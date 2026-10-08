// The Privy policy that bounds the keeper's signer, and the pieces that prove it.
//
// WHAT THE POLICY IS FOR. The keeper signs as each trading wallet through ONE
// Privy authorization key (src/privy-signer.ts). The web registers that key on
// every wallet with addSigners and attaches this policy as the signer's
// OVERRIDE policy (additional_signers[].override_policy_ids), so it binds the
// keeper's requests and nobody else's: a wallet-level policy_ids entry would
// also bind the user and block their export to Axiom. Without it the key on
// Railway can do anything a wallet can — sign any message, send any
// transaction, export the key. With it, the key cannot sign a message or
// export a key, and can only send transactions made ENTIRELY of sip-vault
// settle_v2 instructions and Ed25519SigVerify instructions.
//
// PER INSTRUCTION, NOT ONLY PER PROGRAM. When this policy was first written
// (2026-09) Privy's one source for a custom Solana program was
// solana_program_instruction, which exposes the programId and nothing else, so
// the policy let through EVERY sip-vault instruction the wallet could sign. A
// wallet imported into SaverFi is often its owner's main trading wallet, and
// whoever held the keeper's authorization key and the app's credentials could
// have had it sign, through the seat, create_vault_v2 naming itself as owner,
// then link_wallet again and again with itself paying each link's rent. Privy
// now decodes instruction data against an Anchor IDL
// (field_source solana_instruction_data), and the sip-vault rule pairs its
// programId with instruction_name == settle_v2, read through settleOnlyIdl():
// the exported IDL cut down to settle_v2 alone. An IDL condition matches by the
// discriminator the data begins with, WHATEVER PROGRAM IS CALLED, so it never
// stands without the programId condition beside it (docs.privy.io,
// controls/policies/example-policies/solana-idls).
//
// WHAT THAT STILL ALLOWS.
//   * Any settle_v2 the wallet signs. What one moves is bounded by sip-vault's
//     own checks — the configured attester's Ed25519 signature it finds before
//     it in the transaction, the vault's and the protocol's pause, the vault's
//     max_contribution and wallet_reserve — not by Privy.
//   * An Ed25519SigVerify-only transaction passes, and costs the wallet the
//     base fee plus a fee per signature it declares every time it is sent: a
//     drain bounded by transaction size, not stopped by the policy. That
//     program is not an Anchor program, so no IDL narrows it.
//
// WHY COMPUTE BUDGET IS NOT ALLOWED. A transaction of nothing but
// SetComputeUnitLimit and SetComputeUnitPrice would pass an allowlist naming
// it, simulate cleanly and pay the leader whatever priority fee it names, so
// whoever held the keeper's authorization key could burn each trading wallet's
// SOL as priority fees, and sip-vault could not stop it through the
// instructions sysvar because such a transaction carries no sip-vault
// instruction. The Privy settle path sends [Ed25519SigVerify, settle_v2] and
// nothing else (only invest-tick's crank transaction uses compute budget, and
// the settle key signs that one, not Privy), so it is left out.
//
// HOW PRIVY EVALUATES IT (docs.privy.io, re-read 2026-10-08):
//   * any matching DENY denies; an ALLOW with no DENY allows; a method with no
//     rule is DENIED by default;
//   * on Solana EVERY top-level instruction must be ALLOWed, each by some rule
//     whose conditions all hold for it. So settle_v2 and Ed25519SigVerify get a
//     rule each: one rule naming both programs AND settle_v2 would never allow
//     the Ed25519 instruction, whose data begins with no settle_v2
//     discriminator. settle_v2's System transfer happens by CPI inside the
//     program, so it is not top level and the System program needs no entry;
//   * there is no '*' rule. A '*' DENY would also deny signAndSendTransaction,
//     and a '*' ALLOW would re-open everything the default denies.
//
// Pure except writeAdminKeyFile, which is the one function here that touches
// the disk, and does so as narrowly as it can.

