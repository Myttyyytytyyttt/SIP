// Every instruction the keeper SENDS is built by one exported function — and
// the real-process gate runs that function, not a copy of it.
//
// WHY THIS FILE EXISTS. On 2026-09-18 the keeper threw "anchor.BN is not a
// constructor" on the owner's first profitable trade: anchor is CommonJS, Node's
// ESM lexer does not carry its `BN` across, and vitest's interop does — so the
// settle path's ~25 tests all passed against a builder production could not run.
// The gate that CAN see that class of bug is `tsx bin/keeper.mts --preflight`,
// a real Node process the Dockerfile runs at image build time.
//
// It only sees it where it runs REAL CODE. The preflight built settle_v2
// through settle-tick's own settleInstruction, but built wrap_sol, convert and
// invest through three copies written inside preflight.ts, because the
// originals were inline inside investTurn around their own .rpc()/.instruction()
// send. Measured before this was fixed: putting the broken spelling back at all
// three invest sites left tsc at exit 0 and the preflight at
// {"preflight":"ok","invariants":14} — the identical outage, one file over,
// with the whole automatic gate green. Written as `const { BN: NumberBN } =
// anchor` it also passed the full vitest suite, so the grep in
// anchor-interop.test.ts is not a substitute for running the code.
//
// So what is held here is the SHAPE that keeps the gate honest: the money
// instructions are built in one place each, and the preflight imports those
// places. The bytes below are the second copy of the preflight's own vectors.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { idl, instructionDiscriminator } from "../src/idl.js";
import { convertCall, investCall, wrapSolCall } from "../src/invest-tick.js";

const here = fileURLToPath(new URL("..", import.meta.url));
const read = (rel: string): string => readFileSync(join(here, rel), "utf8");

/** A Program that can encode instructions and cannot reach a network. */
function offlineProgram(): anchor.Program {
  const refuse = async (): Promise<never> => {
    throw new Error("this test signs nothing");
  };
  const connection = new Connection("http://127.0.0.1:1", {
    fetch: () => {
      throw new Error("this test makes no RPC call");
    },
  });
  return new anchor.Program(
    idl as anchor.Idl,
    new anchor.AnchorProvider(connection, { publicKey: PublicKey.default, signTransaction: refuse, signAllTransactions: refuse }, { commitment: "confirmed" }),
  );
}

const zero = PublicKey.default;
const swap = { payer: zero, inputTokenAccount: zero, outputTokenAccount: zero, amountIn: 100n, minAmountOut: 200n };

describe("the money paths' instruction builders", () => {
  it("are looked up in exactly one module each, so there is nowhere for a copy to live", () => {
    // `method(program, "…")` is how every sip-vault instruction is reached. If
    // one of the four ever appears in a second file — preflight.ts above all —
    // then the gate can be proving a builder the keeper does not send.
    const sources = ["src/settle-tick.ts", "src/invest-tick.ts", "src/preflight.ts", "src/methods.ts", "bin/keeper.mts"];
    const lookups = new Map<string, string[]>();
    for (const rel of sources) {
      for (const match of read(rel).matchAll(/method\(\s*program\s*,\s*"([A-Za-z0-9_]+)"/g)) {
        const name = match[1];
        if (name === undefined) continue;
        lookups.set(name, [...(lookups.get(name) ?? []), rel]);
      }
    }
    expect(Object.fromEntries(lookups)).toEqual({
      settleV2: ["src/settle-tick.ts"],
      wrapSol: ["src/invest-tick.ts"],
      convert: ["src/invest-tick.ts"],
      invest: ["src/invest-tick.ts"],
    });
  });

  it("are what the preflight imports, so the real-process gate runs production's code", () => {
    const preflight = read("src/preflight.ts");
    expect(preflight).toMatch(/import \{ convertCall, investCall, wrapSolCall \} from "\.\/invest-tick\.js";/);
    expect(preflight).toMatch(/import \{ settleInstruction \} from "\.\/settle-tick\.js";/);
  });

  it("encode wrap_sol, convert and invest exactly as the preflight's vectors pin them", async () => {
    const program = offlineProgram();
    const wrapSol = await wrapSolCall(program, { crank: zero, vault: zero, policy: zero, vaultWsol: zero }, 100n).instruction();
    const convert = await convertCall(
      program,
      { crank: zero, vault: zero, policy: zero, vaultWsol: zero, vaultIn: zero },
      { amountIn: 100n, minOut: 200n, swap },
    ).instruction();
    const invest = await investCall(
      program,
      { crank: zero, vault: zero, policy: zero, vaultIn: zero, vaultTarget: zero, targetMint: zero },
      { legIndex: 0, amountIn: 100n, minOut: 200n, swap },
    ).instruction();

    // 100 and 200 as little-endian u64s, behind each discriminator; invest's
    // leg index is the single byte between them.
    expect(wrapSol.data.toString("hex")).toBe(`${instructionDiscriminator("wrap_sol").toString("hex")}6400000000000000`);
    expect(convert.data.subarray(0, 24).toString("hex")).toBe(
      `${instructionDiscriminator("convert").toString("hex")}6400000000000000c800000000000000`,
    );
    expect(invest.data.subarray(0, 25).toString("hex")).toBe(
      `${instructionDiscriminator("invest").toString("hex")}006400000000000000c800000000000000`,
    );
  });
});
