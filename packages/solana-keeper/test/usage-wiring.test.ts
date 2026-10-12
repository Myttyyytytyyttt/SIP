// That the keeper actually FEEDS its usage meters and serves them — the wiring
// in bin/keeper.mts, not the rules, which test/rpc-usage.test.ts,
// test/privy-usage.test.ts, test/turn-times.test.ts and test/settle-tick.test.ts
// pin.
//
// THE SOURCE IS READ, as test/sweep-cost-wiring.test.ts reads it and for its
// reason: the sweep is a closure inside a top-level script that connects to a
// chain, a database and Privy before it defines one, and what regresses here is
// structural — a meter nobody hands to the pool, a sweep that stops freezing
// its counts, an alert that stops being asked. An instrument that quietly stops
// instrumenting is exactly the silence L1a exists to end.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const keeper = readFileSync(fileURLToPath(new URL("../bin/keeper.mts", import.meta.url)), "utf8");

/** The body of a top-level function of keeper.mts, from its declaration to its closing brace. */
function body(declaration: string): string {
  const start = keeper.indexOf(declaration);
  expect(start, `${declaration} was not found`).toBeGreaterThan(-1);
  const end = keeper.indexOf("\n}\n", start);
  expect(end).toBeGreaterThan(start);
  return keeper.slice(start, end);
}

describe("the RPC meter", () => {
  it("is handed to the pool every call of the keeper goes through", () => {
    // THE METERED POOL is what every call goes through. Under dep-down it is
    // observed around (watchedRpcFetch), never replaced; without it, it is the pool.
    expect(keeper).toMatch(/const pooledFetch = poolFetch\(\s*config\.rpcUrls,[\s\S]*?\n {2}rpcUsage,\n\);/);
    expect(keeper).toContain("const rpcFetch: typeof fetch = depWatch === null ? pooledFetch : watchedRpcFetch(pooledFetch, depWatch);");
  });

  it("is priced and budgeted from the configuration, never from a literal", () => {
    const created = keeper.slice(keeper.indexOf("const rpcUsage = createRpcUsage({"), keeper.indexOf("const privyUsage ="));
    expect(created).toContain("archivalCredits: config.archivalCredits");
    expect(created).toContain("archivalCreditsSource: config.archivalCreditsSource");
    expect(created).toContain("budgetPerDay: config.creditBudgetPerDay");
  });

  it("also counts what the pool cannot see: Anchor's websocket confirmations and the webhook's REST calls", () => {
    expect(keeper).toContain("countConfirmations(connection, {");
    expect(keeper).toContain("started: () => rpcUsage.webSocketConfirmation()");
    expect(keeper).toContain('ended: (ms) => turnTimers.record("investConfirmMs", ms)');
    const sync = keeper.slice(keeper.indexOf("const webhookSync = createDoorbellWebhookSync({"), keeper.indexOf("/** The /status block, folded in at render"));
    expect(sync).toContain("fetch: heliusRestFetch(rpcUsage)");
  });
});

describe("the Privy meter", () => {
  it("is the fetch of the one Privy config the keeper signs and lists with, and a dry run still has none", () => {
    expect(keeper).toMatch(/const privyConfig: PrivySolanaConfig \| null =\s*config\.signing\?\.privy === null \|\| config\.signing\?\.privy === undefined \? null : \{ \.\.\.config\.signing\.privy, fetch: privyUsage\.fetch\(\) \};/);
  });

  it("times the wallet index on both paths and counts a resolution that had to do without it", () => {
    const start = keeper.indexOf("const privyIndexAt = Date.now();");
    expect(start).toBeGreaterThan(-1);
    const block = keeper.slice(start, keeper.indexOf("// THE CRANK PAYS FOR EVERY MOVE", start));
    expect(block).toContain("} finally {");
    expect(block.slice(block.indexOf("} finally {"))).toContain("privyIndexMs = Date.now() - privyIndexAt");
    expect(block).toContain("privyUsage.indexBuilt(privyIndexMs, indexBuilt)");
    expect(block).toContain('turnTimers.record("privyIndexMs", privyIndexMs)');
    const fallback = keeper.indexOf("if (privyIndex === undefined) privyUsage.fallbackLookup();");
    expect(fallback).toBeGreaterThan(-1);
    expect(fallback).toBeLessThan(keeper.indexOf("const resolution = await createPrivySolanaSigner("));
  });

  it("times the privy-address book's prepare as the same phase, and never reports it as an index build", () => {
    // L1a AND THE CUTS MEET HERE: under privy-address the Privy phase is the
    // book's prepare. It is still this sweep's Privy time (lastSweepPhaseMs,
    // turnTimes), but it built no listing, so privy.indexMs and the index
    // failure counters stay the listing's alone.
    const start = keeper.indexOf("const privyIndexAt = Date.now();");
    const block = keeper.slice(start, keeper.indexOf("// THE CRANK PAYS FOR EVERY MOVE", start));
    const bookAt = block.indexOf("if (privyBook !== null) {");
    expect(bookAt).toBeGreaterThan(block.indexOf("try {"));
    expect(bookAt).toBeLessThan(block.indexOf("} finally {"));
    const book = block.slice(bookAt, block.indexOf("} else {", bookAt));
    expect(book).toContain("await privyBook.prepare(resolving, Date.now());");
    expect(book).not.toContain("indexBuilt");
    expect(block).toContain("let indexBuilt: boolean | null = null;");
    expect(block.slice(block.indexOf("} finally {"))).toContain("if (indexBuilt !== null) privyUsage.indexBuilt(privyIndexMs, indexBuilt);");
  });

  it("counts a settle signature from the settle's own report of its send, by mode", () => {
    expect(keeper).toContain("onSend: noteSettleSend,");
    const note = body("function noteSettleSend(");
    expect(note).toContain('if (send.route === "privy") privyUsage.signature(send.mode, send.ended !== "threw")');
    expect(note).toContain('turnTimers.record("settleSubmitMs", send.submitMs)');
    expect(note).toContain('turnTimers.record("settleConfirmMs", send.confirmMs)');
  });
});

