/**
 * EVERY SENTENCE THE VAULT SCREENS SAY, in one place.
 *
 * The rule texts are the owner's, word for word: what a mode takes, what the
 * keeper can and cannot move, and which rent never comes back. Components and
 * flows import from here, so a claim is changed once and a test can pin it.
 * Client-safe and pure; amounts and rates arrive already written as text.
 *
 * AND SINCE THE BASKET BECAME HIS, THE PARAGRAPHS HE SIGNS ARE GENERATED. The
 * fee, the issuers' powers, the switch that stops the buying and the box he
 * ticks are built from the legs he chose and their own dated readings — see
 * "THE PARAGRAPHS THE OWNER SIGNS" below. A sentence that names a stock by hand
 * is a sentence about somebody else's basket, and this file is where that costs
 * the most.
 */

import { DEFAULT_VAULT_POLICY, LEG_FLOOR_MARGIN_BPS, PRESTOCKS_POWERS, XSTOCKS_POWERS, legFloorMarginBps, type AssetGroup, type CatalogueAsset } from "@sip/solana-core/client";

/**
 * How far over today's price a floor `marginBps` under it lets a stock be
 * bought, to one decimal: 500 is "5.3 %" (1 / 0.95 - 1), 700 is "7.5 %".
 */
export const overTodayPercent = (marginBps: number): string => `${((marginBps * 100) / (10_000 - marginBps)).toFixed(1)} %`;

/** Basis points as a percentage: 2000 is "20 %". */
export const ratePercent = (bps: number): string => `${Number((bps / 100).toFixed(2))} %`;

/** "20 %", from the product's default profit rate. */
export const PROFIT_RATE = ratePercent(DEFAULT_VAULT_POLICY.skimBps);
/** "2 %", from the product's default volume rate. */
export const VOLUME_RATE = ratePercent(DEFAULT_VAULT_POLICY.volumeBps);

/**
 * How many transactions of its own a trading wallet signs, while a PROFIT span is
 * still behind, before the keeper settles zero and drops that loss: the keeper's
 * ZERO_BASE_MIN_TXS (packages/solana-keeper/src/settle-decision.ts). TradingLink
 * keeps no high-water mark, so a dropped loss is not netted against later gains.
 * vault-copy.test.ts holds this to LOSS_FORGIVEN in solana-core's committed
 * vector (test/fixtures/keeper-policy.ts), which the KEEPER's own tests hold
 * its constant and its gate to: the file is not read as text any more, so a
 * reflow over there cannot turn a web gate red.
 */
export const LOSS_DROPPED_AFTER_TXS = 100;

/**
 * HOW SMALL ONE BUY MUST BE BESIDE THE VENUE IT BUYS FROM: the keeper's
 * MIN_VENUE_INVENTORY_MULTIPLE (packages/solana-keeper/src/invest-decision.ts).
 * The venue has to cover the buy this many times over or the turn is refused,
 * so one buy may be at most a FIFTIETH of what that venue can hand over.
 *
 * WHAT IS COUNTED CHANGED ON 2026-09-21 AND THE NUMBER DID NOT, which is
 * exactly the shape that lets a sentence go quietly false. The keeper used to
 * read a Raydium POOL'S IN-SIDE RESERVE; it now counts the VENUE'S INVENTORY of
 * the stock, because the assets this product must hold trade on a central limit
 * order book and a dynamic bin market, neither of which has a reserve to read —
 * and on some of them there is no "pool" at all. The two are the same ratio at
 * the quoted rate, so the 50 carries over untouched and no test would have
 * caught the words. INVEST_COPY.thinPool below was rewritten in the same change.
 *
 * vault-copy.test.ts holds this to POOL_DEPTH in the committed vector, the
 * same way it does LOSS_DROPPED_AFTER_TXS — and to the vector's OTHER UNIT
 * too, because two packages can agree on "50" and disagree about whether it
 * is a multiple or a share.
 */
export const POOL_DEPTH_MULTIPLE = 50;

/**
 * THE MOST A STOCK MAY CHARGE TO TRANSFER AND STILL BE BOUGHT: the keeper's
 * MAX_LEG_FEE_BPS (packages/solana-keeper/src/invest-decision.ts), which gates
 * on `fee.bps > MAX_LEG_FEE_BPS` — strictly greater, so a leg sitting exactly
 * on the limit is still admitted, with no margin whatsoever.
 *
 * 300 SINCE 2026-09-24, WHEN IT WAS 100. That day the PreStocks issuer had
 * already written 300 bps for epoch 1043 on seven of its eight mints, over the
 * 100 they charge now; the owner raised the keeper's limit to 300 rather than
 * have every basket holding one refused from that epoch. So from epoch 1043
 * those seven sit EXACTLY on the limit: a single issuer instruction away from
 * being refused entirely — and the refusal is all-or-nothing, taking the other
 * legs and the SOL conversion with it. INVEST_COPY.feeCeiling is the sentence
 * that says so, and it names the legs ON the limit (now, or from the epoch a
 * written rise lands in) and the legs that go down with them from the basket
 * itself, rather than from a pair of names written here. vault-copy.test.ts
 * holds this constant to LEG_FEE in the committed vector.
 */
export const MAX_LEG_FEE_BPS = 300;

/** "SPYx and ANTHROPIC", "SPYx, ANTHROPIC and GLDx", "SPYx" — a list in a sentence. */
export const listAnd = (items: readonly string[]): string =>
  items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;

/** The first and last four characters of an address. */
export const shortAddress = (address: string): string => (address.length > 10 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address);

// ── THE PARAGRAPHS THE OWNER SIGNS, GENERATED FROM HIS OWN BASKET ────────────
//
// WHY NONE OF THEM MAY BE WRITTEN BY HAND ANY MORE. Until the picker landed the
// basket was two frozen legs, so `hookSwitch`, `feeCeiling` and `issuerCost`
// could name SPYx and ANTHROPIC in prose and be true — and vault-copy.test.ts
// carried a tripwire that went red the moment OFFERED_LEGS stopped being
// exactly those two, because the sentences could not follow. The owner now
// picks up to five assets out of a catalogue of nine. A hand-written paragraph
// would describe a basket he did not choose: it would name a stock he never
// ticked, quote a fee no leg of his charges, and — worst — tell him that a stop
// takes "the whole basket, SPYx along with it" when his basket has no SPYx in
// it, which understates by however many legs he did pick.
//
// So every sentence below is built from the legs on screen and THEIR OWN
// MEASURED FACTS, and each fact carries the day it was read. A leg whose fee
// nobody has read says so; it is never given a zero.
//
// WHAT THESE SENTENCES MAY NOT DO, which is docs/TESTING_TRAPS.md's fourth
// species and the reason this file is the dangerous one: claim more than what
// was measured. Three claims in particular are easy to inherit and false:
//  * the depth gate measures DEPTH AT THE SIZE OF THE TURN, not price. It can
//    say a market is too thin to fill a buy; it cannot say a price is fair.
//  * the stock legs have NO INDEPENDENT PRICE ANCHOR. Pyth anchors the SOL hop
//    only (invest-decision.ts oracleConvertDecision); ARM 1 counts units and
//    has no opinion about what a unit is worth, and ARM 2 divides two quotes
//    from one quoter, so a uniformly bad price divides out of it.
//  * the owner-signed floor DECAYS. It is derived once, at signing, from one
//    Raydium CLMM pool's mid, net of the leg's transfer fee, at
//    legFloorMarginBps(fee) under it — LEG_FLOOR_MARGIN_BPS, widened at a fee
//    over 1 % (solana-core/src/server/build-handler.ts),
//    and then it stands. As the
//    market moves it becomes either a no-op or a block, and nothing re-signs it.
// INVEST_COPY.defencesLimits says all three in the owner's words, and the
// floor-drift block measures the third against the rate the page just read.

/** A chosen leg, as the signed paragraphs need it: what it is called, which product it is, and its own fee reading. */
export interface SignedLeg {
  readonly symbol: string;
  readonly group: AssetGroup;
  /** Its transfer fee IN FORCE when read, in basis points, or null when nobody has read it. NULL IS NOT ZERO and no sentence below treats it as zero. */
  readonly feeBps: number | null;
  /** The epoch that reading was taken in. */
  readonly feeEpoch: number | null;
  readonly feeReadOn: string | null;
  /**
   * A rate the issuer has ALREADY WRITTEN for a later epoch, and that epoch —
   * or null when the reading found nothing pending (or nobody read the fee).
   *
   * THE TWO ARE NEVER MERGED INTO ONE NUMBER HERE, because the owner is owed
   * both: what he pays today and what he will pay from a date already on
   * chain. Read on 2026-09-24, ANTHROPIC charged 1 % and had 3 % written for
   * epoch 1043; a sentence saying "charges 3 %" would have been false for two
   * more days, and one saying "charges 1 %" and stopping would have hidden a
   * tripling nobody needs to sign for.
   */
  readonly scheduledFeeBps: number | null;
  readonly scheduledFeeEpoch: number | null;
  /**
   * WHETHER THE MINT HAS NO FEE SETTING AT ALL, which is a much stronger fact
   * than a fee of zero and is the only ground for "nobody can ever add one".
   *
   * Token-2022 extensions are fixed when a mint is initialised, so a mint
   * without TransferFeeConfig has no authority anywhere able to give it one
   * (XSTOCKS_POWERS). A fee that merely READS zero could be an extension set to
   * zero today and to anything tomorrow, and the two must not be printed the
   * same way. signedLegsOf derives this from the catalogue's own convention —
   * an xStock entry's zero fee is a reading of the extension's ABSENCE, which
   * product.ts states in SPYx's `fee.by` and its notes — and vault-copy.test.ts
   * holds that convention to the shelf, so an xStock whose zero is merely a
   * zero turns the test red rather than picking up this sentence.
   */
  readonly feeSettingAbsent: boolean;
}

/** The catalogue's entries as the signed paragraphs take them: the same readings, narrowed to what the words use. */
export const signedLegsOf = (assets: readonly CatalogueAsset[]): readonly SignedLeg[] =>
  assets.map((asset) => ({
    symbol: asset.symbol,
    group: asset.group,
    feeBps: asset.fee?.bps ?? null,
    feeEpoch: asset.fee?.epoch ?? null,
    feeReadOn: asset.fee?.readOn ?? null,
    scheduledFeeBps: asset.fee?.scheduled?.bps ?? null,
    scheduledFeeEpoch: asset.fee?.scheduled?.epoch ?? null,
    feeSettingAbsent: asset.group === "xstock" && asset.fee?.bps === 0,
  }));

/**
 * The fee a leg WILL pay as far as its reading can see: in force now, or
 * already written for later, whichever is higher. The limit is judged on this,
 * as the keeper and the catalogue judge it. Null when the fee was never read.
 */
export const judgedFeeOf = (leg: SignedLeg): number | null =>
  leg.feeBps === null ? null : Math.max(leg.feeBps, leg.scheduledFeeBps ?? 0);

/**
 * WHEN AN EPOCH A WRITTEN FEE NAMES IS EXPECTED TO BEGIN — AN ESTIMATE, AND
 * SAID AS ONE. Epoch 1041 began 2026-09-23 13:06Z and ran at 265.7 ms a slot
 * (measured 2026-09-24, 397,270 slots in); at 432,000 slots an epoch that puts
 * 1043 at about 05:00Z on Saturday 26 September 2026, give or take hours,
 * because slot times drift. An epoch not listed here is named by its number
 * alone rather than given a date nobody worked out.
 */
const EPOCH_EXPECTED: Readonly<Record<number, string>> = Object.freeze({ 1043: "around 26 September 2026" });

/** "epoch 1043, around 26 September 2026" — or "epoch 1050" when nobody estimated its date. */
const epochWords = (epoch: number): string => (EPOCH_EXPECTED[epoch] === undefined ? `epoch ${epoch}` : `epoch ${epoch}, ${EPOCH_EXPECTED[epoch]}`);

/**
 * "3 % from around 26 September 2026" for a leg with a fee already written for
 * later, or null when nothing different is pending. The short form the
 * start-buying card lists beside what the leg charges today.
 */
export const writtenFeeWords = (leg: SignedLeg): string | null =>
  leg.scheduledFeeBps === null || leg.scheduledFeeEpoch === null || leg.scheduledFeeBps === leg.feeBps
    ? null
    : `${ratePercent(leg.scheduledFeeBps)} from ${EPOCH_EXPECTED[leg.scheduledFeeEpoch] ?? `epoch ${leg.scheduledFeeEpoch}`}`;

/**
 * WHAT A FEE COSTS OVER A ROUND TRIP, and it is not twice the fee.
 *
 * The issuer charges on the way in and again on the way out, and the second
 * charge is taken from what the first one left: 1 − (1 − f)², which at 1 % is
 * 1.99 % and not 2 %, and at the 3 % limit 5.91 % and not 6 %. Written as
 * arithmetic rather than as a figure so that a leg charging anything else is
 * described correctly without anyone re-typing it.
 */
