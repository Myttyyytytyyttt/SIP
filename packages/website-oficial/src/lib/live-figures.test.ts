// THE FIGURES A SHARE CARD TAKES FROM A LIVE PENSION (owner, 10-22): one place
// for them, read by the Live page (through toDashboardMock) and by the share
// route (from a snapshot of its own) — so the two must give the same card — and
// the streak, which the browser claims and the server proves.

import type { ClassifiableEntry, SettledEvent } from "@sip/solana-core/client";
import { describe, expect, it } from "vitest";

import { DAY_MS, provenStreakOf, settledDayOf, shareInputOf, streakOfDays, streakProofOf, streaksOf } from "@/lib/live-figures";
import { toDashboardMock } from "@/lib/live-mock";
import { toLiveDashboard } from "@/lib/live-model";
import { SHARE_STREAK_CAP, shareCardOf, shareRows } from "@/lib/live-share";

import { DEFAULT_ENTRIES, NOW_MS, VAULT, liveActivity, liveDashboard, liveEntry, liveSnapshot, seconds, settledEvent, signature } from "../../test/fixtures/live-dashboard";

/** The card exactly as LiveBody builds it, from the page. */
const pageCard = (data = liveDashboard()) => {
  const page = toDashboardMock(data, { complete: false });
  return shareCardOf({ lifetimeSaved: data.vault.lifetimeSaved, stats: page.stats, rule: page.rule, now: page.now });
};

/** The card as the share route builds it: the snapshot alone, no history, no wallets. */
const routeCard = (snapshot = liveSnapshot(), streak: number | null = null) => shareCardOf(shareInputOf(toLiveDashboard({ snapshot, activity: null, privyWallets: [] }), streak));

describe("the server's card is the page's card", () => {
  it("on the fixture vault: the same dollars, SOL, rule, month, basket and day — the streak aside, which only history holds", () => {
    expect({ ...routeCard(), streakDays: null }).toEqual({ ...pageCard(), streakDays: null });
  });

  it("with no price, paused, a volume rule, nothing saved: still the same card", () => {
    const base = liveSnapshot();
    const variants = [
      liveSnapshot({ prices: null }),
      { ...base, vault: { ...base.vault, state: { ...base.vault.state!, paused: true, skimMode: 1 } } },
      { ...base, vault: { ...base.vault, state: { ...base.vault.state!, lifetimeSaved: "0" } } },
    ];
    for (const snapshot of variants) {
      expect({ ...routeCard(snapshot), streakDays: null }).toEqual({ ...pageCard(liveDashboard({ snapshot })), streakDays: null });
    }
  });

  it("a proven streak is the card's streak; none is no streak, never 0", () => {
    expect(routeCard(liveSnapshot(), 7).streakDays).toBe(7);
    expect(routeCard(liveSnapshot(), null).streakDays).toBeNull();
  });

  it("toDashboardMock reads its streak and month from the same functions", () => {
    const data = liveDashboard();
    const page = toDashboardMock(data, { complete: false });
    expect(page.stats.currentStreakDays).toBe(shareInputOf(data).stats.currentStreakDays);
    expect(page.stats.firstSaveAt).toBe(shareInputOf(data).stats.firstSaveAt);
    expect(page.stats.totalSavedUsd).toBe(shareInputOf(data).stats.totalSavedUsd);
  });
});

describe("the streaks, the sample's way", () => {
  const days = (...paid: number[]) => paid.map((lamports) => ({ lamports: BigInt(lamports) }));

  it("an empty today does not break the current run; an empty yesterday does", () => {
    expect(streaksOf(days(1, 1, 1, 0)).current).toBe(3);
    expect(streaksOf(days(1, 1, 0, 0)).current).toBe(0);
    expect(streaksOf(days(1, 0, 1, 1, 1)).current).toBe(3);
    expect(streaksOf(days(1, 1, 0, 1, 1, 1, 1)).longest).toBe(4);
  });
});

/** A history with a settlement on each of the last `count` days, today included. */
function streakHistory(count: number, extra: readonly ReturnType<typeof liveEntry>[] = []) {
  const today = Math.floor(NOW_MS / DAY_MS) * DAY_MS;
  const entries = Array.from({ length: count }, (_, index) => liveEntry(signature(100 + index), seconds(today - index * DAY_MS + 3_600_000), [settledEvent("1000000")]));
  // complete: the vault page reached its beginning, so every day since creation — 120 days ago — is whole.
  const base = liveSnapshot();
  const snapshot = { ...base, vault: { ...base.vault, state: { ...base.vault.state!, createdAt: String(seconds(NOW_MS - 120 * DAY_MS)) } } };
  return liveDashboard({ snapshot, activity: liveActivity([...entries, ...extra, ...DEFAULT_ENTRIES], { nextBefore: null }) });
}

