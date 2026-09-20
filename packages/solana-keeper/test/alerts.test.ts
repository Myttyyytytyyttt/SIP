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
import { createAlerter, type AlertSeverity } from "../src/alerts.js";
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