export const roundTripPercent = (feeBps: number): string => `${Number((100 * (1 - (1 - feeBps / 10_000) ** 2)).toFixed(2))} %`;

/**
 * THE TRANSFER-HOOK FIELD, AS IT WAS READ, AND ONLY WHERE IT WAS READ.
 *
 * Both groups carry Token-2022's transfer-hook extension with the program id
 * left at the default key, which invest-decision.ts's decodeMintFacts reads as
 * `transferHook: null` — the issuer keeping the option rather than using it. A
 * filled-in field is refused outright (`facts.transferHook !== null`), and by
 * the keeper's all-or-nothing doctrine that refusal takes the whole basket and
 * the SOL conversion with it.
 *
 * THE PRESTOCKS READING COVERS ALL EIGHT MINTS; THE XSTOCKS ONE COVERS SPYx AND
 * NOTHING ELSE, which is why it is keyed by symbol. Generalising SPYx's read to
 * every xStock is exactly the fourth species: a sentence true of what was
 * measured, printed as true of a mint nobody has looked at. An xStock that is
 * not in this record is described as unread.
 *
 * WHO CAN FILL IT IN IS NOT THE SAME ON BOTH SIDES, and neither side may be
 * overstated. On a PreStock it is the single issuer key that also sets the fee,
 * freezes, pauses and holds the permanent delegate (PRESTOCKS_POWERS). On SPYx
 * the 2026-09-20 mainnet read found the authority set to a key of the issuer's
 * own (5aMNNLQJ…), which is NOT the key that can freeze it and cannot put a fee
 * on it at all. So the STOP is symmetric and the FEE is not — and nothing read
 * on either day measures which key is likelier to be used, so nothing here says.
 */
const XSTOCK_HOOK_READS: Readonly<Record<string, string>> = Object.freeze({ SPYx: "2026-09-20" });
const PRESTOCK_HOOK_KEY = "the same key that sets its fee and can freeze, pause and move it";
const XSTOCK_HOOK_KEY = "a key of its issuer's own, which is not the key that can freeze it";

/**
 * WHAT A ROUND TRIP IN ONE STOCK ACTUALLY COST, where anybody has measured one.
 *
 * SIMULATED ON MAINNET, 2026-09-20, epoch 1039, n=7: unsigned transactions
 * through simulateTransaction, USDC → stock → USDC, with the sell chained on the
 * REAL credit the buy returned and not on the quote. Two earlier readings are
 * dead and are quoted nowhere: a 0.60/0.57/1.26 % size curve whose own middle
 * point fell as the buy grew, and a 0.41–0.44 % figure that priced the sell off
 * a quote instead of off the credit.
 *
 * A LEG THAT IS NOT IN HERE HAS NOT BEEN MEASURED, and the paragraph says so
 * rather than reaching for a neighbour's number. The catalogue has nine assets
 * and this has two: that ratio is the point.
 */
//
// THE FEE IT WAS MEASURED AT IS PART OF THE MEASUREMENT (`feeBps`). ANTHROPIC's
// 2.4 % was taken at a 1 % fee; the sentence that splits it into the issuer's
// share and the market's must use THAT fee, not whatever the leg charges on
// the day the page is read — at the 3 % written for epoch 1043 the "issuer's
// part" would come out larger than the whole.
const ROUND_TRIPS: Readonly<
  Record<string, { readonly feeBps: number; readonly all: string | null; readonly low: string; readonly high: string; readonly market: string | null; readonly moved: string | null }>
> = Object.freeze({
  ANTHROPIC: Object.freeze({ feeBps: 100, all: "2.4 %", low: "2.24 %", high: "2.63 %", market: "between 0.25 % and 0.64 %", moved: "0.36 %" }),
  SPYx: Object.freeze({ feeBps: 0, all: null, low: "0.011 %", high: "0.018 %", market: null, moved: null }),
});
const ROUND_TRIP_READ_ON = "20 September 2026";
const ROUND_TRIP_METHOD = "seven round trips, built and run but never signed, each sale priced on what its purchase actually delivered rather than on a quote";

/**
 * A FEE THAT HAS ALREADY BEEN MOVED, by leg, because it is the proof that a key
 * is in use rather than merely held.
 *
 * ANTHROPIC's TransferFeeConfig carried older{epoch 1032, 50 bps} and
 * newer{epoch 1039, 100 bps} when it was read at slot 448864409, inside epoch
 * 1039 — about 1.8 hours in. The same calendar day, read in epoch 1038, the
 * rise was still scheduled. Read again on 2026-09-24 (slot 450109271, epoch
 * 1041) it carried older{epoch 1039, 100 bps} and newer{epoch 1043, 300 bps}.
 * TWO RAISES ARE CLAIMED, each seen on the account: 0.5 % -> 1 % at epoch 1039,
 * and 1 % -> 3 % written for epoch 1043. An earlier 0 -> 50 may well have
 * happened and is on no record read here, so it is not claimed.
 */
const FEE_RAISED: Readonly<Record<string, string>> = Object.freeze({
  ANTHROPIC:
    "ANTHROPIC's was 0.5 % until it became 1 % on 20 September 2026, and on 24 September its issuer was found to have already written 3 % for epoch 1043",
});

const symbolsOf = (legs: readonly SignedLeg[]): string => listAnd(legs.map((leg) => leg.symbol));
const inGroup = (legs: readonly SignedLeg[], group: AssetGroup): readonly SignedLeg[] => legs.filter((leg) => leg.group === group);
const isOne = (legs: readonly SignedLeg[]): boolean => legs.length === 1;

/**
 * "the whole basket — SPYx and ANTHROPIC, every one of them —", or at one leg
 * "the whole basket — which is ANTHROPIC alone —".
 *
 * THE ALL-OR-NOTHING DOCTRINE IS WHY THIS PHRASE EXISTS AT ALL. Every keeper
 * refusal — the depth gate, the fee ceiling, the transfer hook — refuses the
 * WHOLE basket and the SOL conversion with it; a half-basket is unrepresentable
 * in DepthDecision and LegAdmission alike. The sentences that carry that have
 * to name the legs that go down, and until the picker existed they named two by
 * hand.
 */
const wholeBasket = (legs: readonly SignedLeg[]): string =>
  isOne(legs) ? `the whole basket — which is ${symbolsOf(legs)} alone —` : `the whole basket — ${symbolsOf(legs)}, every one of them —`;

/** "Both of these are", "All three of these are": a count the reader can hold, never "All 2 of these". */
const COUNT_WORDS = Object.freeze(["", "one", "two", "three", "four", "five", "six", "seven", "eight"]);
const countWord = (count: number): string => COUNT_WORDS[count] ?? String(count);

/**
 * WHETHER THIS LEG'S ISSUER HAS A FEE SETTING IT COULD MOVE, and the third
 * answer is "nobody knows", which is not the same as either.
 *
 * A PreStock is known to have one: the 2026-09-21 read found the same key
 * holding transfer-fee-config on all eight of those mints (PRESTOCKS_POWERS).
 * A leg whose own fee has been read has one by definition. What is left — a
 * mint nobody read, in no group with a group-wide reading — is unknown, and a
 * sentence saying its issuer "can raise it" would be inventing an extension.
 */
const feeCanMove = (leg: SignedLeg): boolean => !leg.feeSettingAbsent && (leg.group === "prestock" || leg.feeBps !== null);

/** One leg's transfer fee in the owner's words, with the day it was read. An unread fee is said to be unread; an absent setting is said to be absent. */
function feeSentence(leg: SignedLeg): string {
  if (leg.feeBps === null) return `SaverFi has not read ${leg.symbol}'s transfer fee on chain, and an unread fee is not a zero fee.`;
  // WHAT IS ALREADY WRITTEN FOR LATER, said after what is charged now and
  // never instead of it: the owner pays the first today and the second from a
  // date that needs nobody's signature.
  const written =
    leg.scheduledFeeBps === null || leg.scheduledFeeEpoch === null || leg.scheduledFeeBps === leg.feeBps
      ? ""
      : ` Its issuer has already written ${leg.scheduledFeeBps === 0 ? "a fee of nothing" : ratePercent(leg.scheduledFeeBps)} for ${epochWords(leg.scheduledFeeEpoch)}` +
        (leg.scheduledFeeBps > 0 ? `; from then the same round trip gives up ${roundTripPercent(leg.scheduledFeeBps)}.` : ".");
  if (leg.feeBps === 0)
    return leg.feeSettingAbsent
      ? `${leg.symbol} charges nothing to transfer, and nobody can make it: its mint carries no fee setting at all, and no key with the power to add one.`
      : `${leg.symbol} charged nothing to transfer when it was read on ${leg.feeReadOn}, and its issuer can raise that at the next epoch boundary.${written}`;
  return (
    `${leg.symbol}'s issuer charges ${ratePercent(leg.feeBps)} of every transfer of it: once when your vault buys it, and once when it leaves. ` +
    `Going in and back out therefore gives up ${roundTripPercent(leg.feeBps)} before the market is involved at all — not quite twice the fee, because the second charge is taken from what the first one left. ` +
    `That was its fee on ${leg.feeReadOn}, in epoch ${leg.feeEpoch}.${written}`
  );
}

/** What the issuers charge, leg by leg, and why buying smaller does not escape it. */
function issuerCostParagraph(legs: readonly SignedLeg[]): string {
  if (legs.length === 0) return "Choose what your vault buys and SaverFi will tell you what each issuer charges to transfer it.";
  const parts = legs.map(feeSentence);
  if (legs.some((leg) => (leg.feeBps ?? 0) > 0)) {
    parts.push(
      "Buying in smaller pieces does not make that smaller: it is a fee on each transfer, not a price that moves with the size of the order, and every later buy pays it again.",
    );
  }
  const movable = legs.filter(feeCanMove);
  if (movable.length === 0) {
    parts.push(
      `That is a fact about how ${isOne(legs) ? "that mint was" : "those mints were"} made, not a promise about anybody's behaviour: the setting is not there to be used.`,
    );
  } else {
    const raised = legs.map((leg) => FEE_RAISED[leg.symbol]).filter((line): line is string => line !== undefined);
    parts.push(
      `A fee belongs to the issuer — not to SaverFi and not to Solana — and ${symbolsOf(movable)} ${isOne(movable) ? "has" : "have"} a setting the issuer can move at any epoch boundary` +
        `${raised.length === 0 ? "." : `: ${listAnd(raised)}.`}`,
    );
  }
  return parts.join(" ");
}

/** The ceiling the keeper refuses above, against the fees this basket actually carries. */
function feeCeilingParagraph(legs: readonly SignedLeg[], max: string): string {
  const opening = `There is a limit built into SaverFi: the keeper will not buy a stock that charges more than ${max} to transfer.`;
  if (legs.length === 0) return `${opening} A basket with nothing in it has nothing to measure against that.`;
  // ON THE LIMIT NOW, OR ON IT FROM THE EPOCH A RISE ALREADY WRITTEN LANDS IN.
  // Both are the same position — admitted, with no margin — and neither may be
  // described as the other: on 2026-09-24 ANTHROPIC was the second kind, 1 %
  // charged and 3 % written for epoch 1043.
  const atCeiling = legs.filter((leg) => leg.feeBps === MAX_LEG_FEE_BPS);
  const reachesCeiling = legs.filter((leg) => leg.feeBps !== MAX_LEG_FEE_BPS && leg.scheduledFeeBps === MAX_LEG_FEE_BPS);
  const unread = legs.filter((leg) => leg.feeBps === null);
  const movable = legs.filter(feeCanMove);
  const stop = `the vault stops buying ${wholeBasket(legs)} and stops converting your SOL at all, until the basket itself is changed. Nothing is lost when that happens; the saving simply stops until someone acts.`;
  // AND PAST IT, which the shelf no longer offers but a policy signed earlier
  // can still hold: a leg whose fee — in force or written for later — is over
  // the limit is refused from that epoch, and the owner is told the date.
  const overCeiling = legs.filter((leg) => (judgedFeeOf(leg) ?? 0) > MAX_LEG_FEE_BPS);
  const parts = [opening];
  if (overCeiling.length > 0) {
    for (const leg of overCeiling) {
      parts.push(
        leg.feeBps !== null && leg.feeBps > MAX_LEG_FEE_BPS
          ? `${leg.symbol} charged ${ratePercent(leg.feeBps)} when it was read on ${leg.feeReadOn}, over that limit, so ${stop}`
          : `${leg.symbol}'s issuer has already written ${ratePercent(leg.scheduledFeeBps ?? 0)} for ${epochWords(leg.scheduledFeeEpoch ?? 0)}, over that limit: from then ${stop}`,
      );
    }
  } else if (atCeiling.length > 0 || reachesCeiling.length > 0) {
    if (atCeiling.length > 0) {
      parts.push(`${symbolsOf(atCeiling)} ${isOne(atCeiling) ? "sits" : "sit"} exactly on that limit today, with no margin whatsoever.`);
    }
    for (const epoch of [...new Set(reachesCeiling.map((leg) => leg.scheduledFeeEpoch!))]) {
      const landing = reachesCeiling.filter((leg) => leg.scheduledFeeEpoch === epoch);
      parts.push(
        `${symbolsOf(landing)} ${isOne(landing) ? "charges" : "charge"} ${listAnd([...new Set(landing.map((leg) => ratePercent(leg.feeBps ?? 0)))])} today, and ${isOne(landing) ? "its issuer has" : "their issuers have"} already written ${max} for ${epochWords(epoch)}: ` +
          `from then ${isOne(landing) ? "it sits" : "they sit"} exactly on that limit, with no margin whatsoever.`,
      );
    }
    const onIt = [...atCeiling, ...reachesCeiling];
    parts.push(`If ${isOne(onIt) ? "that issuer raises its fee" : "any of those issuers raises its fee"} once more after that, ${stop}`);
  } else if (movable.length > 0) {
    const priced = legs.filter((leg) => leg.feeBps !== null);
    if (priced.length > 0) {
      parts.push(`Nothing you have chosen sits on that limit today: ${listAnd(priced.map((leg) => `${leg.symbol} charges ${leg.feeBps === 0 ? "nothing" : ratePercent(leg.feeBps!)}`))}.`);
    }
    parts.push(`If ${symbolsOf(movable)} ${isOne(movable) ? "raises its fee" : "raise theirs"} past ${max}, ${stop}`);
  } else if (legs.every((leg) => leg.feeSettingAbsent)) {
    parts.push(`Nothing you have chosen can ever reach it: ${symbolsOf(legs)} ${isOne(legs) ? "carries" : "carry"} no fee setting at all, and no key anywhere can add one.`);
  }
  if (unread.length > 0) {
    parts.push(
      `SaverFi has not read ${symbolsOf(unread)}'s transfer fee, so it cannot tell you where ${isOne(unread) ? "it sits" : "they sit"} against that limit — and an unread fee is not a zero fee.`,
    );
  }
  return parts.join(" ");
}

