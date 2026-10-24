// Which keeper does what, and what each on-chain mode needs from it: ONE TABLE.
//
// WHY A TABLE AND NOT A TERNARY. Until this file the role was a two-way branch
// written out at every place it mattered — the lock, the doorbell, the alert
// prefix, the crank alert, which vaults get a signer, which modes are settled,
// who invests, the banner — each one "volume, else profit". KeeperRole was
// already a union, and readRole already refused any third value read from the
// environment, so the trap was not in configuration but in code: a third member
// added to the union lands in the ELSE branch of every one of those comparisons,
// and TypeScript does not flag a ternary. That third role would have claimed the
// profit keeper's lock, settled PROFIT vaults and invested every vault, which is
// the profit keeper's whole job done twice, by a service that was deployed to do
// something else.
//
// A Record over the union cannot fall through. ROLE_PROFILES `satisfies
// Record<KeeperRole, RoleProfile>`, so a role added to KeeperRole without a
// profile is a compile error, and the image's typecheck gate stops it before a
// deploy; test/role-registry.test.ts holds that with a @ts-expect-error that tsc
// itself checks. Every call site reads its answer out of the profile instead of
// comparing the role to a literal, and test/role-registry.test.ts reads the
// source to keep it that way.
//
// A PURE REFACTOR, AND IT HAS TO STAY ONE TO BE TRUSTED. Every value below is
// what the branch it replaced produced, byte for byte: the lock NAMES (their
// advisory keys are derived from them, so a changed character is a different
// lock, and two keepers acting at once during the next deploy), the alert prefix,
// the /status strings, the banner. The tests pin each one to the literal the
// branch held at 7779289.
//
// IT IMPORTS NOTHING AT RUN TIME. config.ts, singleton.ts and status.ts read it,
// and config.ts is loaded by bin/alert-test.mts, which never loads the program's
// scripts. So the mode bytes are written here as literals rather than imported
// from program-scripts.ts — whose import drags in @sip/solana-program's Jupiter
// and Raydium modules — and test/role-registry.test.ts holds them equal to the
// program's numbering, as src/global-stats.ts already does with its own copy.

import type { VaultState } from "./accounts.js";

/** Which keeper this process is: SIP_SOLANA_ROLE (config.ts, readRole). */
export type KeeperRole = "profit" | "volume";

/** The role an unset or empty SIP_SOLANA_ROLE means: every deployment before the volume keeper existed. */
export const DEFAULT_KEEPER_ROLE: KeeperRole = "profit";

/**
 * The program's skim_mode numbering (state.rs; MODE_PROFIT, MODE_VOLUME,
 * MODE_ROUNDUP and MODE_FIXED in @sip/solana-program/attestation), the only bytes
 * any sip-vault version defines. Literals for the reason in this file's header;
 * a test pins them to the program's.
 *
 * 2 AND 3 EXIST ONLY ON THE UPGRADED PROGRAM (set_policy_v3 and settle_v3, ADR
 * §5.4). The binary on mainnet today refuses both, so no vault reports them
 * until the upgrade lands; after it, only set_policy_v3 writes them.
 */
export const MODE_PROFIT_BYTE = 0;
export const MODE_VOLUME_BYTE = 1;
export const MODE_ROUNDUP_BYTE = 2;
export const MODE_FIXED_BYTE = 3;

/** A skim_mode byte this keeper has an entry for. A vault may report any byte; only these mean something. */
export type ModeByte = typeof MODE_PROFIT_BYTE | typeof MODE_VOLUME_BYTE | typeof MODE_ROUNDUP_BYTE | typeof MODE_FIXED_BYTE;

/** The per-trade bytes: settled by settle_v3, never by settle_v2 (ADR §5.4's guard). */
export type PerTradeModeByte = typeof MODE_ROUNDUP_BYTE | typeof MODE_FIXED_BYTE;

