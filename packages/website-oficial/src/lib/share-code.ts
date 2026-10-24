/**
 * THE SHARE CARD'S SHORT LINK, saverfi.cash/c/<8 characters> (owner, 10-23:
 * "haz que los links en lo que dice Post X sean más pequeños, que sean como
 * /c/xxxxxxx y ya" — and, of the ways offered, "Cortos con Vercel Blob"). The
 * long link, /c/<token> (share-token.ts), is the card itself; a short one is a
 * name for it, kept in a private store (share-store.ts). This file is the
 * format, with no I/O: what a code is, what a record holds, how both are read.
 *
 * A CODE IS 8 BASE62 CHARACTERS: the card's id (6) and a tag (2). The id is a
 * keyed hash, under SIP_SHARE_SECRET, of the card's signed tokens — every
 * variant the dialog was handed, each background in each unit; the tag is a
 * keyed hash of the id and one variant. So the same card always gets the same
 * codes (one record, written once, however often it is asked for), and nobody
 * without the secret can make one, or guess one the server made.
 *
 * ONE RECORD PER CARD, NOT ONE PER LINK (adjusted from "c/<code>.json", 10-23).
 * /api/share signs up to six links per dialog (three backgrounds × two units)
 * and only one of them is posted; a record per link would be six writes per new
 * card, on the store's scarcest operation (Vercel Blob on Hobby: 2,000 writes a
 * month, and Blob blocked for 30 days past it). One record per card is one
 * write; its six codes share the id and differ in the tag.
 *
 * WHAT A RECORD HOLDS: c/<id>.json, {"v":1,"t":[six tokens, or null]} — the
 * signed tokens, in SHARE_CODE_VARIANTS' frozen order, and nothing else: no vault, no
 * wallet, no address, nothing of whoever asked. A token says what the card
 * prints and no more (share-token.ts), so neither does the record.
 *
 * READ IN THIS ORDER, and any failure is a 404: the code's shape; its tag
 * against every key in force (mayBeShareCode) — a code this server never made
 * fails here, before the store is asked, all but 1 time in 640, so a run of
 * guesses costs the store almost nothing; then (openShareRecord) the record's
 * shape, nothing it does not name; its id, recomputed from its own tokens, so a
 * record moved to another path is no card at all; and the token the tag names,
 * verified exactly as a long link's — the MAC under SIP_SHARE_SECRET or
 * SIP_SHARE_SECRET_PREVIOUS, then the schema — whose background and unit must
 * be the ones that variant names.
 *
 * TWO VARIANTS WITH ONE TAG (about one card in 250): the second keeps its long
 * link, since a code names one variant. A card's other codes are not given away
 * by the one posted either: each tag is keyed, so a sibling takes some 2,000
 * guesses on average — and what it would show is the same card on another
 * background or in the other unit, nothing more.
 */
import "server-only";

import { createHmac } from "node:crypto";

import { SHARE_BACKGROUNDS, unitsOf, type ShareBackground, type ShareCardData, type ShareLinks, type ShareUnit } from "@/lib/live-share";
import { cardOfPayload, signShareLinks, verifyShareToken, type ShareKeys, type SharePayload } from "@/lib/share-token";

/** What a short link's last segment is: anything else under /c/ is a long token, or nothing. */
export const SHARE_CODE_SHAPE = /^[0-9A-Za-z]{8}$/;

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const ID_CHARS = 6;
const TAG_CHARS = 2;
const DOMAIN = "saverfi.share-code.v1\n";
/** share-token.ts's own cap on a token. */
const MAX_TOKEN_CHARS = 512;
/** A long link this server signed: /c/<base64url>.<base64url>. */
const LONG_LINK = /^\/c\/([A-Za-z0-9_-]{8,480}\.[A-Za-z0-9_-]{22})$/;

/**
 * EVERY WAY A CARD CAN BE POSTED, IN THE ORDER A v1 RECORD LISTS ITS TOKENS —
 * frozen here, written out, never derived from the dialog's own list (review,
 * 10-23). A posted code names its variant by its place in this table (its tag)
 * and a record is read only at this length, so the table is part of every code
 * already posted: derived from SHARE_BACKGROUNDS, a background added to the
 * picker would have turned every posted short link into a 404 (a record of the
 * old length), and a reorder would have pointed tags at other variants. A
 * background the table does not name keeps its long link (shareRecordOf skips
 * it) until a v2 table says otherwise; share-code.test.ts pins this one.
 */
