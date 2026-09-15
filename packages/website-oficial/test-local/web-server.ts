// The web's production build, served on localhost:3015 against the local
// validator, for the local proof. It never builds, and it stops what it started.
//
// THE BUILD MUST EXIST. `pnpm --filter @sip/web run build` writes .next/BUILD_ID;
// without it this refuses, rather than build (a build here would prove a tree
// nobody checked).
//
// A CLEAN ENVIRONMENT. `next start` gets PATH and exactly the settings below, and
// no SIP_*, PRIVY_*, NUVEM_* or ANCHOR_* name from this process. Next also loads
// the package's own .env* files, which this harness never reads: if one adds a
// refused name, the Solana routes answer 503 and the start fails naming that cause.
//
// localhost, never 127.0.0.1, as the page itself is served. Every request sends
// x-real-ip, the one client-IP header the settings trust.
//
// NOTHING LEFT. stop() reports the process exited, the port refused on both
// loopbacks and its temporary HOME removed; proofPortsInUse() lets the proof check
// this port with the validator's before anything starts and after both stop.

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Keypair } from "@solana/web3.js";

import { LOCAL_PORTS, SIP_VAULT_PROGRAM_ID, busyPorts, tcpRefused } from "./local-validator";

export const WEB_PORT = 3_015;
export const WEB_ORIGIN = `http://localhost:${WEB_PORT}`;
export const CLIENT_IP_HEADERS = { "x-real-ip": "127.0.0.1" } as const;

const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));
const READY_TIMEOUT_MS = 60_000;
const STOP_GRACE_MS = 10_000;

export interface StoppedWebServer {
  readonly exited: boolean;
  readonly portRefused: boolean;
  /** Its temporary HOME was removed. */
  readonly homeGone: boolean;
}

export interface WebServer {
  stop(): Promise<StoppedWebServer>;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Nothing listens on `port`, on either loopback address. */
export const portRefused = async (port: number): Promise<boolean> => (await tcpRefused(port, "127.0.0.1")) && (await tcpRefused(port, "::1"));

/**
 * Every port the proof binds that something already holds: the validator's, over
 * TCP and UDP, and this server's. Empty before anything starts, and empty again
 * once both are stopped. It names ports and stops nothing.
 */
export async function proofPortsInUse(): Promise<number[]> {
  const busy = await busyPorts();
  return (await portRefused(WEB_PORT)) ? busy : [...busy, WEB_PORT];
}

/** fetch with the trusted client-IP header added. */
export const withClientIp: typeof fetch = (input, init) => fetch(input, { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), ...CLIENT_IP_HEADERS } });

export async function startWebServer(): Promise<WebServer> {
  if (!existsSync(join(PACKAGE_DIR, ".next", "BUILD_ID"))) {
    throw new Error("there is no production build: run `pnpm --filter @sip/web run build` first. This harness never builds.");
  }
  if (!(await portRefused(WEB_PORT))) throw new Error(`port ${WEB_PORT} is in use. Nothing was stopped.`);

  const home = mkdtempSync(join(tmpdir(), "sip-web-server-"));
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "",
    NODE_ENV: "production",
    NEXT_TELEMETRY_DISABLED: "1",
    HOME: home,
    SIP_SOLANA_RPC_URLS: `http://127.0.0.1:${LOCAL_PORTS.rpc}`,
    SIP_SOLANA_PROGRAM_ID: SIP_VAULT_PROGRAM_ID.toBase58(),
    SIP_TRUSTED_CLIENT_IP_HEADER: "x-real-ip",
    SIP_SOLANA_SEND_PER_MIN: "120",
    SIP_SOLANA_RELAY_PER_MIN: "1200",
  };
  const child = spawn(join(PACKAGE_DIR, "node_modules", ".bin", "next"), ["start", "--port", String(WEB_PORT), "--hostname", "localhost"], {
    cwd: PACKAGE_DIR,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const keep = (chunk: Buffer): void => {
    output = (output + chunk.toString("utf8")).slice(-8_000);
  };
  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);

  const hasExited = (): boolean => child.exitCode !== null || child.signalCode !== null;
  const exitWithin = (ms: number): Promise<boolean> =>
    new Promise((resolve) => {
      if (hasExited()) return resolve(true);
      const onExit = (): void => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        child.off("exit", onExit);
        resolve(hasExited());
      }, ms);
      child.once("exit", onExit);
    });

  const killNow = (): void => {
    if (!hasExited()) child.kill("SIGKILL");
  };
  process.once("exit", killNow);

  let stopped: Promise<StoppedWebServer> | null = null;
  const stop = (): Promise<StoppedWebServer> =>
    (stopped ??= (async () => {
      process.off("exit", killNow);
      if (!hasExited()) {
        child.kill("SIGTERM");
        if (!(await exitWithin(STOP_GRACE_MS))) {
          child.kill("SIGKILL");
          await exitWithin(STOP_GRACE_MS);
        }
      }
      rmSync(home, { recursive: true, force: true });
      return { exited: hasExited(), portRefused: await portRefused(WEB_PORT), homeGone: !existsSync(home) };
    })());

  try {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    for (;;) {
      if (hasExited()) throw new Error(`next start exited (code ${child.exitCode}) before it answered`);
      const health = await fetch(`${WEB_ORIGIN}/api/health`).catch(() => null);
      if (health?.status === 200) break;
      if (Date.now() >= deadline) throw new Error(`GET /api/health did not answer 200 within ${READY_TIMEOUT_MS / 1_000} s`);
      await sleep(250);
    }
    const probe = await withClientIp(`${WEB_ORIGIN}/api/solana-vault`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "state", owner: Keypair.generate().publicKey.toBase58(), wallets: [] }),
    });
    if (probe.status === 503) {
      throw new Error("the gate is invalid; if the package's own environment files add a refused name, remove it. This harness reads none of them.");
    }
    if (probe.status !== 200) throw new Error(`POST /api/solana-vault answered ${probe.status}, not 200`);
  } catch (error) {
    await stop();
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n--- next start output ---\n${output.slice(-3_000)}`);
  }
  return { stop };
}
