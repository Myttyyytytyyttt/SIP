// Generates a disposable keypair for the GMGN canary.
//
// The private key is written straight into a gitignored env file and is never
// printed, so it cannot leak into a terminal scrollback, a screen share, a CI
// log, or an assistant transcript. Only the address reaches stdout.
//
//   node scripts/new-canary-wallet.mjs <VAR_NAME> [envFile]
//
// Example:
//   node scripts/new-canary-wallet.mjs TRADING_OWNER_PRIVATE_KEY ../../.env.canary
//   node scripts/new-canary-wallet.mjs SESSION_KEY_PRIVATE_KEY  ../../.env.canary
//
// Treat every key this produces as burned the moment the canary ends. Never
// reuse one for the real product, and never fund one beyond the drill amount.

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const [varName, envFileArg] = process.argv.slice(2);

if (!varName || !/^[A-Z][A-Z0-9_]*$/.test(varName)) {
  console.error(
    "Usage: node scripts/new-canary-wallet.mjs <VAR_NAME> [envFile]\n" +
      "VAR_NAME must be UPPER_SNAKE_CASE, e.g. TRADING_OWNER_PRIVATE_KEY.",
  );
  process.exit(1);
}

const envFile = resolve(process.cwd(), envFileArg ?? "../../.env.canary");

// `.env` and `.env.*` are gitignored (only `.env.example` is re-included), so
// refuse any destination that falls outside that guarantee.
const basename = envFile.split(/[\\/]/).pop() ?? "";
if (!basename.startsWith(".env") || basename === ".env.example") {
  console.error(
    `Refusing to write a private key to "${basename}".\n` +
      "Target a gitignored .env* file (not .env.example).",
  );
  process.exit(1);
}

if (existsSync(envFile)) {
  const existing = readFileSync(envFile, "utf8");
  if (new RegExp(`^${varName}=.+$`, "m").test(existing)) {
    console.error(
      `${varName} already has a value in ${basename}.\n` +
        "Refusing to overwrite it — remove the line first if you really mean to rotate the key.",
    );
    process.exit(1);
  }
}

const privateKey = generatePrivateKey();
const { address } = privateKeyToAccount(privateKey);

appendFileSync(envFile, `${varName}=${privateKey}\n`, { mode: 0o600 });

// Deliberately address-only. Do not add the key here.
console.log(
  JSON.stringify({ variable: varName, address, writtenTo: basename }, null, 2),
);