/** Whether a vault's byte is a per-trade mode (ROUND-UP or FIXED). Any number: a vault's byte is whatever the chain says. */
export function isPerTradeMode(byte: number): byte is PerTradeModeByte {
  return byte === MODE_ROUNDUP_BYTE || byte === MODE_FIXED_BYTE;
}

/**
 * A real probe on every sweep, which is what every mode gets today.
 *
 * ZERO MILLISECONDS BETWEEN PROBES, read as "at least this long since the last
 * real probe": every sweep qualifies. A named constant rather than a bare 0 so
 * the per-mode cadence the dispatcher design asks for (PMC: ten minutes for the
 * per-trade modes, whose settles wait an hour anyway) is a value change in one
 * row, and so a reader does not take 0 for "never".
 */
export const EVERY_SWEEP = 0;

/**
 * THE PER-MODE PROBE CADENCE OF THE PER-TRADE MODES (ADR §2.3.7, §5.5; plan
 * P4): ten minutes. A per-trade span settles on its own clock
 * (PER_TRADE_MAX_WAIT_SECONDS) or its size, so probing such a link more often
 * than this buys nothing but reads. A dispatcher worker that completes a resting
 * per-trade vault makes it due again this soon at the latest
 * (src/worker-job.ts, completionFor), where every other vault waits for the
 * safety pass.
 */
export const PER_TRADE_PROBE_EVERY_MS = 10 * 60_000;

/**
 * The per-trade clock: one hour at launch, to move to six once Privy signatures
 * pass 60 % of the free tier (ADR §5.5, owner decision 16). A per-trade span
 * settles once its oldest charged trade is this old, whatever it owes.
 */
export const PER_TRADE_MAX_WAIT_SECONDS = 3_600;

/**
 * What a vault in one mode needs from the keeper that settles it.
 *
 * ONE ENTRY PER ON-CHAIN BYTE. A new mode is a new byte (a program upgrade that
 * signs its meaning), then a row here, then a profile that settles it — and
 * until that last step the byte rests at UNSUPPORTED_MODE before any RPC call,
 * which test/settle-tick.test.ts pins.
 */
export interface KeeperMode {
  readonly byte: ModeByte;
  /** How /status and the logs name it: "this vault saves in PROFIT mode". */
  readonly name: string;
  /**
   * The vault field settle_v2 charges at in this mode, as state.rs's
   * `Vault::active_bps` reads it. DESCRIPTIVE: activeBps (settle-decision.ts)
   * keeps the program's own branch, and a test holds this column to it.
   *
   * NULL FOR THE PER-TRADE MODES, which charge no rate: settle_v3 checks a
   * per-trade amount, and settle_v2 refuses them (ModeNeedsSettleV3). activeBps
   * still reads skim_bps for them, because that is what active_bps() does for any
   * byte but 1 (ADR §5.6, Trap 1; pinned by T-O3).
   */
  readonly rateField: keyof Pick<VaultState, "skimBps" | "volumeBps"> | null;
  /**
   * Where the attested base comes from: the wallet's balance chain (a PROFIT
   * span's profit, src/measure-window.ts) or the notional its trades moved (a
   * VOLUME span, src/measure-volume.ts and src/volume-base.ts). bin/keeper.mts
   * hands a turn the volume probe and base seam exactly when this is
   * "trade-notional" and its own profile settles the byte.
   *
   * "per-trade": the same probe's trades, each charged on its own — rounded up
   * to the unit at its own price (ROUND-UP) or a fixed amount (FIXED) — by
   * src/per-trade-base.ts, and settled through settle_v3. No legacy role settles
   * it; only a dispatcher worker does, and only under SIP_SOLANA_EXTRA_MODES
   * (src/settle-modules.ts).
   */
  readonly base: "balance-chain" | "trade-notional" | "per-trade";
  /**
   * Whether a losing span's loss is carried into the next window
   * (settle-decision.ts, baseDecision). DESCRIPTIVE, like rateField, and held to
   * baseDecision by a test: a notional is never negative, so there is nothing
   * to carry.
   */
  readonly carriesLosses: boolean;
  /**
   * THE PER-MODE PROBE CADENCE (PMC). The shortest interval between two real
   * probes of a link resting in this mode. PROFIT and VOLUME are EVERY_SWEEP,
   * which is what settle-tick.ts does with no cadence at all, and nothing a
   * legacy keeper runs reads this field. The per-trade modes are
   * PER_TRADE_PROBE_EVERY_MS, which a dispatcher worker reads as the latest a
   * resting per-trade vault is due again (src/worker-job.ts, completionFor).
   */
  readonly realProbeEveryMs: number;
  /**
   * The longest a per-trade mode's oldest charged trade waits before its span
   * settles on the clock (PER_TRADE_MAX_WAIT_SECONDS). Null for PROFIT and
   * VOLUME, which settle on their own rule (a profit, or VOLUME's cadence in
   * src/volume-base.ts).
   */
  readonly perTradeMaxWaitSeconds: number | null;
}

