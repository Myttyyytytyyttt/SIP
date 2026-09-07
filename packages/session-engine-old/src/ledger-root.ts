// Two encodings of the attestation's ledgerRoot.
//
// SettlementExecutor treats ledgerRoot as opaque bytes32: it folds it into
// deriveSessionId, stores it in the record, and emits it — but never checks its
// preimage. That makes it a free upgrade slot. Anything committed here becomes
// part of sessionId and part of the SettlementExecuted event, publicly auditable
// against the published session report, with no contract change and no redeploy.
//
// Be precise about what that buys: it is auditability, not enforcement. The
// contract still cannot verify any of it, and the attester remains the trusted
// data authority. What it does buy is that a false claim becomes attributable
// and checkable after the fact — and that we learn which fields are actually
// load-bearing before freezing them into the EIP-712 typehash, which costs a new
// executor and, because configureProtocol is one-shot, a new factory.

import { encodeAbiParameters, keccak256, parseAbiParameters, toHex } from "viem";

export type Hex32 = `0x${string}`;

/** Distinguishes an attester upgrade in the event log. */
export const LEDGER_SCHEMA_V2: Hex32 = keccak256(toHex("nuvem.ledger.v2"));

/**
 * Refusal reasons as a bitfield, so the *reasons* are committed and not merely
 * the verdict. Zero means attestable. Order is append-only: renumbering would
 * silently reinterpret every historical root.
 */
export const VERDICT_BITS = {
  NOT_RECONCILED: 1n << 0n,
  NOT_DELTA_FLAT: 1n << 1n,
  ZERO_BASIS_REALIZED: 1n << 2n,
  INCOMPLETE_SCAN: 1n << 3n,
  UNKNOWN_TRANSACTION: 1n << 4n,
  REPLAY_TOO_SHORT: 1n << 5n,
} as const;

export type VerdictReason = keyof typeof VERDICT_BITS;

export function verdictBits(reasons: readonly VerdictReason[]): bigint {
  return reasons.reduce((bits, reason) => bits | VERDICT_BITS[reason], 0n);
}

export interface PositionEntry {
  readonly token: string;
  readonly balanceStart: bigint;
  readonly balanceEnd: bigint;
}

/**
 * Commits the position state at both boundaries.
 *
 * Sorted by token address so the root is independent of discovery order — two
 * runs that find the same movements in a different sequence must agree, or the
 * root is not a fact about the session.
 */
export function positionsRoot(positions: readonly PositionEntry[]): Hex32 {
  const sorted = [...positions].sort((a, b) => (a.token.toLowerCase() < b.token.toLowerCase() ? -1 : 1));
  return keccak256(
    encodeAbiParameters(parseAbiParameters("(address token, uint256 balanceStart, uint256 balanceEnd)[]"), [
      sorted.map((p) => ({
        token: p.token as `0x${string}`,
        balanceStart: p.balanceStart,
        balanceEnd: p.balanceEnd,
      })),
    ]),
  );
}

/**
 * The encoding already accepted on mainnet, in settle tx 0xd342d117…cad186.
 * Kept so historical sessions stay reproducible and so the v2 rollout can be
 * verified against a known-good value rather than against itself.
 *
 * Note the block numbers here are L2 heights, not the L1 heights the attestation
 * carries in startBlock/endBlock.
 */
export function legacyLedgerRoot(
  startBlockL2: bigint,
  endBlockL2: bigint,
  cashStart: bigint,
  cashEnd: bigint,
): Hex32 {
  return keccak256(
    encodeAbiParameters(parseAbiParameters("uint256, uint256, uint256, uint256"), [
      startBlockL2,
      endBlockL2,
      cashStart,
      cashEnd,
    ]),
  );
}

export interface LedgerV2Input {
  readonly startBlockL2: bigint;
  readonly endBlockL2: bigint;
  readonly cashStart: bigint;
  readonly cashEnd: bigint;
  readonly externalDeposits: bigint;
  readonly externalWithdrawals: bigint;
  readonly positions: readonly PositionEntry[];
  readonly zeroBasisRealized: bigint;
  readonly reasons: readonly VerdictReason[];
  readonly replayStartBlockL2: bigint;
}

/**
 * v2 adds everything the session engine found the schema was missing:
 *
 *   positionsRoot        - the position-delta-zero claim, which nothing in the
 *                          current 24 fields encodes
 *   zeroBasisRealized    - guards airdrop-and-dump, which the cash delta cannot
 *                          distinguish from a genuine round trip
 *   verdictBits          - why the attester believed the window was sound
 *   replayStartBlockL2   - cost basis is only knowable if replay began early
 *                          enough; a short replay must be visible, not assumed
 *
 * The L2 heights stay here rather than moving to startBlock/endBlock because the
 * attestation's block fields must remain L1 — that is what the contract compares
 * against block.number. They also keep sessionId unique when the coarse L1 range
 * collapses two distinct sessions onto the same numbers.
 */
export function ledgerRootV2(input: LedgerV2Input): Hex32 {
  return keccak256(
    encodeAbiParameters(
      parseAbiParameters(
        "bytes32, uint256, uint256, uint256, uint256, uint256, uint256, bytes32, uint256, uint256, uint256",
      ),
      [
        LEDGER_SCHEMA_V2,
        input.startBlockL2,
        input.endBlockL2,
        input.cashStart,
        input.cashEnd,
        input.externalDeposits,
        input.externalWithdrawals,
        positionsRoot(input.positions),
        input.zeroBasisRealized,
        verdictBits(input.reasons),
        input.replayStartBlockL2,
      ],
    ),
  );
}
