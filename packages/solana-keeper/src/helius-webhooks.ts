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
export const DOORBELL_SYNC_ALERT_KEY = "doorbell-sync";
const EXCERPT_CHARS = 200;

export interface HeliusWebhook {
  readonly webhookID: string;
  readonly webhookURL: string;
  readonly webhookType?: string;
  readonly accountAddresses?: readonly string[];
  readonly transactionTypes?: readonly string[];
  readonly authHeader?: string;
  readonly txnStatus?: string;
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

const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((value, index) => value === b[index]);

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
  /** Set when the edit needed is the one this process already made and Helius did not keep; nothing was sent. */
  readonly stuck: string | null;
  readonly active: boolean;
  /** Other webhooks on the same URL, left alone: never created by this code, never deleted by it. */
  readonly duplicates: number;
}

/** What this process remembers between two ensureWebhook calls. All optional: a bare call is a first one. */
export interface EnsureContext {
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
  /** The fingerprint of this process's last successful edit (EnsureResult.edit). */
  readonly lastEdit?: string | null;
  /** Whether a create or a reactivation may be sent. Default true. */
  readonly allowCreate?: boolean;
  /** Called right before every create, PUT or PATCH: the attempt, whatever its answer. */
  readonly onAttempt?: () => void;
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
    };
  }
  const held = canonicalAddresses(found.accountAddresses ?? []);
  // THE HEADER HELIUS SENDS, when it can be known: the list's, or the one this
  // process wrote to this very webhook. Undefined = unknown, which differs.
  const auth = found.authHeader ?? (found.webhookID === knownId ? (context.writtenAuth ?? undefined) : undefined);
  const wrongShape =
    (found.webhookType !== undefined && found.webhookType !== "raw") ||
    (found.transactionTypes !== undefined && !sameList([...found.transactionTypes], ["ANY"])) ||
    (found.txnStatus !== undefined && found.txnStatus !== "all");
  const differs = !sameList(held, desired) || auth !== spec.authHeader || wrongShape;
  const gaps: string[] = [];
  let action: EnsureResult["action"] = "unchanged";
  let watched = held;
  let added: readonly string[] = [];
  let edit: string | null = null;
  let stuck: string | null = null;
  let authConfirmed = auth === spec.authHeader;
  // THE SAME EDIT, NEEDED AGAIN, IS AN EDIT HELIUS DID NOT KEEP. Sending it a
  // second time buys nothing but 100 credits; it is reported instead, as a
  // failed sync, until the discovered addresses or the secret change.
  if (differs && context.lastEdit !== undefined && context.lastEdit !== null && context.lastEdit === fingerprint(found.webhookID)) {
    stuck =
      "Helius did not keep the last edit of the webhook (the list still differs from what was sent); it is not sent again " +
      "until the discovered addresses or the secret change";
  } else if (differs && allowEdit) {
    attempt();
    await client.update(found.webhookID, body);
    action = "updated";
    watched = desired;
    const before = new Set(held);
    added = desired.filter((address) => !before.has(address));
    edit = fingerprint(found.webhookID);
    authConfirmed = true;
    if (auth !== undefined && auth !== spec.authHeader) {
      gaps.push("Helius held another Authorization header, and every delivery until now was refused 403, which it never resends");
    }
    if (wrongShape) gaps.push("the webhook was not a raw webhook for every transaction, failed ones included");
  } else if (differs) {
    action = "held";
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
    duplicates: matches.length - 1,
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
  readonly lastFailed: boolean;
  /** The discovered addresses differ from what Helius was last seen holding. */
  readonly differs: boolean;
}): { readonly due: boolean; readonly allowEdit: boolean } {
  const allowEdit = input.lastEditAt === null || input.now - input.lastEditAt >= MIN_EDIT_INTERVAL_MS;
  if (input.lastCheckAt === null || input.lastFailed) return { due: true, allowEdit };
  if (input.differs && allowEdit) return { due: true, allowEdit };
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
  /** What this process knows about the webhook between syncs (EnsureContext). */
  #knownId: string | null = null;
  #writtenAuth: string | null = null;
  #lastEdit: string | null = null;
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
    };
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
    try {
      const authHeader = this.#options.secret!.reveal();
      const result = await ensureWebhook(client, { url: this.#options.url!, authHeader, addresses: desired }, allowEdit, {
        knownId: this.#knownId,
        writtenAuth: this.#writtenAuth,
        lastEdit: this.#lastEdit,
        allowCreate,
        onAttempt: () => {
          attempted = true;
          this.#lastAttemptAt = now;
        },
      });
      if (attempted) this.#lastAttemptFailed = false;
      this.#lastCheckAt = now;
      this.#lastFailed = false;
      this.#knownId = result.webhookID;
      if (result.edit !== null) {
        this.#writtenAuth = authHeader;
        this.#lastEdit = result.edit;
      } else if (result.action === "unchanged" && result.stuck === null) {
        // CONVERGED: whatever was last sent is what Helius holds.
        this.#lastEdit = null;
      }
      this.#confirmedKey = canonicalAddresses(result.watched).join(",");
      this.#options.onSynced({ watched: new Set(result.watched), added: result.added, gap: result.gap, authConfirmed: result.authConfirmed, now });
      if (result.stuck !== null) throw new Error(result.stuck);
      const held =
        result.action === "held"
          ? `the webhook holds ${result.watched.length} addresses and ${desired.length} are discovered; the edit waits for the debounce, and the links it lacks are turned every sweep`
          : null;
      const duplicates = result.duplicates > 0 ? `${result.duplicates} other webhook(s) point at the same URL and deliver twice` : null;
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
      };
      if (result.action !== "unchanged" || result.reactivated) {
        this.#options.log("info", "helius webhook synced", {
          action: this.#status.lastAction,
          addresses: result.watched.length,
          idSuffix: this.#status.idSuffix,
        });
      }
    } catch (error) {
      this.#lastFailed = true;
      if (attempted) this.#lastAttemptFailed = true;
      // HeliusWebhookError carries no URL by construction; anything else is
      // reduced to its name, so nothing unexpected can carry one out either.
      const detail = error instanceof HeliusWebhookError || (error instanceof Error && error.name === "Error") ? error.message : `${(error as Error)?.name ?? "error"}`;
      this.#status = {
        ...this.#status,
        managed: true,
        reason: "the last sync failed",
        lastSyncError: detail,
        consecutiveFailures: this.#status.consecutiveFailures + 1,
      };
      this.#options.log("warn", "helius webhook sync failed", { detail, consecutiveFailures: this.#status.consecutiveFailures });
    }
  }

  status(): WebhookStatus {
    return this.#status;
  }

  /** doorbell-sync: warned once the failures reach SYNC_FAILURE_ALERT_STREAK in a row, cleared by a success. */
  syncAlert(): { readonly fire: { key: string; severity: "warn"; title: string; detail: string } | null; readonly clear: boolean } {
    const { consecutiveFailures, lastSyncError } = this.#status;
    if (consecutiveFailures === 0) return { fire: null, clear: true };
    if (consecutiveFailures < SYNC_FAILURE_ALERT_STREAK) return { fire: null, clear: false };
    return {
      fire: {
        key: DOORBELL_SYNC_ALERT_KEY,
        severity: "warn",
        title: "The keeper cannot keep its Helius webhook in step",
        detail:
          `${consecutiveFailures} syncs in a row failed: ${lastSyncError ?? "unknown"}. New links are turned every sweep until ` +
          "the webhook holds them, so nothing is missed — but the webhook on Helius should be checked.",
      },
      clear: false,
    };
  }
}
