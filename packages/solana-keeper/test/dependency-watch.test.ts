// dep-down (src/dependency-watch.ts): one page per shared dependency that is
// down, instead of a generic sweep-failed and a page per wallet; the per-wallet
// alerts that outage explains are held while it lasts.
//
// The ADR's named test (§4.9 row 24) is written for Pyth, which this keeper reads
// through the RPC (src/pyth.ts) — so its shared-outage case here is Privy's:
// "N wallets sharing one Privy outage produce exactly one critical". Every alert
// below is built by the keeper's own builders (settleAlert, investFailedAlert, …)
// and delivered by the real createAlerter, so a renamed title or key breaks this
// file rather than the gate in production.

import { describe, expect, it } from "vitest";
import { createAlerter, type Alert, type Alerter } from "../src/alerts.js";
import { discoveryStaleAlert } from "../src/discovery-lkg.js";
import {
  DEP_DOWN_MIN_MS,
  DEP_DOWN_STREAK,
  DependencyWatch,
  RPC_POOL_REFUSED,
  answerOutcome,
  depDownAlerts,
  depDownKey,
  explainedBy,
  gatedAlerter,
  isJupiterHost,
  observeGlobalFetch,
  unansweredOutcome,
  watchedRpcFetch,
} from "../src/dependency-watch.js";
import { investFailedAlert } from "../src/invest-decision.js";
import { Secret } from "@sip/solana-log";
import { SETTLE_RETRY_CRITICAL_AFTER, settleAlert, settleThrewAlert } from "../src/settle-decision.js";
import { vaultReadAlert } from "../src/sweep-decision.js";

const T0 = 1_700_000_000_000;
const where = (n: number) => ({ wallet: `Wallet${n}`, vault: `Vault${n}` });

/** A real alerter at the production threshold, whose sends are captured as they leave. */
function box(): { readonly alerter: Alerter; readonly sent: { readonly key: string; readonly severity: string }[] } {
  const sent: { key: string; severity: string }[] = [];
  const alerter = createAlerter({
    webhookUrl: new Secret("https://hooks.example.test/one", "SIP_SOLANA_ALERT_WEBHOOK"),
    minSeverity: "critical",
    log: () => {},
    post: async (_url, body) => {
      const parsed = JSON.parse(body) as { key: string; severity: string };
      sent.push({ key: parsed.key, severity: parsed.severity });
    },
  });
  return { alerter, sent };
}

describe("answerOutcome: what counts as down", () => {
  it("is an answer for any 2xx and for a 4xx refusing THIS request; a failure for 408, 429 and 5xx", () => {
    for (const status of [200, 204, 400, 401, 403, 404, 409]) expect(answerOutcome(status), String(status)).toEqual({ ok: true });
    for (const status of [408, 429, 500, 502, 503, 504]) expect(answerOutcome(status), String(status)).toEqual({ ok: false, reason: `HTTP ${status}` });
  });

  it("names an unanswered request by its error's NAME only — a message can quote a host", () => {
    const error = new TypeError("fetch failed: https://key-bearing.example/?api-key=secret");
    expect(unansweredOutcome(error)).toEqual({ ok: false, reason: "no answer (TypeError)" });
  });
});