describe("the sweep", () => {
  it("zeroes the meters' per-sweep counts at its top, beside the Jupiter counter", () => {
    const top = keeper.indexOf("jupiterCalls.startSweep();");
    expect(keeper.indexOf("rpcUsage.startSweep();", top)).toBeGreaterThan(top);
    expect(keeper.indexOf("privyUsage.startSweep();", top)).toBeGreaterThan(top);
  });

  it("freezes them, adds the doorbell's billed events and asks credit-burn, in noteSweepCost — which runs after the flag is cleared and inside its own catch", () => {
    const cost = body("function noteSweepCost(");
    expect(cost).toContain("rpcUsage.webhookEventsSeen(doorbell.deliveryCounts().accepted)");
    expect(cost).toContain("rpcUsage.endSweep()");
    expect(cost).toContain("privyUsage.endSweep()");
    expect(cost).toContain("const burn = creditBurnAlert(rpcUsage.report(Date.now()))");
    expect(cost).toContain("if (burn.fire !== null) alerter.fire(burn.fire)");
    expect(cost).toContain("else if (burn.clear) alerter.clear(CREDIT_BURN_ALERT_KEY)");
    // AFTER what was there before it: nothing the meters do can keep the skip
    // run from ending or the sweep-slow warning from being asked.
    expect(cost.indexOf("rpcUsage.webhookEventsSeen(")).toBeGreaterThan(cost.indexOf("health.consecutiveSkips = 0"));
    expect(cost.indexOf("rpcUsage.webhookEventsSeen(")).toBeGreaterThan(cost.indexOf("const slow = sweepSlowAlert("));
  });

  it("publishes the Privy index as a phase of its own", () => {
    expect(keeper).toContain("let privyIndexMs = 0;");
    expect(keeper).toContain("{ chainReadMs, discoveryMs, vaultReadMs, triageMs, expensiveMs, privyIndexMs }");
  });

  it("times a LIVE settle that SETTLED and a LIVE invest that INVESTED, and nothing else, around the calls it already makes", () => {
    // A dry run's "would settle" is SETTLED too, and sends nothing: timing it
    // would understate a hot settle by exactly the send and its confirmation.
    expect(keeper).toContain('if (settleTurn.live && settle.outcome === "SETTLED") turnTimers.record("settleSettledMs", Date.now() - settleAt);');
    expect(keeper).toContain('if (investTurn.live && invest.outcome === "INVESTED") turnTimers.record("investInvestedMs", Date.now() - investAt);');
    expect(keeper.indexOf("const settleAt = Date.now();")).toBeLessThan(keeper.indexOf("const settle = await runSettleTick({"));
    expect(keeper.indexOf("const investAt = Date.now();")).toBeLessThan(keeper.indexOf("const invest = await runInvestTick({"));
  });
});

describe("/status", () => {
  it("folds the four usage blocks in at render, read at the moment of the request", () => {
    expect(keeper).toContain("renderStatus({ ...health, ...usageStatus(), pendingCarries: pendingCarries(),");
    const usage = body("function usageStatus(");
    for (const block of ["rpc: rpcUsage.report(now)", "privy: privyUsage.report(now)", "jupiter: jupiterCalls.report(now)", "turnTimes: turnTimers.report()"]) {
      expect(usage).toContain(block);
    }
  });
});
