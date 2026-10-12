// That each remaining piece of L1a is wired in bin/keeper.mts ONLY behind its
// SIP_SOLANA_CUTS token (src/cuts.ts, OPS_TOKENS): with none named, every line
// that reaches one goes through a null, the alerter is the alerter, /status has
// no `ops` block, and the transport, the Privy meter and the read model are the
// ones this keeper had before. The rules themselves live in src/ and their own
// tests; this file pins the switch, the order of the alert chain, and that the
// watchdog's verdict is /health's.
//
// THE SOURCE IS READ, as in test/cuts-wiring.test.ts: the sweep is a closure in a
// top-level script that connects to a chain, a database and Privy before it
// defines one, and what matters here is structural.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { OPS_TOKENS } from "../src/cuts.js";

const keeper = readFileSync(fileURLToPath(new URL("../bin/keeper.mts", import.meta.url)), "utf8");

/** A top-level function's body, from its declaration to the next top-level closing brace. */
function body(declaration: string): string {
  const start = keeper.indexOf(declaration);
  expect(start, `${declaration} was not found`).toBeGreaterThan(-1);
  return keeper.slice(start, keeper.indexOf("\n}\n", start));
}

describe("each piece exists only under its token", () => {
  it("builds the state of dep-down, jupiter-budget, claim-flap and warn-digest only when named", () => {
    expect(keeper).toContain('const depWatch: DependencyWatch | null = config.cuts.has("dep-down") ? new DependencyWatch() : null;');
    expect(keeper).toContain(
      'const jupiterAnswers: JupiterAnswers | null = config.cuts.has("dep-down") || config.cuts.has("jupiter-budget") ? new JupiterAnswers() : null;',
    );
    expect(keeper).toContain('const claimWatch: ClaimWatch | null = config.cuts.has("claim-flap") ? new ClaimWatch() : null;');
    expect(keeper).toContain('const warnDigest: WarnDigest | null = config.cuts.has("warn-digest") ? new WarnDigest(Date.now()) : null;');
    expect(keeper).toMatch(/const watchdog: Watchdog \| null = config\.cuts\.has\("watchdog-exit"\)\n\s+\? startWatchdog\(\{/);
  });

  it("asks each of the four counter alerts only under its own token, after the sweep", () => {
    const ops = body("function noteOpsAfterSweep(): void {");
    expect(ops).toContain('if (config.cuts.has("privy-burn")) applyDecision(PRIVY_BURN_ALERT_KEY, privyBurnAlert(privyUsage.report(now)));');
    expect(ops).toContain('if (config.cuts.has("privy-index")) applyDecision(PRIVY_INDEX_ALERT_KEY, privyIndexAlert(privyUsage.report(now)));');
    expect(ops).toMatch(/if \(config\.cuts\.has\("rpc-fallback"\)\) \{\n\s+applyDecision\(\n\s+RPC_FALLBACK_ALERT_KEY,/);
    expect(ops).toMatch(/if \(config\.cuts\.has\("jupiter-budget"\) && jupiterAnswers !== null\) \{\n\s+applyDecision\(\n\s+JUPITER_BUDGET_ALERT_KEY,/);
    expect(ops).toContain("if (depWatch !== null) {");
    expect(ops).toContain("if (warnDigest !== null && digestAlerter !== null && warnDigest.due(now)) {");
    // ON ITS OWN SENDER, cleared first: otherwise the 30-minute dedupe reads each day's as "(x2)" of the last.
    expect(ops).toMatch(/digestAlerter\.clear\(DIGEST_ALERT_KEY\);\n\s+digestAlerter\.fire\(warnDigest\.take\(now\)\);/);
    // EVERY ALERT IN IT ASKS A TOKEN FIRST: nothing here fires for a keeper that named none.
    for (const rule of ["privyBurnAlert(", "privyIndexAlert(", "rpcFallbackAlert(", "jupiterBudgetAlert(", "depDownAlerts(", "warnDigest.take("]) {
      expect(keeper.split(rule).length - 1, rule).toBe(1);
    }
  });

  it("runs after the sweep's own accounting, last in noteSweepCost, which runs in the sweep's finally", () => {
    const cost = body("function noteSweepCost(");
    expect(cost.indexOf("noteOpsAfterSweep();")).toBeGreaterThan(cost.indexOf("else if (burn.clear) alerter.clear(CREDIT_BURN_ALERT_KEY);"));
    expect(cost.trimEnd().endsWith("noteOpsAfterSweep();")).toBe(true);
  });
});

describe("without dep-down, the transport, the Privy meter and the read model are the old ones", () => {
  it("routes the RPC through the metered pool itself, and only under the token through the watch around it", () => {
    expect(keeper).toContain("const rpcFetch: typeof fetch = depWatch === null ? pooledFetch : watchedRpcFetch(pooledFetch, depWatch);");
    // /health's progress clock still moves on a RETURNED response only.
    expect(keeper).toMatch(/const response = await rpcFetch\(input, init\);\s*\n\s*noteProgress\(\);\s*\n\s*return response;/);
  });

  it("gives the Privy meter its watch only under the token, and the signer the meter's fetch either way", () => {
    expect(keeper).toMatch(/const privyUsage = createPrivyUsage\(\{\n\s+startedAt: Date\.now\(\),\n\s+\.\.\.\(depWatch === null\n\s+\? \{\}/);
    expect(keeper).toContain("{ ...config.signing.privy, fetch: privyUsage.fetch() }");
  });

  it("gives the read model an observer only under the token", () => {
    expect(keeper).toMatch(/const readModel = SolanaReadModel\.create\(\n\s+config\.databaseUrl,\n[^\n]+\n\s+depWatch === null \? undefined : /);
  });

  it("watches Jupiter's host through the global fetch only when dep-down or jupiter-budget asked for its answers", () => {
    const install = keeper.indexOf("observeGlobalFetch(globalThis, isJupiterHost,");
    expect(install).toBeGreaterThan(-1);
    expect(keeper.lastIndexOf("if (jupiterAnswers !== null) {", install)).toBeGreaterThan(install - 200);
    expect(keeper.split("observeGlobalFetch(").length - 1).toBe(1);
    // ITS 429s ARE jupiter-budget's, never dep-down's.
    expect(keeper).toContain('if (depWatch !== null && answer !== 429) depWatch.record("jupiter", at,');
  });
});

describe("the alert chain", () => {
  it("is the alerter itself without dep-down and warn-digest; otherwise the gate, then the digest's tap, then the alerter", () => {
    expect(keeper).toContain("const baseAlerter = createAlerter(alerterOptions);");
    expect(keeper).toContain("const tappedAlerter: Alerter = warnDigest === null ? baseAlerter : warnDigest.tap(baseAlerter);");
    expect(keeper).toContain("const alerter: Alerter = depWatch === null ? tappedAlerter : gatedAlerter(tappedAlerter, depWatch);");
    // ONE createAlerter for every alert, and the digest's own sender, at warn, only under its token.
    expect(keeper.split("createAlerter(").length - 1).toBe(2);
    expect(keeper).toContain('const digestAlerter: Alerter | null = warnDigest === null ? null : createAlerter({ ...alerterOptions, minSeverity: "warn" });');
  });

  it("names the RPC as the sweep's cause before sweep-failed is fired, so the gate can hold it", () => {
    const catchAt = keeper.indexOf('log.error("sweep cycle failed", { detail: health.lastSweepError });');
    const cause = keeper.indexOf("const failedOn = depWatch?.sweepFailureCause(cycleBeganAt) ?? null;", catchAt);
    const declared = keeper.indexOf("if (failedOn !== null) depWatch?.sweepFailedOn(failedOn, health.lastSweepError);", cause);
    const fired = keeper.indexOf('key: "sweep-failed",', catchAt);
    expect(catchAt).toBeGreaterThan(-1);
    expect(cause).toBeGreaterThan(catchAt);
    expect(declared).toBeGreaterThan(cause);
    expect(fired).toBeGreaterThan(declared);
  });

  it("counts Jupiter's 429s per sweep from the top of the sweep", () => {
    const top = keeper.indexOf("jupiterCalls.startSweep();");
    expect(keeper.indexOf("jupiterAnswers?.startSweep();", top)).toBeGreaterThan(top);
  });
});

describe("claim-flap", () => {
  it("tells the watch every takeover, every lost session and every mismatch release — and pages what a regain returns", () => {
    const takeover = body("const claim: KeeperClaim = new KeeperClaim({");
    expect(takeover).toContain('claimWatch?.lost(Date.now(), "session-dropped");');
    expect(takeover).toContain("const regained = claimWatch?.takeover(Date.now()) ?? null;");
    expect(takeover).toContain("if (regained !== null) alerter.fire(regained);");
    expect(keeper).toMatch(/if \(readModel\.enabled && config\.armed && claim\.held\) \{\n\s+claim\.release\(\);\n\s+claimWatch\?\.lost\(Date\.now\(\), "settle-key-mismatch"\);/);
  });
});

describe("watchdog-exit", () => {
  it("exits on /health's own verdict — one function for both — and releases the claim and pages first", () => {
    expect(keeper).toContain(
      "const healthNow = (): HealthReport => decideHealth({ now: Date.now(), startedAt: startedAtMs, lastProgressAt, sweepMs: config.sweepMs });",
    );
    expect(keeper.split("decideHealth(").length - 1).toBe(1);
    const dog = keeper.slice(keeper.indexOf("const watchdog: Watchdog | null ="), keeper.indexOf("  : null;", keeper.indexOf("const watchdog: Watchdog | null =")));
    expect(dog).toContain("health: healthNow,");
    expect(dog).toContain("alerter.fire(watchdogExitAlert(report));");
    expect(dog).toContain("if (config.armed && readModel.enabled && claim.held) claim.release();");
    expect(dog).toContain("exit: (code) => process.exit(code),");
    // /health serves the same function.
    expect(keeper).toMatch(/createHeartbeatServer\(\n\s+httpHandler\(\n[\s\S]{0,400}?\n\s+healthNow,\n/);
  });

  it("is started before the chain is first read, so a boot that hangs is covered", () => {
    expect(keeper.indexOf("const watchdog: Watchdog | null =")).toBeLessThan(keeper.indexOf("const initial = await readChainSnapshot(connection, program);"));
  });
});

describe("/status", () => {
  it("folds the ops block in with the cuts' blocks, and serves no block at all while no ops token is named", () => {
    expect(keeper).toContain("doorbell: doorbellStatus(), ...cutsStatusBlocks() }");
    expect(body("function cutsStatusBlocks(")).toContain("...opsStatusBlock(),");
    const ops = body("function opsStatusBlock(");
    expect(ops).toContain("return Object.keys(ops).length === 0 ? {} : { ops };");
    for (const piece of ["watchdog === null", "depWatch === null", "jupiterAnswers === null", "claimWatch === null", "warnDigest === null"]) {
      expect(ops, piece).toContain(piece);
    }
  });

  it("covers every ops token: each is either a sub-block above or one of the four counter alerts", () => {
    const counters = new Set(["privy-burn", "jupiter-budget", "rpc-fallback", "privy-index"]);
    const stateful = new Set(["watchdog-exit", "dep-down", "warn-digest", "claim-flap"]);
    for (const token of OPS_TOKENS) expect(counters.has(token) || stateful.has(token), token).toBe(true);
    for (const token of OPS_TOKENS) expect(keeper, token).toContain(`config.cuts.has("${token}")`);
  });
});
