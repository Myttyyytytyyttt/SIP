// THE OWNER'S WHOLE FLEET, IN PRODUCTION: every vault between the legacy keepers
// and the dispatcher's queue, as words an owner types (runbook §10):
//
//   flota                      read-only: every vault, who serves it, its last job; where new vaults go;
//                              the legacy keepers' receipts and pages; the scheduler's and workers' health
//   traspasar <vault>          drain, then arm until the vault is in the queue (one vault in transit at a time)
//   traspasar-todos            every legacy vault, one after another, each fully before the next
//   volver <vault>             rollback, then release until the legacy keepers have it again
//   nuevos-a-la-cola           new vaults to the queue — refused unless the scheduler arms by itself
//   nuevos-a-los-de-siempre    new vaults to the legacy keepers — refused unless they are reading
//   marcar-ido <id>...         legacy processes whose deployments are gone, after the owner checked Railway
//   marcar-idos-viejos         every receipt older than 15 min, after the same check (gone --stale)
//   desaparcar <vault>         clear a parked vault (unpark)
//
//   PROD_DB=<the keepers' DATABASE_URL> node_modules/.bin/tsx test-local/shadow/flota-prod.mts <word> [args]
//
// The operator runs it (flota-prod.sh asks for the url without showing it).
// EVERY DECISION AND EVERY SENTENCE IS src/owner-fleet.ts's, tested without a
// database; this file connects them. Every write is bin/dispatch-handover.mts's
// own command, whose rules (receipts, the block wait, the carries) stay the
// guard. The chain is read for block heights only, on the public endpoint, and
// only by that command; the /status pages are read with plain GETs; nothing
// here talks to Helius, Privy, Railway or Jupiter, and nothing is sent. The url
// is never printed (every line is cut by cleanLine) and never written anywhere.
//
// handover-prod.mts, the one-vault tool that moved the owner's vault, is left as
// it is.
//
// A LOCAL REHEARSAL: SIP_FLOTA_TOOL_REHEARSAL=1 and a database on 127.0.0.1.
// Then dry legacy keepers count (`arm --allow-dry`), and the pages, the RPC and
// the wait may be stand-ins on the loopback (owner-fleet.ts readOverrides);
// outside a rehearsal those three variables are refused.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import {
  CLI_FAILURES_TOLERATED,
  autoArmable,
  FLOTA_USAGE,
  MOVE_TIMEOUT_MS,
  checkDatabaseUrl,
  cleanLine,
  flotaLines,
  goneTargets,
  isOlderCliRefusal,
  legacyNewVaultsProblems,
  moveProblems,
  armProgress,
  parkedWords,
  parseFlotaArgs,
  plainBlocker,
  processLine,
  queueNewVaultsProblems,
  readFleetDb,
  readKeeperPage,
  readOverrides,
  readSchedulerPage,
  releaseProgress,
  resolveVault,
  returnProblems,
  rowProblem,
  short,
  staleReceipts,
  withVault,
  type FleetDb,
  type KeeperPageView,
  type PageRead,
  type Progress,
  type SchedulerPageView,
} from "../../src/owner-fleet.js";

const parsedArgs = parseFlotaArgs(process.argv.slice(2));
if ("problem" in parsedArgs) {
  console.log(`${parsedArgs.problem} No he tocado nada.`);
  console.log(FLOTA_USAGE);
  process.exit(2);
}
const command = parsedArgs.command;

const checked = checkDatabaseUrl(process.env["PROD_DB"], process.env["SIP_FLOTA_TOOL_REHEARSAL"] === "1");
if (!checked.ok) {
  for (const line of checked.lines) console.log(line);
  process.exit(2);
}
const { url, secrets, rehearsal } = checked;
/** EVERY printed line goes through here. */
const say = (line: string): void => console.log(cleanLine(line, url, secrets));

const overrides = readOverrides(process.env, rehearsal);
if ("problem" in overrides) {
  say(overrides.problem);
  process.exit(2);
}
const { pages, rpc, pollMs } = overrides;
if (rehearsal) say("(ENSAYO: base local; los keepers en seco cuentan)");

