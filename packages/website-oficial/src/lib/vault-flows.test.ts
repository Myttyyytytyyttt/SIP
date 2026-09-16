// The vault flows with Privy's calls as vi.fn, over a fake server that runs the
// real core builders and the send route's real verifier. Every key is
// Keypair.generate(); nothing reaches a network.

import { createPrivateKey, sign } from "node:crypto";

import {
  DEFAULT_VAULT_POLICY,
  OWNER_TX_MICROLAMPORTS,
  RAYDIUM_CLMM,
  SIP_PROGRAM_ID,
  SPYX_MINT,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  USDC_MINT,
  WSOL_MINT,
  base58Encode,
  base64Encode,
  encodeSetComputeUnitPrice,
  floorWad,
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
  buildSetInvestPolicy,
  buildWithdraw,
  buildWithdrawToken,
  deriveAta,
  deriveConfigPda,
  deriveInvestPda,
  deriveLinkPda,
  deriveVaultPda,
  prepareLinkWalletConsent,
  verifySignedTransaction,
} from "@sip/solana-core/server";
import { Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";

import { LIGHTHOUSE_PROGRAM } from "@/lib/tx-intent";
import { WITHDRAW_COPY } from "@/lib/vault-copy";
import type { ApiFailure, ApiResult, BuiltTransactionJson, InvestmentPolicyJson, SendResponseJson, VaultApi } from "@/lib/vault-api";
import { LINK_MAX_BUILDS, checkAgainFlow, createVaultFlow, investPolicyFlow, linkWalletFlow, pauseInvestingFlow, withdrawFlow, withdrawTokenFlow, type FlowStep } from "@/lib/vault-flows";
import { deriveAtaAddress, deriveConfigAddress, deriveInvestAddress, deriveLinkAddress, deriveVaultAddress } from "@/lib/vault-pda";

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
        if (error instanceof LinkConsentError) return failure(422, "link_consent_invalid", { message: "Your trading wallet's signature does not match SaverFi's link consent." });
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

  it("kit derives the same investment policy and associated token accounts, for the vault and for the pension key, under both token programs", async () => {
    const owner = Keypair.generate().publicKey.toBase58();
    const vault = deriveVaultPda(owner).toBase58();
    expect(await deriveInvestAddress(vault)).toBe(deriveInvestPda(vault).toBase58());
    for (const [mint, program] of [
      [WSOL_MINT, TOKEN_PROGRAM],
      [USDC_MINT, TOKEN_PROGRAM],
      [SPYX_MINT, TOKEN_2022_PROGRAM],
    ] as const) {
      expect(await deriveAtaAddress(vault, mint, program)).toBe(deriveAta(vault, mint, program).toBase58());
      expect(await deriveAtaAddress(owner, mint, program)).toBe(deriveAta(owner, mint, program).toBase58());
    }
  });
});

// ── the policy and the withdrawals ───────────────────────────────────────────

/** The pools' rates at mainnet slot 447313239, and SIP's floors under them. */
const LIVE_CONVERT = 100_038_711_555_492_562n;
const LIVE_SPYX = 131_283_650_130_637_569n;
const CONVERT_FLOOR = floorWad(LIVE_CONVERT, 1_000);
const SPYX_FLOOR = floorWad(LIVE_SPYX, 500);
const POLICY_TARGETS = [
  { mint: WSOL_MINT, tokenProgram: TOKEN_PROGRAM },
  { mint: USDC_MINT, tokenProgram: TOKEN_PROGRAM },
  { mint: SPYX_MINT, tokenProgram: TOKEN_2022_PROGRAM },
] as const;

interface PolicyForge {
  readonly maxPerCall?: bigint;
  readonly maxRolling30d?: bigint;
  readonly enabled?: boolean;
  /** What the transaction carries; the answer's floors stay the honest ones unless `floors` rewrites them. */
  readonly legFloor?: bigint;
  readonly convertFloor?: bigint;
  readonly create?: readonly boolean[];
  readonly floors?: (floors: Record<string, unknown>) => Record<string, unknown>;
}

type Answer = Record<string, unknown> & { readonly txBase64: string };

