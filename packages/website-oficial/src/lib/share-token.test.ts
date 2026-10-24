// THE SHARE CARD'S SIGNED LINK (owner, 10-22: "Enlace con vista previa"): a
// token holds what the card prints and nothing else, verifies only under a key
// in force, and anything else — a byte changed, another version, another key,
// a field the signer never writes — is no card at all.

import { createHmac } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import { toDashboardMock } from "@/lib/live-mock";
import { SHARE_BACKGROUNDS, exampleShareCardOf, shareCardOf, unitsOf, type ShareCardData } from "@/lib/live-share";
import {
  SHARE_SECRET_ENV,
  SHARE_SECRET_PREVIOUS_ENV,
  cardOfPayload,
  openShareToken,
  payloadOf,
  readPayload,
  shareKeysOf,
  signShareLinks,
  signShareToken,
  verifyShareToken,
} from "@/lib/share-token";

import { OWNER, VAULT, WALLET_A, liveDashboard } from "../../test/fixtures/live-dashboard";

const SECRET = "a".repeat(64);
const OTHER = "b".repeat(64);
const KEY = Buffer.from(SECRET);
const ENV = { [SHARE_SECRET_ENV]: SECRET };

const page = toDashboardMock(liveDashboard(), { complete: false });
const card = (over: Partial<ShareCardData> = {}): ShareCardData => ({
  ...shareCardOf({ lifetimeSaved: 11_420_734_512n, stats: page.stats, rule: page.rule, now: page.now }),
  usdText: "$2,073.42",
  usdCompact: "$2.1K",
  streakDays: 13,
  basket: ["SPYx", "ANTHROPIC"],
  ...over,
});

