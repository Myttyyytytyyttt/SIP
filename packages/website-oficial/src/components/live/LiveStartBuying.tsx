"use client";

/**
 * "YOUR FIRST SAVINGS ARRIVED": the buying approval the new-user setup promised.
 *
 * THE OWNER'S RULE (09-24): the setup's vault step lets a person choose what
 * their savings become — SOL, or the offered stocks at an equal split — and
 * signs only the vault. The investing policy is asked for HERE, once the first
 * settlement has landed, so its price limits are that day's and the rent is
 * spent on a pension that has actually started saving.
 *
 * IT SIGNS WHAT THE INVESTING FORM WOULD SIGN for the same basket. The request
 * is built by InvestingCard's own pure pieces — readWeights, readMinimum,
 * readCaps, basketLimits, policyRequest — with the form's own defaults (the
 * catalogue's split minimum, the 30-day cap, the default venue) and one
 * difference, named: the most per buy is a fixed START_BUYING_PER_BUY_RAW held
 * inside the basket's window, well under the depth ceiling, rather than the
 * form's suggestion. The same write path signs it (useVaultWrite.investPolicy),
 * under the page's one lock, and the flow checks the build before Phantom asks.
 *
 * SHORT, NOT PARTIAL. Three lines say what changes, what can stop it and what
 * the price limits do; every paragraph the full form shows before the same
 * signature sits under "What exactly am I signing?", and the box to tick is the
 * form's own sentence, word for word.
 *
 * IT SHOWS ONLY WHEN IT CAN BE TRUE: a live pension whose first settlement has
 * landed, with no policy on either read, and a stored choice of stocks that are
 * still on the shelf. "Keep as SOL" records that choice and the card is gone.
 */

import {
  BUNDLED_VAULT_TOKEN_ACCOUNT_CREATES,
  CONVERT_FLOOR_MARGIN_BPS,
  DEFAULT_INVEST_CAPS,
  LEG_FLOOR_MARGIN_BPS,
  OFFERED_LEGS,
  SIGNATURE_FEE_LAMPORTS,
  TOKEN_PROGRAM,
  USDC_MINT,
  WSOL_MINT,
  defaultInvestPolicy,
  legFloorMarginBps,
  ownerComputeBudget,
  priorityFeeLamports,
} from "@sip/solana-core/client";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SigningDetail, atMostUsd, pickedLegLimits, policyRequest, readCaps, readMinimum, readWeights } from "@/components/wallets/InvestingCard";
import { TxProgress } from "@/components/wallets/TxProgress";
import { useBasketChoice } from "@/hooks/use-onboarding-closed";
import { useVaultWrite, type InvestRequest } from "@/hooks/use-vault-actions";
import { useVaultScreen } from "@/hooks/use-vault-state";
import { USDC_DECIMALS, formatSol, formatUnits, formatUsd, rawFrom } from "@/lib/amounts";
import { LABEL } from "@/lib/classes";
import { basketLimits, evenPercents, overCeiling, type BasketLimits, type PickedLeg } from "@/lib/basket-picker";
import { todaysLimits } from "@/lib/invest-limits";
import { START_BUYING_COPY } from "@/lib/live-copy";
import type { LiveDashboard } from "@/lib/live-types";
import { basketOnShelf } from "@/lib/onboarding";
import { saveBasketChoice } from "@/lib/onboarding-memory";
import type { VaultStateJson } from "@/lib/vault-api";
import { DEFAULT_VENUE_NAME } from "@/lib/vault-flows";
import { INVEST_COPY, MAX_LEG_FEE_BPS, VAULT_COPY, judgedFeeOf, listAnd, ratePercent, signedLegsOf, writtenFeeWords } from "@/lib/vault-copy";

/**
 * THE MOST ONE BUY MAY SPEND for a basket started here: $25.
 *
 * The keeper checks each leg's route depth at the policy's cap, all or nothing,
 * so a cap near the depth ceiling buys nothing on a thin day — ANTHROPIC's
 * counted route puts that ceiling near $298 for a 50/50 basket. $25 clears the
 * floor of every basket the setup offers ($5 for two equal legs) with a wide
 * margin under that ceiling, and a first pension's settlements are small. The
 * owner can raise it from the investing card, which recomputes the window.
 */
