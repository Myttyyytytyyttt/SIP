// THE SHORT LINK'S FORMAT (owner, 10-23: "que sean como /c/xxxxxxx y ya"): a
// code is 8 base62 characters made from the card under the secret — the same
// card, the same codes; another card or another secret, others — and a code
// opens to its own variant of the card only through a record that is exactly
// the one this server writes, whose token verifies like any long link's.

import { describe, expect, it } from "vitest";

import { toDashboardMock } from "@/lib/live-mock";
import { SHARE_BACKGROUNDS, shareCardOf, unitsOf, type ShareCardData, type ShareLinks } from "@/lib/live-share";
import {
  SHARE_CODE_SHAPE,
  SHARE_CODE_VARIANTS,
  mayBeShareCode,
  openShareRecord,
  readShareRecord,
  shareCardIdOf,
  shareCodeOf,
  shareRecordOf,
  shareRecordPath,
  shortShareLinks,
  type ShareRecord,
} from "@/lib/share-code";
import { openShareToken, signShareLinks, SHARE_SECRET_ENV } from "@/lib/share-token";

import { OWNER, VAULT, WALLET_A, liveDashboard } from "../../test/fixtures/live-dashboard";

const SECRET = "a".repeat(64);
const OTHER = "b".repeat(64);
const KEY = Buffer.from(SECRET);
const OTHER_KEY = Buffer.from(OTHER);
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
const zero = (): ShareCardData => shareCardOf({ lifetimeSaved: 0n, stats: page.stats, rule: page.rule, now: page.now });

const linksOf = (shown: ShareCardData, key = KEY): ShareLinks => signShareLinks(shown, unitsOf(shown), key);
const recordOf = (links: ShareLinks): ShareRecord => shareRecordOf(links)!;
const allPaths = (links: ShareLinks): string[] => SHARE_BACKGROUNDS.flatMap((background) => Object.values(links[background]));
const codeOfPath = (path: string) => shareCodeOf(path.slice(3))!;