import { createPrivateKey } from "node:crypto";
import {
  closeSync,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  openSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { OLD_NUVEM_PROGRAM_ID, SIP_PROGRAM_ID, idl, type SipVaultIdl } from "./idl.js";

export const KEEPER_POLICY_NAME = "SaverFi keeper — settle_v2 only";
/** The 1-of-1 key quorum that owns the policy. Its private key never reaches Railway. */
export const ADMIN_KEY_QUORUM_NAME = "sip-solana-policy-admin";
export const ED25519_PROGRAM_ID = "Ed25519SigVerify111111111111111111111111111";
export const COMPUTE_BUDGET_PROGRAM_ID = "ComputeBudget111111111111111111111111111111";
export const MEMO_PROGRAM_ID = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
/** What the refusal probes sign or carry. Harmless if a probe ever went through. */
export const PROBE_MESSAGE = "sip policy probe";
/** The one sip-vault instruction the keeper's signer may send. */
export const SETTLE_INSTRUCTION = "settle_v2";
/** Privy's ceiling for one condition's IDL (docs.privy.io, controls/policies/example-policies/solana-idls). */
export const PRIVY_IDL_MAX_BYTES = 32 * 1024;

export type PolicyAction = "ALLOW" | "DENY";

/** An account of an instruction in the policy's IDL: its name and flags, in the program's order. */
export interface PolicyIdlAccount {
  readonly name: string;
  readonly writable?: true;
  readonly signer?: true;
  readonly optional?: true;
  readonly address?: string;
}

/** The modern Anchor IDL (0.30+, explicit discriminators) a solana_instruction_data condition carries. */
export interface PolicyIdl {
  readonly address: string;
  readonly metadata: { readonly name: string; readonly version: string; readonly spec: string };
  readonly instructions: readonly {
    readonly name: string;
    readonly discriminator: readonly number[];
    readonly accounts: readonly PolicyIdlAccount[];
    readonly args: readonly { readonly name: string; readonly type: string }[];
  }[];
}

/** "This instruction calls this program." */
export interface ProgramCondition {
  readonly field_source: "solana_program_instruction";
  readonly field: "programId";
  readonly operator: "eq";
  readonly value: string;
}

/** "This instruction's data begins with the discriminator `idl` names `value`." Only ever next to a ProgramCondition. */
export interface InstructionNameCondition {
  readonly field_source: "solana_instruction_data";
  readonly field: "instruction_name";
  readonly operator: "eq";
  readonly value: string;
  readonly idl: PolicyIdl;
}

export type KeeperPolicyCondition = ProgramCondition | InstructionNameCondition;

export interface KeeperPolicyRule {
  readonly name: string;
  readonly method: "signAndSendTransaction" | "exportPrivateKey" | "signMessage";
  readonly action: PolicyAction;
  readonly conditions: readonly KeeperPolicyCondition[];
}

/** The body privy.policies().create receives, minus owner_id. */
export interface KeeperPolicy {
  readonly version: "1.0";
  readonly name: string;
  readonly chain_type: "solana";
  readonly rules: readonly KeeperPolicyRule[];
}

/**
 * The policy as a reader of Privy's API sees it. Deliberately looser than the
 * SDK's types: `check` has to describe whatever is actually stored, including
 * shapes this file would never build.
 */
export interface PolicyConditionLike {
  readonly field_source: string;
  readonly field?: string;
  readonly operator: string;
  readonly value: unknown;
  /** solana_instruction_data only: the IDL the field is decoded with, as Privy returns it. */
  readonly idl?: unknown;
}

export interface PolicyRuleLike {
  readonly method: string;
  readonly action: string;
  readonly conditions: readonly PolicyConditionLike[];
  readonly name?: string;
  readonly id?: string;
}

export interface PolicyLike {
  readonly chain_type: string;
  readonly rules: readonly PolicyRuleLike[];
  readonly owner_id?: string | null;
  readonly id?: string;
  readonly name?: string;
  readonly version?: string;
}

const deepFreeze = <T>(value: T): T => {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
};

/**
 * The exported IDL cut down to settle_v2: what the policy's instruction_name
 * condition decodes with.
 *
 * WHY A SUBSET. Privy asks for an IDL trimmed to the instructions the policy
 * uses, and takes at most PRIVY_IDL_MAX_BYTES per condition. The whole
 * exported IDL, as compact JSON, is already most of that ceiling (28 580 bytes
 * on 2026-10-08) and grows with every instruction; settle_v2 alone is under
 * 1 KB, and it is what the owner reads in `privy-policy --print`.
 *
 * WHAT IS KEPT. Privy asks for each instruction the policy uses to be
 * complete: every account, in the program's order, and every type it uses. So
 * settle_v2 keeps its discriminator, its accounts (name and flags) and its
 * arguments, and the IDL keeps the address and metadata of the program it came
 * from: Privy ignores the address, and the programId condition is what names
 * the program. Account docs and PDA seeds are dropped: decoding never reads
 * them, and the seeds name the Vault account type, which this IDL does not
 * carry.
 *
 * IT REFUSES WHAT IT CANNOT CARRY WHOLE. settle_v2's arguments are all
 * primitives today, so the IDL needs no `types`; an argument of a defined type,
 * or an account group, throws here rather than build an IDL Privy would refuse
 * or decode differently from the program.
 */
export function settleOnlyIdl(source: SipVaultIdl = idl): PolicyIdl {
  const settle = source.instructions.find((instruction) => instruction.name === SETTLE_INSTRUCTION);
  if (settle === undefined) throw new Error(`the exported IDL has no ${SETTLE_INSTRUCTION} instruction`);
  const accounts = settle.accounts.map((account): PolicyIdlAccount => {
    if ("accounts" in account) {
      throw new Error(`${SETTLE_INSTRUCTION}'s account ${account.name} is a group; the policy's IDL keeps plain accounts only`);
    }
    return {
      name: account.name,
      ...(account.writable === true ? { writable: true as const } : {}),
      ...(account.signer === true ? { signer: true as const } : {}),
      ...(account.optional === true ? { optional: true as const } : {}),
      ...(account.address !== undefined ? { address: account.address } : {}),
    };
  });
  const args = settle.args.map((arg) => {
    if (typeof arg.type !== "string") {
      throw new Error(`${SETTLE_INSTRUCTION}'s argument ${arg.name} is not a primitive; the policy's IDL would need its types`);
    }
    return { name: arg.name, type: arg.type };
  });
  const subset: PolicyIdl = {
    address: source.address,
    metadata: { name: source.metadata.name, version: source.metadata.version, spec: source.metadata.spec },
    instructions: [{ name: settle.name, discriminator: [...settle.discriminator], accounts, args }],
  };
  const bytes = Buffer.byteLength(JSON.stringify(subset), "utf8");
  if (bytes > PRIVY_IDL_MAX_BYTES) {
    throw new Error(`the policy's IDL is ${bytes} bytes; Privy takes at most ${PRIVY_IDL_MAX_BYTES} per condition`);
  }
  return deepFreeze(subset);
}

/**
 * The keeper's policy for `programId`, which must be the exported IDL's address.
 *
 * TAKES THE ID AND REFUSES EVERY OTHER. The parameter exists so a caller that
 * got an id from somewhere — an environment, an argument — is checked here, in
 * one place, and the old program is refused in its own words before any
 * comparison that would describe it as merely "different".
 */
export function buildKeeperPolicy(programId: string): KeeperPolicy {
  if (programId === OLD_NUVEM_PROGRAM_ID) {
    throw new Error(
      "refusing to build a policy for a retired program: its upgrade authority key leaked, so whoever holds that " +
        `key can rewrite what it does. The keeper's policy allows only sip-vault, ${SIP_PROGRAM_ID}.`,
    );
  }
  if (programId !== SIP_PROGRAM_ID) {
    throw new Error(
      `refusing to build a policy for a program other than the exported IDL's address (${SIP_PROGRAM_ID}): the keeper ` +
        "builds its settle instructions from that IDL, so an allowlist naming anything else is wrong.",
    );
  }
  return deepFreeze({
    version: "1.0",
    name: KEEPER_POLICY_NAME,
    chain_type: "solana",
    rules: [
      {
        name: "Allow sip-vault settle_v2 only",
        method: "signAndSendTransaction",
        action: "ALLOW",
        conditions: [
          { field_source: "solana_program_instruction", field: "programId", operator: "eq", value: programId },
          {
            field_source: "solana_instruction_data",
            field: "instruction_name",
            operator: "eq",
            value: SETTLE_INSTRUCTION,
            idl: settleOnlyIdl(),
          },
        ],
      },
      {
        name: "Allow the attester's Ed25519SigVerify",
        method: "signAndSendTransaction",
        action: "ALLOW",
        conditions: [{ field_source: "solana_program_instruction", field: "programId", operator: "eq", value: ED25519_PROGRAM_ID }],
      },
      { name: "Deny private key export", method: "exportPrivateKey", action: "DENY", conditions: [] },
      { name: "Deny message signing", method: "signMessage", action: "DENY", conditions: [] },
    ],
  });
}

const programsOf = (rule: KeeperPolicyRule): readonly string[] =>
  rule.conditions.flatMap((condition) => (condition.field_source === "solana_program_instruction" ? [condition.value] : []));

/** The programs a policy this file built lets an instruction call, in rule order. */
export function allowedPrograms(policy: KeeperPolicy): readonly string[] {
  return policy.rules.flatMap((rule) => (rule.action === "ALLOW" ? programsOf(rule) : []));
}

/**
 * What each ALLOW rule of a policy this file built lets through, one line per
 * rule, for a person to read next to the policy itself.
 */
export function allowedInstructions(policy: KeeperPolicy): readonly string[] {
  return policy.rules.flatMap((rule) => {
    if (rule.action !== "ALLOW") return [];
    const names = rule.conditions.flatMap((condition) => (condition.field_source === "solana_instruction_data" ? [condition.value] : []));
    const programs = programsOf(rule).join(", ");
    return [names.length === 0 ? `${programs}: any instruction` : `${programs}: ${names.join(", ")} only`];
  });
}

// --- diff --------------------------------------------------------------------

export interface PolicyDiff {
  /** Chain type, rules, methods, actions and condition values (as sets) all match. Names and ids are ignored. */
  readonly identical: boolean;
  /** One sentence per difference in what the policy enforces. Public data only. */
  readonly differences: readonly string[];
  readonly ownerId: string | null;
  readonly owned: boolean;
  /** The owner is the keeper's own signer: the key Railway holds could rewrite its own bounds. */
  readonly ownerIsSigner: boolean;
  /** Why the ownership is wrong, if it is. */
  readonly ownershipProblems: readonly string[];
  /** identical AND owned AND not owned by the signer: the only state `check` exits 0 for. */
  readonly ok: boolean;
}

/** A condition value as a sorted set: Privy accepts a string or a list, and order and repeats enforce nothing. */
const valueSet = (value: unknown): string[] =>
  [...new Set((Array.isArray(value) ? value : [value]).map((item) => String(item)))].sort();

/** An IDL's discriminator as hex, from the byte list Anchor writes or a hex string; null for anything else. */
function discriminatorHex(value: unknown): string | null {
  if (Array.isArray(value) && value.length > 0 && value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
    return Buffer.from(value as number[]).toString("hex");
  }
  if (typeof value === "string" && /^(0x)?([0-9a-fA-F]{2})+$/.test(value)) return value.replace(/^0x/, "").toLowerCase();
  return null;
}

/**
 * What an IDL makes instruction_name mean: every instruction it names, as
 * name=0x<discriminator>, sorted.
 *
 * THE PART THAT ENFORCES, AND ONLY THAT. instruction_name is the name the IDL
 * gives the discriminator an instruction's data begins with, so the condition
 * allows exactly the discriminators its IDL names settle_v2. Listing every
 * name=discriminator pair shows a stored IDL that gives that name to another
 * discriminator, in place of the real one or beside it, and also any other
 * change to the instructions it names, which a reviewer should see even when it
 * widens nothing. Docs, flags and argument lists do not decide what a name
 * resolves to, so a copy Privy re-serialized differently still reads the same.
 */
export function idlFingerprint(value: unknown): string {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed) as unknown;
    } catch {
      return "unreadable";
    }
  }
  const instructions = typeof parsed === "object" && parsed !== null ? (parsed as { instructions?: unknown }).instructions : undefined;
  if (!Array.isArray(instructions)) return parsed === undefined || parsed === null ? "none" : "unreadable";
  if (instructions.length === 0) return "no instructions";
  const entries = instructions.map((instruction: unknown) => {
    const { name, discriminator } = (typeof instruction === "object" && instruction !== null ? instruction : {}) as {
      name?: unknown;
      discriminator?: unknown;
    };
    return `${typeof name === "string" ? name : "?"}=0x${discriminatorHex(discriminator) ?? "?"}`;
  });
  return [...new Set(entries)].sort().join(", ");
}

