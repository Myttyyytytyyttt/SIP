// The relay allowlist and its parameter constraints.

import { describe, expect, it } from "vitest";

import { TOKEN_PROGRAM } from "../src/client/addresses";
import { base58Encode } from "../src/client/base58";
import { OLD_NUVEM_PROGRAM_ID, SIP_PROGRAM_ID } from "../src/client/idl";
import { MAX_RELAY_REQUEST_WEIGHT, RELAY_METHODS, checkRelayBody, checkRelayCall } from "../src/server/relay-policy";
import { RELAY_MAX_RESPONSE_BYTES } from "../src/server/rpc-pool";
import { BLOCKHASH, keypair } from "./helpers";

const address = (): string => keypair().publicKey.toBase58();
const signature = (): string => base58Encode(Uint8Array.from({ length: 64 }, (_, i) => (i * 13 + 5) & 0xff));
const wire = (bytes: number): string => Buffer.alloc(bytes, 1).toString("base64");
const call = (method: string, params?: unknown[], id: unknown = 1): Record<string, unknown> => ({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });

function expectOk(entry: unknown, weight: number, pool: "signing" | "reads"): void {
  const result = checkRelayCall(entry);
  expect(result.ok, result.ok ? "" : result.message).toBe(true);
  if (result.ok) {
    expect(result.weight).toBe(weight);
    expect(result.pool).toBe(pool);
  }
}

function expectRefused(entry: unknown, status: 400 | 403, code: number): void {
  const result = checkRelayCall(entry);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.status).toBe(status);
    expect(result.code).toBe(code);
  }
}