/** Every mode this keeper knows, by byte. */
export const KEEPER_MODES = {
  [MODE_PROFIT_BYTE]: {
    byte: MODE_PROFIT_BYTE,
    name: "PROFIT",
    rateField: "skimBps",
    base: "balance-chain",
    carriesLosses: true,
    realProbeEveryMs: EVERY_SWEEP,
    perTradeMaxWaitSeconds: null,
  },
  [MODE_VOLUME_BYTE]: {
    byte: MODE_VOLUME_BYTE,
    name: "VOLUME",
    rateField: "volumeBps",
    base: "trade-notional",
    carriesLosses: false,
    realProbeEveryMs: EVERY_SWEEP,
    perTradeMaxWaitSeconds: null,
  },
  // THE PER-TRADE MODES (ADR §5): no legacy role settles them — ROLE_PROFILES
  // below is unchanged — so a legacy keeper rests such a vault at
  // UNSUPPORTED_MODE before any RPC call (T-O1, T-O2), and a dispatcher worker
  // settles one only under SIP_SOLANA_EXTRA_MODES (src/settle-modules.ts).
  [MODE_ROUNDUP_BYTE]: {
    byte: MODE_ROUNDUP_BYTE,
    name: "ROUND-UP",
    rateField: null,
    base: "per-trade",
    carriesLosses: false,
    realProbeEveryMs: PER_TRADE_PROBE_EVERY_MS,
    perTradeMaxWaitSeconds: PER_TRADE_MAX_WAIT_SECONDS,
  },
  [MODE_FIXED_BYTE]: {
    byte: MODE_FIXED_BYTE,
    name: "FIXED",
    rateField: null,
    base: "per-trade",
    carriesLosses: false,
    realProbeEveryMs: PER_TRADE_PROBE_EVERY_MS,
    perTradeMaxWaitSeconds: PER_TRADE_MAX_WAIT_SECONDS,
  },
} as const satisfies Record<ModeByte, KeeperMode>;

/**
 * The entry for a byte a vault reported, or null when no sip-vault version
 * defines it.
 *
 * OWN KEYS ONLY. A vault's byte is a number off the chain, and `in` would also
 * find whatever an object inherits; hasOwn reads the table and nothing else.
 */
export function keeperModeFor(byte: number): KeeperMode | null {
  return Object.hasOwn(KEEPER_MODES, byte) ? KEEPER_MODES[byte as ModeByte] : null;
}

/**
 * Which wallets a keeper resolves a signer for.
 *
 *   * "every-vault": every linked wallet, whatever its vault's mode. The profit
 *     keeper does this: its seat alerts and its /status signing routes are the
 *     ones that cover the whole fleet.
 *   * "settled-modes": only wallets whose vault is in a mode this keeper settles.
 *     Resolving the others would repeat the profit keeper's seat alerts for the
 *     same wallets and spend Privy calls on turns that stop at the mode.
 *
 * A vault the sweep could not read is resolved by every keeper; bin/keeper.mts
 * decides that before asking here, because "unread" is a fact about the sweep,
 * not about the role.
 */
