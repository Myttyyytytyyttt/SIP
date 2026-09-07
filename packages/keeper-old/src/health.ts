// The heartbeat surface: GET /health and GET /status.
//
// TWO ENDPOINTS, AND THE SPLIT IS THE WHOLE POINT.
//
// /health is what a container probe reads. It makes NO RPC call and touches NO
// file. It fails only when the tick loop is wedged, because that is the only
// condition a restart actually fixes. An unreachable RPC, a tripped circuit
// breaker, a degraded latch — none of those fail this probe, and none of them
// should: restarting has never once fixed an upstream RPC, and a halted keeper
// must stay UP to explain itself. A probe that talked to the chain would turn a
// provider hiccup into a restart loop, which is strictly worse than a keeper
// sitting still and saying why.
//
// /status is the operator and alerting view. It reads the chain and the journal,
// it is allowed to be slow, and it must never appear in a HEALTHCHECK. Every
// chain-derived field in it is a {ok,value} | {ok,error} pair rather than a bare
// value, because a green tick for something that was not verified is the exact
// bug this codebase exists to prevent.
//
// The port is deliberately not published in docker-compose.yml: /status
// describes a service holding a signing key. It is reachable from a sibling
// container on the compose network, or via `docker compose exec`.

import { createServer, type Server } from "node:http";
import type { Logger } from "./log.js";

export interface HealthSnapshot {
  readonly service: string;
  readonly mode: string;
  readonly uptimeS: number;
  /** Seconds since the last completed tick, or null before the first one. */
  readonly lastTickAgeS: number | null;
  readonly wedged: boolean;
}

export interface HealthServerOptions {
  readonly host: string;
  readonly port: number;
  readonly logger: Logger;
  readonly health: () => HealthSnapshot;
  /** Chain-touching. Only ever called for /status. */
  readonly status: () => Promise<Record<string, unknown>>;
}

const big = (_key: string, value: unknown): unknown => (typeof value === "bigint" ? value.toString() : value);

export function startHealthServer(options: HealthServerOptions): Server {
  const server = createServer((request, response) => {
    // Everything here is read-only and unauthenticated, so nothing but GET is
    // accepted. A keeper holding a signing key should not grow a mutating HTTP
    // surface by accident.
    const url = (request.url ?? "/").split("?")[0];
    const send = (status: number, body: unknown): void => {
      const text = `${JSON.stringify(body, big, 2)}\n`;
      response.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(text);
    };

    if (request.method !== "GET" && request.method !== "HEAD") {
      send(405, { error: "only GET is supported" });
      return;
    }

    if (url === "/health" || url === "/") {
      const snapshot = options.health();
      send(snapshot.wedged ? 503 : 200, {
        status: snapshot.wedged ? "wedged" : "ok",
        service: snapshot.service,
        mode: snapshot.mode,
        uptimeS: snapshot.uptimeS,
        lastTickAgeS: snapshot.lastTickAgeS,
      });
      return;
    }

    if (url === "/status") {
      options
        .status()
        .then((payload) => send(200, payload))
        .catch((error: unknown) => {
          // Even a failed /status goes through the redacting logger, and the
          // response carries only a truncated message: viem annotates transport
          // errors with the endpoint, and the endpoint carries an API key.
          options.logger.error("/status failed", { error });
          send(500, { error: "status unavailable; see the service log" });
        });
      return;
    }

    send(404, { error: "not found", endpoints: ["/health", "/status"] });
  });

  server.on("error", (error) => {
    options.logger.error("health server error", { error });
  });
  // Never let the heartbeat hold the process open on its own.
  server.unref();
  server.listen(options.port, options.host, () => {
    options.logger.info("heartbeat listening", { host: options.host, port: options.port });
  });
  return server;
}
