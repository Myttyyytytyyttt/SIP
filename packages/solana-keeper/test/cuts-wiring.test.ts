// That each cut is wired in bin/keeper.mts ONLY behind its token, and L3 only
// behind its limit — the rules live in src/ and their own tests; this file pins
// the switch.
//
// WHY THE SOURCE IS READ, as in test/sweep-cost-wiring.test.ts: the sweep is a
// closure inside a top-level script that connects to a chain, a database and
// Privy before it defines one. And the regression that matters here is
// structural — a cut that runs without its token, or a fallback that stops
// being one — which reads back from the text.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const keeper = readFileSync(fileURLToPath(new URL("../bin/keeper.mts", import.meta.url)), "utf8");

/** The sweep's body, from its declaration to the next top-level function. */
const sweepBody = ((): string => {
  const start = keeper.indexOf("async function sweep(): Promise<void> {");
  expect(start).toBeGreaterThan(-1);
  return keeper.slice(start, keeper.indexOf("\n}\n", start));
})();

describe("gpa-v2", () => {
  it("lists through V2 only when the token is set, over the Connection's own transport", () => {
    expect(sweepBody).toMatch(
      /config\.cuts\.has\("gpa-v2"\)\n\s+\? discoverLinksPreferringV2\(connection, programId, TRADING_LINK_DISC, trackedFetch\)\n\s+: discoverLinks\(connection, programId, TRADING_LINK_DISC\)/,
    );
    // ONE CALL SITE for each: nothing lists around the switch.
    expect(keeper.match(/discoverLinksPreferringV2\(/g)).toHaveLength(1);
    expect(keeper.match(/discoverLinks\(connection/g)).toHaveLength(1);
  });

  it("says which call listed the links, once per change, only when the cut is on", () => {
    expect(sweepBody).toMatch(/if \(config\.cuts\.has\("gpa-v2"\)\) \{\n\s+changes\.change\(\n\s+"discovery-method",/);
  });
});

describe("L3, the last-known-good list", () => {
  it("is built from SIP_SOLANA_DISCOVERY_LKG_MS and re-reads every remembered link fresh", () => {
    expect(keeper).toContain("const linkDiscovery = new LastKnownGoodDiscovery(config.discoveryLkgMs);");
    expect(sweepBody).toContain("(addresses) => rereadLinks(connection, addresses, programId, TRADING_LINK_DISC),");
  });

  it("warns, then pages, on a remembered sweep — and clears on the next listing", () => {
    const lkg = sweepBody.indexOf('if (found.source === "lkg") {');
    const fresh = sweepBody.indexOf("alerter.clear(DISCOVERY_STALE_ALERT_KEY);");
    expect(lkg).toBeGreaterThan(-1);
    expect(sweepBody.slice(lkg, fresh)).toContain("alerter.fire(discoveryStaleAlert(found.consecutiveFailures, found.lkgAgeMs ?? 0, detail));");
    expect(fresh).toBeGreaterThan(lkg);
  });
});

describe("privy-address", () => {
  it("exists only with the token AND a Privy signer to resolve", () => {
    expect(keeper).toMatch(/const privyBook: PrivyAddressBook \| null =\n\s+privyConfig !== null && config\.cuts\.has\("privy-address"\)/);
  });

  it("replaces the per-sweep listing — never runs beside it — and is asked only about wallets a turn resolves", () => {
    const site = sweepBody.slice(sweepBody.indexOf("if (privyBook !== null) {"), sweepBody.indexOf("// THE CRANK PAYS FOR EVERY MOVE"));
    const [book, today] = site.split("} else {");
    expect(book).toContain("await privyBook.prepare(resolving, Date.now());");
    expect(book).not.toContain("buildPrivySolanaIndex");
    expect(today).toContain("privyIndex = await buildPrivySolanaIndex(privyConfig);");
    // THE TURN LOOP'S OWN CONDITION, so the book asks about nobody the sweep would not have.
    expect(book).toContain("vaults === null || resolvesSignerFor(profile, vaults.get(link.vault)?.skimMode)");
    expect(sweepBody).toContain("const settlesThisVault = vaults === null || resolvesSignerFor(profile, vaults.get(vaultAddr)?.skimMode);");
  });

  it("fails a wallet it could not ask as today's failed lookup does, and asks about the seat again before every send", () => {
    expect(sweepBody).toMatch(/if \(privyConfig !== null && lookupFailed !== undefined\) \{[\s\S]{0,200}if \(walletSigner === null\) route = "none \(privy lookup failed\)";/);
    // WITHOUT THE CUT, THE SIGNER AS IT ALWAYS WAS: no confirmSeat, so settle-tick sends with no read before it.
    expect(sweepBody).toContain("walletSigner = privyBook === null ? resolution.signer : confirmedSubmitter(resolution.signer, privyBook);");
    expect(sweepBody).toContain("privyBook?.prune(discoveredWallets);");
  });
});

describe("rest-skip", () => {
  it("keeps a RestBook only with the token, for the life of the process", () => {
    expect(keeper).toContain('const restBook: RestBook | null = config.cuts.has("rest-skip") ? new RestBook() : null;');
    // ONE BOOK: nothing builds a second one around the switch.
    expect(keeper.match(/new RestBook\(\)/g)).toHaveLength(1);
  });

  it("hands it to the settle turn only when it exists, beside the walk cache", () => {
    expect(sweepBody).toMatch(/walkCache,\n(\s+\/\/[^\n]*\n)*\s+\.\.\.\(restBook === null \? \{\} : \{ restBook \}\),/);
    expect(keeper.match(/restBook \}/g)).toHaveLength(1);
  });

  it("drops the memo of every link the sweep no longer discovered, by link address", () => {
    expect(sweepBody).toContain("restBook?.prune(new Set(doorLinks.map((link) => link.managed.linkAddress.toBase58())));");
  });
});

describe("/status", () => {
  it("serves the discovery block and the cuts block on every render", () => {
    expect(keeper).toContain("doorbell: doorbellStatus(), ...cutsStatusBlocks() }");
    expect(keeper).toMatch(
      /discovery: linkDiscovery\.status\(Date\.now\(\)\),\n\s+cuts: \{\n\s+on: \[\.\.\.config\.cuts\],\n\s+privyAddressBook: privyBook\?\.status\(\) \?\? null,\n\s+board: boardRefresh\?\.status\(\) \?\? null,\n/,
    );
  });

  it("adds rest-skip's counters only with its token: without it the block is the one served before the cut existed", () => {
    expect(keeper).toContain("...(restBook === null ? {} : { restSkip: restBook.status() }),");
  });
});

describe("jupiter-key", () => {
  it("builds the host, the key and ONE pacer only under its token — the keyed host only with a key", () => {
    expect(keeper).toMatch(
      /const jupiterAccess: JupiterAccess \| null = config\.cuts\.has\("jupiter-key"\)\n\s+\? \{\n\s+baseUrl: config\.jupiterApiKey === null \? LITE_API : KEYED_API,\n\s+apiKey: config\.jupiterApiKey,\n\s+pacer: new JupiterPacer\(\{ perMinute: config\.jupiterCallsPerMinute \}\),\n\s+\}\n\s+: null;/,
    );
    expect(keeper.match(/new JupiterPacer\(/g)).toHaveLength(1);
  });

  it("hands it to the invest turn only when it exists, so a keeper without the token runs today's turn", () => {
    expect(sweepBody).toContain("...(jupiterAccess === null ? {} : { jupiter: jupiterAccess }),");
    expect(keeper.match(/runInvestTick\(/g)).toHaveLength(1);
  });

  it("changes /status only under the token: the budget the per-minute view is judged on, and an absent-when-off block", () => {
    expect(keeper).toContain("if (jupiterAccess !== null) jupiterCalls.setBudgetPerMinute(jupiterAccess.pacer.perMinute);");
    expect(keeper.match(/setBudgetPerMinute\(/g)).toHaveLength(1);
    expect(keeper).toMatch(/\.\.\.\(jupiterAccess === null\n\s+\? \{\}\n\s+: \{ jupiter: \{ host: new URL\(jupiterAccess\.baseUrl\)\.host, keyed: jupiterAccess\.apiKey !== null, \.\.\.jupiterAccess\.pacer\.status\(\) \} \}\),/);
  });
});

describe("invest-batch", () => {
  it("is on only under its token AND on a keeper that invests — the volume keeper keeps today's vault read", () => {
    expect(keeper).toContain('const investBatch = config.cuts.has("invest-batch") && profile.invests;');
  });

  it("reads the sweep's batch through readSweepState under the cut, and through today's readVaults line otherwise", () => {
    expect(sweepBody).toMatch(
      /if \(investBatch\) \{\n\s+const state = await readSweepState\(connection, program, turns\.map\(\(turn\) => turn\.link\.managed\.vault\)\);\n\s+vaults = state\.vaults;\n\s+investSnapshots = state\.invest;[\s\S]{0,200}\} else \{\n\s+vaults = await readVaults\(program, turns\.map\(\(turn\) => turn\.link\.managed\.vault\)\);\n\s+\}/,
    );
    expect(keeper.match(/readSweepState\(/g)).toHaveLength(1);
    expect(keeper.match(/await readVaults\(/g)).toHaveLength(1);
  });

  it("starts every sweep with no dirty vault, and never hands a snapshot to a vault the sweep already moved", () => {
    expect(sweepBody).toContain("const dirtyVaults = new Set<string>();");
    expect(sweepBody).toContain(
      "const investSnapshot = investSnapshots === null || dirtyVaults.has(vaultAddr) ? undefined : investSnapshots.get(vaultAddr);",
    );
    expect(sweepBody).toContain("...(investSnapshot === undefined ? {} : { snapshot: investSnapshot }),");
  });

  it("marks a vault dirty after a settle that may have moved money, an invest that may have sent, and any turn that threw", () => {
    expect(sweepBody).toContain("if (investSnapshots !== null && !settleLeavesSnapshotTrue(settle.outcome)) dirtyVaults.add(vaultAddr);");
    expect(sweepBody).toContain("if (!investLeavesSnapshotTrue(invest.outcome)) dirtyVaults.add(vaultAddr);");
    const catchAt = sweepBody.indexOf('if (phase === "settle") {');
    expect(sweepBody.slice(catchAt - 300, catchAt)).toContain("if (investSnapshots !== null) dirtyVaults.add(vaultAddr);");
    // THE SETTLE'S MARK COMES BEFORE THE INVEST TURN THAT WOULD READ THE SNAPSHOT.
    expect(sweepBody.indexOf("!settleLeavesSnapshotTrue(settle.outcome)")).toBeLessThan(sweepBody.indexOf("const investSnapshot = "));
  });

  it("serves its counters only under the token", () => {
    expect(keeper).toContain("...(investBatchStats === null ? {} : { investBatch: { ...investBatchStats } }),");
  });

  it("tells the doorbell the batch's time for a rest the snapshot decided, and the turn's start otherwise", () => {
    expect(sweepBody).toContain("investReads = invest.reads;");
    expect(sweepBody).toContain("const restReadAt = restVerdictReadAt(turnAt, vaultReadAt, investReads);");
    expect(sweepBody).toMatch(/doorbell\.recordTurn\(door, lane, turnRests\(doorTurn\), Date\.now\(\), `[^`]+`, restReadAt\)/);
    // ONE recordTurn, and the turn's own start reaches it only through restVerdictReadAt.
    expect(keeper.match(/doorbell\.recordTurn\(/g)).toHaveLength(1);
  });
});

describe("explicit-send", () => {
  it("builds ONE sender, only under its token, on the provider's own wallet, asking isLive() — never a cached answer", () => {
    expect(keeper).toMatch(
      /const crankSender: CrankSender \| null = config\.cuts\.has\("explicit-send"\)\n\s+\? new CrankSender\(\{\n\s+connection,\n\s+wallet: provider\.wallet,\n\s+isLive: \(\) => isLive\(\),/,
    );
    expect(keeper.match(/new CrankSender\(/g)).toHaveLength(1);
  });

  it("starts the quiet period again at every takeover", () => {
    const takeover = keeper.slice(keeper.indexOf("onTakeover: () => {"), keeper.indexOf("onTakeover: () => {") + 400);
    expect(takeover).toContain("crankSender?.noteTakeover();");
  });

  it("makes a draining process not live, so no turn is handed a key after SIGTERM — and is today's liveBlocker without the token", () => {
    expect(keeper).toMatch(
      /const liveBlocker = \(\): string \| null =>\n[\s\S]{0,400}\(crankSender\?\.draining === true \? "draining after SIGTERM[^"]*" : null\) \?\?\n\s+missingLiveCondition\(\{ armed: config\.armed, verification, claimLive: claim\.live, lockName: profile\.lockName, claimFailure: claim\.failure \}\)( \?\?\n|;)/,
    );
  });

  it("hands the sender to the invest turn only when it exists, and never to the settle turn", () => {
    expect(sweepBody).toContain("...(crankSender === null ? {} : { sender: crankSender }),");
    const settleCall = sweepBody.slice(sweepBody.indexOf("const settle = await runSettleTick({"), sweepBody.indexOf("settleOutcome = settle.outcome;"));
    expect(settleCall).not.toContain("crankSender");
  });

  it("on SIGTERM drains first — no new send, the one in flight confirmed for up to SIGTERM_DRAIN_MS — and only then releases and exits", () => {
    const handler = keeper.slice(keeper.indexOf('for (const signal of ["SIGTERM", "SIGINT"] as const) {'));
    const drain = handler.slice(0, handler.indexOf("return;\n    }"));
    expect(drain).toContain("if (crankSender !== null) {");
    expect(drain).toContain("crankSender.beginDrain();");
    expect(drain).toContain("void crankSender.idle(SIGTERM_DRAIN_MS).then((drained) => {");
    expect(drain.indexOf("crankSender.idle(SIGTERM_DRAIN_MS)")).toBeLessThan(drain.indexOf("claim.release();"));
    expect(drain.indexOf("claim.release();")).toBeLessThan(drain.indexOf("process.exit(0);"));
    // WITHOUT THE TOKEN, TODAY'S HANDLER: release and exit at once.
    const today = handler.slice(handler.indexOf("return;\n    }"));
    expect(today).toMatch(/if \(config\.armed && readModel\.enabled && claim\.held\) \{\n\s+log\.info\("releasing the keeper claim", \{ signal \}\);\n\s+claim\.release\(\);\n\s+\}\n\s+process\.exit\(0\);/);
  });

  it("serves its counters only under the token", () => {
    expect(keeper).toContain("...(crankSender === null ? {} : { explicitSend: crankSender.status() }),");
  });
});
