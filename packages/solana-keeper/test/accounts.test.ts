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

import * as anchor from "@coral-xyz/anchor";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Connection, Keypair, PublicKey, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import {
  configAddress,
  decodeVault,
  investmentPolicyAddress,
  readInvestmentPolicy,
  readProtocolConfig,
  readVault,
} from "../src/accounts.js";
import type { ManagedLink } from "../src/discovery.js";
import { accountDiscriminator, idl } from "../src/idl.js";
import { USDC_MINT } from "../src/invest-decision.js";
import { runInvestTick } from "../src/invest-tick.js";
import { runSettleTick } from "../src/settle-tick.js";

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

type Handler = (...args: unknown[]) => unknown;

/** A Program over a stub chain that serves `accounts` and records every RPC method called. */
function stubChain(accounts: ReadonlyMap<string, Buffer>, extra: Readonly<Record<string, Handler>> = {}) {
  const calls: string[] = [];
  const info = (address: unknown) => {
    const data = accounts.get((address as PublicKey).toBase58());
    return data === undefined ? null : { data, executable: false, lamports: 10_000_000_000, owner: programId, rentEpoch: 0 };
  };
  const served: Record<string, Handler> = {
    getAccountInfoAndContext: async (address) => ({ context: { slot: 1 }, value: info(address) }),
    getAccountInfo: async (address) => info(address),
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
  return { program, connection, calls };
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
  venueProgram: key(),
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
    const planted = policyFields(vault);
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
  function chainWith(vaultOver: Partial<VaultFields>, policyOver: Partial<PolicyFields> | null, extra: Readonly<Record<string, Handler>> = {}) {
    const vault = key();
    const accounts = new Map([
      [vault.toBase58(), vaultBytes(vaultFields(vaultOver))],
      [SYSVAR_CLOCK_PUBKEY.toBase58(), clockBytes(TODAY_UNIX)],
    ]);
    if (policyOver !== null) accounts.set(investmentPolicyAddress(programId, vault).toBase58(), policyBytes(policyFields(vault, policyOver)));
    return { vault, ...stubChain(accounts, extra) };
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

  function linkTo(vault: PublicKey): ManagedLink {
    return { linkAddress: key(), wallet: key(), vault, epoch: 300_000_000n, settlementNonce: 0n, frontierSlot: 0n };
  }

  it("rest a settle for a paused vault, or a paused protocol, after reading the vault alone", async () => {
    for (const [vaultOver, protocolPaused, named] of [
      [{ paused: true }, false, "VaultPaused"],
      [{}, true, "ProtocolPaused"],
    ] as const) {
      const { vault, connection, program, calls } = chainWith(vaultOver, null);
      const result = await runSettleTick({ connection, program, link: linkTo(vault), attester: null, walletSigner: null, live: false, protocolPaused });
      expect(result.outcome).toBe("PAUSED");
      expect(result.detail).toContain(named);
      expect(calls).toEqual(["getAccountInfoAndContext"]);
    }
  });

  it("stop a VOLUME vault at UNSUPPORTED_MODE after reading the vault alone", async () => {
    const { vault, connection, program, calls } = chainWith({ skimMode: 1 }, null);
    const result = await runSettleTick({ connection, program, link: linkTo(vault), attester: null, walletSigner: null, live: false, protocolPaused: false });
    expect(result.outcome).toBe("UNSUPPORTED_MODE");
    expect(calls).toEqual(["getAccountInfoAndContext"]);
  });
});
