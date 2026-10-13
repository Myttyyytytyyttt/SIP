// WHICH CODE SETTLES A VAULT, CHOSEN BY THE VAULT'S OWN ON-CHAIN skim_mode
// (dispatcher ADR §3.2: "a mode is a module chosen by the vault's on-chain
// skim_mode"; plan P3a Q3, P4).
//
// UNDER THE QUEUE ONE WORKER SETTLES EVERY MODE. The legacy keepers split the
// modes by ROLE — the profit keeper settles PROFIT, the volume keeper VOLUME
// (src/role-registry.ts, ROLE_PROFILES) — and each passes its own `settles` and
// its own measurement to runSettleTick. A worker's job holds one vault and reads
// its mode byte fresh, so the choice moves here: the byte picks a KeeperMode
// (role-registry.ts, keeperModeFor) and the mode's `base` picks the module that
// knows how to measure it. A job settles the vault's links with `settles` set to
// that one byte, so a vault whose owner changed the mode between the read and
// the attestation is still refused on chain, never charged by the wrong rule.
//
// THE PER-TRADE MODES PLUG IN HERE (ADR §5, plan §3.4): ROUND-UP (2) and FIXED
// (3) are one module, "per-trade", which reads the vault's PerTradePolicy and —
// for ROUND-UP — Pyth's SOL/USD account once per job, prices each counted trade
// from the price tape (src/price-tape.ts), charges it (src/per-trade-base.ts)
// and hands the turn the seam settle-tick.ts attests through settle_v3.
//
// AND ONLY UNDER AN EXPLICIT FLAG (src/worker-config.ts): a per-trade byte has a
// module only when SIP_SOLANA_EXTRA_MODES names it AND SIP_SOLANA_EXTRA_MODES_VAULTS
// allows the vault. Otherwise — the default, every variable unset — it has none,
// exactly as before this module existed: the job hands the turn `settles: []`,
// and runSettleTick answers UNSUPPORTED_MODE before any RPC call (modeDecision).
// Who acts on a vault at all is still vault_work.system's; this list only says
// which modes a worker that holds it may settle (plan §7 row 14).
//
// A BYTE NO sip-vault VERSION DEFINES HAS NO MODULE, the same way.

import type * as anchor from "@coral-xyz/anchor";
import type { Connection, PublicKey } from "@solana/web3.js";
import { summarizeUpstreamError } from "@sip/solana-log";
import { decodePerTradePolicy, perTradePolicyAddress, type PerTradePolicyState, type VaultState } from "./accounts.js";
import type { ManagedLink } from "./discovery.js";
import { tradeNotional } from "./measure-volume.js";
import { perTradeCadence, perTradeCharge, perTradeCounterAfter, perTradePaid, type PerTradePolicyParams, type TradePrice } from "./per-trade-base.js";
import type { PolicyBoundaryBook, OwnerHistoryReader } from "./policy-boundary.js";
import { TAPE_LOOKUP_SECONDS, tapeRulesRefusal, toUsdE6, type PriceTapeReader, type TapeSample } from "./price-tape.js";
import { MODE_ROUNDUP } from "./program-scripts.js";
import { PYTH_RECEIVER_PROGRAM, PYTH_SOL_USD_FEED_ID_HEX, decodePythPriceUpdate, type PythPriceUpdate } from "./pyth.js";
import { keeperModeFor, type KeeperMode } from "./role-registry.js";
import { measurementStart, type PerTradeBase } from "./settle-decision.js";
import type { SettleDeps, SettleResult } from "./settle-tick.js";
import { createVolumeBase } from "./volume-base.js";

/** What a module may need to build a turn's measurement, beside the link and the vault. */
export interface SettleModuleContext {
  readonly link: ManagedLink;
  readonly vault: VaultState;
  readonly programId: PublicKey;
  /** The process's policy-boundary cache (shared by every job: keyed by vault, rebuilt from the chain on a cold worker). */
  readonly boundaries: PolicyBoundaryBook;
  readonly ownerHistory: OwnerHistoryReader;
  readonly nowSeconds: () => number;
}

