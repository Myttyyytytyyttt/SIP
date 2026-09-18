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
