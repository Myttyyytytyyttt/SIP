// What an alert carries OFF the box.
//
// createAlerter logs its line through the caller's redacting logger and then
// builds a JSON body of its own and POSTs it. That second path has never seen a
// redactor: `detail` and `context` went to Slack or Discord exactly as the
// caller wrote them. The keeper's own logger sink wraps every line in
// withoutByteRuns — the net whose stated purpose is a key nobody registered,
// "printed as numbers by a library, or a number[] copy of a local signer" — and
// that net did not exist on the webhook path at all.
//
// It matters more since a wallet turn that THROWS started escalating: any
// exception from a settle or an invest turn — the SDK's, anchor's, a driver's —
// now reaches an alert `detail`, and an exception's text carries whatever it
// carries. No network: `post` is a function that appends to an array.

import { Keypair } from "@solana/web3.js";
import { Redactor, Secret } from "@sip/solana-log";
import { describe, expect, it } from "vitest";
import { createAlerter, describeDelivery, type Alert, type AlertSeverity } from "../src/alerts.js";
import { scrubbedForExport } from "../src/keeper-log.js";

/** Throwaway: generated per run, never funded, never used to sign anything. */
const keypair = Keypair.generate();
const RPC = "https://mainnet.helius-rpc.example.test/?api-key=HeliusKeyNeverLogged0003";

function wired(): {
  readonly posted: string[];
  readonly logged: { severity: AlertSeverity; line: string }[];
  readonly alerter: ReturnType<typeof createAlerter>;
} {
  const redactor = new Redactor();
  redactor.register(RPC, "rpcUrl:0");
  const posted: string[] = [];
  const logged: { severity: AlertSeverity; line: string }[] = [];
  const alerter = createAlerter({
    webhookUrl: new Secret("https://hooks.example.test/T000/B000/WebhookTokenNeverLogged", "alertWebhook"),
    log: (severity, line) => logged.push({ severity, line }),
    post: async (_url, body) => void posted.push(body),
    // Exactly what bin/keeper.mts wires.
    sanitize: (text) => scrubbedForExport(text, redactor),
  });
  return { posted, logged, alerter };
}

describe("the webhook body", () => {
  it("is scrubbed of a registered secret the caller put in a detail", () => {
    const { posted, alerter } = wired();
    alerter.fire({
      key: "settle-failed:4T52",
      severity: "critical",
      title: "A settle threw",
      detail: `every Solana endpoint refused (${RPC})`,
      context: { wallet: "4T52", endpoint: RPC },
    });

    expect(posted).toHaveLength(1);
    expect(posted[0]).not.toContain(RPC);
    expect(posted[0]).not.toContain("HeliusKeyNeverLogged0003");
    expect(posted[0]).toContain("<redacted:rpcUrl:0>");
    // The alert still says which condition fired.
    expect(JSON.parse(posted[0]!)).toMatchObject({ key: "settle-failed:4T52", severity: "critical" });
  });

  // THE NET FOR A KEY NOBODY REGISTERED. util.inspect's padded decimal columns
  // match no needle and no 64-hex run; the logger drops such a line, and the
  // webhook used to send it.
  it("withholds an alert whose text carries a run of byte values, and still fires", () => {
    const { posted, logged, alerter } = wired();
    alerter.fire({
      key: "settle-failed:4T52",
      severity: "critical",
      title: "A settle threw",
      detail: `sending the settle threw: Error: signer bytes ${Array.from(keypair.secretKey).join(", ")}`,
      context: { wallet: "4T52" },
    });

    expect(posted).toHaveLength(1);
    const body = JSON.parse(posted[0]!) as Record<string, unknown>;
    // NOT SENT: no part of the key, in any spacing.
    for (const form of [Array.from(keypair.secretKey).join(", "), Array.from(keypair.secretKey).join(","), JSON.stringify(Array.from(keypair.secretKey))]) {
      expect(posted[0]).not.toContain(form);
    }
    expect(body["withheld"]).toBe(true);
    // AND NOT SILENT: the condition, its severity and its count survive.
    expect(body).toMatchObject({ key: "settle-failed:4T52", severity: "critical", occurrences: 1 });
    expect(logged.map((entry) => entry.line).join("\n")).toContain("withheld from the webhook");
  });

  it("sends the body unchanged when nothing trips", () => {
    const { posted, alerter } = wired();
    alerter.fire({ key: "crank-low", severity: "warn", title: "The keeper's crank is running out of SOL", detail: "1000000 lamports left", context: { crank: keypair.publicKey.toBase58() } });

    expect(JSON.parse(posted[0]!)).toMatchObject({
      key: "crank-low",
      severity: "warn",
      detail: "1000000 lamports left",
      // A public key is not a secret, and an operator needs it.
      crank: keypair.publicKey.toBase58(),
    });
  });

  // A caller that passes no sanitize keeps the old behaviour exactly.
  it("is sent as built when no sanitize is wired", async () => {
    const posted: string[] = [];
    const alerter = createAlerter({
      webhookUrl: new Secret("https://hooks.example.test/T000/B000/WebhookTokenNeverLogged", "alertWebhook"),
      log: () => undefined,
      post: async (_url, body) => void posted.push(body),
    });
    alerter.fire({ key: "k", severity: "warn", title: "t", detail: RPC });
    expect(posted[0]).toContain(RPC);
  });
});

