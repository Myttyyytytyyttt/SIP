// settle-tick.ts's fence seam (SettleDeps.fence): where a worker's settle meets
// the dispatcher's gate, over a real settle turn on one wallet's stub chain
// (test/settle-world.ts). A legacy keeper passes no fence, and its turns are the
// rest of test/settle-tick.test.ts, unchanged.

import * as anchor from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { idl } from "../src/idl.js";
import { MODE_PROFIT, MODE_VOLUME } from "../src/program-scripts.js";
import type { CarryBook } from "../src/settle-decision.js";
import { runSettleTick, type SettleFence, type SettleGateRequest, type SettleResult } from "../src/settle-tick.js";
import { SettleWorld, vaultOf } from "./settle-world.js";

interface Told {
  readonly requests: SettleGateRequest[];
  readonly signed: string[];
  readonly ended: [string, string][];
}

/** A fence that records what it is asked and told, and admits or refuses as told. */
function fence(answer: "admit" | "refuse" = "admit"): SettleFence & { readonly told: Told } {
  const told: Told = { requests: [], signed: [], ended: [] };
  return {
    told,
    async gate(request) {
      told.requests.push(request);
      if (answer === "refuse") return { kind: "refused", detail: "the dispatcher's fence refused this settle: lease gone" };
      return {
        kind: "gated",
        ticket: {
          signed: (signature) => void told.signed.push(signature),
          ended: (ended, outcome) => void told.ended.push([ended, outcome]),
        },
      };
    },
  };
}

function turn(world: SettleWorld, options: { readonly live: boolean; readonly fence?: SettleFence; readonly mode?: number; readonly carries?: CarryBook }) {
  const calls: string[] = [];
  const connection = world.connection(calls);
  const refuse = async (): Promise<never> => {
    throw new Error("no wallet here");
  };
  const program = new anchor.Program(idl, new anchor.AnchorProvider(connection, { publicKey: PublicKey.default, signTransaction: refuse, signAllTransactions: refuse }, { commitment: "confirmed" }));
  const carries = options.carries ?? new Map();
  const run = (): Promise<SettleResult> =>
    runSettleTick({
      connection,
      program,
      link: world.link,
      vault: vaultOf(options.mode ?? MODE_PROFIT),
      attester: options.live ? Keypair.generate() : null,
      walletSigner: options.live ? world.walletKey : null,
      live: options.live,
      protocolPaused: false,
      settles: [MODE_PROFIT, MODE_VOLUME],
      carries,
      ...(options.fence === undefined ? {} : { fence: options.fence }),
    });
  return { run, calls, carries };
}

describe("a live settle under the dispatcher's fence", () => {
  it("is gated where the carry used to be written — the carry goes INTO the gate, not into memory — and only then sent", async () => {
    const world = new SettleWorld();
    const prefixEnd = world.losingBacklog();
    const gate = fence();
    const { run, carries } = turn(world, { live: true, fence: gate });
    const result = await run();
    expect(result.outcome).toBe("SETTLED");
    expect(gate.told.requests).toHaveLength(1);
    const [request] = gate.told.requests;
    expect(request).toMatchObject({
      mode: MODE_PROFIT,
      endSlot: prefixEnd,
      carry: { lossLamports: 500_000_000n, walletSignedTxCount: 1 },
      live: true,
      amountLamports: 0n,
      lastValidBlockHeight: 1_000,
    });
    expect(request!.idempotencyKey).toMatch(/^[0-9a-f]{64}$/);
    expect(request!.link.linkAddress.equals(world.link.linkAddress)).toBe(true);
    // THE MEMORY BOOK IS NOT WRITTEN: the gate holds the carry now.
    expect(carries.size).toBe(0);
    expect(world.sent).toHaveLength(1);
    // TOLD AFTER THE FACT: the id once the send answered, then how it ended and what the turn reports.
    expect(gate.told.signed).toEqual(["settle-1"]);
    expect(gate.told.ended).toEqual([["landed", "SETTLED"]]);
  });

  it("sends NOTHING when the gate refuses: RETRY in the gate's own words, no carry anywhere, no signature asked for", async () => {
    const world = new SettleWorld();
    world.losingBacklog();
    const gate = fence("refuse");
    const { run, carries } = turn(world, { live: true, fence: gate });
    const result = await run();
    expect(result.outcome).toBe("RETRY");
    expect(result.detail).toContain("the dispatcher's fence refused this settle");
    expect(world.sent).toHaveLength(0);
    expect(carries.size).toBe(0);
    expect(gate.told.signed).toEqual([]);
  });

  it("without a fence writes the carry into memory before the send, exactly as before (the legacy path)", async () => {
    const world = new SettleWorld();
    world.losingBacklog();
    const { run, carries } = turn(world, { live: true });
    expect((await run()).outcome).toBe("SETTLED");
    expect(carries.size).toBe(1);
    expect(world.sent).toHaveLength(1);
  });
});

describe("a dry settle under the dispatcher's fence: the shadow world's gate", () => {
  it("is gated where a live one would be — live: false, the same blockhash, carry and amount — and nothing is sent", async () => {
    const world = new SettleWorld();
    world.trade(400_000_000);
    world.finalizeTo(world.tip);
    const gate = fence();
    const result = await turn(world, { live: false, fence: gate }).run();
    expect(result.outcome).toBe("SETTLED");
    expect(result.detail).toContain("DRY RUN — would settle");
    expect(gate.told.requests).toHaveLength(1);
    expect(gate.told.requests[0]).toMatchObject({ live: false, carry: null, lastValidBlockHeight: 1_000 });
    expect(gate.told.requests[0]!.amountLamports).toBeGreaterThan(0n);
    expect(world.sent).toHaveLength(0);
  });

  it("answers RETRY, still dry, when the gate refuses", async () => {
    const world = new SettleWorld();
    world.trade(400_000_000);
    world.finalizeTo(world.tip);
    const result = await turn(world, { live: false, fence: fence("refuse") }).run();
    expect(result.outcome).toBe("RETRY");
    expect(result.detail).toMatch(/^DRY RUN — the dispatcher's fence refused this settle/);
    expect(world.sent).toHaveLength(0);
  });

  it("asks nothing for a turn that would send nothing anyway — an idle wallet never reaches the gate", async () => {
    const world = new SettleWorld();
    const gate = fence();
    expect((await turn(world, { live: false, fence: gate }).run()).outcome).toBe("IDLE");
    expect(gate.told.requests).toHaveLength(0);
  });
});
