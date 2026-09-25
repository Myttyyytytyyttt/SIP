// Telling a human when savings stop.
//
// Ported from Nuvem's solana-lab keeper (keeper/src/alerts.ts), which was
// itself a copy of the EVM keeper's. Two things changed, both about secrets:
// the webhook URL arrives as a `Secret` and is revealed only inside the POST,
// and there is no default log sink — every alert line goes through the
// caller's redacting logger, because a sink that writes to stdout directly is
// a line the redactor never sees.
//
// Every failure this system has actually had looked healthy from outside. A
// supervisor reported "1 keeper running" while every child crash-looped on a
// missing module. A keeper logged ordinary ticks while refusing to scan and
// falling further behind every block. A whole deployment deferred every
// settlement against a stale attester. In each case the chain was fine, the
// process was up, and the only symptom was an ABSENCE — money that did not
// arrive.
//
// So the alertable conditions here are mostly absences, and the design rule is
// that silence must never be the healthy state.
//
// DEDUPLICATED, BECAUSE AN ALERT THAT REPEATS IS AN ALERT THAT GETS MUTED. A
// condition fires once and then stays quiet until it clears or the repeat window
// passes. The counter is reported when it re-fires, so a long outage still reads
// as a long outage rather than as a single old message.

import type { Secret } from "@sip/solana-log";

export type AlertSeverity = "warn" | "critical";

export interface Alert {
  /** Stable identity for deduplication. Same condition => same key. */
  readonly key: string;
  readonly severity: AlertSeverity;
  readonly title: string;
  readonly detail: string;
  readonly context?: Record<string, unknown>;
  /**
   * A NOTICE, NOT A CONDITION TO CHASE: sent the first time its key fires and
   * not again while the key stands — no 30-minute repeat. clear() rearms it, and
   * an escalation to a higher severity still breaks through.
   */
  readonly once?: boolean;
}

/**
 * Where an alert goes, and in what shape. Slack and Discord take the generic
 * body; Telegram's bot API needs the chat in the body and renders buttons only
 * from `reply_markup`, so it gets its own envelope.
 */
export type AlertDestination = { readonly kind: "webhook" } | { readonly kind: "telegram"; readonly chatId: string };

/** Addresses an operator would open next. Public data only: these become buttons. */
export interface AlertLinks {
  readonly statusUrl?: string | null;
}

export interface Alerter {
  fire(alert: Alert): void;
  /** Whether the destination is accepting. For /status, which must not restate env vars. */
  delivery(): AlertDelivery;
  /** Marks a condition resolved, so its next occurrence alerts again. */
  clear(key: string): void;
}

export interface AlerterOptions {
  /**
   * POST target. Slack, Discord and most incident tools accept this shape. A
   * `Secret`, because a webhook URL IS its credential: whoever reads it can
   * post into the channel an operator trusts to wake them.
   */
  readonly webhookUrl?: Secret | null;
  /** How long a fired condition stays quiet before repeating. */
  readonly repeatAfterMs?: number;
  /**
   * The lowest severity that LEAVES THE BOX. Below it an alert is still
   * deduplicated and still logged — it just does not wake anybody. The filter
   * sits after the dedup on purpose: a resting warn keeps its once-per-window
   * line in the log instead of one per sweep.
   */
  readonly minSeverity?: AlertSeverity;
  /** Defaults to the generic webhook shape. */
  readonly destination?: AlertDestination;
  /** Turned into buttons on Telegram and into a `links` field elsewhere. */
  readonly links?: AlertLinks;
  /** Injected for tests. */
  readonly now?: () => number;
  readonly post?: (url: string, body: string) => Promise<void>;
  /** Always called, webhook or not, so alerts are in the log even unconfigured. */
  readonly log: (severity: AlertSeverity, line: string) => void;
  /**
   * The last thing applied to the webhook body before it leaves the process:
   * returns the text to send, or null when it cannot be cleaned.
   *
   * WHY THE WEBHOOK NEEDS ITS OWN. `log` above hands the line to the caller's
   * redacting logger, which scrubs it and drops it if a byte run survives. The
   * body below is built HERE and POSTed raw, so nothing in that path has ever
   * seen a redactor — and a `detail` carries whatever an exception's text
   * carries. The keeper wires this to the same pair its log lines pass
   * (scrubbedForExport, src/keeper-log.ts). Left out, the body is sent as built,
   * which is what a caller with no secrets to lose wants.
   */
  readonly sanitize?: (text: string) => string | null;
}

/**
 * Whether the box is actually receiving. A LABEL BUILT FROM ENV VARS SAYS
 * NOTHING: "telegram: critical and above" reads the same whether ten thousand
 * messages were accepted or every one was refused 403 because the bot was
 * blocked. This is the counter that turns that line into evidence.
 */
