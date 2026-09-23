// The doorbell's wiring in bin/keeper.mts, read from the source.
//
// WHY THE SOURCE, the reason test/wallet-turn-catch.test.ts gives: the sweep is
// a closure inside a top-level script that connects to a chain, a database and
// Privy before it defines one, so no test can drive a sweep. The decisions are
// exercised in test/doorbell.test.ts, test/helius-webhooks.test.ts and
// test/status.test.ts; what can break HERE is structural — a loop that still
// walks every link, a read that still reads every vault, per-sweep state that
// still assumes every link is turned — and it reads back from the text exactly.
//
// THE AUDIT THIS PINS. Before the doorbell every sweep turned every link, and
// several pieces of state were silently built on that: the signing summary was
// rebuilt from the wallets turned (so "signable of N" would have shrunk to the
// handful that moved), and the leg-fee reconciliation cleared any warning the
// sweep did not raise (so a vault that was merely not turned would lose its
// warning and have it raised again by the rotation).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const keeper = readFileSync(fileURLToPath(new URL("../bin/keeper.mts", import.meta.url)), "utf8");
const lines = keeper.split("\n");
const sweepStart = keeper.indexOf("async function sweep(): Promise<void> {");
const sweepEnd = keeper.indexOf("\nif (config.armed && !readModel.enabled)", sweepStart);
const sweepBody = keeper.slice(sweepStart, sweepEnd);

