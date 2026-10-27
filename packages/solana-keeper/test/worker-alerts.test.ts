// A WORKER'S ALERTS (src/worker-alerts.ts): the legacy sweep's ladder applied to
// one job's end — the same functions and keys, the streaks from the completion the
// job is about to write — and bin/worker.mts wired to fire them.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { INVEST_FAILED_CRITICAL_STREAK, WRAP_SHORT_ALERT_STREAK } from "../src/invest-decision.js";
import { SETTLE_RETRY_CRITICAL_AFTER } from "../src/settle-decision.js";
import { SETTLE_KEY_ALERT_KEY, investRefusedAlert, jobAlerts } from "../src/worker-alerts.js";
import { completionFor, readStreaks, type JobEnd, type JobReport, type JobStreaks, type LinkTurn } from "../src/worker-job.js";

const VAULT = "EFXK995PV49Qz8xPSYMEUDBU5AKRR466JkgsfuGak5iU";
const A = "eRau9u6adUyAzqrb89AUDM3ZgamFpVkDTXDtADmN2jT";
const B = "9QX53J3Kbs8ogQirZq5iN11rucZAvgF4EKWw98QAkUSe";
const NONE: JobStreaks = readStreaks({});

const turn = (wallet: string, outcome: LinkTurn["outcome"], extra: Partial<LinkTurn> = {}): LinkTurn => ({ link: `link-${wallet.slice(0, 4)}`, wallet, outcome, detail: `${outcome} detail`, ...extra });

/** A completed job, its completion computed exactly as runVaultJob computes it. */
function done(input: {
  settles: readonly LinkTurn[];
  invest: JobReport["invest"];
  previous?: JobStreaks;
  wrapShort?: boolean;
  investFacts?: JobReport["investFacts"];
  settleKey?: JobReport["settleKey"];
}): JobEnd {
  const report: JobReport = {
    vault: VAULT,
    fence: 7n,
    world: "live",
    live: true,
    mode: 1,
    module: "VOLUME",
    settles: input.settles,
    invest: input.invest,
    ...(input.investFacts === undefined ? {} : { investFacts: input.investFacts }),
    ...(input.settleKey === undefined ? {} : { settleKey: input.settleKey }),
    intents: 0,
    resolvedAtTakeover: 0,
  };
  const completion = completionFor({ settles: input.settles, invest: input.invest, wrapShort: input.wrapShort ?? false, previous: input.previous ?? NONE, unfinished: false });
  return { kind: "complete", completion, report };
}

const keys = (rules: ReturnType<typeof jobAlerts>) => ({ clear: [...rules.clear], fire: rules.fire.map((alert) => [alert.key, alert.severity]) });

describe("a job's settles, wallet by wallet, as the legacy sweep raises them", () => {
  it("pages a FAILED settle at once and clears what a SETTLED resolves, keyed by wallet", () => {
    expect(keys(jobAlerts(done({ settles: [turn(A, "FAILED"), turn(B, "SETTLED")], invest: { outcome: "IDLE", detail: "" } })))).toMatchObject({
      fire: [[`settle-failed:${A}`, "critical"]],
      clear: expect.arrayContaining([`settle-retry:${A}`, `settle-failed:${B}`, `settle-retry:${B}`]),
    });
  });

  it("warns on a RETRY and pages once the run reaches the legacy keeper's bound, counted in the row across jobs", () => {
    expect(keys(jobAlerts(done({ settles: [turn(A, "RETRY")], invest: null }))).fire).toEqual([[`settle-retry:${A}`, "warn"]]);
    const late = readStreaks({ settleRetries: { [A]: SETTLE_RETRY_CRITICAL_AFTER - 1 } });
    expect(keys(jobAlerts(done({ settles: [turn(A, "RETRY")], invest: null, previous: late }))).fire).toEqual([[`settle-failed:${A}`, "critical"]]);
  });

  it("neither counts nor pages a RETRY that waited on the shared carry store", () => {
    const waited = done({ settles: [turn(A, "RETRY", { waitingOn: "carry-store" })], invest: null, previous: readStreaks({ settleRetries: { [A]: 2 } }) });
    expect(jobAlerts(waited)).toEqual({ clear: [], fire: [], carryWaited: true });
    expect(readStreaks(waited.kind === "complete" ? waited.completion.streaks : {}).settleRetries[A]).toBe(2);
  });

  it("pages a settle turn that THREW as the legacy keeper does, and ends that wallet's RETRY run", () => {
    const threw = done({ settles: [turn(A, "THREW")], invest: null, previous: readStreaks({ settleRetries: { [A]: 2 } }) });
    expect(keys(jobAlerts(threw))).toEqual({ clear: [`settle-retry:${A}`], fire: [[`settle-failed:${A}`, "critical"]] });
    expect(readStreaks(threw.kind === "complete" ? threw.completion.streaks : {}).settleRetries[A]).toBeUndefined();
  });

  it("warns for a wallet with no signer, so a worker that cannot sign says so", () => {
    expect(keys(jobAlerts(done({ settles: [turn(A, "NO_SIGNER")], invest: null }))).fire).toEqual([[`no-signer:${A}`, "warn"]]);
  });
});

