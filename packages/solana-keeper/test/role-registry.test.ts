// THE ROLE AND MODE REGISTRY (src/role-registry.ts): what each keeper does, as
// data, and the proof that moving it there changed nothing.
//
// TWO KINDS OF TEST LIVE HERE, AND THEY ARE NOT THE SAME KIND.
//
//   * THE INVARIANTS the dispatcher design names (exactly one profile invests,
//     no byte settled twice, lock names unchanged, an unserved byte stops before
//     any RPC). They hold for any registry, including the next one.
//   * THE PINS: every string and flag a two-way branch produced at 7779289,
//     written out as the literal it was. The refactor is only "pure" if each of
//     these still comes out byte for byte, and the lock names most of all — their
//     advisory keys are derived from them, so one changed character is a
//     different lock, and the next deploy runs two acting keepers.
//
// AND ONE THAT IS NEITHER: the source is read, so that a comparison of the role
// against a literal cannot come back. A ternary over a two-member union is
// exactly what TypeScript does not flag.

import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { Redactor } from "@sip/solana-log";
import { describe, expect, it } from "vitest";
import type { VaultState } from "../src/accounts.js";
import { loadConfig, readRole } from "../src/config.js";
import { SIP_PROGRAM_ID } from "../src/idl.js";
import type { WindowMeasurement } from "../src/measure-window.js";
import { MODE_FIXED, MODE_PROFIT, MODE_ROUNDUP, MODE_VOLUME } from "../src/program-scripts.js";
import {
  EVERY_SWEEP,
  KEEPER_MODES,
  KEEPER_ROLES,
  MODE_FIXED_BYTE,
  MODE_PROFIT_BYTE,
  MODE_ROUNDUP_BYTE,
  MODE_VOLUME_BYTE,
  PER_TRADE_MAX_WAIT_SECONDS,
  PER_TRADE_PROBE_EVERY_MS,
  ROLE_PROFILES,
  isPerTradeMode,
  isKeeperRole,
  keeperModeFor,
  measuredBase,
  resolvesSignerFor,
  roleProfile,
  rolesSettling,
  type KeeperMode,
  type KeeperRole,
  type RoleProfile,
} from "../src/role-registry.js";
import { activeBps, baseDecision, keeperModes, modeDecision, type VolumeBase } from "../src/settle-decision.js";
import { KEEPER_LOCK_NAME, VOLUME_KEEPER_LOCK_NAME, advisoryKeyFor, lockNameFor } from "../src/singleton.js";

const PACKAGE = fileURLToPath(new URL("..", import.meta.url));
const MODES: readonly KeeperMode[] = Object.values(KEEPER_MODES);
/** The modes a legacy role settles: every byte but the per-trade ones, which only a dispatcher worker's module settles. */
const LEGACY_MODES: readonly KeeperMode[] = MODES.filter((mode) => mode.base !== "per-trade");
/** Every byte a vault could report, so "no byte" claims are about all 256 of them. */
const EVERY_BYTE = Array.from({ length: 256 }, (_, byte) => byte);

