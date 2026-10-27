// sip-vault's accounts, decoded from bytes laid out exactly as state.rs declares
// them, and the ticks' first steps over those bytes.
//
// The readers once guessed a field name, `maxRolling30d`, that Anchor's camelcase
// spells `maxRolling30D`, behind a cast tsc could not see through. Every vault
// with a policy threw before its in_mint was checked, and nothing noticed,
// because no test decoded a real account. Here each account is built byte by
// byte in state.rs's field order, with a distinct value in every field, served
// through a stub Connection to a Program built from the exported IDL, and read
// back through the keeper's own readers. No network: the stub throws on any RPC
// method it was not given, and records every one it was.

import { readFileSync } from "node:fs";
import * as anchor from "@coral-xyz/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  AddressLookupTableAccount,
  Connection,
  Keypair,
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  SYSVAR_EPOCH_SCHEDULE_PUBKEY,
  SystemProgram,
  type Finality,
  type Transaction,
  type VersionedTransaction,
} from "@solana/web3.js";
import { Secret } from "@sip/solana-log";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configAddress,
  decodeVault,
  investmentPolicyAddress,
  readInvestmentPolicy,
  readProtocolConfig,
  readVault,
  readVaultNullable,
  readVaults,
} from "../src/accounts.js";
import type { ManagedLink } from "../src/discovery.js";
import { accountDiscriminator, idl } from "../src/idl.js";
import { JUPITER_V6_PROGRAM, RAYDIUM_CLMM_PROGRAM, USDC_MINT } from "../src/invest-decision.js";
import { KEYED_API, LANDING_WINDOW_SLOTS, LITE_API, MODE_PROFIT, MODE_VOLUME } from "../src/program-scripts.js";
import { convertCall, investCall, runInvestTick } from "../src/invest-tick.js";
import { CrankSender, QUIET_AFTER_TAKEOVER_MS } from "../src/explicit-send.js";
import { readSweepState } from "../src/invest-snapshot.js";
import { JupiterPacer } from "../src/jupiter-pacer.js";
import { MAX_SUPPORTED_TRANSACTION_VERSION } from "../src/measure-window.js";
import {
  PYTH_RECEIVER_PROGRAM,
  PYTH_SOL_USD_FEED,
  PYTH_SOL_USD_FEED_ID_HEX,
  PYTH_USDC_USD_FEED,
  PYTH_USDC_USD_FEED_ID_HEX,
} from "../src/pyth.js";
import {
  SLOT_DESTINATION_TOKEN_ACCOUNT,
  SLOT_PROGRAM_DESTINATION_TOKEN_ACCOUNT,
  SLOT_SOURCE_TOKEN_ACCOUNT,
  SLOT_USER_TRANSFER_AUTHORITY,
} from "@sip/solana-program/jupiter-route";
import { runSettleTick } from "../src/settle-tick.js";
import { JobFence } from "../src/fenced-sender.js";
import { FakeLedger, chained } from "./fake-ledger.js";
import { MemoryDb, MemoryDispatchStore } from "./memory-dispatch-store.js";

// THE SETTLE TICK ITSELF, NOT ONE KEEPER'S SHARE OF IT: these turns settle both modes, as one keeper did before
// SIP_SOLANA_ROLE split them (keeperModes pins that split on its own).
const BOTH_MODES: readonly number[] = [MODE_PROFIT, MODE_VOLUME];

const programId = new PublicKey(idl.address);
const key = (): PublicKey => Keypair.generate().publicKey;

/**
 * The crank every turn test below sends with, and the stub provider's wallet.
 *
 * THEY ARE ONE KEY BECAUSE PRODUCTION'S ARE. bin/keeper.mts passes the settle
 * keypair as the crank, and sendWithBudget's versioned branch REFUSES to build
 * a transaction whose fee payer is not the provider's wallet — Anchor signs
 * with its wallet after us, and VersionedTransaction.sign throws on a key that
 * is not a required signer. Every Jupiter route names lookup tables, so every
 * turn that sends now takes that branch; a fixture with two different keys
 * would fail each of these tests on a condition invest-transaction.test.ts
 * already covers deliberately.
 */
const TURN_CRANK = Keypair.generate();

function u128(buf: Buffer, offset: number, value: bigint): void {
  buf.writeBigUInt64LE(value & 0xffff_ffff_ffff_ffffn, offset);
  buf.writeBigUInt64LE(value >> 64n, offset + 8);
}

interface VaultFields {
  readonly owner: PublicKey;
  readonly paused: boolean;
  readonly skimBps: number;
  readonly skimMode: number;
  readonly volumeBps: number;
  readonly policyNonce: bigint;
  readonly maxContribution: bigint;
  readonly walletReserve: bigint;
}

/** state.rs Vault: 125 bytes. */
function vaultBytes(v: VaultFields): Buffer {
  const buf = Buffer.alloc(125);
  accountDiscriminator("Vault").copy(buf, 0);
  v.owner.toBuffer().copy(buf, 8);
  buf.writeUInt8(253, 40); // bump
  buf.writeUInt8(1, 41); // version
  buf.writeUInt8(v.paused ? 1 : 0, 42);
  buf.writeUInt16LE(v.skimBps, 43);
  buf.writeBigUInt64LE(123_456_789n, 45); // lifetime_saved
  buf.writeBigInt64LE(1_757_000_000n, 53); // created_at
  buf.writeUInt8(v.skimMode, 61);
  buf.writeUInt16LE(v.volumeBps, 62);
  buf.writeBigUInt64LE(v.policyNonce, 64);
  buf.writeBigUInt64LE(v.maxContribution, 72);
  buf.writeBigUInt64LE(v.walletReserve, 80);
  buf.fill(0xee, 88, 125); // _reserved: noise that must not leak into any field
  return buf;
}

interface ConfigFields {
  readonly authority: PublicKey;
  readonly attester: PublicKey;
  readonly keeper: PublicKey;
  readonly pendingAuthority: PublicKey;
  readonly paused: boolean;
  readonly version: number;
}

/** state.rs ProtocolConfig: 203 bytes. */
function configBytes(c: ConfigFields): Buffer {
  const buf = Buffer.alloc(203);
  accountDiscriminator("ProtocolConfig").copy(buf, 0);
  c.authority.toBuffer().copy(buf, 8);
  c.attester.toBuffer().copy(buf, 40);
  buf.writeUInt8(252, 72); // bump
  c.keeper.toBuffer().copy(buf, 73);
  c.pendingAuthority.toBuffer().copy(buf, 105);
  buf.writeUInt8(c.paused ? 1 : 0, 137);
  buf.writeUInt8(c.version, 138);
  buf.fill(0xdd, 139, 203); // _reserved
  return buf;
}

interface PolicyFields {
  readonly vault: PublicKey;
  readonly enabled: boolean;
  readonly venueProgram: PublicKey;
  readonly inMint: PublicKey;
  readonly legs: readonly { readonly mint: PublicKey; readonly weightBps: number; readonly minOutRateWad: bigint }[];
  readonly minConvertRateWad: bigint;
  readonly minInvestment: bigint;
  readonly maxPerCall: bigint;
  readonly maxRolling30d: bigint;
  readonly bucketDays: readonly number[];
  readonly bucketAmounts: readonly bigint[];
}

/** state.rs InvestmentPolicy: 970 bytes, the space of eight legs, however many are used. */
function policyBytes(p: PolicyFields): Buffer {
  const buf = Buffer.alloc(970);
  accountDiscriminator("InvestmentPolicy").copy(buf, 0);
  p.vault.toBuffer().copy(buf, 8);
  buf.writeUInt8(p.enabled ? 1 : 0, 40);
  p.venueProgram.toBuffer().copy(buf, 41);
  p.inMint.toBuffer().copy(buf, 73);
  buf.writeUInt32LE(p.legs.length, 105);
  let at = 109;
  for (const leg of p.legs) {
    leg.mint.toBuffer().copy(buf, at);
    buf.writeUInt16LE(leg.weightBps, at + 32);
    u128(buf, at + 34, leg.minOutRateWad);
    at += 50;
  }
  u128(buf, at, p.minConvertRateWad);
  at += 16;
  buf.writeBigUInt64LE(p.minInvestment, at);
  at += 8;
  buf.writeBigUInt64LE(p.maxPerCall, at);
  at += 8;
  buf.writeBigUInt64LE(p.maxRolling30d, at);
  at += 8;
  for (const [index, day] of p.bucketDays.entries()) buf.writeUInt32LE(day, at + 4 * index); // bucket_days
  at += 124;
  for (const [index, amount] of p.bucketAmounts.entries()) buf.writeBigUInt64LE(amount, at + 8 * index); // bucket_amounts
  at += 248;
  buf.writeBigUInt64LE(777n, at); // lifetime_invested
  at += 8;
  buf.writeBigUInt64LE(9n, at); // policy_nonce
  at += 8;
  buf.writeUInt8(251, at); // bump
  return buf;
}

/** 2026-09-15 00:00 UTC, chain day 20_711. */
const TODAY_UNIX = 1_789_430_400n;

/**
 * Mainnet's EpochSchedule sysvar, byte for byte as read 2026-09-25: 432,000
 * slots per epoch, no warmup. The invest turn reads it beside the Clock.
 */
const MAINNET_EPOCH_SCHEDULE = Buffer.from("gJcGAAAAAACAlwYAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "base64");

/**
 * Epoch 930's first slot plus one — slotIndex 1, which is what the fixture's
 * getEpochInfo answers too. The Clock and getEpochInfo must describe the same
 * slot, or the keeper and the route builder would disagree about how far the
 * epoch has to run: the landing-window rule reads both (feeRiseCanLand).
 */
const FIXTURE_SLOT = 930n * 432_000n + 1n;

/** The Clock sysvar: 40 bytes, unix_timestamp an i64 at byte 32, after four fields that must not be read as it. */
function clockBytes(unixTimestamp: bigint, slot: bigint = FIXTURE_SLOT): Buffer {
  const buf = Buffer.alloc(40);
  buf.writeBigUInt64LE(slot, 0); // slot
  buf.writeBigInt64LE(unixTimestamp - 172_800n, 8); // epoch_start_timestamp
  buf.writeBigUInt64LE(930n, 16); // epoch
  buf.writeBigUInt64LE(931n, 24); // leader_schedule_epoch
  buf.writeBigInt64LE(unixTimestamp, 32);
  return buf;
}

/**
 * A Pyth PriceUpdateV2 account at VerificationLevel::Full: 134 bytes, the body
 * beginning at 41, laid out field by field as the receiver writes one.
 *
 * THE CHAIN CARRIES THESE, SO THE STUB MUST TOO. invest-tick.ts prices its SOL
 * hop against the oracle as well as against the pool it would trade on, and
 * reads both feeds in the same request as the vault and the Clock — so a stub
 * chain that serves no feed is a chain whose vault correctly refuses to wrap or
 * convert anything, forever. Published one second before the Clock below.
 */
function priceUpdateBytes(feedIdHex: string, price: bigint, publishTime: bigint): Buffer {
  const buf = Buffer.alloc(134);
  buf.set([0x22, 0xf1, 0x23, 0x63, 0x9d, 0x7e, 0xf4, 0xcd], 0); // Anchor's PriceUpdateV2 discriminator
  buf.set(key().toBytes(), 8); // write_authority, which is nobody's business but the feed's
  buf.writeUInt8(1, 40); // VerificationLevel::Full, one byte, so the body starts at 41
  buf.set(Buffer.from(feedIdHex, "hex"), 41);
  buf.writeBigInt64LE(price, 73);
  buf.writeBigUInt64LE(1_000n, 81); // conf
  buf.writeInt32LE(-8, 89); // expo, as both feeds quote
  buf.writeBigInt64LE(publishTime, 93);
  buf.writeBigInt64LE(publishTime - 1n, 101); // prev_publish_time
  buf.writeBigInt64LE(price, 109); // ema_price
  buf.writeBigUInt64LE(1_000n, 117); // ema_conf
  buf.writeBigUInt64LE(400_000_000n, 125); // posted_slot
  return buf;
}

type Handler = (...args: unknown[]) => unknown;

/** A Program over a stub chain that serves `accounts` and records every RPC method called, with its arguments. */
function stubChain(
  accounts: ReadonlyMap<string, Buffer>,
  extra: Readonly<Record<string, Handler>> = {},
  /** Accounts this program does not own — Pyth's feeds, which the receiver owns, and which the tick checks. */
  owners: ReadonlyMap<string, PublicKey> = new Map(),
) {
  const calls: string[] = [];
  const callArgs: unknown[][] = [];
  const info = (address: unknown) => {
    const name = (address as PublicKey).toBase58();
    const data = accounts.get(name);
    return data === undefined ? null : { data, executable: false, lamports: 10_000_000_000, owner: owners.get(name) ?? programId, rentEpoch: 0 };
  };
  const served: Record<string, Handler> = {
    getAccountInfoAndContext: async (address) => ({ context: { slot: 1 }, value: info(address) }),
    getAccountInfo: async (address) => info(address),
    getMultipleAccountsInfoAndContext: async (addresses) => ({ context: { slot: 1 }, value: (addresses as PublicKey[]).map(info) }),
    getMultipleAccountsInfo: async (addresses) => (addresses as PublicKey[]).map(info),
    // THE SAME EPOCH THE Clock SYSVAR ABOVE CARRIES, and it has to be: the
    // admission gate resolves a leg's transfer fee against the epoch it read
    // out of the Clock, and the route builder resolves the SAME mint's fee
    // against getEpochInfo. Two different epochs here would make the keeper
    // refuse its own route for a disagreement this fixture invented — which is
    // exactly the disagreement measureLegVenue's slippage refusal exists to
    // catch, so it would look like a real finding.
    getEpochInfo: async () => ({ epoch: 930, slotIndex: 1, slotsInEpoch: 432_000, absoluteSlot: Number(FIXTURE_SLOT), blockHeight: Number(FIXTURE_SLOT) }),
    // THE TABLES THE ROUTE NAMES. lookupTableCache refuses a table the chain
    // does not have — compiling a v0 message against a missing one produces
    // account indexes that resolve to nothing on the validator — so a turn that
    // reaches the send needs this to answer. An EMPTY address list is honest
    // here: compileToV0Message simply compresses nothing, and what these tests
    // are about is that the table was fetched and applied at all, not how much
    // it saved. The byte counts live in test/invest-transaction.test.ts, off a
    // captured route and its real on-chain tables.
    getAddressLookupTable: async (address) => ({
      context: { slot: 1 },
      value: new AddressLookupTableAccount({
        key: address as PublicKey,
        state: { deactivationSlot: (1n << 64n) - 1n, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses: [] },
      }),
    }),
    ...extra,
  };
  const connection = new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop !== "string" || prop === "then") return undefined;
        return (...args: unknown[]) => {
          calls.push(prop);
          callArgs.push(args);
          const handler = served[prop];
          if (handler === undefined) throw new Error(`unexpected RPC call: ${prop}`);
          return handler(...args);
        };
      },
    },
  ) as unknown as Connection;
  const refuse = async (): Promise<never> => {
    throw new Error("the stub chain signs nothing");
  };
  const wallet = { publicKey: TURN_CRANK.publicKey, signTransaction: refuse, signAllTransactions: refuse };
  const program = new anchor.Program(idl, new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" }));
  return { program, connection, calls, callArgs };
}

// ── the venue, stubbed at its own wire and nowhere higher ──────────────────
//
// WHY THERE IS A STUB AT ALL. The keeper buys and converts through Jupiter, so
// every turn below that reaches the depth gate makes two HTTP calls per leg —
// a quote, and a /swap-instructions build — plus one more for ARM 2's probe.
// Left alone this file reaches the real lite-api.jup.ag: measured, it did, on
// the first run after the switch, and it refused a basket because the endpoint
// answered an error. A suite whose verdicts depend on a public endpoint's mood
// is not a suite.
//
// IT IS STUBBED AT `fetch` AND NOWHERE HIGHER, and that is the whole design.
// measureLegVenue, buildJupiterRoute and verifySharedAccountsRoute all run for
// real against these bytes: the shared_accounts_route discriminator, the
// thirteen fixed slots, the vault in slot 2, vault_in in 3, vault_target in 5
// and 6, the route plan walked step by step and the 19-byte amount tail are
// every one of them checked by production code on the way through. A stub one
// layer higher — a fake measureLegVenue handed to the tick — would have been a
// tenth of the work and would have proved only that the tick calls what it was
// given. That is the shape docs/TESTING_TRAPS.md opens with.
const JUPITER_WIRE = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const STUB_LOOKUP_TABLE = "2XPxvU6FHBvq2VmQSRV3YbdJiRdGEvnY3fdafdXQBijN";

/**
 * SOL against USDC at exactly the price the Pyth feeds in this file carry
 * ($102.59321149 the SOL, $0.99987040 the USDC).
 *
 * NOT AN ARBITRARY RATE. oracleConvertDecision compares the convert hop's own
 * route rate against those two feeds and rests the hop when they disagree, so a
 * round number here would rest every conversion test for a reason that has
 * nothing to do with what the test is about.
 */
const SOL_TO_USDC_MICRO = 102_593_211n;

/** Every venue account the stubbed routes name, by the mint that hop pays out in. */
const venueInventory = new Map<string, PublicKey>();

/** What one stubbed hop pays out: the SOL price on the convert, 1:1 on a leg. */
function stubbedOut(inputMint: string, amountIn: bigint): bigint {
  return inputMint === NATIVE_MINT.toBase58() ? (amountIn * SOL_TO_USDC_MICRO) / 1_000_000_000n : amountIn;
}

/**
 * The thirteen fixed prefix slots of a shared_accounts_route, then the venue
 * account ARM 1 censuses.
 *
 * THE SLOT NUMBERS ARE jupiter-route.ts's OWN, imported rather than retyped. A
 * fixture that hardcoded 2, 3, 5 and 6 would go on passing if the verifier
 * moved to different slots, which is the one thing this layout is here to hold.
 */
function stubRouteAccounts(vault: PublicKey, vaultIn: PublicKey, vaultTarget: PublicKey, inventory: PublicKey) {
  const keys = Array.from({ length: 13 }, () => ({ pubkey: JUPITER_WIRE, isSigner: false, isWritable: false }));
  keys[SLOT_USER_TRANSFER_AUTHORITY] = { pubkey: vault.toBase58(), isSigner: true, isWritable: false };
  keys[SLOT_SOURCE_TOKEN_ACCOUNT] = { pubkey: vaultIn.toBase58(), isSigner: false, isWritable: true };
  // Slot 5 is Jupiter's own programDestinationTokenAccount, and it is the vault
  // target here on purpose: that is the shape in which exactly ONE Token-2022
  // transfer lands in the account invest() measures, and the only shape
  // verifySharedAccountsRoute accepts for a fee-bearing mint.
  keys[SLOT_PROGRAM_DESTINATION_TOKEN_ACCOUNT] = { pubkey: vaultTarget.toBase58(), isSigner: false, isWritable: true };
  keys[SLOT_DESTINATION_TOKEN_ACCOUNT] = { pubkey: vaultTarget.toBase58(), isSigner: false, isWritable: true };
  return [...keys, { pubkey: inventory.toBase58(), isSigner: false, isWritable: true }];
}

/**
 * The bytes a shared_accounts_route really carries, laid out the way
 * decodeRouteAmounts reads them: discriminator(8), id(1), the route plan's u32
 * count, one plan step, then the 19-byte amount tail.
 *
 * THE STEP'S FOUR BYTES ARE THE CAPTURED ROUTE'S OWN (28640001).
 * routePlanEndsExactlyAt WALKS the plan rather than trusting the count — that
 * is what makes a two-byte shift refusable — so the step has to be a shape it
 * can walk, with both of its account indices in range.
 */
function stubRouteData(amountIn: bigint, quotedOut: bigint, slippageBps: number): string {
  const head = Buffer.from("c1209b3341d69c81050100000028640001", "hex");
  const tail = Buffer.alloc(19);
  tail.writeBigUInt64LE(amountIn, 0);
  tail.writeBigUInt64LE(quotedOut, 8);
  tail.writeUInt16LE(slippageBps, 16);
  tail.writeUInt8(0, 18);
  return Buffer.concat([head, tail]).toString("base64");
}

/** The vault's ATA for a classic SPL mint, derived the way the tick derives it. */
const classicAta = (mint: PublicKey, vault: PublicKey) => getAssociatedTokenAddressSync(mint, vault, true, TOKEN_PROGRAM_ID);

/**
 * Serve Jupiter from memory for the duration of one test.
 *
 * `fail` makes every call reject, which is how the doctrinal refusals below are
 * driven: an unmeasurable venue must refuse the WHOLE basket and the conversion
 * with it, before the wrap.
 */
