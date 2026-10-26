// PREPARES A RAILWAY SHADOW DATABASE FOR THE DISPATCHER (runbook §10.1, §10.4),
// the way test-local/shadow/harness.ts prepares its local one: the schema, new
// vaults to the queue, then — once the shadow scheduler has discovered them —
// every vault armed into the queue (`arm --all --roles=none --allow-dry`, which
// is only for a database no legacy keeper reads).
//
//   SHADOW_DB=<the shadow Postgres's PUBLIC url> node_modules/.bin/tsx test-local/shadow/railway-setup.mts
//
// The operator runs it (railway-setup.sh asks for the url without showing it).
// NEVER PRODUCTION'S DATABASE: a Supabase host is refused before anything is
// touched, and so is Railway's private host (unreachable from a laptop). The url
// is never printed; the CLIs it runs register it with their redactor, and every
// failure line printed here has it cut out. It reads the chain only through the
// handover's block-height check, on the public mainnet endpoint, and sends
// nothing.

import { spawn } from "node:child_process";
import pg from "pg";
import { sslFor } from "../../src/read-model.js";

const say = (line: string): void => console.log(line);
const url = process.env["SHADOW_DB"]?.trim() ?? "";
if (!/^postgres(?:ql)?:\/\//.test(url)) {
  say("Eso no parece la dirección de una base Postgres (empieza por postgresql://). No he tocado nada.");
  process.exit(2);
}
let host: string;
try {
  host = new URL(url).hostname;
} catch {
  say("Esa dirección no se puede leer. No he tocado nada.");
  process.exit(2);
}
if (/supabase/i.test(host)) {
  say("Esa es la base de Supabase: la de PRODUCCIÓN. La prueba en sombra va en su propia base de Railway. No he tocado nada.");
  process.exit(2);
}
if (/\.railway\.internal$/i.test(host)) {
  say("Esa es la dirección interna de Railway (DATABASE_URL). Desde tu Mac hace falta la pública: DATABASE_PUBLIC_URL. No he tocado nada.");
  process.exit(2);
}

const password = (() => {
  try {
    return decodeURIComponent(new URL(url).password);
  } catch {
    return "";
  }
})();
/** Cuts the url and its password out of anything about to be printed. */
const clean = (text: string): string => {
  let out = text.split(url).join("<url>");
  if (password.length >= 4) out = out.split(password).join("<password>");
  return out;
};

const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: url, SIP_SOLANA_RPC_URLS: "https://api.mainnet-beta.solana.com" };
delete env["SHADOW_DB"];

/** Runs one keeper CLI; prints its last lines when it fails, unless `expected` says the failure is a wait. */
function run(script: string, args: readonly string[] = [], expected?: RegExp): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn("node_modules/.bin/tsx", [script, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => void (out += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => void (out += chunk.toString()));
    child.on("exit", (code) => {
      if (code !== 0 && !(expected?.test(out) ?? false)) say(clean(out.trim().split("\n").slice(-6).join("\n")));
      resolve(code ?? 1);
    });
  });
}

const pool = new pg.Pool({ connectionString: url, ssl: sslFor(url), max: 1, connectionTimeoutMillis: 15_000, query_timeout: 15_000 });
pool.on("error", () => undefined);
const query = async <T,>(sql: string): Promise<T[]> => (await pool.query(sql)).rows as T[];
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<number> {
  say("");
  say("1/4  Comprobando que llego a la base de la sombra…");
  try {
    await query("SELECT 1");
  } catch (error) {
    const detail = clean(error instanceof Error ? error.message : String(error));
    say(`     No contesta: ${detail}`);
    if (/SSL/i.test(detail)) say("     (La base no acepta conexiones cifradas: dímelo y lo ajustamos.)");
    return 1;
  }
  say("     Contesta. Creando las tablas…");
  if ((await run("bin/setup-read-model.mts")) !== 0) return 1;

  say("2/4  Los vaults nuevos irán a la cola…");
  const [fleet] = await query<{ new_vault_system: string }>("SELECT new_vault_system FROM sip_solana.fleet");
  if (fleet?.new_vault_system !== "queue" && (await run("bin/dispatch-handover.mts", ["new-vaults", "queue"])) !== 0) return 1;

  say("3/4  Esperando a que el repartidor encuentre los vaults.");
  say("     Si todavía no lo has creado en Railway, hazlo ahora (paso 3 de la guía). Espero hasta 30 minutos.");
  const waitStarted = Date.now();
  for (let minute = 0; ; ) {
    const [{ n }] = await query<{ n: string }>("SELECT count(*)::text AS n FROM sip_solana.vault_work");
    if (Number(n) > 0) {
      say(`     Encontrados: ${n} vaults.`);
      break;
    }
    if (Date.now() - waitStarted > 30 * 60_000) {
      say("     30 minutos sin que el repartidor escriba nada. Mira en Railway si está «Online» y dime qué pone en sus Deploy Logs.");
      return 1;
    }
    const elapsed = Math.floor((Date.now() - waitStarted) / 60_000);
    if (elapsed > minute) {
      minute = elapsed;
      say(`     … ${minute} min esperando`);
    }
    await sleep(10_000);
  }

  say("4/4  Pasando los vaults a la cola. Tarda 1–3 minutos: espera a que caduque cualquier transacción vieja.");
  const armStarted = Date.now();
  for (;;) {
    // A WAIT FOR THE FINALIZED HEIGHT IS THE ARM WORKING, not a failure: said in one line.
    const code = await run("bin/dispatch-handover.mts", ["arm", "--all", "--roles=none", "--allow-dry"], /waiting for the finalized height|has let go/);
    const systems = await query<{ system: string }>("SELECT DISTINCT system FROM sip_solana.vault_work");
    if (code === 0 && systems.length === 1 && systems[0]!.system === "queue") break;
    say(`     … esperando (${Math.round((Date.now() - armStarted) / 1_000)} s)`);
    if (Date.now() - armStarted > 10 * 60_000) {
      say(`     A los 10 minutos no se han movido todos (estado: ${systems.map((row) => row.system).join(", ")}). Dímelo y lo miro.`);
      return 1;
    }
    await sleep(20_000);
  }
  const [{ vaults }] = await query<{ vaults: string }>("SELECT count(*)::text AS vaults FROM sip_solana.vault_work WHERE system = 'queue'");
  const [{ links }] = await query<{ links: string }>("SELECT count(*)::text AS links FROM sip_solana.keeper_link WHERE gone_at IS NULL");
  say("");
  say(`LISTO: ${vaults} vaults en la cola, ${links} enlaces. Ahora crea el servicio de los trabajadores (paso 5 de la guía).`);
  return 0;
}

main()
  .then(async (code) => {
    await pool.end().catch(() => undefined);
    process.exit(code);
  })
  .catch(async (error: unknown) => {
    say(`Algo falló: ${clean(error instanceof Error ? error.message : String(error))}`);
    await pool.end().catch(() => undefined);
    process.exit(1);
  });