describe("registry: the invariants", () => {
  it("registry: exactly one profile invests", () => {
    const investing = KEEPER_ROLES.filter((role) => roleProfile(role).invests);
    expect(investing).toEqual(["profit"]);
  });

  it("registry: no mode byte is settled by two profiles", () => {
    for (const byte of EVERY_BYTE) expect(rolesSettling(byte).length, `skim_mode ${byte}`).toBeLessThanOrEqual(1);
    // AND EVERY LEGACY BYTE HAS ITS ONE KEEPER: a mode nobody settles is a vault
    // that rests at UNSUPPORTED_MODE forever.
    for (const mode of LEGACY_MODES) expect(rolesSettling(mode.byte), mode.name).toHaveLength(1);
    // T-O1: NO LEGACY ROLE SETTLES A PER-TRADE BYTE. Only a dispatcher worker's
    // module does, and only under SIP_SOLANA_EXTRA_MODES (test/settle-modules.test.ts).
    for (const byte of [MODE_ROUNDUP_BYTE, MODE_FIXED_BYTE]) expect(rolesSettling(byte), `skim_mode ${byte}`).toEqual([]);
    // A profile settles only bytes a sip-vault version defines.
    for (const role of KEEPER_ROLES) for (const byte of ROLE_PROFILES[role].settles) expect(keeperModeFor(byte), `${role} settles ${byte}`).not.toBeNull();
  });

  it("registry: lock names are byte-identical to 7779289", () => {
    expect(ROLE_PROFILES.profit.lockName).toBe("sip-solana-keeper");
    expect(ROLE_PROFILES.volume.lockName).toBe("sip-solana-volume-keeper");
    // Through every name a reader already used.
    expect(KEEPER_LOCK_NAME).toBe("sip-solana-keeper");
    expect(VOLUME_KEEPER_LOCK_NAME).toBe("sip-solana-volume-keeper");
    expect(lockNameFor("profit")).toBe("sip-solana-keeper");
    expect(lockNameFor("volume")).toBe("sip-solana-volume-keeper");
    // AND THE KEYS POSTGRES ACTUALLY LOCKS, written out as computed at 7779289:
    // the name is only the input, and the deploy overlap is decided on these.
    expect(advisoryKeyFor(ROLE_PROFILES.profit.lockName)).toBe(4477756734530440532n);
    expect(advisoryKeyFor(ROLE_PROFILES.volume.lockName)).toBe(1982498693622035255n);
    // One lock per role.
    expect(new Set(KEEPER_ROLES.map((role) => ROLE_PROFILES[role].lockName)).size).toBe(KEEPER_ROLES.length);
  });

  it("registry: the tables are frozen, since they are handed out by reference", () => {
    expect(Object.isFrozen(ROLE_PROFILES)).toBe(true);
    expect(Object.isFrozen(KEEPER_MODES)).toBe(true);
    for (const role of KEEPER_ROLES) {
      expect(Object.isFrozen(ROLE_PROFILES[role]), role).toBe(true);
      expect(Object.isFrozen(keeperModes(role)), `keeperModes(${role})`).toBe(true);
    }
    for (const mode of MODES) expect(Object.isFrozen(mode), mode.name).toBe(true);
  });

  it("registry: the mode bytes are the program's own numbering", () => {
    expect(MODE_PROFIT_BYTE).toBe(MODE_PROFIT);
    expect(MODE_VOLUME_BYTE).toBe(MODE_VOLUME);
    expect(MODE_ROUNDUP_BYTE).toBe(MODE_ROUNDUP);
    expect(MODE_FIXED_BYTE).toBe(MODE_FIXED);
    for (const byte of EVERY_BYTE) expect(isPerTradeMode(byte), `skim_mode ${byte}`).toBe(byte === MODE_ROUNDUP || byte === MODE_FIXED);
    for (const [key, mode] of Object.entries(KEEPER_MODES)) expect(String(mode.byte)).toBe(key);
  });

  it("registry: a byte no sip-vault version defines has no mode, own keys only", () => {
    for (const byte of EVERY_BYTE) expect(keeperModeFor(byte) === null, `skim_mode ${byte}`).toBe(byte > MODE_FIXED);
  });
});

