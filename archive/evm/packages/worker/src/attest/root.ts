// The batch root: the one value a volume attestation commits to.
//
// Phase 0 carries it as `ledgerRoot`, which the deployed SettlementExecutor
// treats as an opaque bytes32. So the root makes the attester's claim AUDITABLE
// rather than enforced: anyone with a public RPC can rebuild the window's fills,
// recompute this value and compare it with what was signed. Phase 1 turns the
// same value into the replay key (`usedBatch[batchRoot]`, DESIGN.md §7).
//
//   batchRoot = keccak256(abi.encode("sip.volume.v1", chainId, wallet, bytes32[] txHashes))
//
// ORDER-INDEPENDENT, because the hashes are sorted before they are encoded. The
// ledger hands fills back oldest-first, a recomputation from eth_getLogs yields
// (block, logIndex) order, and a hand check might list them any way at all; all
// three must agree on the root or the audit is worthless.
//
// DOMAIN-SEPARATED by the tag, the chain and the wallet. The same fills seen on
// another chain, or attributed to another wallet, are a different claim and
// must never collide with this one.
//
// REFUSES RATHER THAN GUESSES. A fill of another wallet, a repeated tx hash or
// a malformed hash is not "skipped": each one is a window that would commit to
// volume nobody can attribute, which is the one unforgivable output (DESIGN.md
// §0.3-0.4). The caller gets an exception, not a root.

import { encodeAbiParameters, keccak256 } from "viem";
import type { Address, Fill, Hex } from "../types.js";

/** The tag under which SIP volume roots live. Changing it re-keys every window ever attested. */
export const BATCH_ROOT_DOMAIN = "sip.volume.v1";

const TX_HASH = /^0x[0-9a-f]{64}$/;

/**
 * The tx hashes a window commits to: lowercase, validated, deduplicated by
 * refusal, sorted. Exported so an auditor can list what went into a root.
 */
export function sortedFillHashes(wallet: Address, fills: readonly Fill[]): readonly Hex[] {
  const owner = wallet.toLowerCase();
  const seen = new Set<string>();
  const hashes: Hex[] = [];
  for (const fill of fills) {
    if (fill.wallet.toLowerCase() !== owner) {
      throw new Error(`batchRoot: fill ${fill.txHash} belongs to ${fill.wallet}, not to the window's wallet ${wallet}`);
    }
    const hash = fill.txHash.toLowerCase();
    if (!TX_HASH.test(hash)) {
      throw new Error(`batchRoot: fill has a malformed tx hash ${fill.txHash}`);
    }
    // One fill per transaction is a v1 invariant (a multi-fill tx is excluded,
    // never split), so a repeated hash is the same notional counted twice.
    if (seen.has(hash)) {
      throw new Error(`batchRoot: tx ${hash} appears twice in the window`);
    }
    seen.add(hash);
    hashes.push(hash as Hex);
  }
  // Fixed-width lowercase hex sorts lexicographically in numeric order.
  hashes.sort();
  return hashes;
}

/** keccak256(abi.encode("sip.volume.v1", chainId, wallet, sorted tx hashes)). Order-independent. */
export function batchRoot(chainId: number, wallet: Address, fills: readonly Fill[]): Hex {
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new Error(`batchRoot: chainId must be a positive integer, got ${chainId}`);
  }
  const hashes = sortedFillHashes(wallet, fills);
  return keccak256(
    encodeAbiParameters(
      [{ type: "string" }, { type: "uint256" }, { type: "address" }, { type: "bytes32[]" }],
      [BATCH_ROOT_DOMAIN, BigInt(chainId), wallet.toLowerCase() as Address, hashes],
    ),
  );
}