/** What the build route answers for investPolicy, the transaction from the core builder. */
function policyAnswer(owner: string, forge: PolicyForge = {}): Answer {
  const create = forge.create ?? [true, true, true];
  const vault = deriveVaultPda(owner).toBase58();
  const built = buildSetInvestPolicy({
    owner,
    legs: [{ mint: SPYX_MINT, weightBps: 10_000, minOutRateWad: forge.legFloor ?? SPYX_FLOOR }],
    minConvertRateWad: forge.convertFloor ?? CONVERT_FLOOR,
    minInvestment: 5_000_000n,
    maxPerCall: forge.maxPerCall ?? 1_000_000_000n,
    maxRolling30d: forge.maxRolling30d ?? 31_000_000_000n,
    enabled: forge.enabled ?? true,
    ...recent(),
    computeBudget: ownerComputeBudget("set_invest_policy"),
    vaultTokenAccounts: POLICY_TARGETS.filter((_, index) => create[index]),
  });
  const floors: Record<string, unknown> = {
    slot: 1,
    marginBps: { convert: 1_000, leg: 500 },
    liveConvertWad: LIVE_CONVERT,
    convertWad: CONVERT_FLOOR,
    usdcRawPerSol: 100_038_711n,
    floorUsdcRawPerSol: 90_034_840n,
    legs: [{ symbol: "SPYx", mint: SPYX_MINT, liveWad: LIVE_SPYX, wad: SPYX_FLOOR, usdcRawPer1e8: 761_709_474n, maxUsdcRawPer1e8: 801_799_446n }],
  };
  return asJson<Answer>({
    ...built,
    policyExists: false,
    floors: forge.floors === undefined ? floors : forge.floors(floors),
    vaultTokenAccounts: POLICY_TARGETS.map((target, index) => ({ ...target, address: deriveAta(vault, target.mint, target.tokenProgram).toBase58(), create: create[index] })),
    costs: { rentLamports: 1n, signatureFeeLamports: 5_000n, priorityFeeLamports: 30_000n, policyRentLamports: 1n, tokenAccountRentLamports: 0n },
    warnings: [],
  });
}

/** The same unsigned transaction with instruction `index`'s account metas edited, recompiled. */
function withInstructionKeys(txBase64: string, index: number, edit: (keys: TransactionInstruction["keys"]) => TransactionInstruction["keys"]): string {
  const message = TransactionMessage.decompile(VersionedTransaction.deserialize(tryBase64Decode(txBase64)!).message);
  const instruction = message.instructions[index]!;
  message.instructions[index] = new TransactionInstruction({ programId: instruction.programId, keys: edit(instruction.keys), data: Buffer.from(instruction.data) });
  return base64Encode(new VersionedTransaction(message.compileToLegacyMessage()).serialize());
}

/** A web3.js key of this package, from a key of the core's copy. */
const here = (key: { toBase58(): string }): PublicKey => new PublicKey(key.toBase58());