describe("registry: the pins (each value the two-way branch produced at 7779289)", () => {
  it("the profit keeper: settles PROFIT, invests, holds the doorbell, watches the crank, resolves every signer, previews nothing", () => {
    const profit: RoleProfile = ROLE_PROFILES.profit;
    expect(profit).toEqual({
      settles: [0],
      invests: true,
      lockName: "sip-solana-keeper",
      alertTitlePrefix: null,
      doorbellAllowed: true,
      crankAlert: true,
      signerScope: "every-vault",
      dryRunPreview: false,
      banner: "profit keeper — settles PROFIT vaults, invests every vault",
    });
  });

  it("the volume keeper: settles VOLUME, never invests, no doorbell, no crank alert, its own vaults' signers, a dry-run preview", () => {
    expect(ROLE_PROFILES.volume).toEqual({
      settles: [1],
      invests: false,
      notInvesting: "none (volume keeper)",
      lockName: "sip-solana-volume-keeper",
      alertTitlePrefix: "[volume] ",
      doorbellAllowed: false,
      crankAlert: false,
      signerScope: "settled-modes",
      dryRunPreview: true,
      banner: "volume keeper — settles VOLUME vaults only, never invests",
    });
  });

  it("keeperModes reads the profile and still answers [0] and [1]", () => {
    expect(keeperModes("profit")).toEqual([MODE_PROFIT]);
    expect(keeperModes("volume")).toEqual([MODE_VOLUME]);
  });

  it("the other keeper's vault is named exactly as before, by the profile that settles it", () => {
    expect(modeDecision({ skimMode: MODE_VOLUME }, keeperModes("profit"))).toEqual({
      outcome: "UNSUPPORTED_MODE",
      detail: "this vault saves in VOLUME mode, which the volume keeper settles; this keeper does not measure or attest it",
    });
    expect(modeDecision({ skimMode: MODE_PROFIT }, keeperModes("volume"))).toEqual({
      outcome: "UNSUPPORTED_MODE",
      detail: "this vault saves in PROFIT mode, which the profit keeper settles; this keeper does not measure or attest it",
    });
    for (const skimMode of [4, 7, 255]) {
      expect(modeDecision({ skimMode }, keeperModes("profit"))).toEqual({
        outcome: "UNSUPPORTED_MODE",
        detail: `this vault reports skim_mode ${skimMode}, which no sip-vault version defines; nothing is attested`,
      });
    }
    // T-O1: A PER-TRADE VAULT RESTS ON BOTH LEGACY KEEPERS, named as what it is.
    for (const [skimMode, name] of [
      [MODE_ROUNDUP, "ROUND-UP"],
      [MODE_FIXED, "FIXED"],
    ] as const) {
      for (const role of KEEPER_ROLES) {
        expect(modeDecision({ skimMode }, keeperModes(role)), `${role}, ${name}`).toEqual({
          outcome: "UNSUPPORTED_MODE",
          detail: `this vault saves in ${name} mode, which only a dispatcher worker serving it settles (settle_v3, SIP_SOLANA_EXTRA_MODES); nothing is attested`,
        });
      }
    }
  });

  it("a doorbell secret on the volume keeper is refused in the words it was refused in before", () => {
    const env = { SIP_SOLANA_RPC_URLS: "https://rpc.example.test", SIP_SOLANA_PROGRAM_ID: SIP_PROGRAM_ID, SIP_SOLANA_ROLE: "volume", SIP_SOLANA_DOORBELL_SECRET: "d".repeat(64) };
    let problems: readonly string[] = [];
    try {
      loadConfig(env, new Redactor());
    } catch (error) {
      problems = (error as { problems: readonly string[] }).problems;
    }
    expect(problems).toContain(
      "SIP_SOLANA_ROLE is volume but SIP_SOLANA_DOORBELL_SECRET is set, and only the profit keeper holds that secret: " +
        "if this is the profit keeper, delete SIP_SOLANA_ROLE; if it is the volume keeper, delete SIP_SOLANA_DOORBELL_SECRET.",
    );
  });
});

