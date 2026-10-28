// The worker's deploy gate (src/worker-health.ts): the four phases, the two it
// may begin at and the one direction they move in, GET and HEAD /health and
// nothing else, a body of fixed words and numbers, and the server bin/worker.mts
// listens with — the keeper's heartbeat server, its timeouts set, rejecting a
// port it cannot have.
//
// The handler is driven with a fake request and response, as test/status.test.ts
// drives the keeper's, except where only a socket can answer: HEAD's missing body
// and the listen itself, on an ephemeral port. That bin/worker.mts listens only
// after its refusals, and turns ready only once registered and claiming, is
// test/worker-health-boot.test.ts's, with the real process.

import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { HEARTBEAT_HEADERS_TIMEOUT_MS, HEARTBEAT_REQUEST_TIMEOUT_MS } from "../src/status.js";
import { WORKER_HEALTH_PATH, WorkerHealthGate, listenForHealth, workerHealthHandler, type WorkerHealthStart } from "../src/worker-health.js";

const STARTED = Date.UTC(2026, 9, 28, 12, 0, 0);
const COMMIT = "cde91801a2b3c4d5e6f708192a3b4c5d6e7f8091";

function drive(
  handler: ReturnType<typeof workerHealthHandler>,
  method: string,
  url: string,
): { status: number; body: string; headers: Record<string, string> } {
  let body = "";
  const headers: Record<string, string> = {};
  const response = {
    statusCode: 200,
    headersSent: false,
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value;
    },
    end(chunk?: string) {
      body = chunk ?? "";
    },
  };
  handler({ method, url } as IncomingMessage, response as unknown as ServerResponse);
  return { status: response.statusCode, body, headers };
}

const gateOf = (version = COMMIT, start: WorkerHealthStart = "starting") => new WorkerHealthGate({ version, startedAt: STARTED, slots: 2 }, start);
/** What every phase's body says besides ok and phase. */
const IDENTITY = { role: "worker", version: COMMIT, startedAt: "2026-10-28T12:00:00.000Z", slots: 2 } as const;

/** Every server a test listened with, closed after it whatever it asserted. */
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
});

describe("the four phases", () => {
  it("starts at 503 starting, is 200 only once ready, and 503 again once stopping, for good", () => {
    const gate = gateOf();
    const handler = workerHealthHandler(gate);

    const starting = drive(handler, "GET", "/health");
    expect(starting.status).toBe(503);
    expect(starting.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(starting.body)).toEqual({ ok: false, phase: "starting", ...IDENTITY });

    expect(gate.ready()).toBe(true);
    const ready = drive(handler, "GET", "/health");
    expect(ready.status).toBe(200);
    expect(JSON.parse(ready.body)).toEqual({ ok: true, phase: "ready", ...IDENTITY });
    // SAID ONCE: the step is starting → ready, and a second call is not one.
    expect(gate.ready()).toBe(false);

    gate.stopping();
    const stopping = drive(handler, "GET", "/health");
    expect(stopping.status).toBe(503);
    expect(JSON.parse(stopping.body)).toEqual({ ok: false, phase: "stopping", ...IDENTITY });
    // A WORKER THAT HAS BEGUN ITS SHUTDOWN IS NEVER READY AGAIN.
    expect(gate.ready()).toBe(false);
    expect(drive(handler, "GET", "/health").status).toBe(503);
    expect(gate.phase).toBe("stopping");
  });

  it("goes straight from starting to stopping when the signal comes before the first claim answers", () => {
    const gate = gateOf();
    gate.stopping();
    expect(gate.ready()).toBe(false);
    expect(drive(workerHealthHandler(gate), "GET", "/health").status).toBe(503);
    expect(gate.answer().body).toMatchObject({ ok: false, phase: "stopping" });
  });

  it("answers 200 off for a worker SIP_SOLANA_DISPATCH=off keeps idle — the stop that survives pushes — and off never turns ready", () => {
    const gate = gateOf(COMMIT, "off");
    const handler = workerHealthHandler(gate);
    const off = drive(handler, "GET", "/health");
    expect(off.status).toBe(200);
    expect(off.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(off.body)).toEqual({ ok: true, phase: "off", ...IDENTITY });
    // OFF CLAIMS NOTHING, SO NOTHING MAKES IT READY: the step is starting → ready only.
    expect(gate.ready()).toBe(false);
    expect(gate.phase).toBe("off");
    expect(JSON.parse(drive(handler, "GET", "/health").body)).toEqual({ ok: true, phase: "off", ...IDENTITY });
  });

  it("goes from off to stopping at the signal: 503, for good, never off or ready again", () => {
    const gate = gateOf(COMMIT, "off");
    const handler = workerHealthHandler(gate);
    expect(drive(handler, "GET", "/health").status).toBe(200);
    gate.stopping();
    const stopping = drive(handler, "GET", "/health");
    expect(stopping.status).toBe(503);
    expect(JSON.parse(stopping.body)).toEqual({ ok: false, phase: "stopping", ...IDENTITY });
    expect(gate.ready()).toBe(false);
    expect(gate.phase).toBe("stopping");
    expect(drive(handler, "GET", "/health").status).toBe(503);
  });

  it("begins at starting or at off and nowhere else, whatever an untyped caller hands it", () => {
    expect(gateOf().phase).toBe("starting");
    expect(gateOf(COMMIT, "off").phase).toBe("off");
    for (const start of ["ready", "stopping", "OFF", "", null]) {
      expect(gateOf(COMMIT, start as unknown as WorkerHealthStart).phase, String(start)).toBe("starting");
    }
  });
});

