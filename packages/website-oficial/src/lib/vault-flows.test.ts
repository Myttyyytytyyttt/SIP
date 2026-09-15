// The vault flows with Privy's calls as vi.fn, over a fake server that runs the
// real core builders and the send route's real verifier. Every key is
// Keypair.generate(); nothing reaches a network.

import { createPrivateKey, sign } from "node:crypto";

import {
  DEFAULT_VAULT_POLICY,
  OWNER_TX_MICROLAMPORTS,
  SIP_PROGRAM_ID,
  base58Encode,
  base64Encode,
  encodeSetComputeUnitPrice,
  linkConsentMessage,
  ownerComputeBudget,
  splitWire,
  toHex,
  tryBase64Decode,
  type ComputeBudget,
  type ConfirmOutcome,
} from "@sip/solana-core/client";
import {
  LinkConsentError,
  buildCreateVaultV2,
  buildLinkWallet,
  deriveConfigPda,
  deriveLinkPda,
  deriveVaultPda,
  prepareLinkWalletConsent,
  verifySignedTransaction,
} from "@sip/solana-core/server";
import { Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";

import { LIGHTHOUSE_PROGRAM } from "@/lib/tx-intent";
import type { ApiFailure, ApiResult, SendResponseJson, VaultApi } from "@/lib/vault-api";
import { LINK_MAX_BUILDS, checkAgainFlow, createVaultFlow, linkWalletFlow, type FlowStep } from "@/lib/vault-flows";
import { deriveConfigAddress, deriveLinkAddress, deriveVaultAddress } from "@/lib/vault-pda";

function signBytes(signer: Keypair, message: Uint8Array): Uint8Array {
  const privateKey = createPrivateKey({
    key: { kty: "OKP", crv: "Ed25519", d: Buffer.from(signer.secretKey.subarray(0, 32)).toString("base64url"), x: Buffer.from(signer.publicKey.toBytes()).toString("base64url") },
    format: "jwk",
  });
  return Uint8Array.from(sign(null, message, privateKey));
}

/** What a wallet's signTransaction does: its signature in its own slot, the others kept. */
function signWith(bytes: Uint8Array, signer: Keypair): Uint8Array {
  const tx = VersionedTransaction.deserialize(bytes);
  tx.sign([signer]);
  return Uint8Array.from(tx.serialize());
}

function replaceBytes(haystack: Uint8Array, needle: Uint8Array, replacement: Uint8Array): Uint8Array {
  for (let at = 0; at + needle.length <= haystack.length; at++) {
    if (needle.every((byte, offset) => haystack[at + offset] === byte)) {
      const out = haystack.slice();
      out.set(replacement, at);
      return out;
    }
  }
  throw new Error("the bytes to replace are not there");
}

/** Phantom's documented rewrite: another priority price, the same length. */
const withPrice = (bytes: Uint8Array, microLamports: bigint): Uint8Array => replaceBytes(bytes, encodeSetComputeUnitPrice(OWNER_TX_MICROLAMPORTS), encodeSetComputeUnitPrice(microLamports));

/** A Lighthouse assertion appended to the message, as Phantom may do, signed by the owner. */
function withLighthouse(bytes: Uint8Array, owner: Keypair): Uint8Array {
  const message = TransactionMessage.decompile(VersionedTransaction.deserialize(bytes).message);
  message.instructions.push(new TransactionInstruction({ programId: new PublicKey(LIGHTHOUSE_PROGRAM), keys: [], data: Buffer.from([1]) }));
  const tx = new VersionedTransaction(message.compileToLegacyMessage());
  tx.sign([owner]);
  return Uint8Array.from(tx.serialize());
}

const asJson = <T>(value: unknown): T => JSON.parse(JSON.stringify(value, (_key, item: unknown) => (typeof item === "bigint" ? item.toString() : item))) as T;
const ok = <T>(body: T): ApiResult<T> => ({ ok: true, status: 200, body });
const failure = (status: number, code: string, body: Record<string, unknown> = {}): ApiFailure => ({
  ok: false,
  status,
  code,
  message: typeof body.message === "string" ? body.message : "",
  retryAfterSeconds: null,
  body: { code, ...body },
});

let blockhashes = 0;
function recent(): { blockhash: string; lastValidBlockHeight: number } {
  blockhashes += 1;
  return { blockhash: base58Encode(Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + blockhashes) & 0xff)), lastValidBlockHeight: 1_000 };
}