describe("scrubbedForExport", () => {
  it("refuses a byte run and a registered secret, and passes ordinary text", () => {
    const redactor = new Redactor();
    redactor.register(RPC, "rpcUrl:0");
    expect(scrubbedForExport("all quiet", redactor)).toBe("all quiet");
    expect(scrubbedForExport(`refused (${RPC})`, redactor)).toBe("refused (<redacted:rpcUrl:0>)");
    expect(scrubbedForExport(Array.from(keypair.secretKey).join(", "), redactor)).toBeNull();
  });
});

// WHAT WAKES SOMEBODY, AND WHAT ONLY GETS WRITTEN DOWN.
//
// Every alert used to leave the box: nine criticals and six warns through the
// same door. A warn is a resting condition — a crank running low, a wallet the
// keeper skipped this sweep — and at three in the morning it is indistinguishable
// from the settle that failed. The threshold sits AFTER the dedup on purpose:
// the log keeps its once-per-window line instead of one per sweep.
describe("the severity threshold", () => {
  function box(options: Partial<Parameters<typeof createAlerter>[0]> = {}) {
    const posted: string[] = [];
    const logged: string[] = [];
    const alerter = createAlerter({
      webhookUrl: new Secret("https://hooks.example.test/T000/B000/WebhookTokenNeverLogged", "alertWebhook"),
      log: (_severity, line) => logged.push(line),
      post: async (_url, body) => void posted.push(body),
      ...options,
    });
    return { posted, logged, alerter };
  }

  it("keeps a warn in the log and lets a critical out", () => {
    const { posted, logged, alerter } = box({ minSeverity: "critical" });
    alerter.fire({ key: "crank-low", severity: "warn", title: "Crank running low", detail: "1000000 lamports left" });
    expect(posted).toHaveLength(0);
    expect(logged).toHaveLength(1); // NOT SILENT: it is written down and it is in /status.

    alerter.fire({ key: "settle-failed:4T52", severity: "critical", title: "A settle threw", detail: "the RPC refused" });
    expect(posted).toHaveLength(1);
    expect(JSON.parse(posted[0]!)).toMatchObject({ severity: "critical" });
  });

  it("does not turn a held-back warn into one log line per sweep", () => {
    const { posted, logged, alerter } = box({ minSeverity: "critical" });
    for (let i = 0; i < 5; i += 1) {
      alerter.fire({ key: "crank-low", severity: "warn", title: "Crank running low", detail: "1000000 lamports left" });
    }
    expect(logged).toHaveLength(1);
    expect(posted).toHaveLength(0);
  });

  it("sends everything when the caller asks for warns too", () => {
    const { posted, alerter } = box({ minSeverity: "warn" });
    alerter.fire({ key: "crank-low", severity: "warn", title: "Crank running low", detail: "1000000 lamports left" });
    expect(posted).toHaveLength(1);
  });
});