/** What a round trip cost where anyone measured one, and plain silence where nobody did. */
function marketCostParagraph(legs: readonly SignedLeg[]): string {
  const parts = ["Then there is what the market charges on top, which depends on the day's liquidity."];
  const measured = legs.filter((leg) => ROUND_TRIPS[leg.symbol] !== undefined);
  const unmeasured = legs.filter((leg) => ROUND_TRIPS[leg.symbol] === undefined);
  if (measured.length > 0) {
    parts.push(`Buying a stock and selling it straight back was measured on ${ROUND_TRIP_READ_ON} on Solana itself — ${ROUND_TRIP_METHOD}.`);
    for (const leg of measured) {
      const trip = ROUND_TRIPS[leg.symbol]!;
      if (trip.all === null) {
        parts.push(`${leg.symbol}'s round trip cost between ${trip.low} and ${trip.high}.`);
      } else {
        parts.push(
          `${leg.symbol}'s round trip cost ${trip.all} all told, between ${trip.low} and ${trip.high}.` +
            (trip.market === null
              ? ""
              : ` The ${roundTripPercent(trip.feeBps)} its issuer charged that day is the part of that which never moves; the rest, ${trip.market}, is the market` +
                (trip.moved === null ? "." : `, and it moved by ${trip.moved} within thirteen minutes that day.`)),
        );
      }
    }
  }
  if (unmeasured.length > 0) {
    parts.push(
      `Nobody has measured a round trip in ${symbolsOf(unmeasured)}, so what ${isOne(unmeasured) ? "it costs" : "they cost"} beyond the transfer ${isOne(unmeasured) ? "fee" : "fees"} above is not a number SaverFi has.`,
    );
  }
  parts.push(
    isOne(legs)
      ? "Another day reads differently."
      : "Another day reads differently, and where two of these cost differently it is their issuers and their markets that differ — not Solana, and not SaverFi.",
  );
  return parts.join(" ");
}

/** Which powers the actual issuers of the actual chosen legs hold, by group, each with the day it was read. */
function issuerPowersParagraph(legs: readonly SignedLeg[]): string {
  const prestocks = inGroup(legs, "prestock");
  const xstocks = inGroup(legs, "xstock");
  const noFeeSetting = xstocks.filter((leg) => leg.feeSettingAbsent);
  const otherXstocks = xstocks.filter((leg) => !leg.feeSettingAbsent);
  const parts: string[] = [];
  if (prestocks.length > 0) {
    parts.push(
      `${symbolsOf(prestocks)} ${isOne(prestocks) ? "is a PreStock" : "are PreStocks"}, and one key — ${shortAddress(PRESTOCKS_POWERS.issuerKey)} — is the mint authority, the freeze authority, ` +
        `the transfer-fee authority and the permanent delegate of ${isOne(prestocks) ? "it" : "every one of them"}. ${isOne(prestocks) ? "It can also be paused" : "Each of them can also be paused"}, ` +
        `and the same key can point every transfer at a program of its choosing. That is one person's discretion over what your vault holds, read on ${PRESTOCKS_POWERS.readOn}.`,
    );
  }
  if (noFeeSetting.length > 0) {
    parts.push(
      `${symbolsOf(noFeeSetting)} ${isOne(noFeeSetting) ? "is an xStock: its mint carries" : "are xStocks: their mints carry"} no transfer-fee setting at all, and no key anywhere can add one — ` +
        `${XSTOCKS_POWERS.why}. That is about the fee and nothing else: the issuer still holds ${listAnd(["a freeze authority", "a permanent delegate", "a pause", "a default account state"])}, ` +
        `under keys separate from each other, read on ${XSTOCKS_POWERS.readOn}.`,
    );
  }
  if (otherXstocks.length > 0) {
    parts.push(
      `${symbolsOf(otherXstocks)} ${isOne(otherXstocks) ? "is an xStock" : "are xStocks"} whose fee setting SaverFi has not read as absent, so nothing here says it cannot gain one; ` +
        "its issuer holds freeze, a pause and a permanent delegate as the others do.",
    );
  }
  if (parts.length === 0) return "Choose what your vault buys and SaverFi will tell you what each issuer can do to it.";
  parts.push("None of that is SaverFi's to grant or to take away, and none of it is Solana's.");
  return parts.join(" ");
}

/** The switch that stops the buying: the transfer-hook field, on the legs chosen, under the keys that were read holding it. */
function hookSwitchParagraph(legs: readonly SignedLeg[]): string {
  if (legs.length === 0) return "Choose what your vault buys and SaverFi will tell you who can stop it buying.";
  const prestocks = inGroup(legs, "prestock");
  const xstocksRead = inGroup(legs, "xstock").filter((leg) => XSTOCK_HOOK_READS[leg.symbol] !== undefined);
  const unread = legs.filter((leg) => leg.group !== "prestock" && XSTOCK_HOOK_READS[leg.symbol] === undefined);
  const read = [...prestocks, ...xstocksRead];
  const readLines = [
    prestocks.length === 0 ? null : `${symbolsOf(prestocks)} on ${PRESTOCKS_POWERS.readOn}`,
    ...xstocksRead.map((leg) => `${leg.symbol} on ${XSTOCK_HOOK_READS[leg.symbol]!}`),
  ].filter((line): line is string => line !== null);

  const parts = [
    `There is a second switch, and it is not about money at all: it stops the buying. ${isOne(legs) ? "This stock carries" : "Every stock in this basket carries"} a Token-2022 field where its issuer may name a program that has to run on every transfer of it.`,
  ];
  if (read.length > 0) {
    parts.push(
      isOne(read)
        ? `On ${symbolsOf(read)} that field was empty when SaverFi read it, on ${readLines[0]!.split(" on ")[1]!}, which is the issuer keeping the option rather than using it.`
        : `On ${symbolsOf(read)} that field was empty when SaverFi read it (${listAnd(readLines)}), which is the issuer keeping the option rather than using it.`,
    );
  }
  if (unread.length > 0) {
    parts.push(`SaverFi has not read that field on ${symbolsOf(unread)}, and an unread field is not an empty one.`);
  }
  parts.push(
    "SaverFi will not buy a stock whose field has been filled in, because it cannot carry what a program named there would demand.",
    `So on the day ${isOne(legs) ? "that issuer writes one in" : "any of these issuers writes one in"}, the vault stops buying ${wholeBasket(legs)} and stops converting your SOL, until the basket itself is changed. It applies from the moment it is written: the next buy is the one that stops.`,
    "That stop takes nothing from you: what you have already saved is neither lost nor moved by it. The freeze, the pause and the permanent delegate described above are separate powers, and those can reach what your vault already holds.",
  );
  if (prestocks.length > 0 && xstocksRead.length > 0) {
    parts.push(
      `Neither side is exempt: on ${symbolsOf(prestocks)} the key over that field is ${PRESTOCK_HOOK_KEY}, and on ${symbolsOf(xstocksRead)} it is ${XSTOCK_HOOK_KEY}, ` +
        "so either issuer can fill its own field in and stop the whole basket the same way. Nothing here measures which of them is likelier to.",
    );
  } else if (prestocks.length > 0) {
    parts.push(`The key over that field is ${PRESTOCK_HOOK_KEY}, so the stop and the fee are in one hand. Nothing here measures how likely that hand is to use either.`);
  } else if (xstocksRead.length > 0) {
    parts.push(`The key over that field is ${XSTOCK_HOOK_KEY}, so the stop is a separate power from the freeze. Nothing here measures how likely that key is to be used.`);
  }
  const noFeeSetting = legs.filter((leg) => leg.feeSettingAbsent);
  const movable = legs.filter(feeCanMove);
  if (noFeeSetting.length > 0 && movable.length > 0) {
    parts.push(
      `The asymmetry that can be proved is the fee, not the stop: ${symbolsOf(noFeeSetting)} ${isOne(noFeeSetting) ? "carries" : "carry"} no fee setting at all and no key able to add one, ` +
        `while ${symbolsOf(movable)} ${isOne(movable) ? "has one its issuer can raise" : "have one their issuers can raise"}.`,
    );
  }
  parts.push(
    movable.length > 0
      ? "So what you are accepting is not only a fee that may rise: it is that a stranger's key can stop your pension buying anything at all, on any day he chooses."
      : "So what you are accepting is that a stranger's key can stop your pension buying anything at all, on any day he chooses — whatever the fees are.",
  );
  return parts.join(" ");
}

/** Token-2022 powers over the chosen legs, said once for the whole basket. */
function freezeNoticeParagraph(legs: readonly SignedLeg[]): string {
  const head =
    legs.length === 0
      ? "The stocks a vault buys are Token-2022 tokens"
      : isOne(legs)
        ? `${symbolsOf(legs)} is a Token-2022 token`
        : legs.length === 2
          ? "Both of these are Token-2022 tokens"
          : `All ${countWord(legs.length)} of these are Token-2022 tokens`;
  return (
    `${head}, and each issuer keeps powers over its own that SaverFi cannot take away. An issuer can freeze your vault's account for that stock, pause every transfer of it, ` +
    "and move it out of your vault through a permanent delegate. If any of that happens, withdrawing that stock can fail or find less than you hold. " +
    "USDC's issuer can freeze USDC accounts too. Withdrawing SOL depends on no issuer at all."
  );
}

/**
 * The legs whose limit is signed further under the market than the usual
 * margin, said with their own margin — or nothing. At a fee over 1 % the
 * build widens the margin by what each buy asks the market for over the plain
 * 2 % (solana-core legFloorMarginBps), and "5 % under it" is then not true of
 * that leg: the owner is owed the number he actually signs.
 */
function widerMarginClause(legs: readonly SignedLeg[]): string {
  const wider = legs
    .map((leg) => ({ symbol: leg.symbol, margin: legFloorMarginBps(judgedFeeOf(leg) ?? 0) }))
    .filter((leg) => leg.margin > LEG_FLOOR_MARGIN_BPS);
  if (wider.length === 0) return "";
  const named = wider.map((leg) => `${ratePercent(leg.margin)} for ${leg.symbol}`);
  const list = named.length === 1 ? named[0]! : `${named.slice(0, -1).join(", ")} and ${named.at(-1)}`;
  return ` (${list}, whose fee makes each buy ask the market for more room — a lower limit, and so less protection against a bad price)`;
}

/**
 * THE HONEST MAP OF THE DEFENCES, and it is short on purpose.
 *
 * Every clause here is a limit rather than a promise, because this file is the
 * one where an over-claim costs the most: the owner reads it, ticks a box and
 * signs. The three limits are the keeper's own (invest-decision.ts, "THE PRICE
 * DEFENCES" and "WHY AN ORACLE AT ALL"), said in his words and not in its.
 */