describe("the streak's proof, as the browser gives it", () => {
  it("one settlement of each day of the run, newest first", () => {
    const data = streakHistory(5);
    expect(toDashboardMock(data, { complete: true }).stats.currentStreakDays).toBe(5);
    const proof = streakProofOf(data);
    expect(proof).toHaveLength(5);
    expect(new Set(proof).size).toBe(5);
    // Today's newest settlement — the fixture's own, an hour before now — then one for each day before.
    expect(proof[0]).toBe(signature(1));
    expect(proof.slice(1)).toEqual([101, 102, 103, 104].map(signature));
  });

  it("nothing when there is no streak to state — one day is not one", () => {
    expect(streakProofOf(streakHistory(1))).toEqual([]);
    expect(streakProofOf(liveDashboard({ activity: null }))).toEqual([]);
  });

  it(`at most ${SHARE_STREAK_CAP} days, and the card says "${SHARE_STREAK_CAP}+" of any longer run`, () => {
    const data = streakHistory(60);
    expect(streakProofOf(data)).toHaveLength(SHARE_STREAK_CAP);
    const card = pageCard(data);
    expect(card.streakDays).toBe(SHARE_STREAK_CAP);
    expect(shareRows(card).find((row) => row.label === "Streak")?.value).toBe(`${SHARE_STREAK_CAP}+ days in a row`);
  });
});

// ── the server's side: what a transaction it read itself proves ─────────────

const OTHER_VAULT = "OtherVau1tP1aceho1der1111111111111111111111";

/** A transaction as readVaultTransactions returns it: a settle_v2 into `vault`, paying `paid`, at `blockTime`. */
function settlement(vault: string, paid: bigint, blockTime: number, over: Partial<ClassifiableEntry> = {}): ClassifiableEntry {
  const event: SettledEvent = {
    vault,
    wallet: "TradingZeroP1aceho1der11111111111111111111",
    mode: 0,
    baseLamports: 500_000_000n,
    bps: 2_000,
    owed: paid,
    paid,
    settlementNonce: 0n,
    sessionEndSlot: 220n,
    linkEpoch: 12n,
    sessionStartSlot: 200n,
    policyNonce: 0n,
  };
  return {
    signature: signature(Number(blockTime % 200)),
    slot: 4_000,
    blockTime,
    ok: true,
    readable: true,
    instructions: [{ name: "settle_v2", args: null, accounts: { vault } }],
    vaultLamportsDelta: paid,
    vaultTokenDeltas: [],
    settled: [event],
    ...over,
  };
}

describe("the streak the chain proves", () => {
  const today = Math.floor(NOW_MS / DAY_MS) * DAY_MS;
  const at = (daysAgo: number): number => seconds(today - daysAgo * DAY_MS + 7_200_000);

  it("an honest claim: one paid settlement into this vault per day — the same number the page counted", () => {
    const entries = [0, 1, 2, 3].map((ago) => settlement(VAULT, 1_000_000n, at(ago)));
    expect(provenStreakOf(entries, VAULT, NOW_MS)).toBe(4);
    // Today not over yet: a run that ended yesterday still counts.
    expect(provenStreakOf([1, 2, 3].map((ago) => settlement(VAULT, 1_000_000n, at(ago))), VAULT, NOW_MS)).toBe(3);
  });

  it("proves nothing with somebody else's settlement, a failed one, an unreadable one, or one that paid nothing", () => {
    expect(settledDayOf(settlement(OTHER_VAULT, 1_000_000n, at(0)), VAULT)).toBeNull();
    expect(settledDayOf(settlement(VAULT, 1_000_000n, at(0), { ok: false }), VAULT)).toBeNull();
    expect(settledDayOf(settlement(VAULT, 1_000_000n, at(0), { readable: false }), VAULT)).toBeNull();
    expect(settledDayOf(settlement(VAULT, 0n, at(0)), VAULT)).toBeNull();
    expect(settledDayOf(settlement(VAULT, 1_000_000n, at(0), { instructions: [{ name: "wrap_sol", args: null, accounts: { vault: VAULT } }] }), VAULT)).toBeNull();
    expect(settledDayOf(settlement(VAULT, 1_000_000n, at(0)), VAULT)).toBe(today / DAY_MS);
  });

  it("an inflated claim proves less than it claims: two signatures of one day, or a gap", () => {
    expect(provenStreakOf([settlement(VAULT, 1n, at(0)), settlement(VAULT, 1n, at(0) + 60)], VAULT, NOW_MS)).toBe(1);
    expect(provenStreakOf([0, 1, 3].map((ago) => settlement(VAULT, 1n, at(ago))), VAULT, NOW_MS)).toBe(2);
  });

  it("counts against the server's today, and a day after it proves nothing", () => {
    expect(streakOfDays([today / DAY_MS + 1, today / DAY_MS], NOW_MS)).toBe(1);
    expect(streakOfDays([], NOW_MS)).toBe(0);
  });
});
