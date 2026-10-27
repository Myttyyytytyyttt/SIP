// THE OWNER'S VAULT, BETWEEN THE LEGACY KEEPERS AND THE QUEUE, IN PRODUCTION
// (runbook §10.4 and §10.5), as four words an owner types:
//
//   estado       read-only: who holds each vault, and each legacy keeper's receipts;
//   traspasar    drain, then arm until the vault is in the queue (≥ 150 blocks after
//                every legacy keeper has read it as foreign);
//   volver       rollback, then release until the vault is legacy again;
//   marcar-ido   <process_id>: a legacy process that will never read again (its
//                deployment is gone in Railway), so `arm` stops waiting on it.
//
//   PROD_DB=<the keepers' DATABASE_URL> node_modules/.bin/tsx test-local/shadow/handover-prod.mts <word> [id]
//
// The operator runs it (handover-prod.sh asks for the url without showing it).
// ONE VAULT ONLY, named below: this tool cannot drain or arm any other. Every
// write is bin/dispatch-handover.mts's own command, whose rules (receipts, the
// block wait, the carries) stay the guard; this adds the loop, the words and the
// refusals. The chain is read (block heights) on the public endpoint; nothing is
// sent. The url is never printed.

import { spawn } from "node:child_process";

/** The owner's vault (VOLUME, two linked wallets). The only vault this tool moves. */
export const OWNER_VAULT = "EFXK995PV49Qz8xPSYMEUDBU5AKRR466JkgsfuGak5iU";
const RPC = "https://api.mainnet-beta.solana.com";
/** How stale a legacy keeper's last read may be for `traspasar` to start: two sweeps and a bit. */
const FRESH_READ_MS = 150_000;

const say = (line: string): void => console.log(line);
const [word, extra] = process.argv.slice(2);
if (!["estado", "traspasar", "volver", "marcar-ido"].includes(word ?? "")) {
  say("Uso: estado | traspasar | volver | marcar-ido <process_id>. No he tocado nada.");
  process.exit(2);
}
if (word === "marcar-ido" && (extra === undefined || !/^[\w:.-]{4,200}$/.test(extra))) {
  say("marcar-ido necesita el process_id que te haya dicho «estado» o «traspasar». No he tocado nada.");
  process.exit(2);
}

const url = process.env["PROD_DB"]?.trim() ?? "";
let parsed: URL;
try {
  parsed = new URL(url);
} catch {
  say("Esa dirección no se puede leer. No he tocado nada.");
  process.exit(2);
}
// A LOCAL REHEARSAL ONLY: a loopback database, and then dry keepers are allowed (--allow-dry).
const rehearsal = process.env["SIP_HANDOVER_TOOL_REHEARSAL"] === "1" && parsed.hostname === "127.0.0.1";
if (!/^postgres(?:ql)?:$/.test(parsed.protocol) || (!rehearsal && !/supabase\.(co|com)$/i.test(parsed.hostname))) {
  say(`Esa dirección apunta a «${parsed.hostname || "(ninguno)"}», que no es Supabase. La buena es la DATABASE_URL de sip-solana-keeper. No he tocado nada.`);
  process.exit(2);
}
if (!rehearsal && (parsed.port || "5432") !== "5432") {
  say(`Esa dirección usa el puerto ${parsed.port}; la de los keepers usa el 5432. No he tocado nada.`);
  process.exit(2);
}
const password = decodeURIComponent(parsed.password);
const clean = (text: string): string => {
  let out = text.split(url).join("<url>");
  if (password.length >= 4) out = out.split(password).join("<password>");
  return out;
};

interface Run {
  readonly code: number;
  readonly ok: boolean | null;
  readonly result: unknown;
  readonly tail: string;
}

/** One dispatch-handover command; its one result line parsed. */
function handover(args: readonly string[]): Promise<Run> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: url, SIP_SOLANA_RPC_URLS: RPC };
    delete env["PROD_DB"];
    const child = spawn("node_modules/.bin/tsx", ["bin/dispatch-handover.mts", ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => void (out += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => void (out += chunk.toString()));
    child.on("exit", (code) => {
      let ok: boolean | null = null;
      let result: unknown = null;
      for (const line of out.split("\n")) {
        if (!line.includes('"event":"dispatch-handover')) continue;
        try {
          const parsedLine = JSON.parse(line) as { ok?: unknown; result?: unknown };
          ok = typeof parsedLine.ok === "boolean" ? parsedLine.ok : null;
          result = parsedLine.result ?? null;
        } catch {
          // not the result line
        }
      }
      resolve({ code: code ?? 1, ok, result, tail: clean(out.trim().split("\n").slice(-4).join("\n")) });
    });
  });
}