const conditionHead = (condition: PolicyConditionLike): string =>
  `${condition.field_source}.${condition.field ?? ""} ${condition.operator}` +
  (condition.field_source === "solana_instruction_data" || (condition.idl !== undefined && condition.idl !== null)
    ? ` (idl: ${idlFingerprint(condition.idl)})`
    : "");

const describeCondition = (condition: PolicyConditionLike): string =>
  `${conditionHead(condition)} [${valueSet(condition.value).join(", ")}]`;

const describeConditions = (conditions: readonly PolicyConditionLike[]): string => {
  const described = [...new Set(conditions.map(describeCondition))].sort();
  return described.length === 0 ? "always" : `when ${described.join(" and ")}`;
};

const describeRule = (rule: PolicyRuleLike): string => `${rule.action} ${rule.method} ${describeConditions(rule.conditions)}`;

/** The programs a rule's programId conditions name, as a sorted set. */
const programsIn = (rule: PolicyRuleLike): string[] =>
  valueSet(
    rule.conditions.flatMap((condition) =>
      condition.field_source === "solana_program_instruction" && condition.field === "programId" ? valueSet(condition.value) : [],
    ),
  );

/** "the ALLOW signAndSendTransaction rule", plus the programs it names when it names any: two rules share a method now. */
const ruleLabel = (rule: PolicyRuleLike): string => {
  const programs = programsIn(rule);
  return `the ${rule.action} ${rule.method} rule${programs.length > 0 ? ` for ${programs.join(", ")}` : ""}`;
};

