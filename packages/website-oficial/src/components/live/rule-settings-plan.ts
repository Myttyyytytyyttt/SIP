/**
 * THE VAULT SETTINGS' LIVE ARITHMETIC (owner, 09-25): what the gear on the
 * Savings rule card would sign for a draft, with EVERY field re-sent.
 *
 * NO NEW RULES LIVE HERE. Every number is read by the pieces the investing
 * card and "Your first savings arrived" already sign with — readWeights,
 * readMinimum, readCaps, basketLimits, policyRequest, policyEditSeed,
 * resignStoredPolicy — imported exactly as LiveStartBuying imports them. This
 * file only decides WHICH of them a draft reaches, and in what order, so the
 * dialog (rule-settings-dialog.tsx) and its host (LiveRulePanel.tsx) never
 * build a request of their own.
 *
 * TWO INSTRUCTIONS, NEVER CONFUSED:
 *   set_policy_v2      → mode, rate, pause. It writes ALL SIX of the vault's
 *                        fields and bumps the vault's nonce even when nothing
 *                        changed, so it is planned only when one of the three
 *                        the dialog shows differs from what it opened on — and
 *                        the other fields go back exactly as the chain holds
 *                        them. An unreadable one is a refusal, never 0n.
 *   set_invest_policy  → the basket, its shares and the threshold. An omitted
 *                        field takes a DESTRUCTIVE server default (a default
 *                        `enabled` un-pauses; default weights are the whole
 *                        shelf), so every field is sent: the stored caps held
 *                        inside the new basket's window, `enabled` as stored,
 *                        and the per-leg minimum that makes the basket invest
 *                        at the typed threshold (rule-settings.ts minimumFor).
 *
 * A VAULT WITH NO POLICY SIGNS NOTHING FROM HERE: its basket is a choice kept
 * on this device (saveBasketChoice), and "Your first savings arrived" asks for
 * the first policy once the first settlement lands, at the $10 base.
 *
 * PURE. No React, no hook is called: the host runs these on every render.
 */

import { DEFAULT_INVEST_CAPS, MODE_PROFIT, MODE_VOLUME, OFFERED_LEGS, investmentReadiness, isOfferable, type CatalogueAsset } from "@sip/solana-core/client";

import { START_BUYING_PER_BUY_RAW } from "@/components/live/LiveStartBuying";
import { atLeastUsd, atMostUsd, policyEditSeed, policyRequest, readCaps, readMinimum, readWeights, resignStoredPolicy } from "@/components/wallets/InvestingCard";
import type { InvestRequest, VaultRuleRequest } from "@/hooks/use-vault-actions";
import { AmountError, USDC_DECIMALS, formatUnits, formatUsd, parseUnits, rawFrom } from "@/lib/amounts";
import { artForMint } from "@/lib/asset-art";
import { basketLimits, catalogueAsset, catalogueRows, overCeiling, type BasketLimits, type PickedLeg } from "@/lib/basket-picker";
import { LIVE_COPY } from "@/lib/live-copy";
import { basketOnShelf, basketSplit } from "@/lib/onboarding";
import type { BasketChoice } from "@/lib/onboarding-memory";
import { BASE_THRESHOLD_RAW, RATE_RANGES, VOLUME_START_BPS, minimumFor, type RuleMode, type SettingsCategory, type SettingsDraft, type SettingsPick } from "@/lib/rule-settings";
import { SETTINGS_COPY } from "@/lib/settings-copy";
import type { InvestmentPolicyJson, VaultStateJson } from "@/lib/vault-api";
import { INVEST_COPY, VAULT_COPY, listAnd, ratePercent, shortAddress, signedLegsOf } from "@/lib/vault-copy";

/** The least threshold the dialog takes: $1, the keeper's smallest quotable probe. */
export const LEAST_THRESHOLD_RAW = 1_000_000n;