// TELEGRAM CARRIES THE CHAT IN THE BODY and renders buttons only from
// reply_markup. A generic webhook body posted to sendMessage is a 400.
describe("the Telegram body", () => {
  const CHAT = "-1001234567890";
  function telegram(links: { statusUrl?: string | null } = { statusUrl: "https://keeper.example.test/status" }) {
    const posted: string[] = [];
    const alerter = createAlerter({
      webhookUrl: new Secret(`https://api.telegram.org/bot777:TelegramBotTokenNeverLogged/sendMessage?chat_id=${CHAT}`, "alertWebhook"),
      destination: { kind: "telegram", chatId: CHAT },
      links,
      minSeverity: "critical",
      log: () => undefined,
      post: async (_url, body) => void posted.push(body),
      // Exactly what bin/keeper.mts wires: without it there is no withheld path.
      sanitize: (text) => scrubbedForExport(text, new Redactor()),
    });
    return { posted, alerter };
  }

  it("names the chat and offers the operator's next stops as buttons", () => {
    const { posted, alerter } = telegram();
    alerter.fire({
      key: "settle-failed:4T52",
      severity: "critical",
      title: "A settle threw",
      detail: "the RPC refused",
      context: { wallet: "4T52abc", vault: "EFXK995P" },
    });

    const body = JSON.parse(posted[0]!) as Record<string, unknown>;
    expect(body["chat_id"]).toBe(CHAT);
    expect(body["text"]).toContain("A settle threw");
    const rows = (body["reply_markup"] as { inline_keyboard: { text: string; url: string }[][] }).inline_keyboard;
    // One per row: a phone renders them as a stack of full-width taps.
    expect(rows.map((row) => row.length)).toEqual([1, 1, 1]);
    expect(rows.flat().map((button) => button.url)).toEqual([
      "https://keeper.example.test/status",
      "https://solscan.io/account/4T52abc",
      "https://solscan.io/account/EFXK995P",
    ]);
  });

  it("offers no empty keyboard when there is nowhere to send the operator", () => {
    const { posted, alerter } = telegram({ statusUrl: null });
    alerter.fire({ key: "k", severity: "critical", title: "t", detail: "d" });
    expect(JSON.parse(posted[0]!)).not.toHaveProperty("reply_markup");
  });

  // The withheld fallback is a SECOND body, built on the failure path. It was
  // the generic shape once; on Telegram that is a 400 and the alert is lost.
  it("keeps the chat id on the withheld fallback", () => {
    const { posted, alerter } = telegram();
    alerter.fire({
      key: "settle-failed:4T52",
      severity: "critical",
      title: "A settle threw",
      detail: `signer bytes ${Array.from(keypair.secretKey).join(", ")}`,
      context: { wallet: "4T52abc" },
    });
    const body = JSON.parse(posted[0]!) as Record<string, unknown>;
    expect(body["chat_id"]).toBe(CHAT);
    expect(body["text"]).toContain("withheld");
    expect(posted[0]).not.toContain(Array.from(keypair.secretKey).join(", "));
  });

  it("leaves a plain webhook the shape Slack and Discord read", () => {
    const posted: string[] = [];
    const alerter = createAlerter({
      webhookUrl: new Secret("https://hooks.example.test/T000/B000/WebhookTokenNeverLogged", "alertWebhook"),
      links: { statusUrl: "https://keeper.example.test/status" },
      log: () => undefined,
      post: async (_url, body) => void posted.push(body),
    });
    alerter.fire({ key: "k", severity: "critical", title: "t", detail: "d" });
    const body = JSON.parse(posted[0]!) as Record<string, unknown>;
    expect(body).not.toHaveProperty("chat_id");
    expect(body["text"]).toContain("t");
    expect(body["links"]).toEqual([{ text: "Keeper status", url: "https://keeper.example.test/status" }]);
  });
});

// THE CRANK-LOW BUG, which the threshold work did not cause and did not fix.
// bin/keeper.mts fires ONE key, "crank-low", whose severity it computes from the
// balance: warn under 0.02 SOL, critical under 0.005. A crank drains in minutes,
// so the critical arrived inside the warn's 30-minute window and the dedup — which
// compared keys and nothing else — dropped it whole. Not sent, and not even logged.
// clear() could not save it: it only runs when the balance climbs back over 0.02.
describe("a condition that gets worse", () => {
  function box(minSeverity: AlertSeverity = "critical") {
    const posted: string[] = [];
    const logged: { severity: AlertSeverity; line: string }[] = [];
    let clock = 1_000;
    const alerter = createAlerter({
      webhookUrl: new Secret("https://hooks.example.test/T000/B000/WebhookTokenNeverLogged", "alertWebhook"),
      minSeverity,
      log: (severity, line) => logged.push({ severity, line }),
      post: async (_url, body) => void posted.push(body),
      now: () => clock,
    });
    return { posted, logged, alerter, tick: (ms: number) => void (clock += ms) };
  }

  const crank = (lamports: bigint): Alert => ({
    key: "crank-low",
    severity: lamports < 5_000_000n ? "critical" : "warn",
    title: "The keeper's crank is running out of SOL",
    detail: `${lamports} lamports left`,
    context: { crank: keypair.publicKey.toBase58() },
  });

  it("breaks through the window its own warn opened", () => {
    const { posted, logged, alerter, tick } = box();
    alerter.fire(crank(19_000_000n)); // warn: logged, kept home by the threshold
    tick(60_000); // one sweep later, still draining
    alerter.fire(crank(4_000_000n)); // critical: investing is about to stop for every vault

    expect(logged.map((entry) => entry.severity)).toEqual(["warn", "critical"]);
    expect(posted).toHaveLength(1);
    expect(JSON.parse(posted[0]!)).toMatchObject({ severity: "critical" });
  });

  it("still treats a repeat at the same severity as a repeat", () => {
    const { posted, logged, alerter, tick } = box("warn");
    alerter.fire(crank(4_000_000n));
    tick(60_000);
    alerter.fire(crank(3_000_000n));
    expect(logged).toHaveLength(1);
    expect(posted).toHaveLength(1);
  });

  it("does not page again when a condition gets BETTER", () => {
    // Nobody needs waking to be told a thing improved. A de-escalation is a repeat.
    const { posted, logged, alerter, tick } = box("warn");
    alerter.fire(crank(4_000_000n)); // critical
    tick(60_000);
    alerter.fire(crank(19_000_000n)); // warn
    expect(logged).toHaveLength(1);
    expect(posted).toHaveLength(1);
  });

  it("escalates again after the window, like any other repeat", () => {
    const { posted, alerter, tick } = box();
    alerter.fire(crank(19_000_000n));
    tick(60_000);
    alerter.fire(crank(4_000_000n));
    tick(31 * 60_000);
    alerter.fire(crank(3_000_000n));
    expect(posted).toHaveLength(2);
  });
});

