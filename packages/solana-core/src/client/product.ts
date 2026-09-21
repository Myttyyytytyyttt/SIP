// What SIP offers a new vault and its first investment policy, decided once and
// kept beside the rules those values must pass. Browser-safe: the forms, the
// build route and the local proof read the same numbers.
//
// test/product.test.ts pins every value here to rules.ts and to the verifier's
// caps, so a changed default fails a test before it reaches a wallet.
//
// THE VOLUME DECISION IS ONE CONSTANT. The keeper cannot yet settle VOLUME from
// real trades (settle-decision.ts UNSUPPORTED_MODE), so a volume vault would
// receive nothing. Until the owner decides to build the volume meter, the web
// offers PROFIT only: the build route refuses mode 1 and the form greys it out.
// The program itself accepts VOLUME vaults from any client, which is intended.
//
// WHY THESE CAPS (review findings 1 and 2 on the program):
//  * max_contribution 0.06 SOL bounds one settlement. At about $100 a SOL it is
//    $6.00, $5.9999 after the SOL/USDC pool's 0.04 % fee, so one settle can fund
//    the first $5 buy down to about $83 a SOL. It does not bound how many
//    settlements run; nothing on chain does.
//  * wallet_reserve 0.05 SOL is the one web-chosen bound on a settle burst: a
//    settlement that would leave less than rent(0) + reserve is refused.
//  * max_per_call 1,000 USDC is the largest value that keeps convert at its
//    tightest program bound, 1 SOL per call (convert.rs compares lamports with
//    max(max_per_call, 1e9)). rules.ts's default, u64::MAX, leaves convert
//    unbounded per call. This overrides "caps at the maximum"; the owner confirms.
//  * max_rolling_30d = 31 × max_per_call: one maximum buy per day-bucket.
//
// AND AT max_per_call THE KEEPER BUYS NOTHING. This is a DEFECT, measured
// 2026-09-21 and still standing in the number below, not a decision. The
// arithmetic is the keeper's own, in solana-keeper/src/invest-decision.ts:
//  * a CONVERTING turn is tested at its worst reachable case, because the USDC
//    the convert will bring in does not exist yet — turnSpendCeiling takes
//    min(max_per_call, 30-day headroom), which on a fresh vault is the whole
//    1,000 USDC;
//  * legShare splits that by weight: at today's two equal legs, 500 USDC into
//    ONE pool;
//  * legDepthDecision then requires that pool's in-side reserve to cover the
//    spend MIN_VENUE_INVENTORY_MULTIPLE (50) times over — 25,000 USDC for a
//    500-USDC leg.
// AND THE POOL THAT PARAGRAPH MEASURES IS NO LONGER THE ONE A BUY GOES THROUGH.
// It was written against Raydium, where the pinned pool was the route. Under
// Jupiter the keeper counts the inventory of the accounts the CHOSEN ROUTE
// names, and on 2026-09-21 a 200 USDC ANTHROPIC buy routed BisonFi + Manifest,
// touching the pinned pool not at all. The census behind that day's ceiling
// measurement implies about $7,450 reachable — $149 a leg at 50x cover — while
// the pinned pool held $9,204.14 (mainnet slot 448994132, down from
// 9,541,652,779 raw the day before) and the venue-wide figure for the same mint
// was $331,617. THREE NUMBERS, ALL TRUE, FORTY-FIVE TIMES APART: whoever quotes
// a depth must say which one it is. What survives of the old paragraph is its
// conclusion — at a $1,000 default the keeper buys nothing, on any of the three
// readings — and the picker's live ceiling (website-oficial/src/lib/basket-limits.ts)
// is what replaces the arithmetic, not another constant.
//
// WHAT SUCH A NUMBER IS CALIBRATED AGAINST, AND WHAT INVALIDATES IT. ONE pool's
// reserve, read ONCE, on ONE day. It is not a property of the product and no
// constant here can make it one: the same kind of reserve fell from about $6,700
// to $51 in two days on the leg this catalogue no longer offers. A third leg,
// different weights, a change in MIN_VENUE_INVENTORY_MULTIPLE, or that pool simply
// thinning all move the neck, and nothing in this file re-reads it. The gate
// that is always right is the keeper's, because it measures depth inside the
// turn against the amount that turn will really spend; a number here only
// decides whether the product's own default walks into that gate or clears it.
//
// WHY IT IS STILL 1,000. The web has already routed around it: InvestingCard's
// box starts at SUGGESTED_PER_BUY_RAW ($190, half the $380 ceiling) and no
// longer pre-fills this constant, so nobody signs $1,000 from the form today.
// Lowering the constant itself is a FOUR-FILE change, which the session that
// wrote this note was not scoped for — test/fixtures/owner-transactions.ts (the
// SET_INVEST_POLICY_GOLDEN_FLOORS wire and data hex are built from this value;
// reprint them with `pnpm --dir packages/solana-core exec tsx
// bin/print-owner-fixtures.mts`), test/handlers-build.test.ts (a pinned
// max_per_call, and a boundary case sized against 1,000), test/product.test.ts,
// and website-oficial/src/lib/vault-flows.test.ts: eleven tests in all. Leaving
// the number undocumented was the worse of the two options.

import {
  ANDURIL_MINT,
  ANTHROPIC_MINT,
  ANTHROPIC_USDC_POOL,
  FIGUREAI_MINT,
  FIGUREAI_USDC_POOL,
  KALSHI_MINT,
  NEURALINK_MINT,
  OPENAI_MINT,
  POLYMARKET_MINT,
  SPACEX_MINT,
  SPYX_MINT,
  SPYX_USDC_POOL,
  TOKEN_2022_PROGRAM,
} from "./addresses";
import type { OwnerInstructionName } from "./idl";
import { DEFAULT_PURCHASE_USDC_RAW, DEFAULT_RATES, MODE_PROFIT, type VaultPolicyInput } from "./rules";

/** The owner's open decision on VOLUME, off until the keeper can measure volume. Changing it must change a test. */
export const VOLUME_MODE_OFFERED: boolean = false;

/** What create_vault_v2 is built with when the request names nothing else. Both rates travel in both modes. */
export const DEFAULT_VAULT_POLICY: Readonly<VaultPolicyInput> = Object.freeze({
  mode: MODE_PROFIT,
  skimBps: DEFAULT_RATES.profitBps,
  volumeBps: DEFAULT_RATES.volumeBps,
  maxContribution: 60_000_000n,
  walletReserve: 50_000_000n,
});

/** The first investment policy's caps, in USDC raw units (6 decimals): $1,000 per buy, $31,000 per 30 days. */
export const DEFAULT_INVEST_CAPS = Object.freeze({ maxPerCall: 1_000_000_000n, maxRolling30d: 31_000_000_000n });

/** The convert floor sits this far under the live SOL/USDC pool price: 10 %. */
export const CONVERT_FLOOR_MARGIN_BPS = 1_000;
/** A leg's floor sits this far under the live pool rate: 5 %, so at most about 5.3 % over today's price is paid. */
export const LEG_FLOOR_MARGIN_BPS = 500;

/** A classic SPL Token account (the vault's wSOL and USDC accounts): 165 bytes. Its rent is read from the chain, never derived. */
export const CLASSIC_TOKEN_ACCOUNT_BYTES = 165;