function harness() {
  const owner = Keypair.generate();
  const trading = Keypair.generate();
  const pensionKey = owner.publicKey.toBase58();
  const tradingAddress = trading.publicKey.toBase58();
  const order: string[] = [];
  const steps: FlowStep[] = [];

  const createVault = (fields: { owner?: string; maxContribution?: bigint; computeBudget?: ComputeBudget | undefined } = {}) =>
    asJson(
      buildCreateVaultV2({
        ...DEFAULT_VAULT_POLICY,
        owner: fields.owner ?? pensionKey,
        maxContribution: fields.maxContribution ?? DEFAULT_VAULT_POLICY.maxContribution,
        ...recent(),
        ...("computeBudget" in fields ? (fields.computeBudget === undefined ? {} : { computeBudget: fields.computeBudget }) : { computeBudget: ownerComputeBudget("create_vault_v2") }),
      }),
    );

  const build = vi.fn(async (body: Readonly<Record<string, unknown>>): Promise<ApiResult<unknown>> => {
    order.push(`build:${String(body.action)}`);
    if (body.action === "createVault") return ok(createVault());
    if (body.action === "prepareLink") return ok(asJson(prepareLinkWalletConsent({ owner: String(body.owner), wallet: String(body.wallet) })));
    if (body.action === "link") {
      try {
        return ok(
          asJson(
            buildLinkWallet({ owner: String(body.owner), wallet: String(body.wallet), consentSignature: String(body.consentSignature), ...recent(), computeBudget: ownerComputeBudget("link_wallet") }),
          ),
        );
      } catch (error) {
        if (error instanceof LinkConsentError) return failure(422, "link_consent_invalid", { message: "Your trading wallet's signature does not match SIP's link consent." });
        throw error;
      }
    }
    return failure(400, "bad_request");
  });
  const send = vi.fn(async (signed: Uint8Array): Promise<ApiResult<SendResponseJson>> => {
    order.push("send");
    const verified = verifySignedTransaction(signed);
    if (!verified.ok) return failure(422, verified.reason, { message: verified.detail });
    return ok({ signature: verified.signature, slot: 9, unitsConsumed: 4_321, explorerUrl: `https://solscan.io/tx/${verified.signature}` });
  });
  const rpc = vi.fn(async () => {
    throw new Error("these tests inject confirm and isBlockhashValid");
  });
  const api = { build, send, rpc, state: vi.fn() } as unknown as VaultApi;

  const signWithPension = vi.fn(async (bytes: Uint8Array) => {
    order.push("pension");
    return signWith(bytes, owner);
  });
  const signMessageWithTrading = vi.fn(async (message: Uint8Array) => {
    order.push("consent");
    return signBytes(trading, message);
  });
  const signWithTrading = vi.fn(async (bytes: Uint8Array) => {
    order.push("trading");
    return signWith(bytes, trading);
  });
  const confirm = vi.fn(async (_signature: string, _lastValidBlockHeight: number): Promise<ConfirmOutcome> => ({ status: "confirmed", slot: 10 }));
  const isBlockhashValid = vi.fn(async (_blockhash: string) => true);
  const onStep = (step: FlowStep): void => {
    steps.push(step);
  };

  return {
    owner,
    trading,
    pensionKey,
    tradingAddress,
    order,
    steps,
    createVault,
    build,
    send,
    signWithPension,
    signMessageWithTrading,
    signWithTrading,
    confirm,
    isBlockhashValid,
    createDeps: { api, confirm, onStep, signers: { signWithPension } },
    linkDeps: { api, confirm, onStep, isBlockhashValid, pension: { signWithPension }, trading: { signMessageWithTrading, signWithTrading } },
    linkInput: { pensionKey, tradingAddress },
  };
}

type Harness = ReturnType<typeof harness>;

const builtTx = async (h: Harness, call: number): Promise<Uint8Array> => {
  const answer = (await h.build.mock.results[call]!.value) as { body: { txBase64: string } };
  return tryBase64Decode(answer.body.txBase64)!;
};

