// The rate the history mirror stores is the rate the settlement was CHARGED at.
//
// sip_solana.vault.skim_bps took the vault's skim_bps whatever its mode, so a
// VOLUME vault's row claimed the PROFIT rate — at the product's rates, 2000 bps
// for a vault actually charged 200, and at the demo's, 5000 against 100. The
// website reads that row, so it was showing a rate no VOLUME vault is ever
// charged.
//
// Two things are pinned here, because the defect lived in bin/keeper.mts and no
// unit test can call that file: the RULE, that one function answers "which rate
// does this settlement use?" for the attestation and for the mirror alike; and
// the CALL SITE, read from the source the way test/privy-client-sites.test.ts
// reads it.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import type { VaultState } from "../src/accounts.js";
import { SIP_PROGRAM_ID } from "../src/idl.js";
import { MODE_PROFIT, MODE_VOLUME } from "../src/program-scripts.js";
import { activeBps, attestationInputs } from "../src/settle-decision.js";

const PACKAGE = new URL("..", import.meta.url);
const source = (path: string): string => readFileSync(fileURLToPath(new URL(path, PACKAGE)), "utf8");

const programId = new PublicKey(SIP_PROGRAM_ID);
const link = {
  wallet: Keypair.generate().publicKey,
  vault: Keypair.generate().publicKey,
  epoch: 300_000_000n,
  settlementNonce: 7n,
  frontierSlot: 300_000_500n,
};
/** The product's rates: 20 % of profit, or 2 % of notional. */
const vault = (over: Partial<VaultState> = {}): VaultState => ({
  owner: Keypair.generate().publicKey,
  paused: false,
  skimMode: MODE_PROFIT,
  skimBps: 2_000,
  volumeBps: 200,
  policyNonce: 3n,
  maxContribution: 1_000_000_000n,
  walletReserve: 0n,
  ...over,
});
const span = { from: link.frontierSlot, endSlot: 300_000_900n, baseLamports: 50_000_000n, currentSlot: 300_001_000n };

describe("the rate a settlement is mirrored at", () => {
  it("is the rate the attestation was built with, in both modes", () => {
    for (const skimMode of [MODE_PROFIT, MODE_VOLUME]) {
      const state = vault({ skimMode });
      const attested = attestationInputs({ programId, link, vault: state, ...span }).bps;
      expect(activeBps(state), `mode ${skimMode}`).toBe(attested);
    }
  });

  it("is a VOLUME vault's VOLUME rate, never the profit rate it is not charged", () => {
    const volume = vault({ skimMode: MODE_VOLUME });
    expect(activeBps(volume)).toBe(200);
    expect(activeBps(volume), "the defect: the row used to hold skim_bps").not.toBe(volume.skimBps);
    // The demo's rates make the gap loud: 5000 stored against 100 charged.
    expect(activeBps(vault({ skimMode: MODE_VOLUME, skimBps: 5_000, volumeBps: 100 }))).toBe(100);
    // A PROFIT vault is unchanged, which is why this went unnoticed.
    expect(activeBps(vault())).toBe(2_000);
  });
});

describe("where the mirror's rate comes from", () => {
  it("passes activeBps at the keeper's only recordLink call, and no longer skim_bps", () => {
    const calls = source("bin/keeper.mts")
      .split("\n")
      .filter((line) => line.includes("recordLink("));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("activeBps(vaultState)");
    expect(calls[0], "skim_bps is the PROFIT rate; a VOLUME vault is never charged it").not.toContain("skimBps");
  });

  it("takes the rate under a name that does not promise skim_bps", () => {
    expect(source("src/read-model.ts")).toMatch(/async recordLink\([^)]*rateBps: number[^)]*\)/);
  });
});