function conditionDelta(expected: PolicyRuleLike, actual: PolicyRuleLike): string[] {
  const out: string[] = [];
  const label = ruleLabel(expected);
  const unmatched = [...actual.conditions];
  for (const want of expected.conditions) {
    const index = unmatched.findIndex((got) => conditionHead(got) === conditionHead(want));
    if (index < 0) {
      out.push(`${label} is missing its condition ${describeCondition(want)}`);
      continue;
    }
    const got = unmatched.splice(index, 1)[0]!;
    const wanted = valueSet(want.value);
    const found = valueSet(got.value);
    const added = found.filter((item) => !wanted.includes(item));
    const dropped = wanted.filter((item) => !found.includes(item));
    if (added.length > 0) out.push(`${label}'s ${conditionHead(want)} list adds [${added.join(", ")}]`);
    if (dropped.length > 0) out.push(`${label}'s ${conditionHead(want)} list drops [${dropped.join(", ")}]`);
  }
  for (const extra of unmatched) out.push(`${label} has an extra condition ${describeCondition(extra)}`);
  // Same heads and same sets but different keys: duplicates, which enforce the same thing.
  return out;
}

/**
 * What differs between the policy this file builds and one Privy stores, in the
 * terms that change enforcement, plus whether the stored one is owned — and not
 * by the key it is meant to bound.
 */
