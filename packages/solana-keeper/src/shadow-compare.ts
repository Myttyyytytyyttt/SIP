// THE LOCAL SHADOW'S ARITHMETIC (plan §3.3.2's gate table): what the harness in
// test-local/shadow/harness.ts measures, as pure functions over what it records.
//
//   * AGREEMENT. Production's per-wallet decision is read from the two legacy
//     keepers' public /status: the SETTLE from the keeper whose mode serves the
//     wallet (the other one answers UNSUPPORTED_MODE before any RPC), the INVEST
//     from the profit keeper, the only one that invests (the volume keeper
//     answers "none (volume keeper)"). The shadow's is the newest COMPLETED job
//     of the wallet's vault, from the worker's own log line (jobLogFields,
//     src/worker-job.ts): each wallet's settle by address, the vault's one
//     invest. One row per wallet per minute: agree, mismatch, or not compared
//     because a side had nothing fresh (a gap is listed, never counted as
//     agreement). THE INVEST IS A VAULT'S: a legacy keeper invests on each
//     link's turn, and the turn that finds the money is the one that buys, so
//     on a vault of two links production shows INVESTED on one wallet and IDLE
//     on the other in the same sweep, where a worker invests once for the
//     vault. Production's invest is therefore read per vault — the acting
//     outcome of any of its wallets' turns, else the resting one — whenever the
//     wallet's vault is known. Afterwards each mismatch is EXPLAINED or left
//     unexplained: DRY RUN when the shadow's settle detail says what it would
//     have sent; TIMING when every half that differs (settle, invest) showed
//     each side's value on the other side within two minutes either way — the
//     two read the chain at different instants; TRANSIENT when one side's turn
//     failed (THREW, INCOMPLETE, RETRY) and the wallet's next compared minute
//     agrees;
//   * DISCOVERY. Exactly one listing a minute for the whole shadow fleet: the
//     census proxy's lines for getProgramAccounts(V2) on the schedulers' paths,
//     by UTC minute, with the gaps between listings beside them (a takeover
//     can put two listings of two holders in one minute and none in the next);
//   * CREDITS. The proxy's per-call lines priced by the keeper's own table
//     (src/rpc-usage.ts: creditClassOf, creditPrice) at archival 1 and 10. The
//     proxy keeps no params, so getSignatureStatuses is priced standard: a
//     shadow sends nothing, and only a send's landing poll searches history;
//   * COVERAGE. A run of 7 × 24 h may stop and resume (a reboot, a crash, a
//     stop): the clock is the sum of the steps between the harness's minute
//     beats that belong to one session, with the fleet up, no longer than one
//     skipped beat. Every other step is a gap, listed with its cause;
//   * THE LONG RUN'S DRILLS. Each drill once per covered day, at a slot that
//     moves daily, due on the coverage clock; a ledger over drills.jsonl says
//     which are done (never repeated across resumes) and which are still owed.
//
// NOTHING RUNS THIS BUT THE HARNESS AND ITS TEST. No entry point under bin/
// imports it (test/dispatch-dark.test.ts lists it).

import { investRests, type TurnInvest } from "./doorbell.js";
import { creditClassOf, creditPrice, type ArchivalCredits, type CreditClass } from "./rpc-usage.js";

/** Every invest outcome a turn can answer; the compiler holds the list whole. */
const INVEST_OUTCOMES = ["IDLE", "NO_POLICY", "PAUSED", "INVESTED", "REFUSED", "FAILED", "DEFERRED", "THREW"] as const satisfies readonly TurnInvest[];
type MissingInvestOutcome = Exclude<TurnInvest, (typeof INVEST_OUTCOMES)[number]>;
const INVEST_OUTCOMES_WHOLE: [MissingInvestOutcome] extends [never] ? true : never = true;
void INVEST_OUTCOMES_WHOLE;

/** Whether an invest outcome rests, by the keeper's own rule (doorbell.ts, investRests); an unknown one acts. */
export function investRestsByName(outcome: string): boolean {
  return (INVEST_OUTCOMES as readonly string[]).includes(outcome) ? investRests(outcome as TurnInvest) : false;
}

/** What production's /status says about one wallet, as the comparison needs it. */
export interface ProductionWallet {
  readonly wallet: string;
  readonly settle: string;
  /** The profit keeper's invest outcome for the wallet's vault; null when its row carries none (a wallet it did not list is left out). */
  readonly invest: string | null;
  readonly detail: string;
  /** When the serving keeper turned the wallet (its row's `at`), ms; null when unreadable. */
  readonly at: number | null;
  /** Which keeper's row the settle came from. */
  readonly servedBy: "profit" | "volume" | "none";
  /** The profit keeper's invest on THIS wallet's own turn, before the vault's was read. */
  readonly investOwn: string | null;
}

/** What the shadow's newest completed job says about one wallet. */
export interface ShadowWallet {
  readonly wallet: string;
  readonly vault: string;
  readonly settle: string;
  readonly invest: string | null;
  readonly detail: string;
  readonly investDetail: string | null;
  readonly at: number;
  /** The worker process that ran the job (the harness's name for it). */
  readonly process: string;
}

