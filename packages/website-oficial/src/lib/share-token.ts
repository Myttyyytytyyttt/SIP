/**
 * THE SHARE CARD'S SIGNED LINK, /c/<token> (owner, 10-22: "Enlace con vista
 * previa"). Post on X posts a link, X shows the card under the post, and the
 * figures on that card are ones THIS SERVER read from the chain and signed —
 * so nobody can mint a "SaverFi" card with a number of their own on our domain.
 *
 * WHAT A TOKEN HOLDS: what the card prints, and nothing else. The figure as
 * printed and its short form, the rate, the mode, a pause, the month it began,
 * the streak, the basket's symbols, the day it was read, and the background
 * and unit it was drawn in. No vault, no wallet, no owner, no lamports: the
 * token is readable by anyone who has the link (base64url is not a secret), so
 * it says no more than the image does. The SOL figure is the card's two places,
 * never the leaderboard's four (live-share.ts says why).
 *
 * THE FORMAT: base64url(payload JSON) "." base64url(the first 16 bytes of
 * HMAC-SHA256(key, "saverfi.share.v1\n" + the payload's base64url)), about
 * 150-250 characters. The domain string keeps this MAC from ever standing for
 * another one the same key might make. The same figures, day, background and
 * unit always give the same token, so a card's image is cached once.
 *
 * READ IN THIS ORDER, and any failure is a 404 (openShareToken): the shape and
 * the length (512 at most), the MAC against every key in force — the current
 * SIP_SHARE_SECRET, and SIP_SHARE_SECRET_PREVIOUS while a rotation settles —
 * compared in constant time, and only then the payload, against a schema that
 * accepts nothing it does not name. No expiry: the card is dated on itself,
 * and a posted tweet keeps its preview. Unsetting or rotating the secret
 * (without keeping the old one as PREVIOUS) ends every preview already posted.
 *
 * THE SECRET: SIP_SHARE_SECRET, server-only, at least 43 characters (what
 * `openssl rand -hex 32` or `openssl rand -base64 32` print: 32 random bytes),
 * set in Production only. Absent or short, the feature is OFF and says so once
 * in the log, naming the variable and never a value; Post on X then shares the
 * site, and the image is pasted, as before (SharePanel.tsx).
 */
import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

import { dateLabel } from "@/lib/format";
import { SHARE_BACKGROUNDS, type ShareBackground, type ShareCardData, type ShareUnit } from "@/lib/live-share";

export const SHARE_SECRET_ENV = "SIP_SHARE_SECRET";
export const SHARE_SECRET_PREVIOUS_ENV = "SIP_SHARE_SECRET_PREVIOUS";
/** 32 random bytes as base64 without padding is 43 characters; as hex, 64. */
export const SHARE_SECRET_MIN_CHARS = 43;

const DOMAIN = "saverfi.share.v1\n";
const MAC_BYTES = 16;
const MAX_TOKEN_CHARS = 512;
const DAY_MS = 86_400_000;
/** base64url, then a dot, then the MAC's 22 characters (16 bytes). */
const TOKEN_SHAPE = /^([A-Za-z0-9_-]{8,480})\.([A-Za-z0-9_-]{22})$/;

type Env = Readonly<Record<string, string | undefined>>;

// ── the payload ──────────────────────────────────────────────────────────────

const BACKGROUND_CODE: Readonly<Record<ShareBackground, "g" | "s" | "v">> = { grid: "g", streaks: "s", vault: "v" };
const CODE_BACKGROUND: Readonly<Record<string, ShareBackground>> = { g: "grid", s: "streaks", v: "vault" };

/**
 * One card, one background, one unit, as signed. Short keys, ONLY what the
 * card prints. `z` marks a card with nothing saved yet: it has no figure, no
 * unit, no month and no streak, because it prints none.
 */
export interface SharePayload {
  readonly v: 1;
  /** The day it was read, as UTC days since 1970: the card's date. */
  readonly d: number;
  readonly b: "g" | "s" | "v";
  readonly z?: 1;
  readonly u?: ShareUnit;
  /** The figure as printed: "$2,073.42", "11.42", "<0.01". */
  readonly n?: string;
  /** Its short form, for a figure too long for the card: "$2.1M". */
  readonly c?: string;
  /** The rate as printed: "20%". */
  readonly r: string;
  /** 1 volume, 0 profit. */
  readonly m: 0 | 1;
  /** 1 while the rule is paused. */
  readonly p: 0 | 1;
  /** "Sep 2026": the month it began. */
  readonly s?: string;
  /** The streak, when it is one (two days or more, 45 at most: live-share.ts SHARE_STREAK_CAP). */
  readonly k?: number;
  /** The basket's symbols, biggest share first. */
  readonly t: readonly string[];
}

const dayNumberOf = (day: string): number => Math.floor(Date.parse(`${day}T00:00:00.000Z`) / DAY_MS);
const dayOfNumber = (days: number): string => new Date(days * DAY_MS).toISOString().slice(0, 10);

