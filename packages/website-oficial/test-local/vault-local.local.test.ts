// The local proof for web-boveda: the vault is created, a trading wallet linked,
// the investment policy signed with the vault's token accounts, and SOL, wSOL and
// SPYx taken out, by the web's own flows, over HTTP to the web's own production
// build, against a validator running the tested sip_vault.so.
//
// THE SPYx HOLDING. No SPYx mint or freeze authority exists locally, so the
// vault's SPYx is a copy of a real Token-2022 account (the SPYx/USDC pool's own
// vault, read once from mainnet's public RPC, read-only), its owner set to vault
// A and its amount to 12,345,678, loaded at genesis with --account.
//
// WHAT RUNS. test-local/local-validator.ts starts solana-test-validator with the
// tested binary at its real id; test-local/web-server.ts serves .next on
// localhost:3015 with SIP_SOLANA_RPC_URLS pointing at it. The flows are imported
// from src/lib/vault-flows.ts unchanged, with a client pointed at that server.
// Only Privy is replaced: Phantom by a Keypair signing the bytes it is given, the
// trading wallet's signMessage by node:crypto, its signTransaction by a Keypair.
// Every call to those, its order and the bytes it received, is recorded.
//
// WHAT IT TIES TOGETHER. Every SIP instruction's data that LANDED equals its byte
// fixture in packages/solana-core/test/fixtures/owner-transactions.ts, which
// builders.test.ts holds the builders to. set_invest_policy's is that fixture with
// only its two floors put in, since they come from the cloned pools, and signed
// again, its two caps as well. The Ed25519 data the program verified is the
// fixture's header, the trading wallet's key, the signature its signMessage
// returned and the consent the page rebuilt. Each landing uses at most half of
// its compute limit.
//
// BEFORE AND AFTER. Nothing starts, and mainnet is not read, while any port of the
// proof is held (the validator's over TCP and UDP, and 3015). Once both are
// stopped, each process has exited, both temporary directories are gone and every
// one of those ports is free again. The printed report carries runSeconds.
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
  ATA_PROGRAM,
  DEFAULT_INVEST_CAPS,
  DEFAULT_VAULT_POLICY,
  OWNER_TX_COMPUTE,
  RAYDIUM_CLMM,
  SIP_ACCOUNT_SPACE,
  SIP_PROGRAM_ID,
  SOL_USDC_POOL,
  SPYX_MINT,
  SPYX_USDC_POOL,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  USDC_MINT,
  WSOL_MINT,
  base64Encode,
  convertWadFromSqrtPrice,
  decodeClmmPoolPrice,
  decodeInvestmentPolicy,
  decodeProtocolConfig,
  decodeTradingLink,
  decodeVault,
  encodeArgs,
  idlInstruction,
  legWadFromSqrtPrice,
  linkConsentMessage,
  ownerComputeBudget,
  toHex,
  tryBase64Decode,
  type OwnerInstructionName,
} from "@sip/solana-core/client";
import { buildCreateVaultV2, buildSetInvestPolicy, buildWithdraw, deriveAta, deriveConfigPda, deriveInvestPda, deriveLinkPda, deriveVaultPda } from "@sip/solana-core/server";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
  type Connection,
  type ParsedAccountData,
  type VersionedTransactionResponse,
} from "@solana/web3.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createVaultApi, transactionErrorWords, type InvestPolicyBuildJson, type VaultApi } from "@/lib/vault-api";
import { createVaultFlow, investPolicyFlow, linkWalletFlow, withdrawFlow, withdrawTokenFlow, type FlowResult } from "@/lib/vault-flows";

import { ED25519_CONSENT_HEADER_HEX, GOLDEN_CONVERT_FLOOR_WAD, GOLDEN_SPYX_FLOOR_WAD, OWNER_INSTRUCTION_DATA_HEX } from "../../solana-core/test/fixtures/owner-transactions";
import { startLocalValidator, type LocalValidator, type PreloadedAccount, type StoppedValidator } from "./local-validator";
import { CLIENT_IP_HEADERS, WEB_ORIGIN, proofPortsInUse, startWebServer, withClientIp, type StoppedWebServer, type WebServer } from "./web-server";

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
/** The vault's SPYx holding: a copy of a real Token-2022 account, not the vault's ATA. */
const spyxHolding = Keypair.generate();