describe("the browser's addresses", () => {
  it("kit derives the same vault, link and config as the core's web3.js", async () => {
    const key = Keypair.generate().publicKey.toBase58();
    expect(await deriveVaultAddress(key)).toBe(deriveVaultPda(key).toBase58());
    expect(await deriveLinkAddress(key)).toBe(deriveLinkPda(key).toBase58());
    expect(await deriveConfigAddress()).toBe(deriveConfigPda().toBase58());
  });
});

describe("createVaultFlow", () => {
  it("builds, has Phantom sign exactly the built bytes, sends what Phantom returned, then confirms with the build's last valid height", async () => {
    const h = harness();
    const result = await createVaultFlow(h.createDeps, { pensionKey: h.pensionKey, mode: 0 });
    expect(result.ok).toBe(true);
    expect(h.order).toEqual(["build:createVault", "pension", "send"]);
    expect(h.build.mock.calls[0]![0]).toEqual({ action: "createVault", owner: h.pensionKey, mode: 0 });
    expect(toHex(h.signWithPension.mock.calls[0]![0])).toBe(toHex(await builtTx(h, 0)));
    expect(toHex(h.send.mock.calls[0]![0])).toBe(toHex(await h.signWithPension.mock.results[0]!.value));
    expect(h.confirm.mock.calls).toEqual([[result.ok ? result.signature : "", 1_000]]);
    expect(h.steps).toEqual(["preparing", "approve_pension", "sending", "confirming", "done"]);
    expect(result).toMatchObject({ explorerUrl: `https://solscan.io/tx/${result.ok ? result.signature : ""}`, slot: 10 });
  });

  it("sends the limits as decimal strings and checks the build against them", async () => {
    const h = harness();
    h.build.mockImplementationOnce(async () => ok(h.createVault({ maxContribution: 70_000_000n })));
    const result = await createVaultFlow(h.createDeps, { pensionKey: h.pensionKey, mode: 0, maxContribution: 70_000_000n });
    expect(result.ok).toBe(true);
    expect(h.build.mock.calls[0]![0]).toEqual({ action: "createVault", owner: h.pensionKey, mode: 0, maxContribution: "70000000" });
  });

  it.each<[string, (h: Harness) => unknown]>([
    ["another rule", (h) => h.createVault({ maxContribution: 70_000_000n })],
    ["another fee payer", (h) => h.createVault({ owner: Keypair.generate().publicKey.toBase58() })],
    ["a higher priority price", (h) => h.createVault({ computeBudget: { unitLimit: 60_000, microLamports: 5_000_000n } })],
    ["no compute budget", (h) => h.createVault({ computeBudget: undefined })],
    [
      "another vault",
      (h) => {
        const body = h.createVault() as { txBase64: string };
        const forged = replaceBytes(tryBase64Decode(body.txBase64)!, deriveVaultPda(h.pensionKey).toBytes(), Keypair.generate().publicKey.toBytes());
        return { ...body, txBase64: base64Encode(forged) };
      },
    ],
  ])("a build with %s is refused before Phantom is asked", async (_, forge) => {
    const h = harness();
    h.build.mockImplementationOnce(async () => ok(forge(h)));
    const result = await createVaultFlow(h.createDeps, { pensionKey: h.pensionKey, mode: 0 });
    expect(result).toMatchObject({ ok: false, kind: "refused" });
    expect(!result.ok && result.message).toContain("Nothing was signed.");
    expect(h.signWithPension).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });

  it("without Phantom connected, refuses with words and makes no request", async () => {
    const h = harness();
    const result = await createVaultFlow({ ...h.createDeps, signers: { refusal: "Phantom is not connected to this page. Open Phantom, unlock it, and reload." } }, { pensionKey: h.pensionKey, mode: 0 });
    expect(result).toEqual({ ok: false, kind: "refused", message: "Phantom is not connected to this page. Open Phantom, unlock it, and reload." });
    expect(h.build).not.toHaveBeenCalled();
  });

  it("a fee Phantom rewrote is tolerated; an instruction Phantom added is refused by name before sending; a declined approval sends nothing", async () => {
    const rewritten = harness();
    rewritten.signWithPension.mockImplementationOnce(async (bytes) => signWith(withPrice(bytes, 250_000n), rewritten.owner));
    expect((await createVaultFlow(rewritten.createDeps, { pensionKey: rewritten.pensionKey, mode: 0 })).ok).toBe(true);

    const lighthouse = harness();
    lighthouse.signWithPension.mockImplementationOnce(async (bytes) => withLighthouse(bytes, lighthouse.owner));
    const refused = await createVaultFlow(lighthouse.createDeps, { pensionKey: lighthouse.pensionKey, mode: 0 });
    expect(refused).toMatchObject({ ok: false, kind: "refused" });
    expect(!refused.ok && refused.message).toContain(`Lighthouse (${LIGHTHOUSE_PROGRAM})`);
    expect(lighthouse.send).not.toHaveBeenCalled();

    const declined = harness();
    declined.signWithPension.mockRejectedValueOnce(new Error("User rejected the request."));
    expect(await createVaultFlow(declined.createDeps, { pensionKey: declined.pensionKey, mode: 0 })).toEqual({ ok: false, kind: "refused", message: "Phantom did not approve. Nothing was sent." });
    expect(declined.send).not.toHaveBeenCalled();
  });

  it("an expired blockhash is 'took too long'; a refusal from the verifier is words; a confirmation that cannot finish is 'not confirmed yet' with the signature", async () => {
    const expired = harness();
    expired.send.mockResolvedValueOnce(failure(422, "simulation_failed", { err: "BlockhashNotFound", logs: [] }));
    expect(await createVaultFlow(expired.createDeps, { pensionKey: expired.pensionKey, mode: 0 })).toMatchObject({ ok: false, kind: "expired" });

    const program = harness();
    program.send.mockResolvedValueOnce(failure(422, "program_not_allowed"));
    expect(await createVaultFlow(program.createDeps, { pensionKey: program.pensionKey, mode: 0 })).toMatchObject({ ok: false, kind: "refused", code: "program_not_allowed" });

    const pending = harness();
    pending.confirm.mockRejectedValueOnce(new Error("Rate limited"));
    const result = await createVaultFlow(pending.createDeps, { pensionKey: pending.pensionKey, mode: 0 });
    expect(result).toMatchObject({ ok: false, kind: "unconfirmed", lastValidBlockHeight: 1_000 });
    const signature = result.ok || result.kind !== "unconfirmed" ? "" : result.signature;
    expect(signature.length).toBeGreaterThan(80);
    const again = await checkAgainFlow({ api: {} as VaultApi, confirm: async () => ({ status: "confirmed", slot: 11 }) }, { signature, lastValidBlockHeight: 1_000 });
    expect(again).toMatchObject({ ok: true, signature, slot: 11 });
  });
});