export interface AlertDelivery {
  readonly sent: number;
  readonly failed: number;
  /** Reset by any success. Above zero, the destination is not working NOW. */
  readonly consecutiveFailures: number;
  /** The last refusal, as a status code or a transport reason. Never the URL. */
  readonly lastError: string | null;
  readonly lastSentAt: number | null;
}

interface FiredState {
  firedAt: number;
  count: number;
  /** THE SEVERITY THAT WAS ACTUALLY REPORTED, so a warn cannot mute the critical that replaces it. */
  severity: AlertSeverity;
}

/**
 * The send itself. EXPORTED so that bin/alert-test.mts proves the destination
 * with the same call the keeper makes at three in the morning, instead of a
 * copy of it that can drift.
 */
export async function postJson(url: string, body: string): Promise<void> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    // A HANG IS WORSE THAN A REFUSAL, because the condition is already marked
    // fired: without this, a connection that never answers holds the alert for
    // Node's own timeout — minutes — and the next identical condition inside the
    // repeat window is deduplicated against a message nobody ever received.
    signal: AbortSignal.timeout(15_000),
  });
  // A DELETED OR RATE-LIMITED WEBHOOK IS NOT SILENCE. fetch resolves on a 404
  // and on a 429, so without this the alert vanishes without even the "alert
  // webhook failed" warning below. The status code is all that leaves: the URL
  // is a credential and the body may hold anything.
  if (!response.ok) throw new Error(`webhook answered ${response.status}`);
}

const RANK: Record<AlertSeverity, number> = { warn: 0, critical: 1 };

/**
 * The /status alert line. PURE, so it can be pinned: the line an operator reads
 * to decide whether the box works is worth a test, and bin/keeper.mts —
 * where it is rendered — has none.
 *
 * Never the URL and never the chat: /status is public and unauthenticated, and a
 * webhook URL or a bot token is a posting credential for that channel.
 */
export function describeDelivery(
  channel: "webhook" | "telegram",
  minSeverity: AlertSeverity,
  delivery: AlertDelivery,
): string {
  const head = `${channel}: ${minSeverity} and above`;
  if (delivery.consecutiveFailures > 0) {
    return `${head} — NOT ARRIVING: ${delivery.consecutiveFailures} refused in a row, last: ${delivery.lastError ?? "no answer"}`;
  }
  if (delivery.sent > 0) return `${head} — ${delivery.sent} delivered`;
  return `${head} — nothing sent yet`;
}

/** Public addresses only. A button is a URL anyone who can read the channel can open. */
function buttonsFor(alert: Alert, links: AlertLinks): { readonly text: string; readonly url: string }[] {
  const out: { text: string; url: string }[] = [];
  if (typeof links.statusUrl === "string" && links.statusUrl !== "") {
    out.push({ text: "Keeper status", url: links.statusUrl });
  }
  const wallet = alert.context?.["wallet"];
  const vault = alert.context?.["vault"];
  if (typeof wallet === "string") out.push({ text: "Trading wallet", url: `https://solscan.io/account/${wallet}` });
  if (typeof vault === "string") out.push({ text: "Vault", url: `https://solscan.io/account/${vault}` });
  return out;
}