describe("the vault's invest, once a job", () => {
  it("warns on the first FAILED turn and pages critical on the third in a row, through the alerter's escalation (no clear, so a discarded COMPLETE cannot page it twice)", () => {
    expect(keys(jobAlerts(done({ settles: [], invest: { outcome: "FAILED", detail: "slippage" } }))).fire).toEqual([[`invest-failed:${VAULT}`, "warn"]]);
    const third = done({ settles: [], invest: { outcome: "FAILED", detail: "slippage" }, previous: readStreaks({ investFailed: INVEST_FAILED_CRITICAL_STREAK - 1 }) });
    const rules = keys(jobAlerts(third));
    expect(rules.fire).toEqual([[`invest-failed:${VAULT}`, "critical"]]);
    expect(rules.clear).not.toContain(`invest-failed:${VAULT}`);
  });

  it("counts a THROW in the invest half as a FAILED turn, as the legacy sweep folds it", () => {
    const threw = done({ settles: [], invest: { outcome: "THREW", detail: "rpc" }, previous: readStreaks({ investFailed: 1 }) });
    expect(readStreaks(threw.kind === "complete" ? threw.completion.streaks : {}).investFailed).toBe(2);
    expect(keys(jobAlerts(threw)).fire).toEqual([[`invest-failed:${VAULT}`, "warn"]]);
  });

  it("clears the failed warning once the vault rests, and the refused one only when a turn bought or failed, as the legacy sweep does", () => {
    const rests = done({ settles: [], invest: { outcome: "IDLE", detail: "" }, previous: readStreaks({ investFailed: 2 }) });
    expect(keys(jobAlerts(rests)).clear).toEqual(expect.arrayContaining([`invest-failed:${VAULT}`, `wrap-short:${VAULT}`]));
    for (const outcome of ["IDLE", "THREW", "DEFERRED", "PAUSED", "NO_POLICY"] as const) {
      expect(keys(jobAlerts(done({ settles: [], invest: { outcome, detail: "" } }))).clear, outcome).not.toContain(`invest-refused:${VAULT}`);
    }
    expect(keys(jobAlerts(done({ settles: [], invest: { outcome: "INVESTED", detail: "" } }))).clear).toContain(`invest-refused:${VAULT}`);
  });

  it("raises a refused basket in the legacy keeper's exact shape", () => {
    const refused = jobAlerts(done({ settles: [], invest: { outcome: "REFUSED", detail: "a leg is too thin" } }));
    expect(refused.fire).toContainEqual(investRefusedAlert(VAULT, "a leg is too thin"));
    expect(investRefusedAlert(VAULT, "x")).toEqual({ key: `invest-refused:${VAULT}`, severity: "warn", title: "A basket cannot be bought", detail: "x", context: { vault: VAULT } });
  });

  it("tells a crank that stays short of the vault on the third short turn, from the turn's own wrap report", () => {
    const wrap = { free: 5_000_000n, allowance: 1_000_000n, wrapped: 1_000_000n, short: true } as unknown as NonNullable<NonNullable<JobReport["investFacts"]>["wrap"]>;
    const third = done({ settles: [], invest: { outcome: "INVESTED", detail: "" }, wrapShort: true, investFacts: { wrap }, previous: readStreaks({ wrapShort: WRAP_SHORT_ALERT_STREAK - 1 }) });
    expect(keys(jobAlerts(third)).fire).toEqual([[`wrap-short:${VAULT}`, "warn"]]);
  });
});

