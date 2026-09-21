// measureLegVenue ITSELF — the composition, not its pieces.
//
// WHY THIS FILE EXISTS. venue-depth.test.ts tests the pure pieces and
// invest-decision.test.ts tests the verdict, and between them sat two claims
// nothing ran: that the slippage warning becomes a REFUSAL, and that the probe's
// rate floors what a leg is judged to take. Both were reachable only through
// the network half, so both were argued in prose and exercised by nothing.
//
// Deleting `if (tooTight !== null) throw ...` from src/venue-depth.ts left the
// whole keeper suite green — 819 passed, zero failures — while the keeper went
// on signing a swap at a margin measured to revert with Jupiter's 0x1771. A
// guard with no red case is not a guard (docs/TESTING_TRAPS.md); these are the
// red cases.
//
// THE NETWORK IS THE ONLY THING STUBBED. buildJupiterRoute and
// fetchJupiterQuote answer with shapes measured off lite-api.jup.ag, and
// everything downstream — routeWarning, routeMints, censusHops,
// censusVenueInventory, legDepthDecision — is the real code the money path
// runs. Stubbing the verdicts would be the stand-in trap in a new costume.

import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey } from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const buildJupiterRoute = vi.fn();
const fetchJupiterQuote = vi.fn();
const findVaultOwnedTokenAccounts = vi.fn(async () => new Set<string>());

vi.mock("../src/program-scripts.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, buildJupiterRoute, fetchJupiterQuote, findVaultOwnedTokenAccounts };
});

const { VenueMeasurementRefusal, measureLegVenue } = await import("../src/venue-depth.js");
const { legDepthDecision, probeAmount, USDC_MINT } = await import("../src/invest-decision.js");
const { remeasureForSend } = await import("../src/invest-tick.js");

const key = (): PublicKey => Keypair.generate().publicKey;

/** A writable token account holding `amount` of `mint`, as the chain returns one. */
function holding(mint: PublicKey, amount: bigint): { readonly address: PublicKey; readonly info: { owner: PublicKey; data: Buffer } } {
  const data = Buffer.alloc(165);
  mint.toBuffer().copy(data, 0);
  key().toBuffer().copy(data, 32);
  data.writeBigUInt64LE(amount, 64);
  return { address: key(), info: { owner: TOKEN_2022_PROGRAM_ID, data } };
}

const TARGET = key();

/** A one-hop route, with the fields measureLegVenue actually reads. */
function routeOf(input: {
  readonly amountIn: bigint;
  readonly outAmount: bigint;
  readonly amm: string;
  readonly accounts: readonly PublicKey[];
  readonly warnings?: readonly unknown[];
}) {
  return {
    quote: {
      inputMint: USDC_MINT.toBase58(),
      outputMint: TARGET.toBase58(),
      inAmount: input.amountIn.toString(),
      outAmount: input.outAmount.toString(),
      otherAmountThreshold: "0",
      swapMode: "ExactIn",
      slippageBps: 200,
      routePlan: [{ swapInfo: { label: "Kipseli", ammKey: input.amm, outputMint: TARGET.toBase58(), outAmount: input.outAmount.toString() } }],
    },
    warnings: input.warnings ?? [],
    remainingAccounts: input.accounts.map((pubkey) => ({ pubkey, isSigner: false, isWritable: true })),
  };
}

describe("the slippage warning IS a refusal on the money path, not a note", () => {
  beforeEach(() => {
    buildJupiterRoute.mockReset();
    fetchJupiterQuote.mockReset();
  });

  it("refuses the leg when the builder's own fee read disagrees with the fee the sizing used", async () => {
    // MEASURED ACROSS THE 1038 -> 1039 BOUNDARY: 100 bps of slippage against a
    // 100 bps fee reverts with Jupiter's 0x1771 at 5, 25 and 250 USD. This
    // keeper asks for legSlippageBps(100) = 200, so a warning coming back at
    // all means the builder read a DIFFERENT fee than the sizing did — and
    // neither read is then a basis for spending.
    const account = holding(TARGET, 10_000_000_000_000n);
    buildJupiterRoute.mockResolvedValue(
      routeOf({
        amountIn: 250_000_000n,
        outAmount: 1_000_000_000n,
        amm: "K1",
        accounts: [account.address],
        warnings: [{ condition: "slippage-not-above-transfer-fee", slippageBps: 100, transferFeeBps: 100, usableToleranceBps: 0, message: "measured to revert" }],
      }),
    );
    const connection = { getMultipleAccountsInfo: async () => [account.info] };

    await expect(
      measureLegVenue(connection as never, {
        vault: key(),
        vaultIn: key(),
        vaultTarget: key(),
        inputMint: USDC_MINT,
        targetMint: TARGET,
        spend: 250_000_000n,
        feeBps: 100n,
        maxAge: { maxAgeMs: 30_000 },
      }),
    ).rejects.toThrow(VenueMeasurementRefusal);

    // AND IT REFUSES BEFORE IT QUOTES THE PROBE: a leg this keeper will not
    // trade costs the keyless endpoint nothing further.
    expect(fetchJupiterQuote).not.toHaveBeenCalled();
  });

  it("does not refuse a route that carries no such warning", async () => {
    const account = holding(TARGET, 10_000_000_000_000n);
    buildJupiterRoute.mockResolvedValue(routeOf({ amountIn: 250_000_000n, outAmount: 1_000_000_000n, amm: "K1", accounts: [account.address] }));
    fetchJupiterQuote.mockRejectedValue(new Error("no probe for this case"));
    const connection = { getMultipleAccountsInfo: async () => [account.info] };
    const { venue } = await measureLegVenue(connection as never, {
      vault: key(),
      vaultIn: key(),
      vaultTarget: key(),
      inputMint: USDC_MINT,
      targetMint: TARGET,
      spend: 250_000_000n,
      feeBps: 100n,
      maxAge: { maxAgeMs: 30_000 },
    });
    expect(venue.hops).toHaveLength(1);
    expect(venue.hops[0]!.takeRaw).toBe(1_000_000_000n);
  });
});