/**
 * A LEG WHOSE SLICE OF THE THRESHOLD IS THIS OR LESS IS WARNED ABOUT, not
 * refused: at $1 or less the keeper's depth probe abstains (invest-decision.ts
 * MIN_PROBE_RAW), and a buy it cannot measure waits for a bigger pile.
 */
export const SMALL_SLICE_RAW = 1_000_000n;

/** The two caps a stored policy carries, in USDC raw units. */
export interface StoredCaps {
  readonly maxPerCall: bigint;
  readonly maxRolling30d: bigint;
}

/** What the Buying half of the dialog stands on. */
export type LiveBuying =
  | {
      /** A signed policy: the dialog edits it, and Save re-signs it whole. */
      readonly kind: "policy";
      readonly policy: InvestmentPolicyJson;
      /** The threshold the policy invests at today (pending.ts investsAtRaw). */
      readonly thresholdRaw: bigint;
      readonly caps: StoredCaps;
      /** A venue NAME (policyEditSeed): the stored one, or the default when the stored program cannot be checked. */
      readonly venue: string;
      readonly enabled: boolean;
      /** What the seed could not put back on the form as stored: dropped legs, a replaced venue. */
      readonly notices: readonly string[];
    }
  | {
      /** No policy: the basket is a choice kept on this device, and nothing is signed from here. */
      readonly kind: "choice";
      /** The stored choice held to today's shelf. */
      readonly choice: BasketChoice;
    }
  | {
      /** The policy cannot be read, or cannot be put back on a form: only the reason is shown. */
      readonly kind: "locked";
      readonly message: string;
    };

/** What the dialog opens on, from the chain. */
export interface LiveSeed {
  readonly draft: SettingsDraft;
  /** Each mode's stored rate, so switching mode seeds the slider from that mode's own value. */
  readonly rates: { readonly profit: number; readonly volume: number };
  readonly buying: LiveBuying;
  /** Changes whenever what the form opens on changes: the host keys the form on it. */
  readonly key: string;
}

const modeOf = (skimMode: number): RuleMode => (skimMode === MODE_VOLUME ? "volume" : "profit");

// ── (1) THE SEED ─────────────────────────────────────────────────────────────

/**
 * THE DRAFT THE DIALOG OPENS ON, read off the vault screen's state.
 *
 * Saving: the stored mode, that mode's stored rate, the pause. Buying: the
 * signed policy as the investing card's edit form would open it (the same
 * policyEditSeed), at the threshold it invests at today; with no policy, the
 * choice kept on this device at its equal split and the $10 base; and a policy
 * that cannot be read or put back on a form is LOCKED with its reason, never
 * guessed into boxes.
 */