export const SHARE_CODE_VARIANTS = [
  ["grid", "usd"],
  ["grid", "sol"],
  ["streaks", "usd"],
  ["streaks", "sol"],
  ["vault", "usd"],
  ["vault", "sol"],
] as const satisfies readonly (readonly [ShareBackground, ShareUnit])[];

/** One card's record in the store: its signed tokens, one per variant, null where it has none. */
export interface ShareRecord {
  readonly v: 1;
  readonly t: readonly (string | null)[];
}

/** A short link's two halves. */
export interface ShareCode {
  /** The card's: the record's name in the store. */
  readonly id: string;
  /** The variant's. */
  readonly tag: string;
}

/** `count` base62 digits of a keyed hash (2^64 values folded into 62^count: no digit is measurably likelier). */
function digitsOf(hash: Buffer, count: number): string {
  let n = hash.readBigUInt64BE(0);
  let out = "";
  for (let i = 0; i < count; i += 1) {
    out += ALPHABET[Number(n % 62n)];
    n /= 62n;
  }
  return out;
}

const keyed = (key: Buffer, text: string): Buffer => createHmac("sha256", key).update(`${DOMAIN}${text}`).digest();

/** The card's id under `key`: from all of its tokens, so one card is one id. */
export const shareCardIdOf = (record: ShareRecord, key: Buffer): string => digitsOf(keyed(key, `card\n${record.t.map((token) => token ?? "").join("\n")}`), ID_CHARS);

const tagOf = (id: string, variant: number, key: Buffer): string => digitsOf(keyed(key, `tag\n${id}\n${variant}`), TAG_CHARS);

/** Where a card's record is kept in the store. */
export const shareRecordPath = (id: string): string => `c/${id}.json`;

/**
 * THE RECORD OF THE LINKS /api/share HAS JUST SIGNED: their tokens, by variant.
 * A card with nothing saved names one link under both units; it is kept once,
 * under dollars. Null when there is no long link among them.
 */
export function shareRecordOf(links: ShareLinks): ShareRecord | null {
  const t = SHARE_CODE_VARIANTS.map(([background, unit]) => {
    const path = links[background][unit];
    const token = path === undefined ? null : (LONG_LINK.exec(path)?.[1] ?? null);
    if (token === null || (unit === "sol" && links[background].usd === path)) return null;
    return token;
  });
  return t.some((token) => token !== null) ? { v: 1, t } : null;
}

/**
 * THE SAME LINKS, SHORT: each long link that has a code becomes /c/<id><tag>.
 * Call it only once the record is in the store. A variant whose tag an earlier
 * one already took keeps its long link (the file's header says why).
 */
export function shortShareLinks(links: ShareLinks, record: ShareRecord, key: Buffer): ShareLinks {
  const id = shareCardIdOf(record, key);
  const taken = new Set<string>();
  const short = new Map<string, string>();
  record.t.forEach((token, variant) => {
    if (token === null) return;
    const tag = tagOf(id, variant, key);
    if (taken.has(tag)) return;
    taken.add(tag);
    short.set(`/c/${token}`, `/c/${id}${tag}`);
  });
  const shorten = (each: Readonly<Partial<Record<ShareUnit, string>>>): Partial<Record<ShareUnit, string>> =>
    Object.fromEntries(Object.entries(each).map(([unit, path]) => [unit, short.get(path) ?? path]));
  // Every background the links have, named in the table or not: one it does not name keeps its long links.
  return Object.fromEntries(Object.entries(links).map(([background, each]) => [background, shorten(each)])) as unknown as ShareLinks;
}

/** A short link's halves, if `param` has a short link's shape; null for anything else (a long token, "example", junk). */
export const shareCodeOf = (param: string): ShareCode | null =>
  typeof param === "string" && SHARE_CODE_SHAPE.test(param) ? { id: param.slice(0, ID_CHARS), tag: param.slice(ID_CHARS) } : null;

/** Whether a key in force could have made this code — asked before the store is: a code that could not is a 404 that costs nothing. */
export const mayBeShareCode = (code: ShareCode, keys: readonly Buffer[]): boolean =>
  keys.some((key) => SHARE_CODE_VARIANTS.some((_, variant) => tagOf(code.id, variant, key) === code.tag));

