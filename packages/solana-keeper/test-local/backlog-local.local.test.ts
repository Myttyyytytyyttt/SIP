// Review finding 5 on a validator running the tested binary: a link buried under
// more than 300 transactions drains oldest first, one complete prefix per settle,
// through the keeper's own turn.
//
// THE GRIEF, AS THE REVIEW PRICED IT. A stranger who holds nothing of the user's
// sends a linked wallet zero-lamport System transfers and pays every fee itself.
// Each one keeps the wallet's balance chain intact and counts toward the walk's
// read limit. Before the prefix, a walk with more than 300 signatures above the
// frontier read none of them and reported INCOMPLETE every sweep, and the frontier
// never moved again. Here 320 transfers and one 1 SOL trade sit above a fresh
// link, and two turns settle them:
// - the first settles the oldest 300 as a zero base over (epoch, S1], S1 being the
//   slot the 300th transfer landed in, and names the backlog;
// - the second settles the rest over (S1, S2], from the frontier the first one
//   left, pays 20 % of the trade, and the link's nonce has moved by 2.
//
// THE BOUNDARY IS MADE, NOT HOPED FOR. A prefix never splits a slot, so transfers
// sharing the 300th one's slot would join its window, and with the trade in it
// there would be no second window at all. The first 300 are all confirmed before
// the rest are signed, and the rest wait for a slot past the last of them.
//
// EVERY KEY IS Keypair.generate(), IN MEMORY, as in settle-local.local.test.ts,
// whose validator harness this file uses and nothing else. NOT PART OF `pnpm
// test`: `pnpm --dir packages/solana-keeper test:local` runs both files, one
// validator at a time.

import * as anchor from "@coral-xyz/anchor";
import { NATIVE_MINT, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  ComputeBudgetProgram,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
  type Connection,
  type VersionedTransactionResponse,
} from "@solana/web3.js";
import { linkWalletWithConsent } from "@sip/solana-program/link-consent";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readVaults } from "../src/accounts.js";
import { readChainSnapshot, verifySettleKey } from "../src/chain-state.js";
import { discoverLinks } from "../src/discovery.js";
import { accountDiscriminator, idl } from "../src/idl.js";
import { MAX_SIGNATURES } from "../src/measure-window.js";
import { method } from "../src/methods.js";
import { MODE_PROFIT } from "../src/program-scripts.js";
import { expectedContribution } from "../src/settle-decision.js";
import { runSettleTick, type SettleResult } from "../src/settle-tick.js";
import { LOCAL_PORTS, SIP_VAULT_PROGRAM_ID, startLocalValidator, type LocalValidator } from "./local-validator.js";

const SOL = BigInt(LAMPORTS_PER_SOL);
/** The market's one payment into the wallet: the second window's profit. */
const TRADE_LAMPORTS = SOL;
const MAX_CONTRIBUTION = 10n * SOL;
const PROFIT_BPS = 2_000;
const VOLUME_BPS = 200;
const WALLET_RESERVE = 10_000_000n;
const WALLET_FUNDING = 2n * SOL;
/** The oldest part of the backlog: exactly what one settlement reads. */
const FIRST_TRANSFERS = MAX_SIGNATURES;
/** What sits above it, so the span holds more than 300 transfers. */
const LATER_TRANSFERS = 20;
const MEMO_PROGRAM = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
/** Transactions sent at once, and signatures per status request (the RPC takes at most 256). */
const SEND_CHUNK = 50;
const STATUS_CHUNK = 256;
const LAND_TIMEOUT_MS = 60_000;
const FINALITY_TIMEOUT_MS = 60_000;
const POLL_MS = 250;
/** Status polls between resends of a transaction the validator has not seen. */
const RESEND_EVERY_POLLS = 8;

const authority = Keypair.generate();
const settleKey = Keypair.generate();
/** Holds nothing of the user's, and pays for every transfer and for the trade. */
const stranger = Keypair.generate();
const owner = Keypair.generate();
const wallet = Keypair.generate();
const vaultAddress = PublicKey.findProgramAddressSync([Buffer.from("vault"), owner.publicKey.toBuffer()], SIP_VAULT_PROGRAM_ID)[0];
const linkAddress = PublicKey.findProgramAddressSync([Buffer.from("link"), wallet.publicKey.toBuffer()], SIP_VAULT_PROGRAM_ID)[0];

interface Landed {
  readonly signature: string;
  readonly slot: bigint;
}

