// The heartbeat surface.
//
// The property under test is the SPLIT: /health must not fail for conditions a
// restart cannot fix. A probe that went red because the RPC was busy, or because
// the keeper had deliberately halted, would restart-loop the one service in this
// repo that holds a signing key — and a halted keeper has to stay up to explain
// itself.

import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { startHealthServer, type HealthSnapshot } from "../src/health.js";
import { Redactor, createLogger } from "../src/log.js";

const servers: { close: () => void }[] = [];
afterEach(() => {
  while (servers.length > 0) servers.pop()?.close();
});

const silent = createLogger({ redactor: new Redactor(), sink: () => {}, minLevel: "error" });

async function serve(
  health: HealthSnapshot,
  status: () => Promise<Record<string, unknown>> = async () => ({ ok: true }),
): Promise<string> {
  const server = startHealthServer({ host: "127.0.0.1", port: 0, logger: silent, health: () => health, status });
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

const healthy: HealthSnapshot = {
  service: "@nuvem/keeper",
  mode: "dry-run",
  uptimeS: 120,
  lastTickAgeS: 12,
  wedged: false,
};

describe("/health", () => {
  it("returns 200 and makes no chain call at all", async () => {
    let statusCalls = 0;
    const base = await serve(healthy, async () => {
      statusCalls += 1;
      return {};
    });
    const response = await fetch(`${base}/health`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.status).toBe("ok");
    expect(body.mode).toBe("dry-run");
    expect(body.lastTickAgeS).toBe(12);
    // The expensive, chain-touching path was never reached.
    expect(statusCalls).toBe(0);
  });

  it("returns 503 only when the tick loop is wedged", async () => {
    const base = await serve({ ...healthy, wedged: true });
    const response = await fetch(`${base}/health`);
    expect(response.status).toBe(503);
    expect(((await response.json()) as Record<string, unknown>).status).toBe("wedged");
  });

  it("stays green for a keeper that is halted, and says so via /status instead", async () => {
    // A degraded latch is a deliberate stop, not a crash. Restarting would not
    // clear it (the latch is in the journal) and would only churn the container.
    const base = await serve(healthy, async () => ({ degraded: { reason: "NONCE_UNRECONCILED" } }));
    expect((await fetch(`${base}/health`)).status).toBe(200);
    const status = (await (await fetch(`${base}/status`)).json()) as Record<string, unknown>;
    expect(status.degraded).toEqual({ reason: "NONCE_UNRECONCILED" });
  });
});

describe("/status", () => {
  it("serializes bigints rather than throwing", async () => {
    const base = await serve(healthy, async () => ({ contribution: 403370889498747n }));
    const body = await (await fetch(`${base}/status`)).text();
    expect(body).toContain('"403370889498747"');
  });

  it("does not leak an upstream error message into the response body", async () => {
    // viem annotates transport errors with the endpoint, and the endpoint carries
    // an API key. The response says nothing; the redacting logger has the detail.
    const base = await serve(healthy, async () => {
      throw new Error("HTTP 429\nURL: https://x.g.alchemy.com/v2/SECRETKEY");
    });
    const response = await fetch(`${base}/status`);
    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).not.toContain("SECRETKEY");
    expect(body).not.toContain("alchemy");
  });
});

describe("the surface is read-only", () => {
  it("refuses anything that is not GET or HEAD", async () => {
    const base = await serve(healthy);
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const response = await fetch(`${base}/status`, { method });
      expect(response.status, method).toBe(405);
    }
  });

  it("404s an unknown path and names what does exist", async () => {
    const base = await serve(healthy);
    const response = await fetch(`${base}/settle`);
    expect(response.status).toBe(404);
    expect(((await response.json()) as { endpoints: string[] }).endpoints).toEqual(["/health", "/status"]);
  });
});
