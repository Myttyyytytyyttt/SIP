// The chain's answer turned into a screen: what each number on the live
// dashboard is, and what it becomes when the chain did not say.

import { SPYX_MINT, USDC_MINT, WSOL_MINT, base58Encode } from "@sip/solana-core/client";
import { describe, expect, it } from "vitest";

import { headCursor } from "@/lib/live-activity-store";
import { toLiveDashboard } from "@/lib/live-model";
import type { LiveActivityJson, LiveEntryJson, LiveSnapshotJson, VaultEventJson } from "@/lib/live-types";

const OWNER = "PensionKeyP1aceho1der111111111111111111111";
const VAULT = "VaultP1aceho1der11111111111111111111111111";
const WALLET_A = "TradingZeroP1aceho1der11111111111111111111";
const WALLET_B = "TradingOneP1aceho1der111111111111111111111";

const NOW_MS = Date.UTC(2026, 8, 16, 12, 0, 0);
const seconds = (ms: number): number => Math.floor(ms / 1_000);

/** A real base58 64-byte signature: solscanTx refuses to build a link from anything else. */
const signature = (seed: number): string => base58Encode(Uint8Array.from({ length: 64 }, (_, index) => ((index + seed) % 255) + 1));

/** The mainnet goldens: $100.038711 a SOL, and $761.709474 per 100,000,000 SPYx raw units. */
const USDC_PER_SOL = "100038711";
const SPYX_PER_1E8 = "761709474";

const PRICES: LiveSnapshotJson["prices"] = {
  slot: 4_242,
  convertWad: "100038711555492562",
  usdcRawPerSol: USDC_PER_SOL,
  legs: [{ symbol: "SPYx", mint: SPYX_MINT, wad: "131283650130637569", usdcRawPer1e8: SPYX_PER_1E8 }],
};

const tokenAccount = (mint: string, amountRaw: string, uiAmount: string, decimals: number) => ({
  mint,
  address: `${mint}-ata`,
  tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  status: "exists" as const,
  amountRaw,
  decimals,
  uiAmount,
});

function snapshot(overrides: Partial<LiveSnapshotJson> = {}): LiveSnapshotJson {
  return {
    owner: OWNER,
    programId: "6kA9H9zQT6PW5xWkXoAFCS3NotxarzaYqj66mjMf9w4J",
    slot: 4_242,
    readAtMs: NOW_MS,
    vault: {
      status: "exists",
      address: VAULT,
      lamports: "201285240",
      rentFloor: "1285240",
      withdrawableLamports: "200000000",
      state: {
        owner: OWNER,
        paused: false,
        skimMode: 0,
        skimBps: 2_000,
        volumeBps: 200,
        lifetimeSaved: "60000000",
        createdAt: "1789495565",
        maxContribution: "60000000",
        walletReserve: "50000000",
        policyNonce: "1",
      },
    },
    policy: { status: "missing", address: `${VAULT}-policy` },
    config: { address: "config", status: "exists", exists: true, paused: false },
    prices: PRICES,
    vaultTokenAccounts: {
      status: "exists",
      items: [
        tokenAccount(WSOL_MINT, "10000000", "0.01", 9),
        tokenAccount(USDC_MINT, "5000000", "5", 6),
        // A scaledUiAmount mint: 11,345,678 raw units DISPLAY as 0.1241643,
        // which is not amountRaw / 10^decimals.
        tokenAccount(SPYX_MINT, "11345678", "0.1241643", 8),
      ],
    },
    rents: { vault: "1285240", walletFloor: "890880" },
    wallets: [
      { wallet: WALLET_A, lamports: "420000000", link: { address: `${WALLET_A}-link`, status: "this_vault", vault: VAULT, epoch: "12", settlementNonce: "3", frontierSlot: "999" } },
    ],
    links: null,
    ...overrides,
  };
}