// ── THE CATALOGUE ────────────────────────────────────────────────────────────
//
// WHAT AN ENTRY IS NOW. Under Raydium the catalogue could name the route: the
// keeper brought one swap through the one pool the entry pinned, so `pool` was
// the market, the floor's price and the depth measurement all at once. Under
// Jupiter (invest-decision.ts ROUTABLE_VENUES) THERE IS NO FIXED ROUTE — the
// router re-picks per quote, and it does not pick what this file pins. Measured
// 2026-09-21 against lite-api.jup.ag, a 200 USDC buy:
//   * SPYx routed Raydium CLMM pool 4pCZCVEi…, NOT the 6truu3rZ… pinned below;
//   * ANTHROPIC routed BisonFi + Manifest, touching its pinned pool not at all,
//     and a 5 USDC buy of the same mint routed GoonFi V2 + Whirlpool + Manifest.
// So `pool` is gone and `floorPool` has taken its place, meaning ONE thing: the
// Raydium CLMM/USDC pool the BUILD ROUTE READS A PRICE FROM when it signs a
// leg's min_out_rate_wad (server/build-handler.ts liveFloors over
// server/readers.ts PRICED_POOLS). It is a price source. It is not where the
// money goes, and nothing here may read as if it were.
//
// NOTHING BELOW IS CLAIMED WITHOUT A DATE AND A SOURCE. Every number an entry
// asserts about a market or a mint carries `readOn` and `by`: the day it was
// read on mainnet and the thing that read it, so a reader can run it again and
// so a figure that has aged out is visible as an old figure rather than as a
// fact. A field that was never measured is null, and null is never a pass —
// offerProblems refuses an unmeasured asset exactly as it refuses a failed one.
//
// WHAT THE CATALOGUE CANNOT DO, SAID ONCE HERE SO NO ENTRY HAS TO IMPLY
// OTHERWISE. It cannot promise a buy will clear. The gate that decides is the
// keeper's, inside the turn, against the size that turn really spends
// (invest-decision.ts legDepthDecision: a census of the accounts the chosen
// route names at MIN_VENUE_INVENTORY_MULTIPLE cover, plus a two-quote impact
// probe). A list written on a Monday cannot know Thursday's book. What this
// file does is narrower and still worth doing: it refuses to OFFER an asset
// that could not be bought at the size this product's own defaults produce on
// the day it was last measured, and it says on which rule each refusal rests.

/** Which product an asset is. The two groups differ in what their issuer can do to a holder, which is a product fact and is spelled out at PRESTOCKS_POWERS and XSTOCKS_POWERS. */
export type AssetGroup = "prestock" | "xstock";

/** The live transfer fee read off a mint, with the epoch it was live in: the issuer rewrites it at an epoch boundary, so the epoch is half the reading. */
export interface FeeReading {
  readonly bps: number;
  readonly epoch: number;
  readonly readOn: string;
  readonly by: string;
}

/**
 * What a venue was measured to hold of USDC, and — crucially — WHICH
 * measurement it is:
 *  * "route-census" counts only the accounts a resolved Jupiter route names,
 *    which is what the keeper's own gate counts (censusVenueInventory);
 *  * "venue-wide" sums a venue's books or bins, which no single route touches.
 * They are not the same number and the gap is not small: ANTHROPIC's venue-wide
 * USDC depth was 331,617 on 2026-09-21 while the census behind that day's
 * ceiling measurement implies about 7,450 — a factor of 45. A venue-wide figure
 * is therefore an UPPER BOUND on any census taken inside it: failing a bar with
 * one is decisive, passing it proves nothing.
 */
export interface DepthReading {
  readonly usdcRaw: bigint;
  readonly scope: "route-census" | "venue-wide";
  /** The venue as the router names it, so a reader knows what was counted. */
  readonly venue: string;
  readonly readOn: string;
  readonly by: string;
  /**
   * TRUE WHEN THE FIGURE WAS WORKED BACK FROM ANOTHER MEASUREMENT RATHER THAN
   * COUNTED, and the distinction is load-bearing all the way to the owner's
   * screen. `by` has always said so in prose — ANTHROPIC's census reads
   * "inverted from that day's ceiling measurement … not a direct count" — but
   * `by` and `scope` are never rendered, so the web called every one of these a
   * count. "Counted" is the word the copy leans on: the null branch says
   * "SaverFi has not counted…", so a derived figure printed as a count
   * collapses the one distinction the sentence relies on. A flag the UI can
   * read keeps the prose honest without re-deriving anything.
   *
   * ABSENT MEANS COUNTED. A reading that does not say it was derived is one
   * somebody took directly, which is the safe default for a field being added
   * to entries that were all written before it existed.
   */
  readonly derived?: boolean;
}

/**
 * How much worse a reference-sized buy is quoted than a sixteenth-sized probe,
 * in basis points — the shape of the keeper's ARM 2 (invest-decision.ts
 * impactFrom / maxTurnImpactBps), taken at build time.
 *
 * `sameVenues` IS THE SCOPE AND MUST BE READ. The keeper compares two quotes
 * only when both took the same venues in the same order, and abstains
 * otherwise. A catalogue reading with sameVenues false compared each size's own
 * best route instead: a coarser number, and a fair one for screening — if even
 * the best route at the reference size is this much worse than the best route
 * at a sixteenth of it, the market is thin at the size this product buys — but
 * it is NOT the keeper's verdict and must never be printed as one.
 */
export interface SizePenaltyReading {
  readonly bps: number;
  readonly atRaw: bigint;
  readonly probeRaw: bigint;
  readonly sameVenues: boolean;
  /** The venues each quote took, turn first, so the scope can be re-read rather than trusted. */
  readonly routes: string;
  readonly readOn: string;
  readonly by: string;
}

/** One asset the catalogue knows about, offered or not. */
export interface CatalogueAsset {
  readonly symbol: string;
  readonly name: string;
  readonly group: AssetGroup;
  readonly mint: string;
  readonly tokenProgram: string;
  readonly decimals: number;
  /** What the Associated Token Account program allocates for this mint, extensions included: the size its rent is read for. */
  readonly tokenAccountBytes: number;
  /**
   * The Raydium CLMM/USDC pool this leg's min_out_rate_wad is PRICED from, or
   * null when none is pinned — in which case SaverFi cannot sign a floor for
   * it, whatever its depth. NOT a route: see the note at the top of this block.
   */
  readonly floorPool: string | null;
  /** That pool's USDC-side reserve when it was last read: what it costs to move the price this product signs its floor against. */
  readonly floorPoolUsdc: DepthReading | null;
  /** The live transfer fee, or null when nobody has read it. An unread fee is not a zero fee. */
  readonly fee: FeeReading | null;
  /** The deepest USDC measurement anybody has taken of where a buy would actually land. */
  readonly depth: DepthReading | null;
  /**
   * THE ONE MEASUREMENT A CAP MAY BE DIVIDED BY, and it is not `depth`.
   *
   * The picker's ceiling (website-oficial/src/lib/basket-limits.ts depthCeiling)
   * answers "how large a max_per_call still clears the keeper's cover", and the
   * keeper's cover is counted over THE ACCOUNTS THE CHOSEN ROUTE NAMES
   * (invest-decision.ts censusVenueInventory). Divide a venue-wide figure by 50
   * instead and the answer is optimistic by exactly the factor between the two
   * — forty-five times, on ANTHROPIC, on the day both were read — and an
   * optimistic ceiling is the one direction a ceiling may never be wrong in: it
   * signs a policy that buys nothing, at any balance, with the rent spent.
   *
   * So a route census lives in ITS OWN FIELD and null means "nobody counted",
   * which the picker must render as a ceiling it does not know rather than as a
   * large one. It is deliberately NOT part of offerProblems: what is on the
   * shelf is decided by the bars above, and this only decides what the owner
   * may then type into Most per buy.
   */
  readonly routeCensus: DepthReading | null;
  readonly sizePenalty: SizePenaltyReading | null;
  /**
   * The day a HELD refusal may be re-examined, or null when the asset is not
   * quarantined. A date, not a clock: a module whose exports change because
   * time passed is a leg that appears in a basket nobody re-measured, so
   * clearing this is a human's edit after a fresh reading.
   */
  readonly quarantinedUntil: string | null;
  /** Sentences true of this asset alone. The group's facts live at PRESTOCKS_POWERS and XSTOCKS_POWERS and are not repeated per entry. */
  readonly notes: readonly string[];
}