export const START_BUYING_PER_BUY_RAW = 25_000_000n;

export interface StartBuyingPlan {
  /** What would be signed, or null when this basket cannot be signed from here today. */
  readonly request: InvestRequest | null;
  readonly legs: readonly PickedLeg[];
  /** The whole buy that clears every leg's minimum: nothing is bought before this much USDC is ready. */
  readonly purchaseRaw: bigint | null;
  /** The basket's cap window (its depth ceiling and the leg that sets it), or null when it could not be worked out. */
  readonly window: BasketLimits | null;
}

/**
 * WHAT THIS CARD WOULD SIGN for these stocks: the investing form's own
 * arithmetic, over the offered shelf only, at equal whole percents.
 */
export function startBuyingPlan(mints: readonly string[]): StartBuyingPlan {
  const assets = OFFERED_LEGS.filter((leg) => mints.includes(leg.mint));
  if (assets.length === 0) return { request: null, legs: [], purchaseRaw: null, window: null };
  const weights = readWeights(
    evenPercents(assets.length).map(String),
    assets,
  );
  if (!weights.ok) return { request: null, legs: [], purchaseRaw: null, window: null };
  const legs = assets.map((asset) => ({ asset, weightBps: weights.byMint.get(asset.mint)! }));
  // The form's own starting minimum: the catalogue's $5, split over the shelf.
  const minimumText = formatUnits(defaultInvestPolicy(OFFERED_LEGS.length).minInvestment, USDC_DECIMALS);
  const minimum = readMinimum(minimumText, null);
  if (!minimum.ok) return { request: null, legs, purchaseRaw: null, window: null };
  const window = basketLimits(legs, minimum.raw);
  // $25, held inside the window: never under the floor this basket can buy at, never over its ceiling.
  let perBuy = START_BUYING_PER_BUY_RAW < window.floorRaw ? window.floorRaw : START_BUYING_PER_BUY_RAW;
  if (window.ceilingRaw !== null && perBuy > window.ceilingRaw) perBuy = window.ceilingRaw;
  const caps = readCaps(formatUnits(perBuy, USDC_DECIMALS), formatUnits(DEFAULT_INVEST_CAPS.maxRolling30d, USDC_DECIMALS), window.floorRaw);
  const perLeg = readMinimum(
    minimumText,
    caps.ok ? caps.maxPerCall : null,
    legs.map((leg) => leg.weightBps),
  );
  const overDepth = caps.ok && (window.empty || overCeiling(caps.maxPerCall, window));
  const request = policyRequest({ caps, minimum: perLeg, weights, overDepth, enabled: true, venue: DEFAULT_VENUE_NAME });
  return { request, legs, purchaseRaw: window.floorRaw, window };
}

/**
 * THE RENT THIS SIGNATURE WILL CHARGE, as the build charges it: the policy's,
 * if it is missing, and the first BUNDLED_VAULT_TOKEN_ACCOUNT_CREATES missing
 * vault token accounts among wSOL, USDC and the CHOSEN stocks, in the order the
 * server reads them. Every other stock account is created later by the keeper,
 * at its own cost — counting it here would quote rent the owner never pays.
 * Null when anything it needs could not be read: said, never guessed.
 */
export function startBuyingRent(state: VaultStateJson, mints: readonly string[]): bigint | null {
  const { rents } = state;
  if (rents === null || state.vaultTokenAccounts.status !== "exists") return null;
  let total = state.policy.status === "missing" ? rawFrom(rents.policy) : 0n;
  if (total === null) return null;
  const policyMints = new Set([WSOL_MINT, USDC_MINT, ...mints]);
  const missing = state.vaultTokenAccounts.items.filter((account) => policyMints.has(account.mint) && account.status !== "exists");
  for (const account of missing.slice(0, BUNDLED_VAULT_TOKEN_ACCOUNT_CREATES)) {
    if (account.status !== "missing") return null;
    const rent = rawFrom(account.tokenProgram === TOKEN_PROGRAM ? rents.tokenAccount : rents.legTokenAccounts[account.mint]);
    if (rent === null) return null;
    total += rent;
  }
  return total;
}

