/**
 * THE LIVE PENSION, IN THE SAMPLE'S SHAPE.
 *
 * The sample's components were built to be fed this way — src/mocks/types.ts
 * opens by saying that swapping the sample for real data "means satisfying
 * these interfaces, not touching a component". This is the satisfying: one
 * pure function from what the chain was read to say (LiveDashboard) to the
 * object those components already draw (DashboardMock).
 *
 * NOTHING HERE IS INVENTED. Every number below comes from a LiveDashboard field
 * or from arithmetic on one, and where the chain has no answer the field is
 * null — which the components print as a dash. Where the sample names a thing
 * the chain does not record, the slot carries the thing it does record under
 * its own name (settlements where the sample counts trades; the gains the rule
 * measured where it shows volume), and `vocabulary` tells the components so.
 *
 * DOLLARS ARE TODAY'S DOLLARS. The owner chose dollars everywhere the sample
 * has them (09-23). The chain stores lamports and no price with any of them, so
 * every figure here is lamports at the ONE price this snapshot read — what that
 * SOL is worth now, not what it was worth when it was saved. When the pools
 * could not be read, those figures are null, and the curve alone falls back to
 * SOL (`unit`), because a curve with no scale is worse than one in the chain's
 * own unit.
 *
 * AND IT CANNOT REACH THE SAMPLE. It imports the contract's types and nothing
 * from `@/mocks` itself — src/components/live/no-mock-import.test.ts scans
 * every lib/live-* file for exactly that.
 */

import { ACTIVITY_COPY } from "@/lib/live-copy";
import { artForMint, NATIVE_SOL } from "@/lib/asset-art";
import { formatSol, rawFrom, usdcRawForLamports } from "@/lib/amounts";
import { usd } from "@/lib/format";
import type { LiveDashboard, LiveRow, LiveWalletView } from "@/lib/live-types";
import { ratePercent } from "@/lib/vault-copy";
import { measureOf, partsOf } from "@/components/live/LiveActivityRow";
import type { ActivityEvent, DashboardMock, Holding, OtherEvent, SavingsDay, SavingsPoint, SavingsStats, Trade, Wallet } from "@/mocks/types";

const DAY_MS = 86_400_000;
const USDC_UNIT = 1_000_000;
const SOL_LOGO = artForMint(NATIVE_SOL) ?? undefined;

/**
 * ONE FIGURE IN THE COLUMN IS ALLOWED TO BE BIG, and it is the balance of the
 * wallet that actually saves. At most one is promoted, and only when it is
 * unambiguous — one readable wallet, or exactly one linked to this vault. A
 * balance nobody could read is never promoted: "—" at 24px is a hole.
 */
export function anchorOf(wallets: readonly LiveWalletView[]): string | null {
  const readable = wallets.filter((wallet) => wallet.lamports !== null);
  if (readable.length === 1) return readable[0]!.address;
  const linked = readable.filter((wallet) => wallet.linkStatus === "this_vault");
  return linked.length === 1 ? linked[0]!.address : null;
}

/** USDC raw units as dollars. Exact to the cent for any sum a pension will hold. */
const dollarsOf = (raw: bigint | null | undefined): number | null => (raw === null || raw === undefined ? null : Number(raw) / USDC_UNIT);

/** "YYYY-MM-DD" of a UTC midnight. */
const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/**
 * The sample's streaks, computed the sample's way (src/mocks/data.ts): today
 * is not over, so an empty today does not break the current one.
 */
function streaksOf(days: readonly { readonly lamports: bigint }[]): { readonly current: number; readonly longest: number } {
  let current = 0;
  let index = days.length - 1;
  if (index >= 0 && days[index]!.lamports === 0n) index -= 1;
  for (; index >= 0 && days[index]!.lamports > 0n; index -= 1) current += 1;
  let longest = 0;
  let run = 0;
  for (const day of days) {
    run = day.lamports > 0n ? run + 1 : 0;
    if (run > longest) longest = run;
  }
  return { current, longest };
}

/**
 * THE CURVE, ONE POINT PER UTC DAY — the sample's own sampling. Its chart
 * slices the last 30 or 90 POINTS and calls them days, so a point per
 * settlement would make "30d" mean thirty settlements. Each day carries the
 * total as it stood at that day's end; a leading point, the day before the
 * first, carries what was already saved before the loaded window began.
 */