const key = (keypair: Keypair): string => keypair.publicKey.toBase58();

const MAINNET_RPC = "https://api.mainnet-beta.solana.com";
/** The SPYx/USDC pool's SPYx vault on mainnet: a Token-2022 account with SPYx's account extensions, 175 bytes. */
const SPYX_TEMPLATE_ACCOUNT = "CiQuPAfYp5v82vijk6u7wqFnaZqtGdJfUUSjDKAtT9ML";
const SPYX_HOLDING_RAW = 12_345_678n;

/** One read-only getAccountInfo from mainnet's public RPC, retried once if it throttles. */
async function mainnetAccountBytes(address: string): Promise<{ owner: string; data: Uint8Array }> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(MAINNET_RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [address, { encoding: "base64", commitment: "confirmed" }] }),
    });
    if (response.status === 429 && attempt === 0) {
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      continue;
    }
    const body = (await response.json()) as { result?: { value?: { owner?: string; data?: [string, string] } | null } };
    const value = body.result?.value;
    const data = tryBase64Decode(value?.data?.[0] ?? "");
    if (value?.owner === undefined || data === null) throw new Error(`mainnet did not answer the account ${address} (HTTP ${response.status})`);
    return { owner: value.owner, data };
  }
}

/** The vault's SPYx holding: the template's bytes with owner vault A, amount 12,345,678, and no delegate or close authority. */
async function spyxHoldingAccount(vault: PublicKey): Promise<PreloadedAccount> {
  const template = await mainnetAccountBytes(SPYX_TEMPLATE_ACCOUNT);
  if (template.owner !== TOKEN_2022_PROGRAM || template.data.length !== 175 || template.data[165] !== 2 || template.data[108] !== 1) {
    throw new Error("the SPYx template account is no longer an initialized 175-byte Token-2022 account");
  }
  const data = template.data.slice();
  data.set(vault.toBytes(), 32);
  new DataView(data.buffer).setBigUint64(64, SPYX_HOLDING_RAW, true);
  data[72] = 0; // delegate: none
  data[129] = 0; // close authority: none
  return {
    pubkey: key(spyxHolding),
    json: { pubkey: key(spyxHolding), account: { lamports: 10_000_000, data: [base64Encode(data), "base64"], owner: TOKEN_2022_PROGRAM, executable: false, rentEpoch: 0, space: 175 } },
  };
}

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
    spyxHolding: key(spyxHolding),
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

/** An unsigned integer's little-endian bytes as hex, `bytes` wide: how borsh writes a u64 (8) or a u128 (16). */
function leHex(value: bigint, bytes: number): string {
  if (value < 0n || value >> BigInt(8 * bytes) !== 0n) throw new RangeError(`${value} does not fit in ${bytes} bytes`);
  let hex = "";
  for (let index = 0; index < bytes; index++) hex += Number((value >> BigInt(8 * index)) & 0xffn).toString(16).padStart(2, "0");
  return hex;
}

/** `hex` with its one byte-aligned occurrence of the field `from` replaced by `to`. Zero occurrences, or two, fail the step. */
function replaceField(hex: string, from: string, to: string): string {
  const at: number[] = [];
  for (let index = hex.indexOf(from); index !== -1; index = hex.indexOf(from, index + 1)) if (index % 2 === 0) at.push(index);
  expect(at, `byte-aligned occurrences of ${from}`).toHaveLength(1);
  return hex.slice(0, at[0]) + to + hex.slice(at[0]! + from.length);
}

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
  const calls = { order: [] as string[], consent: [] as Uint8Array[], consentSigned: [] as Uint8Array[], pensionIn: [] as Uint8Array[], pensionOut: [] as Uint8Array[], tradingIn: [] as Uint8Array[] };
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
        const signature = signBytes(trading, message);
        calls.consentSigned.push(signature);
        return signature;
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