const settledEvent = (paid: string, capped = false): VaultEventJson =>
  ({
    kind: "settled",
    wallet: WALLET_A,
    mode: 0,
    baseLamports: "500000000",
    bps: 2_000,
    owed: paid,
    paid,
    capped,
    settlementNonce: "0",
    linkEpoch: "12",
    sessionStartSlot: "200",
    sessionEndSlot: "220",
  }) as VaultEventJson;

const entry = (signature: string, blockTime: number, events: readonly VaultEventJson[], slot = 4_000): LiveEntryJson => ({
  signature,
  slot,
  blockTime,
  ok: true,
  fee: "5000",
  events,
});

function activity(entries: readonly LiveEntryJson[], overrides: Partial<LiveActivityJson> = {}): LiveActivityJson {
  return { vault: VAULT, status: "exists", nextBefore: null, entries, gap: false, ...overrides };
}

const model = (snap: LiveSnapshotJson = snapshot(), act: LiveActivityJson | null = null, privyWallets: readonly string[] = [WALLET_A]) =>
  toLiveDashboard({ snapshot: snap, activity: act, privyWallets });

const holdingFor = (symbol: string) => model().holdings.find((row) => row.symbol === symbol);

describe("what a holding is worth", () => {
  it("SPYx is valued from its RAW units, never from the display amount a scaled mint can move", () => {
    const spyx = holdingFor("SPYx")!;
    // 11,345,678 × 761,709,474 / 1e8, in integer arithmetic.
    expect(spyx.valueUsdcRaw).toBe(86_421_104n);
    expect(spyx.amountRaw).toBe(11_345_678n);
    // The shares shown are the RPC's own string, not recomputed.
    expect(spyx.uiAmount).toBe("0.1241643");

    // The tempting wrong answer — uiAmount × price — is a different number, and
    // it is what the issuer's multiplier would drift.
    const naive = BigInt(Math.round(0.1241643 * Number(SPYX_PER_1E8)));
    expect(spyx.valueUsdcRaw).not.toBe(naive);
    expect(Number(naive - 86_421_104n)).toBeGreaterThan(1_000_000);
  });

  it("wSOL is priced as the SOL it is, and USDC is counted at a dollar", () => {
    expect(holdingFor("wSOL")!.valueUsdcRaw).toBe(1_000_387n);
    const usdc = holdingFor("USDC")!;
    expect(usdc.valueUsdcRaw).toBe(usdc.amountRaw);
    expect(usdc.valueUsdcRaw).toBe(5_000_000n);
  });

  it("the SOL row is what a withdrawal could take, with the rent Solana keeps noted beside it", () => {
    const sol = holdingFor("SOL")!;
    expect(sol.amountRaw).toBe(200_000_000n);
    expect(sol.rentFloor).toBe(1_285_240n);
    expect(sol.valueUsdcRaw).toBe(20_007_742n);
  });

  it("adds up to what it holds now, and what is not invested yet", () => {
    const view = model();
    expect(view.worthNowUsdcRaw).toBe(20_007_742n + 1_000_387n + 5_000_000n + 86_421_104n);
    expect(view.notInvestedUsdcRaw).toBe(20_007_742n + 1_000_387n + 5_000_000n);
  });

  it("prices that could not be read hide every dollar rather than showing $0", () => {
    const view = model(snapshot({ prices: null }));
    expect(view.worthNowUsdcRaw).toBeNull();
    expect(view.notInvestedUsdcRaw).toBeNull();
    for (const row of view.holdings) expect(row.valueUsdcRaw).toBeNull();
    // The amounts themselves are still known, and still shown.
    expect(view.holdings.find((row) => row.symbol === "SPYx")!.amountRaw).toBe(11_345_678n);
  });

  it("a token the vault holds none of is not a row", () => {
    const view = model(
      snapshot({
        vaultTokenAccounts: { status: "exists", items: [tokenAccount(WSOL_MINT, "0", "0", 9), tokenAccount(USDC_MINT, "5000000", "5", 6), tokenAccount(SPYX_MINT, "0", "0", 8)] },
      }),
    );
    expect(view.holdings.map((row) => row.symbol)).toEqual(["SOL", "USDC"]);
  });

  it("tokens that could not be read are said to be unreadable, and SOL still shows", () => {
    const view = model(snapshot({ vaultTokenAccounts: { status: "unreadable", items: [] } }));
    expect(view.tokensReadable).toBe(false);
    expect(view.holdings.map((row) => row.symbol)).toEqual(["SOL"]);
  });
});

