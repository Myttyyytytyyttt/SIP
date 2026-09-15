// The settle tick's decisions, reached without a Connection, a Program or a mock.
//
// What is pinned here: both modes are measured and only a mode no program version
// defines stops before anything is read; the attestation binds exactly the fields
// settle_v2 rebuilds from chain state — the vault's own mode, the rate of that
// mode as state.rs's active_bps reads it, its policy nonce, a start that is the
// link's measurementStart and nothing else, and a deadline 150 slots past the
// confirmed slot. The measurement order is the old tick's behind two new stops —
// a walk that did not reach the frontier, and a window finality has not caught up
// with — and it ends in the base: a positive base settles, a flat span settles a
// zero base once it is worth a transaction, a window holding only our own settle
// never settles again, and a VOLUME span is charged only on a notional that is
// proven. The frontier-from-epoch rule is unchanged, and the outcome-to-alert rule
// is pinned for every outcome. The bytes those inputs encode to are pinned to the
// program's golden vector in attestation-golden.test.ts.

import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import type { VaultState } from "../src/accounts.js";
import type { ManagedLink } from "../src/discovery.js";
import { SIP_PROGRAM_ID } from "../src/idl.js";
import type { WindowMeasurement } from "../src/measure-window.js";
import { ATTESTATION_MESSAGE_LEN, MODE_PROFIT, MODE_VOLUME, attestationMessage } from "../src/program-scripts.js";
import {
  ATTESTATION_VALIDITY_SLOTS,
  SETTLE_RETRY_CRITICAL_AFTER,
  ZERO_BASE_MIN_TXS,
  activeBps,
  attestationInputs,
  baseDecision,
  decideFromMeasurement,
  defaultVolumeBase,
  expectedContribution,
  measurementStart,
  modeDecision,
  pauseDecision,
  reserveDecision,
  settleAlert,
  type SettleOutcome,
  type VolumeBase,
} from "../src/settle-decision.js";

const link: ManagedLink = {
  linkAddress: Keypair.generate().publicKey,
  wallet: Keypair.generate().publicKey,
  vault: Keypair.generate().publicKey,
  epoch: 300_000_000n,
  settlementNonce: 7n,
  frontierSlot: 300_000_500n,
};

const vault = (over: Partial<VaultState> = {}): VaultState => ({
  owner: Keypair.generate().publicKey,
  paused: false,
  skimMode: 0,
  skimBps: 2_000,
  volumeBps: 20,
  policyNonce: 3n,
  maxContribution: 1_000_000_000n,
  walletReserve: 0n,
  ...over,
});

/** A walk that reached the frontier and read twelve clean trades above it. */
const measured = (over: Partial<WindowMeasurement> = {}): WindowMeasurement => ({
  txCount: 12,
  settleTxCount: 0,
  successfulTradeCount: 12,
  chainBreaks: 0,
  unfetchable: 0,
  cashDelta: 50_000_000n,
  deposits: 0n,
  withdrawals: 0n,
  profitLamports: 50_000_000n,
  firstSlot: 300_000_600n,
  lastSlot: 300_000_900n,
  signaturesAbove: 12,
  frontierReached: true,
  pagesExhausted: false,
  ...over,
});

describe("the vault's mode", () => {
  it("lets both real modes through to be measured", () => {
    expect(modeDecision(vault())).toBeNull();
    expect(modeDecision(vault({ skimMode: MODE_VOLUME }))).toBeNull();
  });

  it("stops a mode no program version defines, before anything is measured", () => {
    const decision = modeDecision(vault({ skimMode: 9 }));
    expect(decision?.outcome).toBe("UNSUPPORTED_MODE");
    expect(decision?.detail).toContain("skim_mode 9");
  });
});

