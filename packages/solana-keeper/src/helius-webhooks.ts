// The Helius webhook the doorbell listens to, kept in step with the links the
// keeper discovers — and nothing else.
//
// A MINIMAL CLIENT, NOT AN SDK. Four calls on https://mainnet.helius-rpc.com/v0/webhooks
// (list, create, update with PUT, activate with PATCH), each with a 10 s
// timeout and an injected fetch, so every rule below is tested without a
// network and without a key.
//
// THE API KEY IS IN THE QUERY STRING, and that is the whole danger of this
// file. A fetch that fails can put the URL in its message or its cause; an
// error body can echo the request. So an error built here carries the method,
// the path WITHOUT the query, the status and a short scrubbed excerpt — and
// never the original error as its cause, which a logger would print whole.
// The key also reaches the shared redactor at config time (src/config.ts), a
// second net under this one.
//
// WHAT IT COSTS. 100 credits per create, edit or delete, 1 per delivered
// event; a webhook holds at most 100,000 addresses and the Developer plan
// allows 50 webhooks. Hence the debounce: at most one edit ATTEMPT per
// MIN_EDIT_INTERVAL_MS, the first after boot excepted — a refused PUT counts,
// or it is sent every sweep — and a new link waits in the doorbell's "new"
// lane, turned every sweep, until the edit lands. And no edit is paid for
// twice: the sync finds its own webhook by id when the URL comes back in
// another form, trusts the header it wrote when the list leaves it out, and
// stops (and warns) when Helius does not keep an edit it answered 200.
//
// WHAT THE LIST DOES NOT SHOW IS NOT WHAT HELIUS DOES NOT HOLD (production,
// 2026-10-11). Every keeper PUT its webhook at boot and, ten minutes later,
// read the list as "Helius did not keep the edit": stuck, a failure every
// sweep, a GET every 60 s, a warn nobody was paged for — and the stuck path
// told the doorbell Helius watched what the list showed, so every link sat in
// the "new" lane while deliveries were arriving, authenticated, the whole
// time. So a look is DESCRIBED first (describeWebhook: counts, booleans and
// field names, never the header or any piece of it), then JUDGED by rules that
// each trust no more than this process itself wrote, and never by `lastEdit`,
// which a converged look clears. A stuck webhook is looked at every
// RECHECK_MS, not every sweep, and pages once it has been out of step for
// SYNC_FAILURE_CRITICAL_AFTER_MS.
//
// AND WHAT THE LIST DOES SHOW IS NOT FORGIVEN BECAUSE THIS PROCESS ONCE WROTE
// SOMETHING (review, 2026-10-11). A plain header with nothing of ours in it,
// or an address list emptied after it had shown the addresses, is a change on
// Helius's side, and is written back as before. The deliveries the doorbell
// counts are judged as they come — refused in a row AFTER the last accepted
// one, not "one accepted, once, since the edit" — and never on one 403: the
// receiver's URL is public, and a stranger's POST is refused like Helius's.
// What the deliveries alone withdraw is re-written at most once per process,
// and otherwise reported, so outside traffic cannot buy a PUT every twenty
// minutes.

import type { Secret } from "@sip/solana-log";

export const HELIUS_API_ORIGIN = "https://mainnet.helius-rpc.com";
const WEBHOOKS_PATH = "/v0/webhooks";
/** How the path of a single webhook is NAMED in an error: the id is not a secret, but it is not needed there either. */
const WEBHOOK_PATH_TEMPLATE = `${WEBHOOKS_PATH}/{webhookID}`;

export const HELIUS_TIMEOUT_MS = 10_000;
/** Helius's own ceiling per webhook. */
export const MAX_WEBHOOK_ADDRESSES = 100_000;
/** At most one address edit per ten minutes; the first sync after boot is not held back. */
export const MIN_EDIT_INTERVAL_MS = 10 * 60_000;
/**
 * How often an unchanged webhook is looked at again anyway: Helius AUTO-DISABLES
 * a webhook whose endpoint fails too often, and it stays off until somebody
 * PATCHes it back on (with a 24 h grace after). Nothing would ring meanwhile,
 * and the doorbell would find out only through a missing echo.
 */
export const RECHECK_MS = 10 * 60_000;
/** Failed syncs in a row before doorbell-sync warns. */
export const SYNC_FAILURE_ALERT_STREAK = 3;
/**
 * How long syncs may go on failing before doorbell-sync PAGES: an hour. The
 * warn stays in the log (Telegram forwards criticals only, by default), and a
 * webhook out of step for an hour is not a blip any more — the doorbell is
 * being kept honest by its safety nets alone.
 */
export const SYNC_FAILURE_CRITICAL_AFTER_MS = 60 * 60_000;
export const DOORBELL_SYNC_ALERT_KEY = "doorbell-sync";
/**
 * Helius's Get All Webhooks shows at most this many addresses per webhook (its
 * docs point to Get Webhook by ID for the whole list). A list cut here is not
 * a webhook that lost the rest.
 */
export const LIST_ADDRESS_CAP = 100;
/**
 * Deliveries refused 403 IN A ROW — after this process's last edit AND after
 * the last delivery accepted — before they count against the header it wrote
 * (AuthEvidence "refused"). Not one: POST /hooks/helius is a public URL, every
 * stranger's request is refused like a delivery with the wrong header, and one
 * probe after the boot PUT made a healthy webhook "stuck" and paged an hour
 * later (review, 2026-10-11). An accepted delivery starts the count again.
 */
export const REFUSALS_TO_WITHDRAW = 3;
const EXCERPT_CHARS = 200;
/** How much of a look a WebhookDiff keeps: addresses named per side, characters per string, entries per list, field names. */
const DIFF_SAMPLE = 3;
const DIFF_TEXT_CHARS = 40;
const DIFF_LIST_ENTRIES = 10;
const DIFF_FIELDS = 20;
/** A Solana address in base58 is at most 44 characters: the most of one a WebhookDiff names. */
const ADDRESS_CHARS = 44;
/**
 * Characters in a row that a header the list shows must share with ours to be
 * compared at all (a mask's visible ends, a truncation) — and that no string a
 * WebhookDiff carries may share with ours.
 */
const HEADER_WINDOW = 6;
/** What a WebhookDiff says in place of a string Helius returned that carries a piece of the header. */
const WITHHELD = "(withheld)";

export interface HeliusWebhook {
  readonly webhookID: string;
  readonly webhookURL: string;
  readonly webhookType?: string;
  readonly accountAddresses?: readonly string[];
  readonly transactionTypes?: readonly string[];
  readonly authHeader?: string;
  readonly txnStatus?: string;
  /** Only ever read for the diagnostics (WebhookDiff.shape): nothing is decided on it. */
  readonly encoding?: string;
  readonly active?: boolean;
}

/** What create and update send: the FULL object, every time — no reliance on partial-update semantics. */
export interface WebhookBody {
  readonly webhookURL: string;
  readonly webhookType: "raw";
  readonly accountAddresses: readonly string[];
  readonly transactionTypes: readonly ["ANY"];
  readonly authHeader: string;
  /** Failed transactions too: the keeper's own reverted settle is still an echo. */
  readonly txnStatus: "all";
}

export class HeliusWebhookError extends Error {
  override readonly name = "HeliusWebhookError";

  constructor(
    readonly method: string,
    /** The path only — never the query, which carries the key. */
    readonly path: string,
    /** Null when no answer arrived at all. */
    readonly status: number | null,
    readonly excerpt: string,
  ) {
    super(`Helius ${method} ${path} ${status === null ? "did not answer" : `answered ${status}`}: ${excerpt}`);
  }
}