/** An asset the rules admit: a catalogue asset whose floor can be priced, which is what the build route and the reserve readers require. */
export interface OfferedLeg extends CatalogueAsset {
  readonly floorPool: string;
  readonly floorPoolUsdc: DepthReading;
  readonly fee: FeeReading;
  readonly depth: DepthReading;
}

/**
 * WHAT ONE ISSUER KEY CAN DO TO A PRESTOCKS HOLDER, and it is one key.
 *
 * Read on mainnet 2026-09-21 (epoch 1039, slot 448993661) over all eight
 * PreStocks mints this file names: WV9PJN7XTmTLVwbutCLFxp8TyePee6Xq5mRq6Fti5Wc
 * is the mint authority AND the freeze authority AND the permanent delegate AND
 * the transfer-fee config authority of EVERY ONE of them, and each mint also
 * carries a Pausable extension and a transfer-hook extension (hook program id
 * null today, which is the only reason the relay can move them at all).
 *
 * In plain words: one key can mint more, freeze an account, pause the whole
 * mint, move a holder's tokens without the holder (permanent delegate), point
 * transfers at a hook program, and rewrite the transfer fee at any epoch
 * boundary. A vault holding a PreStock holds it at that key's discretion. That
 * is the product, not a defect, and it is the reason this group is named on the
 * page rather than folded in beside the equities.
 *
 * AND THE FEE IS ALREADY AT THE CEILING, ON ALL OF THEM. Every PreStocks mint
 * read that day charged 100 bps from epoch 1039 — exactly MAX_LEG_FEE_BPS,
 * which invest-decision.ts compares with `>`, so they are admitted with ZERO
 * MARGIN. One more issuer write refuses the whole basket, the deep legs and the
 * SOL conversion with it, until the fee comes back down.
 */
export const PRESTOCKS_POWERS = Object.freeze({
  issuerKey: "WV9PJN7XTmTLVwbutCLFxp8TyePee6Xq5mRq6Fti5Wc",
  oneKeyHolds: Object.freeze(["mint", "freeze", "permanent-delegate", "transfer-fee-config"]),
  pausable: true,
  transferHookProgram: null,
  readOn: "2026-09-21",
  by: "getMultipleAccounts over the eight PreStocks mints, mainnet, epoch 1039",
});

/**
 * WHAT AN XSTOCK ISSUER CAN AND — THIS IS THE STRONGER HALF — CANNOT DO.
 *
 * SPYx read on mainnet 2026-09-21: NO TransferFeeConfig extension at all. That
 * is not "no fee today". A Token-2022 mint's extensions are fixed when the mint
 * is initialised and cannot be added afterwards, so a mint without that
 * extension HAS NO AUTHORITY ANYWHERE ABLE TO GIVE IT ONE. The fee is zero for
 * the life of the mint, and that is a fact about the account layout rather than
 * a promise about a key's behaviour.
 *
 * WHAT IT DOES NOT MEAN, because the sentence is easy to over-read. SPYx still
 * carries a freeze authority (JDq14BWv…), a permanent delegate (5aMNNLQJ…), a
 * Pausable extension and a default-account-state extension — under DIFFERENT
 * keys from each other, unlike the PreStocks single key, but they are real
 * powers over a holder. The xStocks fact is about the FEE and nothing else.
 */
export const XSTOCKS_POWERS = Object.freeze({
  transferFeeExtension: false,
  feeAddableLater: false,
  why: "Token-2022 extensions are fixed at mint initialisation; a mint with no TransferFeeConfig can never gain one",
  stillHolds: Object.freeze(["freeze", "permanent-delegate", "pausable", "default-account-state"]),
  /**
   * THE MINTS THIS WAS ACTUALLY READ OVER, because 929 xStock mints exist and
   * ONE was read. PRESTOCKS_POWERS makes the same kind of group claim and earns
   * it: it was read over all eight mints it speaks for. This one was not, and
   * the sentence the picker prints from it is in the plural under a heading
   * keyed by group — true today only because SPYx is the sole xStock on the
   * shelf, and a claim the machinery would apply unchanged to the next one
   * added with no new reading required. Naming the mints read makes the copy
   * say what it knows, and makes adding an xStock without reading it visible.
   */
  mintsRead: Object.freeze(["SPYx"]),
  readOn: "2026-09-21",
  by: "getMultipleAccounts over the SPYx mint, mainnet, epoch 1039 — SPYx alone, not the xStocks range",
});

// ── THE SIZE EVERY CATALOGUE RULE IS MEASURED AT ─────────────────────────────
//
// A catalogue bar has to be stated at SOME size, and the honest one is the size
// THIS PRODUCT'S OWN DEFAULTS PRODUCE: max_per_call is a cap on the WHOLE
// basket and is split by weight, so the share one turn can push into one leg of
// a full basket is max_per_call over the number of legs the picker allows. That
// is 1,000 / 5 = 200 USDC, and it is where the 2026-09-21 readings were taken.
//
// WHY NOT THE SMALLEST BUY INSTEAD. Because an asset that only works when the
// owner lowers the cap is a trap in an all-or-nothing basket: one leg that
// cannot serve its share refuses the whole basket AND the SOL conversion, at
// any balance, on every sweep. Offering such an asset means offering a basket
// that silently stops buying. The picker still computes a live ceiling per
// basket (website-oficial/src/lib/basket-limits.ts depthCeiling) and that
// remains the number the owner signs against; the bar here decides only whether
// an asset is on the shelf at all.

/** The most legs the picker offers, which is the owner's "maximo como 5", not the program's MAX_LEGS of 8. The website's PICKER_MAX_LEGS re-exports it. */
export const MAX_PICKED_LEGS = 5;

/** The leg share every rule below is measured at: max_per_call split across a full basket, 200 USDC at the shipped caps. */
export const CATALOGUE_REFERENCE_LEG_RAW = DEFAULT_INVEST_CAPS.maxPerCall / BigInt(MAX_PICKED_LEGS);

/**
 * The keeper's MIN_VENUE_INVENTORY_MULTIPLE, restated here because the browser
 * may not import the keeper (its package.json is what ships to Railway, and the
 * repo forbids the dependency in both directions). test/fixtures/keeper-policy.ts
 * is the committed vector both sides assert against, and product.test.ts holds
 * this copy to it.
 */
export const CATALOGUE_VENUE_INVENTORY_MULTIPLE = 50n;

/** The keeper's MAX_LEG_FEE_BPS, same reason, same vector. Compared with `>`, so a fee sitting exactly on it is admitted with no margin. */
export const CATALOGUE_MAX_FEE_BPS = 100;

/** The keeper's SLIPPAGE_BPS (min-out.ts), same reason, same vector: the whole budget between a quote and its fill. */
export const CATALOGUE_SLIPPAGE_BPS = 200;