describe("the settle key the chain names", () => {
  it("pages a key the chain no longer names, critical, though the job settled nothing and has no wallet turn to page", () => {
    const blocked = done({ settles: [], invest: null, settleKey: { kind: "mismatch", detail: "the on-chain ProtocolConfig names attester X" } });
    expect(keys(jobAlerts(blocked)).fire).toEqual([[SETTLE_KEY_ALERT_KEY, "critical"]]);
    expect(keys(jobAlerts(done({ settles: [turn(A, "IDLE")], invest: { outcome: "IDLE", detail: "" }, settleKey: { kind: "verified", detail: null } }))).clear).toContain(SETTLE_KEY_ALERT_KEY);
  });
});

describe("what the caller keeps between jobs", () => {
  it("clears the leg-fee warnings a vault raised before and no longer does, and says nothing when the turn did not look", () => {
    const looked = jobAlerts(done({ settles: [], invest: { outcome: "INVESTED", detail: "" }, investFacts: { feeWarnings: [] } }), { legFeeKeys: new Set(["leg-fee:MINT"]) });
    expect(looked.clear).toContain("leg-fee:MINT");
    expect(looked.legFeeKeys).toEqual(new Set());
    const blind = jobAlerts(done({ settles: [], invest: { outcome: "IDLE", detail: "" } }), { legFeeKeys: new Set(["leg-fee:MINT"]) });
    expect(blind.clear).not.toContain("leg-fee:MINT");
    expect(blind.legFeeKeys).toBeUndefined();
  });

  it("says when a settle waited on the shared carry store, for the caller to page the store once", () => {
    expect(jobAlerts(done({ settles: [turn(A, "RETRY", { waitingOn: "carry-store" })], invest: null })).carryWaited).toBe(true);
    expect(jobAlerts(done({ settles: [turn(A, "IDLE")], invest: null })).carryWaited).toBe(false);
  });
});

describe("only a completed job speaks", () => {
  it("raises and resolves nothing for a stopped job: it wrote no streaks, and the next job decides", () => {
    const end = done({ settles: [turn(A, "FAILED")], invest: { outcome: "FAILED", detail: "" } });
    const stopped: JobEnd = { kind: "stop", reason: "the lease was lost", report: end.report };
    expect(jobAlerts(stopped)).toEqual({ clear: [], fire: [], carryWaited: false });
  });
});

describe("bin/worker.mts fires them", () => {
  const worker = readFileSync(fileURLToPath(new URL("../bin/worker.mts", import.meta.url)), "utf8");

  it("builds an alerter on the keeper's destination, titled apart from the keepers", () => {
    expect(worker).toContain("const alerter = createAlerter({");
    expect(worker).toContain('titlePrefix: world === "shadow" ? "[worker, shadow] " : "[worker] ",');
    expect(worker).toContain("sanitize: (text) => scrubbedForExport(text),");
  });

  it("applies each job's rules after its log line, clearing before firing, and never lets an alert fail the job", () => {
    const after = worker.slice(worker.indexOf('log.info(end.kind === "complete" ? "job done" : "job stopped"'));
    expect(after.indexOf("const rules = jobAlerts(end, legFeeKeys === undefined ? {} : { legFeeKeys });")).toBeGreaterThan(-1);
    expect(after.indexOf("for (const key of rules.clear) alerter.clear(key);")).toBeLessThan(after.indexOf("for (const alert of rules.fire) alerter.fire(alert);"));
    expect(after.indexOf("} catch (error) {")).toBeLessThan(after.indexOf("return end;"));
  });

  it("pages a vault whose jobs keep throwing or overrunning, from the loop's own end hook", () => {
    expect(worker).toContain("onJobEnd,");
    expect(worker).toContain("const key = `job-failing:${vault}`;");
    expect(worker).toContain("severity: streak >= JOB_FAILING_CRITICAL_STREAK ? \"critical\" : \"warn\",");
  });

  it("raises the seat alert where a wallet's signer is resolved, and checks the authorization key at boot and on a cadence", () => {
    expect(worker).toContain("key: `seat-unbounded:${address}`,");
    expect(worker).toContain("recheckAuthorizationKey();");
    expect(worker).toContain("setInterval(recheckAuthorizationKey, AUTHORIZATION_KEY_RECHECK_MS)");
    expect(worker.indexOf("recheckAuthorizationKey();")).toBeLessThan(worker.indexOf("await loop.start();"));
  });
});
