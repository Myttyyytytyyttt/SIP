// The three numbers the keeper decides with and the website promises in writing.
//
// A SHARED VECTOR, NOT A SHARED MODULE. vault-copy.test.ts used to readFileSync
// three of the keeper's source files and regex these numbers out of them: a web
// gate that went red whenever the keeper reflowed a line, in a package the web
// may not edit, with only the keeper's owner able to fix it. The obvious remedy
// — move the constants into @sip/solana-core and import them from the keeper —
// is the one remedy this repository forbids, in its own words. Of the mirrored
// Pyth decoder, packages/solana-keeper/src/pyth.ts says: "The keeper does not
// depend on @sip/solana-core and must not start to: its package.json is what
// ships to Railway, and the repo already draws this boundary — invest-tick.ts
// re-declares the wSOL/USDC pool rather than import the web's copy of it." A
// rule affirmed there and broken here would be worse than either choice alone.
//
// So this is the pattern that decoder ALREADY uses: ONE COMMITTED VECTOR,
// ASSERTED FROM BOTH SIDES. test/fixtures/pyth-accounts.ts holds two mainnet
// accounts that solana-core's pyth-price.test.ts and the keeper's own
// pyth.test.ts each decode independently, and the copies are held together by
// agreeing about the vector rather than by importing each other. Nothing here
// ships: a test fixture a sibling reads costs the deployed keeper nothing.
//
// EACH NUMBER CARRIES WHAT IT MEANS, WHICH IS THE WHOLE POINT. A vector that
// said only "100" would pass two codebases that agree on the digits and
// disagree on the unit — basis points read as percent, a multiple read as a
// share. So every entry carries FOUR things: the value in the keeper's own
// unit, the same quantity in the unit the website prints, a worked example, and
// the two cases either side of the comparison the keeper actually makes. The
// derived magnitude and the boundary are the assertion; the digits are not.
//
// WHICH SIDE GOES RED FOR WHAT:
//   * the keeper's tests hold its exported constants AND its gates to `keeper`
//     and `boundary`, so MOVING A KEEPER CONSTANT fails in the keeper;
//   * vault-copy.test.ts holds the web's constants AND the sentences the owner
//     signs to `web` and the derived magnitudes, so MOVING THE SIGNED TEXT
//     fails in the website.
// One vector, two assertions, each failing in the package that caused it.
//
// THE FIRST BULLET WAS A CLAIM BEFORE IT WAS A TEST. Until 2026-09-24 no keeper
// test imported POOL_DEPTH, LEG_FEE or LOSS_FORGIVEN: the keeper pinned 50n,
// 100n and 100 as bare literals, and what actually tied its multiple to this
// vector was a regex over invest-decision.ts in solana-core's
// handlers-live.test.ts. The keeper's half of POOL_DEPTH and LEG_FEE, and of
// ALL_OR_NOTHING and TRANSFER_HOOK below, now lives in
// packages/solana-keeper/test/invest-decision.test.ts. LOSS_FORGIVEN's is
// "THE KEEPER'S HALF OF LOSS_FORGIVEN" in settle-decision.test.ts, which holds
// ZERO_BASE_MIN_TXS to `keeper` and runs `boundary` through the settle gate.
// Nothing tied that 100 here before it: a keeper moved to 90 together with
// every literal of its own that counts to it was green in every package while
// the website still printed 100.
//
// NOTHING IS IMPORTED HERE, deliberately: the keeper resolves this file through
// a runtime-built specifier so its NodeNext tsc never follows it, and the web
// imports it directly under Bundler resolution. A dependency-free module is
// legible to both.

/**
 * HOW LONG A LOSS FOLLOWS A TRADER.
 *
 * A losing stretch moves nothing and its loss comes off the next gain. The loss
 * is dropped — and later gains count in full — only once the trading wallet has
 * signed this many transactions OF ITS OWN while still behind, summed across
 * the windows the loss was carried through. The keeper's own settles are not
 * counted, which is what stops a stranger's transfers deciding when a trader is
 * forgiven.
 */