export function diffPolicy(expected: KeeperPolicy, actual: PolicyLike, options: { readonly signerId?: string | null } = {}): PolicyDiff {
  const differences: string[] = [];

  if (actual.chain_type !== expected.chain_type) {
    differences.push(`chain_type is ${String(actual.chain_type)}; expected ${expected.chain_type}`);
  }

  const mentionsOldProgram = actual.rules.some((rule) =>
    rule.conditions.some((condition) => valueSet(condition.value).includes(OLD_NUVEM_PROGRAM_ID)),
  );
  if (mentionsOldProgram) {
    differences.push(`a rule names a retired program ${OLD_NUVEM_PROGRAM_ID}, whose upgrade key leaked; no SaverFi policy may mention it`);
  }

  const missing: PolicyRuleLike[] = [...expected.rules];
  const extra: PolicyRuleLike[] = [...actual.rules];
  const take = (predicate: (want: PolicyRuleLike, got: PolicyRuleLike) => boolean, report: (want: PolicyRuleLike, got: PolicyRuleLike) => void): void => {
    for (let i = 0; i < missing.length; ) {
      const want = missing[i]!;
      const j = extra.findIndex((got) => predicate(want, got));
      if (j < 0) {
        i += 1;
        continue;
      }
      report(want, extra[j]!);
      missing.splice(i, 1);
      extra.splice(j, 1);
    }
  };

  // Exact matches, as a multiset: they say nothing.
  take((want, got) => describeRule(want) === describeRule(got), () => undefined);
  // Same method and conditions, other action: the one-word change that inverts a rule.
  take(
    (want, got) => want.method === got.method && describeConditions(want.conditions) === describeConditions(got.conditions),
    (want, got) =>
      differences.push(`the ${want.method} rule (${describeConditions(want.conditions)}) is ${got.action}; expected ${want.action}`),
  );
  const reportConditions = (want: PolicyRuleLike, got: PolicyRuleLike): void => {
    const delta = conditionDelta(want, got);
    differences.push(...(delta.length > 0 ? delta : [`${ruleLabel(want)}'s conditions differ`]));
  };
  // Same method, action and programs, other conditions: one program's rule whose terms changed.
  take(
    (want, got) => want.method === got.method && want.action === got.action && programsIn(want).join() === programsIn(got).join(),
    reportConditions,
  );
  // Same method and action, other conditions: an allowlist that grew or shrank.
  take((want, got) => want.method === got.method && want.action === got.action, reportConditions);
  for (const want of missing) differences.push(`missing rule: ${describeRule(want)}`);
  for (const got of extra) {
    differences.push(
      `unexpected rule: ${describeRule(got)}` +
        (got.method === "*" ? " (a '*' rule applies to every method, signAndSendTransaction included)" : ""),
    );
  }

  const ownerId = typeof actual.owner_id === "string" && actual.owner_id.trim() !== "" ? actual.owner_id : null;
  const signerId = options.signerId ?? null;
  const ownerIsSigner = ownerId !== null && signerId !== null && ownerId === signerId;
  const ownershipProblems: string[] = [];
  if (ownerId === null) {
    ownershipProblems.push(
      "the policy has no owner_id: the app secret alone can rewrite or delete it, and the keeper on Railway holds that secret",
    );
  } else if (ownerIsSigner) {
    ownershipProblems.push(
      "the policy is owned by the keeper's own signer (SIP_SOLANA_PRIVY_SIGNER_ID): the key Railway holds could widen its own rule",
    );
  }

  const identical = differences.length === 0;
  return {
    identical,
    differences,
    ownerId,
    owned: ownerId !== null,
    ownerIsSigner,
    ownershipProblems,
    ok: identical && ownershipProblems.length === 0,
  };
}

// --- the admin key file ----------------------------------------------------------

/**
 * One additional signer as it sits on a wallet: the key quorum, and the policy
 * ids that override the wallet's own for it.
 *
 * PRIVY ALREADY SENDS THIS. The server API returns it on every wallet it lists
 * (WalletAdditionalSignerItem: `signer_id`, plus an optional
 * `override_policy_ids` documented as "a list of up to one policy ID"), so
 * reading a seat's bound costs no request of its own — the sweep's existing
 * wallet listing carries it. The browser SDK cannot read it back at all, which
 * is why only something holding the app secret, this CLI or the keeper, can
 * tell a bounded seat from an unbounded one.
 */
