// WHAT /prices DOES WHEN A SOURCE WILL NOT ANSWER, AND WHAT IT REFUSES TO SAY.
//
// The page's whole promise is that a figure carries its provenance and that a
// dead source costs the reader that figure and nothing else. Both are behaviour,
// not intention, so they are tested here: an RPC that throws and a third party
// that times out must still produce a page with the eight PreStocks and their
// reasons on it, and the identity checks on the feeds, the mints and the
// issuer's API must refuse rather than price whatever answered.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PricesView } from "@/components/prices-view";
import {
  HERMES_EQUITY_CREDENTIAL_VARIABLE,
  chainClockFrom,
  feeInForce,
  feedFrom,
  hermesEquitySeam,
  loadPrices,
  mintFrom,
  preStocksMarkFrom,
} from "@/lib/prices-data";
import { formatUsd } from "@/lib/prices-units";

const ANTHROPIC = "Pren1FvFX6J3E4kXhJuCiAD5aDmGEb7qJRncwA8Lkhw";
const RECEIVER = "rec2HHDDnjLfj4kE7VyEtFA1HPGQLK33259532cRyHp";
const SOL_FEED = "7AviUf9nL62mcxNbQGKm4nKDQnPjswo6c5MX4D57HmyE";
const SOL_FEED_ID = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";

/** A pool that refuses every call, which is what a dead endpoint list looks like from inside the page. */
const deadPool = {
  size: 1,
  call: async () => {
    throw new Error("every Solana endpoint refused");
  },
  batch: async () => [],
  relay: async () => ({ status: 503, text: "" }),
  scrub: (text: string) => text,
  coolingDown: () => [],
};

const deadFetch: typeof fetch = async () => {
  throw new Error("socket hang up");
};

describe("the page degrades and never breaks", () => {
  it("renders every block as unread, with its reason, when the chain and the issuer both fail", async () => {
    const model = await loadPrices({ pool: deadPool as never, fetch: deadFetch, env: {} });
    expect(model.sol.pool.ok).toBe(false);
    expect(model.sol.oracle.ok).toBe(false);
    expect(model.anthropic.api.ok).toBe(false);
    if (model.anthropic.api.ok) throw new Error("unreachable");
    expect(model.anthropic.api.why).toContain("prestocks.com could not be read");
    // THE CATALOGUE IS NOT A NETWORK READ, so the shelf survives a total outage.
    expect(model.shelf).toHaveLength(9);
    expect(model.shelf.filter((row) => row.group === "prestock")).toHaveLength(8);

    const html = renderToStaticMarkup(createElement(PricesView, { model }));
    expect(html).toContain("could not be read");
    for (const symbol of ["ANTHROPIC", "FIGUREAI", "OPENAI", "NEURALINK", "SPACEX", "POLYMARKET", "KALSHI", "ANDURIL"]) {
      expect(html).toContain(symbol);
    }
    // And it still explains the keeper's guard, whose numbers are not a network read either.
    expect(html).toContain("60 s");
    expect(html).toContain("500 bps");
  });

  it("says the settings are incomplete rather than pretending the chain was read", async () => {
    const model = await loadPrices({ fetch: deadFetch, env: {} });
    expect(model.chain.ok).toBe(false);
    if (model.chain.ok) throw new Error("unreachable");
    expect(model.chain.why).toContain("SIP_SOLANA_RPC_URLS");
  });
});