function defencesLimitsParagraph(legs: readonly SignedLeg[], marginUnderMarket: string): string {
  const stocks = legs.length === 0 ? "The stocks" : symbolsOf(legs);
  const plural = legs.length !== 1;
  return (
    `What SaverFi checks before a buy, and what it does not. It measures how much the venue it is buying from can hand over, and refuses unless that venue holds at least ${POOL_DEPTH_MULTIPLE} times the buy. ` +
    "THAT IS A CHECK ON SIZE, NOT ON PRICE: it can tell you a market is too thin for the buy you have asked for, and it cannot tell you the price you get is a fair one. " +
    "The SOL-to-USDC conversion has one outside opinion on it — the SOL price Pyth publishes, which is the only number in a buy that does not come from the venue being traded against. " +
    `${stocks} ${plural ? "have" : "has"} no such anchor today: nothing SaverFi reads publishes an independent price for ${plural ? "them" : "it"} on chain, so the only price bound on ${plural ? "those legs" : "that leg"} is the limit you sign yourself. ` +
    `And that limit is signed once: it is taken from one pool's price at the moment you sign${
      legs.some((leg) => (judgedFeeOf(leg) ?? 0) > 0) ? ", less the highest transfer fee each stock's issuer has set," : ","
    } ${marginUnderMarket} under it${widerMarginClause(legs)}, and it does not follow the market afterwards. ` +
    "As the market moves, the same number stops protecting you — or starts refusing every honest buy. SaverFi shows you how far it has drifted rather than leaving you to assume it still fits."
  );
}

/** The box he ticks, naming the powers his own legs are actually subject to. */
function acknowledgeSentence(legs: readonly SignedLeg[]): string {
  const prestocks = inGroup(legs, "prestock");
  return (
    "I understand each issuer can freeze, pause or move its own stock out of my vault" +
    (prestocks.length === 0 ? "" : `, that one key holds all of those powers over ${symbolsOf(prestocks)}`) +
    ", and that any of these issuers can stop my vault buying anything at all"
  );
}

export const VAULT_COPY = {
  title: "Vault",
  loading: "Reading your vault on Solana",
  unreadable: "SaverFi could not read Solana just now. Nothing was offered to sign.",
  retry: "Retry",
  noVault: "No vault yet",
  noVaultDescription: "Your vault holds what your trading wallets put aside, and only your pension key can take it out.",
  modeLegend: "What your trading wallet pays into the vault",
  profitLabel: `Profit · ${PROFIT_RATE}`,
  volumeLabel: `Volume · ${VOLUME_RATE}`,
  comingSoon: "Coming soon",
  limits: "Limits",
  mostPerSettlement: "Most per settlement",
  alwaysLeft: "Always left in the trading wallet",
  zeroSettlement: "Most per settlement must be more than 0 SOL.",

  // ── CHANGING THE VAULT'S OWN RULE, AFTER IT IS MADE ────────────────────────
  //
  // Until now these two could only be chosen when the vault was created. The
  // route carries them on setPolicy, which writes ALL SIX of the rule, so the
  // form sends the vault's current mode, rates and paused flag back untouched
  // beside the figure being changed.
  changeLimits: "Change these limits",
  changeLimitsHint:
    "These were set when your vault was made. Changing them signs your vault's rule again — the way it saves and the rate stay exactly as they are.",
  /**
   * THE ONE CONSEQUENCE THE OWNER MUST READ BEFORE SIGNING, not after.
   *
   * set_policy.rs bumps vault.policy_nonce on EVERY call, even one that changes
   * nothing, and settle.rs builds the message it verifies with that nonce — so
   * a settlement the attester has already signed stops verifying the moment
   * this lands. Changing the BASKET bumps a different counter the attestation
   * does not carry and strands nothing; this is the one that does.
   */
  nonceNotice:
    "Signing this makes any saving already on its way stop being valid: the keeper has to sign it again, so a settlement in progress may be delayed by a few minutes. Nothing is lost. Changing what your basket buys does not do this.",
  saveLimits: "Sign new limits",
  savingLimits: "Signing…",
  limitsSaved: "New limits signed",
  limitsUnchanged: "These are the limits your vault already has.",
  create: "Create vault",
  creating: "Creating…",
  created: "Vault created",
  viewOnSolscan: "View on Solscan",
  dismiss: "Dismiss",
  paused: "Paused",
  balance: "Balance",
  withdrawable: "Withdrawable",
  createdOn: "Created",
  address: "Vault address",
  /** The PROFIT rule, at `rate` ("20 %"). */
  profitRule: (rate: string, maxContribution: string, walletReserve: string): string =>
    `Profit · ${rate} of what your trading wallet gains. The keeper watches your trading wallet's SOL. When a stretch of trading ends with more SOL than it started, not counting plain transfers you send in or take out, ${rate} of the gain moves into this vault. Gains held in tokens count once they are sold back to SOL. A losing stretch moves nothing, and its loss comes off the next gain. Once your trading wallet has signed ${LOSS_DROPPED_AFTER_TXS} transactions of its own while still behind, that loss is dropped and later gains count in full. One settlement moves at most ${maxContribution} SOL; anything above that is not carried over. It never leaves the trading wallet with less than ${walletReserve} SOL.`,
  volumeComing: `Volume · ${VOLUME_RATE} of every buy and sell. Coming soon: the keeper cannot measure trading volume yet, so a volume vault would receive nothing. You will be able to switch when it is ready.`,
  /** The VOLUME rule, at `rate` ("2 %"), once VOLUME is offered. */
  volumeRule: (rate: string, maxContribution: string, walletReserve: string): string =>
    `Volume · ${rate} of the SOL value of every buy and sell your trading wallet makes, win or lose. At most ${maxContribution} SOL per settlement, and never leaving less than ${walletReserve} SOL in the trading wallet.`,
  bothModes: (rent: string): string =>
    `Only your pension key can withdraw from the vault, and SaverFi cannot pause or block a SOL withdrawal. The keeper can only move SOL from a linked trading wallet into this vault, never out of it. Creating the vault costs ${rent} SOL of rent plus the network fee. Solana keeps that rent in the vault, and a vault cannot be closed, so it does not come back.`,
  cost: (rent: string, fees: string): string => `Cost: ${rent} SOL of rent that does not come back, plus ${fees} SOL of network fees.`,
  costUnknown: "The rent could not be read just now; Phantom shows the total before you approve.",
  aboutUsd: (usd: string): string => `≈ ${usd}`,
} as const;

export const LINK_COPY = {
  linked: "Linked to your vault",
  viewLink: "View link on Solscan",
  otherVault: "This wallet saves into another vault. Only that vault's owner can unlink it.",
  link: "Link to vault",
  linkThis: "Link this wallet",
  cancel: "Cancel",
  needsVault: "Create your vault first.",
  needsConfig: "Linking opens once SaverFi's program is configured on Solana. Your vault, investing and withdrawals already work.",
  paused: "SaverFi is paused, so linking waits. Withdrawals still work.",
  busy: "Another signature is in progress on this screen.",
  /** A link for THIS wallet was sent and not confirmed, from this row or from the card's chained press. */
  sentNotConfirmed: "A link for this wallet was sent and is not confirmed yet. Check that one before sending another.",
  unreadable: "SaverFi could not read whether this wallet is linked. Nothing was offered to sign.",
  noSigner: "Until SaverFi has permission on this wallet, nothing is saved from it.",
  panel: (linkRent: string): string =>
    `Linking takes three signatures. Your trading wallet signs a consent naming this vault. Phantom pays ${linkRent} SOL of rent (returned if you unlink) and approves. Then your trading wallet co-signs. A wallet can be linked to one vault at a time.`,
  done: "Linked",
  walletIsPension: "A trading wallet cannot be your pension key.",
  tradingNotReady: "This trading wallet is not ready in this session. Reload the page, then try again.",
  consentMismatch: "The server asked your trading wallet to sign something that is not this link's consent. Nothing was signed.",
  consentTitle: "Link to your SaverFi vault",
  consentDescription: (pensionKeyShort: string): string => `Consent for SaverFi to link this trading wallet to the vault of pension key ${pensionKeyShort}. It moves no funds.`,
  consentButton: "Sign consent",
  consentNotSignature: "Your trading wallet did not return a 64-byte signature for the consent. Nothing was linked.",
  approvalPassedTwice: "Solana's approval window passed twice. Try again when ready.",
  coSignMismatch: "Your trading wallet signed a different transaction than Phantom approved. Nothing was sent.",
} as const;

/**
 * CREATING A TRADING WALLET AND LINKING IT, in one press.
 *
 * WHAT THE SEAT SENTENCES MAY CLAIM. A wallet is born seated: the keeper's signer
 * with its policy goes into Privy's createWallet itself. So these words say the
 * seat was asked for at creation, which is what happened, and never that Privy's
 * record has been read back — the row's badge is the only thing that reads it,
 * and it can only ever say a signer exists (src/lib/trading-wallets.ts).
 *
 * EVERY SENTENCE AFTER THE CREATE SAYS THE WALLET IS THERE. Once Privy has made
 * it, the wallet is real and paid for whatever the link does next, so no refusal
 * may read as "nothing happened".
 */
/** Defined before the object so `ahead` can end with it. */
const CREATE_LINK_RENT_UNREAD = "The rent is not on screen yet; Phantom shows it before you approve.";

export const CREATE_LINK_COPY = {
  /** The button, when the chain can take a link. */
  button: "Create wallet and link it",
  /** The button, when the chain cannot: it will only create. */
  buttonCreateOnly: "Create wallet",
  running: "Working…",
  /**
   * Said before anything is pressed, and again for the whole run: Phantom's prompt
   * must never arrive unannounced. `linkRent` is null while the chain's rent has not
   * been read — the amount is then Phantom's to show, and none is invented here.
   */
  ahead: (linkRent: string | null): string =>
    `One press: SaverFi creates the wallet with its permission to save from it, then links it to your vault in three steps — ` +
    `1 your new wallet agrees to save into this vault, ` +
    (linkRent === null ? `2 Phantom asks you to approve and pay the link's rent, ` : `2 Phantom asks you to approve and pay ${linkRent} SOL of rent, `) +
    `3 your new wallet confirms. Phantom's window opens partway through, after the wallet exists.` +
    (linkRent === null ? ` ${CREATE_LINK_RENT_UNREAD}` : ""),
  aheadCreateOnly: "This creates a trading wallet, with SaverFi's permission to save from it. Nothing is signed and nothing is paid.",
  /** The link's rent is not on screen yet: said instead of an amount, never as well as one. */
  rentNotRead: CREATE_LINK_RENT_UNREAD,
  done: "Linked",
  /** The head of every stop after the wallet exists. */
  created: "Your trading wallet is created and nothing was lost.",
  /**
   * What to do with it, said after `created`. THE LINK IS PROMISED FOR AFTER THE
   * CHAIN READ, never for now: a wallet created a moment ago is not in Privy's
   * record yet, so the screen's read has not been asked about it and its row shows
   * `notReadYet` with a re-read, not this button (LinkControl). The `not_ready`
   * stop is exactly that moment, so a flat promise was reliably wrong there — and
   * it named a control the owner could look at and not find.
   */
  inTheList: `It is in the list below, with its seat as Privy records it. Once SaverFi has read it on Solana, its row offers ${LINK_COPY.link}.`,
  /** No vault: the one thing that must happen first, and never done for the user — the rent never comes back. */
  needsVaultTitle: "Create your vault first",
  needsVault: (rent: string | null): string =>
    rent === null
      ? "A trading wallet can only be linked to a vault, and this pension key has none yet. SaverFi does not create one for you: a vault costs rent that never comes back, and it holds a mode and limits you choose. Create it above, then link this wallet from its row."
      : `A trading wallet can only be linked to a vault, and this pension key has none yet. SaverFi does not create one for you: a vault costs ${rent} SOL of rent that never comes back, and it holds a mode and limits you choose. Create it above, then link this wallet from its row.`,
  goToVault: "Create your vault",
  /** Privy answered without an address. */
  noAddress:
    "Privy created a wallet and did not say its address. Nothing is lost: it appears in the list below once Privy's record updates, and it can be linked from there.",
  /** The chain read is not ready, so no link may be attempted from an unknown state. */
  chainUnknown: "SaverFi could not read Solana just now, so the link was not attempted and nothing was signed.",
  /** Privy's record has not reached this session's signer list. */
  notReady:
    "This session cannot sign for the new wallet yet, so the link was not attempted. Reload the page, then link it from its row.",
  /** The link itself stopped. `detail` is the step's own words. */
  linkStopped: (detail: string): string => `The wallet was created; the link did not finish. ${detail}`,
  /** Some link on the screen was sent and not confirmed, so a chained press would race it. */
  linkAwaiting: "A link sent on this screen is not confirmed yet. Check it before starting another.",
  /** A row for a wallet the chain read has not covered yet. */
  notReadYet: "SaverFi has not read this wallet on Solana yet.",
  check: "Check again",
} as const;

