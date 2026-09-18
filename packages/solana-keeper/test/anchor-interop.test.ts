// The interop rules the keeper's money paths depend on, held in place.
//
// THIS FILE CANNOT REPRODUCE THE BUG IT GUARDS, and saying so is the point.
// Vitest's import interop merges a CommonJS module's default export onto its
// namespace, so under vitest `anchor.BN` is a function no matter what Node
// would do — which is exactly how ~25 settle tests passed while production
// threw "anchor.BN is not a constructor" on the owner's first profitable
// trade. The gate that CAN fail is `tsx bin/keeper.mts --preflight`, a real
// Node process, which the Dockerfile runs at image build time and which now
// builds all four money-path instructions.
//
// What this file holds is everything around that: that the keeper has exactly
// one source of BN, that BN is anchor's own class and not a second bn.js, and
// that the two module-system assumptions the fix rests on are still true.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { BN } from "../src/anchor-interop.js";
import { GOLDEN_V2_INPUTS } from "../src/attestation-golden.js";
import { idl } from "../src/idl.js";
import { settleInstruction } from "../src/settle-tick.js";

const here = fileURLToPath(new URL("..", import.meta.url));

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (path.endsWith(".ts") || path.endsWith(".mts")) out.push(path);
  }
  return out;
}

describe("anchor interop", () => {
  it("is the class anchor's own coder accepts: settle_v2's five args, byte for byte", async () => {
    const refuse = async (): Promise<never> => {
      throw new Error("this provider signs nothing");
    };
    const provider = new anchor.AnchorProvider(
      new Connection("http://127.0.0.1:1", {
        fetch: () => {
          throw new Error("this test makes no RPC call");
        },
      }),
      { publicKey: PublicKey.default, signTransaction: refuse, signAllTransactions: refuse },
      { commitment: "confirmed" },
    );
    const program = new anchor.Program(idl as anchor.Idl, provider);
    const zero = PublicKey.default;
    const instruction = await settleInstruction(program, { wallet: zero, vault: zero, linkAddress: zero }, GOLDEN_V2_INPUTS);
    // GOLDEN_V2_INPUTS' own numbers: mode 1, then 100, 200, 1_000_000_000 and
    // 300 as little-endian u64s, behind settle_v2's discriminator.
    expect(instruction.data.toString("hex")).toBe(
      "0529ee8ddb512791016400000000000000c80000000000000000ca9a3b000000002c01000000000000",
    );
    expect(instruction.data.length).toBe(41);
  });

  it("is the class anchor's own coder PRODUCES, so instanceof and encoding agree", async () => {
    const refuse = async (): Promise<never> => {
      throw new Error("this provider signs nothing");
    };
    const program = new anchor.Program(
      idl as anchor.Idl,
      new anchor.AnchorProvider(
        new Connection("http://127.0.0.1:1"),
        { publicKey: PublicKey.default, signTransaction: refuse, signAllTransactions: refuse },
        { commitment: "confirmed" },
      ),
    );
    const encoded = await program.coder.accounts.encode("tradingLink", {
      owner: PublicKey.default,
      vault: PublicKey.default,
      wallet: PublicKey.default,
      epoch: new BN("7"),
      frontierSlot: new BN("9"),
      settlementNonce: new BN("11"),
      bump: 0,
      active: true,
    });
    const decoded = program.coder.accounts.decode("tradingLink", encoded) as { settlementNonce: unknown };
    expect(decoded.settlementNonce).toBeInstanceOf(BN);
    expect(String(decoded.settlementNonce)).toBe("11");
  });

  it("is the keeper's ONLY source of BN: no src or bin file constructs one off the anchor namespace", () => {
    const offenders = [...sourceFiles(join(here, "src")), ...sourceFiles(join(here, "bin"))]
      // anchor-interop.ts is the one file allowed to name it — and only in its
      // own prose, explaining what not to write.
      .filter((path) => !path.endsWith("anchor-interop.ts"))
      .filter((path) => /new\s+anchor\.BN\s*\(/.test(readFileSync(path, "utf8")))
      .map((path) => path.slice(here.length));
    // `new anchor.BN(...)` is undefined under Node ESM in this package. Import
    // BN from src/anchor-interop.js instead, which resolves it through anchor
    // in a way that works under Node, tsx, vitest and CommonJS alike.
    expect(offenders).toEqual([]);
  });

  it("does not reach for a second bn.js, which would not be anchor's class", () => {
    // bn.js is NOT a dependency of this package: `require.resolve("bn.js")`
    // from it under plain node is MODULE_NOT_FOUND, so an `import BN from
    // "bn.js"` would typecheck here and then fail at IMPORT inside the Railway
    // image — trading one broken wallet for a keeper that will not boot. That
    // resolution is not asserted here because vitest resolves modules its own
    // way and would answer differently from the image; what is asserted is
    // that no keeper source reaches for it. Class identity is the second
    // reason, and the two cases above prove the right class positively.
    const keeperSource = [...sourceFiles(join(here, "src")), ...sourceFiles(join(here, "bin"))]
      .filter((path) => !path.endsWith("anchor-interop.ts"))
      .filter((path) => /from\s+["']bn\.js["']/.test(readFileSync(path, "utf8")))
      .map((path) => path.slice(here.length));
    expect(keeperSource).toEqual([]);
  });

  it("holds the two module-system facts the fix rests on", () => {
    // 1. THIS package is ESM. That is what makes Node's CommonJS lexer the
    //    thing standing between the keeper and anchor's BN.
    const keeperPkg = JSON.parse(readFileSync(join(here, "package.json"), "utf8")) as { type?: string };
    expect(keeperPkg.type).toBe("module");

    // 2. @sip/solana-program is CommonJS, and twelve of its scripts and tests
    //    say `new anchor.BN(...)` — correct there, and ONLY because of this.
    //    Adding "type": "module" to that package breaks all twelve at once,
    //    with the same TypeError that took the keeper down on 2026-09-18.
    //    program-scripts.ts's unwrap() also documents this asymmetry.
    const programPkgPath = join(here.replace(/solana-keeper\/?$/, ""), "solana-program", "package.json");
    const programPkg = JSON.parse(readFileSync(programPkgPath, "utf8")) as { type?: string };
    expect(programPkg.type).toBeUndefined();
  });
});