export type SignerScope = "every-vault" | "settled-modes";

interface RoleProfileBase {
  /** The skim_mode bytes this role settles. No byte is settled by two profiles (test). */
  readonly settles: readonly ModeByte[];
  /**
   * The Postgres advisory lock's NAME (src/singleton.ts derives the key from it).
   * Each role its own: one role never waits on, or takes over, another's.
   * BYTE-IDENTICAL to 7779289 forever, or a deploy runs two acting keepers.
   */
  readonly lockName: string;
  /** In front of every alert title this keeper fires, in the one chat both keepers send to; null for none. */
  readonly alertTitlePrefix: string | null;
  /**
   * Whether this role may run the doorbell (a Helius webhook for its own URL).
   * One per deployment, and it is the profit keeper's: a role that may not
   * reads no doorbell setting, and REFUSES TO START where the doorbell secret is
   * set (config.ts), because that secret on it means the role was set on the
   * wrong service.
   */
  readonly doorbellAllowed: boolean;
  /** Whether this role watches the crank's balance: the role that spends it. */
  readonly crankAlert: boolean;
  readonly signerScope: SignerScope;
  /**
   * Whether a DRY RUN of this role describes, for a PROFIT vault it does not
   * settle, what VOLUME mode would charge (src/volume-preview.ts). An acting
   * keeper never does: it would spend reads describing vaults that are not its
   * job.
   */
  readonly dryRunPreview: boolean;
  /**
   * Whether this role computes the public rankings and the dashboard's stats
   * (/leaderboard). One per deployment, the profit keeper's: the web reads that
   * one (SIP_SOLANA_KEEPER_URL). A second role ran the same full-scan
   * aggregates every 120 s for a page nobody fetched from it — the database's
   * load doubled, the answer did not change.
   */
  readonly ranks: boolean;
  /** The `role` field of the "keeper starting" line. */
  readonly banner: string;
}

/**
 * Everything that differs between the keepers, as data.
 *
 * INVESTING IS THE DISCRIMINANT. Exactly one profile invests, and it invests
 * EVERY vault, whatever its mode, so each vault has exactly one keeper buying
 * for it (test). A profile that does not invest must say what /status's invest
 * column reads instead, so the type itself asks for that string rather than a
 * call site defaulting it.
 */
export type RoleProfile = RoleProfileBase &
  (
    | { readonly invests: true }
    | {
        readonly invests: false;
        /** What /status's `invest` column reads for every wallet on this keeper. */
        readonly notInvesting: string;
      }
  );

/**
 * The profit keeper's lock: the name every deployment claimed before the volume
 * keeper existed. Re-exported by src/singleton.ts, its historical home, like
 * the one below.
 */
export const KEEPER_LOCK_NAME = "sip-solana-keeper";

/**
 * The volume keeper's lock: ANOTHER NAME, so the two services on one database
 * each hold their own. Under one name the volume keeper would never act while
 * the profit keeper held it, and during a handover it could take the profit
 * keeper's place. Each lock still keeps two replicas of one role from acting.
 */
export const VOLUME_KEEPER_LOCK_NAME = "sip-solana-volume-keeper";

/** Every role, as data. A role without a row is a compile error (`satisfies`). */
export const ROLE_PROFILES = {
  profit: {
    settles: [MODE_PROFIT_BYTE],
    invests: true,
    lockName: KEEPER_LOCK_NAME,
    alertTitlePrefix: null,
    doorbellAllowed: true,
    crankAlert: true,
    signerScope: "every-vault",
    dryRunPreview: false,
    ranks: true,
    banner: "profit keeper — settles PROFIT vaults, invests every vault",
  },
  volume: {
    settles: [MODE_VOLUME_BYTE],
    invests: false,
    notInvesting: "none (volume keeper)",
    lockName: VOLUME_KEEPER_LOCK_NAME,
    alertTitlePrefix: "[volume] ",
    doorbellAllowed: false,
    crankAlert: false,
    signerScope: "settled-modes",
    dryRunPreview: true,
    ranks: false,
    banner: "volume keeper — settles VOLUME vaults only, never invests",
  },
} as const satisfies Record<KeeperRole, RoleProfile>;

