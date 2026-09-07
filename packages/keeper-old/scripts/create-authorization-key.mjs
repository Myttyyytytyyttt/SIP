#!/usr/bin/env node
// Create the authorization key the keeper signs its Privy requests with, and
// register it as a signer.
//
// This is the same thing the Dashboard's "New key" button does, done here so it
// is repeatable and so the result can be read back rather than copied by hand.
//
// TWO OBJECTS, and confusing them is why this step is easy to get lost in:
//
//   The authorization KEY is a P-256 keypair. The private half is generated on
//   this machine and never sent anywhere — Privy stores only the public half and
//   uses it to verify that a request really came from us. Privy cannot recover
//   the private key, so losing it means creating a new one and having every user
//   re-grant the signer.
//
//   The key QUORUM is what wraps that key and gets an id. That id — not the key —
//   is what `addSigners({signerId})` takes in the browser, and what the keeper
//   passes as PRIVY_SIGNER_ID. A quorum can hold several keys with a threshold;
//   this creates the 1-of-1 case, which is what a single backend service wants.

import { generateP256KeyPair, PrivyClient } from "@privy-io/node";

const appId = process.env.PRIVY_APP_ID;
const appSecret = process.env.PRIVY_APP_SECRET;

if (!appId || !appSecret) {
  console.error("Set PRIVY_APP_ID and PRIVY_APP_SECRET.");
  console.error("Both are on the Privy Dashboard under Configuration > Basics.");
  process.exit(2);
}

const privy = new PrivyClient({ appId, appSecret });

// Generated here, on this machine. Privy never sees the private half.
const { privateKey, publicKey } = await generateP256KeyPair();

const quorum = await privy.keyQuorums().create({
  display_name: process.env.PRIVY_KEY_NAME ?? "Nuvem keeper",
  public_keys: [publicKey],
  // 1-of-1: this one key alone authorises. Higher thresholds are for human
  // approval flows, where the point is that no single holder can act.
  authorization_threshold: 1,
});

console.log("");
console.log("Key quorum created.");
console.log("");
console.log("─".repeat(72));
console.log("PRIVATE KEY — shown once, never again. Privy does not have it.");
console.log("─".repeat(72));
console.log(privateKey);
console.log("");
console.log("Put these where they belong:");
console.log("");
console.log("  packages/keeper-old/.env   (server only — this key can sign for users)");
console.log(`    PRIVY_APP_ID=${appId}`);
console.log("    PRIVY_APP_SECRET=<the same one you just used>");
console.log(`    PRIVY_AUTHORIZATION_KEY=${privateKey}`);
console.log(`    PRIVY_SIGNER_ID=${quorum.id}`);
console.log("");
console.log("  packages/web/.env.local   (the browser needs only the id)");
console.log(`    NEXT_PUBLIC_PRIVY_SIGNER_ID=${quorum.id}`);
console.log("");
console.log("The id is public — it names who may sign, it does not grant anything.");
console.log("The private key is the credential. It belongs on the server and nowhere else.");
console.log("");
console.log("Next: create the policy that bounds what this signer may do, then paste");
console.log("its id as NEXT_PUBLIC_PRIVY_POLICY_ID:");
console.log("    node scripts/create-privy-policy.mjs");
