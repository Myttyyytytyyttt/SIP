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
  fetchHermesLatest,
  hermesFeedFrom,
  hermesSeamFrom,
  loadPrices,
  mintFrom,
  preStocksMarkFrom,
  type FeedRead,
} from "@/lib/prices-data";
import { failed, formatUsd, reads, type Reading } from "@/lib/prices-units";

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

// ── the second path: Pyth Hermes ─────────────────────────────────────────────
//
// THE CREDENTIAL IS A DUMMY AND THE SERVICE IS A STUB. Nothing in this file makes
// a real request, and the value below exists so that one test can prove the model
// never carries it.

/** A recognisable value, so "the credential is absent from the model" is a search and not a hope. */
const DUMMY_CREDENTIAL = "hermes-dummy-credential-3f9a7c";
const CREDENTIAL_ENV = { [HERMES_EQUITY_CREDENTIAL_VARIABLE]: DUMMY_CREDENTIAL };

const SOL_HERMES_ID = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
const USDC_HERMES_ID = "eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a";

/** One parsed[] entry in Hermes's own shape: integers as strings, `0x` on the id, publish_time a number. */
const hermesEntry = (id: string, price: string, conf: string, publishTime: number) => ({
  id: `0x${id}`,
  price: { price, conf, expo: -8, publish_time: publishTime },
  metadata: { slot: 1, proof_available_time: publishTime, prev_publish_time: publishTime - 1 },
});

const hermesBody = (entries: readonly unknown[]) => ({ binary: { encoding: "hex", data: ["00"] }, parsed: entries });

