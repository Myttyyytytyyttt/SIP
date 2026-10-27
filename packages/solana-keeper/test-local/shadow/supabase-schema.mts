// CREATES THE DISPATCHER'S TABLES IN PRODUCTION'S SUPABASE (runbook §10.3: "corre
// antes setup-read-model"), and only that: sql/sip_solana.sql is additive and
// idempotent, every new row starts 'legacy', and the legacy keepers read none of
// it until SIP_SOLANA_DISPATCH is set on them. Nothing here arms, drains or
// moves a vault — that is dispatch-handover's, one vault at a time.
//
//   PROD_DB=<the keepers' DATABASE_URL> node_modules/.bin/tsx test-local/shadow/supabase-schema.mts
//
// The operator runs it (supabase-schema.sh asks for the url without showing it).
// Only a Supabase session-pooler or direct url on 5432 is accepted: 6543 holds
// no session lock, and anything else is not production's database. The url is
// never printed.

import { spawn } from "node:child_process";
import pg from "pg";
import { sslFor } from "../../src/read-model.js";

const say = (line: string): void => console.log(line);
const url = process.env["PROD_DB"]?.trim() ?? "";
let parsed: URL;
try {
  parsed = new URL(url);
} catch {
  say("Esa dirección no se puede leer. No he tocado nada.");
  process.exit(2);
}
// A LOCAL REHEARSAL ONLY: SIP_SCHEMA_TOOL_REHEARSAL=1 lets a loopback database through, nothing else.
const rehearsal = process.env["SIP_SCHEMA_TOOL_REHEARSAL"] === "1" && parsed.hostname === "127.0.0.1";
if (!/^postgres(?:ql)?:$/.test(parsed.protocol) || (!rehearsal && !/supabase\.(co|com)$/i.test(parsed.hostname))) {
  // THE HOST IS NOT A SECRET (the password is): saying which server the url named is what tells a wrong copy apart.
  const host = parsed.hostname || "(ninguno)";
  const railway = /\.railway\.internal$|\.rlwy\.net$|\.proxy\.rlwy\.net$/i.test(host);
  say(`Esa dirección apunta a «${host}», que no es Supabase. No he tocado nada.`);
  if (railway) say("Es una base de Railway: seguramente la copiaste de «Postgres», del repartidor o de los trabajadores. La buena está en el servicio sip-solana-keeper.");
  say("La de producción es la DATABASE_URL del servicio sip-solana-keeper (Railway → sip-solana-keeper → Variables), y su servidor termina en supabase.com.");
  process.exit(2);
}
if (!rehearsal && (parsed.port || "5432") !== "5432") {
  say(`Esa dirección usa el puerto ${parsed.port}; los keepers usan el 5432. Copia la DATABASE_URL de sip-solana-keeper tal cual. No he tocado nada.`);
  process.exit(2);
}
const password = decodeURIComponent(parsed.password);
const clean = (text: string): string => {
  let out = text.split(url).join("<url>");
  if (password.length >= 4) out = out.split(password).join("<password>");
  return out;
};

function run(script: string, args: readonly string[] = []): Promise<number> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: url };
    delete env["PROD_DB"];
    const child = spawn("node_modules/.bin/tsx", [script, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => void (out += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => void (out += chunk.toString()));
    child.on("exit", (code) => {
      if (code !== 0) say(clean(out.trim().split("\n").slice(-6).join("\n")));
      resolve(code ?? 1);
    });
  });
}

const NEW_TABLES = ["loss_carry", "keeper_link", "vault_work", "send_intent", "worker", "rpc_usage", "fleet", "legacy_process", "sol_price_tape"];

const pool = new pg.Pool({ connectionString: url, ssl: sslFor(url), max: 1, connectionTimeoutMillis: 15_000, query_timeout: 15_000 });
pool.on("error", () => undefined);
const query = async <T,>(sql: string, values: unknown[] = []): Promise<T[]> => (await pool.query(sql, values)).rows as T[];
const present = async (): Promise<string[]> =>
  (await query<{ name: string }>("SELECT t.name FROM unnest($1::text[]) AS t(name) WHERE to_regclass('sip_solana.' || t.name) IS NOT NULL", [NEW_TABLES])).map((row) => row.name);


async function main(): Promise<number> {
  say("");
  say("1/3  Comprobando que llego a la base de producción…");
  try {
    await query("SELECT 1");
  } catch (error) {
    say(`     No contesta: ${clean(error instanceof Error ? error.message : String(error))}`);
    return 1;
  }
  const before = await present();
  say(`     Contesta. Tablas nuevas que ya existían: ${before.length} de ${NEW_TABLES.length}.`);

  say("2/3  Creando las que faltan (no cambia ni borra nada de lo que ya hay)…");
  if ((await run("bin/setup-read-model.mts")) !== 0) return 1;

  say("3/3  Comprobando…");
  const after = await present();
  const [fleet] = await query<{ new_vault_system: string; webhook_owner: string }>("SELECT new_vault_system, webhook_owner FROM sip_solana.fleet");
  const [{ moved }] = await query<{ moved: string }>("SELECT count(*)::text AS moved FROM sip_solana.vault_work WHERE system <> 'legacy'");
  say(`     Tablas nuevas: ${after.length} de ${NEW_TABLES.length}.`);
  say(`     Vaults nuevos van a: ${fleet?.new_vault_system ?? "?"} · el timbre lo lleva: ${fleet?.webhook_owner ?? "?"} · vaults fuera de los keepers de siempre: ${moved}`);
  if (after.length !== NEW_TABLES.length || fleet?.new_vault_system !== "legacy" || fleet?.webhook_owner !== "legacy" || moved !== "0") {
    say("     Algo no es lo esperado: dímelo antes de seguir.");
    return 1;
  }
  say("");
  say("LISTO: las tablas del repartidor existen en Supabase y todo sigue en manos de los keepers de siempre.");
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