/** What a venue must hold of USDC for the reference leg to clear the keeper's cover: 50 x 200 USDC = 10,000. */
export const CATALOGUE_MIN_VENUE_DEPTH_RAW = CATALOGUE_REFERENCE_LEG_RAW * CATALOGUE_VENUE_INVENTORY_MULTIPLE;

/**
 * What a FLOOR SOURCE must hold of USDC to count as a price: 50 x the smallest
 * purchase this product makes, 250 USDC.
 *
 * WHY A POOL'S DEPTH DECIDES WHETHER ITS PRICE IS A PRICE. A leg's floor is the
 * only price defence a stock leg has — Pyth anchors the SOL hop and nothing
 * anchors the stocks — and it is signed ONCE, from this pool's mid, and then
 * stands until the owner signs again. A mid that costs a few dollars to move is
 * a mid an attacker sets at the moment of signing, and a floor signed off it is
 * wrong for the life of the policy. The bar is deliberately the small one: it
 * asks that the price source be a market at all, not that it be deep.
 */
export const CATALOGUE_MIN_FLOOR_POOL_RAW = CATALOGUE_VENUE_INVENTORY_MULTIPLE * DEFAULT_PURCHASE_USDC_RAW;

/** What ARM 2 allows the reference leg to cost in its own impact: a quarter of what the slippage budget has left after the issuer's fee. */
export const sizePenaltyCeilingBps = (feeBps: number): number => Math.max(0, Math.floor((CATALOGUE_SLIPPAGE_BPS - feeBps) / 4));

// ── THE RULES, WHICH ARE THE CATALOGUE ───────────────────────────────────────
//
// The list is not hand-picked and must not become so: OFFERED_LEGS is the
// subset of CATALOGUE that offerProblems() finds nothing wrong with. To add an
// asset, measure it and write the readings down; if it then passes, it is
// offered, and if it does not, the function says which rule refused it in a
// sentence the entry did not get to write. That is the whole design — a reader
// who disagrees with an exclusion can re-run its rule instead of arguing with a
// list.

/** The rules an asset must pass to be offered, in the order they are applied. Every refusal in this file names one of these. */
export const OFFER_RULES = Object.freeze({
  /** A USDC route must have been quoted for it. Nothing can be bought that the router will not price. */
  ROUTED: "a Jupiter USDC route was quoted for it at the reference leg",
  /** Its live transfer fee must have been read on mainnet and be at or under the keeper's ceiling. An unread fee is not a zero fee. */
  FEE: `its transfer fee was read on mainnet and is at most ${CATALOGUE_MAX_FEE_BPS} bps`,
  /** ARM 1's shape: the venue must hold cover for the reference leg. Necessary, never sufficient — the keeper re-counts in the turn. */
  DEPTH: `the venue it routes through held at least ${CATALOGUE_VENUE_INVENTORY_MULTIPLE}x the reference leg in USDC`,
  /** ARM 2's shape: the reference leg must not be quoted worse than the keeper's own impact ceiling. */
  PRICE_AT_SIZE: "the reference leg is not quoted worse than the keeper's impact ceiling against a sixteenth-sized probe",
  /** The build route can only sign a floor from a Raydium CLMM/USDC pool, and only from one deep enough for its mid to be a price. */
  FLOOR: "a Raydium CLMM/USDC pool is pinned for it and holds enough USDC for its mid to be a price",
  /** A standing list needs persistence, not a spot reading. See the constant below. */
  HELD: "it has not been read under any of these bars inside the quarantine window",
});

export type OfferRule = keyof typeof OFFER_RULES;

/** One rule an asset failed, and the reading that failed it. */
export interface RuleFailure {
  readonly rule: OfferRule;
  readonly why: string;
}

/**
 * Every rule `asset` fails, in OFFER_RULES' order, or an empty array when it is
 * offerable. EVERY failure, not the first: an asset kept out by two independent
 * facts is a different case from one kept out by a single reading that could
 * move tomorrow, and a reader deciding what to fix needs to see both.
 */
export function offerProblems(asset: CatalogueAsset): RuleFailure[] {
  const problems: RuleFailure[] = [];
  const fail = (rule: OfferRule, why: string): number => problems.push({ rule, why });
  const dollars = (raw: bigint): string => `$${(Number(raw) / 1e6).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  if (asset.depth === null) fail("ROUTED", "no USDC route has been quoted for it");

  if (asset.fee === null) fail("FEE", "its transfer fee has never been read on mainnet, and an unread fee is not a zero fee");
  else if (asset.fee.bps > CATALOGUE_MAX_FEE_BPS) fail("FEE", `it charged ${asset.fee.bps} bps in epoch ${asset.fee.epoch}, over the ${CATALOGUE_MAX_FEE_BPS} bps ceiling`);

  if (asset.depth !== null && asset.depth.usdcRaw < CATALOGUE_MIN_VENUE_DEPTH_RAW) {
    fail(
      "DEPTH",
      `${asset.depth.venue} held ${dollars(asset.depth.usdcRaw)} (${asset.depth.scope}, read ${asset.depth.readOn}), under the ` +
        `${dollars(CATALOGUE_MIN_VENUE_DEPTH_RAW)} that covers a ${dollars(CATALOGUE_REFERENCE_LEG_RAW)} leg ${CATALOGUE_VENUE_INVENTORY_MULTIPLE}x`,
    );
  }

  if (asset.sizePenalty === null) fail("PRICE_AT_SIZE", "nobody has quoted it at the reference leg against a probe");
  else {
    const ceiling = sizePenaltyCeilingBps(asset.fee?.bps ?? CATALOGUE_MAX_FEE_BPS);
    if (asset.sizePenalty.bps > ceiling) {
      fail(
        "PRICE_AT_SIZE",
        `a ${dollars(asset.sizePenalty.atRaw)} buy was quoted ${asset.sizePenalty.bps} bps worse than a ${dollars(asset.sizePenalty.probeRaw)} probe ` +
          `(${asset.sizePenalty.routes}, read ${asset.sizePenalty.readOn}), over the ${ceiling} bps this keeper allows a turn's own impact`,
      );
    }
  }

  if (asset.floorPool === null) {
    fail("FLOOR", "no Raydium CLMM/USDC pool is pinned for it, and the build route can price a leg's floor from nothing else");
  } else if (asset.floorPoolUsdc === null) {
    fail("FLOOR", `its floor pool ${asset.floorPool} has never had its USDC side read, so nobody knows what moving that mid costs`);
  } else if (asset.floorPoolUsdc.usdcRaw < CATALOGUE_MIN_FLOOR_POOL_RAW) {
    fail(
      "FLOOR",
      `its floor pool held ${dollars(asset.floorPoolUsdc.usdcRaw)} of USDC (read ${asset.floorPoolUsdc.readOn}), under the ` +
        `${dollars(CATALOGUE_MIN_FLOOR_POOL_RAW)} a mid needs before it is a price rather than a number anyone can set`,
    );
  }

  if (asset.quarantinedUntil !== null) {
    fail("HELD", `it was read under one of these bars recently and is held out until ${asset.quarantinedUntil}, when a fresh reading may clear it`);
  }

  return problems;
}

/** Whether the rules admit `asset`, with the narrowing the build route and the reserve readers need. */
export const isOfferable = (asset: CatalogueAsset): asset is OfferedLeg => offerProblems(asset).length === 0;