describe("GET and HEAD /health, and nothing else", () => {
  it("answers HEAD with GET's status, in every phase", () => {
    const gate = gateOf();
    const handler = workerHealthHandler(gate);
    expect(drive(handler, "HEAD", "/health").status).toBe(503);
    gate.ready();
    expect(drive(handler, "HEAD", "/health").status).toBe(200);
    gate.stopping();
    expect(drive(handler, "HEAD", "/health").status).toBe(503);
    const off = gateOf(COMMIT, "off");
    expect(drive(workerHealthHandler(off), "HEAD", "/health").status).toBe(200);
    off.stopping();
    expect(drive(workerHealthHandler(off), "HEAD", "/health").status).toBe(503);
  });

  it("reads the path without its query", () => {
    const gate = gateOf();
    gate.ready();
    expect(drive(workerHealthHandler(gate), "GET", "/health?probe=railway").status).toBe(200);
  });

  it("answers any other path 404, whatever the method and the phase, and names the one it serves", () => {
    const gate = gateOf();
    gate.ready();
    const handler = workerHealthHandler(gate);
    for (const [method, url] of [
      ["GET", "/"],
      ["GET", "/status"],
      ["GET", "/leaderboard"],
      ["GET", "/health/"],
      ["GET", "/healthz"],
      ["HEAD", "/status"],
      ["POST", "/hooks/helius"],
      ["DELETE", "/"],
    ] as const) {
      const reply = drive(handler, method, url);
      expect(reply.status, `${method} ${url}`).toBe(404);
      expect(JSON.parse(reply.body), `${method} ${url}`).toEqual({ error: "not found", paths: [WORKER_HEALTH_PATH] });
    }
  });

  it("answers any other method on /health 405 and names GET and HEAD", () => {
    const gate = gateOf();
    gate.ready();
    const handler = workerHealthHandler(gate);
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      const reply = drive(handler, method, "/health");
      expect(reply.status, method).toBe(405);
      expect(reply.headers["allow"], method).toBe("GET, HEAD");
      expect(JSON.parse(reply.body), method).toEqual({ error: "method not allowed" });
    }
  });

  it("answers 500 rather than throw when the gate itself throws: the trap a throw would reach exits the worker mid-job", () => {
    const handler = workerHealthHandler({
      answer: () => {
        throw new Error("the gate broke");
      },
    });
    // drive() would throw if the handler did.
    const reply = drive(handler, "GET", "/health");
    expect(reply.status).toBe(500);
    expect(reply.body).not.toContain("the gate broke");
  });
});

