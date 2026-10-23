/**
 * POST /api/share — THE SHARE CARD'S SIGNED LINKS (owner, 10-22: "Enlace con
 * vista previa": Post on X posts saverfi.cash/c/<token>, and X shows the card
 * under the post).
 *
 * {"action":"link","owner":<pension key>,"streak":[<signature>…]} answers
 * `{card, links, streak}`: the card as THIS SERVER reads it from the chain, and
 * one signed link per background and unit (lib/share-token.ts). The dialog
 * adopts that card, so its preview, Copy, Download and the X preview all show
 * the same figures, and the link shows nothing the server did not read itself.
 *
 * SHORT WHEN IT CAN BE (owner, 10-23: "que sean como /c/xxxxxxx y ya"), AND
 * ONLY WHEN ASKED (review, 10-23: a write on every open, with a price move able
 * to make a new card each minute, was the store's scarcest operation spent on
 * dialogs nobody posted from). "link" writes nothing: it answers the long links, plus
 * `short: true` when this deployment has a Blob store. Then, once per opening
 * at most or when Post on X or Share is reached for, the dialog sends those
 * links back as {"action":"short","links":…}, and the answer is the same links,
 * saverfi.cash/c/<8 characters> wherever the card's record is now kept
 * (lib/share-code.ts reissuedShareLinks, lib/share-store.ts shortLinksOf). No
 * store, and "link" answers exactly what it did before short links existed —
 * no `short`, no second request; a slow, full or refusing store, or a client
 * past its writes, and "short" answers the long links: the dialog posts those.
 *
 * THE FIGURES ARE READ, NEVER RECEIVED. One snapshot — the Live page's own
 * batch of four, through readLiveSnapshot and liveSnapshotJsonText, so the
 * route parses the very JSON /api/solana-live sends — then the Live model
 * (toLiveDashboard) and the card's figures (live-figures.ts shareInputOf). The
 * streak, which no snapshot holds, is a claim the server checks: one settlement
 * signature per day, each read back and kept only when the program says it paid
 * this vault on that day; anything short of the claim and the card states no
 * streak (live-figures.ts). The body's `owner` names whose figures to read and
 * goes nowhere else — not into the links, not into a log line.
 *
 * WHAT IT COSTS: the request's 3, the snapshot's fourth call, and one
 * transaction per streak day not proven in the last day (45 at most): 49 of a
 * client's 60 a minute in the worst case, and the snapshot's 4 plus those
 * transactions from the reads budget every Solana route shares.
 * On top, a budget of its own (SHARE_READS_PER_MIN), so a burst of shares can
 * never starve Live. The card per pension is kept a minute and a proven day a
 * day (both per instance), so a dialog opened twice reads once. The /c pages
 * and their images read nothing of the chain; a short link's, its record, once
 * per instance (lib/share-store.ts). "short" reads nothing of the chain: it
 * checks the tokens it is handed with the secret, and writes a card's record
 * once — at most one store write per request, none for a card already kept,
 * within each client's and each instance's writes (lib/share-store.ts).
 *
 * THE OWN BUDGET IS TAKEN AFTER THE CLIENT PAYS, STEP BY STEP (review, 10-22).
 * It was taken first, for the worst case: 49 for a request whose client paid
 * 4, before the route knew the vault existed — six requests for vaults that do
 * not exist, each naming 45 junk signatures, emptied it, and share links
 * answered 429 for everyone. Now the snapshot is paid by the client and then
 * by the budget; the streak's reads only once the vault is known to exist,
 * again the client first. A client never takes more from the budget than from
 * its own buckets, and one already refused takes nothing.
 *
 * OFF WITHOUT ITS SECRET: no SIP_SHARE_SECRET, and every request is a 404
 * share_links_off before any read — the dialog then shares the site, as
 * before. An unknown total has no card, so no link either.
 */
import "server-only";

import { isPubkey, isSignature } from "@sip/solana-core/client";
import {
  LIVE_READS_WEIGHT,
  createSolanaReadRoute,
  createWeightedLimiter,
  deriveVaultPda,
  liveSnapshotJsonText,
  readLiveSnapshot,
  readVaultTransactions,
  retryAfterSeconds,
  type SolanaBuildHandlerOptions,
  type SolanaRouteHandler,
  type SolanaRouteServed,
  type WeightedLimiter,
} from "@sip/solana-core/server";

import type { Env } from "@/lib/config";
import { settledDayOf, shareInputOf, streakOfDays } from "@/lib/live-figures";
import { toLiveDashboard } from "@/lib/live-model";
import { SHARE_STREAK_CAP, shareCardOf, unitsOf, type ShareCardData, type ShareLinks } from "@/lib/live-share";
import type { LiveDashboard, LiveSnapshotJson } from "@/lib/live-types";
import { solanaGate } from "@/lib/load-config";
import { reissuedShareLinks } from "@/lib/share-code";
import { shortLinksOf, shortLinksOffered, type ShareStore } from "@/lib/share-store";
import { shareKeysOf, signShareLinks } from "@/lib/share-token";