/**
 * Where the card may stand. No Privy hook runs here: the card itself, which
 * signs, mounts only once every condition holds.
 */
export function LiveStartBuying({ data, pensionKey, onRefresh }: { readonly data: LiveDashboard; readonly pensionKey: string; readonly onRefresh: () => void }) {
  const choice = useBasketChoice(pensionKey);
  const screen = useVaultScreen();
  /**
   * WHAT THE CARD WAS LAST SHOWN WITH, and whether its write is still in hand.
   * A poll that flips a read under a card whose wallet is being asked — or whose
   * send is unconfirmed — must not take the card, its progress and its Check
   * again away: it stays, on the last state it was shown, until the write ends.
   */
  const shown = useRef<{ readonly state: VaultStateJson; readonly mints: readonly string[] } | null>(null);
  const [holding, setHolding] = useState(false);
  const basket = choice === null ? null : basketOnShelf(choice);
  const view = screen?.view ?? null;
  const eligible =
    // The first savings have landed, and the live read says there is no policy…
    data.stage === "active" &&
    data.policy.status === "missing" &&
    // …stocks were chosen here, and are still on the shelf…
    basket !== null &&
    basket.kind === "stocks" &&
    // …and the vault screen's own read is this key's and agrees there is none.
    view !== null &&
    view.kind === "ready" &&
    view.state.owner === pensionKey &&
    view.state.policy.status === "missing";

  // THE PRICES IT SHOWS AND IS CHECKED AGAINST ARE READ NOW. The vault screen is
  // read on changes, not on a timer, so its last answer can be hours old by the
  // time the first settlement lands; the build refuses a price that moved more
  // than 5 % from the one shown, and would refuse it on every retry.
  const refreshVault = screen?.refresh ?? null;
  const asked = useRef(false);
  const becameEligible = data.stage === "active" && data.policy.status === "missing" && basket !== null && basket.kind === "stocks";
  useEffect(() => {
    if (!becameEligible || asked.current || refreshVault === null) return;
    asked.current = true;
    refreshVault();
  }, [becameEligible, refreshVault]);

  if (eligible && view !== null && view.kind === "ready" && basket !== null && basket.kind === "stocks") shown.current = { state: view.state, mints: basket.mints };
  if (!eligible && !holding) return null;
  if (shown.current === null) return null;
  return (
    <StartBuyingCard
      state={shown.current.state}
      mints={shown.current.mints}
      pensionKey={pensionKey}
      onRefresh={onRefresh}
      onRefreshVault={refreshVault}
      onHolding={setHolding}
    />
  );
}

