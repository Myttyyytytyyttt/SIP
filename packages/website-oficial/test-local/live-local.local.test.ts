// The local proof for web-panel-live: a vault that really settled, wrapped,
// received, withdrew and paid out a token — then read back through the web's own
// /api/solana-live, over HTTP, against its production build.
//
// WHAT THIS PROVES THAT A UNIT TEST CANNOT. The dashboard's numbers come from a
// route reading a real validator running the tested sip_vault.so, through the
// web's own client. The chain is the oracle: every figure asserted below is read
// again straight from the validator with independent decoders, never from the
// answer being checked.
//
// A SETTLEMENT IS MADE THE WAY THE KEEPER MAKES ONE — an Ed25519 attestation the
// program verifies, then settle_v2 — because "Saved 0.06 SOL" is the one row on
// this dashboard that must never be inferred. The web REFUSES to relay those
// same bytes (settle_v2 is not an owner instruction), which is asserted here
// too: the proof needs a settlement, and the product must still not offer one.
//
// EVERY UPSTREAM REQUEST IS COUNTED. The rate plan is a promise about how much
// one page load asks Solana for; a counting relay sits between the web and the
// validator so the promise is measured, not assumed.
//
// NOT PROVABLE HERE: Raydium's convert and invest (the CLMM program is not on
// this validator), the keeper's own upkeep transactions, Privy's signing, and
// mainnet rent. Only the link format of Solscan is asserted.
//
// NOT PART OF `pnpm test`. Node 22, solana-test-validator and the tested binary:
//   pnpm --filter @sip/web run build
//   SIP_LOCAL_PROGRAM_SO=… pnpm --dir packages/website-oficial test:local

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  ATA_PROGRAM,
  DEFAULT_INVEST_CAPS,
  DEFAULT_VAULT_POLICY,
  INSTRUCTIONS_SYSVAR,
  SIP_ACCOUNT_SPACE,
  SIP_PROGRAM_ID,
  SPYX_MINT,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  USDC_MINT,
  WSOL_MINT,
  decodeInvestmentPolicy,
  decodeProtocolConfig,
  decodeTradingLink,
  decodeVault,
  encodeArgs,
  idlInstruction,
  tryBase64Decode,
} from "@sip/solana-core/client";
import { deriveAta, deriveConfigPda, deriveInvestPda, deriveLinkPda, deriveVaultPda, settledEventsFromLogs } from "@sip/solana-core/server";
import {
  Ed25519Program,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  type Connection,
  type VersionedTransactionResponse,
} from "@solana/web3.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createLiveApi } from "@/lib/live-api";
import { createVaultApi, type VaultApi } from "@/lib/vault-api";
import { createVaultFlow, investPolicyFlow, linkWalletFlow, withdrawFlow, withdrawTokenFlow, type FlowResult } from "@/lib/vault-flows";

// Read-only reuse of the program's own mirror: the same bytes the Rust rebuilds
// and compares. A drifted copy here would produce signatures that never verify.
import { ATTESTATION_MESSAGE_LEN, attestationMessage } from "../../solana-program/scripts/attestation";
import { startLocalValidator, type LocalValidator, type StoppedValidator } from "./local-validator";
import { createProofChain, spyxHoldingAccount, startCountingRelay, wallets, type CountingRelay, type RelayCall } from "./proof-helpers";
import { CLIENT_IP_HEADERS, RELAY_PORT, WEB_ORIGIN, proofPortsInUse, startWebServer, withClientIp, type StoppedWebServer, type WebServer } from "./web-server";

const SOL = BigInt(LAMPORTS_PER_SOL);
const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const UPGRADEABLE_LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

const upgradeAuthority = Keypair.generate();
const attester = Keypair.generate();
const ownerL = Keypair.generate();
const tradingL = Keypair.generate();
/** Never funded, and never given a vault: the "no vault yet" state, on a real chain. */
const ownerEmpty = Keypair.generate();

