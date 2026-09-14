// The browser confirmation helper, with an injected RPC.

import { describe, expect, it } from "vitest";

import { base58Encode } from "../src/client/base58";
import { confirmSignature } from "../src/client/confirm";

const signature = base58Encode(Uint8Array.from({ length: 64 }, (_, i) => 200 - i));

function scripted(statuses: unknown[], heights: number[]) {
  const calls: string[] = [];
  const rpc = async (method: string): Promise<unknown> => {
    calls.push(method);
    if (method === "getSignatureStatuses") return { context: { slot: 1 }, value: [statuses.length > 1 ? statuses.shift() : statuses[0]] };
    if (method === "getBlockHeight") return heights.length > 1 ? heights.shift() : heights[0];
    throw new Error(`unexpected ${method}`);
  };
  return { rpc, calls };
}

const noSleep = async (): Promise<void> => undefined;

describe("confirmSignature", () => {
  it("polls until the status reaches confirmed", async () => {
    const { rpc, calls } = scripted([null, { slot: 5, err: null, confirmationStatus: "processed" }, { slot: 6, err: null, confirmationStatus: "confirmed" }], [100]);
    expect(await confirmSignature({ rpc, signature, lastValidBlockHeight: 150, sleep: noSleep })).toEqual({ status: "confirmed", slot: 6 });
    expect(calls.filter((method) => method === "getSignatureStatuses")).toHaveLength(3);
  });

  it("waits for finalized when asked", async () => {
    const { rpc } = scripted([{ slot: 6, err: null, confirmationStatus: "confirmed" }, { slot: 7, err: null, confirmationStatus: "finalized" }], [100]);
    expect(await confirmSignature({ rpc, signature, lastValidBlockHeight: 150, commitment: "finalized", sleep: noSleep })).toEqual({ status: "finalized", slot: 7 });
  });

  it("reports an on-chain failure", async () => {
    const { rpc } = scripted([{ slot: 9, err: { InstructionError: [0, { Custom: 6004 }] }, confirmationStatus: "confirmed" }], [100]);
    expect(await confirmSignature({ rpc, signature, lastValidBlockHeight: 150, sleep: noSleep })).toEqual({ status: "failed", slot: 9, err: { InstructionError: [0, { Custom: 6004 }] } });
  });

  it("expires once the block height passes lastValidBlockHeight with no status", async () => {
    const { rpc } = scripted([null], [149, 150, 151]);
    expect(await confirmSignature({ rpc, signature, lastValidBlockHeight: 150n, sleep: noSleep })).toEqual({ status: "expired", blockHeight: 151 });
  });

  it("refuses a malformed signature and honours an abort", async () => {
    const { rpc } = scripted([null], [1]);
    await expect(confirmSignature({ rpc, signature: "nope", lastValidBlockHeight: 1, sleep: noSleep })).rejects.toThrow(/signature/);
    const controller = new AbortController();
    controller.abort();
    await expect(confirmSignature({ rpc, signature, lastValidBlockHeight: 10, sleep: noSleep, signal: controller.signal })).rejects.toThrow();
  });
});
