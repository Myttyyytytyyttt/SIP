// The measuring half of the depth gate, without a network.
//
// WHAT IS TESTED HERE AND WHY IT IS NOT IN invest-decision.test.ts: these are
// the functions that turn what Jupiter said into what the pure gate judges —
// the ordered venue comparison, the per-hop census scope, the account read.
// Every VERDICT is still next door. A bug in either file is a basket bought
// into a drained venue, and they fail differently: next door the rule is wrong,
// here the rule is right and was handed the wrong numbers.

import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { legDepthDecision, maxTurnImpactBps, USDC_MINT, type VenueAccount } from "../src/invest-decision.js";
import {
  ammKeysOf,
  censusHops,
  impactFrom,
  labelsOf,
  readRouteAccounts,
  sameVenues,
  slippageRefusal,
} from "../src/venue-depth.js";
import type { JupiterQuote } from "../src/program-scripts.js";

const key = (): PublicKey => Keypair.generate().publicKey;

/** A quote as lite-api.jup.ag really answers one — the fields MEASURED on 2026-09-21. */
function quoteOf(
  hops: readonly { readonly label: string; readonly amm: string; readonly outputMint?: PublicKey; readonly outAmount?: bigint }[],
  totals: { readonly inAmount: bigint; readonly outAmount: bigint } = { inAmount: 25_000_000n, outAmount: 23_897_572n },
): JupiterQuote {
  return {
    inputMint: key().toBase58(),
    outputMint: key().toBase58(),
    inAmount: totals.inAmount.toString(),
    outAmount: totals.outAmount.toString(),
    otherAmountThreshold: "0",
    swapMode: "ExactIn",
    slippageBps: 200,
    routePlan: hops.map((hop) => ({
      swapInfo: {
        label: hop.label,
        ammKey: hop.amm,
        ...(hop.outputMint === undefined ? {} : { outputMint: hop.outputMint.toBase58() }),
        ...(hop.outAmount === undefined ? {} : { outAmount: hop.outAmount.toString() }),
      },
    })),
  };
}

describe("reading a quote's own hops", () => {
  it("takes the ordered ammKey and label lists a turn is compared by", () => {
    // THE SHAPE MEASURED AGAINST lite-api.jup.ag ON 2026-09-21: every hop of
    // every USDC -> ANTHROPIC quote carried ammKey, inAmount and outAmount
    // beside label, the mints and updateContextSlot.
    const quote = quoteOf([{ label: "Kipseli", amm: "7yD7gfXv49" }, { label: "Manifest", amm: "61mmsZUgoF" }]);
    expect(ammKeysOf(quote)).toEqual(["7yD7gfXv49", "61mmsZUgoF"]);
    expect(labelsOf(quote)).toEqual(["Kipseli", "Manifest"]);
  });

  it("compares venue lists IN ORDER, and never matches a hop Jupiter did not name", () => {
    expect(sameVenues(["a", "b"], ["a", "b"])).toBe(true);
    // USDC -> X -> Y and USDC -> Y -> X touch the same two AMMs and are not the
    // same route; a set comparison would divide one path's rate by another's.
    expect(sameVenues(["a", "b"], ["b", "a"])).toBe(false);
    expect(sameVenues(["a", "b"], ["a"])).toBe(false);
    // An unnamed hop is a hop we cannot say is the same hop — including against
    // another unnamed one, which is the case a lenient `===` would let through.
    expect(sameVenues([""], [""])).toBe(false);
    expect(sameVenues([], [])).toBe(false);
  });
});

