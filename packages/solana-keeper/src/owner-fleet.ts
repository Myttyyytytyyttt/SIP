// THE OWNER'S WHOLE FLEET, IN HIS OWN WORDS: what test-local/shadow/flota-prod.mts
// prints and decides, as pure functions a test pins without a database, a chain
// or a page.
//
//   flota                      read-only: every vault, who serves it, its last job, where new vaults
//                              go, the legacy keepers' receipts, the scheduler's and the workers' health;
//   traspasar <vault>          drain, then arm until the vault is in the queue, one vault at a time;
//   traspasar-todos            every legacy vault, one after another, each fully before the next;
//   volver <vault>             rollback, then release until the legacy keepers have it again;
//   nuevos-a-la-cola           fleet.new_vault_system = 'queue', only while the scheduler arms by itself;
//   nuevos-a-los-de-siempre    fleet.new_vault_system = 'legacy', only while the legacy keepers read;
//   marcar-ido <id>...         legacy processes whose deployments are gone (after checking Railway);
//   marcar-idos-viejos         every legacy receipt older than LEGACY_READ_FRESH_MS (same check first);
//   desaparcar <vault>         clear a parked vault's parked_reason.
//
// WHY A SECOND TOOL AND NOT A BIGGER handover-prod. handover-prod.mts moved the
// owner's vault on 2026-10-27 and is left exactly as it is: it is the tool that
// worked. This one is the same discipline for every vault — every write is
// bin/dispatch-handover.mts's own command, whose rules (receipts, the 150-block
// wait, the carries) stay the guard — plus the refusals that only matter once
// more than one vault moves: one vault in transit at a time, never `arm --all`,
// and no flag flipped that would leave a new user with nobody serving him.
//
// TOLERANT OF AN OLDER dispatch-handover. `status --all` and `unpark` are being
// added beside this file; an older CLI refuses `--all` as an unknown flag, and
// then the tool reads plain `status` (only the vaults that are not legacy) and
// says so. Every field that only the newer CLI reports is read as absent, never
// as zero: AN UNREAD FIELD AND AN EMPTY ONE ARE DIFFERENT FACTS.
//
// THE CLI'S SENTENCES ARE TRANSLATED BY PATTERN (plainBlocker). A sentence no
// pattern knows is shown as the CLI wrote it, and test/owner-fleet.test.ts
// produces every blocker through the real Handover so a rewording fails a test
// instead of reaching the owner in English.
//
// DARK. Only test-local/shadow/flota-prod.mts and its tests load this file; no
// entry point under bin/ reaches it (test/dispatch-dark.test.ts lists it).

import type { TurnInvest, TurnSettle } from "./doorbell.js";
import { LEGACY_READ_FRESH_MS, RELEASE_JOB_CEILING_MINUTES } from "./handover.js";
import {
  KEEPER_ROLES,
  MODE_FIXED_BYTE,
  MODE_PROFIT_BYTE,
  MODE_ROUNDUP_BYTE,
  MODE_VOLUME_BYTE,
  isKeeperRole,
  keeperModeFor,
  roleCarriesLosses,
  type KeeperRole,
} from "./role-registry.js";

/** The owner's own vault (VOLUME, two linked wallets): marked on every list. */
export const OWNER_VAULT = "EFXK995PV49Qz8xPSYMEUDBU5AKRR466JkgsfuGak5iU";

/** The only chain this tool reads, and only for block heights (through dispatch-handover's arm and release). */
export const PUBLIC_RPC = "https://api.mainnet-beta.solana.com";

/** The public /status pages: plain GETs, no header, no key. */
export const PROD_PAGES = {
  scheduler: "https://sip-solana-scheduler-production.up.railway.app/status",
  profit: "https://sip-solana-keeper-production.up.railway.app/status",
  volume: "https://sip-solana-volume-keeper-production.up.railway.app/status",
} as const satisfies Record<"scheduler" | KeeperRole, string>;

/**
 * How recent a legacy keeper's read must be for `traspasar` to START: two
 * sweeps and a bit (handover-prod.mts's rule). A row older than this that has
 * not read the vault as foreign is a container `arm` would wait on.
 */
export const FRESH_READ_MS = 150_000;

/** How often arm and release are asked again while waiting: a third of a sweep. */
export const POLL_MS = 20_000;

/** How long one vault may take to move, either way, before the tool stops and says where it is. */
export const MOVE_TIMEOUT_MS = 15 * 60_000;

/** A scheduler whose lock holder has not ticked for this long is marking nothing due. */
export const SCHEDULER_STALE_MS = 3 * 60_000;

/** A claimable vault waiting this long for a worker is worth a line. */
export const QUEUE_LAG_MS = 5 * 60_000;

/** CLI calls that may fail in a row inside a wait (a database blip, a 429 on the public RPC) before the wait stops. */
export const CLI_FAILURES_TOLERATED = 3;

// ── words ────────────────────────────────────────────────────────────────────

export type FlotaCommand =
  | { readonly kind: "flota" | "traspasar-todos" | "nuevos-a-la-cola" | "nuevos-a-los-de-siempre" | "marcar-idos-viejos" }
  | { readonly kind: "traspasar" | "volver" | "desaparcar"; readonly vault: string }
  | { readonly kind: "marcar-ido"; readonly processIds: readonly string[] };

export const FLOTA_USAGE = [
  "Uso:",
  "  flota                       cómo está todo (no toca nada)",
  "  traspasar <vault>           pasa un vault de los keepers de siempre al sistema nuevo",
  "  traspasar-todos             pasa todos los que quedan, uno detrás de otro",
  "  volver <vault>              devuelve un vault a los keepers de siempre",
  "  nuevos-a-la-cola            los vaults nuevos, al sistema nuevo",
  "  nuevos-a-los-de-siempre     los vaults nuevos, a los keepers de siempre",
  "  marcar-ido <id>...          un keeper cuyo despliegue ya no existe en Railway",
  "  marcar-idos-viejos          todos los keepers que llevan 15 min sin leer",
  "  desaparcar <vault>          que el sistema nuevo vuelva a intentar un vault aparcado",
  "Un <vault> es su dirección, o sus primeras letras como las enseña «flota».",
].join("\n");

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;

/** A vault as typed: its address or its first letters (at least 4), a trailing «…» allowed. Null when it cannot be one. */
export function vaultArg(raw: string): string | null {
  const trimmed = raw.trim().replace(/(?:…|\.\.\.)$/, "");
  return trimmed.length >= 4 && trimmed.length <= 44 && BASE58.test(trimmed) ? trimmed : null;
}

/** A whole address, not a prefix: what dispatch-handover itself accepts (it then checks the 32 bytes). */
export function isFullAddress(text: string): boolean {
  return text.length >= 32 && text.length <= 44 && BASE58.test(text);
}

/** The command line, strictly; a problem is a sentence to print. Nothing typed is echoed back (it might be a pasted secret). */
export function parseFlotaArgs(argv: readonly string[]): { readonly command: FlotaCommand } | { readonly problem: string } {
  const [word, ...rest] = argv;
  switch (word) {
    case "flota":
    case "traspasar-todos":
    case "nuevos-a-la-cola":
    case "nuevos-a-los-de-siempre":
    case "marcar-idos-viejos":
      return rest.length === 0 ? { command: { kind: word } } : { problem: `«${word}» no lleva nada detrás.` };
    case "traspasar":
    case "volver":
    case "desaparcar": {
      if (rest.length !== 1) return { problem: `«${word}» lleva un vault: su dirección, o sus primeras letras como las enseña «flota».` };
      const vault = vaultArg(rest[0]!);
      if (vault === null) return { problem: `Eso no parece un vault: una dirección de Solana, o al menos sus 4 primeras letras.` };
      return { command: { kind: word, vault } };
    }
    case "marcar-ido": {
      if (rest.length === 0) return { problem: "«marcar-ido» lleva el id de un keeper: el que enseña «flota»." };
      if (rest.some((id) => !/^[\w:.-]{4,200}$/.test(id))) return { problem: "Eso no parece el id de un keeper: cópialo tal cual de «flota»." };
      return { command: { kind: "marcar-ido", processIds: [...new Set(rest)] } };
    }
    default:
      return { problem: word === undefined ? "Falta la palabra." : "No conozco esa palabra." };
  }
}

// ── the database url ─────────────────────────────────────────────────────────

export type UrlCheck =
  | { readonly ok: true; readonly url: string; readonly secrets: readonly string[]; readonly rehearsal: boolean }
  | { readonly ok: false; readonly lines: readonly string[] };

/**
 * PRODUCTION'S DATABASE AND NOTHING ELSE: a Supabase host on 5432 (6543 holds no
 * session, and any other host is not the keepers' database). A REHEARSAL — the
 * flag set AND the loopback — accepts 127.0.0.1 on any port. THE HOST IS NOT A
 * SECRET (the password is): naming it is what tells a wrong copy apart.
 */
