// The local end-to-end proof, keeper-cobro-v2's Done: "En local, un cobro por
// modo aterriza con el vector dorado del programa."
//
// ONE VALIDATOR, THE PUBLISHED BYTES, THE KEEPER'S OWN TURN. local-validator.ts
// starts solana-test-validator with the tested sip_vault.so preloaded at its real
// id. Everything on chain before the first tick is set up the way the program's
// own suite sets it up, and every settle after it is measured, priced, attested,
// signed and sent by runSettleTick, called as bin/keeper.mts calls it: the link
// from discoverLinks, the vault from the sweep's one readVaults request, the pause
// switch from readChainSnapshot. Nothing in this file builds a settle_v2.
//
// WHAT IT PROVES, PER MODE:
// - a trade one slot past its link rests at PENDING_FINALITY until finality
//   reaches it, and nothing is sent;
// - then the settle lands, and the vault gains exactly settle.rs's
//   floor(base × bps / 10 000), clipped at max_contribution: PROFIT at 2 000 bps
//   on the trade's measured profit, VOLUME at 200 bps on the notional the base
//   seam supplies;
// - the wallet pays that plus the fee the reserve check priced, the frontier
//   moves to the window's end, the nonce moves by one, and one Settled event
//   says all of it;
// - the 171 bytes the settle key signed are the golden-vector encoder's for that
//   event's own fields, and the program verified them.
// Then the PROFIT link's next tick is IDLE, the loop guard, because only our own
// settle sits above its frontier; and a wallet one payment short of its reserve
// rests at BELOW_RESERVE, with nothing signed.
//
// EVERY KEY IS Keypair.generate(), IN MEMORY. No key file is read or written,
// SIP_SOLANA_LOCAL_SIGNERS_DIR and SIP_SOLANA_SETTLE_KEY are never set, and each
// trading wallet signs as a local Keypair, the localnet route settle-tick.ts keeps.
//
// NOT PART OF `pnpm test`. It needs Node 22, solana-test-validator and the tested
// binary, and takes about a minute and a half:
// `pnpm --dir packages/solana-keeper test:local`, with SIP_LOCAL_PROGRAM_SO naming
// the binary when this checkout has no target/.

import { createPublicKey, verify } from "node:crypto";
import * as anchor from "@coral-xyz/anchor";
import { NATIVE_MINT, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
  type Connection,
  type MessageAccountKeys,
  type MessageCompiledInstruction,
  type VersionedTransactionResponse,
} from "@solana/web3.js";
import { linkWalletWithConsent } from "@sip/solana-program/link-consent";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readVaults } from "../src/accounts.js";
import { GOLDEN_V2_HEX, GOLDEN_V2_INPUTS } from "../src/attestation-golden.js";
import { readChainSnapshot, verifySettleKey } from "../src/chain-state.js";
import { discoverLinks, type ManagedLink } from "../src/discovery.js";
import { accountDiscriminator, idl } from "../src/idl.js";
import { method } from "../src/methods.js";
import { ATTESTATION_MESSAGE_LEN, MODE_PROFIT, MODE_VOLUME, attestationMessage } from "../src/program-scripts.js";
import { expectedContribution, type VolumeBase } from "../src/settle-decision.js";
import { runSettleTick, type SettleResult } from "../src/settle-tick.js";
import { LOCAL_PORTS, SIP_VAULT_PROGRAM_ID, startLocalValidator, type LocalValidator } from "./local-validator.js";

const SOL = BigInt(LAMPORTS_PER_SOL);
/** The market's one payment into each wallet: the trade's profit, and the notional the VOLUME seam attests. */
const TRADE_LAMPORTS = SOL;
const MAX_CONTRIBUTION = 10n * SOL;
/** The product's rates (state.rs): PROFIT 20 %, VOLUME 2 %. Every vault stores both. */
const PROFIT_BPS = 2_000;
const VOLUME_BPS = 200;
const MEMO_PROGRAM = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const ED25519_PROGRAM = "Ed25519SigVerify111111111111111111111111111";
/** settle_v2's discriminator, as the exported IDL records it. */
const SETTLE_V2_DISCRIMINATOR = [5, 41, 238, 141, 219, 81, 39, 145];
const FINALITY_TIMEOUT_MS = 60_000;
const FINALITY_POLL_MS = 250;