let validator: LocalValidator | undefined;
let connection: Connection;
let program: anchor.Program;
let linkEpoch: bigint | undefined;
/** The slot of the newest of the first 300 transfers, S1, and of the oldest of the rest. */
let firstTransfersEnd: bigint | undefined;
let laterTransfersStart: bigint | undefined;
let trade: Landed | undefined;
let firstSettle: SettleResult | undefined;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** What a step needs from the steps before it, or a failure naming the step that did not finish. */
function earlier<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`${what} did not complete, so this step cannot run`);
  return value;
}

const big = (value: anchor.BN): bigint => BigInt(value.toString());
const lamports = async (address: PublicKey): Promise<bigint> => BigInt(await connection.getBalance(address, "confirmed"));

/** The faucet answers a moment after the RPC does, so the request is retried; the confirmation is not. */
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

/** The link as the IDL decodes it: an independent read beside discovery's byte offsets. */
async function linkAccount(): Promise<{ readonly epoch: bigint; readonly settlementNonce: bigint; readonly frontierSlot: bigint }> {
  const info = await connection.getAccountInfo(linkAddress, "confirmed");
  if (info === null) throw new Error(`no TradingLink at ${linkAddress.toBase58()}`);
  const decoded = program.coder.accounts.decode<{ epoch: anchor.BN; settlementNonce: anchor.BN; frontierSlot: anchor.BN }>("tradingLink", info.data);
  return { epoch: big(decoded.epoch), settlementNonce: big(decoded.settlementNonce), frontierSlot: big(decoded.frontierSlot) };
}

type Receipt = VersionedTransactionResponse & { readonly meta: NonNullable<VersionedTransactionResponse["meta"]> };

/** A confirmed transaction's receipt, asked for until the node has indexed it. */
async function receiptOf(signature: string): Promise<Receipt> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const receipt = await connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (receipt?.meta) return receipt as Receipt;
    await sleep(POLL_MS);
  }
  throw new Error(`the receipt of ${signature} never became readable`);
}

/** Waits until a signature is finalized, as the walk's reads require. */
async function finalized(signature: string): Promise<void> {
  const deadline = Date.now() + FINALITY_TIMEOUT_MS;
  for (;;) {
    const { value } = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
    if (value[0]?.confirmationStatus === "finalized") return;
    if (Date.now() >= deadline) throw new Error(`${signature} was not finalized within ${FINALITY_TIMEOUT_MS / 1_000} s`);
    await sleep(POLL_MS);
  }
}

/**
 * `count` zero-lamport System transfers from the stranger to the wallet, signed
 * over one blockhash.
 *
 * A DISTINCT COMPUTE LIMIT EACH. The same payer, blockhash and instruction would
 * sign to the same signature, and the validator would take the copies for one
 * transaction. ComputeBudget and System are both external flow to the walk, so
 * every transfer stays a transfer.
 */
async function zeroTransfers(count: number, firstUnits: number): Promise<Buffer[]> {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  return Array.from({ length: count }, (_, index) => {
    const transfer = new Transaction({ feePayer: stranger.publicKey, blockhash, lastValidBlockHeight }).add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: firstUnits + index }),
      SystemProgram.transfer({ fromPubkey: stranger.publicKey, toPubkey: wallet.publicKey, lamports: 0 }),
    );
    transfer.sign(stranger);
    return transfer.serialize();
  });
}

/**
 * Sends every transaction and returns each one's confirmed slot, in the order
 * given, once all have landed without an error.
 *
 * A TRANSACTION THE VALIDATOR HAS NOT SEEN IS SENT AGAIN, byte for byte: the same
 * signature, so it lands once at most however often it is sent.
 */
async function landAll(serialized: readonly Buffer[]): Promise<Landed[]> {
  const signatures: string[] = [];
  for (let start = 0; start < serialized.length; start += SEND_CHUNK) {
    const chunk = serialized.slice(start, start + SEND_CHUNK);
    signatures.push(...(await Promise.all(chunk.map((bytes) => connection.sendRawTransaction(bytes, { preflightCommitment: "confirmed" })))));
  }
  const landed = new Map<string, bigint>();
  const deadline = Date.now() + LAND_TIMEOUT_MS;
  for (let poll = 1; ; poll++) {
    const unseen: number[] = [];
    for (let start = 0; start < signatures.length; start += STATUS_CHUNK) {
      const batch = signatures.slice(start, start + STATUS_CHUNK);
      const { value } = await connection.getSignatureStatuses(batch, { searchTransactionHistory: true });
      for (const [offset, status] of value.entries()) {
        const signature = batch[offset]!;
        if (status === null) {
          unseen.push(start + offset);
        } else if (status.err !== null) {
          throw new Error(`transaction ${signature} failed on chain: ${JSON.stringify(status.err)}`);
        } else if (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized") {
          landed.set(signature, BigInt(status.slot));
        }
      }
    }
    if (landed.size === signatures.length) return signatures.map((signature) => ({ signature, slot: landed.get(signature)! }));
    if (Date.now() >= deadline) {
      throw new Error(`${signatures.length - landed.size} of ${signatures.length} transactions were not confirmed within ${LAND_TIMEOUT_MS / 1_000} s`);
    }
    if (poll % RESEND_EVERY_POLLS === 0) {
      await Promise.all(unseen.map((index) => connection.sendRawTransaction(serialized[index]!, { skipPreflight: true }).catch(() => undefined)));
    }
    await sleep(POLL_MS);
  }
}