describe("the pause switches", () => {
  it("rests a vault its owner paused, naming VaultPaused", () => {
    const decision = pauseDecision(vault({ paused: true }), false);
    expect(decision?.outcome).toBe("PAUSED");
    expect(decision?.detail).toContain("VaultPaused");
    expect(decision?.detail).not.toContain("ProtocolPaused");
  });

  it("rests every vault while the protocol is paused, naming ProtocolPaused", () => {
    const decision = pauseDecision(vault(), true);
    expect(decision?.outcome).toBe("PAUSED");
    expect(decision?.detail).toContain("ProtocolPaused");
    expect(decision?.detail).not.toContain("VaultPaused");
  });

  it("names both switches when both are on", () => {
    const decision = pauseDecision(vault({ paused: true }), true);
    expect(decision?.outcome).toBe("PAUSED");
    expect(decision?.detail).toContain("VaultPaused");
    expect(decision?.detail).toContain("ProtocolPaused");
  });

  it("lets an unpaused vault in an unpaused protocol through", () => {
    expect(pauseDecision(vault(), false)).toBeNull();
  });
});

describe("where a measurement starts", () => {
  it("starts a never-settled link at its own creation, not at slot zero", () => {
    expect(measurementStart({ epoch: 300_000_000n, frontierSlot: 0n })).toBe(300_000_000n);
  });

  it("starts a settled link at its frontier", () => {
    expect(measurementStart({ epoch: 300_000_000n, frontierSlot: 300_000_500n })).toBe(300_000_500n);
  });
});

describe("what a measurement allows, in order", () => {
  const from = 300_000_500n;
  /** A PROFIT span's context at a finalized slot, as settle-tick.ts builds it. */
  const context = (finalizedSlot: bigint) => ({ from, finalizedSlot, mode: MODE_PROFIT, volumeBase: defaultVolumeBase });
  // Finality well past the start: the ordinary case.
  const at = context(300_001_000n);

  it("an unreadable span is INCOMPLETE even when it looks empty", async () => {
    const decision = await decideFromMeasurement(measured({ unfetchable: 3, txCount: 0 }), at);
    expect(decision).toMatchObject({ kind: "stop", outcome: "INCOMPLETE" });
    if (decision.kind === "stop") expect(decision.detail).toContain("OUR node");
  });

  it("a walk whose finalized history ends above a start not finalized yet rests at PENDING_FINALITY", async () => {
    const decision = await decideFromMeasurement(measured({ frontierReached: false, txCount: 0 }), context(from - 1n));
    expect(decision).toMatchObject({ kind: "stop", outcome: "PENDING_FINALITY" });
    if (decision.kind === "stop") expect(decision.detail).toContain(`slot ${from}`);
  });

  it("a walk whose finalized history ends above a finalized start is INCOMPLETE, naming the slot", async () => {
    // At the boundary too: a start AT the finalized slot is finalized.
    for (const finalizedSlot of [from, from + 1_000n]) {
      const decision = await decideFromMeasurement(measured({ frontierReached: false, txCount: 0 }), context(finalizedSlot));
      expect(decision).toMatchObject({ kind: "stop", outcome: "INCOMPLETE" });
      if (decision.kind === "stop") expect(decision.detail).toContain(`stops above slot ${from}`);
    }
  });

  it("a walk that ran out of pages is INCOMPLETE, even over a start finality has not reached", async () => {
    const decision = await decideFromMeasurement(
      measured({ frontierReached: false, pagesExhausted: true, signaturesAbove: 20_000, txCount: 0 }),
      context(from - 1n),
    );
    expect(decision).toMatchObject({ kind: "stop", outcome: "INCOMPLETE" });
    if (decision.kind === "stop") expect(decision.detail).toContain("walked 20000 signatures over 20 pages");
  });

  it("a walk that reached the frontier with nothing finalized above it rests at PENDING_FINALITY, never IDLE", async () => {
    // The turn walks only after a confirmed probe saw a newer signature, so
    // this is finality catching up. An idle wallet never gets this far.
    expect(await decideFromMeasurement(measured({ txCount: 0, signaturesAbove: 0 }), at)).toMatchObject({ kind: "stop", outcome: "PENDING_FINALITY" });
  });

  it("words each finality stop the same while finality advances, so the sweep logs it once", async () => {
    // The sweep's change log emits a resting state only when its line changes,
    // and the finalized slot moves every sweep.
    const shapes = [
      [measured({ frontierReached: false, txCount: 0 }), [from - 50n, from - 1n]],
      [measured({ frontierReached: false, txCount: 0 }), [from, from + 1_000n]],
      [measured({ txCount: 0, signaturesAbove: 0 }), [300_001_000n, 300_001_032n]],
    ] as const;
    for (const [shape, [earlier, later]] of shapes) {
      expect(await decideFromMeasurement(shape, context(earlier))).toEqual(await decideFromMeasurement(shape, context(later)));
    }
  });

  it("more signatures above the frontier than one settlement reads is INCOMPLETE and promises no catch-up; the limit itself is measured", async () => {
    const over = await decideFromMeasurement(measured({ signaturesAbove: 301, txCount: 0 }), at);
    expect(over).toMatchObject({ kind: "stop", outcome: "INCOMPLETE" });
    if (over.kind === "stop") {
      expect(over.detail).toContain("301 signatures");
      expect(over.detail).not.toContain("catch up");
    }
    expect(await decideFromMeasurement(measured({ signaturesAbove: 300, txCount: 300 }), at)).toMatchObject({ kind: "settle" });
  });

  it("a broken chain is INCOMPLETE", async () => {
    expect(await decideFromMeasurement(measured({ chainBreaks: 1 }), at)).toMatchObject({ kind: "stop", outcome: "INCOMPLETE" });
  });

  it("reaches the base only past every completeness stop: an incomplete VOLUME span never asks the seam", async () => {
    let asked = 0;
    const volumeBase: VolumeBase = async () => {
      asked += 1;
      return 1n;
    };
    const volumeAt = { ...at, mode: MODE_VOLUME, volumeBase };
    expect(await decideFromMeasurement(measured({ unfetchable: 1 }), volumeAt)).toMatchObject({ outcome: "INCOMPLETE" });
    expect(await decideFromMeasurement(measured({ chainBreaks: 1 }), volumeAt)).toMatchObject({ outcome: "INCOMPLETE" });
    expect(await decideFromMeasurement(measured({ frontierReached: false, txCount: 0 }), volumeAt)).toMatchObject({ outcome: "INCOMPLETE" });
    expect(asked).toBe(0);
    expect(await decideFromMeasurement(measured(), volumeAt)).toEqual({ kind: "settle", baseLamports: 1n, endSlot: 300_000_900n });
    expect(asked).toBe(1);
  });

  it("profit with no slot beyond the frontier is IDLE", async () => {
    expect(await decideFromMeasurement(measured({ lastSlot: from }), at)).toMatchObject({ kind: "stop", outcome: "IDLE" });
  });

  it("clean profit settles over the measured window", async () => {
    expect(await decideFromMeasurement(measured(), at)).toEqual({ kind: "settle", baseLamports: 50_000_000n, endSlot: 300_000_900n });
  });
});