/**
 * The USDC a chosen route was counted to hold for `asset`, or NULL when nobody
 * counted one — never a venue-wide figure standing in for a count.
 *
 * `depth` is allowed to be either measurement, because the shelf's DEPTH bar is
 * a screen and a venue-wide figure that fails it fails decisively. A ceiling is
 * the other way round: it divides, so the larger number makes the cap larger,
 * and the direction of the error is the direction that signs a dead policy.
 * Null here means the picker must say it does not know the ceiling. It must not
 * reach for `depth` instead.
 */
export const routeCensusReading = (asset: CatalogueAsset): DepthReading | null =>
  asset.routeCensus !== null ? asset.routeCensus : asset.depth !== null && asset.depth.scope === "route-census" ? asset.depth : null;

export const routeCensusRaw = (asset: CatalogueAsset): bigint | null => routeCensusReading(asset)?.usdcRaw ?? null;

// ── THE ASSETS ───────────────────────────────────────────────────────────────
//
// READ ON MAINNET 2026-09-21, EPOCH 1039. The mint facts (owner, decimals,
// extensions, authorities, live fee) come from one getMultipleAccounts over all
// nine mints at slot 448993661. The floor pools' USDC sides come from a second
// one at slot 448994132, over ["pool_vault", pool, USDC] derived under Raydium
// CLMM. The quotes come from lite-api.jup.ag, keyless, at 200 USDC and a
// 12.50 USDC probe, each read three times to make sure the number was the
// market and not a moment.
//
// THE PRESTOCKS MINTS WERE RESOLVED BY SYMBOL AND THEN PROVED BY ISSUER, which
// is the only safe order: a Jupiter token search for any of these symbols also
// answers with half a dozen impostors (ANTHROPIC alone returns ten, several of
// them pump.fun mints with four-figure liquidity). A symbol is not an identity.
// What identifies these eight is that all four authorities of every one of them
// are the single key at PRESTOCKS_POWERS.issuerKey, which is the same key
// addresses.ts already pinned for ANTHROPIC and FIGUREAI before this catalogue
// existed. XAI has no entry because that search answered with no PreStocks mint
// at all on 2026-09-21, and there is nothing to pin.
//
// tokenAccountBytes IS DERIVED FROM THE MINT'S EXTENSION SET, not guessed: 165
// base, 1 account type, then a 4-byte header plus its value per account-side
// extension — ImmutableOwner (0), PausableAccount (0), TransferHookAccount (1),
// and for a fee-charging mint TransferFeeAmount (8). Every PreStocks mint read
// that day carried the same three mint extensions, so every PreStocks entry is
// 191 and SPYx, which has no fee extension, is 179. Only a created account
// proves it; check:legs re-derives it from the mint for the offered legs.