describe("registry: the questions call sites ask", () => {
  it("whose signer is resolved: the profit keeper every wallet's, the volume keeper only its own mode's", () => {
    for (const byte of [MODE_PROFIT, MODE_VOLUME, 2, 7, undefined]) {
      expect(resolvesSignerFor(ROLE_PROFILES.profit, byte), `profit, ${byte}`).toBe(true);
      expect(resolvesSignerFor(ROLE_PROFILES.volume, byte), `volume, ${byte}`).toBe(byte === MODE_VOLUME);
    }
  });

  it("what a turn measures: the base source of a mode the profile settles, nothing for any other byte", () => {
    expect(measuredBase(ROLE_PROFILES.profit, MODE_PROFIT)).toBe("balance-chain");
    expect(measuredBase(ROLE_PROFILES.volume, MODE_VOLUME)).toBe("trade-notional");
    for (const byte of EVERY_BYTE) {
      if (byte !== MODE_PROFIT) expect(measuredBase(ROLE_PROFILES.profit, byte), `profit, ${byte}`).toBeNull();
      if (byte !== MODE_VOLUME) expect(measuredBase(ROLE_PROFILES.volume, byte), `volume, ${byte}`).toBeNull();
    }
  });

  it("a role is read from the environment by exact name and own keys only", () => {
    expect(readRole(undefined)).toEqual({ role: "profit" });
    expect(readRole("")).toEqual({ role: "profit" });
    for (const role of KEEPER_ROLES) expect(readRole(role)).toEqual({ role });
    // What every object inherits is not a keeper: `in` would have taken these.
    for (const inherited of ["constructor", "toString", "hasOwnProperty", "__proto__", "valueOf"]) {
      expect(isKeeperRole(inherited), inherited).toBe(false);
      expect(readRole(inherited), inherited).toHaveProperty("problem");
    }
  });
});

describe("registry: the mode rows describe what the settle path does", () => {
  const vault = { skimBps: 2_000, volumeBps: 200 } as const satisfies Pick<VaultState, "skimBps" | "volumeBps">;

  it("each mode's rateField is the field activeBps charges at", () => {
    for (const mode of LEGACY_MODES) expect(activeBps({ ...vault, skimMode: mode.byte }), mode.name).toBe(vault[mode.rateField!]);
  });

  it("T-O3: a per-trade mode has no rate, and activeBps still reads skim_bps for it, as active_bps() does (Trap 1)", () => {
    for (const byte of [MODE_ROUNDUP_BYTE, MODE_FIXED_BYTE]) {
      expect(keeperModeFor(byte)!.rateField).toBeNull();
      expect(activeBps({ ...vault, skimMode: byte })).toBe(vault.skimBps);
    }
  });

  it("each mode carries a losing prefix's loss exactly when its row says so", async () => {
    // A losing cut prefix the wallet has not signed enough of to forget: PROFIT
    // hands the loss on, VOLUME has none to hand (its seam's notional is zero).
    const losing: WindowMeasurement = {
      txCount: 300,
      settleTxCount: 0,
      walletSignedTxCount: 99,
      successfulTradeCount: 12,
      tradedLamports: 12_000_000_000n,
      chainBreaks: 0,
      unfetchable: 0,
      cashDelta: -7n,
      deposits: 0n,
      withdrawals: 0n,
      profitLamports: -7n,
      firstSlot: 300_000_600n,
      lastSlot: 300_000_900n,
      signaturesAbove: 900,
      newestSignature: "sig-900",
      frontierReached: true,
      pagesExhausted: false,
      prefixCut: true,
      fetched: 301,
    };
    const zeroNotional: VolumeBase = async () => 0n;
    for (const mode of LEGACY_MODES) {
      const decision = await baseDecision({ mode: mode.byte, measured: losing, from: 300_000_500n, volumeBase: zeroNotional, carry: null });
      expect(decision.kind, mode.name).toBe("settle");
      expect("carry" in decision, mode.name).toBe(mode.carriesLosses);
    }
    // A PER-TRADE MODE CARRIES NOTHING, and without its seam — every legacy
    // keeper's turn — its span stops where an undefined mode's always did.
    for (const mode of MODES.filter((m) => m.base === "per-trade")) {
      expect(mode.carriesLosses, mode.name).toBe(false);
      expect(await baseDecision({ mode: mode.byte, measured: losing, from: 300_000_500n, volumeBase: zeroNotional, carry: null }), mode.name).toEqual({
        kind: "stop",
        outcome: "UNSUPPORTED_MODE",
        detail: `skim_mode ${mode.byte} is not a mode this keeper measures; nothing attested`,
      });
    }
  });

  it("registry: PROFIT and VOLUME probe on every sweep; the per-trade modes every 10 minutes and settle within the hour (ADR §5.5)", () => {
    for (const mode of LEGACY_MODES) {
      expect(mode.realProbeEveryMs, mode.name).toBe(EVERY_SWEEP);
      expect(mode.perTradeMaxWaitSeconds, mode.name).toBeNull();
    }
    for (const byte of [MODE_ROUNDUP_BYTE, MODE_FIXED_BYTE]) {
      expect(keeperModeFor(byte)!.realProbeEveryMs).toBe(PER_TRADE_PROBE_EVERY_MS);
      expect(keeperModeFor(byte)!.perTradeMaxWaitSeconds).toBe(PER_TRADE_MAX_WAIT_SECONDS);
    }
    expect(EVERY_SWEEP).toBe(0);
    expect(PER_TRADE_PROBE_EVERY_MS).toBe(600_000);
    expect(PER_TRADE_MAX_WAIT_SECONDS).toBe(3_600);
  });
});

