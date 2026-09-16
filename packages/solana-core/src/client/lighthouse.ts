// Phantom's Lighthouse checks: the only instructions SaverFi relays that it did
// not build. Browser-safe and pure.
//
// WHY THIS EXISTS. On mainnet Phantom signs a transaction and returns another
// one: it "may be augmented with Lighthouse assertion instructions"
// (docs.phantom.com/developer-powertools/lighthouse). Each asks the Lighthouse
// program to check that an account ended up the way Phantom's own simulation
// showed, and fails the whole transaction otherwise. The browser's check of
// Phantom's bytes (website-oficial src/lib/tx-intent.ts) and the relay's verifier
// (server/verify-tx.ts, rule 8c) both accept them through checkWalletGuards, and
// accept nothing else SaverFi did not build, so the two cannot drift.
//
// WHAT IS ACCEPTED, all of it or the whole transaction is refused:
//   1  the program is exactly LIGHTHOUSE_PROGRAM, read-only and never a signer
//   2  every Lighthouse instruction stands after ALL of SaverFi's own: never
//      before or between the compute budget, the consent's Ed25519SigVerify and
//      link_wallet (the program reads the consent at link_wallet's index − 1,
//      ed25519_introspection.rs), or the vault's token-account creations and
//      set_invest_policy
//   3  at most MAX_WALLET_GUARDS of them
//   4  each is AssertAccountInfoMulti (6) or AssertTokenAccountMulti (10), at a
//      log level that calls no program, holding 1 to MAX_GUARD_ASSERTIONS
//      assertions that decode exactly, every byte consumed (the program itself
//      ignores trailing bytes; this does not)
//   5  each names exactly one account, and SaverFi's own instructions name it
//   6  the message holds no key but the ones SaverFi's own instructions name and
//      Lighthouse's, and every key keeps the signer and writable flags those
//      instructions give it
//
// WHAT IS REFUSED, from the program's source (lighthouse 2.0.0,
// github.com/Jac0xb/lighthouse programs/lighthouse/src/instruction.rs; the
// deployed program's ProgramData has no upgrade authority, so this set cannot
// change under it):
//   0  MemoryWrite              creates or grows a memory account, rent paid by a signer
//   1  MemoryClose              moves a memory account's lamports
//   4  AssertAccountDelta       compares against a MemoryWrite snapshot
//   16 AssertMerkleTreeAccount  calls the account-compression program
//   log levels 3 and 6          call the SPL Noop program
//   2, 3, 5, 7-9, 11-15, 17     read-only, but never seen from Phantom: added on evidence only
//
// WHAT PHANTOM WAS SEEN ADDING (mainnet, read-only RPC, September 2026): kinds
// 6 and 10 only, at log level 4, each naming one account the dapp's own
// instructions name (the fee payer's lamports, owner and data length; a token
// account's amount, delegate and derivation), 1 to 6 per transaction, the
// Lighthouse program the only new key, and the dapp's compute budget untouched.
// In a few transactions Phantom also put checks right after the compute budget,
// before the dapp's first instruction: rule 2 refuses those, by the owner's
// decision, and says where the check stood.

import { LIGHTHOUSE_PROGRAM } from "./addresses";
import type { KeyPrivileges } from "./message";

/** Lighthouse's AssertAccountInfoMulti: lamports, owner, data length, flags or a data hash of one account. */
export const LIGHTHOUSE_ASSERT_ACCOUNT_INFO_MULTI = 6;
/** Lighthouse's AssertTokenAccountMulti: mint, owner, amount, delegate, state or derivation of one token account. */
export const LIGHTHOUSE_ASSERT_TOKEN_ACCOUNT_MULTI = 10;

/**
 * Lighthouse instructions relayed in one transaction. Phantom was seen adding 1
 * to 6 (most often 1 or 2; at most 5 after the dapp's instructions), and
 * SaverFi's largest owner transaction names 6 writable accounts a post-state
 * check could be about (the pension key, the vault, its policy and the three
 * vault token accounts created beside set_invest_policy).
 */
export const MAX_WALLET_GUARDS = 6;
/** Assertions in one Lighthouse instruction. Phantom was seen writing 1 to 4. */
export const MAX_GUARD_ASSERTIONS = 8;

/** The program's instructions by their borsh index (instruction.rs). */
const INSTRUCTION_NAMES = [
  "MemoryWrite",
  "MemoryClose",
  "AssertAccountData",
  "AssertAccountDataMulti",
  "AssertAccountDelta",
  "AssertAccountInfo",
  "AssertAccountInfoMulti",
  "AssertMintAccount",
  "AssertMintAccountMulti",
  "AssertTokenAccount",
  "AssertTokenAccountMulti",
  "AssertStakeAccount",
  "AssertStakeAccountMulti",
  "AssertUpgradeableLoaderAccount",
  "AssertUpgradeableLoaderAccountMulti",
  "AssertSysvarClock",
  "AssertMerkleTreeAccount",
  "AssertBubblegumTreeConfigAccount",
] as const;