interface Participant {
  readonly name: "PROFIT" | "VOLUME" | "RESERVE";
  readonly owner: Keypair;
  readonly wallet: Keypair;
  readonly mode: number;
  readonly walletReserve: bigint;
  /** What the faucet gives the wallet before it is linked. */
  readonly funding: bigint;
  readonly vault: PublicKey;
  readonly link: PublicKey;
}

function participant(name: Participant["name"], mode: number, walletReserve: bigint, funding: bigint): Participant {
  const owner = Keypair.generate();
  const wallet = Keypair.generate();
  return {
    name,
    owner,
    wallet,
    mode,
    walletReserve,
    funding,
    vault: PublicKey.findProgramAddressSync([Buffer.from("vault"), owner.publicKey.toBuffer()], SIP_VAULT_PROGRAM_ID)[0],
    link: PublicKey.findProgramAddressSync([Buffer.from("link"), wallet.publicKey.toBuffer()], SIP_VAULT_PROGRAM_ID)[0],
  };
}

const authority = Keypair.generate();
const settleKey = Keypair.generate();
const market = Keypair.generate();
const profit = participant("PROFIT", MODE_PROFIT, 10_000_000n, 2n * SOL);
const volume = participant("VOLUME", MODE_VOLUME, 10_000_000n, 2n * SOL);
/**
 * ONE PAYMENT SHORT. 0.1 SOL and the 1 SOL trade make 1.1 SOL; paying 0.2 SOL
 * would leave 0.9 SOL, under its rent floor plus a 1 SOL wallet_reserve.
 */
const reserve = participant("RESERVE", MODE_PROFIT, SOL, SOL / 10n);
const participants = [profit, volume, reserve] as const;

let validator: LocalValidator | undefined;
let connection: Connection;
let program: anchor.Program;
const epochs = new Map<Participant["name"], bigint>();
const trades = new Map<Participant["name"], { readonly signature: string; readonly slot: bigint }>();
const settles = new Map<Participant["name"], SettleResult>();

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** What a step needs from the steps before it, or a failure naming the step that did not finish. */
function earlier<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`${what} did not complete, so this step cannot run`);
  return value;
}

const big = (value: anchor.BN): bigint => BigInt(value.toString());
const lamports = async (address: PublicKey): Promise<bigint> => BigInt(await connection.getBalance(address, "confirmed"));
const signatureCount = async (wallet: PublicKey): Promise<number> =>
  (await connection.getSignaturesForAddress(wallet, { limit: 1_000 }, "confirmed")).length;

/**
 * THE FAUCET ANSWERS A MOMENT AFTER THE RPC DOES, so the request is retried; the
 * confirmation is not, because a retried airdrop that had landed would break the
 * exact balances asserted below.
 */
async function airdrop(to: PublicKey, amount: bigint): Promise<void> {
  let signature: string | undefined;
  for (let attempt = 1; signature === undefined; attempt++) {
    try {
      signature = await connection.requestAirdrop(to, Number(amount));
    } catch (error) {
      if (attempt === 20) throw error;
      await sleep(500);
    }
  }
  await connection.confirmTransaction(signature, "confirmed");
}