/**
 * FROZEN, NOT ONLY READONLY. `as const` is a promise to the compiler; these
 * objects are handed out by reference — keeperModes returns a profile's own
 * `settles`, where the ternary it replaced built a fresh array per call — so a
 * caller that cast the readonly away could otherwise rewrite which modes a
 * keeper settles for the rest of the process.
 */
for (const profile of Object.values(ROLE_PROFILES)) Object.freeze(Object.freeze(profile).settles);
Object.freeze(ROLE_PROFILES);
for (const mode of Object.values(KEEPER_MODES)) Object.freeze(mode);
Object.freeze(KEEPER_MODES);

/** The profile of a role, typed as the union so a caller narrows on `invests` rather than on the role. */
export function roleProfile(role: KeeperRole): RoleProfile {
  return ROLE_PROFILES[role];
}

/** Every role, in the table's order. */
export const KEEPER_ROLES: readonly KeeperRole[] = Object.keys(ROLE_PROFILES) as KeeperRole[];

/** Whether a string names a role. Own keys only: "constructor" is not a keeper. */
export function isKeeperRole(value: string): value is KeeperRole {
  return Object.hasOwn(ROLE_PROFILES, value);
}

/** Whether this profile settles a vault reporting this byte. Any number: a vault's byte is whatever the chain says. */
export function settlesMode(profile: RoleProfile, byte: number): boolean {
  return (profile.settles as readonly number[]).includes(byte);
}

/**
 * The legacy roles that settle a byte: one each for PROFIT and VOLUME, none for
 * the per-trade bytes — which only a dispatcher worker's module settles — and
 * none for a byte no sip-vault version defines (test). A list rather than one
 * role so the test that no byte has two can read it.
 */
export function rolesSettling(byte: number): readonly KeeperRole[] {
  return KEEPER_ROLES.filter((role) => settlesMode(ROLE_PROFILES[role], byte));
}

/**
 * Whether this keeper resolves a signer for a wallet whose vault reports this
 * byte. `undefined` is a vault the sweep read and did not find; a vault it
 * could not read at all is the caller's to resolve (SignerScope).
 */
export function resolvesSignerFor(profile: RoleProfile, byte: number | undefined): boolean {
  switch (profile.signerScope) {
    case "every-vault":
      return true;
    case "settled-modes":
      return byte !== undefined && settlesMode(profile, byte);
    default:
      return unreachable(profile.signerScope);
  }
}

/**
 * What a turn of this keeper measures for a vault in this byte: the vault's
 * mode's base source when this profile settles it, and null when it does not
 * (the turn stops at modeDecision before measuring anything).
 */
export function measuredBase(profile: RoleProfile, byte: number): KeeperMode["base"] | null {
  return settlesMode(profile, byte) ? (keeperModeFor(byte)?.base ?? null) : null;
}

/**
 * Whether any mode this role settles carries a loss forward (carriesLosses):
 * only such a keeper has anything to keep in a loss-carry store
 * (SIP_SOLANA_CARRY_STORE, src/carry-store.ts). The profit keeper does; the
 * volume keeper settles VOLUME alone, which carries none.
 */
export function roleCarriesLosses(role: KeeperRole): boolean {
  return ROLE_PROFILES[role].settles.some((byte) => keeperModeFor(byte)?.carriesLosses === true);
}

/** The compile-time end of a switch over a closed union: reached only by a value the union does not have. */
export function unreachable(value: never): never {
  throw new Error(`unreachable: ${String(value)}`);
}