/**
 * THE PAYLOAD OF ONE VARIANT, in a fixed key order so the same card always
 * signs to the same token. Only a pension's card is ever signed: an unknown
 * total has no card, and the sample's figures are nobody's (its pages are
 * fixed, app/c/example).
 */
export function payloadOf(card: ShareCardData, background: ShareBackground, unit: ShareUnit): SharePayload {
  if (card.state === "unknown") throw new Error("an unknown total is never signed");
  if (card.example) throw new Error("the example is never signed");
  const base = { v: 1 as const, d: dayNumberOf(card.day), b: BACKGROUND_CODE[background] };
  const rule = { r: card.rate, m: card.mode === "volume" ? (1 as const) : (0 as const), p: card.paused ? (1 as const) : (0 as const) };
  if (card.state === "zero") return { ...base, z: 1, ...rule, t: [...card.basket] };
  const usd = unit === "usd" && card.usdText !== null;
  const n = usd ? card.usdText : card.solText;
  const c = usd ? card.usdCompact : card.solCompact;
  if (n === null || c === null) throw new Error(`no ${unit} figure to sign`);
  return {
    ...base,
    u: usd ? "usd" : "sol",
    n,
    c,
    ...rule,
    ...(card.since === null ? {} : { s: card.since }),
    ...(card.streakDays !== null && card.streakDays >= 2 ? { k: card.streakDays } : {}),
    t: [...card.basket],
  };
}

/** The card a payload prints, with the background and unit it was signed for. */
export function cardOfPayload(payload: SharePayload): { readonly card: ShareCardData; readonly background: ShareBackground; readonly unit: ShareUnit } {
  const day = dayOfNumber(payload.d);
  const unit: ShareUnit = payload.u ?? "usd";
  const saved = payload.z !== 1;
  const usd = saved && unit === "usd";
  const sol = saved && unit === "sol";
  return {
    card: {
      state: saved ? "saved" : "zero",
      usdText: usd ? (payload.n ?? null) : null,
      usdCompact: usd ? (payload.c ?? null) : null,
      solText: sol ? (payload.n ?? null) : null,
      solCompact: sol ? (payload.c ?? null) : null,
      rate: payload.r,
      mode: payload.m === 1 ? "volume" : "profit",
      paused: payload.p === 1,
      since: payload.s ?? null,
      streakDays: payload.k ?? null,
      basket: [...payload.t],
      asOf: dateLabel(`${day}T00:00:00.000Z`),
      day,
      example: false,
    },
    background: CODE_BACKGROUND[payload.b]!,
    unit,
  };
}

// ── the schema: nothing it does not name ─────────────────────────────────────

const USD_TEXT = /^(<\$0\.01|\$[0-9]{1,3}(,[0-9]{3}){0,5}\.[0-9]{2})$/;
const USD_SHORT = /^\$[0-9]{1,4}(\.[0-9])?[KMBT]?$/;
const SOL_TEXT = /^(<0\.01|[0-9]{1,3}(,[0-9]{3}){0,6}(\.[0-9]{1,2})?)$/;
const SOL_SHORT = /^[0-9]{1,4}(\.[0-9])?[KMBT]?$/;
const RATE_TEXT = /^[0-9]{1,3}(\.[0-9]{1,2})?%$/;
const MONTH_TEXT = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [0-9]{4}$/;
const SYMBOL = /^[A-Za-z0-9]{1,16}$/;
const KEYS = new Set(["v", "d", "b", "z", "u", "n", "c", "r", "m", "p", "s", "k", "t"]);

/** The payload, if it is exactly one the signer could have written; null otherwise. */
export function readPayload(value: unknown): SharePayload | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const p = value as Record<string, unknown>;
  if (Object.keys(p).some((key) => !KEYS.has(key))) return null;
  if (p.v !== 1) return null;
  if (typeof p.d !== "number" || !Number.isInteger(p.d) || p.d < 20_000 || p.d > 60_000) return null;
  if (p.b !== "g" && p.b !== "s" && p.b !== "v") return null;
  if (typeof p.r !== "string" || !RATE_TEXT.test(p.r)) return null;
  if (p.m !== 0 && p.m !== 1) return null;
  if (p.p !== 0 && p.p !== 1) return null;
  if (!Array.isArray(p.t) || p.t.length > 8 || !p.t.every((symbol) => typeof symbol === "string" && SYMBOL.test(symbol))) return null;
  if (p.z !== undefined) {
    // Nothing saved yet: nothing is printed but the rule.
    if (p.z !== 1 || ["u", "n", "c", "s", "k"].some((key) => key in p)) return null;
    return p as unknown as SharePayload;
  }
  if (p.u === "usd") {
    if (typeof p.n !== "string" || !USD_TEXT.test(p.n) || typeof p.c !== "string" || !USD_SHORT.test(p.c)) return null;
  } else if (p.u === "sol") {
    if (typeof p.n !== "string" || !SOL_TEXT.test(p.n) || typeof p.c !== "string" || !SOL_SHORT.test(p.c)) return null;
  } else return null;
  if (p.s !== undefined && (typeof p.s !== "string" || !MONTH_TEXT.test(p.s))) return null;
  if (p.k !== undefined && (typeof p.k !== "number" || !Number.isInteger(p.k) || p.k < 2 || p.k > 45)) return null;
  return p as unknown as SharePayload;
}

