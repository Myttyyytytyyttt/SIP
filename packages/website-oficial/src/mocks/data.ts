/**
 * THE MOCK IS THE CONTRACT. Every panel reads from this one object, so the
 * strip, the feed and the hero cannot disagree about what a trade put aside.
 *
 * NOTHING HERE IS RANDOM AT RUNTIME. A seeded generator builds the same ninety
 * days on the server and in the browser; that is what keeps hydration honest.
 * A Math.random() or a Date.now() anywhere in this file would render one
 * number on the server and another on the client, and React would tell you
 * about it on every load.
 *
 * The story it tells: a trader funded a wallet on the first day and has been
 * buying and selling the desk products and xStocks since. Every fill — buy or
 * sell — put 0.20% of its size aside. Once the pile reached five dollars, the
 * pension invested it in whichever target was furthest under its weight. That
 * is the rule in src/mocks/types.ts, run forward.
 */

import type {
  ActivityEvent,
  DashboardMock,
  Holding,
  SavingsDay,
  SavingsPoint,
  SavingsRule,
  SavingsStats,
  Ticker,
  Trade,
  Wallet,
} from "./types";

export const MOCK_NOW = "2026-09-07T14:32:00.000Z";

const DAYS = 90;
const SEED = 137;
const DAY_MS = 86_400_000;

const RULE: SavingsRule = {
  rateBps: 20,
  thresholdUsd: 5,
  targets: [
    { symbol: "INDEX", weightBps: 6000 },
    { symbol: "SPYx", weightBps: 2500 },
    { symbol: "GLDx", weightBps: 1500 },
  ],
  paused: false,
};

const WALLET_ADDRESS = "0x7a3f9c1e4b2d8a6f0e5c3b9d1a7e2f4c6b8d0a1e";
const OPENING_DEPOSIT_USD = 5000;

/** What the wallet trades, weighted toward the desk products. */
const TRADED: ReadonlyArray<readonly [Ticker, number]> = [
  ["pHOOD3x", 18],
  ["pBTC3x", 14],
  ["NVDAx", 12],
  ["TSLAx", 11],
  ["HOODx", 9],
  ["MSTRx", 8],
  ["COINx", 7],
  ["PLTRx", 6],
  ["METAx", 5],
  ["AAPLx", 5],
  ["QQQx", 5],
];

/** Opening prices for the targets; each walks a seeded path from here. */
const BASE_PRICE: ReadonlyArray<readonly [Ticker, number]> = [
  ["INDEX", 10],
  ["SPYx", 640],
  ["GLDx", 305],
];

// ── deterministic randomness ────────────────────────────────────────────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rnd = mulberry32(SEED);