describe("linkWalletFlow", () => {
  it("refuses the pension key as its own trading wallet with no request and no wallet call at all", async () => {
    const h = harness();
    const result = await linkWalletFlow(h.linkDeps, { pensionKey: h.pensionKey, tradingAddress: h.pensionKey });
    expect(result).toMatchObject({ ok: false, kind: "refused", message: "A trading wallet cannot be your pension key." });
    for (const call of [h.build, h.send, h.signWithPension, h.signMessageWithTrading, h.signWithTrading, h.isBlockhashValid]) expect(call).not.toHaveBeenCalled();
  });

  it("the consent, then the build; Phantom signs first; the trading wallet co-signs the bytes Phantom returned; one send; confirmed", async () => {
    const h = harness();
    const result = await linkWalletFlow(h.linkDeps, h.linkInput);
    expect(result).toMatchObject({ ok: true, consentSignature: null });
    expect(h.order).toEqual(["build:prepareLink", "consent", "build:link", "pension", "trading", "send"]);
    const vault = deriveVaultPda(h.pensionKey).toBase58();
    expect(toHex(h.signMessageWithTrading.mock.calls[0]![0])).toBe(toHex(linkConsentMessage({ programId: SIP_PROGRAM_ID, wallet: h.tradingAddress, vault, owner: h.pensionKey })));
    expect(toHex(h.signWithPension.mock.calls[0]![0])).toBe(toHex(await builtTx(h, 1)));
    expect(toHex(h.signWithTrading.mock.calls[0]![0])).toBe(toHex(await h.signWithPension.mock.results[0]!.value));
    expect(h.steps).toEqual(["preparing", "approve_pension", "trading_signing", "sending", "confirming", "done"]);
  });

  it.each<[string, (h: Harness) => unknown]>([
    [
      "one byte of the consent changed",
      (h) => {
        const real = prepareLinkWalletConsent({ owner: h.pensionKey, wallet: h.tradingAddress });
        const bytes = tryBase64Decode(real.consentMessageBase64)!;
        bytes[139] = bytes[139]! ^ 1;
        return { ...real, consentMessageBase64: base64Encode(bytes) };
      },
    ],
    [
      "a vault that is not the pension key's",
      (h) => {
        const vault = Keypair.generate().publicKey.toBase58();
        return { ...prepareLinkWalletConsent({ owner: h.pensionKey, wallet: h.tradingAddress }), vault, consentMessageBase64: base64Encode(linkConsentMessage({ programId: SIP_PROGRAM_ID, wallet: h.tradingAddress, vault, owner: h.pensionKey })) };
      },
    ],
    ["the owner and the wallet swapped", (h) => prepareLinkWalletConsent({ owner: h.tradingAddress, wallet: h.pensionKey })],
  ])("a consent with %s is refused before the trading wallet signs anything", async (_, forge) => {
    const h = harness();
    h.build.mockImplementationOnce(async () => ok(asJson(forge(h))));
    const result = await linkWalletFlow(h.linkDeps, h.linkInput);
    expect(result).toMatchObject({
      ok: false,
      kind: "refused",
      message: "The server asked your trading wallet to sign something that is not this link's consent. Nothing was signed.",
    });
    expect(h.signMessageWithTrading).not.toHaveBeenCalled();
    expect(h.signWithPension).not.toHaveBeenCalled();
  });

  it("a fee Phantom rewrote is co-signed as Phantom returned it, and the link verifies", async () => {
    const h = harness();
    h.signWithPension.mockImplementationOnce(async (bytes) => {
      h.order.push("pension");
      return signWith(withPrice(bytes, 200_000n), h.owner);
    });
    const result = await linkWalletFlow(h.linkDeps, h.linkInput);
    expect(result.ok).toBe(true);
    const phantomReturned = (await h.signWithPension.mock.results[0]!.value) as Uint8Array;
    expect(toHex(splitWire(phantomReturned).message)).not.toBe(toHex(splitWire(await builtTx(h, 1)).message));
    expect(toHex(h.signWithTrading.mock.calls[0]![0])).toBe(toHex(phantomReturned));
  });

  it("a 64-byte answer from the trading wallet is spliced into slot 1 of Phantom's bytes", async () => {
    const h = harness();
    h.signWithTrading.mockImplementationOnce(async (bytes) => signBytes(h.trading, splitWire(bytes).message));
    const result = await linkWalletFlow(h.linkDeps, h.linkInput);
    expect(result.ok).toBe(true);
    const sent = h.send.mock.calls[0]![0];
    expect(toHex(splitWire(sent).signatures[1]!)).toBe(toHex(await h.signWithTrading.mock.results[0]!.value));
    expect(toHex(splitWire(sent).signatures[0]!)).toBe(toHex(splitWire(await h.signWithPension.mock.results[0]!.value).signatures[0]!));
  });

  it("a trading wallet that signed another message, or Phantom adding Lighthouse, is refused before anything is sent", async () => {
    const other = harness();
    other.signWithTrading.mockImplementationOnce(async (bytes) => signWith(signWith(withPrice(bytes, 300_000n), other.owner), other.trading));
    expect(await linkWalletFlow(other.linkDeps, other.linkInput)).toMatchObject({ ok: false, kind: "refused", message: "Your trading wallet signed a different transaction than Phantom approved. Nothing was sent." });
    expect(other.send).not.toHaveBeenCalled();

    const lighthouse = harness();
    lighthouse.signWithPension.mockImplementationOnce(async (bytes) => withLighthouse(bytes, lighthouse.owner));
    const refused = await linkWalletFlow(lighthouse.linkDeps, lighthouse.linkInput);
    expect(!refused.ok && refused.message).toContain("Phantom added an instruction for Lighthouse");
    expect(lighthouse.signWithTrading).not.toHaveBeenCalled();
    expect(lighthouse.send).not.toHaveBeenCalled();
  });

  it("an expired blockhash before sending rebuilds with the same consent: one consent, two approvals each", async () => {
    const h = harness();
    h.isBlockhashValid.mockResolvedValueOnce(false);
    const result = await linkWalletFlow(h.linkDeps, h.linkInput);
    expect(result.ok).toBe(true);
    expect(h.order).toEqual(["build:prepareLink", "consent", "build:link", "pension", "trading", "build:link", "pension", "trading", "send"]);
    expect([h.signMessageWithTrading.mock.calls.length, h.signWithPension.mock.calls.length, h.signWithTrading.mock.calls.length]).toEqual([1, 2, 2]);
  });

  it("a simulation's BlockhashNotFound rebuilds too, within the same limit", async () => {
    const h = harness();
    h.send.mockImplementationOnce(async () => {
      h.order.push("send");
      return failure(422, "simulation_failed", { err: "BlockhashNotFound", logs: [] });
    });
    const result = await linkWalletFlow(h.linkDeps, h.linkInput);
    expect(result.ok).toBe(true);
    expect([h.signMessageWithTrading.mock.calls.length, h.signWithPension.mock.calls.length, h.send.mock.calls.length]).toEqual([1, 2, 2]);
  });

  it(`after ${LINK_MAX_BUILDS} builds it stops with words, keeps the consent, and a second try reuses it`, async () => {
    const h = harness();
    h.isBlockhashValid.mockResolvedValue(false);
    const first = await linkWalletFlow(h.linkDeps, h.linkInput);
    expect(first).toMatchObject({ ok: false, kind: "expired", message: "Solana's approval window passed twice. Try again when ready." });
    expect(first.consentSignature).toHaveLength(64);
    expect(h.signWithPension).toHaveBeenCalledTimes(LINK_MAX_BUILDS);
    expect(h.send).not.toHaveBeenCalled();

    h.isBlockhashValid.mockResolvedValue(true);
    const second = await linkWalletFlow(h.linkDeps, { ...h.linkInput, consentSignature: first.consentSignature });
    expect(second.ok).toBe(true);
    expect(h.signMessageWithTrading).toHaveBeenCalledTimes(1);
  });

  it("a send the endpoint never acknowledged is confirmed by its signature, and nobody signs again", async () => {
    const h = harness();
    h.send.mockImplementationOnce(async (signed) => {
      const verified = verifySignedTransaction(signed);
      if (!verified.ok) throw new Error(verified.detail);
      return failure(502, "send_unconfirmed", { signature: verified.signature });
    });
    const result = await linkWalletFlow(h.linkDeps, h.linkInput);
    expect(result.ok).toBe(true);
    expect(h.confirm).toHaveBeenCalledTimes(1);
    expect([h.signWithPension.mock.calls.length, h.signWithTrading.mock.calls.length, h.send.mock.calls.length]).toEqual([1, 1, 1]);
  });

  it("a consent the server says the trading wallet did not sign is refused with its words and not kept", async () => {
    const h = harness();
    h.signMessageWithTrading.mockImplementationOnce(async (message) => signBytes(Keypair.generate(), message));
    const result = await linkWalletFlow(h.linkDeps, h.linkInput);
    expect(result).toMatchObject({ ok: false, kind: "refused", code: "link_consent_invalid", consentSignature: null });
    expect(h.signWithPension).not.toHaveBeenCalled();
  });

  it("a trading wallet this session does not hold is refused before any request", async () => {
    const h = harness();
    const result = await linkWalletFlow({ ...h.linkDeps, trading: { refusal: "This trading wallet is not ready in this session. Reload the page, then try again." } }, h.linkInput);
    expect(result).toMatchObject({ ok: false, kind: "refused" });
    expect(h.build).not.toHaveBeenCalled();
  });
});