describe("the sweep turns the doorbell's selection", () => {
  it("loops over the selected turns, and no longer over every discovered link", () => {
    expect(sweepStart).toBeGreaterThan(-1);
    expect(sweepEnd).toBeGreaterThan(sweepStart);
    expect(sweepBody).toContain("const selection = doorbell.select({ links: doorLinks,");
    expect(sweepBody).toContain("for (const { link: door, lane } of turns) {");
    expect(sweepBody).not.toContain("for (const link of links) {");
  });

  it("reads only the selected links' vaults, and builds the Privy index only when something is selected", () => {
    expect(sweepBody).toContain("vaults = await readVaults(program, turns.map((turn) => turn.link.managed.vault));");
    expect(sweepBody).not.toMatch(/readVaults\(program, links\./);
    expect(sweepBody).toContain("if (privyConfig !== null && turns.length > 0) {");
  });

  it("still discovers every sweep, and keeps everything discovered as known", () => {
    expect(sweepBody).toContain("links = await discoverLinks(connection, programId, TRADING_LINK_DISC);");
    expect(sweepBody).toContain("health.linksDiscovered = links.length");
    expect(sweepBody).toContain("for (const link of links) linkWallets.set(link.linkAddress.toBase58(), link.wallet.toBase58());");
    expect(sweepBody).toContain("knownAddresses = new Set(doorLinks.flatMap((link) => [link.wallet, link.vault]));");
  });

  it("hands the selection the pause switch and the claim, so an unpause and a takeover turn everyone", () => {
    const paused = sweepBody.indexOf("const protocolPaused = snapshot.config?.paused === true;");
    const select = sweepBody.indexOf("doorbell.select(");
    expect(paused).toBeGreaterThan(-1);
    expect(paused, "read before the selection").toBeLessThan(select);
    expect(sweepBody).toMatch(/doorbell\.select\(\{ links: doorLinks, now: Date\.now\(\), sweepMs: config\.sweepMs, protocolPaused, live: liveAtStart \}\)/);
  });

  it("asks for a full pass when the sweep fails before turning what it selected", () => {
    expect(sweepBody).toContain("selectionOutstanding = turns.length > 0;");
    expect(sweepBody).toContain("selectionOutstanding = false;");
    // In the sweep's own catch: the one that writes lastSweepError.
    expect(sweepBody).toMatch(
      /\} catch \(error\) \{\n(?:\s*\/\/.*\n)*\s*if \(selectionOutstanding\) doorbell\.requestFullPass\([^;]+;\n\s*selectionOutstanding = false;\n\s*health\.lastSweepError = /,
    );
  });
});

describe("what each turn tells the doorbell", () => {
  it("expects every transaction the keeper sends back through the webhook", () => {
    expect(sweepBody).toContain("if (settle.signature !== undefined) doorbell.expectEcho(settle.signature, Date.now(), [wallet, vaultAddr]);");
    expect(sweepBody).toContain("for (const purchase of invest.purchases ?? []) doorbell.expectEcho(purchase.signature, Date.now(), [vaultAddr]);");
  });

  it("records whether the turn may rest OUTSIDE the try, so a turn that threw is recorded busy", () => {
    const record = sweepBody.indexOf("doorbell.recordTurn(door, lane, turnRests(doorTurn)");
    const threwRow = sweepBody.indexOf('settle: "THREW",\n          invest: "THREW",');
    const timing = sweepBody.indexOf("const turnMs = Date.now() - turnAt;");
    expect(record).toBeGreaterThan(-1);
    expect(record, "after the catch's THREW row").toBeGreaterThan(threwRow);
    expect(record, "before the turn is timed").toBeLessThan(timing);
    // The default is a throw: a turn that never reached its outcome may not rest.
    expect(sweepBody).toMatch(/let doorTurn: [^=]+= \{\n\s+settle: "THREW",\n\s+invest: null,\n\s+\};/);
    expect(sweepBody).toContain("doorTurn = { settle: settle.outcome, invest: invest.outcome, wrapShort: invest.wrap?.short === true };");
  });
});

describe("per-sweep state that assumed every link is turned", () => {
  it("keeps the signing routes across sweeps, pruned to the discovered wallets", () => {
    expect(lines.filter((line) => line === "const signingRoutes = new Map<string, string>();")).toHaveLength(1);
    expect(sweepBody, "no longer rebuilt per sweep").not.toContain("const signingRoutes = new Map");
    expect(sweepBody).toContain("for (const wallet of [...signingRoutes.keys()]) if (!discoveredWallets.has(wallet)) signingRoutes.delete(wallet);");
  });

  it("reconciles the leg-fee warnings per vault, not against one sweep-wide set", () => {
    expect(keeper).toContain("const legFeeByVault = new Map<string, ReadonlySet<string>>();");
    expect(sweepBody).toContain("const legFees = reconcileLegFees({");
    expect(sweepBody).not.toContain("legFeeRaised");
  });
});

describe("the doorbell's own alerts, and its route", () => {
  it("raises doorbell-deaf and doorbell-sync from the sweep, and clears them", () => {
    expect(sweepBody).toContain("const deaf = doorbellDeafAlert(doorbell.trust(Date.now()), doorbell.everTrusted);");
    expect(sweepBody).toContain("else if (deaf.clear) alerter.clear(DOORBELL_DEAF_ALERT_KEY);");
    expect(sweepBody).toContain("const sync = webhookSync.syncAlert();");
    expect(sweepBody).toContain("else if (sync.clear) alerter.clear(DOORBELL_SYNC_ALERT_KEY);");
  });

  it("keeps the webhook in step only from the acting instance, detached, and never with an empty list", () => {
    expect(sweepBody).toContain("if (knownAddresses.size > 0) void webhookSync.tick({ acting: liveAtStart, addresses: [...knownAddresses], now: Date.now() });");
  });

  it("serves the receiver only when the doorbell is on, bounds slow requests, and folds the block into /status", () => {
    expect(keeper).toMatch(/const hooks: HooksRoute \| null =\n\s+config\.doorbellSecret === null\n\s+\? null/);
    expect(keeper).toMatch(/\(\) => leaderboard,\n\s+hooks,\n\s+\),/);
    expect(keeper).toContain("server.requestTimeout = 15_000;");
    expect(keeper).toContain("server.headersTimeout = 10_000;");
    expect(keeper).toContain("pendingCarries: pendingCarries(), rpcEndpointInUse, failovers, doorbell: doorbellStatus() }");
  });
});
