// A live dashboard built the way the real one is: a snapshot and a page of
// history, put through the REAL toLiveDashboard. Nothing here hand-writes a view
// model, so a component test cannot pass against a shape the model never
// produces.
//
// The figures are the mainnet goldens live-model.test.ts uses: $100.038711 a
// SOL, and $761.709474 per 100,000,000 SPYx raw units. SPYx's display amount is
// deliberately NOT amountRaw / 10^decimals — it is a scaledUiAmount mint, and
// that difference is what the value rule exists for.

import { SPYX_MINT, USDC_MINT, WSOL_MINT, base58Encode } from "@sip/solana-core/client";

import { toLiveDashboard } from "@/lib/live-model";
import type { LiveActivityJson, LiveDashboard, LiveEntryJson, LiveSnapshotJson, VaultEventJson } from "@/lib/live-types";
import type { InvestmentPolicyJson } from "@/lib/vault-api";

export const OWNER = "PensionKeyP1aceho1der111111111111111111111";
export const VAULT = "VaultP1aceho1der11111111111111111111111111";
export const WALLET_A = "TradingZeroP1aceho1der11111111111111111111";

export const NOW_MS = Date.UTC(2026, 8, 16, 12, 0, 0);
export const seconds = (ms: number): number => Math.floor(ms / 1_000);

/** A real base58 64-byte signature: solscanTx refuses to build a link from anything else. */
export const signature = (seed: number): string => base58Encode(Uint8Array.from({ length: 64 }, (_, index) => ((index + seed) % 255) + 1));

const USDC_PER_SOL = "100038711";
const SPYX_PER_1E8 = "761709474";

export const PRICES: LiveSnapshotJson["prices"] = {
  slot: 4_242,
  convertWad: "100038711555492562",
  usdcRawPerSol: USDC_PER_SOL,
  legs: [{ symbol: "SPYx", mint: SPYX_MINT, wad: "131283650130637569", usdcRawPer1e8: SPYX_PER_1E8 }],
};

export const tokenAccount = (mint: string, amountRaw: string, uiAmount: string, decimals: number) => ({
  mint,
  address: `${mint}-ata`,
  tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  status: "exists" as const,
  amountRaw,
  decimals,
  uiAmount,
});

/** A signed policy whose floors are BELOW today's rates, so buying is not waiting. */
export function policyState(overrides: Partial<InvestmentPolicyJson> = {}): InvestmentPolicyJson {
  return {
    vault: VAULT,
    enabled: true,
    venueProgram: "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
    inMint: USDC_MINT,
    legs: [{ mint: SPYX_MINT, weightBps: 10_000, minOutRateWad: "124000000000000000" }],
    minConvertRateWad: "90000000000000000",
    minInvestment: "5000000",
    maxPerCall: "1000000000",
    maxRolling30d: "31000000000",
    bucketDays: Array.from({ length: 31 }, () => 0),
    bucketAmounts: Array.from({ length: 31 }, () => "0"),
    lifetimeInvested: "0",
    policyNonce: "1",
    ...overrides,
  };
}

export function liveSnapshot(overrides: Partial<LiveSnapshotJson> = {}): LiveSnapshotJson {
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
    policy: { status: "exists", address: `${VAULT}-policy`, state: policyState() },
    config: { address: "config", status: "exists", exists: true, paused: false },
    prices: PRICES,
    vaultTokenAccounts: {
      status: "exists",
      items: [
        tokenAccount(WSOL_MINT, "10000000", "0.01", 9),
        tokenAccount(USDC_MINT, "5000000", "5", 6),
        // 11,345,678 raw units DISPLAY as 0.1241643, which is not amountRaw / 1e8.
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

export const settledEvent = (paid: string, capped = false, owed = paid): VaultEventJson =>
  ({
    kind: "settled",
    wallet: WALLET_A,
    mode: 0,
    baseLamports: "500000000",
    bps: 2_000,
    owed,
    paid,
    capped,
    settlementNonce: "0",
    linkEpoch: "12",
    sessionStartSlot: "200",
    sessionEndSlot: "220",
  }) as VaultEventJson;

export const liveEntry = (sig: string, blockTime: number, events: readonly VaultEventJson[], slot = 4_000): LiveEntryJson => ({
  signature: sig,
  slot,
  blockTime,
  ok: true,
  fee: "5000",
  events,
});

export function liveActivity(entries: readonly LiveEntryJson[], overrides: Partial<LiveActivityJson> = {}): LiveActivityJson {
  return { vault: VAULT, status: "exists", nextBefore: null, entries, gap: false, ...overrides };
}

/** The default history: one capped settlement, an hour ago. */
export const DEFAULT_ENTRIES: readonly LiveEntryJson[] = [liveEntry(signature(1), seconds(NOW_MS - 3_600_000), [settledEvent("60000000", true, "100000000")])];

/** The whole screen, through the real model. */
export function liveDashboard(
  input: { snapshot?: LiveSnapshotJson; activity?: LiveActivityJson | null; privyWallets?: readonly string[] } = {},
): LiveDashboard {
  return toLiveDashboard({
    snapshot: input.snapshot ?? liveSnapshot(),
    activity: input.activity === undefined ? liveActivity(DEFAULT_ENTRIES) : input.activity,
    privyWallets: input.privyWallets ?? [WALLET_A],
  });
}