function gaussian(mean: number, sd: number): number {
  const u = 1 - rnd();
  const v = rnd();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function pickWeighted<T>(items: ReadonlyArray<readonly [T, number]>): T {
  const total = items.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = rnd() * total;
  for (const [item, weight] of items) {
    roll -= weight;
    if (roll <= 0) return item;
  }
  const last = items[items.length - 1];
  if (last === undefined) throw new Error("pickWeighted: nothing to pick from");
  return last[0];
}

function txHash(): string {
  let out = "0x";
  while (out.length < 66) out += Math.floor(rnd() * 16).toString(16);
  return out;
}

const round2 = (value: number): number => Math.round(value * 100) / 100;
const round6 = (value: number): number => Math.round(value * 1_000_000) / 1_000_000;

// ── the calendar ────────────────────────────────────────────────────────────

const now = new Date(MOCK_NOW);
const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
const dayStart = (offset: number): Date => new Date(todayUtc - (DAYS - 1 - offset) * DAY_MS);
const isoDay = (date: Date): string => date.toISOString().slice(0, 10);

// ── target prices: one seeded walk per symbol ───────────────────────────────

const prices = new Map<Ticker, readonly number[]>();
for (const [symbol, base] of BASE_PRICE) {
  const path: number[] = [];
  let price = base;
  for (let day = 0; day < DAYS; day++) {
    price *= 1 + gaussian(0.0006, 0.011);
    path.push(price);
  }
  prices.set(symbol, path);
}

function priceAt(symbol: Ticker, day: number): number {
  const price = prices.get(symbol)?.[day];
  if (price === undefined) throw new Error(`no price for ${symbol} on day ${day}`);
  return price;
}

// ── run the rule forward ────────────────────────────────────────────────────

function buildMock(): DashboardMock {
  const trades: Trade[] = [];
  const activity: ActivityEvent[] = [];
  const days: SavingsDay[] = [];
  const held = new Map<Ticker, { shares: number; costUsd: number }>();

  let sequence = 0;
  const nextId = (prefix: string): string => `${prefix}-${String(++sequence).padStart(4, "0")}`;

  /** The target furthest under its intended weight, by cost basis. */
  const mostUnderweight = (): Ticker => {
    const totalCost = RULE.targets.reduce((sum, t) => sum + (held.get(t.symbol)?.costUsd ?? 0), 0);
    let best: Ticker | null = null;
    let bestGap = -Infinity;
    for (const target of RULE.targets) {
      const actual = totalCost > 0 ? ((held.get(target.symbol)?.costUsd ?? 0) / totalCost) * 10_000 : 0;
      const gap = target.weightBps - actual;
      if (gap > bestGap) {
        bestGap = gap;
        best = target.symbol;
      }
    }
    if (best === null) throw new Error("the savings rule has no targets");
    return best;
  };

  let pending = 0;
  let investments = 0;

  activity.push({
    kind: "deposit",
    id: nextId("a"),
    at: new Date(dayStart(0).getTime() + 8 * 3_600_000).toISOString(),
    txHash: txHash(),
    amountUsd: OPENING_DEPOSIT_USD,
  });

  for (let day = 0; day < DAYS; day++) {
    const date = dayStart(day);
    const weekend = date.getUTCDay() === 0 || date.getUTCDay() === 6;
    const count = weekend
      ? pickWeighted<number>([
          [0, 5],
          [1, 3],
          [2, 1],
        ])
      : pickWeighted<number>([
          [1, 2],
          [2, 4],
          [3, 4],
          [4, 2],
          [5, 1],
        ]);

    // Minutes after midnight UTC, between 08:00 and 21:00, in order.
    const minutes = Array.from({ length: count }, () => 8 * 60 + Math.floor(rnd() * 13 * 60)).sort(
      (left, right) => left - right,
    );

    let savedToday = 0;
    let volumeToday = 0;
    let tradesToday = 0;

    for (const minute of minutes) {
      const at = new Date(date.getTime() + minute * 60_000);
      // The mock is "read" mid-afternoon; nothing has happened after that yet.
      if (at.getTime() > now.getTime()) continue;

      const symbol = pickWeighted(TRADED);
      const side = rnd() < 0.55 ? "buy" : "sell";
      const notionalUsd = round2(150 + Math.pow(rnd(), 1.6) * 2600);
      // THE WHOLE RULE IN ONE LINE: a slice of the fill, whatever the side.
      const savedUsd = round2((notionalUsd * RULE.rateBps) / 10_000);
      const id = nextId("t");
      const hash = txHash();

      trades.push({ id, at: at.toISOString(), symbol, side, notionalUsd, savedUsd, txHash: hash });
      activity.push({
        kind: "trade",
        id: nextId("a"),
        at: at.toISOString(),
        txHash: hash,
        tradeId: id,
        symbol,
        side,
        notionalUsd,
        savedUsd,
        rateBps: RULE.rateBps,
      });
      tradesToday += 1;
      volumeToday = round2(volumeToday + notionalUsd);
      savedToday = round2(savedToday + savedUsd);
      pending = round2(pending + savedUsd);

      if (pending < RULE.thresholdUsd) continue;

      // Accumulate to the threshold, invest the lot, start again.
      const target = mostUnderweight();
      const priceUsd = round2(priceAt(target, day));
      const amountUsd = pending;
      const shares = round6(amountUsd / priceUsd);
      const position = held.get(target) ?? { shares: 0, costUsd: 0 };
      held.set(target, { shares: round6(position.shares + shares), costUsd: round2(position.costUsd + amountUsd) });
      activity.push({
        kind: "invested",
        id: nextId("a"),
        at: new Date(at.getTime() + 90_000).toISOString(),
        txHash: txHash(),
        symbol: target,
        shares,
        priceUsd,
        amountUsd,
      });
      investments += 1;
      pending = 0;
    }

    days.push({ date: isoDay(date), savedUsd: savedToday, volumeUsd: volumeToday, trades: tradesToday });
  }

  // ── derived: the curve is the hero's number at every date ────────────────

  const curve: SavingsPoint[] = [{ date: isoDay(new Date(dayStart(0).getTime() - DAY_MS)), total: 0 }];
  let running = 0;
  for (const day of days) {
    running = round2(running + day.savedUsd);
    curve.push({ date: day.date, total: running });
  }
  const totalSavedUsd = running;

  // ── derived: holdings at today's prices ──────────────────────────────────

  const valued = RULE.targets.map((target) => {
    const position = held.get(target.symbol) ?? { shares: 0, costUsd: 0 };
    return {
      symbol: target.symbol,
      shares: position.shares,
      costUsd: round2(position.costUsd),
      valueUsd: round2(position.shares * priceAt(target.symbol, DAYS - 1)),
      targetWeightBps: target.weightBps,
    };
  });
  const holdingsUsd = round2(valued.reduce((sum, h) => sum + h.valueUsd, 0));
  const costUsd = round2(valued.reduce((sum, h) => sum + h.costUsd, 0));
  const holdings: Holding[] = valued.map((h) => ({
    ...h,
    weightBps: holdingsUsd > 0 ? Math.round((h.valueUsd / holdingsUsd) * 10_000) : 0,
  }));

  // ── derived: streaks ─────────────────────────────────────────────────────

  let currentStreakDays = 0;
  {
    let index = days.length - 1;
    const today = days[index];
    // Today is not over; an empty today does not break the streak.
    if (today !== undefined && today.savedUsd === 0) index -= 1;
    for (; index >= 0; index -= 1) {
      const day = days[index];
      if (day === undefined || day.savedUsd === 0) break;
      currentStreakDays += 1;
    }
  }
  let longestStreakDays = 0;
  let run = 0;
  for (const day of days) {
    run = day.savedUsd > 0 ? run + 1 : 0;
    if (run > longestStreakDays) longestStreakDays = run;
  }

  // ── derived: the rest of the stats ───────────────────────────────────────

  const best = trades.reduce<Trade | null>((top, t) => (top === null || t.savedUsd > top.savedUsd ? t : top), null);
  const sumLast = (n: number, pick: (day: SavingsDay) => number): number =>
    round2(days.slice(-n).reduce((sum, d) => sum + pick(d), 0));
  const volumeUsd = round2(days.reduce((sum, d) => sum + d.volumeUsd, 0));
  const firstSave = activity.find((e) => e.kind === "trade");

  const stats: SavingsStats = {
    totalSavedUsd,
    pensionValueUsd: round2(holdingsUsd + pending),
    holdingsUsd,
    costUsd,
    unrealizedUsd: round2(holdingsUsd - costUsd),
    pendingUsd: pending,
    thresholdUsd: RULE.thresholdUsd,
    savedTodayUsd: sumLast(1, (d) => d.savedUsd),
    savedThisWeekUsd: sumLast(7, (d) => d.savedUsd),
    savedThisMonthUsd: sumLast(30, (d) => d.savedUsd),
    volumeUsd,
    volumeThisMonthUsd: sumLast(30, (d) => d.volumeUsd),
    trades: trades.length,
    avgSavedPerTradeUsd: trades.length > 0 ? round2(totalSavedUsd / trades.length) : 0,
    bestTradeSavedUsd: best?.savedUsd ?? 0,
    bestTradeId: best?.id ?? null,
    investments,
    activeDays: days.filter((d) => d.savedUsd > 0).length,
    currentStreakDays,
    longestStreakDays,
    firstSaveAt: firstSave?.at ?? null,
    projectedYearUsd: round2((totalSavedUsd / DAYS) * 365),
  };

  const wallet: Wallet = {
    address: WALLET_ADDRESS,
    network: "Robinhood Chain",
    label: "Trading wallet",
    // What went in, minus what every fill put aside. Positions are not
    // modelled here; the balance is the cash the wallet still trades with.
    balanceUsd: round2(OPENING_DEPOSIT_USD - totalSavedUsd),
  };

  const newestFirst = <T extends { readonly at: string }>(items: readonly T[]): T[] =>
    [...items].sort((left, right) => right.at.localeCompare(left.at));

  return {
    now: MOCK_NOW,
    wallet,
    rule: RULE,
    stats,
    curve,
    days,
    holdings,
    trades: newestFirst(trades),
    activity: newestFirst(activity),
  };
}

export const mock: DashboardMock = buildMock();