describe("ARM 2, from two quotes of one instant", () => {
  const base = {
    turnAmms: ["7yD7gfXv49", "61mmsZUgoF"],
    probeAmms: ["7yD7gfXv49", "61mmsZUgoF"],
    turnLabels: ["Kipseli", "Manifest"],
    probeLabels: ["Kipseli", "Manifest"],
    slippageBps: 200n,
    feeBps: 100n,
  };

  it("derives the turn's impact from the two implied rates, against a quarter of the usable tolerance", () => {
    // The turn gets 100 out per 1 in; the probe 101. That is 99 bps of
    // degradation, over the 25 bps a 200/100 leg allows.
    const probe = impactFrom({ ...base, turnIn: 100_000_000n, turnOut: 100_000_000n, probeIn: 1_000_000n, probeOut: 1_010_000n });
    expect(probe).toEqual({ compared: true, impactBps: 99n, ceilingBps: maxTurnImpactBps(200n, 100n) });
  });

  it("ABSTAINS when the probe re-routes, naming both routes, and never reads as a pass", () => {
    // MEASURED 2026-09-21, one instant, USDC -> ANTHROPIC: the 25 USD turn
    // routed Kipseli + Manifest and the 1 USD probe routed Byreal + Manifest.
    // Jupiter re-picks per quote, so this is the common case and not the rare
    // one — a gate that refused here would refuse routinely.
    const probe = impactFrom({
      ...base,
      probeAmms: ["9GTj99g9tb", "61mmsZUgoF"],
      probeLabels: ["Byreal", "Manifest"],
      turnIn: 25_000_000n,
      turnOut: 23_897_572n,
      probeIn: 1_000_000n,
      probeOut: 955_938n,
    });
    expect(probe.compared).toBe(false);
    if (probe.compared) return;
    expect(probe.why).toContain("Byreal + Manifest");
    expect(probe.why).toContain("Kipseli + Manifest");
  });

  it("abstains when the turn is no larger than the probe, because there is no size to compare", () => {
    const probe = impactFrom({ ...base, turnIn: 1_000_000n, turnOut: 1_000n, probeIn: 1_000_000n, probeOut: 1_000n });
    expect(probe.compared).toBe(false);
  });
});