export const LOSS_FORGIVEN = Object.freeze({
  /** packages/solana-keeper/src/settle-decision.ts */
  keeper: Object.freeze({ constant: "ZERO_BASE_MIN_TXS", module: "settle-decision.ts", value: 100 }),
  /** packages/website-oficial/src/lib/vault-copy.ts, printed by VAULT_COPY.profitRule. */
  web: Object.freeze({ constant: "LOSS_DROPPED_AFTER_TXS", value: 100 }),
  /**
   * The gate is `signed >= ZERO_BASE_MIN_TXS`, so the count below still carries
   * the loss and the count above forgets it. A flip to `>` moves both.
   */
  boundary: Object.freeze({ stillCarriedAtTxs: 99, forgottenAtTxs: 100 }),
});

/**
 * HOW SMALL ONE BUY MUST BE BESIDE THE VENUE IT GOES INTO.
 *
 * The venue must cover the buy this many times over, measured BEFORE the
 * owner's SOL is sold toward it. One thin leg refuses the whole basket and the
 * SOL conversion with it.
 *
 * WHAT IS COUNTED CHANGED ON 2026-09-21 AND THE NUMBER DID NOT. The keeper used
 * to require a POOL'S IN-SIDE RESERVE to cover the spend 50 times; it now
 * counts the VENUE'S INVENTORY of the asset each hop pays it, because the
 * assets this product must hold trade on a CLOB (Manifest) and a DLMM
 * (Meteora), neither of which has an in-side reserve to read. The two are the
 * same ratio at the quoted rate —
 *     inventory / (spend / price) == (inventory * price) / spend
 * — so 50 carries over unchanged, and the drained-venue replay gives 20.1x
 * where the old gate gave 19.1x. The web's picker divides each leg's
 * venueInventoryRaw (route census) by the same 50 (basket-limits.ts
 * depthCeiling), not a pinned pool's in-side reserve, so the arithmetic below
 * holds for it unchanged. The field names still say "reserve", after what the
 * keeper counted before 2026-09-21.
 */
export const POOL_DEPTH = Object.freeze({
  /** packages/solana-keeper/src/invest-decision.ts */
  keeper: Object.freeze({ constant: "MIN_VENUE_INVENTORY_MULTIPLE", module: "invest-decision.ts", value: 50n }),
  /** packages/website-oficial/src/lib/vault-copy.ts, printed by INVEST_COPY.thinPool. */
  web: Object.freeze({ constant: "POOL_DEPTH_MULTIPLE", value: 50 }),
  /**
   * THE SAME QUANTITY IN THE OTHER UNIT, which is the half a bare "50" cannot
   * carry: at 50x cover, one buy is at most a fiftieth — 2 % — of what the pool
   * holds on the side being spent. A copy that printed "50 %" would agree with
   * the keeper about the digits and lie to the owner about the rule.
   */
  largestShareOfReservePercent: 2,
  /** Worked once by hand, in raw units whatever the mint's decimals: required = spend * multiple. */
  worked: Object.freeze({ spend: 1_000_000n, requiredReserve: 50_000_000n }),
  /**
   * The gate is `inventory < take * MIN_VENUE_INVENTORY_MULTIPLE`, so EXACTLY
   * 50x cover is deep and one raw unit less is refused. A flip to `<=` moves
   * both. (The keeper's own tests run that boundary through the real gate; this
   * is the vector the two sides' copy is held to.)
   */
  boundary: Object.freeze({ forSpend: 1_000_000n, deepAtReserve: 50_000_000n, refusedAtReserve: 49_999_999n }),
});

/**
 * THE MOST AN ISSUER MAY CHARGE TO MOVE A STOCK BEFORE THE KEEPER REFUSES IT.
 *
 * Charged on the way in and again on the way out, so the ceiling is paid twice.
 * One refused leg refuses the whole basket and the SOL conversion with it.
 *
 * 300 SINCE 2026-09-24, AND IT WAS 100. The PreStocks issuer key had written
 * 300 bps for epoch 1043 into seven of the eight PreStocks mints (read on
 * mainnet that day, epoch 1041), and at 100 the keeper would have refused every
 * basket holding one from that epoch on. The owner raised the ceiling to 300
 * knowing the cost below; invest-decision.ts MAX_LEG_FEE_BPS records the
 * decision where it is enforced.
 */
