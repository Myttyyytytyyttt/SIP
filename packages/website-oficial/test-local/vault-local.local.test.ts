// The local proof for web-boveda, Part 1: the vault is created and a trading
// wallet linked by the web's own flows, over HTTP to the web's own production
// build, against a validator running the tested sip_vault.so.
//
// WHAT RUNS. test-local/local-validator.ts starts solana-test-validator with the
// tested binary at its real id; test-local/web-server.ts serves .next on
// localhost:3015 with SIP_SOLANA_RPC_URLS pointing at it. The flows are imported
// from src/lib/vault-flows.ts unchanged, with a client pointed at that server.
// Only Privy is replaced: Phantom by a Keypair signing the bytes it is given, the
// trading wallet's signMessage by node:crypto, its signTransaction by a Keypair.
// Every call to those, its order and the bytes it received, is recorded.
//
// WHAT IT TIES TOGETHER. The SIP instruction data that LANDED equals the byte
// fixtures in packages/solana-core/test/fixtures/owner-transactions.ts, which
// builders.test.ts holds the builders to; the consent the program verified is the
// bytes the page rebuilt; each landing uses at most half of its compute limit.
//
// NOT PROVABLE HERE: Privy's TEE signMessage and signTransaction, Phantom's own
// rewrites or Lighthouse, mainnet rent (the local validator charges 6,960
// lamports per byte, so every rent is read, never typed), and Solscan pages (only
// the link's format is asserted).
//
// NOT PART OF `pnpm test`. Node 22, solana-test-validator and the tested binary:
// `pnpm --filter @sip/web run build && pnpm --dir packages/website-oficial
// test:local`, with SIP_LOCAL_PROGRAM_SO naming the binary when this checkout has
// no target/.

import { createPrivateKey, sign } from "node:crypto";

import {
  DEFAULT_VAULT_POLICY,
  OWNER_TX_COMPUTE,
  SIP_ACCOUNT_SPACE,
  SIP_PROGRAM_ID,
  base64Encode,
  decodeProtocolConfig,
  decodeTradingLink,
  decodeVault,
  encodeArgs,
  idlInstruction,
  linkConsentMessage,
  ownerComputeBudget,
  toHex,
  tryBase64Decode,
  type OwnerInstructionName,
} from "@sip/solana-core/client";
import { buildCreateVaultV2, deriveConfigPda, deriveLinkPda, deriveVaultPda } from "@sip/solana-core/server";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction, TransactionInstruction, VersionedTransaction, type Connection, type VersionedTransactionResponse } from "@solana/web3.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createVaultApi, type VaultApi } from "@/lib/vault-api";
import { createVaultFlow, linkWalletFlow, type FlowResult } from "@/lib/vault-flows";

import { ED25519_CONSENT_HEADER_HEX, OWNER_INSTRUCTION_DATA_HEX } from "../../solana-core/test/fixtures/owner-transactions";
import { startLocalValidator, type LocalValidator, type StoppedValidator } from "./local-validator";
import { CLIENT_IP_HEADERS, WEB_ORIGIN, startWebServer, withClientIp, type WebServer } from "./web-server";

const SOL = BigInt(LAMPORTS_PER_SOL);
const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
const ED25519 = "Ed25519SigVerify111111111111111111111111111";
const UPGRADEABLE_LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const CONFIRM_TIMEOUT_MS = 60_000;

const upgradeAuthority = Keypair.generate();
const attester = Keypair.generate();
const ownerA = Keypair.generate();
const ownerB = Keypair.generate();
const ownerV = Keypair.generate();
const tradingA = Keypair.generate();
const tradingB = Keypair.generate();
const tradingC = Keypair.generate();

const key = (keypair: Keypair): string => keypair.publicKey.toBase58();

let validator: LocalValidator | undefined;
let web: WebServer | undefined;
let connection: Connection;
let api: VaultApi;
const rents = new Map<number, bigint>();
let configured = false;