describe("ARM 1's per-hop censuses and the scope beside them", () => {
  function accountOf(mint: PublicKey, amount: bigint): { readonly account: VenueAccount; readonly address: PublicKey } {
    const address = key();
    const data = Buffer.alloc(165);
    mint.toBuffer().copy(data, 0);
    key().toBuffer().copy(data, 32);
    data.writeBigUInt64LE(amount, 64);
    return { address, account: { address, owner: TOKEN_2022_PROGRAM_ID, data } };
  }

  it("censuses every hop when each names its out-amount, and calls the scope every-hop", () => {
    const inputMint = key();
    const intermediate = key();
    const target = key();
    const mid = accountOf(intermediate, 500_000_000n);
    const end = accountOf(target, 900_000_000n);
    const { hops, censusScope } = censusHops({
      quote: quoteOf([
        { label: "Kipseli", amm: "a", outputMint: intermediate, outAmount: 1_000_000n },
        { label: "Manifest", amm: "b", outputMint: target, outAmount: 2_000_000n },
      ]),
      inputMint,
      targetMint: target,
      candidates: [mid.account, end.account],
      writable: new Set([mid.address.toBase58(), end.address.toBase58()]),
      vaultOwned: new Set(),
    });
    expect(censusScope).toBe("every-hop");
    expect(hops).toHaveLength(2);
    // Each hop is counted against the mint IT pays us, not against the leg's.
    expect(hops[0]!.payMint).toEqual(intermediate);
    expect(hops[0]!.census).toEqual({ counted: true, inventory: 500_000_000n, accounts: 1 });
    expect(hops[1]!.payMint).toEqual(target);
    expect(hops[1]!.takeRaw).toBe(2_000_000n);
  });

  it("degrades to final-only when an intermediate names no out-amount, rather than counting it as taking nothing", () => {
    // A HOP WITH NO out-amount IS NOT A HOP THAT TAKES ZERO. Counting it as
    // zero would read as infinite cover and admit whatever sat behind it, so it
    // is left out and the SCOPE says so — and legDepthDecision then refuses the
    // leg outright if ARM 2 also abstained.
    const target = key();
    const end = accountOf(target, 900_000_000n);
    const { hops, censusScope } = censusHops({
      quote: quoteOf([
        { label: "Kipseli", amm: "a", outputMint: key() },
        { label: "Manifest", amm: "b", outputMint: target, outAmount: 2_000_000n },
      ]),
      inputMint: key(),
      targetMint: target,
      candidates: [end.account],
      writable: new Set([end.address.toBase58()]),
      vaultOwned: new Set(),
    });
    expect(censusScope).toBe("final-only");
    expect(hops).toHaveLength(1);
    expect(hops[0]!.label).toBe("Manifest");
  });

  it("NEVER lets the FINAL hop go uncensused: an unreadable last hop is counted:false, not omitted", () => {
    // If the last hop were merely dropped, a one-hop route with no out-amount
    // would produce a leg with NO hops at all — and a leg with no hops has
    // nothing to refuse on. It has to come back as a failed census instead.
    const target = key();
    const { hops, censusScope } = censusHops({
      quote: quoteOf([{ label: "Manifest", amm: "b", outputMint: target }]),
      inputMint: key(),
      targetMint: target,
      candidates: [],
      writable: new Set(),
      vaultOwned: new Set(),
    });
    expect(censusScope).toBe("final-only");
    expect(hops).toHaveLength(1);
    expect(hops[0]!.census.counted).toBe(false);
    // And the verdict that follows from it, through the real gate.
    const decision = legDepthDecision({
      inMint: key(),
      legs: [{ mint: target, spend: 5_000_000n, venueLabels: ["Manifest"], hops, censusScope, impact: { compared: true, impactBps: 0n, ceilingBps: 25n } }],
    });
    expect(decision.deep).toBe(false);
  });
  it("SUMS A PARALLEL SPLIT'S TAKES, because the census it is judged against is already summed", () => {
    // MEASURED LIVE 2026-09-21, keyless lite-api: USDC -> FIGUREAI at $5,000
    // comes back not as a chain but as a SPLIT — Raydium CLMM 4 %, Hadron 94 %,
    // Manifest 2 %, every step's outputMint the target, each with its own
    // `percent`. /swap-instructions for that quote names all three venues'
    // payout accounts in ONE list, all writable, so censusVenueInventory counts
    // all three whichever step is asking.
    //
    // ASKING ONCE PER SLIVER WAS THEREFORE THE INVERSION. The Raydium pool
    // really held 1,986,791,366 raw against the 1,095,282,199 its 4 % share
    // takes — 1.81x — and the gate read 1,199.77x, because three venues'
    // inventory was being compared with one venue's twenty-fifth of the buy.
    const target = key();
    const slivers = [
      { label: "Raydium CLMM", amm: "r1", take: 1_095_282_199n, holds: 1_986_791_366n },
      { label: "Hadron", amm: "h1", take: 25_693_749_079n, holds: 25_693_749_079n * 50n },
      { label: "Manifest", amm: "m1", take: 548_164_100n, holds: 548_164_100n * 50n },
    ];
    const accounts = slivers.map((sliver) => accountOf(target, sliver.holds));
    const inventory = slivers.reduce((sum, sliver) => sum + sliver.holds, 0n);
    const take = slivers.reduce((sum, sliver) => sum + sliver.take, 0n);
    expect(inventory).toBe(1_314_082_450_316n);
    expect(take).toBe(27_337_195_378n);

    const { hops, censusScope } = censusHops({
      quote: quoteOf(slivers.map((sliver) => ({ label: sliver.label, amm: sliver.amm, outputMint: target, outAmount: sliver.take }))),
      inputMint: key(),
      targetMint: target,
      candidates: accounts.map((a) => a.account),
      writable: new Set(accounts.map((a) => a.address.toBase58())),
      vaultOwned: new Set(),
    });

    // ONE HOP, because the three steps pay the same mint and are judged
    // together — and every venue that pays it is named in the refusal.
    expect(hops).toHaveLength(1);
    expect(hops[0]!.takeRaw).toBe(take);
    expect(hops[0]!.census).toEqual({ counted: true, inventory, accounts: 3 });
    expect(hops[0]!.label).toBe("Raydium CLMM + Hadron + Manifest");
    expect(censusScope).toBe("every-hop");

    // AND THE VERDICT: 48.1x against the 50x bar, so the turn does not spend.
    // Per sliver the SAME route passed at 1,199.77x on the Raydium hop and
    // 2,397x on the Manifest one — the two venues that were given exactly 50x
    // their own share are the only reason it is this close.
    const decision = legDepthDecision({
      inMint: USDC_MINT,
      legs: [{ mint: target, spend: 5_000_000_000n, venueLabels: slivers.map((s) => s.label), hops, censusScope, impact: { compared: false, why: "a split does not probe the same way" } }],
    });
    expect(decision.deep).toBe(false);
    if (decision.deep) return;
    expect(decision.detail).toContain("48.1x cover");
    expect(decision.detail).toContain(`it would need ${take * 50n}`);

    // THE CONTROL: the same three venues, each genuinely 50x its own share,
    // still trades. A gate that refused every split would refuse routinely.
    const deep = slivers.map((sliver) => accountOf(target, sliver.take * 50n));
    const sound = censusHops({
      quote: quoteOf(slivers.map((sliver) => ({ label: sliver.label, amm: sliver.amm, outputMint: target, outAmount: sliver.take }))),
      inputMint: key(),
      targetMint: target,
      candidates: deep.map((a) => a.account),
      writable: new Set(deep.map((a) => a.address.toBase58())),
      vaultOwned: new Set(),
    });
    expect(
      legDepthDecision({
        inMint: USDC_MINT,
        legs: [{ mint: target, spend: 5_000_000_000n, venueLabels: [], hops: sound.hops, censusScope: sound.censusScope, impact: { compared: false, why: "no probe" } }],
      }),
    ).toEqual({ deep: true });
  });

  it("keeps a CHAIN one hop per mint, so the split fix does not merge two different questions", () => {
    // USDC -> X -> target: two mints, two censuses, two covers. The grouping is
    // by the mint a step PAYS, so a chain is untouched by it.
    const intermediate = key();
    const target = key();
    const mid = accountOf(intermediate, 500_000_000n);
    const end = accountOf(target, 900_000_000n);
    const { hops } = censusHops({
      quote: quoteOf([
        { label: "HumidiFi", amm: "a", outputMint: intermediate, outAmount: 1_000_000n },
        { label: "Manifest", amm: "b", outputMint: target, outAmount: 2_000_000n },
      ]),
      inputMint: key(),
      targetMint: target,
      candidates: [mid.account, end.account],
      writable: new Set([mid.address.toBase58(), end.address.toBase58()]),
      vaultOwned: new Set(),
    });
    expect(hops).toHaveLength(2);
    expect(hops.map((hop) => hop.takeRaw)).toEqual([1_000_000n, 2_000_000n]);
    expect(hops.map((hop) => hop.label)).toEqual(["HumidiFi", "Manifest"]);
  });
});