const slotRange = (landed: readonly Landed[]): { readonly lowest: bigint; readonly highest: bigint } =>
  landed.reduce(
    (range, { slot }) => ({ lowest: slot < range.lowest ? slot : range.lowest, highest: slot > range.highest ? slot : range.highest }),
    { lowest: landed[0]!.slot, highest: landed[0]!.slot },
  );

/**
 * The wallet's turn, as bin/keeper.mts runs it: the config for the pause switch,
 * every link from discovery, every vault those links name in one request, then
 * runSettleTick, live, with the settle key and the wallet's local signer.
 */
async function keeperTurn(): Promise<SettleResult> {
  const snapshot = await readChainSnapshot(connection, program);
  const links = await discoverLinks(connection, program.programId, accountDiscriminator("TradingLink"));
  const vaults = await readVaults(program, links.map((candidate) => candidate.vault));
  const link = links.find((candidate) => candidate.wallet.equals(wallet.publicKey));
  if (link === undefined) throw new Error("discovery found no link for the buried wallet");
  return runSettleTick({
    connection,
    program,
    link,
    vault: vaults.get(link.vault.toBase58()) ?? null,
    attester: settleKey,
    walletSigner: wallet,
    live: true,
    protocolPaused: snapshot.config?.paused === true,
  });
}

/** Settled (events.rs), as Anchor's EventParser decodes it over the camelCased IDL. */
interface SettledEvent {
  readonly vault: PublicKey;
  readonly wallet: PublicKey;
  readonly mode: number;
  readonly bps: number;
  readonly baseLamports: anchor.BN;
  readonly paid: anchor.BN;
  readonly settlementNonce: anchor.BN;
  readonly sessionStartSlot: anchor.BN;
  readonly sessionEndSlot: anchor.BN;
}

/** The window a landed settle closed, from the one Settled event in its own logs. */
async function settledWindow(signature: string): Promise<{
  readonly start: bigint;
  readonly end: bigint;
  readonly nonce: bigint;
  readonly base: bigint;
  readonly paid: bigint;
  readonly mode: number;
  readonly bps: number;
}> {
  const receipt = await receiptOf(signature);
  expect(receipt.meta.err).toBeNull();
  const parser = new anchor.EventParser(program.programId, new anchor.BorshCoder(program.idl));
  const events = [...parser.parseLogs(receipt.meta.logMessages ?? [])].filter((event) => event.name.toLowerCase() === "settled");
  expect(events, "exactly one Settled event").toHaveLength(1);
  const event = earlier(events[0], "the Settled event").data as unknown as SettledEvent;
  expect(event.vault.equals(vaultAddress)).toBe(true);
  expect(event.wallet.equals(wallet.publicKey)).toBe(true);
  return {
    start: big(event.sessionStartSlot),
    end: big(event.sessionEndSlot),
    nonce: big(event.settlementNonce),
    base: big(event.baseLamports),
    paid: big(event.paid),
    mode: event.mode,
    bps: event.bps,
  };
}