describe("registry: a role without a profile does not compile", () => {
  it("is refused by tsc, which checks every @ts-expect-error below in the image's typecheck gate", () => {
    type WithThirdRole = KeeperRole | "per-trade";
    // @ts-expect-error — the table has no "per-trade" row, so it is no Record over a union that has one.
    const table: Record<WithThirdRole, RoleProfile> = ROLE_PROFILES;
    expect(Object.keys(table)).toEqual(["profit", "volume"]);
    // @ts-expect-error — and no call site can ask for one: every reader takes a KeeperRole.
    expect(() => lockNameFor("per-trade")).toThrow(TypeError);
  });

  it("because the table is declared as exactly that Record, and the mode table likewise", () => {
    const registry = readFileSync(join(PACKAGE, "src/role-registry.ts"), "utf8");
    expect(registry).toContain("} as const satisfies Record<KeeperRole, RoleProfile>;");
    expect(registry).toContain("} as const satisfies Record<ModeByte, KeeperMode>;");
  });
});

describe("registry: no role is compared to a literal any more", () => {
  /** Every .ts and .mts under src/, bin/ and scripts/: this package's own code, as tsconfig types it. */
  function sourceFiles(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return /\.m?ts$/.test(entry.name) ? [path] : [];
    });
  }
  /** Comments out, so prose that QUOTES the old ternary to explain it is not read as one. */
  const code = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  const sources = ["src", "bin", "scripts"]
    .flatMap((directory) => sourceFiles(join(PACKAGE, directory)))
    .map((path) => ({ path: relative(PACKAGE, path), text: readFileSync(path, "utf8") }));

  it('bin/keeper.mts no longer contains role === "volume", nor any other comparison of the role', () => {
    const keeper = sources.find((source) => source.path === "bin/keeper.mts")!.text;
    for (const quote of ['"', "'", "`"]) {
      for (const role of ["volume", "profit"]) {
        expect(keeper, `role === ${quote}${role}${quote}`).not.toContain(`role === ${quote}${role}${quote}`);
        expect(keeper, `role !== ${quote}${role}${quote}`).not.toContain(`role !== ${quote}${role}${quote}`);
      }
    }
  });

  it("finds no role compared to a string literal anywhere in src/, bin/ or scripts/", () => {
    expect(sources.length).toBeGreaterThan(20);
    const ROLE_VS_LITERAL = /\brole\w*\s*[!=]==?\s*["'`]|["'`]\s*[!=]==?\s*\w*role\b/gi;
    const found = sources.flatMap(({ path, text }) => [...code(text).matchAll(ROLE_VS_LITERAL)].map((match) => `${path}: ${match[0]}`));
    expect(found).toEqual([]);
  });
});
