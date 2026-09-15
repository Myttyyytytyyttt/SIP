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
import { Connection, Keypair, PublicKey, type Finality } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import {
  configAddress,
  decodeVault,
  investmentPolicyAddress,
  readInvestmentPolicy,
  readProtocolConfig,
  readVault,
  readVaults,
} from "../src/accounts.js";
import type { ManagedLink } from "../src/discovery.js";
import { accountDiscriminator, idl } from "../src/idl.js";
import { USDC_MINT } from "../src/invest-decision.js";
import { runInvestTick } from "../src/invest-tick.js";
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
  for (let day = 0; day < 31; day++) buf.writeUInt32LE(20_000 + day, at + 4 * day); // bucket_days
  at += 124;
  for (let day = 0; day < 31; day++) buf.writeBigUInt64LE(BigInt(1_000 + day), at + 8 * day); // bucket_amounts
  at += 248;
  buf.writeBigUInt64LE(777n, at); // lifetime_invested
  at += 8;
  buf.writeBigUInt64LE(9n, at); // policy_nonce
  at += 8;
  buf.writeUInt8(251, at); // bump
  return buf;
}

type Handler = (...args: unknown[]) => unknown;

/** A Program over a stub chain that serves `accounts` and records every RPC method called, with its arguments. */
function stubChain(accounts: ReadonlyMap<string, Buffer>, extra: Readonly<Record<string, Handler>> = {}) {
  const calls: string[] = [];
  const callArgs: unknown[][] = [];
  const info = (address: unknown) => {
    const data = accounts.get((address as PublicKey).toBase58());
    return data === undefined ? null : { data, executable: false, lamports: 10_000_000_000, owner: programId, rentEpoch: 0 };
  };
  const served: Record<string, Handler> = {
    getAccountInfoAndContext: async (address) => ({ context: { slot: 1 }, value: info(address) }),
    getAccountInfo: async (address) => info(address),
    getMultipleAccountsInfoAndContext: async (addresses) => ({ context: { slot: 1 }, value: (addresses as PublicKey[]).map(info) }),
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
    });

    expect(await readInvestmentPolicy(stubChain(new Map()).program, vault)).toBeNull();
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
    const accounts = new Map([[vault.toBase58(), vaultBytes(vaultFields(vaultOver))]]);
    if (policyOver !== null) accounts.set(investmentPolicyAddress(programId, vault).toBase58(), policyBytes(policyFields(vault, policyOver)));
    return { vault, ...stubChain(accounts, extra) };
  }

  const pools = new Map<string, PublicKey>();

  it("refuse a non-USDC in_mint in a dry run after reading the policy and nothing else", async () => {
    const inMint = key();
    const { vault, connection, program, calls } = chainWith({}, { inMint });
    const result = await runInvestTick({ connection, program, vault, crank: null, pools, live: false, protocolPaused: false });
    expect(result.outcome).toBe("REFUSED");
    expect(result.detail).toContain(inMint.toBase58());
    expect(result.detail).toContain(USDC_MINT.toBase58());
    expect(calls).toEqual(["getAccountInfoAndContext"]);
  });

  it("rest a paused vault's investment before any balance, ATA or wrap", async () => {
    const { vault, connection, program, calls } = chainWith({ paused: true }, {});
    const result = await runInvestTick({ connection, program, vault, crank: null, pools, live: false, protocolPaused: false });
    expect(result.outcome).toBe("PAUSED");
    expect(result.detail).toContain("VaultPaused");
    expect(calls).toEqual(["getAccountInfoAndContext", "getAccountInfo"]);
  });

  it("rest every investment while the protocol is paused", async () => {
    const { vault, connection, program, calls } = chainWith({}, {});
    const result = await runInvestTick({ connection, program, vault, crank: null, pools, live: false, protocolPaused: true });
    expect(result.outcome).toBe("PAUSED");
    expect(result.detail).toContain("ProtocolPaused");
    expect(calls).toEqual(["getAccountInfoAndContext", "getAccountInfo"]);
  });

  it("go on past the switches when nothing is paused", async () => {
    const { vault, connection, program, calls } = chainWith({}, {}, {
      getMinimumBalanceForRentExemption: async () => 2_000_000,
      getTokenAccountBalance: async () => {
        throw new Error("could not find account");
      },
    });
    const result = await runInvestTick({ connection, program, vault, crank: null, pools, live: false, protocolPaused: false });
    expect(result.outcome).toBe("INVESTED");
    expect(result.detail).toContain("DRY RUN");
    expect(calls).toContain("getMinimumBalanceForRentExemption");
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
    const result = await runInvestTick({ connection, program, vault, crank: Keypair.generate(), pools: legPools, live: true, protocolPaused: false });
    expect(result.outcome).toBe("IDLE");
    expect(result.detail).toContain("0 USDC, below the policy minimum");
    expect(result.detail).toContain("min_convert_rate_wad is 0");
    expect(calls).toEqual([
      "getAccountInfoAndContext",
      "getAccountInfo",
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
    const result = await runInvestTick({ connection, program, vault, crank: null, pools, live: false, protocolPaused: false });
    expect(result.outcome).toBe("INVESTED");
    expect(result.detail).toContain("DRY RUN — would invest the 7000000 USDC already in the vault");
    expect(result.detail).not.toContain("would wrap");
    expect(result.detail).toContain("min_convert_rate_wad is 0");
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
      const result = await runSettleTick({ connection, program, link: linkTo(vault), vault: read.get(vault.toBase58()) ?? null, attester: null, walletSigner: null, live: false, protocolPaused });
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
    const result = await runSettleTick({ connection, program, link: linkTo(vault), vault: read.get(vault.toBase58()) ?? null, attester: null, walletSigner: null, live: false, protocolPaused: false });
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
    const result = await runSettleTick({ connection, program, link, vault: read.get(vault.toBase58()) ?? null, attester: null, walletSigner: null, live: false, protocolPaused: false });
    expect(result).toEqual({ outcome: "UNSUPPORTED_MODE", detail: "1 successful trade(s) await keeper-medir-volumen; nothing attested" });
    expect(calls).toEqual(["getSignaturesForAddress", "getSlot", "getSignaturesForAddress", "getTransaction", "getTransaction"]);
  });

  it("describe a zero-base dry run in either mode: nothing moves at the mode's rate, and the frontier advances over the span", async () => {
    // 100 zero-lamport transfers above the link's own transaction: a flat span
    // with no trade in it, at the zero-settle threshold.
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
      const result = await runSettleTick({ connection, program, link, vault: read.get(vault.toBase58()) ?? null, attester: null, walletSigner: null, live: false, protocolPaused: false });
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
    const result = await runSettleTick({ connection, program, link: linkTo(missing), vault: read.get(missing.toBase58()) ?? null, attester: null, walletSigner: null, live: true, protocolPaused: false });
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
      const result = await runSettleTick({ connection, program, link, vault: read.get(vault.toBase58()) ?? null, attester: null, walletSigner: null, live: false, protocolPaused: false });
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
    const result = await runSettleTick({ connection, program, link, vault: read.get(vault.toBase58()) ?? null, attester: null, walletSigner: null, live: false, protocolPaused: false });
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
    const result = await runSettleTick({ connection, program, link, vault: read.get(vault.toBase58()) ?? null, attester: null, walletSigner: null, live: false, protocolPaused: false });
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
    expect(callArgs.slice(3, 7)).toEqual([
      ["link-0", { maxSupportedTransactionVersion: 0, commitment: "finalized" }],
      ["trade-5", { maxSupportedTransactionVersion: 0, commitment: "finalized" }],
      ["confirmed"],
      ["confirmed"],
    ]);
    expect(callArgs[8]).toEqual([link.wallet, "confirmed"]);
  });
});
