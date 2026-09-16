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
import { Redactor } from "@sip/solana-log";
import { describe, expect, it } from "vitest";
import { BROADCAST_ACK, loadConfig } from "../src/config.js";
import { SIP_PROGRAM_ID } from "../src/idl.js";
import { SERVICE } from "../src/keeper-log.js";
import { seatCheck } from "../src/seat-check.js";
import {
  HEALTH_STALE_FLOOR_MS,
  decideHealth,
  healthStaleAfterMs,
  httpHandler,
  renderStatus,
  type HealthInput,
  type KeeperStatus,
} from "../src/status.js";

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
      SIP_SOLANA_PRIVY_POLICY_ID: "policy-id",
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
      privyPolicyId: config.privyPolicyId,
      seatCheck: seatCheck(config.privySignerId, config.privyPolicyId),
      secretsRead: true,
      settleKey: config.signing!.settleKey.publicKey.toBase58(),
      wallets: { signable: 1, of: 1 },
    },
    history: `could not be checked — error: connect ECONNREFUSED ${DB}`,
    wallets: {
      [wallet]: { settle: "FAILED", invest: "IDLE", signing: "privy", detail: `webhook ${WEBHOOK} and ${APP_SECRET}`, at: new Date().toISOString() },
    },
    pendingCarries: [
      {
        wallet,
        link: Keypair.generate().publicKey.toBase58(),
        state: "300000000:8:300000900",
        lossLamports: 500_000_000n,
        walletSignedTxCount: 30,
        since: new Date().toISOString(),
      },
    ],
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
    // Public ids. The policy id alone says nothing: this environment sets it and
    // NO signer id, so no seat is examined at all and the page says so.
    expect(parsed.signing.privyPolicyId).toBe("policy-id");
    expect(parsed.signing.seatCheck).toBe("unchecked");
    expect(parsed.lastSweepError).toContain("<redacted:rpcUrl:0>");
    expect(parsed.history).toContain("<redacted:databaseUrl>");
    // A pending carry's lamports are a bigint, which JSON.stringify throws on:
    // the status replacer has to carry them out as a string, or the whole page
    // would fail to render the moment a zero settle carried a loss.
    expect(served).toContain('"lossLamports":"500000000"');
    expect(parsed.pendingCarries).toHaveLength(1);
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

describe("the /health staleness rule", () => {
  const base: HealthInput = { now: 0, startedAt: 0, lastProgressAt: null, sweepMs: 60_000 };

  it("is ten minutes at the default sweep, and three sweeps only above a 200 s one", () => {
    expect(healthStaleAfterMs(5_000)).toBe(HEALTH_STALE_FLOOR_MS);
    expect(healthStaleAfterMs(60_000)).toBe(HEALTH_STALE_FLOOR_MS);
    expect(healthStaleAfterMs(200_000)).toBe(HEALTH_STALE_FLOOR_MS);
    expect(healthStaleAfterMs(300_000)).toBe(900_000);
  });

  it("stays ok for a keeper that is merely idle or slow within the bound, and for one still starting up", () => {
    // Sweeping every minute for nine minutes: idle is not wedged.
    expect(decideHealth({ ...base, lastProgressAt: 0, now: 9 * 60_000 })).toEqual({ ok: true });
    // One millisecond short of the bound: still ok.
    expect(decideHealth({ ...base, lastProgressAt: 0, now: HEALTH_STALE_FLOOR_MS - 1 })).toEqual({ ok: true });
    // Booting. The first sweep is awaited only after the chain read and the read
    // model's preflight, so the process's own start has to be the clock.
    expect(decideHealth({ ...base, now: HEALTH_STALE_FLOOR_MS - 1 })).toEqual({ ok: true });
    // A sweep that started 20 minutes ago at a 10-minute interval is inside 3 × sweepMs.
    expect(decideHealth({ ...base, sweepMs: 600_000, lastProgressAt: 0, now: 20 * 60_000 })).toEqual({ ok: true });
  });

  it("fails once the sweep has not MOVED inside the bound, and says which clock it used", () => {
    const wedged = decideHealth({ ...base, lastProgressAt: 0, now: HEALTH_STALE_FLOOR_MS });
    expect(wedged).toEqual({
      ok: false,
      detail: "the sweep last moved 600s ago",
      quietForMs: HEALTH_STALE_FLOOR_MS,
      staleAfterMs: HEALTH_STALE_FLOOR_MS,
    });
    const neverSwept = decideHealth({ ...base, now: 20 * 60_000 });
    expect(neverSwept).toMatchObject({ ok: false, quietForMs: 1_200_000, staleAfterMs: HEALTH_STALE_FLOOR_MS });
    expect(neverSwept.detail).toBe("no sweep has started in the 1200s since this process came up");
  });

  it("never fails on a clock that went backwards or a sweep interval that is not a number", () => {
    expect(decideHealth({ ...base, lastProgressAt: 60 * 60_000, now: 0 })).toEqual({ ok: true });
    expect(decideHealth({ ...base, sweepMs: Number.NaN, lastProgressAt: 0, now: HEALTH_STALE_FLOOR_MS - 1 })).toEqual({ ok: true });
  });
});

describe("the heartbeat handler", () => {
  const healthy = () => decideHealth({ now: 0, startedAt: 0, lastProgressAt: 0, sweepMs: 60_000 });

  it("answers /health with {ok:true} and /status with the rendered status, and nothing else", () => {
    const { redactor, status } = setup();
    let renders = 0;
    const handler = httpHandler(() => {
      renders += 1;
      return renderStatus(status, redactor);
    }, healthy);

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

  it("answers 503 once sweeping has stopped, with numbers and fixed words and no upstream text", () => {
    const { redactor, status } = setup();
    let renders = 0;
    const handler = httpHandler(
      () => {
        renders += 1;
        return renderStatus(status, redactor);
      },
      () => decideHealth({ now: 30 * 60_000, startedAt: 0, lastProgressAt: 0, sweepMs: 60_000 }),
    );

    const answer = drive(handler, "GET", "/health");
    expect(answer.status).toBe(503);
    expect(JSON.parse(answer.body)).toEqual({
      ok: false,
      detail: "the sweep last moved 1800s ago",
      quietForMs: 1_800_000,
      staleAfterMs: HEALTH_STALE_FLOOR_MS,
    });
    // /health is not scrubbed and has no tripwire, so nothing upstream may reach
    // it — not even the summarized error /status carries in lastSweepError.
    for (const credential of CREDENTIALS) expect(answer.body).not.toContain(credential);
    expect(answer.body).not.toContain("ECONNRESET");
    expect(renders, "/health must not render the status, failing or not").toBe(0);
  });

  it("stays at 200 when the probe itself throws: a bug in the probe must never restart a working keeper", () => {
    const { redactor, status } = setup();
    const handler = httpHandler(
      () => renderStatus(status, redactor),
      () => {
        throw new Error("the probe broke");
      },
    );

    const answer = drive(handler, "GET", "/health");
    expect(answer.status).toBe(200);
    expect(JSON.parse(answer.body).ok).toBe(true);
    expect(answer.body).not.toContain("the probe broke");
  });
});
