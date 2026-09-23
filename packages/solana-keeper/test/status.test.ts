// /status serves nothing credential-bearing, and /health and /status make no call
// of their own.
//
// The status is built from public keys and scrubbed details, but the test does
// not trust that: it plants the endpoint URL and the database URL in the places
// an upstream message could carry them past a summary, and asserts they never
// reach the served JSON. The handler is driven with a fake request and response,
// so no socket and no network is involved.

import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { Keypair } from "@solana/web3.js";
import { Redactor, Secret } from "@sip/solana-log";
import { describe, expect, it } from "vitest";
import { BROADCAST_ACK, loadConfig } from "../src/config.js";
import { Doorbell } from "../src/doorbell.js";
import { WebhookSync, createHeliusWebhookClient } from "../src/helius-webhooks.js";
import { SIP_PROGRAM_ID } from "../src/idl.js";
import { SERVICE } from "../src/keeper-log.js";
import { seatCheck } from "../src/seat-check.js";
import {
  HEALTH_STALE_FLOOR_MS,
  HOOK_MAX_BODY_BYTES,
  authorizationMatcher,
  decideHealth,
  healthStaleAfterMs,
  httpHandler,
  renderLeaderboard,
  renderStatus,
  type HealthInput,
  type HooksRoute,
  type KeeperStatus,
  type LeaderboardReply,
} from "../src/status.js";

const keypair = Keypair.generate();
const RPC = "https://mainnet.helius-rpc.example.test/?api-key=HeliusKeyNeverServed0003";
const DB = "postgres://sip:DbPassw0rdNeverServed@db.example.test:5432/sip";
const WEBHOOK = "https://hooks.slack.example.test/services/T000/B000/WebhookTokenNeverServed";
const APP_SECRET = "privy-app-secret-never-served";
const AUTH_KEY = "wallet-auth:MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgAuthorizationKeyNeverServed";
/** The doorbell's two credentials: the Authorization header Helius sends, and the webhook API's key. */
const DOORBELL_SECRET = "doorbell-secret-never-served-0123456789abcdef";
const HELIUS_API_KEY = "HeliusWebhookApiKeyNeverServed77";

const CREDENTIALS = [
  RPC,
  "HeliusKeyNeverServed0003",
  DB,
  "DbPassw0rdNeverServed",
  WEBHOOK,
  "WebhookTokenNeverServed",
  APP_SECRET,
  AUTH_KEY.slice(12),
  DOORBELL_SECRET,
  HELIUS_API_KEY,
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
      SIP_SOLANA_DOORBELL_SECRET: DOORBELL_SECRET,
      SIP_SOLANA_HELIUS_API_KEY: HELIUS_API_KEY,
      RAILWAY_PUBLIC_DOMAIN: "keeper.example.test",
    },
    redactor,
  );
  // THE DOORBELL BLOCK, BUILT BY THE REAL OBJECTS with both credentials in
  // hand, and one of them planted where an upstream error would put it.
  const bell = new Doorbell(config.doorbellSecret !== null);
  bell.ingest([{ blockTime: 1, slot: 1, transaction: { signatures: ["sig"] } }], new Set(), Date.now());
  const sync = new WebhookSync({
    client: createHeliusWebhookClient({ apiKey: config.heliusApiKey!, fetch: async () => new Response("", { status: 500 }) }),
    url: config.doorbellUrl,
    secret: config.doorbellSecret,
    onSynced: () => undefined,
    log: () => undefined,
  });
  const webhook = { ...sync.status(), lastSyncError: `Helius said: bad key ${HELIUS_API_KEY} for header ${DOORBELL_SECRET}` };
  const wallet = Keypair.generate().publicKey.toBase58();
  const status: KeeperStatus = {
    service: SERVICE,
    startedAt: new Date().toISOString(),
    program: config.programId,
    programDeployed: false,
    config: null,
    mode: "dry-run",
    alerts: "telegram: critical and above",
    armed: config.armed,
    missingLiveCondition: "the on-chain ProtocolConfig does not exist (program not deployed, or init_config not run); staying dry and re-verifying every sweep",
    sweepMs: config.sweepMs,
    pools: config.pools.size,
    sweeps: 3,
    lastSweepAt: new Date().toISOString(),
    lastSweepLinks: 1,
    // Planted: what an upstream message that slipped past its summary looks like.
    lastSweepError: `FetchError: request to ${RPC} failed, reason: ECONNRESET`,
    // WHAT A SWEEP COST. A skipped sweep, a pass that took two thirds of its
    // own interval, and a link that was discovered and never served: the three
    // conditions this page was blind to.
    skipped: 2,
    consecutiveSkips: 1,
    lastSweepMs: 41_000,
    sweepMsP50: 12_000,
    sweepMsP90: 41_000,
    linksDiscovered: 2,
    linksTriaged: 1,
    lastSweepPhaseMs: { chainReadMs: 120, discoveryMs: 240, vaultReadMs: 68, triageMs: 520, expensiveMs: 40_000 },
    // AN INDEX, NEVER A URL: the endpoints carry API keys and this page is public.
    rpcEndpointInUse: "endpoint 2/2",
    failovers: 3,
    jupiterCallsPerSweep: 12,
    crank: { pubkey: null, lamports: null },
    signing: {
      route: "privy",
      privyAppId: config.privyAppId,
      privySignerId: config.privySignerId,
      privyPolicyId: config.privyPolicyId,
      seatCheck: seatCheck(config.privySignerId, config.privyPolicyId),
      authorizationKey: "matches",
      authorizationKeyAt: new Date().toISOString(),
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
    doorbell: { ...bell.status(Date.now()), webhook, apiKeySource: config.heliusApiKeySource },
  };
  return { redactor, status };
}