export const LEG_FEE = Object.freeze({
  /** packages/solana-keeper/src/invest-decision.ts */
  keeper: Object.freeze({ constant: "MAX_LEG_FEE_BPS", module: "invest-decision.ts", value: 300n }),
  /** packages/website-oficial/src/lib/vault-copy.ts, printed by INVEST_COPY.feeCeiling. */
  web: Object.freeze({ constant: "MAX_LEG_FEE_BPS", value: 300 }),
  /** THE UNIT THE WEBSITE PRINTS: 300 bps is 3 % of every transfer. Off by a factor of ten in either direction, this disagrees. */
  percentPerTransfer: 3,
  /**
   * COMPOUNDED, NOT TRIPLED-AND-DOUBLED. In and out at the ceiling is
   * 1 - 0.97^2 = 5.91 %, not 6 %, because the second 3 % is taken from what
   * the first one left. Both sides derive this rather than copy it;
   * INVEST_COPY.issuerCost prints it.
   */
  roundTripPercent: 5.91,
  /**
   * packages/solana-keeper/src/min-out.ts SLIPPAGE_BPS, the tolerance one fill
   * is allowed against the market, and solana-core's CATALOGUE_SLIPPAGE_BPS.
   * UNCHANGED BY THE RAISE, and that is the point of keeping it here: at 100
   * the issuer's round trip (1.99 %) was the whole of it; at 300 the round trip
   * (5.91 %) is almost three times it. The owner accepted that on 2026-09-24;
   * this number records what he accepted it against.
   */
  slippageBps: 200n,
  /**
   * packages/solana-keeper/src/invest-decision.ts MIN_SLIPPAGE_MARGIN_BPS: how
   * far STRICTLY above a leg's transfer fee its slippage is asked, because at
   * equality Jupiter reverts with 0x1771 (measured across epoch 1038 -> 1039).
   * legSlippageBps(fee) = max(slippageBps, fee + this) — 400 at the ceiling.
   * solana-core's catalogue mirrors the same arithmetic, so it is here.
   */
  slippageMarginBps: 100n,
  /**
   * THE IMPACT BAR, FEE BY FEE, worked once by hand:
   *   maxTurnImpactBps(legSlippageBps(fee), fee) = max(5, (slippage - fee) / 4)
   * — the keeper's ARM 2 ceiling, which solana-core's sizePenaltyCeilingBps
   * must return for the same fee or the catalogue offers a leg the keeper
   * refuses (or refuses one it buys). At 300 the old catalogue formula,
   * (200 - fee) / 4, gave 0 while the keeper allows 25: ANTHROPIC would have
   * left the shelf on PRICE_AT_SIZE while the keeper went on buying it.
   * [fee, ceiling] pairs, in bps: 0 -> 50, 50 -> 37, 100 -> 25, 250 -> 25,
   * 300 -> 25, and one past the ceiling, 301 -> 25 (the ask widens with it).
   */
  impactCeilingBps: Object.freeze([
    Object.freeze([0n, 50n] as const),
    Object.freeze([50n, 37n] as const),
    Object.freeze([100n, 25n] as const),
    Object.freeze([250n, 25n] as const),
    Object.freeze([300n, 25n] as const),
    Object.freeze([301n, 25n] as const),
  ]),
  /**
   * The gate is `fee.bps > MAX_LEG_FEE_BPS` — STRICTLY greater — so a leg
   * sitting exactly on the limit is admitted with no margin at all. That is
   * ANTHROPIC's position from epoch 1043, and a flip to `>=` would refuse the
   * basket the website promises. Both cases are asserted so the flip cannot pass.
   */
  boundary: Object.freeze({ admittedAtBps: 300n, refusedAtBps: 301n }),
});