describe("a venue cannot read as deeper by quoting this turn worse", () => {
  beforeEach(() => {
    buildJupiterRoute.mockReset();
    fetchJupiterQuote.mockReset();
  });

  it("judges the leg at the rate the probe implies when the route quotes below it — ARM 2 abstaining or not", async () => {
    // THE INVERSION THIS CLOSES. The cover's denominator is the venue's own
    // quoted out-amount, so a venue quoting 90 % below the market measures as
    // ten times DEEPER. Here: $250 into a venue holding 1,500,000,000,000 raw.
    const spend = 250_000_000n;
    const held = 1_500_000_000_000n;
    const atMid = 250_000_000_000n;
    const quotedLow = 25_000_000_000n;
    expect(Number(held) / Number(quotedLow)).toBeCloseTo(60, 6); // would pass the 50x bar
    expect(Number(held) / Number(atMid)).toBeCloseTo(6, 6); // and must not

    const account = holding(TARGET, held);
    buildJupiterRoute.mockResolvedValue(routeOf({ amountIn: spend, outAmount: quotedLow, amm: "K1", accounts: [account.address] }));
    // THE PROBE ROUTES ELSEWHERE, which is the routine case ARM 2 abstains on
    // (measured 2026-09-21: a 25 USD turn on Kipseli+Manifest, its 1 USD probe
    // on Byreal+Manifest). Its RATE is still the honest second opinion.
    const probeIn = probeAmount(spend);
    fetchJupiterQuote.mockResolvedValue({
      inputMint: USDC_MINT.toBase58(),
      outputMint: TARGET.toBase58(),
      inAmount: probeIn.toString(),
      outAmount: ((probeIn * atMid) / spend).toString(),
      otherAmountThreshold: "0",
      swapMode: "ExactIn",
      slippageBps: 200,
      routePlan: [{ swapInfo: { label: "Byreal", ammKey: "B1", outputMint: TARGET.toBase58(), outAmount: "1" } }],
    });
    const connection = { getMultipleAccountsInfo: async () => [account.info] };

    const { venue } = await measureLegVenue(connection as never, {
      vault: key(),
      vaultIn: key(),
      vaultTarget: key(),
      inputMint: USDC_MINT,
      targetMint: TARGET,
      spend,
      feeBps: 0n,
      maxAge: { maxAgeMs: 30_000 },
    });

    expect(venue.impact.compared, "the probe re-routed, so ARM 2 abstains — and the floor still applies").toBe(false);
    expect(venue.hops[0]!.takeRaw).toBe(atMid);
    expect(venue.hops[0]!.quotedTakeRaw, "what the venue said, kept so the refusal can name both").toBe(quotedLow);

    const decision = legDepthDecision({ inMint: USDC_MINT, legs: [venue] });
    expect(decision.deep, "60x on the venue's own quote, 6.0x at the rate a probe says the turn should get").toBe(false);
    if (decision.deep) return;
    expect(decision.detail).toContain("6.0x cover");
    expect(decision.detail).toContain(`the route quoted ${quotedLow}`);
  });

  it("leaves a route that quotes BETTER than the probe alone, so impact never reads as credit", async () => {
    // A fixed per-hop fee is a larger share of a small size, so a probe can
    // legitimately come back worse than the turn. Taking the larger of the two
    // must not then invent a refusal out of that.
    const spend = 250_000_000n;
    const quoted = 250_000_000_000n;
    const account = holding(TARGET, quoted * 50n);
    buildJupiterRoute.mockResolvedValue(routeOf({ amountIn: spend, outAmount: quoted, amm: "K1", accounts: [account.address] }));
    const probeIn = probeAmount(spend);
    fetchJupiterQuote.mockResolvedValue({
      inputMint: USDC_MINT.toBase58(),
      outputMint: TARGET.toBase58(),
      inAmount: probeIn.toString(),
      outAmount: (((probeIn * quoted) / spend) - 1_000_000n).toString(),
      otherAmountThreshold: "0",
      swapMode: "ExactIn",
      slippageBps: 200,
      routePlan: [{ swapInfo: { label: "Kipseli", ammKey: "K1", outputMint: TARGET.toBase58(), outAmount: "1" } }],
    });
    const connection = { getMultipleAccountsInfo: async () => [account.info] };
    const { venue } = await measureLegVenue(connection as never, {
      vault: key(),
      vaultIn: key(),
      vaultTarget: key(),
      inputMint: USDC_MINT,
      targetMint: TARGET,
      spend,
      feeBps: 0n,
      maxAge: { maxAgeMs: 30_000 },
    });
    expect(venue.hops[0]!.takeRaw).toBe(quoted);
    expect(venue.hops[0]!.quotedTakeRaw).toBeUndefined();
    expect(legDepthDecision({ inMint: USDC_MINT, legs: [venue] })).toEqual({ deep: true });
  });
});