/** The settle a keeper answers for a vault whose mode it does not serve, before any RPC. */
export const UNSUPPORTED_MODE = "UNSUPPORTED_MODE";

interface StatusRow {
  readonly settle?: unknown;
  readonly invest?: unknown;
  readonly detail?: unknown;
  readonly at?: unknown;
}

function rowsOf(status: unknown): ReadonlyMap<string, StatusRow> {
  const out = new Map<string, StatusRow>();
  if (status === null || typeof status !== "object") return out;
  const wallets = (status as { wallets?: unknown }).wallets;
  if (wallets === null || typeof wallets !== "object" || Array.isArray(wallets)) return out;
  for (const [wallet, row] of Object.entries(wallets as Record<string, unknown>)) {
    if (row !== null && typeof row === "object" && !Array.isArray(row)) out.set(wallet, row as StatusRow);
  }
  return out;
}

const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
const millis = (value: unknown): number | null => {
  if (typeof value !== "string") return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
};

/**
 * Production's decision per wallet, from the profit keeper's and the volume
 * keeper's /status bodies (either may be null: a fetch that failed). The settle
 * is the serving keeper's; when neither serves the wallet's mode, it is
 * UNSUPPORTED_MODE, as both answered. The invest is the profit keeper's, PER
 * VAULT where `vaultOf` knows the wallet's vault: the newest acting outcome
 * among the vault's wallets' turns, else the newest resting one (the header).
 *
 * A KEEPER THAT DID NOT ANSWER FOR THE WALLET IS NO DECISION, and the wallet is
 * left out (a no-production gap, never a verdict): without the profit keeper's
 * row there is no invest, and when the profit keeper says the wallet is not its
 * own, without the volume keeper's row there is no settle. Before this rule a
 * /status fetch that got no answer read as "production answered
 * UNSUPPORTED_MODE" or "production decided no invest" — 10 of the 7-day
 * shadow's 15 unexplained mismatches, at three minutes with one fetch failed.
 */
export function productionDecisions(profit: unknown, volume: unknown, vaultOf: (wallet: string) => string | undefined = () => undefined): ReadonlyMap<string, ProductionWallet> {
  const p = rowsOf(profit);
  const v = rowsOf(volume);
  const out = new Map<string, ProductionWallet>();
  for (const wallet of new Set([...p.keys(), ...v.keys()])) {
    const pr = p.get(wallet);
    const vr = v.get(wallet);
    if (pr === undefined) continue;
    const serves = (row: StatusRow | undefined): boolean => row !== undefined && text(row.settle) !== null && row.settle !== UNSUPPORTED_MODE;
    // A PROFIT ROW THAT THREW NAMES NO MODE: the profit keeper turns every vault
    // and its catch writes THREW for a throw in either half (keeper.mts), the
    // invest of a VOLUME vault included. Where the volume keeper answered a
    // settle of its own, that is the wallet's settle.
    const profitServes = serves(pr) && !(pr.settle === "THREW" && serves(vr));
    const served: { row: StatusRow; by: "profit" | "volume" } | null = profitServes ? { row: pr, by: "profit" } : serves(vr) ? { row: vr!, by: "volume" } : null;
    if (served === null && vr === undefined) continue;
    const row = served?.row ?? pr;
    const investOwn = text(pr.invest);
    out.set(wallet, {
      wallet,
      settle: text(row.settle) ?? UNSUPPORTED_MODE,
      invest: investOwn,
      detail: text(row.detail) ?? "",
      at: millis(row.at),
      servedBy: served?.by ?? "none",
      investOwn,
    });
  }
  // THE VAULT'S INVEST: one answer for every wallet of a vault, as a worker gives it.
  const byVault = new Map<string, { readonly invest: string; readonly at: number }[]>();
  for (const [wallet, row] of p) {
    const vault = vaultOf(wallet);
    const invest = text(row.invest);
    if (vault === undefined || invest === null) continue;
    const list = byVault.get(vault) ?? [];
    list.push({ invest, at: millis(row.at) ?? 0 });
    byVault.set(vault, list);
  }
  for (const [wallet, decided] of out) {
    const vault = vaultOf(wallet);
    const turns = vault === undefined ? undefined : byVault.get(vault);
    if (turns === undefined || decided.investOwn === null) continue;
    const newestFirst = [...turns].sort((a, b) => b.at - a.at);
    const acting = newestFirst.find((turn) => !investRestsByName(turn.invest));
    out.set(wallet, { ...decided, invest: (acting ?? newestFirst[0]!).invest });
  }
  return out;
}

/** One parsed line of a worker's log (the keeper logger's JSON: `ts`, `event`, the fields). */
export interface WorkerLogLine {
  readonly ts?: unknown;
  readonly event?: unknown;
  readonly vault?: unknown;
  readonly wallets?: unknown;
  readonly invest?: unknown;
  readonly investDetail?: unknown;
}

