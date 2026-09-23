// That the sweep actually REPORTS what it costs — the wiring in bin/keeper.mts
// and src/venue-depth.ts, not the rules, which test/sweep-cost.test.ts pins.
//
// WHY THE SOURCE IS READ RATHER THAN THE BEHAVIOUR EXERCISED, exactly as in
// test/wallet-turn-catch.test.ts: the sweep is a closure inside a top-level
// script that connects to a chain, a database and Privy before it defines one,
// so there is no seam to drive a single sweep through. And what regresses here
// is structural — a counter that stops being incremented, an alert that stops
// being fired, a timer whose phase is dropped — which reads back from the text.
//
// THE FAILURE THIS GUARDS IS SILENCE. The keeper already dropped overlapping
// sweeps with one log line, no counter and no alert; a wallet turn threw with
// `cycleRunning` stuck on, and every later sweep logged the skip while nobody
// was settled (the comment recording it is still in bin/keeper.mts). An
// instrument that quietly stops instrumenting reproduces exactly that, and the
// only thing that notices is a test that reads the wiring.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const keeper = readFileSync(fileURLToPath(new URL("../bin/keeper.mts", import.meta.url)), "utf8");
const venueDepth = readFileSync(fileURLToPath(new URL("../src/venue-depth.ts", import.meta.url)), "utf8");

/** The skip branch: from `if (cycleRunning) {` to its `return;`. */
function skipBranch(): string {
  const start = keeper.indexOf("if (cycleRunning) {");
  expect(start, "the overlap guard was not found").toBeGreaterThan(-1);
  const end = keeper.indexOf("return;", start);
  expect(end).toBeGreaterThan(start);
  return keeper.slice(start, end);
}

/** The body of noteSweepCost: what a finished sweep publishes. */
function noteSweepCost(): string {
  const start = keeper.indexOf("function noteSweepCost(");
  expect(start, "noteSweepCost was not found").toBeGreaterThan(-1);
  const end = keeper.indexOf("\n}\n", start);
  expect(end).toBeGreaterThan(start);
  return keeper.slice(start, end);
}

/** The sweep's `finally`, where the flag is cleared and the cost published. */
function sweepFinally(): string {
  const start = keeper.indexOf("} finally {\n    // THE FLAG FIRST");
  expect(start, "the sweep's finally was not found").toBeGreaterThan(-1);
  const end = keeper.indexOf("\n  }\n", start);
  expect(end).toBeGreaterThan(start);
  return keeper.slice(start, end);
}

describe("a skipped sweep", () => {
  it("is counted, both in total and in a row", () => {
    const branch = skipBranch();
    expect(branch).toContain("health.skipped += 1");
    expect(branch).toContain("health.consecutiveSkips += 1");
    // Still logged, where it always was.
    expect(branch).toContain("cycle skipped: the previous one is still running");
  });

  it("escalates on the same ladder as the vault read: warn, then critical at three in a row", () => {
    const branch = skipBranch();
    expect(branch).toContain("sweepSkippedAlert");
    expect(branch).toContain("alerter.fire");
    // The alerter dedupes by key alone, so the standing warning is cleared at
    // the escalation or it swallows the critical.
    expect(branch).toContain("SWEEP_SKIPPED_CRITICAL_STREAK");
    expect(branch).toContain("alerter.clear(SWEEP_SKIPPED_ALERT_KEY)");
  });

  it("says how long the sweep it waited for has been running", () => {
    // "A sweep was skipped" is not actionable; "the previous one has been
    // running for 240 s against a 60 s interval" names the lane to look at.
    expect(skipBranch()).toContain("cycleStartedAt");
    expect(keeper).toContain("cycleStartedAt = cycleBeganAt");
  });

  it("ends its run when a sweep completes, without undoing the total", () => {
    const body = noteSweepCost();
    expect(body).toContain("health.consecutiveSkips = 0");
    expect(body).toContain("alerter.clear(SWEEP_SKIPPED_ALERT_KEY)");
    // The total is the count of passes in which nobody was served. A later
    // sweep going through does not give those users their turn back.
    expect(body).not.toContain("health.skipped = 0");
  });
});