/**
 * WHEN THE KEEPER BUYS A LEG UNDER THE OWNER'S FLOOR, AND WHAT min_out IT HANDS invest().
 *
 * packages/solana-program/scripts/jupiter-route.ts investMinOutFor, deployed
 * with origin/main df6ca67 on 2026-09-25. Three numbers per route, in the
 * destination mint's raw units:
 *   venueThreshold      = quotedOut - floor(quotedOut * slippageBps / 1e4)
 *                         (Jupiter's otherAmountThreshold; slippageBps is
 *                         legSlippageBps(fee) = max(200, fee + 100))
 *   netOfVenueThreshold = venueThreshold less the destination's transfer fee
 *   ownerFloor          = amount_in * min_out_rate_wad / 1e18
 * and the rule:
 *   netOfVenueThreshold >= ownerFloor                    -> min_out = netOfVenueThreshold
 *   netOfVenueThreshold <  ownerFloor <= venueThreshold  -> min_out = ownerFloor (it BUYS)
 *   venueThreshold      <  ownerFloor                    -> refused [below-owner-floor]
 * So the keeper buys a leg exactly when venueThreshold >= ownerFloor. The fee
 * is NOT taken off before that comparison — that was the rule until df6ca67,
 * and on it the owner's ANTHROPIC floor was refused every sweep.
 *
 * The cases below were run through the keeper's own investMinOutFor on
 * 2026-09-25 (tsx, from packages/solana-keeper, against this branch merged with
 * df6ca67) and returned exactly these answers. `measured` is the owner's
 * ANTHROPIC leg as the keeper's header records it: 2,752,188 USDC raw in,
 * quotedOut 2,612,063 at slippage 400, a Manifest last hop that quotes gross.
 *
 * WHICH SIDE ASSERTS IT: solana-core's product.test.ts holds its mirror
 * (keeperInvestMinOutFor) to every case, and the website's floor check is
 * built on that mirror. THE KEEPER'S OWN TESTS DO NOT READ THIS ENTRY YET: a
 * change to investMinOutFor goes red here only once someone adds that half.
 */
export const OWNER_FLOOR_MIN_OUT = Object.freeze({
  keeper: Object.freeze({ function: "investMinOutFor", module: "jupiter-route.ts", deployedAt: "df6ca67" }),
  measured: Object.freeze({ amountIn: 2_752_188n, quotedOut: 2_612_063n, slippageBps: 400n, venueThreshold: 2_507_581n, netOfVenueThreshold: 2_432_353n }),
  /** [ownerFloor, min_out the keeper hands invest() or null for a refusal], at the measured venueThreshold and netOfVenueThreshold. */
  cases: Object.freeze([
    Object.freeze([null, 2_432_353n] as const),
    Object.freeze([2_432_353n, 2_432_353n] as const),
    Object.freeze([2_432_354n, 2_432_354n] as const),
    Object.freeze([2_483_089n, 2_483_089n] as const),
    Object.freeze([2_507_581n, 2_507_581n] as const),
    Object.freeze([2_507_582n, null] as const),
  ]),
  /** The owner's signed floor for that leg (902223869744110771 wad) and the verdict: the keeper buys, at min_out = his floor. */
  ownersLeg: Object.freeze({ ownerFloor: 2_483_089n, minOut: 2_483_089n, buys: true }),
});

/**
 * THE DOCTRINE BOTH GATES OBEY, named here so the two sides are visibly talking
 * about one rule: a single refused leg refuses the WHOLE basket, the healthy
 * legs included, and stops the SOL conversion at any balance. There is no
 * per-leg outcome anywhere in it.
 *
 * THIS FIXTURE CANNOT PROVE IT, and says so rather than implying otherwise.
 * Each side proves its own half, and each half asserts this entry, so flipping
 * a field here fails both:
 *   * the keeper, in test/invest-decision.test.ts: DepthDecision and
 *     LegAdmission held to their exact shapes as TYPES (tsc — its typecheck and
 *     its image's build gate), and each gate run over a two-leg basket with one
 *     bad leg, where it must return exactly one refusal of three fields with the
 *     sound leg refused too. stopsSolConversion is the refusal's own words there
 *     ("refusing to convert SOL toward it"); invest-tick.ts calls both gates
 *     before its first wrap.
 *   * the website, in vault-copy.test.ts: the sentences that must not offer the
 *     reader a half-basket that cannot happen.
 * The types are named rather than their text copied. Until 2026-09-24 the
 * website regexed both unions out of invest-decision.ts (docs/TESTING_TRAPS.md,
 * third species); the pin now sits in the package that owns them.
 */
export const ALL_OR_NOTHING = Object.freeze({
  perLegOutcomes: false,
  refusesHealthyLegsToo: true,
  stopsSolConversion: true,
  keeperTypes: Object.freeze(["DepthDecision", "LegAdmission"]),
});