/** A link as the IDL decodes it: an independent read beside discovery's byte offsets. */
async function linkAccount(address: PublicKey): Promise<{ readonly epoch: bigint; readonly settlementNonce: bigint; readonly frontierSlot: bigint }> {
  const info = await connection.getAccountInfo(address, "confirmed");
  if (info === null) throw new Error(`no TradingLink at ${address.toBase58()}`);
  const decoded = program.coder.accounts.decode<{ epoch: anchor.BN; settlementNonce: anchor.BN; frontierSlot: anchor.BN }>("tradingLink", info.data);
  return { epoch: big(decoded.epoch), settlementNonce: big(decoded.settlementNonce), frontierSlot: big(decoded.frontierSlot) };
}

async function lifetimeSaved(vault: PublicKey): Promise<bigint> {
  const info = await connection.getAccountInfo(vault, "confirmed");
  if (info === null) throw new Error(`no Vault at ${vault.toBase58()}`);
  return big(program.coder.accounts.decode<{ lifetimeSaved: anchor.BN }>("vault", info.data).lifetimeSaved);
}

type Receipt = VersionedTransactionResponse & { readonly meta: NonNullable<VersionedTransactionResponse["meta"]> };

/** A confirmed transaction's receipt, asked for until the node has indexed it. */
async function receiptOf(signature: string): Promise<Receipt> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const receipt = await connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (receipt?.meta) return receipt as Receipt;
    await sleep(250);
  }
  throw new Error(`the receipt of ${signature} never became readable`);
}

function accountKeys(receipt: Receipt): MessageAccountKeys {
  return receipt.transaction.message.getAccountKeys({ accountKeysFromLookups: receipt.meta.loadedAddresses ?? undefined });
}

function accountIndex(receipt: Receipt, key: PublicKey): number {
  const keys = accountKeys(receipt);
  for (let index = 0; index < keys.length; index++) {
    if (keys.get(index)?.equals(key)) return index;
  }
  throw new Error(`${key.toBase58()} is not among the transaction's accounts`);
}

/** Waits until a signature is finalized, as the walk's reads require. */
async function finalized(signature: string): Promise<void> {
  const deadline = Date.now() + FINALITY_TIMEOUT_MS;
  for (;;) {
    const { value } = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
    if (value[0]?.confirmationStatus === "finalized") return;
    if (Date.now() >= deadline) throw new Error(`${signature} was not finalized within ${FINALITY_TIMEOUT_MS / 1_000} s`);
    await sleep(FINALITY_POLL_MS);
  }
}

/**
 * THE VOLUME SEAM, FILLED AS keeper-medir-volumen WILL FILL IT: the notional of
 * the span's successful trades. The span this proof builds holds exactly one, the
 * market's 1 SOL payment, so that payment is its notional. Any other count is not
 * that span, and null leaves it unattested at UNSUPPORTED_MODE.
 */
const tradeNotional: VolumeBase = async (measured) => (measured.successfulTradeCount === 1 ? TRADE_LAMPORTS : null);

/**
 * One wallet's turn, as bin/keeper.mts runs it. The sweep's reads come first —
 * the config for the pause switch, every link from discovery, every vault those
 * links name in one request — then runSettleTick, live, with the settle key and
 * the wallet's signer. The VOLUME wallet alone is given the base seam.
 */
async function keeperTurn(p: Participant): Promise<{ readonly link: ManagedLink; readonly result: SettleResult }> {
  const snapshot = await readChainSnapshot(connection, program);
  const links = await discoverLinks(connection, program.programId, accountDiscriminator("TradingLink"));
  const vaults = await readVaults(program, links.map((candidate) => candidate.vault));
  const link = links.find((candidate) => candidate.wallet.equals(p.wallet.publicKey));
  if (link === undefined) throw new Error(`discovery found no link for the ${p.name} wallet`);
  const result = await runSettleTick({
    connection,
    program,
    link,
    vault: vaults.get(link.vault.toBase58()) ?? null,
    attester: settleKey,
    walletSigner: p.wallet,
    live: true,
    protocolPaused: snapshot.config?.paused === true,
    carries: new Map(),
    ...(p.mode === MODE_VOLUME ? { volumeBase: tradeNotional } : {}),
  });
  return { link, result };
}