describe("the SECOND measurement, the one the money is actually spent on", () => {
  beforeEach(() => {
    buildJupiterRoute.mockReset();
    fetchJupiterQuote.mockReset();
  });

  const measure = (spend: bigint) => ({
    vault: key(),
    vaultIn: key(),
    vaultTarget: key(),
    inputMint: USDC_MINT,
    targetMint: TARGET,
    spend,
    feeBps: 0n,
    maxAge: { maxAgeMs: 30_000 },
  });

  it("JUDGES the rebuilt route and refuses it, instead of computing a census and dropping it", () => {
    // THE CONVERT DID EXACTLY THAT. It called measureLegVenue, destructured the
    // result into `measured`, and read only `measured.route`; `measured.venue`
    // — a full depth census of the venue the rebuilt wSOL -> USDC swap would
    // trade against — was never read. Jupiter re-picks per quote, so the route
    // the gate measured and the route the convert sends are routinely
    // different objects: the rebuild is the ONLY measurement of what is signed.
    const spend = 250_000_000n;
    const quoted = 250_000_000_000n;
    const account = holding(TARGET, quoted * 49n); // one multiple under the bar
    buildJupiterRoute.mockResolvedValue(routeOf({ amountIn: spend, outAmount: quoted, amm: "K1", accounts: [account.address] }));
    fetchJupiterQuote.mockRejectedValue(new Error("no probe for this case"));
    const connection = { getMultipleAccountsInfo: async () => [account.info] };
    return expect(remeasureForSend(connection as never, USDC_MINT, measure(spend))).rejects.toThrow(/49\.0x cover/);
  });

  it("hands back the route itself when the rebuild is deep, so there is no verdict left over to forget", async () => {
    const spend = 250_000_000n;
    const quoted = 250_000_000_000n;
    const account = holding(TARGET, quoted * 50n);
    const built = routeOf({ amountIn: spend, outAmount: quoted, amm: "K1", accounts: [account.address] });
    buildJupiterRoute.mockResolvedValue(built);
    fetchJupiterQuote.mockRejectedValue(new Error("no probe for this case"));
    const connection = { getMultipleAccountsInfo: async () => [account.info] };
    expect(await remeasureForSend(connection as never, USDC_MINT, measure(spend))).toBe(built);
  });

  it("carries the slippage refusal through as the same kind of answer", async () => {
    // Both refusals reach a caller as VenueMeasurementRefusal, which is what
    // lets the convert rest and the leg loop return REFUSED rather than
    // reporting either as a FAILED turn naming an exception.
    const account = holding(TARGET, 10_000_000_000_000n);
    buildJupiterRoute.mockResolvedValue(
      routeOf({
        amountIn: 250_000_000n,
        outAmount: 1_000_000_000n,
        amm: "K1",
        accounts: [account.address],
        warnings: [{ condition: "slippage-not-above-transfer-fee", slippageBps: 100, transferFeeBps: 100, usableToleranceBps: 0, message: "measured to revert" }],
      }),
    );
    const connection = { getMultipleAccountsInfo: async () => [account.info] };
    await expect(remeasureForSend(connection as never, USDC_MINT, { ...measure(250_000_000n), feeBps: 100n })).rejects.toThrow(VenueMeasurementRefusal);
  });
});
