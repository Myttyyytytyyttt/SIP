/**
 * THE BROWSER'S OWN CHECKS ON TRANSACTION BYTES, before and after a wallet signs.
 *
 * The build route's answer is advice. Before Phantom is asked, the page reads
 * the unsigned bytes itself and requires exactly what the person asked for:
 * [SetComputeUnitLimit, SetComputeUnitPrice, (the consent's Ed25519SigVerify,)
 * the SIP instruction], the product's compute budget, the pension key as fee
 * payer and signers in order, the SIP instruction's accounts and arguments, and
 * for a link the consent the trading wallet just signed.
 *
 * After Phantom signs, the bytes it RETURNED are read again: a wallet may add a
 * priority fee, and that is tolerated, but nothing else. Only SIP, ComputeBudget
 * and Ed25519SigVerify, at most four instructions, the same blockhash, signers,
 * SIP data and consent, and only the pension key's slot signed. A program the
 * relay refuses (Lighthouse, say) is named before anything is sent.
 *
 * Then, for a link, the trading wallet's co-signature is spliced into Phantom's
 * bytes: its answer must be a 64-byte signature or a transaction over the very
 * message Phantom approved.
 *
 * An investment policy may create the vault's token accounts ahead of
 * set_invest_policy: each must be exactly the CreateIdempotent the page expects,
 * paid by the pension key, for the vault and the associated address the page
 * derived itself, and Phantom's bytes must keep them as they were.
 *
 * None of this replaces /api/solana-tx: its verifier and simulation decide what
 * reaches the chain. This is the page refusing to ask for a signature it would
 * not stand behind. Client-safe and pure.
 */

import {
  ATA_PROGRAM,
  COMPUTE_BUDGET_PROGRAM,
  ED25519_PROGRAM,
  MEMO_PROGRAM,
  OWNER_TX_COMPUTE,
  OWNER_TX_MICROLAMPORTS,
  SIP_PROGRAM_ID,
  SYSTEM_PROGRAM,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  WireFormatError,
  bytesEqual,
  decodeArgs,
  isOwnerInstruction,
  isZeroSignature,
  matchInstruction,
  parseLegacyMessage,
  readComputeBudget,
  spliceSignature,
  splitWire,
  tryBase58Decode,
  type OwnerInstructionName,
  type ParsedInstruction,
  type ParsedLegacyMessage,
} from "@sip/solana-core/client";

import { FAILURE_COPY, LINK_COPY } from "@/lib/vault-copy";

export class IntentError extends Error {
  override readonly name = "IntentError";
}

/** Lighthouse's assertion program, which Phantom documents adding to some transactions. */
export const LIGHTHOUSE_PROGRAM = "L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95";

const PROGRAM_NAMES: Readonly<Record<string, string>> = {
  [SIP_PROGRAM_ID]: "SIP",
  [COMPUTE_BUDGET_PROGRAM]: "ComputeBudget",
  [ED25519_PROGRAM]: "Ed25519SigVerify",
  [LIGHTHOUSE_PROGRAM]: "Lighthouse",
  [SYSTEM_PROGRAM]: "the System program",
  [MEMO_PROGRAM]: "Memo",
  [ATA_PROGRAM]: "Associated Token Account",
  [TOKEN_PROGRAM]: "SPL Token",
  [TOKEN_2022_PROGRAM]: "Token-2022",
};

/** "Lighthouse (L2TE…)": a program's name when it is known, and its address. */
export const programLabel = (programId: string): string => (PROGRAM_NAMES[programId] !== undefined ? `${PROGRAM_NAMES[programId]} (${programId})` : programId);

const RELAYED = new Set([SIP_PROGRAM_ID, COMPUTE_BUDGET_PROGRAM, ED25519_PROGRAM]);
/** Beside set_invest_policy the relay also takes the vault's token-account creations. */
const RELAYED_WITH_TOKEN_ACCOUNTS = new Set([...RELAYED, ATA_PROGRAM]);

/** The Ed25519SigVerify header SIP writes for the 140-byte consent: one signature at 48, key at 16, message at 112 of length 140, every index u16::MAX. */
const CONSENT_HEADER = Uint8Array.from([0x01, 0x00, 0x30, 0x00, 0xff, 0xff, 0x10, 0x00, 0xff, 0xff, 0x70, 0x00, 0x8c, 0x00, 0xff, 0xff]);
const CONSENT_INSTRUCTION_BYTES = 16 + 32 + 64 + 140;