const report = {
  keys: {
    upgradeAuthority: key(upgradeAuthority),
    attester: key(attester),
    ownerA: key(ownerA),
    ownerB: key(ownerB),
    ownerV: key(ownerV),
    tradingA: key(tradingA),
    tradingB: key(tradingB),
    tradingC: key(tradingC),
  },
  rents: {} as Record<string, string>,
  signatures: {} as Record<string, string>,
  units: {} as Record<string, { consumed: number; limit: number }>,
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function earlier<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`${what} did not complete, so this step cannot run`);
  return value;
}

const rent = (size: number): bigint => earlier(rents.get(size), `the rent for ${size} bytes`);
const lamports = async (address: string): Promise<bigint> => BigInt(await connection.getBalance(new PublicKey(address), "confirmed"));

/** What a wallet's signMessage returns, with node:crypto. */
function signBytes(signer: Keypair, message: Uint8Array): Uint8Array {
  const privateKey = createPrivateKey({
    key: { kty: "OKP", crv: "Ed25519", d: Buffer.from(signer.secretKey.subarray(0, 32)).toString("base64url"), x: Buffer.from(signer.publicKey.toBytes()).toString("base64url") },
    format: "jwk",
  });
  return Uint8Array.from(sign(null, message, privateKey));
}

/** What a wallet's signTransaction returns: its own slot signed over the bytes it was given. */
function signWith(bytes: Uint8Array, signer: Keypair): Uint8Array {
  const tx = VersionedTransaction.deserialize(bytes);
  tx.sign([signer]);
  return Uint8Array.from(tx.serialize());
}

async function confirmed(signature: string): Promise<void> {
  const deadline = Date.now() + CONFIRM_TIMEOUT_MS;
  for (;;) {
    const [status] = (await connection.getSignatureStatuses([signature])).value;
    if (status?.err) throw new Error(`${signature} failed: ${JSON.stringify(status.err)}`);
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") return;
    if (Date.now() > deadline) throw new Error(`${signature} was not confirmed within ${CONFIRM_TIMEOUT_MS / 1_000} s`);
    await sleep(250);
  }
}

async function landed(signature: string): Promise<VersionedTransactionResponse> {
  await confirmed(signature);
  for (let attempt = 0; attempt < 40; attempt++) {
    const tx = await connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (tx !== null) {
      expect(tx.meta?.err ?? null).toBeNull();
      return tx;
    }
    await sleep(250);
  }
  throw new Error(`${signature} could not be read back`);
}

const keysOf = (tx: VersionedTransactionResponse): string[] => tx.transaction.message.staticAccountKeys.map((account) => account.toBase58());
const programsOf = (tx: VersionedTransactionResponse): string[] => tx.transaction.message.compiledInstructions.map((instruction) => keysOf(tx)[instruction.programIdIndex]!);
const dataOf = (tx: VersionedTransactionResponse, index: number): Uint8Array => Uint8Array.from(tx.transaction.message.compiledInstructions[index]!.data);
const signersOf = (tx: VersionedTransactionResponse): string[] => keysOf(tx).slice(0, tx.transaction.message.header.numRequiredSignatures);

function withinHalf(name: OwnerInstructionName, tx: VersionedTransactionResponse, label: string, signature: string): void {
  const consumed = tx.meta?.computeUnitsConsumed;
  expect(typeof consumed).toBe("number");
  expect(consumed!).toBeLessThanOrEqual(OWNER_TX_COMPUTE[name] / 2);
  report.units[label] = { consumed: consumed!, limit: OWNER_TX_COMPUTE[name] };
  report.signatures[label] = signature;
}

function landedSignature(result: FlowResult): string {
  if (!result.ok) throw new Error(`the flow did not land: ${result.kind}: ${result.message}`);
  return result.signature;
}

async function airdrop(to: PublicKey, amount: bigint): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await confirmed(await connection.requestAirdrop(to, Number(amount)));
      return;
    } catch (error) {
      // The faucet answers a moment after the RPC does.
      lastError = error;
      await sleep(1_000);
    }
  }
  throw new Error(`the faucet did not fund ${to.toBase58()}: ${String(lastError)}`);
}