export function liveSeed(state: VaultStateJson, choice: BasketChoice | null): LiveSeed | { readonly problem: string } {
  const account = state.vault.status === "exists" ? (state.vault.state ?? null) : null;
  if (account === null) return { problem: state.vault.status === "missing" ? VAULT_COPY.noVault : VAULT_COPY.unreadable };

  const mode = modeOf(account.skimMode);
  // A profit vault's stored volume rate was never chosen — it is whatever the
  // vault was created with — so switching to Volume starts at the product's
  // default (1 %, owner 09-25), not at that leftover. A volume vault's own
  // rate is its owner's choice and is kept.
  const rates = { profit: account.skimBps, volume: mode === "volume" ? account.volumeBps : VOLUME_START_BPS };
  const saving = { mode, rateBps: rates[mode], paused: account.paused };
  const savingKey = `${mode}:${account.skimBps}:${account.volumeBps}:${account.paused}`;

  const locked = (message: string): LiveSeed => ({
    draft: { ...saving, picked: [], threshold: "" },
    rates,
    buying: { kind: "locked", message },
    key: `${savingKey}|locked:${message}`,
  });

  if (state.policy.status === "missing") {
    const onShelf = basketOnShelf(choice);
    const picked: SettingsPick[] = basketSplit(onShelf).map((leg) => ({ id: leg.mint, percent: String(leg.percent) }));
    return {
      draft: { ...saving, picked, threshold: formatUnits(BASE_THRESHOLD_RAW, USDC_DECIMALS) },
      rates,
      buying: { kind: "choice", choice: onShelf },
      key: `${savingKey}|choice:${onShelf.kind === "sol" ? "sol" : onShelf.mints.join(",")}`,
    };
  }

  const policy = state.policy.status === "exists" ? (state.policy.state ?? null) : null;
  if (policy === null) return locked(LIVE_COPY.policyUnreadable);
  const seed = policyEditSeed(policy);
  if (!seed.ok) return locked(seed.message);

  // policyEditSeed read these three and refused a policy missing any of them.
  const minInvestment = rawFrom(policy.minInvestment);
  const maxPerCall = rawFrom(policy.maxPerCall);
  const maxRolling30d = rawFrom(policy.maxRolling30d);
  if (minInvestment === null || maxPerCall === null || maxRolling30d === null) return locked(LIVE_COPY.policyUnreadable);
  const readiness = investmentReadiness(0n, policy.legs, minInvestment, maxPerCall);
  if (readiness === null) return locked(LIVE_COPY.policyUnreadable);

  const notices: string[] = [];
  if (seed.dropped.length > 0) notices.push(INVEST_COPY.editDropped(listAnd(seed.dropped)));
  if (seed.venueReplaced) notices.push(INVEST_COPY.editVenueReplaced(seed.venue));

  const legsKey = policy.legs.map((leg) => `${leg.mint}:${leg.weightBps}`).join(",");
  return {
    draft: {
      ...saving,
      picked: seed.picked.map((row) => ({ id: row.mint, percent: row.percent })),
      threshold: formatUnits(readiness.investsAtRaw, USDC_DECIMALS),
    },
    rates,
    buying: {
      kind: "policy",
      policy,
      thresholdRaw: readiness.investsAtRaw,
      caps: { maxPerCall, maxRolling30d },
      venue: seed.venue,
      enabled: policy.enabled,
      notices,
    },
    key: `${savingKey}|${legsKey}|${minInvestment}|${maxPerCall}|${maxRolling30d}|${policy.enabled}|${policy.venueProgram}`,
  };
}

// ── (2) ONE BASKET AT ONE THRESHOLD ─────────────────────────────────────────

export interface SettingsPolicyInput {
  readonly picked: readonly SettingsPick[];
  /** Dollars as typed. */
  readonly threshold: string;
  /** The stored policy's caps; null for a basket that has none yet. */
  readonly stored: StoredCaps | null;
  /** Always the stored policy's own: a default here would quietly resume a paused policy. */
  readonly enabled: boolean;
  /** A venue NAME. */
  readonly venue: string;
  /** Mints the stored policy already holds; every other leg is new (rent for its account, and its issuer's powers). */
  readonly heldMints?: readonly string[];
}

export interface SettingsPolicyPlan {
  /** Every field of set_invest_policy, or null when this basket cannot be signed. */
  readonly request: InvestRequest | null;
  /** The first reason it cannot, in the owner's words. */
  readonly problem: string | null;
  /** The stored Most per buy, when it had to move to fit this basket's window. */
  readonly capMoved: { readonly from: bigint; readonly to: bigint } | null;
  readonly legs: readonly PickedLeg[];
  /** Legs the stored policy does not hold. */
  readonly newLegs: readonly CatalogueAsset[];
  readonly window: BasketLimits | null;
  readonly thresholdRaw: bigint | null;
  /** What the lightest leg is handed when the pile reaches the threshold (= the per-leg minimum signed). */
  readonly lightestSliceRaw: bigint | null;
  /** That leg, for the small-leg warning. */
  readonly lightest: CatalogueAsset | null;
}