export interface ReadTransaction {
  readonly wire: Uint8Array;
  readonly signatures: readonly Uint8Array[];
  readonly message: Uint8Array;
  readonly parsed: ParsedLegacyMessage;
}

/** One CreateIdempotent the page expects ahead of set_invest_policy, every address its own. */
export interface TokenAccountCreateIntent {
  /** Who pays the rent: the pension key. */
  readonly funder: string;
  /** ATA(wallet, mint, tokenProgram), derived by the page. */
  readonly account: string;
  /** The vault, derived by the page. */
  readonly wallet: string;
  readonly mint: string;
  readonly tokenProgram: string;
}

export interface OwnerIntent {
  readonly instruction: OwnerInstructionName;
  /** Required signers in signature order; the pension key, who pays, first. */
  readonly signers: readonly string[];
  /** IDL account names the SIP instruction must hold, and the addresses they must be. */
  readonly accounts: Readonly<Record<string, string>>;
  /** The decoded arguments it must carry, exactly (bigints for u64). */
  readonly args: Readonly<Record<string, unknown>>;
  /** For link_wallet: what the Ed25519SigVerify ahead of it must carry. */
  readonly consent?: { readonly wallet: string; readonly message: Uint8Array; readonly signature: Uint8Array };
  /** For set_invest_policy: the vault token accounts created ahead of it, in order. None when absent. */
  readonly tokenAccountCreates?: readonly TokenAccountCreateIntent[];
}

const sameCreate = (a: ParsedInstruction, b: ParsedInstruction): boolean => bytesEqual(a.data, b.data) && a.accountKeys.join() === b.accountKeys.join();

function readTransaction(bytes: Uint8Array, unreadable: string): ReadTransaction {
  try {
    const parts = splitWire(bytes);
    return { wire: bytes, signatures: parts.signatures, message: parts.message, parsed: parseLegacyMessage(parts.message) };
  } catch (error) {
    if (error instanceof WireFormatError) throw new IntentError(unreadable);
    throw error;
  }
}

function sameValue(a: unknown, b: unknown): boolean {
  if (typeof a === "bigint" || typeof b === "bigint") return typeof a === typeof b && a === b;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, index) => sameValue(item, b[index]));
  if (a !== null && b !== null && typeof a === "object" && typeof b === "object") {
    const left = Object.keys(a).sort();
    const right = Object.keys(b).sort();
    return (
      left.length === right.length &&
      left.every((key, index) => key === right[index] && sameValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]))
    );
  }
  return a === b;
}

interface SipInstruction {
  readonly name: OwnerInstructionName;
  readonly index: number;
  readonly accounts: Readonly<Record<string, string>>;
  readonly args: Readonly<Record<string, unknown>>;
  readonly instruction: ParsedInstruction;
}

/** The one SIP instruction, its accounts by IDL name and its decoded arguments; a detail string when it is not one. */
function readSip(parsed: ParsedLegacyMessage): SipInstruction | string {
  const indexes = parsed.instructions.flatMap((instruction, index) => (instruction.programId === SIP_PROGRAM_ID ? [index] : []));
  if (indexes.length !== 1) return "it does not hold exactly one SIP instruction";
  const index = indexes[0]!;
  const instruction = parsed.instructions[index]!;
  const matched = matchInstruction(instruction.data);
  if (matched === null || !isOwnerInstruction(matched.name)) return "its SIP instruction is not one your pension key signs";
  if (instruction.accountKeys.length !== matched.accounts.length) return "its SIP instruction lists the wrong number of accounts";
  const accounts: Record<string, string> = {};
  for (const [position, account] of matched.accounts.entries()) {
    const at = instruction.accountKeys[position]!;
    if (account.address !== undefined && at !== account.address) return `its ${account.name} is not the program's fixed address`;
    accounts[account.name] = at;
  }
  let args: Record<string, unknown>;
  try {
    args = decodeArgs(matched.name, instruction.data);
  } catch {
    return "its SIP instruction's arguments do not decode";
  }
  return { name: matched.name, index, accounts, args, instruction };
}