function drive(
  handler: ReturnType<typeof httpHandler>,
  method: string,
  url: string,
): { status: number; body: string; type: string | undefined; headers: Record<string, string> } {
  let body = "";
  const headers: Record<string, string> = {};
  const response = {
    statusCode: 200,
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value;
    },
    end(chunk?: string) {
      body = chunk ?? "";
    },
  };
  handler({ method, url } as IncomingMessage, response as unknown as ServerResponse);
  return { status: response.statusCode, body, type: headers["content-type"], headers };
}

/** A keeper whose rankings are not ready: the state every handler test starts in. */
const noBoard = (): LeaderboardReply => ({ unavailable: "the rankings have not been computed yet" });

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
    // A VERDICT AND ITS DATE ARE READ TOGETHER OR NOT AT ALL. "matches" with no
    // timestamp is a claim about an unknown moment — possibly a process that
    // started days ago — and mid-outage that is the whole question.
    expect(parsed.signing.authorizationKey).toBe("matches");
    expect(Date.parse(parsed.signing.authorizationKeyAt!)).not.toBeNaN();
    expect(parsed.lastSweepError).toContain("<redacted:rpcUrl:0>");
    expect(parsed.history).toContain("<redacted:databaseUrl>");
    // A pending carry's lamports are a bigint, which JSON.stringify throws on:
    // the status replacer has to carry them out as a string, or the whole page
    // would fail to render the moment a zero settle carried a loss.
    expect(served).toContain('"lossLamports":"500000000"');
    expect(parsed.pendingCarries).toHaveLength(1);
  });

  // WHAT A SWEEP COSTS, SERVED AS JSON. The owner's question — how many
  // simultaneous users fit — is sweepMs divided by what a user costs, and until
  // these fields existed neither side of that division was on the page: a
  // keeper skipping every sweep looked exactly like one with nothing to do.
  it("carries the sweep's cost, and names the endpoint by index rather than by URL", () => {
    const { redactor, status } = setup();
    const parsed = JSON.parse(renderStatus(status, redactor)) as KeeperStatus;
    // The skip that used to be a log line and nothing else.
    expect(parsed.skipped).toBe(2);
    expect(parsed.consecutiveSkips).toBe(1);
    // The interval, and how much of it the sweeps are using.
    expect(parsed.lastSweepMs).toBe(41_000);
    expect(parsed.sweepMsP50).toBe(12_000);
    expect(parsed.sweepMsP90).toBe(41_000);
    // TWO FOUND, ONE SERVED: the difference is a user nobody looked at.
    expect(parsed.linksDiscovered).toBe(2);
    expect(parsed.linksTriaged).toBe(1);
    // Which lane is filling the sweep.
    expect(parsed.lastSweepPhaseMs).toEqual({ chainReadMs: 120, discoveryMs: 240, vaultReadMs: 68, triageMs: 520, expensiveMs: 40_000 });
    // The binding external limit, counted rather than assumed.
    expect(parsed.jupiterCallsPerSweep).toBe(12);
    expect(parsed.failovers).toBe(3);
    // AND NEVER THE URL. /status is unauthenticated and the endpoints carry API
    // keys; a label is the only name they get outside the request itself.
    expect(parsed.rpcEndpointInUse).toBe("endpoint 2/2");
    expect(renderStatus(status, redactor)).not.toContain(RPC);
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
    const handler = httpHandler(
      () => {
        renders += 1;
        return renderStatus(status, redactor);
      },
      healthy,
      noBoard,
      null,
    );

    const health = drive(handler, "GET", "/health");
    expect(health).toMatchObject({ status: 200, body: '{"ok":true}', type: "application/json" });
    expect(renders, "/health must not even render the status").toBe(0);

    const served = drive(handler, "GET", "/status?pretty=1");
    expect(served.status).toBe(200);
    expect(renders).toBe(1);
    for (const credential of CREDENTIALS) expect(served.body).not.toContain(credential);
    expect(JSON.parse(served.body)).toMatchObject({ service: SERVICE, program: SIP_PROGRAM_ID });
    // THE LABEL, NEVER THE URL: /status is unauthenticated and served on a
    // public domain, and a Discord or Slack webhook is a posting credential.
    expect(JSON.parse(served.body).alerts).toBe("telegram: critical and above");
    expect(served.body).not.toContain(WEBHOOK);

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
      noBoard,
      null,
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
      noBoard,
      null,
    );

    const answer = drive(handler, "GET", "/health");
    expect(answer.status).toBe(200);
    expect(JSON.parse(answer.body).ok).toBe(true);
    expect(answer.body).not.toContain("the probe broke");
  });
});