/** Why a kind is refused, where its source says more than "not seen from Phantom". */
const REFUSED_KINDS: Readonly<Record<number, string>> = {
  0: "which creates or grows a Lighthouse memory account and pays its rent from a signer",
  1: "which moves a Lighthouse memory account's lamports",
  4: "which compares against a MemoryWrite snapshot",
  16: "which calls the account-compression program",
};

/** LogLevel by its borsh index (types/assert/log_level.rs): borsh writes the index, not the #[repr] value. */
const LOG_LEVEL_NAMES = ["Silent", "PlaintextMessage", "EncodedMessage", "EncodedNoop", "FailedPlaintextMessage", "FailedEncodedMessage", "FailedEncodedNoop"] as const;
/** EncodedNoop and FailedEncodedNoop call the SPL Noop program (assertion_result.rs). */
const LOG_LEVELS_THAT_CALL = new Set([3, 6]);

export type LighthouseGuardKind = "AssertAccountInfoMulti" | "AssertTokenAccountMulti";

export type LighthouseGuardRead =
  | { readonly ok: true; readonly kind: LighthouseGuardKind; readonly logLevel: number; readonly assertions: number }
  | { readonly ok: false; readonly detail: string };

class GuardDataError extends Error {}

/** Borsh as Lighthouse writes it, over one instruction's data, refusing anything the program would not decode. */
class GuardReader {
  private at = 0;

  constructor(private readonly data: Uint8Array) {}

  get remaining(): number {
    return this.data.length - this.at;
  }

  byte(what: string): number {
    const value = this.data[this.at];
    if (value === undefined) throw new GuardDataError(`${what} runs past the end of the data`);
    this.at += 1;
    return value;
  }

  skip(bytes: number, what: string): void {
    if (this.remaining < bytes) throw new GuardDataError(`${what} runs past the end of the data`);
    this.at += bytes;
  }

  /** A borsh enum index or u8-backed choice below `count`. */
  choice(count: number, what: string): number {
    const value = this.byte(what);
    if (value >= count) throw new GuardDataError(`${what} ${value} does not exist`);
    return value;
  }

  bool(what: string): void {
    this.choice(2, what);
  }

  option(what: string, inner: () => void): void {
    if (this.choice(2, `${what}'s option tag`) === 1) inner();
  }

  /** Unsigned LEB128 (lighthouse-common CompactU64 and LEB128Vec's length), in its shortest form and within a u64. */
  leb128(what: string): bigint {
    let value = 0n;
    for (let index = 0; index < 10; index++) {
      const byte = this.byte(what);
      if (index === 9 && byte > 1) throw new GuardDataError(`${what} is larger than a u64`);
      value |= BigInt(byte & 0x7f) << BigInt(7 * index);
      if ((byte & 0x80) === 0) {
        if (index > 0 && byte === 0) throw new GuardDataError(`${what} is not in its shortest encoding`);
        return value;
      }
    }
    throw new GuardDataError(`${what} is longer than a u64`);
  }
}

const INTEGER_OPERATORS = 8;
const EQUATABLE_OPERATORS = 2;
/** KnownProgram: System, Token, Token2022, Rent, Stake, Vote, BpfLoader, UpgradeableLoader, SysvarConfig. */
const KNOWN_PROGRAMS = 9;

/** One AccountInfoAssertion (types/assert/account_info.rs). */
function readAccountInfoAssertion(reader: GuardReader): void {
  const variant = reader.choice(9, "an account-info assertion variant");
  switch (variant) {
    case 0: // Lamports
    case 1: // DataLength
    case 4: // RentEpoch
      reader.skip(8, "a u64");
      reader.choice(INTEGER_OPERATORS, "an integer operator");
      return;
    case 2: // Owner
      reader.skip(32, "a public key");
      reader.choice(EQUATABLE_OPERATORS, "an equality operator");
      return;
    case 3: // KnownOwner
      reader.choice(KNOWN_PROGRAMS, "a known program");
      reader.choice(EQUATABLE_OPERATORS, "an equality operator");
      return;
    case 5: // IsSigner
    case 6: // IsWritable
    case 7: // Executable
      reader.bool("a bool");
      reader.choice(EQUATABLE_OPERATORS, "an equality operator");
      return;
    default: // 8 VerifyDatahash
      reader.skip(32, "a hash");
      reader.leb128("a data-hash start");
      reader.leb128("a data-hash length");
  }
}