function StartBuyingCard({
  state,
  mints,
  pensionKey,
  onRefresh,
  onRefreshVault,
  onHolding,
}: {
  readonly state: VaultStateJson;
  readonly mints: readonly string[];
  readonly pensionKey: string;
  readonly onRefresh: () => void;
  readonly onRefreshVault: (() => void) | null;
  readonly onHolding: (holding: boolean) => void;
}) {
  const write = useVaultWrite("start-buying");
  const [acknowledged, setAcknowledged] = useState(false);
  const [signed, setSigned] = useState<InvestRequest | null>(null);

  // A landed policy: the dashboard reads again, and the card goes with the policy it created.
  // A refusal: the vault is read again too, so a retry is judged against today's prices, not the ones that were refused.
  const seen = useRef(new WeakSet<object>());
  const latestRefresh = useRef(onRefresh);
  latestRefresh.current = onRefresh;
  const latestRefreshVault = useRef(onRefreshVault);
  latestRefreshVault.current = onRefreshVault;
  useEffect(() => {
    const progress = write.progress;
    if (progress.phase !== "finished" || seen.current.has(progress)) return;
    seen.current.add(progress);
    if (progress.kind !== "policy") return;
    if (progress.result.ok) latestRefresh.current();
    else if (progress.result.kind === "refused") latestRefreshVault.current?.();
  }, [write.progress]);

  // The card is held on screen while its write is in hand: asked, sent, or stopped with a way forward.
  const landed = write.progress.phase === "finished" && write.progress.result.ok;
  const inHand = write.running || write.unconfirmed || (write.progress.phase === "finished" && !write.progress.result.ok);
  const hold = useCallback((next: boolean) => onHolding(next), [onHolding]);
  useEffect(() => {
    hold(inHand);
  }, [inHand, hold]);
  useEffect(() => () => hold(false), [hold]);

  const plan = startBuyingPlan(mints);
  const assets = plan.legs.map((leg) => leg.asset);
  const copyLegs = signedLegsOf(assets);
  const symbols = assets.map((asset) => asset.symbol);
  const basketText = plan.legs.length <= 1 ? listAnd(symbols) : `${listAnd(symbols)}, ${ratePercent(plan.legs[0]!.weightBps)} each`;
  const limits = todaysLimits(state.prices);
  const rent = startBuyingRent(state, plan.legs.map((leg) => leg.asset.mint));
  const fees = SIGNATURE_FEE_LAMPORTS + priorityFeeLamports(ownerComputeBudget("set_invest_policy"));
  const purchase = plan.purchaseRaw === null ? null : formatUsd(plan.purchaseRaw);
  // Landed is blocked too: until the fresh read hides this card, a second press would sign a second policy.
  const blocked = write.running || write.busyElsewhere || write.unconfirmed || landed;
  const ceiling = plan.window?.ceilingRaw ?? null;
  const binding = plan.window?.ceilingBinding ?? null;
  const request = plan.request;
  const feeLegs = copyLegs.filter((leg) => leg.feeBps !== null && leg.feeBps > 0);

  return (
    <Card data-start-buying="">
      <CardHeader>
        <CardTitle className="text-base">{START_BUYING_COPY.title}</CardTitle>
        <CardDescription>{START_BUYING_COPY.lede(basketText)}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <ul className="list-disc space-y-1 pl-4 text-xs text-muted-foreground marker:text-muted-foreground/60">
          {/* Always said, prices or not: once a policy exists, every lamport saved is converted. */}
          <li>{START_BUYING_COPY.convert(limits === null ? null : formatUsd(limits.floorPerSol), purchase)}</li>
          {limits === null ? <li>{INVEST_COPY.pricesUnknown}</li> : null}
          {feeLegs.map((leg) => (
            <li key={leg.symbol}>{START_BUYING_COPY.fee(leg.symbol, ratePercent(leg.feeBps ?? 0), writtenFeeWords(leg), ratePercent(MAX_LEG_FEE_BPS))}</li>
          ))}
          <li>
            {START_BUYING_COPY.limits(
              ratePercent(CONVERT_FLOOR_MARGIN_BPS),
              ratePercent(LEG_FLOOR_MARGIN_BPS),
              feeLegs.map((leg) => ({ symbol: leg.symbol, margin: ratePercent(legFloorMarginBps(judgedFeeOf(leg) ?? 0)) })),
            )}
          </li>
        </ul>

        {/* Everything the investing form says before this same signature, one click away. */}
        <details className="rounded-md border px-3 py-2 text-xs">
          <summary className="cursor-pointer font-medium">{START_BUYING_COPY.details}</summary>
          <div className="mt-2 space-y-2 text-muted-foreground">
            {request !== null ? (
              <p>
                {INVEST_COPY.policyRule(
                  listAnd(plan.legs.map((leg) => `${leg.asset.symbol} at ${ratePercent(leg.weightBps)}`)),
                  limits === null ? "today's floor" : formatUsd(limits.floorPerSol),
                  purchase,
                  formatUsd(request.maxPerCall),
                  formatUsd(request.maxRolling30d),
                  rent === null ? "some" : formatSol(rent),
                )}
              </p>
            ) : null}
            <div className="space-y-1">
              <div className={LABEL}>{INVEST_COPY.floorsTitle}</div>
              {limits === null ? (
                <p>{INVEST_COPY.pricesUnknown}</p>
              ) : (
                <>
                  <p>{INVEST_COPY.solFloor(formatUsd(limits.floorPerSol), formatUsd(limits.todayPerSol))}</p>
                  {pickedLegLimits(limits.legs, assets).map((leg) => (
                    <p key={leg.mint}>{INVEST_COPY.legCeiling(leg.symbol, formatUsd(leg.maxPer1e8), leg.feeBps > 0 ? ratePercent(leg.feeBps) : null, leg.marginBps)}</p>
                  ))}
                  <p>{INVEST_COPY.convertFloorEffect(ratePercent(CONVERT_FLOOR_MARGIN_BPS))}</p>
                </>
              )}
            </div>
            <div className="space-y-1">
              <div className={LABEL}>{INVEST_COPY.thinPoolTitle}</div>
              <p>
                {ceiling !== null && binding !== null && request !== null
                  ? START_BUYING_COPY.depth(atMostUsd(ceiling), formatUsd(request.maxPerCall), binding.symbol, INVEST_COPY.censusProvenance(binding.readOn ?? "an unrecorded day", binding.derived))
                  : INVEST_COPY.ceilingUnknown(listAnd((plan.window?.uncounted ?? []).map((leg) => leg.symbol)) || listAnd(symbols))}
              </p>
            </div>
            <div className="space-y-1">
              <div className={LABEL}>{INVEST_COPY.costTitle}</div>
              <p>{INVEST_COPY.issuerCost(copyLegs)}</p>
              <p>{INVEST_COPY.feeCeiling(copyLegs, ratePercent(MAX_LEG_FEE_BPS))}</p>
              <p>{INVEST_COPY.marketCost(copyLegs)}</p>
              <p>{INVEST_COPY.defencesLimits(copyLegs, ratePercent(LEG_FLOOR_MARGIN_BPS))}</p>
            </div>
            <p>{INVEST_COPY.freezeNotice(copyLegs)}</p>
            <p>{INVEST_COPY.issuerKeys(copyLegs)}</p>
            <p>{INVEST_COPY.hookSwitch(copyLegs)}</p>
          </div>
        </details>

        {landed ? null : (
        <>
        <label className="flex items-start gap-2 rounded-md border border-amber-600/30 bg-amber-600/5 px-3 py-2 text-xs">
          <input
            type="checkbox"
            name="start-buying-acknowledge"
            checked={acknowledged}
            disabled={blocked}
            onChange={(event) => setAcknowledged(event.target.checked)}
            className="mt-0.5 size-4 shrink-0 accent-primary"
          />
          <span>{INVEST_COPY.acknowledge(copyLegs)}</span>
        </label>

        {request === null ? <p className="text-xs text-muted-foreground">{START_BUYING_COPY.cannotPlan}</p> : null}
        <p className="text-xs">{rent === null ? VAULT_COPY.costUnknown : START_BUYING_COPY.cost(formatSol(rent), formatSol(fees))}</p>

        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            disabled={!acknowledged || request === null || blocked}
            aria-busy={write.running}
            // No handler when there is nothing signable; the same guard as the button's own for the rest.
            onClick={
              request === null
                ? undefined
                : () => {
                    if (!acknowledged || blocked) return;
                    setSigned(request);
                    void write.investPolicy(request);
                  }
            }
          >
            {write.running ? START_BUYING_COPY.starting : START_BUYING_COPY.start}
          </Button>
          <Button type="button" variant="outline" disabled={blocked} onClick={() => saveBasketChoice(pensionKey, { kind: "sol" })}>
            {START_BUYING_COPY.keepSol}
          </Button>
        </div>
        </>
        )}

        <TxProgress
          progress={write.progress}
          successLabel={START_BUYING_COPY.started}
          onBuildAgain={() => void write.buildAgain()}
          onCheckAgain={() => void write.checkAgain()}
          onDismiss={() => write.dismiss()}
          approveDetail={<SigningDetail progress={write.progress} request={signed} />}
        />
      </CardContent>
    </Card>
  );
}
