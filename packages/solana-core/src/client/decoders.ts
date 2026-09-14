// Account and event decoders for the sip_vault program, V2 layouts, over the
// IDL-driven codec. Browser-safe.
//
// The logic is Nuvem's (packages/solana-core/src/solana.ts decodeVault,
// decodeTradingLink, decodeInvestmentPolicy): exact size first, then the 8-byte
// discriminator, then fields. What changed is where the layout comes from — the
// IDL, not offsets — and what is read: the V2 vault fields Nuvem never decoded
// (skim_mode, volume_bps, policy_nonce, max_contribution, wallet_reserve), the
// policy's in_mint (which moved the legs from byte 77 to 109), ProtocolConfig
// (whose `paused` gates settle, link_wallet and invest for everyone) and the
// Settled event with its appended link_epoch, session_start_slot and
// policy_nonce. The program is a fresh deployment, so no event without them
// exists under its id: a 9-field body is refused, not read short.
//
// Integers above u32 are bigints. Decimal strings are the route boundary's job.
// Field names are the IDL's in camelCase (max_rolling_30d → maxRolling30d, not
// Anchor's maxRolling30D); `_reserved` fields are dropped. test/decoders.test.ts
// checks every key against the IDL, so a renamed field cannot vanish silently.

import { accountSpace, decodeStruct } from "./borsh";
import { accountDiscriminator, bytesEqual, eventDiscriminator, toHex } from "./idl";

export class DecodeError extends Error {
  override readonly name = "DecodeError";
}

/** snake_case → camelCase, digits kept as they are: max_rolling_30d → maxRolling30d. */
export const snakeToCamel = (name: string): string => name.replace(/_([a-z0-9])/g, (_, char: string) => char.toUpperCase());

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;

function camelize(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key.startsWith("_")) continue;
    out[snakeToCamel(key)] = isPlainObject(value)
      ? camelize(value)
      : Array.isArray(value)
        ? value.map((item) => (isPlainObject(item) ? camelize(item) : item))
        : value;
  }
  return out;
}

const memo = new Map<string, number>();
const spaceOf = (name: string): number => {
  let space = memo.get(name);
  if (space === undefined) {
    space = accountSpace(name);
    memo.set(name, space);
  }
  return space;
};

/** Account sizes Anchor allocates, computed from the IDL (and IDL_VEC_MAX_LEN) on first use. */
export const SIP_ACCOUNT_SPACE = {
  get Vault(): number {
    return spaceOf("Vault");
  },
  get TradingLink(): number {
    return spaceOf("TradingLink");
  },
  get InvestmentPolicy(): number {
    return spaceOf("InvestmentPolicy");
  },
  get ProtocolConfig(): number {
    return spaceOf("ProtocolConfig");
  },
};

export type SipAccountName = keyof typeof SIP_ACCOUNT_SPACE;