/** One TokenAccountAssertion (types/assert/token_account.rs). */
function readTokenAccountAssertion(reader: GuardReader): void {
  const variant = reader.choice(9, "a token-account assertion variant");
  switch (variant) {
    case 0: // Mint
    case 1: // Owner
      reader.skip(32, "a public key");
      reader.choice(EQUATABLE_OPERATORS, "an equality operator");
      return;
    case 2: // Amount
    case 6: // DelegatedAmount
      reader.skip(8, "a u64");
      reader.choice(INTEGER_OPERATORS, "an integer operator");
      return;
    case 3: // Delegate
    case 7: // CloseAuthority
      reader.option("a key", () => reader.skip(32, "a public key"));
      reader.choice(EQUATABLE_OPERATORS, "an equality operator");
      return;
    case 4: // State
      reader.byte("an account state");
      reader.choice(INTEGER_OPERATORS, "an integer operator");
      return;
    case 5: // IsNative
      reader.option("a native amount", () => reader.skip(8, "a u64"));
      reader.choice(EQUATABLE_OPERATORS, "an equality operator");
      return;
    default: // 8 TokenAccountOwnerIsDerived
  }
}

/**
 * One Lighthouse instruction's data, read as the kinds SaverFi relays: what it
 * is, or in words why it is not.
 */
export function readLighthouseGuard(data: Uint8Array): LighthouseGuardRead {
  const tag = data[0];
  if (tag === undefined) return { ok: false, detail: "empty" };
  const name = INSTRUCTION_NAMES[tag];
  if (name === undefined) return { ok: false, detail: `instruction ${tag}, which the Lighthouse program does not have` };
  if (tag !== LIGHTHOUSE_ASSERT_ACCOUNT_INFO_MULTI && tag !== LIGHTHOUSE_ASSERT_TOKEN_ACCOUNT_MULTI) {
    return { ok: false, detail: `${name} (${tag}), ${REFUSED_KINDS[tag] ?? "which Phantom has not been seen adding"}` };
  }
  const reader = new GuardReader(data.subarray(1));
  try {
    const logLevel = reader.choice(LOG_LEVEL_NAMES.length, "a log level");
    if (LOG_LEVELS_THAT_CALL.has(logLevel)) {
      return { ok: false, detail: `${name} at log level ${LOG_LEVEL_NAMES[logLevel]}, which calls the SPL Noop program` };
    }
    const count = reader.leb128("the assertion count");
    if (count < 1n || count > BigInt(MAX_GUARD_ASSERTIONS)) {
      return { ok: false, detail: `${name} with ${count} assertions; 1 to ${MAX_GUARD_ASSERTIONS} are relayed` };
    }
    const assertion = tag === LIGHTHOUSE_ASSERT_ACCOUNT_INFO_MULTI ? readAccountInfoAssertion : readTokenAccountAssertion;
    for (let index = 0; index < Number(count); index++) assertion(reader);
    if (reader.remaining !== 0) return { ok: false, detail: `${name} with ${reader.remaining} bytes after its last assertion` };
    return { ok: true, kind: name as LighthouseGuardKind, logLevel, assertions: Number(count) };
  } catch (error) {
    if (error instanceof GuardDataError) return { ok: false, detail: `${name} whose data does not decode: ${error.message}` };
    throw error;
  }
}

export const WALLET_GUARD_REFUSALS = [
  /** A Lighthouse instruction before or between SaverFi's own instructions. */
  "lighthouse_misplaced",
  /** More Lighthouse instructions than MAX_WALLET_GUARDS. */
  "lighthouse_count",
  /** A Lighthouse instruction that is not one assertion kind SaverFi relays, exactly encoded, naming one account. */
  "lighthouse_instruction",
  /** A Lighthouse instruction that names, adds or changes the privileges of an account beyond SaverFi's own instructions. */
  "lighthouse_accounts",
] as const;
export type WalletGuardRefusal = (typeof WALLET_GUARD_REFUSALS)[number];

/** A top-level instruction, decompiled: its program and accounts as base58. ParsedInstruction is one. */
export interface GuardCheckedInstruction {
  readonly programId: string;
  readonly accountKeys: readonly string[];
  readonly data: Uint8Array;
}

/** A message as checkWalletGuards reads it. */
export interface GuardCheckedMessage {
  /** base58, in message order. */
  readonly keys: readonly string[];
  /** What the message lets each key do, by key index. */
  readonly privileges: readonly KeyPrivileges[];
  readonly instructions: readonly GuardCheckedInstruction[];
}

