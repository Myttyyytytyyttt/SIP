// THE OWNER'S FLEET TOOL, REHEARSED ON POSTGRES 16: test-local/shadow/flota-prod.mts
// run as the owner runs it — a child process, his words, «si» typed on its
// stdin — against a throwaway database that bin/setup-read-model.mts built, the
// real bin/dispatch-handover.mts under it, two DRY legacy keepers reading
// through the real LegacySelector beside it, a loopback JSON-RPC answering block
// heights, and loopback /status pages this file controls. Nothing here reads a
// chain or a production page.
//
// RUN ONLY WITH A THROWAWAY DATABASE ON THE LOOPBACK, as the other -pg tests:
// KEEPER_TEST_PG_URL names a server on 127.0.0.1 (the tool's rehearsal accepts
// nothing else), e.g. a `docker run --rm postgres:16-alpine`; the run creates its
// own database and drops it at the end. Without the variable — or without
// test-local/, which no image carries — the block is skipped and says why.
//
// EITHER dispatch-handover. `status --all` and `unpark` are being added beside
// this tool; the run asks the CLI which it is and checks what the tool does with
// each: every vault listed, or the plain `status` and the refusals that say so.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PublicKey } from "@solana/web3.js";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LegacySelector } from "../src/dispatch-select.js";
import { short } from "../src/owner-fleet.js";

const KEEPER = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TOOL = "test-local/shadow/flota-prod.mts";
const URL_RAW = process.env["KEEPER_TEST_PG_URL"];
const usable = ((): boolean => {
  if (URL_RAW === undefined || URL_RAW.trim() === "") return false;
  const host = new URL(URL_RAW).hostname;
  if (!["127.0.0.1", "localhost", "[::1]", "::1"].includes(host)) throw new Error("KEEPER_TEST_PG_URL must point at the loopback; it names another host");
  return host === "127.0.0.1" && existsSync(resolve(KEEPER, TOOL));
})();

/** Valid base58 addresses of 32 bytes, made up: nothing here reads a chain. */
const address = (byte: number): string => new PublicKey(new Uint8Array(32).fill(byte)).toBase58();
const LEGACY_A = address(11);
const LEGACY_B = address(12);
const LEGACY_C = address(13);
const QUEUED = address(14);
const PARKED = address(15);
const OLD_PROCESS = "old-profit-0001-0000-0000-000000000000";

interface Ran {
  readonly code: number;
  readonly out: string;
}

