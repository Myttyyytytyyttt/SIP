// The doorbell's wiring: what can be driven, driven (src/doorbell-wiring.ts,
// SigningRoutes and LegFeeBook in src/sweep-decision.ts, createHeartbeatServer
// in src/status.ts); what cannot, pinned in bin/keeper.mts's source.
//
// WHY STILL SOME SOURCE, the reason test/wallet-turn-catch.test.ts gives: the
// sweep is a closure inside a top-level script that connects to a chain, a
// database and Privy before it defines one, so no test can drive a sweep.
//
// WHY LESS OF IT (review, 2026-09-23). Six edits to the inline wiring left the
// suite green — a delivery ingested against an empty known set, a lost delivery
// that no longer forced a full pass, a sync that told the doorbell nothing,
// signingRoutes cleared after its prune, the leg-fee fold handed a fresh
// `standing`, the doorbell secret missing from the error scrubber — and a
// seventh commented the server timeouts out under a toContain that still
// matched the comment. The wiring now lives in src/ and is watched working; the
// pins below are matched against CODE LINES only, comments stripped.
//
// THE AUDIT THIS PINS. Before the doorbell every sweep turned every link, and
// several pieces of state were silently built on that: the signing summary was
// rebuilt from the wallets turned (so "signable of N" would have shrunk to the
// handful that moved), and the leg-fee reconciliation cleared any warning the
// sweep did not raise (so a vault that was merely not turned would lose its
// warning and have it raised again by the rotation).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Secret } from "@sip/solana-log";
import { describe, expect, it } from "vitest";
import { Doorbell, type DoorLink } from "../src/doorbell.js";
import { createDoorbellWebhookSync, createHooksRoute } from "../src/doorbell-wiring.js";
import { LegFeeBook, SigningRoutes } from "../src/sweep-decision.js";
import { HEARTBEAT_HEADERS_TIMEOUT_MS, HEARTBEAT_REQUEST_TIMEOUT_MS, createHeartbeatServer } from "../src/status.js";

/**
 * The script with every comment-only line removed: a pin must match CODE. A
 * line commented out — `// server.requestTimeout = 15_000;` — no longer
 * satisfies the pin that was written to keep it.
 */
const codeOnly = (text: string): string =>
  text
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return !(trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*"));
    })
    .join("\n");