/**
 * Fold worker log lines into each wallet's newest decision. Only "job done"
 * lines count — a stopped job (its lease lost, a SIGTERM) did not finish its
 * turn — and only those that turned the wallet's settle (a job that waited out
 * an earlier holder's intent, or found no vault, names no wallet).
 */
export function foldShadowJobs(into: Map<string, ShadowWallet>, line: WorkerLogLine, process: string): void {
  if (line.event !== "job done") return;
  const at = millis(line.ts);
  const vault = text(line.vault);
  if (at === null || vault === null || !Array.isArray(line.wallets)) return;
  for (const entry of line.wallets as unknown[]) {
    if (entry === null || typeof entry !== "object") continue;
    const { wallet, settle, detail } = entry as { wallet?: unknown; settle?: unknown; detail?: unknown };
    if (typeof wallet !== "string" || typeof settle !== "string") continue;
    const previous = into.get(wallet);
    if (previous !== undefined && previous.at > at) continue;
    into.set(wallet, {
      wallet,
      vault,
      settle,
      invest: text(line.invest),
      detail: text(detail) ?? "",
      investDetail: text(line.investDetail),
      at,
      process,
    });
  }
}

export type Verdict = "agree" | "mismatch" | "no-shadow" | "no-production";

/** One wallet at one minute. */
export interface CompareRow {
  readonly at: number;
  readonly wallet: string;
  readonly verdict: Verdict;
  readonly production: { readonly settle: string; readonly invest: string | null; readonly ageMs: number | null; readonly servedBy: string; readonly detail: string } | null;
  readonly shadow: {
    readonly settle: string;
    readonly invest: string | null;
    readonly ageMs: number;
    readonly vault: string;
    readonly process: string;
    readonly dry: boolean;
    readonly detail: string;
    readonly investDetail: string | null;
  } | null;
  /** The two details' "slot N" numbers, where both carry one: the frontier each side read. */
  readonly frontier?: { readonly production: string; readonly shadow: string; readonly equal: boolean };
}

/** The newest a side's observation may be, at a minute's comparison, to be compared at all: two production sweeps. */
export const COMPARE_MAX_AGE_MS = 150_000;

const SLOT = /\bslot (\d+)\b/;

/** How much of each side's detail a comparison row keeps. */
export const DETAIL_CHARS = 200;

/**
 * The comparison at one instant. A wallet either side lists is a row; a side
 * with nothing within COMPARE_MAX_AGE_MS is a gap (no-shadow / no-production),
 * not a verdict. Settle AND invest must be equal for "agree".
 */
export function compareAt(at: number, production: ReadonlyMap<string, ProductionWallet>, shadow: ReadonlyMap<string, ShadowWallet>, maxAgeMs = COMPARE_MAX_AGE_MS): CompareRow[] {
  const rows: CompareRow[] = [];
  for (const wallet of [...new Set([...production.keys(), ...shadow.keys()])].sort()) {
    const p = production.get(wallet);
    const s = shadow.get(wallet);
    const pAge = p?.at === null || p === undefined ? null : at - p.at;
    const pFresh = p !== undefined && (pAge === null || pAge <= maxAgeMs);
    const sFresh = s !== undefined && at - s.at <= maxAgeMs;
    const production_ = p === undefined ? null : { settle: p.settle, invest: p.invest, ageMs: pAge, servedBy: p.servedBy, detail: p.detail.slice(0, DETAIL_CHARS) };
    const shadow_ =
      s === undefined
        ? null
        : {
            settle: s.settle,
            invest: s.invest,
            ageMs: at - s.at,
            vault: s.vault,
            process: s.process,
            dry: s.detail.startsWith("DRY RUN"),
            detail: s.detail.slice(0, DETAIL_CHARS),
            investDetail: s.investDetail === null ? null : s.investDetail.slice(0, DETAIL_CHARS),
          };
    const verdict: Verdict = !pFresh ? "no-production" : !sFresh ? "no-shadow" : p!.settle === s!.settle && p!.invest === s!.invest ? "agree" : "mismatch";
    const ps = p === undefined ? null : SLOT.exec(p.detail)?.[1] ?? null;
    const ss = s === undefined ? null : SLOT.exec(s.detail)?.[1] ?? null;
    rows.push({
      at,
      wallet,
      verdict,
      production: production_,
      shadow: shadow_,
      ...(ps !== null && ss !== null ? { frontier: { production: ps, shadow: ss, equal: ps === ss } } : {}),
    });
  }
  return rows;
}

/** A mismatch, explained or not. */
export interface Explained {
  readonly row: CompareRow;
  readonly explanation: "timing" | "dry-run" | "transient" | "unexplained";
  readonly note: string;
}

/** A settle that failed rather than decided: what TRANSIENT may excuse when a fresh comparison agrees. */
const FAILED_TURNS = new Set(["THREW", "INCOMPLETE", "RETRY"]);

/** An invest that failed rather than decided. */
const FAILED_INVESTS = new Set(["THREW", "FAILED"]);

/** How far apart, in comparison rows of the same wallet, a timing explanation may look: two minutes either way. */
export const TIMING_WINDOW_ROWS = 2;