/**
 * WHAT set_invest_policy WOULD CARRY for this basket at this threshold: the
 * generalisation of LiveStartBuying.startBuyingPlan, with the stored caps in
 * place of the start card's $25.
 *
 * THE CAP IS HELD INSIDE THE WINDOW AND SAID TO HAVE MOVED. The window's floor
 * follows the threshold and its ceiling the thinnest leg's counted route, so a
 * cap that fitted the stored basket can sit outside the new one — adding
 * ANTHROPIC lowers the ceiling, raising the threshold lifts the floor. The
 * owner never sees caps in the dialog, so a move is reported (capMoved), and
 * when no cap fits at all the basket is refused (capWindowEmpty): the cap is
 * never raised past the ceiling to make a threshold fit.
 */
export function settingsPolicyPlan(input: SettingsPolicyInput): SettingsPolicyPlan {
  const refused = (problem: string, partial: Partial<SettingsPolicyPlan> = {}): SettingsPolicyPlan => ({
    request: null,
    problem,
    capMoved: null,
    legs: [],
    newLegs: [],
    window: null,
    thresholdRaw: null,
    lightestSliceRaw: null,
    lightest: null,
    ...partial,
  });

  // A pick the shelf does not offer would be filtered out of the request by
  // investPolicyFlow — a shorter basket than the one on screen — so it is refused.
  const assets: CatalogueAsset[] = [];
  for (const pick of input.picked) {
    const asset = catalogueAsset(pick.id);
    if (asset === null || !isOfferable(asset)) return refused(SETTINGS_COPY.notOnShelf(asset?.symbol ?? shortAddress(pick.id)));
    assets.push(asset);
  }
  const weights = readWeights(
    input.picked.map((pick) => pick.percent),
    assets,
  );
  if (!weights.ok) return refused(weights.message);
  const legs: PickedLeg[] = assets.map((asset) => ({ asset, weightBps: weights.byMint.get(asset.mint)! }));
  const weightsBps = legs.map((leg) => leg.weightBps);
  const held = new Set(input.heldMints ?? []);
  const newLegs = assets.filter((asset) => !held.has(asset.mint));
  const lightestLeg = legs.reduce<PickedLeg | null>((worst, leg) => (worst === null || leg.weightBps < worst.weightBps ? leg : worst), null);
  const lightest = lightestLeg?.asset ?? null;

  let thresholdRaw: bigint;
  try {
    thresholdRaw = parseUnits(input.threshold, USDC_DECIMALS, SETTINGS_COPY.threshold);
  } catch (error) {
    if (error instanceof AmountError) return refused(error.message, { legs, newLegs, lightest });
    throw error;
  }
  if (thresholdRaw < LEAST_THRESHOLD_RAW) return refused(SETTINGS_COPY.thresholdTooSmall(formatUsd(LEAST_THRESHOLD_RAW)), { legs, newLegs, lightest });

  const minimumRaw = minimumFor(thresholdRaw, weightsBps);
  const minimumText = formatUnits(minimumRaw, USDC_DECIMALS);
  const known = { legs, newLegs, lightest, thresholdRaw, lightestSliceRaw: minimumRaw };
  const minimum = readMinimum(minimumText, null, weightsBps);
  if (!minimum.ok) return refused(minimum.message, known);

  const window = basketLimits(legs, minimumRaw);
  if (window.empty && window.ceilingRaw !== null) {
    return refused(INVEST_COPY.capWindowEmpty(atLeastUsd(window.floorRaw), atMostUsd(window.ceilingRaw), window.ceilingBinding?.symbol ?? lightest?.symbol ?? ""), {
      ...known,
      window,
    });
  }

  const from = input.stored?.maxPerCall ?? START_BUYING_PER_BUY_RAW;
  let perBuy = from < window.floorRaw ? window.floorRaw : from;
  if (window.ceilingRaw !== null && perBuy > window.ceilingRaw) perBuy = window.ceilingRaw;
  const capMoved = input.stored !== null && perBuy !== from ? { from, to: perBuy } : null;
  const storedPer30 = input.stored?.maxRolling30d ?? DEFAULT_INVEST_CAPS.maxRolling30d;
  const per30 = storedPer30 > perBuy ? storedPer30 : perBuy;

  const caps = readCaps(formatUnits(perBuy, USDC_DECIMALS), formatUnits(per30, USDC_DECIMALS), window.floorRaw);
  if (!caps.ok) return refused(caps.message, { ...known, window, capMoved });
  const perLeg = readMinimum(minimumText, caps.maxPerCall, weightsBps);
  if (!perLeg.ok) return refused(perLeg.message, { ...known, window, capMoved });
  const overDepth = window.empty || overCeiling(caps.maxPerCall, window);
  const request = policyRequest({ caps, minimum: perLeg, weights, overDepth, enabled: input.enabled, venue: input.venue });
  if (request === null) return refused(INVEST_COPY.resignUnreadable, { ...known, window, capMoved });
  return { request, problem: null, capMoved, window, ...known };
}