export const INVEST_COPY = {
  title: "Investing",
  needsVault: "Create your vault first.",
  policyUnreadable: "SaverFi could not read your investment policy just now. Nothing was offered to sign.",
  basket: "Basket",
  rule: "Rule",
  buysEach: (usd: string): string => `Buys each time ${usd} of USDC is ready`,
  /** The same fact when the basket on screen does not yet fix a figure. Never the one-leg $5. */
  buysUnknown: "Buys once enough USDC is ready for the smallest share to clear its minimum",
  mostPerBuy: "Most per buy",
  mostPer30Days: "Most per 30 days",
  floorsTitle: "Today's price limits",
  solFloor: (floor: string, today: string): string => `SOL is never sold below ${floor} (90 % of today's ${today})`,
  /**
   * WHAT THE SOL FLOOR ACTUALLY IS, said in words, beside the live price it was
   * taken from. It reaches the program as min_convert_rate_wad, and the program
   * does NOT validate it: a zero there is accepted and silently means "sell this
   * vault's SOL at any price at all". Nothing on this screen can reach zero — the
   * web never lets the figure be typed, it is always floorWad(live price,
   * CONVERT_FLOOR_MARGIN_BPS), and vault-flows.ts refuses to sign a build whose
   * convertWad is null, zero or not exactly that — but the owner is signing the
   * number, so he is told what it does and what zero would have meant. `margin`
   * is how far under the live price it sits, from CONVERT_FLOOR_MARGIN_BPS.
   */
  convertFloorEffect: (margin: string): string =>
    `That floor is what keeps converting switched on: the keeper sells your vault's SOL for USDC only at or above it, and it is set ${margin} under the price just read above. It is never zero, and zero is the one value that would matter — it would mean your SOL sold at any price at all.`,
  /**
   * `fee` is the transfer fee the floor is netted of, as a percentage, or null
   * for a leg with none; `marginBps` is how far under the net price the floor
   * sits (solana-core legFloorMarginBps: 500, or 700 at a 3 % fee). WITH A FEE
   * THE LIMIT IS PER UNIT THAT ARRIVES: the floor is checked against what the
   * vault is credited, after the issuer's cut, so the percentage over today's
   * price is true only once that cut is counted — and the page says so rather
   * than letting a bigger number look like a looser limit. AND A WIDER MARGIN
   * IS SAID AS ONE: at 700 the limit is 7.5 % over, not 5.3 %, and the sentence
   * says why the room is there. AND THE FEE MAY NOT BE IN FORCE YET: the build
   * nets the higher of the live and the written fee, so on 2026-09-25 (epoch
   * 1042, 100 bps in force, 300 written for 1043) the floor 0.97 x 0.93 = 90.2 %
   * of the mid let a unit that arrives at 0.99 of it cost up to 9.7 % over
   * today's price, not 7.5 %. The sentence says the room is larger until then.
   */
  legCeiling: (symbol: string, max: string, fee: string | null, marginBps: number): string => {
    const over = overTodayPercent(marginBps);
    if (fee === null) return `${symbol} is never bought above ${max} per 100,000,000 raw units (${over} over today's pool price)`;
    return (
      `${symbol} is never bought above ${max} per 100,000,000 raw units that reach your vault (${over} over today's pool price once a ${fee} transfer fee is counted — the highest its issuer has set, in force now or written for a later epoch, so while a lower fee applies a buy may land further over today's price` +
      `${marginBps > LEG_FLOOR_MARGIN_BPS ? `; wider than the usual ${overTodayPercent(LEG_FLOOR_MARGIN_BPS)} because at that fee each buy asks the market for more room, and the limit has to leave it` : ""})`
    );
  },
  pricesUnknown: "Today's prices could not be read just now. The build reads them again, and the limits you sign are shown before Phantom asks.",
  /**
   * The owner's words for what a policy does, at the limits shown. `basket` is
   * every CHOSEN leg with its weight, so this sentence cannot go on naming one
   * stock after the basket grows — which is exactly how it came to say "invests
   * in SPYx" while the Basket field beside it already read "SPYx 50 %,
   * ANTHROPIC 50 %". The per-stock ceilings are NOT inlined here any more: at
   * two legs they arrived joined by a slash ("$801.80 / $18.95"), a figure of
   * no meaning, and the box below already prints one line per stock.
   *
   * TWO CLAUSES IN IT WERE FALSE ON THIS BRANCH AND ARE FIXED HERE, both left
   * behind by changes that updated everything except this paragraph — the first
   * sentence the owner reads.
   *  * "each through its own Raydium pool". The keeper routes JUPITER and
   *    nothing else (invest-decision.ts ROUTABLE_VENUES); there is no fixed
   *    route at all any more, because the router re-picks per quote
   *    (product.ts: "THERE IS NO FIXED ROUTE — Jupiter picks it"), and a 200
   *    USDC ANTHROPIC buy has been read routing four different venue pairs in
   *    one hour. Worse, Raydium was ALSO the only venue this form could then
   *    sign, and a policy naming it is refused by the keeper before the wrap
   *    for the life of the policy — so the opening words were false end to end.
   *  * "one of the pools is too small for the buy". The unit changed on
   *    2026-09-21 from a pool's in-side reserve to a census of the venue
   *    inventory the chosen route names, because the venues this basket must
   *    reach are an order book and a bin market with no reserve to read. See
   *    POOL_DEPTH_MULTIPLE above: INVEST_COPY.thinPool was rewritten in that
   *    change and this sentence was not, which is the shape that lets words go
   *    quietly false while every test stays green.
   */
  /**
   * `purchase` MAY BE NULL, AND NULL IS NOT $5.
   *
   * It is the whole buy at which the LIGHTEST share clears min_investment, so
   * it is a function of the basket and of the shares in the boxes. While either
   * is unreadable — which is every keystroke in the middle of a re-weight —
   * there is no such figure, and the clause used to fall back on the
   * catalogue's flat $5 constant: the one-leg answer, correct only by the
   * arithmetic coincidence TESTING_TRAPS.md is about. It now says it does not
   * know rather than naming a number that is right for a different basket.
   */
  policyRule: (basket: string, floorUsdPerSol: string, purchase: string | null, maxPerCall: string, maxRolling: string, rent: string): string =>
    `Your vault invests in ${basket}, each bought through Jupiter, which picks the route for every buy, and a buy takes all of them or none. When the vault holds SOL, the keeper converts it to USDC, never below ${floorUsdPerSol} per SOL, then ${purchase === null ? "buys once enough USDC is ready for the smallest share in the basket to clear its minimum" : `buys once ${purchase} of USDC is ready`} and never above the per-stock limits below. At most ${maxPerCall} per buy and ${maxRolling} per 30 days until you change them. If a price moves past a limit, or the venue a buy would land in is too small for it, nothing is bought and no SOL is converted until you sign again. Nothing is sold at a worse price. Setting this up costs ${rent} SOL of rent for the policy and the vault's token accounts, and none of it comes back.`,

  // ── WHAT THE POSITION COSTS, AND WHO OWNS EACH NUMBER ──────────────────────
  //
  // GENERATED FROM THE LEGS ON SCREEN, WHICH IS THE WHOLE CHANGE. These three
  // paragraphs used to name SPYx and ANTHROPIC in prose, quote their two fees
  // as literals and compare their two round trips against each other. Every
  // word of that was true while the basket was frozen at those two, and every
  // word of it became a description of somebody else's basket the moment the
  // owner could pick his own. The fee now comes from each chosen leg's own
  // mint reading with the epoch it was read in; the round trip comes from the
  // 2026-09-20 simulation where one exists, and a leg nobody measured is called
  // unmeasured rather than handed a neighbour's number.
  //
  // THE SIMULATION AND ITS SCOPE live at ROUND_TRIPS above, with the two dead
  // readings it replaced named there so neither comes back.
  costTitle: "What this costs you, and who decides it",
  /** What the issuers charge to move the chosen stocks: compounded over a round trip, never doubled, and never escapable by buying smaller. */
  issuerCost: (legs: readonly SignedLeg[]): string => issuerCostParagraph(legs),
  /**
   * THE LIMIT THE NEXT RAISE CROSSES, against the fees THIS basket carries.
   *
   * The keeper admits a leg while `fee.bps <= MAX_LEG_FEE_BPS` (invest-decision.ts
   * gates on `>`, strictly greater), so a leg sitting exactly on the limit is
   * admitted with no margin at all — which is the position of seven PreStocks
   * from epoch 1043, the 3 % their issuer had already written when read on
   * 2026-09-24.
   * `max` is MAX_LEG_FEE_BPS as a percentage, held to the keeper's own constant
   * by vault-copy.test.ts so this sentence cannot drift from the gate.
   */
  feeCeiling: (legs: readonly SignedLeg[], max: string = ratePercent(MAX_LEG_FEE_BPS)): string => feeCeilingParagraph(legs, max),
  /** What a round trip actually cost, where anybody measured one, and silence where nobody did. */
  marketCost: (legs: readonly SignedLeg[]): string => marketCostParagraph(legs),
  /**
   * WHAT SAVERFI CHECKS AND WHAT IT DOES NOT, which no sentence on this card
   * said while three of them described the checks.
   *
   * The depth gate measures DEPTH AT THE SIZE OF THE TURN and has no opinion
   * about price; Pyth anchors the SOL hop alone; the stock legs' only price
   * bound is the owner's own floor, and that floor is signed once and decays.
   * `marginUnderMarket` is LEG_FLOOR_MARGIN_BPS as a percentage, from the
   * constant the build route actually derives the floor with; a leg whose fee
   * widens it (legFloorMarginBps) is named with its own margin.
   */
  defencesLimits: (legs: readonly SignedLeg[], marginUnderMarket: string): string => defencesLimitsParagraph(legs, marginUnderMarket),

  // ── WHETHER IT CAN BUY AT ALL TODAY ────────────────────────────────────────
  //
  // NOT "only one leg can be bought": the keeper's depth gate is all-or-nothing
  // by explicit doctrine (legDepthDecision refuses "the whole basket ... the deep
  // ones included, and refusing to convert SOL toward it"), so one leg alone is
  // not a thing that can happen. And the gate tests a CONVERTING turn at
  // max_per_call itself (turnSpendCeiling), not at what the vault holds — so the
  // shipped $1,000 default is the figure it is judged by, and at two equal legs
  // that is $500 into ANTHROPIC's pool against the 50x it must clear.
  //
  // WHAT THE FIGURES USED TO BE, AND WHY THEY ARE NO LONGER WRITTEN DOWN HERE.
  // This block held one night's reading of ANTHROPIC's PINNED RAYDIUM POOL —
  // $9,541.65 on 2026-09-20, admitting $190.83 a leg and $381.67 a buy at two
  // equal legs — and the card printed it as the ceiling. Two things then became
  // true at once. The keeper moved to Jupiter, so the pinned pool is no longer
  // where the money goes (a 200 USDC ANTHROPIC buy routed BisonFi + Manifest on
  // 2026-09-21 and touched that pool not at all). And the owner got a picker,
  // so the basket and the shares are his: the ceiling is a function of which
  // assets he chose and what share each takes, and one leg at 50 % against one
  // at 20 % moved the same asset's cap from $298 to $745 on one day's reading.
  // A sentence with the number inside it cannot follow either change, so every
  // figure below is PASSED IN from basket-picker.ts's live computation over
  // solana-core's dated route censuses, and this comment keeps only the history.
  thinPoolTitle: "Today, this basket may buy nothing at all",
  /**
   * HOW THE CEILING'S OWN NUMBER CAME TO BE, IN THREE WORDS OR SO — and it is
   * not always "counted".
   *
   * The ceiling always divides a ROUTE CENSUS (basket-picker.ts refuses to
   * divide anything else), but a census is not always a count: ANTHROPIC's is
   * worked back from the day's own ceiling measurement, which its catalogue
   * entry has always said in a field nothing rendered. Four sentences on this
   * card therefore told the owner a derived figure had been counted, while the
   * sentence for a leg with no census at all opens "SaverFi has not counted" —
   * so the one distinction the copy leans on was collapsed exactly where it
   * mattered. One clause, used by all three, so they cannot drift apart again.
   */
  censusProvenance: (readOn: string, derived: boolean): string =>
    derived ? `worked out on ${readOn} from that day's own measurement rather than counted directly` : `counted on ${readOn}`,
  /**
   * THE CEILING, IN THE OWNER'S TERMS, with every number computed from the
   * basket on screen. `ceiling` is the largest Most per buy every chosen leg's
   * counted route still covers, `suggested` is where the box starts (half of
   * it), `symbol` is the leg that set it and `readOn` the day that leg's route
   * was counted. Nothing here is a constant, because none of it is constant.
   */
  thinPool: (ceiling: string, suggested: string, symbol: string, readOn: string, derived = false): string =>
    `The keeper refuses a buy unless the venue it buys from holds at least ${POOL_DEPTH_MULTIPLE} times that buy, so a thin market sets a small ceiling. On the shares you have chosen, the leg that sets it is ${symbol}: from what its route held, ${INVEST_COPY.censusProvenance(readOn, derived)}, the whole buy can be at most ${ceiling}, and that is the ceiling itself, not a target. Because a buy takes all of the basket or none, a Most per buy above it stops the buying altogether whenever the vault has SOL to convert: nothing bought, no SOL converted, at any balance. Most per buy starts at ${suggested}, which is half the ceiling, so an ordinary day's drift in that market does not turn your cap into one that buys nothing. That reading was true on the day it was taken and nothing on this page re-reads it. The keeper measures whichever venue it is actually buying through, in the turn itself, so a market that was deep last week does not count for anything today.`,
  /** The same ceiling as a line of facts, above the box it constrains. */
  capWindow: (floor: string, ceiling: string, symbol: string, readOn: string, derived = false): string =>
    `At these shares, Most per buy can be between ${floor} and ${ceiling}. The bottom is arithmetic on what you are signing; the top is ${symbol}'s market as it was ${INVEST_COPY.censusProvenance(readOn, derived)}, divided by the ${POOL_DEPTH_MULTIPLE}x cover the keeper insists on.`,
  /** No ceiling at all: a chosen leg's route has never been counted. Never rendered as a large ceiling. */
  ceilingUnknown: (symbols: string): string =>
    `SaverFi has not counted what ${symbols} holds where a buy would actually land, so it cannot tell you the largest Most per buy this basket can use. The figure it does have for that market is the venue's whole book, which no single buy reaches, and dividing that would give you a ceiling that is too high — the one direction this number must never be wrong in. Keep Most per buy small, or choose an asset whose route has been counted.`,

  // ── THE ISSUERS' POWERS, OVER THE STOCKS HE ACTUALLY PICKED ────────────────
  //
  // THESE THREE NAMED TWO STOCKS BY HAND AND CANNOT ANY MORE. The notice, the
  // powers paragraph and the box he TICKS all described SPYx and ANTHROPIC:
  // one key over ANTHROPIC, three separate keys over SPYx, and a stop that
  // takes "SPYx along with it". With a basket of his own choosing every one of
  // those clauses could be about a stock he never ticked — and the box he ticks
  // would have him acknowledging powers over something he does not hold while
  // saying nothing about the ones he does.
  //
  // WHAT THEY ARE BUILT FROM: PRESTOCKS_POWERS and XSTOCKS_POWERS in
  // solana-core's product.ts, each carrying the day it was read and the read
  // that produced it, plus HOOK_FIELD above for the one fact those two do not
  // hold. Nothing here is a literal about a particular stock except the
  // readings themselves, and those are dated.
  freezeNotice: (legs: readonly SignedLeg[]): string => freezeNoticeParagraph(legs),
  /** Which powers the actual issuers of the actual chosen legs hold — one key for a PreStock, and for an xStock no fee authority at all. */
  issuerKeys: (legs: readonly SignedLeg[]): string => issuerPowersParagraph(legs),
  /**
   * THE SWITCH THAT STOPS THE BUYING, on the legs chosen, under the keys that
   * hold it.
   *
   * Said in the owner's terms on purpose: what he is being asked to accept is
   * not a fee that might rise by some amount, it is that a stranger can stop
   * his pension buying anything at all, on a day of that stranger's choosing.
   * Every clause is a fact of the arrangement rather than of today's number, so
   * it survives a fee moving again: the field is empty TODAY, and the refusal
   * is what SaverFi does whenever it is not.
   *
   * THE STOP SPEAKS ONLY FOR ITSELF. It is said that the stop takes nothing,
   * and the powers that DO reach the holding are pointed back at, because this
   * paragraph sits in the same box as the permanent delegate and a bare
   * "nothing is lost" there reads as a promise that box denies three lines up.
   *
   * AND NEITHER SIDE OF THE ASYMMETRY IS OVERSTATED. Both groups carry the
   * field and both authorities are set, so the STOP is symmetric; only the FEE
   * is not. Nothing anybody read measures which key is likelier to be used, so
   * no sentence weighs them.
   */
  hookSwitch: (legs: readonly SignedLeg[]): string => hookSwitchParagraph(legs),
  /**
   * The short form, for screens that are not the policy form. It takes the legs
   * when the caller knows them and speaks generally when it does not — the
   * withdraw screen lists whatever the vault holds, which is not the same set
   * as the basket being signed.
   */
  freezeShort: (legs: readonly SignedLeg[] = []): string =>
    "Each issuer can freeze, pause or move its own stock, even inside your vault" +
    (inGroup(legs, "prestock").length === 0 ? "" : `, and on ${symbolsOf(inGroup(legs, "prestock"))} one key holds all of those powers`) +
    ". Withdrawing SOL does not depend on any of them.",
  /** The box he ticks, naming the powers HIS legs are subject to and no others. */
  acknowledge: (legs: readonly SignedLeg[]): string => acknowledgeSentence(legs),

  // ── THE FLOOR HE SIGNED ONCE, AND THE MARKET THAT WALKED AWAY FROM IT ──────
  //
  // WHY THIS BLOCK EXISTS. min_out_rate_wad is derived at signing time from one
  // pool's mid (net of the leg's fee since 2026-09-24), legFloorMarginBps(fee)
  // under it, and then it stands until the
  // owner signs again. The keeper's own comment is blunt about what that means:
  // the floor "DECAYS ... it clears itself as the market rises (a stale floor
  // stops binding) and blocks every honest buy as the market falls. A floor
  // that always passes is not a defence."
  //
  // THE SCREEN ALREADY SAID ONE HALF OF THAT AND NOT THE OTHER. A floor the
  // market has PASSED is visible: the badge flips and `marketPast` explains it.
  // A floor the market has left far behind is invisible, and it is the one that
  // costs money quietly — the number is still there, still signed, and would
  // let a buy through at a price nobody would accept today.
  //
  // WHAT IT MAY NOT SAY. Not that the drift is dangerous by some threshold of
  // its own invention, and not when it was signed: THE POLICY ACCOUNT RECORDS
  // NO SIGNING DATE (state.rs InvestmentPolicy has no timestamp), so the date
  // is passed in when a caller genuinely knows one and the sentence says
  // plainly that it is unknown when nobody does. The drift itself is arithmetic
  // over two numbers on the page: the floor the policy carries and the rate the
  // screen just read.
  floorDriftTitle: "The limits you signed do not follow the market",
  /** The head of the block. `signedOn` is null whenever nobody knows the day, and that is said rather than guessed. */
  floorDriftSigned: (signedOn: string | null): string =>
    signedOn === null
      ? "You signed these limits once and they have stood unchanged since. SaverFi cannot tell you which day that was — the policy on Solana does not record one — so what it shows instead is how far today's prices have moved away from them."
      : `You signed these limits on ${signedOn} and they have stood unchanged since. Today's prices have not.`,
  /** A leg whose limit the market has left far below: it still permits a buy nobody would make today. */
  legFloorSlack: (symbol: string, limit: string, today: string, drift: string): string =>
    `${symbol} may still be bought at up to ${limit}, while the market is at ${today} — ${drift} above today's price. That limit was set just under the price of the day it was signed, and it has not moved since, so it is no longer stopping much. Sign again to set it from today's prices.`,
  // ── WHETHER SAVERFI CAN STILL BUY UNDER A SIGNED LIMIT ────────────────────
  //
  // invest-limits.ts floorRoom answers "every-route", "some-routes" or
  // "no-route" for each leg, at the highest transfer fee its issuer has
  // written; these are the words for the last two. Neither may say more than
  // the keeper does: under "some-routes" it still buys whenever a sweep's best
  // route quotes before the fee, so the sentence must not say it refuses; under
  // "no-route" it refuses the whole basket and the SOL conversion on every
  // sweep (invest-tick.ts, before the wrap), and the sentence says exactly that.
  //
  // `fromEpoch` is the epoch a written rise takes effect in, when the limit is
  // still fine at the fee charged today and only that rise moves it; null when
  // the state already holds at today's fee (or no rise is written).
  roomTitle: "Whether SaverFi can still buy under your limits",
  /** "some-routes": a note, not an alarm — buying goes on, on some routes. */
  legFloorSomeRoutes: (symbol: string, limit: string, feeBps: number, fromEpoch: number | null): string =>
    `${
      fromEpoch === null
        ? `At the ${ratePercent(feeBps)} ${symbol}'s issuer charges on every transfer, your ${symbol} limit of ${limit} lets`
        : `From ${epochWords(fromEpoch)}, ${symbol}'s issuer charges ${ratePercent(feeBps)} on every transfer. Your ${symbol} limit of ${limit} will still let`
    } SaverFi buy on some of the routes the market offers, but not on every one: when a sweep's best route is one of the others, SaverFi waits for a later sweep instead of buying. Signing again with today's prices keeps every route open.`,
  /** "no-route": nothing is bought until the owner signs again. The badge says "Sign again" beside it. */
  legFloorNoRoute: (symbol: string, limit: string, today: string, feeBps: number, fromEpoch: number | null): string =>
    `${
      fromEpoch !== null
        ? `From ${epochWords(fromEpoch)}, when ${symbol}'s issuer starts charging ${ratePercent(feeBps)} on every transfer, SaverFi will not buy`
        : feeBps > 0
          ? `At the ${ratePercent(feeBps)} ${symbol}'s issuer charges on every transfer, SaverFi does not buy`
          : "SaverFi does not buy"
    } this basket — no stock in it, and no SOL converted toward it — until you sign again. Your ${symbol} limit of ${limit} is too close to today's price of ${today} to leave room for ${
      feeBps > 0 ? "that fee and " : ""
    }the market's movement on any route. The market has not passed your limit; signing again with today's prices sets it with that room.`,
  /** A leg whose limit the market has passed: the all-or-nothing refusal, said as what it stops. */
  legFloorPassed: (symbol: string, limit: string, today: string): string =>
    `${symbol} is limited to ${limit} and the market has passed it at ${today}: nothing is bought, and no SOL is converted toward any of it, until you sign again with today's prices.`,
  /** The SOL floor the market has left far above: your SOL may be sold far under what it is worth. */
  solFloorSlack: (floor: string, today: string, drift: string): string =>
    `Your SOL may still be sold for as little as ${floor} per SOL, while it is worth ${today} — ${drift} under today's price. That floor was set just under the price of the day it was signed and has not moved since. Sign again to set it from today's prices.`,
  /** The SOL floor the market has fallen through: conversion stops, and with it the buying. */
  solFloorPassed: (floor: string, today: string): string =>
    `Your SOL floor is ${floor} per SOL and SOL is at ${today}, under it: no SOL is converted, so nothing is bought, until you sign again with today's prices.`,
  /** Every floor still sits where it was signed, within the margin it was signed at. */
  floorsInStep: "Every limit still sits close to the prices just read.",

  sign: "Sign investment policy",
  signing: "Signing…",
  signed: "Policy signed",
  capsProblem: (minimum: string): string => `Most per buy must be at least ${minimum}, and Most per 30 days at least Most per buy.`,

  // ── THE FIELDS THE OWNER ASKED TO SET ──────────────────────────────────────
  minPerBuy: "Least per stock",
  /**
   * THE HINT NAMES THIS BASKET'S OWN FIGURE, because the one it used to name
   * was a worked example of somebody else's.
   *
   * It read "with two stocks at equal shares, a buy has to be at least twice
   * this". True of two equal legs and false of every other basket the picker
   * can build: at 80/20 the bar is FIVE times the minimum, not twice, because
   * the rule is ⌈min × 10,000 / the LIGHTEST share⌉ and not min × the count.
   * A sentence that is right at equal shares and wrong as soon as the owner
   * moves one box is the species TESTING_TRAPS.md calls prose that outruns its
   * measurement, so the example is gone and the basket's real floor is passed
   * in. `floor` is null while the shares or the minimum are unreadable, and the
   * sentence then says the figure depends on them rather than inventing one.
   *
   * AND IT SAYS WHICH OF THE TWO IS MISSING. The floor needs BOTH the shares
   * and the minimum, and the one sentence used to blame the shares for either
   * — so clearing this box to type a new figure produced "these do not add up
   * to 100 % yet" directly underneath it, about shares that were fine, while
   * the prose two elements above was simultaneously reading them out at
   * "SPYx at 80 % and ANTHROPIC at 20 %". `pending` names the box that is
   * actually empty, and this hint sits under the minimum's own box, so that
   * one is named first when both are unreadable.
   */
  minPerBuyHint: (floor: string | null, count: number, pending: "shares" | "minimum"): string =>
    "The smallest amount the keeper will put into ONE stock. It is checked per stock, not per buy: a buy has to be big enough for the SMALLEST share in your basket to clear it. " +
    (floor === null || count < 1
      ? pending === "minimum"
        ? "What that comes to follows this figure and the shares you have typed, and this box does not hold a figure yet."
        : "What that comes to follows the shares you type, and these do not add up to 100 % yet."
      : count === 1
        ? `With one stock that is ${floor} a buy.`
        : `With these ${count} stocks at the shares you have typed, that is ${floor} a buy.`),
  minimumProblem: "Least per stock must be more than zero.",
  minimumUnreachable: (minimum: string): string =>
    `At these settings no buy ever reaches ${minimum} for every stock, so nothing would be bought. Lower this, or raise Most per buy.`,
  weightsTitle: "What share each stock takes",
  weightsHint: "Whole percentages that add up to 100. Nothing is rounded or filled in for you: a basket that does not add up is refused rather than adjusted.",
  weightProblem: (symbol: string): string => `${symbol}'s share must be a whole number of percent, greater than zero.`,
  weightsSum: (total: string): string => `The shares must add up to exactly 100 %. These add up to ${total}.`,
  /** An empty basket. The program takes 1..8 legs and there is no such thing as a policy that buys nothing on purpose. */
  basketEmpty: "Choose at least one stock for your vault to buy.",
  /** More than the picker offers. The program would take eight; this product offers five, and the refusal names the number on screen. */
  basketTooMany: (most: number, chosen: number): string => `A basket holds at most ${most} stocks. This one has ${chosen}: untick one before adding another.`,
  venueLabel: "Where it trades",
  venueHint: "The exchange the keeper buys through. SaverFi checks the transaction against the one you pick before your wallet is asked to sign it.",
  convertWarning: "Above $1,000.00 per buy, one conversion can sell more than 1 SOL of your savings at the floor.",
  /**
   * SAID BESIDE THE BOX, the moment he types past the ceiling — AND IT NOW
   * BLOCKS SIGN RATHER THAN ONLY COLOURING THE TEXT.
   *
   * THE REASON IT WAS A WARNING IS GONE. It was a warning because the ceiling
   * was a literal that nothing on the page could re-derive, so refusing on it
   * would have been refusing on a number the page could not defend. The page
   * now computes it from the basket on screen, the shares in the boxes and
   * solana-core's dated route censuses, and re-computes it on every keystroke.
   * A cap over it is not a risk, it is an arithmetic certainty on the readings
   * SaverFi has: the keeper's depth gate is all-or-nothing, so the policy buys
   * NOTHING at any balance, forever, and the rent that signs it does not come
   * back.
   *
   * A REFUSAL THAT DOES NOT SAY WHAT TO DO INSTEAD IS HALF A REFUSAL, so this
   * names the leg responsible and every way out — the cap, that leg's share,
   * or that leg.
   *
   * AND IT COUNTS THEM HONESTLY. In a one-stock basket the share is 100 % by
   * arithmetic and cannot be lowered, so `lighterShare` arrives null and the
   * sentence offers TWO ways out and says two. A refusal that promises three
   * and lists two sends the owner looking for a control that is not there.
   */
  depthWarning: (ceiling: string, symbol: string, readOn: string, lighterShare: string | null, derived = false): string =>
    `${ceiling} is the most this basket can buy with, and ${symbol} is what sets it: its market was ${INVEST_COPY.censusProvenance(readOn, derived)}, and the keeper will not put more than a ${POOL_DEPTH_MULTIPLE}th of what it found there into one leg of one buy. Above this the vault buys nothing and converts no SOL, at any balance, and the rent you pay to sign it does not come back. ${lighterShare === null ? "Two" : "Three"} ways out: lower Most per buy to ${ceiling} or less` +
    (lighterShare === null ? "" : `, give ${symbol} a smaller share — ${lighterShare} or under works at the cap you typed`) +
    `, or take ${symbol} out of the basket.`,
  /**
   * The button that takes the refusal away in one press.
   *
   * IT OFFERS THE SUGGESTED CAP, NOT THE CEILING, and the difference is the
   * point. Pressing a button labelled with the ceiling would move the owner
   * from one raw unit above the edge to exactly on it, where an ordinary day's
   * drift in that market puts him back — a fix that has to be applied twice is
   * not a fix. Half the ceiling is where the box would have started.
   */
  useSuggested: (suggested: string): string => `Use ${suggested}`,
  /**
   * NO CAP EXISTS AT ALL: the ceiling has fallen under the per-leg minimum's
   * floor. This is a real outcome, not an error — a thin market at a heavy
   * share produces it — and the only honest answer is that the BASKET has to
   * change, so no number in the caps boxes is offered as a fix.
   */
  capWindowEmpty: (floor: string, ceiling: string, symbol: string): string =>
    `There is no Most per buy that works for this basket. Every buy has to be at least ${floor} for each stock to clear its minimum, and ${symbol}'s market cannot cover more than ${ceiling} at the share you have given it. Give ${symbol} a smaller share, lower Least per stock, or take ${symbol} out.`,
  youAreSigning: (solFloor: string, legs: string, perBuy: string, per30Days: string): string =>
    `You are signing: SOL never sold below ${solFloor}; ${legs}; at most ${perBuy} per buy and ${per30Days} per 30 days.`,
  legSigning: (symbol: string, max: string): string => `${symbol} never bought above ${max} per 100,000,000 raw units`,
  enabled: "Investing is on.",
  paused: "Investing is paused.",
  floorsBelowMarket: "Floors below market",
  floorPassed: "Floor passed",
  /** The badge when a leg's signed limit leaves SaverFi no route to buy on (invest-limits.ts floorRoom "no-route"): nothing is wrong with the market, the limit has to be signed again. */
  floorNoRoute: "Sign again",
  marketPast: "The market moved past a floor: buying waits until you sign again with today's prices.",
  storedSolFloor: (floor: string, today: string | null): string => (today === null ? `SOL floor ${floor}` : `SOL floor ${floor}, today ${today}`),
  storedLegCeiling: (symbol: string, max: string, today: string | null): string =>
    today === null ? `${symbol} ceiling ${max} per 100,000,000 raw units` : `${symbol} ceiling ${max} per 100,000,000 raw units, today ${today}`,
  usedLast30: "Used in the last 30 days",
  lifetime: "Invested so far",
  ready: "Ready: the next sweep can buy.",
  waiting: (at: string): string => `Waiting: it buys once the vault holds ${at} of USDC.`,
  unreachable: "These limits can never buy the whole basket: raise Most per buy.",
  signAgain: "Sign again with today's prices",
  pause: "Pause investing",
  resume: "Resume investing",

  // ── CHANGING A POLICY THAT IS ALREADY SIGNED ───────────────────────────────
  //
  // THE FORM WAS ALWAYS THERE AND WAS ONLY EVER REACHABLE ONCE. The card sent
  // every owner WITH a policy to the summary, which renders the stored basket
  // as text and offers two buttons that both re-sign exactly what is stored. So
  // the picker, the share boxes, the two caps and the minimum — all built,
  // tested and correct — could not be reached by anybody who had signed, and
  // the owner's words for that were "it is not functional".
  //
  // set_invest_policy OVERWRITES, so an edit is not a second instruction, a
  // migration or a second form: it is the SAME form, opened on the values the
  // chain holds. That is the whole of it, and it is why the arithmetic that
  // refuses an unbuyable basket lands here too instead of being reimplemented
  // beside it.
  /** The way in, on a policy that exists. */
  editBasket: "Change what your vault buys",
  /** The way back out without signing anything. */
  keepWhatIHave: "Keep what I have",
  /**
   * WHAT SIGNING FROM THE EDIT FORM DOES, said before he touches a box.
   *
   * Two facts, and the second one is why the form can refuse him: the policy is
   * REPLACED rather than amended, and the largest cap the basket may carry is a
   * function of the thinnest market in it. An owner who ticks a thin stock and
   * then finds Sign greyed out reads that as a broken screen unless he was told
   * beforehand that the cap and the basket are one arithmetic.
   */
  editingPolicy:
    "You are changing a policy that is already signed. Signing replaces it outright: the basket, the shares and the limits on this screen are what your vault uses from then on. The one thing not on this screen that is kept is whether investing is on or paused — the button below says which of the two you are signing. Adding a thinly traded stock lowers the most you can buy with, so Most per buy may have to come down before this can be signed.",
  /**
   * A STORED STOCK THE SHELF NO LONGER OFFERS, on the form rather than instead
   * of it.
   *
   * The edit form used to be REFUSED in this case, because it shares its
   * reading of the stored basket with "Sign again" — where a missing leg
   * really would build a different basket. For the form the opposite is true:
   * set_invest_policy overwrites, so a fresh basket without that stock is
   * precisely the remedy, and the owner whose basket has stopped buying
   * because a venue drained is the one who needs the picker most. What he must
   * not get is a silent absence: the row is gone from the boxes and the shares
   * no longer add up to 100, and that has to read as a consequence rather than
   * as a glitch.
   */
  editDropped: (symbols: string): string =>
    `This policy holds ${symbols}, which SaverFi does not offer today, so it is not in the boxes below and the shares no longer add up to 100 %. Signing from here replaces the policy with the basket on this screen, which is how ${symbols} comes out of it. Give the stocks you are keeping shares that add up to 100 %.`,
  /**
   * THE VENUE THE FORM SUBSTITUTED. The select holds NAMES and the policy holds
   * a program id, and a stored program this app cannot check the bytes of has
   * no name to show — so the box opens on the default, and signing would write
   * it. That is a change to the policy made by the form and not by the owner,
   * which is exactly what editingPolicy promises does not happen silently.
   */
  editVenueReplaced: (venue: string): string =>
    `This policy was signed on a venue SaverFi can no longer check, so Where it buys has opened on ${venue} instead of what is stored. Signing from here moves the policy to ${venue}.`,
  /** Signing an edit of a policy that is ON. */
  signChanges: "Sign these changes",
  /**
   * Signing an edit of a PAUSED policy, which must not quietly resume it.
   *
   * The setup form hardcoded `enabled: true` — correct for a first policy and
   * wrong for every edit of a paused one, where it would turn investing back on
   * without a word. The flag is seeded from the policy and the button says
   * which of the two is being signed.
   */
  signChangesPaused: "Sign these changes, investing stays paused",
  /**
   * A STORED SHARE THE BOXES CANNOT HOLD, REFUSED RATHER THAN ROUNDED.
   *
   * The picker takes whole percentages and readWeights refuses anything else,
   * so a stored 33.34 % has no box to sit in. Rounding it would re-sign a
   * basket the owner never chose — silently, from a screen he opened to change
   * something else — so the edit is declined and the two buttons that re-sign
   * what is stored are left alone. No policy on the shelf holds such a share
   * today: this is a guard, not a repair.
   */
  editFractionalShare: (symbol: string, share: string): string =>
    `This policy gives ${symbol} ${share}, which is not a whole number of percent, and the share boxes take whole percentages only. Changing the basket here would have to round it into a share you never chose, so it is not offered. Signing again and pausing still work on it exactly as it stands.`,
  pauseKeeps: "Pausing signs this policy again as it is, with investing off, so it needs no prices. Resuming and signing again read today's prices.",
  pauseSigning: "You are signing: investing paused, with every floor and limit this policy has.",
  noRefill: "Signing again does not refill this month's cap.",

  // ── WHEN "Sign again" AND "Resume" MAY NOT BE PRESSED ─────────────────────
  //
  // BOTH BUTTONS RE-SIGN THE STORED BASKET, which is the change these four
  // sentences belong to. They used to send the two caps and nothing else, and
  // the build route then filled the rest in with its own defaults: the WHOLE
  // shelf at equal shares, at the catalogue's split minimum. On a one-stock
  // policy that meant one press replaced the basket the owner picked with a
  // basket he never saw — while Pause, three inches away, correctly re-signed
  // the stored legs, so pause-then-resume was not a round trip.
  //
  // AND THE STORED CAP IS JUDGED AGAINST THE STORED BASKET, because the cap
  // that was inside the window for the basket he signed can be outside it for
  // any other one. A cap over the ceiling does not buy less: the keeper's depth
  // gate is all-or-nothing, so the policy buys nothing at any balance for its
  // whole life, and the rent is spent again. The setup form has refused this
  // since the picker landed; these two buttons went around it.
  /** A stored policy whose own fields cannot be read: no re-sign is offered rather than one built on a guess. */
  resignUnreadable: "SaverFi could not read this policy's own basket and limits just now, so it cannot offer to sign it again. Pausing still works: it re-signs exactly what is stored.",
  /** A stored basket holding something the shelf no longer offers: re-signing would quietly drop it. */
  resignUnoffered: (symbols: string): string =>
    `This policy holds ${symbols}, which SaverFi does not offer today. Signing again would build a basket without it — a different basket from the one you signed — so it is not offered. Pausing still re-signs exactly what is stored.`,
  /** The stored cap is under the floor its own basket needs: re-signing would rebuild a policy that cannot buy. */
  resignBelowFloor: (floor: string, symbol: string): string =>
    `This policy's Most per buy is under ${floor}, the least every stock in it can clear — ${symbol} has the smallest share, so it sets that bar. Signing it again would sign a policy that buys nothing at any balance. Pause it and set it up again with a larger Most per buy.`,
  /** The stored cap is over the depth ceiling its own basket faces: the same refusal the setup form makes. */
  resignOverCeiling: (ceiling: string, symbol: string, readOn: string): string =>
    `This policy's Most per buy is over ${ceiling}, the most ${symbol}'s market covered when it was read on ${readOn} at the share this policy gives it. The keeper refuses a buy the venue cannot cover ${POOL_DEPTH_MULTIPLE} times over, and it refuses the whole basket with it, so signing this again would sign a policy that buys nothing at any balance and spends the rent doing it. Pause it and set it up again with a smaller Most per buy.`,
} as const;