/** A small seeded generator, so the guessing test is the same every run. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

describe("a short link is 8 base62 characters, made from the card under the secret", () => {
  it("one per variant, sharing the card's id, the same every time for the same card", () => {
    const links = linksOf(card());
    const short = shortShareLinks(links, recordOf(links), KEY);
    const paths = allPaths(short);
    expect(paths).toHaveLength(6);
    for (const path of paths) expect(path).toMatch(/^\/c\/[0-9A-Za-z]{8}$/);
    expect(new Set(paths).size).toBe(6);
    expect(new Set(paths.map((path) => path.slice(3, 9))).size).toBe(1);
    expect(shortShareLinks(linksOf(card()), recordOf(linksOf(card())), KEY)).toEqual(short);
  });

  it("another card — another figure, another day, another streak — is another id; another secret, other codes", () => {
    const idOf = (shown: ShareCardData, key = KEY) => shareCardIdOf(recordOf(linksOf(shown, key)), key);
    const id = idOf(card());
    expect(id).toMatch(/^[0-9A-Za-z]{6}$/);
    for (const other of [card({ usdText: "$2,073.43" }), card({ day: "2026-09-17" }), card({ streakDays: null }), card({ paused: true })]) expect(idOf(other)).not.toBe(id);
    expect(idOf(card(), OTHER_KEY)).not.toBe(id);
    expect(shareCardIdOf(recordOf(linksOf(card())), OTHER_KEY)).not.toBe(id);
  });

  it("a card with nothing saved has one code per background, for both units", () => {
    const links = linksOf(zero());
    const record = recordOf(links);
    expect(record.t.map((token) => token !== null)).toEqual([true, false, true, false, true, false]);
    const short = shortShareLinks(links, record, KEY);
    for (const background of SHARE_BACKGROUNDS) {
      expect(short[background].usd).toMatch(/^\/c\/[0-9A-Za-z]{8}$/);
      expect(short[background].sol).toBe(short[background].usd);
    }
  });

  it("the record holds the signed tokens, in the variants' order, and nothing else — no address of anyone's", () => {
    const links = linksOf(card());
    const record = recordOf(links);
    const text = JSON.stringify(record);
    expect(Object.keys(JSON.parse(text) as object)).toEqual(["v", "t"]);
    SHARE_CODE_VARIANTS.forEach(([background, unit], variant) => {
      expect(`/c/${record.t[variant]}`).toBe(links[background][unit]);
      expect(openShareToken(record.t[variant]!, ENV)).toMatchObject({ background, unit });
    });
    for (const secret of [OWNER, VAULT, WALLET_A, SECRET]) expect(text).not.toContain(secret);
    expect(shareRecordPath("aZ09bY")).toBe("c/aZ09bY.json");
  });

  it("only long links this server signed go into a record: a short one, the sample's or none at all is not a record", () => {
    expect(shareRecordOf({ grid: { usd: "/c/example" }, streaks: { usd: "/c/example/streaks" }, vault: {} })).toBeNull();
    const short = shortShareLinks(linksOf(card()), recordOf(linksOf(card())), KEY);
    expect(shareRecordOf(short)).toBeNull();
  });
});

describe("a code opens to its own variant of the card", () => {
  it("every code: the card its long link shows, in its background and unit", () => {
    const links = linksOf(card());
    const record = recordOf(links);
    const short = shortShareLinks(links, record, KEY);
    for (const background of SHARE_BACKGROUNDS) {
      for (const unit of ["usd", "sol"] as const) {
        const opened = openShareRecord(codeOfPath(short[background][unit]!), record, [KEY]);
        expect(opened).toEqual(openShareToken(links[background][unit]!.slice(3), ENV));
        expect([opened?.background, opened?.unit]).toEqual([background, unit]);
      }
    }
  });

  it("a code this server never made is refused before the store is asked — all but about 1 in 640", () => {
    const links = linksOf(card());
    for (const path of allPaths(shortShareLinks(links, recordOf(links), KEY))) expect(mayBeShareCode(codeOfPath(path), [KEY])).toBe(true);
    const random = seeded(1023);
    const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    let passed = 0;
    for (let i = 0; i < 20_000; i += 1) {
      const code = Array.from({ length: 8 }, () => ALPHABET[Math.floor(random() * 62)]).join("");
      if (mayBeShareCode(shareCodeOf(code)!, [KEY])) passed += 1;
    }
    // 20,000 / 640 ≈ 31.
    expect(passed).toBeGreaterThan(5);
    expect(passed).toBeLessThan(80);
  });

  it("only 8 base62 characters are a code: a long token, the sample, junk are not", () => {
    expect(SHARE_CODE_SHAPE.test("aZ09bY18")).toBe(true);
    for (const param of ["example", "aZ09bY1", "aZ09bY18x", "aZ09bY1-", "aZ09bY1_", "aZ09 Y18", linksOf(card()).grid.usd!.slice(3)]) expect(shareCodeOf(param), param).toBeNull();
    expect(shareCodeOf("aZ09bY18")).toEqual({ id: "aZ09bY", tag: "18" });
  });

  it("while a rotation settles, a code made under the previous secret still opens; without it, it does not", () => {
    const links = linksOf(card(), OTHER_KEY);
    const record = recordOf(links);
    const code = codeOfPath(shortShareLinks(links, record, OTHER_KEY).grid.usd!);
    expect(mayBeShareCode(code, [KEY, OTHER_KEY])).toBe(true);
    expect(openShareRecord(code, record, [KEY, OTHER_KEY])).toMatchObject({ background: "grid", unit: "usd" });
    expect(openShareRecord(code, record, [KEY])).toBeNull();
  });
});

describe("a record that is not exactly one this server writes is no card", () => {
  const links = linksOf(card());
  const record = recordOf(links);
  const code = codeOfPath(shortShareLinks(links, record, KEY).streaks.sol!);

  it("a token changed by one character: the MAC refuses it, as it would the long link", () => {
    const at = SHARE_CODE_VARIANTS.findIndex(([background, unit]) => background === "streaks" && unit === "sol");
    const token = record.t[at]!;
    const changed = `${token.slice(0, 12)}${token[12] === "A" ? "B" : "A"}${token.slice(13)}`;
    const t = record.t.map((each, variant) => (variant === at ? changed : each));
    expect(openShareRecord(code, { v: 1, t }, [KEY])).toBeNull();
  });

  it("tokens swapped between variants, or a record moved to another card's id: refused", () => {
    const swapped = { v: 1 as const, t: [record.t[1]!, record.t[0]!, ...record.t.slice(2)] };
    expect(openShareRecord(codeOfPath(shortShareLinks(links, record, KEY).grid.usd!), swapped, [KEY])).toBeNull();
    const elsewhere = recordOf(linksOf(card({ usdText: "$9.99", usdCompact: "$9.9" })));
    expect(openShareRecord(code, elsewhere, [KEY])).toBeNull();
  });

  it("a record's text with anything it does not name, or missing anything, is not read at all", () => {
    expect(readShareRecord(JSON.stringify(record))).toEqual(record);
    for (const text of [
      "",
      "null",
      "[]",
      "{}",
      JSON.stringify({ ...record, owner: OWNER }),
      JSON.stringify({ v: 2, t: record.t }),
      JSON.stringify({ v: 1, t: record.t.slice(1) }),
      JSON.stringify({ v: 1, t: [...record.t, null] }),
      JSON.stringify({ v: 1, t: [null, null, null, null, null, null] }),
      JSON.stringify({ v: 1, t: [1, null, null, null, null, null] }),
      JSON.stringify({ v: 1, t: ["x".repeat(513), null, null, null, null, null] }),
    ]) {
      expect(readShareRecord(text), text.slice(0, 40)).toBeNull();
    }
  });
});

/**
 * TWO VARIANTS OF ONE CARD WITH ONE TAG (about one card in 250): a code must
 * name one variant, so the second keeps its long link, and the first's code
 * still opens to the first.
 */
describe("two variants with one tag", () => {
  it("the later keeps its long link; the earlier's code opens to the earlier", () => {
    let found: { key: Buffer; links: ShareLinks; short: ShareLinks } | null = null;
    for (let i = 0; i < 5_000 && found === null; i += 1) {
      const key = Buffer.from(`collide-${i}`.padEnd(64, "x"));
      const links = linksOf(card(), key);
      const short = shortShareLinks(links, recordOf(links), key);
      if (allPaths(short).some((path) => path.length > 11)) found = { key, links, short };
    }
    expect(found).not.toBeNull();
    const { key, links, short } = found!;
    const record = recordOf(links);
    const kept = SHARE_CODE_VARIANTS.filter(([background, unit]) => short[background][unit] === links[background][unit]);
    expect(kept.length).toBeGreaterThan(0);
    for (const [background, unit] of SHARE_CODE_VARIANTS) {
      const path = short[background][unit]!;
      if (path === links[background][unit]) continue;
      expect(openShareRecord(codeOfPath(path), record, [key]), `${background} ${unit}`).toMatchObject({ background, unit });
    }
  });
});
