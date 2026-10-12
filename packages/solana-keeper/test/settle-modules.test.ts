// Which code settles a vault, chosen by the vault's own on-chain skim_mode
// (src/settle-modules.ts; ADR §3.2). The job-level proof — a worker's job hands
// each turn exactly its vault's byte and that module's measurement — is
// test/worker-job.test.ts's.

import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { tradeNotional } from "../src/measure-volume.js";
import { PolicyBoundaryBook } from "../src/policy-boundary.js";
import { KEEPER_MODES, MODE_PROFIT_BYTE, MODE_VOLUME_BYTE } from "../src/role-registry.js";
import { settleModuleFor } from "../src/settle-modules.js";
import { vaultOf } from "./settle-world.js";

const context = (mode: number) => ({
  link: {
    linkAddress: Keypair.generate().publicKey,
    wallet: Keypair.generate().publicKey,
    vault: Keypair.generate().publicKey,
    epoch: 1n,
    settlementNonce: 0n,
    frontierSlot: 0n,
  },
  vault: vaultOf(mode),
  programId: PublicKey.default,
  boundaries: new PolicyBoundaryBook(),
  ownerHistory: {
    signatures: async () => {
      throw new Error("not asked while the module is only chosen");
    },
    transaction: async () => null,
  },
  nowSeconds: () => 1_700_000_000,
});

describe("settleModuleFor: the vault's byte picks the module", () => {
  it("PROFIT: the balance-chain module, which adds nothing to the turn — the walk measures it, and its losses are carried", () => {
    const module = settleModuleFor(MODE_PROFIT_BYTE)!;
    expect(module.mode.byte).toBe(MODE_PROFIT_BYTE);
    expect(module.mode.base).toBe("balance-chain");
    expect(module.mode.carriesLosses).toBe(true);
    expect(module.turn(context(MODE_PROFIT_BYTE))).toEqual({});
  });

  it("VOLUME: the trade-notional module — the volume probe and a volume base at the vault's own rate — and no losses", () => {
    const module = settleModuleFor(MODE_VOLUME_BYTE)!;
    expect(module.mode.byte).toBe(MODE_VOLUME_BYTE);
    expect(module.mode.base).toBe("trade-notional");
    expect(module.mode.carriesLosses).toBe(false);
    const turn = module.turn(context(MODE_VOLUME_BYTE));
    expect(turn.volumeProbe).toBe(tradeNotional);
    expect(typeof turn.volumeBase).toBe("function");
  });

  it("a byte no sip-vault version defines has no module: the job then settles it as UNSUPPORTED_MODE", () => {
    for (const byte of [2, 3, 7, 255, -1, 0.5]) expect(settleModuleFor(byte)).toBeNull();
  });

  it("every mode the registry knows has a module — a new KeeperMode row cannot ship without one", () => {
    for (const mode of Object.values(KEEPER_MODES)) expect(settleModuleFor(mode.byte)?.mode).toBe(mode);
  });
});