describe("which stage this pension is at", () => {
  const stageOf = (snap: LiveSnapshotJson, act: LiveActivityJson | null = null, wallets: readonly string[] = [WALLET_A]) => model(snap, act, wallets).stage;

  it("a vault that could not be READ is never reported as one that does not exist", () => {
    const unreadable = snapshot({ vault: { status: "unreadable", address: VAULT } });
    expect(stageOf(unreadable)).toBe("vault_unreadable");
    expect(stageOf(unreadable)).not.toBe("no_vault");
  });

  it("a vault that simply is not there yet is no_vault — not unreadable", () => {
    const missing = snapshot({ vault: { status: "missing", address: VAULT } });
    expect(stageOf(missing)).toBe("no_vault");
  });

  it("walks through no trading wallet, not linked, waiting, then active", () => {
    const fresh = snapshot({ vault: { ...snapshot().vault, state: { ...snapshot().vault.state!, lifetimeSaved: "0" } } });
    expect(stageOf(fresh, null, [])).toBe("no_trading_wallet");

    const unlinked = snapshot({
      ...fresh,
      wallets: [{ wallet: WALLET_A, lamports: "420000000", link: { address: `${WALLET_A}-link`, status: "missing", vault: null, epoch: null, settlementNonce: null, frontierSlot: null } }],
    });
    expect(stageOf(unlinked)).toBe("not_linked");

    const linkedNoSettlement = snapshot({
      ...fresh,
      wallets: [{ wallet: WALLET_A, lamports: "420000000", link: { address: `${WALLET_A}-link`, status: "this_vault", vault: VAULT, epoch: "12", settlementNonce: "0", frontierSlot: "0" } }],
    });
    expect(stageOf(linkedNoSettlement)).toBe("waiting_first_settlement");

    // Anything actually saved makes it active.
    expect(stageOf(snapshot())).toBe("active");
  });
});