/**
 * THE CATALOGUE AND ITS PICKER.
 *
 * WHAT THE OWNER ASKED FOR, in his words: "que el user pueda seleccionar las
 * que quiere y las que no, maximo como 5 assets y despues el user pone las %
 * que quiere". So: browse, tick at most five, type a share against each.
 *
 * WHAT THE SCREEN OWES HIM BESIDE THE LIST. Two things, and neither may be
 * buried in a paragraph under the fold:
 *  * THAT A BUY IS ALL-OR-NOTHING. The keeper's refusals — the depth gate, the
 *    fee ceiling, the transfer hook — each refuse the WHOLE basket and the SOL
 *    conversion with it, by explicit doctrine (invest-decision.ts
 *    legDepthDecision: "the deep ones included, and refusing to convert SOL
 *    toward it"). Adding a thin asset to a deep basket does not add a little
 *    risk to one leg; it puts the whole thing on that leg's worst day. The
 *    sentence therefore lives WHERE HE PICKS, not in the small print.
 *  * WHY AN ASSET IS NOT ON THE SHELF, with the reading that refused it.
 *    offerProblems() returns every rule an asset failed and the dated figure
 *    behind each, so a refusal can be re-run rather than argued with.
 */
export const PICKER_COPY = {
  title: "Choose what your vault buys",
  hint: (most: number): string =>
    `Tick up to ${most} and give each one a share. Shares are whole percentages and must add up to exactly 100 — nothing is rounded or filled in for you, because a basket that does not add up is a different basket from the one on screen.`,
  /** Said beside the ticks, not under them. */
  allOrNothing:
    "A buy takes the whole basket or none of it. If one of these cannot be bought on the day — its market too thin for the size, its issuer's fee raised, its transfer hook filled in — then nothing is bought, no SOL is converted, and that stays true on every sweep until you sign a different basket. The thinner the market you add, the more often that day comes.",
  evenOut: "Even them out",
  /** The running total, always on screen, so the sum is never news at the end. */
  total: (total: string): string => `Shares add up to ${total}`,
  short: (missing: string): string => `${missing} left to give`,
  over: (excess: string): string => `${excess} too much`,
  exact: "Adds up to 100 %",
  /** One line per chosen leg: what it would be handed out of a full buy. */
  legShare: (symbol: string, share: string, cap: string): string => `${symbol} takes ${share} of every buy — ${cap} out of a full one`,
  full: (most: number): string => `That is ${most}, the most a basket holds. Untick one to choose another.`,
  notOffered: "Not available",
  /** Why an asset is off the shelf, with the dated reading that put it there. */
  refusedBecause: (why: string): string => why,
  /** The group's standing facts, shown once per group rather than once per asset. */
  /**
   * A GROUP SENTENCE, SO IT MUST BE TRUE OF EVERY PRESTOCK THE PICKER LISTS.
   * Read 2026-09-24: all eight charge 1 %, and seven have 3 % — exactly the
   * limit — already written for epoch 1043; SPACEX alone has nothing newer.
   * vault-copy.test.ts holds this sentence to those readings, so a re-read
   * that changes either half turns it red instead of leaving it standing.
   */
  prestockGroup:
    "PreStocks: one issuer key mints, freezes, pauses, sets the transfer fee and holds a permanent delegate over every one of these, and it has used that key. Each charges 1 % to transfer today, and on all but SPACEX it has already written 3 % from epoch 1043, around 26 September 2026 — exactly SaverFi's limit, so one more raise after that and the whole basket stops.",
  /**
   * THE GROUP'S FACT, SAID OF THE MINTS SOMEBODY ACTUALLY READ. 929 xStock
   * mints exist and one was read (XSTOCKS_POWERS.mintsRead), so the plural was
   * a promise about 928 accounts nobody had opened — harmless today, because
   * SPYx is the only xStock on the shelf, and applied unchanged to the next one
   * added. PRESTOCKS_POWERS earns its plural: it was read over all eight mints
   * it speaks for.
   */
  xstockGroup: (read: string): string =>
    `xStocks (read here: ${read}): no transfer fee, and no key anywhere able to add one — the mint carries no fee setting at all, and a Token-2022 mint cannot gain one after it is made. The issuer still holds freeze, pause and a permanent delegate, under separate keys. Each xStock is its own mint and is read before it is offered; this is not a promise about the rest of the range.`,
  /**
   * THE DEPTH READING A TILE CARRIES, DATED AND SCOPED ON ITS FACE.
   *
   * `scope` IS NOT DECORATION. A route census counts the accounts one route
   * names — what the keeper's own gate counts — while a venue-wide figure sums
   * a book or a set of bins that no single buy reaches, and on ANTHROPIC the
   * two differed by forty-five times on the day both were read. This line used
   * to render both in the same words, under a sentence calling them all counts,
   * so a tile showing a venue's whole book read exactly like a tile showing a
   * counted route. `derived` is the second half of the same honesty: some of
   * these figures were worked back from another measurement rather than taken.
   */
  depthLine: (venue: string, usd: string, readOn: string, scope: "route-census" | "venue-wide" = "route-census", derived = false): string =>
    scope === "venue-wide"
      ? `${venue} held ${usd} across its whole book when it was read on ${readOn} — no single buy reaches all of that`
      : `${venue} held ${usd} where a buy would land, ${derived ? `worked out on ${readOn} rather than counted directly` : `counted on ${readOn}`}`,
  depthUnread: "Nobody has counted this market where a buy would land.",
  /** What these readings are and are not, said once under the list. */
  depthMeaning:
    "Those readings were taken on a named day, not promises — and they are not all the same kind. Some count the route a buy actually took; some are a venue's whole book, which no single buy reaches; one is worked back from another day's measurement rather than counted. Each line says which it is. The keeper counts again inside every buy, against the amount that buy really spends, and its count is the one that decides.",
  remove: (symbol: string): string => `Remove ${symbol}`,
} as const;