describe("what it refuses to price", () => {
  it("refuses a Pyth account that the receiver does not own, however right the address is", () => {
    const reading = feedFrom("SOL/USD", SOL_FEED, SOL_FEED_ID, { owner: "SomeoneElse1111111111111111111111111111111", lamports: 1n, data: new Uint8Array(134) }, 0n);
    expect(reading.ok).toBe(false);
    if (reading.ok) throw new Error("unreachable");
    expect(reading.why).toContain("not the Pyth receiver");
  });

  it("refuses a mint that Token-2022 does not own", () => {
    const reading = mintFrom(ANTHROPIC, { owner: RECEIVER, lamports: 1n, data: new Uint8Array(200) }, 0n);
    expect(reading.ok).toBe(false);
  });

  it("refuses a clock nobody vouches for, because an age is only as good as its clock", () => {
    expect(chainClockFrom({ owner: "NotTheSysvarProgram11111111111111111111111", lamports: 1n, data: new Uint8Array(40) }).ok).toBe(false);
    expect(chainClockFrom(null).ok).toBe(false);
  });

  it("refuses the issuer's entry when the API names a mint this repository did not pin — a symbol is not an identity", () => {
    const body = [{ symbol: "ANTHROPIC", contract_address: "Impostor11111111111111111111111111111111111", markPrice: 1, tokenPrice: 1, supply: 1 }];
    const reading = preStocksMarkFrom(body, "ANTHROPIC", ANTHROPIC);
    expect(reading.ok).toBe(false);
    if (reading.ok) throw new Error("unreachable");
    expect(reading.why).toContain("only prices the mint pinned");
  });

  it("reads the issuer's entry when the mint matches, to the cent", () => {
    const body = [{ symbol: "ANTHROPIC", contract_address: ANTHROPIC, markPrice: 1057.38355029, tokenPrice: 1076.3831487638447, supply: 7381.776355255 }];
    const reading = preStocksMarkFrom(body, "ANTHROPIC", ANTHROPIC);
    expect(reading.ok).toBe(true);
    if (!reading.ok) throw new Error("unreachable");
    expect(formatUsd(reading.value.markMicroUsd)).toBe("$1,057.38");
    expect(formatUsd(reading.value.tokenMicroUsd)).toBe("$1,076.38");
    expect(reading.value.supplyNano).toBe(7_381_776_355_255n);
  });

  it("refuses a list with no such symbol, and an answer that is not a list", () => {
    expect(preStocksMarkFrom([], "ANTHROPIC", ANTHROPIC).ok).toBe(false);
    expect(preStocksMarkFrom({ symbol: "ANTHROPIC" }, "ANTHROPIC", ANTHROPIC).ok).toBe(false);
  });
});

describe("the transfer fee in force, against the chain's own epoch", () => {
  const schedule = { older: { epoch: 1_039n, maximumFee: 0n, bps: 100 }, newer: { epoch: 1_043n, maximumFee: 0n, bps: 300 } };

  it("charges the older rate before the newer epoch arrives, and says what is written for later", () => {
    const fee = feeInForce(schedule, 1_042n);
    expect(fee).not.toBeNull();
    expect(fee!.bps).toBe(100);
    expect(fee!.sinceEpoch).toBe(1_039n);
    expect(fee!.scheduled).toEqual({ bps: 300, fromEpoch: 1_043n });
    // A floor signed today must net the HIGHER of the two: solana-core's rule, not this page's.
    expect(fee!.netBps).toBe(300);
  });

  it("charges the newer rate from its epoch on, with nothing left scheduled", () => {
    const fee = feeInForce(schedule, 1_043n);
    expect(fee!.bps).toBe(300);
    expect(fee!.sinceEpoch).toBe(1_043n);
    expect(fee!.scheduled).toBeNull();
    expect(fee!.netBps).toBe(300);
  });

  it("is null for a mint that carries no fee extension", () => {
    expect(feeInForce(null, 1_042n)).toBeNull();
  });
});

describe("the Hermes equity seam", () => {
  it("is absent when the variable is not set, and the page is correct without it", () => {
    const seam = hermesEquitySeam({});
    expect(seam.kind).toBe("absent");
    expect(seam.variable).toBe(HERMES_EQUITY_CREDENTIAL_VARIABLE);
  });

  it("reports a credential as present without ever carrying its value", () => {
    const seam = hermesEquitySeam({ [HERMES_EQUITY_CREDENTIAL_VARIABLE]: "something" });
    expect(seam.kind).toBe("configured-not-wired");
    expect(JSON.stringify(seam)).not.toContain("something");
  });
});