/**
 * The same window IN TIME, which is what bounds it: rows a minute apart, plus
 * half a minute of slack for a beat that ran late. Counted in rows alone it
 * stretched across any gap — a Mac asleep, a fleet down — and paired a
 * mismatch with a "witness" an hour away.
 */
export const TIMING_WINDOW_MS = TIMING_WINDOW_ROWS * 60_000 + 30_000;

type Sides = { readonly production: NonNullable<CompareRow["production"]>; readonly shadow: NonNullable<CompareRow["shadow"]> };

/**
 * Why one half of a mismatch is a failure rather than a decision, and whose;
 * null when both sides decided. A shadow job with no invest is one that ran
 * out of time before it (worker-job.ts: the soft deadline ends the settles and
 * skips the invest) — a failed half, not a decision.
 */
function failedHalf(half: "settle" | "invest", { production: p, shadow: s }: Sides): { readonly side: "production" | "shadow"; readonly note: string } | null {
  if (half === "settle") {
    if (FAILED_TURNS.has(s.settle)) return { side: "shadow", note: `the shadow's settle ${s.settle}: ${s.detail}` };
    if (FAILED_TURNS.has(p.settle)) return { side: "production", note: `production's settle ${p.settle}: ${p.detail}` };
    return null;
  }
  if (s.invest === null) return { side: "shadow", note: "the shadow's job ran out of time before its invest" };
  if (FAILED_INVESTS.has(s.invest)) return { side: "shadow", note: `the shadow's invest ${s.invest}${s.investDetail === null ? "" : `: ${s.investDetail}`}` };
  if (p.invest !== null && FAILED_INVESTS.has(p.invest)) return { side: "production", note: `production's invest ${p.invest}` };
  return null;
}

/** When a side's observation in a row was made: rows that repeat one observation show nothing new. */
const observedAt = (row: CompareRow, side: "production" | "shadow"): number => {
  const ageMs = row[side]?.ageMs ?? null;
  return ageMs === null ? row.at : row.at - ageMs;
};

/**
 * Each mismatch with its explanation. DRY RUN: the shadow's settle detail says
 * what it would have sent, and production's outcome is one a real send leads
 * to. TIMING: for every half that differs (settle, invest), within
 * TIMING_WINDOW_MS of the same wallet's rows either way, production showed the
 * shadow's value AND the shadow showed production's — the two read the chain at
 * different instants (a settle and the buy it funds may each land a minute
 * apart). TRANSIENT: every half that differs FAILED on one side — a settle that
 * THREW, was INCOMPLETE or RETRY; an invest that THREW or FAILED, or a shadow
 * job that ran out of time before its invest — and the wallet's next compared
 * row with a NEWER observation from each failed side agrees ON THE DECISION THE
 * OTHER SIDE MADE (a row that repeats the failed observation, because no job ran
 * in between, cannot show a recovery; nor can an agreement on something else,
 * such as the IDLE after a buy only production made). TIMING looks at most
 * TIMING_WINDOW_MS either way. Anything else is unexplained, and the gate fails
 * on it.
 */
export function explainMismatches(rows: readonly CompareRow[]): Explained[] {
  const byWallet = new Map<string, CompareRow[]>();
  for (const row of rows) {
    const list = byWallet.get(row.wallet) ?? [];
    list.push(row);
    byWallet.set(row.wallet, list);
  }
  const out: Explained[] = [];
  for (const list of byWallet.values()) {
    list.sort((a, b) => a.at - b.at);
    list.forEach((row, index) => {
      if (row.verdict !== "mismatch") return;
      const p = row.production!;
      const s = row.shadow!;
      if (s.dry && ["SETTLED", "PENDING_FINALITY", "IDLE"].includes(p.settle)) {
        out.push({ row, explanation: "dry-run", note: `the shadow would have sent (${s.settle}, dry); production answered ${p.settle}` });
        return;
      }
      const near = list.filter((other) => Math.abs(other.at - row.at) <= TIMING_WINDOW_MS);
      const halves = (["settle", "invest"] as const).filter((half) => p[half] !== s[half]);
      const shifted = halves.every(
        (half) =>
          near.some((other) => other.production !== null && other.production[half] === s[half]) &&
          near.some((other) => other.shadow !== null && other.shadow[half] === p[half]),
      );
      if (shifted) {
        out.push({ row, explanation: "timing", note: `each side showed the other's ${halves.join(" and ")} within two minutes: they read the chain at different instants` });
        return;
      }
      const failures = halves.map((half) => failedHalf(half, { production: p, shadow: s }));
      if (failures.length > 0 && failures.every((failure) => failure !== null)) {
        const sides = [...new Set(failures.map((failure) => failure!.side))];
        const next = list
          .slice(index + 1)
          .find((other) => (other.verdict === "agree" || other.verdict === "mismatch") && sides.every((side) => observedAt(other, side) > observedAt(row, side)));
        // THE RECOVERY MUST BE THE SAME DECISION: the side that did not fail says
        // again what it said, and the failed side now says it too. Without this a
        // shadow whose buy failed every time production bought was excused by the
        // IDLE/IDLE minute after — production had spent the money.
        const same =
          next !== undefined &&
          halves.every((half, k) => (failures[k]!.side === "shadow" ? next.production?.[half] === p[half] : next.shadow?.[half] === s[half]));
        if (next?.verdict === "agree" && same) {
          out.push({ row, explanation: "transient", note: `${failures.map((failure) => failure!.note).join("; ")}; the next fresh comparison agrees` });
          return;
        }
      }
      out.push({ row, explanation: "unexplained", note: `production ${p.settle}/${p.invest ?? "-"} vs shadow ${s.settle}/${s.invest ?? "-"}` });
    });
  }
  return out.sort((a, b) => a.row.at - b.row.at || a.row.wallet.localeCompare(b.row.wallet));
}

