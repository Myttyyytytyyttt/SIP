// One copy of each module the keeper shares with its siblings.
//
// @sip/solana-program's scripts receive the keeper's Connection and PublicKeys
// and hand back TransactionInstructions the keeper adds to its own transactions.
// Two copies of @solana/web3.js would make that work by coincidence of shape —
// until the first instanceof. pnpm installs one copy per set of resolved peer
// dependencies, and ws@7's optional utf-8-validate peer resolved differently for
// the keeper (whose Privy graph carries utf-8-validate 6) than for the program:
// two directories, two copies, measured on 2026-09-13. The keeper pins
// utf-8-validate 5.0.10, inside ws@7's own peer range, and this test fails the
// day a lockfile change splits them again.

import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { SIP_PROGRAM_ID } from "../src/idl.js";
import { MODE_PROFIT, attestationInstruction, buildSwapV2Data } from "../src/program-scripts.js";

const keeper = createRequire(import.meta.url);
const program = createRequire(join(dirname(keeper.resolve("@sip/solana-program/package.json")), "package.json"));

describe("shared modules", () => {
  it("resolves the same @solana/web3.js and @coral-xyz/anchor as @sip/solana-program", () => {
    for (const name of ["@solana/web3.js", "@coral-xyz/anchor"]) {
      expect(realpathSync(keeper.resolve(name)), name).toBe(realpathSync(program.resolve(name)));
    }
  });

  it("takes the worker's logger from packages/worker/src/log.ts, not a copy", () => {
    expect(realpathSync(keeper.resolve("@sip/worker/log"))).toBe(
      realpathSync(fileURLToPath(new URL("../../worker/src/log.ts", import.meta.url))),
    );
  });

  it("gets working functions from the program's scripts, whose instructions are the keeper's class", () => {
    const signer = Keypair.generate();
    const instruction = attestationInstruction(signer.secretKey, {
      programId: new PublicKey(SIP_PROGRAM_ID),
      wallet: Keypair.generate().publicKey,
      vault: Keypair.generate().publicKey,
      linkEpoch: 1n,
      settlementNonce: 0n,
      sessionStartSlot: 1n,
      sessionEndSlot: 2n,
      baseLamports: 3n,
      mode: MODE_PROFIT,
      bps: 2_000,
      policyNonce: 0n,
      validUntilSlot: 152n,
    });
    expect(instruction).toBeInstanceOf(TransactionInstruction);
    expect(instruction.programId.toBase58()).toBe("Ed25519SigVerify111111111111111111111111111");
    expect(buildSwapV2Data({ payer: signer.publicKey, inputTokenAccount: signer.publicKey, outputTokenAccount: signer.publicKey, amountIn: 1n, minAmountOut: 1n }).length).toBe(41);
  });
});