describe("reading the accounts a route names", () => {
  it("pages at a hundred, deduplicates, and LEAVES OUT what the chain did not return", () => {
    // AN ACCOUNT THAT DID NOT COME BACK IS NOT AN EMPTY ONE. Defaulting it to
    // zero bytes would make a route we could not read look like a venue holding
    // nothing — which happens to refuse too, and so would hide the difference
    // between "measured and shallow" and "not measured at all".
    const addresses = Array.from({ length: 250 }, () => key());
    const pages: number[] = [];
    const missing = addresses[7]!.toBase58();
    const connection = {
      getMultipleAccountsInfo: async (page: readonly PublicKey[]) => {
        pages.push(page.length);
        return page.map((address) =>
          address.toBase58() === missing ? null : { owner: TOKEN_PROGRAM_ID, data: Buffer.alloc(165) },
        );
      },
    };
    return readRouteAccounts(connection as never, [...addresses, addresses[0]!]).then((found) => {
      expect(pages).toEqual([100, 100, 50]);
      expect(found).toHaveLength(249);
      expect(found.map((account) => account.address.toBase58())).not.toContain(missing);
    });
  });
});

describe("the slippage warning, turned into a refusal", () => {
  const target = new PublicKey("Pren1FvFX6J3E4kXhJuCiAD5aDmGEb7qJRncwA8Lkhw");

  it("REFUSES a route quoted at 100 bps against ANTHROPIC's live 100 bps fee, measured across the 1038 -> 1039 boundary", () => {
    // ANTHROPIC's transfer fee is 100 bps ACTIVE in epoch 1039 (older {1032,50},
    // newer {1039,100}). At 100 bps of slippage Jupiter reverts the CPI with
    // 0x1771 at 5, 25 and 250 USD — one raw unit short, because Jupiter floors
    // its deduction and Token-2022 ceils its fee — and fills at 200.
    //
    // jupiter-route.ts leaves this a WARNING because it cannot know whether the
    // AMM making the final transfer quotes gross or net. THE KEEPER REFUSES:
    // it would rather miss a sweep than sign a transaction it has measured
    // reverting, and reaching this line at all means the fee the sizing used
    // and the fee the builder read disagree.
    const refusal = slippageRefusal(
      { slippageBps: 100, transferFeeBps: 100, usableToleranceBps: 0 },
      { targetMint: target, askedBps: 200n, feeBps: 100n },
    );
    expect(refusal).not.toBeNull();
    expect(refusal).toContain(target.toBase58());
    expect(refusal).toContain("100 bps of slippage against a 100 bps transfer fee");
    expect(refusal).toContain("leaving 0 bps of usable tolerance");
    // The disagreement itself, which is the thing an operator has to act on.
    expect(refusal).toContain("This keeper asked for 200 bps");
    expect(refusal).toContain("DISAGREE");
    expect(refusal).toContain("0x1771");
  });

  it("says nothing when the builder raised no warning, which is every honest route", () => {
    expect(slippageRefusal(null, { targetMint: target, askedBps: 200n, feeBps: 100n })).toBeNull();
  });
});

