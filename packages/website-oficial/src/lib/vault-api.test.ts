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
    [6023, "SaverFi is paused for settling and investing. Withdrawals are not affected."],
    [6035, "A trading wallet cannot be your pension key."],
    [6036, "consent is missing"],
    [6037, "not this trading wallet"],
    [6038, "another program, wallet, vault or owner"],
  ])("program error %i", (code, words) => {
    expect(programErrorWords(code)).toContain(words);
    expect(vaultFailureWords(failure("simulation_failed", { err: instructionError(code), logs: [] }))).toContain(words);
  });

  it("a failure at a position the bytes sent hold a Lighthouse check is Phantom's check, whatever its code, ahead of SaverFi's instructions or after them; any other position, and no positions given, keeps the program's words", () => {
    const at = (index: number, custom: number) => ({ InstructionError: [index, { Custom: custom }] });
    // [budget pair, a leading check, withdraw, two trailing checks]. Lighthouse's AssertionFailed is 6001 and a Multi's failed assertion 6400 + i: SaverFi's range, or past it.
    const walletGuards = [2, 4, 5];
    for (const err of [at(2, 6001), at(2, 6400), at(4, 6400), at(5, 1)]) {
      expect(transactionErrorWords(err, [], { walletGuards })).toBe(FAILURE_COPY.walletGuardFailed);
      expect(vaultFailureWords(failure("simulation_failed", { err, logs: [] }), { walletGuards })).toBe(FAILURE_COPY.walletGuardFailed);
    }
    // SaverFi's own instruction after a leading block, and the instructions before it.
    for (const index of [3, 1]) expect(transactionErrorWords(at(index, 6001), [], { walletGuards })).toBe("This vault belongs to another pension key.");
    expect(transactionErrorWords(at(3, 6001), [], { walletGuards: [] })).toBe("This vault belongs to another pension key.");
    expect(transactionErrorWords(at(3, 6001), [])).toBe("This vault belongs to another pension key.");
    expect(transactionErrorWords("BlockhashNotFound", [], { walletGuards })).toBe(FAILURE_COPY.blockhashExpired);
  });

  it("a program error with no words of its own uses the IDL's message; an unknown one says its number", () => {
    expect(programErrorWords(6029)).toBe("Mode must be 0 (profit) or 1 (volume).");
    expect(programErrorWords(1)).toContain("error 1");
  });

  it("the token issuers' freeze and pause, read from the logs; SaverFi's own pause is not the issuer's", () => {
    expect(transactionErrorWords(instructionError(0x11), ["Program TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb failed: custom program error: 0x11"])).toBe(
      "The issuer has frozen this token account. SOL withdrawals still work.",
    );
    expect(transactionErrorWords(null, ["Program log: Error: Account is frozen"])).toBe(FAILURE_COPY.frozen);
    // The log names no mint, and the basket now holds two stocks with two
    // different issuers, so the words may not pick one of them.
    expect(transactionErrorWords(instructionError(0x43), ["Program log: Transferring, minting, and burning is paused on this mint"])).toBe(
      "The issuer has paused transfers of that stock.",
    );
    expect(transactionErrorWords(instructionError(6023), ["Program log: AnchorError occurred. Error Message: the protocol is paused."])).toContain(
      "Withdrawals are not affected",
    );
  });

  it("a pension key short of SOL is told to add SOL, with what the action costs when known: rent the System program could not take, a fee, rent for the fee payer, or no account at all", () => {
    const needsSol = (cost: string) => `Your pension key needs more SOL: this action costs about ${cost} SOL in rent and fees. Add SOL in Phantom, then try again. Nothing moved.`;
    const withoutCost = "Your pension key does not hold enough SOL for this action's rent and fees. Add SOL in Phantom, then try again. Nothing moved.";
    const rentShort = { InstructionError: [2, { Custom: 1 }] };
    const rentLogs = ["Program 11111111111111111111111111111111 invoke [2]", "Transfer: insufficient lamports 1000000, need 1760880", "Program 11111111111111111111111111111111 failed: custom program error: 0x1"];
    expect(transactionErrorWords(rentShort, rentLogs, { costLamports: 1_771_880n })).toBe(needsSol("0.00177188"));
    expect(vaultFailureWords(failure("simulation_failed", { err: rentShort, logs: rentLogs }), { costLamports: 1_771_880n })).toBe(needsSol("0.00177188"));
    expect(transactionErrorWords(rentShort, rentLogs)).toBe(withoutCost);
    for (const err of ["InsufficientFundsForFee", "AccountNotFound", { InsufficientFundsForRent: { account_index: 0 } }]) {
      expect(vaultFailureWords(failure("simulation_failed", { err, logs: [] }), { costLamports: 11_000n })).toBe(needsSol("0.000011"));
    }
    // SPL Token's own error 1 is a token balance, not SOL: it keeps the program's words.
    expect(transactionErrorWords(rentShort, ["Program log: Error: insufficient funds"])).not.toContain("Add SOL");
  });

  it("an account that exists, an expired blockhash, a rate limit and an unreachable server", () => {
    expect(transactionErrorWords(instructionError(0), ["Allocate: account Address { address: X, base: None } already in use"])).toBe("It already exists. Refreshing.");
    expect(vaultFailureWords(failure("simulation_failed", { err: "BlockhashNotFound", logs: [] }))).toBe(FAILURE_COPY.blockhashExpired);
    expect(vaultFailureWords({ ...failure("rate_limited", {}, 429), retryAfterSeconds: 12 })).toBe("Too many requests just now. Try again in 12 s.");
    expect(vaultFailureWords(failure("network", {}, 0))).toBe(FAILURE_COPY.network);
    expect(vaultFailureWords(failure("unreadable", {}, 502))).toBe("SaverFi could not read Solana just now. Nothing was offered to sign.");
  });

  it.each([
    ["zero_amount", 400, "The amount must be more than zero."],
    ["above_withdrawable", 422, "That is more than the vault can release: it keeps its rent reserve."],
    ["not_held", 422, "Your vault holds none of this token."],
    ["above_holding", 422, "Your vault holds less of this token than that."],
    ["price_unavailable", 502, "SaverFi could not read today's prices from Raydium, so no floor was set. Nothing was built."],
    ["mint_unexpected", 409, "A token this policy names is not held by the token program SaverFi expects. Nothing was built."],
  ])("the build route's %s is shown as its own words", (code, status, message) => {
    expect(vaultFailureWords(failure(code, {}, status, message))).toBe(message);
  });

  it("the build route's refusals are shown as its words; an invalid rule lists its problems", () => {
    expect(vaultFailureWords(failure("config_missing", {}, 409, "Linking opens once SaverFi's program is configured on Solana."))).toBe("Linking opens once SaverFi's program is configured on Solana.");
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
