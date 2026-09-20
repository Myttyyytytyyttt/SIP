/**
 * Where the rankings come from, and what this app is willing to believe about
 * them.
 *
 * THE SITE STILL HAS NO DATABASE. The keeper owns the history — it is the only
 * writer — so it also computes the boards and serves them at /leaderboard, and
 * this file reads that one URL from the server side. No connection string
 * reaches Vercel, no pooled Postgres client lives in a serverless function, and
 * the page keeps the property every other page here has: it can be rendered by
 * anyone, holding nothing.
 *
 * A NETWORK RESPONSE IS NOT A TYPE. What comes back is parsed and checked,
 * never cast: a keeper on an old build, a proxy serving an error page as JSON
 * or a half-written payload must produce "unavailable", not a page that throws
 * while rendering a row. Entries that do not parse are dropped; a payload whose
 * shape is wrong is refused whole.
 */

export type BoardName = "ahorro" | "volumen";
export type RangeName = "season" | "all";

export const BOARD_NAMES: readonly BoardName[] = ["ahorro", "volumen"];
const RANGE_NAMES: readonly RangeName[] = ["season", "all"];

export interface LeaderboardEntry {
  readonly rank: number;
  /** The vault address: one competitor per pension, whatever it trades through. */
  readonly subject: string;
  readonly points: number;
  readonly activeDays: number;
  readonly bestStreak: number;
  readonly settles: number;
  /** Lamports as a decimal string — never a number, which would round it. */
  readonly amountRaw: string;
}

/** The scoring constants THE SERVICE APPLIED, so the page explains the real rule. */
export interface BoardRules {
  readonly participation: number;
  readonly sizeFactor: number;
  readonly sizeCap: number;
  readonly sizeUnit: number;
  readonly streakPerDay: number;
  readonly streakCap: number;
}

export interface LeaderboardData {
  readonly computedAt: string;
  readonly seasonStart: string;
  readonly unit: "lamports";
  readonly rules: Readonly<Record<BoardName, BoardRules>>;
  readonly coverage: {
    readonly subjects: number;
    readonly settlements: number;
    readonly firstDay: string | null;
    readonly lastDay: string | null;
  };
  readonly boards: Readonly<Record<BoardName, Readonly<Record<RangeName, readonly LeaderboardEntry[]>>>>;
}

export type LeaderboardResult =
  | { readonly ok: true; readonly data: LeaderboardData }
  | { readonly ok: false; readonly detail: string };

/** The one variable this feature reads. Public: a keeper's own hostname, not a key. */
export const KEEPER_URL_VARIABLE = "SIP_SOLANA_KEEPER_URL";

/** How long a fetched payload may be reused. The keeper recomputes every two minutes. */
export const LEADERBOARD_REVALIDATE_SECONDS = 60;

/** A keeper that does not answer in this long is treated as unavailable. */
const TIMEOUT_MS = 6_000;

type Env = Readonly<Record<string, string | undefined>>;

/**
 * The keeper's /leaderboard URL, or why there is none.
 *
 * CREDENTIALS ARE REFUSED, not stripped. A URL with a password in it is a
 * misconfiguration whose right answer is to fix the variable — quietly dropping
 * the password would leave the secret sitting in an environment nobody revisits.
 * Plain http is allowed only for localhost, where there is no network to listen on.
 */