describe("investPolicyFlow", () => {
  it("builds with the caps asked, checks the floors and the vault's own token accounts, shows the checked answer, has Phantom sign the built bytes, and sends", async () => {
    const h = harness();
    const shown: BuiltTransactionJson[] = [];
    h.build.mockImplementationOnce(async (body) => {
      h.order.push(`build:${String(body.action)}`);
      return ok(policyAnswer(h.pensionKey, { maxPerCall: 10_000_000n, maxRolling30d: 50_000_000n }));
    });
    const result = await investPolicyFlow({ ...h.createDeps, onBuilt: (body) => shown.push(body) }, { pensionKey: h.pensionKey, maxPerCall: 10_000_000n, maxRolling30d: 50_000_000n });
    expect(result.ok).toBe(true);
    expect(h.order).toEqual(["build:investPolicy", "pension", "send"]);
    expect(h.build.mock.calls[0]![0]).toEqual({ action: "investPolicy", owner: h.pensionKey, maxPerCall: "10000000", maxRolling30d: "50000000" });
    expect(shown).toHaveLength(1);
    expect(toHex(h.signWithPension.mock.calls[0]![0])).toBe(toHex(await builtTx(h, 0)));
    expect(h.steps).toEqual(["preparing", "approve_pension", "sending", "confirming", "done"]);
  });

  it("pausing sends enabled false and no caps, and expects the product's caps with no token account to create", async () => {
    const h = harness();
    h.build.mockImplementationOnce(async () => ok(policyAnswer(h.pensionKey, { enabled: false, create: [false, false, false] })));
    const result = await investPolicyFlow(h.createDeps, { pensionKey: h.pensionKey, enabled: false });
    expect(result.ok).toBe(true);
    expect(h.build.mock.calls[0]![0]).toEqual({ action: "investPolicy", owner: h.pensionKey, enabled: false });
  });

  it.each<[string, (h: Harness) => Answer]>([
    ["a SPYx floor lower than the answer shows", (h) => policyAnswer(h.pensionKey, { legFloor: SPYX_FLOOR - 1n })],
    ["a cap the person did not choose", (h) => policyAnswer(h.pensionKey, { maxPerCall: 2_000_000_000n })],
    ["floors that are not SaverFi's margins under the prices read", (h) => policyAnswer(h.pensionKey, { convertFloor: LIVE_CONVERT / 2n, floors: (floors) => ({ ...floors, convertWad: LIVE_CONVERT / 2n }) })],
    ["a SOL floor of zero, which would turn conversion off", (h) => policyAnswer(h.pensionKey, { convertFloor: 0n, floors: (floors) => ({ ...floors, convertWad: 0n, liveConvertWad: 0n }) })],
    ["a basket that is not SaverFi's", (h) => policyAnswer(h.pensionKey, { floors: (floors) => ({ ...floors, legs: [] }) })],
    [
      "a token account paid by another key",
      (h) => {
        const answer = policyAnswer(h.pensionKey);
        return { ...answer, txBase64: withInstructionKeys(answer.txBase64, 2, (keys) => keys.map((meta, at) => (at === 0 ? { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true } : meta))) };
      },
    ],
    [
      "a token account for another owner's vault",
      (h) => {
        const answer = policyAnswer(h.pensionKey);
        const otherVault = deriveVaultPda(Keypair.generate().publicKey.toBase58());
        const theirs = deriveAta(otherVault, WSOL_MINT, TOKEN_PROGRAM);
        const txBase64 = withInstructionKeys(answer.txBase64, 2, (keys) =>
          keys.map((meta, at) => (at === 1 ? { ...meta, pubkey: here(theirs) } : at === 2 ? { ...meta, pubkey: here(otherVault) } : meta)),
        );
        return { ...answer, txBase64 };
      },
    ],
    [
      "token accounts listed under another program",
      (h) => {
        const answer = policyAnswer(h.pensionKey);
        const listed = answer.vaultTokenAccounts as { tokenProgram: string }[];
        return { ...answer, vaultTokenAccounts: listed.map((entry, index) => (index === 1 ? { ...entry, tokenProgram: TOKEN_2022_PROGRAM } : entry)) };
      },
    ],
    [
      "a token account created that the answer does not list",
      (h) => {
        const answer = policyAnswer(h.pensionKey);
        const listed = answer.vaultTokenAccounts as { create: boolean }[];
        return { ...answer, vaultTokenAccounts: listed.map((entry, index) => (index === 0 ? { ...entry, create: false } : entry)) };
      },
    ],
  ])("a build with %s is refused before Phantom is asked", async (_, forge) => {
    const h = harness();
    h.build.mockImplementationOnce(async () => ok(forge(h)));
    const result = await investPolicyFlow(h.createDeps, { pensionKey: h.pensionKey });
    expect(result).toMatchObject({ ok: false, kind: "refused" });
    expect(!result.ok && result.message).toContain("Nothing was signed.");
    expect(h.signWithPension).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });

  it("Phantom dropping a token account creation is refused before anything is sent", async () => {
    const h = harness();
    h.build.mockImplementationOnce(async () => ok(policyAnswer(h.pensionKey)));
    h.signWithPension.mockImplementationOnce(async (bytes) => {
      const message = TransactionMessage.decompile(VersionedTransaction.deserialize(bytes).message);
      message.instructions.splice(2, 1);
      const tx = new VersionedTransaction(message.compileToLegacyMessage());
      tx.sign([h.owner]);
      return Uint8Array.from(tx.serialize());
    });
    const result = await investPolicyFlow(h.createDeps, { pensionKey: h.pensionKey });
    expect(result).toMatchObject({ ok: false, kind: "refused" });
    expect(!result.ok && result.message).toContain("Nothing was sent.");
    expect(h.send).not.toHaveBeenCalled();
  });
});