/** The part of a settle turn's deps a mode decides. */
export type SettleModuleTurn = Pick<SettleDeps, "volumeProbe" | "volumeBase" | "perTrade">;

/** What a module reads once per job, before its vault's first link (src/worker-job.ts). */
export interface ModuleJob {
  readonly connection: Connection;
  readonly program: anchor.Program;
  readonly vaultAddress: PublicKey;
  readonly vault: VaultState;
}

/** What a link's turn ended in, as afterTurn reads it. */
export type ModuleTurnEnd = Pick<SettleResult, "outcome" | "expectedLamports" | "settledLamports" | "perTrade">;

/** A module ready to build its vault's turns, or why none of them can run this job (each is then a RETRY). */
export type ModulePrepared =
  | {
      readonly kind: "ready";
      turn(context: SettleModuleContext): SettleModuleTurn;
      /**
       * Told how each link's turn ended, before the next link's turn is built
       * (src/worker-job.ts), at `nowSeconds`. PROFIT and VOLUME keep nothing
       * between links and have none; the per-trade module carries its vault's
       * daily counter forward (perTradeModule).
       */
      afterTurn?(end: ModuleTurnEnd, nowSeconds: number): void;
    }
  | { readonly kind: "retry"; readonly detail: string };

/** One mode's settle code. */
export interface SettleModule {
  readonly mode: KeeperMode;
  /**
   * Whether a LIVE job's turns of this module may send. True for PROFIT and
   * VOLUME; for a per-trade module, SIP_SOLANA_EXTRA_MODES_LIVE: until it is 1 a
   * live worker turns a per-trade vault DRY — measured, attested on paper,
   * reported, never gated or sent (ADR §6.2 M4).
   */
  readonly sends: boolean;
  /** Once per job. PROFIT and VOLUME read nothing (no RPC); the per-trade module reads its PDA and the oracle. */
  prepare(job: ModuleJob): Promise<ModulePrepared>;
}

/** What a dispatcher worker serves of the per-trade modes (src/worker-config.ts, SIP_SOLANA_EXTRA_MODES*). */
export interface PerTradeServing {
  /** The bytes SIP_SOLANA_EXTRA_MODES names (2 roundup, 3 fixed). Never empty: no serving at all is a null PerTradeServing. */
  readonly modes: ReadonlySet<number>;
  /** SIP_SOLANA_EXTRA_MODES_VAULTS: the vault addresses served, or "*" for every one the worker holds. */
  readonly vaults: ReadonlySet<string> | "*";
  /** SIP_SOLANA_EXTRA_MODES_LIVE: whether a live worker's per-trade turns may send. */
  readonly live: boolean;
  /** SIP_SOLANA_EXTRA_MODES_FROM_SLOT: trades at or below it are forgiven (RT-7); null adds nothing to the policy boundary. */
  readonly fromSlot: bigint | null;
  /** The price tape ROUND-UP trades are valued at. */
  readonly tape: PriceTapeReader;
  /** The Pyth SOL/USD PriceUpdateV2 account: mainnet's sponsored feed, or a local proof's fixture. */
  readonly oracle: PublicKey;
}

/** Whether this worker serves a per-trade byte for this vault: the mode named AND the vault allowed. */
export function servesPerTrade(serving: PerTradeServing | null, byte: number, vault: string): boolean {
  if (serving === null || !serving.modes.has(byte)) return false;
  return serving.vaults === "*" || serving.vaults.has(vault);
}

/** The policy's per-trade parameters as the charge and the boundary read them. */
function paramsOf(policy: PerTradePolicyState): PerTradePolicyParams {
  return {
    roundupUnitCents: policy.roundupUnitCents,
    fixedLamports: policy.fixedLamports,
    minTradeCents: policy.minTradeCents,
    minTradeLamports: policy.minTradeLamports,
    dailyCapLamports: policy.dailyCapLamports,
    dayIndex: policy.dayIndex,
    daySavedLamports: policy.daySavedLamports,
  };
}