// ── signing and reading ──────────────────────────────────────────────────────

const macOf = (key: Buffer, body: string): Buffer => createHmac("sha256", key).update(`${DOMAIN}${body}`).digest().subarray(0, MAC_BYTES);

/** The token of a payload, under the current key. */
export function signShareToken(payload: SharePayload, key: Buffer): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${macOf(key, body).toString("base64url")}`;
}

/** The payload a token carries, if any key in force signed it and it is one the signer could have written; null otherwise. */
export function verifyShareToken(token: string, keys: readonly Buffer[]): SharePayload | null {
  if (typeof token !== "string" || token.length > MAX_TOKEN_CHARS) return null;
  const shape = TOKEN_SHAPE.exec(token);
  if (shape === null) return null;
  const [, body, mac] = shape as unknown as [string, string, string];
  const given = Buffer.from(mac, "base64url");
  // A non-canonical base64url (a stray bit in the last character) decodes to the same bytes: refused, so one card has one address.
  if (given.length !== MAC_BYTES || given.toString("base64url") !== mac) return null;
  if (!keys.some((key) => timingSafeEqual(macOf(key, body), given))) return null;
  try {
    const bytes = Buffer.from(body, "base64url");
    if (bytes.toString("base64url") !== body) return null;
    return readPayload(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown);
  } catch {
    return null;
  }
}

// ── the secret ───────────────────────────────────────────────────────────────

export interface ShareKeys {
  /** What new tokens are signed with. */
  readonly sign: Buffer;
  /** What a token may have been signed with: the current key, then the previous one. */
  readonly verify: readonly Buffer[];
}

const keyOf = (env: Env, name: string): Buffer | null => {
  const value = env[name]?.trim() ?? "";
  return value.length >= SHARE_SECRET_MIN_CHARS && !/\s/.test(value) ? Buffer.from(value, "utf8") : null;
};

const OFF_WARNED = Symbol.for("sip.web.share.offWarned");
const processWide = globalThis as unknown as Record<symbol, unknown>;

/**
 * THE KEYS IN FORCE, or null when share links are off. Off says so ONCE per
 * process, naming the variable and never a value — the same rule as the
 * config's own lines (load-config.ts): nothing else would show it, since the
 * site works on without it.
 */
export function shareKeysOf(env: Env = process.env): ShareKeys | null {
  const current = keyOf(env, SHARE_SECRET_ENV);
  if (current === null) {
    if (processWide[OFF_WARNED] !== true) {
      processWide[OFF_WARNED] = true;
      console.warn(
        JSON.stringify({
          event: "web.share.links_off",
          names: [SHARE_SECRET_ENV],
          message: `Share links are off: ${SHARE_SECRET_ENV} is unset or shorter than ${SHARE_SECRET_MIN_CHARS} characters. Post on X shares the site and the image is pasted. Make one with "openssl rand -hex 32".`,
        }),
      );
    }
    return null;
  }
  const previous = keyOf(env, SHARE_SECRET_PREVIOUS_ENV);
  return { sign: current, verify: previous === null ? [current] : [current, previous] };
}

/** A token's card, background and unit, if it is genuine and the feature is on; null — a 404 — otherwise. */
export function openShareToken(token: string, env: Env = process.env): ReturnType<typeof cardOfPayload> | null {
  const keys = shareKeysOf(env);
  if (keys === null) return null;
  const payload = verifyShareToken(token, keys.verify);
  return payload === null ? null : cardOfPayload(payload);
}

/** Every variant of one card, signed: three backgrounds × the units it can show — one link for a card with nothing saved. */
export function signShareLinks(card: ShareCardData, units: readonly ShareUnit[], key: Buffer): Record<ShareBackground, Partial<Record<ShareUnit, string>>> {
  const links = {} as Record<ShareBackground, Partial<Record<ShareUnit, string>>>;
  for (const background of SHARE_BACKGROUNDS) {
    const each: Partial<Record<ShareUnit, string>> = {};
    if (card.state === "zero") {
      const path = `/c/${signShareToken(payloadOf(card, background, "usd"), key)}`;
      each.usd = path;
      each.sol = path;
    } else {
      for (const unit of units) each[unit] = `/c/${signShareToken(payloadOf(card, background, unit), key)}`;
    }
    links[background] = each;
  }
  return links;
}