export const WITHDRAW_COPY = {
  title: "Take money out",
  refresh: "Refresh",
  needsVault: "Create your vault first.",
  sol: "SOL",
  balance: "Balance",
  withdrawable: "Withdrawable",
  keptAsRent: (rent: string): string => `Kept as rent ${rent} SOL`,
  amount: "Amount to withdraw",
  max: "Max",
  withdrawSol: "Withdraw SOL",
  withdrawing: "Withdrawing…",
  withdrawn: "Withdrawn",
  zero: "Enter more than 0 SOL.",
  aboveWithdrawable: (max: string): string => `The vault can release at most ${max} SOL.`,
  solRule: (rentFloor: string): string =>
    `Only your pension key can withdraw, and SaverFi cannot pause or block a SOL withdrawal. The vault keeps ${rentFloor} SOL of rent, which Solana requires, and a vault cannot be closed.`,
  empty: "Savings arrive from linked trading wallets. To try a withdrawal now, send a little SOL to the vault address from your wallet app.",
  /** Shown beside the SOL section while the vault's investment policy is on. */
  investingOn:
    "Investing is on, so the keeper can convert SOL that reaches this vault to USDC within about a minute, and it then shows under Tokens. To test a SOL withdrawal, pause investing first.",
  /** A withdrawal the build checked, refused on chain because the vault then held less SOL: the keeper's conversion, most likely. */
  balanceMoved: "The vault's SOL moved after this was prepared, most likely into investing by the keeper: see Tokens. Nothing was withdrawn.",
  vaultAddress: "Vault address",
  tokens: "Tokens",
  noTokens: "The vault holds no tokens yet.",
  tokensUnreadable: "SaverFi could not read the vault's tokens just now. Nothing was offered to sign.",
  /** When the vault's token listing could not be read and its own accounts, read by address, could: `symbols` is "wSOL, USDC and SPYx". */
  tokensOwnAccountsOnly: (symbols: string): string => `SaverFi could not list every token account your vault owns just now, so only its own ${symbols} accounts are shown.`,
  ownAccountsEmpty: "Those accounts hold no tokens.",
  share: (percent: number): string => (percent === 100 ? "All" : `${percent} %`),
  wsolNote: "Arrives in your wallet as SOL.",
  createsLegAccount: (symbol: string, rent: string): string => `Creates your own ${symbol} token account if you have none (${rent} SOL of rent, paid by you and kept by you).`,
} as const;

