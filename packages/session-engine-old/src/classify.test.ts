// Settlement recognition, which is the one classification rule that keys on a
// constant rather than on observed movement.
//
// session.test.ts already proves the HISTORICAL settlement classifies, against
// the recorded mainnet fixture. It cannot prove anything about the selector the
// redeployed executor will use, because that executor does not exist yet — and
// "the constant is wrong" is not a failure the fixture could ever surface. These
// cases are synthetic on purpose: they are the only coverage the new selector
// has until there is a second settlement in history.

import { describe, expect, it } from "vitest";
import {
  LEGACY_SETTLE_SELECTORS,
  SETTLEMENT_EXECUTOR,
  SETTLE_SELECTOR,
  classifySettlementCall,
} from "./chain.js";
import { classifyTx } from "./classify.js";
import type { RawTx } from "./window.js";

const WALLET = "0xc455bf7f16ebbc2b07cb26d1dd46194977974e7d";
const CONTRIBUTION = 403370889498747n;

/** A settle() call as the chain records it: value out, nothing back, no tokens. */
const settleTx = (to: string | null, input: string): RawTx => ({
  hash: "0xsettle",
  blockNumber: 22086130n,
  sender: WALLET,
  to,
  input,
  success: true,
  gasPaid: 21_000n,
  nativeMoves: [{ from: WALLET, to: to ?? "0x", value: CONTRIBUTION }],
  tokenMoves: [],
});

/** Calldata is the selector plus an arbitrary body; only the first 4 bytes matter. */
const callData = (selector: string): string => `${selector}${"00".repeat(64)}`;

describe("recognising a settlement", () => {
  it("recognises the current settle selector", () => {
    const tx = classifyTx(settleTx(SETTLEMENT_EXECUTOR, callData(SETTLE_SELECTOR)), WALLET);
    expect(tx.kind).toBe("SETTLEMENT");
    expect(tx.cashOut).toBe(CONTRIBUTION);
  });

  it("still recognises every superseded selector", () => {
    // The engine's whole value is reproducing windows that already happened.
    // configureProtocol is one-shot, so an executor is replaced rather than
    // amended, and the calldata already in history never changes shape.
    for (const legacy of LEGACY_SETTLE_SELECTORS) {
      const tx = classifyTx(settleTx(SETTLEMENT_EXECUTOR, callData(legacy)), WALLET);
      expect(tx.kind, `legacy selector ${legacy}`).toBe("SETTLEMENT");
    }
  });

  /**
   * The shape every non-custodial path produces: the wallet does not send the
   * transaction, so the top-level `to` is not the executor. Before the
   * destination check existed this fell through to UNKNOWN ("cash left via a
   * contract call that returned nothing") and one UNKNOWN refuses the window
   * permanently — which would have made the delegate, a relayer and a bundler
   * all unusable.
   */
  it("recognises a settlement RELAYED by someone else, where the top-level `to` is the wallet", () => {
    const relayed: RawTx = {
      hash: "0xrelayed",
      blockNumber: 22086130n,
      sender: "0x1111111111111111111111111111111111111111", // a relayer, not the wallet
      to: WALLET, // an EIP-7702 delegate: code runs AT the wallet's address
      input: `0xbeefbeef${"00".repeat(64)}`, // not the settle selector
      success: true,
      gasPaid: 21_000n,
      nativeMoves: [{ from: WALLET, to: SETTLEMENT_EXECUTOR, value: CONTRIBUTION }],
      tokenMoves: [],
    };
    const tx = classifyTx(relayed, WALLET);
    expect(tx.kind).toBe("SETTLEMENT");
    expect(tx.cashOut).toBe(CONTRIBUTION);
    expect(tx.selfSent).toBe(false);
  });

  it("does NOT treat cash sent to an unknown address as a settlement", () => {
    const impostor: RawTx = {
      hash: "0ximpostor",
      blockNumber: 22086130n,
      sender: "0x1111111111111111111111111111111111111111",
      to: WALLET,
      input: `0xbeefbeef${"00".repeat(64)}`,
      success: true,
      gasPaid: 21_000n,
      // Same shape, but the cash went somewhere this engine does not know.
      nativeMoves: [{ from: WALLET, to: "0x000000000000000000000000000000000000dead", value: CONTRIBUTION }],
      tokenMoves: [],
    };
    expect(classifyTx(impostor, WALLET).kind).toBe("UNKNOWN");
  });

  it("is case-insensitive about the executor address", () => {
    const checksummed = "0x5D037fE7Fd65745BA51DDb433Aa5B17E965D46Ac";
    expect(classifySettlementCall(checksummed, callData(SETTLE_SELECTOR)).kind).toBe("SETTLEMENT");
  });
});

describe("refusing to guess", () => {
  it("refuses a settle-shaped call to an executor it does not know, and says why", () => {
    // This is the shape of a redeploy whose address was never added to
    // SETTLEMENT_EXECUTORS. It must not silently become an ordinary cash
    // outflow: that is the misclassification the whole guard exists to prevent.
    const stranger = "0x00000000000000000000000000000000deadbeef";
    const tx = classifyTx(settleTx(stranger, callData(SETTLE_SELECTOR)), WALLET);
    expect(tx.kind).toBe("UNKNOWN");
    expect(tx.note).toContain("not a known SettlementExecutor");
    expect(tx.note).toContain(stranger);
  });

  it("never credits a stranger's contract for sharing four bytes", () => {
    // Anyone can deploy a function whose selector collides. Counting it as a
    // settlement would add its outflow back into realized profit — profit the
    // wallet did not make. The address check is what stops that, and it is
    // deliberately not a fallback.
    const impostor = "0x1111111111111111111111111111111111111111";
    expect(classifySettlementCall(impostor, callData(SETTLE_SELECTOR)).kind).toBe("UNRECOGNISED_EXECUTOR");
  });

  it("leaves ordinary calls to the executor alone", () => {
    // Not every call to the executor is a settlement; a view call is not one.
    const match = classifySettlementCall(SETTLEMENT_EXECUTOR, callData("0x12345678"));
    expect(match.kind).toBe("NOT_SETTLEMENT");
  });

  it("does not treat a contract creation as a settlement", () => {
    expect(classifySettlementCall(null, callData(SETTLE_SELECTOR)).kind).toBe("NOT_SETTLEMENT");
  });

  it("keeps a reverted settle attempt out of the flows", () => {
    // A reverted transaction moved no value. Booking its declared contribution
    // as an external withdrawal would add back cash that never left.
    const reverted: RawTx = { ...settleTx(SETTLEMENT_EXECUTOR, callData(SETTLE_SELECTOR)), success: false };
    expect(classifyTx(reverted, WALLET).kind).toBe("APPROVE_OR_NOOP");
  });
});