describe("the drained venue, replayed through the MEASURING half", () => {
  /**
   * THE CASE THE GATE EXISTS FOR, END TO END THIS TIME.
   * invest-decision.test.ts replays it against legDepthDecision with hops
   * written by hand; what is not covered anywhere else is the composition
   * measureLegVenue actually performs — a quote as lite-api.jup.ag serves one,
   * through censusHops, into the gate. A gate that judges correctly and a
   * censusHops that hands it the wrong hop are the same bought basket.
   *
   * FIGUREAI (PreZad18…, nine decimals) on the Raydium CLMM pool
   * HvpDt29EdGcKkFMLkUgvAJDP5oDFLaYG4jnVZnRsHduM:
   *  * 2026-09-20, drained: 0.110274669 of the stock against 31.91 USDC, any
   *    buy over about 11 dollars reverting, mid 289.36 USDC/token — two days
   *    after check:legs passed the same leg at 6,700 dollars;
   *  * 2026-09-21, refilled: the same vault (CfLC4dghcYotKZoo7ArRYixjbpRDnEuzxG6sZs5FLvzB)
   *    read 1.986791366 off mainnet, and lite-api quoted 250 USDC through that
   *    same pool at 1_368_494_910 raw out. Both numbers measured, an hour apart
   *    from each other, on the machine this test runs on.
   */
  const FIGUREAI = new PublicKey("PreZad18qfPtbxNpMtMuAuX2zVpvkEU8DnJx56faCWd");
  const DRAINED = 110_274_669n;

  /** One account the census can count: a venue's own, writable, not the vault's. */
  function venueAccount(mint: PublicKey, amount: bigint): VenueAccount {
    const data = Buffer.alloc(165);
    mint.toBuffer().copy(data, 0);
    key().toBuffer().copy(data, 32);
    data.writeBigUInt64LE(amount, 64);
    return { address: key(), owner: TOKEN_2022_PROGRAM_ID, data };
  }

  /** The composition measureLegVenue performs once the network has answered. */
  function verdict(input: { readonly take: bigint; readonly inventory: bigint; readonly spend: bigint }): ReturnType<typeof legDepthDecision> {
    const held = venueAccount(FIGUREAI, input.inventory);
    const { hops, censusScope } = censusHops({
      quote: quoteOf([{ label: "Raydium CLMM", amm: "HvpDt29EdG", outputMint: FIGUREAI, outAmount: input.take }], {
        inAmount: input.spend,
        outAmount: input.take,
      }),
      inputMint: USDC_MINT,
      targetMint: FIGUREAI,
      candidates: [held],
      writable: new Set([held.address.toBase58()]),
      vaultOwned: new Set(),
    });
    return legDepthDecision({
      inMint: USDC_MINT,
      legs: [
        {
          mint: FIGUREAI,
          spend: input.spend,
          venueLabels: ["Raydium CLMM"],
          hops,
          censusScope,
          // ARM 2 ABSTAINS, DELIBERATELY: a sixteenth-sized probe of a drained
          // venue is exactly the size Jupiter re-routes, so ARM 1 must carry
          // this alone. A case that let ARM 2 decide would not be this case.
          impact: { compared: false, why: "the probe routed elsewhere" },
        },
      ],
    });
  }

  it("REFUSES the drained venue at the product's DEFAULT 5 dollars — ARM 1, 7.4x cover", () => {
    // $5 is UNDER the ~11 dollar revert threshold measured that night, so this
    // venue would have FILLED and taken the money. 0.014936 taken against
    // 0.110274669 held.
    const decision = verdict({ take: 14_936_000n, inventory: DRAINED, spend: 5_000_000n });
    expect(decision.deep).toBe(false);
    if (decision.deep) return;
    expect(decision.detail).toContain("7.4x cover");
    expect(decision.detail).toContain("Raydium CLMM");
    expect(decision.detail).toContain(`holds ${DRAINED} raw`);
  });

  it("REFUSES it at the live policy's CAP even if the venue hands over EVERY unit it holds", () => {
    // AT THE CAP THE QUOTE CANNOT BE TAKEN AT MID. A 1,000-dollar buy at the
    // measured mid implies 3.45 tokens out of a venue holding 0.110274669, and
    // no venue pays what it does not have — so the honest worst case for the
    // GATE (the best for the venue) is a take of everything in it. 1.0x cover,
    // fifty times under the bar, and the refusal still names both numbers.
    const decision = verdict({ take: DRAINED, inventory: DRAINED, spend: 1_000_000_000n });
    expect(decision.deep).toBe(false);
    if (decision.deep) return;
    expect(decision.detail).toContain("1.0x cover");
    expect(decision.detail).toContain(`it would need ${DRAINED * 50n}`);
  });

  it("REFUSES the SAME pool a day later at a real 250-dollar quote, refilled — 1.5x cover", () => {
    // THE TWO ENDS, BOTH MEASURED: the vault's own balance off mainnet and
    // Jupiter's own out-amount for 250 USDC through that pool, same hour. A
    // refilled venue is not a deep one, and nothing in a registry says which
    // it is today.
    const decision = verdict({ take: 1_368_494_910n, inventory: 1_986_791_366n, spend: 250_000_000n });
    expect(decision.deep).toBe(false);
    if (decision.deep) return;
    expect(decision.detail).toContain("1.5x cover");
  });

  it("trades against that pool at the DEFAULT size once it is deep enough, which is what keeps the gate honest", () => {
    // A gate that refused this too would be a gate that refuses everything.
    // The same pool, the same real 5-dollar quote (27_434_493 raw out,
    // lite-api 2026-09-21), against inventory of 50x that take exactly.
    expect(verdict({ take: 27_434_493n, inventory: 27_434_493n * 50n, spend: 5_000_000n })).toEqual({ deep: true });
    expect(verdict({ take: 27_434_493n, inventory: 27_434_493n * 50n - 1n, spend: 5_000_000n }).deep).toBe(false);
  });
});
