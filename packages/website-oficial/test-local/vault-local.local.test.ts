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
// PHANTOM'S MAINNET REWRITE. Step 17 signs every Phantom-signed flow the way
// Phantom does on mainnet: Lighthouse checks in the byte shapes decoded from
// mainnet appended after SaverFi's instructions, the message compiled again. The
// page and the relay accept them, and the checks run on Lighthouse cloned from
// mainnet, each landing within half of its compute limit.
//
// Step 18 signs them again for a fresh pension key the way Phantom sometimes
// opens a transaction: a block of pre-state checks right after the compute
// budget, one on each account SaverFi writes besides the pension key, before the
// consent's Ed25519SigVerify for a link, and the usual checks after.
//
// NOT PROVABLE HERE: Privy's TEE signMessage and signTransaction, which checks
// Phantom itself chooses and where, mainnet rent (the local validator charges 6,960
// lamports per byte, so every rent is read, never typed), and Solscan pages (only
// the link's format is asserted).
//
// NOT PART OF `pnpm test`. Node 22, solana-test-validator and the tested binary:
// `pnpm --filter @sip/web run build && pnpm --dir packages/website-oficial
// test:local`, with SIP_LOCAL_PROGRAM_SO naming the binary when this checkout has
// no target/.

import {
  ATA_PROGRAM,
  DEFAULT_INVEST_CAPS,
  DEFAULT_VAULT_POLICY,
  LIGHTHOUSE_PROGRAM,
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
import { createVaultFlow, investPolicyFlow, linkWalletFlow, pauseInvestingFlow, withdrawFlow, withdrawTokenFlow, type FlowResult } from "@/lib/vault-flows";

import { ED25519_CONSENT_HEADER_HEX, GOLDEN_CONVERT_FLOOR_WAD, GOLDEN_SPYX_FLOOR_WAD, OWNER_INSTRUCTION_DATA_HEX } from "../../solana-core/test/fixtures/owner-transactions";
import { startLocalValidator, type LocalValidator, type StoppedValidator } from "./local-validator";
// The waits, the throwaway signers and the mainnet template: shared with the
// live proof rather than copied, so one cannot drift from the other.
import { PHANTOM_CHECK, createProofChain, lighthouseCheck, phantomOnMainnet, signBytes, signWith, spyxHoldingAccount, wallets } from "./proof-helpers";
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
/** The pension key and trading wallet whose flows Phantom signs the mainnet way (step 17). */
const ownerL = Keypair.generate();
const tradingL = Keypair.generate();
/** The pension key and trading wallet whose flows Phantom opens with pre-state checks (step 18). */
const ownerP = Keypair.generate();
const tradingP = Keypair.generate();
/** The vault's SPYx holding: a copy of a real Token-2022 account, not the vault's ATA. */
const spyxHolding = Keypair.generate();

const key = (keypair: Keypair): string => keypair.publicKey.toBase58();

const SPYX_HOLDING_RAW = 12_345_678n;

let validator: LocalValidator | undefined;
let web: WebServer | undefined;
let connection: Connection;
let api: VaultApi;
const rents = new Map<number, bigint>();
let configured = false;

// The validator opens in beforeAll, so the helpers read the connection through a
// getter. Bound to the same names the steps below already use.
const { confirmed, landed, airdrop, direct } = createProofChain(() => connection);

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
    ownerL: key(ownerL),
    tradingL: key(tradingL),
    ownerP: key(ownerP),
    tradingP: key(tradingP),
  },
  rents: {} as Record<string, string>,
  signatures: {} as Record<string, string>,
  units: {} as Record<string, { consumed: number; limit: number }>,
  lighthouse: {} as Record<string, { consumed: number; limit: number; checks: number; leading?: number; signature: string }>,
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function earlier<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`${what} did not complete, so this step cannot run`);
  return value;
}

const rent = (size: number): bigint => earlier(rents.get(size), `the rent for ${size} bytes`);
const lamports = async (address: string): Promise<bigint> => BigInt(await connection.getBalance(new PublicKey(address), "confirmed"));


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