/** Settled (events.rs), as Anchor's EventParser decodes it over the camelCased IDL. */
interface SettledEvent {
  readonly vault: PublicKey;
  readonly wallet: PublicKey;
  readonly mode: number;
  readonly baseLamports: anchor.BN;
  readonly bps: number;
  readonly owed: anchor.BN;
  readonly paid: anchor.BN;
  readonly settlementNonce: anchor.BN;
  readonly sessionEndSlot: anchor.BN;
  readonly linkEpoch: anchor.BN;
  readonly sessionStartSlot: anchor.BN;
  readonly policyNonce: anchor.BN;
}

/**
 * Tick 2 for one mode: the trade is final, the keeper's turn settles it, and
 * every trace the settle left on chain is checked against the program's rules.
 */
async function settlesOnce(p: Participant, bps: number, expected: bigint): Promise<void> {
  const epoch = earlier(epochs.get(p.name), "the setup");
  const trade = earlier(trades.get(p.name), `the ${p.name} trade`);
  await finalized(trade.signature);

  // settle.rs:129-136, restated: owed = floor(base × bps / 10 000) in u128, and
  // paid = min(owed, max_contribution). The keeper's mirror must agree.
  const owed = (TRADE_LAMPORTS * BigInt(bps)) / 10_000n;
  const paid = owed < MAX_CONTRIBUTION ? owed : MAX_CONTRIBUTION;
  expect(paid, "settle.rs's formula for this base and rate").toBe(expected);
  expect(expectedContribution(TRADE_LAMPORTS, bps, MAX_CONTRIBUTION)).toEqual({ owed: expected, paid: expected });

  const vaultBefore = await lamports(p.vault);
  const walletBefore = await lamports(p.wallet.publicKey);
  const savedBefore = await lifetimeSaved(p.vault);
  expect(await linkAccount(p.link)).toEqual({ epoch, settlementNonce: 0n, frontierSlot: 0n });

  const { result } = await keeperTurn(p);
  expect(result.outcome, `${p.name}: ${result.detail}`).toBe("SETTLED");
  const signature = earlier(result.signature, `the ${p.name} settle's signature`);
  settles.set(p.name, result);

  // (a) THE AMOUNT: what the keeper expected, what its receipt read, what the
  // vault gained and what the vault's own counter says, all the formula's.
  expect(result.mode).toBe(p.mode);
  expect(result.baseLamports).toBe(TRADE_LAMPORTS);
  expect(result.expectedLamports).toBe(expected);
  expect(result.settledLamports, "the vault delta the keeper read from the receipt").toBe(expected);
  expect((await lamports(p.vault)) - vaultBefore, "the vault's balance delta").toBe(expected);
  expect((await lifetimeSaved(p.vault)) - savedBefore, "the vault's lifetime_saved delta").toBe(expected);

  // (b) THE FEE: the wallet paid the contribution and the receipt's fee, and that
  // fee is the one the reserve check priced before anything was signed.
  const receipt = await receiptOf(signature);
  expect(receipt.meta.err).toBeNull();
  const fee = BigInt(receipt.meta.fee);
  expect(walletBefore - (await lamports(p.wallet.publicKey)), "the wallet paid the contribution and the fee").toBe(expected + fee);
  expect(result.feeLamports, "the fee the reserve check priced is the fee charged").toBe(fee);

  // (c) THE LINK: the frontier is the window's end, at or past the trade, and the
  // nonce moved by exactly one.
  const endSlot = earlier(result.endSlot, `the ${p.name} settle's end slot`);
  expect(endSlot >= trade.slot, `the window ends at ${endSlot}, at or past the trade's slot ${trade.slot}`).toBe(true);
  expect(await linkAccount(p.link)).toEqual({ epoch, settlementNonce: 1n, frontierSlot: endSlot });
  expect(result.nonce).toBe(0n);

  // (d) THE EVENT, parsed from the settle's own logs as tests/settle.ts reads it.
  const parser = new anchor.EventParser(program.programId, new anchor.BorshCoder(program.idl));
  const events = [...parser.parseLogs(receipt.meta.logMessages ?? [])].filter((event) => event.name.toLowerCase() === "settled");
  expect(events, "exactly one Settled event").toHaveLength(1);
  const event = earlier(events[0], "the Settled event").data as unknown as SettledEvent;
  expect(event.vault.equals(p.vault)).toBe(true);
  expect(event.wallet.equals(p.wallet.publicKey)).toBe(true);
  expect({
    mode: event.mode,
    bps: event.bps,
    baseLamports: big(event.baseLamports),
    owed: big(event.owed),
    paid: big(event.paid),
    settlementNonce: big(event.settlementNonce),
    sessionStartSlot: big(event.sessionStartSlot),
    sessionEndSlot: big(event.sessionEndSlot),
    linkEpoch: big(event.linkEpoch),
    policyNonce: big(event.policyNonce),
  }).toEqual({
    mode: p.mode,
    bps,
    baseLamports: TRADE_LAMPORTS,
    owed: expected,
    paid: expected,
    settlementNonce: 0n,
    sessionStartSlot: epoch,
    sessionEndSlot: endSlot,
    linkEpoch: epoch,
    policyNonce: 0n,
  });

  // (e) THE BYTES. Instruction 0 is the Ed25519 verification, instruction 1 the
  // settle_v2 it guards. The message the settle key signed, at 112 in web3.js's
  // layout, must be the golden-vector encoder's output for the event's fields and
  // the deadline settle_v2 was handed as its last u64.
  const keys = accountKeys(receipt);
  const instructions: readonly MessageCompiledInstruction[] = receipt.transaction.message.compiledInstructions;
  expect(instructions, "the settle carries exactly [Ed25519, settle_v2]").toHaveLength(2);
  const verifyIx = earlier(instructions[0], "instruction 0");
  const settleIx = earlier(instructions[1], "instruction 1");
  expect(keys.get(verifyIx.programIdIndex)?.toBase58()).toBe(ED25519_PROGRAM);
  expect(keys.get(settleIx.programIdIndex)?.equals(program.programId)).toBe(true);

  const settleData = Buffer.from(settleIx.data);
  expect(settleData.length, "discriminator, mode u8 and four u64 arguments").toBe(8 + 1 + 8 * 4);
  expect([...settleData.subarray(0, 8)]).toEqual(SETTLE_V2_DISCRIMINATOR);
  const validUntilSlot = settleData.readBigUInt64LE(settleData.length - 8);
  expect({
    mode: settleData.readUInt8(8),
    sessionStartSlot: settleData.readBigUInt64LE(9),
    sessionEndSlot: settleData.readBigUInt64LE(17),
    baseLamports: settleData.readBigUInt64LE(25),
  }).toEqual({ mode: p.mode, sessionStartSlot: epoch, sessionEndSlot: endSlot, baseLamports: TRADE_LAMPORTS });
  expect(validUntilSlot > endSlot).toBe(true);

  const verifyData = Buffer.from(verifyIx.data);
  expect(verifyData[0], "exactly one signature").toBe(1);
  expect(verifyData.length).toBe(112 + ATTESTATION_MESSAGE_LEN);
  expect(verifyData.subarray(16, 48).equals(settleKey.publicKey.toBuffer()), "signed by the settle key").toBe(true);
  const signed = verifyData.subarray(112, 112 + ATTESTATION_MESSAGE_LEN);
  const rebuilt = attestationMessage({
    programId: program.programId,
    wallet: event.wallet,
    vault: event.vault,
    linkEpoch: big(event.linkEpoch),
    settlementNonce: big(event.settlementNonce),
    sessionStartSlot: big(event.sessionStartSlot),
    sessionEndSlot: big(event.sessionEndSlot),
    baseLamports: big(event.baseLamports),
    mode: event.mode,
    bps: event.bps,
    policyNonce: big(event.policyNonce),
    validUntilSlot,
  });
  expect(signed.toString("hex"), "the signed message is the encoder's bytes for the event's fields").toBe(rebuilt.toString("hex"));
  // The Ed25519 program's own check, repeated with node:crypto: the raw key
  // behind the fixed SPKI prefix for Ed25519.
  const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), settleKey.publicKey.toBuffer()]);
  expect(verify(null, signed, createPublicKey({ key: spki, format: "der", type: "spki" }), verifyData.subarray(48, 112))).toBe(true);

  // Public facts only, one line per landed settle, so a run reports what it measured.
  console.log(
    `local proof: ${p.name} settled ${expected} lamports on a base of ${TRADE_LAMPORTS} at ${bps} bps; fee ${fee}; ` +
      `window (${epoch}, ${endSlot}], valid until slot ${validUntilSlot}; nonce 0 -> 1; ${signature}`,
  );
}