describe("the /leaderboard route", () => {
  const healthy = () => decideHealth({ now: 0, startedAt: 0, lastProgressAt: 0, sweepMs: 60_000 });

  it("refuses at 503 rather than serve an empty board, and serves the payload once there is one", () => {
    const { redactor, status } = setup();
    let reply: LeaderboardReply = { unavailable: "this keeper has no database, so it keeps no history to rank" };
    const handler = httpHandler(() => renderStatus(status, redactor), healthy, () => reply, null);

    // AN EMPTY BOARD AND AN UNREAD ONE ARE DIFFERENT FACTS. A 200 with no rows
    // would tell a new user that nobody has ever saved anything.
    const missing = drive(handler, "GET", "/leaderboard");
    expect(missing.status).toBe(503);
    expect(JSON.parse(missing.body)).toEqual({
      error: "the leaderboard is not available",
      detail: "this keeper has no database, so it keeps no history to rank",
    });

    const board = JSON.stringify({ computedAt: "2026-09-20T12:00:00.000Z", boards: { ahorro: { season: [] } } });
    reply = { body: board };
    const served = drive(handler, "GET", "/leaderboard");
    expect(served).toMatchObject({ status: 200, body: board, type: "application/json" });
    // Public data, readable without a proxy, and cheap to serve under load.
    expect(served.headers["access-control-allow-origin"]).toBe("*");
    expect(served.headers["cache-control"]).toBe("public, max-age=30");
    expect(drive(handler, "POST", "/leaderboard").status).toBe(405);
  });

  it("is named in the 404, so a wrong path says what this service does serve", () => {
    const { redactor, status } = setup();
    const handler = httpHandler(() => renderStatus(status, redactor), healthy, noBoard, null);
    expect(JSON.parse(drive(handler, "GET", "/leaderboards").body).paths).toEqual(["/health", "/status", "/leaderboard"]);
  });

  it("scrubs a registered secret that somehow reached the payload", () => {
    const { redactor } = setup();
    // Nothing in a ranking should be secret — it is addresses and amounts, all
    // of them on chain. This asserts what happens if that "should" ever fails:
    // the value is replaced by its label, and the connection string that a
    // mis-written query could have put in a subject column is not served.
    const served = renderLeaderboard({ boards: { ahorro: { season: [{ subject: DB }] } } }, redactor);
    expect(served).not.toContain(DB);
    expect(served).not.toContain("DbPassw0rdNeverServed");
    expect(JSON.parse(served).boards.ahorro.season[0].subject).toBe("<redacted:databaseUrl>");
  });

  it("serves lamports as strings and numbers as numbers, with no bigint anywhere", () => {
    const { redactor } = setup();
    const served = renderLeaderboard({ points: 84, amountRaw: (12_345n * 10n ** 12n).toString(), raw: 7n }, redactor);
    expect(JSON.parse(served)).toEqual({ points: 84, amountRaw: "12345000000000000", raw: "7" });
  });
});