describe("the body: fixed words and numbers", () => {
  const RPC = "https://mainnet.helius-rpc.example.test/?api-key=HeliusKeyNeverServed0003";
  const DB = "postgres://sip:DbPassw0rdNeverServed@db.example.test:5432/sip";
  const SETTLE_KEY = "SettleKeyNeverServed4f9c2a7b1e";
  const PLANTED = [RPC, "HeliusKeyNeverServed0003", DB, "DbPassw0rdNeverServed", SETTLE_KEY];

  /** Every reply a gate gives over its life, every phase and a wrong path and method among them. */
  function lifetime(gate: WorkerHealthGate): string[] {
    const handler = workerHealthHandler(gate);
    const replies = [drive(handler, "GET", "/health"), drive(handler, "GET", "/nope"), drive(handler, "POST", "/health")];
    gate.ready();
    replies.push(drive(handler, "GET", "/health"), drive(handler, "HEAD", "/health"));
    gate.stopping();
    replies.push(drive(handler, "GET", "/health"));
    return replies.map((reply) => `${reply.body} ${JSON.stringify(reply.headers)}`);
  }

  it("carries exactly ok, phase, role, version, startedAt and slots, off included", () => {
    expect(Object.keys(gateOf().answer().body).sort()).toEqual(["ok", "phase", "role", "slots", "startedAt", "version"]);
    expect(Object.keys(gateOf(COMMIT, "off").answer().body).sort()).toEqual(["ok", "phase", "role", "slots", "startedAt", "version"]);
  });

  it("serves the commit only as a hex hash or 'local', and nothing that reached it in any other shape", () => {
    expect(gateOf("local").answer().body.version).toBe("local");
    expect(gateOf("cde9180").answer().body.version).toBe("cde9180");
    for (const version of [...PLANTED, "", "main", "CDE9180", "cde918", "cde9180 ", `${COMMIT}0`, "../../etc/passwd"]) {
      const gate = gateOf(version);
      expect(gate.answer().body.version, JSON.stringify(version)).toBeNull();
      for (const served of lifetime(gate)) for (const secret of PLANTED) expect(served).not.toContain(secret);
    }
  });

  it("serves the start only as a time, and the slots only as a whole number from 1", () => {
    expect(new WorkerHealthGate({ version: "local", startedAt: Number.NaN, slots: 2 }).answer().body.startedAt).toBeNull();
    expect(new WorkerHealthGate({ version: "local", startedAt: 1e20, slots: 2 }).answer().body.startedAt).toBeNull();
    for (const slots of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(new WorkerHealthGate({ version: "local", startedAt: STARTED, slots }).answer().body.slots, String(slots)).toBeNull();
    }
    expect(new WorkerHealthGate({ version: "local", startedAt: STARTED, slots: 8 }).answer().body.slots).toBe(8);
  });

  it("never carries a value from the process's environment — a URL, a key — in any phase", () => {
    const planted: Readonly<Record<string, string>> = { SIP_SOLANA_RPC_URLS: RPC, DATABASE_URL: DB, SIP_SOLANA_SETTLE_KEY: SETTLE_KEY };
    const before = Object.fromEntries(Object.keys(planted).map((name) => [name, process.env[name]]));
    Object.assign(process.env, planted);
    try {
      for (const gate of [gateOf(), gateOf(COMMIT, "off")]) for (const served of lifetime(gate)) for (const secret of PLANTED) expect(served).not.toContain(secret);
    } finally {
      for (const [name, value] of Object.entries(before)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});

describe("the server bin/worker.mts listens with", () => {
  const listenedPort = (server: Server): number => (server.address() as { port: number }).port;

  it("is the keeper's heartbeat server, its timeouts set, and answers HEAD with no body over a real socket", async () => {
    const gate = gateOf();
    const server = await listenForHealth(gate, 0, () => undefined);
    servers.push(server);
    expect(server.requestTimeout).toBe(HEARTBEAT_REQUEST_TIMEOUT_MS);
    expect(server.headersTimeout).toBe(HEARTBEAT_HEADERS_TIMEOUT_MS);
    const base = `http://127.0.0.1:${listenedPort(server)}`;

    const startingHead = await fetch(`${base}${WORKER_HEALTH_PATH}`, { method: "HEAD" });
    expect(startingHead.status).toBe(503);
    expect(await startingHead.text()).toBe("");
    gate.ready();
    const readyHead = await fetch(`${base}${WORKER_HEALTH_PATH}`, { method: "HEAD" });
    expect(readyHead.status).toBe(200);
    expect(readyHead.headers.get("content-type")).toBe("application/json");
    expect(await readyHead.text()).toBe("");
    const readyGet = await fetch(`${base}${WORKER_HEALTH_PATH}`);
    expect(readyGet.status).toBe(200);
    expect(await readyGet.json()).toMatchObject({ ok: true, phase: "ready", role: "worker" });
    expect((await fetch(`${base}/status`)).status).toBe(404);
  });

  it("rejects when the port is taken — bin/worker.mts exits 1 on it", async () => {
    const holder = createServer();
    await new Promise<void>((done) => holder.listen(0, done));
    const port = (holder.address() as { port: number }).port;
    try {
      await expect(listenForHealth(gateOf(), port, () => undefined)).rejects.toMatchObject({ code: "EADDRINUSE" });
    } finally {
      await new Promise<void>((done) => holder.close(() => done()));
    }
  });

  it("hands an error that comes after listening to its caller, and throws nothing into the process", async () => {
    const late: Error[] = [];
    const server = await listenForHealth(gateOf(), 0, (error) => void late.push(error));
    servers.push(server);
    expect(() => server.emit("error", new Error("accept failed"))).not.toThrow();
    expect(late.map((error) => error.message)).toEqual(["accept failed"]);
  });
});