// A LABEL BUILT FROM ENV VARS IS NOT EVIDENCE. "telegram: critical and above"
// reads identically whether every message was accepted or every one was refused
// 403 because the bot was blocked or never spoken to. Nothing counted, and the
// catch discarded the status code postJson had already computed.
describe("what the box did with what it was handed", () => {
  const webhookUrl = new Secret("https://hooks.example.test/T000/B000/WebhookTokenNeverLogged", "alertWebhook");
  const critical: Alert = { key: "k", severity: "critical", title: "t", detail: "d" };

  it("starts having neither sent nor failed anything", () => {
    const alerter = createAlerter({ webhookUrl, log: () => undefined, post: async () => undefined });
    expect(alerter.delivery()).toEqual({ sent: 0, failed: 0, consecutiveFailures: 0, lastError: null, lastSentAt: null });
  });

  it("counts a delivery, with when", async () => {
    const alerter = createAlerter({ webhookUrl, log: () => undefined, post: async () => undefined, now: () => 5_000 });
    alerter.fire(critical);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(alerter.delivery()).toMatchObject({ sent: 1, failed: 0, consecutiveFailures: 0, lastError: null, lastSentAt: 5_000 });
  });

  it("remembers the refusal, and says which one it was", async () => {
    const logged: string[] = [];
    const alerter = createAlerter({
      webhookUrl,
      log: (_severity, line) => logged.push(line),
      // What postJson throws for a bot that was blocked or never spoken to.
      post: async () => {
        throw new Error("webhook answered 403");
      },
    });
    alerter.fire(critical);
    alerter.fire({ ...critical, key: "k2" });
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(alerter.delivery()).toMatchObject({ sent: 0, failed: 2, consecutiveFailures: 2, lastError: "webhook answered 403" });
    // 403, 401 and 400 are three different mistakes; the old line was identical for all three.
    expect(logged.join("\n")).toContain("alert webhook failed (webhook answered 403)");
  });

  it("forgets the streak the moment one gets through", async () => {
    let refuse = true;
    const alerter = createAlerter({
      webhookUrl,
      log: () => undefined,
      post: async () => {
        if (refuse) throw new Error("webhook answered 429");
        return undefined;
      },
    });
    alerter.fire(critical);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(alerter.delivery().consecutiveFailures).toBe(1);

    refuse = false;
    alerter.fire({ ...critical, key: "k2" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(alerter.delivery()).toMatchObject({ sent: 1, failed: 1, consecutiveFailures: 0, lastError: null });
  });
});

// THE LINE THE OWNER READS TO DECIDE WHETHER THE BOX WORKS.
describe("the /status alert line", () => {
  const quiet = { sent: 0, failed: 0, consecutiveFailures: 0, lastError: null, lastSentAt: null };

  it("does not claim anything before anything has been sent", () => {
    expect(describeDelivery("telegram", "critical", quiet)).toBe("telegram: critical and above — nothing sent yet");
  });

  it("says how many got through", () => {
    expect(describeDelivery("telegram", "critical", { ...quiet, sent: 12, lastSentAt: 1 })).toBe(
      "telegram: critical and above — 12 delivered",
    );
  });

  // THE CASE THE WHOLE FIELD EXISTS FOR: the bot was blocked or never spoken to,
  // Telegram answers 403 to every critical, and the old line read exactly the
  // same as a healthy one.
  it("says it out loud when nothing is arriving, and which refusal it was", () => {
    expect(describeDelivery("telegram", "critical", { ...quiet, failed: 7, consecutiveFailures: 7, lastError: "webhook answered 403" })).toBe(
      "telegram: critical and above — NOT ARRIVING: 7 refused in a row, last: webhook answered 403",
    );
  });

  it("carries neither the URL nor the chat", () => {
    const line = describeDelivery("telegram", "critical", { ...quiet, sent: 1, lastSentAt: 1 });
    expect(line).not.toContain("api.telegram.org");
    expect(line).not.toMatch(/\d{6,}/);
  });
});
