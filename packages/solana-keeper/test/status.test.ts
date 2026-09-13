// /status serves nothing credential-bearing, and /health and /status make no call
// of their own.
//
// The status is built from public keys and scrubbed details, but the test does
// not trust that: it plants the endpoint URL and the database URL in the places
// an upstream message could carry them past a summary, and asserts they never
// reach the served JSON. The handler is driven with a fake request and response,
// so no socket and no network is involved.

import type { IncomingMessage, ServerResponse } from "node:http";
import { Keypair } from "@solana/web3.js";
import { Redactor } from "@sip/worker/log";
import { describe, expect, it } from "vitest";
import { BROADCAST_ACK, loadConfig } from "../src/config.js";
import { SIP_PROGRAM_ID } from "../src/idl.js";
import { SERVICE } from "../src/keeper-log.js";
import { httpHandler, renderStatus, type KeeperStatus } from "../src/status.js";

const keypair = Keypair.generate();
const RPC = "https://mainnet.helius-rpc.example.test/?api-key=HeliusKeyNeverServed0003";
const DB = "postgres://sip:DbPassw0rdNeverServed@db.example.test:5432/sip";
const WEBHOOK = "https://hooks.slack.example.test/services/T000/B000/WebhookTokenNeverServed";
const APP_SECRET = "privy-app-secret-never-served";
const AUTH_KEY = "wallet-auth:MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgAuthorizationKeyNeverServed";

const CREDENTIALS = [
  RPC,
  "HeliusKeyNeverServed0003",
  DB,
  "DbPassw0rdNeverServed",
  WEBHOOK,
  "WebhookTokenNeverServed",
  APP_SECRET,
  AUTH_KEY.slice(12),
  JSON.stringify(Array.from(keypair.secretKey)),
  Array.from(keypair.secretKey).slice(0, 16).join(","),
];

function setup(): { redactor: Redactor; status: KeeperStatus } {
  const redactor = new Redactor();
  const config = loadConfig(
    {
      SIP_SOLANA_RPC_URLS: RPC,
      SIP_SOLANA_PROGRAM_ID: SIP_PROGRAM_ID,
      SIP_SOLANA_BROADCAST: "1",
      SIP_SOLANA_ALLOW_BROADCAST: BROADCAST_ACK,
      SIP_SOLANA_SETTLE_KEY: JSON.stringify(Array.from(keypair.secretKey)),
      SIP_SOLANA_PRIVY_APP_ID: "app-id",
      SIP_SOLANA_PRIVY_APP_SECRET: APP_SECRET,
      SIP_SOLANA_PRIVY_AUTHORIZATION_KEY: AUTH_KEY,
      SIP_SOLANA_ALERT_WEBHOOK: WEBHOOK,
      DATABASE_URL: DB,
      PORT: "18080",
    },
    redactor,
  );
  const wallet = Keypair.generate().publicKey.toBase58();
  const status: KeeperStatus = {
    service: SERVICE,
    startedAt: new Date().toISOString(),
    program: config.programId,
    programDeployed: false,
    config: null,
    mode: "dry-run",
    armed: config.armed,
    missingLiveCondition: "the on-chain ProtocolConfig does not exist (program not deployed, or init_config not run); staying dry and re-verifying every sweep",
    sweepMs: config.sweepMs,
    pools: config.pools.size,
    sweeps: 3,
    lastSweepAt: new Date().toISOString(),
    lastSweepLinks: 1,
    // Planted: what an upstream message that slipped past its summary looks like.
    lastSweepError: `FetchError: request to ${RPC} failed, reason: ECONNRESET`,
    crank: { pubkey: null, lamports: null },
    signing: {
      route: "privy",
      privyAppId: config.privyAppId,
      privySignerId: config.privySignerId,
      secretsRead: true,
      settleKey: config.signing!.settleKey.publicKey.toBase58(),
      wallets: { signable: 1, of: 1 },
    },
    history: `could not be checked — error: connect ECONNREFUSED ${DB}`,
    wallets: {
      [wallet]: { settle: "FAILED", invest: "IDLE", signing: "privy", detail: `webhook ${WEBHOOK} and ${APP_SECRET}`, at: new Date().toISOString() },
    },
  };
  return { redactor, status };
}

function drive(handler: ReturnType<typeof httpHandler>, method: string, url: string): { status: number; body: string; type: string | undefined } {
  let body = "";
  let type: string | undefined;
  const response = {
    statusCode: 200,
    setHeader(name: string, value: string) {
      if (name.toLowerCase() === "content-type") type = value;
    },
    end(chunk?: string) {
      body = chunk ?? "";
    },
  };
  handler({ method, url } as IncomingMessage, response as unknown as ServerResponse);
  return { status: response.statusCode, body, type };
}

describe("the /status JSON", () => {
  it("contains no registered credential, and still says what an operator needs", () => {
    const { redactor, status } = setup();
    const served = renderStatus(status, redactor);
    for (const credential of CREDENTIALS) expect(served).not.toContain(credential);
    const parsed = JSON.parse(served) as KeeperStatus;
    expect(parsed.program).toBe(SIP_PROGRAM_ID);
    expect(parsed.programDeployed).toBe(false);
    expect(parsed.signing.settleKey).toBe(keypair.publicKey.toBase58());
    expect(parsed.lastSweepError).toContain("<redacted:rpcUrl:0>");
    expect(parsed.history).toContain("<redacted:databaseUrl>");
  });

  it("is withheld whole when a registered secret survives the scrub", () => {
    const { redactor, status } = setup();
    const seedHex = Buffer.from(keypair.secretKey.subarray(0, 32)).toString("hex");
    // Split by a space, so substitution cannot match it but the tripwire can.
    status.lastSweepError = `${seedHex.slice(0, 30)} ${seedHex.slice(30)}`;
    const served = renderStatus(status, redactor);
    expect(JSON.parse(served)).toEqual({ service: SERVICE, status: "withheld: redaction tripwire" });
    expect(served.replace(/\s/g, "")).not.toContain(seedHex);
  });
});

describe("the heartbeat handler", () => {
  it("answers /health with {ok:true} and /status with the rendered status, and nothing else", () => {
    const { redactor, status } = setup();
    let renders = 0;
    const handler = httpHandler(() => {
      renders += 1;
      return renderStatus(status, redactor);
    });

    const health = drive(handler, "GET", "/health");
    expect(health).toMatchObject({ status: 200, body: '{"ok":true}', type: "application/json" });
    expect(renders, "/health must not even render the status").toBe(0);

    const served = drive(handler, "GET", "/status?pretty=1");
    expect(served.status).toBe(200);
    expect(renders).toBe(1);
    for (const credential of CREDENTIALS) expect(served.body).not.toContain(credential);
    expect(JSON.parse(served.body)).toMatchObject({ service: SERVICE, program: SIP_PROGRAM_ID });

    expect(drive(handler, "GET", "/").status).toBe(404);
    expect(drive(handler, "POST", "/status").status).toBe(405);
  });
});