interface Run {
  readonly code: number;
  readonly ok: boolean | null;
  readonly result: unknown;
  /** The CLI's own refusal of the command line (its `refused` event), when it refused one. */
  readonly refused: string | null;
  readonly tail: string;
}

/** One dispatch-handover command: its one result line parsed, its refusal read, its last lines kept (cleaned) for a failure. */
function handover(args: readonly string[]): Promise<Run> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: url, SIP_SOLANA_RPC_URLS: rpc };
    delete env["PROD_DB"];
    const child = spawn("node_modules/.bin/tsx", ["bin/dispatch-handover.mts", ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => void (out += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => void (out += chunk.toString()));
    child.on("error", () => undefined);
    child.on("close", (code) => {
      let ok: boolean | null = null;
      let result: unknown = null;
      let refused: string | null = null;
      for (const line of out.split("\n")) {
        if (!line.startsWith("{")) continue;
        try {
          const parsed = JSON.parse(line) as { event?: unknown; ok?: unknown; result?: unknown; detail?: unknown };
          if (typeof parsed.event === "string" && parsed.event.startsWith("dispatch-handover ")) {
            ok = typeof parsed.ok === "boolean" ? parsed.ok : null;
            result = parsed.result ?? null;
          } else if (parsed.event === "refused" && typeof parsed.detail === "string") {
            refused = parsed.detail;
          }
        } catch {
          // not one of its JSON lines
        }
      }
      resolve({ code: code ?? 1, ok, result, refused, tail: cleanLine(out.trim().split("\n").slice(-4).join("\n"), url, secrets) });
    });
  });
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** One public page, a plain GET: its JSON, or why there was none. */
async function getPage(address: string): Promise<PageRead<unknown>> {
  try {
    const response = await fetch(address, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return { answered: false, why: `contestó ${response.status}` };
    return { answered: true, page: (await response.json()) as unknown };
  } catch (error) {
    return { answered: false, why: error instanceof Error && error.name === "TimeoutError" ? "no contestó en 10 s" : "no contesta" };
  }
}

async function schedulerPage(): Promise<PageRead<SchedulerPageView>> {
  const read = await getPage(pages.scheduler);
  return read.answered ? { answered: true, page: readSchedulerPage(read.page) } : read;
}

async function keeperPage(address: string): Promise<PageRead<KeeperPageView>> {
  const read = await getPage(address);
  return read.answered ? { answered: true, page: readKeeperPage(read.page, Date.now()) } : read;
}

/** The fleet as the database says: `status --all`, or plain `status` from an older dispatch-handover. Null (and said why) on failure. */
async function readDb(): Promise<FleetDb | null> {
  let run = await handover(["status", "--all"]);
  let all = true;
  if (isOlderCliRefusal(run)) {
    run = await handover(["status"]);
    all = false;
  }
  if (run.result === null) {
    say("La base no contestó a «status»:");
    say(run.tail);
    return null;
  }
  const db = readFleetDb(run.result, all);
  if (db === null) say("No entiendo lo que contestó «status». No he tocado nada.");
  return db;
}

/** The fleet, with this vault's row in it even when an older CLI listed only the vaults that are not legacy. */
async function readDbWith(vault: string): Promise<FleetDb | null> {
  const db = await readDb();
  if (db === null || db.allListed || db.vaults.some((entry) => entry.vault === vault)) return db;
  const one = await handover(["status", vault]);
  return withVault(db, one.result === null ? null : readFleetDb(one.result, false), vault);
}

/** A typed vault, found in the fleet: null (and said why) when it is not one. */
async function findVault(typed: string): Promise<{ readonly db: FleetDb; readonly vault: string } | null> {
  const first = await readDb();
  if (first === null) return null;
  const found = resolveVault(typed, first);
  if ("problem" in found) {
    say(`${found.problem} No he tocado nada.`);
    return null;
  }
  const db = first.allListed || first.vaults.some((entry) => entry.vault === found.vault) ? first : await readDbWith(found.vault);
  if (db === null) return null;
  const missing = rowProblem(db, found.vault);
  if (missing !== null) {
    say(`NO: ${missing}. No he tocado nada.`);
    return null;
  }
  return { db, vault: found.vault };
}

/**
 * A wait: the same command again every pollMs until `decide` says done or stop,
 * MOVE_TIMEOUT_MS at most. A call that gives no result at all is tolerated
 * CLI_FAILURES_TOLERATED times in a row (a database blip, the public RPC's 429).
 * `stranded` is where the wait leaves the vault — said when it gives up, by the
 * clock OR by the CLI not answering: either way the vault is still «pasando»,
 * and the owner must hear that nobody serves it and what to type.
 */
async function waitFor(args: readonly string[], decide: (result: unknown) => Progress | null, stranded: readonly string[]): Promise<boolean> {
  const started = Date.now();
  let lastNote = "";
  let failures = 0;
  for (;;) {
    const run = await handover(args);
    const progress = decide(run.result);
    if (progress === null) {
      failures += 1;
      if (failures >= CLI_FAILURES_TOLERATED) {
        say(`     «${args[0]}» no contestó ${failures} veces seguidas:`);
        say(run.tail);
        for (const line of stranded) say(`     ${line}`);
        return false;
      }
    } else {
      failures = 0;
      if (progress.kind === "done") return true;
      if (progress.kind === "stop") {
        for (const line of progress.lines) say(`     ${line}`);
        return false;
      }
      if (progress.note !== lastNote) {
        say(`     … ${Math.round((Date.now() - started) / 1000)} s: ${progress.note}`);
        lastNote = progress.note;
      }
    }
    if (Date.now() - started > MOVE_TIMEOUT_MS) {
      say("     15 minutos esperando, y no ha terminado.");
      for (const line of stranded) say(`     ${line}`);
      return false;
    }
    await sleep(pollMs);
  }
}

/** One vault, legacy (or already draining) → queue. True when it is in the queue. */
async function moveOne(typed: string): Promise<boolean> {
  say("1/3  Comprobando que todo está listo…");
  const found = await findVault(typed);
  if (found === null) return false;
  const { db, vault } = found;
  const row = db.vaults.find((entry) => entry.vault === vault)!;
  if (row.system === "queue") {
    say(`     ${short(vault)} ya está en el sistema nuevo. Nada que hacer.`);
    return true;
  }
  const scheduler = await schedulerPage();
  const problems = moveProblems(db, vault, rehearsal, scheduler.answered && scheduler.page.autoArm?.enabled === true);
  if (problems.length > 0) {
    for (const problem of problems) say(`     NO: ${problem}.`);
    say("     No he tocado nada.");
    return false;
  }
  if (row.system === "legacy") {
    say(`2/3  ${short(vault)} pasa a «pasando»: desde su próxima vuelta (~1 min) los keepers de siempre lo dejan en paz.`);
    say("     Hasta que termine, nadie lo cobra ni compra.");
    const drained = await handover(["drain", vault]);
    if (drained.ok !== true) {
      const blockers = (drained.result as { blockers?: unknown } | null)?.blockers;
      say("     No se pudo:");
      if (Array.isArray(blockers) && blockers.length > 0) for (const blocker of blockers) say(`     ${plainBlocker(String(blocker))}`);
      else say(drained.tail);
      return false;
    }
  } else {
    say(`2/3  ${short(vault)} ya estaba «pasando»: sigo desde ahí.`);
  }
  say("3/3  Esperando a que los keepers de siempre lo lean como ajeno y a que pasen 150 bloques (2–4 min)…");
  const moved = await waitFor(["arm", vault, ...(rehearsal ? ["--allow-dry"] : [])], armProgress, [
    "No he podido pasarlo. Sigue «pasando»: nadie lo cobra ni compra.",
    "Si un keeper no lo ha leído, mira en Railway si su despliegue aún existe; si no, «marcar-ido <id>».",
    `Para devolverlo a los keepers de siempre: «volver ${vault.slice(0, 8)}».`,
  ]);
  if (!moved) return false;
  // A VAULT PARKED BEFORE IT LEFT THE QUEUE IS STILL PARKED: no handover step clears parked_reason, and no worker claims a parked vault.
  if (row.parkedReason !== null) {
    say(`OJO: ${short(vault)} está en el sistema nuevo pero sigue aparcado (${parkedWords(row.parkedReason)}): ningún trabajador lo toma.`);
    say(`     «desaparcar ${vault.slice(0, 8)}» para que lo intenten.`);
    return true;
  }
  say(`LISTO: ${short(vault)} está en el sistema nuevo. Un trabajador lo toma en segundos.`);
  return true;
}

async function traspasarTodos(): Promise<number> {
  const db = await readDb();
  if (db === null) return 1;
  if (!db.allListed) {
    say("NO: esta versión de dispatch-handover no me enseña los vaults de los keepers de siempre (falta «status --all»).");
    say("     Usa «traspasar <vault>» con la dirección entera, uno a uno. No he tocado nada.");
    return 1;
  }
  const legacy = db.vaults.filter((entry) => entry.system === "legacy").map((entry) => entry.vault);
  if (legacy.length === 0) {
    say("No queda ningún vault con los keepers de siempre. Nada que hacer.");
    return 0;
  }
  say(`Voy a pasar ${legacy.length} vault${legacy.length === 1 ? "" : "s"} al sistema nuevo, uno detrás de otro, cada uno entero antes del siguiente:`);
  for (const vault of legacy) say(`  ${short(vault)}`);
  for (const [index, vault] of legacy.entries()) {
    say("");
    say(`── ${index + 1} de ${legacy.length}: ${short(vault)} ──`);
    if (!(await moveOne(vault))) {
      const left = legacy.length - index - 1;
      say("");
      say(`Paro aquí.${left > 0 ? ` Los ${left} que faltan siguen con los keepers de siempre, que los sirven como siempre.` : ""}`);
      return 1;
    }
  }
  say("");
  say("LISTO: todos los vaults están en el sistema nuevo.");
  return 0;
}

async function volver(typed: string): Promise<number> {
  say("1/2  Comprobando…");
  const found = await findVault(typed);
  if (found === null) return 1;
  const { db, vault } = found;
  const row = db.vaults.find((entry) => entry.vault === vault)!;
  if (row.system === "legacy") {
    say(`     ${short(vault)} ya es de los keepers de siempre. Nada que hacer.`);
    return 0;
  }
  const problems = returnProblems(db, vault, rehearsal);
  if (problems.length > 0) {
    for (const problem of problems) say(`     NO: ${problem}.`);
    say("     No he tocado nada.");
    return 1;
  }
  // ONLY A NEW VAULT THE SCHEDULER ENROLLED AND NOBODY TOUCHED can be armed by it while this waits (a rollback stamps the row).
  const scheduler = await schedulerPage();
  if (autoArmable(row) && scheduler.answered && scheduler.page.autoArm?.enabled === true) {
    say("     OJO: es un vault nuevo que el scheduler está pasando solo; podría terminar de pasarlo mientras espero. Si pasa, te lo digo.");
  }
  if (row.system === "queue") {
    say(`     Sacando ${short(vault)} de la cola: ningún trabajador lo vuelve a tomar.`);
    const back = await handover(["rollback", vault]);
    if (back.ok !== true) {
      say("     No se pudo:");
      say(back.tail);
      return 1;
    }
  }
  say(`2/2  Esperando a que el trabajador lo suelte y a que caduque su último envío (hasta ~6 min)…`);
  const released = await waitFor(["release", vault], releaseProgress, [
    "No he podido devolverlo. Sigue «pasando»: nadie lo cobra ni compra.",
    `Vuelve a probar «volver ${vault.slice(0, 8)}» en unos minutos; si sigue igual, dímelo.`,
  ]);
  if (!released) return 1;
  say(`LISTO: ${short(vault)} vuelve a ser de los keepers de siempre (lo atienden desde su próxima vuelta, ~1 min).`);
  return 0;
}

async function nuevosALaCola(): Promise<number> {
  const db = await readDb();
  if (db === null) return 1;
  if (db.newVaultSystem === "queue") {
    say("Los vaults nuevos ya van al sistema nuevo. Nada que hacer.");
    return 0;
  }
  // TWO REPLICAS ANSWER THE PAGE, a GET reaches either: three reads, and every answer must agree.
  const reads: PageRead<SchedulerPageView>[] = [];
  for (let i = 0; i < 3; i += 1) reads.push(await schedulerPage());
  const problems = queueNewVaultsProblems(db, reads, rehearsal);
  if (problems.length > 0) {
    for (const problem of problems) say(`NO: ${problem}.`);
    say("No he tocado nada: los vaults nuevos siguen yendo a los keepers de siempre.");
    return 1;
  }
  const run = await handover(["new-vaults", "queue"]);
  if (run.ok !== true) {
    say("No se pudo:");
    say(run.tail);
    return 1;
  }
  say("LISTO: desde ahora un vault nuevo entra «pasando» y el scheduler lo pasa solo al sistema nuevo");
  say("(unos minutos: los recibos de los keepers y 150 bloques). «flota» lo enseña mientras tanto.");
  return 0;
}

async function nuevosALosDeSiempre(): Promise<number> {
  const db = await readDb();
  if (db === null) return 1;
  if (db.newVaultSystem === "legacy") {
    say("Los vaults nuevos ya van a los keepers de siempre. Nada que hacer.");
    return 0;
  }
  const problems = legacyNewVaultsProblems(db, rehearsal);
  if (problems.length > 0) {
    for (const problem of problems) say(`NO: ${problem}.`);
    say("No he tocado nada.");
    return 1;
  }
  const run = await handover(["new-vaults", "legacy"]);
  if (run.ok !== true) {
    say("No se pudo:");
    say(run.tail);
    return 1;
  }
  say("LISTO: desde ahora los vaults nuevos van a los keepers de siempre.");
  for (const entry of db.vaults.filter((vault) => vault.system === "draining")) {
    say(`OJO: ${short(entry.vault)} sigue «pasando»: «traspasar ${entry.vault.slice(0, 8)}» para acabar, o «volver ${entry.vault.slice(0, 8)}».`);
  }
  return 0;
}

/** One line typed by the owner: yes only for «si» / «sí». No terminal (or an empty one) is a no. */
async function confirm(question: string): Promise<boolean> {
  const lines = createInterface({ input: process.stdin, terminal: false });
  process.stdout.write(question);
  const answer = await new Promise<string>((resolve) => {
    lines.once("line", (line) => resolve(line));
    lines.once("close", () => resolve(""));
  });
  lines.close();
  console.log("");
  return /^s[ií]$/i.test(answer.trim());
}

async function marcarIdos(ids: readonly string[] | "viejos"): Promise<number> {
  const db = await readDb();
  if (db === null) return 1;
  let targets: readonly { readonly processId: string }[];
  if (ids === "viejos") {
    const stale = staleReceipts(db);
    if (stale.length === 0) {
      say("No hay ningún keeper que lleve 15 min sin leer. Nada que marcar.");
      return 0;
    }
    targets = stale;
  } else {
    const found = goneTargets(db, ids);
    if (found.problems.length > 0) {
      for (const problem of found.problems) say(`NO: ${problem}.`);
      say("No he tocado nada.");
      return 1;
    }
    targets = found.targets;
  }
  say(`Vas a marcar como ido${targets.length === 1 ? "" : "s"}:`);
  for (const entry of db.processes.filter((process) => targets.some((target) => target.processId === process.processId))) say(`  ${processLine(entry)}`);
  say("");
  say(`ANTES: comprueba en Railway que ${targets.length === 1 ? "ese deployment ya no existe" : "esos deployments ya no existen"}`);
  say("(Railway → el servicio del keeper → Deployments: no debe salir como activo).");
  if (!(await confirm("¿Lo has comprobado y ya no existe? Escribe «si» y pulsa Enter: "))) {
    say("No he tocado nada.");
    return 1;
  }
  const run = await handover(ids === "viejos" ? ["gone", "--stale"] : ["gone", ...targets.map((target) => target.processId)]);
  const marked = (run.result as { marked?: unknown } | null)?.marked;
  if (run.ok !== true || !Array.isArray(marked)) {
    say("No se pudo:");
    say(run.tail);
    return 1;
  }
  const markedIds = marked.flatMap((entry) => (typeof entry === "object" && entry !== null && typeof (entry as { processId?: unknown }).processId === "string" ? [(entry as { processId: string }).processId] : []));
  say(`LISTO: marcado${markedIds.length === 1 ? "" : "s"} como ido${markedIds.length === 1 ? "" : "s"}: ${markedIds.length === 0 ? "ninguno (ya lo estaban, o volvieron a leer)" : markedIds.join(", ")}.`);
  const extra = markedIds.filter((id) => !targets.some((target) => target.processId === id));
  if (extra.length > 0) say(`OJO: también se marcaron ${extra.join(", ")} (dejaron de leer mientras contestabas). Si alguno vuelve a leer, se desmarca solo.`);
  say("Un keeper marcado que vuelve a leer se desmarca solo.");
  return 0;
}

async function desaparcar(typed: string): Promise<number> {
  const found = await findVault(typed);
  if (found === null) return 1;
  const { db, vault } = found;
  const row = db.vaults.find((entry) => entry.vault === vault)!;
  if (row.extended && row.parkedReason === null) {
    say(`${short(vault)} no está aparcado. Nada que hacer.`);
    return 0;
  }
  if (row.parkedReason !== null) say(`${short(vault)} está aparcado: ${parkedWords(row.parkedReason)}.`);
  const run = await handover(["unpark", vault]);
  if (isOlderCliRefusal(run)) {
    say("NO: esta versión de dispatch-handover todavía no sabe desaparcar (falta «unpark»). No he tocado nada.");
    return 1;
  }
  // `ok` IS `wasParked` (dispatch-handover unpark): a vault that was not parked answers ok false with wasParked false, which is no failure.
  const result = run.result as { wasParked?: unknown } | null;
  if (result !== null && result.wasParked === false) {
    say(`${short(vault)} ya no estaba aparcado. Nada que hacer.`);
    return 0;
  }
  if (run.ok !== true || result === null || result.wasParked !== true) {
    say("No se pudo:");
    say(run.tail);
    return 1;
  }
  say(`LISTO: ${short(vault)} desaparcado. Un trabajador lo vuelve a intentar en su siguiente vuelta.`);
  say("Si se vuelve a aparcar, dímelo: es un trabajo que no termina.");
  return 0;
}

async function flota(): Promise<number> {
  const [db, scheduler, profit, volume] = await Promise.all([readDb(), schedulerPage(), keeperPage(pages.profit), keeperPage(pages.volume)]);
  if (db === null) return 1;
  say("La flota, ahora:");
  say("");
  for (const line of flotaLines({ db, scheduler, keepers: { profit, volume }, now: Date.now(), rehearsal })) say(line);
  return 0;
}

async function main(): Promise<number> {
  say("");
  switch (command.kind) {
    case "flota":
      return flota();
    case "traspasar":
      return (await moveOne(command.vault)) ? 0 : 1;
    case "traspasar-todos":
      return traspasarTodos();
    case "volver":
      return volver(command.vault);
    case "nuevos-a-la-cola":
      return nuevosALaCola();
    case "nuevos-a-los-de-siempre":
      return nuevosALosDeSiempre();
    case "marcar-ido":
      return marcarIdos(command.processIds);
    case "marcar-idos-viejos":
      return marcarIdos("viejos");
    case "desaparcar":
      return desaparcar(command.vault);
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    say(`Algo falló: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