/** The agreement figure: agree / (agree + mismatch); gaps are counted beside it, never in it. */
export function agreementOf(rows: readonly CompareRow[]): {
  readonly compared: number;
  readonly agree: number;
  readonly mismatch: number;
  readonly noShadow: number;
  readonly noProduction: number;
  readonly percent: number | null;
  readonly frontier: { readonly compared: number; readonly equal: number };
} {
  const count = (verdict: Verdict) => rows.filter((row) => row.verdict === verdict).length;
  const agree = count("agree");
  const mismatch = count("mismatch");
  const withFrontier = rows.filter((row) => row.verdict !== "no-production" && row.verdict !== "no-shadow" && row.frontier !== undefined);
  return {
    compared: agree + mismatch,
    agree,
    mismatch,
    noShadow: count("no-shadow"),
    noProduction: count("no-production"),
    percent: agree + mismatch === 0 ? null : (100 * agree) / (agree + mismatch),
    frontier: { compared: withFrontier.length, equal: withFrontier.filter((row) => row.frontier!.equal).length },
  };
}

/** One minute's production sample as the harness records it (production.jsonl). */
export interface ProductionSample {
  readonly at: string;
  readonly profit: { readonly status: number | null; readonly body: unknown };
  readonly volume: { readonly status: number | null; readonly body: unknown };
}

/**
 * The comparison replayed from what a run recorded: each production sample set
 * beside the workers' job lines up to its instant. The same rows the live
 * comparison wrote, recomputed — so a change to the rules re-reads a finished
 * run, and the report never depends on the live loop's timing.
 */
export function replayComparison(samples: readonly ProductionSample[], jobs: readonly (WorkerLogLine & { readonly process?: unknown })[]): CompareRow[] {
  const ordered = jobs
    .map((line) => ({ line, at: millis(line.ts) }))
    .filter((entry): entry is { line: WorkerLogLine & { readonly process?: unknown }; at: number } => entry.at !== null)
    .sort((a, b) => a.at - b.at);
  const shadow = new Map<string, ShadowWallet>();
  const rows: CompareRow[] = [];
  let next = 0;
  for (const sample of [...samples].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
    const at = Date.parse(sample.at);
    if (!Number.isFinite(at)) continue;
    while (next < ordered.length && ordered[next]!.at <= at) {
      const { line } = ordered[next]!;
      foldShadowJobs(shadow, line, typeof line.process === "string" ? line.process : "");
      next += 1;
    }
    const production = productionDecisions(sample.profit.body, sample.volume.body, (wallet) => shadow.get(wallet)?.vault);
    rows.push(...compareAt(at, production, shadow));
  }
  return rows;
}

/** One line of the census proxy's log (disp-measure's proxy.mjs, copied as test-local/shadow/census-proxy.mjs). */
export interface ProxyLine {
  readonly ts?: unknown;
  readonly run?: unknown;
  readonly method?: unknown;
  readonly status?: unknown;
  readonly refused?: unknown;
  readonly kind?: unknown;
}

/** A call line: a JSON-RPC method the proxy forwarded or refused (not its start, stop or refused-upgrade lines). */
function callOf(line: ProxyLine): { readonly ts: number; readonly run: string; readonly method: string; readonly refused: boolean } | null {
  if (typeof line.method !== "string" || typeof line.ts !== "number") return null;
  return { ts: line.ts, run: typeof line.run === "string" ? line.run : "", method: line.method, refused: line.refused === true };
}

const LISTING_METHODS = new Set(["getProgramAccounts", "getProgramAccountsV2"]);

/** The UTC minute of an instant, as "YYYY-MM-DDTHH:MM". */
export const minuteOf = (ms: number): string => new Date(ms).toISOString().slice(0, 16);

/**
 * Discovery listings, by UTC minute, over the calls whose run tag `isScheduler`
 * accepts, between `from` and `to` (whole minutes only: a partial first or last
 * minute is not judged). A V2 listing that pages counts once per page here; a
 * plain listing is one call.
 */
