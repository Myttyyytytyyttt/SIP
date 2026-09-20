// The vault flows with Privy's calls as vi.fn, over a fake server that runs the
// real core builders and the send route's real verifier. Every key is
// Keypair.generate(); nothing reaches a network.

import { createPrivateKey, sign } from "node:crypto";

import {
  ANTHROPIC_MINT,
  DEFAULT_VAULT_POLICY,
  LIGHTHOUSE_PROGRAM,
  MAX_WALLET_GUARDS,
  MEMO_PROGRAM,
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
import { ComputeBudgetProgram, Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";

import { FAILURE_COPY, WITHDRAW_COPY } from "@/lib/vault-copy";
import type { ApiFailure, ApiResult, BuiltTransactionJson, InvestmentPolicyJson, SendResponseJson, VaultApi } from "@/lib/vault-api";
import {
  LINK_MAX_BUILDS,
  awaitsConfirmation,
  checkAgainFlow,
  createVaultFlow,
  investPolicyFlow,
  linkWalletFlow,
  pauseInvestingFlow,
  withdrawFlow,
  withdrawTokenFlow,
  type FlowResult,
  type FlowStep,
} from "@/lib/vault-flows";
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

/** Another priority price, the same length: a rewrite Phantom does not document for a transaction that carries one. */
const withPrice = (bytes: Uint8Array, microLamports: bigint): Uint8Array => replaceBytes(bytes, encodeSetComputeUnitPrice(OWNER_TX_MICROLAMPORTS), encodeSetComputeUnitPrice(microLamports));

// ── Phantom's mainnet rewrite ────────────────────────────────────────────────
// Lighthouse checks in the exact shapes Phantom was seen adding on mainnet
// (packages/solana-core/test/phantom-rewrite.ts cites the transactions), with
// this test's amounts and accounts.

const LIGHTHOUSE = new PublicKey(LIGHTHOUSE_PROGRAM);
const u64le = (value: bigint): number[] => [...new Uint8Array(new BigUint64Array([value]).buffer)];
const GUARD = {
  /** AssertAccountInfoMulti [Lamports >= min, KnownOwner == System, DataLength == 0]. */
  payer: (min: bigint): number[] => [6, 4, 3, 0, ...u64le(min), 4, 3, 0, 0, 1, ...u64le(0n), 0],
  /** AssertAccountInfoMulti [KnownOwner == System, DataLength == 0]. */
  system: (): number[] => [6, 4, 2, 3, 0, 0, 1, ...u64le(0n), 0],
  /** AssertTokenAccountMulti [Amount >= min, Delegate == None, DelegatedAmount <= 0, OwnerIsDerived]. */
  token: (min: bigint): number[] => [10, 4, 4, 2, ...u64le(min), 4, 3, 0, 0, 6, ...u64le(0n), 5, 8],
  /** AssertAccountInfoMulti [Owner == program]. */
  owner: (program: string): number[] => [6, 4, 1, 2, ...new PublicKey(program).toBytes(), 0],
  /** Ahead of the dapp's instructions: AssertAccountInfoMulti [Lamports == 0], on an account about to be created. */
  created: (): number[] => [6, 4, 1, 0, ...u64le(0n), 0],
  /** Ahead of the dapp's instructions: AssertTokenAccountMulti [Delegate == None, DelegatedAmount <= 0, OwnerIsDerived]. */
  pretoken: (): number[] => [10, 4, 3, 3, 0, 0, 6, ...u64le(0n), 5, 8],
};

/** A Lighthouse instruction checking `account`, read-only and unsigned as Phantom names it, unless `meta` says otherwise. */
const guard = (data: readonly number[], account: string, meta: { isSigner?: boolean; isWritable?: boolean; programId?: PublicKey } = {}): TransactionInstruction =>
  new TransactionInstruction({ programId: meta.programId ?? LIGHTHOUSE, keys: [{ pubkey: new PublicKey(account), isSigner: meta.isSigner ?? false, isWritable: meta.isWritable ?? false }], data: Buffer.from(data) });

interface Rewrite {
  readonly guards: readonly TransactionInstruction[];
  /** Where the guards go; after every instruction when absent. */
  readonly at?: number;
  /** Pre-state checks right after SaverFi's compute-budget pair (instruction 2), inserted after `guards`. */
  readonly leading?: readonly TransactionInstruction[];
  readonly edit?: (message: TransactionMessage) => void;
}

/** What Phantom returns for `bytes` on mainnet: the message decompiled, its checks inserted, compiled again, signed by `signer` alone. */
function phantomRewrite(bytes: Uint8Array, rewrite: Rewrite, signer: Keypair): Uint8Array {
  const message = TransactionMessage.decompile(VersionedTransaction.deserialize(bytes).message);
  message.instructions.splice(rewrite.at ?? message.instructions.length, 0, ...rewrite.guards);
  message.instructions.splice(2, 0, ...(rewrite.leading ?? []));
  rewrite.edit?.(message);
  const tx = new VersionedTransaction(message.compileToLegacyMessage());
  tx.sign([signer]);
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

/**
 * The pools' rates and SIP's floors under them. SOL's and SPYx's are the mainnet
 * readings at slot 447313239; ANTHROPIC's is the $180-a-token pool solana-core's
 * own fixture pins (test/chain-fixtures.ts, LEG_POOLS), written here as literals
 * so a rate is never re-derived by the functions under test.
 */
const LIVE_CONVERT = 100_038_711_555_492_562n;
const LIVE_SPYX = 131_283_650_130_637_569n;
const LIVE_ANTHROPIC = 5_555_555_555_555_555_556n;
const CONVERT_FLOOR = floorWad(LIVE_CONVERT, 1_000);
const SPYX_FLOOR = floorWad(LIVE_SPYX, 500);
const ANTHROPIC_FLOOR = floorWad(LIVE_ANTHROPIC, 500);

/**
 * The vault's own token accounts, in the order the page derives them: wSOL, USDC,
 * then each offered leg. FOUR, because the basket is SPYx and ANTHROPIC — the
 * page's tokenAccountCreates holds a build's list to exactly this shape.
 */
const POLICY_TARGETS = [
  { mint: WSOL_MINT, tokenProgram: TOKEN_PROGRAM },
  { mint: USDC_MINT, tokenProgram: TOKEN_PROGRAM },
  { mint: SPYX_MINT, tokenProgram: TOKEN_2022_PROGRAM },
  { mint: ANTHROPIC_MINT, tokenProgram: TOKEN_2022_PROGRAM },
] as const;

/** What the build route bundles today: the first BUNDLED_VAULT_TOKEN_ACCOUNT_CREATES missing accounts, the rest left to the keeper. */
const BUNDLED_CREATES = [true, true, false, false] as const;

/**
 * Three creations, which the relay still accepts (MAX_VAULT_TOKEN_ACCOUNT_CREATES
 * is 3) even though the route now bundles two: the wire the Lighthouse cases below
 * measure Phantom's blocks against.
 */
const THREE_CREATES = [true, true, true, false] as const;
const THREE_CREATED = POLICY_TARGETS.filter((_, index) => THREE_CREATES[index]);

interface PolicyForge {
  readonly maxPerCall?: bigint;
  readonly maxRolling30d?: bigint;
  readonly enabled?: boolean;
  /** What the transaction carries for SPYx, the first leg; the answer's floors stay the honest ones unless `floors` rewrites them. */
  readonly legFloor?: bigint;
  /** The same for ANTHROPIC, the second leg. */
  readonly anthropicFloor?: bigint;
  readonly convertFloor?: bigint;
  readonly create?: readonly boolean[];
  readonly floors?: (floors: Record<string, unknown>) => Record<string, unknown>;
}

type Answer = Record<string, unknown> & { readonly txBase64: string };

/** What the build route answers for investPolicy, the transaction from the core builder. */
function policyAnswer(owner: string, forge: PolicyForge = {}): Answer {
  const create = forge.create ?? BUNDLED_CREATES;
  const vault = deriveVaultPda(owner).toBase58();
  const built = buildSetInvestPolicy({
    owner,
    // basketWeightsBps(2), written out: equal halves of SaverFi's two legs.
    legs: [
      { mint: SPYX_MINT, weightBps: 5_000, minOutRateWad: forge.legFloor ?? SPYX_FLOOR },
      { mint: ANTHROPIC_MINT, weightBps: 5_000, minOutRateWad: forge.anthropicFloor ?? ANTHROPIC_FLOOR },
    ],
    minConvertRateWad: forge.convertFloor ?? CONVERT_FLOOR,
    // defaultInvestPolicy(2).minInvestment: the $5 purchase split across the legs, and enforced per leg.
    minInvestment: 2_500_000n,
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
    legs: [
      { symbol: "SPYx", mint: SPYX_MINT, liveWad: LIVE_SPYX, wad: SPYX_FLOOR, usdcRawPer1e8: 761_709_474n, maxUsdcRawPer1e8: 801_799_446n },
      { symbol: "ANTHROPIC", mint: ANTHROPIC_MINT, liveWad: LIVE_ANTHROPIC, wad: ANTHROPIC_FLOOR, usdcRawPer1e8: 18_000_000n, maxUsdcRawPer1e8: 18_947_369n },
    ],
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
    h.build.mockImplementationOnce(async () => ok(policyAnswer(h.pensionKey, { enabled: false, create: [false, false, false, false] })));
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

  /** The pool rates the form showed before the click, as /api/solana-vault answers them. */
  const shownPrices = (overrides: { readonly convertWad?: bigint; readonly legWad?: bigint; readonly anthropicWad?: bigint } = {}) => ({
    slot: 1,
    convertWad: (overrides.convertWad ?? LIVE_CONVERT).toString(),
    usdcRawPerSol: "100038711",
    legs: [
      { symbol: "SPYx", mint: SPYX_MINT, wad: (overrides.legWad ?? LIVE_SPYX).toString(), usdcRawPer1e8: "761709474" },
      { symbol: "ANTHROPIC", mint: ANTHROPIC_MINT, wad: (overrides.anthropicWad ?? LIVE_ANTHROPIC).toString(), usdcRawPer1e8: "18000000" },
    ],
  });

  /**
   * A build whose every margin holds and whose floors are worthless:
   * floorWad(2, 1000) and floorWad(2, 500) are both 1, so a live rate of 2 with
   * a floor of 1 passes each margin check while the bytes sign a SOL floor of
   * $0.00 and a SPYx ceiling of 1e20 per 100,000,000 raw units.
   */
  const forgedFloors = (h: Harness): Answer =>
    policyAnswer(h.pensionKey, {
      convertFloor: 1n,
      legFloor: 1n,
      anthropicFloor: 1n,
      floors: () => ({
        slot: 1,
        marginBps: { convert: 1_000, leg: 500 },
        liveConvertWad: 2n,
        convertWad: 1n,
        usdcRawPerSol: 100_038_711n,
        floorUsdcRawPerSol: 90_034_840n,
        legs: [
          { symbol: "SPYx", mint: SPYX_MINT, liveWad: 2n, wad: 1n, usdcRawPer1e8: 761_709_474n, maxUsdcRawPer1e8: 801_799_446n },
          { symbol: "ANTHROPIC", mint: ANTHROPIC_MINT, liveWad: 2n, wad: 1n, usdcRawPer1e8: 18_000_000n, maxUsdcRawPer1e8: 18_947_369n },
        ],
      }),
    });

  it("refuses a build whose rates are nowhere near the prices the form showed, before Phantom is asked", async () => {
    const h = harness();
    h.build.mockImplementationOnce(async () => ok(forgedFloors(h)));
    const result = await investPolicyFlow(h.createDeps, { pensionKey: h.pensionKey, shownPrices: shownPrices() });
    expect(result).toMatchObject({ ok: false, kind: "refused" });
    expect(!result.ok && result.message).toContain("far from the one this page showed you");
    expect(h.signWithPension).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });

  it("…and that same answer passes every margin, which is why the margins alone were not enough", async () => {
    const h = harness();
    h.build.mockImplementationOnce(async () => ok(forgedFloors(h)));
    // WHAT IS NOT FIXED, stated rather than implied: with no prices on screen
    // there is no second opinion, and the forged floors are signed. The margins
    // hold a floor to the rate the server REPORTS, never to a real market.
    const result = await investPolicyFlow(h.createDeps, { pensionKey: h.pensionKey, shownPrices: null });
    expect(result.ok).toBe(true);
  });

  it("a pool that moved a little between the form and the build is still signed", async () => {
    const h = harness();
    h.build.mockImplementationOnce(async () => ok(policyAnswer(h.pensionKey)));
    const moved = shownPrices({ convertWad: (LIVE_CONVERT * 102n) / 100n, legWad: (LIVE_SPYX * 98n) / 100n });
    const result = await investPolicyFlow(h.createDeps, { pensionKey: h.pensionKey, shownPrices: moved });
    expect(result.ok).toBe(true);
  });

  it("a SPYx rate far from the screen's is refused too, and says which price it was", async () => {
    const h = harness();
    h.build.mockImplementationOnce(async () => ok(policyAnswer(h.pensionKey)));
    const result = await investPolicyFlow(h.createDeps, { pensionKey: h.pensionKey, shownPrices: shownPrices({ legWad: LIVE_SPYX / 2n }) });
    expect(result).toMatchObject({ ok: false, kind: "refused" });
    expect(!result.ok && result.message).toContain("SPYx price it read is far");
    expect(h.signWithPension).not.toHaveBeenCalled();
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

  it("Phantom's Lighthouse check on the pension key is sent exactly as Phantom returned it, and verifies", async () => {
    const h = harness();
    h.signWithPension.mockImplementationOnce(async (bytes) => phantomRewrite(bytes, { guards: [guard(GUARD.payer(1_000_000n), h.pensionKey)] }, h.owner));
    const result = await createVaultFlow(h.createDeps, { pensionKey: h.pensionKey, mode: 0 });
    expect(result.ok).toBe(true);
    expect(toHex(h.send.mock.calls[0]![0])).toBe(toHex(await h.signWithPension.mock.results[0]!.value));
    expect(verifySignedTransaction(h.send.mock.calls[0]![0])).toMatchObject({ ok: true, instructions: expect.arrayContaining([{ program: LIGHTHOUSE_PROGRAM, name: "AssertAccountInfoMulti" }]) });
  });

  it("a fee Phantom rewrote is refused in its own words: Phantom documents no such rewrite of a transaction that carries its budget; a declined approval sends nothing", async () => {
    const rewritten = harness();
    rewritten.signWithPension.mockImplementationOnce(async (bytes) => signWith(withPrice(bytes, 250_000n), rewritten.owner));
    expect(await createVaultFlow(rewritten.createDeps, { pensionKey: rewritten.pensionKey, mode: 0 })).toEqual({
      ok: false,
      kind: "refused",
      message: FAILURE_COPY.signedMismatch("its compute budget changed"),
    });
    expect(rewritten.send).not.toHaveBeenCalled();

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
    // "consent" is its own step: a chained create-and-link has to name which wallet is being asked for what.
    expect(h.steps).toEqual(["preparing", "consent", "approve_pension", "trading_signing", "sending", "confirming", "done"]);
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

  /** Phantom's checks on a link: the pension key, the new trading link, the trading wallet. */
  const linkGuards = (h: Harness): TransactionInstruction[] => [
    guard(GUARD.payer(1_000_000n), h.pensionKey),
    guard(GUARD.owner(SIP_PROGRAM_ID), deriveLinkPda(h.tradingAddress).toBase58()),
    guard(GUARD.system(), h.tradingAddress),
  ];

  it("Phantom's Lighthouse checks are co-signed as Phantom returned them, the consent still right before link_wallet, and the link verifies", async () => {
    const h = harness();
    h.signWithPension.mockImplementationOnce(async (bytes) => {
      h.order.push("pension");
      return phantomRewrite(bytes, { guards: linkGuards(h) }, h.owner);
    });
    const result = await linkWalletFlow(h.linkDeps, h.linkInput);
    expect(result.ok).toBe(true);
    expect(h.order).toEqual(["build:prepareLink", "consent", "build:link", "pension", "trading", "send"]);
    const phantomReturned = (await h.signWithPension.mock.results[0]!.value) as Uint8Array;
    expect(toHex(splitWire(phantomReturned).message)).not.toBe(toHex(splitWire(await builtTx(h, 1)).message));
    expect(toHex(h.signWithTrading.mock.calls[0]![0])).toBe(toHex(phantomReturned));
    const sent = h.send.mock.calls[0]![0];
    expect(toHex(splitWire(sent).message)).toBe(toHex(splitWire(phantomReturned).message));
    expect(verifySignedTransaction(sent)).toMatchObject({ ok: true, signers: [h.pensionKey, h.tradingAddress] });
  });

  it("Phantom's two-signer rewrite, a check on the new trading link right after the compute budget: the trading wallet co-signs Phantom's message, the consent still right before link_wallet, and the relay verifies both signatures", async () => {
    for (const answer of ["transaction", "signature"] as const) {
      const h = harness();
      const tradingLink = deriveLinkPda(h.tradingAddress).toBase58();
      h.signWithPension.mockImplementationOnce(async (bytes) => {
        h.order.push("pension");
        return phantomRewrite(bytes, { leading: [guard(GUARD.created(), tradingLink)], guards: [guard(GUARD.payer(1_000_000n), h.pensionKey), guard(GUARD.owner(SIP_PROGRAM_ID), tradingLink)] }, h.owner);
      });
      if (answer === "signature") h.signWithTrading.mockImplementationOnce(async (bytes) => signBytes(h.trading, splitWire(bytes).message));
      const result = await linkWalletFlow(h.linkDeps, h.linkInput);
      expect(result.ok, `${answer}: ${result.ok ? "" : result.message}`).toBe(true);
      const phantomReturned = (await h.signWithPension.mock.results[0]!.value) as Uint8Array;
      expect(toHex(h.signWithTrading.mock.calls[0]![0])).toBe(toHex(phantomReturned));
      const sent = h.send.mock.calls[0]![0];
      expect(toHex(splitWire(sent).message)).toBe(toHex(splitWire(phantomReturned).message));
      expect(toHex(splitWire(sent).signatures[0]!)).toBe(toHex(splitWire(phantomReturned).signatures[0]!));
      const verified = verifySignedTransaction(sent);
      expect(verified.ok).toBe(true);
      if (!verified.ok) continue;
      expect(verified.signers).toEqual([h.pensionKey, h.tradingAddress]);
      expect(verified.instructions.map((instruction) => instruction.name)).toEqual([
        "SetComputeUnitLimit",
        "SetComputeUnitPrice",
        "AssertAccountInfoMulti",
        "Ed25519SigVerify",
        "link_wallet",
        "AssertAccountInfoMulti",
        "AssertAccountInfoMulti",
      ]);
    }
  });

  it("a 64-byte answer from the trading wallet is spliced into slot 1 of Phantom's bytes, as Phantom returned them or rewritten", async () => {
    for (const rewrite of [false, true]) {
      const h = harness();
      if (rewrite) h.signWithPension.mockImplementationOnce(async (bytes) => phantomRewrite(bytes, { guards: linkGuards(h) }, h.owner));
      h.signWithTrading.mockImplementationOnce(async (bytes) => signBytes(h.trading, splitWire(bytes).message));
      const result = await linkWalletFlow(h.linkDeps, h.linkInput);
      expect(result.ok).toBe(true);
      const sent = h.send.mock.calls[0]![0];
      expect(toHex(splitWire(sent).signatures[1]!)).toBe(toHex(await h.signWithTrading.mock.results[0]!.value));
      expect(toHex(splitWire(sent).signatures[0]!)).toBe(toHex(splitWire(await h.signWithPension.mock.results[0]!.value).signatures[0]!));
    }
  });

  it("a trading wallet that signed another message, or Phantom putting a Lighthouse check between the consent and link_wallet, is refused before anything is sent", async () => {
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
    lighthouse.signWithPension.mockImplementationOnce(async (bytes) => phantomRewrite(bytes, { guards: [guard(GUARD.payer(1n), lighthouse.pensionKey)], at: 3 }, lighthouse.owner));
    const refused = await linkWalletFlow(lighthouse.linkDeps, lighthouse.linkInput);
    expect(!refused.ok && refused.message).toBe(
      FAILURE_COPY.walletGuardRefused(
        "the Lighthouse instruction at position 4 stands before SaverFi's own instruction at position 5; Lighthouse checks are relayed only right after SaverFi's compute budget, or after all of SaverFi's instructions",
      ),
    );
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

describe("Phantom's Lighthouse checks, in the browser and at the relay", () => {
  const holding = Keypair.generate().publicKey.toBase58();
  const withdrawAnswer = (owner: string, lamports = 150_000_000n) => asJson<Answer>({ ...buildWithdraw({ owner, lamports, ...recent(), computeBudget: ownerComputeBudget("withdraw") }), withdrawableLamports: 200_000_000n });
  const tokenAnswer = (owner: string) =>
    asJson<Answer>(buildWithdrawToken({ owner, mint: SPYX_MINT, tokenProgram: TOKEN_2022_PROGRAM, amountRaw: 12_345_678n, vaultToken: holding, ...recent(), computeBudget: ownerComputeBudget("withdraw_token") }));
  const tokenInput = (h: Harness) => ({ pensionKey: h.pensionKey, mint: SPYX_MINT, amountRaw: 12_345_678n, vaultTokenAccount: holding, tokenProgram: TOKEN_2022_PROGRAM });

  /** Phantom signs with `rewrite` applied to what it was given. */
  const phantomSigns = (h: Harness, rewrite: (h: Harness) => Rewrite): void => {
    h.signWithPension.mockImplementationOnce(async (bytes) => {
      h.order.push("pension");
      return phantomRewrite(bytes, rewrite(h), h.owner);
    });
  };

  /** The flow, run against `h`: every owner flow whose bytes Phantom signs alone. */
  type Flow = (h: Harness) => Promise<{ ok: boolean; message?: string }>;
  const flows: Readonly<Record<string, { run: Flow; guards: (h: Harness) => TransactionInstruction[]; leading: (h: Harness) => TransactionInstruction[] }>> = {
    create_vault_v2: {
      run: (h) => createVaultFlow(h.createDeps, { pensionKey: h.pensionKey, mode: 0 }),
      guards: (h) => [guard(GUARD.payer(1_000_000n), h.pensionKey)],
      leading: (h) => [guard(GUARD.created(), deriveVaultPda(h.pensionKey).toBase58())],
    },
    // Phantom checks the accounts the transaction WRITES, so its blocks follow
    // THREE_CREATED, not every target: an account this build does not create is
    // not one SaverFi's instructions name.
    "set_invest_policy with three token-account creations": {
      run: (h) => {
        h.build.mockImplementationOnce(async () => ok(policyAnswer(h.pensionKey, { create: THREE_CREATES })));
        return investPolicyFlow(h.createDeps, { pensionKey: h.pensionKey });
      },
      guards: (h) => {
        const vault = deriveVaultPda(h.pensionKey);
        return [guard(GUARD.payer(1_000_000n), h.pensionKey), ...THREE_CREATED.map((target) => guard(GUARD.token(0n), deriveAta(vault, target.mint, target.tokenProgram).toBase58()))];
      },
      leading: (h) => {
        const vault = deriveVaultPda(h.pensionKey);
        return [deriveInvestPda(vault).toBase58(), ...THREE_CREATED.map((target) => deriveAta(vault, target.mint, target.tokenProgram).toBase58())].map((address) => guard(GUARD.created(), address));
      },
    },
    withdraw: {
      run: (h) => {
        h.build.mockImplementationOnce(async () => ok(withdrawAnswer(h.pensionKey)));
        return withdrawFlow(h.createDeps, { pensionKey: h.pensionKey, lamports: 150_000_000n });
      },
      guards: (h) => [guard(GUARD.payer(150_000_000n), h.pensionKey)],
      leading: (h) => [guard(GUARD.owner(SIP_PROGRAM_ID), deriveVaultPda(h.pensionKey).toBase58())],
    },
    withdraw_token: {
      run: (h) => {
        h.build.mockImplementationOnce(async () => ok(tokenAnswer(h.pensionKey)));
        return withdrawTokenFlow(h.createDeps, tokenInput(h));
      },
      guards: (h) => [guard(GUARD.payer(1_000_000n), h.pensionKey), guard(GUARD.token(12_345_678n), deriveAta(h.pensionKey, SPYX_MINT, TOKEN_2022_PROGRAM).toBase58())],
      leading: (h) => [guard(GUARD.pretoken(), holding), guard(GUARD.created(), deriveAta(h.pensionKey, SPYX_MINT, TOKEN_2022_PROGRAM).toBase58())],
    },
  };

  it.each(Object.keys(flows))("%s: Phantom's checks after SaverFi's instructions are accepted by the page, sent as Phantom returned them, and verified by the relay", async (name) => {
    const flow = flows[name]!;
    const h = harness();
    phantomSigns(h, (harnessed) => ({ guards: flow.guards(harnessed) }));
    const result = await flow.run(h);
    expect(result.ok, result.message).toBe(true);
    expect(h.send).toHaveBeenCalledTimes(1);
    const sent = h.send.mock.calls[0]![0];
    expect(toHex(sent)).toBe(toHex(await h.signWithPension.mock.results[0]!.value));
    const verified = verifySignedTransaction(sent);
    expect(verified.ok).toBe(true);
    if (verified.ok) expect(verified.instructions.filter((instruction) => instruction.program === LIGHTHOUSE_PROGRAM)).toHaveLength(flow.guards(h).length);
  });

  it.each(Object.keys(flows))("%s: Phantom's leading block right after the compute budget, one check on each account SaverFi writes besides the pension key, and its checks after, are accepted by the page, sent as Phantom returned them, and verified by the relay", async (name) => {
    const flow = flows[name]!;
    const h = harness();
    phantomSigns(h, (harnessed) => ({ leading: flow.leading(harnessed), guards: flow.guards(harnessed) }));
    const result = await flow.run(h);
    expect(result.ok, result.message).toBe(true);
    const sent = h.send.mock.calls[0]![0];
    expect(toHex(sent)).toBe(toHex(await h.signWithPension.mock.results[0]!.value));
    const verified = verifySignedTransaction(sent);
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    const lighthouseAt = verified.instructions.flatMap((instruction, index) => (instruction.program === LIGHTHOUSE_PROGRAM ? [index] : []));
    const leading = flow.leading(h).length;
    expect(lighthouseAt.slice(0, leading)).toEqual(Array.from({ length: leading }, (_, index) => 2 + index));
    expect(lighthouseAt).toHaveLength(leading + flow.guards(h).length);
  });

  /** A refusal before sending, in exactly these words. */
  async function refusedBeforeSending(run: Flow, h: Harness, message: string | RegExp): Promise<void> {
    const result = await run(h);
    expect(result.ok).toBe(false);
    if (typeof message === "string") expect(result.message).toBe(message);
    else expect(result.message).toMatch(message);
    expect(h.send).not.toHaveBeenCalled();
  }

  it("a check inside the budget pair or between a creation and set_invest_policy is refused with where it stood; one ahead of create_vault_v2 on the pension key, or on an account SaverFi only reads, with what it checks", async () => {
    const between = harness();
    phantomSigns(between, (h) => ({ guards: [guard(GUARD.created(), deriveVaultPda(h.pensionKey).toBase58())], at: 1 }));
    await refusedBeforeSending(
      flows.create_vault_v2!.run,
      between,
      FAILURE_COPY.walletGuardRefused(
        "the Lighthouse instruction at position 2 stands before SaverFi's own instruction at position 3; Lighthouse checks are relayed only right after SaverFi's compute budget, or after all of SaverFi's instructions",
      ),
    );
    const policy = harness();
    phantomSigns(policy, (h) => ({ guards: [guard(GUARD.payer(1n), h.pensionKey)], at: 5 }));
    await refusedBeforeSending(flows["set_invest_policy with three token-account creations"]!.run, policy, /position 6 stands before SaverFi's own instruction at position 7/);

    const payer = harness();
    phantomSigns(payer, (h) => ({ leading: [guard(GUARD.payer(1n), h.pensionKey)], guards: [] }));
    await refusedBeforeSending(
      flows.create_vault_v2!.run,
      payer,
      FAILURE_COPY.walletGuardRefused(
        `the Lighthouse instruction at position 3, ahead of SaverFi's instructions, checks the fee payer ${payer.pensionKey}; checks there are relayed only on the accounts SaverFi's instructions write, other than the fee payer`,
      ),
    );
    const readOnly = harness();
    phantomSigns(readOnly, (h) => ({ leading: [guard(GUARD.owner(SIP_PROGRAM_ID), deriveVaultPda(h.pensionKey).toBase58())], guards: [] }));
    await refusedBeforeSending(flows.withdraw_token!.run, readOnly, /ahead of SaverFi's instructions, checks \w+, which SaverFi's own instructions do not write/);
  });

  it("a Lighthouse instruction that writes and pays rent, a bare MemoryClose, more checks than the bound, or a check on an account SaverFi does not name, is refused in Lighthouse's words", async () => {
    const memoryWrite = (h: Harness): TransactionInstruction => {
      const [memory, bump] = PublicKey.findProgramAddressSync([Buffer.from("memory"), h.owner.publicKey.toBuffer(), Buffer.from([0])], LIGHTHOUSE);
      return new TransactionInstruction({
        programId: LIGHTHOUSE,
        keys: [
          { pubkey: LIGHTHOUSE, isSigner: false, isWritable: false },
          { pubkey: new PublicKey("11111111111111111111111111111111"), isSigner: false, isWritable: false },
          { pubkey: h.owner.publicKey, isSigner: true, isWritable: true },
          { pubkey: memory, isSigner: false, isWritable: true },
          { pubkey: h.owner.publicKey, isSigner: false, isWritable: false },
        ],
        data: Buffer.from([0, 0, bump, 0, 1, 1]),
      });
    };
    const cases: [string, (h: Harness) => Rewrite, RegExp][] = [
      ["MemoryWrite", (h) => ({ guards: [memoryWrite(h)] }), /MemoryWrite \(0\), which creates or grows a Lighthouse memory account and pays its rent from a signer/],
      ["the old bare MemoryClose", () => ({ guards: [new TransactionInstruction({ programId: LIGHTHOUSE, keys: [], data: Buffer.from([1]) })] }), /MemoryClose \(1\)/],
      ["too many", (h) => ({ guards: Array.from({ length: MAX_WALLET_GUARDS + 1 }, () => guard(GUARD.payer(1n), h.pensionKey)) }), new RegExp(`${MAX_WALLET_GUARDS + 1} Lighthouse instructions; at most ${MAX_WALLET_GUARDS} are relayed`)],
      ["a stranger's account", () => ({ guards: [guard(GUARD.system(), Keypair.generate().publicKey.toBase58())] }), /which SaverFi's own instructions do not name/],
    ];
    for (const [, rewrite, words] of cases) {
      const h = harness();
      phantomSigns(h, rewrite);
      const result = await flows.create_vault_v2!.run(h);
      expect(result.message).toMatch(/^Phantom added a Lighthouse safety check SaverFi does not relay \(/);
      expect(result.message).toMatch(words);
      expect(h.send).not.toHaveBeenCalled();
    }
  });

  it("a program one byte away from Lighthouse's id, or Memo after the checks, is named as a foreign program", async () => {
    const bytes = LIGHTHOUSE.toBytes();
    bytes[31] = bytes[31]! ^ 1;
    const lookalike = new PublicKey(bytes);
    const h = harness();
    phantomSigns(h, () => ({ guards: [guard(GUARD.payer(1n), h.pensionKey, { programId: lookalike })] }));
    await refusedBeforeSending(flows.create_vault_v2!.run, h, FAILURE_COPY.foreignProgram(lookalike.toBase58()));

    const memo = harness();
    phantomSigns(memo, () => ({ guards: [guard(GUARD.payer(1n), memo.pensionKey), new TransactionInstruction({ programId: new PublicKey(MEMO_PROGRAM), keys: [], data: Buffer.from("x") })] }));
    await refusedBeforeSending(flows.withdraw!.run, memo, FAILURE_COPY.foreignProgram(`Memo (${MEMO_PROGRAM})`));
  });

  it("beside valid checks: another fee payer, a new signer, another blockhash, another compute budget, a second price, another amount, another account, or a key made writable, each refused in its own words", async () => {
    const payerCheck = (h: Harness): TransactionInstruction => guard(GUARD.payer(1n), h.pensionKey);
    const replaceInstruction = (message: TransactionMessage, index: number, change: (instruction: TransactionInstruction) => TransactionInstruction): void => {
      message.instructions[index] = change(message.instructions[index]!);
    };
    const cases: [string, keyof typeof flows, (h: Harness) => Rewrite, (h: Harness) => string][] = [
      ["a stranger pays", "create_vault_v2", (h) => ({ guards: [payerCheck(h)], edit: (message) => (message.payerKey = Keypair.generate().publicKey) }), () => FAILURE_COPY.signedMismatch("it asks for other signers")],
      ["a check names a new signer", "create_vault_v2", () => ({ guards: [guard(GUARD.system(), Keypair.generate().publicKey.toBase58(), { isSigner: true })] }), () => FAILURE_COPY.signedMismatch("it asks for other signers")],
      ["another blockhash", "create_vault_v2", (h) => ({ guards: [payerCheck(h)], edit: (message) => (message.recentBlockhash = recent().blockhash) }), () => FAILURE_COPY.signedMismatch("its blockhash changed")],
      [
        "a higher unit limit",
        "withdraw",
        (h) => ({ guards: [payerCheck(h)], edit: (message) => replaceInstruction(message, 0, () => ComputeBudgetProgram.setComputeUnitLimit({ units: 60_000 })) }),
        () => FAILURE_COPY.signedMismatch("its compute budget changed"),
      ],
      [
        "a second unit price after the checks",
        "withdraw",
        (h) => ({ guards: [payerCheck(h), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 })] }),
        () => FAILURE_COPY.signedMismatch("it does not hold the instructions SaverFi built"),
      ],
      [
        "one lamport more",
        "withdraw",
        (h) => ({
          guards: [payerCheck(h)],
          edit: (message) =>
            replaceInstruction(message, 2, (withdraw) => {
              const data = Buffer.from(withdraw.data);
              data.writeBigUInt64LE(150_000_001n, 8);
              return new TransactionInstruction({ programId: withdraw.programId, keys: withdraw.keys, data });
            }),
        }),
        () => FAILURE_COPY.signedMismatch("its SaverFi instruction changed"),
      ],
      [
        "another destination token account",
        "withdraw_token",
        (h) => ({
          guards: [payerCheck(h)],
          edit: (message) =>
            replaceInstruction(message, 2, (withdraw) => new TransactionInstruction({ programId: withdraw.programId, keys: withdraw.keys.map((meta, at) => (at === 4 ? { ...meta, pubkey: Keypair.generate().publicKey } : meta)), data: withdraw.data })),
        }),
        () => FAILURE_COPY.signedMismatch("its SaverFi instruction changed"),
      ],
      [
        "the vault made writable by a check",
        "withdraw_token",
        (h) => ({ guards: [guard(GUARD.owner(SIP_PROGRAM_ID), deriveVaultPda(h.pensionKey).toBase58(), { isWritable: true })] }),
        (h) => FAILURE_COPY.walletGuardRefused(`${deriveVaultPda(h.pensionKey).toBase58()} is writable in the message, and read-only in SaverFi's own instructions`),
      ],
    ];
    for (const [label, flow, rewrite, words] of cases) {
      const h = harness();
      phantomSigns(h, rewrite);
      const result = await flows[flow]!.run(h);
      expect(result, label).toMatchObject({ ok: false, kind: "refused", message: words(h) });
      expect(h.send, label).not.toHaveBeenCalled();
    }
  });

  it("a key made writable with no check at all is refused by the page's own comparison", async () => {
    const h = harness();
    h.signWithPension.mockImplementationOnce(async (bytes) => {
      const tx = VersionedTransaction.deserialize(bytes);
      const header = tx.message.header;
      // One read-only unsigned key fewer: the last read-only key becomes writable, every instruction untouched.
      const message = new (tx.message.constructor as new (args: unknown) => typeof tx.message)({
        header: { ...header, numReadonlyUnsignedAccounts: header.numReadonlyUnsignedAccounts - 1 },
        accountKeys: tx.message.staticAccountKeys,
        recentBlockhash: tx.message.recentBlockhash,
        instructions: (tx.message as unknown as { instructions: unknown[] }).instructions,
      });
      const rewritten = new VersionedTransaction(message);
      rewritten.sign([h.owner]);
      return Uint8Array.from(rewritten.serialize());
    });
    const result = await flows.create_vault_v2!.run(h);
    expect(result).toMatchObject({ ok: false, kind: "refused" });
    expect(result.message).toMatch(/^Phantom changed the transaction SaverFi built \(it makes .* writable, where SaverFi built it read-only\)/);
    expect(h.send).not.toHaveBeenCalled();
  });

  it("a check that fails when the transaction runs says it was Phantom's check, never SaverFi's error under the same code, in simulation and on chain", async () => {
    // Lighthouse's AssertionFailed is 6001, which is also sip_vault's "This vault belongs to another pension key."
    for (const [name, index] of [
      ["create_vault_v2", 3],
      ["withdraw", 3],
    ] as const) {
      const simulated = harness();
      phantomSigns(simulated, (h) => ({ guards: flows[name]!.guards(h) }));
      simulated.send.mockImplementationOnce(async () => failure(422, "simulation_failed", { err: { InstructionError: [index, { Custom: 6004 }] }, logs: [] }));
      expect(await flows[name]!.run(simulated)).toMatchObject({ ok: false, kind: "refused", message: FAILURE_COPY.walletGuardFailed });

      const landed = harness();
      phantomSigns(landed, (h) => ({ guards: flows[name]!.guards(h) }));
      landed.confirm.mockImplementationOnce(async () => ({ status: "failed", slot: 11, err: { InstructionError: [index, { Custom: 6001 }] } }));
      expect(await flows[name]!.run(landed)).toMatchObject({ ok: false, kind: "refused", message: FAILURE_COPY.walletGuardFailed });
    }
    // The link's check after its own four instructions.
    const link = harness();
    link.signWithPension.mockImplementationOnce(async (bytes) => phantomRewrite(bytes, { guards: [guard(GUARD.payer(1n), link.pensionKey)] }, link.owner));
    link.confirm.mockImplementationOnce(async () => ({ status: "failed", slot: 11, err: { InstructionError: [4, { Custom: 6400 }] } }));
    expect(await linkWalletFlow(link.linkDeps, link.linkInput)).toMatchObject({ ok: false, kind: "refused", message: FAILURE_COPY.walletGuardFailed });
    // SaverFi's own instruction keeps SaverFi's words.
    const own = harness();
    phantomSigns(own, (h) => ({ guards: flows.withdraw!.guards(h) }));
    own.send.mockImplementationOnce(async () => failure(422, "simulation_failed", { err: { InstructionError: [2, { Custom: 6004 }] }, logs: [] }));
    expect(await flows.withdraw!.run(own)).toEqual({ ok: false, kind: "refused", message: WITHDRAW_COPY.balanceMoved, code: "balance_moved" });
  });

  it("with Phantom's leading block, the failing instruction's position in the bytes sent says whose failure it is: a check ahead of SaverFi's instruction is Phantom's, SaverFi's instruction after the block keeps SaverFi's words, in simulation and on chain, for withdraw and for the link", async () => {
    // withdraw as [budget pair, the vault's owner, withdraw, the pension key's check].
    const withLeading = (h: Harness): Rewrite => ({ leading: flows.withdraw!.leading(h), guards: flows.withdraw!.guards(h) });
    for (const [index, words] of [
      [2, { ok: false, kind: "refused", message: FAILURE_COPY.walletGuardFailed }],
      [3, { ok: false, kind: "refused", message: WITHDRAW_COPY.balanceMoved, code: "balance_moved" }],
      [4, { ok: false, kind: "refused", message: FAILURE_COPY.walletGuardFailed }],
    ] as const) {
      const simulated = harness();
      phantomSigns(simulated, withLeading);
      simulated.send.mockImplementationOnce(async () => failure(422, "simulation_failed", { err: { InstructionError: [index, { Custom: 6004 }] }, logs: [] }));
      expect(await flows.withdraw!.run(simulated), `simulated at ${index}`).toMatchObject(words);

      const landed = harness();
      phantomSigns(landed, withLeading);
      landed.confirm.mockImplementationOnce(async () => ({ status: "failed", slot: 11, err: { InstructionError: [index, { Custom: 6004 }] } }));
      expect(await flows.withdraw!.run(landed), `landed at ${index}`).toMatchObject(words);
    }

    // The link as Phantom writes it for two signers: [budget pair, the new trading link, Ed25519SigVerify, link_wallet, the pension key's check].
    for (const [index, custom, message] of [
      [2, 6400, FAILURE_COPY.walletGuardFailed],
      [4, 6036, "The trading wallet's consent is missing from this link. Nothing was linked."],
      [5, 6001, FAILURE_COPY.walletGuardFailed],
    ] as const) {
      const link = harness();
      link.signWithPension.mockImplementationOnce(async (bytes) =>
        phantomRewrite(bytes, { leading: [guard(GUARD.created(), deriveLinkPda(link.tradingAddress).toBase58())], guards: [guard(GUARD.payer(1n), link.pensionKey)] }, link.owner),
      );
      link.confirm.mockImplementationOnce(async () => ({ status: "failed", slot: 11, err: { InstructionError: [index, { Custom: custom }] } }));
      expect(await linkWalletFlow(link.linkDeps, link.linkInput), `link at ${index}`).toMatchObject({ ok: false, kind: "refused", message });
    }
  });
});

describe("awaitsConfirmation: what leaves a transaction on its way", () => {
  const SENT: FlowResult = { ok: false, kind: "unconfirmed", message: "not confirmed", signature: "sig", explorerUrl: null, lastValidBlockHeight: 7 };

  it("only a sent-and-unconfirmed result waits: everything else is settled, and null is not a write at all", () => {
    expect(awaitsConfirmation(SENT)).toBe(true);
    expect(awaitsConfirmation(null)).toBe(false);
    for (const result of [
      { ok: true, signature: "sig", explorerUrl: null, slot: 1, unitsConsumed: null },
      { ok: false, kind: "refused", message: "no" },
      { ok: false, kind: "expired", message: "no" },
      { ok: false, kind: "rate_limited", message: "no", retryAfterSeconds: null },
      { ok: false, kind: "unreadable", message: "no" },
    ] satisfies FlowResult[]) {
      expect(awaitsConfirmation(result), result.ok ? "landed" : result.kind).toBe(false);
    }
  });
});