describe("the base, and when a zero base is worth a transaction", () => {
  const from = 300_000_500n;
  const profit = (span: WindowMeasurement) => baseDecision({ mode: MODE_PROFIT, measured: span, from, volumeBase: defaultVolumeBase });
  const volume = (span: WindowMeasurement, volumeBase: VolumeBase = defaultVolumeBase) =>
    baseDecision({ mode: MODE_VOLUME, measured: span, from, volumeBase });

  it("a losing span with enough transactions in it settles a zero base over the measured window", async () => {
    expect(await profit(measured({ profitLamports: -5n, txCount: 150, settleTxCount: 1 }))).toEqual({
      kind: "settle",
      baseLamports: 0n,
      endSlot: 300_000_900n,
    });
  });

  it("THE LOOP GUARD: a window holding only our own previous settle is IDLE, however many, and whatever a seam says", async () => {
    // A settle is external flow, so this window measures a profit of exactly zero.
    const onlyOurSettle = measured({ txCount: 1, settleTxCount: 1, successfulTradeCount: 0, cashDelta: -10_000n, withdrawals: 10_000n, profitLamports: 0n });
    const decision = await profit(onlyOurSettle);
    expect(decision).toMatchObject({ kind: "stop", outcome: "IDLE" });
    if (decision.kind === "stop") expect(decision.detail).toContain("only our own settle");
    const many = ZERO_BASE_MIN_TXS + 5;
    expect(await profit(measured({ txCount: many, settleTxCount: many, successfulTradeCount: 0, profitLamports: 0n }))).toMatchObject({ outcome: "IDLE" });

    let asked = 0;
    const seam: VolumeBase = async () => {
      asked += 1;
      return 1_000_000_000n;
    };
    expect(await volume(onlyOurSettle, seam)).toMatchObject({ kind: "stop", outcome: "IDLE" });
    expect(asked, "the seam is never asked about our own settles").toBe(0);
  });

  it("a small flat or losing span rests at NO_PROFIT, carries its base, and says how far it is from a zero settle", async () => {
    const flat = await profit(measured({ txCount: 3, successfulTradeCount: 3, profitLamports: 0n }));
    expect(flat).toMatchObject({ kind: "stop", outcome: "NO_PROFIT", baseLamports: 0n });
    if (flat.kind === "stop") {
      expect(flat.detail).toContain("a losing or flat span");
      expect(flat.detail).toContain(`${ZERO_BASE_MIN_TXS - 3} to go`);
      // The old warning promised a wedge the zero settle now prevents.
      expect(flat.detail).not.toContain("WARNING");
    }
    expect(await profit(measured({ profitLamports: -5n }))).toMatchObject({ kind: "stop", outcome: "NO_PROFIT", baseLamports: -5n });
  });

  it("counts only transactions other than our own settles toward a zero settle, at the boundary", async () => {
    expect(ZERO_BASE_MIN_TXS).toBe(100);
    const below = await profit(measured({ txCount: ZERO_BASE_MIN_TXS, settleTxCount: 1, profitLamports: 0n }));
    expect(below).toMatchObject({ kind: "stop", outcome: "NO_PROFIT" });
    if (below.kind === "stop") expect(below.detail).toContain("1 to go");
    expect(await profit(measured({ txCount: ZERO_BASE_MIN_TXS + 1, settleTxCount: 1, profitLamports: 0n }))).toEqual({
      kind: "settle",
      baseLamports: 0n,
      endSlot: 300_000_900n,
    });
  });

  it("positive profit settles whatever the span's size, and never asks the VOLUME seam", async () => {
    let asked = 0;
    const seam: VolumeBase = async () => {
      asked += 1;
      return 5n;
    };
    const one = measured({ txCount: 1, successfulTradeCount: 1, profitLamports: 1n });
    expect(await baseDecision({ mode: MODE_PROFIT, measured: one, from, volumeBase: seam })).toEqual({ kind: "settle", baseLamports: 1n, endSlot: 300_000_900n });
    expect(asked).toBe(0);
  });

  it("a VOLUME span with no successful trade settles a zero base, attested in mode 1 at the volume rate", async () => {
    const quiet = measured({ txCount: 120, settleTxCount: 0, successfulTradeCount: 0, profitLamports: -600_000n });
    const decision = await volume(quiet);
    expect(decision).toEqual({ kind: "settle", baseLamports: 0n, endSlot: 300_000_900n });
    if (decision.kind !== "settle") return;
    const inputs = attestationInputs({
      programId: new PublicKey(SIP_PROGRAM_ID),
      link,
      vault: vault({ skimMode: MODE_VOLUME, skimBps: 2_000, volumeBps: 200 }),
      from,
      endSlot: decision.endSlot,
      baseLamports: decision.baseLamports,
      currentSlot: 300_001_000n,
    });
    expect(inputs).toMatchObject({ mode: MODE_VOLUME, bps: 200, baseLamports: 0n, sessionEndSlot: 300_000_900n });
    expect(inputs.bps, "the volume rate, never skim_bps").not.toBe(2_000);
  });

  it("a small VOLUME span with no successful trade rests at NO_PROFIT and says so", async () => {
    const decision = await volume(measured({ txCount: 4, successfulTradeCount: 0, profitLamports: 0n }));
    expect(decision).toMatchObject({ kind: "stop", outcome: "NO_PROFIT", baseLamports: 0n });
    if (decision.kind === "stop") {
      expect(decision.detail).toContain("no successful trade over 4 txs");
      expect(decision.detail).toContain(`${ZERO_BASE_MIN_TXS - 4} to go`);
    }
  });

  it("a VOLUME span with a successful trade rests at UNSUPPORTED_MODE under the default seam, and attests nothing", async () => {
    // Large enough for a zero settle, which must not happen: its notional is unknown, not zero.
    const decision = await volume(measured({ txCount: 150, successfulTradeCount: 1, profitLamports: 0n }));
    expect(decision).toEqual({ kind: "stop", outcome: "UNSUPPORTED_MODE", detail: "1 successful trade(s) await keeper-medir-volumen; nothing attested" });
  });

  it("a VOLUME span settles at the notional an injected seam measures, the seam sees the measurement, and a negative one throws", async () => {
    const span = measured({ successfulTradeCount: 1 });
    let seen: WindowMeasurement | undefined;
    const seam: VolumeBase = async (measurement) => {
      seen = measurement;
      return 1_000_000_000n;
    };
    expect(await volume(span, seam)).toEqual({ kind: "settle", baseLamports: 1_000_000_000n, endSlot: 300_000_900n });
    expect(seen).toBe(span);
    await expect(volume(span, async () => -1n)).rejects.toThrow(/never negative/);
  });

  it("an undefined mode that reached the base is UNSUPPORTED_MODE, never charged at the profit rate", async () => {
    expect(await baseDecision({ mode: 9, measured: measured(), from, volumeBase: defaultVolumeBase })).toMatchObject({
      kind: "stop",
      outcome: "UNSUPPORTED_MODE",
    });
  });
});