export interface WalletGuard {
  readonly position: number;
  readonly kind: LighthouseGuardKind;
  readonly logLevel: number;
  readonly assertions: number;
  /** The one account it checks. */
  readonly account: string;
}

export type WalletGuardCheck =
  | {
      readonly ok: true;
      /** SaverFi's own instructions: the first `ownCount`. All of them when there is no guard. */
      readonly ownCount: number;
      readonly guards: readonly WalletGuard[];
    }
  | { readonly ok: false; readonly reason: WalletGuardRefusal; readonly detail: string };

const describePrivileges = (privileges: KeyPrivileges): string =>
  privileges.signer ? (privileges.writable ? "a writable signer" : "a read-only signer") : privileges.writable ? "writable" : "read-only";

/**
 * The wallet's Lighthouse checks in `message`, held to rules 1 to 6 above.
 *
 * `own` is the reference for rule 6: the signer and writable flags SaverFi's own
 * instructions give each key they name, which is what the message carries
 * without any guard. The browser passes the built message's; the relay, which
 * never saw the build, passes the ones the IDL and CreateIdempotent declare.
 *
 * With no Lighthouse instruction it answers ok at once and reads nothing else:
 * every other rule stays the caller's.
 */
export function checkWalletGuards(message: GuardCheckedMessage, own: ReadonlyMap<string, KeyPrivileges>): WalletGuardCheck {
  const { instructions } = message;
  const ownCount = instructions.findIndex((instruction) => instruction.programId === LIGHTHOUSE_PROGRAM);
  if (ownCount === -1) return { ok: true, ownCount: instructions.length, guards: [] };

  // 2: after all of SaverFi's own instructions.
  const after = instructions.findIndex((instruction, position) => position > ownCount && instruction.programId !== LIGHTHOUSE_PROGRAM);
  if (ownCount === 0 || after !== -1) {
    return {
      ok: false,
      reason: "lighthouse_misplaced",
      detail:
        ownCount === 0
          ? "a Lighthouse instruction stands first, before any of SaverFi's own instructions"
          : `the Lighthouse instruction at position ${ownCount + 1} stands before SaverFi's own instruction at position ${after + 1}; Lighthouse checks are relayed only after all of SaverFi's instructions`,
    };
  }

  // 3
  const guardCount = instructions.length - ownCount;
  if (guardCount > MAX_WALLET_GUARDS) {
    return { ok: false, reason: "lighthouse_count", detail: `${guardCount} Lighthouse instructions; at most ${MAX_WALLET_GUARDS} are relayed` };
  }

  // 4 and 5
  const named = new Set(instructions.slice(0, ownCount).flatMap((instruction) => instruction.accountKeys));
  const guards: WalletGuard[] = [];
  for (let position = ownCount; position < instructions.length; position++) {
    const instruction = instructions[position]!;
    const at = `the Lighthouse instruction at position ${position + 1}`;
    const read = readLighthouseGuard(instruction.data);
    if (!read.ok) return { ok: false, reason: "lighthouse_instruction", detail: `${at} is ${read.detail}` };
    if (instruction.accountKeys.length !== 1) {
      return { ok: false, reason: "lighthouse_instruction", detail: `${at} names ${instruction.accountKeys.length} accounts; an assertion names exactly one` };
    }
    const account = instruction.accountKeys[0]!;
    if (!named.has(account)) {
      return { ok: false, reason: "lighthouse_accounts", detail: `${at} checks ${account}, which SaverFi's own instructions do not name` };
    }
    guards.push({ position, kind: read.kind, logLevel: read.logLevel, assertions: read.assertions, account });
  }

  // 1 and 6: no new key but Lighthouse's, and no key's privileges changed.
  const present = new Set(message.keys);
  for (const [index, key] of message.keys.entries()) {
    const privileges = message.privileges[index]!;
    const expected = own.get(key) ?? (key === LIGHTHOUSE_PROGRAM ? { signer: false, writable: false } : undefined);
    if (expected === undefined) {
      return { ok: false, reason: "lighthouse_accounts", detail: `the message adds ${key}, which SaverFi's own instructions do not name` };
    }
    if (privileges.signer !== expected.signer || privileges.writable !== expected.writable) {
      return {
        ok: false,
        reason: "lighthouse_accounts",
        detail: `${key === LIGHTHOUSE_PROGRAM ? "the Lighthouse program" : key} is ${describePrivileges(privileges)} in the message, and ${describePrivileges(expected)} in SaverFi's own instructions`,
      };
    }
  }
  for (const key of own.keys()) {
    if (!present.has(key)) return { ok: false, reason: "lighthouse_accounts", detail: `the message no longer holds ${key}` };
  }
  return { ok: true, ownCount, guards };
}
