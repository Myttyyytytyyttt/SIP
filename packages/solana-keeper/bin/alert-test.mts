// PROVING THE BOX RECEIVES, BEFORE TRUSTING IT WITH THE NIGHT.
//
// /status says `alerts: telegram: critical and above`. That label proves the URL
// parsed and carried a chat id — nothing more. It does NOT prove the token is
// right, that the chat exists, that the bot may write there, or that Telegram
// accepts the body this keeper builds. The first proof of all that would
// otherwise be the first real critical, which is the worst moment to find out.
//
// This fires ONE genuine critical through the keeper's own alerter: the same
// config parsing, the same severity threshold, the same envelope, the same
// redactor, and — because src/alerts.ts exports it — the same postJson. The only
// thing this file adds is WAITING for the answer and reading it out loud, which
// the keeper deliberately does not do (an unreachable alert endpoint must never
// take down the thing it is monitoring).
//
// It also fires a warn first, which must NOT arrive. A run that delivers two
// messages means the threshold is not doing its job.
//
//   pnpm --filter @sip/solana-keeper alert-test
//
// with SIP_SOLANA_ALERT_WEBHOOK set — by hand, or with the service's real
// environment via `railway run`. Exits 1 if nothing arrived.

import "../src/console-bridge.js";
import { sharedRedactor } from "@sip/solana-log";
import { createAlerter, postJson } from "../src/alerts.js";
import { ConfigError, loadConfig } from "../src/config.js";
import { scrubbedForExport } from "../src/keeper-log.js";

/**
 * A destination test needs a destination and nothing else, so the two variables
 * every other entry point demands get harmless stand-ins. Anything actually set
 * wins, which is what makes `railway run` test the REAL configuration.
 */
const env: NodeJS.ProcessEnv = {
  SIP_SOLANA_RPC_URLS: "https://api.mainnet-beta.solana.com",
  SIP_SOLANA_PROGRAM_ID: "6kA9H9zQT6PW5xWkXoAFCS3NotxarzaYqj66mjMf9w4J",
  ...process.env,
};

const config = (() => {
  try {
    return loadConfig(env, sharedRedactor);
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`The configuration is refused, so the keeper would not start either:\n${error.message}`);
      process.exit(1);
    }
    throw error;
  }
})();

if (config.alertWebhook === null) {
  console.error(
    "SIP_SOLANA_ALERT_WEBHOOK is not set, so there is nothing to test. Set it to the Telegram sendMessage URL\n" +
      "with its chat_id, or run this under `railway run` so the service's own value is used.",
  );
  process.exit(1);
}

const channel = config.alertChatId === null ? "a generic webhook (Slack/Discord shape)" : `Telegram chat ${config.alertChatId}`;
console.log(`Destination: ${channel}`);
console.log(`Threshold:   ${config.alertMinSeverity} and above`);
console.log(`Status link: ${config.statusUrl ?? "none — RAILWAY_PUBLIC_DOMAIN is unset, so there is no status button"}`);
console.log("");

/** What the keeper's own post did, once it finishes. The keeper never waits for this. */
interface Outcome {
  readonly ok: boolean;
  readonly error?: string;
}
let outcome: Outcome | null = null;
/**
 * Read through a call, not the variable: every assignment to `outcome` happens
 * inside the post callback, which control-flow analysis does not follow, so a
 * direct read after the wait below narrows to `never`.
 */
const settled = (): Outcome | null => outcome;
let sentBody: string | null = null;
let sentUrl: string | null = null;

const alerter = createAlerter({
  webhookUrl: config.alertWebhook,
  minSeverity: config.alertMinSeverity,
  destination: config.alertChatId === null ? { kind: "webhook" } : { kind: "telegram", chatId: config.alertChatId },
  links: { statusUrl: config.statusUrl },
  log: (severity, line) => console.log(`  log[${severity}] ${line}`),
  sanitize: (text) => scrubbedForExport(text),
  // Production's own send, awaited. The wrapper records the verdict; it does not
  // change what is sent.
  post: async (url, body) => {
    sentUrl = url;
    sentBody = body;
    try {
      await postJson(url, body);
      outcome = { ok: true };
    } catch (error) {
      outcome = { ok: false, error: error instanceof Error ? error.message : String(error) };
      throw error;
    }
  },
});

// FIRST, the one that must stay home.
console.log("Firing a warn, which the threshold should keep in the log:");
alerter.fire({
  key: "alert-test:warn",
  severity: "warn",
  title: "Prueba: un aviso",
  detail: "Si esto te llega al móvil, el umbral no está filtrando.",
});
if (sentBody !== null && config.alertMinSeverity === "critical") {
  console.error("\nTHE WARN LEFT THE BOX. The threshold is not being applied.");
  process.exit(1);
}
console.log(config.alertMinSeverity === "critical" ? "  …it stayed. Good.\n" : "  …sent, because the threshold is 'warn'.\n");

// THEN the real one, with the context that becomes buttons.
console.log("Firing a critical, which must arrive:");
alerter.fire({
  key: "alert-test:critical",
  severity: "critical",
  title: "Prueba del vigilante SIP",
  detail: "Si ves esto en el móvil, la caja funciona: los críticos llegan. Puedes ignorar este mensaje.",
  context: { wallet: "9QX53J3Kbs8ogQirZq5iN11rucZAvgF4EKWw98QAkUSe", vault: "EFXK995PV49Qz8xPSYMEUDBU5AKRR466JkgsfuGak5iU" },
});

const deadline = 30_000;
const startedAt = process.hrtime.bigint();
while (settled() === null && Number(process.hrtime.bigint() - startedAt) / 1e6 < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 100));
}

if (sentBody !== null) {
  console.log("\nThe body that left (the token is in the URL, never in here):");
  console.log(scrubbedForExport(JSON.stringify(JSON.parse(sentBody), null, 2)) ?? "  …withheld by the redactor");
}

const verdict = settled();
if (verdict === null) {
  console.error("\nNo answer in 30 s. The destination is not reachable from here.");
  process.exit(1);
}

if (verdict.ok) {
  console.log("\nDELIVERED. Telegram accepted it — check the phone; the message carries its buttons.");
  process.exit(0);
}

// A STATUS CODE IS NOT A DIAGNOSIS. postJson deliberately lets only the code out,
// because the body may hold anything. Here, once, we read the answer: "chat not
// found" and "Unauthorized" are different mistakes with different fixes.
console.error(`\nREFUSED: ${verdict.error}`);
if (sentUrl !== null && sentBody !== null) {
  try {
    const again = await fetch(sentUrl, { method: "POST", headers: { "content-type": "application/json" }, body: sentBody });
    const said = (await again.json()) as { description?: string; error_code?: number };
    console.error(`Telegram says: ${said.error_code ?? again.status} — ${said.description ?? "(no description)"}`);
    console.error(
      said.description?.includes("chat not found")
        ? "→ The chat_id is wrong, or the bot has never been spoken to in that chat."
        : said.description?.includes("Unauthorized")
          ? "→ The token is wrong or the bot was deleted. Check it with BotFather."
          : "→ Compare the URL against https://api.telegram.org/bot<TOKEN>/sendMessage?chat_id=<ID>.",
    );
  } catch {
    console.error("The second, diagnostic attempt did not answer either.");
  }
}
process.exit(1);