/** The largest body: an owner and 45 signatures of up to 88 characters each — or six links of up to 515 — with room to spare. */
export const SHARE_MAX_BODY_BYTES = 6_144;
/** Upstream calls /api/share may make per minute in one instance, across everyone, before it answers 429. */
export const SHARE_READS_PER_MIN = 300;
/** How long one pension's card is kept, and one proven day. */
export const SHARE_CARD_TTL_MS = 60_000;
export const SHARE_PROOF_TTL_MS = 86_400_000;

const FIELDS = ["action", "owner", "streak"] as const;
const SHORT_FIELDS = ["action", "links"] as const;
const HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "private, no-store" } as const;

/** What the dialog is answered. */
export interface ShareLinkAnswer {
  readonly card: ShareCardData;
  readonly links: ShareLinks;
  /** How many days were claimed, and how many the chain proved — null when nothing was claimed. */
  readonly streak: { readonly claimed: number; readonly proven: number | null };
  /** Present, and true, only when this deployment keeps short links: the dialog may then ask for them ("short"). */
  readonly short?: true;
}

/** What "short" answers: the links it was handed, short wherever the card's record is kept. */
export interface ShareShortAnswer {
  readonly links: ShareLinks;
}

// ── per instance: the card a minute, a proven day a day, and the route's own budget

interface Kept<T> {
  readonly at: number;
  readonly value: T;
}
interface ShareState {
  readonly dashboards: Map<string, Kept<LiveDashboard>>;
  /** A signature proven to be a paid settlement into `vault`, on `day`. */
  readonly proven: Map<string, Kept<{ readonly vault: string; readonly day: number }>>;
  readonly budget: WeightedLimiter;
}

const STATE = Symbol.for("sip.web.share.state");
const MAX_KEPT = 2_000;

/** Held on globalThis like the Solana routes' reads budget, so every bundle of this route shares one. */
function stateOf(): ShareState {
  const holder = globalThis as unknown as Record<symbol, ShareState | undefined>;
  return (holder[STATE] ??= { dashboards: new Map(), proven: new Map(), budget: createWeightedLimiter({ capacity: SHARE_READS_PER_MIN }) });
}

function keep<T>(map: Map<string, Kept<T>>, key: string, value: T, at: number, ttl: number): void {
  if (map.size >= MAX_KEPT) for (const [old, kept] of map) if (at - kept.at >= ttl || map.size >= MAX_KEPT) map.delete(old);
  map.set(key, { at, value });
}

const fresh = <T>(kept: Kept<T> | undefined, at: number, ttl: number): T | null => (kept !== undefined && at - kept.at < ttl ? kept.value : null);

// ── the action ───────────────────────────────────────────────────────────────

export interface ShareRouteOptions extends Omit<SolanaBuildHandlerOptions, "gate" | "volumeOffered" | "maxBodyBytes"> {
  /** Read at each request. Default: process.env. */
  readonly env?: Env;
  /** This route's own budget across everyone. Default: one per process, SHARE_READS_PER_MIN. */
  readonly shareBudget?: WeightedLimiter;
  /** Where short links are kept. Default: the deployment's Blob store, if it has one (lib/share-store.ts); null: none, every link long. */
  readonly shareStore?: ShareStore | null;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: HEADERS });
}