describe("the chart is worked backwards from the vault's own total", () => {
  const T1 = seconds(NOW_MS - 3 * 3_600_000);
  const T2 = seconds(NOW_MS - 1 * 3_600_000);

  it("ends at lifetimeSaved, starts from a baseline before the oldest settlement, and steps by each payment", () => {
    // Newest first, as the route sends them.
    const history = activity([entry("sig2", T2, [settledEvent("40000000")]), entry("sig1", T1, [settledEvent("20000000")])]);
    const chart = model(snapshot(), history).chart!;

    expect(chart).not.toBeNull();
    expect(chart.map((point) => point.totalLamports)).toEqual([0n, 20_000_000n, 60_000_000n, 60_000_000n]);
    // The hero and the end of the curve are the same number, by construction.
    expect(chart[chart.length - 1]!.totalLamports).toBe(60_000_000n);
    expect(Date.parse(chart[0]!.at)).toBeLessThan(T1 * 1_000);
    expect(Date.parse(chart[chart.length - 1]!.at)).toBe(NOW_MS);
  });

  it("leaves out a settlement the snapshot's slot does not yet cover, so the curve cannot rise above the total", () => {
    const newer = activity([entry("sigNew", T2, [settledEvent("40000000")], 9_999), entry("sig1", T1, [settledEvent("20000000")])]);
    const view = model(snapshot(), newer);
    expect(view.stats.loadedSettlements).toBe(1);
    expect(view.chart!.map((point) => point.totalLamports)).toEqual([40_000_000n, 60_000_000n, 60_000_000n]);
  });

  it("draws NO chart when the loaded settlements exceed the vault's own total: a curve cannot start below zero", () => {
    // An RPC answer without context.slot leaves the snapshot's slot null, which
    // turns the coverage guard off — so 0.1 SOL of loaded settlements sit over
    // a lifetime total of 0.06 SOL, and the baseline would be −0.04 SOL.
    const history = activity([entry("sigNew", T2, [settledEvent("40000000")], 9_999), entry("sig1", T1, [settledEvent("60000000")])]);
    const view = model(snapshot({ slot: null }), history);
    expect(view.chart).toBeNull();
    // Nothing is hidden by that: both settlements are still counted and listed.
    expect(view.stats.loadedSettlements).toBe(2);
    expect(view.stats.loadedSavedLamports).toBe(100_000_000n);
    expect(view.rows).toHaveLength(2);
  });

  it("is null when there is no window to draw across: no rows loaded at all", () => {
    // The vault HAS saved here, so this is not "no settlement yet" — it is a
    // read that came back with nothing to be flat over. LiveSavedChart says
    // which, from stats.settledOutsideHistory, rather than claiming a first
    // settlement that already happened.
    expect(model(snapshot(), activity([])).chart).toBeNull();
    expect(model(snapshot(), null).chart).toBeNull();
    expect(model(snapshot(), activity([])).stats.settledOutsideHistory).toBe(true);
  });

  it("is FLAT across a window holding no settlement: the total only moves when one lands", () => {
    // The 2026-09-19 shape: fifteen signatures of keeper upkeep over a vault
    // whose own lifetimeSaved is 0.06 SOL. Drawing nothing there is what put
    // "The chart starts with your first settlement" over a settled pension.
    const upkeepOnly = activity([entry("sig2", T2, [{ kind: "upkeep" } as VaultEventJson]), entry("sig1", T1, [{ kind: "upkeep" } as VaultEventJson])]);
    const view = model(snapshot(), upkeepOnly);

    expect(view.stats.settledOutsideHistory).toBe(true);
    expect(view.stats.loadedSettlements).toBe(0);
    expect(view.chart!.map((point) => point.totalLamports)).toEqual([60_000_000n, 60_000_000n]);
    // From the oldest loaded row to the read's own clock, and no further.
    expect(Date.parse(view.chart![0]!.at)).toBe(T1 * 1_000);
    expect(Date.parse(view.chart![1]!.at)).toBe(NOW_MS);
  });

  it("really is null when nothing has ever settled: the honest branch is kept", () => {
    const fresh = snapshot({
      vault: { ...snapshot().vault, state: { ...snapshot().vault.state!, lifetimeSaved: "0" } },
      wallets: [{ wallet: WALLET_A, lamports: "420000000", link: { address: `${WALLET_A}-link`, status: "this_vault", vault: VAULT, epoch: "12", settlementNonce: "0", frontierSlot: "0" } }],
    });
    const upkeepOnly = activity([entry("sig1", T1, [{ kind: "upkeep" } as VaultEventJson])]);
    expect(model(fresh, upkeepOnly).chart).toBeNull();
    expect(model(fresh, upkeepOnly).stats.settledOutsideHistory).toBe(false);
  });
});