describe("allowed calls", () => {
  it("serves exactly the D2 set", () => {
    expect(Object.keys(RELAY_METHODS).sort()).toEqual(
      [
        "getLatestBlockhash",
        "getFeeForMessage",
        "simulateTransaction",
        "getTokenAccountsByOwner",
        "getGenesisHash",
        "getBalance",
        "getAccountInfo",
        "getMultipleAccounts",
        "getMinimumBalanceForRentExemption",
        "getTokenAccountBalance",
        "getSignatureStatuses",
        "getSlot",
        "getBlockHeight",
        "isBlockhashValid",
      ].sort(),
    );
    expect(MAX_RELAY_REQUEST_WEIGHT).toBe(30);
  });

  it("accepts each method's valid shapes with its weight and budget pool", () => {
    expectOk(call("getLatestBlockhash", []), 1, "signing");
    expectOk(call("getLatestBlockhash", [{ commitment: "confirmed", minContextSlot: 5 }]), 1, "signing");
    expectOk(call("getLatestBlockhash"), 1, "signing");
    expectOk(call("getFeeForMessage", [wire(200), { commitment: "confirmed" }]), 1, "signing");
    expectOk(call("simulateTransaction", [wire(600), { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" }], "7"), 3, "signing");
    expectOk(call("getTokenAccountsByOwner", [address(), { mint: address() }, { encoding: "jsonParsed", commitment: "confirmed" }]), 3, "reads");
    expectOk(call("getGenesisHash", []), 1, "signing");
    expectOk(call("getBalance", [address(), { commitment: "confirmed" }]), 1, "signing");
    expectOk(call("getAccountInfo", [address(), { encoding: "base64", dataSlice: { offset: 0, length: 4096 } }]), 1, "reads");
    expectOk(call("getAccountInfo", [address(), { encoding: "jsonParsed" }]), 1, "reads");
    expectOk(call("getMultipleAccounts", [Array.from({ length: 10 }, address), { encoding: "base64" }]), 2, "reads");
    expectOk(call("getMultipleAccounts", [Array.from({ length: 50 }, address), { encoding: "base64", dataSlice: { offset: 0, length: 100 } }]), 2, "reads");
    expectOk(call("getMinimumBalanceForRentExemption", [125]), 1, "reads");
    expectOk(call("getTokenAccountBalance", [address()]), 1, "reads");
    expectOk(call("getSignatureStatuses", [[signature()], { searchTransactionHistory: false }]), 1, "signing");
    expectOk(call("getSlot", []), 1, "reads");
    expectOk(call("getBlockHeight", [{ commitment: "confirmed" }]), 1, "signing");
    expectOk(call("isBlockhashValid", [BLOCKHASH, { commitment: "processed" }]), 1, "signing");
  });
});

describe("refused methods (403 -32601)", () => {
  it.each([
    "sendTransaction",
    "requestAirdrop",
    "getBlock",
    "getLargestAccounts",
    "getTokenLargestAccounts",
    "accountSubscribe",
    "getProgramAccounts",
    "getSignaturesForAddress",
    "getTransaction",
    "toString",
    "__proto__",
    "constructor",
    "xyzzy",
  ])("%s", (method) => {
    expectRefused(call(method, []), 403, -32601);
  });

  it("names why the history and scan methods are not relayed", () => {
    const result = checkRelayCall(call("getProgramAccounts", [SIP_PROGRAM_ID, {}]));
    expect(!result.ok && result.message).toContain("server-side");
    const old = checkRelayCall(call("getProgramAccounts", [OLD_NUVEM_PROGRAM_ID, {}]));
    expect(old.ok).toBe(false);
  });
});

describe("parameter constraints (400 -32602)", () => {
  it.each([
    ["getMultipleAccounts with 11 keys and no dataSlice", call("getMultipleAccounts", [Array.from({ length: 11 }, address), { encoding: "base64" }])],
    ["getMultipleAccounts with 51 keys", call("getMultipleAccounts", [Array.from({ length: 51 }, address), { encoding: "base64", dataSlice: { offset: 0, length: 10 } }])],
    ["getMultipleAccounts without an encoding", call("getMultipleAccounts", [[address()], {}])],
    ["getMultipleAccounts with a dataSlice and jsonParsed", call("getMultipleAccounts", [[address()], { encoding: "jsonParsed", dataSlice: { offset: 0, length: 10 } }])],
    ["getAccountInfo base58", call("getAccountInfo", [address(), { encoding: "base58" }])],
    ["getAccountInfo base64+zstd", call("getAccountInfo", [address(), { encoding: "base64+zstd" }])],
    ["getAccountInfo with no config", call("getAccountInfo", [address()])],
    ["getAccountInfo dataSlice 5000", call("getAccountInfo", [address(), { encoding: "base64", dataSlice: { offset: 0, length: 5000 } }])],
    ["getAccountInfo with a 31-byte key", call("getAccountInfo", [base58Encode(new Uint8Array(31).fill(3)), { encoding: "base64" }])],
    ["simulateTransaction with accounts", call("simulateTransaction", [wire(100), { encoding: "base64", accounts: { addresses: [address()], encoding: "base64" } }])],
    ["simulateTransaction base58", call("simulateTransaction", [wire(100), { encoding: "base58" }])],
    ["simulateTransaction with no config", call("simulateTransaction", [wire(100)])],
    ["simulateTransaction sigVerify and replaceRecentBlockhash", call("simulateTransaction", [wire(100), { encoding: "base64", sigVerify: true, replaceRecentBlockhash: true }])],
    ["simulateTransaction of 1645 characters", call("simulateTransaction", ["A".repeat(1645), { encoding: "base64" }])],
    ["simulateTransaction of 1233 bytes", call("simulateTransaction", [wire(1233), { encoding: "base64" }])],
    ["getFeeForMessage not base64", call("getFeeForMessage", ["not base64!"])],
    ["getSignatureStatuses searchTransactionHistory true", call("getSignatureStatuses", [[signature()], { searchTransactionHistory: true }])],
    ["getSignatureStatuses with 11 signatures", call("getSignatureStatuses", [Array.from({ length: 11 }, signature)])],
    ["getSignatureStatuses with a key instead of a signature", call("getSignatureStatuses", [[address()]])],
    ["getTokenAccountsByOwner with a programId filter", call("getTokenAccountsByOwner", [address(), { programId: TOKEN_PROGRAM }, { encoding: "jsonParsed" }])],
    ["getTokenAccountsByOwner with two filters", call("getTokenAccountsByOwner", [address(), { mint: address(), programId: TOKEN_PROGRAM }, { encoding: "jsonParsed" }])],
    ["getTokenAccountsByOwner without an encoding", call("getTokenAccountsByOwner", [address(), { mint: address() }, {}])],
    ["getBalance with an unknown config key", call("getBalance", [address(), { commitment: "confirmed", foo: 1 }])],
    ["getLatestBlockhash with a bad commitment", call("getLatestBlockhash", [{ commitment: "max" }])],
    ["getMinimumBalanceForRentExemption of 10241", call("getMinimumBalanceForRentExemption", [10_241])],
    ["getGenesisHash with a parameter", call("getGenesisHash", [1])],
    ["params as an object", { jsonrpc: "2.0", id: 1, method: "getSlot", params: { commitment: "confirmed" } }],
  ])("%s", (_, entry) => {
    expectRefused(entry, 400, -32602);
  });
});

describe("the JSON-RPC envelope (400 -32600)", () => {
  it.each([
    ["jsonrpc 1.0", { jsonrpc: "1.0", id: 1, method: "getSlot", params: [] }],
    ["a null id", call("getSlot", [], null)],
    ["a missing id", { jsonrpc: "2.0", method: "getSlot", params: [] }],
    ["a fractional id", call("getSlot", [], 1.5)],
    ["an unsafe integer id", call("getSlot", [], 2 ** 60)],
    ["an overlong id", call("getSlot", [], "x".repeat(129))],
    ["an extra member", { ...call("getSlot", []), extra: true }],
    ["a non-string method", { jsonrpc: "2.0", id: 1, method: 5 }],
    ["an array entry", [1, 2]],
  ])("%s", (_, entry) => {
    expectRefused(entry, 400, -32600);
  });
});

describe("whole bodies", () => {
  it("refuses an empty batch (400) and a batch of 11 (413)", () => {
    expect(checkRelayBody([])).toMatchObject({ ok: false, status: 400 });
    expect(checkRelayBody(Array.from({ length: 11 }, (_, i) => call("getSlot", [], i)))).toMatchObject({ ok: false, status: 413 });
  });

  it("forwards the validated call, not the caller's text: a duplicate method key reaches upstream once, as getSlot", () => {
    const parsed = JSON.parse('{"jsonrpc":"2.0","id":1,"method":"sendTransaction","params":[],"method":"getSlot"}') as unknown;
    const checked = checkRelayBody(parsed);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.forwardBody).toBe('{"jsonrpc":"2.0","id":1,"method":"getSlot","params":[]}');
    expect(checked.forwardBody).not.toContain("sendTransaction");
  });

  it("sums weights per pool and re-serialises a batch as a batch", () => {
    const checked = checkRelayBody([
      call("simulateTransaction", [wire(100), { encoding: "base64" }], "a"),
      call("getMultipleAccounts", [[address()], { encoding: "base64" }], "b"),
      call("getLatestBlockhash", [], "c"),
    ]);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.weight).toBe(6);
    expect(checked.poolWeights).toEqual({ signing: 4, reads: 2 });
    expect(Array.isArray(JSON.parse(checked.forwardBody))).toBe(true);
    expect(checked.methods).toEqual(["simulateTransaction", "getMultipleAccounts", "getLatestBlockhash"]);
  });

  it("reports the refusing call's id and method", () => {
    const checked = checkRelayBody([call("getSlot", [], "ok"), call("sendTransaction", ["x"], "bad")]);
    expect(checked).toMatchObject({ ok: false, status: 403, id: "bad", method: "sendTransaction" });
  });
});

describe("response caps", () => {
  it("pins each method's answer cap, in KiB", () => {
    const table = Object.fromEntries(Object.entries(RELAY_METHODS).map(([name, method]) => [name, method.maxResponseBytes / 1024]));
    expect(table).toEqual({
      getLatestBlockhash: 64,
      getFeeForMessage: 64,
      simulateTransaction: 256,
      getTokenAccountsByOwner: 256,
      getGenesisHash: 64,
      getBalance: 64,
      getAccountInfo: 256,
      getMultipleAccounts: 512,
      getMinimumBalanceForRentExemption: 64,
      getTokenAccountBalance: 64,
      getSignatureStatuses: 64,
      getSlot: 64,
      getBlockHeight: 64,
      isBlockhashValid: 64,
    });
    expect(checkRelayCall(call("getAccountInfo", [address(), { encoding: "base64" }]))).toMatchObject({ ok: true, maxResponseBytes: 256 * 1024 });
  });

  it("a body's cap is its calls' caps summed, never above the relay's", () => {
    expect(checkRelayBody(call("getAccountInfo", [address(), { encoding: "base64" }]))).toMatchObject({ ok: true, maxResponseBytes: 256 * 1024 });
    expect(checkRelayBody([call("getLatestBlockhash", [], "a"), call("getMultipleAccounts", [[address()], { encoding: "base64" }], "b")])).toMatchObject({
      ok: true,
      maxResponseBytes: (64 + 512) * 1024,
    });
    const heavy = checkRelayBody(Array.from({ length: 10 }, (_, i) => call("getMultipleAccounts", [[address()], { encoding: "base64" }], i)));
    expect(heavy).toMatchObject({ ok: true, maxResponseBytes: RELAY_MAX_RESPONSE_BYTES });
  });
});