describe("DependencyWatch: the down rule", () => {
  it(`is ${DEP_DOWN_STREAK} failures in a row spanning at least ${DEP_DOWN_MIN_MS / 1000} s — a burst inside one second is weather`, () => {
    const watch = new DependencyWatch();
    for (let i = 0; i < 5; i += 1) watch.failed("privy", T0 + i * 100, "HTTP 503");
    expect(watch.isDown("privy", T0 + 500)).toBe(false);
    expect(watch.isDown("privy", T0 + DEP_DOWN_MIN_MS)).toBe(true);
  });

  it("needs the streak, not just the time", () => {
    const watch = new DependencyWatch();
    watch.failed("jupiter", T0, "HTTP 502");
    watch.failed("jupiter", T0 + 2 * DEP_DOWN_MIN_MS, "HTTP 502");
    expect(watch.isDown("jupiter", T0 + 3 * DEP_DOWN_MIN_MS)).toBe(false);
    watch.failed("jupiter", T0 + 3 * DEP_DOWN_MIN_MS, "HTTP 502");
    expect(watch.isDown("jupiter", T0 + 3 * DEP_DOWN_MIN_MS)).toBe(true);
  });

  it("is ended by any answer, and a new run starts its clock again", () => {
    const watch = new DependencyWatch();
    for (let i = 0; i < 3; i += 1) watch.failed("postgres", T0 + i * DEP_DOWN_MIN_MS, "no answer from the database");
    expect(watch.isDown("postgres", T0 + 2 * DEP_DOWN_MIN_MS)).toBe(true);
    watch.ok("postgres", T0 + 3 * DEP_DOWN_MIN_MS);
    expect(watch.isDown("postgres", T0 + 3 * DEP_DOWN_MIN_MS)).toBe(false);
    for (let i = 0; i < 3; i += 1) watch.failed("postgres", T0 + 4 * DEP_DOWN_MIN_MS + i, "no answer from the database");
    expect(watch.isDown("postgres", T0 + 4 * DEP_DOWN_MIN_MS + 10)).toBe(false);
  });

  it("keeps each dependency's run apart", () => {
    const watch = new DependencyWatch();
    for (let i = 0; i < 3; i += 1) watch.failed("rpc", T0 + i * DEP_DOWN_MIN_MS, RPC_POOL_REFUSED);
    expect(watch.isDown("rpc", T0 + 2 * DEP_DOWN_MIN_MS)).toBe(true);
    for (const other of ["privy", "jupiter", "postgres"] as const) expect(watch.isDown(other, T0 + 2 * DEP_DOWN_MIN_MS)).toBe(false);
  });
});

describe("DependencyWatch: a sweep that failed on the RPC", () => {
  it("names the RPC when the sweep's last RPC request failed and nothing answered after it", () => {
    const watch = new DependencyWatch();
    watch.ok("rpc", T0 + 10);
    watch.failed("rpc", T0 + 20, RPC_POOL_REFUSED);
    expect(watch.sweepFailureCause(T0)).toBe("rpc");
  });

  it("does not, when the RPC answered after the failure — the sweep failed on something else", () => {
    const watch = new DependencyWatch();
    watch.failed("rpc", T0 + 10, RPC_POOL_REFUSED);
    watch.ok("rpc", T0 + 20);
    expect(watch.sweepFailureCause(T0)).toBeNull();
  });

  it("does not blame a failure from before the sweep began", () => {
    const watch = new DependencyWatch();
    watch.failed("rpc", T0 - 1, RPC_POOL_REFUSED);
    expect(watch.sweepFailureCause(T0)).toBeNull();
  });

  it("is down at once, without the streak, until the RPC's next answer", () => {
    const watch = new DependencyWatch();
    watch.failed("rpc", T0, RPC_POOL_REFUSED);
    watch.sweepFailedOn("rpc", "Error: every Solana endpoint refused (endpoint 1/1 HTTP 503)");
    expect(watch.isDown("rpc", T0)).toBe(true);
    expect(watch.status(T0).rpc.lastFailure).toBe("Error: every Solana endpoint refused (endpoint 1/1 HTTP 503)");
    watch.ok("rpc", T0 + 1);
    expect(watch.isDown("rpc", T0 + 1)).toBe(false);
  });
});

