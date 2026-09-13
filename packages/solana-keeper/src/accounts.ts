// sip-vault's accounts, decoded through the IDL into plain values.
//
// THE CAST LIVES HERE AND NOWHERE ELSE. The generic Program<Idl> has no typed
// account namespace; the runtime one does. Nuvem's keeper reached it with a
// narrow cast at every call site and then carried `any` through the invest
// arithmetic. Here each account is read once into an interface with bigints,
// so a field renamed in the program fails in one reader, not as NaN in a basket
// split.
//
// EVERY FIELD IS TAKEN BY THE NAME ANCHOR GIVES IT, THROUGH ONE CHECKED READER.
// `new Program(idl)` camelCases every IDL name, and its camelcase uppercases a
// letter that follows a digit: state.rs's `max_rolling_30d` decodes as
// `maxRolling30D`, not `maxRolling30d`. This file once guessed the second
// spelling behind an `as {...}` cast, tsc could not see through the cast, and
// every vault with a policy threw `undefined.toString()` before its in_mint was
// ever checked — dry run and live alike. A missing field now fails naming the
// account and the field, and test/accounts.test.ts decodes hand-built accounts
// laid out byte for byte as state.rs declares them.

import type * as anchor from "@coral-xyz/anchor";
import { PublicKey, type PublicKeyInitData } from "@solana/web3.js";

interface AccountClient {
  fetch(address: PublicKey): Promise<unknown>;
  fetchNullable(address: PublicKey): Promise<unknown>;
}

function client(program: anchor.Program, name: string): AccountClient {
  const namespace = program.account as unknown as Record<string, AccountClient | undefined>;
  const found = namespace[name];
  if (found === undefined) throw new Error(`the IDL behind this Program has no ${name} account`);
  return found;
}

/** Typed, checked access to one decoded account's fields. */
function fields(account: string, decoded: unknown) {
  if (decoded === null || typeof decoded !== "object") {
    throw new Error(`${account} did not decode to an object`);
  }
  const raw = decoded as Readonly<Record<string, unknown>>;
  const get = (name: string): unknown => {
    const value = raw[name];
    if (value === undefined || value === null) {
      throw new Error(`${account}.${name} is missing from the decoded account — this reader and the IDL's field names have drifted`);
    }
    return value;
  };
  return {
    key: (name: string): PublicKey => new PublicKey(get(name) as PublicKeyInitData),
    flag: (name: string): boolean => {
      const value = get(name);
      if (typeof value !== "boolean") throw new Error(`${account}.${name} decoded as ${typeof value}, not a boolean`);
      return value;
    },
    /** u8 and u16, which Anchor decodes as JS numbers. */
    small: (name: string): number => {
      const value = Number(get(name));
      if (!Number.isInteger(value)) throw new Error(`${account}.${name} did not decode to an integer`);
      return value;
    },
    /** u64 and u128, which Anchor decodes as BN; its toString() is base 10. */
    big: (name: string): bigint => BigInt(String(get(name))),
    list: (name: string): readonly unknown[] => {
      const value = get(name);
      if (!Array.isArray(value)) throw new Error(`${account}.${name} did not decode to a list`);
      return value;
    },
  };
}

/** One user's vault (state.rs Vault), as settle reads it. */
export interface VaultState {
  readonly owner: PublicKey;
  readonly paused: boolean;
  /** 0 PROFIT, 1 VOLUME. */
  readonly skimMode: number;
  /** The PROFIT rate, 101..=10_000. */
  readonly skimBps: number;
  /** The VOLUME rate, 1..=100. */
  readonly volumeBps: number;
  /** Bumped on every set_policy_v2 and signed into every attestation. */
  readonly policyNonce: bigint;
  readonly maxContribution: bigint;
  readonly walletReserve: bigint;
}

