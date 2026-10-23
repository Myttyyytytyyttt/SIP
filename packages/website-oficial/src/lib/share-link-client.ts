/**
 * THE DIALOG'S SIDE OF THE SIGNED LINK (owner, 10-22: "Enlace con vista
 * previa"): one POST to /api/share when a Live page's dialog opens, and what to
 * do with its answer (lib/share-server.ts holds the other side).
 *
 * ASKED ONCE PER FIGURES, NOT PER OPEN. The answer is kept here, for this tab,
 * five minutes, under the pension key and what the PAGE showed when it asked —
 * its card and its streak's proof — never under the card the server answered:
 * the dialog adopts that card, and a key made of it would ask again, adopt
 * again, and loop. A saving that lands changes the page's card, and so asks
 * anew. A refusal is not kept — the next open asks again — except "links are
 * off", which is a setting, not a moment.
 *
 * NEVER MORE THAN A FEW SECONDS. Post on X waits for the link (SharePanel.tsx)
 * at most SHARE_LINK_WAIT_MS; past that the dialog shares the site as before,
 * and an answer that comes later is still taken.
 *
 * THE SHORT LINK IS A SECOND ASK, AND NEVER A WAIT (owner, 10-23: "que sean
 * como /c/xxxxxxx y ya"; review, 10-23: no store write per open). Only when the
 * answer says `short`, and only when the dialog has had the card in view for
 * SHARE_KEEP_DWELL_MS or Post on X or Share is reached for (SharePanel.tsx):
 * one POST {"action":"short","links":…} (keepShareLinks), whose answer — the
 * same links, short where the server kept the card — is held for the tab like
 * the first one. Nothing waits for it: until it is in, the dialog posts the
 * long link. An answer with nothing short in it — the store, or this client's
 * writes, out of room just now, or a refusal — is believed SHARE_SHORT_RETRY_MS,
 * then asked again on the next reach.
 */

import { createJsonPoster } from "@/lib/vault-api";

import { SHARE_SITE, type ShareCardData, type ShareLinks, type ShareLinkSource } from "@/lib/live-share";

/** How long Post on X waits for its link before it shares the site instead. */
export const SHARE_LINK_WAIT_MS = 4_000;
/** How long an answer is kept for the same figures. */
export const SHARE_LINK_KEEP_MS = 5 * 60_000;
/** How long the card is in view before the dialog asks for its short link on its own: an opening that is a glance writes nothing. */
export const SHARE_KEEP_DWELL_MS = 2_000;
/** How long "nothing short just now" is believed before a reach asks again. */
export const SHARE_SHORT_RETRY_MS = 60_000;

/** What /api/share answers (ShareLinkAnswer in lib/share-server.ts), as the dialog reads it. */
export interface ShareLinkAnswer {
  readonly card: ShareCardData;
  readonly links: ShareLinks;
  readonly streak: { readonly claimed: number; readonly proven: number | null };
  /** True when the deployment keeps short links, so the dialog may ask for them; absent otherwise. */
  readonly short?: boolean;
}

/** none: no link at all (the old flow) · pending: asked, not answered · ready: links to post — `short` when they may be made short · failed: refused or too slow (the old flow). */
export type ShareLinkState =
  | { readonly status: "none" }
  | { readonly status: "pending" }
  | { readonly status: "ready"; readonly card: ShareCardData | null; readonly links: ShareLinks; readonly short: boolean }
  | { readonly status: "failed" };

interface Asked<T = ShareLinkAnswer | null> {
  readonly at: number;
  readonly answer: Promise<T>;
  /** The answer once it came: undefined while it has not. */
  settled?: T;
}

const asked = new Map<string, Asked>();

/** The key an answer is kept under: whose, what the page showed, and what it proved — never the adopted card. */
export const shareLinkKey = (source: Extract<ShareLinkSource, { kind: "live" }>, card: ShareCardData): string =>
  JSON.stringify([source.owner, source.proof, card]);

const isAnswer = (body: unknown): body is ShareLinkAnswer =>
  typeof body === "object" && body !== null && typeof (body as ShareLinkAnswer).card === "object" && typeof (body as ShareLinkAnswer).links === "object";

