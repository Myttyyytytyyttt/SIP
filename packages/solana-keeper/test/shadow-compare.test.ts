// THE LOCAL SHADOW'S ARITHMETIC (src/shadow-compare.ts): production's per-wallet
// decision from the two legacy /status bodies, the shadow's from the workers' job
// lines, the minute's comparison and its explanations, the listings a minute,
// the credits, the coverage clock of a run that resumes, and the long run's
// drill plan — each on the shapes the harness records (test-local/shadow).

import { describe, expect, it } from "vitest";
import {
  COMPARE_MAX_AGE_MS,
  COVER_MAX_STEP_MS,
  DETAIL_CHARS,
  agreementOf,
  compareAt,
  coverageOf,
  creditsOf,
  drillLedger,
  explainMismatches,
  foldShadowJobs,
  listingsPerMinute,
  listingsPerTick,
  perDay,
  investRestsByName,
  productionDecisions,
  replayComparison,
  weeklyDrillPlan,
  type CompareRow,
  type ShadowWallet,
} from "../src/shadow-compare.js";
import { investRests } from "../src/doorbell.js";

const T0 = Date.parse("2026-10-13T00:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const PROFIT_W = "84gLa2HFbk8H43s5dtebuyjmeCMqMSXpXSaySw5ZEQct";
const VOLUME_W = "eRau9u6adUyAzqrb89AUDM3ZgamFpVkDTXDtADmN2jT";
const VAULT = "EFXK995Pvault1111111111111111111111111111111";

/** The two production bodies as /status serves them (2026-10-12, trimmed to what is read). */
function production(at: number, overrides: { profitSettle?: string; volumeSettle?: string; invest?: string } = {}) {
  return {
    profit: {
      role: "profit",
      wallets: {
        [PROFIT_W]: { settle: overrides.profitSettle ?? "IDLE", invest: "NO_POLICY", detail: "nothing since slot 452454667", at: iso(at) },
        [VOLUME_W]: { settle: "UNSUPPORTED_MODE", invest: overrides.invest ?? "IDLE", detail: "this vault saves in VOLUME mode, which the volume keeper settles", at: iso(at) },
      },
    },
    volume: {
      role: "volume",
      wallets: {
        [PROFIT_W]: { settle: "UNSUPPORTED_MODE", invest: "none (volume keeper)", detail: "this vault saves in PROFIT mode", at: iso(at) },
        [VOLUME_W]: { settle: overrides.volumeSettle ?? "IDLE", invest: "none (volume keeper)", detail: "only our own settle since slot 455120195; nothing to charge", at: iso(at - 5_000) },
      },
    },
  };
}

const jobLine = (at: number, wallets: { wallet: string; settle: string; detail: string }[], invest: string, event = "job done") => ({
  ts: iso(at),
  event,
  vault: VAULT,
  wallets,
  invest,
  investDetail: "nothing to invest",
});

describe("production's decision per wallet", () => {
  it("takes the settle from the keeper that serves the wallet's mode and the invest from the profit keeper", () => {
    const { profit, volume } = production(T0);
    const decided = productionDecisions(profit, volume);
    expect(decided.get(PROFIT_W)).toMatchObject({ settle: "IDLE", invest: "NO_POLICY", servedBy: "profit", detail: "nothing since slot 452454667", at: T0 });
    // THE VOLUME WALLET: settled by the volume keeper (its row's time), invested by the profit keeper — never "none (volume keeper)".
    expect(decided.get(VOLUME_W)).toMatchObject({ settle: "IDLE", invest: "IDLE", servedBy: "volume", at: T0 - 5_000 });
  });

  it("says UNSUPPORTED_MODE only when both keepers answered that neither serves the wallet", () => {
    const both = productionDecisions(
      { wallets: { X: { settle: "UNSUPPORTED_MODE", invest: "IDLE", detail: "no keeper settles byte 2", at: iso(T0) } } },
      { wallets: { X: { settle: "UNSUPPORTED_MODE", invest: "none (volume keeper)", detail: "", at: iso(T0) } } },
    );
    expect(both.get("X")).toMatchObject({ settle: "UNSUPPORTED_MODE", invest: "IDLE", servedBy: "none" });
    expect(productionDecisions("not json", undefined).size).toBe(0);
  });

  it("leaves a wallet out when a keeper it needs did not answer: no profit keeper, no invest; profit says not mine and no volume keeper, no settle (the 7-day shadow's 10 at 2026-10-15 05:48 and 2026-10-21 09:41–09:43)", () => {
    const { profit, volume } = production(T0);
    // THE PROFIT KEEPER'S FETCH GOT NO ANSWER: the volume keeper's settle is there, the invest is not — no decision.
    expect(productionDecisions(null, volume).size).toBe(0);
    // THE VOLUME KEEPER'S FETCH GOT NO ANSWER: the profit wallet is whole, the volume wallet has no settle.
    const noVolume = productionDecisions(profit, { error: "502" });
    expect([...noVolume.keys()]).toEqual([PROFIT_W]);
    expect(noVolume.get(PROFIT_W)).toMatchObject({ settle: "IDLE", invest: "NO_POLICY", servedBy: "profit" });
    // So the comparison lists them as no-production gaps, never as mismatches.
    const shadow = new Map<string, ShadowWallet>([[VOLUME_W, { wallet: VOLUME_W, vault: VAULT, settle: "IDLE", invest: "IDLE", detail: "", investDetail: null, at: T0, process: "worker-a" }]]);
    expect(compareAt(T0 + 1_000, noVolume, shadow).find((row) => row.wallet === VOLUME_W)?.verdict).toBe("no-production");
  });
});

describe("the shadow's decision per wallet, from the workers' job lines", () => {
  it("keeps each wallet's newest completed job and ignores stopped jobs and lines that name no wallet", () => {
    const shadow = new Map<string, ShadowWallet>();
    foldShadowJobs(shadow, jobLine(T0 + 2_000, [{ wallet: VOLUME_W, settle: "IDLE", detail: "only our own settle since slot 455120195" }], "IDLE"), "worker-a");
    foldShadowJobs(shadow, jobLine(T0 + 1_000, [{ wallet: VOLUME_W, settle: "RETRY", detail: "older" }], "IDLE"), "worker-b");
    foldShadowJobs(shadow, jobLine(T0 + 9_000, [{ wallet: VOLUME_W, settle: "SETTLED", detail: "stopped" }], "IDLE", "job stopped"), "worker-b");
    foldShadowJobs(shadow, { ts: iso(T0 + 9_000), event: "job done", vault: VAULT, invest: null }, "worker-b");
    expect([...shadow.values()]).toEqual([
      { wallet: VOLUME_W, vault: VAULT, settle: "IDLE", invest: "IDLE", detail: "only our own settle since slot 455120195", investDetail: "nothing to invest", at: T0 + 2_000, process: "worker-a" },
    ]);
  });
});

describe("the minute's comparison", () => {
  const shadowOf = (at: number, settle: string, invest: string, detail = "only our own settle since slot 455120195"): Map<string, ShadowWallet> =>
    new Map([[VOLUME_W, { wallet: VOLUME_W, vault: VAULT, settle, invest, detail, investDetail: null, at, process: "worker-a" }]]);

  it("agrees when settle and invest are equal, mismatches when either differs, and reads each side's frontier slot", () => {
    const { profit, volume } = production(T0);
    const prod = productionDecisions(profit, volume);
    const [agree] = compareAt(T0 + 10_000, new Map([[VOLUME_W, prod.get(VOLUME_W)!]]), shadowOf(T0 + 3_000, "IDLE", "IDLE"));
    expect(agree).toMatchObject({ verdict: "agree", frontier: { production: "455120195", shadow: "455120195", equal: true } });
    const [investDiffers] = compareAt(T0 + 10_000, new Map([[VOLUME_W, prod.get(VOLUME_W)!]]), shadowOf(T0 + 3_000, "IDLE", "DEFERRED"));
    expect(investDiffers!.verdict).toBe("mismatch");
    // A ROW KEEPS EACH SIDE'S DETAIL, CUT: the start of a long one.
    const [long] = compareAt(T0 + 10_000, new Map([[VOLUME_W, prod.get(VOLUME_W)!]]), shadowOf(T0 + 3_000, "IDLE", "IDLE", "y".repeat(1_000)));
    expect(long!.shadow!.detail).toBe("y".repeat(DETAIL_CHARS));
    expect(long!.production!.detail).toBe("only our own settle since slot 455120195; nothing to charge");
  });

  it("counts a side with nothing fresh as a gap, never as agreement", () => {
    const { profit, volume } = production(T0);
    const prod = productionDecisions(profit, volume);
    const at = T0 + COMPARE_MAX_AGE_MS + 10_000;
    const rows = compareAt(at, prod, shadowOf(T0, "IDLE", "IDLE"));
    expect(rows.find((row) => row.wallet === VOLUME_W)!.verdict).toBe("no-production");
    const fresh = productionDecisions(production(at).profit, production(at).volume);
    const stale = compareAt(at, fresh, shadowOf(T0, "IDLE", "IDLE"));
    expect(stale.map((row) => [row.wallet, row.verdict])).toEqual([
      [PROFIT_W, "no-shadow"],
      [VOLUME_W, "no-shadow"],
    ]);
    expect(agreementOf(stale)).toMatchObject({ compared: 0, percent: null, noShadow: 2 });
  });
});

describe("explaining mismatches", () => {
  const row = (minute: number, prodSettle: string, shadowSettle: string, dry = false, invest: { production?: string; shadow?: string } = {}): CompareRow => {
    const production = { settle: prodSettle, invest: invest.production ?? "IDLE", ageMs: 1_000, servedBy: "volume", detail: "production's detail" };
    const shadow = { settle: shadowSettle, invest: invest.shadow ?? "IDLE", ageMs: 1_000, vault: VAULT, process: "worker-a", dry, detail: dry ? "DRY RUN — would settle" : "the shadow's detail", investDetail: null };
    return {
      at: T0 + minute * 60_000,
      wallet: VOLUME_W,
      verdict: production.settle === shadow.settle && production.invest === shadow.invest ? "agree" : "mismatch",
      production,
      shadow,
    };
  };

  it("calls a shift of a minute either way timing, a dry would-send dry-run, and anything else unexplained", () => {
    // THE SHADOW READ THE TRADE A MINUTE BEFORE PRODUCTION'S SWEEP DID, then both rested.
    const timing = [row(0, "IDLE", "IDLE"), row(1, "IDLE", "PENDING_FINALITY"), row(2, "PENDING_FINALITY", "IDLE"), row(3, "IDLE", "IDLE")];
    expect(explainMismatches(timing).map((e) => [e.row.at - T0, e.explanation])).toEqual([
      [60_000, "timing"],
      [120_000, "timing"],
    ]);
    const dry = [row(0, "IDLE", "SETTLED", true)];
    expect(explainMismatches(dry)[0]!.explanation).toBe("dry-run");
    const lone = [row(0, "IDLE", "IDLE"), row(1, "IDLE", "FAILED"), row(2, "IDLE", "IDLE"), row(3, "IDLE", "IDLE")];
    expect(explainMismatches(lone).map((e) => e.explanation)).toEqual(["unexplained"]);
    // FIVE MINUTES APART IS NOT TIMING.
    const far = [row(0, "IDLE", "PENDING_FINALITY"), row(1, "IDLE", "IDLE"), row(2, "IDLE", "IDLE"), row(3, "IDLE", "IDLE"), row(4, "IDLE", "IDLE"), row(5, "PENDING_FINALITY", "IDLE")];
    expect(explainMismatches(far).map((e) => e.explanation)).toEqual(["unexplained", "unexplained"]);
    expect(agreementOf(timing)).toMatchObject({ compared: 4, agree: 2, mismatch: 2, percent: 50 });
  });

  it("explains a settle and the buy it funds landing a minute apart on each side, half by half (2026-10-13 00:47–00:50, the owner's VOLUME vault)", () => {
    // 00:48 the shadow would settle (dry) what production settles at 00:49; 00:49 the shadow reads production's
    // settle landed (IDLE) and would buy the 18 794 782 lamports, which production's profit keeper bought that sweep.
    const rows = [
      row(0, "IDLE", "IDLE"),
      row(1, "IDLE", "SETTLED", true),
      row(2, "SETTLED", "IDLE", false, { production: "INVESTED", shadow: "INVESTED" }),
      row(3, "IDLE", "IDLE"),
    ];
    expect(explainMismatches(rows).map((e) => [e.row.at - T0, e.explanation])).toEqual([
      [60_000, "dry-run"],
      [120_000, "timing"],
    ]);
    // THE SAME MINUTES WITH THE BUY NEVER SEEN BY PRODUCTION: the invest half has no partner, so it is unexplained.
    const unbought = [row(0, "IDLE", "IDLE"), row(1, "IDLE", "SETTLED", true), row(2, "SETTLED", "IDLE", false, { shadow: "INVESTED" }), row(3, "IDLE", "IDLE")];
    expect(explainMismatches(unbought).map((e) => e.explanation)).toEqual(["dry-run", "unexplained"]);
  });

  it("calls a failed turn whose next minute agrees transient, and one that stays failed unexplained", () => {
    const once = [row(0, "IDLE", "IDLE"), row(1, "IDLE", "THREW"), row(2, "IDLE", "IDLE")];
    expect(explainMismatches(once).map((e) => [e.explanation, e.note])).toEqual([["transient", "the shadow's settle THREW: the shadow's detail; the next fresh comparison agrees"]]);
    const stuck = [row(0, "IDLE", "IDLE"), row(1, "IDLE", "THREW"), row(2, "IDLE", "THREW"), row(3, "IDLE", "THREW"), row(4, "IDLE", "THREW")];
    expect(explainMismatches(stuck).every((e) => e.explanation === "unexplained")).toBe(true);
  });

  it("calls a failed invest transient too — one that threw, or a shadow job that ran out of time before it — and only when every differing half failed", () => {
    const withInvest = (minute: number, shadowInvest: string | null): CompareRow => {
      const base = row(minute, "IDLE", "IDLE");
      return { ...base, verdict: shadowInvest === "IDLE" ? "agree" : "mismatch", shadow: { ...base.shadow!, invest: shadowInvest } };
    };
    // 2026-10-13 07:55: a sibling's settle timed out and the job ran out of time before its invest.
    const outOfTime = [withInvest(0, "IDLE"), withInvest(1, null), withInvest(2, "IDLE")];
    expect(explainMismatches(outOfTime).map((e) => [e.explanation, e.note])).toEqual([["transient", "the shadow's job ran out of time before its invest; the next fresh comparison agrees"]]);
    expect(explainMismatches([withInvest(0, "IDLE"), withInvest(1, "THREW"), withInvest(2, "IDLE")])[0]!.explanation).toBe("transient");
    // A DECIDED SETTLE THAT DIFFERS BESIDE A FAILED INVEST is not excused by the invest's failure.
    const decided: CompareRow = { ...row(1, "IDLE", "SETTLED"), shadow: { ...row(1, "IDLE", "SETTLED").shadow!, invest: null } };
    expect(explainMismatches([row(0, "IDLE", "IDLE"), decided, row(2, "IDLE", "IDLE")])[0]!.explanation).toBe("unexplained");
  });

  it("looks past rows that repeat the failed observation for the recovery (2026-10-20 03:20–03:21: one invest that threw, read twice)", () => {
    // THE SAME SHADOW JOB, 70 s and then 130 s old, then a new job that agrees.
    const stale = (minute: number, ageMs: number, invest: string): CompareRow => {
      const base = row(minute, "IDLE", "IDLE", false, { production: "NO_POLICY", shadow: invest });
      return { ...base, shadow: { ...base.shadow!, ageMs } };
    };
    const rows = [stale(0, 10_000, "NO_POLICY"), stale(1, 70_000, "THREW"), stale(2, 130_000, "THREW"), stale(3, 5_000, "NO_POLICY")];
    expect(explainMismatches(rows).map((e) => e.explanation)).toEqual(["transient", "transient"]);
    // A NEW JOB THAT STILL DISAGREES is not a recovery.
    const still = [stale(0, 10_000, "NO_POLICY"), stale(1, 70_000, "THREW"), stale(2, 130_000, "THREW"), stale(3, 5_000, "IDLE"), stale(4, 5_000, "NO_POLICY")];
    expect(explainMismatches(still).map((e) => e.explanation).slice(0, 2)).toEqual(["unexplained", "unexplained"]);
  });
});

describe("the invest is a vault's", () => {
  it("rests by the keeper's own rule, and an outcome it does not know acts", () => {
    for (const outcome of ["IDLE", "NO_POLICY", "PAUSED", "INVESTED", "REFUSED", "FAILED", "DEFERRED", "THREW"] as const) {
      expect(investRestsByName(outcome), outcome).toBe(investRests(outcome));
    }
    expect(investRestsByName("SOMETHING_NEW")).toBe(false);
  });

  it("reads production's invest per vault: the turn that bought speaks for every wallet of the vault", () => {
    const OTHER_W = "9QX53J3Kbs8ogQirZq5iN11rucZAvgF4EKWw98QAkUSe";
    const profit = {
      wallets: {
        // THE NEWER TURN RESTED (it came after the buy): the acting one still speaks for the vault.
        [VOLUME_W]: { settle: "UNSUPPORTED_MODE", invest: "IDLE", detail: "", at: iso(T0 + 58_000) },
        [OTHER_W]: { settle: "UNSUPPORTED_MODE", invest: "INVESTED", detail: "", at: iso(T0 + 56_000) },
        [PROFIT_W]: { settle: "IDLE", invest: "NO_POLICY", detail: "", at: iso(T0 + 51_000) },
      },
    };
    const volume = {
      wallets: {
        [VOLUME_W]: { settle: "SETTLED", invest: "none (volume keeper)", detail: "settled", at: iso(T0 + 38_000) },
        [OTHER_W]: { settle: "IDLE", invest: "none (volume keeper)", detail: "", at: iso(T0 + 40_000) },
      },
    };
    const vaults: Record<string, string> = { [VOLUME_W]: VAULT, [OTHER_W]: VAULT, [PROFIT_W]: "4J3En7ugVHR8ZjupjZKqcYi56dp51jG52Am6CFMBVA9W" };
    const byVault = productionDecisions(profit, volume, (wallet) => vaults[wallet]);
    expect(byVault.get(VOLUME_W)).toMatchObject({ settle: "SETTLED", invest: "INVESTED", investOwn: "IDLE" });
    expect(byVault.get(OTHER_W)).toMatchObject({ invest: "INVESTED", investOwn: "INVESTED" });
    expect(byVault.get(PROFIT_W)).toMatchObject({ invest: "NO_POLICY" });
    // WITHOUT THE VAULTS, each wallet keeps its own turn's.
    expect(productionDecisions(profit, volume).get(VOLUME_W)).toMatchObject({ invest: "IDLE" });
  });
});

describe("replaying a run's comparison", () => {
  it("sets each production sample beside the job lines up to its instant, with the vaults the jobs named", () => {
    const sample = (minute: number, investOther: string) => ({
      at: iso(T0 + minute * 60_000 + 30_000),
      profit: {
        status: 200,
        body: {
          wallets: {
            [VOLUME_W]: { settle: "UNSUPPORTED_MODE", invest: "IDLE", detail: "", at: iso(T0 + minute * 60_000 + 20_000) },
            OTHER: { settle: "UNSUPPORTED_MODE", invest: investOther, detail: "", at: iso(T0 + minute * 60_000 + 21_000) },
          },
        },
      },
      volume: { status: 200, body: { wallets: { [VOLUME_W]: { settle: "IDLE", invest: "none (volume keeper)", detail: "only our own settle since slot 456249335", at: iso(T0 + minute * 60_000 + 5_000) } } } },
    });
    const job = (second: number, invest: string) => ({
      process: "worker-a",
      ...jobLine(
        T0 + second * 1_000,
        [
          { wallet: VOLUME_W, settle: "IDLE", detail: "only our own settle since slot 456249335" },
          { wallet: "OTHER", settle: "IDLE", detail: "only our own settle since slot 450450506" },
        ],
        invest,
      ),
    });
    const rows = replayComparison([sample(1, "INVESTED"), sample(0, "IDLE")], [job(75, "INVESTED"), job(10, "IDLE"), job(95, "IDLE")]);
    const ours = rows.filter((r) => r.wallet === VOLUME_W);
    expect(ours.map((r) => [r.at - T0, r.verdict, r.shadow?.invest, r.production?.invest])).toEqual([
      [30_000, "agree", "IDLE", "IDLE"],
      // THE JOB AT 95 s IS AFTER THIS SAMPLE (90 s) AND IS NOT READ; the vault's buy is the other wallet's turn.
      [90_000, "agree", "INVESTED", "INVESTED"],
    ]);
  });
});

describe("discovery listings a minute", () => {
  const call = (ts: number, run: string, method = "getProgramAccounts") => ({ ts, run, method, status: 200 });

  it("counts the schedulers' listings by whole UTC minute, with the gaps between them", () => {
    const lines = [
      { ts: T0 - 1_000, kind: "proxy-start" },
      call(T0 + 5_000, "sched-a"),
      call(T0 + 6_000, "worker-a", "getMultipleAccounts"),
      call(T0 + 65_000, "sched-a"),
      call(T0 + 125_000, "sched-a"),
      // THE TAKEOVER: the standby's first tick lands 40 s after the dead holder's last listing, in the same minute's neighbour.
      call(T0 + 165_000, "sched-b"),
      call(T0 + 225_000, "sched-b"),
      call(T0 + 230_000, "handover"),
      // AFTER THE WINDOW: neither a minute nor a gap of it.
      call(T0 + 285_000, "sched-b"),
    ];
    const result = listingsPerMinute(lines, (run) => run.startsWith("sched-"), T0, T0 + 240_000);
    expect(result.minutes.map((m) => m.listings)).toEqual([1, 1, 2, 1]);
    expect(result.minutes[2]!.runs).toEqual(["sched-a", "sched-b"]);
    expect(result.gapsMs).toEqual([60_000, 60_000, 40_000, 60_000]);
    expect(result).toMatchObject({ exactlyOne: 3, judged: 4 });
    // A PARTIAL MINUTE AT EITHER END IS NOT JUDGED.
    expect(listingsPerMinute(lines, (run) => run.startsWith("sched-"), T0 + 30_000, T0 + 200_000).judged).toBe(2);
  });
});

describe("discovery listings per acted tick", () => {
  const call = (ts: number, run: string) => ({ ts, run, method: "getProgramAccounts", status: 200 });
  const tick = (ts: number, process: string, event = "scheduler tick") => ({ process, ts: iso(ts), event });

  it("gives each listing to its scheduler's next acted tick, so a late tick's empty minute is still one listing a tick (the 7-day shadow's 19 minutes)", () => {
    const lines = [
      call(T0 + 1_000, "sched-a"),
      call(T0 + 61_000, "sched-a"),
      // A LATE TICK: 123 s after the previous one, so minute 2 has no listing at all.
      call(T0 + 184_000, "sched-a"),
      call(T0 + 244_000, "sched-a"),
    ];
    const ticks = [tick(T0 + 1_300, "sched-a"), tick(T0 + 61_300, "sched-a"), tick(T0 + 184_300, "sched-a"), tick(T0 + 244_300, "sched-a"), tick(T0 + 250_000, "sched-b", "took the scheduler lock: this tick is a full pass")];
    expect(listingsPerMinute(lines, (run) => run.startsWith("sched-"), T0, T0 + 300_000).minutes.map((m) => m.listings)).toEqual([1, 1, 0, 1, 1]);
    const result = listingsPerTick(lines, ticks, (run) => run.startsWith("sched-"), T0, T0 + 300_000);
    expect(result).toMatchObject({ judged: 4, exactlyOne: 4, notOne: [], orphans: [] });
    expect(result.late).toEqual([{ at: T0 + 184_300, process: "sched-a", gapMs: 123_000 }]);
  });

  it("fails a tick that listed twice or not at all, and counts a listing no acted tick took as an orphan", () => {
    const lines = [call(T0 + 1_000, "sched-a"), call(T0 + 2_000, "sched-a"), call(T0 + 30_000, "sched-b"), call(T0 + 400_000, "sched-b")];
    const ticks = [tick(T0 + 3_000, "sched-a"), tick(T0 + 63_000, "sched-a")];
    const result = listingsPerTick(lines, ticks, (run) => run.startsWith("sched-"), T0, T0 + 500_000);
    expect(result.notOne).toEqual([
      { at: T0 + 3_000, process: "sched-a", listings: 2 },
      { at: T0 + 63_000, process: "sched-a", listings: 0 },
    ]);
    // THE STANDBY THAT LISTED, and a listing whose tick never ended: neither belongs to an acted tick.
    expect(result.orphans.map((orphan) => orphan.process)).toEqual(["sched-b", "sched-b"]);
  });
});

describe("credits from the proxy's lines", () => {
  it("prices each call by the keeper's own table at archival 1 and 10, and bills nothing refused", () => {
    const lines = [
      { ts: T0, run: "sched-a", method: "getProgramAccounts", status: 200 },
      { ts: T0, run: "worker-a", method: "getMultipleAccounts", status: 200 },
      { ts: T0, run: "worker-a", method: "getSignaturesForAddress", status: 200 },
      { ts: T0, run: "worker-a", method: "getTransaction", status: 200 },
      { ts: T0, run: "worker-a", method: "getSignatureStatuses", status: 200 },
      { ts: T0, run: "worker-b", method: "sendTransaction", status: "refused", refused: true },
      { ts: T0, kind: "websocket-upgrade-refused", refused: true },
    ];
    const one = creditsOf(lines, 1);
    expect(one).toMatchObject({ calls: 5, credits: 10 + 1 + 1 + 1 + 1, refused: 1 });
    expect(one.byClass).toEqual({ programAccounts: { calls: 1, credits: 10 }, standard: { calls: 2, credits: 2 }, archival: { calls: 2, credits: 2 } });
    expect(creditsOf(lines, 10).credits).toBe(10 + 1 + 10 + 10 + 1);
    expect(creditsOf(lines, 1, (run) => run.startsWith("sched-")).credits).toBe(10);
    expect(perDay(31, 60_000)).toBe(31 * 1_440);
  });
});

describe("the coverage clock of a run that stops and resumes", () => {
  const beat = (seconds: number, session = 1, fleetUp = true) => ({ at: T0 + seconds * 1_000, session, fleetUp });

  it("counts the steps between beats of one session with the fleet up, and lists every other step as a gap with its cause", () => {
    const beats = [
      beat(0),
      beat(60),
      beat(120),
      // ONE SKIPPED BEAT (a minute that ran long): still covered.
      beat(240),
      // THE MAC SLEPT TEN MINUTES inside session 1.
      beat(840),
      beat(900),
      // THE FLEET WAS NOT WHOLE AT ONE BEAT: both steps touching it are gaps.
      beat(960, 1, false),
      beat(1_020),
      // THE HARNESS WAS KILLED; session 2 resumed the run an hour later.
      beat(4_620, 2),
      beat(4_680, 2),
    ];
    const cov = coverageOf(beats, { sessionCause: (session) => (session === 2 ? "the harness was killed or crashed" : undefined) });
    expect(cov.coveredMs).toBe((60 + 60 + 120 + 60 + 60) * 1_000);
    expect(cov.intervals.map((i) => [(i.from - T0) / 1_000, (i.to - T0) / 1_000])).toEqual([
      [0, 240],
      [840, 900],
      [4_620, 4_680],
    ]);
    expect(cov.gaps.map((g) => [(g.from - T0) / 1_000, (g.to - T0) / 1_000, g.cause.split(":")[0]])).toEqual([
      [240, 840, "the harness's minute did not run"],
      // ADJACENT GAPS OF ONE CAUSE ARE ONE GAP.
      [900, 1_020, "the shadow could not work (no live scheduler or worker, or its database or proxy down)"],
      [1_020, 4_620, "the harness was killed or crashed"],
    ]);
    // NOTHING IS DROPPED: covered + gaps = the whole span.
    expect(cov.coveredMs + cov.gaps.reduce((sum, g) => sum + g.ms, 0)).toBe(4_680_000);
  });

  it("opens a gap up to now when the last beat is older than the bound, and none while the run beats", () => {
    const beats = [beat(0), beat(60)];
    expect(coverageOf(beats, { now: T0 + 60_000 + COVER_MAX_STEP_MS }).gaps).toEqual([]);
    const open = coverageOf(beats, { now: T0 + 3_660_000 }).gaps;
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ from: T0 + 60_000, to: T0 + 3_660_000, ms: 3_600_000 });
    // A STEP OF TWO SKIPPED BEATS IS NOT COVERED.
    expect(coverageOf([beat(0), beat(180)]).coveredMs).toBe(0);
    expect(coverageOf([]).coveredMs).toBe(0);
  });
});