describe("the local proof: one settle per mode lands through the keeper's own turn", () => {
  beforeAll(async () => {
    // The keeper reaches the program through the exported IDL; the validator
    // preloads the binary at this id. They must be one program.
    expect(idl.address).toBe(SIP_VAULT_PROGRAM_ID.toBase58());
    expect(idl.instructions.find((instruction) => instruction.name === "settle_v2")?.discriminator).toEqual(SETTLE_V2_DISCRIMINATOR);
    validator = await startLocalValidator(authority.publicKey);
    connection = validator.connection;
    program = new anchor.Program(idl, new anchor.AnchorProvider(connection, new anchor.Wallet(authority), { commitment: "confirmed" }));
  });

  afterAll(async () => {
    if (validator === undefined) return;
    const stopped = await validator.stop();
    expect(stopped.exited, `the validator this run spawned has exited (code ${stopped.exitCode}, signal ${stopped.signalCode})`).toBe(true);
    expect(stopped.rpcRefused, `a TCP connect to 127.0.0.1:${LOCAL_PORTS.rpc} is refused`).toBe(true);
    expect(stopped.tempDirGone, "the temporary ledger directory is gone").toBe(true);
  });

  it("sets up a config naming the settle key, a PROFIT, a VOLUME and a reserve-bound vault, each linked with its wallet's consent", async () => {
    // The encoder every byte check below compares against is the golden vector's, in this run too.
    expect(attestationMessage(GOLDEN_V2_INPUTS).toString("hex")).toBe(GOLDEN_V2_HEX);

    await Promise.all([
      airdrop(authority.publicKey, 5n * SOL),
      airdrop(settleKey.publicKey, SOL),
      airdrop(market.publicKey, 5n * SOL),
      ...participants.flatMap((p) => [airdrop(p.owner.publicKey, 2n * SOL), airdrop(p.wallet.publicKey, p.funding)]),
    ]);

    // init_config accepts only the upgrade authority ProgramData records: this run's.
    const [programData] = PublicKey.findProgramAddressSync(
      [program.programId.toBuffer()],
      new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"),
    );
    const [config] = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);
    await method(program, "initConfig")(settleKey.publicKey).accountsPartial({ authority: authority.publicKey, programData }).rpc();
    await method(program, "setKeeper")(settleKey.publicKey).accountsPartial({ authority: authority.publicKey, config }).rpc();

    for (const p of participants) {
      await method(program, "createVaultV2")(
        p.mode,
        PROFIT_BPS,
        VOLUME_BPS,
        new anchor.BN(MAX_CONTRIBUTION.toString()),
        new anchor.BN(p.walletReserve.toString()),
      )
        .accountsPartial({ owner: p.owner.publicKey })
        .signers([p.owner])
        .rpc();
      await linkWalletWithConsent(program, { owner: p.owner.publicKey, wallet: p.wallet }).signers([p.owner, p.wallet]).rpc();
    }

    // Read back with the keeper's own readers, as a sweep reads it.
    expect(verifySettleKey(settleKey.publicKey, await readChainSnapshot(connection, program))).toEqual({ kind: "verified" });
    const links = await discoverLinks(connection, program.programId, accountDiscriminator("TradingLink"));
    expect(links).toHaveLength(participants.length);
    const vaults = await readVaults(program, links.map((link) => link.vault));
    for (const p of participants) {
      const link = earlier(
        links.find((candidate) => candidate.wallet.equals(p.wallet.publicKey)),
        `discovery of the ${p.name} link`,
      );
      expect(link.linkAddress.equals(p.link)).toBe(true);
      expect(link.vault.equals(p.vault)).toBe(true);
      expect({ frontierSlot: link.frontierSlot, settlementNonce: link.settlementNonce }).toEqual({ frontierSlot: 0n, settlementNonce: 0n });
      expect(link.epoch > 0n).toBe(true);
      const vault = earlier(vaults.get(p.vault.toBase58()) ?? undefined, `the ${p.name} vault read`);
      expect(vault.owner.equals(p.owner.publicKey)).toBe(true);
      expect({ ...vault, owner: null }).toEqual({
        owner: null,
        paused: false,
        skimMode: p.mode,
        skimBps: PROFIT_BPS,
        volumeBps: VOLUME_BPS,
        policyNonce: 0n,
        maxContribution: MAX_CONTRIBUTION,
        walletReserve: p.walletReserve,
      });
      expect(await lamports(p.wallet.publicKey), `the ${p.name} wallet holds only its funding`).toBe(p.funding);
      epochs.set(p.name, link.epoch);
    }
  });

  it("rests a trade one slot past each link at PENDING_FINALITY, sending nothing", async () => {
    const lastEpoch = participants
      .map((p) => earlier(epochs.get(p.name), "the setup"))
      .reduce((highest, epoch) => (epoch > highest ? epoch : highest), 0n);
    // A TRADE IN ITS LINK'S OWN SLOT IS NEVER MEASURED: the walk stops at the first
    // signature at or below the span's start, which is the epoch.
    while (BigInt(await connection.getSlot("confirmed")) <= lastEpoch) await sleep(200);

    // Any program outside System, ComputeBudget, Ed25519 and sip-vault makes a
    // transaction trading (measure-window.ts). Memo is in the validator's
    // genesis; the ATA program is the fallback if it ever is not.
    const memo = await connection.getAccountInfo(MEMO_PROGRAM, "confirmed");
    const marker =
      memo?.executable === true
        ? new TransactionInstruction({ programId: MEMO_PROGRAM, keys: [], data: Buffer.from("trade") })
        : createAssociatedTokenAccountIdempotentInstruction(
            market.publicKey,
            getAssociatedTokenAddressSync(NATIVE_MINT, market.publicKey),
            market.publicKey,
            NATIVE_MINT,
          );
    console.log(`local proof: each trade is the market's 1 SOL payment beside a ${memo?.executable === true ? "Memo" : "create-idempotent ATA"} instruction`);

    for (const p of participants) {
      const epoch = earlier(epochs.get(p.name), "the setup");
      // The market pays the fee and signs alone, so the wallet's delta is exactly the payment.
      const trade = new Transaction().add(
        SystemProgram.transfer({ fromPubkey: market.publicKey, toPubkey: p.wallet.publicKey, lamports: TRADE_LAMPORTS }),
        marker,
      );
      const signature = await sendAndConfirmTransaction(connection, trade, [market], { commitment: "confirmed" });
      const receipt = await receiptOf(signature);
      const index = accountIndex(receipt, p.wallet.publicKey);
      expect(BigInt(receipt.meta.postBalances[index] ?? 0) - BigInt(receipt.meta.preBalances[index] ?? 0)).toBe(TRADE_LAMPORTS);
      expect(BigInt(receipt.slot) > epoch, `the ${p.name} trade landed at ${receipt.slot}, past its link's epoch ${epoch}`).toBe(true);
      trades.set(p.name, { signature, slot: BigInt(receipt.slot) });
    }

    // TICK 1, straight after: the trades are confirmed and not final.
    for (const p of participants) {
      const before = await signatureCount(p.wallet.publicKey);
      const { result } = await keeperTurn(p);
      expect(result.outcome, `${p.name}: ${result.detail}`).toBe("PENDING_FINALITY");
      expect(result.signature).toBeUndefined();
      expect(await signatureCount(p.wallet.publicKey), `${p.name}: nothing was sent`).toBe(before);
      expect((await linkAccount(p.link)).frontierSlot).toBe(0n);
    }
  });

  it("settles the PROFIT trade once it is final: 20 % of the profit, the frontier, the event and the golden bytes", async () => {
    await settlesOnce(profit, PROFIT_BPS, 200_000_000n);
  });

  it("settles the VOLUME trade once it is final, through the base seam: 2 % of the notional, the frontier, the event and the golden bytes", async () => {
    await settlesOnce(volume, VOLUME_BPS, 20_000_000n);
  });

  it("ticks the PROFIT link to IDLE once its settle is final: only our own settle sits above the frontier", async () => {
    const settled = earlier(settles.get(profit.name), "the PROFIT settle");
    await finalized(earlier(settled.signature, "the PROFIT settle's signature"));
    const before = await signatureCount(profit.wallet.publicKey);
    const linkBefore = await linkAccount(profit.link);
    expect(linkBefore.settlementNonce).toBe(1n);

    const { result } = await keeperTurn(profit);
    expect(result.outcome, result.detail).toBe("IDLE");
    // The loop guard, not the probe: the probe saw the settle above the frontier.
    expect(result.detail).toContain("only our own settle");
    expect(result.signature).toBeUndefined();
    expect(await signatureCount(profit.wallet.publicKey), "nothing was sent").toBe(before);
    expect(await linkAccount(profit.link)).toEqual(linkBefore);
  });

  it("rests a wallet one payment short of its reserve at BELOW_RESERVE, with nothing signed or moved", async () => {
    const trade = earlier(trades.get(reserve.name), "the RESERVE trade");
    await finalized(trade.signature);
    const walletLamports = await lamports(reserve.wallet.publicKey);
    expect(walletLamports, "0.1 SOL of funding and the 1 SOL trade").toBe(reserve.funding + TRADE_LAMPORTS);
    const before = {
      signatures: await signatureCount(reserve.wallet.publicKey),
      vault: await lamports(reserve.vault),
      link: await linkAccount(reserve.link),
    };

    const { result } = await keeperTurn(reserve);
    expect(result.outcome, result.detail).toBe("BELOW_RESERVE");
    expect(result.signature).toBeUndefined();
    expect(result.expectedLamports).toBe(200_000_000n);

    // settle.rs's own rule would refuse it: the fee comes off first, and what the
    // payment leaves must cover rent_exempt(0) + wallet_reserve.
    const fee = earlier(result.feeLamports, "the priced fee");
    const rentExemptZero = BigInt(await connection.getMinimumBalanceForRentExemption(0));
    expect(walletLamports - fee - 200_000_000n < rentExemptZero + reserve.walletReserve).toBe(true);
    console.log(
      `local proof: RESERVE rests at BELOW_RESERVE holding ${walletLamports} lamports against fee ${fee}, ` +
        `payment 200000000, rent floor ${rentExemptZero} and wallet_reserve ${reserve.walletReserve}`,
    );

    expect({
      signatures: await signatureCount(reserve.wallet.publicKey),
      vault: await lamports(reserve.vault),
      link: await linkAccount(reserve.link),
    }).toEqual(before);
    expect(before.link.frontierSlot).toBe(0n);
  });
});