export function listingsPerMinute(
  lines: readonly ProxyLine[],
  isScheduler: (run: string) => boolean,
  from: number,
  to: number,
): {
  readonly minutes: readonly { readonly minute: string; readonly listings: number; readonly runs: readonly string[] }[];
  readonly gapsMs: readonly number[];
  readonly exactlyOne: number;
  readonly judged: number;
} {
  const listings = lines
    .map(callOf)
    .filter((call): call is NonNullable<typeof call> => call !== null && LISTING_METHODS.has(call.method) && isScheduler(call.run) && call.ts >= from && call.ts < to)
    .sort((a, b) => a.ts - b.ts);
  const first = Math.ceil(from / 60_000) * 60_000;
  const last = Math.floor(to / 60_000) * 60_000;
  const minutes: { minute: string; listings: number; runs: string[] }[] = [];
  for (let m = first; m < last; m += 60_000) {
    const inMinute = listings.filter((call) => call.ts >= m && call.ts < m + 60_000);
    minutes.push({ minute: minuteOf(m), listings: inMinute.length, runs: [...new Set(inMinute.map((call) => call.run))] });
  }
  const gapsMs = listings.slice(1).map((call, index) => call.ts - listings[index]!.ts);
  return { minutes, gapsMs, exactlyOne: minutes.filter((minute) => minute.listings === 1).length, judged: minutes.length };
}

/** One line of the schedulers' tick log as the harness records it (ticks.jsonl): the process, the logger's `ts`, the event. */
export interface TickLine {
  readonly process?: unknown;
  readonly ts?: unknown;
  readonly event?: unknown;
}

/** The event an acting scheduler logs at the end of every tick it acted on (bin/scheduler.mts). */
export const ACTED_TICK_EVENT = "scheduler tick";

/**
 * Discovery judged PER ACTED TICK, the scheduler's own unit: each listing is
 * given to the first acted tick its scheduler logged at or after it, within
 * `maxTickMs` (a listing is made inside a tick, and the tick logs when it ends).
 * An acted tick logged in [from, to] is judged: exactly one listing, or not. A
 * listing no acted tick of its scheduler took is an ORPHAN — a standby that
 * listed, or a tick that died after listing — and is counted apart.
 *
 * WHY NOT THE MINUTE ALONE: a tick that runs late (the process frozen for a
 * while, an RPC that times out) leaves a UTC minute with no listing although
 * every tick listed once — all 19 of the 7-day shadow's "not one" minutes were
 * such gaps between two ticks of one scheduler (84–180 s). The late ticks are
 * listed beside the verdict: a tick more than 1.5 × `tickMs` after its
 * scheduler's previous one.
 */
export function listingsPerTick(
  lines: readonly ProxyLine[],
  ticks: readonly TickLine[],
  isScheduler: (run: string) => boolean,
  from: number,
  to: number,
  options: { readonly tickMs?: number; readonly maxTickMs?: number } = {},
): {
  /** Every judged acted tick, in time order, with the listings it took. */
  readonly ticks: readonly { readonly at: number; readonly process: string; readonly listings: number }[];
  readonly judged: number;
  readonly exactlyOne: number;
  readonly notOne: readonly { readonly at: number; readonly process: string; readonly listings: number }[];
  readonly orphans: readonly { readonly at: number; readonly process: string }[];
  readonly late: readonly { readonly at: number; readonly process: string; readonly gapMs: number }[];
} {
  const tickMs = options.tickMs ?? 60_000;
  const maxTickMs = options.maxTickMs ?? 5 * tickMs;
  const byProcess = new Map<string, number[]>();
  for (const line of ticks) {
    if (line.event !== ACTED_TICK_EVENT || typeof line.process !== "string" || !isScheduler(line.process)) continue;
    const at = millis(line.ts);
    if (at === null || at < from - maxTickMs || at > to + maxTickMs) continue;
    const list = byProcess.get(line.process) ?? [];
    list.push(at);
    byProcess.set(line.process, list);
  }
  for (const list of byProcess.values()) list.sort((a, b) => a - b);
  const taken = new Map<string, number[]>();
  for (const [process, list] of byProcess) taken.set(process, list.map(() => 0));
  const orphans: { at: number; process: string }[] = [];
  for (const line of lines) {
    const call = callOf(line);
    if (call === null || !LISTING_METHODS.has(call.method) || !isScheduler(call.run) || call.ts < from - maxTickMs || call.ts > to) continue;
    const list = byProcess.get(call.run) ?? [];
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid]! < call.ts) lo = mid + 1;
      else hi = mid;
    }
    if (lo < list.length && list[lo]! - call.ts <= maxTickMs) taken.get(call.run)![lo]! += 1;
    else if (call.ts >= from) orphans.push({ at: call.ts, process: call.run });
  }
  const judgedTicks: { at: number; process: string; listings: number }[] = [];
  const late: { at: number; process: string; gapMs: number }[] = [];
  for (const [process, list] of byProcess) {
    list.forEach((at, index) => {
      if (at < from || at > to) return;
      judgedTicks.push({ at, process, listings: taken.get(process)![index]! });
      const previous = index === 0 ? null : list[index - 1]!;
      if (previous !== null && at - previous > 1.5 * tickMs) late.push({ at, process, gapMs: at - previous });
    });
  }
  const byTime = <T extends { readonly at: number }>(a: T, b: T): number => a.at - b.at;
  judgedTicks.sort(byTime);
  const notOne = judgedTicks.filter((tick) => tick.listings !== 1);
  return { ticks: judgedTicks, judged: judgedTicks.length, exactlyOne: judgedTicks.length - notOne.length, notOne, orphans: orphans.sort(byTime), late: late.sort(byTime) };
}