const keeper = codeOnly(readFileSync(fileURLToPath(new URL("../bin/keeper.mts", import.meta.url)), "utf8"));
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
    expect(lines.filter((line) => line === "const signingRoutes = new SigningRoutes();")).toHaveLength(1);
    expect(sweepBody, "no longer rebuilt per sweep").not.toContain("new SigningRoutes");
    expect(sweepBody, "no longer rebuilt per sweep").not.toContain("const signingRoutes = new Map");
    expect(sweepBody).toContain("signingRoutes.prune(discoveredWallets);");
    expect(sweepBody).toContain("const routes = signingRoutes.values();");
  });

  it("reconciles the leg-fee warnings per vault, through the one book that owns them", () => {
    expect(lines.filter((line) => line === "const legFeeBook = new LegFeeBook();")).toHaveLength(1);
    expect(sweepBody).toContain(
      "for (const key of legFeeBook.fold(legFeeLooked, new Set(doorLinks.map((link) => link.vault)))) alerter.clear(key);",
    );
    expect(sweepBody).not.toContain("legFeeRaised");
    expect(sweepBody).not.toContain("reconcileLegFees(");
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

  it("serves the receiver built by createHooksRoute, on the server that bounds slow requests, and folds the block into /status", () => {
    expect(keeper).toMatch(/const hooks = createHooksRoute\(\{\n\s+secret: config\.doorbellSecret,\n\s+doorbell,\n\s+known: \(\) => knownAddresses,/);
    expect(keeper).toMatch(/\(\) => leaderboard,\n\s+hooks,\n\s+\),/);
    expect(keeper).toContain("const server = createHeartbeatServer(");
    expect(keeper).not.toMatch(/\bcreateServer\(/);
    expect(keeper).toContain("pendingCarries: pendingCarries(), rpcEndpointInUse, failovers, doorbell: doorbellStatus() }");
  });

  it("builds the webhook sync with createDoorbellWebhookSync, handing it the doorbell", () => {
    expect(keeper).toMatch(
      /const webhookSync = createDoorbellWebhookSync\(\{\n\s+apiKey: config\.heliusApiKey,\n\s+secret: config\.doorbellSecret,\n\s+url: config\.doorbellUrl,\n\s+doorbell,/,
    );
  });

  it("passes each turn's START to the doorbell, so a bell is answered only by a turn that began after it", () => {
    expect(sweepBody).toContain("const turnAt = Date.now();");
    expect(sweepBody).toMatch(/doorbell\.recordTurn\(door, lane, turnRests\(doorTurn\), Date\.now\(\), `[^`]+`, turnAt\)/);
  });
});

describe("the ceiling bench", () => {
  // Its number is the cost of a FULL pass, and a shell with production
  // variables exported must neither switch the doorbell on in the child nor
  // point it at the real Helius account.
  it("strips every doorbell variable from the keeper it starts", () => {
    const bench = readFileSync(fileURLToPath(new URL("../scripts/ceiling-bench.mts", import.meta.url)), "utf8");
    const stripped = bench.slice(bench.indexOf("function childEnv("), bench.indexOf("delete env[name];"));
    for (const name of ["SIP_SOLANA_DOORBELL_SECRET", "SIP_SOLANA_HELIUS_API_KEY", "SIP_SOLANA_DOORBELL_URL", "RAILWAY_PUBLIC_DOMAIN"]) {
      expect(stripped, name).toContain(`"${name}",`);
    }
  });
});

// ── the wiring, driven ────────────────────────────────────────────────────────

const SECRET = "doorbell-secret-0123456789abcdef0123456789abcdef";
const API_KEY = "HeliusApiKeyNeverInAnError0042";
const HOOK_URL = "https://keeper.up.railway.app/hooks/helius";
const T0 = Date.parse("2026-09-23T12:00:00Z");
const SWEEP = 60_000;
const quiet = () => undefined;

const fleet = (n: number): DoorLink[] =>
  Array.from({ length: n }, (_, i) => ({ link: `link-${String(i).padStart(5, "0")}`, wallet: `wallet-${i}`, vault: `vault-${i}` }));
const addressesOf = (links: readonly DoorLink[]): Set<string> => new Set(links.flatMap((link) => [link.wallet, link.vault]));
const select = (bell: Doorbell, links: readonly DoorLink[], now: number) =>
  bell.select({ links, now, sweepMs: SWEEP, protocolPaused: false, live: true });
const delivery = (addresses: readonly string[], signature = `sig-${Math.random()}`) =>
  Buffer.from(JSON.stringify([{ slot: 449756519, blockTime: 1, transaction: { signatures: [signature], message: { accountKeys: addresses } } }]));

/** A booted, trusted doorbell over `links`, every link resting. */
function booted(links: readonly DoorLink[]): Doorbell {
  const bell = new Doorbell(true);
  for (const turn of select(bell, links, T0).turns) bell.recordTurn(turn.link, turn.lane, true, T0, "IDLE", T0);
  bell.ingestBody(delivery(["nobody"]).toString("utf8"), new Set(), T0);
  return bell;
}

describe("the receiver's callbacks (createHooksRoute)", () => {
  const secret = new Secret(SECRET, "doorbellSecret");

  it("does not exist while the doorbell is off", () => {
    expect(createHooksRoute({ secret: null, doorbell: new Doorbell(false), known: () => new Set(), log: quiet })).toBeNull();
  });

  it("rings a delivery against the addresses discovered NOW, not the ones known when it was built", () => {
    const links = fleet(200);
    const bell = booted(links);
    let known: ReadonlySet<string> = new Set();
    const route = createHooksRoute({ secret, doorbell: bell, known: () => known, log: quiet, now: () => T0 + 10_000 })!;
    known = addressesOf(links);
    expect(route.authorized(SECRET)).toBe(true);
    route.accepted(delivery([links[123]!.wallet]));
    const next = select(bell, links, T0 + SWEEP);
    expect(next.turns.find((turn) => turn.link.link === links[123]!.link)?.lane).toBe("bell");
  });

  it("makes the next sweep a full pass when a delivery is lost", () => {
    const links = fleet(200);
    const bell = booted(links);
    const route = createHooksRoute({ secret, doorbell: bell, known: () => addressesOf(links), log: quiet })!;
    route.lost("a delivery over 4194304 bytes was refused");
    expect(select(bell, links, T0 + SWEEP).fullReason).toContain("refused");
  });
});

describe("the webhook sync, reporting into the doorbell (createDoorbellWebhookSync)", () => {
  /** An in-memory Helius that holds one webhook, as the tests of src/helius-webhooks.ts do. */
  function helius(initial: Record<string, unknown>[] = []) {
    const hooks = initial.map((hook) => ({ ...hook }));
    let next = 1;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
      const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
      if (method === "GET") return json(hooks);
      if (method === "POST") {
        const created = { webhookID: `wh-${next++}-abcdef`, active: true, ...body };
        hooks.push(created);
        return json(created);
      }
      const hook = hooks.find((candidate) => candidate.webhookID === decodeURIComponent(url.pathname.split("/")[3] ?? ""))!;
      Object.assign(hook, body);
      return json(hook);
    };
    return { hooks, fetchImpl };
  }
  const build = (bell: Doorbell, fetchImpl: typeof fetch) =>
    createDoorbellWebhookSync({
      apiKey: new Secret(API_KEY, "heliusApiKey"),
      secret: new Secret(SECRET, "doorbellSecret"),
      url: HOOK_URL,
      doorbell: bell,
      log: quiet,
      fetch: fetchImpl,
    });

  it("keeps every link out of rest until the first sync says what Helius holds", async () => {
    const links = fleet(200);
    const bell = booted(links);
    const held = [...addressesOf(links)].sort();
    const api = helius([{ webhookID: "wh-held-abcdef", webhookURL: HOOK_URL, webhookType: "raw", accountAddresses: held, transactionTypes: ["ANY"], authHeader: SECRET, txnStatus: "all", active: true }]);
    const sync = build(bell, api.fetchImpl);
    // MANAGED, NOT CONFIRMED: every link is "new", none rests on a bell that may not ring.
    expect(select(bell, links, T0 + SWEEP).lanes.new).toBe(200);
    await sync.tick({ acting: true, addresses: held, now: T0 + SWEEP });
    const confirmed = select(bell, links, T0 + 2 * SWEEP);
    expect(confirmed.lanes.new).toBe(0);
    expect(confirmed.fullReason).toBeNull();
  });

  it("turns everyone after a sync that had to switch the webhook back on", async () => {
    const links = fleet(200);
    const bell = booted(links);
    const held = [...addressesOf(links)].sort();
    const api = helius([{ webhookID: "wh-off-abcdef", webhookURL: HOOK_URL, webhookType: "raw", accountAddresses: held, transactionTypes: ["ANY"], authHeader: SECRET, txnStatus: "all", active: false }]);
    await build(bell, api.fetchImpl).tick({ acting: true, addresses: held, now: T0 + SWEEP });
    expect(select(bell, links, T0 + 2 * SWEEP).fullReason).toContain("disabled");
  });

  it("rings the addresses an edit added, so their links are turned after it landed", async () => {
    const links = fleet(200);
    const bell = booted(links);
    const newcomer = links[150]!;
    const before = [...addressesOf(links)].filter((address) => address !== newcomer.wallet && address !== newcomer.vault).sort();
    const api = helius([{ webhookID: "wh-held-abcdef", webhookURL: HOOK_URL, webhookType: "raw", accountAddresses: before, transactionTypes: ["ANY"], authHeader: SECRET, txnStatus: "all", active: true }]);
    await build(bell, api.fetchImpl).tick({ acting: true, addresses: [...addressesOf(links)], now: T0 + SWEEP });
    const next = select(bell, links, T0 + 2 * SWEEP);
    expect(next.turns.find((turn) => turn.link.link === newcomer.link)?.lane).toBe("bell");
  });

  it("confirms the header, so a later 403 is a stranger and not a lost delivery", async () => {
    const links = fleet(200);
    const bell = new Doorbell(true);
    select(bell, links, T0);
    const api = helius();
    await build(bell, api.fetchImpl).tick({ acting: true, addresses: [...addressesOf(links)], now: T0 });
    select(bell, links, T0 + SWEEP); // the gap's full pass (the webhook was created)
    bell.rejected();
    bell.ingestBody(delivery(["nobody"]).toString("utf8"), new Set(), T0 + SWEEP);
    expect(select(bell, links, T0 + 2 * SWEEP).fullReason).toBeNull();
  });

  it("scrubs the doorbell secret out of an error Helius echoes back", async () => {
    const bell = new Doorbell(true);
    const echoing: typeof fetch = async () => new Response(`bad authHeader ${SECRET}`, { status: 400 });
    const sync = build(bell, echoing);
    await sync.tick({ acting: true, addresses: ["a"], now: T0 });
    expect(sync.status().lastSyncError).toContain("<redacted:doorbellSecret>");
    expect(JSON.stringify(sync.status())).not.toContain(SECRET);
  });
});

describe("the per-sweep state, over two sweeps that turn different links", () => {
  it("keeps a wallet's signing route while it is discovered, whether or not this sweep turned it", () => {
    const routes = new SigningRoutes();
    routes.prune(new Set(["w1", "w2", "w3"]));
    routes.set("w1", "privy");
    routes.set("w2", "privy");
    routes.set("w3", "none");
    // Sweep 2 turns only w1; w3 is no longer linked.
    routes.prune(new Set(["w1", "w2"]));
    routes.set("w1", "local-keypair");
    expect(routes.values().sort()).toEqual(["local-keypair", "privy"]);
    expect(routes.has("w3")).toBe(false);
  });

  it("clears a leg-fee key only when no vault's last looking turn still raises it", () => {
    const book = new LegFeeBook();
    const key = "leg-fee:MINT:120";
    expect(book.fold(new Map([["vault-a", new Set([key])], ["vault-b", new Set([key])]]), new Set(["vault-a", "vault-b"]))).toEqual([]);
    // Sweep 2 turns only vault-a, which no longer raises it: vault-b still does.
    expect(book.fold(new Map([["vault-a", new Set<string>()]]), new Set(["vault-a", "vault-b"]))).toEqual([]);
    expect([...book.standing]).toEqual([key]);
    // Sweep 3 turns vault-b, which has stopped raising it too: now it clears.
    expect(book.fold(new Map([["vault-b", new Set<string>()]]), new Set(["vault-a", "vault-b"]))).toEqual([key]);
  });
});

describe("the heartbeat server", () => {
  it("gives a request fifteen seconds and its headers ten, instead of Node's five minutes", () => {
    const server = createHeartbeatServer(() => undefined);
    expect(server.requestTimeout).toBe(HEARTBEAT_REQUEST_TIMEOUT_MS);
    expect(server.headersTimeout).toBe(HEARTBEAT_HEADERS_TIMEOUT_MS);
    expect(HEARTBEAT_REQUEST_TIMEOUT_MS).toBe(15_000);
    expect(HEARTBEAT_HEADERS_TIMEOUT_MS).toBe(10_000);
    server.close();
  });
});