export interface SignerSeat {
  readonly signerId: string;
  /**
   * Empty when the seat carries no override. The signer then falls back to the
   * WALLET's own policies, which for a trading wallet the web creates means
   * none at all: an unbounded signer.
   */
  readonly overridePolicyIds: readonly string[];
}

/** What a wallet's seats say about one signer. */
export type SeatVerdict =
  /** No seat on this wallet names the signer. */
  | "NOT_GRANTED"
  /** The signer is seated, but not bounded by exactly the expected policy. */
  | "NOT_BOUNDED"
  | "BOUND";

/** Every seat naming `signerId`. More than one is unusual, and each is held to the same rule. */
export function seatsFor(seats: readonly SignerSeat[], signerId: string): readonly SignerSeat[] {
  return seats.filter((seat) => seat.signerId === signerId);
}

/**
 * THE ONE RULE deciding whether the keeper's signer is bounded on a wallet,
 * shared by `privy-policy verify` and by the keeper's own signer so that the
 * command an operator trusts and the process that signs can never drift apart.
 *
 * EXACTLY ONE OVERRIDE POLICY, AND THIS ONE — never `includes`. Privy documents
 * at most one policy per signer, so a seat carrying a second id carries a second
 * bound nobody here has examined, and a seat carrying none is an unbounded
 * credential: the key on Railway could sign any message, send any transaction
 * and export that wallet's key.
 */
export function seatVerdict(seats: readonly SignerSeat[], signerId: string, policyId: string): SeatVerdict {
  const granted = seatsFor(seats, signerId);
  if (granted.length === 0) return "NOT_GRANTED";
  const bounded = granted.every((seat) => seat.overridePolicyIds.length === 1 && seat.overridePolicyIds[0] === policyId);
  return bounded ? "BOUND" : "NOT_BOUNDED";
}

export type AdminKeyFileRefusal = "NOT_A_KEY" | "NO_DIRECTORY" | "INSIDE_REPOSITORY" | "EXISTS" | "WRITE_FAILED";

/** Thrown by writeAdminKeyFile. The message names paths and reasons, never the key. */
export class AdminKeyFileError extends Error {
  override readonly name = "AdminKeyFileError";

  constructor(
    readonly reason: AdminKeyFileRefusal,
    message: string,
  ) {
    super(message);
  }
}

/**
 * True for exactly what the SDK's authorization_context.authorization_private_keys
 * documents and generateP256KeyPair returns: a base64 PKCS8 P-256 private key,
 * no PEM headers, no "wallet-auth:" prefix, no whitespace.
 */
export function isP256Pkcs8PrivateKey(value: string): boolean {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  const der = Buffer.from(value, "base64");
  // Node's decoder is lenient; a value that does not round-trip is not canonical base64.
  if (der.toString("base64") !== value) return false;
  try {
    const key = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
    return key.asymmetricKeyType === "ec" && key.asymmetricKeyDetails?.namedCurve === "prime256v1";
  } catch {
    // The error describes the DER parser's state, not the key, but it has no use here.
    return false;
  }
}

/** The directory holding `.git` above `start` (a worktree's `.git` is a file; both count), else the pnpm workspace root, else `start`. */
export function findRepositoryRoot(start: string): string {
  const fallbacks: string[] = [];
  for (let dir = resolve(start); ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) return dir;
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) fallbacks.push(dir);
    if (dirname(dir) === dir) break;
  }
  return fallbacks[0] ?? resolve(start);
}

/** A path's device and inode, following symlinks: the same under every spelling of it. Null if it cannot be stat'ed. */
function fileIdentity(path: string): { readonly dev: bigint; readonly ino: bigint } | null {
  try {
    const stats = statSync(path, { bigint: true });
    return { dev: stats.dev, ino: stats.ino };
  } catch {
    return null;
  }
}

/**
 * The repository `directory` (already resolved through symlinks) lies in, in
 * words for a refusal, or null when it lies in none.
 *
 * BY IDENTITY, NOT BY SPELLING. On macOS one directory answers to paths that
 * realpath hands back unchanged — /users/… on a case-insensitive volume,
 * /System/Volumes/Data/Users/… through the Data firmlink — and a string prefix
 * test lets every one of them through. So each directory from `directory` up
 * to / is compared with the repository by device and inode. A directory that
 * holds a `.git` entry is refused as well: another checkout, or a worktree of
 * this one, is just as close to public.
 */