/** Sends signed bytes straight to the validator, past the web's relay, and waits for them to land. */
async function direct(transaction: Transaction, ...signers: Keypair[]): Promise<VersionedTransactionResponse> {
  const recent = await connection.getLatestBlockhash("confirmed");
  transaction.recentBlockhash = recent.blockhash;
  transaction.feePayer = signers[0]!.publicKey;
  transaction.sign(...signers);
  return landed(await connection.sendRawTransaction(transaction.serialize(), { skipPreflight: false }));
}

const tokenAmount = async (account: string): Promise<bigint> => BigInt((await connection.getTokenAccountBalance(new PublicKey(account), "confirmed")).value.amount);

/** Set once this run may have spawned something, so a start refused for a held port reports it once and stops nothing. */
let started = false;
let startedAt = 0;

beforeAll(async () => {
  startedAt = Date.now();
  // Before anything: every port of the proof is free. Nothing is spawned, and mainnet is not read, while one is held.
  const held = await proofPortsInUse();
  if (held.length > 0) throw new Error(`refusing to start: port(s) ${held.join(", ")} are in use. Nothing was started, and nothing was stopped.`);
  const vaultA = new PublicKey(deriveVaultPda(key(ownerA)).toBase58());
  const holding = await spyxHoldingAccount(vaultA);
  started = true;
  validator = await startLocalValidator(upgradeAuthority.publicKey, { accounts: [holding] });
  connection = validator.connection;
  web = await startWebServer();
  api = createVaultApi({ origin: WEB_ORIGIN, fetch: withClientIp });
});

afterAll(async () => {
  let webStopped: StoppedWebServer | null = null;
  let validatorStopped: StoppedValidator | null = null;
  try {
    webStopped = web === undefined ? null : await web.stop();
  } finally {
    validatorStopped = validator === undefined ? null : await validator.stop();
  }
  // After: nothing of this run is left. Both processes exited with their temporary directories removed, and every port of the proof is free again.
  const portsInUseAfter = started ? await proofPortsInUse() : null;
  const runSeconds = Number(((Date.now() - startedAt) / 1_000).toFixed(1));
  console.log(JSON.stringify({ event: "web-boveda.local-proof", ...report, runSeconds, stopped: { web: webStopped, validator: validatorStopped, portsInUseAfter } }, null, 1));
  if (webStopped !== null) expect(webStopped).toEqual({ exited: true, portRefused: true, homeGone: true });
  if (validatorStopped !== null) expect(validatorStopped).toEqual({ exited: true, rpcRefused: true, tempDirGone: true });
  if (portsInUseAfter !== null) expect(portsInUseAfter).toEqual([]);
});