function dailyCurve(points: readonly { readonly at: string; readonly totalLamports: bigint }[], nowMs: number, value: (lamports: bigint) => number | null): SavingsPoint[] {
  if (points.length === 0) return [];
  const firstDay = Math.floor(Date.parse(points[0]!.at) / DAY_MS) * DAY_MS;
  const lastDay = Math.floor(nowMs / DAY_MS) * DAY_MS;
  const out: SavingsPoint[] = [];
  const baseline = value(points[0]!.totalLamports);
  if (baseline === null) return [];
  out.push({ date: dayOf(firstDay - DAY_MS), total: baseline });
  let cursor = 0;
  let standing = points[0]!.totalLamports;
  for (let day = firstDay; day <= lastDay; day += DAY_MS) {
    const end = day + DAY_MS;
    while (cursor < points.length && Date.parse(points[cursor]!.at) < end) {
      standing = points[cursor]!.totalLamports;
      cursor += 1;
    }
    const total = value(standing);
    if (total === null) return [];
    out.push({ date: dayOf(day), total });
  }
  return out;
}

/** What each live kind leads with, in the sample row's own glyph vocabulary. */
const ICONS: Readonly<Partial<Record<LiveRow["event"]["kind"], OtherEvent["icon"]>>> = {
  wrapped: "wrap",
  converted: "convert",
  withdrew_sol: "withdraw",
  withdrew_token: "withdraw",
  vault_created: "vault",
  rule_changed: "rule",
  policy_signed: "policy",
  linked: "link",
  unlinked: "unlink",
  received_sol: "receive",
  failed: "failed",
  unreadable: "failed",
  upkeep: "upkeep",
};