function repositoryContaining(directory: string, repoRoot: string): string | null {
  const repo = fileIdentity(repoRoot);
  for (let dir = directory; ; dir = dirname(dir)) {
    const here = repo === null ? null : fileIdentity(dir);
    if (repo !== null && here !== null && here.dev === repo.dev && here.ino === repo.ino) {
      return dir === repoRoot ? `the repository (${repoRoot})` : `the repository (${repoRoot}, spelled ${dir})`;
    }
    if (existsSync(join(dir, ".git"))) return `a git work tree (${dir} holds a .git entry)`;
    if (dirname(dir) === dir) return null;
  }
}

/**
 * Writes the policy admin's private key, once, where the repository cannot see it.
 *
 *   * THE KEY IS CHECKED FIRST: a value that is not a P-256 PKCS8 key is never
 *     written, so the file is always usable as authorization_private_keys[0]
 *     byte for byte — no newline, no prefix, nothing to trim.
 *   * THE PARENT IS RESOLVED THROUGH SYMLINKS and refused if it, or any
 *     directory above it, is the repository — compared by device and inode, so
 *     no other spelling of the path gets past — or holds a `.git` entry. A key
 *     written into a repository is one `git add -A` from public, and a symlink
 *     pointing into it is the same path.
 *   * OPENED WITH 'wx' AND 0600: O_CREAT|O_EXCL refuses an existing file and
 *     refuses a symlink in the last component; the mode is set on the
 *     descriptor as well, so a umask cannot widen it. The file is opened under
 *     the resolved parent, so the directory that was checked is the one written.
 *   * NOTHING IS LOGGED, and no message built here contains the key.
 */
export function writeAdminKeyFile(
  path: string,
  privateKey: string,
  options: { readonly repoRoot: string },
): { readonly path: string; readonly mode: number } {
  if (!isP256Pkcs8PrivateKey(privateKey)) {
    throw new AdminKeyFileError("NOT_A_KEY", "the admin key is not a base64 PKCS8 P-256 private key; nothing was written");
  }
  const target = resolve(path);
  let parent: string;
  try {
    parent = realpathSync.native(dirname(target));
  } catch {
    throw new AdminKeyFileError("NO_DIRECTORY", `${dirname(target)} does not exist; create it first (mkdir -p, then chmod 700)`);
  }
  const repository = repositoryContaining(parent, options.repoRoot);
  if (repository !== null) {
    throw new AdminKeyFileError(
      "INSIDE_REPOSITORY",
      `${target} resolves inside ${repository}; the admin key must live outside every repository, e.g. ~/sip-keys`,
    );
  }

  const file = join(parent, basename(target));
  let fd: number;
  try {
    fd = openSync(file, "wx", 0o600);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      throw new AdminKeyFileError("EXISTS", `${file} already exists; refusing to overwrite a key. Choose a new path.`);
    }
    throw new AdminKeyFileError("WRITE_FAILED", `could not create ${file} (${code ?? "unknown error"})`);
  }
  try {
    fchmodSync(fd, 0o600);
    const bytes = Buffer.from(privateKey, "utf8");
    for (let offset = 0; offset < bytes.length; ) offset += writeSync(fd, bytes, offset, bytes.length - offset);
    fsyncSync(fd);
    const mode = fstatSync(fd).mode & 0o777;
    if (mode !== 0o600) throw new Error(`mode ${mode.toString(8)}`);
    closeSync(fd);
    return { path: file, mode };
  } catch (error) {
    try {
      closeSync(fd);
    } catch {
      // Already closed.
    }
    // Only the file this call created with O_EXCL: a half-written key is worse than none.
    try {
      unlinkSync(file);
    } catch {
      // Nothing to remove.
    }
    const code = (error as NodeJS.ErrnoException).code ?? (error instanceof Error ? error.message : "unknown error");
    throw new AdminKeyFileError("WRITE_FAILED", `could not write ${file} (${code}); nothing was left behind`);
  }
}

// --- errors ------------------------------------------------------------------------

export type PrivyErrorClass = "POLICY_VIOLATION" | "SIMULATION_FAILED" | "AUTHORIZATION" | "OTHER";

/**
 * The SDK's APIError (node_modules/@privy-io/node/core/error): `status` is the
 * HTTP status (undefined for a connection error) and `error` is the parsed JSON
 * body, where Privy puts `code`. Matched by shape, not instanceof, so a second
 * copy of the SDK in the graph classifies the same.
 */
function apiErrorParts(error: unknown): { readonly status: number | undefined; readonly body: unknown } | null {
  if (typeof error !== "object" || error === null || !("status" in error) || !("error" in error)) return null;
  const status = (error as { status: unknown }).status;
  return { status: typeof status === "number" ? status : undefined, body: (error as { error: unknown }).error };
}