/** What this file knows about, offered or not. OFFERED_LEGS is the part of it the rules admit. */
export const CATALOGUE: readonly CatalogueAsset[] = Object.freeze([
  Object.freeze({
    symbol: "SPYx",
    name: "SP500 xStock",
    group: "xstock",
    mint: SPYX_MINT,
    tokenProgram: TOKEN_2022_PROGRAM,
    decimals: 8,
    tokenAccountBytes: 179,
    floorPool: SPYX_USDC_POOL,
    floorPoolUsdc: Object.freeze({ usdcRaw: 2_646_541_815_865n, scope: "route-census", venue: "Raydium CLMM 6truu3rZ… (the floor source, USDC vault 3EmW8zJD…)", readOn: "2026-09-21", by: "getMultipleAccounts, mainnet slot 448994132" }),
    fee: Object.freeze({ bps: 0, epoch: 1039, readOn: "2026-09-21", by: "mint extensions, mainnet slot 448993661: no TransferFeeConfig at all" }),
    depth: Object.freeze({ usdcRaw: 317_640_466_447n, scope: "route-census", venue: "Raydium CLMM 4pCZCVEi… (a pool a 200 USDC buy routed through on 2026-09-21)", readOn: "2026-09-21", by: "getMultipleAccounts over that pool's USDC vault 92aTAYGn…, mainnet slot 448995444" }),
    // THE CENSUS IS THE SMALLEST INVENTORY ANY POOL THE ROUTER ACTUALLY PICKED
    // WAS COUNTED TO HOLD, AND IT IS NOT THE POOL ABOVE.
    //
    // The ceiling DIVIDES this number, so the only direction it may be wrong in
    // is downwards — and it was pinned at 317,640, a pool that no reading later
    // the same day routed through at all. Read again on 2026-09-21 a 200 USDC
    // buy routed Byreal 27x6aSxc… in one hour and Riptide G9pQE63… in the next,
    // five readings each. Byreal is a Raydium CLMM fork and names its own USDC
    // vault, so it can be counted: $201,151.98. Riptide's pool account names no
    // token account at all, so nothing in it can be counted from chain — the
    // same wall Hadron puts up.
    //
    // So this figure is a BOUND, not the route: the smallest count taken of any
    // pool observed on the route, which is the conservative reading when the
    // router re-picks per quote and one of its picks cannot be counted at all.
    // SPYx is deep enough that no cap this product can sign comes near it; what
    // the change buys is that the ceiling stops dividing a number no buy has
    // been seen to touch.
    routeCensus: Object.freeze({
      usdcRaw: 201_151_975_426n,
      scope: "route-census",
      venue: "Byreal 27x6aSxcAm6SoazoxmmTtFg6fWMQuNmdKJmHagq1DUZy (one of the pools a 200 USDC buy routed through; Riptide G9pQE63etkaFuuX7UNGB8YnvBufNNZMo9GchQNCxrYeD answered the others and cannot be counted)",
      readOn: "2026-09-21",
      by: "getAccountInfo on the pool, then getMultipleAccounts over the USDC account it names, FGdm1Ww1ch138kWjjEigFUFncxzkvfZ6m8Fo1YvM8BMu, mainnet slot 449184534",
    }),
    sizePenalty: Object.freeze({
      bps: 0.2,
      atRaw: 200_000_000n,
      probeRaw: 12_500_000n,
      sameVenues: false,
      routes: "Raydium CLMM at 200 USDC vs Whirlpool at 12.50 (2026-09-21); re-read the same day, Riptide G9pQE63… at BOTH sizes, five readings, 0 bps each",
      readOn: "2026-09-21",
      by: "lite-api.jup.ag, three readings, all 0.2; re-read later the same day, five paired readings, all 0.0 — the figure kept here is the worse of the two sets",
    }),
    quarantinedUntil: null,
    notes: Object.freeze([
      "ITS FLOOR POOL IS NOT ITS MARKET. The pool this entry prices the floor from held $2,646,541.82; the pool a 200 USDC buy actually routed through is a different Raydium CLMM pool holding $317,640.47. The two disagree by 8.3x and both are real — one is where the price is read, the other is where the money goes.",
      "The two prices agree even so: the floor pool's mid put 200 USDC at 25,961,743 raw SPYx and the route filled 25,940,466, 8 bps apart, well inside the 500 bps LEG_FLOOR_MARGIN_BPS the floor is signed at.",
      "Zero transfer fee, permanently: see XSTOCKS_POWERS. Its impact ceiling is therefore the full 50 bps, not the 25 a PreStock is left with.",
    ]),
  }),
  Object.freeze({
    symbol: "ANTHROPIC",
    name: "Anthropic PreStock",
    group: "prestock",
    mint: ANTHROPIC_MINT,
    tokenProgram: TOKEN_2022_PROGRAM,
    decimals: 9,
    tokenAccountBytes: 191,
    floorPool: ANTHROPIC_USDC_POOL,
    floorPoolUsdc: Object.freeze({ usdcRaw: 9_204_135_177n, scope: "route-census", venue: "Raydium CLMM 47MsbowA… (the floor source, USDC vault FZmwQEZq…)", readOn: "2026-09-21", by: "getMultipleAccounts, mainnet slot 448994132" }),
    fee: Object.freeze({ bps: 100, epoch: 1039, readOn: "2026-09-21", by: "mint TransferFeeConfig, mainnet slot 448993661: newer record, live from epoch 1039" }),
    depth: Object.freeze({ usdcRaw: 331_617_000_000n, scope: "venue-wide", venue: "Hadron", readOn: "2026-09-21", by: "carried over from the 2026-09-21 Jupiter migration work. THERE IS NO SOURCE FOR IT IN THIS REPOSITORY: no notes file, no script and no commit records the reading, and it is not re-derivable — the venue names no token account this figure could be counted from. Read it as an undated third-party figure with a date on it" }),
    // 2.2 % OF THE FIGURE ABOVE, AND IT IS THIS ONE THE CAP IS DIVIDED BY. The
    // number is inverted from the day's own ceiling measurement rather than
    // counted directly, and it inverts exactly: a 50 % leg capped the policy at
    // $298.00 and a 20 % leg at $745.00, and ⌊7,450 / 50⌋ = $149 a leg is the
    // only countable inventory that produces both. It is a derived reading and
    // is labelled one; re-deriving it means censusing a live route.
    routeCensus: Object.freeze({
      usdcRaw: 7_450_000_000n,
      scope: "route-census",
      // DERIVED, AND NOW FLAGGED AS SUCH SO THE OWNER'S SCREEN CAN SAY IT. `by`
      // has always said "not a direct count", but nothing rendered `by`, so
      // every sentence in the web called this a count — beside a null branch
      // whose whole meaning is "SaverFi has not counted this". One flag the
      // copy can read keeps that distinction alive at the place it matters.
      derived: true,
      venue: "the route a 200 USDC buy took on 2026-09-21 (BisonFi + Manifest then; re-read the same day it took Kipseli, AlphaQ, Raydium CLMM, BisonFi and Manifest in five different pairings, never the same one twice)",
      readOn: "2026-09-21",
      by: "inverted from that day's ceiling measurement — $298.00 at a half share, $745.00 at a fifth — not a direct count",
    }),
    // THE WORST OF EIGHT PAIRED READINGS, NOT THE BEST, AND THE SPREAD IS THE
    // POINT. The entry recorded 0.1 bps citing "three readings: 0.0, -0.0,
    // 0.1", which reads as a settled quantity. It is not one: check:legs read
    // 107 bps on one run on 2026-09-21 and FAILED this leg, then 14 bps minutes
    // later, then 0 bps on the next run, and five paired probes taken in
    // between returned 0, 1, 1, 0, 0 with a DIFFERENT route on every single
    // reading. The bar this is measured against is 25 bps, so the quantity
    // straddles it. What is recorded here is the worst reading of the ones
    // taken in the session that wrote this comment; what the entry must not do
    // is present any of them as stable.
    sizePenalty: Object.freeze({
      bps: 1,
      atRaw: 200_000_000n,
      probeRaw: 12_500_000n,
      sameVenues: false,
      routes: "a route that changed on every reading — Kipseli + Manifest, AlphaQ + Whirlpool + Manifest, Raydium CLMM + Manifest, BisonFi + Meteora DLMM + Manifest, Manifest + Raydium CLMM + Manifest — against a probe that re-routed too",
      readOn: "2026-09-21",
      by: "lite-api.jup.ag, five paired readings (0, 1, 1, 0, 0 bps), the worst kept; the same quantity read 107 bps and 14 bps through check:legs earlier the same day, so it is a screen and not a settled number",
    }),
    quarantinedUntil: null,
    notes: Object.freeze([
      "ITS TRANSFER FEE IS AT THE CEILING WITH ZERO MARGIN. 100 bps from epoch 1039, against MAX_LEG_FEE_BPS of 100, which the keeper compares with `>`. One more write by the issuer key — which it may make at any epoch boundary, and an epoch is hours — refuses this leg, and a refused leg refuses the WHOLE basket and the SOL conversion with it, on every sweep, until the fee comes back down. The fee was 50 bps until epoch 1039 and this file is not its source: read it from the mint.",
      "THE VENUE-WIDE NUMBER ABOVE IS NOT WHAT THE KEEPER COUNTS, and the gap decides whether a buy clears. The keeper censuses only the accounts the chosen route names; the 2026-09-21 ceiling measurement implies about $7,450 of that, 2.2 % of the venue-wide figure, which at 50x cover allows about $149 a leg. That is UNDER the $200 reference leg this catalogue is measured at: at the shipped $1,000 max_per_call split five ways, the keeper refuses ANTHROPIC today. The owner lowers max_per_call and the picker computes the ceiling (basket-limits.ts depthCeiling); nothing in this entry promises otherwise.",
      "ITS SIZE PENALTY IS NOT A STABLE NUMBER AND THE SHELF RULE IT PASSES IS A COIN FLIP. Readings of the same quantity minutes apart on 2026-09-21 ranged from 0 to 107 bps against a 25 bps bar, because the router picked a different route every time and the two sizes never took the same one (sameVenues false in every reading, so the keeper's own ARM 2 would ABSTAIN here rather than compare). What admits this leg is therefore a screening number with a spread wider than the bar. The gate that decides is the keeper's, in the turn, at the size that turn really spends.",
      "THE VENUE-WIDE FIGURE THAT PASSES THE DEPTH RULE HAS NO SOURCE IN THIS REPO. 331,617 is cited to the Jupiter migration, and nothing in the tree records the reading — see the note on `by` below. It is load-bearing in the ADMITTING direction: this asset clears DEPTH only because 331,617 >= 10,000. The number the owner's cap is divided by is the route census instead, which is a tenth the size and is derived rather than counted.",
      "It is offered because the track requires a PreStock and this is the deepest venue any of them has — not because it is safe. Everything at PRESTOCKS_POWERS is true of it.",
    ]),
  }),
  Object.freeze({
    symbol: "FIGUREAI",
    name: "Figure AI PreStock",
    group: "prestock",
    mint: FIGUREAI_MINT,
    tokenProgram: TOKEN_2022_PROGRAM,
    decimals: 9,
    tokenAccountBytes: 191,
    floorPool: FIGUREAI_USDC_POOL,
    floorPoolUsdc: Object.freeze({ usdcRaw: 2_786_965_702n, scope: "route-census", venue: "Raydium CLMM HvpDt29E… (the floor source, USDC vault ALfDjAtK…)", readOn: "2026-09-21", by: "getMultipleAccounts, mainnet slot 448994132" }),
    fee: Object.freeze({ bps: 100, epoch: 1039, readOn: "2026-09-21", by: "mint TransferFeeConfig, mainnet slot 448993661" }),
    depth: Object.freeze({ usdcRaw: 50_000_000_000n, scope: "venue-wide", venue: "Hadron (though a 200 USDC quote that day routed Manifest E7Mcgg…)", readOn: "2026-09-21", by: "carried over from the 2026-09-21 Jupiter migration work; no notes file, script or commit in this repository records the reading, and it is not re-derivable from here" }),
    routeCensus: null,
    sizePenalty: Object.freeze({ bps: 0, atRaw: 200_000_000n, probeRaw: 12_500_000n, sameVenues: true, routes: "Manifest E7Mcgg… at both sizes", readOn: "2026-09-21", by: "lite-api.jup.ag, three readings, all 0.0" }),
    quarantinedUntil: "2026-10-20",
    notes: Object.freeze([
      "THE SENTENCE THAT USED TO KEEP IT OUT IS NO LONGER TRUE, AND IS CORRECTED HERE RATHER THAN LEFT STANDING. This file said its pinned pool was empty — 0.110274669 FIGUREAI and 31.91 USDC, about $51, on 2026-09-20, with a buy over about $11 reverting. Read again on 2026-09-21 the same pool holds $2,786.97 on the USDC side, and Jupiter quotes 200 USDC into Manifest at no measurable penalty against a probe. On today's readings alone it would pass every other rule in this file.",
      "IT IS STILL OUT, AND THE RULE IS THE POINT. A venue that went from roughly $6,700 to $51 and back to $2,787 inside four days has not got a depth; it has weather. The keeper can afford to judge that in the turn, because it re-measures every sweep; a catalogue cannot, because it is a standing offer a stranger reads on a Tuesday and signs on a Friday. So HELD holds it out until 2026-10-20, a month past the reading that failed, and clearing that date means taking a fresh reading — not deleting the line.",
    ]),
  }),
  Object.freeze({
    symbol: "OPENAI",
    name: "OpenAI PreStock",
    group: "prestock",
    mint: OPENAI_MINT,
    tokenProgram: TOKEN_2022_PROGRAM,
    decimals: 9,
    tokenAccountBytes: 191,
    floorPool: null,
    floorPoolUsdc: null,
    fee: Object.freeze({ bps: 100, epoch: 1039, readOn: "2026-09-21", by: "mint TransferFeeConfig, mainnet slot 448993661" }),
    depth: Object.freeze({ usdcRaw: 25_220_000_000n, scope: "venue-wide", venue: "Manifest 6Gi6cz…", readOn: "2026-09-21", by: "carried over from the 2026-09-21 Jupiter migration work; no notes file, script or commit in this repository records the reading, and it is not re-derivable from here" }),
    routeCensus: null,
    sizePenalty: Object.freeze({ bps: 29.8, atRaw: 200_000_000n, probeRaw: 12_500_000n, sameVenues: true, routes: "Manifest 6Gi6cz… at both sizes", readOn: "2026-09-21", by: "lite-api.jup.ag, three readings, all 29.8" }),
    quarantinedUntil: null,
    notes: Object.freeze([
      "The deepest PreStock after ANTHROPIC by venue-wide depth, and still refused: at the reference leg its own price impact is 29.8 bps against the 25 the keeper leaves a 100 bps mint, measured on the SAME venue at both sizes — which is the keeper's own ARM 2 scope, so this is not a coarse reading. A cheaper fee or a smaller leg would both move it; neither is this file's to decide.",
    ]),
  }),
  Object.freeze({
    symbol: "NEURALINK",
    name: "Neuralink PreStock",
    group: "prestock",
    mint: NEURALINK_MINT,
    tokenProgram: TOKEN_2022_PROGRAM,
    decimals: 9,
    tokenAccountBytes: 191,
    floorPool: null,
    floorPoolUsdc: null,
    fee: Object.freeze({ bps: 100, epoch: 1039, readOn: "2026-09-21", by: "mint TransferFeeConfig, mainnet slot 448993661" }),
    depth: Object.freeze({ usdcRaw: 8_995_000_000n, scope: "venue-wide", venue: "Manifest G3LHQo…", readOn: "2026-09-21", by: "carried over from the 2026-09-21 Jupiter migration work; no notes file, script or commit in this repository records the reading, and it is not re-derivable from here" }),
    routeCensus: null,
    sizePenalty: Object.freeze({ bps: 77.9, atRaw: 200_000_000n, probeRaw: 12_500_000n, sameVenues: true, routes: "Manifest G3LHQo… at both sizes", readOn: "2026-09-21", by: "lite-api.jup.ag, three readings, all 77.9" }),
    quarantinedUntil: null,
    notes: Object.freeze(["Refused twice over, which is the useful kind of refusal: not enough at the venue, and what is there is not at this price."]),
  }),
  Object.freeze({
    symbol: "SPACEX",
    name: "SpaceX PreStock",
    group: "prestock",
    mint: SPACEX_MINT,
    tokenProgram: TOKEN_2022_PROGRAM,
    decimals: 9,
    tokenAccountBytes: 191,
    floorPool: null,
    floorPoolUsdc: null,
    fee: Object.freeze({ bps: 100, epoch: 1039, readOn: "2026-09-21", by: "mint TransferFeeConfig, mainnet slot 448993661" }),
    depth: Object.freeze({ usdcRaw: 7_542_000_000n, scope: "venue-wide", venue: "Meteora DLMM Chroid…", readOn: "2026-09-21", by: "carried over from the 2026-09-21 Jupiter migration work; no notes file, script or commit in this repository records the reading, and it is not re-derivable from here" }),
    routeCensus: null,
    sizePenalty: Object.freeze({ bps: 27, atRaw: 200_000_000n, probeRaw: 12_500_000n, sameVenues: true, routes: "Meteora DLMM Chroid… at both sizes", readOn: "2026-09-21", by: "lite-api.jup.ag, three readings, all 27.0" }),
    quarantinedUntil: null,
    notes: Object.freeze(["A DLMM keeps its liquidity in bins, so a count of units can read deep while the price two bins out is not there. Both of this entry's refusals say the same thing from the two sides the keeper measures it from."]),
  }),
  Object.freeze({
    symbol: "POLYMARKET",
    name: "Polymarket PreStock",
    group: "prestock",
    mint: POLYMARKET_MINT,
    tokenProgram: TOKEN_2022_PROGRAM,
    decimals: 9,
    tokenAccountBytes: 191,
    floorPool: null,
    floorPoolUsdc: null,
    fee: Object.freeze({ bps: 100, epoch: 1039, readOn: "2026-09-21", by: "mint TransferFeeConfig, mainnet slot 448993661" }),
    depth: Object.freeze({ usdcRaw: 7_264_000_000n, scope: "venue-wide", venue: "Manifest J4PjSn…", readOn: "2026-09-21", by: "carried over from the 2026-09-21 Jupiter migration work; no notes file, script or commit in this repository records the reading, and it is not re-derivable from here" }),
    routeCensus: null,
    sizePenalty: Object.freeze({ bps: 10.8, atRaw: 200_000_000n, probeRaw: 12_500_000n, sameVenues: true, routes: "Manifest J4PjSn… at both sizes", readOn: "2026-09-21", by: "lite-api.jup.ag, three readings, all 10.8" }),
    quarantinedUntil: null,
    notes: Object.freeze([
      "THE ONE WORTH RE-READING WHEN THE FLOOR STOPS COMING FROM A RAYDIUM POOL. Its price holds at the reference leg — 10.8 bps against a 25 bps ceiling, same venue at both sizes — and the two rules it fails are both about infrastructure rather than about the asset: its venue is $2,736 short of covering a $200 leg fifty times over, and SaverFi has no way to sign a floor for anything that does not trade on a Raydium CLMM/USDC pool.",
    ]),
  }),
  Object.freeze({
    symbol: "KALSHI",
    name: "Kalshi PreStock",
    group: "prestock",
    mint: KALSHI_MINT,
    tokenProgram: TOKEN_2022_PROGRAM,
    decimals: 9,
    tokenAccountBytes: 191,
    floorPool: null,
    floorPoolUsdc: null,
    fee: Object.freeze({ bps: 100, epoch: 1039, readOn: "2026-09-21", by: "mint TransferFeeConfig, mainnet slot 448993661" }),
    depth: Object.freeze({ usdcRaw: 4_229_000_000n, scope: "venue-wide", venue: "Meteora DLMM (reached through a first hop that changed between readings)", readOn: "2026-09-21", by: "carried over from the 2026-09-21 Jupiter migration work; no notes file, script or commit in this repository records the reading, and it is not re-derivable from here" }),
    routeCensus: null,
    sizePenalty: Object.freeze({ bps: 96.7, atRaw: 200_000_000n, probeRaw: 12_500_000n, sameVenues: false, routes: "GoonFi V2 + Meteora DLMM at 200 USDC vs Raydium CLMM + Scorch + Meteora DLMM at 12.50", readOn: "2026-09-21", by: "lite-api.jup.ag, three readings: 96.6, 96.7, 96.7" }),
    quarantinedUntil: null,
    notes: Object.freeze(["Its two quotes never took the same route twice, so the keeper's ARM 2 would abstain here rather than measure — and 96.7 bps is far enough over any ceiling that the coarser reading settles it anyway."]),
  }),
  Object.freeze({
    symbol: "ANDURIL",
    name: "Anduril PreStock",
    group: "prestock",
    mint: ANDURIL_MINT,
    tokenProgram: TOKEN_2022_PROGRAM,
    decimals: 9,
    tokenAccountBytes: 191,
    floorPool: null,
    floorPoolUsdc: null,
    fee: Object.freeze({ bps: 100, epoch: 1039, readOn: "2026-09-21", by: "mint TransferFeeConfig, mainnet slot 448993661" }),
    depth: Object.freeze({ usdcRaw: 2_016_000_000n, scope: "venue-wide", venue: "Manifest BeUdSs… (a Meteora DLMM answered the probe instead)", readOn: "2026-09-21", by: "carried over from the 2026-09-21 Jupiter migration work; no notes file, script or commit in this repository records the reading, and it is not re-derivable from here" }),
    routeCensus: null,
    sizePenalty: Object.freeze({ bps: 33.3, atRaw: 200_000_000n, probeRaw: 12_500_000n, sameVenues: false, routes: "Manifest BeUdSs… at 200 USDC vs Meteora DLMM Gug9Tr… at 12.50", readOn: "2026-09-21", by: "lite-api.jup.ag, three readings, all 33.3" }),
    quarantinedUntil: null,
    notes: Object.freeze(["The thinnest venue measured: $2,016 covers a $200 leg ten times, not fifty. At the ceiling arithmetic in basket-limits.ts this is the asset that drags a five-leg basket's cap to about $200 all by itself."]),
  }),
]);

