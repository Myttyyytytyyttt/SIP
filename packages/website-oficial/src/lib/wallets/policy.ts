/**
 * How a trading wallet's savings policy reaches the vault: the volume-mode
 * numbers, the EIP-712 shape of the acceptance the wallet signs, and the two
 * viem clients every write on the wallets page is made with.
 *
 * Constants ported from HEAD (fd927b0) src/components/InviteTradingWallet.tsx.
 * HEAD's profit-era presets (10–100 % of each win) are replaced by volume-mode
 * rates — basis points of every buy and sell — per WEB_WALLETS.md §0.6.
 */

import type { ConnectedWallet } from "@privy-io/react-auth";
import { createPublicClient, createWalletClient, custom, http, keccak256, stringToHex, type Address, type Chain } from "viem";

import { ROBINHOOD_CHAIN_ID, robinhoodChain } from "@/lib/chain";
import { UINT128_MAX, type PublicConfig } from "@/lib/config";

// ── the rate ────────────────────────────────────────────────────────────────

/** The three rates on offer, in basis points of notional: 0.1 % / 0.2 % / 0.5 %. */
export const RATE_PRESETS_BPS = [10, 20, 50] as const;
export type RatePresetBps = (typeof RATE_PRESETS_BPS)[number];
export const DEFAULT_RATE_BPS: RatePresetBps = 20;

export function isRatePreset(bps: number): bps is RatePresetBps {
  return (RATE_PRESETS_BPS as readonly number[]).includes(bps);
}

// ── the five numbers the saver never sees ───────────────────────────────────

/**
 * A minimum below which settling costs more gas than it saves; per-settlement
 * and 30-day ceilings set to the maximum the fields hold, because a low ceiling
 * is shared by every wallet in the vault and one wallet exhausting it blocks
 * the rest; and the cash the wallet keeps so it can carry on trading and pay gas.
 */
export const MIN_CONTRIBUTION_WEI = 1_000_000_000_000n; // 1e12 wei = 1e-6 ETH

/**
 * What the wallet keeps back, sized against MEASURED cost rather than guessed.
 *
 * A settle() is ~516k gas, and at the chain's ~0.03 gwei that is about
 * 0.0000163 ETH. The earlier 0.005 reserve was therefore three hundred
 * settlements of headroom — and, combined with a 0.01 floor, it made a wallet
 * holding less than 0.015 ETH permanently unsettleable. That is not a
 * conservative default, it is one that silently excludes every small wallet.
 *
 * 0.0005 is still ~30 settlements of gas. The floor is a product choice, not a
 * safety one: it is trading capital deliberately left alone, and the pension
 * key can retune both without re-inviting the wallet.
 */
export const TRADING_FLOOR_WEI = 1_000_000_000_000_000n; // 1e15 wei = 0.001 ETH kept for trading
export const GAS_RESERVE_WEI = 500_000_000_000_000n; // 5e14 wei = 0.0005 ETH ≈ 30 settlements

/** Every SIP invite is tagged with this platform id. */
export const PLATFORM_ID = keccak256(stringToHex("sip"));

/** The struct `inviteTradingAccount` and `setTradingAccountPolicy` take. */
export interface TradingAccountPolicy {
  readonly savingsBps: number;
  readonly minContributionWei: bigint;
  readonly maxPerSettlementWei: bigint;
  readonly maxRolling30dWei: bigint;
  readonly tradingFloorWei: bigint;
  readonly gasReserveWei: bigint;
}

/** The full policy for a rate: one question answered, the other five fixed. */
export function tradingPolicy(savingsBps: number): TradingAccountPolicy {
  return {
    savingsBps,
    minContributionWei: MIN_CONTRIBUTION_WEI,
    maxPerSettlementWei: UINT128_MAX,
    maxRolling30dWei: UINT128_MAX,
    tradingFloorWei: TRADING_FLOOR_WEI,
    gasReserveWei: GAS_RESERVE_WEI,
  };
}

/** How long an invite stays acceptable: a day, as HEAD set it. */
export const INVITE_TTL_SECONDS = 86_400;

// ── the acceptance the trading wallet signs (free) ──────────────────────────