/** Privy's error code, lowercased — the docs write it `policy_violation` and `POLICY_VIOLATION` — or null. */
export function privyErrorCode(error: unknown): string | null {
  const body = apiErrorParts(error)?.body;
  if (typeof body !== "object" || body === null) return null;
  const pick = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value.trim().toLowerCase() : null);
  const direct = pick((body as { code?: unknown }).code);
  if (direct !== null) return direct;
  const nested = (body as { error?: unknown }).error;
  return typeof nested === "object" && nested !== null ? pick((nested as { code?: unknown }).code) : null;
}

export function privyErrorStatus(error: unknown): number | null {
  return apiErrorParts(error)?.status ?? null;
}

/** docs.privy.io/basics/troubleshooting/error-handling/api-errors, "Authorization signature errors". */
const AUTHORIZATION_CODES = new Set([
  "missing_or_empty_authorization_header",
  "zero_correct_authorization_signatures",
  "insufficient_correct_authorization_signatures",
  "incorrect_quantity_of_authorization_signatures",
  "request_expired",
  "no_valid_user_session_keys",
  "user_session_keys_expired",
]);

/**
 * Privy documents no code of its own for a failed simulation, only that the
 * simulation's error is returned; `insufficient_funds` is the one documented
 * case. The text pattern catches the simulation errors Solana itself words.
 */
const SIMULATION_CODES = new Set(["insufficient_funds", "simulation_failed", "transaction_simulation_failed"]);
const SIMULATION_TEXT = /simulat|insufficient (funds|lamports)|AccountNotFound|no record of a prior credit|blockhash ?not ?found/i;

/**
 * Which of four things a Privy failure was.
 *
 * ONLY A CODE MAKES A POLICY_VIOLATION. `verify` counts a probe as refused only
 * on this class, so it is matched on Privy's code and nothing looser: a message
 * that merely mentions a policy must not turn an unknown failure into a pass.
 * The other classes only change what an operator is told, never the verdict.
 */
export function classifyPrivyError(error: unknown): PrivyErrorClass {
  const parts = apiErrorParts(error);
  if (parts !== null) {
    const code = privyErrorCode(error);
    if (code === "policy_violation") return "POLICY_VIOLATION";
    if ((code !== null && AUTHORIZATION_CODES.has(code)) || parts.status === 401 || parts.status === 403) return "AUTHORIZATION";
    if (code !== null && (SIMULATION_CODES.has(code) || code.includes("simulation"))) return "SIMULATION_FAILED";
    if (parts.status !== undefined && parts.status >= 400 && parts.status < 500) {
      let text: string;
      try {
        text = JSON.stringify(parts.body) ?? "";
      } catch {
        text = "";
      }
      if (SIMULATION_TEXT.test(text)) return "SIMULATION_FAILED";
    }
    return "OTHER";
  }
  // Thrown by the SDK itself (lib/cryptography importPKCS8PrivateKey) before any request.
  if (error instanceof Error && error.message === "Invalid wallet authorization private key") return "AUTHORIZATION";
  return "OTHER";
}

// --- refusal probes ------------------------------------------------------------------

/**
 * One instruction, fee payer the wallet, serialized with empty signature slots.
 *
 * WHY THESE SHAPES. Privy simulates a sign-and-send BEFORE it evaluates the
 * policy, and a failed simulation answers with the simulation's error, not a
 * policy violation. A refusal probe must therefore be a transaction that would
 * succeed, from a funded wallet — and one whose success would cost nothing but
 * a fee, because a probe that goes through has been broadcast.
 */
function probeTransaction(wallet: PublicKey | string, recentBlockhash: string, instruction: TransactionInstruction): Buffer {
  const payer = new PublicKey(wallet);
  try {
    // A blockhash is 32 bytes of base58: the shape PublicKey validates.
    new PublicKey(recentBlockhash);
  } catch {
    throw new Error("recentBlockhash is not a base58 32-byte hash");
  }
  const transaction = new Transaction();
  transaction.feePayer = payer;
  transaction.recentBlockhash = recentBlockhash;
  transaction.add(instruction);
  return transaction.serialize({ requireAllSignatures: false, verifySignatures: false });
}

/** A top-level System transfer of 1 lamport from the wallet to itself: not in the allowlist, and harmless if sent. */
export function buildSelfTransferProbe(wallet: PublicKey | string, recentBlockhash: string): Buffer {
  const address = new PublicKey(wallet);
  return probeTransaction(address, recentBlockhash, SystemProgram.transfer({ fromPubkey: address, toPubkey: address, lamports: 1 }));
}

/** A Memo program instruction carrying PROBE_MESSAGE, with no accounts: not in the allowlist, and harmless if sent. */
export function buildMemoProbe(wallet: PublicKey | string, recentBlockhash: string): Buffer {
  return probeTransaction(
    wallet,
    recentBlockhash,
    new TransactionInstruction({ programId: new PublicKey(MEMO_PROGRAM_ID), keys: [], data: Buffer.from(PROBE_MESSAGE, "utf8") }),
  );
}