export function checkDatabaseUrl(raw: string | undefined, rehearsalFlag: boolean): UrlCheck {
  const url = raw?.trim() ?? "";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, lines: ["Esa dirección no se puede leer. No he tocado nada."] };
  }
  const rehearsal = rehearsalFlag && parsed.hostname === "127.0.0.1";
  const host = parsed.hostname || "(ninguno)";
  if (!/^postgres(?:ql)?:$/.test(parsed.protocol) || (!rehearsal && !/(?:^|\.)supabase\.(?:co|com)$/i.test(parsed.hostname))) {
    const lines = [`Esa dirección apunta a «${host}», que no es Supabase. No he tocado nada.`];
    if (/\.railway\.internal$|\.rlwy\.net$/i.test(host)) lines.push("Es una base de Railway: la buena está en el servicio sip-solana-keeper.");
    lines.push("La buena es la DATABASE_URL de sip-solana-keeper (Railway → sip-solana-keeper → Variables), y su servidor termina en supabase.com.");
    return { ok: false, lines };
  }
  if (!rehearsal && (parsed.port || "5432") !== "5432") {
    return { ok: false, lines: [`Esa dirección usa el puerto ${parsed.port}; la de los keepers usa el 5432. Cópiala tal cual. No he tocado nada.`] };
  }
  // THE PASSWORD IN EVERY FORM IT CAN BE PRINTED IN: as the url spells it, decoded, and re-encoded.
  const secrets = new Set([parsed.password]);
  try {
    const decoded = decodeURIComponent(parsed.password);
    secrets.add(decoded);
    secrets.add(encodeURIComponent(decoded));
    // AND EVERY CHARACTER THAT IS NOT A LETTER OR A DIGIT ENCODED, the form a url builder that encodes `!*'()` too writes.
    secrets.add([...decoded].map((char) => (/^[A-Za-z0-9]$/.test(char) ? char : [...new TextEncoder().encode(char)].map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, "0")}`).join(""))).join(""));
  } catch {
    // Not valid percent-encoding: the form the url spells is the one there is.
  }
  return { ok: true, url, secrets: [...secrets].filter((secret) => secret.length >= 4), rehearsal };
}

/** The url and its password, cut out of a line before it is printed. Longest first, so a shorter form never splits a longer one. */
export function cleanLine(text: string, url: string, secrets: readonly string[]): string {
  let out = url.length > 0 ? text.split(url).join("<url>") : text;
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    if (secret.length >= 4) out = out.split(secret).join("<password>");
  }
  return out;
}

export interface RehearsalOverrides {
  readonly pages: { readonly scheduler: string; readonly profit: string; readonly volume: string };
  readonly rpc: string;
  readonly pollMs: number;
}

/**
 * A rehearsal's stand-ins: SIP_FLOTA_TOOL_PAGES (a loopback base serving
 * /scheduler/status, /keeper/status and /volume-keeper/status),
 * SIP_FLOTA_TOOL_RPC (a loopback JSON-RPC) and SIP_FLOTA_TOOL_POLL_MS. OUTSIDE A
 * REHEARSAL THEY ARE REFUSED, not ignored: a tool that silently read another
 * page than the one it names would lie about production.
 */
export function readOverrides(env: Readonly<Record<string, string | undefined>>, rehearsal: boolean): RehearsalOverrides | { readonly problem: string } {
  const pagesBase = env["SIP_FLOTA_TOOL_PAGES"]?.trim() || null;
  const rpc = env["SIP_FLOTA_TOOL_RPC"]?.trim() || null;
  const poll = env["SIP_FLOTA_TOOL_POLL_MS"]?.trim() || null;
  if (!rehearsal) {
    if (pagesBase !== null || rpc !== null || poll !== null) {
      return { problem: "SIP_FLOTA_TOOL_PAGES, SIP_FLOTA_TOOL_RPC y SIP_FLOTA_TOOL_POLL_MS solo valen en un ensayo contra 127.0.0.1. No he tocado nada." };
    }
    return { pages: PROD_PAGES, rpc: PUBLIC_RPC, pollMs: POLL_MS };
  }
  const loopback = (value: string): boolean => {
    try {
      const parsed = new URL(value);
      return parsed.protocol === "http:" && parsed.hostname === "127.0.0.1";
    } catch {
      return false;
    }
  };
  if (pagesBase !== null && !loopback(pagesBase)) return { problem: "SIP_FLOTA_TOOL_PAGES tiene que ser http://127.0.0.1:<puerto>." };
  if (rpc !== null && !loopback(rpc)) return { problem: "SIP_FLOTA_TOOL_RPC tiene que ser http://127.0.0.1:<puerto>." };
  let pollMs = POLL_MS;
  if (poll !== null) {
    if (!/^\d{2,6}$/.test(poll) || Number(poll) < 50) return { problem: "SIP_FLOTA_TOOL_POLL_MS es un número de milisegundos, 50 o más." };
    pollMs = Number(poll);
  }
  const base = pagesBase?.replace(/\/+$/, "") ?? null;
  return {
    pages: base === null ? PROD_PAGES : { scheduler: `${base}/scheduler/status`, profit: `${base}/keeper/status`, volume: `${base}/volume-keeper/status` },
    rpc: rpc ?? PUBLIC_RPC,
    pollMs,
  };
}

// ── what dispatch-handover status says ───────────────────────────────────────

export interface VaultEntry {
  readonly vault: string;
  /** legacy | draining | queue, as vault_work says. */
  readonly system: string;
  readonly systemAt: string | null;
  readonly handoverHeight: string | null;
  readonly holder: string | null;
  readonly leaseUntil: string | null;
  // `status --all` only (a newer dispatch-handover); null when the CLI did not say.
  readonly skimMode: number | null;
  readonly lane: string | null;
  readonly fence: string | null;
  readonly claimedAt: string | null;
  readonly lastDoneAt: string | null;
  readonly lastOutcome: string | null;
  readonly lastDetail: string | null;
  readonly parkedReason: string | null;
  /**
   * Whether the CLI reported the `status --all` fields at all. False (an older
   * CLI): every one of them is unknown, and a null parkedReason or lastOutcome
   * says nothing — not "not parked", not "never worked".
   */
  readonly extended: boolean;
  readonly attempts: number | null;
  readonly dueAt: string | null;
  readonly streaks: Readonly<Record<string, unknown>> | null;
}

export interface ProcessEntry {
  readonly processId: string;
  readonly role: string;
  readonly dispatch: string | null;
  readonly deployment: string | null;
  readonly host: string | null;
  /** Acting (armed and holding its claim) at its last read. */
  readonly live: boolean;
  /** How long ago it last read, by the database's clock. */
  readonly ageMs: number;
  readonly goneAt: string | null;
  /** Every vault it read as not its own at that read. */
  readonly notLegacy: Readonly<Record<string, string>>;
  /** The vaults whose loss carry it held only in its memory at that read (arm refuses each); empty when the CLI did not say. */
  readonly carryVaults: readonly string[];
  readonly carryStore: string | null;
}

export interface FleetDb {
  readonly newVaultSystem: string | null;
  /** fleet.webhook_owner; null when the CLI did not say (older) or no row. */
  readonly webhookOwner: string | null;
  readonly vaults: readonly VaultEntry[];
  readonly processes: readonly ProcessEntry[];
  /** True when the list is `status --all`'s, every vault_work row; false when only the vaults that are not legacy. */
  readonly allListed: boolean;
}

type Json = Readonly<Record<string, unknown>>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const num = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  return null;
};
const intText = (value: unknown): string | null => (typeof value === "string" && /^\d+$/.test(value) ? value : typeof value === "number" && Number.isSafeInteger(value) ? String(value) : null);
const bool = (value: unknown): boolean | null => (typeof value === "boolean" ? value : null);

/**
 * dispatch-handover status's `result`, read. The fields every version reports
 * are required — a vault without an address or a system, a process without an
 * id, a role, an age or `live`, is a reply this tool does not understand, and
 * it answers null rather than guess. Everything `status --all` adds is optional.
 */
export function readFleetDb(result: unknown, allListed: boolean): FleetDb | null {
  if (!isObject(result) || !Array.isArray(result["vaults"]) || !Array.isArray(result["processes"])) return null;
  const vaults: VaultEntry[] = [];
  for (const raw of result["vaults"] as unknown[]) {
    if (!isObject(raw)) return null;
    const vault = str(raw["vault"]);
    const system = str(raw["system"]);
    if (vault === null || vault === "" || system === null) return null;
    vaults.push({
      vault,
      system,
      systemAt: str(raw["systemAt"]),
      handoverHeight: intText(raw["handoverHeight"]),
      holder: str(raw["holder"]),
      leaseUntil: str(raw["leaseUntil"]),
      skimMode: num(raw["skimMode"]),
      lane: str(raw["lane"]),
      fence: intText(raw["fence"]),
      claimedAt: str(raw["claimedAt"]),
      lastDoneAt: str(raw["lastDoneAt"]),
      lastOutcome: str(raw["lastOutcome"]),
      lastDetail: str(raw["lastDetail"]),
      parkedReason: str(raw["parkedReason"]),
      extended: Object.hasOwn(raw, "lastOutcome") || Object.hasOwn(raw, "parkedReason"),
      attempts: num(raw["attempts"]),
      dueAt: str(raw["dueAt"]),
      streaks: isObject(raw["streaks"]) ? raw["streaks"] : null,
    });
  }
  const processes: ProcessEntry[] = [];
  for (const raw of result["processes"] as unknown[]) {
    if (!isObject(raw)) return null;
    const processId = str(raw["processId"]);
    const role = str(raw["role"]);
    const ageMs = num(raw["ageMs"]);
    const live = bool(raw["live"]);
    if (processId === null || role === null || ageMs === null || live === null) return null;
    const notLegacy: Record<string, string> = {};
    if (isObject(raw["notLegacy"])) for (const [vault, system] of Object.entries(raw["notLegacy"])) if (typeof system === "string") notLegacy[vault] = system;
    processes.push({
      processId,
      role,
      dispatch: str(raw["dispatch"]),
      deployment: str(raw["deployment"]),
      host: str(raw["host"]),
      live,
      ageMs,
      goneAt: str(raw["goneAt"]),
      notLegacy,
      carryVaults: Array.isArray(raw["carryVaults"]) ? (raw["carryVaults"] as unknown[]).filter((entry): entry is string => typeof entry === "string") : [],
      carryStore: str(raw["carryStore"]),
    });
  }
  return { newVaultSystem: str(result["newVaultSystem"]), webhookOwner: str(result["webhookOwner"]), vaults, processes, allListed };
}

/** One vault's row, added to a list that did not have it (an older CLI's `status <vault>`). */
export function withVault(db: FleetDb, one: FleetDb | null, vault: string): FleetDb {
  if (one === null || db.vaults.some((entry) => entry.vault === vault)) return db;
  return { ...db, vaults: [...db.vaults, ...one.vaults.filter((entry) => entry.vault === vault)] };
}

/** Whether a refusal is an older dispatch-handover not knowing a command or flag this tool uses. */
export function isOlderCliRefusal(run: { readonly code: number; readonly refused: string | null }): boolean {
  return run.code === 2 && run.refused !== null && /unknown (?:command|flag)/.test(run.refused);
}

/** A typed vault, found: the whole address, or the one listed vault its letters start. */
export function resolveVault(arg: string, db: FleetDb): { readonly vault: string } | { readonly problem: string } {
  if (db.vaults.some((entry) => entry.vault === arg)) return { vault: arg };
  const matches = db.vaults.filter((entry) => entry.vault.startsWith(arg));
  if (matches.length === 1) return { vault: matches[0]!.vault };
  if (matches.length > 1) return { problem: `Hay ${matches.length} vaults que empiezan por «${arg}»: escribe más letras.` };
  if (isFullAddress(arg)) return { vault: arg };
  return {
    problem: `No encuentro ningún vault que empiece por «${arg}».${db.allListed ? "" : " Con esta versión de dispatch-handover solo veo los que no son de los keepers de siempre: escribe la dirección entera."}`,
  };
}

/** The vault must have a vault_work row: one with none is an address nobody discovered — a typo, as often as not. */
export function rowProblem(db: FleetDb, vault: string): string | null {
  return db.vaults.some((entry) => entry.vault === vault)
    ? null
    : `${short(vault)} no está en la lista de la flota (vault_work): o la dirección está mal, o el scheduler aún no lo ha apuntado (lo hace en su siguiente vuelta, si tiene alguna cartera enlazada)`;
}

// ── small words ──────────────────────────────────────────────────────────────

export const short = (address: string): string => `${address.slice(0, 8)}…`;

const ROLE_WORDS: Record<KeeperRole, string> = { profit: "beneficios", volume: "volumen" };

/** "beneficios": a legacy role in the owner's words; an unknown one as written. */
export function roleWords(role: string): string {
  return isKeeperRole(role) ? ROLE_WORDS[role] : role;
}

/** "el keeper de beneficios". */
export function keeperWords(role: string): string {
  return `el keeper de ${roleWords(role)}`;
}

export function agoWords(ms: number): string {
  if (!Number.isFinite(ms) || ms < 1_000) return "ahora mismo";
  if (ms < 90_000) return `hace ${Math.round(ms / 1000)} s`;
  if (ms < 90 * 60_000) return `hace ${Math.round(ms / 60_000)} min`;
  if (ms < 36 * 3_600_000) return `hace ${Math.round(ms / 3_600_000)} h`;
  return `hace ${Math.round(ms / 86_400_000)} días`;
}

/** A duration as the owner reads it: "15 min", "2 min y medio", "90 s". */
export function spanWords(ms: number): string {
  if (ms % 60_000 === 0) return `${ms / 60_000} min`;
  if (ms % 30_000 === 0) return `${Math.floor(ms / 60_000)} min y medio`;
  return `${Math.round(ms / 1000)} s`;
}

const MODE_WORDS: Readonly<Record<number, string>> = {
  [MODE_PROFIT_BYTE]: "beneficio",
  [MODE_VOLUME_BYTE]: "volumen",
  [MODE_ROUNDUP_BYTE]: "redondeo",
  [MODE_FIXED_BYTE]: "cuota fija",
};

/** The vault's mode byte, as the owner names his modes; null when vault_work holds none. */
export function modeWords(skimMode: number | null): string | null {
  if (skimMode === null) return null;
  return MODE_WORDS[skimMode] ?? `modo ${skimMode}`;
}

/** Who serves a vault, in four words. */
export type Server = "queue" | "legacy" | "draining" | "parked";

export const SERVER_WORDS: Record<Server, string> = {
  queue: "sistema nuevo",
  legacy: "keepers de siempre",
  draining: "pasando",
  parked: "aparcado",
};

export function whoServes(vault: VaultEntry): Server | null {
  switch (vault.system) {
    case "queue":
      return vault.parkedReason !== null ? "parked" : "queue";
    case "legacy":
      return "legacy";
    case "draining":
      return "draining";
    default:
      return null;
  }
}

/**
 * WHETHER THE SCHEDULER'S AUTO-ARM WILL EVER MOVE THIS VAULT: only a row it
 * enrolled itself and nobody has touched since — draining, system_at never
 * stamped (every handover step stamps it, the enrolment does not), never
 * claimed (fence 0), held by nobody (AUTO_ARMABLE_SQL, the scheduler's
 * auto-arm). A vault an operator drained, rolled back or released — a
 * `traspasar` that stopped half way, a `volver` that did — is NOT one: the
 * scheduler leaves it draining for ever, served by nobody, and the screen must
 * say so rather than "the scheduler moves it". False when the CLI did not
 * report the fence (an older one): unknown is not "the scheduler's".
 */
export function autoArmable(vault: VaultEntry): boolean {
  return vault.system === "draining" && vault.systemAt === null && vault.fence === "0" && vault.holder === null;
}

const systemWords = (system: string | null): string =>
  system === "queue" ? SERVER_WORDS.queue : system === "legacy" ? SERVER_WORDS.legacy : system === "draining" ? SERVER_WORDS.draining : (system ?? "sin fila");

// ── a job's last outcome ─────────────────────────────────────────────────────

interface Said {
  readonly text: string;
  /** Something the owner should look at, or tell somebody about. */
  readonly attention: boolean;
}

/** EVERY settle outcome a worker writes, and the compiler holds it so: a new member does not build until it has words. */
const SETTLE_WORDS: Record<TurnSettle, Said> = {
  IDLE: { text: "sin operaciones nuevas", attention: false },
  PENDING_FINALITY: { text: "operaciones nuevas, esperando a que la cadena las cierre", attention: false },
  SETTLED: { text: "cobrado", attention: false },
  NO_PROFIT: { text: "sin ganancia que cobrar", attention: false },
  INCOMPLETE: { text: "no pudo leer todo el historial", attention: true },
  NO_SIGNER: { text: "no puede firmar por la cartera (el usuario tiene que dar el permiso en la web)", attention: true },
  UNSUPPORTED_MODE: { text: "un modo que aún no se cobra", attention: true },
  PAUSED: { text: "en pausa", attention: false },
  BELOW_RESERVE: { text: "la cartera no tiene saldo para pagar el cobro", attention: false },
  RETRY: { text: "no entró; lo reintenta", attention: true },
  FAILED: { text: "falló", attention: true },
  THREW: { text: "reventó (error inesperado)", attention: true },
};

const INVEST_WORDS: Record<TurnInvest, Said> = {
  IDLE: { text: "nada que comprar", attention: false },
  NO_POLICY: { text: "sin cesta elegida", attention: false },
  PAUSED: { text: "en pausa", attention: false },
  INVESTED: { text: "comprado", attention: false },
  REFUSED: { text: "rechazada (precio o liquidez)", attention: true },
  FAILED: { text: "falló", attention: true },
  DEFERRED: { text: "aplazada a la siguiente vuelta", attention: false },
  THREW: { text: "reventó (error inesperado)", attention: true },
};

/** The outcomes a job writes for the whole vault (src/worker-job.ts, worker-loop.ts, the scheduler's idle pass, the store's release). */
const JOB_WORDS: Readonly<Record<string, Said>> = {
  IDLE: { text: "al día: nada nuevo en la cadena", attention: false },
  WAITING_INTENT: { text: "esperando a saber si entró un envío anterior", attention: false },
  WAITING_FINALITY: { text: "esperando a que pasen los bloques de un envío anterior", attention: false },
  FAILED: { text: "falló", attention: true },
  NO_LINK: { text: "ninguna cartera enlazada", attention: false },
  RETRY: { text: "no pudo empezar; lo reintenta", attention: true },
  THREW: { text: "el trabajo reventó; lo reintenta en un minuto", attention: true },
  RELEASED: { text: "lo soltó a medias (un reinicio); vuelve enseguida", attention: false },
};

const lookup = <K extends string>(table: Readonly<Record<K, Said>>, key: string): Said | null =>
  Object.hasOwn(table, key) ? table[key as K] : null;

/** Several wallets' settles, grouped: "cobrado", "cobrado (2 carteras)", "1 cobrado, 1 sin operaciones nuevas". */
function settleGroup(outcomes: readonly string[]): Said {
  const counts = new Map<string, number>();
  for (const outcome of outcomes) counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
  const said = [...counts.keys()].map((outcome) => lookup(SETTLE_WORDS, outcome) ?? { text: outcome, attention: true });
  const attention = said.some((entry) => entry.attention);
  if (counts.size === 1) return { text: `${said[0]!.text}${outcomes.length > 1 ? ` (${outcomes.length} carteras)` : ""}`, attention };
  return { text: [...counts.values()].map((count, index) => `${count} ${said[index]!.text}`).join(", "), attention };
}

/** vault_work.last_outcome in the owner's words. */
export function outcomeWords(outcome: string | null): Said {
  if (outcome === null) return { text: "todavía sin ningún trabajo", attention: false };
  const turn = /^settle (\S+) · invest (\S+)$/.exec(outcome);
  if (turn !== null) {
    const parts: Said[] = [];
    if (turn[1] !== "none") {
      const group = settleGroup(turn[1]!.split(","));
      parts.push({ text: `cobro: ${group.text}`, attention: group.attention });
    }
    if (turn[2] !== "none") {
      const invest = lookup(INVEST_WORDS, turn[2]!) ?? { text: turn[2]!, attention: true };
      parts.push({ text: `compra: ${invest.text}`, attention: invest.attention });
    }
    if (parts.length === 0) return { text: "nada que hacer", attention: false };
    return { text: parts.map((part) => part.text).join(" · "), attention: parts.some((part) => part.attention) };
  }
  return lookup(JOB_WORDS, outcome) ?? { text: outcome, attention: true };
}

/** A vault's streaks (vault_work.streaks) that say something is repeating. Empty when none does, or none was reported. */
export function streakWords(streaks: Readonly<Record<string, unknown>> | null): string[] {
  if (streaks === null) return [];
  const count = (value: unknown): number => (typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0);
  const out: string[] = [];
  const refused = count(streaks["investRefused"]);
  if (refused > 0) out.push(`lleva ${refused} compra${refused === 1 ? "" : "s"} rechazada${refused === 1 ? "" : "s"} seguidas`);
  const failed = count(streaks["investFailed"]);
  if (failed > 0) out.push(`lleva ${failed} compra${failed === 1 ? "" : "s"} fallida${failed === 1 ? "" : "s"} seguidas`);
  const retries = isObject(streaks["settleRetries"]) ? Object.values(streaks["settleRetries"]).map(count) : [];
  const worst = Math.max(0, ...retries);
  if (worst > 0) out.push(`un cobro lleva ${worst} reintento${worst === 1 ? "" : "s"} seguidos`);
  return out;
}

/** Why the scheduler parked a vault (scheduler-pg.ts PARK_SQL), in the owner's words. */
export function parkedWords(reason: string): string {
  const lapsed = /^its lease lapsed (\d+) claims in a row without a completion/.exec(reason);
  if (lapsed !== null) return `su trabajo se cortó ${lapsed[1]} veces seguidas sin terminar`;
  return reason;
}

// ── the CLI's blockers ───────────────────────────────────────────────────────

const remaining = (above: string, now: string): string => {
  const left = Number(above) + 1 - Number(now);
  return left > 0 ? `faltan ${left} bloques` : "ya casi";
};

/**
 * One blocker of arm, release, drain or rollback (src/handover.ts) in the
 * owner's words, with what to do. A sentence no pattern knows comes back as it
 * was written.
 */
export function plainBlocker(blocker: string): string {
  let m = /^legacy process (\S+) \((\w+), deployment .*?, last read (.+?) ago(?:, acting)?\) has not yet read this vault as not its own/.exec(blocker);
  if (m !== null) {
    return `${keeperWords(m[2]!)} (id ${m[1]}) todavía no lo ha leído como ajeno (leyó por última vez hace ${m[3]}); espera a su siguiente vuelta. Si su despliegue ya no existe en Railway: «marcar-ido ${m[1]}»`;
  }
  m = /^legacy process (\S+) \((\w+), .*? holds a loss carry for a link of this vault only in its memory/.exec(blocker);
  if (m !== null) {
    return (
      `${keeperWords(m[2]!)} (id ${m[1]}) guarda solo en su memoria una pérdida de este vault, que el sistema nuevo no vería. No le cambies ahora ` +
      "SIP_SOLANA_CARRY_STORE: el redespliegue olvida esa pérdida. Devuélvelo con «volver» (allí la pérdida sigue en su memoria y se " +
      `compensa); si su despliegue ya no existe en Railway, la pérdida ya se perdió: «marcar-ido ${m[1]}»`
    );
  }
  m = /^no (ACTING )?(\w+) keeper has read this vault as not its own in the last (\d+) min/.exec(blocker);
  if (m !== null) {
    return `ningún keeper de ${roleWords(m[2]!)}${m[1] === undefined ? "" : " encendido y actuando"} lo ha leído como ajeno en los últimos ${m[3]} min: ¿está encendido en Railway, con SIP_SOLANA_DISPATCH=on?`;
  }
  m = /^every legacy keeper has let go; waiting for the finalized height to pass (\d+) \(now (\d+)\)/.exec(blocker);
  if (m !== null) return `los keepers de siempre ya lo han soltado; esperando a que pasen los bloques (${remaining(m[1]!, m[2]!)})`;
  m = /^waiting for the finalized height to pass (\d+) \(now (\d+)\)/.exec(blocker);
  if (m !== null) return `esperando a que pasen los bloques (${remaining(m[1]!, m[2]!)})`;
  if (/^vault_work has no row for this vault: drain it first/.test(blocker)) return "la base no tiene este vault apuntado";
  if (/^vault_work has no row for this vault: it is already the legacy keepers'/.test(blocker)) return "ya es de los keepers de siempre";
  m = /^the vault is (\w+): only a draining vault is (?:armed|released)/.exec(blocker);
  if (m !== null) return `el vault está en «${systemWords(m[1]!)}», no «${SERVER_WORDS.draining}»`;
  m = /^the vault is (\w+), not legacy: there is nothing to drain/.exec(blocker);
  if (m !== null) return `el vault ya no es de los keepers de siempre (está en «${systemWords(m[1] === "unknown" ? null : m[1]!)}»)`;
  m = /^the vault is (\w+), not queue: there is nothing to roll back/.exec(blocker);
  if (m !== null) return `el vault no está en el sistema nuevo (está en «${systemWords(m[1] === "unknown" ? null : m[1]!)}»)`;
  if (/^worker \S+ still holds it/.test(blocker)) {
    return `un trabajador lo tiene entre manos; espera a que termine (como mucho ${RELEASE_JOB_CEILING_MINUTES} min desde que lo tomó)`;
  }
  m = /^a worker's transaction for this vault could still land until height (\d+): wait for the finalized height to pass it \(now (\d+)\)/.exec(blocker);
  if (m !== null) return `un envío del trabajador aún podría entrar en la cadena; esperando a que pasen los bloques (${remaining(m[1]!, m[2]!)})`;
  m = /^legacy process (\S+) \((\w+), .*? runs SIP_SOLANA_CARRY_STORE=(off|dual|unknown)/.exec(blocker);
  if (m !== null) {
    return `${keeperWords(m[2]!)} (id ${m[1]}) no lee en cada vuelta las pérdidas que guardó el sistema nuevo (SIP_SOLANA_CARRY_STORE=${m[3]}): ponle SIP_SOLANA_CARRY_STORE=on en Railway; si ese despliegue ya no existe, «marcar-ido ${m[1]}»`;
  }
  m = /^no .*? keeper running SIP_SOLANA_CARRY_STORE=on has read in the last (\d+) min, and a worker carried a loss/.exec(blocker);
  if (m !== null) {
    return `ningún keeper de beneficios con SIP_SOLANA_CARRY_STORE=on ha leído en los últimos ${m[1]} min, y el sistema nuevo guardó una pérdida de este vault: enciéndelo con SIP_SOLANA_CARRY_STORE=on y SIP_SOLANA_DISPATCH=on, y espera su siguiente vuelta`;
  }
  return blocker;
}

// ── the legacy keepers' receipts ─────────────────────────────────────────────

/** vivo: read within LEGACY_READ_FRESH_MS; viejo: not since, and not marked; ido: marked gone. */
export type ReceiptState = "vivo" | "viejo" | "ido";

export function receiptState(process: ProcessEntry): ReceiptState {
  if (process.goneAt !== null) return "ido";
  return process.ageMs <= LEGACY_READ_FRESH_MS ? "vivo" : "viejo";
}

/** The receipts of a role that say its keeper is reading now: not gone, within `withinMs`, and acting unless a rehearsal's dry keepers count. */
function reading(db: FleetDb, role: KeeperRole, withinMs: number, rehearsal: boolean): ProcessEntry[] {
  return db.processes.filter((entry) => entry.goneAt === null && entry.role === role && entry.ageMs <= withinMs && (rehearsal || entry.live));
}

/** Receipts not marked gone and older than LEGACY_READ_FRESH_MS: what `gone --stale` would mark. */
export function staleReceipts(db: FleetDb): ProcessEntry[] {
  return db.processes.filter((entry) => receiptState(entry) === "viejo");
}

export function processLine(entry: ProcessEntry): string {
  return `${keeperWords(entry.role)} · id ${entry.processId} · despliegue ${entry.deployment ?? "?"} · máquina ${entry.host ?? "?"} · leyó ${agoWords(entry.ageMs)}`;
}

/** What each legacy role needs to be doing, per role, as one problem each: `withinMs` decides how fresh. */
function rolesReadingProblems(db: FleetDb, roles: readonly string[], withinMs: number, rehearsal: boolean, why: string): string[] {
  const problems: string[] = [];
  for (const role of roles) {
    if (!isKeeperRole(role)) {
      problems.push(`no conozco el rol «${role}»`);
      continue;
    }
    if (reading(db, role, withinMs, rehearsal).length === 0) {
      problems.push(`${keeperWords(role)} no ha leído la base en los últimos ${spanWords(withinMs)}${rehearsal ? "" : " estando encendido y actuando"}: ${why}. ¿Está encendido en Railway, con SIP_SOLANA_DISPATCH=on?`);
    }
  }
  return problems;
}

// ── the decisions ────────────────────────────────────────────────────────────

/**
 * Why `traspasar <vault>` may not start (empty: it may). Everything here is
 * something arm would otherwise wait on for its whole fifteen minutes, or a
 * second vault in transit:
 *   * the vault has a vault_work row (an address nobody discovered is a typo);
 *   * NO OTHER VAULT IS DRAINING: one in transit at a time, so a stuck one is
 *     never hidden behind the next (`autoArmOn`: the scheduler arms by itself,
 *     and a draining vault it enrolled and nobody touched — autoArmable — is
 *     one it is moving, so the advice is to wait; any other draining vault
 *     nobody but the owner will finish);
 *   * each legacy role has a receipt read in the last FRESH_READ_MS, acting
 *     (a rehearsal's dry keepers count): it is that keeper's own receipt that
 *     lets the vault go;
 *   * no receipt that is not marked gone has stopped reading (older than
 *     FRESH_READ_MS) without having read THIS vault as foreign — an old
 *     container arm would wait on, which the owner marks gone after Railway;
 *   * NO RECEIPT HOLDS A LOSS OF THIS VAULT ONLY IN ITS MEMORY (carryVaults):
 *     arm refuses that until the carry nets out, which only a settle does, and
 *     nobody settles a draining vault — so the vault would sit «pasando» the
 *     whole wait, and the way out the owner would reach for (a carry store
 *     change) is a redeploy that forgets the loss;
 *   * for a vault that may carry losses (PROFIT, or a mode the CLI did not
 *     say), every profit receipt not marked gone runs SIP_SOLANA_CARRY_STORE=on
 *     (runbook 10.8 step 3): with the store off, a loss a worker carries for it
 *     in the queue is one `volver` could never hand back (returnProblems).
 */
export function moveProblems(db: FleetDb, vault: string, rehearsal: boolean, autoArmOn = false): string[] {
  const problems: string[] = [];
  const row = rowProblem(db, vault);
  if (row !== null) problems.push(row);
  for (const other of db.vaults) {
    if (other.vault !== vault && other.system === "draining") {
      problems.push(
        autoArmOn && autoArmable(other)
          ? `el vault ${short(other.vault)} está a medio pasar, seguramente uno nuevo que el scheduler pasa solo: espera unos minutos y vuelve a probar`
          : `el vault ${short(other.vault)} está a medio pasar: termínalo primero («traspasar ${other.vault.slice(0, 8)}») o devuélvelo («volver ${other.vault.slice(0, 8)}»)`,
      );
    }
  }
  problems.push(...rolesReadingProblems(db, KEEPER_ROLES, FRESH_READ_MS, rehearsal, "es su propio recibo el que suelta el vault"));
  for (const entry of db.processes) {
    if (entry.goneAt === null && entry.ageMs > FRESH_READ_MS && !Object.hasOwn(entry.notLegacy, vault)) {
      problems.push(
        `${keeperWords(entry.role)} con id ${entry.processId} no lee desde ${agoWords(entry.ageMs)} y no ha soltado este vault: el traspaso esperaría por él. Si su despliegue (${entry.deployment ?? "?"}) ya no existe en Railway: «marcar-ido ${entry.processId}»; si existe, espera a que vuelva a leer`,
      );
    }
  }
  for (const entry of db.processes) {
    if (entry.goneAt === null && entry.carryVaults.includes(vault)) {
      problems.push(
        `${keeperWords(entry.role)} (id ${entry.processId}) guarda solo en su memoria una pérdida de este vault: el sistema nuevo cobraría de más su siguiente ganancia. ` +
          "Déjalo con los keepers de siempre: la pérdida se compensa con su siguiente ganancia, y entonces se puede traspasar. No cambies " +
          "SIP_SOLANA_CARRY_STORE para esto: un redespliegue olvida esa pérdida (10.8 paso 3: a on, cuando su /status diga pendingCarries vacío)",
      );
    }
  }
  if (mayCarryLosses(db, vault)) problems.push(...carryStoreProblems(db, "con este vault en el sistema nuevo, «volver» no podría devolverlo si un trabajador guarda una pérdida suya"));
  return problems;
}

/** Whether the vault may carry losses: a mode that does (PROFIT, role-registry), or one nobody said or nobody knows (an older CLI, a row with no mode yet). */
function mayCarryLosses(db: FleetDb, vault: string): boolean {
  const mode = db.vaults.find((entry) => entry.vault === vault)?.skimMode ?? null;
  return mode === null || keeperModeFor(mode)?.carriesLosses !== false;
}

/** A receipt of a role whose keeper keeps loss carries (roleCarriesLosses: the profit keeper), not marked gone, not running the store `on`. */
const carryStoreNotOn = (entry: ProcessEntry): boolean =>
  entry.goneAt === null && isKeeperRole(entry.role) && roleCarriesLosses(entry.role) && entry.carryStore !== "on";

/**
 * Each profit receipt not marked gone that does not run SIP_SOLANA_CARRY_STORE=on,
 * as one problem: release refuses a vault whose links hold a loss a worker
 * carried while any of them is not `on` (handover.ts, #carryBlockers), and
 * nothing this tool reads says whether such a loss exists — so it asks for `on`
 * before the vault leaves the legacy keepers, and before it goes back.
 */
function carryStoreProblems(db: FleetDb, why: string): string[] {
  const problems: string[] = [];
  for (const entry of db.processes) {
    if (!carryStoreNotOn(entry)) continue;
    problems.push(
      `${keeperWords(entry.role)} (id ${entry.processId}) no guarda en la base las pérdidas (SIP_SOLANA_CARRY_STORE=${entry.carryStore ?? "off"}): ${why}. ` +
        "Ponle SIP_SOLANA_CARRY_STORE=on en sip-solana-keeper (10.8 paso 3, cuando su /status diga pendingCarries vacío)" +
        (receiptState(entry) === "viejo" ? `; si su despliegue (${entry.deployment ?? "?"}) ya no existe en Railway: «marcar-ido ${entry.processId}»` : ""),
    );
  }
  return problems;
}

/**
 * Why `volver <vault>` may not start, before the rollback takes it out of the
 * queue: a vault handed back to keepers that are not reading would be served by
 * nobody; and for a vault that may carry losses, a profit receipt not running
 * the carry store `on` is one release refuses on whenever a worker carried a
 * loss for it — after the rollback, so the vault would wait «pasando», served by
 * nobody, until the variable changed. With every profit receipt `on` and one of
 * them reading (the roles' check), release's carry rule holds.
 *
 * READING MEANS WITHIN FRESH_READ_MS, as for `traspasar`, not the 15 minutes a
 * receipt counts as «vivo»: nothing marks a receipt when its keeper stops, so a
 * keeper stopped five minutes ago still had one, and a vault handed back to it
 * was told «lo atienden desde su próxima vuelta» with nobody serving it — and
 * legacy-orphaned paging only half an hour later. The keepers' own pages close
 * the rest of the window (keepersUpProblems).
 */
export function returnProblems(db: FleetDb, vault: string, rehearsal: boolean): string[] {
  const problems: string[] = [];
  const row = rowProblem(db, vault);
  if (row !== null) problems.push(row);
  problems.push(...rolesReadingProblems(db, KEEPER_ROLES, FRESH_READ_MS, rehearsal, "devuelto, nadie lo serviría; enciéndelo primero"));
  if (mayCarryLosses(db, vault)) problems.push(...carryStoreProblems(db, "devuelto con una pérdida que guardó el sistema nuevo, cobraría de más; «volver» se quedaría esperando con el vault sin servir"));
  return problems;
}

/** Why `nuevos-a-los-de-siempre` may not flip the flag: a new vault would go to keepers that are not reading (within FRESH_READ_MS, as returnProblems). */
export function legacyNewVaultsProblems(db: FleetDb, rehearsal: boolean): string[] {
  return rolesReadingProblems(db, KEEPER_ROLES, FRESH_READ_MS, rehearsal, "un vault nuevo se quedaría sin nadie; enciéndelo primero");
}

/**
 * Why the legacy keepers' own pages say a vault handed to them now would not be
 * served (empty: it would) — for `volver` and `nuevos-a-los-de-siempre`, beside
 * the receipts. A receipt is the database's word and outlives its keeper by up
 * to FRESH_READ_MS; the page is the keeper's own, and a page that does not
 * answer is a keeper that is not running. Outside a rehearsal only: there the
 * dry keepers' pages are stand-ins, or production's, and the receipts decide.
 */
export function keepersUpProblems(keepers: Readonly<Record<KeeperRole, PageRead<KeeperPageView>>>, rehearsal: boolean): string[] {
  if (rehearsal) return [];
  const problems: string[] = [];
  for (const role of KEEPER_ROLES) {
    const read = keepers[role];
    if (!read.answered) {
      problems.push(`${keeperWords(role)}: su página no contesta (${read.why}) — ¿parado en Railway? Enciéndelo primero (10.8 paso 9)`);
      continue;
    }
    const page = read.page;
    if (page.mode !== "live" || page.armed !== true) {
      const state = page.mode === "live" ? "en vivo, sin armar" : page.mode === null ? "no dice su modo" : "en seco";
      problems.push(`${keeperWords(role)}: su página dice que no está actuando (${state}); devuelto, nadie lo serviría: enciéndelo en vivo primero (10.8 paso 9)`);
    } else if (page.dispatch === null) {
      problems.push(`${keeperWords(role)}: su página dice que no tiene SIP_SOLANA_DISPATCH; ponle SIP_SOLANA_DISPATCH=on primero (10.8 paso 9)`);
    }
  }
  return problems;
}

/** What happened after one call in a wait: moved, still waiting (and why), or a stop the owner must hear. */
export type Progress = { readonly kind: "done" } | { readonly kind: "wait"; readonly note: string } | { readonly kind: "stop"; readonly lines: readonly string[] };

interface StepView {
  readonly system: string | null;
  readonly blockers: readonly string[];
}

function readStep(result: unknown): StepView | null {
  if (!isObject(result) || !Object.hasOwn(result, "system")) return null;
  const system = result["system"] === null ? null : str(result["system"]);
  const blockers = Array.isArray(result["blockers"]) ? (result["blockers"] as unknown[]).filter((entry): entry is string => typeof entry === "string") : [];
  return { system, blockers };
}

/**
 * One `arm <vault>` answered. DONE IS THE SYSTEM, NOT `ok`: a vault the
 * scheduler armed between two calls answers ok:false ("only a draining vault is
 * armed") from a vault that is already in the queue, and that is the finish.
 * Null: the CLI gave no result (the caller counts it, CLI_FAILURES_TOLERATED).
 */
export function armProgress(result: unknown): Progress | null {
  const step = readStep(result);
  if (step === null) return null;
  if (step.system === "queue") return { kind: "done" };
  if (step.system === "legacy") return { kind: "stop", lines: ["El vault ha vuelto a los keepers de siempre mientras esperaba: ¿alguien ha hecho «volver»? No sigo."] };
  if (step.system === null) return { kind: "stop", lines: ["La base ya no tiene este vault apuntado. No sigo: dímelo."] };
  return { kind: "wait", note: step.blockers.length === 0 ? "esperando bloques" : armNote(step.blockers) };
}

/** A receipt blocker of arm (`legacy process <id> (<role>, …, last read <n> <unit> ago[, acting]) has not yet read …`), read. */
function unreadReceipt(blocker: string): { readonly role: string; readonly ageMs: number; readonly acting: boolean } | null {
  const m = /^legacy process \S+ \((\w+), deployment .*?, last read (\d+) (s|min|h) ago(, acting)?\) has not yet read this vault as not its own/.exec(blocker);
  if (m === null) return null;
  const unit = m[3] === "s" ? 1_000 : m[3] === "min" ? 60_000 : 3_600_000;
  return { role: m[1]!, ageMs: Number(m[2]) * unit, acting: m[4] !== undefined };
}

/**
 * THE WAIT RIGHT AFTER THE DRAIN IS THE NORMAL ONE. No keeper has read the
 * vault as foreign yet, so arm names every receipt ("has not yet read") and
 * every role ("no ACTING … keeper has read … in the last 15 min"), and in the
 * owner's words that read as a fault — «¿está encendido en Railway?», a
 * «marcar-ido» for a live keeper — with an age that changed every poll, a new
 * line each time. A receipt read within FRESH_READ_MS clears on its next sweep:
 * it becomes one line with no age, and so does the role it will satisfy (an
 * acting one, or any one in a rehearsal's dry variant). A receipt older than
 * that, or a role with no such receipt, keeps its own words.
 */
function armNote(blockers: readonly string[]): string {
  const soon = { acting: new Set<string>(), any: new Set<string>() };
  const kept: string[] = [];
  for (const blocker of blockers) {
    const receipt = unreadReceipt(blocker);
    if (receipt !== null && receipt.ageMs <= FRESH_READ_MS) {
      soon.any.add(receipt.role);
      if (receipt.acting) soon.acting.add(receipt.role);
      continue;
    }
    const role = /^no (ACTING )?(\w+) keeper has read this vault as not its own/.exec(blocker);
    if (role !== null && (role[1] === undefined ? soon.any : soon.acting).has(role[2]!)) continue;
    kept.push(blocker);
  }
  const lines = kept.map(plainBlocker);
  if (soon.any.size > 0) lines.unshift("esperando a que los keepers de siempre lean el cambio (su próxima vuelta, ~1 min)");
  return lines.join(" · ");
}

/**
 * One `release <vault>` answered: legacy (or no row, which IS legacy) is done;
 * back in the queue is someone else arming it — the scheduler, only for a new
 * vault it enrolled and nobody had touched (a rollback stamps the row, so it
 * never re-arms one this tool rolled back), or another `traspasar` at once.
 */
export function releaseProgress(result: unknown): Progress | null {
  const step = readStep(result);
  if (step === null) return null;
  if (step.system === "legacy" || step.system === null) return { kind: "done" };
  if (step.system === "queue") {
    return {
      kind: "stop",
      lines: [
        "El vault ha vuelto al sistema nuevo mientras esperaba: lo ha pasado otro (el scheduler, si era un vault nuevo, u otro «traspasar» a la vez). No sigo.",
        "Está servido por el sistema nuevo. Si aun así quieres devolverlo, «volver» otra vez.",
      ],
    };
  }
  return { kind: "wait", note: step.blockers.length === 0 ? "esperando" : step.blockers.map(plainBlocker).join(" · ") };
}

/** The processes `marcar-ido` would mark: each typed id found (whole, or a unique start of 8+ characters) among the receipts not marked gone. */
export function goneTargets(db: FleetDb, ids: readonly string[]): { readonly targets: readonly ProcessEntry[]; readonly problems: readonly string[] } {
  const targets: ProcessEntry[] = [];
  const problems: string[] = [];
  const open = db.processes.filter((entry) => entry.goneAt === null);
  for (const id of ids) {
    const exact = open.find((entry) => entry.processId === id);
    const byStart = id.length >= 8 ? open.filter((entry) => entry.processId.startsWith(id)) : [];
    const found = exact ?? (byStart.length === 1 ? byStart[0] : undefined);
    if (found === undefined) {
      if (byStart.length > 1) problems.push(`hay ${byStart.length} keepers cuyo id empieza por «${id}»: cópialo entero`);
      else if (db.processes.some((entry) => entry.processId === id)) problems.push(`«${id}» ya está marcado como ido`);
      else problems.push(`no encuentro ningún keeper con id «${id}» entre los que no están marcados`);
      continue;
    }
    if (found.ageMs < FRESH_READ_MS) {
      problems.push(`${keeperWords(found.role)} con id ${found.processId} leyó ${agoWords(found.ageMs)}: está vivo, no lo marco. Si Railway dice que ya no existe, espera unos minutos y vuelve a probar`);
      continue;
    }
    if (!targets.includes(found)) targets.push(found);
  }
  return { targets, problems };
}

// ── the public pages ─────────────────────────────────────────────────────────

/** A GET of a public page: its JSON, or why there was none. */
export type PageRead<T> = { readonly answered: true; readonly page: T } | { readonly answered: false; readonly why: string };

export interface AutoArmView {
  readonly enabled: boolean | null;
  /** The legacy roles whose receipts the scheduler waits for before it arms; null when not reported. */
  readonly legacyRoles: readonly string[] | null;
  readonly pending: number | null;
  readonly pendingVaults: readonly string[];
  readonly lastArmedAt: string | null;
  readonly lastError: string | null;
  readonly lastResults: readonly { readonly vault: string; readonly system: string | null; readonly blockers: readonly string[] }[];
}

export interface SchedulerPageView {
  readonly healthOk: boolean | null;
  readonly healthDetail: string | null;
  /** This replica: holding the lock ("acting") or standing by. */
  readonly replica: string | null;
  /** Whether the page has read the fleet from Postgres at least once. */
  readonly fleetRead: boolean;
  readonly readOk: boolean | null;
  readonly readError: string | null;
  /** How long ago the LOCK HOLDER ticked, by the database's clock. */
  readonly tickAgeMs: number | null;
  readonly workersAlive: number;
  readonly slots: number;
  readonly busy: number;
  readonly jobsLast10Min: number | null;
  readonly due: number | null;
  readonly oldestDueMs: number | null;
  readonly parked: number | null;
  readonly expiredLeases: number | null;
  readonly firing: readonly string[];
  /** scheduler.autoArm; null when this scheduler's version does not report it (it does not arm by itself). */
  readonly autoArm: AutoArmView | null;
}

/** A worker row counts as alive: not stopped, not reaped as dead, heartbeat within two minutes (fleet-status.ts WORKER_DEAD_AFTER_MS). */
const WORKER_ALIVE_MS = 2 * 60_000;

function readAutoArm(raw: unknown): AutoArmView | null {
  if (!isObject(raw)) return null;
  const pendingRaw = raw["pending"];
  const pendingVaults = Array.isArray(pendingRaw)
    ? (pendingRaw as unknown[]).flatMap((entry) => (typeof entry === "string" ? [entry] : isObject(entry) && typeof entry["vault"] === "string" ? [entry["vault"]] : []))
    : [];
  // EITHER SHAPE OF A RESULT: a Step's own (`system`, `blockers`), or the scheduler's summary of one
  // (src/auto-arm.ts AutoArmResult: `moved`, and `blocker`, the first thing in the way).
  const lastResults = Array.isArray(raw["lastResults"])
    ? (raw["lastResults"] as unknown[]).flatMap((entry) => {
        if (!isObject(entry) || typeof entry["vault"] !== "string") return [];
        const step = readStep(entry);
        const blockers = step !== null && step.blockers.length > 0 ? step.blockers : typeof entry["blocker"] === "string" ? [entry["blocker"]] : [];
        const system = step?.system ?? (entry["moved"] === true ? "queue" : null);
        return [{ vault: entry["vault"], system, blockers }];
      })
    : [];
  return {
    enabled: bool(raw["enabled"]),
    legacyRoles: Array.isArray(raw["legacyRoles"]) ? (raw["legacyRoles"] as unknown[]).filter((entry): entry is string => typeof entry === "string") : null,
    pending: Array.isArray(pendingRaw) ? pendingRaw.length : num(pendingRaw),
    pendingVaults,
    lastArmedAt: str(raw["lastArmedAt"]),
    lastError: str(raw["lastError"]),
    lastResults,
  };
}

/** The scheduler's /status (src/fleet-status.ts's page plus bin/scheduler.mts's `scheduler`), read for what the owner needs. */
export function readSchedulerPage(raw: unknown): SchedulerPageView {
  const page = isObject(raw) ? raw : {};
  const health = isObject(page["health"]) ? page["health"] : {};
  const read = isObject(page["read"]) ? page["read"] : {};
  const fleet = isObject(page["fleet"]) ? page["fleet"] : null;
  const scheduler = isObject(page["scheduler"]) ? page["scheduler"] : {};
  const fleetScheduler = fleet !== null && isObject(fleet["scheduler"]) ? fleet["scheduler"] : {};
  const queue = fleet !== null && isObject(fleet["queue"]) ? fleet["queue"] : {};
  const leases = isObject(queue["leases"]) ? queue["leases"] : {};
  const parked = isObject(queue["parked"]) ? queue["parked"] : {};
  const workers = fleet !== null && Array.isArray(fleet["workers"]) ? (fleet["workers"] as unknown[]).filter(isObject) : [];
  const alive = workers.filter(
    (worker) => worker["kind"] === "worker" && worker["stoppedAt"] === null && worker["dead"] !== true && (num(worker["heartbeatAgeMs"]) ?? Infinity) <= WORKER_ALIVE_MS,
  );
  const jobs = alive.map((worker) => (isObject(worker["stats"]) ? num(worker["stats"]["jobsLast10Min"]) : null));
  const alerts = isObject(page["alerts"]) ? page["alerts"] : {};
  return {
    healthOk: bool(health["ok"]),
    healthDetail: str(health["detail"]),
    replica: str(scheduler["role"]),
    fleetRead: fleet !== null,
    readOk: bool(read["ok"]),
    readError: str(read["lastError"]),
    tickAgeMs: num(fleetScheduler["tickAgeMs"]),
    workersAlive: alive.length,
    slots: alive.reduce((sum, worker) => sum + (num(worker["slots"]) ?? 0), 0),
    busy: alive.reduce((sum, worker) => sum + (num(worker["busy"]) ?? 0), 0),
    jobsLast10Min: jobs.some((count) => count !== null) ? jobs.reduce<number>((sum, count) => sum + (count ?? 0), 0) : null,
    due: num(queue["due"]),
    oldestDueMs: num(queue["oldestDueMs"]),
    parked: num(parked["count"]),
    expiredLeases: num(leases["expired"]),
    firing: Array.isArray(alerts["firing"]) ? (alerts["firing"] as unknown[]).filter((entry): entry is string => typeof entry === "string") : [],
    autoArm: Object.hasOwn(scheduler, "autoArm") ? readAutoArm(scheduler["autoArm"]) : null,
  };
}

export interface KeeperPageView {
  readonly mode: string | null;
  readonly armed: boolean | null;
  readonly lastSweepAgeMs: number | null;
  readonly dispatch: string | null;
}

/** A legacy keeper's /status (src/status.ts): whether it is acting and when it last swept. */
export function readKeeperPage(raw: unknown, now: number): KeeperPageView {
  const page = isObject(raw) ? raw : {};
  const last = str(page["lastSweepAt"]);
  const at = last === null ? NaN : Date.parse(last);
  const dispatch = isObject(page["dispatch"]) ? str(page["dispatch"]["mode"]) : null;
  return { mode: str(page["mode"]), armed: bool(page["armed"]), lastSweepAgeMs: Number.isFinite(at) ? Math.max(0, now - at) : null, dispatch };
}

const REPLICA_WORDS: Readonly<Record<string, string>> = { acting: "la que manda", standby: "la de reserva" };

/** Whether the scheduler is turning: its page answered, its lock holder ticked within SCHEDULER_STALE_MS. */
function schedulerTicking(page: SchedulerPageView): boolean {
  return page.tickAgeMs !== null && page.tickAgeMs <= SCHEDULER_STALE_MS;
}

/**
 * Why `nuevos-a-la-cola` may not flip the flag (empty: it may). UNDER 'queue' A
 * NEW VAULT ENTERS AS 'draining' (scheduler-pg.ts ENSURE_VAULTS_SQL), the legacy
 * keepers leave it alone and no worker claims it: only an arm moves it. So the
 * flag flips only while every answer of the scheduler's page — two replicas, a
 * GET reaches either — says it arms by itself, its lock holder is ticking, every
 * legacy role it waits on is reading, and no stale receipt stands in the way of
 * every arm.
 */
export function queueNewVaultsProblems(db: FleetDb, pages: readonly PageRead<SchedulerPageView>[], rehearsal: boolean): string[] {
  const answered = pages.flatMap((read) => (read.answered ? [read.page] : []));
  if (answered.length === 0) return ["la página del scheduler no contesta: no puedo comprobar que se arme solo"];
  const problems = new Set<string>();
  const roles = new Set<string>();
  for (const page of answered) {
    if (page.autoArm === null) {
      problems.add("esta versión del scheduler no se arma sola: un vault nuevo se quedaría «pasando» sin que nadie lo cobre ni compre");
      continue;
    }
    if (page.autoArm.enabled !== true) problems.add("el scheduler no se arma solo (lo tiene apagado): un vault nuevo se quedaría «pasando» sin que nadie lo cobre ni compre");
    for (const role of page.autoArm.legacyRoles ?? []) roles.add(role);
    if (!schedulerTicking(page)) problems.add("el scheduler no da vueltas: nadie apuntaría los vaults nuevos");
  }
  for (const problem of rolesReadingProblems(db, [...roles].sort(), LEGACY_READ_FRESH_MS, rehearsal, "el scheduler espera su recibo para armar un vault nuevo")) problems.add(problem);
  const stale = staleReceipts(db);
  if (stale.length > 0) {
    problems.add(
      `hay ${stale.length} recibo${stale.length === 1 ? "" : "s"} viejo${stale.length === 1 ? "" : "s"} sin marcar como ido (${stale.map((entry) => entry.processId).join(", ")}): el scheduler esperaría por ellos. Si esos despliegues ya no existen en Railway, «marcar-idos-viejos» primero`,
    );
  }
  return [...problems];
}

// ── the screen ───────────────────────────────────────────────────────────────

export interface FlotaView {
  readonly db: FleetDb;
  readonly scheduler: PageRead<SchedulerPageView>;
  readonly keepers: Readonly<Record<KeeperRole, PageRead<KeeperPageView>>>;
  readonly now: number;
  /** A rehearsal's dry keepers count as reading. */
  readonly rehearsal: boolean;
}

/** Whether the scheduler that answered says it arms by itself. */
const autoArmOnPage = (scheduler: PageRead<SchedulerPageView>): boolean => scheduler.answered && scheduler.page.autoArm?.enabled === true;

/**
 * A draining vault's line: the scheduler moves it only when it arms by itself
 * AND the vault is one of its own untouched enrolments (autoArmable) — then its
 * last word on it, when it reports one; any other draining vault is the owner's
 * to finish, and nobody serves it until he does.
 */
function drainingNote(vault: VaultEntry, scheduler: PageRead<SchedulerPageView>): string {
  if (autoArmOnPage(scheduler) && autoArmable(vault)) {
    const said = scheduler.answered ? scheduler.page.autoArm?.lastResults.find((entry) => entry.vault === vault.vault) : undefined;
    if (said !== undefined && said.blockers.length > 0) return `el scheduler lo pasa solo: ${plainBlocker(said.blockers[0]!)}`;
    return "el scheduler lo pasa solo (unos minutos)";
  }
  return `nadie lo cobra ni compra hasta que termine: «traspasar ${vault.vault.slice(0, 8)}» para acabar, o «volver ${vault.vault.slice(0, 8)}»`;
}

/** The vaults, two lines each at most: who serves it and its mode, then what its last job did and when. */
export function vaultLines(view: FlotaView): string[] {
  const { db, now } = view;
  const lines: string[] = [`Vaults (${db.vaults.length}):`];
  if (db.vaults.length === 0) lines.push("  ninguno en la lista");
  const order: Record<string, number> = { draining: 0, queue: 1, legacy: 2 };
  const sorted = [...db.vaults].sort((a, b) => (order[a.system] ?? 3) - (order[b.system] ?? 3) || a.vault.localeCompare(b.vault));
  for (const vault of sorted) {
    const server = whoServes(vault);
    const mode = modeWords(vault.skimMode);
    const mine = vault.vault === OWNER_VAULT ? "  ← el tuyo" : "";
    lines.push(`  ${short(vault.vault)}  ${server === null ? vault.system : SERVER_WORDS[server]}${mode === null ? "" : ` · ${mode}`}${mine}`);
    const pad = "             ";
    if (server === "draining") {
      lines.push(`${pad}${drainingNote(vault, view.scheduler)}`);
      continue;
    }
    if (server === "parked") {
      lines.push(`${pad}${parkedWords(vault.parkedReason!)} · «desaparcar ${vault.vault.slice(0, 8)}» para que lo vuelva a intentar`);
      continue;
    }
    if (server !== "queue") continue;
    const busy = vault.holder !== null ? " · trabajando ahora" : "";
    if (!vault.extended) {
      if (busy !== "") lines.push(`${pad}trabajando ahora`);
      continue;
    }
    const said = outcomeWords(vault.lastOutcome);
    const done = vault.lastDoneAt === null ? NaN : Date.parse(vault.lastDoneAt);
    const when = Number.isFinite(done) ? `${agoWords(now - done)} · ` : "";
    lines.push(`${pad}${said.attention ? "OJO: " : ""}${when}${said.text}${busy}`);
    if (said.attention && vault.lastDetail !== null && vault.lastDetail !== "") lines.push(`${pad}detalle: ${vault.lastDetail.slice(0, 160)}`);
    for (const streak of streakWords(vault.streaks)) lines.push(`${pad}OJO: ${streak}`);
    if (vault.attempts !== null && vault.attempts >= 2) lines.push(`${pad}OJO: ${vault.attempts} intentos seguidos sin terminar`);
  }
  if (!db.allListed) lines.push("  (esta versión de dispatch-handover solo me enseña los que no son de los keepers de siempre)");
  return lines;
}

function newVaultsLine(db: FleetDb, scheduler: PageRead<SchedulerPageView>): string[] {
  if (db.newVaultSystem === "legacy") return ["Vaults nuevos: van a los keepers de siempre."];
  if (db.newVaultSystem === "queue") {
    // UNKNOWN IS NOT "NO": a page that did not answer says nothing about the auto-arm.
    if (!scheduler.answered) return ["Vaults nuevos: van al sistema nuevo; no sé si el scheduler se arma solo (su página no contesta)."];
    const autoArm = scheduler.page.autoArm;
    if (autoArm?.enabled === true) return ["Vaults nuevos: van al sistema nuevo (entran «pasando» y el scheduler los pasa solo)."];
    return [
      "Vaults nuevos: van al sistema nuevo, PERO el scheduler no se arma solo: un vault nuevo se queda «pasando» sin que nadie lo sirva.",
      "  Haz «nuevos-a-los-de-siempre», o «traspasar» cada vault nuevo a mano.",
    ];
  }
  return ["Vaults nuevos: la base no lo dice (¿falta la fila de fleet?)."];
}

function receiptLines(db: FleetDb): string[] {
  const lines = ["Keepers de siempre (sus recibos en la base):"];
  const open = db.processes.filter((entry) => entry.goneAt === null);
  const gone = db.processes.length - open.length;
  if (open.length === 0) lines.push("  ninguno sin marcar como ido");
  for (const entry of open) {
    const state = receiptState(entry);
    const acting = entry.live ? "actuando" : "en seco";
    const carry = entry.carryStore === null ? "" : ` · pérdidas en la base: ${entry.carryStore}`;
    lines.push(`  keeper de ${roleWords(entry.role)}: ${state} · leyó ${agoWords(entry.ageMs)} · ${acting}${carry} · id ${entry.processId}`);
    if (state === "viejo") lines.push(`    si su despliegue (${entry.deployment ?? "?"}) ya no existe en Railway: «marcar-ido ${entry.processId}»`);
  }
  if (gone > 0) lines.push(`  idos (marcados): ${gone}`);
  return lines;
}

function keeperPageLines(keepers: FlotaView["keepers"]): string[] {
  const lines = ["Sus páginas:"];
  for (const role of KEEPER_ROLES) {
    const read = keepers[role];
    if (!read.answered) {
      lines.push(`  ${keeperWords(role)}: no contesta (${read.why}) — ¿parado en Railway?`);
      continue;
    }
    const page = read.page;
    const acting = page.mode === "live" ? (page.armed === true ? "actuando" : "en vivo, sin armar") : page.mode === null ? "?" : "en seco";
    const sweep = page.lastSweepAgeMs === null ? "sin vueltas todavía" : `última vuelta ${agoWords(page.lastSweepAgeMs)}`;
    lines.push(`  ${keeperWords(role)}: contesta · ${acting} · ${sweep}${page.dispatch === null ? " · SIN SIP_SOLANA_DISPATCH" : ""}`);
  }
  return lines;
}

/** The scheduler's and the workers' health, and the problems worth a line of their own. */
export function schedulerLines(read: PageRead<SchedulerPageView>, now: number): { readonly lines: readonly string[]; readonly problems: readonly string[] } {
  if (!read.answered) {
    return { lines: [`Scheduler: su página no contesta (${read.why}).`], problems: ["la página del scheduler no contesta: mira en Railway que sip-solana-scheduler esté encendido"] };
  }
  const page = read.page;
  const lines: string[] = [];
  const problems: string[] = [];
  const replica = page.replica === null ? "" : ` (contestó ${REPLICA_WORDS[page.replica] ?? page.replica})`;
  const tick = page.tickAgeMs === null ? "todavía sin ninguna vuelta" : `última vuelta ${agoWords(page.tickAgeMs)}`;
  lines.push(`Scheduler: ${page.healthOk === false ? "NO está sano" : "sano"} · ${tick}${replica}`);
  if (page.healthOk === false) problems.push(`el scheduler no está sano${page.healthDetail === null ? "" : ` (${page.healthDetail})`}`);
  if (page.tickAgeMs !== null && page.tickAgeMs > SCHEDULER_STALE_MS) problems.push(`el scheduler no da vueltas desde ${agoWords(page.tickAgeMs)}: nadie marca los vaults del sistema nuevo para trabajar`);
  if (page.readOk === false) problems.push(`la página del scheduler no puede leer la base${page.readError === null ? "" : ` (${page.readError.slice(0, 120)})`}`);
  const autoArm = page.autoArm;
  if (autoArm === null) lines.push("  se arma solo: no (esta versión no lo hace)");
  else if (autoArm.enabled === true) {
    const pending = autoArm.pending === null || autoArm.pending === 0 ? "" : ` · pendientes: ${autoArm.pending}`;
    const at = autoArm.lastArmedAt === null ? NaN : Date.parse(autoArm.lastArmedAt);
    const armed = Number.isFinite(at) ? ` · armó por última vez ${agoWords(now - at)}` : "";
    const waits = autoArm.legacyRoles === null ? "" : ` · espera recibos de: ${autoArm.legacyRoles.length === 0 ? "nadie" : autoArm.legacyRoles.map(roleWords).join(", ")}`;
    lines.push(`  se arma solo: sí${pending}${armed}${waits}`);
    if (autoArm.lastError !== null) lines.push(`  OJO: su último intento de armar falló: ${autoArm.lastError.slice(0, 160)}`);
  } else lines.push("  se arma solo: no (apagado)");
  if (!page.fleetRead) {
    lines.push("Trabajadores: la página aún no ha leído la base.");
    return { lines, problems };
  }
  const jobs = page.jobsLast10Min === null ? "" : ` · ${page.jobsLast10Min} trabajos en 10 min`;
  lines.push(`Trabajadores: ${page.workersAlive} vivo${page.workersAlive === 1 ? "" : "s"} · ${page.busy} de ${page.slots} huecos ocupados${jobs}`);
  if (page.workersAlive === 0) problems.push("no hay ningún trabajador vivo: los vaults del sistema nuevo no se cobran ni compran");
  const queue = [
    page.due === null ? null : page.due === 0 ? "nada esperando" : `${page.due} esperando${page.oldestDueMs === null ? "" : ` (el más antiguo ${agoWords(page.oldestDueMs).replace(/^hace /, "desde hace ")})`}`,
    page.parked === null ? null : `${page.parked} aparcado${page.parked === 1 ? "" : "s"}`,
    page.expiredLeases === null || page.expiredLeases === 0 ? null : `${page.expiredLeases} trabajo${page.expiredLeases === 1 ? "" : "s"} cortado${page.expiredLeases === 1 ? "" : "s"}`,
  ].filter((part): part is string => part !== null);
  if (queue.length > 0) lines.push(`Cola: ${queue.join(" · ")}`);
  if (page.oldestDueMs !== null && page.oldestDueMs > QUEUE_LAG_MS) problems.push(`hay vaults esperando a un trabajador ${agoWords(page.oldestDueMs).replace(/^hace /, "desde hace ")}`);
  if (page.firing.length > 0) problems.push(`avisos encendidos: ${page.firing.join(", ")}`);
  return { lines, problems };
}

/**
 * What to do next, in the order it matters: a vault nobody serves first
 * (draining, parked), then what stands in the way of the next move, then the
 * next move of the cutover itself.
 */
export function nextSteps(view: FlotaView): string[] {
  const { db, scheduler } = view;
  const steps: string[] = [];
  const page = scheduler.answered ? scheduler.page : null;
  const autoArmOn = page?.autoArm?.enabled === true;
  const draining = db.vaults.filter((vault) => vault.system === "draining");
  const parked = db.vaults.filter((vault) => vault.system === "queue" && vault.parkedReason !== null);
  const legacy = db.vaults.filter((vault) => vault.system === "legacy");
  const stale = staleReceipts(db);
  const legacyReading = KEEPER_ROLES.every((role) => reading(db, role, LEGACY_READ_FRESH_MS, view.rehearsal).length > 0);
  for (const vault of parked) steps.push(`${short(vault.vault)} está aparcado: «desaparcar ${vault.vault.slice(0, 8)}». Si se vuelve a aparcar, dímelo.`);
  // A DRAINING VAULT THE SCHEDULER WILL NOT MOVE (it does not arm by itself, or the vault is not its own untouched enrolment) is served by nobody.
  for (const vault of draining) {
    if (!(autoArmOn && autoArmable(vault))) steps.push(`${short(vault.vault)} está a medio pasar y nadie lo sirve: «traspasar ${vault.vault.slice(0, 8)}» o «volver ${vault.vault.slice(0, 8)}».`);
  }
  if (stale.length > 0) steps.push("Hay keepers que llevan más de 15 min sin leer: comprueba en Railway que esos despliegues ya no existen y haz «marcar-idos-viejos».");
  if (db.newVaultSystem === "queue" && page !== null && !autoArmOn) steps.push("Los vaults nuevos van a la cola pero el scheduler no se arma solo: «nuevos-a-los-de-siempre».");
  if (!db.allListed) {
    steps.push("Para ver todos los vaults hace falta la versión nueva de dispatch-handover (status --all).");
    return steps;
  }
  if (legacy.length > 0) {
    // THE CARRY STORE FIRST (10.8 step 3): «traspasar» refuses a PROFIT vault while the profit keeper does not run it `on`.
    const storeOff = db.processes.some(carryStoreNotOn);
    steps.push(
      !legacyReading
        ? `Quedan ${legacy.length} con los keepers de siempre, y esos keepers no están leyendo: enciéndelos en Railway antes de traspasar.`
        : storeOff && legacy.some((entry) => mayCarryLosses(db, entry.vault))
          ? `Quedan ${legacy.length} con los keepers de siempre. Antes de traspasar: SIP_SOLANA_CARRY_STORE=on en sip-solana-keeper (10.8 paso 3, cuando su /status diga pendingCarries vacío); luego «traspasar-todos».`
          : `Quedan ${legacy.length} con los keepers de siempre: «traspasar-todos» (uno detrás de otro) o «traspasar <vault>».`,
    );
    return steps;
  }
  if (draining.length > 0 || parked.length > 0) return steps;
  if (db.newVaultSystem !== "queue") {
    steps.push(
      autoArmOn
        ? "Todos los vaults están en el sistema nuevo. Siguiente: «nuevos-a-la-cola»."
        : "Todos los vaults están en el sistema nuevo. Para mandar también los nuevos hace falta que el scheduler se arme solo (la versión nueva, encendida); luego «nuevos-a-la-cola».",
    );
    return steps;
  }
  // AN UNREAD PAGE IS NOT "WAITS ON NOBODY": stopping the keepers while the scheduler still waits on their receipts leaves every new vault «pasando».
  const waitsOn = page === null ? undefined : page.autoArm === null ? null : (page.autoArm.legacyRoles ?? undefined);
  if (legacyReading) {
    steps.push(
      waitsOn === undefined
        ? "Todo va al sistema nuevo. No sé si el scheduler se arma solo ni qué recibos espera: su página no contesta; vuelve a probar «flota» antes de parar nada."
        : waitsOn !== null && waitsOn.length > 0
          ? "Todo va al sistema nuevo. Antes de parar los keepers de siempre, el scheduler tiene que dejar de esperar sus recibos (ahora los espera): dímelo."
          : "Todo va al sistema nuevo. Cuando quieras, para los keepers de siempre en Railway (no los borres) y luego «marcar-idos-viejos».",
    );
  } else steps.push("Todo va al sistema nuevo.");
  return steps;
}

/** The whole `flota` screen. */
export function flotaLines(view: FlotaView): string[] {
  const health = schedulerLines(view.scheduler, view.now);
  const lines = [
    ...vaultLines(view),
    "",
    ...newVaultsLine(view.db, view.scheduler),
    ...(view.db.webhookOwner === null ? [] : [`Timbre de Helius: lo lleva ${view.db.webhookOwner === "scheduler" ? "el scheduler" : view.db.webhookOwner === "legacy" ? "el keeper de beneficios" : view.db.webhookOwner}.`]),
    "",
    ...receiptLines(view.db),
    ...keeperPageLines(view.keepers),
    "",
    ...health.lines,
  ];
  if (health.problems.length > 0) {
    lines.push("", "OJO:");
    for (const problem of health.problems) lines.push(`  - ${problem}.`);
  }
  const steps = nextSteps(view);
  lines.push("", "Siguiente:");
  if (steps.length === 0) lines.push("  - nada: todo en orden.");
  for (const step of steps) lines.push(`  - ${step}`);
  return lines;
}