/**
 * The Pyth SOL/USD account as the job read it: the receiver's, the SOL/USD feed.
 * Null when it is missing or is not that, with no throw: an IDLE link needs no
 * price, and a span that does is a RETRY (the seam, and settlePerTrade).
 */
function readOracle(info: { readonly owner: PublicKey; readonly data: Buffer } | null): PythPriceUpdate | null {
  if (info === null || !info.owner.equals(PYTH_RECEIVER_PROGRAM)) return null;
  try {
    return decodePythPriceUpdate(info.data, PYTH_SOL_USD_FEED_ID_HEX);
  } catch {
    return null;
  }
}

/**
 * THE PER-TRADE SEAM for one link (PerTradeBase): its counted trades above the
 * boundary, valued (ROUND-UP) at the tape's sample nearest each one's block
 * time or late at the job's Pyth read, charged, and held to the cadence.
 *
 * WHAT IT CANNOT KNOW IS A RETRY, NEVER A GUESS: a tape it cannot read, a
 * policy boundary it cannot walk, a ROUND-UP span with no settle-time price,
 * and a LATE trade when the job's Pyth read is one the tape itself would not
 * keep — older than TAPE_MAX_AGE_SECONDS or wider than TAPE_MAX_CONF_BPS
 * (tapeRulesRefusal). A feed that stalls for hours leaves a hole in the tape;
 * the trades in it wait for a fresh read rather than take the stalled one. The
 * on-chain floor's 24 h (oracleRefusal) is a different question: whether the
 * program accepts the window, not what a trade was worth.
 */