/**
 * The assets a policy can be signed for: the part of CATALOGUE that
 * offerProblems() finds nothing wrong with. Today that is SPYx and ANTHROPIC,
 * and it is a RESULT rather than a list — the seven assets beside them each
 * fail a named rule with a dated reading behind it, and putting one back means
 * changing its readings, not this line.
 */
export const OFFERED_LEGS: readonly OfferedLeg[] = Object.freeze(CATALOGUE.filter(isOfferable));

/** Each of `count` legs' weight, summing to exactly 10,000 bps: equal shares, any remainder on the first leg. */
export function basketWeightsBps(count: number): number[] {
  if (!Number.isInteger(count) || count < 1) throw new RangeError("a basket has at least one leg");
  const share = Math.floor(10_000 / count);
  return Array.from({ length: count }, (_, index) => (index === 0 ? share + (10_000 - share * count) : share));
}

export interface ComputeBudget {
  /** SetComputeUnitLimit. */
  readonly unitLimit: number;
  /** SetComputeUnitPrice, in micro-lamports per unit. */
  readonly microLamports: bigint;
}

/**
 * The unit limit every owner transaction carries, per SIP instruction. Every
 * owner transaction carries both compute-budget instructions, because Phantom
 * rewrites an unsigned transaction's fees only when it has none. The local proof
 * requires each landing to consume at most half of its limit.
 */