/** The answer for these figures: one already kept, or a new POST. Null when there is no link to post. */
export function askShareLink(
  source: Extract<ShareLinkSource, { kind: "live" }>,
  card: ShareCardData,
  options: { readonly fetch?: typeof fetch; readonly now?: number } = {},
): Promise<ShareLinkAnswer | null> {
  const key = shareLinkKey(source, card);
  const at = options.now ?? Date.now();
  const kept = asked.get(key);
  if (kept !== undefined && at - kept.at < SHARE_LINK_KEEP_MS) return kept.answer;
  for (const [old, each] of asked) if (at - each.at >= SHARE_LINK_KEEP_MS) asked.delete(old);
  const { request } = createJsonPoster(options.fetch === undefined ? {} : { fetch: options.fetch });
  const entry: Asked = {
    at,
    answer: request<ShareLinkAnswer>("/api/share", { action: "link", owner: source.owner, streak: [...source.proof] }).then((result) => {
      const answer = result.ok && isAnswer(result.body) ? result.body : null;
      entry.settled = answer;
      // A refusal is asked again next time; links that are off stay off for the while.
      if (answer === null && !(result.ok === false && result.code === "share_links_off")) asked.delete(key);
      return answer;
    }),
  };
  asked.set(key, entry);
  return entry.answer;
}

/** An answer already in hand for these figures, so a reopened dialog starts ready: the answer, null when refused, undefined when none yet. */
export function keptShareLink(source: Extract<ShareLinkSource, { kind: "live" }>, card: ShareCardData, now: number = Date.now()): ShareLinkAnswer | null | undefined {
  const kept = asked.get(shareLinkKey(source, card));
  return kept === undefined || now - kept.at >= SHARE_LINK_KEEP_MS ? undefined : kept.settled;
}

// ── the short link ───────────────────────────────────────────────────────────

/** A short link's path: /c/ and 8 base62 characters (lib/share-code.ts SHARE_CODE_SHAPE, which is server-only). */
const SHORT_PATH = /^\/c\/[0-9A-Za-z]{8}$/;

const linkPaths = (links: ShareLinks): string[] => Object.values(links).flatMap((each) => Object.values(each as Record<string, string>));

/** The answer's links, if they are links: every background an object of /c/ paths. */
const isLinks = (value: unknown): value is ShareLinks =>
  typeof value === "object" &&
  value !== null &&
  Object.values(value).every((each) => typeof each === "object" && each !== null && Object.values(each).every((path) => typeof path === "string" && path.startsWith("/c/")));

const shortened = new Map<string, Asked<ShareLinks | null>>();

/** Short links for these long ones: kept from an earlier ask, or one POST {"action":"short"}. Null when none are short just now. */
export function keepShareLinks(links: ShareLinks, options: { readonly fetch?: typeof fetch; readonly now?: number } = {}): Promise<ShareLinks | null> {
  const key = JSON.stringify(links);
  const at = options.now ?? Date.now();
  const kept = shortened.get(key);
  if (kept !== undefined && at - kept.at < (kept.settled === null ? SHARE_SHORT_RETRY_MS : SHARE_LINK_KEEP_MS)) return kept.answer;
  for (const [old, each] of shortened) if (at - each.at >= SHARE_LINK_KEEP_MS) shortened.delete(old);
  const { request } = createJsonPoster(options.fetch === undefined ? {} : { fetch: options.fetch });
  const entry: Asked<ShareLinks | null> = {
    at,
    answer: request<{ links?: unknown }>("/api/share", { action: "short", links }).then((result) => {
      const got = result.ok && isLinks(result.body?.links) ? result.body.links : null;
      // Long links back are no short link: the store had no room, or this client no writes, just now.
      const answer = got !== null && linkPaths(got).some((path) => SHORT_PATH.test(path)) ? got : null;
      entry.settled = answer;
      return answer;
    }),
  };
  shortened.set(key, entry);
  return entry.answer;
}

/** Short links already in hand for these long ones: the links, null when the last ask found none, undefined when none was made (or it is stale). */
export function keptShortLinks(links: ShareLinks, now: number = Date.now()): ShareLinks | null | undefined {
  const kept = shortened.get(JSON.stringify(links));
  if (kept === undefined || kept.settled === undefined) return undefined;
  return now - kept.at < (kept.settled === null ? SHARE_SHORT_RETRY_MS : SHARE_LINK_KEEP_MS) ? kept.settled : undefined;
}

/** A path on this site as the address a post carries: the production site's, whatever host the dialog runs on. */
export const shareLinkUrl = (path: string): string => new URL(path, SHARE_SITE).toString();

const warmed = new Set<string>();

/**
 * ASK FOR THE PICTURE BEFORE X DOES: the first request draws it and the CDN
 * keeps it, so X's crawler — which gives up quickly — finds it ready. Once per
 * picture per tab; a failure costs nothing but the try.
 */
export function warmShareImage(path: string): void {
  if (warmed.has(path)) return;
  warmed.add(path);
  void globalThis.fetch(path).catch(() => undefined);
}

/** For tests: forget every answer and every warmed picture. */
export function forgetShareLinks(): void {
  asked.clear();
  shortened.clear();
  warmed.clear();
}