describe("the local proof of finding 5: a buried link drains oldest first, one complete prefix per settle", () => {
  beforeAll(async () => {
    expect(idl.address).toBe(SIP_VAULT_PROGRAM_ID.toBase58());
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

  it("sets up a PROFIT vault whose config names the settle key, and links its wallet with the wallet's consent", async () => {
    await Promise.all([
      airdrop(authority.publicKey, 5n * SOL),
      airdrop(settleKey.publicKey, SOL),
      airdrop(stranger.publicKey, 5n * SOL),
      airdrop(owner.publicKey, 2n * SOL),
      airdrop(wallet.publicKey, WALLET_FUNDING),
    ]);

    const [programData] = PublicKey.findProgramAddressSync([program.programId.toBuffer()], new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"));
    const [config] = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);
    await method(program, "initConfig")(settleKey.publicKey).accountsPartial({ authority: authority.publicKey, programData }).rpc();
    await method(program, "setKeeper")(settleKey.publicKey).accountsPartial({ authority: authority.publicKey, config }).rpc();
    await method(program, "createVaultV2")(MODE_PROFIT, PROFIT_BPS, VOLUME_BPS, new anchor.BN(MAX_CONTRIBUTION.toString()), new anchor.BN(WALLET_RESERVE.toString()))
      .accountsPartial({ owner: owner.publicKey })
      .signers([owner])
      .rpc();
    await linkWalletWithConsent(program, { owner: owner.publicKey, wallet }).signers([owner, wallet]).rpc();

    expect(verifySettleKey(settleKey.publicKey, await readChainSnapshot(connection, program))).toEqual({ kind: "verified" });
    const links = await discoverLinks(connection, program.programId, accountDiscriminator("TradingLink"));
    expect(links).toHaveLength(1);
    const link = earlier(links[0], "discovery of the link");
    expect(link.linkAddress.equals(linkAddress)).toBe(true);
    expect(link.vault.equals(vaultAddress)).toBe(true);
    expect({ frontierSlot: link.frontierSlot, settlementNonce: link.settlementNonce }).toEqual({ frontierSlot: 0n, settlementNonce: 0n });
    expect(link.epoch > 0n).toBe(true);
    const vault = earlier((await readVaults(program, [vaultAddress])).get(vaultAddress.toBase58()) ?? undefined, "the vault read");
    expect({ skimMode: vault.skimMode, skimBps: vault.skimBps, walletReserve: vault.walletReserve }).toEqual({
      skimMode: MODE_PROFIT,
      skimBps: PROFIT_BPS,
      walletReserve: WALLET_RESERVE,
    });
    expect(await lamports(wallet.publicKey), "the wallet holds only its funding").toBe(WALLET_FUNDING);
    linkEpoch = link.epoch;
  });

  it("buries the link under 320 zero-lamport transfers the stranger pays for, the first 300 in slots of their own, then a 1 SOL trade", async () => {
    const epoch = earlier(linkEpoch, "the setup");
    // A transaction in the link's own slot is never measured: the walk stops at the epoch.
    while (BigInt(await connection.getSlot("confirmed")) <= epoch) await sleep(200);

    const first = await landAll(await zeroTransfers(FIRST_TRANSFERS, 10_000));
    const firstRange = slotRange(first);
    expect(firstRange.lowest > epoch, `the first transfer landed at ${firstRange.lowest}, past the epoch ${epoch}`).toBe(true);
    // THE BOUNDARY: nothing signed from here on can land in the 300th transfer's slot.
    while (BigInt(await connection.getSlot("confirmed")) <= firstRange.highest) await sleep(200);
    const later = await landAll(await zeroTransfers(LATER_TRANSFERS, 20_000));
    const laterRange = slotRange(later);
    expect(laterRange.lowest > firstRange.highest, `the later transfers start at ${laterRange.lowest}, past S1 ${firstRange.highest}`).toBe(true);

    // Any program outside System, ComputeBudget, Ed25519 and sip-vault makes a
    // transaction trading (measure-window.ts). Memo is in the validator's genesis;
    // the ATA program is the fallback if it ever is not.
    const memo = await connection.getAccountInfo(MEMO_PROGRAM, "confirmed");
    const marker =
      memo?.executable === true
        ? new TransactionInstruction({ programId: MEMO_PROGRAM, keys: [], data: Buffer.from("trade") })
        : createAssociatedTokenAccountIdempotentInstruction(
            stranger.publicKey,
            getAssociatedTokenAddressSync(NATIVE_MINT, stranger.publicKey),
            stranger.publicKey,
            NATIVE_MINT,
          );
    const payment = new Transaction().add(
      SystemProgram.transfer({ fromPubkey: stranger.publicKey, toPubkey: wallet.publicKey, lamports: TRADE_LAMPORTS }),
      marker,
    );
    const signature = await sendAndConfirmTransaction(connection, payment, [stranger], { commitment: "confirmed" });
    const tradeSlot = BigInt((await receiptOf(signature)).slot);
    expect(tradeSlot > laterRange.highest, `the trade landed at ${tradeSlot}, above every transfer`).toBe(true);
    // The transfers moved nothing, and the stranger paid for all of them.
    expect(await lamports(wallet.publicKey), "the wallet holds its funding and the trade").toBe(WALLET_FUNDING + TRADE_LAMPORTS);

    firstTransfersEnd = firstRange.highest;
    laterTransfersStart = laterRange.lowest;
    trade = { signature, slot: tradeSlot };
    console.log(
      `local proof: ${FIRST_TRANSFERS} zero-lamport transfers in slots ${firstRange.lowest}..${firstRange.highest}, ` +
        `${LATER_TRANSFERS} more in ${laterRange.lowest}..${laterRange.highest}, and the trade at ${tradeSlot}, all above epoch ${epoch}`,
    );
  });

  it("settles the oldest 300 as a zero base over (epoch, S1], S1 the 300th transfer's slot, and names the backlog it leaves", async () => {
    const epoch = earlier(linkEpoch, "the setup");
    const s1 = earlier(firstTransfersEnd, "the transfers");
    await finalized(earlier(trade, "the trade").signature);
    expect(await linkAccount()).toEqual({ epoch, settlementNonce: 0n, frontierSlot: 0n });
    const vaultBefore = await lamports(vaultAddress);

    const result = await keeperTurn();
    expect(result.outcome, result.detail).toBe("SETTLED");
    expect(result).toMatchObject({ baseLamports: 0n, expectedLamports: 0n, settledLamports: 0n, endSlot: s1, nonce: 0n });
    expect(result.detail).toContain(
      `backlog: settling the oldest ${FIRST_TRANSFERS} of ${FIRST_TRANSFERS + LATER_TRANSFERS + 1} signatures above slot ${epoch}, ` +
        `up to slot ${s1}; the rest continues next sweep`,
    );
    const signature = earlier(result.signature, "the first settle's signature");

    expect(await linkAccount(), "the frontier is S1 and the nonce moved by one").toEqual({ epoch, settlementNonce: 1n, frontierSlot: s1 });
    expect(await lamports(vaultAddress), "a zero base moves nothing").toBe(vaultBefore);
    expect(await settledWindow(signature)).toEqual({ start: epoch, end: s1, nonce: 0n, base: 0n, paid: 0n, mode: MODE_PROFIT, bps: PROFIT_BPS });
    firstSettle = result;
    console.log(`local proof: settle 1 closed (${epoch}, ${s1}] with a zero base over ${FIRST_TRANSFERS} transfers; nonce 0 -> 1; ${signature}`);
  });

  it("settles the rest over (S1, S2] from the frontier the first settle left, pays 20 % of the trade, and the nonce is up by 2", async () => {
    const epoch = earlier(linkEpoch, "the setup");
    const s1 = earlier(firstTransfersEnd, "the transfers");
    const laterStart = earlier(laterTransfersStart, "the transfers");
    const theTrade = earlier(trade, "the trade");
    const firstSignature = earlier(earlier(firstSettle, "the first settle").signature, "the first settle's signature");
    await finalized(firstSignature);
    const firstSettleSlot = BigInt((await receiptOf(firstSignature)).slot);
    const expected = expectedContribution(TRADE_LAMPORTS, PROFIT_BPS, MAX_CONTRIBUTION).paid;
    expect(expected, "settle.rs's floor(base × bps / 10 000) for the trade").toBe(200_000_000n);
    const vaultBefore = await lamports(vaultAddress);

    const result = await keeperTurn();
    expect(result.outcome, result.detail).toBe("SETTLED");
    // What was left above S1 fits one settlement: the later transfers, the trade and the first settle.
    expect(result.detail).not.toContain("backlog");
    expect(result.detail).toContain(`measured over ${LATER_TRANSFERS + 2} txs`);
    const s2 = earlier(result.endSlot, "the second settle's end slot");
    expect(s2, "S2 is the newest finalized signature, the first settle").toBe(firstSettleSlot);
    expect(laterStart > s1 && theTrade.slot <= s2, "the later transfers and the trade sit inside (S1, S2]").toBe(true);
    expect(result).toMatchObject({ baseLamports: TRADE_LAMPORTS, expectedLamports: expected, settledLamports: expected, nonce: 1n });
    const signature = earlier(result.signature, "the second settle's signature");

    expect((await lamports(vaultAddress)) - vaultBefore, "the vault gained the trade's 20 %").toBe(expected);
    expect(await linkAccount(), "the frontier is S2 and the nonce is up by 2").toEqual({ epoch, settlementNonce: 2n, frontierSlot: s2 });
    expect(await settledWindow(signature)).toEqual({ start: s1, end: s2, nonce: 1n, base: TRADE_LAMPORTS, paid: expected, mode: MODE_PROFIT, bps: PROFIT_BPS });
    console.log(`local proof: settle 2 closed (${s1}, ${s2}] paying ${expected} on a base of ${TRADE_LAMPORTS}; nonce 1 -> 2; ${signature}`);
  });
});