export interface HeliusWebhookClient {
  list(): Promise<HeliusWebhook[]>;
  create(body: WebhookBody): Promise<HeliusWebhook>;
  update(webhookID: string, body: WebhookBody): Promise<HeliusWebhook>;
  setActive(webhookID: string, active: boolean): Promise<void>;
}

export interface HeliusClientOptions {
  readonly apiKey: Secret;
  /** Other values an error body could echo back — the doorbell secret, sent as authHeader. */
  readonly alsoScrub?: readonly Secret[];
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly origin?: string;
}

/**
 * Takes every URL, every secret this client knows and any api-key query
 * parameter out of a text, then keeps the first EXCERPT_CHARS characters.
 */
function scrubber(secrets: readonly Secret[]): (text: string) => string {
  return (text) => {
    // URLS FIRST, BY SHAPE: an error body or undici's TypeError can quote the
    // request's own URL, and a URL is the one thing in these texts nobody needs.
    let out = text.replace(/https?:\/\/[^\s"'<>]+/g, "<url>");
    for (const secret of secrets) {
      const value = secret.reveal();
      if (value.length > 0) out = out.split(value).join(`<redacted:${secret.label}>`);
      const encoded = encodeURIComponent(value);
      if (encoded !== value && encoded.length > 0) out = out.split(encoded).join(`<redacted:${secret.label}>`);
    }
    out = out.replace(/([?&]api-key=)[^&\s"'<>]*/gi, "$1<redacted>");
    out = out.replace(/\s+/g, " ").trim();
    return out.length > EXCERPT_CHARS ? `${out.slice(0, EXCERPT_CHARS)}…` : out;
  };
}

/** A failed fetch in words that cannot carry the URL: its name, its code, and a scrubbed message. */
function describeFailure(error: unknown, scrub: (text: string) => string): string {
  if (!(error instanceof Error)) return "the request failed";
  const cause = (error as { cause?: unknown }).cause;
  const code =
    typeof cause === "object" && cause !== null && typeof (cause as { code?: unknown }).code === "string"
      ? ` (${(cause as { code: string }).code})`
      : "";
  const message = scrub(error.message);
  return `${error.name}${code}: ${message}`;
}

export function createHeliusWebhookClient(options: HeliusClientOptions): HeliusWebhookClient {
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? HELIUS_TIMEOUT_MS;
  const origin = options.origin ?? HELIUS_API_ORIGIN;
  const scrub = scrubber([options.apiKey, ...(options.alsoScrub ?? [])]);

  async function call(method: string, pathName: string, path: string, body?: unknown): Promise<unknown> {
    // REVEALED HERE AND NOWHERE ELSE, inside the one expression that needs it.
    const url = `${origin}${path}?api-key=${encodeURIComponent(options.apiKey.reveal())}`;
    let text: string;
    let status: number;
    let ok: boolean;
    try {
      const response = await fetchImpl(url, {
        method,
        ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      status = response.status;
      ok = response.ok;
      text = await response.text();
    } catch (error) {
      // NOT `cause: error`. The original can hold the URL in its message and
      // again in its cause, and a logger that prints causes would print both.
      throw new HeliusWebhookError(method, pathName, null, describeFailure(error, scrub));
    }
    if (!ok) throw new HeliusWebhookError(method, pathName, status, scrub(text) || "(empty body)");
    if (text.trim() === "") return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new HeliusWebhookError(method, pathName, status, "the answer is not JSON");
    }
  }

  const one = (id: string): string => `${WEBHOOKS_PATH}/${encodeURIComponent(id)}`;
  const asWebhook = (value: unknown, method: string, pathName: string): HeliusWebhook => {
    if (typeof value !== "object" || value === null || typeof (value as { webhookID?: unknown }).webhookID !== "string") {
      throw new HeliusWebhookError(method, pathName, 200, "the answer is not a webhook");
    }
    return value as HeliusWebhook;
  };

  return {
    async list() {
      const value = await call("GET", WEBHOOKS_PATH, WEBHOOKS_PATH);
      if (!Array.isArray(value)) throw new HeliusWebhookError("GET", WEBHOOKS_PATH, 200, "the answer is not a list");
      return value.map((item) => asWebhook(item, "GET", WEBHOOKS_PATH));
    },
    async create(body) {
      return asWebhook(await call("POST", WEBHOOKS_PATH, WEBHOOKS_PATH, body), "POST", WEBHOOKS_PATH);
    },
    async update(webhookID, body) {
      return asWebhook(await call("PUT", WEBHOOK_PATH_TEMPLATE, one(webhookID), body), "PUT", WEBHOOK_PATH_TEMPLATE);
    },
    async setActive(webhookID, active) {
      await call("PATCH", WEBHOOK_PATH_TEMPLATE, one(webhookID), { active });
    },
  };
}

/** Sorted, unique: the one form addresses are compared and sent in. */
export function canonicalAddresses(addresses: Iterable<string>): string[] {
  return [...new Set(addresses)].sort();
}

// ── what a look saw, without the secret ──────────────────────────────────────

/**
 * How the Authorization header Helius shows differs from ours. Booleans and
 * counts — NEVER the value or any piece of it, which could be ours, masked or
 * not, and would then be in a log line, an alert and /status.
 */
export interface AuthHint {
  readonly type: "string" | "other";
  readonly length: "equal" | "shorter" | "longer";
  /** It contains * • ● … or "...": a value shown masked. */
  readonly looksMasked: boolean;
  /** How many characters are not mask characters. */
  readonly visibleChars: number;
  /** Whether the masked value's visible start is ours' start; null when it is not masked or its start is masked too. */
  readonly prefixAgrees: boolean | null;
  readonly suffixAgrees: boolean | null;
  readonly equalIgnoringCase: boolean;
  readonly equalTrimmed: boolean;
  /** Ours inside it, e.g. "Bearer <ours>". */
  readonly containsOurs: boolean;
  /** It inside ours: a truncation. */
  readonly withinOurs: boolean;
}

/**
 * What deliveries since this process's last edit say about the header Helius
 * sends: "refused" when at least REFUSALS_TO_WITHDRAW in a row were refused
 * after the last one accepted (and after the edit); else "proven" once one was
 * accepted; else "none". Read afresh at every look — a delivery accepted once
 * does not vouch for the header for good.
 */
export type AuthEvidence = "proven" | "refused" | "none";

/** One look at the webhook, described: what /status, the logs and doorbell-sync say about it. */
export interface WebhookDiff {
  /** The list (judged), or the answer to a create or a PUT (described, no rule applied). */
  readonly source: "list" | "edit-answer";
  readonly at: string;
  /** The object's field names, sorted, at most DIFF_FIELDS: names only, never values. */
  readonly fields: readonly string[];
  readonly addresses: {
    /** Whether accountAddresses was in the object at all. */
    readonly listed: boolean;
    readonly held: number;
    readonly desired: number;
    readonly missing: number;
    readonly extra: number;
    /**
     * The first DIFF_SAMPLE of each: public, on-chain addresses. The extra ones
     * are what Helius returned, so each is cut to ADDRESS_CHARS and withheld
     * when it carries a piece of the header.
     */
    readonly missingSample: readonly string[];
    readonly extraSample: readonly string[];
    readonly verdict: "same" | "written-unlisted" | "list-capped" | "extra-only" | "differs";
  };
  readonly auth: {
    readonly state: "absent" | "same" | "different";
    readonly hint: AuthHint | null;
    /**
     * "refused": one this process wrote and the list cannot show, which the
     * deliveries since contradict (AuthEvidence "refused") — re-written at
     * most once per process, and otherwise reported as a failed sync.
     */
    readonly verdict: "same" | "masked-ours" | "written-by-us" | "refused" | "differs";
    readonly evidence: AuthEvidence;
  };
  readonly shape: {
    /**
     * As Helius shows them, cut to DIFF_TEXT_CHARS characters and
     * DIFF_LIST_ENTRIES entries, and WITHHELD when one carries a piece of the
     * header: these are Helius's strings, and /status is public.
     */
    readonly webhookType: string | null;
    readonly transactionTypes: readonly string[] | null;
    readonly txnStatus: string | null;
    readonly encoding: string | null;
    readonly wrong: readonly ("webhookType" | "transactionTypes" | "txnStatus")[];
  };
  /** What still differs AFTER the rules; empty = converged. */
  readonly differs: readonly ("addresses" | "auth" | "shape")[];
}

/** What describeWebhook may judge a look by: what this process wrote, and what deliveries said since. */
export interface DescribeContext {
  readonly knownId?: string | null;
  readonly writtenAuth?: string | null;
  /** The canonical address key (sorted, joined by ",") this process last wrote to knownId. */
  readonly writtenKey?: string | null;
  readonly authEvidence?: AuthEvidence;
  /**
   * A delivery was accepted since this process's last edit: the webhook
   * delivers, whatever its list shows. Unlike authEvidence it does not go back
   * to "no" — it is asked only about addresses, which a refused delivery does
   * not contradict.
   */
  readonly heardSinceEdit?: boolean;
  /**
   * The list has shown this webhook holding addresses since this process's
   * last edit. An empty list after that is not the list's habit but a change
   * on Helius's side, and is written back.
   */
  readonly listedSinceEdit?: boolean;
  /** When the look happened, for WebhookDiff.at. */
  readonly now?: number;
}

/** A run of mask characters, or of three dots or more. A fresh one per use: a global regex carries lastIndex. */
const maskPattern = (): RegExp => /[*•●…]+|\.{3,}/g;

/**
 * The header Helius shows, measured against ours.
 *
 * THE VALUE NEVER LEAVES THIS FUNCTION. The masked value's visible head and
 * tail live in two locals, used only inside startsWith and endsWith; what comes
 * out is booleans and counts.
 */
function authHint(theirs: unknown, ours: string): AuthHint {
  const text = typeof theirs === "string" ? theirs : "";
  const masks = [...text.matchAll(maskPattern())];
  const looksMasked = masks.length > 0;
  let prefixAgrees: boolean | null = null;
  let suffixAgrees: boolean | null = null;
  if (looksMasked) {
    const first = masks[0]!;
    const last = masks[masks.length - 1]!;
    const head = text.slice(0, first.index);
    const tail = text.slice((last.index ?? 0) + last[0].length);
    prefixAgrees = head.length === 0 ? null : ours.startsWith(head);
    suffixAgrees = tail.length === 0 ? null : ours.endsWith(tail);
  }
  return {
    type: typeof theirs === "string" ? "string" : "other",
    length: text.length === ours.length ? "equal" : text.length < ours.length ? "shorter" : "longer",
    looksMasked,
    visibleChars: text.replace(maskPattern(), "").length,
    prefixAgrees,
    suffixAgrees,
    equalIgnoringCase: text.length > 0 && text.toLowerCase() === ours.toLowerCase(),
    equalTrimmed: text.length > 0 && text.trim() === ours.trim(),
    containsOurs: ours.length > 0 && text.includes(ours),
    withinOurs: text.length > 0 && ours.includes(text),
  };
}

/** The addresses the object shows, canonical; none when it shows no list (or not a list). */
function heldAddresses(found: HeliusWebhook): string[] {
  const raw: unknown = found.accountAddresses;
  return Array.isArray(raw) ? canonicalAddresses(raw.filter((address): address is string => typeof address === "string")) : [];
}

/**
 * Whether a text carries HEADER_WINDOW characters of ours in a row, in any
 * case, as they are or URL-encoded — or all of ours, when ours is shorter.
 */
function carriesOurs(text: string, ours: string): boolean {
  const haystack = text.toLowerCase();
  for (const form of new Set([ours, encodeURIComponent(ours)])) {
    const needle = form.toLowerCase();
    if (needle.length === 0) continue;
    if (needle.length <= HEADER_WINDOW) {
      if (haystack.includes(needle)) return true;
      continue;
    }
    for (let at = 0; at + HEADER_WINDOW <= needle.length; at += 1) {
      if (haystack.includes(needle.slice(at, at + HEADER_WINDOW))) return true;
    }
  }
  return false;
}

/**
 * A string Helius returned, as a WebhookDiff may carry it: cut to `max`, and
 * WITHHELD whole when any of it carries a piece of the header.
 *
 * EVERY HELIUS STRING, NOT ONLY authHeader. A body that echoes the header in a
 * renamed field, in encoding, or as an "address" someone pasted into the
 * dashboard would otherwise reach /status — public — in full: forty characters
 * hold a 32-character secret, and an address had no cap at all (review,
 * 2026-10-11). The whole value is checked, not the cut, so no window of it
 * survives the cut either.
 */
const told = (value: unknown, ours: string, max: number = DIFF_TEXT_CHARS): string | null =>
  value === undefined || value === null
    ? null
    : typeof value !== "string"
      ? `(${typeof value})`
      : carriesOurs(value, ours)
        ? WITHHELD
        : value.slice(0, max);
const canonicalWord = (value: unknown): string | null => (typeof value === "string" ? value.trim().toLowerCase() : null);

/**
 * One look at the webhook, described and judged. Pure.
 *
 * THE RULES TRUST NO MORE THAN THIS PROCESS WROTE. Each relaxation needs this
 * very webhook to be the one this process last edited (knownId) with this very
 * header or address set, and none of them is keyed on `lastEdit`, which a
 * converged look clears — a rule that was would PUT every other look.
 *
 * AND ONLY WHERE THE LIST CANNOT SHOW WHAT IT HOLDS. What it does show, plainly
 * and unlike ours, is a change on Helius's side — a hand edit in the dashboard,
 * an instance with another secret — and having written something once does
 * not forgive it (review, 2026-10-11).
 *
 *   * HEADER. The same value; or a MASKED value with at least HEADER_WINDOW
 *     characters showing whose visible ends are ours' ends; or one this
 *     process wrote, when what the list shows cannot contradict it — no header,
 *     a blank one, a mask whose visible ends are not another's, or ours
 *     transformed (inside "Bearer …", in another case, trimmed, or a truncation
 *     of HEADER_WINDOW characters or more). That last rule holds until the
 *     deliveries say otherwise (AuthEvidence "refused"): then the verdict is
 *     "refused", and the webhook is re-written at most once per process.
 *   * ADDRESSES. The same set; or one this process wrote, when the list leaves
 *     accountAddresses out, cuts it at LIST_ADDRESS_CAP, holds only extra ones
 *     besides (a PUT that merged), or shows an empty list — the last only
 *     while a delivery accepted since the edit proves the webhook works and the
 *     list has not shown the addresses since: an empty list after a full one is
 *     Helius emptying it.
 *   * SHAPE, compared trimmed and lower-case: raw, ["any"], all. A field the
 *     list leaves out (or shows as null) passes.
 *
 * NO STRING HELIUS RETURNED LEAVES WHOLE (told): field names, shape values and
 * extra addresses are cut, and withheld when they carry a piece of the header.
 *
 * Every relaxation still has the doorbell's own nets under it: the receiver's
 * exact header check, the echo deadline that makes it deaf, and the safety
 * rotation. A webhook out of step from Helius's side shows up there.
 */
export function describeWebhook(found: HeliusWebhook, body: WebhookBody, ctx: DescribeContext, source: WebhookDiff["source"]): WebhookDiff {
  const desired = canonicalAddresses(body.accountAddresses);
  const listed = Array.isArray(found.accountAddresses as unknown);
  const held = heldAddresses(found);
  const heldSet = new Set(held);
  const desiredSet = new Set(desired);
  const missing = desired.filter((address) => !heldSet.has(address));
  const extra = held.filter((address) => !desiredSet.has(address));

  const knownId = ctx.knownId ?? null;
  const written = knownId !== null && found.webhookID === knownId;
  const wroteHeader = written && ctx.writtenAuth === body.authHeader;
  const wroteAddresses = written && ctx.writtenKey === desired.join(",");
  const evidence = ctx.authEvidence ?? "none";

  const theirs: unknown = found.authHeader;
  const state: WebhookDiff["auth"]["state"] = theirs === undefined || theirs === null ? "absent" : theirs === body.authHeader ? "same" : "different";
  const hint = state === "different" ? authHint(theirs, body.authHeader) : null;
  // MASKED OURS needs one visible end compared, not merely none contradicted: a
  // mask that shows only its middle has proven nothing.
  const maskedOurs =
    hint !== null &&
    hint.looksMasked &&
    hint.visibleChars >= HEADER_WINDOW &&
    hint.prefixAgrees !== false &&
    hint.suffixAgrees !== false &&
    (hint.prefixAgrees === true || hint.suffixAgrees === true);
  // WHAT THE LIST SHOWS IN PLACE OF OURS, AND WHETHER IT COULD STILL BE OURS:
  // nothing to see (no header, a blank one, a mask whose visible ends are not
  // another's), or ours transformed. A plain value with nothing of ours in it,
  // or a mask showing another's ends, is not — it is written back.
  const hidden = state === "absent" || (typeof theirs === "string" && theirs.trim() === "");
  const opaque = hint !== null && hint.looksMasked && hint.prefixAgrees !== false && hint.suffixAgrees !== false;
  const transformed =
    hint !== null && (hint.containsOurs || hint.equalTrimmed || hint.equalIgnoringCase || (hint.withinOurs && hint.visibleChars >= HEADER_WINDOW));
  const mayBeWritten = wroteHeader && (hidden || opaque || transformed);
  const authVerdict: WebhookDiff["auth"]["verdict"] =
    state === "same" ? "same" : maskedOurs ? "masked-ours" : mayBeWritten ? (evidence === "refused" ? "refused" : "written-by-us") : "differs";

  const addressVerdict: WebhookDiff["addresses"]["verdict"] =
    missing.length === 0 && extra.length === 0
      ? "same"
      : !listed && wroteAddresses
        ? "written-unlisted"
        : held.length === LIST_ADDRESS_CAP && desired.length > LIST_ADDRESS_CAP && extra.length === 0 && wroteAddresses
          ? "list-capped"
          : listed && held.length === 0 && wroteAddresses && ctx.heardSinceEdit === true && ctx.listedSinceEdit !== true
            ? "written-unlisted"
            : missing.length === 0 && wroteAddresses
              ? "extra-only"
              : "differs";

  const types: unknown = found.transactionTypes;
  const wrong: ("webhookType" | "transactionTypes" | "txnStatus")[] = [];
  if (found.webhookType != null && canonicalWord(found.webhookType) !== "raw") wrong.push("webhookType");
  if (types != null && !(Array.isArray(types) && types.length === 1 && canonicalWord(types[0]) === "any")) wrong.push("transactionTypes");
  if (found.txnStatus != null && canonicalWord(found.txnStatus) !== "all") wrong.push("txnStatus");

  const differs: ("addresses" | "auth" | "shape")[] = [];
  if (addressVerdict === "differs") differs.push("addresses");
  if (authVerdict === "differs" || authVerdict === "refused") differs.push("auth");
  if (wrong.length > 0) differs.push("shape");

  const ours = body.authHeader;
  return {
    source,
    at: new Date(ctx.now ?? Date.now()).toISOString(),
    fields: Object.keys(found)
      .sort()
      .slice(0, DIFF_FIELDS)
      .map((name) => told(name, ours) ?? WITHHELD),
    addresses: {
      listed,
      held: held.length,
      desired: desired.length,
      missing: missing.length,
      extra: extra.length,
      missingSample: missing.slice(0, DIFF_SAMPLE),
      extraSample: extra.slice(0, DIFF_SAMPLE).map((address) => told(address, ours, ADDRESS_CHARS) ?? WITHHELD),
      verdict: addressVerdict,
    },
    auth: { state, hint, verdict: authVerdict, evidence },
    shape: {
      webhookType: told(found.webhookType, ours),
      transactionTypes: Array.isArray(types) ? types.slice(0, DIFF_LIST_ENTRIES).map((type) => told(type, ours) ?? "(null)") : null,
      txnStatus: told(found.txnStatus, ours),
      encoding: told(found.encoding, ours),
      wrong,
    },
    differs,
  };
}

/**
 * A WebhookDiff in one line, for the logs and doorbell-sync's detail: e.g.
 * "addresses 0/7 listed (no accountAddresses; missing 7) written-unlisted; header
 * different (masked, length equal, start/end agree) masked-ours, deliveries none;
 * shape raw·ANY·all; converged". Counts and flags only, like the diff itself.
 */
export function summarizeDiff(diff: WebhookDiff): string {
  const a = diff.addresses;
  const addressNotes = [
    a.listed ? null : "no accountAddresses",
    a.missing > 0 ? `missing ${a.missing}` : null,
    a.extra > 0 ? `extra ${a.extra}` : null,
  ].filter((note): note is string => note !== null);
  const addresses = `addresses ${a.desired - a.missing}/${a.desired} listed${addressNotes.length > 0 ? ` (${addressNotes.join("; ")})` : ""}${a.verdict === "same" ? "" : ` ${a.verdict}`}`;

  const { state, hint, verdict, evidence } = diff.auth;
  let header = `header ${state}`;
  if (hint !== null) {
    const end = (agrees: boolean | null, one: boolean): string => (agrees === null ? "hidden" : agrees ? (one ? "agrees" : "agree") : one ? "differs" : "differ");
    const ends =
      hint.prefixAgrees === hint.suffixAgrees
        ? `start/end ${end(hint.prefixAgrees, false)}`
        : `start ${end(hint.prefixAgrees, true)}, end ${end(hint.suffixAgrees, true)}`;
    const notes = [
      hint.type === "string" ? null : "not a string",
      hint.looksMasked ? `masked, ${hint.visibleChars} visible` : "plain",
      `length ${hint.length}`,
      hint.looksMasked ? ends : null,
      hint.containsOurs ? "contains ours" : null,
      hint.withinOurs ? "within ours" : null,
      hint.equalIgnoringCase ? "equal ignoring case" : null,
      hint.equalTrimmed ? "equal trimmed" : null,
    ].filter((note): note is string => note !== null);
    header += ` (${notes.join(", ")})`;
  }
  if (verdict !== "same") header += ` ${verdict}`;
  if (evidence !== "none" || verdict === "written-by-us") header += `, deliveries ${evidence}`;

  const s = diff.shape;
  const shape = `shape ${s.webhookType ?? "-"}·${s.transactionTypes === null ? "-" : s.transactionTypes.join("+")}·${s.txnStatus ?? "-"}${s.wrong.length > 0 ? ` (wrong: ${s.wrong.join(", ")})` : ""}`;
  const verdictOf = diff.differs.length === 0 ? (diff.source === "edit-answer" ? "matches what was sent" : "converged") : `differs: ${diff.differs.join(", ")}`;
  const outcome = diff.source === "edit-answer" ? `answer ${verdictOf}` : verdictOf;
  return `${addresses}; ${header}; ${shape}; ${outcome}`;
}

export interface EnsureResult {
  readonly webhookID: string;
  readonly action: "created" | "updated" | "unchanged" | "held";
  readonly reactivated: boolean;
  /** What Helius holds NOW: the desired set after a create or an update, the old one when the edit was held. */
  readonly watched: readonly string[];
  /** The addresses this call put on the webhook that it did not hold before: every one on a create. */
  readonly added: readonly string[];
  /**
   * Why deliveries before this call were certainly DROPPED, or null. The webhook
   * did not exist, was auto-disabled, or sent another Authorization header
   * (refused 403, which Helius never resends) or another shape. The doorbell
   * answers with a full pass (review, 2026-09-23).
   */
  readonly gap: string | null;
  /** Whether Helius now sends spec.authHeader: seen in the list, or written by this call or this process. */
  readonly authConfirmed: boolean;
  /** The edit this call made (create or PUT), as a fingerprint the next call compares; null when none. */
  readonly edit: string | null;
  /**
   * Set when the edit needed is the one this process already made and Helius
   * did not keep, or a header the deliveries refuse that this process already
   * re-wrote once; nothing was sent.
   */
  readonly stuck: string | null;
  readonly active: boolean;
  /** Other webhooks on the same URL, left alone: never created by this code, never deleted by it. */
  readonly duplicates: number;
  /** The look at the list, described and judged; null when there was no webhook to look at (a create). */
  readonly diff: WebhookDiff | null;
  /** The answer to this call's create or PUT, described with no rule applied; null when none was sent. */
  readonly editEcho: WebhookDiff | null;
}

/** What this process remembers between two ensureWebhook calls. All optional: a bare call is a first one. */
export interface EnsureContext extends DescribeContext {
  /**
   * The id this process created or last edited. Looked up by id when no
   * webhook matches the URL exactly: a list that returns the URL in another
   * form (a trailing slash) made the sync create a NEW webhook every ten
   * minutes, each one delivering every event again (review, 2026-09-23).
   */
  readonly knownId?: string | null;
  /**
   * The Authorization header this process last wrote to knownId. It stands in
   * for a list that leaves authHeader out, which otherwise reads as "differs"
   * on every look — a 100-credit PUT every ten minutes, forever.
   */
  readonly writtenAuth?: string | null;
  /**
   * The address set (canonical, joined by ",") this process last wrote to
   * knownId. It stands in for a list that leaves accountAddresses out, cuts it
   * at LIST_ADDRESS_CAP, or keeps extra ones — the same reason as writtenAuth.
   */
  readonly writtenKey?: string | null;
  /** What deliveries since the last edit say (WebhookSync's #evidence). Default "none". */
  readonly authEvidence?: AuthEvidence;
  /**
   * This process already re-wrote the webhook once over a "refused" header.
   * The next "refused" is reported (stuck), not paid for: refusals can be
   * strangers', and a PUT for each run of them was a PUT every twenty minutes.
   */
  readonly refusedEditSpent?: boolean;
  /** The fingerprint of this process's last successful edit (EnsureResult.edit). */
  readonly lastEdit?: string | null;
  /** Whether a create or a reactivation may be sent. Default true. */
  readonly allowCreate?: boolean;
  /** Called right before every create, PUT or PATCH: the attempt, whatever its answer. */
  readonly onAttempt?: () => void;
  /** Called with the look's diff as soon as it is made, so a PUT that then fails still leaves it for /status. */
  readonly onDiff?: (diff: WebhookDiff) => void;
}

/**
 * Makes the webhook for `url` watch `addresses`, idempotently.
 *
 * FOUND BY EXACT URL among the account's webhooks, so a restart, or two
 * instances overlapping during a deploy, find the one that exists instead of
 * creating another. A second webhook on the same URL would deliver every event
 * twice and cost twice.
 *
 * `allowEdit` false holds a PUT back (the debounce); a missing webhook is still
 * created and a disabled one is still switched back on, because either is the
 * doorbell being silent rather than slightly out of date.
 */
export async function ensureWebhook(
  client: HeliusWebhookClient,
  spec: { readonly url: string; readonly authHeader: string; readonly addresses: readonly string[] },
  allowEdit: boolean,
  context: EnsureContext = {},
): Promise<EnsureResult> {
  const allowCreate = context.allowCreate ?? true;
  const attempt = context.onAttempt ?? (() => undefined);
  const desired = canonicalAddresses(spec.addresses);
  if (desired.length > MAX_WEBHOOK_ADDRESSES) {
    throw new Error(
      `${desired.length} addresses is over Helius's ${MAX_WEBHOOK_ADDRESSES} per webhook; the webhook was not changed, ` +
        "and the links it does not hold are turned every sweep",
    );
  }
  const body: WebhookBody = {
    webhookURL: spec.url,
    webhookType: "raw",
    accountAddresses: desired,
    transactionTypes: ["ANY"],
    authHeader: spec.authHeader,
    txnStatus: "all",
  };
  const listed = await client.list();
  const byUrl = listed.filter((webhook) => webhook.webhookURL === spec.url);
  const knownId = context.knownId ?? null;
  const matches = byUrl.length > 0 ? byUrl : listed.filter((webhook) => knownId !== null && webhook.webhookID === knownId);
  const found = matches[0];
  const fingerprint = (id: string): string => `${id}:${JSON.stringify(body)}`;
  if (found === undefined) {
    if (!allowCreate) {
      throw new Error("the webhook is missing, and the last attempt to change it failed less than ten minutes ago; it is not created again yet");
    }
    attempt();
    const created = await client.create(body);
    return {
      webhookID: created.webhookID,
      action: "created",
      reactivated: false,
      watched: desired,
      added: desired,
      gap: "the webhook did not exist; nothing was delivered before it was created",
      authConfirmed: true,
      edit: fingerprint(created.webhookID),
      stuck: null,
      active: created.active !== false,
      duplicates: 0,
      diff: null,
      editEcho: describeWebhook(created, body, { now: context.now }, "edit-answer"),
    };
  }
  const held = heldAddresses(found);
  // DESCRIBED, THEN JUDGED (describeWebhook says by which rules). What is
  // trusted there — the header or the addresses this process wrote, a masked
  // header whose ends are ours — no longer reads as "differs" on every look.
  const diff = describeWebhook(found, body, context, "list");
  context.onDiff?.(diff);
  const refused = diff.auth.verdict === "refused";
  // ONE RE-WRITE ON THE DELIVERIES' WORD ALONE, PER PROCESS. Refusals are
  // anybody's — a stranger's POST, another webhook on this URL with an old
  // header — so a PUT for every run of them is outside traffic spending 100
  // credits a time. After one, a "refused" header is reported, not re-sent; an
  // edit the addresses or the shape need still goes, and carries the header.
  const refusedAgain = refused && context.refusedEditSpent === true;
  const toEdit = diff.differs.filter((part) => !(part === "auth" && refusedAgain));
  const differs = toEdit.length > 0;
  const authDiffers = diff.auth.verdict === "differs" || refused;
  const duplicates = matches.length - 1;
  const refusedDetail =
    `deliveries to the receiver were refused 403 since this process last wrote the webhook's header — at least ${REFUSALS_TO_WITHDRAW} in a row, ` +
    "none accepted after them — and Helius's list does not show the header to compare; it is not sent again while this lasts, and a delivery " +
    "accepted (or a change in the discovered addresses) ends it. A stranger's POST is refused too" +
    (duplicates > 0 ? `, and so is any of the ${duplicates} other webhook(s) on the same URL that holds an old header` : "") +
    ": check the header the webhook holds on Helius";
  const gaps: string[] = [];
  let action: EnsureResult["action"] = "unchanged";
  // WHAT HELIUS IS TAKEN TO WATCH: the desired set unless the addresses truly
  // differ. Telling the doorbell "what the list shows" when the list does not
  // show addresses at all put every link in the "new" lane, and kept the next
  // sweep's sync due (its key never matched): a GET every 60 s.
  let watched: readonly string[] = diff.addresses.verdict === "differs" ? held : desired;
  let added: readonly string[] = [];
  let edit: string | null = null;
  let stuck: string | null = null;
  let authConfirmed = !authDiffers;
  let editEcho: WebhookDiff | null = null;
  // THE SAME EDIT, NEEDED AGAIN, IS AN EDIT HELIUS DID NOT KEEP. Sending it a
  // second time buys nothing but 100 credits; it is reported instead, as a
  // failed sync, until the discovered addresses or the secret change.
  if (differs && context.lastEdit !== undefined && context.lastEdit !== null && context.lastEdit === fingerprint(found.webhookID)) {
    // WHAT DIFFERS ON THE DELIVERIES' WORD ALONE IS SAID SO: the list itself
    // shows nothing Helius failed to keep, and "did not keep" sent the reader
    // to the wrong place (review, 2026-10-11).
    stuck =
      toEdit.length === 1 && toEdit[0] === "auth" && refused
        ? refusedDetail
        : "Helius did not keep the last edit of the webhook (the list still differs from what was sent); it is not sent again " +
          "until the discovered addresses or the secret change";
  } else if (differs && allowEdit) {
    attempt();
    // THE ANSWER IS A FREE DIAGNOSTIC: what Helius says it now holds, described
    // against what was sent, with no rule applied.
    const answer = await client.update(found.webhookID, body);
    editEcho = describeWebhook(answer, body, { now: context.now }, "edit-answer");
    action = "updated";
    watched = desired;
    const before = new Set(held);
    added = desired.filter((address) => !before.has(address));
    edit = fingerprint(found.webhookID);
    authConfirmed = true;
    if (refused) {
      gaps.push(
        `deliveries were refused 403 since this process last wrote the header (at least ${REFUSALS_TO_WITHDRAW} in a row, none accepted after them); ` +
          "if they were Helius's, it never resends them",
      );
    } else if (diff.auth.state === "different" && authDiffers) {
      gaps.push("Helius held another Authorization header, and every delivery until now was refused 403, which it never resends");
    }
    if (diff.shape.wrong.length > 0) gaps.push("the webhook was not a raw webhook for every transaction, failed ones included");
  } else if (differs) {
    action = "held";
  } else if (refusedAgain) {
    stuck = refusedDetail;
  }
  let reactivated = false;
  if (found.active === false) {
    if (!allowCreate) {
      throw new Error("the webhook is disabled, and the last attempt to change it failed less than ten minutes ago; it is not switched on yet");
    }
    attempt();
    await client.setActive(found.webhookID, true);
    reactivated = true;
    gaps.push("the webhook was disabled (Helius switches off an endpoint that fails too often), and nothing was delivered meanwhile");
  }
  return {
    webhookID: found.webhookID,
    action,
    reactivated,
    watched,
    added,
    gap: gaps.length === 0 ? null : gaps.join("; "),
    authConfirmed,
    edit,
    stuck,
    active: true,
    duplicates,
    diff,
    editEcho,
  };
}

/** Whether a sync is due this sweep, and whether it may edit. Pure, so the debounce is tested as a rule. */
export function syncDue(input: {
  readonly now: number;
  readonly lastCheckAt: number | null;
  /**
   * When the last create, PUT or PATCH was ATTEMPTED — answered or not. It was
   * the last SUCCESS, and a PUT Helius refused every time was sent again every
   * sweep: 60 an hour at 100 credits each (review, 2026-09-23).
   */
  readonly lastEditAt: number | null;
  /** The last sync threw: the list could not be read, or an edit was refused. */
  readonly lastFailed: boolean;
  /** The last create, PUT or PATCH failed (an edit refused, not a list unread). */
  readonly lastAttemptFailed: boolean;
  /** The webhook is stuck on this very address set: the edit it needs is the one Helius did not keep. */
  readonly stuck: boolean;
  /** The discovered addresses differ from what Helius was last seen holding. */
  readonly differs: boolean;
}): { readonly due: boolean; readonly allowEdit: boolean } {
  const allowEdit = input.lastEditAt === null || input.now - input.lastEditAt >= MIN_EDIT_INTERVAL_MS;
  // A FAILED LIST is looked at again next sweep; a FAILED EDIT waits for its
  // debounce — the GET before it buys nothing until the PUT may be sent again.
  if (input.lastFailed) return { due: !input.lastAttemptFailed || allowEdit, allowEdit };
  if (input.lastCheckAt === null) return { due: true, allowEdit };
  // STUCK IS NOT DUE EVERY SWEEP. Its addresses "differ" and its debounce has
  // long passed, so this line made it a GET every 60 s; nothing is sent until
  // the addresses or the secret change, and RECHECK_MS is soon enough to see
  // that Helius came round.
  if (input.differs && allowEdit && !input.stuck) return { due: true, allowEdit };
  return { due: input.now - input.lastCheckAt >= RECHECK_MS, allowEdit };
}

/** The webhook half of /status's doorbell block. Never the key, never the secret, never the whole id. */
export interface WebhookStatus {
  readonly managed: boolean;
  /** Why it is not managed, or what is wrong with it; null when all is well. */
  readonly reason: string | null;
  /** The last six characters of the webhook id: enough to tell two apart, not to address one. */
  readonly idSuffix: string | null;
  readonly addresses: number | null;
  readonly active: boolean | null;
  readonly lastAction: string | null;
  readonly lastSyncAt: string | null;
  readonly lastSyncError: string | null;
  readonly consecutiveFailures: number;
  /** The last look at the list, described: what differed and by which rule it was forgiven. Never the header. */
  readonly lastDiff: WebhookDiff | null;
  /** The answer to the last create or PUT, described with no rule applied. */
  readonly lastEditEcho: WebhookDiff | null;
  /** When the current run of failed syncs began; null while the last one succeeded. */
  readonly failingSince: string | null;
}

/** What a successful sync tells the doorbell. */
export interface SyncReport {
  /** What Helius holds now (Doorbell.setWatched). */
  readonly watched: ReadonlySet<string>;
  /** Addresses this sync put on the webhook: they ring, so their links are turned after the edit landed. */
  readonly added: readonly string[];
  /** Deliveries were certainly dropped before this sync (EnsureResult.gap): the next sweep is a full pass. */
  readonly gap: string | null;
  /** Helius is known to send the secret: a 403 from now on is a stranger, not a lost delivery. */
  readonly authConfirmed: boolean;
  readonly now: number;
}

export interface WebhookSyncOptions {
  /** Null when there is no API key: nothing is managed, and /status says why. */
  readonly client: HeliusWebhookClient | null;
  readonly url: string | null;
  readonly secret: Secret | null;
  /** Told after every successful sync (src/doorbell-wiring.ts hands it to the doorbell). */
  readonly onSynced: (report: SyncReport) => void;
  readonly log: (level: "info" | "warn", message: string, fields: Record<string, unknown>) => void;
  /**
   * Deliveries authenticated and refused since boot, and refused since the
   * last one authenticated (Doorbell.deliveryCounts). Compared with their count
   * at this process's last edit, they are the only outside word on whether
   * Helius sends the header this process wrote.
   */
  readonly deliveries?: () => DeliveryCounts;
}

/** What the doorbell counted (Doorbell.deliveryCounts). */
export interface DeliveryCounts {
  /** Transactions in authenticated deliveries, since boot. */
  readonly accepted: number;
  /** Deliveries refused 403, since boot: Helius's with another header, and anybody else's. */
  readonly rejected: number;
  /** Deliveries refused 403 since the last authenticated one (since boot, before one). */
  readonly rejectedSinceAccepted: number;
}

/**
 * Keeps the webhook in step, off the settlement path.
 *
 * FIRE AND FORGET, ONE AT A TIME. tick() starts a sync and returns; a sync
 * still in flight makes the next tick a no-op. A slow Helius API can delay the
 * webhook, never a settle.
 *
 * ONLY THE ACTING KEEPER MANAGES. Two instances overlap on every deploy; the
 * one holding the claim is the one whose view of the links is being acted on,
 * and one writer is the only way two writers never undo each other's edit.
 */
export class WebhookSync {
  readonly #options: WebhookSyncOptions;
  #inFlight = false;
  #lastCheckAt: number | null = null;
  /** When the last create, PUT or PATCH was attempted, and whether that attempt failed. */
  #lastAttemptAt: number | null = null;
  #lastAttemptFailed = false;
  #lastFailed = false;
  #confirmedKey: string | null = null;
  /** The address key the webhook is stuck on (EnsureResult.stuck), or null: not due every sweep while it stays. */
  #stuckKey: string | null = null;
  /** What this process knows about the webhook between syncs (EnsureContext). */
  #knownId: string | null = null;
  #writtenAuth: string | null = null;
  #writtenKey: string | null = null;
  #lastEdit: string | null = null;
  /** The deliveries counted at this process's last successful edit; null before one. */
  #deliveriesAtEdit: DeliveryCounts | null = null;
  /** Whether a look since the last edit saw the list holding addresses (DescribeContext.listedSinceEdit). */
  #listedSinceEdit = false;
  /** Whether this process already re-wrote the webhook over a "refused" header (EnsureContext.refusedEditSpent). */
  #refusedEditSpent = false;
  /** The current run of failures: when it began, when it last failed, and what that last failing look saw. */
  #failingSince: number | null = null;
  #lastFailureAt: number | null = null;
  #lastFailureDiff: WebhookDiff | null = null;
  #status: WebhookStatus;

  /** Whether the webhook is managed at all here: a key, a URL and a secret. The acting keeper then runs it. */
  get manageable(): boolean {
    return this.#options.secret !== null && this.#options.client !== null && this.#options.url !== null;
  }

  constructor(options: WebhookSyncOptions) {
    this.#options = options;
    this.#status = {
      managed: false,
      reason: this.#unmanagedReason(false) ?? "no sweep has run yet",
      idSuffix: null,
      addresses: null,
      active: null,
      lastAction: null,
      lastSyncAt: null,
      lastSyncError: null,
      consecutiveFailures: 0,
      lastDiff: null,
      lastEditEcho: null,
      failingSince: null,
    };
  }

  /**
   * What deliveries since this process's last edit say about the header it
   * wrote (AuthEvidence), and whether one was accepted at all (heard).
   *
   * READ AFRESH AT EVERY LOOK. "Proven" was "one accepted since the edit", and
   * stayed so until the next edit however many 403s followed; "refused" was any
   * 403 at all, a stranger's included. Now it is REFUSALS_TO_WITHDRAW refused
   * in a row after BOTH the edit and the last accepted delivery — the shorter
   * of the two runs the counts give — and an accepted delivery ends the run.
   */
  #evidence(): { readonly evidence: AuthEvidence; readonly heard: boolean } {
    const at = this.#deliveriesAtEdit;
    const now = this.#options.deliveries?.();
    if (at === null || now === undefined) return { evidence: "none", heard: false };
    const heard = now.accepted > at.accepted;
    const refusedInARow = Math.min(now.rejected - at.rejected, now.rejectedSinceAccepted);
    if (refusedInARow >= REFUSALS_TO_WITHDRAW) return { evidence: "refused", heard };
    return { evidence: heard ? "proven" : "none", heard };
  }

  #unmanagedReason(acting: boolean): string | null {
    if (this.#options.secret === null) return "the doorbell is off";
    if (this.#options.client === null) return "no Helius API key (SIP_SOLANA_HELIUS_API_KEY, or a helius-rpc.com endpoint in SIP_SOLANA_RPC_URLS)";
    if (this.#options.url === null) return "no public receiver URL (SIP_SOLANA_DOORBELL_URL, or RAILWAY_PUBLIC_DOMAIN)";
    if (!acting) return "this instance is not the acting keeper; the one holding the claim manages the webhook";
    return null;
  }

  /** Starts a sync when one is due. Returns the running sync, or null when none was started. Never rejects. */
  tick(input: { readonly acting: boolean; readonly addresses: readonly string[]; readonly now: number }): Promise<void> | null {
    const unmanaged = this.#unmanagedReason(input.acting);
    if (unmanaged !== null) {
      this.#status = { ...this.#status, managed: false, reason: unmanaged };
      return null;
    }
    if (this.#inFlight) return null;
    const desired = canonicalAddresses(input.addresses);
    const key = desired.join(",");
    const { due, allowEdit } = syncDue({
      now: input.now,
      lastCheckAt: this.#lastCheckAt,
      lastEditAt: this.#lastAttemptAt,
      lastFailed: this.#lastFailed,
      lastAttemptFailed: this.#lastAttemptFailed,
      stuck: this.#stuckKey === key,
      differs: key !== this.#confirmedKey,
    });
    // URGENT CHANGES — a missing webhook, a disabled one — are not held for the
    // debounce, except after an attempt that FAILED inside it, and except a
    // webhook this process already made: one that vanished is re-created at
    // most once per interval, so a list that lags a create cannot breed copies.
    const recentFailure = this.#lastAttemptFailed && this.#lastAttemptAt !== null && input.now - this.#lastAttemptAt < MIN_EDIT_INTERVAL_MS;
    const allowCreate = !recentFailure && (this.#knownId === null || allowEdit);
    // An unmanaged reason no longer applies; a managed one stands until the next sync says otherwise.
    if (!this.#status.managed) this.#status = { ...this.#status, managed: true, reason: null };
    if (!due) return null;
    this.#inFlight = true;
    // NEVER REJECTS. #run catches its own failures, but its log callback is the
    // caller's; a rejection here would be unhandled, and this process's
    // unhandledRejection trap exits the keeper.
    return this.#run(desired, allowEdit, allowCreate, input.now)
      .catch(() => undefined)
      .finally(() => {
        this.#inFlight = false;
      });
  }

  async #run(desired: readonly string[], allowEdit: boolean, allowCreate: boolean, now: number): Promise<void> {
    const client = this.#options.client!;
    let attempted = false;
    let failure: string | null = null;
    let diff: WebhookDiff | null = null;
    try {
      const authHeader = this.#options.secret!.reveal();
      const { evidence, heard } = this.#evidence();
      const result = await ensureWebhook(client, { url: this.#options.url!, authHeader, addresses: desired }, allowEdit, {
        knownId: this.#knownId,
        writtenAuth: this.#writtenAuth,
        writtenKey: this.#writtenKey,
        authEvidence: evidence,
        heardSinceEdit: heard,
        listedSinceEdit: this.#listedSinceEdit,
        refusedEditSpent: this.#refusedEditSpent,
        lastEdit: this.#lastEdit,
        allowCreate,
        now,
        onAttempt: () => {
          attempted = true;
          this.#lastAttemptAt = now;
        },
        onDiff: (described) => {
          diff = described;
        },
      });
      if (attempted) this.#lastAttemptFailed = false;
      this.#lastCheckAt = now;
      this.#lastFailed = false;
      this.#knownId = result.webhookID;
      if (result.edit !== null) {
        this.#writtenAuth = authHeader;
        this.#writtenKey = desired.join(",");
        this.#lastEdit = result.edit;
        // EVIDENCE COUNTS FROM HERE: only what was delivered after this edit says anything about it.
        this.#deliveriesAtEdit = this.#options.deliveries?.() ?? null;
        // The look was BEFORE the edit: what it listed says nothing about what the edit wrote.
        this.#listedSinceEdit = false;
        if (result.diff?.auth.verdict === "refused") this.#refusedEditSpent = true;
      } else {
        if (result.diff !== null && result.diff.addresses.listed && result.diff.addresses.held > 0) this.#listedSinceEdit = true;
        // CONVERGED: whatever was last sent is what Helius holds.
        if (result.action === "unchanged" && result.stuck === null) this.#lastEdit = null;
      }
      this.#stuckKey = result.stuck !== null ? desired.join(",") : null;
      this.#confirmedKey = canonicalAddresses(result.watched).join(",");
      this.#status = { ...this.#status, lastDiff: result.diff, lastEditEcho: result.editEcho ?? this.#status.lastEditEcho };
      this.#options.onSynced({ watched: new Set(result.watched), added: result.added, gap: result.gap, authConfirmed: result.authConfirmed, now });
      if (result.stuck !== null) {
        // STUCK IS A FAILURE, NOT A THROW. A throw set #lastFailed, and a failed
        // sync is due again next sweep: a GET every 60 s for a webhook nothing
        // will be sent to. It is counted (and pages) below, looked at every
        // RECHECK_MS, and due at once only when the addresses change.
        failure = result.stuck;
      } else {
        const held =
          result.action === "held"
            ? `the webhook holds ${result.watched.length} addresses and ${desired.length} are discovered; the edit waits for the debounce, and the links it lacks are turned every sweep`
            : null;
        const duplicates = result.duplicates > 0 ? `${result.duplicates} other webhook(s) point at the same URL and deliver twice` : null;
        this.#failingSince = null;
        this.#lastFailureAt = null;
        this.#lastFailureDiff = null;
        this.#status = {
          managed: true,
          reason: [held, duplicates].filter((part): part is string => part !== null).join("; ") || null,
          idSuffix: result.webhookID.slice(-6),
          addresses: result.watched.length,
          active: result.active,
          lastAction: result.reactivated ? `${result.action}, reactivated` : result.action,
          lastSyncAt: new Date(now).toISOString(),
          lastSyncError: null,
          consecutiveFailures: 0,
          lastDiff: this.#status.lastDiff,
          lastEditEcho: this.#status.lastEditEcho,
          failingSince: null,
        };
        if (result.action !== "unchanged" || result.reactivated) {
          this.#options.log("info", "helius webhook synced", {
            action: this.#status.lastAction,
            addresses: result.watched.length,
            idSuffix: this.#status.idSuffix,
            diff: result.diff === null ? null : summarizeDiff(result.diff),
            echo: result.editEcho === null ? null : summarizeDiff(result.editEcho),
          });
        }
      }
    } catch (error) {
      this.#lastFailed = true;
      if (attempted) this.#lastAttemptFailed = true;
      // HeliusWebhookError carries no URL by construction; anything else is
      // reduced to its name, so nothing unexpected can carry one out either.
      failure = error instanceof HeliusWebhookError || (error instanceof Error && error.name === "Error") ? error.message : `${(error as Error)?.name ?? "error"}`;
    }
    // OUTSIDE THE TRY, so a logger that throws here is not caught and counted a
    // second time; tick's .catch swallows it.
    if (failure !== null) this.#recordFailure(failure, now, diff);
  }

  /** One failed sync: counted, dated, logged with what the look saw (when it got that far). */
  #recordFailure(detail: string, now: number, diff: WebhookDiff | null): void {
    this.#failingSince ??= now;
    this.#lastFailureAt = now;
    this.#lastFailureDiff = diff;
    const failingSince = new Date(this.#failingSince).toISOString();
    this.#status = {
      ...this.#status,
      managed: true,
      reason: "the last sync failed",
      lastSyncError: detail,
      consecutiveFailures: this.#status.consecutiveFailures + 1,
      lastDiff: diff ?? this.#status.lastDiff,
      failingSince,
    };
    this.#options.log("warn", "helius webhook sync failed", {
      detail,
      consecutiveFailures: this.#status.consecutiveFailures,
      failingSince,
      diff: diff === null ? null : summarizeDiff(diff),
    });
  }

  status(): WebhookStatus {
    return this.#status;
  }

  /**
   * doorbell-sync: warned once the failures reach SYNC_FAILURE_ALERT_STREAK in
   * a row, CRITICAL once they have gone on for SYNC_FAILURE_CRITICAL_AFTER_MS,
   * cleared by a success.
   *
   * ONE KEY, TWO SEVERITIES, like not-acting (bin/keeper.mts): the alerter lets
   * an escalation through its dedup window, so the page is not swallowed by
   * the warn sent minutes before. A warn alone reaches nobody by default
   * (Telegram forwards criticals), and the webhook was stuck for hours with
   * nobody told.
   */
  syncAlert(): { readonly fire: { key: string; severity: "warn" | "critical"; title: string; detail: string } | null; readonly clear: boolean } {
    const { consecutiveFailures, lastSyncError } = this.#status;
    if (consecutiveFailures === 0) return { fire: null, clear: true };
    if (consecutiveFailures < SYNC_FAILURE_ALERT_STREAK) return { fire: null, clear: false };
    const lastedMs = this.#failingSince === null || this.#lastFailureAt === null ? 0 : this.#lastFailureAt - this.#failingSince;
    const look = this.#lastFailureDiff === null ? "" : ` Last look: ${summarizeDiff(this.#lastFailureDiff)}.`;
    if (lastedMs >= SYNC_FAILURE_CRITICAL_AFTER_MS) {
      return {
        fire: {
          key: DOORBELL_SYNC_ALERT_KEY,
          severity: "critical",
          title: "The keeper's Helius webhook has been out of step for an hour",
          detail:
            `${consecutiveFailures} syncs in a row failed over ${Math.floor(lastedMs / 60_000)} min: ${lastSyncError ?? "unknown"}.${look} ` +
            "The links the webhook lacks are turned every sweep and a deaf doorbell turns everyone, so nothing is missed — " +
            "but the webhook on Helius needs a look now (/status → doorbell.webhook.lastDiff).",
        },
        clear: false,
      };
    }
    return {
      fire: {
        key: DOORBELL_SYNC_ALERT_KEY,
        severity: "warn",
        title: "The keeper cannot keep its Helius webhook in step",
        detail:
          `${consecutiveFailures} syncs in a row failed: ${lastSyncError ?? "unknown"}.${look} New links are turned every sweep until ` +
          "the webhook holds them, so nothing is missed — but the webhook on Helius should be checked.",
      },
      clear: false,
    };
  }
}