describe("explainedBy: what an outage holds, from the keeper's own alerts", () => {
  it("holds a settle that does not land for the RPC or Privy, and a throw for the RPC — never a refusal", () => {
    expect(explainedBy(settleAlert("RETRY", where(1), "Privy answered 503", 1).fire!)).toEqual(["rpc", "privy"]);
    expect(explainedBy(settleAlert("RETRY", where(1), "Privy answered 503", SETTLE_RETRY_CRITICAL_AFTER).fire!)).toEqual(["rpc", "privy"]);
    expect(explainedBy(settleThrewAlert(where(1), "fetch failed").fire!)).toEqual(["rpc"]);
    // THE SAME KEY, A DIFFERENT CONDITION: a refusal names a defect, and nothing shared causes it.
    expect(settleAlert("FAILED", where(1), "WrongAttester").fire!.key).toBe(settleThrewAlert(where(1), "x").fire!.key);
    expect(explainedBy(settleAlert("FAILED", where(1), "WrongAttester").fire!)).toEqual([]);
  });

  it("holds the sweep's own failures for the RPC, a basket for the RPC or Jupiter, and not-acting for Postgres", () => {
    const sweepFailed: Alert = { key: "sweep-failed", severity: "critical", title: "The keeper's sweep is failing", detail: "x" };
    expect(explainedBy(sweepFailed)).toEqual(["rpc"]);
    expect(explainedBy(vaultReadAlert(3, "x"))).toEqual(["rpc"]);
    expect(explainedBy(discoveryStaleAlert(3, 11 * 60_000, "x"))).toEqual(["rpc"]);
    expect(explainedBy(investFailedAlert("Vault1", 3, "x"))).toEqual(["rpc", "jupiter"]);
    expect(explainedBy({ key: "invest-refused:Vault1", severity: "warn", title: "A basket cannot be bought", detail: "x" })).toEqual(["rpc", "jupiter"]);
    expect(explainedBy({ key: "not-acting", severity: "critical", title: "Armed, but another keeper holds the claim", detail: "x" })).toEqual([
      "postgres",
    ]);
  });

  it("holds nothing that is the wallet's or the owner's own", () => {
    for (const outcome of ["NO_SIGNER", "INCOMPLETE"] as const) expect(explainedBy(settleAlert(outcome, where(1), "x").fire!)).toEqual([]);
    for (const key of ["crank-low", "seat-unbounded:W", "claim-lost", "credit-burn", "leg-fee:M:300", "wrap-short:V", "dep-down:rpc"]) {
      expect(explainedBy({ key, severity: "critical", title: "t", detail: "d" }), key).toEqual([]);
    }
  });
});

describe("dep-down: N wallets sharing one Privy outage produce exactly one critical", () => {
  /** Three sweeps a minute apart, five wallets whose settles come back RETRY each time, Privy failing throughout. */
  function outage(gated: boolean) {
    const { alerter: inner, sent } = box();
    const watch = new DependencyWatch();
    const alerter = gated ? gatedAlerter(inner, watch, () => clock) : inner;
    let clock = T0;
    const retries = new Map<string, number>();
    for (let sweep = 1; sweep <= SETTLE_RETRY_CRITICAL_AFTER; sweep += 1) {
      clock = T0 + sweep * 60_000;
      for (let n = 1; n <= 5; n += 1) {
        // The settle's send went to Privy and got a 503.
        watch.failed("privy", clock, "HTTP 503");
        const streak = (retries.get(`Wallet${n}`) ?? 0) + 1;
        retries.set(`Wallet${n}`, streak);
        const rule = settleAlert("RETRY", where(n), "Privy answered 503; the next sweep reads the vault and the link again", streak);
        for (const key of rule.clear) alerter.clear(key);
        if (rule.fire !== null) alerter.fire(rule.fire);
      }
      if (gated) {
        const down = depDownAlerts(watch, clock);
        for (const key of down.clear) alerter.clear(key);
        for (const page of down.fire) alerter.fire(page);
      }
    }
    return { sent, watch, alerter, clock };
  }

  it("without the gate: one critical per wallet (the control)", () => {
    const { sent } = outage(false);
    expect(sent.filter((s) => s.severity === "critical").map((s) => s.key)).toEqual([1, 2, 3, 4, 5].map((n) => `settle-failed:Wallet${n}`));
  });

  it("with it: dep-down:privy once, every wallet's alert held and counted", () => {
    const { sent, watch, clock } = outage(true);
    expect(sent).toEqual([{ key: "dep-down:privy", severity: "critical" }]);
    const status = watch.status(clock).privy;
    expect(status.down).toBe(true);
    // The first sweep's five warns go out to the log before Privy is down (the
    // streak needs its minute); the next two sweeps' ten are held.
    expect(status.held).toBe(10);
  });

  it("clears with Privy's first answer, and a wallet still failing after it pages for itself", () => {
    const { sent, watch, alerter } = outage(true);
    const after = T0 + 10 * 60_000;
    watch.ok("privy", after);
    const down = depDownAlerts(watch, after);
    expect(down.fire).toEqual([]);
    expect(down.clear).toContain(depDownKey("privy"));
    for (const key of down.clear) alerter.clear(key);
    alerter.fire(settleAlert("RETRY", where(1), "AttestationExpired", SETTLE_RETRY_CRITICAL_AFTER + 1).fire!);
    expect(sent.map((s) => s.key)).toEqual(["dep-down:privy", "settle-failed:Wallet1"]);
  });
});