describe("the doorbell block on /status", () => {
  it("says whether the keeper is still looking at everybody, and never serves the secret or the API key", () => {
    const { redactor, status } = setup();
    const served = renderStatus(status, redactor);
    expect(served).not.toContain(DOORBELL_SECRET);
    expect(served).not.toContain(HELIUS_API_KEY);
    const parsed = JSON.parse(served) as KeeperStatus;
    expect(parsed.doorbell).toMatchObject({ enabled: true, trusted: true, eventsReceived: 1, apiKeySource: "env" });
    expect(parsed.doorbell.webhook.lastSyncError).toContain("<redacted:heliusApiKey>");
    expect(parsed.doorbell.webhook.lastSyncError).toContain("<redacted:doorbellSecret>");
    for (const field of ["untrustedReason", "lanes", "possibleMisses", "echoesPending", "rungAddresses", "lastEventLagMs"]) {
      expect(parsed.doorbell, field).toHaveProperty(field);
    }
  });
});

/** A request that can carry a body: headers, then chunks, then its end. */
function post(
  headers: Record<string, string>,
  url = "/hooks/helius",
): IncomingMessage & { send(chunks: readonly (string | Buffer)[]): void; resumed: boolean } {
  const request = new EventEmitter() as IncomingMessage & { send(chunks: readonly (string | Buffer)[]): void; resumed: boolean };
  Object.assign(request, { method: "POST", url, headers, resumed: false });
  request.resume = function () {
    this.resumed = true;
    return this;
  };
  request.send = (chunks) => {
    for (const chunk of chunks) request.emit("data", Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    request.emit("end");
  };
  return request;
}

function answer(): ServerResponse & { body: string; headers: Record<string, string>; ended: boolean } {
  const response = {
    statusCode: 200,
    body: "",
    headers: {} as Record<string, string>,
    ended: false,
    headersSent: false,
    setHeader(name: string, value: string) {
      this.headers[name.toLowerCase()] = value;
    },
    end(chunk?: string) {
      this.body = chunk ?? "";
      this.ended = true;
      this.headersSent = true;
    },
  };
  return response as unknown as ServerResponse & { body: string; headers: Record<string, string>; ended: boolean };
}

describe("the Helius receiver", () => {
  const healthy = () => decideHealth({ now: 0, startedAt: 0, lastProgressAt: 0, sweepMs: 60_000 });
  const secret = new Secret(DOORBELL_SECRET, "doorbellSecret");

  function receiver() {
    const seen = { accepted: [] as string[], rejected: 0, lost: [] as string[] };
    const hooks: HooksRoute = {
      authorized: authorizationMatcher(secret),
      accepted: (body) => seen.accepted.push(body.toString("utf8")),
      rejected: () => {
        seen.rejected += 1;
      },
      lost: (reason) => seen.lost.push(reason),
    };
    const { redactor, status } = setup();
    return { seen, handler: httpHandler(() => renderStatus(status, redactor), healthy, noBoard, hooks) };
  }
  const tick = () => new Promise((resolve) => setImmediate(resolve));

  it("answers 200 as soon as the body is read and authenticated, and ingests only after the reply", async () => {
    const { seen, handler } = receiver();
    const request = post({ authorization: DOORBELL_SECRET });
    const response = answer();
    handler(request, response);
    request.send(['[{"slot":1,', '"transaction":{"signatures":["s"]}}]']);
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("{}");
    expect(seen.accepted, "not before the reply has gone").toEqual([]);
    await tick();
    expect(seen.accepted).toEqual(['[{"slot":1,"transaction":{"signatures":["s"]}}]']);
  });

  it("refuses a wrong or missing Authorization with 403 — the one 4xx Helius does not retry — and counts it", async () => {
    const { seen, handler } = receiver();
    const attempts: Record<string, string>[] = [{ authorization: `${DOORBELL_SECRET}x` }, { authorization: DOORBELL_SECRET.slice(0, -1) }, {}];
    for (const headers of attempts) {
      const request = post(headers);
      const response = answer();
      handler(request, response);
      expect(response.statusCode).toBe(403);
      expect(response.body).not.toContain(DOORBELL_SECRET);
      expect(request.resumed, "the body is drained, never read").toBe(true);
    }
    await tick();
    expect(seen.rejected).toBe(3);
    expect(seen.accepted).toEqual([]);
  });

  it("compares in constant time over digests, so a wrong length answers the same way", () => {
    // What cannot be timed in a unit test is pinned in the source: both sides
    // hashed to 32 bytes, then timingSafeEqual — never === on the strings.
    const source = readFileSync(fileURLToPath(new URL("../src/status.ts", import.meta.url)), "utf8");
    expect(source).toContain('const expected = createHash("sha256").update(secret.reveal(), "utf8").digest();');
    expect(source).toContain('return timingSafeEqual(createHash("sha256").update(header, "utf8").digest(), expected);');
    const matches = authorizationMatcher(secret);
    expect(matches(DOORBELL_SECRET)).toBe(true);
    expect(matches("short")).toBe(false);
    expect(matches(`${DOORBELL_SECRET}${"x".repeat(1000)}`)).toBe(false);
    expect(matches(undefined)).toBe(false);
  });

  it("refuses a body over 4 MiB with 413 and asks for a full pass, declared or streamed", async () => {
    const { seen, handler } = receiver();
    const declared = post({ authorization: DOORBELL_SECRET, "content-length": String(HOOK_MAX_BODY_BYTES + 1) });
    const first = answer();
    handler(declared, first);
    expect(first.statusCode).toBe(413);

    const streamed = post({ authorization: DOORBELL_SECRET });
    const second = answer();
    handler(streamed, second);
    streamed.send([Buffer.alloc(HOOK_MAX_BODY_BYTES), Buffer.alloc(1), Buffer.alloc(10)]);
    expect(second.statusCode).toBe(413);
    await tick();
    expect(seen.lost).toHaveLength(2);
    expect(seen.accepted).toEqual([]);
  });

  it("lets nothing throw out of the handler: a failing ingest, a throwing matcher, an aborted upload", async () => {
    const { redactor, status } = setup();
    const exploding: HooksRoute = {
      authorized: () => true,
      accepted: () => {
        throw new Error("ingest broke");
      },
      rejected: () => undefined,
      lost: () => undefined,
    };
    const handler = httpHandler(() => renderStatus(status, redactor), healthy, noBoard, exploding);
    const request = post({ authorization: "anything" });
    const response = answer();
    handler(request, response);
    request.send(["[]"]);
    await tick();
    expect(response.statusCode).toBe(200);

    // An upload aborted mid-body emits 'error'. With no listener, Node rethrows
    // it — and this process's uncaughtException trap exits the keeper.
    const aborted = post({ authorization: "anything" });
    handler(aborted, answer());
    expect(() => aborted.emit("error", new Error("aborted"))).not.toThrow();

    const throwingMatcher = httpHandler(() => "{}", healthy, noBoard, {
      ...exploding,
      authorized: () => {
        throw new Error("matcher broke");
      },
    });
    const refused = answer();
    throwingMatcher(post({ authorization: "x" }), refused);
    expect(refused.statusCode).toBe(403);
  });

  it("does not exist while the doorbell is off, and leaves every other route as it was", () => {
    const { redactor, status } = setup();
    const off = httpHandler(() => renderStatus(status, redactor), healthy, noBoard, null);
    const response = answer();
    off(post({ authorization: DOORBELL_SECRET }), response);
    expect(response.statusCode).toBe(404);

    const { handler } = receiver();
    expect(drive(handler, "POST", "/status").status).toBe(405);
    expect(drive(handler, "PUT", "/hooks/helius").status).toBe(405);
    expect(drive(handler, "GET", "/health").status).toBe(200);
    expect(drive(handler, "GET", "/status").status).toBe(200);
    // Off, the route does not exist for any method a page would use.
    expect(drive(off, "GET", "/hooks/helius").status).toBe(404);
  });

  it("answers any other method on the route with 405 and names POST, not a 404 that says it is not there", () => {
    // PROOF, 2026-09-23: with the doorbell on, GET /hooks/helius said 404 while
    // PUT on the same path said 405.
    const { handler } = receiver();
    for (const method of ["GET", "HEAD", "PUT", "DELETE"]) {
      const reply = drive(handler, method, "/hooks/helius");
      expect(reply.status, method).toBe(405);
      expect(reply.headers["allow"], method).toBe("POST");
    }
  });
});

describe("the receiver's body cap", () => {
  // Every other test uses the constant by name, so a tuning edit to 40 MiB kept
  // them all green while the public route buffered ten times more (review,
  // 2026-09-23). The value is the argument: hundreds of full transactions.
  it("is 4 MiB", () => {
    expect(HOOK_MAX_BODY_BYTES).toBe(4 * 1024 * 1024);
  });
});