describe.skipIf(!usable)("flota-prod on Postgres 16, rehearsed (needs KEEPER_TEST_PG_URL on 127.0.0.1)", () => {
  const database = `keeper_flota_${process.pid}_${Date.now()}`;
  let admin: pg.Pool;
  let db: pg.Pool;
  let dbUrl = "";
  let pages: Server;
  let rpc: Server;
  let pagesBase = "";
  let rpcUrl = "";
  let keepers: ReturnType<typeof setInterval> | undefined;
  let newCli = false;
  let height = 1_000;
  let schedulerPage: Record<string, unknown> = {};

  /** The scheduler's page as production serves it (fleet-status.ts + bin/scheduler.mts), healthy, with `autoArm` as given (absent: an older scheduler). */
  const setScheduler = (autoArm?: Record<string, unknown>): void => {
    schedulerPage = {
      service: "sip-solana-keeper",
      role: "scheduler",
      health: { ok: true },
      read: { ok: true, lastError: null },
      fleet: {
        scheduler: { tickAgeMs: 20_000 },
        workers: [{ workerId: "worker:1", kind: "worker", heartbeatAgeMs: 4_000, dead: false, stoppedAt: null, slots: 2, busy: 0, stats: { jobsLast10Min: 3 } }],
        queue: { due: 0, oldestDueMs: null, leases: { expired: 0 }, parked: { count: 1, vaults: [] } },
      },
      alerts: { firing: [] },
      scheduler: { role: "acting", mode: "on", ...(autoArm === undefined ? {} : { autoArm }) },
    };
  };

  const run = (command: string, args: readonly string[], env: Record<string, string>, input = ""): Promise<Ran> =>
    new Promise((done) => {
      const child = spawn(command, [...args], { cwd: KEEPER, env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", ...env }, stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      child.stdout.on("data", (chunk: Buffer) => void (out += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => void (out += chunk.toString()));
      child.stdin.end(input);
      child.on("close", (code) => done({ code: code ?? 1, out }));
    });

  /** The tool, as flota-prod.sh starts it, in a rehearsal against this database and these stand-ins. */
  const tool = (args: readonly string[], input = "", over: Record<string, string> = {}): Promise<Ran> =>
    run("node_modules/.bin/tsx", [TOOL, ...args], {
      PROD_DB: dbUrl,
      SIP_FLOTA_TOOL_REHEARSAL: "1",
      SIP_FLOTA_TOOL_PAGES: pagesBase,
      SIP_FLOTA_TOOL_RPC: rpcUrl,
      SIP_FLOTA_TOOL_POLL_MS: "150",
      ...over,
    }, input);

  const system = async (vault: string): Promise<string | null> =>
    ((await db.query("SELECT system FROM sip_solana.vault_work WHERE vault_addr = $1", [vault])).rows[0]?.["system"] as string | undefined) ?? null;
  const flag = async (): Promise<string> => (await db.query("SELECT new_vault_system FROM sip_solana.fleet WHERE id")).rows[0]!["new_vault_system"] as string;

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: URL_RAW!, max: 1 });
    admin.on("error", () => undefined);
    await admin.query(`CREATE DATABASE ${database}`);
    const parsed = new URL(URL_RAW!);
    parsed.pathname = `/${database}`;
    if (!parsed.searchParams.has("sslmode")) parsed.searchParams.set("sslmode", "disable");
    dbUrl = parsed.toString();

    // THE SCHEMA, AS PRODUCTION GOT IT: bin/setup-read-model.mts.
    const setup = await run("node_modules/.bin/tsx", ["bin/setup-read-model.mts"], { DATABASE_URL: dbUrl });
    expect(setup.code, setup.out).toBe(0);
    db = new pg.Pool({ connectionString: dbUrl, max: 3 });
    db.on("error", () => undefined);

    // THE FLEET: three legacy vaults, the owner's in the queue with a job done, one parked, and a container long gone but not marked.
    await db.query(
      `INSERT INTO sip_solana.vault_work (vault_addr, system, skim_mode, last_outcome, last_done_at, attempts, parked_reason, streaks) VALUES
         ($1, 'legacy', 0, NULL, NULL, 0, NULL, '{}'),
         ($2, 'legacy', 0, NULL, NULL, 0, NULL, '{}'),
         ($3, 'legacy', 1, NULL, NULL, 0, NULL, '{}'),
         ($4, 'queue', 1, 'settle IDLE,IDLE · invest IDLE', clock_timestamp() - interval '2 minutes', 0, NULL, '{"investRefused": 3}'),
         ($5, 'queue', 0, 'THREW', clock_timestamp() - interval '1 hour', 5,
          'its lease lapsed 5 claims in a row without a completion: a job that never ends; parked by the scheduler until an operator clears parked_reason', '{}')`,
      [LEGACY_A, LEGACY_B, LEGACY_C, QUEUED, PARKED],
    );
    await db.query(
      `INSERT INTO sip_solana.legacy_process (process_id, role, dispatch, deployment, host, live, read_at, seen, absent_is, carry_store)
       VALUES ($1, 'profit', 'on', 'dep-old', 'old-box', true, clock_timestamp() - interval '1 hour', '{}', 'legacy', 'dual')`,
      [OLD_PROCESS],
    );

    // TWO DRY LEGACY KEEPERS, reading as the real ones do, five times a second.
    const runner = async (text: string, values: readonly unknown[]) => (await db.query(text, [...values])).rows;
    const selectors = (["profit", "volume"] as const).map(
      (role) => new LegacySelector({ role, mode: "on", processId: `rehearsal-${role}`, deployment: `dep-${role}`, host: "here", carryStore: "on", run: runner }),
    );
    const sweep = async (): Promise<void> => void (await Promise.all(selectors.map((selector) => selector.read({ live: false, carryVaults: [], now: Date.now() }))));
    await sweep();
    keepers = setInterval(() => void sweep(), 200);

    // THE CHAIN'S HEIGHTS: every PROCESSED read a hundred blocks on, so 150 blocks pass within two arms;
    // a FINALIZED read answers the last processed one less 32, as a chain does — never above it (the
    // newer dispatch-handover refuses a processed height below the finalized one: two endpoints out of step).
    rpc = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => void (body += chunk.toString()));
      request.on("end", () => {
        const call = JSON.parse(body) as { id: unknown; method: string; params?: readonly { commitment?: string }[] };
        const commitment = call.params?.[0]?.commitment;
        if (commitment !== "finalized") height += 100;
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify(
            call.method === "getBlockHeight"
              ? { jsonrpc: "2.0", id: call.id, result: commitment === "finalized" ? height - 32 : height }
              : { jsonrpc: "2.0", id: call.id, error: { code: -32601, message: "only heights here" } },
          ),
        );
      });
    });
    pages = createServer((request, response) => {
      const keeper = { mode: "dry", armed: false, lastSweepAt: new Date().toISOString(), dispatch: { mode: "on" } };
      const body = request.url === "/scheduler/status" ? schedulerPage : request.url === "/keeper/status" || request.url === "/volume-keeper/status" ? keeper : null;
      response.statusCode = body === null ? 404 : 200;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(body ?? {}));
    });
    await Promise.all([new Promise<void>((ok) => rpc.listen(0, "127.0.0.1", ok)), new Promise<void>((ok) => pages.listen(0, "127.0.0.1", ok))]);
    rpcUrl = `http://127.0.0.1:${(rpc.address() as AddressInfo).port}`;
    pagesBase = `http://127.0.0.1:${(pages.address() as AddressInfo).port}`;
    setScheduler();

    // WHICH dispatch-handover is this: does it list every vault?
    newCli = (await run("node_modules/.bin/tsx", ["bin/dispatch-handover.mts", "status", "--all"], { DATABASE_URL: dbUrl })).code === 0;
  }, 60_000);

  afterAll(async () => {
    if (keepers !== undefined) clearInterval(keepers);
    await new Promise<void>((ok) => (rpc?.listening ? rpc.close(() => ok()) : ok()));
    await new Promise<void>((ok) => (pages?.listening ? pages.close(() => ok()) : ok()));
    await db?.end().catch(() => undefined);
    if (admin !== undefined) {
      await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`).catch(() => undefined);
      await admin.end();
    }
  });

  it("refuses the loopback outside a rehearsal, naming the host and never the url", async () => {
    const ran = await tool(["flota"], "", { SIP_FLOTA_TOOL_REHEARSAL: "0", SIP_FLOTA_TOOL_PAGES: "", SIP_FLOTA_TOOL_RPC: "", SIP_FLOTA_TOOL_POLL_MS: "" });
    expect(ran.code).toBe(2);
    expect(ran.out).toContain("apunta a «127.0.0.1», que no es Supabase");
    expect(ran.out).not.toContain(dbUrl);
  }, 30_000);

  it("flota: every vault it can see, who serves it, the receipts, the pages, what next — and touches nothing", async () => {
    const ran = await tool(["flota"]);
    expect(ran.code, ran.out).toBe(0);
    expect(ran.out).not.toContain(dbUrl);
    expect(ran.out).toContain("(ENSAYO: base local; los keepers en seco cuentan)");
    expect(ran.out).toContain(`  ${short(QUEUED)}  sistema nuevo`);
    expect(ran.out).toContain("Vaults nuevos: van a los keepers de siempre.");
    expect(ran.out).toMatch(/keeper de beneficios: vivo · leyó (?:hace \d+ s|ahora mismo) · en seco · pérdidas en la base: on · id rehearsal-profit/);
    expect(ran.out).toContain(`keeper de beneficios: viejo · leyó hace 60 min · actuando · pérdidas en la base: dual · id ${OLD_PROCESS}`);
    expect(ran.out).toContain("el keeper de volumen: contesta · en seco");
    expect(ran.out).toContain("Scheduler: sano · última vuelta hace 20 s (contestó la que manda)");
    expect(ran.out).toContain("se arma solo: no (esta versión no lo hace)");
    expect(ran.out).toContain("Hay keepers que llevan más de 15 min sin leer");
    if (newCli) {
      expect(ran.out).toContain("Vaults (5):");
      expect(ran.out).toContain(`  ${short(PARKED)}  aparcado · beneficio`);
      expect(ran.out).toContain(`  ${short(LEGACY_A)}  keepers de siempre · beneficio`);
      expect(ran.out).toContain(`  ${short(LEGACY_C)}  keepers de siempre · volumen`);
      expect(ran.out).toContain("cobro: sin operaciones nuevas (2 carteras) · compra: nada que comprar");
      expect(ran.out).toContain("OJO: lleva 3 compras rechazadas seguidas");
      expect(ran.out).toContain("su trabajo se cortó 5 veces seguidas sin terminar");
      // THE OLD CONTAINER'S RECEIPT RUNS THE CARRY STORE dual, and the profit keeper reading now runs on: the old
      // one is the container a redeploy replaced, and what is asked is «marcar-ido», not the variable again.
      expect(ran.out).toContain(`Quedan 3 con los keepers de siempre. Antes de traspasar: «marcar-ido ${OLD_PROCESS}», el contenedor que el redespliegue del paso 3 sustituyó`);
      expect(ran.out).not.toContain("Antes de traspasar: SIP_SOLANA_CARRY_STORE=on en sip-solana-keeper");
    } else {
      expect(ran.out).toContain("Vaults (2):");
      // AN OLDER CLI does not say a vault is parked: it is shown as the queue's, and not as parked.
      expect(ran.out).toContain(`  ${short(PARKED)}  sistema nuevo`);
      expect(ran.out).toContain("(esta versión de dispatch-handover solo me enseña los que no son de los keepers de siempre)");
      expect(ran.out).not.toContain(short(LEGACY_A));
    }
    expect(await system(LEGACY_A)).toBe("legacy");
    expect(await flag()).toBe("legacy");
  }, 60_000);

  it("nuevos-a-la-cola: refused while the scheduler does not arm by itself, or a stale receipt would stall it", async () => {
    setScheduler();
    let ran = await tool(["nuevos-a-la-cola"]);
    expect(ran.code, ran.out).toBe(1);
    expect(ran.out).toContain("NO: esta versión del scheduler no se arma sola");
    expect(ran.out).toContain("No he tocado nada");
    setScheduler({ enabled: false, legacyRoles: ["profit", "volume"] });
    ran = await tool(["nuevos-a-la-cola"]);
    expect(ran.code, ran.out).toBe(1);
    expect(ran.out).toContain("el scheduler no se arma solo (lo tiene apagado)");
    setScheduler({ enabled: true, legacyRoles: ["profit", "volume"], pending: [], lastArmedAt: null, lastResults: [], lastError: null });
    ran = await tool(["nuevos-a-la-cola"]);
    expect(ran.code, ran.out).toBe(1);
    expect(ran.out).toContain(`hay 1 recibo viejo sin marcar como ido (${OLD_PROCESS})`);
    expect(await flag()).toBe("legacy");
  }, 90_000);

  it("traspasar: refused while an old container has not let go, naming what to type", async () => {
    const ran = await tool(["traspasar", LEGACY_A]);
    expect(ran.code, ran.out).toBe(1);
    expect(ran.out).toContain(`con id ${OLD_PROCESS} no lee desde hace 60 min y no ha soltado este vault`);
    expect(ran.out).toContain(`«marcar-ido ${OLD_PROCESS}»`);
    // ... AND ITS CARRY STORE IS dual: a PROFIT vault waits for every profit receipt on `on` (10.8 step 3) —
    // here the container a redeploy replaced, beside the profit keeper reading now with on.
    expect(ran.out).toContain(`(id ${OLD_PROCESS}, SIP_SOLANA_CARRY_STORE=dual) es el contenedor que un redespliegue sustituyó`);
    expect(ran.out).toContain("No he tocado nada.");
    expect(await system(LEGACY_A)).toBe("legacy");
  }, 30_000);

  it("marcar-ido: says to check Railway first; without «si» touches nothing, with it marks the process", async () => {
    const goneAt = async (): Promise<unknown> => (await db.query("SELECT gone_at FROM sip_solana.legacy_process WHERE process_id = $1", [OLD_PROCESS])).rows[0]!["gone_at"];
    let ran = await tool(["marcar-ido", "old-profit-0001"], "no\n");
    expect(ran.code, ran.out).toBe(1);
    expect(ran.out).toContain("ANTES: comprueba en Railway que ese deployment ya no existe");
    expect(ran.out).toContain(`keeper de beneficios · id ${OLD_PROCESS} · despliegue dep-old · máquina old-box`);
    expect(await goneAt()).toBeNull();
    // A LIVE ONE IS REFUSED before anything is asked.
    ran = await tool(["marcar-ido", "rehearsal-profit"], "si\n");
    expect(ran.code, ran.out).toBe(1);
    expect(ran.out).toContain("está vivo, no lo marco");
    ran = await tool(["marcar-ido", "old-profit-0001"], "si\n");
    expect(ran.code, ran.out).toBe(0);
    expect(ran.out).toContain(`LISTO: marcado como ido: ${OLD_PROCESS}.`);
    expect(await goneAt()).not.toBeNull();
  }, 60_000);

  it("nuevos-a-la-cola, with a scheduler that arms by itself, flips the flag; nuevos-a-los-de-siempre flips it back", async () => {
    let ran = await tool(["nuevos-a-la-cola"]);
    expect(ran.code, ran.out).toBe(0);
    expect(ran.out).toContain("LISTO: desde ahora un vault nuevo entra «pasando»");
    expect(await flag()).toBe("queue");
    ran = await tool(["nuevos-a-la-cola"]);
    expect(ran.out).toContain("ya van al sistema nuevo. Nada que hacer.");
    ran = await tool(["nuevos-a-los-de-siempre"]);
    expect(ran.code, ran.out).toBe(0);
    expect(await flag()).toBe("legacy");
  }, 60_000);

  it("traspasar: drain, the dry keepers' receipts, 150 blocks, and the vault is in the queue", async () => {
    const ran = await tool(["traspasar", LEGACY_A]);
    expect(ran.code, ran.out).toBe(0);
    expect(ran.out).toContain(`2/3  ${short(LEGACY_A)} pasa a «pasando»`);
    expect(ran.out).toMatch(/esperando a que pasen los bloques \(faltan \d+ bloques\)/);
    expect(ran.out).toContain(`LISTO: ${short(LEGACY_A)} está en el sistema nuevo.`);
    expect(ran.out).not.toContain(dbUrl);
    expect(await system(LEGACY_A)).toBe("queue");
    const again = await tool(["traspasar", LEGACY_A]);
    expect(again.code).toBe(0);
    expect(again.out).toContain("ya está en el sistema nuevo. Nada que hacer.");
  }, 90_000);

  it("traspasar: refused while another vault is draining", async () => {
    await db.query("UPDATE sip_solana.vault_work SET system = 'draining' WHERE vault_addr = $1", [LEGACY_B]);
    try {
      const ran = await tool(["traspasar", LEGACY_C]);
      expect(ran.code, ran.out).toBe(1);
      expect(ran.out).toContain(`el vault ${short(LEGACY_B)} está a medio pasar`);
      expect(await system(LEGACY_C)).toBe("legacy");
    } finally {
      await db.query("UPDATE sip_solana.vault_work SET system = 'legacy' WHERE vault_addr = $1", [LEGACY_B]);
    }
  }, 30_000);

  it("traspasar, stopped with Ctrl-C after the drain: says the vault is «pasando», and what to type to finish it or hand it back", async () => {
    // A RECEIPT THAT READ 30 s AGO AND NEVER READS AGAIN: the pre-checks pass, and arm waits on it — the wait the owner interrupts.
    await db.query(
      `INSERT INTO sip_solana.legacy_process (process_id, role, dispatch, deployment, host, live, read_at, seen, absent_is, carry_store)
       VALUES ('frozen-profit', 'profit', 'on', 'dep-frozen', 'box', true, clock_timestamp() - interval '30 seconds', '{}', 'legacy', 'on')`,
    );
    try {
      const child = spawn("node_modules/.bin/tsx", [TOOL, "traspasar", LEGACY_B], {
        cwd: KEEPER,
        env: {
          PATH: process.env["PATH"] ?? "",
          HOME: process.env["HOME"] ?? "",
          PROD_DB: dbUrl,
          SIP_FLOTA_TOOL_REHEARSAL: "1",
          SIP_FLOTA_TOOL_PAGES: pagesBase,
          SIP_FLOTA_TOOL_RPC: rpcUrl,
          SIP_FLOTA_TOOL_POLL_MS: "150",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      const ended = new Promise<number | null>((done) => child.on("close", (code) => done(code)));
      await new Promise<void>((waiting, failed) => {
        const timer = setTimeout(() => failed(new Error(`no wait to interrupt:\n${out}`)), 40_000);
        const watch = (chunk: Buffer): void => {
          out += chunk.toString();
          // THE FIRST NOTE OF THE WAIT: the drain is done and arm is being asked.
          if (/… \d+ s: /.test(out)) {
            clearTimeout(timer);
            waiting();
          }
        };
        child.stdout.on("data", watch);
        child.stderr.on("data", watch);
      });
      expect(await system(LEGACY_B)).toBe("draining");
      child.kill("SIGINT");
      const code = await ended;
      expect(code, out).toBe(130);
      expect(out).toContain("esperando a que los keepers de siempre lean el cambio");
      expect(out).toContain("Parado a mitad.");
      // IT DOES NOT KNOW whether the arm in flight had committed: «flota» does.
      expect(out).toContain("haya quedado «pasando» (nadie lo cobra ni compra) o que ya esté en el sistema nuevo. Mira «flota».");
      expect(out).toContain(`«traspasar ${LEGACY_B.slice(0, 8)}»`);
      expect(out).toContain(`«volver ${LEGACY_B.slice(0, 8)}»`);
      expect(await system(LEGACY_B)).toBe("draining");
      // traspasar-todos NAMES IT rather than pass it over: it is not 'legacy' any more, and nobody serves it.
      await db.query("UPDATE sip_solana.vault_work SET system = 'queue' WHERE vault_addr = $1", [LEGACY_C]);
      if (newCli) {
        const all = await tool(["traspasar-todos"]);
        expect(all.code, all.out).toBe(1);
        expect(all.out).toContain(`OJO: ${short(LEGACY_B)} sigue «pasando» y nadie lo sirve`);
      }
    } finally {
      await db.query("DELETE FROM sip_solana.legacy_process WHERE process_id = 'frozen-profit'");
      await db.query("UPDATE sip_solana.vault_work SET system = 'legacy', system_at = NULL, handover_height = NULL WHERE vault_addr = ANY($1::text[])", [[LEGACY_B, LEGACY_C]]);
    }
  }, 90_000);

  it("traspasar, stopped with Ctrl-C DURING the drain: still says where the vault may be and to look at «flota», not a silent 130", async () => {
    // THE SIGNAL REACHES THE TOOL ALONE while its dispatch-handover child drains: before, no listener
    // was installed until the wait, and tsx exited 130 printing nothing — with the drain going on.
    const child = spawn("node_modules/.bin/tsx", [TOOL, "traspasar", LEGACY_B], {
      cwd: KEEPER,
      env: {
        PATH: process.env["PATH"] ?? "",
        HOME: process.env["HOME"] ?? "",
        PROD_DB: dbUrl,
        SIP_FLOTA_TOOL_REHEARSAL: "1",
        SIP_FLOTA_TOOL_PAGES: pagesBase,
        SIP_FLOTA_TOOL_RPC: rpcUrl,
        SIP_FLOTA_TOOL_POLL_MS: "150",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    const ended = new Promise<number | null>((done) => child.on("close", (code) => done(code)));
    try {
      await new Promise<void>((draining, failed) => {
        const timer = setTimeout(() => failed(new Error(`no drain to interrupt:\n${out}`)), 40_000);
        const watch = (chunk: Buffer): void => {
          out += chunk.toString();
          if (out.includes(`2/3  ${short(LEGACY_B)} pasa a «pasando»`)) {
            clearTimeout(timer);
            draining();
          }
        };
        child.stdout.on("data", watch);
        child.stderr.on("data", watch);
      });
      child.kill("SIGINT");
      const code = await ended;
      expect(code, out).toBe(130);
      expect(out).toContain("Parado a mitad.");
      expect(out).toContain("Mira «flota».");
      expect(out).toContain(`Si «flota» lo enseña «pasando»: «traspasar ${LEGACY_B.slice(0, 8)}» para acabar, o «volver ${LEGACY_B.slice(0, 8)}» para devolverlo.`);
    } finally {
      // THE CHILD WAS NOT SIGNALLED and drains on: wait for it, then put the vault back.
      const until = Date.now() + 20_000;
      while ((await system(LEGACY_B)) !== "draining" && Date.now() < until) await new Promise((wait) => setTimeout(wait, 200));
      await db.query("UPDATE sip_solana.vault_work SET system = 'legacy', system_at = NULL, handover_height = NULL WHERE vault_addr = $1", [LEGACY_B]);
    }
  }, 90_000);

  it("traspasar-todos names a new vault the scheduler enrolled when the scheduler does not arm by itself, rather than «nada que hacer»", async () => {
    if (!newCli) return;
    // 10.8 STEP 5 UNDONE: new vaults back to the legacy keepers, SIP_SOLANA_AUTO_ARM removed — and a vault the
    // scheduler had enrolled (draining, system_at NULL, fence 0) left behind, which nobody will arm.
    await db.query("UPDATE sip_solana.vault_work SET system = 'draining', system_at = NULL WHERE vault_addr = $1", [LEGACY_B]);
    await db.query("UPDATE sip_solana.vault_work SET system = 'queue' WHERE vault_addr = $1", [LEGACY_C]);
    try {
      setScheduler({ enabled: false, legacyRoles: ["profit", "volume"], pending: [], lastArmedAt: null, lastResults: [], lastError: null });
      const off = await tool(["traspasar-todos"]);
      expect(off.code, off.out).toBe(1);
      expect(off.out).toContain(`OJO: ${short(LEGACY_B)} sigue «pasando» y nadie lo sirve`);
      expect(off.out).not.toContain("Nada que hacer");
      // WHILE IT ARMS BY ITSELF, the vault is the scheduler's to move: passed over, as before.
      setScheduler({ enabled: true, legacyRoles: ["profit", "volume"], pending: 1, lastArmedAt: null, lastResults: [], lastError: null });
      const on = await tool(["traspasar-todos"]);
      expect(on.code, on.out).toBe(0);
      expect(on.out).toContain("Nada que hacer");
    } finally {
      await db.query("UPDATE sip_solana.vault_work SET system = 'legacy', system_at = NULL WHERE vault_addr = ANY($1::text[])", [[LEGACY_B, LEGACY_C]]);
      setScheduler({ enabled: true, legacyRoles: ["profit", "volume"], pending: [], lastArmedAt: null, lastResults: [], lastError: null });
    }
  }, 60_000);

  it("flota, with a scheduler that arms by itself: only its own untouched enrolment is «the scheduler's»; one the owner left half way is nobody's", async () => {
    setScheduler({ enabled: true, legacyRoles: ["profit", "volume"], pending: 1, lastArmedAt: null, lastResults: [], lastError: null });
    // LEGACY_B AS THE SCHEDULER ENROLS A NEW VAULT (draining, system_at NULL, fence 0); LEGACY_C AS A «traspasar» THAT STOPPED HALF WAY (drain stamps system_at).
    await db.query("UPDATE sip_solana.vault_work SET system = 'draining', system_at = NULL WHERE vault_addr = $1", [LEGACY_B]);
    await db.query("UPDATE sip_solana.vault_work SET system = 'draining', system_at = clock_timestamp() WHERE vault_addr = $1", [LEGACY_C]);
    // NEW VAULTS TO THE QUEUE, as production will run once the scheduler arms by itself.
    await db.query("UPDATE sip_solana.fleet SET new_vault_system = 'queue' WHERE id");
    try {
      const ran = await tool(["flota"]);
      expect(ran.code, ran.out).toBe(0);
      expect(ran.out).toContain(`nadie lo cobra ni compra hasta que termine: «traspasar ${LEGACY_C.slice(0, 8)}» para acabar`);
      expect(ran.out).toContain(`${short(LEGACY_C)} está a medio pasar y nadie lo sirve: «traspasar ${LEGACY_C.slice(0, 8)}» o «volver ${LEGACY_C.slice(0, 8)}».`);
      if (newCli) {
        // THE NEWER CLI REPORTS system_at AND THE FENCE: the scheduler's own enrolment is told apart.
        expect(ran.out).toContain("el scheduler lo pasa solo (unos minutos)");
        expect(ran.out).not.toContain(`${short(LEGACY_B)} está a medio pasar y nadie lo sirve`);
      } else {
        // AN OLDER CLI DOES NOT: unknown is not the scheduler's, and both are said to be nobody's.
        expect(ran.out).toContain(`${short(LEGACY_B)} está a medio pasar y nadie lo sirve`);
      }
    } finally {
      await db.query("UPDATE sip_solana.vault_work SET system = 'legacy', system_at = NULL WHERE vault_addr = ANY($1::text[])", [[LEGACY_B, LEGACY_C]]);
      await db.query("UPDATE sip_solana.fleet SET new_vault_system = 'legacy' WHERE id");
      setScheduler({ enabled: true, legacyRoles: ["profit", "volume"], pending: [], lastArmedAt: null, lastResults: [], lastError: null });
    }
  }, 30_000);

  it("volver: rollback, then release, and the legacy keepers have it again", async () => {
    const ran = await tool(["volver", newCli ? LEGACY_A.slice(0, 8) : LEGACY_A]);
    expect(ran.code, ran.out).toBe(0);
    expect(ran.out).toContain(`LISTO: ${short(LEGACY_A)} vuelve a ser de los keepers de siempre`);
    expect(await system(LEGACY_A)).toBe("legacy");
  }, 60_000);

  it("traspasar-todos: every legacy vault, one after another — or, with an older CLI, refused", async () => {
    const ran = await tool(["traspasar-todos"]);
    if (!newCli) {
      expect(ran.code, ran.out).toBe(1);
      expect(ran.out).toContain("falta «status --all»");
      expect(await system(LEGACY_A)).toBe("legacy");
      return;
    }
    expect(ran.code, ran.out).toBe(0);
    expect(ran.out).toContain("Voy a pasar 3 vaults al sistema nuevo, uno detrás de otro");
    expect(ran.out).toContain("── 3 de 3:");
    expect(ran.out).toContain("LISTO: todos los vaults están en el sistema nuevo.");
    for (const vault of [LEGACY_A, LEGACY_B, LEGACY_C]) expect(await system(vault)).toBe("queue");
  }, 180_000);

  it("desaparcar: clears the park — or, with an older CLI, says it cannot yet", async () => {
    const parked = async (): Promise<unknown> => (await db.query("SELECT parked_reason FROM sip_solana.vault_work WHERE vault_addr = $1", [PARKED])).rows[0]!["parked_reason"];
    const ran = await tool(["desaparcar", PARKED]);
    if (!newCli) {
      expect(ran.code, ran.out).toBe(1);
      expect(ran.out).toContain("todavía no sabe desaparcar");
      expect(await parked()).not.toBeNull();
      return;
    }
    expect(ran.code, ran.out).toBe(0);
    expect(ran.out).toContain(`está aparcado: su trabajo se cortó 5 veces seguidas sin terminar`);
    expect(ran.out).toContain(`LISTO: ${short(PARKED)} desaparcado.`);
    expect(await parked()).toBeNull();
  }, 30_000);

  it("marcar-idos-viejos: lists the stale receipts, asks, and marks them", async () => {
    await db.query(
      `INSERT INTO sip_solana.legacy_process (process_id, role, dispatch, deployment, host, live, read_at, seen, absent_is)
       VALUES ('old-volume-0002', 'volume', 'on', 'dep-old-2', 'old-box', true, clock_timestamp() - interval '2 hours', '{}', 'legacy')`,
    );
    let ran = await tool(["marcar-idos-viejos"], "\n");
    expect(ran.code, ran.out).toBe(1);
    expect(ran.out).toContain("ANTES: comprueba en Railway que ese deployment ya no existe");
    ran = await tool(["marcar-idos-viejos"], "sí\n");
    expect(ran.code, ran.out).toBe(0);
    expect(ran.out).toContain("LISTO: marcado como ido: old-volume-0002.");
    ran = await tool(["marcar-idos-viejos"]);
    expect(ran.code).toBe(0);
    expect(ran.out).toContain("No hay ningún keeper que lleve 15 min sin leer.");
  }, 60_000);
});
