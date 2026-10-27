// A WORKER'S ALERTS (src/worker-alerts.ts): the legacy sweep's ladder applied to
// one job's end — the same functions and keys, the streaks from the completion the
// job is about to write — and bin/worker.mts wired to fire them.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { INVEST_FAILED_CRITICAL_STREAK, UNMEASURED_BASKET_REFUSAL, WRAP_SHORT_ALERT_STREAK } from "../src/invest-decision.js";
import { SETTLE_RETRY_CRITICAL_AFTER } from "../src/settle-decision.js";
import { Secret } from "@sip/solana-log";
import { createAlerter, type AlertSeverity } from "../src/alerts.js";
import {
  INVEST_REFUSED_CRITICAL_STREAK,
  INVEST_REFUSED_UPSTREAM_ALERT_KEY,
  SETTLE_KEY_ALERT_KEY,
  UPSTREAM_REFUSAL_FORGET_MS,
  UpstreamRefusals,
  investRefusedAlert,
  jobAlerts,
} from "../src/worker-alerts.js";
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
  vault?: string;
}): JobEnd {
  const report: JobReport = {
    vault: input.vault ?? VAULT,
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

  it("raises a refused basket in the legacy keeper's exact shape while the refusal is new", () => {
    const refused = jobAlerts(done({ settles: [], invest: { outcome: "REFUSED", detail: "a leg is too thin" } }));
    expect(refused.fire).toContainEqual(investRefusedAlert(VAULT, "a leg is too thin"));
    expect(investRefusedAlert(VAULT, "x")).toEqual({ key: `invest-refused:${VAULT}`, severity: "warn", title: "A basket cannot be bought", detail: "x", context: { vault: VAULT } });
    expect(investRefusedAlert(VAULT, "x", INVEST_REFUSED_CRITICAL_STREAK - 1)).toEqual(investRefusedAlert(VAULT, "x"));
  });

  it("pages a refusal that persists: critical on the third REFUSED job in a row, counted in the row across jobs, with no clear before it", () => {
    expect(INVEST_REFUSED_CRITICAL_STREAK).toBe(3);
    const severities: string[] = [];
    let previous = NONE;
    for (let job = 1; job <= 4; job++) {
      const end = done({ settles: [], invest: { outcome: "REFUSED", detail: "a leg is too thin" }, previous });
      const rules = keys(jobAlerts(end));
      expect(rules.clear, `job ${job}`).not.toContain(`invest-refused:${VAULT}`);
      severities.push(...rules.fire.filter(([key]) => key === `invest-refused:${VAULT}`).map(([, severity]) => severity as string));
      previous = readStreaks(end.kind === "complete" ? end.completion.streaks : {});
    }
    expect(severities).toEqual(["warn", "warn", "critical", "critical"]);
    expect(previous.investRefused).toBe(4);
    const third = investRefusedAlert(VAULT, "a leg is too thin", 3);
    expect(third).toEqual({
      key: `invest-refused:${VAULT}`,
      severity: "critical",
      title: "A vault's basket keeps being refused",
      detail: "3 refused turns in a row, nothing bought: a leg is too thin",
      context: { vault: VAULT },
    });
  });

  it("does not let a deferral end the run, and starts again from a warn after a turn that bought", () => {
    // A DEFERRED turn attempted nothing: the streak holds, so the next refusal is the third.
    const deferred = done({ settles: [], invest: { outcome: "DEFERRED", detail: "the Jupiter budget is short" }, previous: readStreaks({ investRefused: 2 }) });
    const held = readStreaks(deferred.kind === "complete" ? deferred.completion.streaks : {});
    expect(held.investRefused).toBe(2);
    expect(keys(jobAlerts(done({ settles: [], invest: { outcome: "REFUSED", detail: "x" }, previous: held }))).fire).toContainEqual([`invest-refused:${VAULT}`, "critical"]);
    // A BUY clears the alert and the streak: the next refusal is a first one.
    const bought = done({ settles: [], invest: { outcome: "INVESTED", detail: "" }, previous: readStreaks({ investRefused: 5 }) });
    expect(keys(jobAlerts(bought)).clear).toContain(`invest-refused:${VAULT}`);
    const after = readStreaks(bought.kind === "complete" ? bought.completion.streaks : {});
    expect(keys(jobAlerts(done({ settles: [], invest: { outcome: "REFUSED", detail: "x" }, previous: after }))).fire).toContainEqual([`invest-refused:${VAULT}`, "warn"]);
  });

  it("reaches a critical-only destination on the third refusal, through the alerter's escalation, and not before", () => {
    // THE ALERTER AS bin/worker.mts BUILDS IT, on a destination that takes critical only, with REFUSED's own spacing (5 min, then 10).
    let now = 0;
    const posted: { severity: AlertSeverity; key: string }[] = [];
    const alerter = createAlerter({
      webhookUrl: new Secret("https://hooks.example.test/T000/B000/WebhookTokenNeverLogged", "alertWebhook"),
      minSeverity: "critical",
      now: () => now,
      post: async (_url, body) => void posted.push(JSON.parse(body) as { severity: AlertSeverity; key: string }),
      log: () => undefined,
    });
    let previous = NONE;
    for (const at of [0, 5 * 60_000, 15 * 60_000, 35 * 60_000]) {
      now = at;
      const end = done({ settles: [], invest: { outcome: "REFUSED", detail: "a leg is too thin" }, previous });
      const rules = jobAlerts(end);
      for (const key of rules.clear) alerter.clear(key);
      for (const alert of rules.fire) alerter.fire(alert);
      previous = readStreaks(end.kind === "complete" ? end.completion.streaks : {});
    }
    // ONE PAGE: the third job's critical; the fourth, 20 minutes on, is a repeat inside the window.
    expect(posted.map((body) => [body.key, body.severity])).toEqual([[`invest-refused:${VAULT}`, "critical"]]);
  });

  it("pages two minutes in, and every 30 minutes after, when a full pass turns the refused vault every tick (production's scheduler today)", () => {
    // NO DOORBELL SECRET: every 60 s tick is a full pass, which makes a vault that
    // did not rest due at once, whatever REFUSED_DUE_SECONDS asked for — so the
    // streak climbs once a minute, not at 5 and then 10 minutes.
    let now = 0;
    const posted: { at: number; severity: AlertSeverity }[] = [];
    const alerter = createAlerter({
      webhookUrl: new Secret("https://hooks.example.test/T000/B000/WebhookTokenNeverLogged", "alertWebhook"),
      minSeverity: "critical",
      now: () => now,
      post: async (_url, body) => void posted.push({ at: now, severity: (JSON.parse(body) as { severity: AlertSeverity }).severity }),
      log: () => undefined,
    });
    let previous = NONE;
    for (let minute = 0; minute <= 62; minute++) {
      now = minute * 60_000;
      const end = done({ settles: [], invest: { outcome: "REFUSED", detail: "a leg is too thin" }, previous });
      const rules = jobAlerts(end);
      for (const key of rules.clear) alerter.clear(key);
      for (const alert of rules.fire) alerter.fire(alert);
      previous = readStreaks(end.kind === "complete" ? end.completion.streaks : {});
    }
    expect(posted.map((page) => [page.at / 60_000, page.severity])).toEqual([
      [2, "critical"],
      [32, "critical"],
      [62, "critical"],
    ]);
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

  it("pages a basket nobody could measure once for every vault, beside each job's rules", () => {
    const after = worker.slice(worker.indexOf("const rules = jobAlerts(end, legFeeKeys === undefined ? {} : { legFeeKeys });"));
    expect(worker).toContain("const upstreamRefusals = new UpstreamRefusals();");
    expect(after.indexOf("const upstream = upstreamRefusals.observe(claimed.vault, rules.upstreamRefusal);")).toBeGreaterThan(-1);
    expect(after.indexOf("alerter.clear(INVEST_REFUSED_UPSTREAM_ALERT_KEY);")).toBeLessThan(after.indexOf("} catch (error) {"));
  });

  it("raises the seat alert where a wallet's signer is resolved, and checks the authorization key at boot and on a cadence", () => {
    expect(worker).toContain("key: `seat-unbounded:${address}`,");
    expect(worker).toContain("recheckAuthorizationKey();");
    expect(worker).toContain("setInterval(recheckAuthorizationKey, AUTHORIZATION_KEY_RECHECK_MS)");
    expect(worker.indexOf("recheckAuthorizationKey();")).toBeLessThan(worker.indexOf("await loop.start();"));
  });
});

describe("a refusal the upstream caused: the basket's venues could not be measured", () => {
  const OUTAGE = `${UNMEASURED_BASKET_REFUSAL}Error: Jupiter answered HTTP 503 at api.jup.ag/swap/v1/quote — refusing the whole basket`;
  const FUNDED = ["Funded1", "Funded2", "Funded3", "Funded4"].map((name) => name.padEnd(44, "1"));

  /** bin/worker.mts's order on a critical-only destination: each job's rules, then the upstream page. */
  function worker() {
    let now = 0;
    const posted: { at: number; key: string; severity: AlertSeverity }[] = [];
    const alerter = createAlerter({
      webhookUrl: new Secret("https://hooks.example.test/T000/B000/WebhookTokenNeverLogged", "alertWebhook"),
      minSeverity: "critical",
      now: () => now,
      post: async (_url, body) => {
        const parsed = JSON.parse(body) as { key: string; severity: AlertSeverity };
        posted.push({ at: now / 60_000, key: parsed.key, severity: parsed.severity });
      },
      log: () => undefined,
    });
    const upstream = new UpstreamRefusals({ now: () => now });
    const previous = new Map<string, JobStreaks>();
    const job = (vault: string, invest: JobReport["invest"]) => {
      const end = done({ vault, settles: [], invest, previous: previous.get(vault) ?? NONE });
      const rules = jobAlerts(end);
      for (const key of rules.clear) alerter.clear(key);
      for (const alert of rules.fire) alerter.fire(alert);
      const decision = upstream.observe(vault, rules.upstreamRefusal);
      if (decision.fire !== null) alerter.fire(decision.fire);
      else if (decision.clear) alerter.clear(INVEST_REFUSED_UPSTREAM_ALERT_KEY);
      previous.set(vault, readStreaks(end.kind === "complete" ? end.completion.streaks : {}));
      return rules;
    };
    return { posted, job, at: (minute: number) => (now = minute * 60_000) };
  }

  it("pages one Jupiter outage once for four refused vaults, not four times, and keeps each vault's own key a warn", () => {
    const w = worker();
    for (let minute = 0; minute <= 35; minute++) {
      w.at(minute);
      for (const vault of FUNDED) {
        const rules = w.job(vault, { outcome: "REFUSED", detail: OUTAGE });
        expect(rules.fire.find((alert) => alert.key === `invest-refused:${vault}`)?.severity).toBe("warn");
      }
    }
    // BEFORE: four criticals at minute 2 and four more at minute 32, all for one cause.
    expect(w.posted.map((page) => [page.at, page.key])).toEqual([
      [2, INVEST_REFUSED_UPSTREAM_ALERT_KEY],
      [32, INVEST_REFUSED_UPSTREAM_ALERT_KEY],
    ]);
  });

  it("still pages a vault's own refusal — a drained pool — on that vault's key, beside the outage", () => {
    const w = worker();
    for (let minute = 0; minute <= 2; minute++) {
      w.at(minute);
      w.job(FUNDED[0]!, { outcome: "REFUSED", detail: OUTAGE });
      w.job(FUNDED[1]!, { outcome: "REFUSED", detail: "the leg's pool holds $51 against a $149 buy: too thin" });
    }
    expect(w.posted.map((page) => page.key).sort()).toEqual([INVEST_REFUSED_UPSTREAM_ALERT_KEY, `invest-refused:${FUNDED[1]!}`].sort());
  });

  it("clears once no refused vault is left at the streak — one bought, the other forgotten unheard of — and starts again from a warn", () => {
    let now = 0;
    const upstream = new UpstreamRefusals({ now: () => now });
    const three = { streak: INVEST_REFUSED_CRITICAL_STREAK, detail: OUTAGE };
    expect(upstream.observe(FUNDED[0]!, { streak: 1, detail: OUTAGE })).toEqual({ fire: null, clear: false });
    const page = upstream.observe(FUNDED[0]!, three).fire!;
    expect([page.key, page.severity]).toEqual([INVEST_REFUSED_UPSTREAM_ALERT_KEY, "critical"]);
    expect(page.detail).toContain("1 vault's basket is refused because the venues could not be measured");
    expect(page.detail).toContain("Jupiter answered HTTP 503");
    expect(upstream.observe(FUNDED[1]!, { streak: 1, detail: OUTAGE }).fire?.detail).toContain("2 vaults' baskets are refused because the venues could not be measured, 1 of them for 3 turns");
    // A DEFERRAL OR A REST SAYS NOTHING: the page stands.
    expect(upstream.observe(FUNDED[0]!, undefined).fire).not.toBeNull();
    // FUNDED[0] BOUGHT: nobody is left at the streak.
    expect(upstream.observe(FUNDED[0]!, null)).toEqual({ fire: null, clear: true });
    // FUNDED[1] REACHES IT, THEN IS NEVER HEARD OF AGAIN (unlinked, handed back): forgotten, and the page clears.
    expect(upstream.observe(FUNDED[1]!, three).fire).not.toBeNull();
    now = UPSTREAM_REFUSAL_FORGET_MS + 1;
    expect(upstream.observe(FUNDED[2]!, undefined)).toEqual({ fire: null, clear: true });
  });
});