export function leaderboardEndpoint(env: Env): { readonly ok: true; readonly url: string } | { readonly ok: false; readonly detail: string } {
  const raw = env[KEEPER_URL_VARIABLE]?.trim();
  if (raw === undefined || raw === "") {
    return { ok: false, detail: `no keeper is configured: set ${KEEPER_URL_VARIABLE} to the keeper's public URL` };
  }
  let base: URL;
  try {
    base = new URL(raw);
  } catch {
    return { ok: false, detail: `${KEEPER_URL_VARIABLE} is not a URL` };
  }
  if (base.username !== "" || base.password !== "") {
    return { ok: false, detail: `${KEEPER_URL_VARIABLE} must not carry credentials` };
  }
  const local = base.hostname === "localhost" || base.hostname === "127.0.0.1";
  if (base.protocol !== "https:" && !(base.protocol === "http:" && local)) {
    return { ok: false, detail: `${KEEPER_URL_VARIABLE} must be https (http is allowed only for localhost)` };
  }
  const prefix = base.pathname.replace(/\/+$/, "");
  return { ok: true, url: new URL(`${prefix}/leaderboard`, base).toString() };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** A lamport amount as the keeper serves it: digits only, and never a number. */
function digits(value: unknown): string | null {
  return typeof value === "string" && /^\d+$/.test(value) ? value : null;
}

function parseEntry(value: unknown): LeaderboardEntry | null {
  if (!isRecord(value)) return null;
  const rank = finite(value["rank"]);
  const points = finite(value["points"]);
  const activeDays = finite(value["activeDays"]);
  const bestStreak = finite(value["bestStreak"]);
  const settles = finite(value["settles"]);
  const amountRaw = digits(value["amountRaw"]);
  const subject = typeof value["subject"] === "string" ? value["subject"] : null;
  if (rank === null || points === null || activeDays === null || bestStreak === null || settles === null) return null;
  if (amountRaw === null || subject === null || subject === "") return null;
  return { rank, subject, points, activeDays, bestStreak, settles, amountRaw };
}

function parseRules(value: unknown): BoardRules | null {
  if (!isRecord(value)) return null;
  const participation = finite(value["participation"]);
  const sizeFactor = finite(value["sizeFactor"]);
  const sizeCap = finite(value["sizeCap"]);
  const sizeUnit = finite(value["sizeUnit"]);
  const streakPerDay = finite(value["streakPerDay"]);
  const streakCap = finite(value["streakCap"]);
  if (participation === null || sizeFactor === null || sizeCap === null) return null;
  if (sizeUnit === null || sizeUnit <= 0 || streakPerDay === null || streakCap === null) return null;
  return { participation, sizeFactor, sizeCap, sizeUnit, streakPerDay, streakCap };
}

/** The payload, checked. Null means "this is not a leaderboard", never an empty one. */
export function parseLeaderboard(value: unknown): LeaderboardData | null {
  if (!isRecord(value)) return null;
  const computedAt = typeof value["computedAt"] === "string" ? value["computedAt"] : null;
  const seasonStart = typeof value["seasonStart"] === "string" ? value["seasonStart"] : null;
  if (computedAt === null || seasonStart === null || value["unit"] !== "lamports") return null;
  if (!isRecord(value["rules"]) || !isRecord(value["boards"]) || !isRecord(value["coverage"])) return null;

  const rules: Record<string, BoardRules> = {};
  const boards: Record<string, Record<string, readonly LeaderboardEntry[]>> = {};
  for (const board of BOARD_NAMES) {
    const boardRules = parseRules((value["rules"] as Record<string, unknown>)[board]);
    const cuts = (value["boards"] as Record<string, unknown>)[board];
    if (boardRules === null || !isRecord(cuts)) return null;
    rules[board] = boardRules;
    const parsed: Record<string, readonly LeaderboardEntry[]> = {};
    for (const range of RANGE_NAMES) {
      const rows = cuts[range];
      if (!Array.isArray(rows)) return null;
      // ONE BAD ROW IS NOT A BAD BOARD: drop it and rank what parsed.
      parsed[range] = rows.map(parseEntry).filter((entry): entry is LeaderboardEntry => entry !== null);
    }
    boards[board] = parsed;
  }

  const coverage = value["coverage"] as Record<string, unknown>;
  return {
    computedAt,
    seasonStart,
    unit: "lamports",
    rules: rules as Record<BoardName, BoardRules>,
    coverage: {
      subjects: finite(coverage["subjects"]) ?? 0,
      settlements: finite(coverage["settlements"]) ?? 0,
      firstDay: typeof coverage["firstDay"] === "string" ? coverage["firstDay"] : null,
      lastDay: typeof coverage["lastDay"] === "string" ? coverage["lastDay"] : null,
    },
    boards: boards as LeaderboardData["boards"],
  };
}

/**
 * Reads the keeper's board. NEVER THROWS and never returns an empty payload in
 * place of a failure: the caller must be able to say "unavailable" out loud,
 * because an empty table tells a visitor that nobody has ever saved anything.
 */
export async function fetchLeaderboard(
  env: Env = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<LeaderboardResult> {
  const endpoint = leaderboardEndpoint(env);
  if (!endpoint.ok) return endpoint;
  try {
    const response = await fetchImpl(endpoint.url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      // The keeper recomputes on its own cadence; this is the shared cache in
      // front of it, so a burst of visitors is one upstream request.
      next: { revalidate: LEADERBOARD_REVALIDATE_SECONDS },
    } as RequestInit);
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      // The keeper's own reason when it gave one: "no database", "not computed
      // yet". Far better than "503" for whoever has to fix it.
      const detail = isRecord(body) && typeof body["detail"] === "string" ? body["detail"] : `the keeper answered ${response.status}`;
      return { ok: false, detail };
    }
    const data = parseLeaderboard(body);
    if (data === null) return { ok: false, detail: "the keeper's answer was not a leaderboard this build understands" };
    return { ok: true, data };
  } catch (error) {
    // A TIMEOUT AND A DNS FAILURE READ THE SAME to a visitor, and neither may
    // put an upstream message on the page.
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    return { ok: false, detail: timedOut ? "the keeper did not answer in time" : "the keeper could not be reached" };
  }
}

/**
 * Lamports as SOL, from the decimal string. BIGINT ALL THE WAY: Number would
 * round a real balance, and the one thing a ranking must not do is misreport
 * the amount beside the name.
 */
export function formatSol(amountRaw: string, digitsAfter = 4): string {
  let lamports: bigint;
  try {
    lamports = BigInt(amountRaw);
  } catch {
    return "—";
  }
  const whole = lamports / 1_000_000_000n;
  const fraction = (lamports % 1_000_000_000n).toString().padStart(9, "0").slice(0, digitsAfter).replace(/0+$/, "");
  if (whole === 0n && fraction === "") return lamports === 0n ? "0" : `<0.${"0".repeat(digitsAfter - 1)}1`;
  return fraction === "" ? whole.toString() : `${whole}.${fraction}`;
}