describe("the long run's drill plan", () => {
  const names = ["worker-kill", "worker-sigterm-0", "worker-sigterm-30", "scheduler-kill", "scheduler-blocked", "pg-pause", "pg-outage"];

  it("runs every drill once per covered day, every drill at every slot once over the week, two never in one slot", () => {
    const plan = weeklyDrillPlan(names, 7);
    expect(plan).toHaveLength(49);
    expect(new Set(plan.map((d) => d.id)).size).toBe(49);
    expect(new Set(plan.map((d) => d.atCoveredMs)).size).toBe(49);
    const hours = (id: string) => plan.find((d) => d.id === id)!.atCoveredMs / 3_600_000;
    expect([hours("d1-worker-kill"), hours("d1-pg-outage"), hours("d2-worker-kill"), hours("d2-pg-outage")]).toEqual([1, 19, 28, 25]);
    for (const name of names) {
      const slots = plan.filter((d) => d.name === name).map((d) => (d.atCoveredMs / 3_600_000) % 24);
      expect(new Set(slots).size).toBe(7);
    }
    // THE LAST DRILL IS DUE BEFORE THE 168 h TARGET.
    expect(Math.max(...plan.map((d) => d.atCoveredMs))).toBeLessThan(168 * 3_600_000);
    expect(() => weeklyDrillPlan([...names, "a", "b"], 1)).toThrow(/do not fit/);
  });

  it("owes a drill until it has a result, never repeats a done one, and retries an interrupted one up to the limit", () => {
    const plan = weeklyDrillPlan(names, 1);
    const ledger = drillLedger(plan, [
      { id: "d1-worker-kill", drill: "worker-kill", ok: true, startedAt: iso(T0) },
      // A FAILURE IS A RESULT: not retried.
      { id: "d1-pg-pause", drill: "pg-pause", ok: false },
      { id: "d1-pg-outage", drill: "pg-outage", ok: false, interrupted: true },
      { id: "d1-scheduler-kill", drill: "scheduler-kill", ok: false, interrupted: true },
      { id: "d1-scheduler-kill", drill: "scheduler-kill", ok: false, interrupted: true },
    ]);
    expect(ledger.done.map((d) => [d.id, d.ok])).toEqual([
      ["d1-worker-kill", true],
      ["d1-pg-pause", false],
    ]);
    expect(ledger.interrupted).toEqual({ "d1-pg-outage": 1, "d1-scheduler-kill": 2 });
    expect(ledger.gaveUp).toEqual(["d1-scheduler-kill"]);
    expect(ledger.owed.map((d) => d.id).sort()).toEqual(["d1-pg-outage", "d1-scheduler-blocked", "d1-worker-sigterm-0", "d1-worker-sigterm-30"]);
    // A RESULT WRITTEN BEFORE IDS EXISTED IS KNOWN BY ITS DRILL NAME.
    expect(drillLedger([{ id: "worker-kill", name: "worker-kill", atCoveredMs: 0 }], [{ drill: "worker-kill", ok: true }]).owed).toEqual([]);
  });
});