describe("dep-down: instead of the generic sweep-failed", () => {
  it("a sweep that ended on 'every endpoint refused' pages dep-down:rpc once, not sweep-failed, until the RPC answers", () => {
    const { alerter: inner, sent } = box();
    const watch = new DependencyWatch();
    let clock = T0;
    const alerter = gatedAlerter(inner, watch, () => clock);
    const failingSweep = (at: number): void => {
      clock = at;
      watch.failed("rpc", at, RPC_POOL_REFUSED);
      // bin/keeper.mts's catch, in its order.
      const cause = watch.sweepFailureCause(at);
      if (cause !== null) watch.sweepFailedOn(cause, "Error: every Solana endpoint refused (endpoint 1/1 HTTP 503)");
      alerter.fire({ key: "sweep-failed", severity: "critical", title: "The keeper's sweep is failing", detail: "x" });
      const down = depDownAlerts(watch, at);
      for (const key of down.clear) alerter.clear(key);
      for (const page of down.fire) alerter.fire(page);
    };
    failingSweep(T0);
    failingSweep(T0 + 60_000);
    expect(sent).toEqual([{ key: "dep-down:rpc", severity: "critical" }]);
    // Recovery clears it; the next outage pages again.
    watch.ok("rpc", T0 + 120_000);
    for (const key of depDownAlerts(watch, T0 + 120_000).clear) alerter.clear(key);
    failingSweep(T0 + 180_000);
    expect(sent).toEqual([
      { key: "dep-down:rpc", severity: "critical" },
      { key: "dep-down:rpc", severity: "critical" },
    ]);
  });

  it("a sweep that failed with the RPC answering is still sweep-failed", () => {
    const { alerter: inner, sent } = box();
    const watch = new DependencyWatch();
    const alerter = gatedAlerter(inner, watch, () => T0);
    watch.ok("rpc", T0);
    expect(watch.sweepFailureCause(T0)).toBeNull();
    alerter.fire({ key: "sweep-failed", severity: "critical", title: "The keeper's sweep is failing", detail: "x" });
    expect(sent).toEqual([{ key: "sweep-failed", severity: "critical" }]);
  });
});

describe("gatedAlerter", () => {
  it("passes clear and delivery through, and lets an alert out if its own question throws", () => {
    const { alerter: inner, sent } = box();
    const broken = new DependencyWatch();
    broken.isDown = () => {
      throw new Error("broken");
    };
    const alerter = gatedAlerter(inner, broken);
    alerter.fire({ key: "sweep-failed", severity: "critical", title: "t", detail: "d" });
    expect(sent).toHaveLength(1);
    alerter.clear("sweep-failed");
    alerter.fire({ key: "sweep-failed", severity: "critical", title: "t", detail: "d" });
    expect(sent).toHaveLength(2);
    expect(alerter.delivery()).toEqual(inner.delivery());
  });
});