/** Calls and credits by the bill's line, for the calls `accept` takes, at one archival price. */
export function creditsOf(
  lines: readonly ProxyLine[],
  archival: ArchivalCredits,
  accept: (run: string, ts: number) => boolean = () => true,
): { readonly calls: number; readonly credits: number; readonly byClass: Readonly<Record<string, { readonly calls: number; readonly credits: number }>>; readonly byMethod: Readonly<Record<string, number>>; readonly refused: number } {
  const byClass: Record<string, { calls: number; credits: number }> = {};
  const byMethod: Record<string, number> = {};
  let calls = 0;
  let credits = 0;
  let refused = 0;
  for (const line of lines) {
    const call = callOf(line);
    if (call === null || !accept(call.run, call.ts)) continue;
    if (call.refused) {
      // A REFUSED CALL NEVER REACHED A NODE: nothing to bill, but counted, because it should not exist.
      refused += 1;
      continue;
    }
    const line_: CreditClass = creditClassOf(call.method, undefined);
    const price = creditPrice(line_, archival);
    const entry = (byClass[line_] ??= { calls: 0, credits: 0 });
    entry.calls += 1;
    entry.credits += price;
    byMethod[call.method] = (byMethod[call.method] ?? 0) + 1;
    calls += 1;
    credits += price;
  }
  return { calls, credits, byClass, byMethod, refused };
}

/** A count over a window, scaled to a day. */
export const perDay = (count: number, windowMs: number): number => (windowMs <= 0 ? 0 : (count * 86_400_000) / windowMs);

// ── THE COVERAGE CLOCK (plan §3.3.2: "≥ 7 × 24 h of ticks; gaps are listed, not hidden") ──

/** One heartbeat of the harness's minute (coverage.jsonl): when, which session of the run, and whether the shadow could work. */
export interface CoverageBeat {
  readonly at: number;
  readonly session: number;
  /**
   * The shadow could work at that instant: at least one live scheduler and one
   * live worker, its database answering and its proxy up — a drill's
   * deliberate outage excepted (the harness decides; this only reads it).
   */
  readonly fleetUp: boolean;
}

/**
 * The longest step between two beats that still counts as covered. The minute
 * beats every 60 s; a minute that ran long (a production fetch's 15 s, an
 * audit waiting on a paused database) can push one beat to the next minute,
 * so one skipped beat (≈ 120 s) is still covered. Anything longer — a sleeping
 * Mac, a stopped process — is a gap.
 */
export const COVER_MAX_STEP_MS = 135_000;

export interface CoverageGap {
  readonly from: number;
  readonly to: number;
  readonly ms: number;
  readonly cause: string;
}

export interface Coverage {
  /** The sum of the covered steps: the clock the 7 × 24 h target is read on. */
  readonly coveredMs: number;
  /** The covered stretches, each a run of consecutive covered steps. */
  readonly intervals: readonly { readonly from: number; readonly to: number }[];
  /** Every step that was not covered, with its cause; adjacent gaps of one cause are merged. */
  readonly gaps: readonly CoverageGap[];
  readonly firstBeatAt: number | null;
  readonly lastBeatAt: number | null;
}

/**
 * The coverage clock over a run's beats, across every session of it. A step
 * between two consecutive beats is COVERED when both belong to one session, the
 * fleet was up at both, and it is no longer than `maxStepMs`. Every other step
 * is a GAP, named:
 *   * between two sessions: `sessionCause(next session)` — the harness was not
 *     running (a stop, a crash, a reboot), as the harness recorded it at resume;
 *   * a step too long inside one session: the harness's minute did not run —
 *     the Mac slept, or the process was frozen;
 *   * the fleet down at either end: the shadow could not work.
 * With `now`, a last beat older than `maxStepMs` opens a gap up to `now` (the
 * run is not beating now). Nothing is ever dropped: covered + gaps = the span.
 */