function signersProblem(parsed: ParsedLegacyMessage, signatures: readonly Uint8Array[], signers: readonly string[]): string | null {
  if (parsed.header.numRequiredSignatures !== signers.length || signatures.length !== signers.length) return "it asks for other signers";
  if (signers.some((signer, index) => parsed.keys[index] !== signer)) return "its fee payer or signers are not yours";
  return null;
}

/**
 * The unsigned bytes from the build route, before any wallet sees them. Throws
 * IntentError with words; returns them read, for checkSignedIntent.
 */
export function checkBuiltIntent(bytes: Uint8Array, intent: OwnerIntent): ReadTransaction {
  const refuse = (detail: string): IntentError => new IntentError(FAILURE_COPY.builtMismatch(detail));
  const tx = readTransaction(bytes, FAILURE_COPY.unreadableBuilt);
  const { parsed } = tx;
  const signers = signersProblem(parsed, tx.signatures, intent.signers);
  if (signers !== null) throw refuse(signers);
  if (tx.signatures.some((signature) => !isZeroSignature(signature))) throw refuse("it arrived already signed");

  const creates = intent.tokenAccountCreates ?? [];
  const expected = [
    COMPUTE_BUDGET_PROGRAM,
    COMPUTE_BUDGET_PROGRAM,
    ...(intent.consent === undefined ? [] : [ED25519_PROGRAM]),
    ...creates.map(() => ATA_PROGRAM),
    SIP_PROGRAM_ID,
  ];
  const programs = parsed.instructions.map((instruction) => instruction.programId);
  if (programs.length !== expected.length || programs.some((program, index) => program !== expected[index])) throw refuse("its instructions are not the ones this action needs");
  creates.forEach((create, index) => {
    const instruction = parsed.instructions[2 + index]!;
    const keys = [create.funder, create.account, create.wallet, create.mint, SYSTEM_PROGRAM, create.tokenProgram];
    if (instruction.data.length !== 1 || instruction.data[0] !== 1 || instruction.accountKeys.length !== keys.length || instruction.accountKeys.some((key, at) => key !== keys[at])) {
      throw refuse(`its token account #${index + 1} is not your vault's own ${programLabel(create.mint)} account, paid by you`);
    }
  });

  const [limit, price] = parsed.instructions;
  const units = readComputeBudget(limit!.data);
  const microLamports = readComputeBudget(price!.data);
  if (
    limit!.accountKeys.length !== 0 ||
    price!.accountKeys.length !== 0 ||
    units?.kind !== "unitLimit" ||
    units.units !== OWNER_TX_COMPUTE[intent.instruction] ||
    microLamports?.kind !== "unitPrice" ||
    microLamports.microLamports !== OWNER_TX_MICROLAMPORTS
  ) {
    throw refuse("its compute budget is not SIP's");
  }

  const sip = readSip(parsed);
  if (typeof sip === "string") throw refuse(sip);
  if (sip.name !== intent.instruction) throw refuse(`it is ${sip.name}, not ${intent.instruction}`);
  for (const [name, address] of Object.entries(intent.accounts)) {
    if (sip.accounts[name] !== address) throw refuse(`its ${name} is not the one you expect`);
  }
  if (!sameValue(sip.args, intent.args)) throw refuse("its arguments are not the ones you chose");

  if (intent.consent !== undefined) {
    const verify = parsed.instructions[2]!;
    const data = verify.data;
    const wallet = tryBase58Decode(intent.consent.wallet);
    if (
      verify.accountKeys.length !== 0 ||
      data.length !== CONSENT_INSTRUCTION_BYTES ||
      wallet === null ||
      !bytesEqual(data.subarray(0, 16), CONSENT_HEADER) ||
      !bytesEqual(data.subarray(16, 48), wallet) ||
      !bytesEqual(data.subarray(48, 112), intent.consent.signature) ||
      !bytesEqual(data.subarray(112), intent.consent.message)
    ) {
      throw refuse("its consent check is not your trading wallet's consent");
    }
  }
  return tx;
}

/**
 * The bytes Phantom returned for `built`. A different priority fee or compute
 * limit is tolerated; anything else is refused with words, a foreign program by
 * name. Only the first signature slot may be signed.
 */