export function toDashboardMock(data: LiveDashboard, { complete }: { readonly complete: boolean }): DashboardMock {
  const perSol = rawFrom(data.prices?.usdcRawPerSol);
  /** Lamports as dollars at the price this snapshot read; null when it read none. */
  const $ = (lamports: bigint | null | undefined): number | null =>
    lamports === null || lamports === undefined || perSol === null ? null : Number(usdcRawForLamports(lamports, perSol)) / USDC_UNIT;
  const labelOf = (wallet: string | null): string =>
    wallet === null ? ACTIVITY_COPY.someWallet : (data.wallets.find((entry) => entry.address === wallet)?.label ?? ACTIVITY_COPY.someWallet);
  const now = new Date(data.nowMs).toISOString();
  const { vault, policy, stats } = data;

  // ── the wallet the column leads with ───────────────────────────────────
  const anchor = anchorOf(data.wallets);
  const lead = anchor === null ? null : (data.wallets.find((wallet) => wallet.address === anchor) ?? null);
  const wallet: Wallet | null = lead === null ? null : { address: lead.address, network: "Solana", label: lead.label, balanceUsd: $(lead.lamports) };

  // ── the rule ───────────────────────────────────────────────────────────
  // The basket's real threshold, the balance at which EVERY leg clears the
  // minimum — which is what "invests when the pile reaches this" means. A
  // basket the caps can never buy has no such balance, and says nothing.
  const readiness = policy.readiness;
  const reachable = readiness !== null && readiness.state !== "unreachable" && readiness.investsAtRaw > 0n;
  const thresholdUsd = reachable ? dollarsOf(readiness.investsAtRaw) : null;

  // ── the numbers ────────────────────────────────────────────────────────
  const legRows = data.holdings.filter((row) => row.kind === "leg");
  const holdingsUsd = legRows.some((row) => row.valueUsdcRaw === null) ? null : dollarsOf(legRows.reduce((total, row) => total + (row.valueUsdcRaw ?? 0n), 0n));
  const streaks = streaksOf(stats.dailySaved);
  const createdMs = vault.createdAt === null || vault.createdAt <= 0n ? null : Number(vault.createdAt) * 1_000;
  // The sample's own "at this pace": the lifetime total over the days it took,
  // carried to a year. A projection, and the tile says so; not before a day
  // has passed, when a day's saving would be multiplied into a year's.
  const projected =
    vault.lifetimeSaved === null || createdMs === null || data.nowMs - createdMs < DAY_MS
      ? null
      : (vault.lifetimeSaved * BigInt(365 * DAY_MS)) / BigInt(data.nowMs - createdMs);

  const statsOut: SavingsStats = {
    totalSavedUsd: $(vault.lifetimeSaved),
    pensionValueUsd: dollarsOf(data.worthNowUsdcRaw),
    holdingsUsd,
    // No cost basis on chain, so no gain or loss against one.
    costUsd: null,
    unrealizedUsd: null,
    pendingUsd: dollarsOf(data.notInvestedUsdcRaw),
    readyToInvestUsd: readiness === null ? null : dollarsOf(readiness.heldRaw),
    thresholdUsd,
    savedTodayUsd: $(stats.savedTodayLamports),
    savedThisWeekUsd: $(stats.savedThisWeekLamports),
    savedThisMonthUsd: $(stats.savedThisMonthLamports),
    volumeUsd: $(stats.gainsMeasuredLamports),
    volumeThisMonthUsd: $(stats.gainsThisMonthLamports),
    trades: stats.settlementsLifetime === null ? null : Number(stats.settlementsLifetime),
    avgSavedPerTradeUsd:
      vault.lifetimeSaved === null || stats.settlementsLifetime === null || stats.settlementsLifetime === 0n ? null : $(vault.lifetimeSaved / stats.settlementsLifetime),
    bestTradeSavedUsd: $(stats.biggestPaid),
    bestTradeId: null,
    investments: stats.investmentsLoaded,
    activeDays: stats.dailySaved.length === 0 ? null : stats.dailySaved.filter((day) => day.lamports > 0n).length,
    currentStreakDays: stats.dailySaved.length === 0 ? null : streaks.current,
    longestStreakDays: stats.dailySaved.length === 0 ? null : streaks.longest,
    firstSaveAt: createdMs === null ? null : new Date(createdMs).toISOString(),
    projectedYearUsd: $(projected),
    vocabulary: "settlements",
    complete,
    pricedToday: perSol !== null,
    totalSavedSol: vault.lifetimeSaved === null ? null : formatSol(vault.lifetimeSaved),
    settledOutsideHistory: stats.settledOutsideHistory,
    holdingsUnreadable: !data.tokensReadable,
  };

  // ── the curve and the days ─────────────────────────────────────────────
  const unit = perSol === null ? ("SOL" as const) : undefined;
  const curve = dailyCurve(data.chart ?? [], data.nowMs, (lamports) => (unit === "SOL" ? Number(lamports) / 1e9 : $(lamports)));
  const days: SavingsDay[] = stats.dailySaved.map((day) => ({ date: day.day, savedUsd: $(day.lamports), volumeUsd: null, trades: null }));

  // ── what the pension holds: the basket, as the sample lists it ─────────
  const held = new Set(legRows.map((row) => row.mint));
  const holdings: Holding[] = [
    ...legRows.map((row) => ({
      symbol: row.symbol,
      logo: artForMint(row.mint) ?? undefined,
      shares: Number(row.uiAmount ?? "0"),
      // The RPC's own display string: SPYx's carries a multiplier raw units do not.
      sharesText: row.uiAmount ?? undefined,
      costUsd: null,
      valueUsd: dollarsOf(row.valueUsdcRaw),
      weightBps: row.weightBps,
      targetWeightBps: row.targetWeightBps,
    })),
    // A leg the policy names and the vault does not hold yet is a real row
    // holding nothing — but only when the token list was read, or "nothing"
    // is a guess.
    ...(data.tokensReadable
      ? policy.legs
          .filter((leg) => !held.has(leg.mint))
          .map((leg) => ({
            symbol: leg.symbol,
            logo: artForMint(leg.mint) ?? undefined,
            shares: 0,
            sharesText: "0",
            costUsd: null,
            valueUsd: 0,
            weightBps: 0,
            targetWeightBps: leg.weightBps,
          }))
      : []),
  ];

  // ── the settlements: the strip, and the green rows of the feed ─────────
  const savedDetail = (row: LiveRow): { readonly basis: string; readonly paid: bigint; readonly base: bigint } | null => {
    if (row.event.kind !== "settled") return null;
    const paid = rawFrom(row.event.paid) ?? 0n;
    const base = rawFrom(row.event.baseLamports) ?? 0n;
    const baseUsd = $(base);
    const rate = ratePercent(row.event.bps);
    const measure = measureOf(row.event.mode);
    return {
      paid,
      base,
      // In dollars when a price was read, and in the chain's own SOL when not.
      basis: baseUsd === null ? ACTIVITY_COPY.settledFrom(rate, formatSol(base), measure) : ACTIVITY_COPY.settledFromUsd(rate, usd(baseUsd), measure),
    };
  };

  const maxUsd = $(vault.maxContribution);
  const capText = maxUsd !== null ? usd(maxUsd) : vault.maxContribution === null ? "the rule's ceiling" : `${formatSol(vault.maxContribution)} SOL`;
  const trades: Trade[] = data.settlementRows.flatMap((row, index) => {
    const detail = savedDetail(row);
    // The strip is a glance at recent slices; one the chain gave no time is
    // still in the feed, under "Time unknown", and never dropped from there.
    if (detail === null || row.at === null || row.event.kind !== "settled") return [];
    return [
      {
        id: `${row.signature}:${index}`,
        at: row.at,
        symbol: "SOL",
        logo: SOL_LOGO,
        notionalUsd: $(detail.base),
        savedUsd: $(detail.paid),
        txHash: row.signature,
        // A slice the rule's ceiling cut short says so where it is looked at: the rest is not carried over.
        detail: `${labelOf(row.event.wallet)} · ${detail.basis}${row.event.capped ? ` · capped at ${capText}` : ""}`,
        href: row.explorerUrl ?? undefined,
      },
    ];
  });

  // ── the feed: the vault's own page, and the settlements the links found ─
  //
  // A DISPLAY UNION, NOT A MERGED STORE. The two streams stay in their own
  // stores (live-backfill.test.ts); this only draws them in one column, which
  // is what puts the settlements — the green rows — back in it. The vault's
  // copy of a transaction wins, as mergeStreams decides in live-model.ts.
  const onVaultPage = new Set(data.rows.map((row) => row.signature));
  const union = [...data.rows, ...data.settlementRows.filter((row) => !onVaultPage.has(row.signature))];
  const timed = union.filter((row) => row.blockTime !== null).sort((left, right) => right.blockTime! - left.blockTime!);
  const untimed = union.filter((row) => row.blockTime === null);
  // How many buys each transaction holds: a unit price is only honest when there is one.
  const investsIn = new Map<string, number>();
  for (const row of union) if (row.event.kind === "invested") investsIn.set(row.signature, (investsIn.get(row.signature) ?? 0) + 1);

  const activity: ActivityEvent[] = [...timed, ...untimed].map((row, index) => {
    const base = { id: `${row.signature}:${index}`, at: row.at, txHash: row.signature, href: row.explorerUrl ?? undefined };
    const event = row.event;

    if (event.kind === "settled") {
      const detail = savedDetail(row)!;
      const words = partsOf(event, labelOf, vault.maxContribution);
      return {
        ...base,
        kind: "saved" as const,
        from: labelOf(event.wallet),
        // "Settled from …, nothing to save" when nothing moved: the words the live feed has always used.
        title: detail.paid > 0n ? undefined : words.title,
        basis: detail.basis,
        savedUsd: $(detail.paid),
        note: words.note ?? undefined,
        logo: SOL_LOGO,
      };
    }

    if (event.kind === "invested") {
      const spent = dollarsOf(rawFrom(event.usdcSpentRaw));
      const quantity = event.receivedUi === null ? null : Number(event.receivedUi);
      // The USDC this transaction spent is the WHOLE transaction's, so a price
      // per share is only true when it bought one thing. The keeper sends one
      // invest per transaction today — which is the keeper, not the data.
      const price = spent !== null && quantity !== null && quantity > 0 && investsIn.get(row.signature) === 1 ? spent / quantity : null;
      const words = partsOf(event, labelOf, vault.maxContribution);
      return {
        ...base,
        kind: "invested" as const,
        symbol: words.title.replace(/^Invested in /, ""),
        logo: artForMint(event.mint) ?? undefined,
        shares: quantity ?? 0,
        sharesText: event.receivedUi ?? undefined,
        priceUsd: price,
        amountUsd: spent,
      };
    }

    const words = partsOf(event, labelOf, vault.maxContribution);
    const lamports = "lamports" in event ? rawFrom(event.lamports) : null;
    const dollars = $(lamports);
    // SOL that moved, in today's dollars like every other amount in the
    // column; the sign says which way. Anything else keeps the live row's
    // own figure — a token amount, or dollars already.
    const amount =
      lamports === null
        ? words.amount
        : dollars === null
          ? words.amount
          : event.kind === "withdrew_sol"
            ? `−${usd(dollars)}`
            : event.kind === "received_sol"
              ? `+${usd(dollars)}`
              : usd(dollars);
    return {
      ...base,
      kind: "other" as const,
      title: words.title,
      sub: words.detail,
      amount,
      icon: ICONS[event.kind] ?? "other",
      logo: event.kind === "withdrew_token" ? (artForMint(event.mint) ?? undefined) : undefined,
      failed: words.failed || undefined,
    };
  });

  return {
    now,
    wallet,
    rule: {
      mode: vault.mode === 1 ? "volume" : "profit",
      rateBps: vault.rateBps ?? 0,
      thresholdUsd,
      targets: policy.legs.map((leg) => ({ symbol: leg.symbol, logo: artForMint(leg.mint) ?? undefined, weightBps: leg.weightBps })),
      paused: vault.paused === true,
    },
    stats: statsOut,
    curve,
    days,
    holdings,
    trades,
    activity,
    ...(unit === undefined ? {} : { unit }),
  };
}