/** Privy, replaced: a pension key and a trading wallet as Keypairs, every call recorded. */
function wallets(owner: Keypair, trading: Keypair) {
  const calls = { order: [] as string[], consent: [] as Uint8Array[], pensionIn: [] as Uint8Array[], pensionOut: [] as Uint8Array[], tradingIn: [] as Uint8Array[] };
  return {
    calls,
    pension: {
      signWithPension: async (bytes: Uint8Array) => {
        calls.order.push("pension");
        calls.pensionIn.push(bytes);
        const signed = signWith(bytes, owner);
        calls.pensionOut.push(signed);
        return signed;
      },
    },
    trading: {
      signMessageWithTrading: async (message: Uint8Array) => {
        calls.order.push("consent");
        calls.consent.push(message);
        return signBytes(trading, message);
      },
      signWithTrading: async (bytes: Uint8Array) => {
        calls.order.push("trading");
        calls.tradingIn.push(bytes);
        return signWith(bytes, trading);
      },
    },
  };
}

async function rawBuild(body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: { error?: { code?: string; vault?: string } } }> {
  const response = await fetch(`${WEB_ORIGIN}/api/solana-build`, {
    method: "POST",
    headers: { "content-type": "application/json", ...CLIENT_IP_HEADERS, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json()) as never };
}

beforeAll(async () => {
  validator = await startLocalValidator(upgradeAuthority.publicKey);
  connection = validator.connection;
  web = await startWebServer();
  api = createVaultApi({ origin: WEB_ORIGIN, fetch: withClientIp });
});

afterAll(async () => {
  let webStopped: { exited: boolean; portRefused: boolean } | null = null;
  let validatorStopped: StoppedValidator | null = null;
  try {
    webStopped = web === undefined ? null : await web.stop();
  } finally {
    validatorStopped = validator === undefined ? null : await validator.stop();
  }
  console.log(JSON.stringify({ event: "web-boveda.local-proof", ...report, stopped: { web: webStopped, validator: validatorStopped } }, null, 1));
  if (webStopped !== null) expect(webStopped).toEqual({ exited: true, portRefused: true });
  if (validatorStopped !== null) expect(validatorStopped).toEqual({ exited: true, rpcRefused: true, tempDirGone: true });
});

describe("web-boveda Part 1 on the tested sip_vault", () => {
  it("1. funds the keys from the faucet and reads the local rents", async () => {
    for (const keypair of [upgradeAuthority, ownerA, ownerB, ownerV]) await airdrop(keypair.publicKey, 20n * SOL);
    for (const size of [0, SIP_ACCOUNT_SPACE.Vault, SIP_ACCOUNT_SPACE.TradingLink]) {
      rents.set(size, BigInt(await connection.getMinimumBalanceForRentExemption(size, "confirmed")));
      report.rents[String(size)] = rent(size).toString();
    }
    expect(SIP_ACCOUNT_SPACE.Vault).toBe(125);
    expect(SIP_ACCOUNT_SPACE.TradingLink).toBe(129);
  });

  it("2. /api/solana-vault reads no vault, no policy and no config yet, and prices from the cloned pools", async () => {
    const state = await api.state({ owner: key(ownerA), wallets: [] });
    if (!state.ok) throw new Error(state.code);
    expect([state.body.vault.status, state.body.policy.status, state.body.config.status]).toEqual(["missing", "missing", "missing"]);
    expect(state.body.rents).toEqual({ vault: rent(125).toString(), link: rent(129).toString() });
    expect(state.body.prices).not.toBeNull();
  });

  it("3. createVaultFlow lands create_vault_v2 with the product's defaults, and the landed data is the fixture", async () => {
    const owner = key(ownerA);
    const before = await lamports(owner);
    const signers = wallets(ownerA, tradingA);
    const result = await createVaultFlow({ api, signers: signers.pension }, { pensionKey: owner, mode: 0, maxContribution: DEFAULT_VAULT_POLICY.maxContribution, walletReserve: DEFAULT_VAULT_POLICY.walletReserve });
    const signature = landedSignature(result);
    expect(result.ok && result.explorerUrl).toBe(`https://solscan.io/tx/${signature}`);
    const tx = await landed(signature);

    const vaultAddress = deriveVaultPda(owner).toBase58();
    const account = await connection.getAccountInfo(new PublicKey(vaultAddress), "confirmed");
    const vault = decodeVault(Uint8Array.from(earlier(account ?? undefined, "the vault account").data));
    expect(vault).toMatchObject({ owner, skimMode: 0, skimBps: 2_000, volumeBps: 200, maxContribution: 60_000_000n, walletReserve: 50_000_000n, paused: false, lifetimeSaved: 0n, policyNonce: 0n });
    expect(BigInt(account!.lamports)).toBe(rent(125));
    expect((await lamports(owner)) - before).toBe(-(rent(125) + BigInt(tx.meta!.fee)));

    expect(programsOf(tx)).toEqual([COMPUTE_BUDGET, COMPUTE_BUDGET, SIP_PROGRAM_ID]);
    expect(toHex(dataOf(tx, 2))).toBe(OWNER_INSTRUCTION_DATA_HEX.CREATE_VAULT_V2_PROFIT_DEFAULTS);
    expect(signersOf(tx)).toEqual([owner]);
    withinHalf("create_vault_v2", tx, "create_vault_v2 ownerA", signature);

    const again = await api.build({ action: "createVault", owner, mode: 0 });
    expect(again).toMatchObject({ ok: false, status: 409, code: "vault_exists" });
  });

  it("4. VOLUME: the build route refuses mode 1, and the tested program accepts the same bytes from any client", async () => {
    const owner = key(ownerV);
    expect(await api.build({ action: "createVault", owner, mode: 1 })).toMatchObject({ ok: false, status: 400, code: "volume_not_offered" });
    const recent = await connection.getLatestBlockhash("confirmed");
    const built = buildCreateVaultV2({
      owner,
      ...DEFAULT_VAULT_POLICY,
      mode: 1,
      blockhash: recent.blockhash,
      lastValidBlockHeight: recent.lastValidBlockHeight,
      computeBudget: ownerComputeBudget("create_vault_v2"),
    });
    const sent = await api.send(signWith(earlier(tryBase64Decode(built.txBase64) ?? undefined, "the built VOLUME vault"), ownerV));
    if (!sent.ok) throw new Error(`${sent.code}: ${sent.message}`);
    const tx = await landed(sent.body.signature);
    const account = await connection.getAccountInfo(new PublicKey(deriveVaultPda(owner).toBase58()), "confirmed");
    expect(decodeVault(Uint8Array.from(account!.data)).skimMode).toBe(1);
    withinHalf("create_vault_v2", tx, "create_vault_v2 VOLUME ownerV", sent.body.signature);
  });

  it("5. before the program is configured, linking stops at config_missing and the trading wallet signs nothing", async () => {
    const signers = wallets(ownerA, tradingA);
    const result = await linkWalletFlow({ api, pension: signers.pension, trading: signers.trading }, { pensionKey: key(ownerA), tradingAddress: key(tradingA) });
    expect(result).toMatchObject({ ok: false, kind: "refused", code: "config_missing" });
    expect(signers.calls.consent).toHaveLength(0);
    expect(signers.calls.order).toEqual([]);
  });

  it("6. init_config, hand-built and sent straight to the validator; the send route refuses the same bytes", async () => {
    const [programData] = PublicKey.findProgramAddressSync([new PublicKey(SIP_PROGRAM_ID).toBytes()], UPGRADEABLE_LOADER);
    const config = new PublicKey(deriveConfigPda().toBase58());
    const idl = idlInstruction("init_config");
    const addresses: Record<string, PublicKey> = {
      authority: upgradeAuthority.publicKey,
      config,
      program: new PublicKey(SIP_PROGRAM_ID),
      program_data: programData,
      system_program: new PublicKey("11111111111111111111111111111111"),
    };
    const instruction = new TransactionInstruction({
      programId: new PublicKey(SIP_PROGRAM_ID),
      keys: idl.accounts.map((account) => ({ pubkey: earlier(addresses[account.name], account.name), isSigner: account.signer === true, isWritable: account.writable === true })),
      data: Buffer.from(encodeArgs("init_config", { attester: key(attester) })),
    });
    const recent = await connection.getLatestBlockhash("confirmed");
    const tx = new Transaction({ feePayer: upgradeAuthority.publicKey, blockhash: recent.blockhash, lastValidBlockHeight: recent.lastValidBlockHeight }).add(instruction);
    tx.sign(upgradeAuthority);
    const bytes = Uint8Array.from(tx.serialize());
    const signature = await connection.sendRawTransaction(bytes, { skipPreflight: false });
    await landed(signature);
    report.signatures["init_config"] = signature;

    expect(await api.send(bytes)).toMatchObject({ ok: false, status: 422, code: "instruction_not_allowed" });
    const state = decodeProtocolConfig(Uint8Array.from((await connection.getAccountInfo(config, "confirmed"))!.data));
    expect(state).toMatchObject({ authority: key(upgradeAuthority), attester: key(attester), paused: false });
    configured = true;
  });

  it("7. the pension key as its own trading wallet is refused before any request, and by the build route", async () => {
    let requests = 0;
    const counted = createVaultApi({
      origin: WEB_ORIGIN,
      fetch: (input, init) => {
        requests += 1;
        return withClientIp(input, init);
      },
    });
    const signers = wallets(ownerA, ownerA);
    const result = await linkWalletFlow({ api: counted, pension: signers.pension, trading: signers.trading }, { pensionKey: key(ownerA), tradingAddress: key(ownerA) });
    expect(result).toMatchObject({ ok: false, kind: "refused", message: "A trading wallet cannot be your pension key." });
    expect(requests).toBe(0);
    expect(signers.calls.order).toEqual([]);
    const refused = await rawBuild({ action: "prepareLink", owner: key(ownerA), wallet: key(ownerA) });
    expect([refused.status, refused.json.error?.code]).toEqual([400, "wallet_is_owner"]);
  });

  it("8. linkWalletFlow links tradingA: the consent, Phantom first, the trading wallet on Phantom's bytes, and the fixture's bytes on chain", async () => {
    earlier(configured || undefined, "init_config");
    const owner = key(ownerA);
    const wallet = key(tradingA);
    const vaultAddress = deriveVaultPda(owner).toBase58();
    const [ownerBefore, walletBefore] = [await lamports(owner), await lamports(wallet)];
    const signers = wallets(ownerA, tradingA);
    const result = await linkWalletFlow({ api, pension: signers.pension, trading: signers.trading }, { pensionKey: owner, tradingAddress: wallet });
    const signature = landedSignature(result);
    const tx = await landed(signature);

    expect(signers.calls.order).toEqual(["consent", "pension", "trading"]);
    const consent = signers.calls.consent[0]!;
    expect(consent).toHaveLength(140);
    expect(consent[0]).toBe(0xff);
    expect(toHex(consent)).toBe(toHex(linkConsentMessage({ programId: SIP_PROGRAM_ID, wallet, vault: vaultAddress, owner })));
    expect(toHex(signers.calls.tradingIn[0]!)).toBe(toHex(signers.calls.pensionOut[0]!));

    const linkAddress = deriveLinkPda(wallet).toBase58();
    const account = await connection.getAccountInfo(new PublicKey(linkAddress), "confirmed");
    const link = decodeTradingLink(Uint8Array.from(earlier(account ?? undefined, "the link account").data));
    expect(link).toMatchObject({ wallet, vault: vaultAddress, settlementNonce: 0n, frontierSlot: 0n });
    expect(link.epoch > 0n && link.epoch <= BigInt(tx.slot)).toBe(true);
    expect(BigInt(account!.lamports)).toBe(rent(129));
    expect((await lamports(owner)) - ownerBefore).toBe(-(rent(129) + BigInt(tx.meta!.fee)));
    expect((await lamports(wallet)) - walletBefore).toBe(0n);

    expect(signersOf(tx)).toEqual([owner, wallet]);
    expect(programsOf(tx)).toEqual([COMPUTE_BUDGET, COMPUTE_BUDGET, ED25519, SIP_PROGRAM_ID]);
    expect(toHex(dataOf(tx, 3))).toBe(OWNER_INSTRUCTION_DATA_HEX.LINK_WALLET);
    expect(toHex(dataOf(tx, 2).subarray(0, 16))).toBe(ED25519_CONSENT_HEADER_HEX);
    expect(tx.meta?.logMessages).toContain(`Program ${SIP_PROGRAM_ID} success`);
    withinHalf("link_wallet", tx, "link_wallet ownerA tradingA", signature);

    const state = await api.state({ owner, wallets: [wallet] });
    expect(state.ok && state.body.walletLinks).toEqual([{ wallet, link: linkAddress, status: "this_vault", vault: vaultAddress }]);
  });

  it("9. an approval window that passed builds the link again with the same consent: one consent, two approvals each, one landing", async () => {
    const owner = key(ownerB);
    const wallet = key(tradingB);
    const created = await createVaultFlow({ api, signers: wallets(ownerB, tradingB).pension }, { pensionKey: owner, mode: 0 });
    const createdSignature = landedSignature(created);
    withinHalf("create_vault_v2", await landed(createdSignature), "create_vault_v2 ownerB", createdSignature);

    const signers = wallets(ownerB, tradingB);
    let answeredFalse = false;
    const isBlockhashValid = async (blockhash: string): Promise<boolean> => {
      if (!answeredFalse) {
        answeredFalse = true;
        return false;
      }
      const answer = await api.rpc<{ value?: boolean }>("isBlockhashValid", [blockhash, { commitment: "confirmed" }]);
      return answer.value !== false;
    };
    const result = await linkWalletFlow({ api, pension: signers.pension, trading: signers.trading, isBlockhashValid }, { pensionKey: owner, tradingAddress: wallet });
    const signature = landedSignature(result);
    expect(signers.calls.order).toEqual(["consent", "pension", "trading", "pension", "trading"]);
    const tx = await landed(signature);
    expect(signersOf(tx)).toEqual([owner, wallet]);
    withinHalf("link_wallet", tx, "link_wallet ownerB tradingB (rebuilt)", signature);
  });

  it("10. after linking: a wallet linked elsewhere is 409 naming its vault; a consent over another vault is 422", async () => {
    const elsewhere = await rawBuild({ action: "prepareLink", owner: key(ownerB), wallet: key(tradingA) });
    expect([elsewhere.status, elsewhere.json.error?.code, elsewhere.json.error?.vault]).toEqual([409, "wallet_already_linked", deriveVaultPda(key(ownerA)).toBase58()]);

    const overVaultB = linkConsentMessage({ programId: SIP_PROGRAM_ID, wallet: key(tradingC), vault: deriveVaultPda(key(ownerB)).toBase58(), owner: key(ownerB) });
    const refused = await rawBuild({ action: "link", owner: key(ownerA), wallet: key(tradingC), consentSignature: base64Encode(signBytes(tradingC, overVaultB)) });
    expect([refused.status, refused.json.error?.code]).toEqual([422, "link_consent_invalid"]);
  });

  it("15. the live build route refuses a cross-site request, text/plain and an unknown action", async () => {
    expect((await rawBuild({ action: "createVault", owner: key(ownerA), mode: 0 }, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await rawBuild(JSON.stringify({ action: "createVault" }), { "content-type": "text/plain" })).status).toBe(415);
    expect((await rawBuild({ action: "mintMoney", owner: key(ownerA) })).status).toBe(400);
  });

  it("16. every landing used at most half of its compute limit", () => {
    const landings = Object.values(report.units);
    expect(landings.length).toBe(5);
    for (const { consumed, limit } of landings) expect(consumed).toBeLessThanOrEqual(limit / 2);
  });
});