// ── (3) THE WHOLE DRAFT ─────────────────────────────────────────────────────

export interface SettingsPlanInput {
  readonly state: VaultStateJson;
  readonly seed: LiveSeed;
  readonly draft: SettingsDraft;
  /** VOLUME_MODE_OFFERED from @sip/solana-core/client, passed in so a test can hold either side. */
  readonly volumeOffered: boolean;
}

export interface SettingsPlan {
  /** set_policy_v2, all six fields, or null when mode, rate and pause are as the dialog opened. */
  readonly rule: VaultRuleRequest | null;
  /** set_invest_policy, every field, or null when the basket and the threshold are as stored. */
  readonly policy: InvestRequest | null;
  /** The basket choice to keep on this device (no policy yet), or null when it did not change. */
  readonly choice: BasketChoice | null;
  /** The first reason nothing can be saved, and the half of the dialog it belongs to. Everything above is null with it. */
  readonly problem: { readonly section: "saving" | "buying"; readonly message: string } | null;
  /** What differs from what the dialog opened on, whether or not it can be saved. */
  readonly changes: { readonly rule: boolean; readonly buying: boolean };
  /** Said before Save: a cap that moved, a leg too small to measure, a paused policy that stays paused. */
  readonly notices: readonly string[];
  /** Legs the stored policy does not hold: Save waits for the issuer-powers box (`acknowledge`). */
  readonly newLegs: readonly CatalogueAsset[];
  /** The issuer-powers sentence over the whole new basket, when it adds a leg; null otherwise. */
  readonly acknowledge: string | null;
  /** How many times the wallet will ask: one per instruction that changes. */
  readonly approvals: number;
}

/** The picks as one comparable string, whatever order they are in. */
const picksOf = (picked: readonly SettingsPick[]): string =>
  picked
    .map((pick) => `${pick.id}:${pick.percent.trim()}`)
    .sort()
    .join(",");

const thresholdRawOf = (text: string): bigint | null => {
  try {
    return parseUnits(text, USDC_DECIMALS, SETTINGS_COPY.threshold);
  } catch (error) {
    if (error instanceof AmountError) return null;
    throw error;
  }
};

/**
 * ONE PRESS OF SAVE: what is signed, in which order, or why nothing is.
 *
 * Saving first (the host queues the policy behind the rule and drops it if the
 * rule does not land), each half planned only when it changed, and each with
 * every field it writes.
 */