describe("what a finished sweep publishes", () => {
  it("times itself and keeps the percentiles over a BOUNDED ring", () => {
    const body = noteSweepCost();
    expect(body).toContain("health.lastSweepMs");
    expect(body).toContain("sweepTimes.add");
    expect(body).toContain("health.sweepMsP50");
    expect(body).toContain("health.sweepMsP90");
    // Bounded, because this process runs for weeks: createSweepTimes, not an
    // array that grows for as long as the container lives.
    expect(keeper).toContain("const sweepTimes = createSweepTimes()");
  });

  it("warns at 60 % of the interval, before the skip it predicts", () => {
    expect(noteSweepCost()).toContain("sweepSlowAlert");
    // And clears itself when the sweeps come back under the line, or the
    // warning would stand for the life of the process.
    expect(noteSweepCost()).toContain("alerter.clear(SWEEP_SLOW_ALERT_KEY)");
  });

  it("reports how many links it found and how many it served", () => {
    expect(keeper).toContain("health.linksDiscovered = links.length");
    expect(noteSweepCost()).toContain("health.linksTriaged = linksTriaged");
    // COUNTED OUTSIDE THE PER-WALLET TRY, so a turn that threw still counts as
    // a user who was looked at. Inside it, a throwing wallet would read as a
    // user nobody reached — the opposite of what happened.
    const increment = keeper.indexOf("linksTriaged += 1");
    const threw = keeper.indexOf('log.error("wallet turn threw"');
    expect(increment).toBeGreaterThan(threw);
  });

  it("splits the sweep into the phases that scale differently with users", () => {
    // Discovery is one request for everybody; the batched vault read is nearly
    // free up to 100 accounts; triage grows linearly with users; the walks are
    // sequential and can hold the whole sweep. Only a split says which one is
    // filling the interval.
    for (const phase of ["chainReadMs", "discoveryMs", "vaultReadMs", "triageMs", "expensiveMs"]) {
      // Declared before the try, so the `finally` publishes them even when the
      // sweep throws half way — a failed sweep's shape is the interesting one.
      expect(keeper.includes(`let ${phase} = 0;`), phase).toBe(true);
    }
    expect(sweepFinally()).toContain("chainReadMs, discoveryMs, vaultReadMs, triageMs, expensiveMs");
    // Each lane is charged from a clock, not guessed.
    expect(keeper).toContain("chainReadMs = Date.now() - chainReadAt");
    expect(keeper).toContain("discoveryMs = Date.now() - discoveryAt");
    expect(keeper).toContain("vaultReadMs = Date.now() - vaultReadAt");
    expect(keeper).toMatch(/if \(settleOutcome !== null && !settleWalked\(settleOutcome\)\) triageMs \+= turnMs;/);
    expect(keeper).toContain("else expensiveMs += turnMs");
  });

  it("publishes AFTER the running flag is cleared, and cannot wedge the keeper if it throws", () => {
    // THE ONE WAY THIS INSTRUMENTATION COULD CAUSE THE OUTAGE IT REPORTS. A
    // throw between `cycleRunning = true` and its reset leaves every later
    // sweep skipped — which is exactly the incident this file exists for.
    const body = sweepFinally();
    const cleared = body.indexOf("cycleRunning = false");
    const published = body.indexOf("noteSweepCost(");
    expect(cleared).toBeGreaterThan(-1);
    expect(published).toBeGreaterThan(cleared);
    expect(body.slice(cleared)).toContain("try {");
    expect(body.slice(cleared)).toContain("} catch (error) {");
  });
});

describe("the Jupiter budget, counted where it is spent", () => {
  it("is zeroed at the top of the sweep and read when the sweep ends", () => {
    expect(keeper).toContain("jupiterCalls.startSweep()");
    expect(noteSweepCost()).toContain("jupiterCalls.sweepTotal()");
  });

  it("counts both of the invest path's Jupiter calls BEFORE they are made", () => {
    // The keyless tier's 30-a-minute is spent by the REQUEST: a build that is
    // refused with a 429 has cost the budget just as surely as one that
    // answered, and counting after the await would under-report exactly while
    // the keeper was being throttled.
    const routeCount = venueDepth.indexOf("jupiterCalls.count(JUPITER_CALLS_PER_ROUTE_BUILD)");
    const routeCall = venueDepth.indexOf("await buildJupiterRoute(");
    const quoteCount = venueDepth.indexOf("jupiterCalls.count(JUPITER_CALLS_PER_QUOTE)");
    const quoteCall = venueDepth.indexOf("await fetchJupiterQuote(");
    expect(routeCount).toBeGreaterThan(-1);
    expect(quoteCount).toBeGreaterThan(-1);
    expect(routeCount).toBeLessThan(routeCall);
    expect(quoteCount).toBeLessThan(quoteCall);
  });

  it("counts at every Jupiter call site in the keeper, so the total cannot silently drift", () => {
    // If a third call site is ever added to this file, this fails until it is
    // counted too — the number on /status is the one the ceiling is read from.
    const calls = (haystack: string, needle: string): number => haystack.split(needle).length - 1;
    expect(calls(venueDepth, "await buildJupiterRoute(") + calls(venueDepth, "await fetchJupiterQuote(")).toBe(
      calls(venueDepth, "jupiterCalls.count("),
    );
  });
});

describe("which endpoint the keeper is actually on", () => {
  it("counts failovers and records the endpoint that answered", () => {
    expect(keeper).toContain("failovers += 1");
    expect(keeper).toContain("rpcEndpointInUse = at");
  });

  it("serves both on /status, by label and never by URL", () => {
    // The URLs carry API keys and /status is unauthenticated: `endpointLabel`
    // ("endpoint 2/3") is the only name an endpoint gets outside the request.
    expect(keeper).toContain("pendingCarries: pendingCarries(), rpcEndpointInUse, failovers");
    expect(keeper).not.toContain("rpcEndpointInUse = urls");
    expect(keeper).not.toMatch(/rpcEndpointInUse = .*reveal\(\)/);
  });
});