export function coverageOf(
  beats: readonly CoverageBeat[],
  options: { readonly maxStepMs?: number; readonly sessionCause?: (session: number) => string | undefined; readonly now?: number } = {},
): Coverage {
  const maxStepMs = options.maxStepMs ?? COVER_MAX_STEP_MS;
  const ordered = beats.filter((beat) => Number.isFinite(beat.at)).sort((a, b) => a.at - b.at);
  const intervals: { from: number; to: number }[] = [];
  const gaps: CoverageGap[] = [];
  let coveredMs = 0;
  const gap = (from: number, to: number, cause: string): void => {
    const last = gaps.at(-1);
    if (last !== undefined && last.to === from && last.cause === cause) {
      gaps[gaps.length - 1] = { from: last.from, to, ms: to - last.from, cause };
      return;
    }
    gaps.push({ from, to, ms: to - from, cause });
  };
  for (let i = 1; i < ordered.length; i += 1) {
    const a = ordered[i - 1]!;
    const b = ordered[i]!;
    const step = b.at - a.at;
    if (a.session !== b.session) {
      gap(a.at, b.at, options.sessionCause?.(b.session) ?? `the harness was not running (session ${b.session} resumed the run)`);
      continue;
    }
    if (!a.fleetUp || !b.fleetUp) {
      gap(a.at, b.at, "the shadow could not work (no live scheduler or worker, or its database or proxy down)");
      continue;
    }
    if (step > maxStepMs) {
      gap(a.at, b.at, "the harness's minute did not run: the Mac slept, or the process was frozen");
      continue;
    }
    coveredMs += step;
    const last = intervals.at(-1);
    if (last !== undefined && last.to === a.at) last.to = b.at;
    else intervals.push({ from: a.at, to: b.at });
  }
  const lastBeatAt = ordered.at(-1)?.at ?? null;
  if (options.now !== undefined && lastBeatAt !== null && options.now - lastBeatAt > maxStepMs) {
    gap(lastBeatAt, options.now, "no beat since: the harness is not running, or the Mac sleeps");
  }
  return { coveredMs, intervals, gaps, firstBeatAt: ordered[0]?.at ?? null, lastBeatAt };
}

// ── THE DRILLS OF A LONG RUN ─────────────────────────────────────────────────

/** A drill the run owes: its id (stable across resumes), its name, and when it is due on the coverage clock. */
export interface PlannedDrill {
  readonly id: string;
  readonly name: string;
  readonly atCoveredMs: number;
}

/**
 * Every drill once per covered day, spread over the day: the slots are
 * `firstSlotHours`, then every `slotEveryHours`, and drill k takes slot
 * (k + day) mod n — so over n days every drill meets every slot once, and no
 * two drills share a slot. Due times are on the COVERAGE clock, so a night the
 * Mac slept moves the drills with it instead of piling them up at the resume.
 * Ids are `d<day>-<name>`, the same in every session of the run.
 */
export function weeklyDrillPlan(names: readonly string[], days: number, firstSlotHours = 1, slotEveryHours = 3): PlannedDrill[] {
  if (names.length === 0) return [];
  if (firstSlotHours + slotEveryHours * (names.length - 1) >= 24) throw new Error("the drills' slots do not fit in a day");
  const out: PlannedDrill[] = [];
  for (let day = 0; day < days; day += 1) {
    names.forEach((name, k) => {
      const slot = (k + day) % names.length;
      out.push({ id: `d${day + 1}-${name}`, name, atCoveredMs: (day * 24 + firstSlotHours + slot * slotEveryHours) * 3_600_000 });
    });
  }
  return out.sort((a, b) => a.atCoveredMs - b.atCoveredMs);
}

/** One line of drills.jsonl as the ledger reads it. */
export interface DrillResultLine {
  readonly id?: unknown;
  readonly drill?: unknown;
  readonly ok?: unknown;
  readonly interrupted?: unknown;
  readonly startedAt?: unknown;
}

/**
 * Where each planned drill stands, from the results written so far: DONE when
 * a result that is not an interruption exists (passed or failed — a failure is
 * a result, never retried); INTERRUPTED attempts (the harness stopped mid-drill)
 * are counted and the drill stays owed until `maxAttempts` interruptions, after
 * which it counts as failed. A result line without an id is a run before ids
 * (its drill name is its id).
 */
export function drillLedger(
  planned: readonly PlannedDrill[],
  results: readonly DrillResultLine[],
  maxAttempts = 2,
): {
  readonly done: readonly { readonly id: string; readonly name: string; readonly ok: boolean; readonly startedAt: string | null }[];
  readonly interrupted: Readonly<Record<string, number>>;
  readonly owed: readonly PlannedDrill[];
  readonly gaveUp: readonly string[];
} {
  const finals = new Map<string, { id: string; name: string; ok: boolean; startedAt: string | null }>();
  const interrupted: Record<string, number> = {};
  for (const line of results) {
    const name = typeof line.drill === "string" ? line.drill : "";
    const id = typeof line.id === "string" ? line.id : name;
    if (id === "") continue;
    if (line.interrupted === true) {
      interrupted[id] = (interrupted[id] ?? 0) + 1;
      continue;
    }
    finals.set(id, { id, name, ok: line.ok === true, startedAt: typeof line.startedAt === "string" ? line.startedAt : null });
  }
  const gaveUp = Object.entries(interrupted)
    .filter(([id, n]) => n >= maxAttempts && !finals.has(id))
    .map(([id]) => id);
  return {
    done: [...finals.values()],
    interrupted,
    owed: planned.filter((drill) => !finals.has(drill.id) && !gaveUp.includes(drill.id)),
    gaveUp,
  };
}
