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
  Connection,
  Keypair,
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  SystemProgram,
  type Finality,
  type Transaction,
  type VersionedTransaction,
} from "@solana/web3.js";
import { describe, expect, it } from "vitest";
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
import { RAYDIUM_CLMM_PROGRAM, USDC_MINT } from "../src/invest-decision.js";
import { convertCall, investCall, runInvestTick } from "../src/invest-tick.js";
import { MAX_SUPPORTED_TRANSACTION_VERSION } from "../src/measure-window.js";
import {
  PYTH_RECEIVER_PROGRAM,
  PYTH_SOL_USD_FEED,
  PYTH_SOL_USD_FEED_ID_HEX,
  PYTH_USDC_USD_FEED,
  PYTH_USDC_USD_FEED_ID_HEX,
} from "../src/pyth.js";
import { runSettleTick } from "../src/settle-tick.js";
import { FakeLedger, chained } from "./fake-ledger.js";

const programId = new PublicKey(idl.address);
const key = (): PublicKey => Keypair.generate().publicKey;

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

/** The Clock sysvar: 40 bytes, unix_timestamp an i64 at byte 32, after four fields that must not be read as it. */
function clockBytes(unixTimestamp: bigint): Buffer {
  const buf = Buffer.alloc(40);
  buf.writeBigUInt64LE(400_000_000n, 0); // slot
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
  const wallet = { publicKey: PublicKey.default, signTransaction: refuse, signAllTransactions: refuse };
  const program = new anchor.Program(idl, new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" }));
  return { program, connection, calls, callArgs };
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
  // THE VENUE EVERY POLICY SIGNED TO DATE NAMES. It was a random key here, which
  // no reader looked at and every tick ignored — the keeper passed the Raydium
  // literal whatever the policy said. Now that the tick refuses a venue it
  // cannot route, a random key would refuse every turn below before the gate
  // each of those tests is actually about. The reader's own test overrides it
  // with a random key, which is where reading arbitrary bytes at offset 41
  // belongs.
  venueProgram: RAYDIUM_CLMM_PROGRAM,
  inMint: USDC_MINT,
  legs: [
    { mint: key(), weightBps: 6_000, minOutRateWad: 3n * 10n ** 18n + (1n << 70n) },
    { mint: key(), weightBps: 4_000, minOutRateWad: 17n },
  ],
  minConvertRateWad: (1n << 64n) + 12_345n,
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
    const planted = policyFields(vault, { venueProgram: key() });
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
  function chainWith(
    vaultOver: Partial<VaultFields>,
    policyOver: Partial<PolicyFields> | null,
    extra: Readonly<Record<string, Handler>> = {},
    /** False leaves the chain with no Pyth accounts at all, as a receiver outage would. */
    feeds = true,
    /** Anything else the turn reads off the chain: leg mints, their pools, and the pools' vaults. */
    more: ReadonlyMap<string, { readonly data: Buffer; readonly owner?: PublicKey }> = new Map(),
  ) {
    const vault = key();
    const accounts = new Map([
      [vault.toBase58(), vaultBytes(vaultFields(vaultOver))],
      [SYSVAR_CLOCK_PUBKEY.toBase58(), clockBytes(TODAY_UNIX)],
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

  const pools = new Map<string, PublicKey>();

  it("refuse a non-USDC in_mint in a dry run after reading the policy and nothing else", async () => {
    const inMint = key();
    const { vault, connection, program, calls } = chainWith({}, { inMint });
    const result = await runInvestTick({ connection, program, vault, crank: null, crankLamports: null, pools, live: false, protocolPaused: false });
    expect(result.outcome).toBe("REFUSED");
    expect(result.detail).toContain(inMint.toBase58());
    expect(result.detail).toContain(USDC_MINT.toBase58());
    expect(calls).toEqual(["getAccountInfoAndContext"]);
  });

  it("rest a paused vault's investment before any balance, ATA or wrap", async () => {
    const { vault, connection, program, calls } = chainWith({ paused: true }, {});
    const result = await runInvestTick({ connection, program, vault, crank: null, crankLamports: null, pools, live: false, protocolPaused: false });
    expect(result.outcome).toBe("PAUSED");
    expect(result.detail).toContain("VaultPaused");
    expect(calls).toEqual(["getAccountInfoAndContext", "getMultipleAccountsInfo"]);
  });

  it("rest every investment while the protocol is paused", async () => {
    const { vault, connection, program, calls } = chainWith({}, {});
    const result = await runInvestTick({ connection, program, vault, crank: null, crankLamports: null, pools, live: false, protocolPaused: true });
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
    const result = await runInvestTick({ connection, program, vault, crank: null, crankLamports: 20_000_000_000n, pools, live: false, protocolPaused: false });
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
    const result = await runInvestTick({ connection, program, vault, crank: null, crankLamports: 300_000_000n, pools, live: false, protocolPaused: false });
    expect(result.outcome).toBe("INVESTED");
    expect(result.detail).toContain("would wrap 280000000");
    expect(result.detail).not.toContain("9998000000");
    expect(result.wrap).toEqual({ free: 9_998_000_000n, allowance: 280_000_000n, wrapped: 280_000_000n, short: true });

    // A balance the snapshot could not read fronts nothing: the turn rests, and says why.
    const unread = await runInvestTick({ connection, program, vault, crank: null, crankLamports: null, pools, live: false, protocolPaused: false });
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
    const result = await runInvestTick({ connection, program, vault, crank: null, crankLamports: 20_000_000_000n, pools, live: false, protocolPaused: false });
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
    const result = await runInvestTick({ connection, program, vault, crank: Keypair.generate(), crankLamports: null, pools: legPools, live: true, protocolPaused: false });
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
    const result = await runInvestTick({ connection, program, vault, crank: null, crankLamports: null, pools, live: false, protocolPaused: false });
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
    const result = await runInvestTick({ connection, program, vault, crank: Keypair.generate(), crankLamports: 10_000_000_000n, pools: legPools, live: true, protocolPaused: false });
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
  const DRAINED_USDC = 31_910_000n;
  const DRAINED_STOCK = 110_274_669n;
  const LIVE_USDC = 9_389_405_679n;
  const LIVE_STOCK = 1_163_416_179n;

  /** A Token-2022 mint with no extensions: the 82-byte base and AccountType::Mint, which charges nothing. */
  function plainMintBytes(): Buffer {
    const data = Buffer.alloc(83);
    data.fill(0xab, 0, 82);
    data.writeUInt8(1, 82);
    return data;
  }

  /** A Raydium CLMM PoolState as mainnet serves one: 1544 bytes, the pair at 73 and 105, the vaults at 137 and 169. */
  function poolBytes(mint0: PublicKey, mint1: PublicKey, vault0: PublicKey, vault1: PublicKey): Buffer {
    const data = Buffer.alloc(1_544);
    data.fill(0xcd, 0, 73);
    mint0.toBuffer().copy(data, 73);
    mint1.toBuffer().copy(data, 105);
    vault0.toBuffer().copy(data, 137);
    vault1.toBuffer().copy(data, 169);
    return data;
  }

  /** An SPL Token account: the balance is a u64 at 64. */
  function tokenAccountBytes(amount: bigint): Buffer {
    const data = Buffer.alloc(165);
    data.writeBigUInt64LE(amount, 64);
    return data;
  }

  /**
   * A three-leg basket as the chain holds it: a mint, a pool and the pool's two
   * vaults per leg, at the weights of the live basket.
   */
  function basketOnChain(reserves: readonly (readonly [bigint, bigint])[]) {
    const accounts = new Map<string, { data: Buffer; owner?: PublicKey }>();
    const legs = reserves.map(([usdcReserve, stock], index) => {
      const mint = key();
      const pool = key();
      const usdcVault = key();
      const stockVault = key();
      accounts.set(mint.toBase58(), { data: plainMintBytes(), owner: TOKEN_2022_PROGRAM_ID });
      accounts.set(pool.toBase58(), { data: poolBytes(USDC_MINT, mint, usdcVault, stockVault) });
      accounts.set(usdcVault.toBase58(), { data: tokenAccountBytes(usdcReserve) });
      accounts.set(stockVault.toBase58(), { data: tokenAccountBytes(stock) });
      return { mint, pool, weightBps: [4_000, 3_300, 2_700][index]!, minOutRateWad: 1n };
    });
    return {
      accounts,
      legs: legs.map((leg) => ({ mint: leg.mint, weightBps: leg.weightBps, minOutRateWad: leg.minOutRateWad })),
      pools: new Map(legs.map((leg) => [leg.mint.toBase58(), leg.pool] as const)),
      mints: legs.map((leg) => leg.mint),
      addresses: legs.map((leg) => leg.pool),
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
    const basket = basketOnChain([[LIVE_USDC, LIVE_STOCK], [DRAINED_USDC, DRAINED_STOCK], [LIVE_USDC, LIVE_STOCK]]);
    const { vault, connection, program, calls, callArgs } = chainWith({}, { legs: basket.legs }, emptyAndPriced, true, basket.accounts);
    const result = await runInvestTick({
      connection, program, vault, crank: Keypair.generate(), crankLamports: 10_000_000_000n, pools: basket.pools, live: true, protocolPaused: false,
    });

    expect(result.outcome).toBe("REFUSED");
    // THE AMOUNT TESTED IS THE ONE THIS TURN WOULD REALLY SPEND: max_per_call
    // (250 USDC) caps the BASKET and is split by weight, so the 3,300 bps leg
    // gets 82.5 USDC — not the 5-dollar default purchase, and not the whole cap.
    expect(result.detail).toContain("holds 31910000 in-asset raw against the 82500000 this turn would push into it");
    expect(result.detail).toContain("0.4x cover, under the 50x this keeper trades on (it would need 4125000000)");
    expect(result.detail).toContain(basket.mints[1]!.toBase58());
    expect(result.detail).toContain("refusing the whole basket of 3 leg(s), the deep ones included");
    expect(result.detail).toContain("refusing to convert SOL toward it");
    for (const index of [0, 2]) expect(result.detail).not.toContain(basket.mints[index]!.toBase58());

    // NOTHING MOVED, AND ALMOST NOTHING WAS ASKED FOR. The pool states ride the
    // request the mint gate was already sending — no extra round trip — and the
    // reserves inside them cost exactly one more, for the whole basket.
    expect(calls).toEqual([
      "getAccountInfoAndContext",
      "getMultipleAccountsInfo",
      "getMinimumBalanceForRentExemption",
      "getTokenAccountBalance",
      "getTokenAccountBalance",
      "getMultipleAccountsInfo",
      "getMultipleAccountsInfo",
    ]);
    expect(callArgs[5]![0]).toEqual([...basket.mints, ...basket.addresses]);
    expect((callArgs[6]![0] as PublicKey[]).length, "six vaults for three legs, in one request").toBe(6);
    for (const rpc of ["getBalance", "getAccountInfo", "sendTransaction", "getSignaturesForAddress"]) expect(calls).not.toContain(rpc);
    expect(result.wrap?.wrapped).toBe(0n);
  });

  it("let a deep basket through the gate and go on to the turn's own arithmetic", async () => {
    // The same three legs, none of them drained, and conversion switched off so
    // the money this turn can spend is exactly the 12 USDC the vault holds: 4.80
    // to the heaviest leg, under the 5 USDC invest.rs requires of every call.
    // Reaching that refusal at all is the proof the depth gate passed.
    const basket = basketOnChain([[LIVE_USDC, LIVE_STOCK], [LIVE_USDC, LIVE_STOCK], [LIVE_USDC, LIVE_STOCK]]);
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
      connection, program, vault, crank: Keypair.generate(), crankLamports: 10_000_000_000n, pools: basket.pools, live: true, protocolPaused: false,
    });

    expect(result.outcome).toBe("IDLE");
    expect(result.detail).toContain("$12.00 across 3 legs is $4.80-ish each, under the $5.00 per-call minimum");
    expect(result.detail).toContain("min_convert_rate_wad is 0");
    // A RESTING TURN IS TESTED AT WHAT IT HOLDS, NOT AT THE CAP. Had the gate
    // used max_per_call here it would have measured 100 USDC against pools this
    // vault was never going to push more than 4.80 into.
    expect(calls).toEqual([
      "getAccountInfoAndContext",
      "getMultipleAccountsInfo",
      "getMinimumBalanceForRentExemption",
      "getTokenAccountBalance",
      "getTokenAccountBalance",
      "getMultipleAccountsInfo",
      "getMultipleAccountsInfo",
      "getTokenAccountBalance",
    ]);
    for (const rpc of ["getBalance", "sendTransaction"]) expect(calls).not.toContain(rpc);
  });

  it("refuse a leg routed through a pool that is not its pair, which no build-time check can see change", async () => {
    // The registry maps a mint to a pool by configuration. Nothing before this
    // gate asks the pool what it actually trades, so a stale entry sends the
    // vault's money into a stranger's market at the weights of this one.
    const basket = basketOnChain([[LIVE_USDC, LIVE_STOCK], [LIVE_USDC, LIVE_STOCK], [LIVE_USDC, LIVE_STOCK]]);
    const strangerVaults = [key(), key()];
    basket.accounts.set(basket.addresses[0]!.toBase58(), {
      data: poolBytes(USDC_MINT, key(), strangerVaults[0]!, strangerVaults[1]!),
    });
    for (const address of strangerVaults) basket.accounts.set(address.toBase58(), { data: tokenAccountBytes(LIVE_USDC) });
    const { vault, connection, program } = chainWith({}, { legs: basket.legs }, emptyAndPriced, true, basket.accounts);
    const result = await runInvestTick({
      connection, program, vault, crank: Keypair.generate(), crankLamports: 10_000_000_000n, pools: basket.pools, live: true, protocolPaused: false,
    });
    expect(result.outcome).toBe("REFUSED");
    expect(result.detail).toContain("is not this leg's pair");
    expect(result.detail).toContain(basket.mints[0]!.toBase58());
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

  it("reads every token account it might need in ONE request, and creates the missing one INSIDE the transaction that uses it", async () => {
    const basket = basketOnChain([[LIVE_USDC, LIVE_STOCK], [LIVE_USDC, LIVE_STOCK], [LIVE_USDC, LIVE_STOCK]]);
    const crank = Keypair.generate();
    const { vault, connection, calls, callArgs } = chainWith({}, { legs: basket.legs }, convertingAndFunded, true, basket.accounts);
    const { signed, program } = capturing(connection);
    const result = await runInvestTick({
      connection, program, vault, crank, crankLamports: 10_000_000_000n, pools: basket.pools, live: true, protocolPaused: false,
    });

    // The turn dies where the stub refuses to sign — past the point this test is about.
    expect(result.outcome).toBe("FAILED");

    const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, vault, true, TOKEN_PROGRAM_ID);
    const usdcAta = getAssociatedTokenAddressSync(USDC_MINT, vault, true, TOKEN_PROGRAM_ID);
    const legAtas = basket.mints.map((mint) => getAssociatedTokenAddressSync(mint, vault, true, TOKEN_2022_PROGRAM_ID));

    // ONE REQUEST, NAMING EVERY CANDIDATE: the vault's wSOL account, its USDC
    // account and every leg's target, in one getMultipleAccountsInfo — not one
    // read, and not one transaction, per account.
    const reads = calls.flatMap((name, index) => (name === "getMultipleAccountsInfo" ? [callArgs[index]![0] as PublicKey[]] : []));
    expect(reads).toHaveLength(4);
    expect(reads[3]).toEqual([wsolAta, usdcAta, ...legAtas]);

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
    for (const rpc of ["sendTransaction", "sendRawTransaction", "getAccountInfo"]) expect(calls).not.toContain(rpc);

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

  it("creates nothing for an account that already exists: the same turn sends the wrap alone", async () => {
    const basket = basketOnChain([[LIVE_USDC, LIVE_STOCK], [LIVE_USDC, LIVE_STOCK], [LIVE_USDC, LIVE_STOCK]]);
    const crank = Keypair.generate();
    // The vault's wSOL account is on the chain this time. Everything else about
    // the turn is identical, so the only thing the assertions can be reading is
    // the account's existence.
    const chain = chainWith({}, { legs: basket.legs }, convertingAndFunded, true, basket.accounts);
    const connection = withAccountPresent(chain.connection, getAssociatedTokenAddressSync(NATIVE_MINT, chain.vault, true, TOKEN_PROGRAM_ID));
    const { signed, program } = capturing(connection);
    const result = await runInvestTick({
      connection, program, vault: chain.vault, crank, crankLamports: 10_000_000_000n, pools: basket.pools, live: true, protocolPaused: false,
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
    // the only thing this turn can do is buy: 250 USDC, three legs, deep pools,
    // and a pool whose history holds no swap at all.
    const basket = basketOnChain([[LIVE_USDC, LIVE_STOCK], [LIVE_USDC, LIVE_STOCK], [LIVE_USDC, LIVE_STOCK]]);
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
      connection, program, vault, crank: Keypair.generate(), crankLamports: 10_000_000_000n, pools: basket.pools, live: true, protocolPaused: false,
    });

    expect(result.outcome).toBe("FAILED");
    expect(result.detail).toContain("not Raydium CLMM");
    expect(result.purchases).toBeUndefined();
    // Three reads, and they are the ones that were there before this fix: the
    // vault + Clock + feeds, the leg mints + pools, and the pools' vaults. The
    // candidate token accounts were never read, because no account was ever
    // going to be created for a leg that has nowhere to trade.
    expect(calls.filter((name) => name === "getMultipleAccountsInfo")).toHaveLength(3);
    // ZERO, not one, and that is STRICTER than it was. The route used to be
    // found by walking a pool's signatures for a recent swap_v2; it now comes
    // from the pool's own account, so a signature walk here would be a
    // regression to the read that took 52-72 s and died on a versioned
    // transaction. Pinning 0 keeps it gone.
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
    const basket = basketOnChain([[LIVE_USDC, LIVE_STOCK], [LIVE_USDC, LIVE_STOCK], [LIVE_USDC, LIVE_STOCK]]);
    const venue = key();
    const { vault, connection, program, calls } = chainWith({}, { legs: basket.legs, venueProgram: venue }, emptyAndPriced, true, basket.accounts);
    const result = await runInvestTick({
      connection, program, vault, crank: Keypair.generate(), crankLamports: 10_000_000_000n, pools: basket.pools, live: true, protocolPaused: false,
    });

    expect(result.outcome).toBe("REFUSED");
    // WHAT A READER AT 3AM NEEDS: which venue was asked for, which one the
    // keeper can actually route, what the program would have answered, and who
    // can change it.
    expect(result.detail).toContain(venue.toBase58());
    expect(result.detail).toContain("Raydium CLMM");
    expect(result.detail).toContain(RAYDIUM_CLMM_PROGRAM.toBase58());
    expect(result.detail).toContain("WrongVenue");
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

  it("hand convert and invest the venue the POLICY names, at the account the program checks", async () => {
    const { program } = stubChain(new Map());
    const zero = PublicKey.default;
    const venue = key();
    const swap = { payer: zero, inputTokenAccount: zero, outputTokenAccount: zero, amountIn: 100n, minAmountOut: 200n };
    const convertAccounts = { crank: zero, vault: zero, policy: zero, vaultWsol: zero, vaultIn: zero };
    const investAccounts = { crank: zero, vault: zero, policy: zero, vaultIn: zero, vaultTarget: zero, targetMint: zero };
    const convertArgs = { amountIn: 100n, minOut: 200n, swap };
    const investArgs = { legIndex: 0, amountIn: 100n, minOut: 200n, swap };

    const convert = await convertCall(program, { ...convertAccounts, venueProgram: venue }, convertArgs).instruction();
    const invest = await investCall(program, { ...investAccounts, venueProgram: venue }, investArgs).instruction();
    // venue_program is the LAST account of both instructions in the IDL, and
    // these calls carry no remaining accounts.
    expect(convert.keys.at(-1)?.pubkey.toBase58()).toBe(venue.toBase58());
    expect(invest.keys.at(-1)?.pubkey.toBase58()).toBe(venue.toBase58());

    // LEFT OUT, IT IS WHAT IT ALWAYS WAS. The preflight and the builder vectors
    // call these offline, with fabricated accounts and no policy to read a venue
    // from, so the argument is optional and defaults to the literal the keeper
    // used to hardcode. Every caller that HAS a policy passes it.
    const convertDefault = await convertCall(program, convertAccounts, convertArgs).instruction();
    const investDefault = await investCall(program, investAccounts, investArgs).instruction();
    expect(convertDefault.keys.at(-1)?.pubkey.toBase58()).toBe(RAYDIUM_CLMM_PROGRAM.toBase58());
    expect(investDefault.keys.at(-1)?.pubkey.toBase58()).toBe(RAYDIUM_CLMM_PROGRAM.toBase58());

    // AND THE ARGUMENT BYTES DID NOT MOVE. The venue is an ACCOUNT, not an
    // argument, so the fixed vectors the preflight compares against — and the
    // bytes anything else builds — are the same whichever venue is passed.
    expect(convert.data.toString("hex")).toBe(convertDefault.data.toString("hex"));
    expect(invest.data.toString("hex")).toBe(investDefault.data.toString("hex"));
  });

  it("no longer names a venue of its own at either money site, whatever else the file grows", () => {
    // The SHAPE of the fix, pinned in the source the way the ATA storm's is
    // above: the crank owns no authority, so the venue it sends has to be the
    // one the owner signed, read off the policy this tick already loaded. The
    // literal survives in exactly one place — the default for offline callers
    // with no policy in hand.
    const source = readFileSync(new URL("../src/invest-tick.ts", import.meta.url), "utf8");
    expect(source).not.toContain("venueProgram: RAYDIUM_CLMM");
    expect(source.match(/venueProgram: accounts\.venueProgram \?\? RAYDIUM_CLMM/g)).toHaveLength(2);
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
      connection, program, vault, crank: Keypair.generate(), crankLamports: 10_000_000_000n, pools: new Map(), live: true, protocolPaused: false,
    });

    expect(result.outcome).toBe("REFUSED");
    // FIRST, not last: a truncated log line has to keep it.
    expect(result.detail.startsWith("CONVERSION IS OFF")).toBe(true);
    expect(result.detail).toContain("PYTH GUARD ON THAT HOP HAS NOTHING TO WATCH");
    // And the refusal it leads is still all of itself.
    expect(result.detail).toContain(`no pool configured for ${mint.toBase58()}`);
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
      const result = await runSettleTick({ connection, program, link: linkTo(vault), vault: read.get(vault.toBase58()) ?? null, attester: null, walletSigner: null, live: false, protocolPaused, carries: new Map() });
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
    const result = await runSettleTick({ connection, program, link: linkTo(vault), vault: read.get(vault.toBase58()) ?? null, attester: null, walletSigner: null, live: false, protocolPaused: false, carries: new Map() });
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
    const result = await runSettleTick({ connection, program, link, vault: read.get(vault.toBase58()) ?? null, attester: null, walletSigner: null, live: false, protocolPaused: false, carries: new Map() });
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
      const result = await runSettleTick({ connection, program, link, vault: read.get(vault.toBase58()) ?? null, attester: null, walletSigner: null, live: false, protocolPaused: false, carries: new Map() });
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
    const result = await runSettleTick({ connection, program, link: linkTo(missing), vault: read.get(missing.toBase58()) ?? null, attester: null, walletSigner: null, live: true, protocolPaused: false, carries: new Map() });
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
      const result = await runSettleTick({ connection, program, link, vault: read.get(vault.toBase58()) ?? null, attester: null, walletSigner: null, live: false, protocolPaused: false, carries: new Map() });
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
    const result = await runSettleTick({ connection, program, link, vault: read.get(vault.toBase58()) ?? null, attester: null, walletSigner: null, live: false, protocolPaused: false, carries: new Map() });
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
    const result = await runSettleTick({ connection, program, link, vault: read.get(vault.toBase58()) ?? null, attester: null, walletSigner: null, live: false, protocolPaused: false, carries: new Map() });
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
});