function decodeAccount(name: SipAccountName, data: Uint8Array): Record<string, unknown> {
  if (!(data instanceof Uint8Array)) throw new DecodeError(`${name}: expected bytes`);
  const space = spaceOf(name);
  if (data.length !== space) throw new DecodeError(`${name} account is ${data.length} bytes, expected ${space}`);
  const head = data.subarray(0, 8);
  if (!bytesEqual(head, accountDiscriminator(name))) {
    throw new DecodeError(`not a ${name} account (discriminator ${toHex(head)})`);
  }
  try {
    // A vec-bearing account (the policy) ends before its space; the tail may
    // hold stale bytes from an earlier, longer basket, so it is not inspected.
    return camelize(decodeStruct(name, data, 8).value);
  } catch (error) {
    throw new DecodeError(`${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export interface VaultState {
  readonly owner: string;
  readonly bump: number;
  readonly version: number;
  readonly paused: boolean;
  /** Profit rate, bps (201..=10000). */
  readonly skimBps: number;
  readonly lifetimeSaved: bigint;
  /** Unix seconds (i64). */
  readonly createdAt: bigint;
  /** 0 profit, 1 volume. */
  readonly skimMode: number;
  /** Volume rate, bps (1..=200). */
  readonly volumeBps: number;
  readonly policyNonce: bigint;
  readonly maxContribution: bigint;
  readonly walletReserve: bigint;
}

export interface TradingLinkState {
  readonly wallet: string;
  readonly vault: string;
  /** Slot of link creation. */
  readonly epoch: bigint;
  readonly settlementNonce: bigint;
  readonly frontierSlot: bigint;
  readonly bump: number;
}

export interface InvestmentLegState {
  readonly mint: string;
  readonly weightBps: number;
  readonly minOutRateWad: bigint;
}

export interface InvestmentPolicyState {
  readonly vault: string;
  readonly enabled: boolean;
  readonly venueProgram: string;
  readonly inMint: string;
  readonly legs: readonly InvestmentLegState[];
  readonly minConvertRateWad: bigint;
  readonly minInvestment: bigint;
  readonly maxPerCall: bigint;
  readonly maxRolling30d: bigint;
  readonly bucketDays: readonly number[];
  readonly bucketAmounts: readonly bigint[];
  readonly lifetimeInvested: bigint;
  readonly policyNonce: bigint;
  readonly bump: number;
}

export interface ProtocolConfigState {
  readonly authority: string;
  readonly attester: string;
  readonly bump: number;
  /** The default key means no keeper: owner-only cranking. */
  readonly keeper: string;
  /** The default key means no transfer is pending. */
  readonly pendingAuthority: string;
  /** Protocol-wide pause: settle, link_wallet, wrap_sol, convert and invest stop; withdrawals and an owner's unlink never do. */
  readonly paused: boolean;
  readonly version: number;
}

export interface SettledEvent {
  readonly vault: string;
  readonly wallet: string;
  readonly mode: number;
  readonly baseLamports: bigint;
  readonly bps: number;
  /** What the attested base and rate come to. */
  readonly owed: bigint;
  /** What actually moved, after max_contribution. */
  readonly paid: bigint;
  /** Restarts at zero when a link is re-created: (wallet, linkEpoch, settlementNonce) is unique, (wallet, settlementNonce) is not. */
  readonly settlementNonce: bigint;
  readonly sessionEndSlot: bigint;
  /** The link's birth slot (TradingLink.epoch) the attestation signed. Appended, so every field above keeps its offset. */
  readonly linkEpoch: bigint;
  /** The first slot of the settled window. */
  readonly sessionStartSlot: bigint;
  /** The vault's policy nonce the attestation signed. */
  readonly policyNonce: bigint;
}

export const decodeVault = (data: Uint8Array): VaultState => decodeAccount("Vault", data) as unknown as VaultState;

export const decodeTradingLink = (data: Uint8Array): TradingLinkState =>
  decodeAccount("TradingLink", data) as unknown as TradingLinkState;

export const decodeInvestmentPolicy = (data: Uint8Array): InvestmentPolicyState =>
  decodeAccount("InvestmentPolicy", data) as unknown as InvestmentPolicyState;

export const decodeProtocolConfig = (data: Uint8Array): ProtocolConfigState =>
  decodeAccount("ProtocolConfig", data) as unknown as ProtocolConfigState;

/** The bytes of one `Program data:` log line (discriminator + body), or throws. */
export function decodeSettledEvent(data: Uint8Array): SettledEvent {
  const head = data.subarray(0, 8);
  if (data.length < 8 || !bytesEqual(head, eventDiscriminator("Settled"))) {
    throw new DecodeError(`not a Settled event (discriminator ${toHex(head)})`);
  }
  let decoded: { value: Record<string, unknown>; end: number };
  try {
    decoded = decodeStruct("Settled", data, 8);
  } catch (error) {
    throw new DecodeError(`Settled: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (decoded.end !== data.length) throw new DecodeError(`Settled: ${data.length - decoded.end} trailing bytes`);
  return camelize(decoded.value) as unknown as SettledEvent;
}