export const PROGRESS_COPY = {
  creating_wallet: "Creating your trading wallet",
  preparing: "Preparing",
  consent: "Trading wallet signs the consent",
  approve_pension: "Approve in Phantom",
  trading_signing: "Trading wallet signing",
  sending: "Sending",
  confirming: "Confirming on Solana",
  done: "Done",
  tookTooLong: "Took too long",
  tookTooLongDetail: "Solana's approval window passed before the transaction landed, so nothing moved. Build it again to sign a fresh one.",
  buildAgain: "Build again",
  notConfirmed: "Not confirmed yet",
  notConfirmedDetail: "The transaction was sent, and Solana has not confirmed it yet. Check again before signing anything new.",
  checkAgain: "Check again",
  refused: "Refused",
  rateLimited: "Too many requests",
  unreadable: "Solana did not answer",
} as const;

export const FAILURE_COPY = {
  phantomNotConnected: "Phantom is not connected to this page. Open Phantom, unlock it, and reload.",
  phantomDeclined: "Phantom did not approve. Nothing was sent.",
  tradingDeclined: "Your trading wallet did not sign. Nothing was sent.",
  network: "SaverFi could not be reached. Check your connection, then try again.",
  unavailable: "Solana is not available on this deployment right now.",
  upstream: "Solana did not answer just now. Nothing was sent. Try again.",
  rateLimited: (seconds: number | null): string =>
    seconds === null ? "Too many requests just now. Try again in a minute." : `Too many requests just now. Try again in ${seconds} s.`,
  blockhashExpired: "Solana's approval window passed before the transaction was sent. Build it again.",
  alreadyExists: "It already exists. Refreshing.",
  frozen: "The issuer has frozen this token account. SOL withdrawals still work.",
  issuerPaused: "The issuer has paused transfers of that stock.",
  simulationRefused: "Solana refused this transaction in simulation. Nothing was sent.",
  /** The pension key cannot pay this action's rent and fees; `cost` is its total in SOL when the build said it, else null. */
  needsSol: (cost: string | null): string =>
    cost === null
      ? "Your pension key does not hold enough SOL for this action's rent and fees. Add SOL in Phantom, then try again. Nothing moved."
      : `Your pension key needs more SOL: this action costs about ${cost} SOL in rent and fees. Add SOL in Phantom, then try again. Nothing moved.`,
  unknown: "Something went wrong. Nothing was sent.",
  builtMismatch: (detail: string): string => `SaverFi's server sent a transaction that is not what you asked for (${detail}). Nothing was signed.`,
  /**
   * A venue this app cannot check the bytes of. The server may offer a name the
   * web has not learned the program for yet; signing it would mean trusting the
   * server about which program the vault will call, which is the one thing the
   * intent check exists to avoid. The panel only offers verifiable names, so
   * this is a last line rather than something an owner should ever meet.
   */
  unverifiableVenue: (venue: string): string =>
    `SaverFi cannot check a transaction that trades on "${venue}" yet, so it will not ask you to sign one. Nothing was signed. Choose another venue, or update SaverFi.`,
  signedMismatch: (detail: string): string => `Phantom changed the transaction SaverFi built (${detail}). Nothing was sent.`,
  foreignProgram: (label: string): string => `Phantom added an instruction for ${label}, which SaverFi does not relay. Nothing was sent.`,
  /** Phantom's Lighthouse checks broke the rule the relay holds them to; `detail` is @sip/solana-core's checkWalletGuards words. */
  walletGuardRefused: (detail: string): string => `Phantom added a Lighthouse safety check SaverFi does not relay (${detail}). Nothing was sent.`,
  /** A Lighthouse check Phantom added failed: an account was not as Phantom's preview showed when the transaction ran. */
  walletGuardFailed: "Phantom's safety check stopped this transaction: an account changed after Phantom previewed it. Nothing moved. Try again.",
  unreadableBuilt: "SaverFi's server sent something that is not a transaction. Nothing was signed.",
  unreadableSigned: "Phantom returned something that is not a transaction SaverFi can read. Nothing was sent.",
} as const;