/** A stub that records what it was called with, so the header and the URL can be asserted rather than assumed. */
function recordingFetch(answer: (url: string) => Response): { impl: typeof fetch; calls: { url: string; init: RequestInit | undefined }[] } {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const impl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    // The issuer's API is not this block's subject; it gets a flat refusal.
    if (!url.startsWith("https://hermes.pyth.network/")) throw new Error("prestocks.com is not stubbed in this test");
    return answer(url);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const jsonResponse = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

/** A push account's reading, as the on-chain half of a drift: $200.00 at publish_time 1 000 000. */
const onChainSol = (microUsd: bigint, publishTime: bigint): Reading<FeedRead> =>
  reads({
    address: SOL_FEED,
    label: "SOL/USD",
    feedIdHex: SOL_HERMES_ID,
    microUsd,
    confMicroUsd: 1_000n,
    ageSeconds: 5n,
    publishTime,
    price: microUsd * 100n,
    expo: -8,
    update: {} as never,
  });

describe("Hermes: the second path, and the drift between the two", () => {
  it("makes no request at all when there is no credential, and the model says so in a state of its own", async () => {
    const { impl, calls } = recordingFetch(() => jsonResponse(hermesBody([])));
    const seam = hermesSeamFrom(await fetchHermesLatest(impl, {}), {});
    expect(calls).toHaveLength(0);
    expect(seam.kind).toBe("absent");
    expect(seam.variable).toBe(HERMES_EQUITY_CREDENTIAL_VARIABLE);
  });

  it("sends the credential in an Authorization header, never in the URL, and asks only for the two entitled feeds", async () => {
    const { impl, calls } = recordingFetch(() => jsonResponse(hermesBody([hermesEntry(SOL_HERMES_ID, "20000000000", "5000000", 1_000_000)])));
    await fetchHermesLatest(impl, CREDENTIAL_ENV);
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect((init?.headers as Record<string, string>).authorization).toBe(`Bearer ${DUMMY_CREDENTIAL}`);
    // A query parameter does NOT authenticate against this service — it answers 401 — so the value must not be anywhere in the URL.
    expect(url).not.toContain(DUMMY_CREDENTIAL);
    expect(url).toContain(`ids[]=${SOL_HERMES_ID}`);
    expect(url).toContain(`ids[]=${USDC_HERMES_ID}`);
    // The feeds this credential is NOT entitled to are never requested: a request known to fail is waste on every page load.
    for (const notEntitled of ["2817b78438c769357182c04346fddaad1178c82f4048828fe0997c3c64624e14", "SPYX", "NVDAX", "Equity"]) {
      expect(url).not.toContain(notEntitled);
    }
    // And the page must not be able to wait on it: the request carries a hard stop.
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("reads both feeds and takes the drift in bps of the ACCOUNT, signed, in both directions", async () => {
    const { impl } = recordingFetch(() =>
      jsonResponse(
        hermesBody([
          // $200.50 against an account at $200.00: +25 bps.
          hermesEntry(SOL_HERMES_ID, "20050000000", "3000000", 1_000_060),
          // $0.9998 against an account at $1.0000: -2 bps.
          hermesEntry(USDC_HERMES_ID, "99980000", "10000", 1_000_010),
        ]),
      ),
    );
    const seam = hermesSeamFrom(await fetchHermesLatest(impl, CREDENTIAL_ENV), {
      "SOL/USD": onChainSol(200_000_000n, 1_000_000n),
      "USDC/USD": onChainSol(1_000_000n, 1_000_030n),
    });
    expect(seam.kind).toBe("read");
    if (seam.kind !== "read") throw new Error("unreachable");
    const [sol, usdc] = seam.feeds;

    expect(sol!.hermes.ok).toBe(true);
    if (!sol!.hermes.ok || !sol!.drift.ok) throw new Error("unreachable");
    expect(formatUsd(sol!.hermes.value.microUsd)).toBe("$200.50");
    expect(sol!.drift.value.bps).toBe(25n);
    // Hermes published 60 s after the bytes on chain were written: the account trails by that much.
    expect(sol!.drift.value.publishGapSeconds).toBe(60n);
    expect(sol!.drift.value.onChainMicroUsd).toBe(200_000_000n);

    if (!usdc!.drift.ok) throw new Error("unreachable");
    // The sign is the content: Hermes is the LOWER of the two here, and the gap the other way round in time.
    expect(usdc!.drift.value.bps).toBe(-2n);
    expect(usdc!.drift.value.publishGapSeconds).toBe(-20n);
  });

  it("degrades with the service's own reason on a 403, and costs the page nothing else", async () => {
    const notEntitled = "Not entitled: feed Crypto.SPYX/USD";
    const { impl } = recordingFetch(() => new Response(notEntitled, { status: 403 }));
    const seam = hermesSeamFrom(await fetchHermesLatest(impl, CREDENTIAL_ENV), {});
    expect(seam.kind).toBe("unread");
    if (seam.kind !== "unread") throw new Error("unreachable");
    expect(seam.why).toContain("HTTP 403");
    expect(seam.why).toContain("Not entitled: feed");
  });

  it("degrades when the request times out, and when the body is not JSON", async () => {
    const timedOut = (async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    }) as unknown as typeof fetch;
    const seam = hermesSeamFrom(await fetchHermesLatest(timedOut, CREDENTIAL_ENV), {});
    expect(seam.kind).toBe("unread");
    if (seam.kind !== "unread") throw new Error("unreachable");
    expect(seam.why).toContain("2500 ms");
    expect(seam.why).toContain("aborted due to timeout");

    const { impl } = recordingFetch(() => new Response("<html>a proxy said no</html>", { status: 200, headers: { "content-type": "text/html" } }));
    const garbled = hermesSeamFrom(await fetchHermesLatest(impl, CREDENTIAL_ENV), {});
    expect(garbled.kind).toBe("unread");
  });

  it("refuses a feed id it did not ask for, exactly as the push account is refused", () => {
    const impostor = hermesBody([hermesEntry("dead".repeat(16), "20000000000", "1000", 1_000_000)]);
    const reading = hermesFeedFrom(impostor, SOL_HERMES_ID, "Crypto.SOL/USD");
    expect(reading.ok).toBe(false);
    if (reading.ok) throw new Error("unreachable");
    expect(reading.why).toContain("not requested is not this feed");
    // And an answer with no parsed[] at all is refused rather than read as empty.
    expect(hermesFeedFrom({ binary: {} }, SOL_HERMES_ID, "Crypto.SOL/USD").ok).toBe(false);
  });

  it("keeps the price when there is no on-chain reading to drift against, and says that is why there is no drift", async () => {
    const { impl } = recordingFetch(() => jsonResponse(hermesBody([hermesEntry(SOL_HERMES_ID, "20000000000", "1000", 1_000_000)])));
    const seam = hermesSeamFrom(await fetchHermesLatest(impl, CREDENTIAL_ENV), {});
    if (seam.kind !== "read") throw new Error("unreachable");
    const sol = seam.feeds[0]!;
    expect(sol.hermes.ok).toBe(true);
    expect(sol.drift.ok).toBe(false);
    if (sol.drift.ok) throw new Error("unreachable");
    expect(sol.drift.why).toContain("nothing for Hermes to be drifted against");
    // The USDC row failed on its own and did not take the SOL row with it.
    expect(seam.feeds[1]!.hermes.ok).toBe(false);
  });

  it("never lets the credential reach the model — not as a figure, not inside a reason, not in a thrown message", async () => {
    // The worst case: a service that echoes the token back inside an error body.
    const echoing = recordingFetch(() => new Response(`upstream rejected token ${DUMMY_CREDENTIAL}`, { status: 500 }));
    const echoed = hermesSeamFrom(await fetchHermesLatest(echoing.impl, CREDENTIAL_ENV), {});
    expect(JSON.stringify(echoed)).not.toContain(DUMMY_CREDENTIAL);
    if (echoed.kind !== "unread") throw new Error("unreachable");
    expect(echoed.why).toContain("credential redacted");

    // And the whole model, in the state a deployment with a credential renders in.
    const { impl } = recordingFetch(() => jsonResponse(hermesBody([hermesEntry(SOL_HERMES_ID, "20000000000", "1000", 1_000_000)])));
    const model = await loadPrices({ pool: deadPool as never, fetch: impl, env: CREDENTIAL_ENV });
    const serialized = JSON.stringify(model, (_key, value) => (typeof value === "bigint" ? value.toString() : value));
    expect(serialized).not.toContain(DUMMY_CREDENTIAL);
    // It names the variable, which is the whole point of naming it, and nothing else about it.
    expect(serialized).toContain(HERMES_EQUITY_CREDENTIAL_VARIABLE);
  });

  it("renders both paths beside each other, and renders with Hermes dead", async () => {
    const { impl } = recordingFetch(() =>
      jsonResponse(hermesBody([hermesEntry(SOL_HERMES_ID, "20050000000", "3000000", 1_000_060), hermesEntry(USDC_HERMES_ID, "99980000", "10000", 1_000_010)])),
    );
    const live = hermesSeamFrom(await fetchHermesLatest(impl, CREDENTIAL_ENV), { "SOL/USD": onChainSol(200_000_000n, 1_000_000n) });
    const model = await loadPrices({ pool: deadPool as never, fetch: deadFetch, env: {} });

    const withHermes = renderToStaticMarkup(createElement(PricesView, { model: { ...model, hermes: live } }));
    expect(withHermes).toContain("+25 bps");
    expect(withHermes).toContain("$200.50");
    // The push account's own price is printed beside the drift, never replaced by it.
    expect(withHermes).toContain("$200.00");
    expect(withHermes).toContain("behind Hermes");
    expect(withHermes).not.toContain(DUMMY_CREDENTIAL);

    // Hermes dead: the page still renders, the shelf survives, and the keeper's bars are still explained.
    const dead = hermesSeamFrom(failed("Pyth's Hermes answered HTTP 503: upstream unavailable"), {});
    const withoutHermes = renderToStaticMarkup(createElement(PricesView, { model: { ...model, hermes: dead } }));
    expect(withoutHermes).toContain("HTTP 503");
    expect(withoutHermes).toContain("ANTHROPIC");
    expect(withoutHermes).toContain("500 bps");
  });

  it("states the entitlement as a dated, measured fact, and the page prints it", async () => {
    const model = await loadPrices({ pool: deadPool as never, fetch: deadFetch, env: {} });
    expect(model.hermes.kind).toBe("absent");
    expect(model.hermes.entitlement).toContain("2026-09-25");
    expect(model.hermes.entitlement).toContain("Not entitled: feed");
    const html = renderToStaticMarkup(createElement(PricesView, { model }));
    expect(html).toContain("2026-09-25");
    expect(html).toContain(HERMES_EQUITY_CREDENTIAL_VARIABLE);
  });
});