describe("web-boveda on the tested sip_vault", () => {
  it("1. funds the keys from the faucet and reads the local rents", async () => {
    for (const keypair of [upgradeAuthority, ownerA, ownerB, ownerV]) await airdrop(keypair.publicKey, 20n * SOL);
    for (const size of [0, SIP_ACCOUNT_SPACE.Vault, SIP_ACCOUNT_SPACE.TradingLink, SIP_ACCOUNT_SPACE.InvestmentPolicy, 165, 179]) {
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
    expect(state.body.rents).toEqual({
      vault: rent(125).toString(),
      link: rent(129).toString(),
      policy: rent(970).toString(),
      tokenAccount: rent(165).toString(),
      legTokenAccounts: { [SPYX_MINT]: rent(179).toString() },
    });
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
    // The Ed25519 data the program read the consent from: the fixture's offsets header, the trading wallet's key, the signature its signMessage returned, and the 140 bytes the page rebuilt.
    expect(toHex(dataOf(tx, 2))).toBe(ED25519_CONSENT_HEADER_HEX + toHex(tradingA.publicKey.toBytes()) + toHex(signers.calls.consentSigned[0]!) + toHex(consent));
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

  it("11. investPolicyFlow signs SPYx at the cloned pools' floors, creating and paying for the vault's three token accounts; again with other caps and none; an account for another vault is refused", async () => {
    const owner = key(ownerA);
    const vault = deriveVaultPda(owner).toBase58();
    const signers = wallets(ownerA, tradingA);

    // The harness's own floors, from the cloned pools' sqrt prices, with no code of the build route.
    const [solPool, spyxPool] = await connection.getMultipleAccountsInfo([new PublicKey(SOL_USDC_POOL), new PublicKey(SPYX_USDC_POOL)], "confirmed");
    expect([solPool?.owner.toBase58(), spyxPool?.owner.toBase58()]).toEqual([RAYDIUM_CLMM, RAYDIUM_CLMM]);
    const solSqrt = decodeClmmPoolPrice(Uint8Array.from(solPool!.data)).sqrtPriceX64;
    const spyxSqrt = decodeClmmPoolPrice(Uint8Array.from(spyxPool!.data)).sqrtPriceX64;
    const convertFloor = (convertWadFromSqrtPrice(solSqrt) * 9_000n) / 10_000n;
    const legFloor = (legWadFromSqrtPrice(spyxSqrt) * 9_500n) / 10_000n;
    expect(convertFloor).toBe(((solSqrt * solSqrt * 10n ** 18n) >> 128n) * 9_000n / 10_000n);
    expect(legFloor).toBe(((((1n << 128n) * 10n ** 18n) / (spyxSqrt * spyxSqrt)) * 9_500n) / 10_000n);

    const shown: InvestPolicyBuildJson[] = [];
    const before = await lamports(owner);
    const result = await investPolicyFlow({ api, signers: signers.pension, onBuilt: (body) => void shown.push(body as InvestPolicyBuildJson) }, { pensionKey: owner });
    const signature = landedSignature(result);
    const tx = await landed(signature);
    expect(shown).toHaveLength(1);
    expect([shown[0]!.floors.convertWad, shown[0]!.floors.legs[0]!.wad]).toEqual([convertFloor.toString(), legFloor.toString()]);

    expect(programsOf(tx)).toEqual([COMPUTE_BUDGET, COMPUTE_BUDGET, ATA_PROGRAM, ATA_PROGRAM, ATA_PROGRAM, SIP_PROGRAM_ID]);
    // The landed data is the core fixture with only its two floors put in from the cloned pools: the same basket, venue, in-mint, $5 minimum, caps and switch.
    const firstPolicyData = replaceField(
      replaceField(OWNER_INSTRUCTION_DATA_HEX.SET_INVEST_POLICY_GOLDEN_FLOORS, leHex(GOLDEN_SPYX_FLOOR_WAD, 16), leHex(legFloor, 16)),
      leHex(GOLDEN_CONVERT_FLOOR_WAD, 16),
      leHex(convertFloor, 16),
    );
    expect(toHex(dataOf(tx, 5))).toBe(firstPolicyData);
    expect(signers.calls.pensionIn[0]!.length).toBeLessThanOrEqual(1_232);
    const policyAddress = new PublicKey(deriveInvestPda(vault).toBase58());
    const policy = decodeInvestmentPolicy(Uint8Array.from((await connection.getAccountInfo(policyAddress, "confirmed"))!.data));
    expect(policy).toMatchObject({
      vault,
      enabled: true,
      venueProgram: RAYDIUM_CLMM,
      inMint: USDC_MINT,
      legs: [{ mint: SPYX_MINT, weightBps: 10_000, minOutRateWad: legFloor }],
      minConvertRateWad: convertFloor,
      minInvestment: 5_000_000n,
      maxPerCall: DEFAULT_INVEST_CAPS.maxPerCall,
      maxRolling30d: DEFAULT_INVEST_CAPS.maxRolling30d,
      policyNonce: 1n,
    });
    expect(policy.bucketAmounts.every((amount) => amount === 0n)).toBe(true);

    const expected = [
      { mint: WSOL_MINT, program: TOKEN_PROGRAM, size: 165 },
      { mint: USDC_MINT, program: TOKEN_PROGRAM, size: 165 },
      { mint: SPYX_MINT, program: TOKEN_2022_PROGRAM, size: 179 },
    ];
    for (const { mint, program, size } of expected) {
      const address = new PublicKey(deriveAta(vault, mint, program).toBase58());
      const account = await connection.getParsedAccountInfo(address, "confirmed");
      const value = account.value!;
      expect([value.owner.toBase58(), (value as { space?: number }).space]).toEqual([program, size]);
      const info = (value.data as ParsedAccountData).parsed.info as { owner: string; mint: string; isNative: boolean; state: string; extensions?: { extension: string }[] };
      expect([info.owner, info.mint, info.state]).toEqual([vault, mint, "initialized"]);
      if (mint === SPYX_MINT) expect(info.extensions?.map((extension) => extension.extension)).toEqual(["immutableOwner", "pausableAccount", "transferHookAccount"]);
    }
    expect((await lamports(owner)) - before).toBe(-(rent(970) + 2n * rent(165) + rent(179) + BigInt(tx.meta!.fee)));
    withinHalf("set_invest_policy", tx, "set_invest_policy ownerA with 3 token accounts", signature);

    const beforeAgain = await lamports(owner);
    const again = await investPolicyFlow({ api, signers: signers.pension }, { pensionKey: owner, maxPerCall: 10_000_000n, maxRolling30d: 50_000_000n });
    const againSignature = landedSignature(again);
    const againTx = await landed(againSignature);
    expect(programsOf(againTx)).toEqual([COMPUTE_BUDGET, COMPUTE_BUDGET, SIP_PROGRAM_ID]);
    // The same bytes with only the two caps changed to $10 and $50.
    expect(toHex(dataOf(againTx, 2))).toBe(
      replaceField(replaceField(firstPolicyData, leHex(DEFAULT_INVEST_CAPS.maxPerCall, 8), leHex(10_000_000n, 8)), leHex(DEFAULT_INVEST_CAPS.maxRolling30d, 8), leHex(50_000_000n, 8)),
    );
    const resigned = decodeInvestmentPolicy(Uint8Array.from((await connection.getAccountInfo(policyAddress, "confirmed"))!.data));
    expect(resigned).toMatchObject({ policyNonce: 2n, maxPerCall: 10_000_000n, maxRolling30d: 50_000_000n });
    expect((await lamports(owner)) - beforeAgain).toBe(-BigInt(againTx.meta!.fee));
    withinHalf("set_invest_policy", againTx, "set_invest_policy ownerA again", againSignature);

    // The core builder with a token account for ownerB's vault spliced in front, signed by ownerA.
    const recent = await connection.getLatestBlockhash("confirmed");
    const honest = buildSetInvestPolicy({
      owner,
      legs: [{ mint: SPYX_MINT, weightBps: 10_000, minOutRateWad: legFloor }],
      minConvertRateWad: convertFloor,
      minInvestment: 5_000_000n,
      maxPerCall: 10_000_000n,
      maxRolling30d: 50_000_000n,
      enabled: true,
      blockhash: recent.blockhash,
      computeBudget: ownerComputeBudget("set_invest_policy"),
    });
    const forged = Transaction.from(Buffer.from(tryBase64Decode(honest.txBase64)!));
    const otherVault = new PublicKey(deriveVaultPda(key(ownerB)).toBase58());
    const theirs = new PublicKey(deriveAta(otherVault.toBase58(), WSOL_MINT, TOKEN_PROGRAM).toBase58());
    forged.instructions.splice(
      2,
      0,
      new TransactionInstruction({
        programId: new PublicKey(ATA_PROGRAM),
        keys: [
          { pubkey: ownerA.publicKey, isSigner: true, isWritable: true },
          { pubkey: theirs, isSigner: false, isWritable: true },
          { pubkey: otherVault, isSigner: false, isWritable: false },
          { pubkey: new PublicKey(WSOL_MINT), isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: new PublicKey(TOKEN_PROGRAM), isSigner: false, isWritable: false },
        ],
        data: Buffer.from([1]),
      }),
    );
    forged.sign(ownerA);
    expect(await api.send(Uint8Array.from(forged.serialize()))).toMatchObject({ ok: false, status: 422, code: "vault_account_invalid" });
  });

  it("12. withdraw: a deposit the relay refuses lands straight on the validator, a lamport past what the vault can release is refused, withdrawFlow lands, and the program's own refusal reads in words", async () => {
    const owner = key(ownerA);
    const vault = new PublicKey(deriveVaultPda(owner).toBase58());

    const deposit = new Transaction({ feePayer: ownerA.publicKey, recentBlockhash: (await connection.getLatestBlockhash("confirmed")).blockhash }).add(
      SystemProgram.transfer({ fromPubkey: ownerA.publicKey, toPubkey: vault, lamports: 200_000_000 }),
    );
    deposit.sign(ownerA);
    expect(await api.send(Uint8Array.from(deposit.serialize()))).toMatchObject({ ok: false, status: 422, code: "program_not_allowed" });
    await direct(new Transaction().add(SystemProgram.transfer({ fromPubkey: ownerA.publicKey, toPubkey: vault, lamports: 200_000_000 })), ownerA);

    const state = await api.state({ owner, wallets: [] });
    expect(state.ok && state.body.vault.withdrawableLamports).toBe("200000000");
    expect(await api.build({ action: "withdraw", owner, lamports: "200000001" })).toMatchObject({ ok: false, status: 422, code: "above_withdrawable", body: { withdrawableLamports: "200000000" } });

    const [ownerBefore, vaultBefore] = [await lamports(owner), await lamports(vault.toBase58())];
    const result = await withdrawFlow({ api, signers: wallets(ownerA, tradingA).pension }, { pensionKey: owner, lamports: 150_000_000n });
    const signature = landedSignature(result);
    const tx = await landed(signature);
    expect((await lamports(vault.toBase58())) - vaultBefore).toBe(-150_000_000n);
    expect((await lamports(owner)) - ownerBefore).toBe(150_000_000n - BigInt(tx.meta!.fee));
    expect(programsOf(tx)).toEqual([COMPUTE_BUDGET, COMPUTE_BUDGET, SIP_PROGRAM_ID]);
    expect(toHex(dataOf(tx, 2))).toBe(OWNER_INSTRUCTION_DATA_HEX.WITHDRAW_150000000);
    withinHalf("withdraw", tx, "withdraw ownerA 150000000", signature);

    // The core builder past the rent floor: the relay's simulation answers the program's 6004.
    const recent = await connection.getLatestBlockhash("confirmed");
    const above = buildWithdraw({ owner, lamports: 50_000_001n, blockhash: recent.blockhash, computeBudget: ownerComputeBudget("withdraw") });
    const refused = await api.send(signWith(tryBase64Decode(above.txBase64)!, ownerA));
    expect(refused).toMatchObject({ ok: false, status: 422, code: "simulation_failed", body: { err: { InstructionError: [2, { Custom: 6004 }] } } });
    if (!refused.ok) expect(transactionErrorWords(refused.body.err, refused.body.logs)).toContain("below its rent reserve");
  });

  it("13. withdraw_token for wSOL: SOL synced into the vault's wSOL account comes back to the pension key as SOL, and its account closes", async () => {
    const owner = key(ownerA);
    const vault = deriveVaultPda(owner).toBase58();
    const vaultWsol = new PublicKey(deriveAta(vault, WSOL_MINT, TOKEN_PROGRAM).toBase58());
    await direct(
      new Transaction().add(
        SystemProgram.transfer({ fromPubkey: ownerA.publicKey, toPubkey: vaultWsol, lamports: 100_000_000 }),
        new TransactionInstruction({ programId: new PublicKey(TOKEN_PROGRAM), keys: [{ pubkey: vaultWsol, isSigner: false, isWritable: true }], data: Buffer.from([17]) }),
      ),
      ownerA,
    );

    const state = await api.state({ owner, wallets: [] });
    if (!state.ok) throw new Error(state.code);
    const holding = state.body.holdings.items.find((item) => item.mint === WSOL_MINT);
    expect(holding).toMatchObject({ tokenAccount: vaultWsol.toBase58(), amountRaw: "100000000", tokenProgram: TOKEN_PROGRAM });

    const before = await lamports(owner);
    const result = await withdrawTokenFlow(
      { api, signers: wallets(ownerA, tradingA).pension },
      { pensionKey: owner, mint: WSOL_MINT, amountRaw: BigInt(holding!.amountRaw), vaultTokenAccount: holding!.tokenAccount, tokenProgram: holding!.tokenProgram },
    );
    const signature = landedSignature(result);
    const tx = await landed(signature);
    expect(await tokenAmount(vaultWsol.toBase58())).toBe(0n);
    expect(await connection.getAccountInfo(new PublicKey(deriveAta(owner, WSOL_MINT, TOKEN_PROGRAM).toBase58()), "confirmed")).toBeNull();
    expect((await lamports(owner)) - before).toBe(100_000_000n - BigInt(tx.meta!.fee));
    expect(toHex(dataOf(tx, 2))).toBe(OWNER_INSTRUCTION_DATA_HEX.WITHDRAW_TOKEN_100000000);
    withinHalf("withdraw_token", tx, "withdraw_token ownerA wSOL", signature);
  });

  it("14. withdraw_token for SPYx on Token-2022: from the holding that is not the vault's ATA, into the pension key's own new account, which it pays for", async () => {
    const owner = key(ownerA);
    const state = await api.state({ owner, wallets: [] });
    if (!state.ok) throw new Error(state.code);
    const holding = state.body.holdings.items.find((item) => item.mint === SPYX_MINT);
    expect(holding).toMatchObject({ tokenAccount: key(spyxHolding), amountRaw: SPYX_HOLDING_RAW.toString(), tokenProgram: TOKEN_2022_PROGRAM });

    const built = await api.build<{ vaultTokenAccount: string }>({ action: "withdrawToken", owner, mint: SPYX_MINT, amountRaw: SPYX_HOLDING_RAW.toString() });
    expect(built.ok && built.body.vaultTokenAccount).toBe(key(spyxHolding));

    const before = await lamports(owner);
    const result = await withdrawTokenFlow(
      { api, signers: wallets(ownerA, tradingA).pension },
      { pensionKey: owner, mint: SPYX_MINT, amountRaw: SPYX_HOLDING_RAW, vaultTokenAccount: holding!.tokenAccount, tokenProgram: holding!.tokenProgram },
    );
    const signature = landedSignature(result);
    const tx = await landed(signature);
    expect(await tokenAmount(key(spyxHolding))).toBe(0n);
    const ownerSpyx = new PublicKey(deriveAta(owner, SPYX_MINT, TOKEN_2022_PROGRAM).toBase58());
    const parsed = (await connection.getParsedAccountInfo(ownerSpyx, "confirmed")).value!;
    expect([parsed.owner.toBase58(), (parsed as { space?: number }).space]).toEqual([TOKEN_2022_PROGRAM, 179]);
    expect(((parsed.data as ParsedAccountData).parsed.info as { owner: string }).owner).toBe(owner);
    expect(await tokenAmount(ownerSpyx.toBase58())).toBe(SPYX_HOLDING_RAW);
    expect((await lamports(owner)) - before).toBe(-(rent(179) + BigInt(tx.meta!.fee)));
    expect(toHex(dataOf(tx, 2))).toBe(OWNER_INSTRUCTION_DATA_HEX.WITHDRAW_TOKEN_12345678);
    withinHalf("withdraw_token", tx, "withdraw_token ownerA SPYx", signature);
  });

  it("15. the live build route refuses a cross-site request, text/plain and an unknown action", async () => {
    expect((await rawBuild({ action: "createVault", owner: key(ownerA), mode: 0 }, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await rawBuild(JSON.stringify({ action: "createVault" }), { "content-type": "text/plain" })).status).toBe(415);
    expect((await rawBuild({ action: "mintMoney", owner: key(ownerA) })).status).toBe(400);
  });

  it("16. every landing used at most half of its compute limit", () => {
    const landings = Object.values(report.units);
    // Part 1's five, two policies, a withdrawal, and the wSOL and SPYx token withdrawals.
    expect(landings.length).toBe(10);
    for (const { consumed, limit } of landings) expect(consumed).toBeLessThanOrEqual(limit / 2);
  });
});