async function link(
  fields: Readonly<Record<string, unknown>>,
  served: SolanaRouteServed,
  env: Env,
  now: () => number,
  budget: WeightedLimiter,
  store: ShareStore | null | undefined,
): Promise<Response> {
  const extra = Object.keys(fields).find((name) => !(FIELDS as readonly string[]).includes(name));
  if (extra !== undefined) return served.refuse(400, "bad_request", `Unexpected field ${extra.slice(0, 40)}.`);
  const { owner, streak } = fields;
  if (!isPubkey(owner)) return served.refuse(400, "bad_request", "owner must be a base58 32-byte public key.");
  if (!Array.isArray(streak) || streak.length > SHARE_STREAK_CAP || !streak.every(isSignature) || new Set(streak).size !== streak.length) {
    return served.refuse(400, "bad_request", `streak must list 0 to ${SHARE_STREAK_CAP} distinct base58 64-byte signatures.`);
  }
  const keys = shareKeysOf(env);
  if (keys === null) return json(404, { error: { code: "share_links_off", message: "Share links are off on this deployment." } });

  const state = stateOf();
  const vault = deriveVaultPda(owner).toBase58();
  const at = now();
  const kept = fresh(state.dashboards.get(owner), at, SHARE_CARD_TTL_MS);
  const unproven = (streak as string[]).filter((signature) => fresh(state.proven.get(signature), at, SHARE_PROOF_TTL_MS)?.vault !== vault);
  /** This route's own budget, for calls the client has just paid for: a 429 when it is spent. */
  const shared = (calls: number): Response | null => {
    const wait = budget.take("global", calls, now());
    if (wait <= 0) return null;
    const seconds = retryAfterSeconds(wait);
    return served.refuse(429, "rate_limited", `SaverFi is making many share links right now. Retry in ${seconds} s.`, { retryAfterSeconds: seconds });
  };

  // THE CARD: one snapshot, the Live page's own JSON, the Live page's own model — paid by the client, then by the route's budget.
  let data = kept;
  if (data === null) {
    const spent = served.spendReads(LIVE_READS_WEIGHT.snapshot) ?? shared(LIVE_READS_WEIGHT.snapshot);
    if (spent !== null) return spent;
    const snapshot = await readLiveSnapshot(served.pool, { owner, wallets: [], discover: false });
    const parsed = JSON.parse(liveSnapshotJsonText(owner, snapshot, now())) as LiveSnapshotJson;
    data = toLiveDashboard({ snapshot: parsed, activity: null, privyWallets: [] });
    if (data.vault.status === "exists" && data.vault.lifetimeSaved !== null) keep(state.dashboards, owner, data, at, SHARE_CARD_TTL_MS);
  }
  if (data.vault.status === "missing") return served.refuse(404, "vault_missing", "This pension key has no vault.");
  if (data.vault.status !== "exists" || data.vault.lifetimeSaved === null) return served.refuse(502, "unreadable", "SaverFi could not read this pension just now.");

  // THE STREAK: the claim, read back — each day proven once a day. Only for a vault that exists, and the client pays first.
  if (unproven.length > 0) {
    const more = served.spendMore(unproven.length) ?? shared(unproven.length);
    if (more !== null) return more;
    const read = await readVaultTransactions(
      served.pool,
      vault,
      unproven.map((signature) => ({ signature, slot: 0, blockTime: null, err: null })),
    );
    if (read.kind === "exists") {
      for (const entry of read.value) {
        const day = settledDayOf(entry, vault);
        if (day !== null) keep(state.proven, entry.signature, { vault, day }, at, SHARE_PROOF_TTL_MS);
      }
    }
  }
  const claimed = streak.length;
  const days = (streak as string[]).flatMap((signature) => {
    const proof = fresh(state.proven.get(signature), at, SHARE_PROOF_TTL_MS);
    return proof !== null && proof.vault === vault ? [proof.day] : [];
  });
  const proven = claimed === 0 ? null : streakOfDays(days, data.nowMs);
  // Only the whole claim, proven, is stated; anything less, and the card says nothing of a streak — never a smaller number, never 0.
  const streakDays = claimed >= 2 && proven === claimed ? proven : null;

  const card = shareCardOf(shareInputOf(data, streakDays));
  if (card.state === "unknown") return served.refuse(502, "unreadable", "SaverFi could not read this pension just now.");
  // THE LINKS: signed, long. Nothing is written here — a store write waits for the dialog to ask ("short").
  const links = signShareLinks(card, unitsOf(card), keys.sign);
  const answer: ShareLinkAnswer = { card, links, streak: { claimed, proven }, ...(shortLinksOffered({ env, store, now }) ? { short: true as const } : {}) };
  return json(200, answer);
}

/**
 * "short": the links "link" answered, kept and made short. Only a set that is
 * exactly one card's as this server signed it is taken (reissuedShareLinks);
 * the answer is never an error for the store's sake — its failures, and a
 * client or an instance past its writes, answer the long links.
 */
async function short(fields: Readonly<Record<string, unknown>>, served: SolanaRouteServed, env: Env, now: () => number, store: ShareStore | null | undefined): Promise<Response> {
  const extra = Object.keys(fields).find((name) => !(SHORT_FIELDS as readonly string[]).includes(name));
  if (extra !== undefined) return served.refuse(400, "bad_request", `Unexpected field ${extra.slice(0, 40)}.`);
  const keys = shareKeysOf(env);
  if (keys === null) return json(404, { error: { code: "share_links_off", message: "Share links are off on this deployment." } });
  const links = reissuedShareLinks(fields.links, keys);
  if (links === null) return served.refuse(400, "bad_request", "links must be one card's links, as /api/share signed them.");
  const answer: ShareShortAnswer = { links: await shortLinksOf(links, keys.sign, served.client, { env, store, now }) };
  return json(200, answer);
}

/**
 * The route, bound to this app's gate. The secret is read per request, like the
 * gate: an edited environment needs no rebuild. Off, a request is answered 404
 * before anything else is spent on it.
 */
export function shareRoute(options: ShareRouteOptions = {}): SolanaRouteHandler {
  const { env: given, shareBudget, shareStore, ...rest } = options;
  const env = (): Env => given ?? process.env;
  const now = rest.now ?? Date.now;
  const budget = (): WeightedLimiter => shareBudget ?? stateOf().budget;
  const route = createSolanaReadRoute("share", { ...rest, gate: () => solanaGate(env()), maxBodyBytes: SHARE_MAX_BODY_BYTES }, async (action, fields, served) =>
    action === "link"
      ? link(fields, served, env(), now, budget(), shareStore)
      : action === "short"
        ? short(fields, served, env(), now, shareStore)
        : served.refuse(400, "bad_request", 'action must be "link" or "short".'),
  );
  return {
    POST: (request) => (shareKeysOf(env()) === null ? Promise.resolve(json(404, { error: { code: "share_links_off", message: "Share links are off on this deployment." } })) : route.POST(request)),
    GET: route.GET,
  };
}
