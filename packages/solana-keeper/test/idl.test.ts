// The IDL the keeper decodes and builds with, pinned.
//
// packages/solana-program/idl/sip_vault.json is COMMITTED so an image never needs
// the Rust toolchain; the price is that it can go stale behind a program change.
// These tests close that gap without needing anchor: the exported file names
// sip-vault's id and the V2 settle, and — whenever an `anchor build` has produced
// target/idl — it is byte-identical to what the build produced.

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { IDL_PATH, OLD_NUVEM_PROGRAM_ID, SIP_PROGRAM_ID, accountDiscriminator, derivedDiscriminator } from "../src/idl.js";

const require = createRequire(import.meta.url);
const PROGRAM_DIR = dirname(require.resolve("@sip/solana-program/package.json"));
const EXPORTED = join(PROGRAM_DIR, "idl/sip_vault.json");
const TARGET = join(PROGRAM_DIR, "target/idl/sip_vault.json");

const exported = JSON.parse(readFileSync(EXPORTED, "utf8")) as {
  address: string;
  instructions: { name: string; accounts: { name: string }[] }[];
};

describe("the exported sip_vault IDL", () => {
  it("is the file the keeper loads", () => {
    expect(IDL_PATH).toBe(EXPORTED);
  });

  it("names the sip-vault program, and not Nuvem's", () => {
    expect(exported.address).toBe("6kA9H9zQT6PW5xWkXoAFCS3NotxarzaYqj66mjMf9w4J");
    expect(SIP_PROGRAM_ID).toBe(exported.address);
    expect(exported.address).not.toBe(OLD_NUVEM_PROGRAM_ID);
  });

  it("has settle_v2 and no V1 settle", () => {
    const names = exported.instructions.map((instruction) => instruction.name);
    expect(names).toContain("settle_v2");
    expect(names).not.toContain("settle");
    expect(names).not.toContain("create_vault");
    expect(names).not.toContain("set_policy");
  });

  it("gives wrap_sol the investment policy account the invest tick passes by name", () => {
    // invest-tick.ts hands `policy` to wrap_sol through accountsPartial, which
    // would not notice an IDL that lacked it; this does.
    const wrapSol = exported.instructions.find((instruction) => instruction.name === "wrap_sol");
    expect(wrapSol?.accounts.map((account) => account.name)).toEqual([
      "crank",
      "config",
      "vault",
      "policy",
      "vault_wsol",
      "token_program",
      "system_program",
    ]);
  });

  it("records the TradingLink discriminator Anchor derives, which discovery filters on", () => {
    expect(accountDiscriminator("TradingLink").equals(derivedDiscriminator("TradingLink"))).toBe(true);
  });

  it("is byte-identical to packages/solana-program/target/idl/sip_vault.json when a build exists", (ctx) => {
    if (!existsSync(TARGET)) {
      ctx.skip(
        "packages/solana-program/target/idl/sip_vault.json is absent (no anchor build in this checkout), so there is nothing to compare against",
      );
    }
    expect(Buffer.compare(readFileSync(EXPORTED), readFileSync(TARGET)), "run `anchor build && pnpm idl:export` in packages/solana-program").toBe(0);
  });
});