/**
 * THE SECOND STOP: A FIELD THE ISSUER CAN FILL IN.
 *
 * Token-2022's TransferHook extension names a program that every transfer of
 * the mint must call. sip-vault's invest cannot append that program's accounts
 * without an upgrade, so the keeper refuses a leg whose hook names one, and by
 * ALL_OR_NOTHING the whole basket goes with it.
 *
 * "EMPTY" IS THE HALF THAT NEEDS ITS MEANING WRITTEN DOWN. Every PreStocks mint
 * CARRIES the extension, with a program id of 32 zero bytes: the issuer keeping
 * the option, not using it. A keeper that read "extension present" as "hooked"
 * would refuse the live basket; one that read a filled-in id as empty would buy
 * into code it has never seen. So the empty value is typed out here, as the
 * base58 of 32 zero bytes, rather than left to each side's library to supply.
 *
 * WHICH SIDE GOES RED: the keeper's invest-decision.test.ts decodes a mint whose
 * hook is `emptyProgramId` and one whose hook is anything else, through
 * decodeMintFacts and legAdmissionDecision; vault-copy.test.ts holds
 * INVEST_COPY.hookSwitch ("empty when SaverFi read it", "will not buy a stock
 * whose field has been filled in") to this entry. Until 2026-09-24 the website
 * held that sentence to two expressions regexed out of invest-decision.ts.
 */
export const TRANSFER_HOOK = Object.freeze({
  /** packages/solana-keeper/src/invest-decision.ts */
  keeper: Object.freeze({ decoder: "decodeMintFacts", gate: "legAdmissionDecision", module: "invest-decision.ts" }),
  /** 32 zero bytes: what an unfilled field holds on chain, and what the keeper decodes as no hook at all. */
  emptyProgramId: "11111111111111111111111111111111",
  emptyIsAdmitted: true,
  filledIsRefused: true,
});

/**
 * THE VENUE PROGRAM A POLICY MUST NAME, AND THE ONE IT MUST NOT.
 *
 * This is the entry whose absence cost the most. The keeper moved the basket to
 * Jupiter — ROUTABLE_VENUES holds Jupiter v6 alone and venueDecision REFUSES
 * anything else before the wrap, all-or-nothing and for the life of the policy
 * — while the website's closed venue set still held raydium-clmm alone, so
 * every policy the picker could build named a program the keeper had already
 * retired. Both sides were internally consistent, both sides had tests, both
 * sides were green, and 100 % of the baskets the owner could sign bought
 * nothing at any balance while the rent that signed them stayed spent.
 *
 * TWO PACKAGES AGREEING ABOUT ONE 32-BYTE VALUE IS EXACTLY WHAT THIS FILE IS
 * FOR, and the pair below is the assertion: the routed id, and the retired one
 * that must never be offerable again. Each side asserts against this vector —
 * the keeper over ROUTABLE_VENUES and RETIRED_VENUES, solana-core over
 * addresses.ts and build-handler.ts's VENUE_PROGRAMS, the website over
 * VERIFIABLE_VENUES and DEFAULT_VENUE_NAME — so a venue that moves in one
 * package goes red in that package.
 */
export const ROUTED_VENUE = Object.freeze({
  /** packages/solana-keeper/src/invest-decision.ts, the only key in ROUTABLE_VENUES. */
  keeper: Object.freeze({ constant: "JUPITER_V6_PROGRAM", module: "invest-decision.ts", programId: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4" }),
  /** packages/solana-core/src/client/addresses.ts, translated from the NAME below by build-handler.ts's VENUE_PROGRAMS. */
  web: Object.freeze({ constant: "JUPITER_V6", programId: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", venueName: "jupiter-v6" }),
  /**
   * RETIRED, AND THE POINT IS THAT IT IS STILL REAL. Raydium CLMM is what every
   * policy signed before 2026-09-22 names — the live mainnet one was re-signed
   * onto Jupiter v6 that day (CHANGELOG.md) — and it is still the PRICE SOURCE
   * the floors are read from (readers.ts PRICED_POOLS).
   * What it may never be again is a venue a new policy can be signed with.
   */
  retired: Object.freeze({ constant: "RAYDIUM_CLMM", programId: "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK", venueName: "raydium-clmm", stillAPriceSource: true }),
  /** One venue, on purpose: a second entry is a second route builder, not a second name. */
  routableCount: 1,
});