describe("the attestation", () => {
  const programId = new PublicKey(SIP_PROGRAM_ID);
  // link.frontierSlot is 300_000_500, so that is where this span must start.
  const span = { from: 300_000_500n, endSlot: 300_000_900n, baseLamports: 50_000_000n, currentSlot: 300_001_000n };

  it("takes the rate of the vault's active mode, branch for branch as state.rs's active_bps", () => {
    expect(activeBps(vault({ skimMode: MODE_PROFIT, skimBps: 2_500, volumeBps: 40 }))).toBe(2_500);
    expect(activeBps(vault({ skimMode: MODE_VOLUME, skimBps: 2_500, volumeBps: 40 }))).toBe(40);
    // The program tests `== MODE_VOLUME`, so every other mode reads skim_bps.
    expect(activeBps(vault({ skimMode: 9, skimBps: 2_500, volumeBps: 40 }))).toBe(2_500);
  });

  it("binds a PROFIT vault's mode 0, its PROFIT rate and policy nonce, and a deadline 150 slots out", () => {
    const state = vault({ skimBps: 2_500, volumeBps: 40, policyNonce: 11n });
    const inputs = attestationInputs({ programId, link, vault: state, ...span });
    expect(inputs).toEqual({
      programId,
      wallet: link.wallet,
      vault: link.vault,
      linkEpoch: link.epoch,
      settlementNonce: 7n,
      sessionStartSlot: 300_000_500n,
      sessionEndSlot: 300_000_900n,
      baseLamports: 50_000_000n,
      mode: MODE_PROFIT,
      bps: 2_500,
      policyNonce: 11n,
      validUntilSlot: 300_001_150n,
    });
    expect(ATTESTATION_VALIDITY_SLOTS).toBe(150n);
    expect(inputs.bps, "never the volume rate").not.toBe(state.volumeBps);
  });

  it("binds a VOLUME vault's mode 1 and its VOLUME rate, never the profit rate", () => {
    const state = vault({ skimMode: MODE_VOLUME, skimBps: 2_500, volumeBps: 40, policyNonce: 11n });
    const inputs = attestationInputs({ programId, link, vault: state, ...span });
    expect(inputs).toMatchObject({ mode: MODE_VOLUME, bps: 40, policyNonce: 11n, validUntilSlot: 300_001_150n });
    expect(inputs.bps, "never the profit rate").not.toBe(state.skimBps);
  });

  it("encodes through the program's own mirror to the 171-byte message, the vault's mode at byte 152", () => {
    for (const skimMode of [MODE_PROFIT, MODE_VOLUME]) {
      const message = attestationMessage(attestationInputs({ programId, link, vault: vault({ skimMode }), ...span }));
      expect(message.length).toBe(ATTESTATION_MESSAGE_LEN);
      expect(message.length).toBe(171);
      // mode sits right after the five u64s: 16 + 96 + 40.
      expect(message[152]).toBe(skimMode);
    }
  });

  it("carries a zero base as eight zero bytes at 144..151, and nothing else about the message changes", () => {
    // base is the fifth u64: 16 + 96 + 32.
    const zero = attestationMessage(attestationInputs({ programId, link, vault: vault(), ...span, baseLamports: 0n }));
    const some = attestationMessage(attestationInputs({ programId, link, vault: vault(), ...span }));
    expect([...zero.subarray(144, 152)]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(some.readBigUInt64LE(144)).toBe(50_000_000n);
    const outsideBase = (message: Buffer) => Buffer.concat([message.subarray(0, 144), message.subarray(152)]);
    expect(outsideBase(zero).equals(outsideBase(some))).toBe(true);
  });

  it("a start other than measurementStart throws, above it or below it", () => {
    // Above forgives the slots in between; below is a window settle_v2 would
    // refuse for a settled link.
    for (const from of [300_000_501n, 300_000_499n]) {
      expect(() => attestationInputs({ programId, link, vault: vault(), ...span, from })).toThrow(/starts at slot 300000500/);
    }
    // A never-settled link starts at its epoch: not at zero, where the
    // program's own check (start >= frontier 0) would let it through.
    const fresh: ManagedLink = { ...link, frontierSlot: 0n };
    expect(() => attestationInputs({ programId, link: fresh, vault: vault(), ...span, from: 0n })).toThrow(/starts at slot 300000000/);
    expect(attestationInputs({ programId, link: fresh, vault: vault(), ...span, from: 300_000_000n }).sessionStartSlot).toBe(300_000_000n);
  });

  it("previews what settle_v2 would pay: floored, and clipped at max_contribution", () => {
    expect(expectedContribution(50_000_000n, 2_000, 1_000_000_000n)).toEqual({ owed: 10_000_000n, paid: 10_000_000n });
    expect(expectedContribution(9_999n, 2_000, 1_000_000_000n)).toEqual({ owed: 1_999n, paid: 1_999n });
    expect(expectedContribution(50_000_000n, 2_000, 4_000_000n)).toEqual({ owed: 10_000_000n, paid: 4_000_000n });
  });
});

describe("the wallet reserve, as settle.rs refuses it, with the fee the wallet pays first", () => {
  const fee = 10_000n;
  const rent0 = 890_880n;
  const reserve = 50_000_000n;
  const paid = 20_000_000n;
  const decide = (walletLamports: bigint, over: Partial<Parameters<typeof reserveDecision>[0]> = {}) =>
    reserveDecision({ walletLamports, feeLamports: fee, rentExemptZero: rent0, walletReserve: reserve, paid, ...over });

  it("lets a wallet left at exactly rent_exempt(0) + wallet_reserve through, and refuses one lamport less", () => {
    // z-review-settle-link.ts's boundary — balance − paid == rent0 + reserve —
    // with the fee the runtime takes before settle_v2 runs.
    const exact = fee + paid + rent0 + reserve;
    expect(decide(exact)).toBeNull();
    const short = decide(exact - 1n);
    expect(short?.outcome).toBe("BELOW_RESERVE");
    expect(short?.detail).toContain("1 lamports short");
  });

  it("checks what is PAID, clipped at max_contribution, never what is owed", () => {
    // 1 SOL owed against a 0.1 SOL cap: a wallet covering 0.1 SOL settles.
    const { owed, paid: clipped } = expectedContribution(5_000_000_000n, 2_000, 100_000_000n);
    expect([owed, clipped]).toEqual([1_000_000_000n, 100_000_000n]);
    const covering = fee + clipped + rent0 + reserve;
    expect(decide(covering, { paid: clipped })).toBeNull();
    expect(decide(covering, { paid: owed })?.outcome).toBe("BELOW_RESERVE");
  });

  it("ignores wallet_reserve for a zero payment, which needs only the fee and the rent floor", () => {
    expect(decide(fee + rent0, { paid: 0n, walletReserve: 1_000_000_000_000n })).toBeNull();
    expect(decide(fee + rent0 - 1n, { paid: 0n })?.outcome).toBe("BELOW_RESERVE");
  });

  it("refuses a wallet holding less than the fee, or nothing, without throwing", () => {
    for (const payment of [0n, paid]) {
      expect(() => decide(fee - 1n, { paid: payment })).not.toThrow();
      expect(decide(fee - 1n, { paid: payment })?.outcome).toBe("BELOW_RESERVE");
      expect(decide(0n, { paid: payment })?.outcome).toBe("BELOW_RESERVE");
    }
  });

  it("names WalletBelowReserve and wallet_reserve, and never calls a resting state a failure", () => {
    const positive = decide(0n)?.detail ?? "";
    expect(positive).toContain("WalletBelowReserve");
    expect(positive).toContain(`wallet_reserve ${reserve}`);
    expect(positive).toContain("frontier stays put");
    const zero = decide(0n, { paid: 0n })?.detail ?? "";
    for (const detail of [positive, zero]) expect(detail.toLowerCase()).not.toContain("fail");
  });
});

describe("the alert rule", () => {
  const where = { wallet: "Wallet1111", vault: "Vault1111" };
  const failed = "settle-failed:Wallet1111";
  const retry = "settle-retry:Wallet1111";
  const incomplete = "incomplete:Wallet1111";
  const noSigner = "no-signer:Wallet1111";
  type Want = { readonly fire: { readonly key: string; readonly severity: "warn" | "critical" } | null; readonly clear: readonly string[] };
  // A Record over SettleOutcome, so an outcome added without a row here fails to compile.
  const table: Record<SettleOutcome, Want> = {
    IDLE: { fire: null, clear: [retry, incomplete, noSigner] },
    PENDING_FINALITY: { fire: null, clear: [retry, incomplete, noSigner] },
    NO_PROFIT: { fire: null, clear: [retry, incomplete, noSigner] },
    UNSUPPORTED_MODE: { fire: null, clear: [retry, incomplete, noSigner] },
    SETTLED: { fire: null, clear: [failed, retry] },
    PAUSED: { fire: null, clear: [failed, retry, incomplete, noSigner] },
    BELOW_RESERVE: { fire: null, clear: [failed, retry, incomplete, noSigner] },
    INCOMPLETE: { fire: { key: incomplete, severity: "warn" }, clear: [retry, noSigner] },
    NO_SIGNER: { fire: { key: noSigner, severity: "warn" }, clear: [retry, incomplete] },
    RETRY: { fire: { key: retry, severity: "warn" }, clear: [] },
    FAILED: { fire: { key: failed, severity: "critical" }, clear: [retry] },
  };

  it("raises and resolves exactly this for every outcome, carrying the turn's detail", () => {
    for (const [outcome, want] of Object.entries(table) as [SettleOutcome, Want][]) {
      // A RETRY is the first of its run; every other outcome resets the run to 0.
      const rule = settleAlert(outcome, where, "the turn's detail", outcome === "RETRY" ? 1 : 0);
      const got = { fire: rule.fire === null ? null : { key: rule.fire.key, severity: rule.fire.severity }, clear: [...rule.clear].sort() };
      expect(got, outcome).toEqual({ fire: want.fire, clear: [...want.clear].sort() });
      if (rule.fire !== null) expect(rule.fire.detail, outcome).toBe("the turn's detail");
    }
  });

  it("warns on a RETRY and pages it as a failed settlement at the third sweep in a row", () => {
    expect(SETTLE_RETRY_CRITICAL_AFTER).toBe(3);
    for (const run of [1, 2]) expect(settleAlert("RETRY", where, "d", run).fire, String(run)).toMatchObject({ key: retry, severity: "warn" });
    for (const run of [3, 4]) {
      expect(settleAlert("RETRY", where, "AttestationMismatch", run).fire, String(run)).toEqual({
        key: failed,
        severity: "critical",
        title: "A settlement keeps not landing",
        detail: `${run} sweeps in a row: AttestationMismatch`,
        context: { wallet: "Wallet1111", vault: "Vault1111" },
      });
    }
  });

  it("names the wallet and the vault on a failed settle, and the wallet on a warning", () => {
    expect(settleAlert("FAILED", where, "d").fire).toMatchObject({ title: "A settlement failed", context: { wallet: "Wallet1111", vault: "Vault1111" } });
    expect(settleAlert("INCOMPLETE", where, "d").fire?.context).toEqual({ wallet: "Wallet1111" });
    expect(settleAlert("NO_SIGNER", where, "d").fire?.context).toEqual({ wallet: "Wallet1111" });
  });
});