export function checkSignedIntent(bytes: Uint8Array, built: ReadTransaction, intent: OwnerIntent): ReadTransaction {
  const refuse = (detail: string): IntentError => new IntentError(FAILURE_COPY.signedMismatch(detail));
  const tx = readTransaction(bytes, FAILURE_COPY.unreadableSigned);
  const { parsed } = tx;
  const creates = intent.tokenAccountCreates ?? [];
  const relayed = creates.length > 0 ? RELAYED_WITH_TOKEN_ACCOUNTS : RELAYED;
  const foreign = parsed.instructions.find((instruction) => !relayed.has(instruction.programId));
  if (foreign !== undefined) throw new IntentError(FAILURE_COPY.foreignProgram(programLabel(foreign.programId)));
  if (parsed.instructions.length > 4 + creates.length) throw refuse("it holds more instructions than SIP relays");
  const signers = signersProblem(parsed, tx.signatures, intent.signers);
  if (signers !== null) throw refuse(signers);
  if (parsed.recentBlockhash !== built.parsed.recentBlockhash) throw refuse("its blockhash changed");
  if (isZeroSignature(tx.signatures[0]!)) throw refuse("the pension key's signature is missing");
  if (tx.signatures.slice(1).some((signature) => !isZeroSignature(signature))) throw refuse("another key has already signed");

  const now = readSip(parsed);
  const before = readSip(built.parsed);
  if (typeof now === "string") throw refuse(now);
  if (typeof before === "string") throw refuse(before);
  if (!bytesEqual(now.instruction.data, before.instruction.data) || now.instruction.accountKeys.join() !== before.instruction.accountKeys.join()) {
    throw refuse("its SIP instruction changed");
  }

  const createsNow = parsed.instructions.flatMap((instruction, index) => (instruction.programId === ATA_PROGRAM ? [{ instruction, index }] : []));
  const createsBefore = built.parsed.instructions.filter((instruction) => instruction.programId === ATA_PROGRAM);
  if (
    createsNow.length !== createsBefore.length ||
    createsNow.some((create, at) => create.index > now.index || !sameCreate(create.instruction, createsBefore[at]!))
  ) {
    throw refuse("its token account creations changed");
  }

  const verifies = parsed.instructions.filter((instruction) => instruction.programId === ED25519_PROGRAM);
  if (intent.consent === undefined) {
    if (verifies.length > 0) throw refuse("it gained a signature check");
  } else {
    const consentNow = parsed.instructions[now.index - 1];
    const consentBefore = built.parsed.instructions[before.index - 1];
    if (verifies.length !== 1 || consentNow?.programId !== ED25519_PROGRAM || consentBefore === undefined || !bytesEqual(consentNow.data, consentBefore.data)) {
      throw refuse("its consent check changed");
    }
  }
  return tx;
}

/**
 * Phantom's signed bytes with the trading wallet's signature in slot 1. The
 * trading wallet may answer a 64-byte signature, or a whole transaction; a whole
 * transaction must be over Phantom's exact message, keep or leave empty
 * Phantom's slot, and carry its own.
 */
export function mergeCoSignature(phantomBytes: Uint8Array, tradingAnswer: Uint8Array): Uint8Array {
  const refuse = (): IntentError => new IntentError(LINK_COPY.coSignMismatch);
  if (!(tradingAnswer instanceof Uint8Array)) throw refuse();
  if (tradingAnswer.length === 64) {
    if (isZeroSignature(tradingAnswer)) throw refuse();
    return spliceSignature(phantomBytes, 1, tradingAnswer);
  }
  let phantom;
  let trading;
  try {
    phantom = splitWire(phantomBytes);
    trading = splitWire(tradingAnswer);
  } catch {
    throw refuse();
  }
  if (phantom.signatures.length !== 2 || trading.signatures.length !== 2 || !bytesEqual(phantom.message, trading.message)) throw refuse();
  const [phantomSlot0] = phantom.signatures;
  const [tradingSlot0, tradingSlot1] = trading.signatures;
  if (!(bytesEqual(tradingSlot0!, phantomSlot0!) || isZeroSignature(tradingSlot0!)) || isZeroSignature(tradingSlot1!)) throw refuse();
  return spliceSignature(phantomBytes, 1, tradingSlot1!);
}