export function perTradeSeam(args: {
  readonly context: SettleModuleContext;
  readonly mode: KeeperMode;
  readonly policy: PerTradePolicyState;
  readonly oracle: PythPriceUpdate | null;
  readonly serving: Pick<PerTradeServing, "fromSlot" | "tape">;
}): PerTradeBase {
  const { context, mode, policy, oracle, serving } = args;
  const { link, vault } = context;
  const roundUp = mode.byte === MODE_ROUNDUP;
  const params = paramsOf(policy);
  return async (measured) => {
    const trades = measured.volumeTrades;
    // A CALLER BUG, NOT A QUIET SPAN: without the probe the walk records no trades.
    if (trades === undefined) throw new Error("the per-trade seam needs the walk's volume trades: runSettleTick was not given the volume probe");
    const nowSeconds = context.nowSeconds();

    // THE BOUNDARY: the newest change of mode or per-trade rule, and the served-from slot, whichever is later.
    let boundarySlot = serving.fromSlot;
    if (trades.length > 0) {
      try {
        const found = await context.boundaries.boundary({
          reader: context.ownerHistory,
          programId: context.programId.toBase58(),
          vault: link.vault,
          owner: vault.owner,
          from: measurementStart(link),
          current: {
            mode: vault.skimMode,
            volumeBps: vault.volumeBps,
            perTrade: { unitCents: policy.roundupUnitCents, fixedLamports: policy.fixedLamports, minTradeCents: policy.minTradeCents, minTradeLamports: policy.minTradeLamports },
          },
        });
        if (found.slot !== null && (boundarySlot === null || found.slot > boundarySlot)) boundarySlot = found.slot;
      } catch (error) {
        return { kind: "retry", detail: `the owner's policy history could not be walked (${summarizeUpstreamError(error)}), so which trades are chargeable is unknown; nothing was attested` };
      }
    }

    // THE PRICES, ROUND-UP only: the job's Pyth read for anything late, the tape for the rest.
    let settlePrice: bigint | null = null;
    let samples: ReadonlyMap<number, TapeSample | null> = new Map();
    if (roundUp) {
      if (oracle === null || oracle.price <= 0n || oracle.expo < -18 || oracle.expo > 18) {
        return { kind: "retry", detail: "a ROUND-UP span is valued in dollars, and this job could not read Pyth's SOL/USD account as the receiver's SOL/USD feed; nothing was attested" };
      }
      settlePrice = toUsdE6(oracle.price, oracle.expo);
      if (settlePrice <= 0n) return { kind: "retry", detail: `Pyth's SOL/USD price ${oracle.price}e${oracle.expo} is under a micro-dollar; nothing was attested` };
      const priced = trades.filter((trade) => boundarySlot === null || trade.slot > boundarySlot);
      const times = [...new Set(priced.filter((trade) => trade.blockTime !== null).map((trade) => trade.blockTime!))];
      if (times.length > 0) {
        try {
          samples = await serving.tape.pricesAt(times);
        } catch (error) {
          return { kind: "retry", detail: `the price tape could not be read (${summarizeUpstreamError(error)}); nothing was attested, and the trades are priced next turn` };
        }
      }
      // A LATE PRICE IS HELD TO THE TAPE'S OWN RULES: only trades it would price, and only when there are any.
      const untaped = priced.filter((trade) => trade.blockTime === null || (samples.get(trade.blockTime) ?? null) === null).length;
      const refused = untaped === 0 ? null : tapeRulesRefusal(oracle, Math.floor(nowSeconds), "now");
      if (refused !== null) {
        return {
          kind: "retry",
          detail:
            `no fresh price for ${untaped} trade(s): the tape holds no sample within ${TAPE_LOOKUP_SECONDS} s of them, and this job's Pyth SOL/USD read ` +
            `is not one the tape would keep (${refused.detail}); nothing was attested, and they are priced late once a read passes`,
        };
      }
    }
    const late = settlePrice;
    const priceOf = (trade: { readonly blockTime: number | null }): TradePrice => {
      const sample = trade.blockTime === null ? null : (samples.get(trade.blockTime) ?? null);
      return sample === null ? { priceUsdE6: late!, source: "late" } : { priceUsdE6: sample.priceE6, source: "tape" };
    };
    const charge = perTradeCharge({ mode: vault.skimMode, trades, boundarySlot, policy: params, priceOf, settlePriceUsdE6: settlePrice });
    if (charge.tradeCount === 0) return { kind: "charge", charge, wait: null };
    const { headroom } = perTradePaid({ amountLamports: charge.amountLamports, maxContribution: vault.maxContribution, policy: params, nowSeconds });
    const cadence = perTradeCadence({
      charge,
      maxContribution: vault.maxContribution,
      headroom,
      nowSeconds,
      maxWaitSeconds: mode.perTradeMaxWaitSeconds ?? 0,
    });
    return { kind: "charge", charge, wait: cadence.settle ? null : { detail: cadence.detail, dueAt: cadence.dueAt } };
  };
}