const key = (keypair: Keypair): string => keypair.publicKey.toBase58();
const SPYX_HOLDING_RAW = 12_345_678n;
const SETTLE_BASE_LAMPORTS = 500_000_000n;
const SETTLE_PAID = 60_000_000n;
const WRAPPED = 10_000_000n;
const DEPOSITED = 5_000_000n;
const WITHDREW_SOL = 20_000_000n;
const WITHDREW_SPYX = 1_000_000n;

const ownerLKey = key(ownerL);
const tradingLKey = key(tradingL);
const vaultL = deriveVaultPda(ownerLKey).toBase58();
const spyxAta = deriveAta(vaultL, SPYX_MINT, TOKEN_2022_PROGRAM).toBase58();
const wsolAta = deriveAta(vaultL, WSOL_MINT, TOKEN_PROGRAM).toBase58();
const usdcAta = deriveAta(vaultL, USDC_MINT, TOKEN_PROGRAM).toBase58();

let validator: LocalValidator | undefined;
let relay: CountingRelay | undefined;
let web: WebServer | undefined;
let connection: Connection;
let api: VaultApi;
let live: ReturnType<typeof createLiveApi>;
const rents = new Map<number, bigint>();

/** Filled as the steps land, so the report and the later assertions name the same transactions. */
const signatures: Record<string, string> = {};
let settleSlot = 0n;
let linkEpoch = 0n;

const { confirmed, landed, airdrop, direct } = createProofChain(() => connection);