export const OWNER_TX_COMPUTE: Readonly<Record<OwnerInstructionName, number>> = Object.freeze({
  create_vault_v2: 60_000,
  set_policy_v2: 40_000,
  link_wallet: 100_000,
  unlink_wallet: 40_000,
  withdraw: 40_000,
  withdraw_token: 200_000,
  set_invest_policy: 300_000,
});

/**
 * How many of a vault's missing token accounts the build route bundles ahead of
 * set_invest_policy, at the owner's expense: the first two of
 * vaultTokenAccountTargets' order, wSOL and USDC. The keeper creates every other
 * one idempotently at the crank's expense on the first invest tick
 * (solana-keeper/src/invest-tick.ts calls createAssociatedTokenAccountIdempotent
 * for wSOL, USDC and each leg), so an unbundled leg costs the owner nothing and
 * delays nothing.
 *
 * WHY TWO, MEASURED WITH THIS REPO'S OWN BUILDERS AND THE REAL LIGHTHOUSE
 * REWRITE (test/lighthouse.test.ts's sizes case re-measures it in CI; legacy
 * wire, signed, with Phantom's leading and trailing blocks as
 * test/phantom-rewrite.ts takes them from mainnet). AT TODAY'S TWO LEGS:
 *   * two creations: 1,008 bytes of MAX_TX_BYTES = 1,232, 224 to spare (1,010 as
 *     v0, and 1,029/1,031 with Phantom's trailing block saturated at
 *     MAX_TRAILING_WALLET_GUARDS — a worst case of 201 bytes spare).
 *   * three creations: 1,162 bytes, 70 to spare, AND Phantom's blocks are already
 *     full at 4 leading and 6 trailing, so there is no room left for a single
 *     further assertion. Seventy bytes that cannot absorb one more check is not a
 *     margin. (At three legs the same two numbers were 1,058 and 1,212, the
 *     second leaving twenty: this got better with the leg, not safe.)
 *
 * AND RAISING MAX_VAULT_TOKEN_ACCOUNT_CREATES IS NOT THE FIX. Bundling all four
 * of today's targets is refused by the builder itself — MAX_VAULT_TOKEN_ACCOUNT_CREATES
 * is 3 — and it would be refused by the relay anyway, because every extra
 * creation also buys one more leading and one more trailing wallet guard: five
 * leading and seven trailing, past MAX_LEADING_WALLET_GUARDS (4) and
 * MAX_TRAILING_WALLET_GUARDS (6). The wire gets worse with the cap, not better.
 * The verifier's cap stays 3: it bounds what the relay accepts, and the one-leg
 * golden still creates three.
 */
export const BUNDLED_VAULT_TOKEN_ACCOUNT_CREATES = 2;

/** The priority price of every owner transaction. The verifier's cap is 5,000,000. */
export const OWNER_TX_MICROLAMPORTS = 100_000n;

/** Solana's base fee per required signature. */
export const SIGNATURE_FEE_LAMPORTS = 5_000n;

/** The compute budget an owner transaction for `name` is built with. */
export const ownerComputeBudget = (name: OwnerInstructionName): ComputeBudget => ({ unitLimit: OWNER_TX_COMPUTE[name], microLamports: OWNER_TX_MICROLAMPORTS });

/** What the priority price costs on top of the signature fees: ceil(limit × price / 1e6), as the runtime charges it. */
export function priorityFeeLamports(budget: ComputeBudget): bigint {
  const microLamports = BigInt(budget.unitLimit) * budget.microLamports;
  return (microLamports + 999_999n) / 1_000_000n;
}