describe("stats only claim what the loaded history covers", () => {
  const recent = seconds(NOW_MS - 2 * 3_600_000);
  const old = seconds(NOW_MS - 30 * 86_400_000);

  it("counts every settlement the links record, not only the loaded ones", () => {
    const view = model(snapshot(), activity([entry("sig1", recent, [settledEvent("60000000", true)])]));
    expect(view.stats.settlementsLifetime).toBe(3n);
    expect(view.stats.loadedSettlements).toBe(1);
    expect(view.stats.cappedCount).toBe(1);
    expect(view.stats.biggestPaid).toBe(60_000_000n);
    expect(view.stats.loadedSavedLamports).toBe(60_000_000n);
  });

  it("a nonce nobody could read makes the lifetime count unknown, not smaller", () => {
    const unreadable = snapshot({
      wallets: [{ wallet: WALLET_A, lamports: "1", link: { address: "l", status: "this_vault", vault: VAULT, epoch: null, settlementNonce: null, frontierSlot: null } }],
    });
    expect(model(unreadable).stats.settlementsLifetime).toBeNull();
  });

  it("…and so does a link list the snapshot had to CUT: ten of twelve is not a lifetime", () => {
    const chainLink = (index: number) => ({
      wallet: `ChainLink${index}P1aceho1der111111111111111`,
      address: `link-${index}`,
      epoch: "1",
      settlementNonce: "5",
      frontierSlot: "0",
    });

    // Nine chain links plus WALLET_A is exactly the ten a snapshot carries: the
    // whole list is here, so its total is a real one — 3 + 9 × 5.
    const whole = model(snapshot({ links: { status: "exists", items: Array.from({ length: 9 }, (_, index) => chainLink(index)) } }), null, [WALLET_A]);
    expect(whole.wallets).toHaveLength(10);
    expect(whole.stats.settlementsLifetime).toBe(48n);

    // One wallet more than fits. The eleventh's settlements happened and cannot
    // be read here, so the count is unknown — NOT the 48 the survivors add to,
    // which would be a smaller number wearing a complete one's name.
    const cut = model(snapshot({ links: { status: "exists", items: Array.from({ length: 10 }, (_, index) => chainLink(index)) } }), null, [WALLET_A]);
    expect(cut.wallets).toHaveLength(10);
    expect(cut.stats.settlementsLifetime).toBeNull();
  });

  it("today and this week are NULL when the loaded page does not reach back that far", () => {
    const partial = activity([entry("sig1", recent, [settledEvent("60000000")])], { nextBefore: "moreP1aceho1der" });
    const stats = model(snapshot(), partial).stats;
    expect(stats.savedTodayLamports).toBeNull();
    expect(stats.savedThisWeekLamports).toBeNull();
  });

  it("…and a quiet POLL a minute later does not turn that partial history complete", () => {
    const partial = activity([entry("sig1", recent, [settledEvent("60000000")])], { nextBefore: "moreP1aceho1der" });

    // What the store holds after a poll that found nothing new: the same rows,
    // and the cursor the HEAD page defined — not the poll's own null.
    const afterPoll = activity(partial.entries, {
      nextBefore: headCursor({ polled: true, gap: false, page: null, held: partial.nextBefore }),
    });
    expect(afterPoll.nextBefore).toBe("moreP1aceho1der");

    // A minute after loading, the week must not have shrunk to one page of it.
    const stats = model(snapshot(), afterPoll).stats;
    expect(stats.savedTodayLamports).toBeNull();
    expect(stats.savedThisWeekLamports).toBeNull();
  });

  it("…and are real totals once the history is complete, or reaches past the window", () => {
    const complete = activity([entry("sig1", recent, [settledEvent("60000000")])]);
    const stats = model(snapshot(), complete).stats;
    expect(stats.savedTodayLamports).toBe(60_000_000n);
    expect(stats.savedThisWeekLamports).toBe(60_000_000n);

    // Not complete, but the oldest loaded settlement predates the window.
    const reachesBack = activity([entry("sig2", recent, [settledEvent("60000000")]), entry("sig1", old, [settledEvent("10000000")])], { nextBefore: "moreP1aceho1der" });
    expect(model(snapshot(), reachesBack).stats.savedThisWeekLamports).toBe(60_000_000n);
  });
});

