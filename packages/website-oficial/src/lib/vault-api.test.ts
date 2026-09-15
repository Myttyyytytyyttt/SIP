// The vault client's requests, and every failure it can meet in words.

import { VERIFY_REFUSALS } from "@sip/solana-core/server";
import { describe, expect, it, vi } from "vitest";

import { RpcCallError, createVaultApi, programErrorWords, transactionErrorWords, vaultFailureWords, type ApiFailure } from "@/lib/vault-api";
import { FAILURE_COPY } from "@/lib/vault-copy";

const failure = (code: string, body: Record<string, unknown> = {}, status = 422, message = ""): ApiFailure => ({ ok: false, status, code, message, retryAfterSeconds: null, body });
const instructionError = (custom: number) => ({ InstructionError: [2, { Custom: custom }] });

describe("words", () => {
  it.each([...VERIFY_REFUSALS])("the send route's refusal %s has its own words", (reason) => {
    const words = vaultFailureWords(failure(reason));
    expect(words).not.toBe(FAILURE_COPY.unknown);
    expect(words.length).toBeGreaterThan(20);
  });

  it.each([
    [6001, "This vault belongs to another pension key."],
    [6004, "That would leave the vault below its rent reserve."],
    [6005, "The vault holds less of this token than that."],
    [6006, "more than zero"],
    [6013, "refused this rule"],
    [6023, "SIP is paused for settling and investing. Withdrawals are not affected."],
    [6035, "A trading wallet cannot be your pension key."],
    [6036, "consent is missing"],
    [6037, "not this trading wallet"],
    [6038, "another program, wallet, vault or owner"],
  ])("program error %i", (code, words) => {
    expect(programErrorWords(code)).toContain(words);
    expect(vaultFailureWords(failure("simulation_failed", { err: instructionError(code), logs: [] }))).toContain(words);
  });

  it("a program error with no words of its own uses the IDL's message; an unknown one says its number", () => {
    expect(programErrorWords(6029)).toBe("Mode must be 0 (profit) or 1 (volume).");
    expect(programErrorWords(1)).toContain("error 1");
  });

  it("the token issuers' freeze and pause, read from the logs; SIP's own pause is not the issuer's", () => {
    expect(transactionErrorWords(instructionError(0x11), ["Program TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb failed: custom program error: 0x11"])).toBe(
      "The issuer has frozen this token account. SOL withdrawals still work.",
    );
    expect(transactionErrorWords(null, ["Program log: Error: Account is frozen"])).toBe(FAILURE_COPY.frozen);
    expect(transactionErrorWords(instructionError(0x43), ["Program log: Transferring, minting, and burning is paused on this mint"])).toBe(
      "The issuer has paused SPYx transfers.",
    );
    expect(transactionErrorWords(instructionError(6023), ["Program log: AnchorError occurred. Error Message: the protocol is paused."])).toContain(
      "Withdrawals are not affected",
    );
  });

  it("an account that exists, an expired blockhash, a rate limit and an unreachable server", () => {
    expect(transactionErrorWords(instructionError(0), ["Allocate: account Address { address: X, base: None } already in use"])).toBe("It already exists. Refreshing.");
    expect(vaultFailureWords(failure("simulation_failed", { err: "BlockhashNotFound", logs: [] }))).toBe(FAILURE_COPY.blockhashExpired);
    expect(vaultFailureWords({ ...failure("rate_limited", {}, 429), retryAfterSeconds: 12 })).toBe("Too many requests just now. Try again in 12 s.");
    expect(vaultFailureWords(failure("network", {}, 0))).toBe(FAILURE_COPY.network);
    expect(vaultFailureWords(failure("unreadable", {}, 502))).toBe("SIP could not read Solana just now. Nothing was offered to sign.");
  });

  it("the build route's refusals are shown as its words; an invalid rule lists its problems", () => {
    expect(vaultFailureWords(failure("config_missing", {}, 409, "Linking opens once SIP's program is configured on Solana."))).toBe("Linking opens once SIP's program is configured on Solana.");
    expect(vaultFailureWords(failure("invalid_policy", { problems: ["maxContribution must be a u64 greater than zero"] }, 400, "The program would refuse this vault rule."))).toBe(
      "The program would refuse this vault rule. MaxContribution must be a u64 greater than zero.",
    );
  });
});

describe("createVaultApi", () => {
  it("posts JSON to this app's routes under the given origin and reads the answer", async () => {
    const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ txBase64: "AA==" }), { status: 200 }));
    const api = createVaultApi({ origin: "http://localhost:3015/", fetch: fetch as unknown as typeof globalThis.fetch });
    const built = await api.build({ action: "createVault", owner: "x", mode: 0 });
    expect(built).toEqual({ ok: true, status: 200, body: { txBase64: "AA==" } });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("http://localhost:3015/api/solana-build");
    expect(init).toMatchObject({ method: "POST", headers: { "content-type": "application/json" } });
    expect(JSON.parse(String(init?.body))).toEqual({ action: "createVault", owner: "x", mode: 0 });

    await api.send(Uint8Array.from([1, 2, 3]));
    expect(fetch.mock.calls[1]![0]).toBe("http://localhost:3015/api/solana-tx");
    expect(JSON.parse(String(fetch.mock.calls[1]![1]?.body))).toEqual({ action: "send", signedTxBase64: "AQID" });
    await api.state({ owner: "o", wallets: ["w"] });
    expect(JSON.parse(String(fetch.mock.calls[2]![1]?.body))).toEqual({ action: "state", owner: "o", wallets: ["w"] });
  });

  it("a refusal keeps its code, message, body and retry-after; no answer at all is a network failure", async () => {
    const limited = createVaultApi({
      fetch: (async () =>
        new Response(JSON.stringify({ error: { code: "rate_limited", message: "Too many requests from this client. Retry in 7 s.", retryAfterSeconds: 7 } }), {
          status: 429,
          headers: { "retry-after": "7" },
        })) as typeof globalThis.fetch,
    });
    expect(await limited.build({ action: "createVault" })).toMatchObject({ ok: false, status: 429, code: "rate_limited", retryAfterSeconds: 7 });
    const down = createVaultApi({
      fetch: (async () => {
        throw new TypeError("Failed to fetch");
      }) as typeof globalThis.fetch,
    });
    expect(await down.send(new Uint8Array(1))).toMatchObject({ ok: false, status: 0, code: "network" });
    await expect(down.rpc("getBlockHeight", [])).rejects.toThrow(RpcCallError);
  });

  it("rpc resolves a JSON-RPC result and throws its error", async () => {
    const answers = [{ jsonrpc: "2.0", id: 1, result: { value: true } }, { jsonrpc: "2.0", id: 1, error: { code: -32005, message: "Rate limited. Retry in 2 s." } }];
    const api = createVaultApi({ fetch: (async () => new Response(JSON.stringify(answers.shift()), { status: 200 })) as typeof globalThis.fetch });
    expect(await api.rpc("isBlockhashValid", ["x", { commitment: "confirmed" }])).toEqual({ value: true });
    await expect(api.rpc("getBlockHeight", [])).rejects.toThrow("Rate limited. Retry in 2 s.");
  });
});