export function planSettings(input: SettingsPlanInput): SettingsPlan {
  const { state, seed, draft } = input;
  const opened = seed.draft;
  const ruleChanged = draft.mode !== opened.mode || draft.rateBps !== opened.rateBps || draft.paused !== opened.paused;

  const buying = seed.buying;
  let buyingChanged = false;
  if (buying.kind === "policy") {
    // AGAINST WHAT THE FORM OPENED ON, not against the stored legs: a stored
    // leg the shelf no longer offers is left off the form (policyEditSeed), and
    // measured against the chain the untouched form would read as a change —
    // blocking a pause or a new rate behind a basket nobody edited.
    const typed = thresholdRawOf(draft.threshold);
    buyingChanged = picksOf(draft.picked) !== picksOf(opened.picked) || typed === null || typed !== thresholdRawOf(opened.threshold);
  } else if (buying.kind === "choice") {
    const was = new Set(buying.choice.kind === "stocks" ? buying.choice.mints : []);
    const now = new Set(draft.picked.map((pick) => pick.id));
    buyingChanged = was.size !== now.size || [...now].some((mint) => !was.has(mint));
  }
  const changes = { rule: ruleChanged, buying: buyingChanged };
  const approvals = (ruleChanged ? 1 : 0) + (buyingChanged && buying.kind === "policy" ? 1 : 0);
  const refused = (section: "saving" | "buying", message: string, newLegs: readonly CatalogueAsset[] = []): SettingsPlan => ({
    rule: null,
    policy: null,
    choice: null,
    problem: { section, message },
    changes,
    notices: [],
    newLegs,
    acknowledge: null,
    approvals,
  });

  // ── SAVING: set_policy_v2, all six fields ──
  let rule: VaultRuleRequest | null = null;
  const switchingToVolume = ruleChanged && draft.mode === "volume" && opened.mode !== "volume";
  if (ruleChanged) {
    const account = state.vault.status === "exists" ? (state.vault.state ?? null) : null;
    if (account === null) return refused("saving", VAULT_COPY.unreadable);
    // The build route refuses a volume rule before it reads anything (volume_not_offered),
    // and the keeper settles nothing for a volume vault that trades.
    if (draft.mode === "volume" && !input.volumeOffered) return refused("saving", LIVE_COPY.volumeNotOffered);
    const range = RATE_RANGES[draft.mode];
    if (!Number.isInteger(draft.rateBps) || draft.rateBps < range.min || draft.rateBps > range.max) {
      return refused("saving", SETTINGS_COPY.rateOutOfRange(ratePercent(range.min), ratePercent(range.max)));
    }
    const maxContribution = rawFrom(account.maxContribution);
    const walletReserve = rawFrom(account.walletReserve);
    // The two limits the dialog does not show go back exactly as stored — or nothing goes.
    if (maxContribution === null || walletReserve === null) return refused("saving", VAULT_COPY.unreadable);
    rule = {
      mode: draft.mode === "volume" ? MODE_VOLUME : MODE_PROFIT,
      skimBps: draft.mode === "profit" ? draft.rateBps : account.skimBps,
      volumeBps: draft.mode === "volume" ? draft.rateBps : account.volumeBps,
      paused: draft.paused,
      maxContribution,
      walletReserve,
    };
  }

  // ── BUYING ──
  let policy: InvestRequest | null = null;
  let choice: BasketChoice | null = null;
  // What switching to Volume means, said before the wallet asks (owner, 09-25).
  const notices: string[] = switchingToVolume ? [...SETTINGS_COPY.volumeSwitch] : [];
  let newLegs: readonly CatalogueAsset[] = [];
  let acknowledge: string | null = null;

  if (buyingChanged && buying.kind === "policy") {
    const plan = settingsPolicyPlan({
      picked: draft.picked,
      threshold: draft.threshold,
      stored: buying.caps,
      enabled: buying.enabled,
      venue: buying.venue,
      heldMints: buying.policy.legs.map((leg) => leg.mint),
    });
    if (plan.problem !== null || plan.request === null) return refused("buying", plan.problem ?? INVEST_COPY.resignUnreadable, plan.newLegs);
    policy = plan.request;
    newLegs = plan.newLegs;
    if (plan.capMoved !== null) notices.push(SETTINGS_COPY.capMoved(formatUsd(plan.capMoved.from), formatUsd(plan.capMoved.to)));
    if (plan.lightest !== null && plan.lightestSliceRaw !== null && plan.lightestSliceRaw <= SMALL_SLICE_RAW) {
      notices.push(SETTINGS_COPY.smallLeg(plan.lightest.symbol, formatUsd(plan.lightestSliceRaw)));
    }
    if (!buying.enabled) notices.push(SETTINGS_COPY.buyingStaysPaused);
    if (newLegs.length > 0) acknowledge = INVEST_COPY.acknowledge(signedLegsOf(plan.legs.map((leg) => leg.asset)));
  } else if (buyingChanged && buying.kind === "choice") {
    // Only what setup offers can be kept as a choice: the start card signs it from OFFERED_LEGS.
    const unoffered = draft.picked.filter((pick) => !OFFERED_LEGS.some((leg) => leg.mint === pick.id));
    if (unoffered.length > 0) {
      const first = unoffered[0]!;
      return refused("buying", SETTINGS_COPY.notOnShelf(catalogueAsset(first.id)?.symbol ?? shortAddress(first.id)));
    }
    const mints = OFFERED_LEGS.map((leg) => leg.mint).filter((mint) => draft.picked.some((pick) => pick.id === mint));
    choice = mints.length === 0 ? { kind: "sol" } : { kind: "stocks", mints };
  }

  return { rule, policy, choice, problem: null, changes, notices, newLegs, acknowledge, approvals };
}