function stubJupiter(options: { readonly fail?: boolean; readonly deliverTo?: PublicKey } = {}): { readonly urls: string[] } {
  const urls: string[] = [];
  vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    urls.push(url);
    if (options.fail === true) throw new Error("lite-api.jup.ag is unreachable in this test");

    if (url.includes("/quote")) {
      const params = new URL(url).searchParams;
      const inputMint = params.get("inputMint") ?? "";
      const outputMint = params.get("outputMint") ?? "";
      const amountIn = BigInt(params.get("amount") ?? "0");
      const slippageBps = Number(params.get("slippageBps") ?? "0");
      const outAmount = stubbedOut(inputMint, amountIn);
      return new Response(
        JSON.stringify({
          inputMint,
          outputMint,
          inAmount: amountIn.toString(),
          outAmount: outAmount.toString(),
          // The venue's own floor, by the arithmetic venueThresholdFrom uses:
          // the two are cross-checked, so a different number here is refused.
          otherAmountThreshold: (outAmount - (outAmount * BigInt(slippageBps)) / 10_000n).toString(),
          swapMode: "ExactIn",
          slippageBps,
          contextSlot: 448_859_887,
          timeTaken: 0.017,
          routePlan: [
            {
              swapInfo: {
                label: "Manifest",
                // ONE ammKey FOR EVERY SIZE, so ARM 2 sees the probe and the
                // turn on the same venue and actually COMPARES them. A fresh
                // key per call would abstain, and an abstention that happened
                // by accident is a gate that was never exercised.
                ammKey: "MNFSTqtC93rEfYHB6hF82sKdZpUDFWkViLByLd1k1Ms",
                inputMint,
                outputMint,
                inAmount: amountIn.toString(),
                outAmount: outAmount.toString(),
                updateContextSlot: "448859870",
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (url.includes("/swap-instructions")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        quoteResponse: { inputMint: string; outputMint: string; inAmount: string; outAmount: string; slippageBps: number };
        userPublicKey: string;
        destinationTokenAccount: string;
      };
      const quote = body.quoteResponse;
      const vault = new PublicKey(body.userPublicKey);
      // `deliverTo` builds a route that pays somewhere OTHER than the account
      // the keeper asked for and measures — Jupiter's answer disagreeing with
      // Jupiter's own request. Nothing on the wire says it is wrong.
      const vaultTarget = options.deliverTo ?? new PublicKey(body.destinationTokenAccount);
      // vault_in is not in the POST body — Jupiter infers it — so it is derived
      // here exactly as the tick derives it: the vault's ATA for the mint being
      // spent, under the classic token program (USDC and wSOL are both plain
      // SPL mints with no extensions).
      const vaultIn = classicAta(new PublicKey(quote.inputMint), vault);
      const inventory = venueInventory.get(quote.outputMint);
      if (inventory === undefined) throw new Error(`the test registered no venue inventory for ${quote.outputMint}`);
      return new Response(
        JSON.stringify({
          swapInstruction: {
            programId: JUPITER_WIRE,
            accounts: stubRouteAccounts(vault, vaultIn, vaultTarget, inventory),
            data: stubRouteData(BigInt(quote.inAmount), BigInt(quote.outAmount), quote.slippageBps),
          },
          setupInstructions: [],
          cleanupInstruction: null,
          tokenLedgerInstruction: null,
          otherInstructions: [],
          addressLookupTableAddresses: [STUB_LOOKUP_TABLE],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    throw new Error(`the Jupiter stub was asked for ${url}, which it does not serve`);
  });
  return { urls };
}

const vaultFields = (over: Partial<VaultFields> = {}): VaultFields => ({
  owner: key(),
  paused: false,
  skimBps: 2_345,
  skimMode: 0,
  volumeBps: 37,
  policyNonce: 0x0102_0304_0506_0708n,
  maxContribution: 5_000_000_000n,
  walletReserve: 50_000_000n,
  ...over,
});

const policyFields = (vault: PublicKey, over: Partial<PolicyFields> = {}): PolicyFields => ({
  vault,
  enabled: true,
  // NOT A RANDOM KEY. It was one here, which no reader looked at and every tick
  // ignored — the keeper passed the Raydium literal whatever the policy said.
  // Now that the tick refuses a venue it cannot route, a random key would
  // refuse every turn below before the gate each of those tests is actually
  // about. The reader's own test overrides it with a random key, which is where
  // reading arbitrary bytes at offset 41 belongs.
  // THE VENUE THE KEEPER ACTUALLY ROUTES, which is the whole point of a fixture
  // default (docs/TESTING_TRAPS.md, first species). It was RAYDIUM_CLMM_PROGRAM
  // while that was the routable venue; it is Jupiter v6 now, so that every turn
  // test below reaches the gate it means to test instead of stopping at
  // venueDecision. The Raydium value has its own case, where it is the subject.
  venueProgram: JUPITER_V6_PROGRAM,
  inMint: USDC_MINT,
  legs: [
    { mint: key(), weightBps: 6_000, minOutRateWad: 3n * 10n ** 18n + (1n << 70n) },
    { mint: key(), weightBps: 4_000, minOutRateWad: 17n },
  ],
  // A RATE THE SOL HOP CAN ACTUALLY MEET, and it has to be one now. This was
  // (1n << 64n) + 12_345n — about 18.4 raw USDC per LAMPORT, or roughly
  // $18,000,000,000 the SOL — chosen to exercise the reader's u128 decode and
  // harmless while nothing priced a conversion against it. The route builder
  // checks the owner's floor when it builds, so an impossible floor now rests
  // every conversion in this file and the convert tests below would pass while
  // testing nothing. The u128 torture value lives on in the reader's own case,
  // which is where it belongs.
  //
  // 0.1 raw USDC per lamport is $100 the SOL; the Pyth feeds and the Jupiter
  // stub here both price it at $102.59, so the hop clears this floor with a
  // little room, which is what a real signed policy looks like.
  minConvertRateWad: 100_000_000_000_000_000n,
  minInvestment: 5_000_000n,
  maxPerCall: 250_000_000n,
  maxRolling30d: 900_000_000n,
  // A distinct value in every bucket, and every day long out of the window of
  // the Clock chainWith serves, so nothing counts against the cap.
  bucketDays: Array.from({ length: 31 }, (_, index) => 20_000 + index),
  bucketAmounts: Array.from({ length: 31 }, (_, index) => BigInt(1_000 + index)),
  ...over,
});

describe("the account readers, over bytes laid out as state.rs declares them", () => {
  it("read every Vault field, through the IDL and from data already in hand", async () => {
    const address = key();
    const planted = vaultFields({ paused: true, skimMode: 1 });
    const { program, calls } = stubChain(new Map([[address.toBase58(), vaultBytes(planted)]]));

    const read = await readVault(program, address);
    expect(read).toEqual(planted);
    expect(decodeVault(program, vaultBytes(planted))).toEqual(planted);
    expect(calls).toEqual(["getAccountInfoAndContext"]);
  });

  it("read every Vault field for three links over two vaults, in one request that names each vault once", async () => {
    const [shared, own] = [key(), key()];
    const plantedShared = vaultFields({
      skimMode: 0,
      skimBps: 2_000,
      volumeBps: 200,
      policyNonce: 4n,
      maxContribution: 7_000_000_000n,
      walletReserve: 10_000_000n,
    });
    const plantedOwn = vaultFields({
      paused: true,
      skimMode: 1,
      skimBps: 9_999,
      volumeBps: 1,
      policyNonce: 0x0a0b_0c0d_0e0f_1011n,
      maxContribution: 1n,
      walletReserve: 1_000_000_000n,
    });
    const { program, calls, callArgs } = stubChain(
      new Map([
        [shared.toBase58(), vaultBytes(plantedShared)],
        [own.toBase58(), vaultBytes(plantedOwn)],
      ]),
    );

    const vaults = await readVaults(program, [shared, own, shared]);
    expect(calls).toEqual(["getMultipleAccountsInfoAndContext"]);
    expect((callArgs[0]?.[0] as PublicKey[]).map((address) => address.toBase58())).toEqual([shared.toBase58(), own.toBase58()]);
    expect(vaults.size).toBe(2);
    expect(vaults.get(shared.toBase58())).toEqual(plantedShared);
    expect(vaults.get(own.toBase58())).toEqual(plantedOwn);
  });

  it("map an address with no vault account to null, in order, and ask for nothing when there are no links", async () => {
    const [absent, present] = [key(), key()];
    const planted = vaultFields();
    const { program, calls } = stubChain(new Map([[present.toBase58(), vaultBytes(planted)]]));

    const vaults = await readVaults(program, [absent, present]);
    expect(vaults.get(absent.toBase58())).toBeNull();
    expect(vaults.get(present.toBase58())).toEqual(planted);
    expect(calls).toEqual(["getMultipleAccountsInfoAndContext"]);

    const empty = stubChain(new Map());
    expect((await readVaults(empty.program, [])).size).toBe(0);
    expect(empty.calls).toEqual([]);
  });

  it("tell an absent vault from an unreadable one, for the sweep's degraded per-link read", async () => {
    const [absent, present] = [key(), key()];
    const planted = vaultFields();
    const { program } = stubChain(new Map([[present.toBase58(), vaultBytes(planted)]]));

    // ABSENT is the batched read's own answer, so runSettleTick reports FAILED
    // and settleAlert pages for that wallet whichever path read the vault. The
    // degraded path used fetch(), which throws here, and the page was lost.
    expect(await readVaultNullable(program, absent)).toBeNull();
    expect(await readVaultNullable(program, present)).toEqual(planted);
    // Anchor's fetch() is what the degraded path used to call, and this is the
    // throw that a catch cannot tell from a refused request.
    await expect(readVault(program, absent)).rejects.toThrow(/Account does not exist/);

    // UNREADABLE still throws: a throttled endpoint is not an empty address, and
    // calling it a missing vault would page for every wallet on one 429.
    const client = (program.account as unknown as Record<string, { fetchNullable: (address: PublicKey) => Promise<unknown> }>)["vault"]!;
    client.fetchNullable = async () => {
      throw new Error("429 Too Many Requests");
    };
    await expect(readVaultNullable(program, present)).rejects.toThrow(/429/);
  });

  it("read every ProtocolConfig field, and null when the PDA does not exist", async () => {
    const planted: ConfigFields = {
      authority: key(),
      attester: key(),
      keeper: key(),
      pendingAuthority: key(),
      paused: true,
      version: 3,
    };
    const { program } = stubChain(new Map([[configAddress(programId).toBase58(), configBytes(planted)]]));
    expect(await readProtocolConfig(program)).toEqual({ address: configAddress(programId), ...planted });

    expect(await readProtocolConfig(stubChain(new Map()).program)).toBeNull();
  });

  it("read every InvestmentPolicy field, max_rolling_30d included, and null with no policy", async () => {
    const vault = key();
    // A venue of its own, and a random one: the reader must return the 32 bytes
    // at offset 41 whatever they are, not the venue the keeper happens to route.
    // AND THE u128 THE DEFAULT NO LONGER CARRIES. min_convert_rate_wad is the
    // policy's only u128, so the reader's own case is where a value past 2^64
    // has to be planted — the turn tests need a floor their conversions can
    // actually meet, and a fixture cannot be both.
    const planted = policyFields(vault, { venueProgram: key(), minConvertRateWad: (1n << 64n) + 12_345n });
    const address = investmentPolicyAddress(programId, vault);
    const { program } = stubChain(new Map([[address.toBase58(), policyBytes(planted)]]));

    const read = await readInvestmentPolicy(program, vault);
    expect(read).toEqual({
      address,
      enabled: planted.enabled,
      venueProgram: planted.venueProgram,
      inMint: planted.inMint,
      legs: planted.legs,
      minConvertRateWad: planted.minConvertRateWad,
      minInvestment: planted.minInvestment,
      maxPerCall: planted.maxPerCall,
      maxRolling30d: 900_000_000n,
      bucketDays: Array.from({ length: 31 }, (_, index) => 20_000 + index),
      bucketAmounts: Array.from({ length: 31 }, (_, index) => BigInt(1_000 + index)),
    });

    expect(await readInvestmentPolicy(stubChain(new Map()).program, vault)).toBeNull();
  });

  it("refuse day buckets of any length but state.rs's 31", async () => {
    const vault = key();
    const { program } = stubChain(new Map([[investmentPolicyAddress(programId, vault).toBase58(), policyBytes(policyFields(vault))]]));
    const client = (program.account as unknown as Record<string, { fetchNullable: (address: PublicKey) => Promise<unknown> }>)[
      "investmentPolicy"
    ]!;
    const real = client.fetchNullable.bind(client);
    client.fetchNullable = async (address) => {
      const decoded = (await real(address)) as Record<string, unknown>;
      return { ...decoded, bucketAmounts: (decoded["bucketAmounts"] as unknown[]).slice(1) };
    };
    await expect(readInvestmentPolicy(program, vault)).rejects.toThrow(/InvestmentPolicy\.bucketAmounts decoded 30 buckets, not state\.rs's 31/);
  });

  it("name the account and the field when the decoded names drift from the reader", async () => {
    const vault = key();
    const { program } = stubChain(new Map([[investmentPolicyAddress(programId, vault).toBase58(), policyBytes(policyFields(vault))]]));
    const client = (program.account as unknown as Record<string, { fetchNullable: (address: PublicKey) => Promise<unknown> }>)[
      "investmentPolicy"
    ]!;
    const real = client.fetchNullable.bind(client);
    // What the reader saw before: the field under a spelling Anchor does not produce.
    client.fetchNullable = async (address) => {
      const { maxRolling30D, ...rest } = (await real(address)) as Record<string, unknown>;
      return { ...rest, maxRolling30d: maxRolling30D };
    };
    await expect(readInvestmentPolicy(program, vault)).rejects.toThrow(/InvestmentPolicy\.maxRolling30D is missing/);
  });
});

describe("the ticks' first steps, over the same bytes", () => {
  // EVERY STUB COMES BACK OFF. A `fetch` left stubbed would follow this file
  // into whatever runs next in the same worker, and the failure would appear
  // somewhere with no Jupiter in it at all.
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function chainWith(
    vaultOver: Partial<VaultFields>,
    policyOver: Partial<PolicyFields> | null,
    extra: Readonly<Record<string, Handler>> = {},
    /** False leaves the chain with no Pyth accounts at all, as a receiver outage would. */
    feeds = true,
    /** Anything else the turn reads off the chain: leg mints, their pools, and the pools' vaults. */
    more: ReadonlyMap<string, { readonly data: Buffer; readonly owner?: PublicKey }> = new Map(),
    /** The vault's address, when a test must place accounts at addresses derived from it beforehand. */
    vault: PublicKey = key(),
  ) {
    const accounts = new Map([
      [vault.toBase58(), vaultBytes(vaultFields(vaultOver))],
      [SYSVAR_CLOCK_PUBKEY.toBase58(), clockBytes(TODAY_UNIX)],
      [SYSVAR_EPOCH_SCHEDULE_PUBKEY.toBase58(), MAINNET_EPOCH_SCHEDULE],
      // THE IN-ASSET'S OWN MINT. The route builder reads the DESTINATION mint's
      // transfer-fee config for every hop it builds, and on the convert hop
      // (wSOL -> USDC) that destination is USDC. Exactly 82 bytes, which is
      // what a mint with no extensions really is — USDC is a classic SPL mint.
      [USDC_MINT.toBase58(), Buffer.alloc(82)],
    ]);
    const owners = new Map<string, PublicKey>();
    for (const [address, account] of more) {
      accounts.set(address, account.data);
      if (account.owner !== undefined) owners.set(address, account.owner);
    }
    if (feeds) {
      // $102.59321149 SOL against a USDC at $0.99987040, the pair as mainnet
      // quoted it, at the addresses pyth.ts names and owned by the RECEIVER
      // program — not this one, which is exactly what the tick checks.
      accounts.set(PYTH_SOL_USD_FEED.toBase58(), priceUpdateBytes(PYTH_SOL_USD_FEED_ID_HEX, 10_259_321_149n, TODAY_UNIX - 1n));
      accounts.set(PYTH_USDC_USD_FEED.toBase58(), priceUpdateBytes(PYTH_USDC_USD_FEED_ID_HEX, 99_987_040n, TODAY_UNIX - 1n));
      owners.set(PYTH_SOL_USD_FEED.toBase58(), PYTH_RECEIVER_PROGRAM);
      owners.set(PYTH_USDC_USD_FEED.toBase58(), PYTH_RECEIVER_PROGRAM);
    }
    if (policyOver !== null) accounts.set(investmentPolicyAddress(programId, vault).toBase58(), policyBytes(policyFields(vault, policyOver)));
    return { vault, ...stubChain(accounts, extra, owners) };
  }

  it("refuse a non-USDC in_mint in a dry run after reading the policy and nothing else", async () => {
    const inMint = key();
    const { vault, connection, program, calls } = chainWith({}, { inMint });
    const result = await runInvestTick({ connection, program, vault, crank: null, crankLamports: null, live: false, protocolPaused: false });
    expect(result.outcome).toBe("REFUSED");
    expect(result.detail).toContain(inMint.toBase58());
    expect(result.detail).toContain(USDC_MINT.toBase58());
    expect(calls).toEqual(["getAccountInfoAndContext"]);
  });

  it("rest a paused vault's investment before any balance, ATA or wrap", async () => {
    const { vault, connection, program, calls } = chainWith({ paused: true }, {});
    const result = await runInvestTick({ connection, program, vault, crank: null, crankLamports: null, live: false, protocolPaused: false });
    expect(result.outcome).toBe("PAUSED");
    expect(result.detail).toContain("VaultPaused");
    expect(calls).toEqual(["getAccountInfoAndContext", "getMultipleAccountsInfo"]);
  });

  it("rest every investment while the protocol is paused", async () => {
    const { vault, connection, program, calls } = chainWith({}, {});
    const result = await runInvestTick({ connection, program, vault, crank: null, crankLamports: null, live: false, protocolPaused: true });
    expect(result.outcome).toBe("PAUSED");
    expect(result.detail).toContain("ProtocolPaused");
    expect(calls).toEqual(["getAccountInfoAndContext", "getMultipleAccountsInfo"]);
  });

  it("go on past the switches when nothing is paused", async () => {
    const { vault, connection, program, calls } = chainWith({}, {}, {
      getMinimumBalanceForRentExemption: async () => 2_000_000,
      getTokenAccountBalance: async () => {
        throw new Error("could not find account");
      },
    });
    const result = await runInvestTick({ connection, program, vault, crank: null, crankLamports: 20_000_000_000n, live: false, protocolPaused: false });
    expect(result.outcome).toBe("INVESTED");
    expect(result.detail).toContain("DRY RUN");
    expect(calls).toContain("getMinimumBalanceForRentExemption");
  });

  it("say a dry run would wrap what the crank can front, never the vault's whole free balance", async () => {
    // 10 SOL in the vault over a 2_000_000 rent floor, and a crank holding 0.3
    // SOL. wrap_sol has the crank pay the amount in before the vault pays it
    // back, so the 9_998_000_000-lamport wrap the tick once planned fails on
    // every sweep; the turn wraps the crank's balance less its 0.02 SOL reserve.
    const { vault, connection, program } = chainWith({}, {}, {
      getMinimumBalanceForRentExemption: async () => 2_000_000,
      getTokenAccountBalance: async () => {
        throw new Error("could not find account");
      },
    });
    const result = await runInvestTick({ connection, program, vault, crank: null, crankLamports: 300_000_000n, live: false, protocolPaused: false });
    expect(result.outcome).toBe("INVESTED");
    expect(result.detail).toContain("would wrap 280000000");
    expect(result.detail).not.toContain("9998000000");
    expect(result.wrap).toEqual({ free: 9_998_000_000n, allowance: 280_000_000n, wrapped: 280_000_000n, short: true });

    // A balance the snapshot could not read fronts nothing: the turn rests, and says why.
    const unread = await runInvestTick({ connection, program, vault, crank: null, crankLamports: null, live: false, protocolPaused: false });
    expect(unread.outcome).toBe("IDLE");
    expect(unread.detail).toContain("the crank's balance was not read this sweep");
    expect(unread.wrap).toEqual({ free: 9_998_000_000n, allowance: 0n, wrapped: 0n, short: true });
  });

  it("wrap nothing while Pyth cannot be read, and still not fail the turn", async () => {
    // The same 10-SOL vault and the same well-funded crank as above, on a chain
    // that serves no feed accounts at all. The SOL hop rests exactly as it does
    // for an owner who never signed a conversion floor: no wrap is planned, the
    // detail says which feeds could not be read, and the outcome is a REST —
    // never FAILED, never REFUSED. A stalled oracle must not stall the product.
    const { vault, connection, program } = chainWith({}, {}, {
      getMinimumBalanceForRentExemption: async () => 2_000_000,
      getTokenAccountBalance: async () => {
        throw new Error("could not find account");
      },
    }, false);
    const result = await runInvestTick({ connection, program, vault, crank: null, crankLamports: 20_000_000_000n, live: false, protocolPaused: false });
    expect(result.outcome).toBe("IDLE");
    expect(result.detail).toContain("SOL/USD and USDC/USD");
    expect(result.detail).toContain("only the USDC the vault already holds is invested");
    expect(result.detail).not.toContain("would wrap");
    expect(result.wrap).toBeUndefined();
  });

  it("send nothing, live, for a policy with no conversion floor: no ATA, no wrap, and a detail that says why", async () => {
    // 10 SOL in the vault, no token accounts, and a routable one-leg basket. A
    // turn that looked only at `enabled` went on to create the vault's wSOL and
    // USDC accounts and send the wrap_sol the program refuses with FloorTooLow;
    // over this stub, which sends nothing, that turn ended FAILED.
    const mint = key();
    const legPools = new Map([[mint.toBase58(), key()]]);
    const { vault, connection, program, calls } = chainWith(
      {},
      { minConvertRateWad: 0n, legs: [{ mint, weightBps: 10_000, minOutRateWad: 1n }] },
      {
        getMinimumBalanceForRentExemption: async () => 2_000_000,
        getTokenAccountBalance: async () => {
          throw new Error("could not find account");
        },
      },
    );
    const result = await runInvestTick({ connection, program, vault, crank: TURN_CRANK, crankLamports: null, live: true, protocolPaused: false });
    expect(result.outcome).toBe("IDLE");
    expect(result.detail).toContain("0 USDC, below the policy minimum");
    expect(result.detail).toContain("min_convert_rate_wad is 0");
    expect(calls).toEqual([
      "getAccountInfoAndContext",
      "getMultipleAccountsInfo",
      "getMinimumBalanceForRentExemption",
      "getTokenAccountBalance",
      "getTokenAccountBalance",
    ]);
  });

  it("still invest the USDC a vault with no conversion floor already holds, and say its SOL stays SOL", async () => {
    let usdcAta: PublicKey | undefined;
    const { vault, connection, program } = chainWith({}, { minConvertRateWad: 0n }, {
      getMinimumBalanceForRentExemption: async () => 2_000_000,
      getTokenAccountBalance: async (address) => {
        if (usdcAta === undefined || !(address as PublicKey).equals(usdcAta)) throw new Error("could not find account");
        return { context: { slot: 1 }, value: { amount: "7000000", decimals: 6, uiAmount: 7 } };
      },
    });
    usdcAta = getAssociatedTokenAddressSync(USDC_MINT, vault, true);
    const result = await runInvestTick({ connection, program, vault, crank: null, crankLamports: null, live: false, protocolPaused: false });
    expect(result.outcome).toBe("INVESTED");
    expect(result.detail).toContain("DRY RUN — would invest the 7000000 USDC already in the vault");
    expect(result.detail).not.toContain("would wrap");
    expect(result.detail).toContain("min_convert_rate_wad is 0");
  });

  it("rest a live turn whose 30-day cap is spent, before any balance, ATA, wrap or convert", async () => {
    // 10 SOL free, a funded crank, a routable two-leg basket, and 31 buckets
    // inside the served Clock's window holding 899_000_000 of the 900_000_000
    // cap. The tick that never read the buckets wrapped and sold this SOL, and
    // then every leg was refused with RollingCapExhausted.
    const legs = [
      { mint: key(), weightBps: 6_000, minOutRateWad: 1n },
      { mint: key(), weightBps: 4_000, minOutRateWad: 1n },
    ];
    const legPools = new Map(legs.map((leg) => [leg.mint.toBase58(), key()] as const));
    const { vault, connection, program, calls } = chainWith({}, {
      legs,
      bucketDays: Array.from({ length: 31 }, (_, index) => 20_681 + index),
      bucketAmounts: Array.from({ length: 31 }, () => 29_000_000n),
    });
    const result = await runInvestTick({ connection, program, vault, crank: TURN_CRANK, crankLamports: 10_000_000_000n, live: true, protocolPaused: false });
    expect(result.outcome).toBe("IDLE");
    expect(result.detail).toContain("RollingCapExhausted: rolling 899000000 of max 900000000");
    expect(result.detail).toContain("headroom 1000000 is below the basket minimum 12500000");
    expect(result.detail).toContain("headroom next grows on day 20712 (2026-09-16)");
    expect(calls).toEqual(["getAccountInfoAndContext", "getMultipleAccountsInfo"]);
    for (const rpc of ["getTokenAccountBalance", "getBalance", "sendTransaction"]) expect(calls).not.toContain(rpc);
  });

  // ── the depth of the pools, measured in the turn that would trade on them ──
  //
  // A BUILD-TIME CHECK CANNOT PROTECT AGAINST A POOL DRAINING. The numbers here
  // are the ones mainnet held on 2026-09-20: a pool check:legs passed at 6,700
  // dollars two days earlier, holding 31.91 USDC against 0.110274669 of its own
  // token, where a buy over about 11 dollars reverts.
  // WHAT THESE NUMBERS NOW MEAN, AND IT CHANGED WITH THE VENUE. They used to be
  // a Raydium pool's two RESERVES, because the gate read a pool. The gate
  // censuses a VENUE'S INVENTORY of the asset each hop pays us — the only
  // layout a CLOB and a DLMM share — so what a leg carries here is how much of
  // its own stock the venue holds.
  //
  // DRAINED IS STILL THE REAL NUMBER: 0.110274669 of its own token, what
  // mainnet held on 2026-09-20 in a venue check:legs had passed at 6,700
  // dollars two days earlier. DEEP is sized against this suite's own ceiling —
  // max_per_call is 250 USDC, the heaviest leg is 4,000 bps of it, and the stub
  // quotes a leg 1:1 — so a 100,000,000 raw take needs 5,000,000,000 raw of
  // cover at the keeper's 50x, and this clears it with room.
  const DRAINED_INVENTORY = 110_274_669n;
  const DEEP_INVENTORY = 5_000_000_000_000n;
  /** The convert hop's out-side: USDC, and far past anything this suite converts. */
  const DEEP_USDC_INVENTORY = 900_000_000_000_000n;

  // ── the mint layout, at the offsets the chain really uses ────────────────
  //
  // THESE TWO WERE WRONG UNTIL 2026-09-21, IN THE SAME WAY THE DECODER WAS.
  // Both wrote AccountType at byte 82 and the TLV at 83, which is what
  // decodeMintFacts then read — so fixture and code agreed with each other and
  // with no mint that has ever existed. Measured against mainnet: ANTHROPIC is
  // 911 bytes with byte[165] = 1, SPYx is 676 bytes with byte[165] = 1, and
  // byte[82] is zero padding on both.
  //
  // test/fixtures/token2022-mints.json holds those real accounts, and
  // invest-decision.test.ts decodes them directly. These builders stay because
  // a fabricated mint is the only way to ask for a fee of exactly N bps at
  // exactly epoch E — but they now fabricate the real shape.

  /** A Token-2022 mint with no extensions: exactly the 82-byte base, which charges nothing. */
  function plainMintBytes(): Buffer {
    const data = Buffer.alloc(82);
    data.fill(0xab);
    return data;
  }

  /**
   * A Token-2022 mint carrying exactly one TLV extension.
   *
   * The 82-byte base, then ZERO PADDING out to 165 — Token-2022 pads a mint
   * past `Account`'s own length precisely so the two can never be told apart by
   * size — then AccountType::Mint at 165 and the TLV from 166.
   */
  function mintWithExtension(type: number, body: Buffer): Buffer {
    const data = Buffer.alloc(170 + body.length);
    data.fill(0xab, 0, 82);
    data.writeUInt8(1, 165); // AccountType::Mint, after the padding
    data.writeUInt16LE(type, 166);
    data.writeUInt16LE(body.length, 168);
    body.copy(data, 170);
    return data;
  }

  /**
   * TransferFeeConfig (type 1): nothing older, `bps` uncapped from `fromEpoch`.
   *
   * THE CLOCK THIS STUB SERVES IS EPOCH 930, so a fee stamped below it is the
   * one in force and a fee stamped above it is the rise that is only written —
   * which is the difference between a warning and a dated stop.
   */
  function feeMintBytes(bps: number, fromEpoch: bigint): Buffer {
    const config = Buffer.alloc(108); // authority(32) withdraw(32) withheld(8) older(18) newer(18)
    config.writeBigUInt64LE(fromEpoch, 90);
    config.writeBigUInt64LE((1n << 64n) - 1n, 98); // maximum_fee: uncapped, as both live mints are
    config.writeUInt16LE(bps, 106);
    return mintWithExtension(1, config);
  }

  /** TransferHook (type 14) naming a REAL program: the one disqualification no later transaction can undo. */
  function hookMintBytes(hook: PublicKey): Buffer {
    const config = Buffer.alloc(64); // authority(32) program_id(32)
    hook.toBuffer().copy(config, 32);
    return mintWithExtension(14, config);
  }

  /**
   * An SPL Token account: mint(32) owner(32) amount(u64 at 64), 165 bytes.
   *
   * THE MINT IS WRITTEN, AND IT DID NOT USED TO BE. While the gate compared a
   * pool's in-side RESERVE against the spend, nothing ever read these thirty-two
   * bytes, so the fixture left them zero — the field under dispute, arbitrary,
   * and therefore untested while looking tested (docs/TESTING_TRAPS.md, first
   * species). The census reads them to decide which side of the pool an account
   * is on, so they now carry the mint the pool really holds there.
   */
  function tokenAccountBytes(mint: PublicKey, amount: bigint): Buffer {
    const data = Buffer.alloc(165);
    mint.toBuffer().copy(data, 0);
    key().toBuffer().copy(data, 32); // the pool's authority: not the vault, which is what the exclusion looks for
    data.writeBigUInt64LE(amount, 64);
    return data;
  }

  /**
   * A basket as the chain holds it: one mint per leg at the weights of the live
   * basket, plus the venue account the stubbed route names for each of them and
   * one for USDC, which the convert hop is paid in.
   *
   * THE POOLS ARE GONE FROM HERE because they are gone from the turn. The tick
   * used to read a PoolState and its two vaults per leg; it reads the leg mints
   * and then whatever the ROUTE names, which is why the venue accounts are
   * registered with the stub rather than derived from a pool.
   */
  function basketOnChain(inventories: readonly bigint[]) {
    const accounts = new Map<string, { data: Buffer; owner?: PublicKey }>();
    // FRESH PER BASKET. The registry is module-level so the fetch stub can read
    // it, and a leftover entry from an earlier test would serve a venue account
    // this chain has never heard of — which reads as an unmeasurable venue and
    // refuses, a long way from the test that caused it.
    venueInventory.clear();
    const usdcVenue = key();
    accounts.set(usdcVenue.toBase58(), { data: tokenAccountBytes(USDC_MINT, DEEP_USDC_INVENTORY), owner: TOKEN_PROGRAM_ID });
    venueInventory.set(USDC_MINT.toBase58(), usdcVenue);

    const legs = inventories.map((inventory, index) => {
      const mint = key();
      const venue = key();
      accounts.set(mint.toBase58(), { data: plainMintBytes(), owner: TOKEN_2022_PROGRAM_ID });
      // AND IT IS OWNED BY A TOKEN PROGRAM, which the census requires before it
      // will read these offsets at all: bytes at 0..32 mean "a mint" only in an
      // account the token program owns.
      accounts.set(venue.toBase58(), { data: tokenAccountBytes(mint, inventory), owner: TOKEN_2022_PROGRAM_ID });
      venueInventory.set(mint.toBase58(), venue);
      return { mint, venue, weightBps: [4_000, 3_300, 2_700][index]!, minOutRateWad: 1n };
    });
    return {
      accounts,
      legs: legs.map((leg) => ({ mint: leg.mint, weightBps: leg.weightBps, minOutRateWad: leg.minOutRateWad })),
      mints: legs.map((leg) => leg.mint),
      venues: legs.map((leg) => leg.venue),
    };
  }

  /** What a turn reads before it would wrap: the rent floor and the vault's two token balances, all empty. */
  const emptyAndPriced: Readonly<Record<string, Handler>> = {
    getMinimumBalanceForRentExemption: async () => 2_000_000,
    getTokenAccountBalance: async () => {
      throw new Error("could not find account");
    },
  };

  it("refuse a basket whose pool drained since check:legs passed it, before anything is wrapped or converted", async () => {
    // 10 SOL free and a funded crank, so this turn WOULD wrap and convert; the
    // gate runs first, and the SOL never moves. The middle leg's pool is the
    // drained one; the other two are the live pool as measured.
    const basket = basketOnChain([DEEP_INVENTORY, DRAINED_INVENTORY, DEEP_INVENTORY]);
    stubJupiter();
    const { vault, connection, program, calls, callArgs } = chainWith({}, { legs: basket.legs }, emptyAndPriced, true, basket.accounts);
    const result = await runInvestTick({
      connection, program, vault, crank: TURN_CRANK, crankLamports: 10_000_000_000n, live: true, protocolPaused: false,
    });

    expect(result.outcome).toBe("REFUSED");
    // THE AMOUNT TESTED IS THE MOST THIS TURN COULD REALLY SPEND. The vault
    // holds no USDC, and convert.rs lets one call sell at most 1 SOL here
    // (max(max_per_call, 1 SOL), convertCapLamports) — so whatever the ~10 SOL
    // it holds, this turn can bring in 1 SOL at the feeds' $102.59, which the ceiling
    // prices at the top of the oracle's band plus CONVERT_PROCEEDS_MARGIN_BPS:
    // 112,868,301 raw, under the 250 USDC max_per_call. Split by weight, the
    // 3,300 bps leg gets 37.25 USDC — not the 5-dollar default purchase, and
    // not the 82.50 that 3,300 bps of the cap came to before this ceiling was
    // changed (2026-10-09), which this turn could never have reached. The stub quotes a leg 1:1, so
    // that is also what the hop TAKES out of the venue, which is the number the
    // cover is measured against.
    expect(result.detail).toContain(`holds ${DRAINED_INVENTORY} raw of ${basket.mints[1]!.toBase58()} across 1 account(s) at its Manifest hop`);
    expect(result.detail).toContain("against the 37246539 this turn would move through it");
    expect(result.detail).toContain("3.0x cover, under the 50x this keeper trades on (it would need 1862326950)");
    expect(result.detail).toContain(basket.mints[1]!.toBase58());
    // FOUR, NOT THREE: the wSOL -> USDC conversion is one more leg of the same
    // basket, measured by the same function and judged by the same verdict.
    // That is the doctrine stated in a number — a shallow leg refuses the
    // conversion, and a shallow conversion refuses the legs.
    expect(result.detail).toContain("refusing the whole basket of 4 leg(s), the deep ones included");
    expect(result.detail).toContain("refusing to convert SOL toward it");
    for (const index of [0, 2]) expect(result.detail).not.toContain(basket.mints[index]!.toBase58());

    // NOTHING MOVED. The exact RPC sequence is no longer pinned here: a Jupiter
    // measurement reads the destination mint, the epoch and the accounts the
    // ROUTE names, so the list is measureLegVenue's shape rather than this
    // turn's, and pinning it would make a harmless reordering inside that
    // function fail a test about refusing to wrap (docs/TESTING_TRAPS.md, third
    // species). What this turn promises is pinned instead: the leg mints in one
    // request, and not one lamport moved.
    const sameKeys = (got: unknown, want: readonly PublicKey[]): boolean =>
      Array.isArray(got) && got.length === want.length && want.every((key, index) => key.equals(got[index] as PublicKey));
    expect(
      callArgs.some((args) => sameKeys(args[0], basket.mints)),
      "the leg mints go in ONE request — the index is not pinned because the route reads around it are measureLegVenue's",
    ).toBe(true);
    for (const rpc of ["getBalance", "getLatestBlockhash", "sendTransaction", "sendRawTransaction", "getSignaturesForAddress"]) {
      expect(calls).not.toContain(rpc);
    }
    expect(result.wrap?.wrapped).toBe(0n);
  });

  it("let a deep basket through the gate and go on to the turn's own arithmetic", async () => {
    // The same three legs, none of them drained, and conversion switched off so
    // the money this turn can spend is exactly the 12 USDC the vault holds: 4.80
    // to the heaviest leg, under the 5 USDC invest.rs requires of every call.
    // Reaching that refusal at all is the proof the depth gate passed.
    const basket = basketOnChain([DEEP_INVENTORY, DEEP_INVENTORY, DEEP_INVENTORY]);
    stubJupiter();
    let usdcAta: PublicKey | undefined;
    const { vault, connection, program, calls } = chainWith({}, { legs: basket.legs, minConvertRateWad: 0n }, {
      getMinimumBalanceForRentExemption: async () => 2_000_000,
      getTokenAccountBalance: async (address) => {
        if (usdcAta === undefined || !(address as PublicKey).equals(usdcAta)) throw new Error("could not find account");
        return { context: { slot: 1 }, value: { amount: "12000000", decimals: 6, uiAmount: 12 } };
      },
    }, true, basket.accounts);
    usdcAta = getAssociatedTokenAddressSync(USDC_MINT, vault, true);
    const result = await runInvestTick({
      connection, program, vault, crank: TURN_CRANK, crankLamports: 10_000_000_000n, live: true, protocolPaused: false,
    });

    expect(result.outcome).toBe("IDLE");
    expect(result.detail).toContain("$12.00 across 3 legs is $4.80-ish each, under the $5.00 per-call minimum");
    expect(result.detail).toContain("min_convert_rate_wad is 0");
    // A RESTING TURN IS TESTED AT WHAT IT HOLDS, NOT AT THE CAP. Had the gate
    // used max_per_call here it would have measured 100 USDC against venues this
    // vault was never going to push more than 4.80 into.
    //
    // ONE MEASUREMENT PER LEG AND NO MORE. Three legs, no conversion (the floor
    // is 0), so the destination mint is read exactly three times — once per leg
    // — and never once for the convert hop that is not happening.
    expect(calls.filter((name) => name === "getEpochInfo")).toHaveLength(3);
    for (const rpc of ["getBalance", "getLatestBlockhash", "sendTransaction", "sendRawTransaction"]) {
      expect(calls).not.toContain(rpc);
    }
  });

  it("refuse a route that delivers anywhere but the account invest() measures, whatever the request said", async () => {
    // THE JUPITER-ERA VERSION OF "a pool that is not its pair". The old gate
    // could be handed a stale registry row pointing at a stranger's market;
    // this one asks Jupiter for a route and is handed back an instruction. The
    // request named the vault's own target account — the stub echoes a
    // different one, which is what a compromised or simply wrong build looks
    // like from here, and nothing about the response says so.
    //
    // WHY IT MATTERS THAT THIS IS REFUSED RATHER THAN SENT. invest() takes its
    // delta around vault_target, so a fill landing elsewhere measures ZERO and
    // reverts with FillTooSmall — the principal survives, the fee does not, and
    // it happens on every sweep. The keeper refuses before signing instead.
    const basket = basketOnChain([DEEP_INVENTORY, DEEP_INVENTORY, DEEP_INVENTORY]);
    stubJupiter({ deliverTo: key() });
    const { vault, connection, program, calls } = chainWith({}, { legs: basket.legs }, emptyAndPriced, true, basket.accounts);
    const result = await runInvestTick({
      connection, program, vault, crank: TURN_CRANK, crankLamports: 10_000_000_000n, live: true, protocolPaused: false,
    });
    expect(result.outcome).toBe("REFUSED");
    expect(result.detail).toContain("delivers to");
    // AND IT IS STILL A REFUSAL BEFORE THE WRAP. One leg's route being wrong
    // takes the whole basket and the SOL conversion with it — the doctrine does
    // not soften because the reason moved from a pool to an API.
    expect(result.wrap?.wrapped).toBe(0n);
    for (const rpc of ["getBalance", "sendTransaction", "sendRawTransaction"]) expect(calls).not.toContain(rpc);
  });

  // ── the warning the refusal cannot give ───────────────────────────────────
  //
  // legFeeWarnings() existed, was covered by eleven tests, AND HAD NO CALLER.
  // An operator would never have seen one. The live basket's ANTHROPIC leg sits
  // EXACTLY on MAX_LEG_FEE_BPS (300) from epoch 1043 — admitted only because
  // that comparison is strictly greater-than — and the issuer has moved these
  // mints 0 → 50 → 100 → 300 with about two epochs' notice. One more step refuses the WHOLE
  // basket, SPYx and the SOL conversion included, and the only notice anybody
  // got was a vault that silently stopped buying.
  //
  // These are about the WIRING, not the decision: that the warning is computed
  // over the very legs and the very epoch the refusal judged, that it rides the
  // turn's result whichever way the turn ends, and that it changes nothing.

  /** The three-leg scenario the assertions below share: deep pools, conversion off, 12 USDC held. */
  async function restingTurn(
    mints: (defaults: readonly PublicKey[]) => ReadonlyMap<string, Buffer>,
    /** Slots from the chain's slot to epoch 931, for the Clock AND getEpochInfo alike; default: all but one of 930. */
    slotsLeftInEpoch?: bigint,
    /** What getEpochInfo answers instead, for a chain that moved on after the turn read its Clock. */
    laterSlotsLeftInEpoch?: bigint,
  ) {
    const basket = basketOnChain([DEEP_INVENTORY, DEEP_INVENTORY, DEEP_INVENTORY]);
    const jupiter = stubJupiter();
    for (const [address, data] of mints(basket.mints)) basket.accounts.set(address, { data, owner: TOKEN_2022_PROGRAM_ID });
    const slot = slotsLeftInEpoch === undefined ? FIXTURE_SLOT : 931n * 432_000n - slotsLeftInEpoch;
    const laterSlot = laterSlotsLeftInEpoch === undefined ? slot : 931n * 432_000n - laterSlotsLeftInEpoch;
    const laterEpoch = laterSlot / 432_000n;
    if (slotsLeftInEpoch !== undefined) basket.accounts.set(SYSVAR_CLOCK_PUBKEY.toBase58(), { data: clockBytes(TODAY_UNIX, slot) });
    let usdcAta: PublicKey | undefined;
    const { vault, connection, program } = chainWith({}, { legs: basket.legs, minConvertRateWad: 0n }, {
      ...(slotsLeftInEpoch === undefined
        ? {}
        : { getEpochInfo: async () => ({ epoch: Number(laterEpoch), slotIndex: Number(laterSlot - laterEpoch * 432_000n), slotsInEpoch: 432_000, absoluteSlot: Number(laterSlot), blockHeight: Number(laterSlot) }) }),
      getMinimumBalanceForRentExemption: async () => 2_000_000,
      getTokenAccountBalance: async (address) => {
        if (usdcAta === undefined || !(address as PublicKey).equals(usdcAta)) throw new Error("could not find account");
        return { context: { slot: 1 }, value: { amount: "12000000", decimals: 6, uiAmount: 12 } };
      },
    }, true, basket.accounts);
    usdcAta = getAssociatedTokenAddressSync(USDC_MINT, vault, true);
    const run = async () =>
      runInvestTick({
        connection, program, vault, crank: TURN_CRANK, crankLamports: 10_000_000_000n, live: true, protocolPaused: false,
      });
    return { basket, run, result: await run(), urls: jupiter.urls };
  }

  const none = (): ReadonlyMap<string, Buffer> => new Map();

  it("carries a leg's fee warning out on the turn's result, and changes nothing else about the turn", async () => {
    // TWO IDENTICAL TURNS, one whose middle leg charges EXACTLY the ceiling.
    // The fee is admitted — deliberately — so both turns must reach the same
    // outcome by the same words. A warning that moved either is a refusal
    // wearing a warning's name.
    const plain = await restingTurn(none);
    const atCeiling = await restingTurn((mints) => new Map([[mints[1]!.toBase58(), feeMintBytes(300, 900n)]]));

    expect(plain.result.outcome).toBe("IDLE");
    expect(plain.result.outcome).toBe(atCeiling.result.outcome);
    expect(atCeiling.result.detail).toBe(plain.result.detail);
    expect(atCeiling.result.detail).toContain("under the $5.00 per-call minimum");
    expect(atCeiling.result.purchases).toEqual(plain.result.purchases);

    // AND THE NOTICE IS THERE, where the alerter can reach it. A mint with no
    // fee extension at all says nothing — but it says it as an EMPTY ARRAY, not
    // as an absent field: bin/keeper.mts clears a standing alert only on the
    // evidence that a turn LOOKED.
    expect(plain.result.feeWarnings).toEqual([]);
    expect(atCeiling.result.feeWarnings).toHaveLength(1);
    const alert = atCeiling.result.feeWarnings![0]!;
    expect(alert.severity).toBe("warn");
    expect(alert.title).toContain("at the ceiling this keeper buys through");
    expect(alert.detail).toContain(atCeiling.basket.mints[1]!.toBase58());
    // THE CHAIN'S OWN EPOCH, not this host's clock and not a second read: the
    // fee is judged in the epoch Token-2022 would charge it in, which is the
    // same epoch the admission gate beside it used.
    expect(alert.detail).toContain("charges 300 bps to transfer in epoch 930");
    expect(alert.context).toMatchObject({ feeBps: "300", ceilingBps: "300", epoch: "930" });
    // The other two legs carry no fee, so they are silent.
    for (const index of [0, 2]) expect(alert.detail).not.toContain(atCeiling.basket.mints[index]!.toBase58());
  });

  it("raises the SAME key on every sweep, so one condition is one message rather than one a minute", async () => {
    // alerts.ts deduplicates by key alone and holds a fired condition quiet for
    // the repeat window. A key that moved between sweeps would defeat that
    // whole mechanism, and the keeper sweeps about once a minute.
    const turn = await restingTurn((mints) => new Map([
      [mints[0]!.toBase58(), feeMintBytes(250, 900n)],
      [mints[2]!.toBase58(), feeMintBytes(300, 900n)],
    ]));
    const again = await turn.run();
    const keys = (result: { readonly feeWarnings?: readonly { readonly key: string }[] }): readonly string[] =>
      (result.feeWarnings ?? []).map((warning) => warning.key);

    // SWEEP TO SWEEP, NOTHING MOVES. Same chain, same legs, same keys.
    expect(keys(turn.result)).toHaveLength(2);
    expect(keys(again)).toEqual(keys(turn.result));

    // AND THE KEY IS THE MINT AND THE RATE, which is what makes a fee that
    // WORSENS a different condition: it breaks through the quiet window its own
    // earlier warning opened, instead of being muted by it for half an hour.
    const at = (mint: PublicKey): string => keys(turn.result).find((entry) => entry.includes(mint.toBase58()))!;
    expect(at(turn.basket.mints[0]!)).toBe(`leg-fee:${turn.basket.mints[0]!.toBase58()}:250`);
    expect(at(turn.basket.mints[2]!)).toBe(`leg-fee:${turn.basket.mints[2]!.toBase58()}:300`);
    expect(new Set(keys(turn.result)).size).toBe(2);
  });

  it("still carries the warning out of a basket REFUSED for a different leg", async () => {
    // This turn's problem is not next month's. A basket refused today for leg
    // A's transfer hook must not swallow the notice that leg B is one issuer
    // step from stopping it forever.
    const hook = key();
    const turn = await restingTurn((mints) => new Map([
      [mints[0]!.toBase58(), hookMintBytes(hook)],
      [mints[2]!.toBase58(), feeMintBytes(300, 900n)],
    ]));

    expect(turn.result.outcome).toBe("REFUSED");
    expect(turn.result.detail).toContain(hook.toBase58());
    expect(turn.result.detail).toContain("without a program upgrade");
    expect(turn.result.feeWarnings).toHaveLength(1);
    expect(turn.result.feeWarnings![0]!.detail).toContain(turn.basket.mints[2]!.toBase58());
    // The hooked mint carries no fee at all, so it is refused in words and
    // silent here rather than reported twice.
    expect(turn.result.feeWarnings![0]!.detail).not.toContain(hook.toBase58());
  });

  it("calls a rise that is only SCHEDULED what it is: a date this basket stops, before it arrives", async () => {
    // set_transfer_fee writes the new rate stamped with the epoch it starts in,
    // about two epochs out. Between that write and the charge, the number that
    // will stop this basket is sitting in the mint's own bytes — and this turn
    // reads those bytes anyway, so the notice costs no request at all.
    const turn = await restingTurn((mints) => new Map([[mints[1]!.toBase58(), feeMintBytes(350, 932n)]]));
    expect(turn.result.outcome).toBe("IDLE");
    const alert = turn.result.feeWarnings![0]!;
    expect(alert.severity).toBe("critical");
    expect(alert.title).toContain("will stop this basket");
    expect(alert.detail).toContain("A fee of 350 bps is ALREADY written for epoch 932");
    expect(alert.detail).toContain("2 epoch(s) from now");
    // AND THE TURN STILL BUYS TODAY, because 0 bps is what a transfer in epoch
    // 930 is actually charged. The warning is the only thing that changed.
    expect(turn.result.detail).toContain("under the $5.00 per-call minimum");

    // A SCHEDULED 300 IS THE CEILING THE OWNER ACCEPTED ON 2026-09-24, NOT A
    // DATE: through the same wiring it is a warning, and the basket is bought
    // from that epoch too.
    const atCeiling = await restingTurn((mints) => new Map([[mints[1]!.toBase58(), feeMintBytes(300, 932n)]]));
    const notice = atCeiling.result.feeWarnings![0]!;
    expect(notice.severity).toBe("warn");
    expect(notice.detail).toContain("A fee of 300 bps is ALREADY written for epoch 932, 2 epoch(s) from now: EXACTLY the ceiling");
  });

  describe("a written fee rise reaches the slippage only in the epoch a transaction can land in", () => {
    // THE REFUSAL THIS REPLACES, measured 2026-09-25 on the owner's vault in
    // epoch 1042, ~355,000 slots before 1043: 300 bps written for 1043 made the
    // keeper ask 400 and take min_out net of 300, under the owner's floor, on
    // every sweep. The turn below asks Jupiter directly, so the slippage in the
    // quote URL is the keeper's sizing and the builder's agreement at once — a
    // disagreement would REFUSE instead of reaching the per-call minimum.
    const askedFor = (urls: readonly string[], mint: PublicKey): readonly string[] =>
      urls
        .filter((url) => url.includes("/quote") && new URL(url).searchParams.get("outputMint") === mint.toBase58())
        .map((url) => new URL(url).searchParams.get("slippageBps") ?? "");
    const rise = (from: bigint) => (mints: readonly PublicKey[]) => new Map([[mints[1]!.toBase58(), feeMintBytes(300, from)]]);

    it("asks 200, not 400, for a 300 written two epochs out, even in the last slot of this one", async () => {
      const turn = await restingTurn(rise(932n), 1n);
      expect(turn.result.outcome).toBe("IDLE");
      expect(turn.result.detail).toContain("under the $5.00 per-call minimum");
      expect(askedFor(turn.urls, turn.basket.mints[1]!)).toEqual(["200", "200"]);
      // AND THE NOTICE IS UNCHANGED: the rise is announced the day it is written.
      expect(turn.result.feeWarnings![0]!.detail).toContain("A fee of 300 bps is ALREADY written for epoch 932, 2 epoch(s) from now");
    });

    it("asks 200 for a 300 written for the next epoch while that epoch is still outside the landing window", async () => {
      const turn = await restingTurn(rise(931n), LANDING_WINDOW_SLOTS + 1n);
      expect(turn.result.detail).toContain("under the $5.00 per-call minimum");
      expect(askedFor(turn.urls, turn.basket.mints[1]!)).toEqual(["200", "200"]);
    });

    it("asks 400 for the same rise once the next epoch starts inside the landing window, and the builder agrees", async () => {
      const turn = await restingTurn(rise(931n), LANDING_WINDOW_SLOTS);
      // REACHING THE PER-CALL MINIMUM IS THE AGREEMENT: had the builder
      // modelled 0 while the keeper asked 400, or 300 while it asked 200, the
      // route or measureLegVenue would have refused the basket first.
      expect(turn.result.outcome).toBe("IDLE");
      expect(turn.result.detail).toContain("under the $5.00 per-call minimum");
      expect(askedFor(turn.urls, turn.basket.mints[1]!)).toEqual(["400", "400"]);
      // The other legs carry no fee and are asked the floor, whatever the window.
      expect(askedFor(turn.urls, turn.basket.mints[0]!)).toEqual(["200", "200"]);
    });

    it("keeps the turn's own decision when the chain crosses into the window after the Clock was read (review, 2026-09-25)", async () => {
      // The Clock says one slot outside the window; by the time the builder asks
      // getEpochInfo the next epoch is inside it. Before the builder took the
      // turn's decision, the keeper asked 200 for 100 bps, the builder modelled
      // the 300, and measureLegVenue refused the basket on the disagreement —
      // on the send-time re-measure, that is after the wrap and the convert.
      const turn = await restingTurn(rise(931n), LANDING_WINDOW_SLOTS + 1n, LANDING_WINDOW_SLOTS - 100n);
      expect(turn.result.outcome).toBe("IDLE");
      expect(turn.result.detail).toContain("under the $5.00 per-call minimum");
      expect(askedFor(turn.urls, turn.basket.mints[1]!)).toEqual(["200", "200"]);
    });

    it("but once the chain is IN a later epoch, the turn's slots-left no longer decide anything", async () => {
      // The turn's Clock is ONE slot from the end of 930, and the 300 is written
      // for 932 — two epochs out for the turn, so it asks 200. The chain the
      // builder reads is already 100 slots into 931, where 932 is a whole epoch
      // away. Carrying the turn's "one slot left" into 931 would make the 932
      // rise look one slot away and refuse the basket on a fee no transaction
      // can land under; the builder's own slots-left says it is far, and agrees.
      const turn = await restingTurn(rise(932n), 1n, -100n);
      expect(turn.result.outcome).toBe("IDLE");
      expect(turn.result.detail).toContain("under the $5.00 per-call minimum");
      expect(askedFor(turn.urls, turn.basket.mints[1]!)).toEqual(["200", "200"]);
    });

    it("fails the turn before anything is sent when the EpochSchedule cannot be read, rather than guess where the epoch ends", async () => {
      const basket = basketOnChain([DEEP_INVENTORY, DEEP_INVENTORY, DEEP_INVENTORY]);
      const jupiter = stubJupiter();
      basket.accounts.set(SYSVAR_EPOCH_SCHEDULE_PUBKEY.toBase58(), { data: MAINNET_EPOCH_SCHEDULE.subarray(0, 32) });
      let usdcAta: PublicKey | undefined;
      const { vault, connection, program, calls } = chainWith({}, { legs: basket.legs, minConvertRateWad: 0n }, {
        getMinimumBalanceForRentExemption: async () => 2_000_000,
        getTokenAccountBalance: async (address) => {
          if (usdcAta === undefined || !(address as PublicKey).equals(usdcAta)) throw new Error("could not find account");
          return { context: { slot: 1 }, value: { amount: "12000000", decimals: 6, uiAmount: 12 } };
        },
      }, true, basket.accounts);
      usdcAta = getAssociatedTokenAddressSync(USDC_MINT, vault, true);
      const result = await runInvestTick({
        connection, program, vault, crank: TURN_CRANK, crankLamports: 10_000_000_000n, live: true, protocolPaused: false,
      });
      expect(result.outcome).toBe("FAILED");
      expect(result.detail).toContain("the EpochSchedule sysvar could not be read");
      expect(result.detail).toContain("33 bytes");
      expect(result.detail).toContain("nothing was sent");
      expect(jupiter.urls).toEqual([]);
      for (const rpc of ["getLatestBlockhash", "sendTransaction", "sendRawTransaction"]) expect(calls).not.toContain(rpc);
    });
  });

  it("leaves feeWarnings ABSENT on a turn that stopped before it read a single mint", async () => {
    // The distinction bin/keeper.mts clears on: an EMPTY array is "looked, and
    // there is nothing to say"; ABSENT is "this turn learned nothing about any
    // fee". A venue refusal happens off the policy alone, before the leg read,
    // so a sweep of nothing but these must not clear a standing warning.
    const basket = basketOnChain([DEEP_INVENTORY, DEEP_INVENTORY, DEEP_INVENTORY]);
    stubJupiter();
    basket.accounts.set(basket.mints[0]!.toBase58(), { data: feeMintBytes(100, 900n), owner: TOKEN_2022_PROGRAM_ID });
    const { vault, connection, program } = chainWith({}, { legs: basket.legs, venueProgram: key() }, emptyAndPriced, true, basket.accounts);
    const result = await runInvestTick({
      connection, program, vault, crank: TURN_CRANK, crankLamports: 10_000_000_000n, live: true, protocolPaused: false,
    });

    expect(result.outcome).toBe("REFUSED");
    expect(result.detail).toContain("WrongVenue");
    expect(result.feeWarnings).toBeUndefined();
  });

  // ── and the operator actually receiving it ────────────────────────────────
  //
  // WHY THE SOURCE IS READ RATHER THAN THE BEHAVIOUR EXERCISED, the same reason
  // test/wallet-turn-catch.test.ts gives: the sweep is a closure inside a
  // top-level script that connects to a chain, a database and Privy before it
  // defines one, so there is no seam to drive a single turn through. What broke
  // here is structural — a function with no caller — and it reads back from the
  // text exactly. The DECISION is exercised properly in test/invest-decision.ts
  // and the tick's carry is exercised above; this is the last link, and it is
  // the one that was missing.

  const keeperSource = readFileSync(new URL("../bin/keeper.mts", import.meta.url), "utf8");

  it("raises every fee warning the tick carried, on ANY outcome rather than only the refused ones", () => {
    // OUTSIDE THE OUTCOME BRANCH. `invest-refused` lives inside
    // `if (invest.outcome === "INVESTED" || ... )`, which excludes IDLE — and
    // an IDLE turn is exactly how a vault sitting on a 100 bps leg reads on a
    // quiet day. Eight spaces of indent is the link loop's own level, one
    // outside that branch, so this pins the placement and not just the call.
    // (Since the doorbell the keys are collected PER VAULT — a sweep no longer
    // turns every vault — but the placement pinned here is unchanged. Since
    // 2026-09-25 each goes through legFeeAlert, which makes a WARN announce
    // once instead of every 30 minutes; test/alerts.test.ts drives that.)
    expect(keeperSource).toMatch(
      /\n {8}if \(invest\.feeWarnings !== undefined\) \{\n {10}const raised = legFeeLooked\.get\(vaultAddr\) \?\? new Set<string>\(\);\n {10}for \(const alert of invest\.feeWarnings\) \{\n {12}raised\.add\(alert\.key\);\n {12}alerter\.fire\(legFeeAlert\(alert\)\);\n {10}\}\n {10}legFeeLooked\.set\(vaultAddr, raised\);\n {8}\}\n/,
    );
  });

  it("clears a leg-fee key the sweep stopped raising, and only once a turn had actually looked", () => {
    // AN ALERT THAT IS NEVER CLEARED IS AN ALARM THAT NEVER STOPS RINGING —
    // and one cleared on no evidence rings once a minute forever, because the
    // next sweep that reads a mint raises it again from nothing. Both halves
    // are the deduplication working: the key is the mint AND the rate, so a
    // worsening fee opens its own condition while the old one is retired here.
    //
    // "ONLY ONCE A TURN HAD LOOKED" IS NOW PER VAULT. Under the doorbell a sweep
    // turns a selection, and a vault that was not turned has learned nothing:
    // clearing its warning because this sweep did not raise it would re-raise it
    // on the next rotation, forever. So only a vault whose turn read the mints
    // enters `legFeeLooked`, and reconcileLegFees (test/sweep-decision.test.ts)
    // keeps every other vault's last word.
    expect(keeperSource).toMatch(/if \(invest\.feeWarnings !== undefined\) \{/);
    // The fold itself — per vault, `standing` owned by the book — is driven in
    // test/doorbell-wiring.test.ts over two sweeps (LegFeeBook).
    expect(keeperSource).toMatch(
      /\n {4}for \(const key of legFeeBook\.fold\(legFeeLooked, new Set\(doorLinks\.map\(\(link\) => link\.vault\)\)\)\) alerter\.clear\(key\);\n/,
    );
    // Cleared by KEY across vaults, never by a vault's own template: legFeeCeilingAlert
    // keys on the mint and the rate with no vault in it, so two vaults holding the
    // same leg are one condition — and a per-vault clear would silence the other's warning.
    expect(keeperSource).not.toMatch(/alerter\.clear\(`leg-fee:/);
  });

  // ── the ATA storm ─────────────────────────────────────────────────────────
  //
  // createAssociatedTokenAccountIdempotent sends a TRANSACTION of its own on
  // every call, existing account or not, at 5,000 lamports each. The turn opened
  // with two and then sent one more per leg, before it knew there was a route to
  // buy through. Of 27 signatures on the live vault on 2026-09-20, 17 were that,
  // and they pushed the real settle off the first page of the dashboard.

  /** An anchor Program over the stub chain whose wallet CAPTURES what it is asked to sign, then refuses. */
  function capturing(connection: Connection) {
    const signed: Transaction[] = [];
    const wallet = {
      publicKey: PublicKey.default,
      // The turn's transactions are legacy ones; the signature is the generic
      // shape anchor's Wallet declares, so no cast is needed at the call.
      signTransaction: async <T extends Transaction | VersionedTransaction>(tx: T): Promise<T> => {
        signed.push(tx as Transaction);
        throw new Error("the capturing wallet signs nothing");
      },
      signAllTransactions: async <T extends Transaction | VersionedTransaction>(): Promise<T[]> => {
        throw new Error("the capturing wallet signs nothing");
      },
    };
    return { signed, program: new anchor.Program(idl, new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" })) };
  }

  /** Everything a live CONVERTING turn reads before its wrap: a rent floor, no token accounts, and a crank holding 10 SOL. */
  const convertingAndFunded: Readonly<Record<string, Handler>> = {
    ...emptyAndPriced,
    getBalance: async () => 10_000_000_000,
    getLatestBlockhash: async () => ({ blockhash: key().toBase58(), lastValidBlockHeight: 1_000 }),
  };

  /**
   * The chain's own answers, with `present` served as an SPL Token account that
   * exists and holds nothing (the 165-byte layout, zero at the u64 at 64).
   *
   * Through a Proxy rather than through chainWith's account map, because the
   * vault this account belongs to is generated inside chainWith and the address
   * does not exist until it returns.
   */
  function withAccountPresent(connection: Connection, present: PublicKey): Connection {
    const served = connection.getMultipleAccountsInfo.bind(connection);
    const account = { data: Buffer.alloc(165), executable: false, lamports: 2_039_280, owner: TOKEN_PROGRAM_ID, rentEpoch: 0 };
    return new Proxy(connection, {
      get(target, prop) {
        if (prop !== "getMultipleAccountsInfo") return (target as unknown as Record<string | symbol, unknown>)[prop];
        return async (addresses: PublicKey[], commitment: unknown) => {
          const answer = (await served(addresses, commitment as never)) as (typeof account | null)[];
          return answer.map((info, index) => (addresses[index]!.equals(present) ? account : info));
        };
      },
    }) as Connection;
  }

  // ── a small converting vault, measured at what it can reach ───────────────
  //
  // THE OWNER'S VAULT ON 2026-10-09, IN THIS FILE'S PRICES. 0.0197 SOL free, no
  // wSOL and no USDC, a two-leg basket at 50/50 under max_per_call $149 and a
  // $1 minimum. The deployed gate measured each leg at half the cap, $74.50,
  // and refused a venue at that size that the vault could never push more than
  // about a dollar into. Here SOL is the feeds' $102.59, so what the convert
  // can bring in is 0.0197 x $102.59 = $2.02, and the ceiling is that at the
  // top of the oracle's band plus CONVERT_PROCEEDS_MARGIN_BPS: 2,223,506 raw.

  /** The vault's free SOL in these cases: the stub serves every account 10 SOL, so the rent floor is set to leave this much. */
  const SMALL_FREE = 19_700_000;
  /** convertProceedsCeiling of SMALL_FREE at this file's feeds (conf 1,000 at -8 on both), worked in exact fractions outside the code: ceil(19.7e6 x (102.59322149 / 0.99986040) / 1e3 x 1.1). */
  const SMALL_CEILING = 2_223_506n;
  /** What one 5,000 bps leg of that is: the size the gate must measure. */
  const SMALL_LEG = 1_111_753n;

  function smallVault(basket: ReturnType<typeof basketOnChain>, extra: Readonly<Record<string, Handler>> = {}) {
    const legs = basket.legs.map((leg) => ({ ...leg, weightBps: 5_000 }));
    return chainWith(
      {},
      { legs, maxPerCall: 149_000_000n, minInvestment: 1_000_000n },
      {
        ...convertingAndFunded,
        getMinimumBalanceForRentExemption: async () => 10_000_000_000 - SMALL_FREE,
        ...extra,
      },
      true,
      basket.accounts,
    );
  }

  /** The amount of every Jupiter quote whose output is one of `mints`, in the order asked. */
  function legQuoteAmounts(urls: readonly string[], mints: readonly PublicKey[]): bigint[] {
    const names = new Set(mints.map((mint) => mint.toBase58()));
    return urls
      .filter((url) => url.includes("/quote"))
      .map((url) => new URL(url).searchParams)
      .filter((params) => names.has(params.get("outputMint") ?? ""))
      .map((params) => BigInt(params.get("amount") ?? "0"));
  }

  it("measures a small converting vault's legs at what its SOL can bring in, not at half its max_per_call", async () => {
    const basket = basketOnChain([DEEP_INVENTORY, DEEP_INVENTORY]);
    const { urls } = stubJupiter();
    const chain = smallVault(basket);
    const { program } = capturing(chain.connection);
    const result = await runInvestTick({
      connection: chain.connection, program, vault: chain.vault, crank: TURN_CRANK, crankLamports: 10_000_000_000n, live: true, protocolPaused: false,
    });

    // PAST THE GATE: the turn dies where the capturing wallet refuses to sign
    // the wrap, so every quote below was asked before any money could move.
    expect(result.outcome).toBe("FAILED");
    const amounts = legQuoteAmounts(urls, basket.mints);
    // Two legs, each quoted at its turn size and at ARM 2's probe.
    expect(amounts).toHaveLength(4);
    expect(amounts.reduce((a, b) => (a > b ? a : b), 0n)).toBe(SMALL_LEG);
    // The deployed gate's size, which no quote here may reach.
    for (const amount of amounts) expect(amount).toBeLessThan(74_500_000n);
  });

  it("never spends more than the gate measured, even when the convert brings in far more than estimated", async () => {
    // THE CLAMP, DRIVEN THROUGH A WHOLE TURN. The chain here confirms what it
    // is sent, and the USDC the vault holds after the convert is 500 dollars —
    // a convert that paid out far past its estimate, or a deposit that landed
    // mid-turn; to the turn the two are the same thing. max_per_call alone
    // would let 149 of it be spent, 74.50 a leg, into venues the gate measured
    // at about a dollar a leg. invest-tick.ts clamps the budget to the ceiling
    // the gate tested; remove that line and this fails.
    const basket = basketOnChain([DEEP_INVENTORY, DEEP_INVENTORY]);
    const { urls } = stubJupiter();
    const crank = Keypair.generate();
    let sent = 0;
    let quotesBeforeFirstSend: number | null = null;
    let usdcAta: PublicKey | undefined;
    let wsolAta: PublicKey | undefined;
    const chain = smallVault(basket, {
      sendRawTransaction: async () => {
        if (quotesBeforeFirstSend === null) quotesBeforeFirstSend = urls.length;
        sent += 1;
        return Keypair.generate().publicKey.toBase58();
      },
      confirmTransaction: async () => ({ context: { slot: 1 }, value: { err: null } }),
      getSlot: async () => 1,
      getTokenAccountBalance: async (address) => {
        const raw = (amount: bigint) => ({ context: { slot: 1 }, value: { amount: amount.toString(), decimals: 6, uiAmount: null } });
        // After the wrap, the vault holds what it wrapped as wSOL.
        if (wsolAta !== undefined && (address as PublicKey).equals(wsolAta) && sent >= 1) return raw(BigInt(SMALL_FREE));
        // After the convert, far more USDC than the estimate said it could.
        if (usdcAta !== undefined && (address as PublicKey).equals(usdcAta) && sent >= 2) return raw(500_000_000n);
        throw new Error("could not find account");
      },
    });
    usdcAta = getAssociatedTokenAddressSync(USDC_MINT, chain.vault, true, TOKEN_PROGRAM_ID);
    wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, chain.vault, true, TOKEN_PROGRAM_ID);
    const signing = async <T extends Transaction | VersionedTransaction>(tx: T): Promise<T> => tx;
    const program = new anchor.Program(
      idl,
      new anchor.AnchorProvider(
        chain.connection,
        { publicKey: crank.publicKey, signTransaction: signing, signAllTransactions: async (txs) => txs },
        { commitment: "confirmed" },
      ),
    );
    const result = await runInvestTick({
      connection: chain.connection, program, vault: chain.vault, crank, crankLamports: 10_000_000_000n, live: true, protocolPaused: false,
    });

    expect(result.detail).toContain("bought");
    expect(result.outcome).toBe("INVESTED");
    // The wrap, the convert and one invest per leg.
    expect(sent).toBe(4);
    // WHAT WAS SPENT IS WHAT WAS TESTED, and not a raw more: each leg's share
    // of the ceiling the gate measured, not of the 149 the vault could afford.
    expect(result.purchases?.map((purchase) => purchase.spentRaw)).toEqual([SMALL_LEG, SMALL_LEG]);
    const gate = legQuoteAmounts(urls.slice(0, quotesBeforeFirstSend ?? 0), basket.mints);
    const send = legQuoteAmounts(urls.slice(quotesBeforeFirstSend ?? 0), basket.mints);
    expect(gate.length).toBeGreaterThan(0);
    expect(send.length).toBeGreaterThan(0);
    const tested = gate.reduce((a, b) => (a > b ? a : b), 0n);
    for (const amount of send) expect(amount).toBeLessThanOrEqual(tested);
    expect(legQuoteAmounts(urls, basket.mints)).not.toContain(74_500_000n);
    expect(SMALL_CEILING / 2n).toBe(SMALL_LEG);
  });

  it("reads every token account it might need in ONE request, and creates the missing one INSIDE the transaction that uses it", async () => {
    const basket = basketOnChain([DEEP_INVENTORY, DEEP_INVENTORY, DEEP_INVENTORY]);
    stubJupiter();
    const crank = Keypair.generate();
    const { vault, connection, calls, callArgs } = chainWith({}, { legs: basket.legs }, convertingAndFunded, true, basket.accounts);
    const { signed, program } = capturing(connection);
    const result = await runInvestTick({
      connection, program, vault, crank, crankLamports: 10_000_000_000n, live: true, protocolPaused: false,
    });

    // The turn dies where the stub refuses to sign — past the point this test is about.
    expect(result.outcome).toBe("FAILED");

    const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, vault, true, TOKEN_PROGRAM_ID);
    const usdcAta = getAssociatedTokenAddressSync(USDC_MINT, vault, true, TOKEN_PROGRAM_ID);
    const legAtas = basket.mints.map((mint) => getAssociatedTokenAddressSync(mint, vault, true, TOKEN_2022_PROGRAM_ID));

    // ONE REQUEST, NAMING EVERY CANDIDATE: the vault's wSOL account, its USDC
    // account and every leg's target, in one getMultipleAccountsInfo — not one
    // read, and not one transaction, per account.
    //
    // FOUND BY ITS CONTENTS, NOT ITS POSITION. It used to be the 4th such read
    // and the test said so; a Jupiter measurement now reads the accounts every
    // route names, so the count in front of it belongs to measureLegVenue and
    // would move for reasons that have nothing to do with the ATA storm. What
    // must stay true is that these six addresses are asked for TOGETHER, and
    // exactly once.
    const reads = calls.flatMap((name, index) => (name === "getMultipleAccountsInfo" ? [callArgs[index]![0] as PublicKey[]] : []));
    const candidates = [wsolAta, usdcAta, ...legAtas];
    const candidateReads = reads.filter(
      (read) => read.length === candidates.length && candidates.every((key, index) => key.equals(read[index]!)),
    );
    expect(candidateReads, "the vault's wSOL, USDC and every leg target, in one request and only one").toHaveLength(1);

    // AND IT HAPPENS ONLY ONCE THE TURN HAS DECIDED TO WRAP. getBalance is the
    // crank's own balance, re-read to size the wrap; the candidates are read
    // after it, and nothing is signed before either.
    expect(calls.indexOf("getBalance")).toBeLessThan(calls.lastIndexOf("getMultipleAccountsInfo"));
    expect(calls.lastIndexOf("getMultipleAccountsInfo")).toBeLessThan(calls.indexOf("getLatestBlockhash"));

    // NOT ONE TRANSACTION OF ITS OWN. Exactly one transaction was built, and the
    // create rides it: the ATA exists if and only if the wrap_sol it is for was
    // sent.
    expect(signed).toHaveLength(1);
    expect(calls.filter((name) => name === "getLatestBlockhash")).toHaveLength(1);
    for (const rpc of ["sendTransaction", "sendRawTransaction"]) expect(calls).not.toContain(rpc);

    // getAccountInfo IS NOW CALLED, AND IT MUST NEVER BE FOR ONE OF THESE.
    // This used to assert the call did not happen at all, which was the same
    // claim as "no account is read one at a time". It happens now — the route
    // builder reads each hop's DESTINATION MINT to price its transfer fee — so
    // the assertion states what it always meant: a single read is for a mint,
    // never for a token account, because a token account read one at a time is
    // the ATA storm coming back.
    const singles = calls.flatMap((name, index) => (name === "getAccountInfo" ? [callArgs[index]![0] as PublicKey] : []));
    expect(singles.length, "one per hop: the convert's USDC and each leg's own mint").toBeGreaterThan(0);
    for (const address of singles) {
      expect(
        candidates.some((candidate) => candidate.equals(address)),
        `${address.toBase58()} is one of the vault's token accounts, read on its own — that is the ATA storm`,
      ).toBe(false);
      expect([USDC_MINT.toBase58(), ...basket.mints.map((m) => m.toBase58())]).toContain(address.toBase58());
    }

    const [create, wrapSol] = signed[0]!.instructions;
    expect(signed[0]!.instructions).toHaveLength(2);
    expect(wrapSol!.programId.equals(programId)).toBe(true);
    expect(create!.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)).toBe(true);
    // Byte 1 is CreateIdempotent, not Create: a race that creates the account
    // between the read above and the send is a no-op, never a broken turn.
    expect([...create!.data]).toEqual([1]);
    expect(create!.keys.map((meta) => meta.pubkey.toBase58())).toEqual([
      crank.publicKey.toBase58(),
      wsolAta.toBase58(),
      vault.toBase58(),
      NATIVE_MINT.toBase58(),
      SystemProgram.programId.toBase58(),
      TOKEN_PROGRAM_ID.toBase58(),
    ]);
  });

  it("does NOT refuse the basket because the SOL hop is below the owner's floor — that is a rest, not a verdict", async () => {
    // FOUND BY REMOVAL, 2026-09-21. The convert is measured by the same
    // function and judged by the same all-or-nothing verdict as the legs, so it
    // is tempting to hand the gate the owner's min_convert_rate_wad as well.
    // That is wrong, and nothing was stopping it: passing ownerFloorRateWad at
    // the gate left all 44 cases in this file green.
    //
    // WHY IT MATTERS. The gate's question is whether the VENUE is deep, and its
    // answer refuses the whole basket before the wrap. The owner's floor is a
    // PRICE, and a price under it means the market moved — a reason to leave
    // the SOL as SOL this sweep, not a reason to stop buying with the USDC the
    // vault already holds. A floor of (1 << 64) wad is about $18 billion the
    // SOL: unmeetable, deliberately, so that the only thing this test can be
    // reading is what the gate does with it.
    const basket = basketOnChain([DEEP_INVENTORY, DEEP_INVENTORY, DEEP_INVENTORY]);
    stubJupiter();
    const chain = chainWith({}, { legs: basket.legs, minConvertRateWad: 1n << 64n }, convertingAndFunded, true, basket.accounts);
    const { program } = capturing(chain.connection);
    const result = await runInvestTick({
      connection: chain.connection, program, vault: chain.vault, crank: TURN_CRANK, crankLamports: 10_000_000_000n, live: true, protocolPaused: false,
    });

    // PAST THE GATE. The turn dies later, where the capturing stub refuses to
    // sign — which is exactly the point: it GOT there. Had the floor been
    // handed to the gate, this would be REFUSED before a single lamport was
    // wrapped, and the detail would say the venues could not be measured.
    expect(result.outcome).toBe("FAILED");
    expect(result.detail).not.toContain("could not be measured");
    expect(result.detail).not.toContain("refusing the whole basket");
  });

  it("creates nothing for an account that already exists: the same turn sends the wrap alone", async () => {
    const basket = basketOnChain([DEEP_INVENTORY, DEEP_INVENTORY, DEEP_INVENTORY]);
    stubJupiter();
    const crank = Keypair.generate();
    // The vault's wSOL account is on the chain this time. Everything else about
    // the turn is identical, so the only thing the assertions can be reading is
    // the account's existence.
    const chain = chainWith({}, { legs: basket.legs }, convertingAndFunded, true, basket.accounts);
    const connection = withAccountPresent(chain.connection, getAssociatedTokenAddressSync(NATIVE_MINT, chain.vault, true, TOKEN_PROGRAM_ID));
    const { signed, program } = capturing(connection);
    const result = await runInvestTick({
      connection, program, vault: chain.vault, crank, crankLamports: 10_000_000_000n, live: true, protocolPaused: false,
    });

    expect(result.outcome).toBe("FAILED");
    expect(signed).toHaveLength(1);
    expect(signed[0]!.instructions).toHaveLength(1);
    expect(signed[0]!.instructions[0]!.programId.equals(programId)).toBe(true);
    for (const instruction of signed[0]!.instructions) {
      expect(instruction.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)).toBe(false);
    }
  });

  it("creates NOTHING for a leg whose route cannot be fetched, and never asks whether its account exists", async () => {
    // THE ORDER IS THE BUG. The old turn created the leg's associated token
    // account and only then went looking for a route; a leg with no live swap
    // left a paid-for account behind on every sweep. Conversion is off here, so
    // the only thing this turn can do is buy: 250 USDC, three legs, deep
    // venues, and a Jupiter that will not answer.
    const basket = basketOnChain([DEEP_INVENTORY, DEEP_INVENTORY, DEEP_INVENTORY]);
    stubJupiter({ fail: true });
    let usdcAta: PublicKey | undefined;
    const { vault, connection, program, calls } = chainWith({}, { legs: basket.legs, minConvertRateWad: 0n }, {
      getMinimumBalanceForRentExemption: async () => 2_000_000,
      getTokenAccountBalance: async (address) => {
        if (usdcAta === undefined || !(address as PublicKey).equals(usdcAta)) throw new Error("could not find account");
        return { context: { slot: 1 }, value: { amount: "250000000", decimals: 6, uiAmount: 250 } };
      },
      getSignaturesForAddress: async () => [],
    }, true, basket.accounts);
    usdcAta = getAssociatedTokenAddressSync(USDC_MINT, vault, true, TOKEN_PROGRAM_ID);
    const result = await runInvestTick({
      connection, program, vault, crank: TURN_CRANK, crankLamports: 10_000_000_000n, live: true, protocolPaused: false,
    });

    // REFUSED, NOT FAILED, AND THAT IS THE IMPROVEMENT. A leg with nowhere to
    // trade used to be discovered at route-fetch time and reported as a failed
    // transaction; it is now a measurement that could not be taken, which is a
    // refusal — and an unmeasurable depth is never a pass.
    expect(result.outcome).toBe("REFUSED");
    expect(result.detail).toContain("could not be measured");
    expect(result.detail).toContain("refusing to convert SOL toward it");
    expect(result.purchases).toBeUndefined();
    // TWO READS, AND NOT A THIRD. The vault + Clock + feeds, then the leg
    // mints. The first leg's measurement threw before it named an account, so
    // nothing was read for the route and — the point of this test — no token
    // account was ever asked about, because none was going to be created for a
    // basket that cannot be bought.
    expect(calls.filter((name) => name === "getMultipleAccountsInfo")).toHaveLength(2);
    // ZERO, not one, and that is STRICTER than it was. The route used to be
    // found by walking a pool's signatures for a recent swap_v2, a read that
    // took 52-72 s and died on a versioned transaction. Pinning 0 keeps it gone.
    expect(calls.filter((name) => name === "getSignaturesForAddress")).toHaveLength(0);
    for (const rpc of ["getLatestBlockhash", "sendTransaction", "sendRawTransaction"]) expect(calls).not.toContain(rpc);
  });

  // ── the venue the owner signed, at the moment the money would move ─────────
  //
  // InvestmentPolicy pins venue_program, convert.rs and invest.rs both check the
  // account against it (WrongVenue), and this tick passed the RAYDIUM_CLMM
  // literal at both sites while holding the policy that names the venue. Against
  // every policy signed to date the literal happened to be right; against one
  // re-signed anywhere else, every convert and every invest for that vault
  // reverts, on every sweep, and the keeper reports it as one more failed
  // transaction.

  it("refuse a venue this keeper cannot route, before anything is wrapped, converted or bought", async () => {
    // EVERYTHING ELSE ABOUT THIS TURN IS FINE: 10 SOL free, a crank that can
    // front it, conversion on, and three pools deep enough to trade in. The only
    // thing wrong is the venue the owner's policy names, and it is enough.
    const basket = basketOnChain([DEEP_INVENTORY, DEEP_INVENTORY, DEEP_INVENTORY]);
    stubJupiter();
    const venue = key();
    const { vault, connection, program, calls } = chainWith({}, { legs: basket.legs, venueProgram: venue }, emptyAndPriced, true, basket.accounts);
    const result = await runInvestTick({
      connection, program, vault, crank: TURN_CRANK, crankLamports: 10_000_000_000n, live: true, protocolPaused: false,
    });

    expect(result.outcome).toBe("REFUSED");
    // WHAT A READER AT 3AM NEEDS: which venue was asked for, which one the
    // keeper can actually route, what the program would have answered, and who
    // can change it.
    expect(result.detail).toContain(venue.toBase58());
    expect(result.detail).toContain("Jupiter v6");
    expect(result.detail).toContain(JUPITER_V6_PROGRAM.toBase58());
    expect(result.detail).toContain("WrongVenue");
    // AND IT DOES NOT OPEN WITH THE MIGRATION SENTENCE. That clause is reserved
    // for a venue this keeper RETIRED, where the refusal is expected; an
    // unknown venue is not expected, and telling an operator "nothing is wrong"
    // about one would be the more expensive half of the mistake.
    expect(result.detail).not.toContain("EXPECTED first state");
    expect(result.detail).toContain("every sweep");
    expect(result.detail).toContain("OWNER");

    // AND IT COSTS LESS THAN THE GATES BESIDE IT. The policy is already in hand,
    // so this refusal needs nothing from the chain: the leg mints, the pools and
    // the pools' vaults are never read, no balance is fronted and nothing is
    // signed. Compare the mint/depth refusal above, which reads two more.
    expect(calls).toEqual([
      "getAccountInfoAndContext",
      "getMultipleAccountsInfo",
      "getMinimumBalanceForRentExemption",
      "getTokenAccountBalance",
      "getTokenAccountBalance",
    ]);
    for (const rpc of ["getBalance", "getLatestBlockhash", "sendTransaction", "sendRawTransaction"]) expect(calls).not.toContain(rpc);
    expect(result.wrap?.wrapped).toBe(0n);
  });

  it("open a RETIRED venue's refusal by saying the migration is expected, and name what the owner must re-sign", async () => {
    // THE REFUSAL A NOT-YET-MIGRATED VAULT GETS. The live vault got it until
    // the owner re-signed onto Jupiter v6 on 2026-09-22 (CHANGELOG.md); any
    // vault whose policy still names Raydium CLMM gets it — by design, before
    // the wrap, with nothing spent. Everything else about this turn is fine: 10
    // SOL free and a crank that can front it.
    const basket = basketOnChain([DEEP_INVENTORY, DEEP_INVENTORY, DEEP_INVENTORY]);
    stubJupiter();
    const { vault, connection, program, calls } = chainWith(
      {}, { legs: basket.legs, venueProgram: RAYDIUM_CLMM_PROGRAM }, emptyAndPriced, true, basket.accounts,
    );
    const result = await runInvestTick({
      connection, program, vault, crank: TURN_CRANK, crankLamports: 10_000_000_000n, live: true, protocolPaused: false,
    });

    expect(result.outcome).toBe("REFUSED");
    // THE FIRST CLAUSE IS THE ONE THAT DECIDES WHETHER SOMEBODY IS WOKEN UP.
    expect(result.detail.startsWith("This is the EXPECTED first state of the Jupiter migration")).toBe(true);
    expect(result.detail).toContain("no SOL has been wrapped");
    // And it still says everything the generic refusal says.
    expect(result.detail).toContain(RAYDIUM_CLMM_PROGRAM.toBase58());
    expect(result.detail).toContain(JUPITER_V6_PROGRAM.toBase58());
    expect(result.detail).toContain("set_invest_policy");
    // NOTHING WAS WRAPPED, which is the part that costs money if it is wrong.
    expect(result.wrap?.wrapped).toBe(0n);
    for (const rpc of ["getBalance", "getLatestBlockhash", "sendTransaction", "sendRawTransaction"]) expect(calls).not.toContain(rpc);
  });

  it("hand convert and invest the venue the POLICY names, at the account the program checks", async () => {
    const { program } = stubChain(new Map());
    const zero = PublicKey.default;
    const venue = key();
    const venueData = Buffer.from("c1209b3341d69c81deadbeef", "hex");
    const convertAccounts = { crank: zero, vault: zero, policy: zero, vaultWsol: zero, vaultIn: zero };
    const investAccounts = { crank: zero, vault: zero, policy: zero, vaultIn: zero, vaultTarget: zero, targetMint: zero };
    const convertArgs = { amountIn: 100n, minOut: 200n, venueData };
    const investArgs = { legIndex: 0, amountIn: 100n, minOut: 200n, venueData };

    const convert = await convertCall(program, { ...convertAccounts, venueProgram: venue }, convertArgs).instruction();
    const invest = await investCall(program, { ...investAccounts, venueProgram: venue }, investArgs).instruction();
    // venue_program is the LAST account of both instructions in the IDL, and
    // these calls carry no remaining accounts.
    expect(convert.keys.at(-1)?.pubkey.toBase58()).toBe(venue.toBase58());
    expect(invest.keys.at(-1)?.pubkey.toBase58()).toBe(venue.toBase58());

    // THERE IS NO DEFAULT ANY MORE, and the type is what enforces it: both
    // builders used to fall back to the RAYDIUM_CLMM literal when a caller
    // omitted the venue, which is now a venue this keeper REFUSES — so the
    // fallback would have built, for every offline caller, an instruction the
    // live gate would never allow. `venueProgram` is required; preflight.ts and
    // money-builders.test.ts pass JUPITER_V6_PROGRAM, the same value production
    // passes. The compiler is the assertion, so what is left to check here is
    // that the venue does not leak into the DATA.
    //
    // THE ARGUMENT BYTES DO NOT MOVE WITH IT. The venue is an ACCOUNT, so the
    // fixed vectors the preflight compares against are the same whichever venue
    // is passed — while venueData, which IS an argument, is carried verbatim.
    const other = await convertCall(program, { ...convertAccounts, venueProgram: JUPITER_V6_PROGRAM }, convertArgs).instruction();
    expect(convert.data.toString("hex")).toBe(other.data.toString("hex"));
    expect(convert.data.toString("hex")).toContain("c1209b3341d69c81deadbeef");
    expect(invest.data.toString("hex")).toContain("c1209b3341d69c81deadbeef");
  });

  it("no longer names a venue of its own at either money site, whatever else the file grows", () => {
    // The SHAPE of the fix, pinned in the source the way the ATA storm's is
    // above: the crank owns no authority, so the venue it sends has to be the
    // one the owner signed, read off the policy this tick already loaded.
    //
    // AND THE DEFAULT IS GONE, which this now pins too. There used to be two
    // `?? RAYDIUM_CLMM` fallbacks here for offline callers; a default naming a
    // venue the keeper refuses is worse than no default, so the argument is
    // required and the literal has left this file entirely.
    const source = readFileSync(new URL("../src/invest-tick.ts", import.meta.url), "utf8");
    expect(source).not.toContain("venueProgram: RAYDIUM_CLMM");
    expect(source).not.toContain("?? RAYDIUM_CLMM");
    expect(source.match(/venueProgram: policy\.venueProgram/g)).toHaveLength(2);
  });

  it("lead a REFUSED turn's detail with the conversion-off alarm, which these paths used to drop entirely", async () => {
    // A ZERO min_convert_rate_wad IS A VALID POLICY and is never refused — but
    // it silently switches off the SOL hop, so it is said on the way out of
    // EVERY turn. It used to be appended by `noted`, which some of the turn's
    // ways out call and the three basket refusals do not: this vault's SOL had
    // stopped moving and the detail talked only about the missing pool.
    const mint = key();
    let usdcAta: PublicKey | undefined;
    const { vault, connection, program } = chainWith({}, { minConvertRateWad: 0n, legs: [{ mint, weightBps: 10_000, minOutRateWad: 1n }] }, {
      getMinimumBalanceForRentExemption: async () => 2_000_000,
      getTokenAccountBalance: async (address) => {
        if (usdcAta === undefined || !(address as PublicKey).equals(usdcAta)) throw new Error("could not find account");
        return { context: { slot: 1 }, value: { amount: "250000000", decimals: 6, uiAmount: 250 } };
      },
    });
    usdcAta = getAssociatedTokenAddressSync(USDC_MINT, vault, true, TOKEN_PROGRAM_ID);
    const result = await runInvestTick({
      connection, program, vault, crank: TURN_CRANK, crankLamports: 10_000_000_000n, live: true, protocolPaused: false,
    });

    expect(result.outcome).toBe("REFUSED");
    // FIRST, not last: a truncated log line has to keep it.
    expect(result.detail.startsWith("CONVERSION IS OFF")).toBe(true);
    expect(result.detail).toContain("PYTH GUARD ON THAT HOP HAS NOTHING TO WATCH");
    // AND THE REFUSAL IT LEADS IS STILL ALL OF ITSELF. The refusal underneath
    // changed with the venue — there is no pool registry to be missing from any
    // more, so a leg the keeper knows nothing about is one whose MINT it cannot
    // read — but the alarm's job is the same either way: lead, whatever leads
    // after it.
    expect(result.detail).toContain(`${mint.toBase58()} has no readable mint account`);
    expect(result.detail).toContain("refusing to convert SOL toward it");
    // SAID ONCE. It was reported by `noted` and is now a turn finding; carrying
    // both would print the whole alarm twice in one line.
    expect(result.detail.match(/min_convert_rate_wad is 0/g)).toHaveLength(1);
  });

  it("no longer holds the call that sent a transaction per account, whatever else the file grows", () => {
    // The SHAPE of the fix, pinned in the source the way the wedge is in
    // measure-window.test.ts. createAssociatedTokenAccountIdempotent is the
    // ACTION: it builds a transaction and sends it, every call, and nothing
    // about its name says so. Its instruction is what belongs here.
    const source = readFileSync(new URL("../src/invest-tick.ts", import.meta.url), "utf8");
    expect(source).not.toContain("createAssociatedTokenAccountIdempotent(");
    expect(source).toContain("createAssociatedTokenAccountIdempotentInstruction(");
  });

  function linkTo(vault: PublicKey): ManagedLink {
    return { linkAddress: key(), wallet: key(), vault, epoch: 300_000_000n, settlementNonce: 0n, frontierSlot: 0n };
  }

  /** What a turn that reaches a settle reads before it would sign: a blockhash, the fee for its message, the wallet's balance and rent. 10 SOL covers any reserve here. */
  const pricedAndFunded: Readonly<Record<string, Handler>> = {
    getLatestBlockhash: async () => ({ blockhash: key().toBase58(), lastValidBlockHeight: 1_000 }),
    getFeeForMessage: async () => ({ context: { slot: 1 }, value: 10_000 }),
    getBalance: async () => 10_000_000_000,
    getMinimumBalanceForRentExemption: async () => 890_880,
  };

  it("rest a settle for a paused vault, or a paused protocol, on the sweep's vault read with no request of its own", async () => {
    for (const [vaultOver, protocolPaused, named] of [
      [{ paused: true }, false, "VaultPaused"],
      [{}, true, "ProtocolPaused"],
    ] as const) {
      const { vault, connection, program, calls } = chainWith(vaultOver, null);
      const read = await readVaults(program, [vault]);
      expect(calls.splice(0)).toEqual(["getMultipleAccountsInfoAndContext"]);
      const result = await runSettleTick({ settles: BOTH_MODES, connection, program, link: linkTo(vault), vault: read.get(vault.toBase58()) ?? null, attester: null, walletSigner: null, live: false, protocolPaused, carries: new Map() });
      expect(result.outcome).toBe("PAUSED");
      expect(result.detail).toContain(named);
      expect(calls).toEqual([]);
    }
  });

  it("walk a VOLUME vault in a dry run instead of stopping it: IDLE on the probe when nothing is newer than its start, with no blockhash read", async () => {
    const { vault, connection, program, calls } = chainWith({ skimMode: 1 }, null, {
      getSignaturesForAddress: async () => [{ signature: "link", slot: 300_000_000, err: null, memo: null }],
    });
    const read = await readVaults(program, [vault]);
    expect(calls.splice(0)).toEqual(["getMultipleAccountsInfoAndContext"]);
    const result = await runSettleTick({ settles: BOTH_MODES, connection, program, link: linkTo(vault), vault: read.get(vault.toBase58()) ?? null, attester: null, walletSigner: null, live: false, protocolPaused: false, carries: new Map() });
    expect(result).toEqual({ outcome: "IDLE", detail: "nothing since slot 300000000" });
    expect(calls).toEqual(["getSignaturesForAddress"]);
    expect(calls).not.toContain("getLatestBlockhash");
  });

  it("measure a VOLUME span with a successful trade, and rest it at UNSUPPORTED_MODE past the walk, before any deadline or blockhash", async () => {
    let ledger: FakeLedger | undefined;
    const { vault, connection, program, calls } = chainWith({ skimMode: 1 }, null, {
      getSignaturesForAddress: async (wallet, options, commitment) =>
        commitment === "confirmed"
          ? [{ signature: "trade-5", slot: 300_000_005, err: null, memo: null }]
          : ledger!.signatures(wallet as PublicKey, options as { limit: number }, commitment as Finality),
      getTransaction: async (signature, config) => ledger!.transaction(signature as string, (config as { commitment: Finality }).commitment),
      getSlot: async () => 300_000_100,
    });
    const link = linkTo(vault);
    ledger = new FakeLedger(
      link.wallet,
      chained(2_000_000_000, [
        { signature: "link-0", slot: 300_000_000, programs: ["11111111111111111111111111111111"], delta: -2_000_000 },
        { signature: "trade-5", slot: 300_000_005, programs: ["JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"], delta: 1_000_000_000 },
      ]),
    );
    const read = await readVaults(program, [vault]);
    calls.splice(0);
    const result = await runSettleTick({ settles: BOTH_MODES, connection, program, link, vault: read.get(vault.toBase58()) ?? null, attester: null, walletSigner: null, live: false, protocolPaused: false, carries: new Map() });
    expect(result).toEqual({ outcome: "UNSUPPORTED_MODE", detail: "1 successful trade(s) await keeper-medir-volumen; nothing attested" });
    expect(calls).toEqual(["getSignaturesForAddress", "getSlot", "getSignaturesForAddress", "getTransaction", "getTransaction"]);
  });

  it("describe a zero-base dry run in either mode: nothing moves at the mode's rate, and the frontier advances over the span", async () => {
    // 100 zero-lamport transfers the wallet signs itself, the fake ledger's
    // default signer, above the link's own transaction: a flat span with no trade
    // in it, at the zero-settle threshold.
    for (const [vaultOver, named] of [
      [{ skimMode: 0 }, "in PROFIT at 2345 bps"],
      [{ skimMode: 1 }, "in VOLUME at 37 bps"],
    ] as const) {
      let ledger: FakeLedger | undefined;
      const { vault, connection, program } = chainWith(vaultOver, null, {
        getSignaturesForAddress: async (wallet, options, commitment) =>
          commitment === "confirmed"
            ? [{ signature: "flow-100", slot: 300_000_100, err: null, memo: null }]
            : ledger!.signatures(wallet as PublicKey, options as { limit: number }, commitment as Finality),
        getTransaction: async (signature, config) => ledger!.transaction(signature as string, (config as { commitment: Finality }).commitment),
        getSlot: async (commitment) => (commitment === "finalized" ? 300_000_200 : 300_000_240),
        ...pricedAndFunded,
      });
      const link = linkTo(vault);
      ledger = new FakeLedger(
        link.wallet,
        chained(2_000_000_000, [
          { signature: "link-0", slot: 300_000_000, programs: ["11111111111111111111111111111111"], delta: -2_000_000 },
          ...Array.from({ length: 100 }, (_, i) => ({ signature: `flow-${i + 1}`, slot: 300_000_001 + i, programs: ["11111111111111111111111111111111"], delta: 0 })),
        ]),
      );
      const read = await readVaults(program, [vault]);
      const result = await runSettleTick({ settles: BOTH_MODES, connection, program, link, vault: read.get(vault.toBase58()) ?? null, attester: null, walletSigner: null, live: false, protocolPaused: false, carries: new Map() });
      expect(result).toMatchObject({ outcome: "SETTLED", baseLamports: 0n, mode: vaultOver.skimMode });
      expect(result.detail).toBe(`DRY RUN — would settle 0 lamports ${named} and advance the frontier from 300000000 to 300000100 over 100 txs`);
    }
  });

  it("fail a settle whose vault the sweep's read did not find, naming the address, with no request of its own", async () => {
    const { connection, program, calls } = chainWith({}, null);
    const missing = key();
    const read = await readVaults(program, [missing]);
    expect(read.get(missing.toBase58())).toBeNull();
    expect(calls.splice(0)).toEqual(["getMultipleAccountsInfoAndContext"]);
    // Live and with no signer: the missing vault is what gets reported, not NO_SIGNER.
    const result = await runSettleTick({ settles: BOTH_MODES, connection, program, link: linkTo(missing), vault: read.get(missing.toBase58()) ?? null, attester: null, walletSigner: null, live: true, protocolPaused: false, carries: new Map() });
    expect(result.outcome).toBe("FAILED");
    expect(result.detail).toContain("vault account missing");
    expect(result.detail).toContain(missing.toBase58());
    expect(calls).toEqual([]);
  });

  it("rest a PROFIT settle at IDLE on one confirmed probe when nothing is newer than its start, and walk nothing", async () => {
    // No signature at all, and only the link's own, at its epoch.
    for (const newest of [[], [{ signature: "link", slot: 300_000_000, err: null, memo: null }]]) {
      const { vault, connection, program, calls, callArgs } = chainWith({}, null, { getSignaturesForAddress: async () => newest });
      const read = await readVaults(program, [vault]);
      calls.splice(0);
      callArgs.splice(0);
      const link = linkTo(vault);
      const result = await runSettleTick({ settles: BOTH_MODES, connection, program, link, vault: read.get(vault.toBase58()) ?? null, attester: null, walletSigner: null, live: false, protocolPaused: false, carries: new Map() });
      expect(result).toEqual({ outcome: "IDLE", detail: "nothing since slot 300000000" });
      expect(calls).toEqual(["getSignaturesForAddress"]);
      expect(callArgs).toEqual([[link.wallet, { limit: 1 }, "confirmed"]]);
    }
  });

  it("read finality before a finalized walk, and rest at PENDING_FINALITY when that history does not reach a start not finalized yet", async () => {
    const { vault, connection, program, calls, callArgs } = chainWith({}, null, {
      getSignaturesForAddress: async (_wallet, _options, commitment) =>
        commitment === "confirmed" ? [{ signature: "trade", slot: 300_000_010, err: null, memo: null }] : [],
      getSlot: async () => 299_999_990,
    });
    const read = await readVaults(program, [vault]);
    calls.splice(0);
    callArgs.splice(0);
    const link = linkTo(vault);
    const result = await runSettleTick({ settles: BOTH_MODES, connection, program, link, vault: read.get(vault.toBase58()) ?? null, attester: null, walletSigner: null, live: false, protocolPaused: false, carries: new Map() });
    expect(result.outcome).toBe("PENDING_FINALITY");
    expect(calls).toEqual(["getSignaturesForAddress", "getSlot", "getSignaturesForAddress"]);
    expect(callArgs).toEqual([
      [link.wallet, { limit: 1 }, "confirmed"],
      ["finalized"],
      [link.wallet, { limit: 1_000 }, "finalized"],
    ]);
  });

  it("walk a finalized window through the connection, read the confirmed slot for the deadline only once it settles, then price the fee and check the reserve, in a dry run", async () => {
    let ledger: FakeLedger | undefined;
    const { vault, connection, program, calls, callArgs } = chainWith({}, null, {
      getSignaturesForAddress: async (wallet, options, commitment) =>
        commitment === "confirmed"
          ? [{ signature: "trade-5", slot: 300_000_005, err: null, memo: null }]
          : ledger!.signatures(wallet as PublicKey, options as { limit: number }, commitment as Finality),
      getTransaction: async (signature, config) => ledger!.transaction(signature as string, (config as { commitment: Finality }).commitment),
      getSlot: async (commitment) => (commitment === "finalized" ? 300_000_100 : 300_000_140),
      ...pricedAndFunded,
    });
    const link = linkTo(vault);
    ledger = new FakeLedger(
      link.wallet,
      chained(2_000_000_000, [
        // The link's own transaction at its epoch: the anchor the walk stops on.
        { signature: "link-0", slot: 300_000_000, programs: ["11111111111111111111111111111111"], delta: -2_000_000 },
        { signature: "trade-5", slot: 300_000_005, programs: ["JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"], delta: 1_000_000_000 },
      ]),
    );
    const read = await readVaults(program, [vault]);
    calls.splice(0);
    callArgs.splice(0);
    const result = await runSettleTick({ settles: BOTH_MODES, connection, program, link, vault: read.get(vault.toBase58()) ?? null, attester: null, walletSigner: null, live: false, protocolPaused: false, carries: new Map() });
    expect(result).toMatchObject({ outcome: "SETTLED", baseLamports: 1_000_000_000n, mode: 0, feeLamports: 10_000n, expectedLamports: 234_500_000n });
    // 1 SOL of profit at the planted 2 345 bps.
    expect(result.detail).toContain("DRY RUN — would settle 234500000 lamports");
    expect(result.detail).toContain("over slots 300000000..300000005");
    expect(calls).toEqual([
      "getSignaturesForAddress",
      "getSlot",
      "getSignaturesForAddress",
      "getTransaction",
      "getTransaction",
      "getSlot",
      "getLatestBlockhash",
      "getFeeForMessage",
      "getBalance",
      "getMinimumBalanceForRentExemption",
    ]);
    // THE VERSION THE READ ASKS FOR IS THE PACKAGE'S ONE ANSWER, not a literal
    // repeated here: `maxSupportedTransactionVersion: 0` refuses — with a THROW
    // — every transaction above version 0, which is what killed a whole walk at
    // its first versioned transaction (measure-window.test.ts).
    expect(callArgs.slice(3, 7)).toEqual([
      ["link-0", { maxSupportedTransactionVersion: MAX_SUPPORTED_TRANSACTION_VERSION, commitment: "finalized" }],
      ["trade-5", { maxSupportedTransactionVersion: MAX_SUPPORTED_TRANSACTION_VERSION, commitment: "finalized" }],
      ["confirmed"],
      ["confirmed"],
    ]);
    expect(MAX_SUPPORTED_TRANSACTION_VERSION).toBeGreaterThan(0);
    expect(callArgs[8]).toEqual([link.wallet, "confirmed"]);
  });

  // ── the jupiter-key cut: the measured unpaced turn, replayed through a real turn ──
  //
  // WHAT WAS MEASURED (test/fixtures/jupiter-turn-run2-apijup-unpaced.jsonl,
  // 2026-10-11, the owner's two-leg converting basket against the keyless
  // api.jup.ag): five calls answered 200 with x-ratelimit-remaining counting
  // 4, 3, 2, 1, 0, and the SIXTH, 0.85 s in, answered 429. The gate's convert
  // quote met the same wall, which in the keeper throws the gate: the whole
  // basket REFUSED. Every call after that was refused too.
  //
  // WHAT THESE PROVE, through runInvestTick over the stub chain and the stub
  // venue (nothing higher is faked): today's path reproduces that refusal call
  // for call; under the cut the same gateway answers every call of a turn
  // spaced at the plan's rate, a turn the minute cannot cover is DEFERRED
  // before its first call — nothing quoted, wrapped or sent — and a 429 holds
  // the next turn back instead of letting it spend another gate. And one the
  // replay cannot show on its own, because the keyless gate is refused before
  // the wrap: on a gateway wide enough to pass the gate, the unpaced turn
  // WRAPS and then fails at send time — the mid-basket failure the reservation
  // exists to prevent.
  describe("the jupiter-key cut, against the measured rate limiter", () => {
    /** The Jupiter requests of the measured turn, in the order they were made. */
    const measured = readFileSync(new URL("./fixtures/jupiter-turn-run2-apijup-unpaced.jsonl", import.meta.url), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { kind: string; status?: number | string; rl?: string; phase?: string })
      .filter((entry) => entry.kind === "jupiter");

    /** One request as the gateway saw it. */
    interface Seen {
      readonly at: number;
      readonly host: string;
      readonly path: string;
      readonly status: number;
      readonly key: string | null;
    }

    const refusedBody = () =>
      new Response(JSON.stringify({ code: 429, message: "[API Gateway] Too many requests" }), {
        status: 429,
        headers: { "Content-Type": "application/json", "x-ratelimit-remaining": "0" },
      });

    /**
     * A gateway in front of the venue stub: `answer` decides each request's fate
     * from what came before it, and an accepted one is served by stubJupiter.
     * Installed AFTER stubJupiter, over it.
     */
    function gateway(now: () => number, answer: (accepted: readonly number[], index: number, at: number) => boolean) {
      const venue = globalThis.fetch;
      const accepted: number[] = [];
      const seen: Seen[] = [];
      vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
        const at = now();
        const url = new URL(String(input));
        const key = new Headers(init?.headers).get("x-api-key");
        const ok = answer(accepted, seen.length, at);
        seen.push({ at, host: url.host, path: url.pathname, status: ok ? 200 : 429, key });
        if (!ok) return refusedBody();
        accepted.push(at);
        return venue(input as string, init);
      });
      return { seen, accepted };
    }

    /** The measured gateway, replayed: the n-th request gets the n-th recorded status, and anything past the recording is refused. */
    const replayed = (now: () => number) =>
      gateway(now, (_accepted, index) => (measured[index]?.status ?? 429) === 200);

    /** The measured SHAPE: five accepted per ten seconds (x-ratelimit-reset +10 s, api-keyless-probe.log), refused ones not counted. */
    const fivePerTen = (now: () => number, perWindow = 5) =>
      gateway(now, (accepted, _index, at) => accepted.filter((t) => t > at - 10_000).length < perWindow);

    /** A clock the pacer sleeps on: spacing advances it, real time does not. */
    function fakeClock(start = 1_791_760_456_000) {
      let now = start;
      return {
        now: () => now,
        advance: (ms: number) => {
          now += ms;
        },
        pacer: (perMinute: number) =>
          new JupiterPacer({
            perMinute,
            now: () => now,
            sleep: async (ms) => {
              now += ms;
            },
          }),
      };
    }

    /**
     * The owner's vault on 2026-10-09 (smallVault: two legs at 50/50 under a
     * $149 max_per_call, 0.0197 SOL free), on a chain that CONFIRMS what it is
     * sent — so a turn that is let through can buy, and every send is counted.
     */
    function buyingVault(basket: ReturnType<typeof basketOnChain>) {
      const crank = Keypair.generate();
      let sent = 0;
      let wsolAta: PublicKey | undefined;
      let usdcAta: PublicKey | undefined;
      const chain = smallVault(basket, {
        sendRawTransaction: async () => {
          sent += 1;
          return Keypair.generate().publicKey.toBase58();
        },
        confirmTransaction: async () => ({ context: { slot: 1 }, value: { err: null } }),
        getSlot: async () => 1,
        getTokenAccountBalance: async (address) => {
          const raw = (amount: bigint) => ({ context: { slot: 1 }, value: { amount: amount.toString(), decimals: 6, uiAmount: null } });
          if (wsolAta !== undefined && (address as PublicKey).equals(wsolAta) && sent >= 1) return raw(BigInt(SMALL_FREE));
          if (usdcAta !== undefined && (address as PublicKey).equals(usdcAta) && sent >= 2) return raw(2_000_000n);
          throw new Error("could not find account");
        },
      });
      wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, chain.vault, true, TOKEN_PROGRAM_ID);
      usdcAta = getAssociatedTokenAddressSync(USDC_MINT, chain.vault, true, TOKEN_PROGRAM_ID);
      const signing = async <T extends Transaction | VersionedTransaction>(tx: T): Promise<T> => tx;
      const program = new anchor.Program(
        idl,
        new anchor.AnchorProvider(
          chain.connection,
          { publicKey: crank.publicKey, signTransaction: signing, signAllTransactions: async (txs) => txs },
          { commitment: "confirmed" },
        ),
      );
      const deps = { connection: chain.connection, program, vault: chain.vault, crank, crankLamports: 10_000_000_000n, live: true, protocolPaused: false };
      return { deps, sent: () => sent };
    }

    const TEST_KEY = "jupiter-test-key-0000000001";

    it("REPLAYS the measured turn on today's path: 429 on call 6, the gate throws, the whole basket REFUSED, nothing sent", async () => {
      // THE RECORDING ITSELF, read rather than retyped.
      expect(measured.map((entry) => entry.status)).toEqual([200, 200, 200, 200, 200, 429, 429, 429, 429, 429]);
      expect(measured.map((entry) => entry.rl).slice(0, 5)).toEqual(["4", "3", "2", "1", "0"]);
      const basket = basketOnChain([DEEP_INVENTORY, DEEP_INVENTORY]);
      stubJupiter();
      const clock = fakeClock();
      const wire = replayed(clock.now);
      const vault = buyingVault(basket);

      const result = await runInvestTick(vault.deps);

      // CALL FOR CALL WHAT THE MEASUREMENT SAW: leg 0 measured (3), leg 1's
      // build (2) and its probe — the sixth call, refused, which ARM 2 takes as
      // an abstention — and then the convert's quote, refused, which throws the
      // gate.
      expect(wire.seen.map((s) => s.status)).toEqual([200, 200, 200, 200, 200, 429, 429]);
      expect(wire.seen.map((s) => s.path)).toEqual([
        "/swap/v1/quote", "/swap/v1/swap-instructions", "/swap/v1/quote",
        "/swap/v1/quote", "/swap/v1/swap-instructions", "/swap/v1/quote",
        "/swap/v1/quote",
      ]);
      expect(result.outcome).toBe("REFUSED");
      // THE DETAIL SAYS 429. In the measurement it could not: the error quoted
      // the 228-character URL first and summarizeUpstreamError's 200 characters
      // ended inside it. jupiterRefusal (jupiter-route.ts) leads with the status
      // and the path and puts the query last, so the status survives the cut
      // and the wire above and the detail now agree.
      expect(result.detail).toContain("could not be measured: Error: Jupiter answered HTTP 429 at lite-api.jup.ag/swap/v1/quote: ");
      expect(result.detail).toContain("refusing the whole basket");
      // BEFORE THE WRAP, as the doctrine says — but having spent seven calls of
      // an organisation's budget on a basket it then refused.
      expect(vault.sent()).toBe(0);
      // Today's host, keyless: no header was ever sent.
      expect(new Set(wire.seen.map((s) => s.host))).toEqual(new Set(["lite-api.jup.ag"]));
      expect(wire.seen.every((s) => s.key === null)).toBe(true);
    });

    it("under the cut, the same limiter answers all 18 calls of the turn — spaced, keyed, at api.jup.ag — and the basket is bought", async () => {
      const basket = basketOnChain([DEEP_INVENTORY, DEEP_INVENTORY]);
      stubJupiter();
      const clock = fakeClock();
      const wire = fivePerTen(clock.now);
      const pacer = clock.pacer(30);
      const vault = buyingVault(basket);

      const result = await runInvestTick({ ...vault.deps, jupiter: { baseUrl: KEYED_API, apiKey: new Secret(TEST_KEY, "jupiterApiKey"), pacer } });

      expect(result.outcome).toBe("INVESTED");
      // 6(L+1) at L = 2: the ADR's 18 calls per buy, unchanged by the cut.
      expect(wire.seen).toHaveLength(18);
      expect(wire.seen.every((s) => s.status === 200)).toBe(true);
      // J1: every request to the keyed host, every one carrying the key.
      expect(new Set(wire.seen.map((s) => s.host))).toEqual(new Set(["api.jup.ag"]));
      expect(wire.seen.every((s) => s.key === TEST_KEY)).toBe(true);
      // P8: two seconds apart, so no ten-second window ever held a sixth.
      const gaps = wire.seen.slice(1).map((s, i) => s.at - wire.seen[i]!.at);
      expect(Math.min(...gaps)).toBeGreaterThanOrEqual(2_000);
      // The wrap, the convert and one invest per leg.
      expect(vault.sent()).toBe(4);
      expect(pacer.status()).toMatchObject({ granted: 1, calls: 18, overdrawn: 0, http429: 0, reservedOutstanding: 0 });
    });

    it("DEFERS a second buying turn in the same minute BEFORE ITS FIRST CALL, where today's path starts it and is refused", async () => {
      const basket = basketOnChain([DEEP_INVENTORY, DEEP_INVENTORY]);
      stubJupiter();
      const clock = fakeClock();
      const wire = fivePerTen(clock.now);
      const pacer = clock.pacer(30);
      const jupiter = { baseUrl: KEYED_API, apiKey: new Secret(TEST_KEY, "jupiterApiKey"), pacer };

      expect((await runInvestTick({ ...buyingVault(basket).deps, jupiter })).outcome).toBe("INVESTED");
      const before = wire.seen.length;
      // ANOTHER VAULT'S TURN, the same sweep: 18 more would make 36 of 30 in one minute.
      const second = buyingVault(basket);
      const deferred = await runInvestTick({ ...second.deps, jupiter });
      expect(deferred.outcome).toBe("DEFERRED");
      expect(deferred.detail).toContain("needs 18 calls and 18 of this keeper's 30 a minute");
      expect(deferred.detail).toContain("nothing was quoted, wrapped or sent");
      expect(wire.seen.length - before).toBe(0);
      expect(second.sent()).toBe(0);
      expect(pacer.status().deferred).toEqual({ budget: 1, backoff: 0, neverFits: 0 });

      // TODAY'S PATH, the same turn at the same instant: it starts, and the
      // gateway refuses it — a request spent, a basket refused, a warning raised.
      const unpaced = await runInvestTick(buyingVault(basket).deps);
      expect(unpaced.outcome).toBe("REFUSED");
      expect(wire.seen.length - before).toBeGreaterThan(0);
      expect(wire.seen.slice(before).some((s) => s.status === 429)).toBe(true);

      // A MINUTE LATER the budget is back and the deferred vault buys.
      clock.advance(60_000);
      expect((await runInvestTick({ ...second.deps, jupiter })).outcome).toBe("INVESTED");
    });

    it("prevents the MID-BASKET failure: on a gateway wide enough for the gate, today's path WRAPS and then fails at send time", async () => {
      // TEN PER TEN SECONDS: the free key's burst as the ADR assumes it (open
      // question 10). The gate's nine calls fit; the send path's do not.
      const basket = basketOnChain([DEEP_INVENTORY, DEEP_INVENTORY]);
      stubJupiter();
      const clock = fakeClock();
      const wire = fivePerTen(clock.now, 10);
      const unpaced = buyingVault(basket);
      const result = await runInvestTick(unpaced.deps);
      expect(result.outcome).toBe("FAILED");
      expect(result.detail).toContain("429");
      // THE WRAP WENT OUT: the owner's SOL is wSOL now, and no basket was bought with it.
      expect(unpaced.sent()).toBe(1);
      expect(wire.seen.filter((s) => s.status === 429)).toHaveLength(1);

      // Under the cut, one call a second against the same gateway: all eighteen answered, the basket bought.
      clock.advance(60_000);
      const paced = buyingVault(basket);
      const pacer = clock.pacer(60);
      const bought = await runInvestTick({ ...paced.deps, jupiter: { baseUrl: KEYED_API, apiKey: new Secret(TEST_KEY, "jupiterApiKey"), pacer } });
      expect(bought.outcome).toBe("INVESTED");
      expect(paced.sent()).toBe(4);
      expect(pacer.status().http429).toBe(0);
    });

    it("backs off after a 429 it could not prevent: the refused turn's successor is DEFERRED with no request at all, then let through", async () => {
      // ANOTHER CONSUMER OF THE SAME ORGANISATION — the web, a script — has
      // just spent the gateway's window. The pacer cannot see it; the 429 says it.
      const basket = basketOnChain([DEEP_INVENTORY, DEEP_INVENTORY]);
      stubJupiter();
      const clock = fakeClock();
      const wire = fivePerTen(clock.now);
      for (let i = 0; i < 5; i++) wire.accepted.push(clock.now());
      const pacer = clock.pacer(30);
      const jupiter = { baseUrl: KEYED_API, apiKey: new Secret(TEST_KEY, "jupiterApiKey"), pacer };

      const refused = await runInvestTick({ ...buyingVault(basket).deps, jupiter });
      expect(refused.outcome).toBe("REFUSED");
      expect(refused.detail).toContain("could not be measured");
      // ONE request, refused: the gate stops at its first build that throws.
      expect(wire.seen.map((s) => s.status)).toEqual([429]);
      expect(pacer.status().http429).toBe(1);

      // THE NEXT SWEEP: deferred on the backoff, no request at all.
      clock.advance(30_000);
      const held = await runInvestTick({ ...buyingVault(basket).deps, jupiter });
      expect(held.outcome).toBe("DEFERRED");
      expect(held.detail).toContain("429 Too Many Requests");
      expect(wire.seen).toHaveLength(1);

      // Past the backoff, through — and bought.
      clock.advance(30_000);
      expect((await runInvestTick({ ...buyingVault(basket).deps, jupiter })).outcome).toBe("INVESTED");
      expect(pacer.status().deferred).toEqual({ budget: 0, backoff: 1, neverFits: 0 });
    });

    it("refuses a basket a dispatcher worker's share cannot cover, though the plan's minute could — with the remedy, nothing asked — where a deferral would starve it in silence", async () => {
      const basket = basketOnChain([DEEP_INVENTORY, DEEP_INVENTORY]);
      stubJupiter();
      const clock = fakeClock();
      const wire = fivePerTen(clock.now);
      // THE KEYLESS 30 A MINUTE OVER THE ADR'S r = 2: 15 each, under the owner's 18.
      const pacer = clock.pacer(30);
      pacer.retune(15);
      const jupiter = { baseUrl: LITE_API, apiKey: null, pacer };
      for (let sweep = 0; sweep < 3; sweep++) {
        const result = await runInvestTick({ ...buyingVault(basket).deps, jupiter });
        expect(result.outcome).toBe("REFUSED");
        expect(result.detail).toContain("needs 18 Jupiter calls per buying turn");
        expect(result.detail).toContain("this worker's share of the organisation's 30 a minute is 15 now");
        clock.advance(60_000);
      }
      expect(wire.seen).toHaveLength(0);
      // THE SAME WORKER, ITS SHARE BACK TO A BASKET'S WORTH: bought.
      pacer.retune(30);
      expect((await runInvestTick({ ...buyingVault(basket).deps, jupiter })).outcome).toBe("INVESTED");
    });

    it("refuses a basket the plan's minute can never cover — with the remedy — and asks Jupiter nothing", async () => {
      const basket = basketOnChain([DEEP_INVENTORY, DEEP_INVENTORY]);
      stubJupiter();
      const clock = fakeClock();
      const wire = fivePerTen(clock.now);
      const result = await runInvestTick({ ...buyingVault(basket).deps, jupiter: { baseUrl: LITE_API, apiKey: null, pacer: clock.pacer(12) } });
      expect(result.outcome).toBe("REFUSED");
      expect(result.detail).toContain("needs 18 Jupiter calls per buying turn");
      expect(result.detail).toContain("can never be bought at this budget");
      expect(wire.seen).toHaveLength(0);
    });

    it("releases the reservation on every way out — a FAILED turn included — so one bad turn cannot hold the budget for the life of the process", async () => {
      const basket = basketOnChain([DEEP_INVENTORY, DEEP_INVENTORY]);
      stubJupiter();
      const clock = fakeClock();
      fivePerTen(clock.now);
      const pacer = clock.pacer(30);
      const vault = buyingVault(basket);
      const exploding = new Proxy(vault.deps.connection, {
        get(target, prop) {
          if (prop === "getBalance") return async () => {
            throw new Error("the crank's balance could not be read");
          };
          return (target as unknown as Record<string | symbol, unknown>)[prop];
        },
      }) as Connection;
      const result = await runInvestTick({ ...vault.deps, connection: exploding, jupiter: { baseUrl: LITE_API, apiKey: null, pacer } });
      expect(result.outcome).toBe("FAILED");
      expect(pacer.status().reservedOutstanding).toBe(0);
    });
  });

  // ── the invest-batch cut: the snapshot decides only what sends nothing ──────
  //
  // THE CLAIM UNDER TEST (ADR §2.3.3, CUTS §3.3). The sweep's batch carries
  // every input of the at-rest half of a turn, so a turn that rests can be
  // decided from it with no request of its own; and a turn that would ACT is
  // never decided from it — runInvestTick throws that answer away and runs the
  // turn again on today's reads, so the requests it then makes and the bytes it
  // then sends are today's, one for one. Each case below runs the same chain
  // twice: once as today (no snapshot) and once from readSweepState's snapshot.
  describe("the invest-batch cut", () => {
    /** A classic SPL Token account owned by `vault`, holding `amount`: what a deposit leaves in its ATA. */
    function ataHolding(mint: PublicKey, vault: PublicKey, amount: bigint) {
      const data = Buffer.alloc(165);
      mint.toBuffer().copy(data, 0);
      vault.toBuffer().copy(data, 32);
      data.writeBigUInt64LE(amount, 64);
      return { data, owner: TOKEN_PROGRAM_ID };
    }

    /**
     * A chain whose vault holds `usdc` in its USDC ATA and `wsol` in its wSOL ATA,
     * both as ACCOUNTS (which the batch reads) and through getTokenAccountBalance
     * (which today's turn asks) — one truth, two readers.
     */
    function chainHolding(
      over: { readonly vault?: Partial<VaultFields>; readonly policy?: Partial<PolicyFields> | null; readonly usdc?: bigint; readonly wsol?: bigint; readonly feeds?: boolean },
      extra: Readonly<Record<string, Handler>> = {},
      more: Map<string, { readonly data: Buffer; readonly owner?: PublicKey }> = new Map(),
    ) {
      const vault = key();
      const balances = new Map<string, bigint>();
      if ((over.usdc ?? 0n) > 0n) {
        const ata = classicAta(USDC_MINT, vault);
        more.set(ata.toBase58(), ataHolding(USDC_MINT, vault, over.usdc!));
        balances.set(ata.toBase58(), over.usdc!);
      }
      if ((over.wsol ?? 0n) > 0n) {
        const ata = classicAta(NATIVE_MINT, vault);
        more.set(ata.toBase58(), ataHolding(NATIVE_MINT, vault, over.wsol!));
        balances.set(ata.toBase58(), over.wsol!);
      }
      const chain = chainWith(
        over.vault ?? {},
        over.policy === undefined ? {} : over.policy,
        {
          getMinimumBalanceForRentExemption: async () => 2_000_000,
          getTokenAccountBalance: async (address) => {
            const amount = balances.get((address as PublicKey).toBase58());
            if (amount === undefined) throw new Error("could not find account");
            return { context: { slot: 1 }, value: { amount: amount.toString(), decimals: 6, uiAmount: null } };
          },
          ...extra,
        },
        over.feeds ?? true,
        more,
        vault,
      );
      return { ...chain, balances };
    }

    /** The same turn, as today and from the batch: both answers, and what each asked the chain. */
    async function bothWays(chain: ReturnType<typeof chainHolding>, deps: Omit<Parameters<typeof runInvestTick>[0], "connection" | "program" | "vault">) {
      const base = { connection: chain.connection, program: chain.program, vault: chain.vault, ...deps };
      chain.calls.splice(0);
      const fresh = await runInvestTick(base);
      const freshCalls = chain.calls.splice(0);
      const state = await readSweepState(chain.connection, chain.program, [chain.vault]);
      expect(chain.calls.splice(0)).toEqual(["getMultipleAccountsInfo"]);
      const snapshot = state.invest.get(chain.vault.toBase58())!;
      const fromBatch = await runInvestTick({ ...base, snapshot });
      const batchCalls = chain.calls.splice(0);
      // A SECOND TURN ON THE SAME VAULT, as a second linked wallet's would be: the rent is cached now.
      const again = await runInvestTick({ ...base, snapshot });
      const againCalls = chain.calls.splice(0);
      return { fresh, freshCalls, fromBatch, batchCalls, again, againCalls };
    }

    const dry = { crank: null, crankLamports: 10_000_000_000n, live: false, protocolPaused: false } as const;

    it.each([
      ["NO_POLICY", { policy: null }, dry, "NO_POLICY"],
      ["investing switched off", { policy: { enabled: false } }, dry, "IDLE"],
      ["an in_mint this keeper cannot route", { policy: { inMint: Keypair.generate().publicKey } }, dry, "REFUSED"],
      ["the vault paused", { vault: { paused: true } }, dry, "PAUSED"],
      ["the protocol paused", {}, { ...dry, protocolPaused: true }, "PAUSED"],
      ["below the minimum, with conversion off", { usdc: 1_000_000n, policy: { minConvertRateWad: 0n } }, dry, "IDLE"],
      ["the crank too short to wrap", { usdc: 4_000_000n }, { ...dry, crankLamports: 1_000n }, "IDLE"],
      ["the oracle unreadable, so the SOL rests", { usdc: 4_000_000n, feeds: false }, dry, "IDLE"],
      ["a dry run that would wrap and invest", {}, dry, "INVESTED"],
      ["a dry run that would invest USDC already held", { usdc: 50_000_000n, policy: { minConvertRateWad: 0n } }, dry, "INVESTED"],
    ] as const)("decides %s exactly as today, from the batch alone", async (_name, over, deps, outcome) => {
      const chain = chainHolding(over as Parameters<typeof chainHolding>[0]);
      const run = await bothWays(chain, deps);
      expect(run.fresh.outcome).toBe(outcome);
      // THE SAME ANSWER, WORD FOR WORD — wrap report and fee notes included.
      const { reads, ...batchAnswer } = run.fromBatch;
      expect(batchAnswer).toEqual(run.fresh);
      expect(reads).toBe("snapshot");
      // TODAY IT ASKED THE CHAIN; FROM THE BATCH IT ASKED NOTHING but the rent floor, once for the connection.
      expect(run.freshCalls.length).toBeGreaterThan(0);
      expect(run.batchCalls.filter((call) => call !== "getMinimumBalanceForRentExemption")).toEqual([]);
      expect(run.batchCalls.length).toBeLessThanOrEqual(1);
      expect(run.againCalls).toEqual([]);
      expect(run.again.outcome).toBe(outcome);
    });

    it("never decides a FAILED from the batch: a vault the batch found missing is read again, and failed by today's reads", async () => {
      const chain = chainHolding({});
      const state = await readSweepState(chain.connection, chain.program, [chain.vault]);
      // The vault closes between the batch and the turn — or the batch simply did not have it.
      const snapshot = { ...state.invest.get(chain.vault.toBase58())!, vault: null };
      chain.calls.splice(0);
      const result = await runInvestTick({ connection: chain.connection, program: chain.program, vault: chain.vault, ...dry, snapshot });
      expect(result.reads).toBe("fresh");
      // Today's verdict, from today's reads: the chain still HAS the vault, so it is not "missing".
      expect(result.outcome).toBe("INVESTED");
      expect(chain.calls).toContain("getAccountInfoAndContext");
    });

    it("throws on a policy that does not decode, as today — never a NO_POLICY that says nothing", async () => {
      const chain = chainHolding({});
      const state = await readSweepState(chain.connection, chain.program, [chain.vault]);
      const snap = state.invest.get(chain.vault.toBase58())!;
      const broken = { ...snap, policy: { ...snap.policy!, data: Buffer.alloc(snap.policy!.data.length) } };
      await expect(runInvestTick({ connection: chain.connection, program: chain.program, vault: chain.vault, ...dry, snapshot: broken })).rejects.toThrow(/discriminator/);
    });

    it("refuses a snapshot that is another vault's, before reading anything from it", async () => {
      const a = chainHolding({});
      const b = chainHolding({});
      const state = await readSweepState(b.connection, b.program, [b.vault]);
      await expect(
        runInvestTick({ connection: a.connection, program: a.program, vault: a.vault, ...dry, snapshot: state.invest.get(b.vault.toBase58())! }),
      ).rejects.toThrow(/is vault .*'s/);
    });

    /**
     * A vault that will BUY: a two-leg basket, `usdc` already in its ATA and no
     * SOL free to wrap, on a chain that confirms what it is sent and records the
     * bytes — the blockhash fixed, so two runs sign the same message.
     */
    function buyingWith(usdc: bigint) {
      const basket = basketOnChain([DEEP_INVENTORY, DEEP_INVENTORY]);
      const crank = Keypair.fromSeed(new Uint8Array(32).fill(9));
      const raw: string[] = [];
      const chain = chainHolding(
        { usdc, policy: { legs: basket.legs, minConvertRateWad: 0n } },
        {
          // EVERY LAMPORT IS RENT, so nothing is free to wrap and only the deposit is bought.
          getMinimumBalanceForRentExemption: async () => 10_000_000_000,
          getBalance: async () => 10_000_000_000,
          getLatestBlockhash: async () => ({ blockhash: "3Nx5J6yqnGRrZ2mYqPSgDh1ZrmQnrgjSvJnBeCxMwGWk", lastValidBlockHeight: 1_000 }),
          sendRawTransaction: async (bytes) => {
            raw.push(Buffer.from(bytes as Uint8Array).toString("base64"));
            return Keypair.generate().publicKey.toBase58();
          },
          confirmTransaction: async () => ({ context: { slot: 1 }, value: { err: null } }),
          getSlot: async () => 1,
        },
        new Map(basket.accounts),
      );
      const signing = async <T extends Transaction | VersionedTransaction>(tx: T): Promise<T> => tx;
      const program = new anchor.Program(
        idl,
        new anchor.AnchorProvider(chain.connection, { publicKey: crank.publicKey, signTransaction: signing, signAllTransactions: async (txs) => txs }, { commitment: "confirmed" }),
      );
      const deps = { connection: chain.connection, program, vault: chain.vault, crank, crankLamports: 10_000_000_000n, live: true, protocolPaused: false };
      return { chain, deps, raw };
    }

    it("buys a MANUAL DEPOSIT with no settle at all: the batch sees the vault's own USDC, says act, and the turn buys on fresh reads", async () => {
      // THE TRAP IN MEMORY (keeper-user-ceiling-measured): skipping invest on a
      // vault whose settle rested would strand every deposit made by hand. The
      // snapshot holds the vault's OWN balances, not a verdict about the settle.
      const { urls } = stubJupiter();
      const { chain, deps, raw } = buyingWith(100_000_000n);
      const state = await readSweepState(chain.connection, deps.program, [chain.vault]);
      expect(state.invest.get(chain.vault.toBase58())!.usdcHeld).toBe(100_000_000n);
      const result = await runInvestTick({ ...deps, snapshot: state.invest.get(chain.vault.toBase58())! });
      expect(result.reads).toBe("fresh");
      expect(result.outcome).toBe("INVESTED");
      expect(result.purchases).toHaveLength(2);
      expect(raw).toHaveLength(2);
      expect(urls.length).toBeGreaterThan(0);
    });

    it("re-reads EVERYTHING fresh before it acts, and sends the same bytes, after the same requests, as today's turn", async () => {
      stubJupiter();
      const { chain, deps, raw } = buyingWith(100_000_000n);
      chain.calls.splice(0);
      const asToday = await runInvestTick(deps);
      const todayCalls = chain.calls.splice(0);
      const todayBytes = raw.splice(0);
      expect(asToday.outcome).toBe("INVESTED");
      expect(todayBytes).toHaveLength(2);

      // THE SAME VAULT ON THE SAME CHAIN, now led by the batch.
      const state = await readSweepState(chain.connection, deps.program, [chain.vault]);
      chain.calls.splice(0);
      const fromBatch = await runInvestTick({ ...deps, snapshot: state.invest.get(chain.vault.toBase58())! });
      const batchCalls = chain.calls.splice(0);

      expect(fromBatch.reads).toBe("fresh");
      expect(fromBatch.outcome).toBe("INVESTED");
      // THE REQUESTS: the snapshot pass asked for the rent floor once (its cache
      // is new to this connection) and nothing else; then the fresh turn made
      // EXACTLY today's requests, in today's order — the policy, the vault batch,
      // the rent, both balances, the leg mints, every venue read, the token
      // accounts, the tables, the blockhash, the sends.
      expect(batchCalls[0]).toBe("getMinimumBalanceForRentExemption");
      expect(batchCalls.slice(1)).toEqual(todayCalls);
      // THE BYTES: every transaction the batch-led turn sent is the one today's sent.
      expect(raw).toEqual(todayBytes);
      expect(fromBatch.purchases?.map((p) => p.spentRaw)).toEqual(asToday.purchases?.map((p) => p.spentRaw));
    });
  });

  // ── the explicit-send cut, through whole turns ──────────────────────────────
  //
  // L1d's three behaviours, each against today's path on the same chain: the
  // same four transactions for the same blockhash (wrap, convert, two legs);
  // isLive() asked per SEND, so a claim lost after the wrap sends no convert and
  // no leg — where today's turn, which asked once, sends all four; and no buy
  // at all inside the takeover quiet period, nothing quoted either.
  describe("the explicit-send cut", () => {
    /**
     * The owner's small converting vault (smallVault), on a chain that confirms
     * what it is sent — by websocket for Anchor, by status for the sender — and
     * records the bytes. The blockhash and the crank are fixed and the state is
     * resettable, so two runs on ONE chain sign the same messages.
     */
    function sendingVault() {
      const basket = basketOnChain([DEEP_INVENTORY, DEEP_INVENTORY]);
      const crank = Keypair.fromSeed(new Uint8Array(32).fill(4));
      const raw: string[] = [];
      let sent = 0;
      let wsolAta: PublicKey | undefined;
      let usdcAta: PublicKey | undefined;
      const chain = smallVault(basket, {
        getLatestBlockhash: async () => ({ blockhash: "3Nx5J6yqnGRrZ2mYqPSgDh1ZrmQnrgjSvJnBeCxMwGWk", lastValidBlockHeight: 1_000 }),
        sendRawTransaction: async (bytes) => {
          sent += 1;
          raw.push(Buffer.from(bytes as Uint8Array).toString("base64"));
          return `sig-${sent}`;
        },
        confirmTransaction: async () => ({ context: { slot: 1 }, value: { err: null } }),
        getSignatureStatuses: async () => ({ context: { slot: 1 }, value: [{ confirmationStatus: "confirmed", err: null, slot: 1, confirmations: 1 }] }),
        getBlockHeight: async () => 0,
        getSlot: async () => 1,
        getTokenAccountBalance: async (address) => {
          const amount = (value: bigint) => ({ context: { slot: 1 }, value: { amount: value.toString(), decimals: 6, uiAmount: null } });
          if (wsolAta !== undefined && (address as PublicKey).equals(wsolAta) && sent >= 1) return amount(BigInt(SMALL_FREE));
          if (usdcAta !== undefined && (address as PublicKey).equals(usdcAta) && sent >= 2) return amount(2_000_000n);
          throw new Error("could not find account");
        },
      });
      wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, chain.vault, true, TOKEN_PROGRAM_ID);
      usdcAta = getAssociatedTokenAddressSync(USDC_MINT, chain.vault, true, TOKEN_PROGRAM_ID);
      // THE KEEPER'S WALLET IS THE CRANK (bin/keeper.mts): it signs what it is handed, as anchor.Wallet does.
      const wallet = {
        publicKey: crank.publicKey,
        async signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T> {
          if ("partialSign" in tx) (tx as Transaction).partialSign(crank);
          else (tx as VersionedTransaction).sign([crank]);
          return tx;
        },
        async signAllTransactions<T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]> {
          return txs;
        },
      };
      const program = new anchor.Program(idl, new anchor.AnchorProvider(chain.connection, wallet, { commitment: "confirmed" }));
      const deps = { connection: chain.connection, program, vault: chain.vault, crank, crankLamports: 10_000_000_000n, live: true, protocolPaused: false };
      /** A sender on a clock the test owns, already past its quiet period unless asked otherwise. */
      const sender = (isLive: () => boolean, options: { quiet?: boolean } = {}) => {
        let now = 1_000_000;
        const made = new CrankSender({ connection: chain.connection, wallet, isLive, now: () => now, sleep: async (ms) => void (now += ms) });
        if (options.quiet !== true) now += QUIET_AFTER_TAKEOVER_MS;
        return { sender: made, advance: (ms: number) => void (now += ms) };
      };
      return { chain, deps, raw, sender, reset: () => ((sent = 0), raw.splice(0)) };
    }

    it("sends the wrap, the convert and both legs as the very bytes today's turn sends, for the same blockhash", async () => {
      stubJupiter();
      const vault = sendingVault();
      const today = await runInvestTick(vault.deps);
      const todayBytes = [...vault.raw];
      expect(today.outcome).toBe("INVESTED");
      expect(todayBytes).toHaveLength(4);

      vault.reset();
      const { sender } = vault.sender(() => true);
      const explicit = await runInvestTick({ ...vault.deps, sender });
      expect(explicit.outcome).toBe("INVESTED");
      expect(vault.raw).toEqual(todayBytes);
      expect(explicit.purchases?.map((p) => p.spentRaw)).toEqual(today.purchases?.map((p) => p.spentRaw));
      // CONFIRMED BY POLLING, NEVER BY THE WEBSOCKET: no confirmTransaction on the explicit run.
      expect(sender.status()).toMatchObject({ sent: 4, landed: 4, refused: { notLive: 0, quiet: 0, draining: 0 } });
    });

    it("asks isLive() before EACH send: a claim lost after the wrap sends no convert and no leg — today's turn sends all four", async () => {
      stubJupiter();
      const vault = sendingVault();
      // TODAY: keysForTurn asked once, at the top of the turn, and nothing asks
      // again — whatever happens to the claim after that, all four go out.
      const today = await runInvestTick(vault.deps);
      expect(today.outcome).toBe("INVESTED");
      expect(vault.raw).toHaveLength(4);

      vault.reset();
      let live = true;
      // The claim goes the moment the wrap's bytes have left.
      const wrapThenLose = new Proxy(vault.deps.connection, {
        get(target, prop) {
          const value = (target as unknown as Record<string | symbol, unknown>)[prop];
          if (prop !== "sendRawTransaction") return value;
          return async (...args: unknown[]) => {
            const signature = await (value as (...a: unknown[]) => Promise<string>)(...args);
            live = false;
            return signature;
          };
        },
      }) as Connection;
      const lostSender = new CrankSender({ connection: wrapThenLose, wallet: (vault.deps.program.provider as anchor.AnchorProvider).wallet, isLive: () => live, quietMs: 0 });
      const result = await runInvestTick({ ...vault.deps, sender: lostSender });
      expect(vault.raw).toHaveLength(1);
      expect(result.outcome).toBe("FAILED");
      expect(result.detail).toContain("no longer holds the claim");
      expect(result.purchases).toBeUndefined();
      expect(lostSender.status()).toMatchObject({ sent: 1, landed: 1, refused: { notLive: 1 } });
    });

    it("buys NOTHING inside the takeover quiet period — nothing quoted, wrapped or sent — and buys once it is over", async () => {
      const { urls } = stubJupiter();
      const vault = sendingVault();
      const { sender, advance } = vault.sender(() => true, { quiet: true });
      const held = await runInvestTick({ ...vault.deps, sender });
      expect(held.outcome).toBe("DEFERRED");
      expect(held.detail).toContain("the takeover quiet period");
      expect(held.detail).toContain("settles go as usual");
      expect(urls).toHaveLength(0);
      expect(vault.raw).toHaveLength(0);

      advance(QUIET_AFTER_TAKEOVER_MS);
      const bought = await runInvestTick({ ...vault.deps, sender });
      expect(bought.outcome).toBe("INVESTED");
      expect(vault.raw).toHaveLength(4);
    });

    it("starts no buy while draining after SIGTERM", async () => {
      const { urls } = stubJupiter();
      const vault = sendingVault();
      const { sender } = vault.sender(() => true);
      sender.beginDrain();
      const held = await runInvestTick({ ...vault.deps, sender });
      expect(held.outcome).toBe("DEFERRED");
      expect(held.detail).toContain("draining after SIGTERM");
      expect(urls).toHaveLength(0);
      expect(vault.raw).toHaveLength(0);
    });

    // ── the dispatcher's fenced sender: the same sender plus the job's gate (src/fenced-sender.ts) ──
    //
    // A worker hands runInvestTick a CrankSender whose gate is its job's fence.
    // Through a WHOLE turn: the four transactions are today's bytes, and each one
    // left only after its intent row was committed — wrap, convert, then each leg.
    /** The vault claimed by a worker in the store model, and that job's fence. */
    async function fenced(chainVault: PublicKey, mayAct: () => string | null = () => null) {
      const db = new MemoryDb();
      db.addVault(chainVault.toBase58());
      const store = new MemoryDispatchStore(db, "worker-a");
      const [claimed] = await store.claim(1);
      const fence = new JobFence({ store, vault: chainVault.toBase58(), fence: claimed!.fence, planClearedHeight: null, programId, confirmedHeight: async () => 0n, mayAct });
      return { db, store, fence };
    }

    it("the fenced sender: today's four transactions, byte for byte, each gated — wrap, convert, leg, leg — before it leaves", async () => {
      stubJupiter();
      const vault = sendingVault();
      const today = await runInvestTick(vault.deps);
      const todayBytes = [...vault.raw];
      expect(today.outcome).toBe("INVESTED");

      vault.reset();
      const job = await fenced(vault.deps.vault);
      const wallet = (vault.deps.program.provider as anchor.AnchorProvider).wallet;
      const rowsAtSend: number[] = [];
      const watched = new Proxy(vault.deps.connection, {
        get(target, prop) {
          const value = (target as unknown as Record<string | symbol, unknown>)[prop];
          if (prop !== "sendRawTransaction") return value;
          return async (...args: unknown[]) => (rowsAtSend.push(job.db.intents.length), (value as (...a: unknown[]) => Promise<string>)(...args));
        },
      }) as Connection;
      const sender = new CrankSender({ connection: watched, wallet, isLive: () => true, quietMs: 0, gate: job.fence.crankGate() });
      const result = await runInvestTick({ ...vault.deps, sender });
      expect(result.outcome).toBe("INVESTED");
      expect(vault.raw).toEqual(todayBytes);
      expect(rowsAtSend).toEqual([1, 2, 3, 4]);
      expect(job.db.intents.map((row) => row.kind)).toEqual(["wrap", "convert", "invest", "invest"]);
      expect(job.db.intents.every((row) => row.fence === 1n && row.signature !== null)).toBe(true);
      // THE TWO LEGS LANDED AND WAIT FOR THEIR HISTORY ROWS (the job's outbox); the wrap and the convert are resolved.
      await job.fence.settled();
      expect(job.db.intents.map((row) => row.state)).toEqual(["landed", "landed", "intent", "intent"]);
      expect(job.fence.landedAwaitingHistory()).toHaveLength(2);
    });

    it("the fenced sender: a lease lost after the wrap — the convert is signed, refused at the gate, and nothing after it is sent", async () => {
      stubJupiter();
      const vault = sendingVault();
      const job = await fenced(vault.deps.vault);
      const wallet = (vault.deps.program.provider as anchor.AnchorProvider).wallet;
      // ANOTHER WORKER TAKES THE VAULT the moment the wrap's bytes have left.
      const takeover = new Proxy(vault.deps.connection, {
        get(target, prop) {
          const value = (target as unknown as Record<string | symbol, unknown>)[prop];
          if (prop !== "sendRawTransaction") return value;
          return async (...args: unknown[]) => {
            const signature = await (value as (...a: unknown[]) => Promise<string>)(...args);
            const row = job.db.vaults.get(vault.deps.vault.toBase58())!;
            row.holder = "worker-b";
            row.fence += 1n;
            return signature;
          };
        },
      }) as Connection;
      const sender = new CrankSender({ connection: takeover, wallet, isLive: () => true, quietMs: 0, gate: job.fence.crankGate() });
      const result = await runInvestTick({ ...vault.deps, sender });
      expect(vault.raw).toHaveLength(1);
      expect(result.outcome).toBe("FAILED");
      expect(result.detail).toContain("the dispatcher's fence refused this convert");
      expect(job.db.gateCalls.map((call) => [call.draft.kind, call.answer])).toEqual([
        ["wrap", "gated"],
        ["convert", "refused"],
      ]);
      expect(job.fence.lostReason).not.toBeNull();
    });
  });
});