export function createAlerter(options: AlerterOptions): Alerter {
  const repeatAfterMs = options.repeatAfterMs ?? 30 * 60 * 1000;
  const minSeverity = options.minSeverity ?? "warn";
  const destination: AlertDestination = options.destination ?? { kind: "webhook" };
  const links = options.links ?? {};
  const now = options.now ?? (() => Date.now());
  const log = options.log;
  const post = options.post ?? postJson;

  const sanitize = options.sanitize ?? ((text: string): string | null => text);

  const fired = new Map<string, FiredState>();

  // WHAT THE BOX ACTUALLY DID WITH WHAT WE HANDED IT. The send is detached on
  // purpose — an unreachable alert endpoint must never take down the thing it
  // is monitoring — and until now that meant its outcome reached nothing at all.
  let sent = 0;
  let failed = 0;
  let consecutiveFailures = 0;
  let lastError: string | null = null;
  let lastSentAt: number | null = null;

  return {
    fire(alert: Alert): void {
      const at = now();
      const previous = fired.get(alert.key);
      // A CONDITION THAT GETS WORSE IS NOT A REPEAT OF ITSELF. crank-low is one
      // key whose severity is computed from the balance (bin/keeper.mts): it
      // warns under 0.02 SOL and pages under 0.005. Draining takes minutes, so
      // the critical landed inside the warn's 30-minute window and was dropped
      // whole — not logged, not sent — and clear() only runs if the balance
      // climbs back, which a draining crank never does. An ESCALATION breaks
      // through; a de-escalation is still a repeat, because nobody needs paging
      // to be told a thing got better.
      const escalated = previous !== undefined && RANK[alert.severity] > RANK[previous.severity];
      if (previous !== undefined && !escalated && (alert.once === true || at - previous.firedAt < repeatAfterMs)) {
        previous.count += 1;
        return;
      }
      const count = (previous?.count ?? 0) + 1;
      fired.set(alert.key, { firedAt: at, count, severity: alert.severity });

      const repeated = count > 1 ? ` (x${count})` : "";
      const line = `[${alert.severity.toUpperCase()}] ${alert.title}${repeated} — ${alert.detail}`;
      log(alert.severity, line);

      const webhook = options.webhookUrl;
      if (webhook === undefined || webhook === null) return;
      // BELOW THE THRESHOLD IT STAYS IN THE LOG. Deduplicated above, logged
      // above, and not sent: the operator asked to be woken by criticals only.
      if (RANK[alert.severity] < RANK[minSeverity]) return;
      const buttons = buttonsFor(alert, links);
      const envelope = (text: string, extra: Record<string, unknown>): string =>
        destination.kind === "telegram"
          ? JSON.stringify({
              chat_id: destination.chatId,
              text,
              disable_web_page_preview: true,
              // One per row: a phone renders them as a stack of full-width taps.
              ...(buttons.length > 0 ? { reply_markup: { inline_keyboard: buttons.map((b) => [b]) } } : {}),
            })
          : JSON.stringify({ text, ...extra, ...(buttons.length > 0 ? { links: buttons } : {}) });
      const body = envelope(line, {
        // `text` is what Slack and Discord render; the rest is for anything that
        // parses. Both are sent so one payload works everywhere.
        severity: alert.severity,
        key: alert.key,
        title: alert.title,
        detail: alert.detail,
        occurrences: count,
        ...alert.context,
      });
      // THE NETS THE LOG LINE ALREADY PASSED, ON THE WAY OFF THE BOX. `log`
      // above went through the caller's redacting logger; this body did not, and
      // `detail` holds whatever an exception's text holds.
      let payload = sanitize(body);
      if (payload === null) {
        // SILENCE IS THE ONE OUTCOME THIS FILE EXISTS TO PREVENT. So the alert
        // still goes out and only its words stay behind: which condition fired,
        // how often, and how bad — enough to send a human to /status, where the
        // detail belongs anyway.
        log("warn", `[WARN] an alert's text did not pass the redactor and was withheld from the webhook (${alert.key})`);
        payload = sanitize(
          envelope(
            `[${alert.severity.toUpperCase()}] ${alert.key}${repeated} — withheld: this alert's text did not pass the keeper's redactor. Read /status.`,
            { severity: alert.severity, key: alert.key, occurrences: count, withheld: true },
          ),
        );
      }
      // Not even the key came back clean: nothing leaves, and the log has it.
      if (payload === null) return;
      // Never awaited and never allowed to throw: an unreachable alerting
      // endpoint must not take down the thing it is monitoring. The failure
      // line carries no detail on purpose — a fetch error names the URL.
      void post(webhook.reveal(), payload)
        .then(() => {
          sent += 1;
          consecutiveFailures = 0;
          lastError = null;
          lastSentAt = now();
        })
        .catch((error: unknown) => {
          failed += 1;
          consecutiveFailures += 1;
          // THE STATUS CODE IS THE DIAGNOSIS: 403 is a bot that was blocked or
          // never spoken to, 401 a rotated token, 400 a wrong chat — three
          // different fixes that used to produce one identical line. postJson
          // already computed it and the old catch threw it away. Nothing but
          // the reason leaves: the URL is a credential, and both the log sink
          // and /status scrub it besides.
          lastError = (error instanceof Error ? error.message : "no answer").slice(0, 200);
          log("warn", `[WARN] alert webhook failed (${lastError}); the alert above was logged only`);
        });
    },

    delivery(): AlertDelivery {
      return { sent, failed, consecutiveFailures, lastError, lastSentAt };
    },

    clear(key: string): void {
      fired.delete(key);
    },
  };
}

/**
 * A watchdog for the condition that has no event: nothing happening.
 *
 * Every other alert here is raised by something going wrong. This one fires when
 * NOTHING goes anything — a keeper that stopped ticking, a sweep that stopped
 * sweeping. It is the only alert that can catch a process wedged rather than
 * crashed, which is the failure mode that hides longest.
 */
export function createHeartbeat(input: {
  readonly alerter: Alerter;
  readonly name: string;
  readonly silenceMs: number;
  readonly now?: () => number;
}): { beat: () => void; check: () => void } {
  const now = input.now ?? (() => Date.now());
  let last = now();

  return {
    beat(): void {
      last = now();
      input.alerter.clear(`silent:${input.name}`);
    },
    check(): void {
      const quietFor = now() - last;
      if (quietFor < input.silenceMs) return;
      input.alerter.fire({
        key: `silent:${input.name}`,
        severity: "critical",
        title: `${input.name} has gone quiet`,
        detail:
          `No progress for ${Math.round(quietFor / 1000)}s. The process may be up and wedged, ` +
          "which produces no error of its own — savings stop with nothing in the log.",
        context: { quietForMs: quietFor },
      });
    },
  };
}