// ── (4) "REFRESH PRICE LIMITS" ──────────────────────────────────────────────

/**
 * THE STORED POLICY RE-SIGNED AT TODAY'S PRICES: byte-for-byte what the
 * investing card's "Sign again" sends (InvestingCard.tsx PolicySummary) — the
 * stored caps, `enabled` as stored, the stored basket by mint and its own
 * minimum, the venue left to the route's default. The server builds the new
 * floors from today's pools, net of the higher of the live and written fee.
 *
 * One difference, for an unreadable field only: "Sign again" would send a
 * 30-day cap it could not read as 0n; this refuses instead.
 */
export function refreshRequest(policy: InvestmentPolicyJson): InvestRequest | { readonly problem: string } {
  const resign = resignStoredPolicy(policy);
  if (!resign.ok) return { problem: resign.message };
  const maxPerCall = rawFrom(policy.maxPerCall);
  const maxRolling30d = rawFrom(policy.maxRolling30d);
  if (maxPerCall === null || maxRolling30d === null) return { problem: INVEST_COPY.resignUnreadable };
  return { maxPerCall, maxRolling30d, enabled: policy.enabled, minInvestment: resign.minInvestment, weights: resign.weights };
}

// ── (5) THE SHELF, BY CATEGORY ──────────────────────────────────────────────

/** The order the dialog lists groups in: listed shares and funds first. */
const GROUP_ORDER: readonly CatalogueAsset["group"][] = ["xstock", "prestock"];

/**
 * THE CATALOGUE AS THE DIALOG LISTS IT: one category per asset group, the
 * offered assets tickable (id = mint, art by mint), the refused ones only
 * named — never a tile somebody could tick into a basket the route refuses.
 */
export function liveCategories(): readonly SettingsCategory[] {
  const rows = catalogueRows();
  const groups = [...GROUP_ORDER, ...rows.map((row) => row.asset.group).filter((group) => !GROUP_ORDER.includes(group))].filter(
    (group, index, all) => all.indexOf(group) === index,
  );
  return groups
    .map((group): SettingsCategory => {
      const inGroup = rows.filter((row) => row.asset.group === group);
      return {
        id: group,
        title: SETTINGS_COPY.categories[group],
        help: SETTINGS_COPY.help[group],
        assets: inGroup
          .filter((row) => row.offerable)
          .map((row) => {
            const logo = artForMint(row.asset.mint);
            return { id: row.asset.mint, symbol: row.asset.symbol, name: row.asset.name, ...(logo === null ? {} : { logo }) };
          }),
        unavailable: inGroup.filter((row) => !row.offerable).map((row) => row.asset.symbol),
      };
    })
    .filter((category) => category.assets.length + category.unavailable.length > 0);
}