describe("the rows a person sees", () => {
  const at = seconds(NOW_MS - 600_000);

  it("hides account upkeep and dust transfers, and counts them instead", () => {
    const history = activity([
      entry(signature(1), at, [settledEvent("60000000")]),
      entry(signature(2), at, [{ kind: "upkeep" } as VaultEventJson]),
      entry(signature(3), at, [{ kind: "received_sol", lamports: "5000" } as VaultEventJson]),
    ]);
    const view = model(snapshot(), history);
    expect(view.rows).toHaveLength(1);
    expect([view.hiddenUpkeep, view.hiddenDust]).toEqual([1, 1]);
  });

  it("keeps a real transfer, and links every row to Solscan", () => {
    const sig = signature(9);
    const history = activity([entry(sig, at, [{ kind: "received_sol", lamports: "5000000" } as VaultEventJson])]);
    const view = model(snapshot(), history);
    expect(view.rows).toHaveLength(1);
    expect(view.hiddenDust).toBe(0);
    expect(view.rows[0]!.explorerUrl).toBe(`https://solscan.io/tx/${sig}`);
    expect(view.rows[0]!.at).toBe(new Date(at * 1_000).toISOString());
  });

  it("builds NO link from something that is not a signature, rather than a URL that goes nowhere", () => {
    const history = activity([entry("not-a-signature", at, [{ kind: "received_sol", lamports: "5000000" } as VaultEventJson])]);
    expect(model(snapshot(), history).rows[0]!.explorerUrl).toBeNull();
  });
});

describe("trading wallets", () => {
  it("a wallet holding exactly the floor plus the reserve CANNOT settle: the program refuses that", () => {
    const floorPlusReserve = 890_880n + 50_000_000n;
    const withBalance = (lamports: bigint) =>
      model(
        snapshot({ wallets: [{ wallet: WALLET_A, lamports: lamports.toString(), link: { address: "l", status: "this_vault", vault: VAULT, epoch: "1", settlementNonce: "0", frontierSlot: "0" } }] }),
      ).wallets[0]!;
    expect(withBalance(floorPlusReserve).canSettle).toBe(false);
    expect(withBalance(floorPlusReserve + 1n).canSettle).toBe(true);
    expect(withBalance(floorPlusReserve - 1n).canSettle).toBe(false);
  });

  it("names Privy's wallets in HD order, and a link found on chain as one it did not create", () => {
    const chainWallet = "ChainOn1yP1aceho1der1111111111111111111111";
    const view = model(
      snapshot({ links: { status: "exists", items: [{ wallet: chainWallet, address: "chain-link", epoch: "5", settlementNonce: "2", frontierSlot: "9" }] } }),
      null,
      [WALLET_A, WALLET_B],
    );
    expect(view.wallets.map((wallet) => [wallet.label, wallet.source])).toEqual([
      ["Trading wallet 1", "privy"],
      ["Trading wallet 2", "privy"],
      ["Linked wallet", "chain"],
    ]);
    expect(view.wallets[2]!.settlementNonce).toBe(2n);
  });

  it("never lists more than the ten the snapshot can ask about", () => {
    const many = Array.from({ length: 12 }, (_, index) => ({
      wallet: `ChainLink${index}P1aceho1der111111111111111`,
      address: `link-${index}`,
      epoch: "1",
      settlementNonce: "0",
      frontierSlot: "0",
    }));
    const view = model(snapshot({ links: { status: "exists", items: many } }), null, [WALLET_A, WALLET_B]);
    expect(view.wallets).toHaveLength(10);
    expect(view.wallets.slice(0, 2).map((wallet) => wallet.source)).toEqual(["privy", "privy"]);
  });
});

describe("the vault's own rule", () => {
  it("reports the rate of the mode it actually measures", () => {
    expect(model().vault.rateBps).toBe(2_000);
    const volume = snapshot({ vault: { ...snapshot().vault, state: { ...snapshot().vault.state!, skimMode: 1 } } });
    const view = model(volume);
    expect(view.vault.rateBps).toBe(200);
    // A volume vault receives nothing while the keeper cannot measure volume, and says so.
    expect(view.vault.volumeNotOffered).toBe(true);
  });

  it("claims no protocol pause either way when the config could not be read", () => {
    expect(model().protocolPaused).toBe(false);
    expect(model(snapshot({ config: { address: "c", status: "unreadable", exists: false, paused: null } })).protocolPaused).toBeNull();
  });
});