interface VaultRow {
  readonly vault: string;
  readonly system: string;
  readonly holder: string | null;
  readonly leaseUntil: string | null;
}
interface ProcessRow {
  readonly processId: string;
  readonly role: string;
  readonly dispatch: string;
  readonly deployment: string | null;
  readonly live: boolean;
  readonly ageMs: number;
  readonly goneAt: string | null;
  readonly notLegacy: Record<string, string>;
}
interface Status {
  readonly newVaultSystem: string | null;
  readonly vaults: readonly VaultRow[];
  readonly processes: readonly ProcessRow[];
}
interface StepResult {
  readonly system: string | null;
  readonly moved: boolean;
  readonly blockers: readonly string[];
  readonly waitUntilFinalizedAbove?: string;
}

const short = (address: string): string => `${address.slice(0, 8)}…`;

/**
 * The CLI's blockers (src/handover.ts) in the owner's words, for the ones a
 * normal handover meets; anything else is shown as the CLI wrote it.
 */
function plain(blocker: string): string {
  const notRead = /^legacy process (\S+) \((profit|volume),.*?last read ([^)]*?) ago[^)]*\) has not yet read this vault as not its own/.exec(blocker);
  if (notRead !== null) {
    const role = notRead[2] === "profit" ? "beneficios" : "volumen";
    return `el keeper de ${role} todavía no lo ha leído como ajeno (su última vuelta fue hace ${notRead[3]}; espera a la siguiente) — si su contenedor ya no existe en Railway: «marcar-ido ${notRead[1]}»`;
  }
  if (/^every legacy keeper has let go; waiting for the finalized height/.test(blocker)) return "los dos keepers ya lo han soltado; esperando a que pasen los bloques";
  if (/^waiting for the finalized height/.test(blocker)) return "esperando a que pasen los bloques";
  return blocker;
}
const ago = (ms: number): string => (ms < 90_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function status(): Promise<Status | null> {
  const run = await handover(["status"]);
  if (run.code !== 0 || run.result === null) {
    say("     La base no contestó a «status»:");
    say(run.tail);
    return null;
  }
  return run.result as Status;
}

function printStatus(s: Status): void {
  say(`     Vaults nuevos van a: ${s.newVaultSystem ?? "?"}`);
  for (const v of s.vaults) {
    const mine = v.vault === OWNER_VAULT ? "  ← el tuyo" : "";
    const held = v.holder === null ? "" : ` · lo tiene ${v.holder.slice(0, 24)} hasta ${v.leaseUntil ?? "?"}`;
    say(`     ${short(v.vault)}  ${v.system}${held}${mine}`);
  }
  const live = s.processes.filter((p) => p.goneAt === null);
  if (live.length === 0) say("     Ningún keeper de siempre ha dejado su recibo: ¿tienen SIP_SOLANA_DISPATCH=on?");
  for (const p of live) {
    const foreign = Object.keys(p.notLegacy).length;
    say(`     keeper ${p.role}: leído hace ${ago(p.ageMs)}${p.live ? ", actuando" : ", en seco"} · deja en paz ${foreign} vault(s) · id ${p.processId}`);
  }
}

/** traspasar's preconditions: both legacy roles reading fresh, new vaults to legacy, the owner's vault legacy or draining, the others legacy. */
function readyToMove(s: Status): string[] {
  const problems: string[] = [];
  if (s.newVaultSystem !== "legacy") problems.push(`los vaults nuevos van a «${s.newVaultSystem ?? "?"}», no a «legacy»`);
  for (const role of ["profit", "volume"]) {
    const fresh = s.processes.filter((p) => p.goneAt === null && p.role === role && p.ageMs < FRESH_READ_MS && (rehearsal || p.live));
    if (fresh.length === 0) problems.push(`el keeper de ${role === "profit" ? "beneficios" : "volumen"} no ha leído la cola en los últimos ${FRESH_READ_MS / 60_000} min (¿tiene SIP_SOLANA_DISPATCH=on y está «live»?)`);
  }
  const mine = s.vaults.find((v) => v.vault === OWNER_VAULT);
  if (mine !== undefined && mine.system === "queue") problems.push("tu vault ya está en la cola");
  for (const v of s.vaults) if (v.vault !== OWNER_VAULT && v.system !== "legacy") problems.push(`el vault ${short(v.vault)} no es «legacy» (${v.system}): este traspaso es solo para el tuyo`);
  return problems;
}

async function traspasar(): Promise<number> {
  say("1/3  Comprobando que todo está listo…");
  const s = await status();
  if (s === null) return 1;
  printStatus(s);
  const problems = readyToMove(s);
  if (problems.length > 0) {
    for (const p of problems) say(`     NO: ${p}.`);
    say("     No he tocado nada.");
    return 1;
  }
  const mine = s.vaults.find((v) => v.vault === OWNER_VAULT);
  if (mine === undefined || mine.system === "legacy") {
    say("2/3  Tu vault pasa a «draining»: desde su próxima vuelta (~1 min) los keepers de siempre lo dejan en paz…");
    const drained = await handover(["drain", OWNER_VAULT]);
    if (drained.ok !== true) {
      say("     No se pudo:");
      say(drained.tail);
      return 1;
    }
  } else {
    say(`2/3  Tu vault ya estaba en «${mine.system}»: sigo desde ahí.`);
  }
  say("3/3  Esperando a que los dos keepers lo lean como ajeno y a que pasen 150 bloques (2–4 min)…");
  const started = Date.now();
  let lastNote = "";
  for (;;) {
    const args = ["arm", OWNER_VAULT, ...(rehearsal ? ["--allow-dry"] : [])];
    const run = await handover(args);
    const step = run.result as StepResult | null;
    if (run.ok === true && step?.system === "queue") break;
    if (step === null) {
      say("     «arm» no contestó:");
      say(run.tail);
      return 1;
    }
    const note = step.blockers.length === 0 ? "esperando bloques" : step.blockers.map(plain).join(" · ");
    if (note !== lastNote) {
      say(`     … ${Math.round((Date.now() - started) / 1000)} s: ${note}`);
      lastNote = note;
    }
    if (Date.now() - started > 15 * 60_000) {
      say("     15 minutos sin poder moverlo. Tu vault sigue en «draining»: nadie lo cobra ni compra.");
      say("     Si un keeper no lo ha leído, mira en Railway si su despliegue aún existe; si no, «marcar-ido <id>».");
      say("     Para devolverlo a los keepers de siempre: «volver».");
      return 1;
    }
    await sleep(20_000);
  }
  say("");
  say("LISTO: tu vault está en la cola. El trabajador lo toma en segundos.");
  return 0;
}

async function volver(): Promise<number> {
  say("1/2  Sacando tu vault de la cola…");
  const s = await status();
  if (s === null) return 1;
  const mine = s.vaults.find((v) => v.vault === OWNER_VAULT);
  if (mine === undefined || mine.system === "legacy") {
    say("     Tu vault ya es de los keepers de siempre. Nada que hacer.");
    return 0;
  }
  if (mine.system === "queue") {
    const back = await handover(["rollback", OWNER_VAULT]);
    if (back.ok !== true) {
      say("     No se pudo:");
      say(back.tail);
      return 1;
    }
  }
  say("2/2  Esperando a que el trabajador lo suelte y a que caduque su último envío (hasta ~6 min)…");
  const started = Date.now();
  let lastNote = "";
  for (;;) {
    const run = await handover(["release", OWNER_VAULT]);
    const step = run.result as StepResult | null;
    if (run.ok === true && step?.system === "legacy") break;
    if (step === null) {
      say("     «release» no contestó:");
      say(run.tail);
      return 1;
    }
    const note = step.blockers.length === 0 ? "esperando bloques" : step.blockers.map(plain).join(" · ");
    if (note !== lastNote) {
      say(`     … ${Math.round((Date.now() - started) / 1000)} s: ${note}`);
      lastNote = note;
    }
    if (Date.now() - started > 15 * 60_000) {
      say("     15 minutos sin poder devolverlo. Sigue en «draining»: nadie lo cobra ni compra. Dímelo.");
      return 1;
    }
    await sleep(20_000);
  }
  say("");
  say("LISTO: tu vault vuelve a ser de los keepers de siempre.");
  return 0;
}

async function main(): Promise<number> {
  say("");
  if (word === "estado") {
    say("Estado de la cola:");
    const s = await status();
    if (s === null) return 1;
    printStatus(s);
    return 0;
  }
  if (word === "marcar-ido") {
    const run = await handover(["gone", extra!]);
    if (run.ok !== true) {
      say(run.tail);
      return 1;
    }
    say(`Marcado como ido: ${extra}.`);
    return 0;
  }
  return word === "traspasar" ? traspasar() : volver();
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    say(`Algo falló: ${clean(error instanceof Error ? error.message : String(error))}`);
    process.exit(1);
  });