describe("pauseInvestingFlow", () => {
  /** The policy the screen shows: floors and caps that are not the product's, so nothing here is derived from a price. */
  const shownPolicy = (vault: string, fields: Partial<InvestmentPolicyJson> = {}): InvestmentPolicyJson => ({
    vault,
    enabled: true,
    venueProgram: RAYDIUM_CLMM,
    inMint: USDC_MINT,
    legs: [{ mint: SPYX_MINT, weightBps: 10_000, minOutRateWad: "111" }],
    minConvertRateWad: "222",
    minInvestment: "5000000",
    maxPerCall: "10000000",
    maxRolling30d: "50000000",
    bucketDays: new Array<number>(31).fill(0),
    bucketAmounts: new Array<string>(31).fill("0"),
    lifetimeInvested: "0",
    policyNonce: "3",
    ...fields,
  });
  const pauseAnswer = (owner: string, forge: { legFloor?: bigint; convertFloor?: bigint; maxPerCall?: bigint; enabled?: boolean } = {}): Answer =>
    asJson<Answer>({
      ...buildSetInvestPolicy({
        owner,
        legs: [{ mint: SPYX_MINT, weightBps: 10_000, minOutRateWad: forge.legFloor ?? 111n }],
        minConvertRateWad: forge.convertFloor ?? 222n,
        minInvestment: 5_000_000n,
        maxPerCall: forge.maxPerCall ?? 10_000_000n,
        maxRolling30d: 50_000_000n,
        enabled: forge.enabled ?? false,
        ...recent(),
        computeBudget: ownerComputeBudget("set_invest_policy"),
      }),
      policyExists: true,
      costs: { rentLamports: 0n, signatureFeeLamports: 5_000n, priorityFeeLamports: 30_000n },
    });

  it("asks for the pause by owner alone, then has Phantom sign the policy on screen with investing off, and sends", async () => {
    const h = harness();
    h.build.mockImplementationOnce(async () => ok(pauseAnswer(h.pensionKey)));
    const result = await pauseInvestingFlow(h.createDeps, { pensionKey: h.pensionKey, policy: shownPolicy(deriveVaultPda(h.pensionKey).toBase58()) });
    expect(result.ok).toBe(true);
    expect(h.build.mock.calls[0]![0]).toEqual({ action: "pauseInvesting", owner: h.pensionKey });
    expect(toHex(h.signWithPension.mock.calls[0]![0])).toBe(toHex(await builtTx(h, 0)));
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it.each<[string, (owner: string) => Answer]>([
    ["a SPYx floor other than the one on screen", (owner) => pauseAnswer(owner, { legFloor: 110n })],
    ["a SOL floor other than the one on screen", (owner) => pauseAnswer(owner, { convertFloor: 223n })],
    ["a cap other than the one on screen", (owner) => pauseAnswer(owner, { maxPerCall: 20_000_000n })],
    ["investing left on", (owner) => pauseAnswer(owner, { enabled: true })],
  ])("a build with %s is refused before Phantom is asked", async (_, forge) => {
    const h = harness();
    h.build.mockImplementationOnce(async () => ok(forge(h.pensionKey)));
    const result = await pauseInvestingFlow(h.createDeps, { pensionKey: h.pensionKey, policy: shownPolicy(deriveVaultPda(h.pensionKey).toBase58()) });
    expect(result).toMatchObject({ ok: false, kind: "refused" });
    expect(!result.ok && result.message).toContain("Nothing was signed.");
    expect(h.signWithPension).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });

  it("a policy on screen that belongs to another vault, or does not read as amounts, is refused before Phantom is asked", async () => {
    for (const policy of [shownPolicy(deriveVaultPda(Keypair.generate().publicKey.toBase58()).toBase58()), (vault: string) => shownPolicy(vault, { maxPerCall: "ten" })] as const) {
      const h = harness();
      h.build.mockImplementationOnce(async () => ok(pauseAnswer(h.pensionKey)));
      const shown = typeof policy === "function" ? policy(deriveVaultPda(h.pensionKey).toBase58()) : policy;
      const result = await pauseInvestingFlow(h.createDeps, { pensionKey: h.pensionKey, policy: shown });
      expect(result).toMatchObject({ ok: false, kind: "refused" });
      expect(h.signWithPension).not.toHaveBeenCalled();
    }
  });
});

describe("withdrawFlow and withdrawTokenFlow", () => {
  const withdrawAnswer = (owner: string, lamports: bigint) => asJson<Answer>({ ...buildWithdraw({ owner, lamports, ...recent(), computeBudget: ownerComputeBudget("withdraw") }), withdrawableLamports: 200_000_000n });
  const tokenAnswer = (owner: string, fields: { mint?: string; tokenProgram?: string; amountRaw?: bigint; vaultToken: string }) =>
    asJson<Answer>(
      buildWithdrawToken({
        owner,
        mint: fields.mint ?? SPYX_MINT,
        tokenProgram: fields.tokenProgram ?? TOKEN_2022_PROGRAM,
        amountRaw: fields.amountRaw ?? 12_345_678n,
        vaultToken: fields.vaultToken,
        ...recent(),
        computeBudget: ownerComputeBudget("withdraw_token"),
      }),
    );

  it("withdraw: the lamports asked, as a decimal string, found in the built bytes, signed and sent", async () => {
    const h = harness();
    h.build.mockImplementationOnce(async () => ok(withdrawAnswer(h.pensionKey, 150_000_000n)));
    const result = await withdrawFlow(h.createDeps, { pensionKey: h.pensionKey, lamports: 150_000_000n });
    expect(result.ok).toBe(true);
    expect(h.build.mock.calls[0]![0]).toEqual({ action: "withdraw", owner: h.pensionKey, lamports: "150000000" });
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it("withdraw: a build for one lamport more than asked is refused before Phantom is asked", async () => {
    const h = harness();
    h.build.mockImplementationOnce(async () => ok(withdrawAnswer(h.pensionKey, 150_000_001n)));
    const result = await withdrawFlow(h.createDeps, { pensionKey: h.pensionKey, lamports: 150_000_000n });
    expect(result).toMatchObject({ ok: false, kind: "refused" });
    expect(h.signWithPension).not.toHaveBeenCalled();
  });

  it("withdraw: the program's 6004 after the build checked the amount says the SOL moved, most likely into investing, in simulation and on chain, with a code the screen refreshes on", async () => {
    const vaultBelowRent = { InstructionError: [2, { Custom: 6004 }] };
    const simulated = harness();
    simulated.build.mockImplementationOnce(async () => ok(withdrawAnswer(simulated.pensionKey, 150_000_000n)));
    simulated.send.mockImplementationOnce(async () => failure(422, "simulation_failed", { err: vaultBelowRent, logs: ["Program log: AnchorError occurred. Error Code: InsufficientVaultBalance."] }));
    const refusedInSimulation = await withdrawFlow(simulated.createDeps, { pensionKey: simulated.pensionKey, lamports: 150_000_000n });
    expect(refusedInSimulation).toEqual({ ok: false, kind: "refused", message: WITHDRAW_COPY.balanceMoved, code: "balance_moved" });

    const landedFailed = harness();
    landedFailed.build.mockImplementationOnce(async () => ok(withdrawAnswer(landedFailed.pensionKey, 150_000_000n)));
    landedFailed.confirm.mockImplementationOnce(async () => ({ status: "failed", slot: 11, err: vaultBelowRent }));
    const failedOnChain = await withdrawFlow(landedFailed.createDeps, { pensionKey: landedFailed.pensionKey, lamports: 150_000_000n });
    expect(failedOnChain).toEqual({ ok: false, kind: "refused", message: WITHDRAW_COPY.balanceMoved, code: "balance_moved" });

    // Only a withdrawal says so: the same error on another write keeps the program's words.
    const created = harness();
    created.send.mockImplementationOnce(async () => failure(422, "simulation_failed", { err: vaultBelowRent, logs: [] }));
    expect(await createVaultFlow(created.createDeps, { pensionKey: created.pensionKey, mode: 0 })).toMatchObject({ ok: false, kind: "refused", message: "That would leave the vault below its rent reserve." });
  });

  it("withdrawToken: from the vault account the screen showed, into the pension key's own associated account, the amount asked", async () => {
    const h = harness();
    const holding = Keypair.generate().publicKey.toBase58();
    h.build.mockImplementationOnce(async () => ok(tokenAnswer(h.pensionKey, { vaultToken: holding })));
    const result = await withdrawTokenFlow(h.createDeps, { pensionKey: h.pensionKey, mint: SPYX_MINT, amountRaw: 12_345_678n, vaultTokenAccount: holding, tokenProgram: TOKEN_2022_PROGRAM });
    expect(result.ok).toBe(true);
    expect(h.build.mock.calls[0]![0]).toEqual({ action: "withdrawToken", owner: h.pensionKey, mint: SPYX_MINT, amountRaw: "12345678", vaultToken: holding });
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it.each<[string, (owner: string, holding: string) => Answer]>([
    ["another amount", (owner, holding) => tokenAnswer(owner, { vaultToken: holding, amountRaw: 12_345_677n })],
    ["another source account", (owner) => tokenAnswer(owner, { vaultToken: Keypair.generate().publicKey.toBase58() })],
    ["another mint", (owner, holding) => tokenAnswer(owner, { vaultToken: holding, mint: USDC_MINT, tokenProgram: TOKEN_PROGRAM })],
  ])("withdrawToken: a build with %s is refused before Phantom is asked", async (_, forge) => {
    const h = harness();
    const holding = Keypair.generate().publicKey.toBase58();
    h.build.mockImplementationOnce(async () => ok(forge(h.pensionKey, holding)));
    const result = await withdrawTokenFlow(h.createDeps, { pensionKey: h.pensionKey, mint: SPYX_MINT, amountRaw: 12_345_678n, vaultTokenAccount: holding, tokenProgram: TOKEN_2022_PROGRAM });
    expect(result).toMatchObject({ ok: false, kind: "refused" });
    expect(!result.ok && result.message).toContain("Nothing was signed.");
    expect(h.signWithPension).not.toHaveBeenCalled();
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

  it("a pension key short of SOL is told to add SOL, with the rent and fees the build quoted, or without a figure when the build quoted none", async () => {
    const rentShort = { err: { InstructionError: [2, { Custom: 1 }] }, logs: ["Transfer: insufficient lamports 1000000, need 1760880"] };
    const quoted = harness();
    quoted.build.mockImplementationOnce(async () => ok({ ...(quoted.createVault() as Record<string, unknown>), costs: { rentLamports: "1760880", signatureFeeLamports: "5000", priorityFeeLamports: "6000" } }));
    quoted.send.mockImplementationOnce(async () => failure(422, "simulation_failed", rentShort));
    expect(await createVaultFlow(quoted.createDeps, { pensionKey: quoted.pensionKey, mode: 0 })).toEqual({
      ok: false,
      kind: "refused",
      message: "Your pension key needs more SOL: this action costs about 0.00177188 SOL in rent and fees. Add SOL in Phantom, then try again. Nothing moved.",
      code: "simulation_failed",
    });

    const unquoted = harness();
    unquoted.send.mockImplementationOnce(async () => failure(422, "simulation_failed", { err: "InsufficientFundsForFee", logs: [] }));
    expect(await createVaultFlow(unquoted.createDeps, { pensionKey: unquoted.pensionKey, mode: 0 })).toMatchObject({
      ok: false,
      kind: "refused",
      message: "Your pension key does not hold enough SOL for this action's rent and fees. Add SOL in Phantom, then try again. Nothing moved.",
    });
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

    // Its own slot only, over another message, Phantom's slot left empty: only the message comparison can refuse this.
    const alone = harness();
    alone.signWithTrading.mockImplementationOnce(async (bytes) => {
      const rewritten = withPrice(bytes, 300_000n);
      rewritten.fill(0, 1, 65);
      return signWith(rewritten, alone.trading);
    });
    expect(await linkWalletFlow(alone.linkDeps, alone.linkInput)).toMatchObject({ ok: false, kind: "refused", message: "Your trading wallet signed a different transaction than Phantom approved. Nothing was sent." });
    expect(alone.send).not.toHaveBeenCalled();

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