/** A record's text as a record, if it is exactly one this server writes; null otherwise. */
export function readShareRecord(text: string): ShareRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 2 || record.v !== 1 || !Array.isArray(record.t)) return null;
  const t = record.t as unknown[];
  if (t.length !== SHARE_CODE_VARIANTS.length) return null;
  if (!t.every((token) => token === null || (typeof token === "string" && token.length > 0 && token.length <= MAX_TOKEN_CHARS))) return null;
  if (!t.some((token) => token !== null)) return null;
  return { v: 1, t: t as (string | null)[] };
}

/**
 * THE CARD A CODE NAMES IN ITS RECORD, with its background and unit — if the
 * record is that card's under a key in force, the tag names one of its
 * variants, and that variant's token verifies as the variant it says it is.
 * Null — a 404 — otherwise.
 */
export function openShareRecord(code: ShareCode, record: ShareRecord, keys: readonly Buffer[]): ReturnType<typeof cardOfPayload> | null {
  for (const key of keys) {
    if (shareCardIdOf(record, key) !== code.id) continue;
    for (let variant = 0; variant < record.t.length; variant += 1) {
      const token = record.t[variant];
      if (token === null || token === undefined || tagOf(code.id, variant, key) !== code.tag) continue;
      const payload = verifyShareToken(token, keys);
      if (payload === null) return null;
      const opened = cardOfPayload(payload);
      const [background, unit] = SHARE_CODE_VARIANTS[variant]!;
      return opened.background === background && opened.unit === unit ? opened : null;
    }
  }
  return null;
}

const isBackground = (value: string): value is ShareBackground => (SHARE_BACKGROUNDS as readonly string[]).includes(value);

/**
 * THE LINKS TO KEEP, FROM THE ONES THE DIALOG WAS HANDED (review, 10-23: the
 * record is written when the dialog asks for short links, not when it opens —
 * share-server.ts's "short" action). `given` is accepted only if it is exactly
 * one card's set as /api/share signs it: every path a long link whose token a
 * key in force signed, every background there, each variant printing what that
 * card prints in it — so a request can keep only a card this server read from
 * the chain, and never a mix of two. The answer is that set signed again under
 * the current key, so no record is written under a key on its way out; null
 * for anything else.
 */
export function reissuedShareLinks(given: unknown, keys: ShareKeys): ShareLinks | null {
  if (given === null || typeof given !== "object" || Array.isArray(given)) return null;
  const read: { readonly background: ShareBackground; readonly unit: ShareUnit; readonly payload: SharePayload }[] = [];
  for (const [background, each] of Object.entries(given as Record<string, unknown>)) {
    if (!isBackground(background) || each === null || typeof each !== "object" || Array.isArray(each)) return null;
    for (const [unit, path] of Object.entries(each as Record<string, unknown>)) {
      if ((unit !== "usd" && unit !== "sol") || typeof path !== "string") return null;
      const token = LONG_LINK.exec(path)?.[1];
      const payload = token === undefined ? null : verifyShareToken(token, keys.verify);
      if (payload === null) return null;
      read.push({ background, unit, payload });
    }
  }
  if (read.length === 0) return null;
  // The card they print: the rule, the day and the rest from any of them, each unit's figure from its own.
  const opened = read.map(({ payload }) => cardOfPayload(payload).card);
  const usd = opened.find((card) => card.usdText !== null);
  const sol = opened.find((card) => card.solText !== null);
  const card: ShareCardData = {
    ...opened[0]!,
    usdText: usd?.usdText ?? null,
    usdCompact: usd?.usdCompact ?? null,
    solText: sol?.solText ?? null,
    solCompact: sol?.solCompact ?? null,
  };
  const again = signShareLinks(card, unitsOf(card), keys.sign);
  const printed = (path: string, verify: readonly Buffer[]): string => JSON.stringify(verifyShareToken(path.slice(3), verify));
  const asked = given as Partial<Record<ShareBackground, Partial<Record<ShareUnit, string>>>>;
  for (const background of SHARE_BACKGROUNDS) {
    for (const unit of ["usd", "sol"] as const) {
      const want = again[background][unit];
      const got = asked[background]?.[unit];
      if ((want === undefined) !== (got === undefined)) return null;
      if (want !== undefined && got !== undefined && printed(want, [keys.sign]) !== printed(got, keys.verify)) return null;
    }
  }
  return again;
}