/** The per-trade module, for one served byte. */
function perTradeModule(mode: KeeperMode, serving: PerTradeServing): SettleModule {
  return {
    mode,
    sends: serving.live,
    async prepare({ connection, program, vaultAddress, vault }) {
      if (vault.skimMode !== mode.byte) throw new Error(`a ${mode.name} module was prepared for a vault in skim_mode ${vault.skimMode}`);
      const policyAddress = perTradePolicyAddress(program.programId, vaultAddress);
      const roundUp = mode.byte === MODE_ROUNDUP;
      // ONE READ PER JOB: the PDA, and — ROUND-UP — the oracle beside it.
      const keys = roundUp ? [policyAddress, serving.oracle] : [policyAddress];
      const infos = await connection.getMultipleAccountsInfo(keys, "confirmed");
      if (infos.length !== keys.length) throw new Error(`asked for ${keys.length} accounts and got ${infos.length}: the per-trade read no longer lines up`);
      const policyInfo = infos[0] ?? null;
      if (policyInfo === null || !policyInfo.owner.equals(program.programId)) {
        return {
          kind: "retry",
          detail: `this vault reports ${mode.name} and the chain holds no PerTradePolicy at ${policyAddress.toBase58()}; set_policy_v3 writes both together, so the read is behind the chain; nothing was attested`,
        };
      }
      const policy = decodePerTradePolicy(program, policyAddress, policyInfo.data);
      if (policy === null || !policy.vault.equals(vaultAddress)) {
        return { kind: "retry", detail: `the PerTradePolicy at ${policyAddress.toBase58()} does not name this vault; nothing was attested` };
      }
      const update = roundUp ? readOracle(infos[1] ?? null) : null;
      // THE DAILY COUNTER IS THE VAULT'S, AND THIS JOB SETTLES EVERY LINK OF IT:
      // settle_v3 writes day_index and day_saved_lamports at each link, so the
      // job's one read is carried forward past each SETTLED turn — a dry one
      // included, since a dry turn says what a live one would do — and the next
      // link's headroom, cadence and reserve are worked out against it.
      let current = policy;
      return {
        kind: "ready",
        turn: (context) => {
          const turnPolicy = current;
          return {
            volumeProbe: tradeNotional,
            perTrade: {
              base: perTradeSeam({ context, mode, policy: turnPolicy, oracle: update, serving }),
              policy: turnPolicy,
              oracle: update === null ? null : { address: serving.oracle, update },
              nowSeconds: context.nowSeconds,
            },
          };
        },
        afterTurn: (end, nowSeconds) => {
          if (end.outcome !== "SETTLED" || end.perTrade === undefined) return;
          // WHAT MOVED: the receipt's vault delta when it was read, else what this keeper computed the program pays (perTradePaid).
          const paid = end.settledLamports ?? end.expectedLamports;
          if (paid === undefined) return;
          current = { ...current, ...perTradeCounterAfter(current, paid, nowSeconds) };
        },
      };
    },
  };
}

/**
 * One module per measurement, as the legacy turns build them (bin/keeper.mts,
 * `volumeTurn`): the balance chain needs nothing beyond the walk; a VOLUME span
 * is measured by the trade-notional probe and charged from the last policy
 * boundary at the vault's cadence. Neither reads anything when prepared.
 */
const SETTLE_MODULES: { readonly [Base in Exclude<KeeperMode["base"], "per-trade">]: (mode: KeeperMode) => SettleModule } = {
  "balance-chain": (mode) => ({ mode, sends: true, prepare: async () => ({ kind: "ready", turn: () => ({}) }) }),
  "trade-notional": (mode) => ({
    mode,
    sends: true,
    prepare: async () => ({
      kind: "ready",
      turn: ({ link, vault, programId, boundaries, ownerHistory, nowSeconds }) => ({
        volumeProbe: tradeNotional,
        volumeBase: createVolumeBase({
          volumeBps: vault.volumeBps,
          boundary: () =>
            boundaries.boundary({
              reader: ownerHistory,
              programId: programId.toBase58(),
              vault: link.vault,
              owner: vault.owner,
              from: measurementStart(link),
              current: { mode: vault.skimMode, volumeBps: vault.volumeBps },
            }),
          nowSeconds,
        }),
      }),
    }),
  }),
};

/**
 * The module for a vault reporting this byte, or null: no sip-vault version
 * defines it, or it is a per-trade byte this worker does not serve for this
 * vault (servesPerTrade). Without `serving` — every variable unset — no
 * per-trade byte has a module.
 */
export function settleModuleFor(byte: number, options: { readonly vault?: string; readonly serving?: PerTradeServing | null } = {}): SettleModule | null {
  const mode = keeperModeFor(byte);
  if (mode === null) return null;
  if (mode.base === "per-trade") {
    const serving = options.serving ?? null;
    if (options.vault === undefined || serving === null || !servesPerTrade(serving, byte, options.vault)) return null;
    return perTradeModule(mode, serving);
  }
  return SETTLE_MODULES[mode.base](mode);
}