const report = {
  keys: { upgradeAuthority: key(upgradeAuthority), attester: key(attester), ownerL: ownerLKey, tradingL: tradingLKey, ownerEmpty: key(ownerEmpty), vaultL, spyxAta },
  signatures,
  relay: {} as Record<string, unknown>,
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const rent = (size: number): bigint => {
  const value = rents.get(size);
  if (value === undefined) throw new Error(`the rent for ${size} bytes was not read`);
  return value;
};
const lamportsOf = async (address: string): Promise<bigint> => BigInt(await connection.getBalance(new PublicKey(address), "confirmed"));
const tokenAmount = async (account: string): Promise<bigint> => BigInt((await connection.getTokenAccountBalance(new PublicKey(account), "confirmed")).value.amount);

const keysOf = (tx: VersionedTransactionResponse): string[] => tx.transaction.message.staticAccountKeys.map((account) => account.toBase58());
const programsOf = (tx: VersionedTransactionResponse): string[] => tx.transaction.message.compiledInstructions.map((instruction) => keysOf(tx)[instruction.programIdIndex]!);

function landedSignature(result: FlowResult): string {
  if (!result.ok) throw new Error(`the flow did not land: ${result.kind}: ${result.message}`);
  return result.signature;
}

/** A hand-built instruction, its accounts in the IDL's own order. */
function sipInstruction(name: string, args: Record<string, unknown>, addresses: Record<string, PublicKey>): TransactionInstruction {
  const idl = idlInstruction(name);
  return new TransactionInstruction({
    programId: new PublicKey(SIP_PROGRAM_ID),
    keys: idl.accounts.map((account) => {
      const pubkey = addresses[account.name];
      if (pubkey === undefined) throw new Error(`${name}: no address for ${account.name}`);
      return { pubkey, isSigner: account.signer === true, isWritable: account.writable === true };
    }),
    data: Buffer.from(encodeArgs(name, args)),
  });
}

/** Only the upstream posts the relay saw since it was last reset. */
const since = (before: number): readonly RelayCall[] => (relay?.calls() ?? []).slice(before);

let started = false;
let startedAt = 0;

beforeAll(async () => {
  startedAt = Date.now();
  // Nothing is spawned, and mainnet is not read, while any port of the proof is held.
  const held = await proofPortsInUse([RELAY_PORT]);
  if (held.length > 0) throw new Error(`refusing to start: port(s) ${held.join(", ")} are in use. Nothing was started, and nothing was stopped.`);

  // The vault's SPYx sits at its OWN associated address: that is where the
  // keeper's invest would put it, and where the dashboard reads it from.
  const holding = await spyxHoldingAccount({ vault: new PublicKey(vaultL), at: new PublicKey(spyxAta), amountRaw: SPYX_HOLDING_RAW });
  started = true;
  validator = await startLocalValidator(upgradeAuthority.publicKey, { accounts: [holding] });
  connection = validator.connection;
  relay = await startCountingRelay({ upstream: validator.rpcUrl, port: RELAY_PORT });
  web = await startWebServer({ rpcUrl: relay.url });
  api = createVaultApi({ origin: WEB_ORIGIN, fetch: withClientIp });
  live = createLiveApi({ origin: WEB_ORIGIN, fetch: withClientIp });
});

afterAll(async () => {
  let relayStopped: Awaited<ReturnType<CountingRelay["stop"]>> | null = null;
  let webStopped: StoppedWebServer | null = null;
  let validatorStopped: StoppedValidator | null = null;
  try {
    relayStopped = relay === undefined ? null : await relay.stop();
    webStopped = web === undefined ? null : await web.stop();
  } finally {
    validatorStopped = validator === undefined ? null : await validator.stop();
  }
  const portsInUseAfter = started ? await proofPortsInUse([RELAY_PORT]) : null;
  const runSeconds = Number(((Date.now() - startedAt) / 1_000).toFixed(1));
  console.log(JSON.stringify({ event: "web-panel-live.local-proof", ...report, runSeconds, stopped: { relay: relayStopped, web: webStopped, validator: validatorStopped, portsInUseAfter } }, null, 1));
  if (relayStopped !== null) expect(relayStopped).toEqual({ stopped: true, portRefused: true });
  if (webStopped !== null) expect(webStopped).toEqual({ exited: true, portRefused: true, homeGone: true });
  if (validatorStopped !== null) expect(validatorStopped).toEqual({ exited: true, rpcRefused: true, tempDirGone: true });
  if (portsInUseAfter !== null) expect(portsInUseAfter).toEqual([]);
});

describe("the live panel on the tested sip_vault", () => {
  it("1. funds the keys and reads the local rents", async () => {
    for (const keypair of [upgradeAuthority, ownerL, tradingL]) await airdrop(keypair.publicKey, 20n * SOL);
    for (const size of [0, SIP_ACCOUNT_SPACE.Vault, SIP_ACCOUNT_SPACE.TradingLink, SIP_ACCOUNT_SPACE.InvestmentPolicy, 165, 179]) {
      rents.set(size, BigInt(await connection.getMinimumBalanceForRentExemption(size, "confirmed")));
    }
    expect(SIP_ACCOUNT_SPACE.Vault).toBe(125);
    // The wallet floor settle.rs refuses to go under is rent(0) plus the reserve.
    expect(rent(0)).toBeGreaterThan(0n);
  });

  it("2. init_config names the attester, hand-built and sent straight to the validator", async () => {
    const [programData] = PublicKey.findProgramAddressSync([new PublicKey(SIP_PROGRAM_ID).toBytes()], UPGRADEABLE_LOADER);
    const instruction = sipInstruction(
      "init_config",
      { attester: key(attester) },
      {
        authority: upgradeAuthority.publicKey,
        config: new PublicKey(deriveConfigPda().toBase58()),
        program: new PublicKey(SIP_PROGRAM_ID),
        program_data: programData,
        system_program: new PublicKey(SYSTEM_PROGRAM),
      },
    );
    const tx = await direct(new Transaction().add(instruction), upgradeAuthority);
    signatures.init_config = tx.transaction.signatures[0] ?? "";
    const config = decodeProtocolConfig(Uint8Array.from((await connection.getAccountInfo(new PublicKey(deriveConfigPda().toBase58()), "confirmed"))!.data));
    expect(config).toMatchObject({ authority: key(upgradeAuthority), attester: key(attester), paused: false });
  });

  it("3. createVaultFlow lands the vault with the product's defaults", async () => {
    const signers = wallets(ownerL, tradingL);
    const result = await createVaultFlow(
      { api, signers: signers.pension },
      { pensionKey: ownerLKey, mode: 0, maxContribution: DEFAULT_VAULT_POLICY.maxContribution, walletReserve: DEFAULT_VAULT_POLICY.walletReserve },
    );
    signatures.create_vault_v2 = landedSignature(result);
    await landed(signatures.create_vault_v2);
    const vault = decodeVault(Uint8Array.from((await connection.getAccountInfo(new PublicKey(vaultL), "confirmed"))!.data));
    expect(vault).toMatchObject({ owner: ownerLKey, skimMode: 0, skimBps: 2_000, maxContribution: 60_000_000n, walletReserve: 50_000_000n, lifetimeSaved: 0n, policyNonce: 0n });
  });

  it("4. linkWalletFlow links the trading wallet to the vault", async () => {
    const signers = wallets(ownerL, tradingL);
    const result = await linkWalletFlow({ api, pension: signers.pension, trading: signers.trading }, { pensionKey: ownerLKey, tradingAddress: tradingLKey });
    signatures.link_wallet = landedSignature(result);
    await landed(signatures.link_wallet);
    const link = decodeTradingLink(Uint8Array.from((await connection.getAccountInfo(new PublicKey(deriveLinkPda(tradingLKey).toBase58()), "confirmed"))!.data));
    expect(link).toMatchObject({ wallet: tradingLKey, vault: vaultL, settlementNonce: 0n, frontierSlot: 0n });
    linkEpoch = link.epoch;
    expect(linkEpoch).toBeGreaterThan(0n);
  });

  it("5. investPolicyFlow signs the policy and creates the vault's wSOL and USDC accounts (SPYx already exists)", async () => {
    const signers = wallets(ownerL, tradingL);
    const before = await lamportsOf(ownerLKey);
    const result = await investPolicyFlow({ api, signers: signers.pension }, { pensionKey: ownerLKey });
    signatures.set_invest_policy = landedSignature(result);
    const tx = await landed(signatures.set_invest_policy);

    // Two ATAs, not three: the SPYx account was preloaded at genesis.
    expect(programsOf(tx)).toEqual([COMPUTE_BUDGET, COMPUTE_BUDGET, ATA_PROGRAM, ATA_PROGRAM, SIP_PROGRAM_ID]);
    expect((await lamportsOf(ownerLKey)) - before).toBe(-(rent(970) + 2n * rent(165) + BigInt(tx.meta!.fee)));

    const policy = decodeInvestmentPolicy(Uint8Array.from((await connection.getAccountInfo(new PublicKey(deriveInvestPda(vaultL).toBase58()), "confirmed"))!.data));
    expect(policy).toMatchObject({ vault: vaultL, enabled: true, inMint: USDC_MINT, minInvestment: 5_000_000n, maxPerCall: DEFAULT_INVEST_CAPS.maxPerCall, lifetimeInvested: 0n });
    expect(policy.legs).toEqual([{ mint: SPYX_MINT, weightBps: 10_000, minOutRateWad: policy.legs[0]!.minOutRateWad }]);
  });

  it("6. SETTLE: an attested settle_v2 the WEB REFUSES to relay lands straight on the validator", async () => {
    // The keeper's own shape: wait until the session can end after the link's epoch.
    for (;;) {
      settleSlot = BigInt(await connection.getSlot("confirmed"));
      if (settleSlot >= linkEpoch + 2n) break;
      await sleep(400);
    }
    const vaultBefore = decodeVault(Uint8Array.from((await connection.getAccountInfo(new PublicKey(vaultL), "confirmed"))!.data));
    expect(vaultBefore.policyNonce).toBe(0n);

    const message = attestationMessage({
      programId: new PublicKey(SIP_PROGRAM_ID),
      wallet: tradingL.publicKey,
      vault: new PublicKey(vaultL),
      linkEpoch,
      settlementNonce: 0n,
      sessionStartSlot: linkEpoch,
      sessionEndSlot: settleSlot,
      baseLamports: SETTLE_BASE_LAMPORTS,
      mode: 0,
      bps: 2_000,
      policyNonce: vaultBefore.policyNonce,
      validUntilSlot: settleSlot + 300n,
    });
    expect(message).toHaveLength(ATTESTATION_MESSAGE_LEN);

    const transaction = new Transaction()
      .add(Ed25519Program.createInstructionWithPrivateKey({ privateKey: attester.secretKey, message }))
      .add(
        sipInstruction(
          "settle_v2",
          { mode: 0, session_start_slot: linkEpoch, session_end_slot: settleSlot, base_lamports: SETTLE_BASE_LAMPORTS, valid_until_slot: settleSlot + 300n },
          {
            wallet: tradingL.publicKey,
            vault: new PublicKey(vaultL),
            trading_link: new PublicKey(deriveLinkPda(tradingLKey).toBase58()),
            config: new PublicKey(deriveConfigPda().toBase58()),
            instructions_sysvar: new PublicKey(INSTRUCTIONS_SYSVAR),
            system_program: new PublicKey(SYSTEM_PROGRAM),
          },
        ),
      );
    const recent = await connection.getLatestBlockhash("confirmed");
    transaction.recentBlockhash = recent.blockhash;
    transaction.feePayer = tradingL.publicKey;
    transaction.sign(tradingL);
    const bytes = Uint8Array.from(transaction.serialize());

    // THE PRODUCT STILL REFUSES IT: settle_v2 is not an owner instruction.
    const refused = await api.send(bytes);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(["instruction_not_allowed", "program_not_allowed"]).toContain(refused.code);

    const vaultBeforeLamports = await lamportsOf(vaultL);
    const signature = await connection.sendRawTransaction(bytes, { skipPreflight: false });
    const tx = await landed(signature);
    signatures.settle_v2 = signature;

    // The chain is the oracle: the event, the balance and the link, read again.
    const events = settledEventsFromLogs(tx.meta?.logMessages);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      vault: vaultL,
      wallet: tradingLKey,
      baseLamports: SETTLE_BASE_LAMPORTS,
      bps: 2_000,
      owed: 100_000_000n,
      paid: SETTLE_PAID,
      settlementNonce: 0n,
      linkEpoch,
      sessionStartSlot: linkEpoch,
      sessionEndSlot: settleSlot,
    });
    expect((await lamportsOf(vaultL)) - vaultBeforeLamports).toBe(SETTLE_PAID);
    const vault = decodeVault(Uint8Array.from((await connection.getAccountInfo(new PublicKey(vaultL), "confirmed"))!.data));
    expect(vault.lifetimeSaved).toBe(SETTLE_PAID);
    const link = decodeTradingLink(Uint8Array.from((await connection.getAccountInfo(new PublicKey(deriveLinkPda(tradingLKey).toBase58()), "confirmed"))!.data));
    expect(link).toMatchObject({ settlementNonce: 1n, frontierSlot: settleSlot });
  });

  it("7. wrap_sol, cranked by the owner, moves SOL into the vault's wSOL account", async () => {
    const before = await lamportsOf(vaultL);
    const tx = await direct(
      new Transaction().add(
        sipInstruction(
          "wrap_sol",
          { amount: WRAPPED },
          {
            crank: ownerL.publicKey,
            config: new PublicKey(deriveConfigPda().toBase58()),
            vault: new PublicKey(vaultL),
            policy: new PublicKey(deriveInvestPda(vaultL).toBase58()),
            vault_wsol: new PublicKey(wsolAta),
            token_program: new PublicKey(TOKEN_PROGRAM),
            system_program: new PublicKey(SYSTEM_PROGRAM),
          },
        ),
      ),
      ownerL,
    );
    signatures.wrap_sol = tx.transaction.signatures[0] ?? "";
    expect((await lamportsOf(vaultL)) - before).toBe(-WRAPPED);
    expect(await tokenAmount(wsolAta)).toBe(WRAPPED);
  });

  it("8. a plain deposit is NOT a saving: lifetimeSaved does not move", async () => {
    const vaultBefore = decodeVault(Uint8Array.from((await connection.getAccountInfo(new PublicKey(vaultL), "confirmed"))!.data));
    const tx = await direct(new Transaction().add(SystemProgram.transfer({ fromPubkey: ownerL.publicKey, toPubkey: new PublicKey(vaultL), lamports: Number(DEPOSITED) })), ownerL);
    signatures.deposit = tx.transaction.signatures[0] ?? "";
    const vaultAfter = decodeVault(Uint8Array.from((await connection.getAccountInfo(new PublicKey(vaultL), "confirmed"))!.data));
    expect(vaultAfter.lifetimeSaved).toBe(vaultBefore.lifetimeSaved);
  });

  it("9. withdrawFlow takes SOL back out to the pension key", async () => {
    const signers = wallets(ownerL, tradingL);
    const before = await lamportsOf(vaultL);
    const result = await withdrawFlow({ api, signers: signers.pension }, { pensionKey: ownerLKey, lamports: WITHDREW_SOL });
    signatures.withdraw = landedSignature(result);
    await landed(signatures.withdraw);
    expect((await lamportsOf(vaultL)) - before).toBe(-WITHDREW_SOL);
  });

  it("10. withdrawTokenFlow takes SPYx out of the vault's own account", async () => {
    const signers = wallets(ownerL, tradingL);
    const result = await withdrawTokenFlow(
      { api, signers: signers.pension },
      { pensionKey: ownerLKey, mint: SPYX_MINT, amountRaw: WITHDREW_SPYX, vaultTokenAccount: spyxAta, tokenProgram: TOKEN_2022_PROGRAM },
    );
    signatures.withdraw_token = landedSignature(result);
    await landed(signatures.withdraw_token);
    expect(await tokenAmount(spyxAta)).toBe(SPYX_HOLDING_RAW - WITHDREW_SPYX);
  });

  it("11. /api/solana-live answers the whole dashboard, and the CHAIN agrees with every figure", async () => {
    const snapshot = await live.snapshot({ owner: ownerLKey, wallets: [tradingLKey], discover: true });
    if (!snapshot.ok) throw new Error(`${snapshot.code}: ${snapshot.message}`);
    const body = snapshot.body;

    // ── the vault, read again from the validator ──────────────────────────────
    expect(body.vault.status).toBe("exists");
    expect(body.vault.lamports).toBe((await lamportsOf(vaultL)).toString());
    expect(body.vault.rentFloor).toBe(rent(125).toString());
    expect(body.vault.withdrawableLamports).toBe(((await lamportsOf(vaultL)) - rent(125)).toString());
    expect(body.vault.state).toMatchObject({
      skimMode: 0,
      skimBps: 2_000,
      lifetimeSaved: SETTLE_PAID.toString(),
      maxContribution: "60000000",
      walletReserve: "50000000",
      paused: false,
    });

    // ── the policy and the protocol config ────────────────────────────────────
    expect(body.policy.status).toBe("exists");
    expect(body.policy.state).toMatchObject({ enabled: true, minInvestment: "5000000", lifetimeInvested: "0" });
    expect(body.policy.state!.legs).toEqual([{ mint: SPYX_MINT, weightBps: 10_000, minOutRateWad: body.policy.state!.legs[0]!.minOutRateWad }]);
    expect(body.config).toMatchObject({ exists: true, paused: false });

    // ── prices, from the pools the validator cloned ───────────────────────────
    expect(body.prices).not.toBeNull();
    expect(BigInt(body.prices!.usdcRawPerSol)).toBeGreaterThan(0n);
    expect(body.prices!.legs[0]!.mint).toBe(SPYX_MINT);

    // ── the trading wallet and its link ───────────────────────────────────────
    expect(body.wallets).toHaveLength(1);
    expect(body.wallets[0]).toMatchObject({
      wallet: tradingLKey,
      lamports: (await lamportsOf(tradingLKey)).toString(),
      link: { address: deriveLinkPda(tradingLKey).toBase58(), status: "this_vault", vault: vaultL, settlementNonce: "1", frontierSlot: settleSlot.toString() },
    });
    expect(body.links?.status).toBe("exists");
    expect(body.links?.items.map((item) => item.wallet)).toEqual([tradingLKey]);

    // ── the vault's own token accounts ────────────────────────────────────────
    const held = (mint: string) => body.vaultTokenAccounts.items.find((item) => item.mint === mint);
    expect(held(WSOL_MINT)).toMatchObject({ address: wsolAta, status: "exists", amountRaw: WRAPPED.toString() });
    expect(held(USDC_MINT)).toMatchObject({ address: usdcAta, status: "exists", amountRaw: "0" });
    const spyxOnChain = await connection.getTokenAccountBalance(new PublicKey(spyxAta), "confirmed");
    expect(held(SPYX_MINT)).toMatchObject({ address: spyxAta, status: "exists", amountRaw: spyxOnChain.value.amount, uiAmount: spyxOnChain.value.uiAmountString });
    // A scaled mint: the display amount is NOT amountRaw / 10^decimals.
    expect(held(SPYX_MINT)!.amountRaw).toBe((SPYX_HOLDING_RAW - WITHDREW_SPYX).toString());

    expect(body.rents).toEqual({ vault: rent(125).toString(), walletFloor: rent(0).toString() });

    // ── the history, classified, newest first ─────────────────────────────────
    const activity = await live.activity({ owner: ownerLKey, limit: 15 });
    if (!activity.ok) throw new Error(`${activity.code}: ${activity.message}`);
    expect(activity.body.status).toBe("exists");
    const kinds = activity.body.entries.map((entry) => entry.events.map((event) => event.kind).join("+"));
    expect(kinds).toEqual(["withdrew_token", "withdrew_sol", "received_sol", "wrapped", "settled", "policy_signed", "linked", "vault_created"]);

    const bySignature = new Map(activity.body.entries.map((entry) => [entry.signature, entry]));
    const settled = bySignature.get(signatures.settle_v2!)!.events[0]!;
    expect(settled).toMatchObject({ kind: "settled", wallet: tradingLKey, paid: SETTLE_PAID.toString(), owed: "100000000", capped: true, bps: 2_000 });
    expect(bySignature.get(signatures.wrap_sol!)!.events[0]).toMatchObject({ kind: "wrapped", lamports: WRAPPED.toString() });
    expect(bySignature.get(signatures.deposit!)!.events[0]).toMatchObject({ kind: "received_sol", lamports: DEPOSITED.toString() });
    expect(bySignature.get(signatures.withdraw!)!.events[0]).toMatchObject({ kind: "withdrew_sol", lamports: WITHDREW_SOL.toString() });
    expect(bySignature.get(signatures.withdraw_token!)!.events[0]).toMatchObject({ kind: "withdrew_token", mint: SPYX_MINT, amountRaw: WITHDREW_SPYX.toString() });
    expect(bySignature.get(signatures.link_wallet!)!.events[0]).toMatchObject({ kind: "linked", wallet: tradingLKey });
    expect(bySignature.get(signatures.create_vault_v2!)!.events[0]).toMatchObject({ kind: "vault_created", mode: 0, skimBps: 2_000 });
    expect(bySignature.get(signatures.set_invest_policy!)!.events[0]).toMatchObject({ kind: "policy_signed", enabled: true });

    // No upkeep in this history: every transaction here did something.
    expect(kinds).not.toContain("upkeep");

    const out = process.env.SIP_LIVE_FIXTURE_OUT;
    if (out !== undefined && out !== "") {
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, "active-snapshot.json"), JSON.stringify(body, null, 1));
      writeFileSync(join(out, "active-activity.json"), JSON.stringify(activity.body, null, 1));
    }
  });

  it("12. paging: before walks back through the history, and until finds nothing new", async () => {
    const first = await live.activity({ owner: ownerLKey, limit: 3 });
    if (!first.ok) throw new Error(first.code);
    expect(first.body.entries).toHaveLength(3);
    expect(first.body.nextBefore).toBe(first.body.entries[2]!.signature);

    const next = await live.activity({ owner: ownerLKey, limit: 3, before: first.body.nextBefore! });
    if (!next.ok) throw new Error(next.code);
    expect(next.body.entries).toHaveLength(3);
    // No overlap: `before` is exclusive.
    expect(next.body.entries.map((entry) => entry.signature)).not.toContain(first.body.nextBefore);

    const newest = first.body.entries[0]!.signature;
    const nothingNew = await live.activity({ owner: ownerLKey, limit: 15, until: newest });
    if (!nothingNew.ok) throw new Error(nothingNew.code);
    expect(nothingNew.body.entries).toEqual([]);
    expect(nothingNew.body.gap).toBe(false);
  });

  it("13. the rate plan, MEASURED: one batch for a snapshot, one call plus one batch for a page", async () => {
    const withDiscover = relay!.calls().length;
    await live.snapshot({ owner: ownerLKey, wallets: [tradingLKey], discover: true });
    const discoverCalls = since(withDiscover);
    expect(discoverCalls).toHaveLength(1);
    expect(discoverCalls[0]!.batch).toBe(true);
    expect(discoverCalls[0]!.methods).toEqual([
      "getMultipleAccounts",
      "getMultipleAccounts",
      "getMinimumBalanceForRentExemption",
      "getMinimumBalanceForRentExemption",
      "getProgramAccounts",
    ]);

    const withoutDiscover = relay!.calls().length;
    await live.snapshot({ owner: ownerLKey, wallets: [tradingLKey], discover: false });
    const plainCalls = since(withoutDiscover);
    expect(plainCalls).toHaveLength(1);
    expect(plainCalls[0]!.methods).toHaveLength(4);
    expect(plainCalls[0]!.methods).not.toContain("getProgramAccounts");

    const beforeActivity = relay!.calls().length;
    const page = await live.activity({ owner: ownerLKey, limit: 15 });
    if (!page.ok) throw new Error(page.code);
    const activityCalls = since(beforeActivity);
    expect(activityCalls).toHaveLength(2);
    expect(activityCalls[0]!.methods).toEqual(["getSignaturesForAddress"]);
    expect(activityCalls[1]!.batch).toBe(true);
    // One getTransaction per signature, and not one more.
    expect(activityCalls[1]!.methods).toEqual(page.body.entries.map(() => "getTransaction"));

    report.relay = {
      snapshotDiscover: discoverCalls.length,
      snapshotPlain: plainCalls.length,
      activityPosts: activityCalls.length,
      activityTransactions: activityCalls[1]!.methods.length,
      total: relay!.calls().length,
    };
  });

  it("14. a pension key with no vault is MISSING, never unreadable, and is offered the rent it would cost", async () => {
    const snapshot = await live.snapshot({ owner: key(ownerEmpty), wallets: [], discover: true });
    if (!snapshot.ok) throw new Error(snapshot.code);
    expect(snapshot.body.vault.status).toBe("missing");
    expect(snapshot.body.policy.status).toBe("missing");
    expect(snapshot.body.vault.status).not.toBe("unreadable");
    // The rent a vault costs is read even when there is no vault: the card quotes it.
    expect(snapshot.body.rents.vault).toBe(rent(125).toString());
    expect(snapshot.body.links?.items).toEqual([]);

    const out = process.env.SIP_LIVE_FIXTURE_OUT;
    if (out !== undefined && out !== "") {
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, "novault-snapshot.json"), JSON.stringify(snapshot.body, null, 1));
    }
  });

  it("15. every landed transaction is linkable, and the endpoint never leaks", async () => {
    const page = await live.activity({ owner: ownerLKey, limit: 15 });
    if (!page.ok) throw new Error(page.code);
    for (const entry of page.body.entries) {
      expect(entry.signature).toMatch(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/);
      await confirmed(entry.signature);
    }
    expect(JSON.stringify(page.body)).not.toContain("127.0.0.1");
    expect(JSON.stringify(page.body)).not.toContain(String(RELAY_PORT));
  });
});