describe("depDownAlert", () => {
  it("is a once-only critical under dep-down:<dep>, in fixed words, naming what it holds", () => {
    const watch = new DependencyWatch();
    for (let i = 0; i < 3; i += 1) watch.failed("jupiter", T0 + i * 30_000, "HTTP 502");
    const [page] = depDownAlerts(watch, T0 + 60_000).fire;
    expect(page).toMatchObject({ key: "dep-down:jupiter", severity: "critical", once: true });
    expect(page!.detail).toContain("3 requests in a row failed over 60 s; last: HTTP 502.");
    expect(page!.detail).toContain("invest-refused, invest-failed");
    expect(page!.detail).not.toMatch(/https?:/);
  });
});

describe("watchedRpcFetch", () => {
  it("hands back the pool's own response and records an answer", async () => {
    const watch = new DependencyWatch();
    const response = new Response("{}", { status: 200 });
    const watched = watchedRpcFetch((async () => response) as typeof fetch, watch, () => T0);
    expect(await watched("https://ignored.example", { method: "POST" })).toBe(response);
    expect(watch.status(T0).rpc.lastOkAt).toBe(new Date(T0).toISOString());
  });

  it("rethrows the pool's own error unchanged and records the failure in fixed words, never its message", async () => {
    const watch = new DependencyWatch();
    const thrown = new Error("every Solana endpoint refused (endpoint 1/2 HTTP 429; endpoint 2/2 TypeError)");
    const watched = watchedRpcFetch((async () => {
      throw thrown;
    }) as typeof fetch, watch, () => T0);
    await expect(watched("https://ignored.example")).rejects.toBe(thrown);
    expect(watch.status(T0).rpc).toMatchObject({ failuresInRow: 1, lastFailure: RPC_POOL_REFUSED });
  });
});

describe("observeGlobalFetch", () => {
  const jupiterQuote = "https://lite-api.jup.ag/swap/v1/quote?inputMint=a&outputMint=b&amount=1";
  const rpc = "https://mainnet.helius-rpc.example/?api-key=not-a-real-key";

  it("reports Jupiter's answers only, and returns every response — Jupiter's or not — untouched", async () => {
    const answers = new Map<string, Response>([
      [jupiterQuote, new Response("{}", { status: 429 })],
      [rpc, new Response("{}", { status: 200 })],
    ]);
    const scope = { fetch: (async (input: string) => answers.get(input)!) as unknown as typeof fetch };
    const reported: (number | "unanswered")[] = [];
    const undo = observeGlobalFetch(scope, isJupiterHost, (answer) => void reported.push(answer));
    expect(await scope.fetch(jupiterQuote)).toBe(answers.get(jupiterQuote));
    expect(await scope.fetch(rpc)).toBe(answers.get(rpc));
    expect(reported).toEqual([429]);
    undo();
    await scope.fetch(jupiterQuote);
    expect(reported).toEqual([429]);
  });

  it("rethrows a refused request unchanged, and a report that throws changes nothing", async () => {
    const thrown = new TypeError("fetch failed");
    const scope = {
      fetch: (async () => {
        throw thrown;
      }) as unknown as typeof fetch,
    };
    observeGlobalFetch(scope, isJupiterHost, () => {
      throw new Error("observer broke");
    });
    await expect(scope.fetch(jupiterQuote)).rejects.toBe(thrown);
  });

  it("knows Jupiter's hosts and nobody else's", () => {
    for (const host of ["jup.ag", "lite-api.jup.ag", "api.jup.ag"]) expect(isJupiterHost(host), host).toBe(true);
    for (const host of ["notjup.ag", "jup.ag.evil.example", "mainnet.helius-rpc.com", "api.privy.io"]) expect(isJupiterHost(host), host).toBe(false);
  });
});
