// Builds a REAL Raydium CLMM swap_v2 instruction — the venue route invest()
// forwards on mainnet.
//
// EVERY BYTE IS FROM A CAPTURED MAINNET SWAP, not from memory. The
// discriminator, the account order and the data layout were read off a real
// swap on the NVDAx/USDC pool (harness/raydium/captured-swap.json); this
// project has been bitten twice by transcribed selectors, so nothing here is
// transcribed. The discriminator is additionally recomputed from "global:swap_v2"
// and asserted equal to the captured one at module load.
//
// invest() treats this whole thing as opaque: it receives `data` and the
// account list as remaining_accounts, lends the vault PDA's signature, and
// measures the input and output deltas. So this builder's only job is to be
// byte-correct.

import { createHash } from "node:crypto";
// AccountMeta IS A TYPE, and must be imported as one. @solana/web3.js exports
// no runtime value by that name (it is absent from the 80-key namespace a real
// `node --input-type=module` import produces), so a value-position import of it
// survives only because esbuild/tsx erases bindings it can see are used only in
// type positions. The day anyone writes AccountMeta in a value position that
// erasure stops, the import becomes "does not provide an export named
// 'AccountMeta'", and because the keeper loads THIS FILE through
// @sip/solana-program/raydium-swap, the failure is the keeper not booting at
// all. One keyword removes the hazard.
import type { AccountMeta } from "@solana/web3.js";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";

const SWAP_V2 = createHash("sha256").update("global:swap_v2").digest().subarray(0, 8);
// The captured swap's discriminator, from harness/raydium/captured-swap.json.
if (SWAP_V2.toString("hex") !== "2b04ed0b1ac91e62") {
  throw new Error(`swap_v2 discriminator drifted: ${SWAP_V2.toString("hex")}`);
}

export const RAYDIUM_CLMM = new PublicKey("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK");
export const MEMO_PROGRAM = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022_PROGRAM = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

export interface SwapV2Pool {
  readonly ammConfig: PublicKey;
  readonly poolState: PublicKey;
  readonly inputVault: PublicKey;
  readonly outputVault: PublicKey;
  readonly observationState: PublicKey;
  readonly inputMint: PublicKey;
  readonly outputMint: PublicKey;
  readonly inputTokenProgram: PublicKey;
  readonly outputTokenProgram: PublicKey;
  /** Tick arrays (and the bitmap extension, if any), in on-chain order. */
  readonly tickArrays: readonly PublicKey[];
}

export interface SwapV2Args {
  readonly payer: PublicKey; // the vault PDA on the invest path
  readonly inputTokenAccount: PublicKey; // vault's in ATA
  readonly outputTokenAccount: PublicKey; // vault's out ATA
  readonly amountIn: bigint;
  readonly minAmountOut: bigint;
}

const u64le = (v: bigint): Buffer => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v);
  return b;
};

/**
 * The swap_v2 account order, verbatim from the captured mainnet swap:
 *   0 payer  1 ammConfig  2 poolState  3 inputTokenAccount  4 outputTokenAccount
 *   5 inputVault  6 outputVault  7 observationState  8 inputTokenProgram
 *   9 outputTokenProgram  10 memo  11 inputMint  12 outputMint  13.. tickArrays
 */
export function buildSwapV2AccountMetas(pool: SwapV2Pool, args: SwapV2Args): AccountMeta[] {
  return [
    { pubkey: args.payer, isSigner: true, isWritable: false },
    { pubkey: pool.ammConfig, isSigner: false, isWritable: false },
    { pubkey: pool.poolState, isSigner: false, isWritable: true },
    { pubkey: args.inputTokenAccount, isSigner: false, isWritable: true },
    { pubkey: args.outputTokenAccount, isSigner: false, isWritable: true },
    { pubkey: pool.inputVault, isSigner: false, isWritable: true },
    { pubkey: pool.outputVault, isSigner: false, isWritable: true },
    { pubkey: pool.observationState, isSigner: false, isWritable: true },
    // swap_v2 slots [8] and [9] are POSITIONAL, not per-mint: [8] must be the
    // classic SPL Token program and [9] the Token-2022 program, whatever the
    // mints are. A wSOL/USDC pool (both classic) still passes Token-2022 in
    // [9] — Raydium asserts the id even when no 2022 mint is involved.
    { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: TOKEN_2022_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: MEMO_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: pool.inputMint, isSigner: false, isWritable: false },
    { pubkey: pool.outputMint, isSigner: false, isWritable: false },
    ...pool.tickArrays.map((pubkey) => ({ pubkey, isSigner: false, isWritable: true })),
  ];
}

/**
 * The swap_v2 instruction data:
 *   disc(8) amount(u64) otherAmountThreshold(u64) sqrtPriceLimitX64(u128) isBaseInput(bool)
 * For an exact-input buy: amount = amountIn, threshold = minAmountOut,
 * sqrtPriceLimitX64 = 0 (no explicit limit — minAmountOut is the guard), and
 * isBaseInput = true. invest()'s own delta guard is the real floor regardless.
 */
export function buildSwapV2Data(args: SwapV2Args): Buffer {
  return Buffer.concat([
    SWAP_V2,
    u64le(args.amountIn),
    u64le(args.minAmountOut),
    Buffer.alloc(16), // sqrtPriceLimitX64 = 0
    Buffer.from([1]), // isBaseInput = true
  ]);
}

/** The standalone instruction, for a smoke test that calls Raydium directly. */
export function buildSwapV2Instruction(pool: SwapV2Pool, args: SwapV2Args): TransactionInstruction {
  return new TransactionInstruction({
    programId: RAYDIUM_CLMM,
    keys: buildSwapV2AccountMetas(pool, args),
    data: buildSwapV2Data(args),
  });
}