/**
 * The typed data behind `acceptTradingAccountBySig`. The vault hashes the
 * nonce and epoch it HOLDS, so the message is always built from a fresh
 * `getTradingAccount` read, never from what the browser thinks it sent.
 */
export const ACCEPT_TYPES = {
  AcceptTradingAccount: [
    { name: "vaultId", type: "bytes32" },
    { name: "vault", type: "address" },
    { name: "tradingWallet", type: "address" },
    { name: "inviteNonce", type: "uint64" },
    { name: "adminEpoch", type: "uint64" },
    { name: "deadline", type: "uint48" },
  ],
} as const;

/** PersonalVault's EIP-712 domain: `__EIP712_init("Nuvem Personal Vault", "1")`. */
export function acceptDomain(vault: Address) {
  return {
    name: "Nuvem Personal Vault",
    version: "1",
    chainId: ROBINHOOD_CHAIN_ID,
    verifyingContract: vault,
  } as const;
}

/**
 * The one repair for a stuck PENDING invite. `_requireInvitable` refuses
 * PENDING outright, and the admin's `invalidateTradingAccountInvites` refuses
 * it too (it would strand the outstanding acceptance); only
 * `cancelTradingAccountInvitation` moves a PENDING account on — to REVOKED,
 * from which it can be invited again. Not in W1's §3 list, so the fragment
 * lives here beside the flow that needs it.
 */
export const cancelInviteAbi = [
  {
    type: "function",
    name: "cancelTradingAccountInvitation",
    inputs: [{ name: "account", type: "address" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

// ── the keeper's seat ───────────────────────────────────────────────────────

/**
 * How long to wait before each retry of the keeper's seat, in ms. Starts at a
 * second and ends near half a minute — long enough for Privy's own user
 * propagation, and slow enough that six attempts cannot themselves look like
 * abuse to a rate limiter.
 */
export const SEAT_BACKOFF_MS = [1_000, 2_000, 4_000, 6_000, 8_000, 10_000] as const;

/**
 * The signer entry a trading wallet is born with, or null when either id is
 * missing. NEVER an empty `policyIds` — Privy reads that as FULL permission
 * over the wallet, which is the one thing a signer must never have — so a
 * half-configured deployment gets no signer at all, and the caller says so.
 */
export function seatSigners(
  config: Pick<PublicConfig, "privySignerId" | "privyPolicyId">,
): readonly { readonly signerId: string; readonly policyIds: readonly [string] }[] | null {
  const signerId = config.privySignerId;
  const policyId = config.privyPolicyId;
  if (!signerId || !policyId) return null;
  return [{ signerId, policyIds: [policyId] }];
}

/** The sentence shown wherever the seat cannot be attached. */
export const SEAT_NOT_CONFIGURED =
  "The keeper's signer or policy id is not configured for this deployment (PRIVY_SIGNER_ID / PRIVY_POLICY_ID), " +
  "so no seat can be attached — an unconstrained signer would have full use of the wallet.";

// ── the clients ─────────────────────────────────────────────────────────────

/**
 * Reads and receipts from the browser go through the wallet-facing RPC — the
 * same-origin relay by default — never a privileged URL. The URL is taken
 * from the chain object, not from `walletRpcUrl` directly: the default value
 * is the RELATIVE `/api/rpc`, and `robinhoodChain` is what resolves it against
 * the page origin. Chain 4663 is absent from viem/chains.
 */
export function readClient(config: Pick<PublicConfig, "walletRpcUrl" | "explorerUrl">) {
  const chain = robinhoodChain(config.walletRpcUrl, config.explorerUrl);
  return createPublicClient({ chain, transport: http() });
}

/**
 * A viem wallet client over a Privy-connected wallet's EIP-1193 provider.
 *
 * The provider is requested AFTER the chain switch: Privy's own JSDoc on
 * `switchChain` says it does not update provider instances already handed out.
 * The cast crosses Privy's own `EIP1193Provider` interface to viem's and does
 * nothing else.
 */
export async function walletClientFor(wallet: ConnectedWallet, account: Address, chain: Chain) {
  const provider = await wallet.getEthereumProvider();
  return createWalletClient({
    account,
    chain,
    transport: custom(provider as Parameters<typeof custom>[0]),
  });
}

/** Seconds since the epoch — called inside handlers only, never during render. */
export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