async function rawBuild(body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: { error?: { code?: string; vault?: string } } }> {
  const response = await fetch(`${WEB_ORIGIN}/api/solana-build`, {
    method: "POST",
    headers: { "content-type": "application/json", ...CLIENT_IP_HEADERS, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json()) as never };
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
  const holding = await spyxHoldingAccount({ vault: vaultA, at: spyxHolding.publicKey, amountRaw: SPYX_HOLDING_RAW });
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

    // Pause: the policy /api/solana-vault shows, signed again with investing off. The landed data is "again"'s with only its last byte, enabled, turned to 0.
    const shownState = await api.state({ owner, wallets: [] });
    if (!shownState.ok || shownState.body.policy.state === undefined) throw new Error("the policy could not be read back through /api/solana-vault");
    const beforePause = await lamports(owner);
    const paused = await pauseInvestingFlow({ api, signers: signers.pension }, { pensionKey: owner, policy: shownState.body.policy.state });
    const pauseSignature = landedSignature(paused);
    const pauseTx = await landed(pauseSignature);
    expect(programsOf(pauseTx)).toEqual([COMPUTE_BUDGET, COMPUTE_BUDGET, SIP_PROGRAM_ID]);
    const againData = toHex(dataOf(againTx, 2));
    expect(againData.endsWith("01")).toBe(true);
    expect(toHex(dataOf(pauseTx, 2))).toBe(`${againData.slice(0, -2)}00`);
    const pausedPolicy = decodeInvestmentPolicy(Uint8Array.from((await connection.getAccountInfo(policyAddress, "confirmed"))!.data));
    expect(pausedPolicy).toMatchObject({ enabled: false, policyNonce: 3n, minConvertRateWad: convertFloor, legs: [{ mint: SPYX_MINT, weightBps: 10_000, minOutRateWad: legFloor }], maxPerCall: 10_000_000n, maxRolling30d: 50_000_000n });
    expect((await lamports(owner)) - beforePause).toBe(-BigInt(pauseTx.meta!.fee));
    withinHalf("set_invest_policy", pauseTx, "set_invest_policy ownerA paused", pauseSignature);
    expect(await api.build({ action: "pauseInvesting", owner })).toMatchObject({ ok: false, status: 409, code: "already_paused" });

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
    // The vault's own accounts, read by address with jsonParsed and no listing: the same balance, and SPYx's empty account parsed under Token-2022.
    const own = state.body.vaultTokenAccounts.items;
    expect(own.find((item) => item.mint === WSOL_MINT)).toMatchObject({ address: vaultWsol.toBase58(), status: "exists", amountRaw: "100000000", decimals: 9, uiAmount: "0.1" });
    expect(own.find((item) => item.mint === SPYX_MINT)).toMatchObject({ status: "exists", amountRaw: "0", decimals: 8 });

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

    const built = await api.build<{ vaultTokenAccount: string }>({ action: "withdrawToken", owner, mint: SPYX_MINT, amountRaw: SPYX_HOLDING_RAW.toString(), vaultToken: key(spyxHolding) });
    expect(built.ok && built.body.vaultTokenAccount).toBe(key(spyxHolding));
    // The vault's own SPYx account exists and is empty: named as the source, it is refused before anything is built.
    const emptyAta = deriveAta(deriveVaultPda(owner).toBase58(), SPYX_MINT, TOKEN_2022_PROGRAM).toBase58();
    expect(await api.build({ action: "withdrawToken", owner, mint: SPYX_MINT, amountRaw: "1", vaultToken: emptyAta })).toMatchObject({ ok: false, status: 422, code: "not_held" });

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

  it("15b. a pension key short of SOL is told by the validator's own refusal to add SOL, with what the action costs; one that never held SOL too", async () => {
    // Enough for the fees, not for the vault's rent: the System program refuses to fund the account.
    const short = Keypair.generate();
    await direct(new Transaction().add(SystemProgram.transfer({ fromPubkey: ownerA.publicKey, toPubkey: short.publicKey, lamports: 1_000_000 })), ownerA);
    const quoted = rent(125) + 5_000n + 6_000n;
    const refused = await createVaultFlow({ api, signers: wallets(short, tradingA).pension }, { pensionKey: key(short), mode: 0 });
    expect(refused).toMatchObject({ ok: false, kind: "refused", code: "simulation_failed" });
    expect(!refused.ok && refused.message).toBe(
      `Your pension key needs more SOL: this action costs about ${Number(quoted) / 1e9} SOL in rent and fees. Add SOL in Phantom, then try again. Nothing moved.`,
    );
    expect(await connection.getAccountInfo(new PublicKey(deriveVaultPda(key(short)).toBase58()), "confirmed")).toBeNull();

    // Never funded: the simulation cannot find the fee payer at all.
    const empty = Keypair.generate();
    const none = await createVaultFlow({ api, signers: wallets(empty, tradingA).pension }, { pensionKey: key(empty), mode: 0 });
    expect(none).toMatchObject({ ok: false, kind: "refused" });
    expect(!none.ok && none.message).toContain("Add SOL in Phantom, then try again.");
  });

  it("16. every landing used at most half of its compute limit", () => {
    const landings = Object.values(report.units);
    // Part 1's five, two policies and a pause, a withdrawal, and the wSOL and SPYx token withdrawals.
    expect(landings.length).toBe(11);
    for (const { consumed, limit } of landings) expect(consumed).toBeLessThanOrEqual(limit / 2);
  });

  it("17. Phantom's mainnet rewrite: create, link, withdraw, a first policy and withdraw_token each land with Lighthouse checks after SaverFi's instructions, run by the cloned Lighthouse program, within half of each compute limit", async () => {
    earlier(configured || undefined, "init_config");
    const owner = key(ownerL);
    const wallet = key(tradingL);
    const vault = deriveVaultPda(owner).toBase58();
    await airdrop(ownerL.publicKey, 20n * SOL);

    // Phantom's check on the pension key: after the transaction it holds at least what it holds now less 0.1 SOL, and is still a system account with no data.
    const payerCheck = async (): Promise<TransactionInstruction> => lighthouseCheck(PHANTOM_CHECK.payer((await lamports(owner)) - SOL / 10n), owner);
    const lands = async (label: string, name: OwnerInstructionName, result: FlowResult, own: readonly string[], checks: number): Promise<VersionedTransactionResponse> => {
      const signature = landedSignature(result);
      const tx = await landed(signature);
      expect(programsOf(tx), label).toEqual([...own, ...new Array<string>(checks).fill(LIGHTHOUSE_PROGRAM)]);
      expect(tx.meta?.logMessages?.filter((line) => line === `Program ${LIGHTHOUSE_PROGRAM} success`), label).toHaveLength(checks);
      const consumed = tx.meta?.computeUnitsConsumed;
      expect(typeof consumed, label).toBe("number");
      expect(consumed!, label).toBeLessThanOrEqual(OWNER_TX_COMPUTE[name] / 2);
      report.lighthouse[label] = { consumed: consumed!, limit: OWNER_TX_COMPUTE[name], checks, signature };
      return tx;
    };

    const create = phantomOnMainnet(ownerL, async () => [await payerCheck()]);
    const created = await lands("create_vault_v2", "create_vault_v2", await createVaultFlow({ api, signers: create.pension }, { pensionKey: owner, mode: 0 }), [COMPUTE_BUDGET, COMPUTE_BUDGET, SIP_PROGRAM_ID], 1);
    expect(toHex(dataOf(created, 2))).toBe(OWNER_INSTRUCTION_DATA_HEX.CREATE_VAULT_V2_PROFIT_DEFAULTS);

    // The link: checks on the pension key, the new trading link and the trading wallet; the consent still right before link_wallet; the trading wallet co-signs Phantom's rewritten bytes.
    const link = phantomOnMainnet(ownerL, async () => [await payerCheck(), lighthouseCheck(PHANTOM_CHECK.owner(SIP_PROGRAM_ID), deriveLinkPda(wallet).toBase58()), lighthouseCheck(PHANTOM_CHECK.system(), wallet)]);
    const trading = wallets(ownerL, tradingL);
    const linked = await lands(
      "link_wallet",
      "link_wallet",
      await linkWalletFlow({ api, pension: link.pension, trading: trading.trading }, { pensionKey: owner, tradingAddress: wallet }),
      [COMPUTE_BUDGET, COMPUTE_BUDGET, ED25519, SIP_PROGRAM_ID],
      3,
    );
    expect(toHex(trading.calls.tradingIn[0]!)).toBe(toHex(link.calls.pensionOut[0]!));
    expect(signersOf(linked)).toEqual([owner, wallet]);
    expect(toHex(dataOf(linked, 3))).toBe(OWNER_INSTRUCTION_DATA_HEX.LINK_WALLET);
    expect(decodeTradingLink(Uint8Array.from(earlier((await connection.getAccountInfo(new PublicKey(deriveLinkPda(wallet).toBase58()), "confirmed")) ?? undefined, "the link account").data))).toMatchObject({ wallet, vault });

    await direct(new Transaction().add(SystemProgram.transfer({ fromPubkey: ownerL.publicKey, toPubkey: new PublicKey(vault), lamports: 200_000_000 })), ownerL);
    const withdraw = phantomOnMainnet(ownerL, async () => [await payerCheck()]);
    const withdrawn = await lands("withdraw", "withdraw", await withdrawFlow({ api, signers: withdraw.pension }, { pensionKey: owner, lamports: 150_000_000n }), [COMPUTE_BUDGET, COMPUTE_BUDGET, SIP_PROGRAM_ID], 1);
    expect(toHex(dataOf(withdrawn, 2))).toBe(OWNER_INSTRUCTION_DATA_HEX.WITHDRAW_150000000);

    // A first policy: the pension key's check and one on each token account it creates for the vault.
    const vaultAccounts = [
      [WSOL_MINT, TOKEN_PROGRAM],
      [USDC_MINT, TOKEN_PROGRAM],
      [SPYX_MINT, TOKEN_2022_PROGRAM],
    ].map(([mint, program]) => deriveAta(vault, mint!, program!).toBase58());
    const policy = phantomOnMainnet(ownerL, async () => [await payerCheck(), ...vaultAccounts.map((account) => lighthouseCheck(PHANTOM_CHECK.tokenAccount(), account))]);
    await lands("set_invest_policy", "set_invest_policy", await investPolicyFlow({ api, signers: policy.pension }, { pensionKey: owner }), [COMPUTE_BUDGET, COMPUTE_BUDGET, ATA_PROGRAM, ATA_PROGRAM, ATA_PROGRAM, SIP_PROGRAM_ID], 4);
    expect(policy.calls.pensionOut[0]!.length).toBeLessThanOrEqual(1_232);

    // wSOL synced into the vault's account comes back, with a check on that account too.
    const vaultWsol = vaultAccounts[0]!;
    await direct(
      new Transaction().add(
        SystemProgram.transfer({ fromPubkey: ownerL.publicKey, toPubkey: new PublicKey(vaultWsol), lamports: 100_000_000 }),
        new TransactionInstruction({ programId: new PublicKey(TOKEN_PROGRAM), keys: [{ pubkey: new PublicKey(vaultWsol), isSigner: false, isWritable: true }], data: Buffer.from([17]) }),
      ),
      ownerL,
    );
    const token = phantomOnMainnet(ownerL, async () => [await payerCheck(), lighthouseCheck(PHANTOM_CHECK.tokenAccount(), vaultWsol)]);
    const taken = await lands(
      "withdraw_token",
      "withdraw_token",
      await withdrawTokenFlow({ api, signers: token.pension }, { pensionKey: owner, mint: WSOL_MINT, amountRaw: 100_000_000n, vaultTokenAccount: vaultWsol, tokenProgram: TOKEN_PROGRAM }),
      [COMPUTE_BUDGET, COMPUTE_BUDGET, SIP_PROGRAM_ID],
      2,
    );
    expect(toHex(dataOf(taken, 2))).toBe(OWNER_INSTRUCTION_DATA_HEX.WITHDRAW_TOKEN_100000000);
    expect(await tokenAmount(vaultWsol)).toBe(0n);
  });

  it("18. Phantom's leading block: create, link, withdraw, a first policy and withdraw_token each land with pre-state checks right after the compute budget on every account SaverFi writes besides the pension key, and checks after, run by the cloned Lighthouse program, within half of each compute limit", async () => {
    earlier(configured || undefined, "init_config");
    const owner = key(ownerP);
    const wallet = key(tradingP);
    const vault = deriveVaultPda(owner).toBase58();
    const tradingLink = deriveLinkPda(wallet).toBase58();
    await airdrop(ownerP.publicKey, 20n * SOL);

    const payerCheck = async (): Promise<TransactionInstruction> => lighthouseCheck(PHANTOM_CHECK.payer((await lamports(owner)) - SOL / 10n), owner);
    const LIGHTHOUSE_SUCCESS = `Program ${LIGHTHOUSE_PROGRAM} success`;
    const lands = async (label: string, name: OwnerInstructionName, result: FlowResult, own: readonly string[], leading: number, checks: number): Promise<VersionedTransactionResponse> => {
      const signature = landedSignature(result);
      const tx = await landed(signature);
      const [limit, price, ...rest] = own;
      expect(programsOf(tx), label).toEqual([limit, price, ...new Array<string>(leading).fill(LIGHTHOUSE_PROGRAM), ...rest, ...new Array<string>(checks).fill(LIGHTHOUSE_PROGRAM)]);
      expect(tx.meta?.logMessages?.filter((line) => line === LIGHTHOUSE_SUCCESS), label).toHaveLength(leading + checks);
      const consumed = tx.meta?.computeUnitsConsumed;
      expect(typeof consumed, label).toBe("number");
      expect(consumed!, label).toBeLessThanOrEqual(OWNER_TX_COMPUTE[name] / 2);
      report.lighthouse[`leading ${label}`] = { consumed: consumed!, limit: OWNER_TX_COMPUTE[name], checks: leading + checks, leading, signature };
      return tx;
    };

    // No lamports yet on the vault create_vault_v2 makes.
    const create = phantomOnMainnet(ownerP, async () => [await payerCheck()], async () => [lighthouseCheck(PHANTOM_CHECK.created(), vault)]);
    const created = await lands("create_vault_v2", "create_vault_v2", await createVaultFlow({ api, signers: create.pension }, { pensionKey: owner, mode: 0 }), [COMPUTE_BUDGET, COMPUTE_BUDGET, SIP_PROGRAM_ID], 1, 1);
    expect(toHex(dataOf(created, 3))).toBe(OWNER_INSTRUCTION_DATA_HEX.CREATE_VAULT_V2_PROFIT_DEFAULTS);

    // SaverFi's two-signer shape: no lamports yet on the trading link, ahead of the consent, which the program still reads at link_wallet's index - 1.
    const link = phantomOnMainnet(ownerP, async () => [await payerCheck(), lighthouseCheck(PHANTOM_CHECK.owner(SIP_PROGRAM_ID), tradingLink)], async () => [lighthouseCheck(PHANTOM_CHECK.created(), tradingLink)]);
    const trading = wallets(ownerP, tradingP);
    const linked = await lands(
      "link_wallet",
      "link_wallet",
      await linkWalletFlow({ api, pension: link.pension, trading: trading.trading }, { pensionKey: owner, tradingAddress: wallet }),
      [COMPUTE_BUDGET, COMPUTE_BUDGET, ED25519, SIP_PROGRAM_ID],
      1,
      2,
    );
    expect(toHex(trading.calls.tradingIn[0]!)).toBe(toHex(link.calls.pensionOut[0]!));
    expect(signersOf(linked)).toEqual([owner, wallet]);
    expect(toHex(dataOf(linked, 4))).toBe(OWNER_INSTRUCTION_DATA_HEX.LINK_WALLET);
    expect(toHex(dataOf(linked, 3)).startsWith(ED25519_CONSENT_HEADER_HEX + toHex(tradingP.publicKey.toBytes()))).toBe(true);
    expect(decodeTradingLink(Uint8Array.from(earlier((await connection.getAccountInfo(new PublicKey(tradingLink), "confirmed")) ?? undefined, "the link account").data))).toMatchObject({ wallet, vault });

    // The vault's owner before withdraw.
    await direct(new Transaction().add(SystemProgram.transfer({ fromPubkey: ownerP.publicKey, toPubkey: new PublicKey(vault), lamports: 200_000_000 })), ownerP);
    const withdraw = phantomOnMainnet(ownerP, async () => [await payerCheck()], async () => [lighthouseCheck(PHANTOM_CHECK.owner(SIP_PROGRAM_ID), vault)]);
    const withdrawn = await lands("withdraw", "withdraw", await withdrawFlow({ api, signers: withdraw.pension }, { pensionKey: owner, lamports: 150_000_000n }), [COMPUTE_BUDGET, COMPUTE_BUDGET, SIP_PROGRAM_ID], 1, 1);
    expect(toHex(dataOf(withdrawn, 3))).toBe(OWNER_INSTRUCTION_DATA_HEX.WITHDRAW_150000000);

    // A first policy: no lamports yet on the policy and on the three token accounts, the most checks a leading block may hold.
    const vaultAccounts = [
      [WSOL_MINT, TOKEN_PROGRAM],
      [USDC_MINT, TOKEN_PROGRAM],
      [SPYX_MINT, TOKEN_2022_PROGRAM],
    ].map(([mint, program]) => deriveAta(vault, mint!, program!).toBase58());
    const policyAccount = deriveInvestPda(vault).toBase58();
    const policy = phantomOnMainnet(
      ownerP,
      async () => [await payerCheck(), ...vaultAccounts.map((account) => lighthouseCheck(PHANTOM_CHECK.tokenAccount(), account))],
      async () => [policyAccount, ...vaultAccounts].map((account) => lighthouseCheck(PHANTOM_CHECK.created(), account)),
    );
    await lands("set_invest_policy", "set_invest_policy", await investPolicyFlow({ api, signers: policy.pension }, { pensionKey: owner }), [COMPUTE_BUDGET, COMPUTE_BUDGET, ATA_PROGRAM, ATA_PROGRAM, ATA_PROGRAM, SIP_PROGRAM_ID], 4, 4);
    expect(policy.calls.pensionOut[0]!.length).toBeLessThanOrEqual(1_232);

    // withdraw_token: the vault's wSOL account's delegate and derivation, and no lamports yet on the pension key's wSOL account.
    const vaultWsol = vaultAccounts[0]!;
    const ownerWsol = deriveAta(owner, WSOL_MINT, TOKEN_PROGRAM).toBase58();
    await direct(
      new Transaction().add(
        SystemProgram.transfer({ fromPubkey: ownerP.publicKey, toPubkey: new PublicKey(vaultWsol), lamports: 100_000_000 }),
        new TransactionInstruction({ programId: new PublicKey(TOKEN_PROGRAM), keys: [{ pubkey: new PublicKey(vaultWsol), isSigner: false, isWritable: true }], data: Buffer.from([17]) }),
      ),
      ownerP,
    );
    expect(await connection.getAccountInfo(new PublicKey(ownerWsol), "confirmed")).toBeNull();
    const token = phantomOnMainnet(ownerP, async () => [await payerCheck()], async () => [lighthouseCheck(PHANTOM_CHECK.tokenAccount(), vaultWsol), lighthouseCheck(PHANTOM_CHECK.created(), ownerWsol)]);
    const taken = await lands(
      "withdraw_token",
      "withdraw_token",
      await withdrawTokenFlow({ api, signers: token.pension }, { pensionKey: owner, mint: WSOL_MINT, amountRaw: 100_000_000n, vaultTokenAccount: vaultWsol, tokenProgram: TOKEN_PROGRAM }),
      [COMPUTE_BUDGET, COMPUTE_BUDGET, SIP_PROGRAM_ID],
      2,
      1,
    );
    expect(toHex(dataOf(taken, 4))).toBe(OWNER_INSTRUCTION_DATA_HEX.WITHDRAW_TOKEN_100000000);
    expect(await tokenAmount(vaultWsol)).toBe(0n);
  });
});