function vaultState(decoded: unknown): VaultState {
  const f = fields("Vault", decoded);
  return {
    owner: f.key("owner"),
    paused: f.flag("paused"),
    skimMode: f.small("skimMode"),
    skimBps: f.small("skimBps"),
    volumeBps: f.small("volumeBps"),
    policyNonce: f.big("policyNonce"),
    maxContribution: f.big("maxContribution"),
    walletReserve: f.big("walletReserve"),
  };
}

export async function readVault(program: anchor.Program, address: PublicKey): Promise<VaultState> {
  return vaultState(await client(program, "vault").fetch(address));
}

/**
 * A vault from account data already in hand. The invest tick reads the vault
 * account for its lamports anyway; decoding that same read gives it the pause
 * switch without a second request.
 */
export function decodeVault(program: anchor.Program, data: Buffer): VaultState {
  return vaultState(program.coder.accounts.decode("vault", data));
}

/** The deployment's ProtocolConfig (state.rs), the source of truth for who attests and who cranks. */
export interface ProtocolConfigState {
  readonly address: PublicKey;
  readonly authority: PublicKey;
  readonly attester: PublicKey;
  /** The default pubkey means NOBODY may crank, not anybody (state.rs). */
  readonly keeper: PublicKey;
  readonly pendingAuthority: PublicKey;
  readonly paused: boolean;
  readonly version: number;
}

export function configAddress(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("config")], programId)[0];
}

/** Null when the PDA does not exist: a program not deployed, or init_config never run. */
export async function readProtocolConfig(program: anchor.Program): Promise<ProtocolConfigState | null> {
  const address = configAddress(program.programId);
  const decoded = await client(program, "protocolConfig").fetchNullable(address);
  if (decoded === null) return null;
  const f = fields("ProtocolConfig", decoded);
  return {
    address,
    authority: f.key("authority"),
    attester: f.key("attester"),
    keeper: f.key("keeper"),
    pendingAuthority: f.key("pendingAuthority"),
    paused: f.flag("paused"),
    version: f.small("version"),
  };
}

export interface InvestmentLegState {
  readonly mint: PublicKey;
  readonly weightBps: number;
  readonly minOutRateWad: bigint;
}

/** A vault's InvestmentPolicy (state.rs), every floor and cap in units of `inMint`. */
export interface InvestmentPolicyState {
  readonly address: PublicKey;
  readonly enabled: boolean;
  readonly venueProgram: PublicKey;
  readonly inMint: PublicKey;
  readonly legs: readonly InvestmentLegState[];
  readonly minConvertRateWad: bigint;
  readonly minInvestment: bigint;
  readonly maxPerCall: bigint;
  readonly maxRolling30d: bigint;
}

export function investmentPolicyAddress(programId: PublicKey, vault: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("invest"), vault.toBuffer()], programId)[0];
}

/** Null when the owner has not chosen a basket: a vault with no policy account cannot invest. */
export async function readInvestmentPolicy(program: anchor.Program, vault: PublicKey): Promise<InvestmentPolicyState | null> {
  const address = investmentPolicyAddress(program.programId, vault);
  const decoded = await client(program, "investmentPolicy").fetchNullable(address);
  if (decoded === null) return null;
  const f = fields("InvestmentPolicy", decoded);
  return {
    address,
    enabled: f.flag("enabled"),
    venueProgram: f.key("venueProgram"),
    inMint: f.key("inMint"),
    legs: f.list("legs").map((leg, index) => {
      const l = fields(`InvestmentPolicy.legs[${index}]`, leg);
      return { mint: l.key("mint"), weightBps: l.small("weightBps"), minOutRateWad: l.big("minOutRateWad") };
    }),
    minConvertRateWad: f.big("minConvertRateWad"),
    minInvestment: f.big("minInvestment"),
    maxPerCall: f.big("maxPerCall"),
    // `maxRolling30D`, with the capital D: see the header.
    maxRolling30d: f.big("maxRolling30D"),
  };
}
