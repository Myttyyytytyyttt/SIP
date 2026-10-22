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
 */

import { createJsonPoster } from "@/lib/vault-api";

import { SHARE_SITE, type ShareCardData, type ShareLinks, type ShareLinkSource } from "@/lib/live-share";

/** How long Post on X waits for its link before it shares the site instead. */
export const SHARE_LINK_WAIT_MS = 4_000;
/** How long an answer is kept for the same figures. */
export const SHARE_LINK_KEEP_MS = 5 * 60_000;

/** What /api/share answers (ShareLinkAnswer in lib/share-server.ts), as the dialog reads it. */
export interface ShareLinkAnswer {
  readonly card: ShareCardData;
  readonly links: ShareLinks;
  readonly streak: { readonly claimed: number; readonly proven: number | null };
}

/** none: no link at all (the old flow) · pending: asked, not answered · ready: links to post · failed: refused or too slow (the old flow). */
export type ShareLinkState =
  | { readonly status: "none" }
  | { readonly status: "pending" }
  | { readonly status: "ready"; readonly card: ShareCardData | null; readonly links: ShareLinks }
  | { readonly status: "failed" };

interface Asked {
  readonly at: number;
  readonly answer: Promise<ShareLinkAnswer | null>;
  /** The answer once it came: undefined while it has not. */
  settled?: ShareLinkAnswer | null;
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
  warmed.clear();
}
