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

interface FiredState {
  firedAt: number;
  count: number;
}

const RANK: Record<AlertSeverity, number> = { warn: 0, critical: 1 };

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
  const post =
    options.post ??
    (async (url: string, body: string) => {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      // A DELETED OR RATE-LIMITED WEBHOOK IS NOT SILENCE. fetch resolves on a
      // 404 and on a 429, so without this the alert vanishes without even the
      // "alert webhook failed" warning below. The status code is all that
      // leaves: the URL is a credential and the body may hold anything.
      if (!response.ok) throw new Error(`webhook answered ${response.status}`);
    });

  const sanitize = options.sanitize ?? ((text: string): string | null => text);

  const fired = new Map<string, FiredState>();

  return {
    fire(alert: Alert): void {
      const at = now();
      const previous = fired.get(alert.key);
      if (previous !== undefined && at - previous.firedAt < repeatAfterMs) {
        previous.count += 1;
        return;
      }
      const count = (previous?.count ?? 0) + 1;
      fired.set(alert.key, { firedAt: at, count });

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
      void post(webhook.reveal(), payload).catch(() => {
        log("warn", "[WARN] alert webhook failed; the alert above was logged only");
      });
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