/** A token with its payload replaced, MAC kept: what an edit to the visible half looks like. */
const withPayload = (token: string, payload: unknown): string => `${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${token.split(".")[1]}`;
/** A token signed with `key` over any payload at all: what a holder of the key could write. */
const forged = (payload: unknown, key = KEY): string => {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${createHmac("sha256", key).update(`saverfi.share.v1\n${body}`).digest().subarray(0, 16).toString("base64url")}`;
};

afterEach(() => vi.restoreAllMocks());

describe("a token holds what the card prints, and nothing else", () => {
  it("round trip: the card, the background and the unit come back as signed", () => {
    for (const background of SHARE_BACKGROUNDS) {
      for (const unit of ["usd", "sol"] as const) {
        const token = signShareToken(payloadOf(card(), background, unit), KEY);
        const opened = cardOfPayload(verifyShareToken(token, [KEY])!);
        expect([opened.background, opened.unit]).toEqual([background, unit]);
        const shown = card();
        expect(opened.card).toEqual({
          ...shown,
          usdText: unit === "usd" ? shown.usdText : null,
          usdCompact: unit === "usd" ? shown.usdCompact : null,
          solText: unit === "sol" ? shown.solText : null,
          solCompact: unit === "sol" ? shown.solCompact : null,
        });
      }
    }
  });

  it("no vault, wallet, owner, lamports or leaderboard figure — in the payload or anywhere in the token", () => {
    const payload = payloadOf(card(), "grid", "sol");
    expect(Object.keys(payload).sort()).toEqual(["b", "c", "d", "k", "m", "n", "p", "r", "s", "t", "u", "v"]);
    const token = signShareToken(payload, KEY);
    const text = `${token} ${Buffer.from(token.split(".")[0]!, "base64url").toString()}`;
    for (const secret of [OWNER, VAULT, WALLET_A, "11420734512", "11.4207", SECRET]) expect(text).not.toContain(secret);
    expect(payload.n).toBe("11.42");
  });

  it("a card with nothing saved signs its rule alone: no figure, unit, month or streak", () => {
    const zero = card({ state: "zero", usdText: null, usdCompact: null, solText: "0", solCompact: "0" });
    const payload = payloadOf(zero, "vault", "usd");
    expect(payload).toEqual({ v: 1, d: payload.d, b: "v", z: 1, r: "20%", m: 0, p: 0, t: ["SPYx", "ANTHROPIC"] });
    expect(cardOfPayload(payload).card).toMatchObject({ state: "zero", usdText: null, solText: null, since: null, streakDays: null, rate: "20%" });
  });

  it("is never made for an unknown total or for the sample", () => {
    expect(() => payloadOf(card({ state: "unknown" }), "grid", "usd")).toThrow();
    expect(() => payloadOf(exampleShareCardOf({ stats: page.stats, rule: page.rule, now: page.now }), "grid", "usd")).toThrow();
  });

  it("the same card is the same token, so its picture is cached once", () => {
    expect(signShareToken(payloadOf(card(), "grid", "usd"), KEY)).toBe(signShareToken(payloadOf(card(), "grid", "usd"), KEY));
    expect(signShareToken(payloadOf(card(), "grid", "usd"), KEY)).not.toBe(signShareToken(payloadOf(card({ usdText: "$2,073.43" }), "grid", "usd"), KEY));
  });

  it("is short enough for a post: under 300 characters with a full basket", () => {
    const token = signShareToken(payloadOf(card({ basket: ["SPYx", "ANTHROPIC", "OPENAI", "SPACEX", "NEURALINK", "POLYMARKET", "KALSHI", "ANDURIL"] }), "streaks", "usd"), KEY);
    expect(token.length).toBeLessThan(300);
  });
});

describe("anything else is no card", () => {
  const good = signShareToken(payloadOf(card(), "grid", "usd"), KEY);

  it("one byte changed, anywhere: the figure, the MAC, or a character of either half", () => {
    const payload = payloadOf(card(), "grid", "usd");
    expect(verifyShareToken(withPayload(good, { ...payload, n: "$9,073.42" }), [KEY])).toBeNull();
    for (let index = 0; index < good.length; index += 7) {
      if (good[index] === ".") continue;
      const swapped = `${good.slice(0, index)}${good[index] === "A" ? "B" : "A"}${good.slice(index + 1)}`;
      expect(verifyShareToken(swapped, [KEY]), `at ${index}`).toBeNull();
    }
  });

  it("another key; a rotation keeps the previous one only while it is named", () => {
    expect(verifyShareToken(good, [Buffer.from(OTHER)])).toBeNull();
    expect(openShareToken(good, { [SHARE_SECRET_ENV]: OTHER })).toBeNull();
    expect(openShareToken(good, { [SHARE_SECRET_ENV]: OTHER, [SHARE_SECRET_PREVIOUS_ENV]: SECRET })).not.toBeNull();
    // New tokens are signed with the current key.
    expect(shareKeysOf({ [SHARE_SECRET_ENV]: OTHER, [SHARE_SECRET_PREVIOUS_ENV]: SECRET })!.sign.toString()).toBe(OTHER);
  });

  it("another version, a field the signer never writes, a figure out of shape — even under the right key", () => {
    const payload = payloadOf(card(), "grid", "usd");
    expect(verifyShareToken(forged(payload), [KEY])).toEqual(payload);
    expect(verifyShareToken(forged({ ...payload, v: 2 }), [KEY])).toBeNull();
    expect(verifyShareToken(forged({ ...payload, owner: OWNER }), [KEY])).toBeNull();
    expect(verifyShareToken(forged({ ...payload, n: "<script>" }), [KEY])).toBeNull();
    expect(verifyShareToken(forged({ ...payload, u: "sol" }), [KEY])).toBeNull(); // dollars under a SOL label
    expect(verifyShareToken(forged({ ...payload, k: 46 }), [KEY])).toBeNull();
    expect(verifyShareToken(forged({ ...payload, t: ["SPY x"] }), [KEY])).toBeNull();
    expect(verifyShareToken(forged({ ...payload, z: 1 }), [KEY])).toBeNull(); // nothing saved, with a figure
  });

  it("the wrong shape, too long, or not a token at all", () => {
    for (const token of ["", "abc", `${good}x`, `${good}.x`, good.replace(".", ""), `${"A".repeat(500)}.${good.split(".")[1]}`, "example", "../../etc/passwd"]) {
      expect(verifyShareToken(token, [KEY]), token.slice(0, 20)).toBeNull();
    }
  });
});

describe("the secret", () => {
  it("absent, blank or short: links are off, said once in the log by name and never by value", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    (globalThis as Record<symbol, unknown>)[Symbol.for("sip.web.share.offWarned")] = undefined;
    expect(shareKeysOf({})).toBeNull();
    expect(shareKeysOf({ [SHARE_SECRET_ENV]: "  " })).toBeNull();
    expect(shareKeysOf({ [SHARE_SECRET_ENV]: "short-secret" })).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain(SHARE_SECRET_ENV);
    expect(String(warn.mock.calls[0]![0])).not.toContain("short-secret");
    // And with links off, no token opens.
    expect(openShareToken(signShareToken(payloadOf(card(), "grid", "usd"), KEY), {})).toBeNull();
  });

  it("what `openssl rand -hex 32` or `-base64 32` prints is enough", () => {
    expect(shareKeysOf({ [SHARE_SECRET_ENV]: "f".repeat(64) })).not.toBeNull();
    expect(shareKeysOf({ [SHARE_SECRET_ENV]: `${"Q".repeat(43)}=` })).not.toBeNull();
  });
});

describe("every variant of a card", () => {
  it("three backgrounds × the units it can show, each opening to its own background and unit", () => {
    const links = signShareLinks(card(), unitsOf(card()), KEY);
    for (const background of SHARE_BACKGROUNDS) {
      for (const unit of ["usd", "sol"] as const) {
        const path = links[background][unit]!;
        expect(path).toMatch(/^\/c\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$/);
        expect(openShareToken(path.slice(3), ENV)).toMatchObject({ background, unit });
      }
    }
  });

  it("no price: SOL only; nothing saved: one link, whichever unit is asked", () => {
    const noPrice = card({ usdText: null, usdCompact: null });
    expect(Object.keys(signShareLinks(noPrice, unitsOf(noPrice), KEY).grid)).toEqual(["sol"]);
    const zero = card({ state: "zero", usdText: null, usdCompact: null });
    const links = signShareLinks(zero, unitsOf(zero), KEY);
    expect(links.vault.usd).toBe(links.vault.sol);
  });
});

describe("the schema accepts every figure a card can print", () => {
  it("dollars, SOL, dust, big figures, any rate", () => {
    const base = payloadOf(card(), "grid", "usd");
    for (const [u, n, c] of [
      ["usd", "<$0.01", "$0"],
      ["usd", "$0.04", "$0"],
      ["usd", "$1,234,567.89", "$1.2M"],
      ["sol", "<0.01", "0"],
      ["sol", "0.5", "0.5"],
      ["sol", "6,800.18", "6.8K"],
    ] as const) {
      expect(readPayload({ ...base, u, n, c }), n).not.toBeNull();
    }
    for (const r of ["0.25%", "2%", "20%", "100%"]) expect(readPayload({ ...base, r }), r).not.toBeNull();
  });
});
