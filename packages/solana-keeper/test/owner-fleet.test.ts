// THE OWNER'S FLEET TOOL'S DECISIONS AND SENTENCES (src/owner-fleet.ts), without
// a database, a chain or a page: what each word refuses and why, how the CLI's
// replies are read (an older dispatch-handover's included), and that every
// blocker the real Handover can write reaches the owner in Spanish.
//
// The rehearsal against a real Postgres, with the tool itself as a child
// process, is test/owner-fleet-pg.test.ts.

import { describe, expect, it } from "vitest";
import type { TurnInvest, TurnSettle } from "../src/doorbell.js";
import { Handover, LEGACY_READ_FRESH_MS, type HandoverPool } from "../src/handover.js";
import {
  FRESH_READ_MS,
  OWNER_VAULT,
  PROD_PAGES,
  PUBLIC_RPC,
  POLL_MS,
  SERVER_WORDS,
  agoWords,
  armProgress,
  checkDatabaseUrl,
  cleanLine,
  flotaLines,
  goneTargets,
  isOlderCliRefusal,
  legacyNewVaultsProblems,
  modeWords,
  moveProblems,
  nextSteps,
  outcomeWords,
  parkedWords,
  parseFlotaArgs,
  plainBlocker,
  queueNewVaultsProblems,
  readFleetDb,
  readKeeperPage,
  readOverrides,
  readSchedulerPage,
  receiptState,
  releaseProgress,
  resolveVault,
  returnProblems,
  rowProblem,
  schedulerLines,
  spanWords,
  staleReceipts,
  streakWords,
  vaultArg,
  whoServes,
  withVault,
  type FleetDb,
  type FlotaView,
  type KeeperPageView,
  type PageRead,
  type ProcessEntry,
  type SchedulerPageView,
  type VaultEntry,
} from "../src/owner-fleet.js";
import { PARK_AFTER_ATTEMPTS, PARK_SQL } from "../src/scheduler-pg.js";

const LEGACY_A = "D5J5o2gSMadeUpProfitVau1t1111111111111111111";
const LEGACY_B = "4J3En7ugMadeUpProfitVau1t1111111111111111111";
const DRAINING = "DrainVau1tMadeUp111111111111111111111111111";
const PARKED = "ParkedVau1tMadeUp11111111111111111111111111";

const NOW = Date.parse("2026-10-27T08:00:00Z");

const vault = (address: string, system: string, over: Partial<VaultEntry> = {}): VaultEntry => ({
  vault: address,
  system,
  systemAt: null,
  handoverHeight: null,
  holder: null,
  leaseUntil: null,
  skimMode: null,
  lane: null,
  fence: null,
  claimedAt: null,
  lastDoneAt: null,
  lastOutcome: null,
  lastDetail: null,
  parkedReason: null,
  extended: true,
  attempts: null,
  dueAt: null,
  streaks: null,
  ...over,
});

const receipt = (processId: string, role: string, over: Partial<ProcessEntry> = {}): ProcessEntry => ({
  processId,
  role,
  dispatch: "on",
  deployment: `dep-${processId}`,
  host: "box",
  live: true,
  ageMs: 20_000,
  goneAt: null,
  notLegacy: {},
  carryStore: "dual",
  ...over,
});

const fleet = (over: Partial<FleetDb> = {}): FleetDb => ({
  newVaultSystem: "legacy",
  webhookOwner: "legacy",
  vaults: [vault(OWNER_VAULT, "queue", { skimMode: 1 }), vault(LEGACY_A, "legacy", { skimMode: 0 }), vault(LEGACY_B, "legacy", { skimMode: 0 })],
  processes: [receipt("p-profit", "profit"), receipt("p-volume", "volume")],
  allListed: true,
  ...over,
});

describe("the words", () => {
  it("parses every word, and refuses what is missing, extra or unknown without echoing it", () => {
    expect(parseFlotaArgs(["flota"])).toEqual({ command: { kind: "flota" } });
    expect(parseFlotaArgs(["traspasar-todos"])).toEqual({ command: { kind: "traspasar-todos" } });
    expect(parseFlotaArgs(["nuevos-a-la-cola"])).toEqual({ command: { kind: "nuevos-a-la-cola" } });
    expect(parseFlotaArgs(["nuevos-a-los-de-siempre"])).toEqual({ command: { kind: "nuevos-a-los-de-siempre" } });
    expect(parseFlotaArgs(["marcar-idos-viejos"])).toEqual({ command: { kind: "marcar-idos-viejos" } });
    expect(parseFlotaArgs(["traspasar", "D5J5o2gS…"])).toEqual({ command: { kind: "traspasar", vault: "D5J5o2gS" } });
    expect(parseFlotaArgs(["volver", LEGACY_A])).toEqual({ command: { kind: "volver", vault: LEGACY_A } });
    expect(parseFlotaArgs(["desaparcar", "Parked..."])).toEqual({ command: { kind: "desaparcar", vault: "Parked" } });
    expect(parseFlotaArgs(["marcar-ido", "5a3d0308-a4fa", "5a3d0308-a4fa", "ed2e0b7c"])).toEqual({ command: { kind: "marcar-ido", processIds: ["5a3d0308-a4fa", "ed2e0b7c"] } });

    expect(parseFlotaArgs([])).toEqual({ problem: "Falta la palabra." });
    expect(parseFlotaArgs(["estado"])).toEqual({ problem: "No conozco esa palabra." });
    expect(parseFlotaArgs(["flota", "extra"])).toHaveProperty("problem");
    expect(parseFlotaArgs(["traspasar"])).toHaveProperty("problem");
    expect(parseFlotaArgs(["traspasar", "a", "b"])).toHaveProperty("problem");
    expect(parseFlotaArgs(["marcar-ido"])).toHaveProperty("problem");
    // A PASTED SECRET IS NEVER ECHOED: not a vault, and the sentence does not repeat it.
    const pasted = "postgresql://postgres:hunter2hunter2@db.example.supabase.co:5432/postgres";
    for (const word of ["traspasar", "volver", "desaparcar", "marcar-ido"]) {
      const answer = parseFlotaArgs([word, pasted]);
      expect(answer).toHaveProperty("problem");
      expect(JSON.stringify(answer)).not.toContain("hunter2");
    }
  });

  it("takes a vault as its address or its first letters (4+ base58, a trailing ellipsis allowed)", () => {
    expect(vaultArg("D5J5")).toBe("D5J5");
    expect(vaultArg("D5J5o2gS...")).toBe("D5J5o2gS");
    expect(vaultArg("D5J")).toBeNull();
    expect(vaultArg("D5J5O0Il")).toBeNull(); // 0, O, I and l are not base58
    expect(vaultArg("x".repeat(45))).toBeNull();
  });
});

describe("the database url", () => {
  it("accepts a Supabase host on 5432, and its password in every form is cut", () => {
    const url = "postgresql://postgres.abc:p%40ss!word99@aws-0-eu-west-1.pooler.supabase.com:5432/postgres";
    const checked = checkDatabaseUrl(`  ${url}\n`, false);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.rehearsal).toBe(false);
    const line = `a ${url} b p@ss!word99 c p%40ss!word99 d p%40ss%21word99`;
    const cleaned = cleanLine(line, checked.url, checked.secrets);
    expect(cleaned).toBe("a <url> b <password> c <password> d <password>");
    expect(checkDatabaseUrl("postgres://u:pw12345@db.xyz.supabase.co/postgres", false).ok).toBe(true);
  });

  it("refuses another host (naming it, never the password), another port, another protocol and an unreadable value", () => {
    const railway = checkDatabaseUrl("postgresql://postgres:sekrit99@postgres.railway.internal:5432/railway", false);
    expect(railway.ok).toBe(false);
    if (!railway.ok) {
      expect(railway.lines.join("\n")).toContain("postgres.railway.internal");
      expect(railway.lines.join("\n")).toContain("Railway");
      expect(railway.lines.join("\n")).not.toContain("sekrit99");
    }
    expect(checkDatabaseUrl("postgresql://u:p@evilsupabase.com:5432/db", false).ok).toBe(false);
    expect(checkDatabaseUrl("postgresql://u:p@db.supabase.co.evil.net:5432/db", false).ok).toBe(false);
    const pooler = checkDatabaseUrl("postgresql://u:p@aws-0-eu-west-1.pooler.supabase.com:6543/postgres", false);
    expect(pooler.ok).toBe(false);
    if (!pooler.ok) expect(pooler.lines[0]).toContain("6543");
    expect(checkDatabaseUrl("https://db.supabase.co:5432/x", false).ok).toBe(false);
    expect(checkDatabaseUrl("not a url", false).ok).toBe(false);
    expect(checkDatabaseUrl(undefined, false).ok).toBe(false);
  });

  it("lets the loopback through only in a rehearsal, on any port", () => {
    const local = "postgres://postgres:pw@127.0.0.1:55444/postgres?sslmode=disable";
    expect(checkDatabaseUrl(local, false).ok).toBe(false);
    const rehearsal = checkDatabaseUrl(local, true);
    expect(rehearsal).toMatchObject({ ok: true, rehearsal: true });
    // localhost is not the loopback this flag names.
    expect(checkDatabaseUrl("postgres://postgres:pw@localhost:55444/postgres", true).ok).toBe(false);
    // The flag does not make a Supabase url a rehearsal.
    expect(checkDatabaseUrl("postgres://u:pw12@db.x.supabase.co:5432/p", true)).toMatchObject({ ok: true, rehearsal: false });
  });

  it("refuses the rehearsal's stand-ins outside a rehearsal, and takes them on the loopback inside one", () => {
    expect(readOverrides({}, false)).toEqual({ pages: PROD_PAGES, rpc: PUBLIC_RPC, pollMs: POLL_MS });
    expect(readOverrides({ SIP_FLOTA_TOOL_PAGES: "http://127.0.0.1:9" }, false)).toHaveProperty("problem");
    expect(readOverrides({ SIP_FLOTA_TOOL_RPC: "http://127.0.0.1:9" }, false)).toHaveProperty("problem");
    expect(readOverrides({ SIP_FLOTA_TOOL_POLL_MS: "100" }, false)).toHaveProperty("problem");
    expect(readOverrides({ SIP_FLOTA_TOOL_PAGES: "http://127.0.0.1:4100/", SIP_FLOTA_TOOL_RPC: "http://127.0.0.1:4101", SIP_FLOTA_TOOL_POLL_MS: "250" }, true)).toEqual({
      pages: { scheduler: "http://127.0.0.1:4100/scheduler/status", profit: "http://127.0.0.1:4100/keeper/status", volume: "http://127.0.0.1:4100/volume-keeper/status" },
      rpc: "http://127.0.0.1:4101",
      pollMs: 250,
    });
    expect(readOverrides({ SIP_FLOTA_TOOL_PAGES: "https://sip-solana-scheduler-production.up.railway.app" }, true)).toHaveProperty("problem");
    expect(readOverrides({ SIP_FLOTA_TOOL_RPC: "http://10.0.0.1:8899" }, true)).toHaveProperty("problem");
    expect(readOverrides({ SIP_FLOTA_TOOL_POLL_MS: "10" }, true)).toHaveProperty("problem");
    expect(readOverrides({ SIP_FLOTA_TOOL_POLL_MS: "fast" }, true)).toHaveProperty("problem");
    expect(readOverrides({}, true)).toEqual({ pages: PROD_PAGES, rpc: PUBLIC_RPC, pollMs: POLL_MS });
  });
});

describe("dispatch-handover status, read", () => {
  /** What today's CLI prints for `status` (Handover.status through the bigint-safe JSON). */
  const OLD = {
    newVaultSystem: "legacy",
    vaults: [{ vault: OWNER_VAULT, system: "queue", systemAt: "2026-10-27T05:00:00.000Z", handoverHeight: "380000000", holder: null, leaseUntil: null }],
    processes: [
      {
        processId: "5a3d0308",
        role: "profit",
        dispatch: "on",
        deployment: "dep-1",
        host: "h",
        live: true,
        reads: "93",
        readAt: "2026-10-27T07:10:01.192Z",
        ageMs: 4000,
        startedAt: "2026-10-27T05:37:59.009Z",
        goneAt: null,
        notLegacy: { [OWNER_VAULT]: "queue" },
        absentIs: "legacy",
        carryVaults: [],
        carryStore: "dual",
      },
    ],
  };

  it("reads today's reply, with every field `status --all` adds absent and not invented", () => {
    const db = readFleetDb(OLD, false)!;
    expect(db.allListed).toBe(false);
    expect(db.webhookOwner).toBeNull();
    expect(db.vaults[0]).toMatchObject({ vault: OWNER_VAULT, system: "queue", handoverHeight: "380000000", extended: false, lastOutcome: null, parkedReason: null, skimMode: null, attempts: null });
    expect(db.processes[0]).toMatchObject({ processId: "5a3d0308", role: "profit", live: true, ageMs: 4000, notLegacy: { [OWNER_VAULT]: "queue" }, carryStore: "dual" });
  });

  it("reads the `status --all` contract: every vault_work row with its job's fields, and the webhook owner", () => {
    const db = readFleetDb(
      {
        ...OLD,
        webhookOwner: "legacy",
        vaults: [
          {
            ...OLD.vaults[0],
            skimMode: 1,
            lane: "safety",
            fence: "41",
            claimedAt: "2026-10-27T06:59:00Z",
            lastDoneAt: "2026-10-27T07:00:00Z",
            lastOutcome: "settle IDLE,IDLE · invest IDLE",
            lastDetail: "nothing since slot 1",
            parkedReason: null,
            attempts: 0,
            dueAt: "2026-10-27T07:30:00Z",
            streaks: { investRefused: 2 },
          },
          { vault: LEGACY_A, system: "legacy", systemAt: null, handoverHeight: null, holder: null, leaseUntil: null, skimMode: 0, lastOutcome: null, parkedReason: null },
        ],
      },
      true,
    )!;
    expect(db.allListed).toBe(true);
    expect(db.webhookOwner).toBe("legacy");
    expect(db.vaults[0]).toMatchObject({ skimMode: 1, lane: "safety", fence: "41", lastOutcome: "settle IDLE,IDLE · invest IDLE", attempts: 0, extended: true, streaks: { investRefused: 2 } });
    expect(db.vaults[1]).toMatchObject({ vault: LEGACY_A, system: "legacy", skimMode: 0, extended: true });
  });

  it("refuses a reply it does not understand rather than guess", () => {
    expect(readFleetDb(null, true)).toBeNull();
    expect(readFleetDb({ vaults: [] }, true)).toBeNull();
    expect(readFleetDb({ ...OLD, vaults: [{ system: "queue" }] }, true)).toBeNull();
    expect(readFleetDb({ ...OLD, processes: [{ ...OLD.processes[0], ageMs: undefined }] }, true)).toBeNull();
    expect(readFleetDb({ ...OLD, processes: [{ ...OLD.processes[0], live: "yes" }] }, true)).toBeNull();
  });

  it("tells an older CLI's refusal of a flag or command from any other failure", () => {
    expect(isOlderCliRefusal({ code: 2, refused: "unknown flag for status: --all" })).toBe(true);
    expect(isOlderCliRefusal({ code: 2, refused: "unknown command: unpark" })).toBe(true);
    expect(isOlderCliRefusal({ code: 2, refused: "not a vault address: a 7-character value" })).toBe(false);
    expect(isOlderCliRefusal({ code: 1, refused: null })).toBe(false);
  });

  it("finds a typed vault by its address or its unique first letters, and adds an older CLI's single row", () => {
    const db = fleet();
    expect(resolveVault("D5J5o2gS", db)).toEqual({ vault: LEGACY_A });
    expect(resolveVault(LEGACY_B, db)).toEqual({ vault: LEGACY_B });
    expect(resolveVault("ZZZZ", db)).toHaveProperty("problem");
    const twins = fleet({ vaults: [vault("AbcdOne111111111111111111111111111111111111", "legacy"), vault("AbcdTwo111111111111111111111111111111111111", "legacy")] });
    expect(resolveVault("Abcd", twins)).toEqual({ problem: "Hay 2 vaults que empiezan por «Abcd»: escribe más letras." });
    // AN OLDER CLI lists no legacy vault: a prefix cannot be found, a whole address is taken and its row asked for.
    const partial = fleet({ vaults: [vault(OWNER_VAULT, "queue")], allListed: false });
    const missing = resolveVault("D5J5o2gS", partial);
    expect(missing).toHaveProperty("problem");
    expect((missing as { problem: string }).problem).toContain("dirección entera");
    expect(resolveVault(LEGACY_A, partial)).toEqual({ vault: LEGACY_A });
    expect(rowProblem(partial, LEGACY_A)).toContain("no está en la lista");
    const one = fleet({ vaults: [vault(LEGACY_A, "legacy")], allListed: false });
    expect(withVault(partial, one, LEGACY_A).vaults.map((entry) => entry.vault)).toEqual([OWNER_VAULT, LEGACY_A]);
    expect(withVault(partial, null, LEGACY_A)).toBe(partial);
    expect(rowProblem(withVault(partial, one, LEGACY_A), LEGACY_A)).toBeNull();
  });
});

describe("the owner's words for what the fleet says", () => {
  it("names who serves each vault, and each mode byte", () => {
    expect(whoServes(vault(LEGACY_A, "legacy"))).toBe("legacy");
    expect(whoServes(vault(LEGACY_A, "draining"))).toBe("draining");
    expect(whoServes(vault(LEGACY_A, "queue"))).toBe("queue");
    expect(whoServes(vault(LEGACY_A, "queue", { parkedReason: "x" }))).toBe("parked");
    expect(whoServes(vault(LEGACY_A, "elsewhere"))).toBeNull();
    expect(SERVER_WORDS).toEqual({ queue: "sistema nuevo", legacy: "keepers de siempre", draining: "pasando", parked: "aparcado" });
    expect([0, 1, 2, 3, 9, null].map(modeWords)).toEqual(["beneficio", "volumen", "redondeo", "cuota fija", "modo 9", null]);
  });

  it("says ages and spans as the owner reads them", () => {
    expect(agoWords(500)).toBe("ahora mismo");
    expect(agoWords(20_000)).toBe("hace 20 s");
    expect(agoWords(5 * 60_000)).toBe("hace 5 min");
    expect(agoWords(3 * 3_600_000)).toBe("hace 3 h");
    expect(agoWords(3 * 86_400_000)).toBe("hace 3 días");
    expect(spanWords(LEGACY_READ_FRESH_MS)).toBe("15 min");
    expect(spanWords(FRESH_READ_MS)).toBe("2 min y medio");
    expect(spanWords(45_000)).toBe("45 s");
  });

  it("has words for every settle and invest outcome a worker writes, and marks the ones to look at", () => {
    const settles: readonly TurnSettle[] = ["IDLE", "PENDING_FINALITY", "SETTLED", "NO_PROFIT", "INCOMPLETE", "NO_SIGNER", "UNSUPPORTED_MODE", "PAUSED", "BELOW_RESERVE", "RETRY", "FAILED", "THREW"];
    const invests: readonly TurnInvest[] = ["IDLE", "NO_POLICY", "PAUSED", "INVESTED", "REFUSED", "FAILED", "DEFERRED", "THREW"];
    for (const settle of settles) {
      const said = outcomeWords(`settle ${settle} · invest none`);
      expect(said.text, settle).toMatch(/^cobro: /);
      expect(said.text, settle).not.toContain(settle);
    }
    for (const invest of invests) {
      const said = outcomeWords(`settle none · invest ${invest}`);
      expect(said.text, invest).toMatch(/^compra: /);
      expect(said.text, invest).not.toContain(invest);
    }
    const attention = (outcome: string): boolean => outcomeWords(outcome).attention;
    expect(settles.filter((settle) => attention(`settle ${settle} · invest none`))).toEqual(["INCOMPLETE", "NO_SIGNER", "UNSUPPORTED_MODE", "RETRY", "FAILED", "THREW"]);
    expect(invests.filter((invest) => attention(`settle none · invest ${invest}`))).toEqual(["REFUSED", "FAILED", "THREW"]);
  });

  it("groups a vault's wallets, and words the job-level outcomes", () => {
    expect(outcomeWords("settle IDLE,IDLE · invest IDLE")).toEqual({ text: "cobro: sin operaciones nuevas (2 carteras) · compra: nada que comprar", attention: false });
    expect(outcomeWords("settle SETTLED,IDLE · invest INVESTED")).toEqual({ text: "cobro: 1 cobrado, 1 sin operaciones nuevas · compra: comprado", attention: false });
    expect(outcomeWords("settle SETTLED · invest REFUSED")).toEqual({ text: "cobro: cobrado · compra: rechazada (precio o liquidez)", attention: true });
    expect(outcomeWords("settle none · invest none")).toEqual({ text: "nada que hacer", attention: false });
    expect(outcomeWords("IDLE").text).toBe("al día: nada nuevo en la cadena");
    expect(outcomeWords("NO_LINK")).toEqual({ text: "ninguna cartera enlazada", attention: false });
    expect(outcomeWords("THREW").attention).toBe(true);
    expect(outcomeWords("WAITING_INTENT").attention).toBe(false);
    expect(outcomeWords("RELEASED").attention).toBe(false);
    expect(outcomeWords(null)).toEqual({ text: "todavía sin ningún trabajo", attention: false });
    // AN OUTCOME NOBODY HAS WORDS FOR is shown as written, and flagged: it is new.
    expect(outcomeWords("SOMETHING_NEW")).toEqual({ text: "SOMETHING_NEW", attention: true });
    expect(outcomeWords("settle WEIRD · invest IDLE").attention).toBe(true);
    // "constructor" is not an outcome.
    expect(outcomeWords("constructor")).toEqual({ text: "constructor", attention: true });
  });

  it("says the streaks that repeat, and the scheduler's park, from the real PARK_SQL", () => {
    expect(streakWords(null)).toEqual([]);
    expect(streakWords({ settleRetries: {}, investFailed: 0, investRefused: 0, wrapShort: 0 })).toEqual([]);
    expect(streakWords({ settleRetries: { w1: 1, w2: 4 }, investFailed: 1, investRefused: 6 })).toEqual([
      "lleva 6 compras rechazadas seguidas",
      "lleva 1 compra fallida seguidas",
      "un cobro lleva 4 reintentos seguidos",
    ]);
    // THE REASON AS POSTGRES WRITES IT: PARK_SQL's own literals around the attempts.
    const literals = [...PARK_SQL.matchAll(/'([^']*)'/g)].map((match) => match[1]!);
    const reason = `${literals[0]}${PARK_AFTER_ATTEMPTS}${literals[1]}${literals[2]}`;
    expect(reason).toMatch(/^its lease lapsed 5 claims in a row/);
    expect(parkedWords(reason)).toBe("su trabajo se cortó 5 veces seguidas sin terminar");
    expect(parkedWords("parked by hand")).toBe("parked by hand");
  });
});

// ── every blocker the real Handover writes ───────────────────────────────────

interface Scripted {
  readonly vault?: Record<string, unknown> | null;
  readonly receipts?: readonly Record<string, unknown>[];
  readonly floor?: string | null;
  readonly carries?: readonly Record<string, unknown>[];
  readonly readers?: readonly Record<string, unknown>[];
  readonly system?: string | null;
}

/** A pool whose one client answers Handover's statements from a script: no database, the real sentences. */
function scriptedPool(script: Scripted): HandoverPool {
  const client = {
    async query(text: string) {
      if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(text)) return { rows: [] };
      if (text.includes("FOR UPDATE")) return { rows: script.vault ? [script.vault] : [] };
      if (text.includes("seen ? $1")) return { rows: script.receipts ?? [] };
      if (text.includes("max(COALESCE(resolved_height")) return { rows: [{ floor: script.floor ?? null }] };
      if (text.includes("loss_carry c")) return { rows: script.carries ?? [] };
      if (text.includes("role = ANY($1::text[])")) return { rows: script.readers ?? [] };
      if (text.startsWith("SELECT system FROM")) return { rows: script.system ? [{ system: script.system }] : [] };
      // An UPDATE or INSERT … RETURNING that moved nothing.
      return { rows: [] };
    },
    release() {},
  };
  return { connect: async () => client };
}

const heights = { processed: 1_000n, finalized: 970n };
const legacyRow = (processId: string, role: string, over: Record<string, unknown> = {}) => ({
  process_id: processId,
  role,
  deployment: `dep-${processId}`,
  host: "box",
  live: true,
  read_at: new Date(),
  saw: true,
  carry: false,
  age_ms: "20000",
  carry_store: "on",
  ...over,
});

async function everyBlocker(): Promise<string[]> {
  const draining = { system: "draining", handover_height: null, holder: null, lease_until: null, holder_dead: false };
  const blockers: string[] = [];
  const add = (step: { readonly blockers: readonly string[] }): void => void blockers.push(...step.blockers);
  // arm: an old container that never read it, a carry only in memory, and no acting volume keeper.
  add(
    await new Handover(
      scriptedPool({ vault: draining, receipts: [legacyRow("p-old", "profit", { saw: false, age_ms: "3600000", live: false }), legacyRow("p-carry", "profit", { carry: true })] }),
    ).arm("V", heights),
  );
  // arm --allow-dry: the dry variant of "no keeper of that role".
  add(await new Handover(scriptedPool({ vault: draining, receipts: [legacyRow("p-profit", "profit")] })).arm("V", heights, { allowDry: true }));
  // arm: every keeper let go — the height recorded — and then the wait.
  add(await new Handover(scriptedPool({ vault: draining, receipts: [legacyRow("p-profit", "profit"), legacyRow("p-volume", "volume")] })).arm("V", heights));
  add(
    await new Handover(scriptedPool({ vault: { ...draining, handover_height: "990" }, receipts: [legacyRow("p-profit", "profit"), legacyRow("p-volume", "volume")] })).arm("V", heights),
  );
  // arm: no row, and a vault that is not draining.
  add(await new Handover(scriptedPool({ vault: null })).arm("V", heights));
  add(await new Handover(scriptedPool({ vault: { ...draining, system: "queue" } })).arm("V", heights));
  // release: a live holder, an intent that may still land, and a worker's carry the profit keepers would not read.
  add(
    await new Handover(
      scriptedPool({
        vault: { ...draining, holder: "worker:abc", lease_until: new Date(), holder_dead: false },
        floor: "1200",
        carries: [{ link_addr: "L1", epoch: "5", settlement_nonce: "2", frontier_slot: "9", loss_lamports: "1000", written_fence: "7" }],
        readers: [legacyRow("p-off", "profit", { carry_store: "off", age_ms: "3600000" }), legacyRow("p-null", "profit", { carry_store: null })],
      }),
    ).release("V", heights),
  );
  add(await new Handover(scriptedPool({ vault: null })).release("V", heights));
  add(await new Handover(scriptedPool({ vault: { ...draining, system: "legacy" } })).release("V", heights));
  // drain and rollback that had nothing to move.
  add(await new Handover(scriptedPool({ system: "queue" })).drain("V"));
  add(await new Handover(scriptedPool({ system: null })).drain("V"));
  add(await new Handover(scriptedPool({ system: "legacy" })).rollback("V"));
  return blockers;
}

describe("the CLI's blockers, in Spanish", () => {
  it("translates EVERY blocker the real Handover writes (a rewording there fails here)", async () => {
    const blockers = await everyBlocker();
    expect(blockers.length).toBe(18);
    for (const blocker of blockers) {
      const plain = plainBlocker(blocker);
      expect(plain, blocker).not.toBe(blocker);
      expect(plain, blocker).not.toMatch(/\b(legacy process|has not yet|waiting for|the vault is|still holds|could still land|carried a loss)\b/);
    }
  });

  it("names the process, its role, the wait and what to type", async () => {
    const plain = (await everyBlocker()).map(plainBlocker);
    expect(plain[0]).toBe(
      "el keeper de beneficios (id p-old) todavía no lo ha leído como ajeno (leyó por última vez hace 60 min); espera a su siguiente vuelta. Si su despliegue ya no existe en Railway: «marcar-ido p-old»",
    );
    expect(plain[1]).toContain("el keeper de beneficios (id p-carry) guarda solo en su memoria una pérdida");
    expect(plain[2]).toBe("ningún keeper de volumen encendido y actuando lo ha leído como ajeno en los últimos 15 min: ¿está encendido en Railway, con SIP_SOLANA_DISPATCH=on?");
    expect(plain[3]).toBe("ningún keeper de volumen lo ha leído como ajeno en los últimos 15 min: ¿está encendido en Railway, con SIP_SOLANA_DISPATCH=on?");
    expect(plain[4]).toBe("los keepers de siempre ya lo han soltado; esperando a que pasen los bloques (faltan 181 bloques)");
    expect(plain[5]).toBe("esperando a que pasen los bloques (faltan 171 bloques)");
    expect(plain[6]).toBe("la base no tiene este vault apuntado");
    expect(plain[7]).toBe("el vault está en «sistema nuevo», no «pasando»");
    expect(plain[8]).toBe("un trabajador lo tiene entre manos; espera a que termine (como mucho 6 min desde que lo tomó)");
    expect(plain[9]).toBe("un envío del trabajador aún podría entrar en la cadena; esperando a que pasen los bloques (faltan 231 bloques)");
    expect(plain[10]).toContain("el keeper de beneficios (id p-off) no lee en cada vuelta las pérdidas que guardó el sistema nuevo (SIP_SOLANA_CARRY_STORE=off)");
    expect(plain[10]).toContain("«marcar-ido p-off»");
    expect(plain[11]).toContain("(SIP_SOLANA_CARRY_STORE=unknown)");
    expect(plain[12]).toContain("ningún keeper de beneficios con SIP_SOLANA_CARRY_STORE=on ha leído en los últimos 15 min");
    expect(plain[13]).toBe("ya es de los keepers de siempre");
    expect(plain[14]).toBe("el vault está en «keepers de siempre», no «pasando»");
    expect(plain[15]).toBe("el vault ya no es de los keepers de siempre (está en «sistema nuevo»)");
    expect(plain[16]).toBe("el vault ya no es de los keepers de siempre (está en «sin fila»)");
    expect(plain[17]).toBe("el vault no está en el sistema nuevo (está en «keepers de siempre»)");
  });

  it("leaves a sentence it does not know as written", () => {
    expect(plainBlocker("something new happened")).toBe("something new happened");
  });
});

// ── the decisions ────────────────────────────────────────────────────────────

describe("the receipts", () => {
  it("are vivo within 15 min, viejo after, ido once marked", () => {
    expect(receiptState(receipt("a", "profit", { ageMs: LEGACY_READ_FRESH_MS }))).toBe("vivo");
    expect(receiptState(receipt("a", "profit", { ageMs: LEGACY_READ_FRESH_MS + 1 }))).toBe("viejo");
    expect(receiptState(receipt("a", "profit", { ageMs: 10, goneAt: "2026-10-27T00:00:00Z" }))).toBe("ido");
    const db = fleet({ processes: [receipt("a", "profit"), receipt("b", "profit", { ageMs: 3_600_000 }), receipt("c", "volume", { ageMs: 3_600_000, goneAt: "x" })] });
    expect(staleReceipts(db).map((entry) => entry.processId)).toEqual(["b"]);
  });
});

describe("traspasar: what it refuses before touching anything", () => {
  it("starts with both keepers reading and acting, nothing else in transit", () => {
    expect(moveProblems(fleet(), LEGACY_A, false)).toEqual([]);
  });

  it("refuses a vault with no row, and while another vault is draining", () => {
    expect(moveProblems(fleet(), "Unknown1111111111111111111111111111111111111", false)[0]).toContain("no está en la lista de la flota");
    const busy = fleet({ vaults: [...fleet().vaults, vault(DRAINING, "draining")] });
    const problems = moveProblems(busy, LEGACY_A, false);
    expect(problems).toEqual([`el vault DrainVau… está a medio pasar: termínalo primero («traspasar DrainVau») o devuélvelo («volver DrainVau»)`]);
    // THE DRAINING ONE ITSELF may be finished.
    expect(moveProblems(busy, DRAINING, false)).toEqual([]);
    // A SCHEDULER THAT ARMS BY ITSELF is most likely moving a new vault: wait.
    expect(moveProblems(busy, LEGACY_A, false, true)).toEqual(["el vault DrainVau… está a medio pasar, seguramente uno nuevo que el scheduler pasa solo: espera unos minutos y vuelve a probar"]);
  });

  it("refuses a role that is not reading now, or reading dry outside a rehearsal", () => {
    const quiet = fleet({ processes: [receipt("p-profit", "profit"), receipt("p-volume", "volume", { ageMs: FRESH_READ_MS + 5_000, notLegacy: { [LEGACY_A]: "draining" } })] });
    expect(moveProblems(quiet, LEGACY_A, false)).toEqual([
      "el keeper de volumen no ha leído la base en los últimos 2 min y medio estando encendido y actuando: es su propio recibo el que suelta el vault. ¿Está encendido en Railway, con SIP_SOLANA_DISPATCH=on?",
    ]);
    const dry = fleet({ processes: [receipt("p-profit", "profit", { live: false }), receipt("p-volume", "volume", { live: false })] });
    expect(moveProblems(dry, LEGACY_A, false)).toHaveLength(2);
    expect(moveProblems(dry, LEGACY_A, true)).toEqual([]);
  });

  it("refuses an old container that stopped reading without letting this vault go, naming what to type", () => {
    const old = fleet({ processes: [...fleet().processes, receipt("p-gone-soon", "profit", { ageMs: 3_600_000 })] });
    const problems = moveProblems(old, LEGACY_A, false);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("el keeper de beneficios con id p-gone-soon no lee desde hace 60 min y no ha soltado este vault");
    expect(problems[0]).toContain("«marcar-ido p-gone-soon»");
    // ONE THAT ALREADY READ THIS VAULT AS FOREIGN is no obstacle; one marked gone neither.
    const letGo = fleet({ processes: [...fleet().processes, receipt("p-old", "profit", { ageMs: 3_600_000, notLegacy: { [LEGACY_A]: "draining" } })] });
    expect(moveProblems(letGo, LEGACY_A, false)).toEqual([]);
    const marked = fleet({ processes: [...fleet().processes, receipt("p-old", "profit", { ageMs: 3_600_000, goneAt: "2026-10-27T07:00:00Z" })] });
    expect(moveProblems(marked, LEGACY_A, false)).toEqual([]);
  });
});

describe("volver and the new-vault flag: never to nobody", () => {
  it("volver refuses when a legacy role is not reading", () => {
    expect(returnProblems(fleet(), OWNER_VAULT, false)).toEqual([]);
    const noVolume = fleet({ processes: [receipt("p-profit", "profit")] });
    expect(returnProblems(noVolume, OWNER_VAULT, false)).toEqual([
      "el keeper de volumen no ha leído la base en los últimos 15 min estando encendido y actuando: devuelto, nadie lo serviría; enciéndelo primero. ¿Está encendido en Railway, con SIP_SOLANA_DISPATCH=on?",
    ]);
    expect(returnProblems(noVolume, "Unknown1111111111111111111111111111111111111", false)).toHaveLength(2);
  });

  it("nuevos-a-los-de-siempre refuses while a legacy role is not reading", () => {
    expect(legacyNewVaultsProblems(fleet(), false)).toEqual([]);
    expect(legacyNewVaultsProblems(fleet({ processes: [] }), false)).toHaveLength(2);
    expect(legacyNewVaultsProblems(fleet({ processes: [receipt("a", "profit", { live: false }), receipt("b", "volume", { live: false })] }), true)).toEqual([]);
  });
});

describe("waiting on arm and release", () => {
  it("arm: done is the system, not ok — a vault the scheduler armed meanwhile is finished", () => {
    expect(armProgress({ vault: "V", system: "queue", moved: true, blockers: [] })).toEqual({ kind: "done" });
    expect(armProgress({ vault: "V", system: "queue", moved: false, blockers: ["the vault is queue: only a draining vault is armed (drain it first)"] })).toEqual({ kind: "done" });
    expect(armProgress({ vault: "V", system: "draining", moved: false, blockers: ["waiting for the finalized height to pass 1150 (now 1100)"] })).toEqual({
      kind: "wait",
      note: "esperando a que pasen los bloques (faltan 51 bloques)",
    });
    expect(armProgress({ vault: "V", system: "draining", moved: false, blockers: [] })).toEqual({ kind: "wait", note: "esperando bloques" });
    expect(armProgress({ vault: "V", system: "legacy", moved: false, blockers: [] })).toMatchObject({ kind: "stop" });
    expect(armProgress({ vault: "V", system: null, moved: false, blockers: [] })).toMatchObject({ kind: "stop" });
    expect(armProgress(null)).toBeNull();
    expect(armProgress({ unexpected: true })).toBeNull();
  });

  it("release: legacy or no row is done; back in the queue stops and says who did it", () => {
    expect(releaseProgress({ vault: "V", system: "legacy", moved: true, blockers: [] })).toEqual({ kind: "done" });
    expect(releaseProgress({ vault: "V", system: null, moved: false, blockers: ["vault_work has no row for this vault: it is already the legacy keepers'"] })).toEqual({ kind: "done" });
    const back = releaseProgress({ vault: "V", system: "queue", moved: false, blockers: [] });
    expect(back).toMatchObject({ kind: "stop" });
    expect((back as { readonly lines: readonly string[] }).lines.join(" ")).toContain("el scheduler lo ha armado otra vez");
    expect(releaseProgress({ vault: "V", system: "draining", moved: false, blockers: ["worker w still holds it (lease until x): wait"] })).toEqual({
      kind: "wait",
      note: "un trabajador lo tiene entre manos; espera a que termine (como mucho 6 min desde que lo tomó)",
    });
    expect(releaseProgress("nonsense")).toBeNull();
  });
});

describe("marcar-ido: only receipts that stopped reading", () => {
  const db = fleet({
    processes: [
      receipt("5a3d0308-a4fa-4aed-af31-737f158f482d", "profit"),
      receipt("ed2e0b7c-d95b-4bb3-b4a8-903a55099781", "volume", { ageMs: 4 * 3_600_000 }),
      receipt("aaaa1111-0000-0000-0000-000000000000", "profit", { ageMs: 3_600_000 }),
      receipt("aaaa1111-9999-0000-0000-000000000000", "profit", { ageMs: 3_600_000 }),
      receipt("cccc2222-0000-0000-0000-000000000000", "volume", { ageMs: 3_600_000, goneAt: "2026-10-27T01:00:00Z" }),
    ],
  });

  it("finds an id whole or by a unique start of 8+, and refuses a live one, a marked one, an unknown one and an ambiguous start", () => {
    expect(goneTargets(db, ["ed2e0b7c-d95b-4bb3-b4a8-903a55099781"]).targets.map((entry) => entry.processId)).toEqual(["ed2e0b7c-d95b-4bb3-b4a8-903a55099781"]);
    expect(goneTargets(db, ["ed2e0b7c"]).targets.map((entry) => entry.processId)).toEqual(["ed2e0b7c-d95b-4bb3-b4a8-903a55099781"]);
    expect(goneTargets(db, ["ed2e0b7c", "ed2e0b7c-d95b-4bb3-b4a8-903a55099781"]).targets).toHaveLength(1);
    const live = goneTargets(db, ["5a3d0308-a4fa-4aed-af31-737f158f482d"]);
    expect(live.targets).toEqual([]);
    expect(live.problems[0]).toContain("está vivo, no lo marco");
    expect(goneTargets(db, ["cccc2222-0000-0000-0000-000000000000"]).problems).toEqual(["«cccc2222-0000-0000-0000-000000000000» ya está marcado como ido"]);
    expect(goneTargets(db, ["nobody-at-all"]).problems[0]).toContain("no encuentro ningún keeper");
    expect(goneTargets(db, ["aaaa1111"]).problems).toEqual(["hay 2 keepers cuyo id empieza por «aaaa1111»: cópialo entero"]);
    // TOO SHORT A START is never matched by its start.
    expect(goneTargets(db, ["ed2e"]).problems[0]).toContain("no encuentro ningún keeper");
  });
});

// ── the pages ────────────────────────────────────────────────────────────────

/** The scheduler's /status as production served it on 2026-10-27 (trimmed; a standby replica answered). */
const SCHEDULER_PAGE = {
  service: "sip-solana-keeper",
  role: "scheduler",
  health: { ok: true },
  read: { ok: true, at: "2026-10-27T07:10:46.230Z", ageMs: 13736, reads: 195, failures: 0, consecutiveFailures: 0, skipped: 0, lastError: null },
  fleet: {
    now: "2026-10-27T07:10:46.221701+00:00",
    scheduler: { schedulerId: "scheduler-7c88", tickAt: "2026-10-27T07:10:15.587544+00:00", tickAgeMs: 30634, fullPassReason: null },
    workers: [
      { workerId: "scheduler-32fb", kind: "scheduler", heartbeatAgeMs: 2909047, dead: false, stoppedAt: "2026-10-27T06:22:21Z", slots: 0, busy: 0, stats: {} },
      { workerId: "worker:d53e", kind: "worker", heartbeatAgeMs: 2927799, dead: false, stoppedAt: "2026-10-27T06:22:03Z", slots: 2, busy: 0, stats: { jobsLast10Min: 10 } },
      { workerId: "worker:453b", kind: "worker", heartbeatAgeMs: 5977, dead: false, stoppedAt: null, slots: 2, busy: 1, stats: { jobsLast10Min: 10 } },
    ],
    queue: {
      bySystem: { legacy: 2, queue: 1 },
      lanes: {},
      due: 0,
      oldestDueMs: null,
      leases: { held: 0, expired: 0, overCeiling: 0, takeovers: 0, claimLagP50Ms: null, claimLagP90Ms: null },
      parked: { count: 0, vaults: [] },
      outcomes: { "settle IDLE,IDLE · invest IDLE": 1 },
    },
  },
  alerts: { acting: false, firing: [] },
  dispatch: "on",
  scheduler: { role: "standby", mode: "on", ticks: 0 },
};

const withAutoArm = (autoArm: unknown, over: Record<string, unknown> = {}) => ({ ...SCHEDULER_PAGE, scheduler: { ...SCHEDULER_PAGE.scheduler, autoArm, ...over } });
const answered = <T>(page: T): PageRead<T> => ({ answered: true, page });

describe("the scheduler's page, read", () => {
  it("reads production's page: health, the lock holder's tick, the live workers only, the queue, and no autoArm", () => {
    expect(readSchedulerPage(SCHEDULER_PAGE)).toEqual({
      healthOk: true,
      healthDetail: null,
      replica: "standby",
      fleetRead: true,
      readOk: true,
      readError: null,
      tickAgeMs: 30634,
      workersAlive: 1,
      slots: 2,
      busy: 1,
      jobsLast10Min: 10,
      due: 0,
      oldestDueMs: null,
      parked: 0,
      expiredLeases: 0,
      firing: [],
      autoArm: null,
    });
  });

  it("reads scheduler.autoArm tolerantly: pending as a count or a list, lastResults' blockers", () => {
    const page = readSchedulerPage(
      withAutoArm({
        enabled: true,
        legacyRoles: ["profit", "volume"],
        pending: [DRAINING, { vault: PARKED }],
        lastArmedAt: "2026-10-27T07:00:00Z",
        lastResults: [{ vault: DRAINING, system: "draining", moved: false, blockers: ["waiting for the finalized height to pass 1150 (now 1100)"] }, { nonsense: true }],
        lastError: null,
      }),
    );
    expect(page.autoArm).toEqual({
      enabled: true,
      legacyRoles: ["profit", "volume"],
      pending: 2,
      pendingVaults: [DRAINING, PARKED],
      lastArmedAt: "2026-10-27T07:00:00Z",
      lastError: null,
      lastResults: [{ vault: DRAINING, system: "draining", blockers: ["waiting for the finalized height to pass 1150 (now 1100)"] }],
    });
    expect(readSchedulerPage(withAutoArm({ enabled: false, pending: 3 })).autoArm).toMatchObject({ enabled: false, pending: 3, legacyRoles: null, lastResults: [] });
    // PRESENT BUT NOT AN OBJECT is not "enabled".
    expect(readSchedulerPage(withAutoArm("yes")).autoArm).toBeNull();
  });

  it("reads a page that has not read the fleet yet, and a page that is not a page", () => {
    expect(readSchedulerPage({ ...SCHEDULER_PAGE, fleet: null })).toMatchObject({ fleetRead: false, workersAlive: 0, tickAgeMs: null, due: null });
    expect(readSchedulerPage("<html>")).toMatchObject({ healthOk: null, fleetRead: false, autoArm: null });
  });

  it("reads a legacy keeper's page", () => {
    const page = readKeeperPage({ role: "profit", mode: "live", armed: true, lastSweepAt: "2026-10-27T07:59:30Z", dispatch: { mode: "on" } }, NOW);
    expect(page).toEqual({ mode: "live", armed: true, lastSweepAgeMs: 30_000, dispatch: "on" });
    expect(readKeeperPage({}, NOW)).toEqual({ mode: null, armed: null, lastSweepAgeMs: null, dispatch: null });
  });

  it("words the scheduler's health and its problems", () => {
    const healthy = schedulerLines(answered(readSchedulerPage(SCHEDULER_PAGE)), NOW);
    expect(healthy.problems).toEqual([]);
    expect(healthy.lines).toEqual([
      "Scheduler: sano · última vuelta hace 31 s (contestó la de reserva)",
      "  se arma solo: no (esta versión no lo hace)",
      "Trabajadores: 1 vivo · 1 de 2 huecos ocupados · 10 trabajos en 10 min",
      "Cola: nada esperando · 0 aparcados",
    ]);
    const sick = readSchedulerPage({
      ...SCHEDULER_PAGE,
      health: { ok: false, detail: "the scheduler's tick last moved 900s ago" },
      read: { ok: false, lastError: "connect ETIMEDOUT" },
      fleet: { ...SCHEDULER_PAGE.fleet, scheduler: { tickAgeMs: 900_000 }, workers: [], queue: { ...SCHEDULER_PAGE.fleet.queue, due: 3, oldestDueMs: 600_000 } },
      alerts: { firing: ["queue-lag", "scheduler-stale"] },
    });
    const problems = schedulerLines(answered(sick), NOW).problems;
    expect(problems).toHaveLength(6);
    expect(problems.join("\n")).toContain("no hay ningún trabajador vivo");
    expect(problems.join("\n")).toContain("avisos encendidos: queue-lag, scheduler-stale");
    expect(schedulerLines({ answered: false, why: "no contesta" }, NOW).problems[0]).toContain("no contesta");
    const armed = schedulerLines(answered(readSchedulerPage(withAutoArm({ enabled: true, legacyRoles: [], lastArmedAt: "2026-10-27T07:55:00Z", lastError: "boom" }))), NOW).lines;
    expect(armed[1]).toBe("  se arma solo: sí · armó por última vez hace 5 min · espera recibos de: nadie");
    expect(armed[2]).toBe("  OJO: su último intento de armar falló: boom");
  });
});

describe("nuevos-a-la-cola: refused unless the scheduler arms by itself", () => {
  const armed = answered(readSchedulerPage(withAutoArm({ enabled: true, legacyRoles: ["profit", "volume"] })));

  it("flips only when every answer says enabled, the lock holder ticks, the roles it waits on read, no stale receipt stands", () => {
    expect(queueNewVaultsProblems(fleet(), [armed, armed, armed], false)).toEqual([]);
  });

  it("refuses with no page, an old scheduler, autoArm off, or one replica of two disagreeing", () => {
    expect(queueNewVaultsProblems(fleet(), [{ answered: false, why: "no contesta" }], false)).toEqual(["la página del scheduler no contesta: no puedo comprobar que se arme solo"]);
    const old = answered(readSchedulerPage(SCHEDULER_PAGE));
    expect(queueNewVaultsProblems(fleet(), [old], false)[0]).toContain("esta versión del scheduler no se arma sola");
    const off = answered(readSchedulerPage(withAutoArm({ enabled: false })));
    expect(queueNewVaultsProblems(fleet(), [off], false)[0]).toContain("no se arma solo (lo tiene apagado)");
    expect(queueNewVaultsProblems(fleet(), [armed, old, armed], false)).toHaveLength(1);
    expect(queueNewVaultsProblems(fleet(), [armed, { answered: false, why: "x" }], false)).toEqual([]);
  });

  it("refuses a scheduler that is not ticking, a role it waits on that is not reading, and stale receipts", () => {
    const stalled = answered(readSchedulerPage({ ...withAutoArm({ enabled: true, legacyRoles: [] }), fleet: { ...SCHEDULER_PAGE.fleet, scheduler: { tickAgeMs: 600_000 } } }));
    expect(queueNewVaultsProblems(fleet(), [stalled], false)).toEqual(["el scheduler no da vueltas: nadie apuntaría los vaults nuevos"]);
    const volumeQuiet = fleet({ processes: [receipt("p-profit", "profit")] });
    expect(queueNewVaultsProblems(volumeQuiet, [armed], false)[0]).toContain("el keeper de volumen no ha leído la base en los últimos 15 min");
    // A SCHEDULER THAT WAITS ON NO ROLE does not need them reading.
    const none = answered(readSchedulerPage(withAutoArm({ enabled: true, legacyRoles: [] })));
    expect(queueNewVaultsProblems(fleet({ processes: [] }), [none], false)).toEqual([]);
    const stale = fleet({ processes: [...fleet().processes, receipt("old-1", "profit", { ageMs: 3_600_000 })] });
    expect(queueNewVaultsProblems(stale, [armed], false)).toEqual([
      "hay 1 recibo viejo sin marcar como ido (old-1): el scheduler esperaría por ellos. Si esos despliegues ya no existen en Railway, «marcar-idos-viejos» primero",
    ]);
  });
});

// ── the screen ───────────────────────────────────────────────────────────────

const keeperPage = (over: Partial<KeeperPageView> = {}): PageRead<KeeperPageView> => answered({ mode: "live", armed: true, lastSweepAgeMs: 30_000, dispatch: "on", ...over });

const view = (db: FleetDb, scheduler: PageRead<SchedulerPageView> = answered(readSchedulerPage(SCHEDULER_PAGE)), over: Partial<FlotaView> = {}): FlotaView => ({
  db,
  scheduler,
  keepers: { profit: keeperPage(), volume: keeperPage() },
  now: NOW,
  rehearsal: false,
  ...over,
});

describe("flota: the screen", () => {
  it("shows today's fleet: each vault, who serves it, its last job, the receipts, the pages, the health, what next", () => {
    const db = fleet({
      vaults: [
        vault(OWNER_VAULT, "queue", { skimMode: 1, lastOutcome: "settle IDLE,IDLE · invest IDLE", lastDoneAt: "2026-10-27T07:58:00Z" }),
        vault(LEGACY_A, "legacy", { skimMode: 0 }),
        vault(LEGACY_B, "legacy", { skimMode: 0 }),
      ],
      processes: [
        receipt("p-profit", "profit", { notLegacy: { [OWNER_VAULT]: "queue" } }),
        receipt("p-volume", "volume", { ageMs: 12_000, carryStore: null }),
        receipt("p-old", "profit", { ageMs: 7_200_000 }),
        receipt("p-gone", "volume", { goneAt: "2026-10-27T05:00:00Z" }),
      ],
    });
    expect(flotaLines(view(db))).toEqual([
      "Vaults (3):",
      "  EFXK995P…  sistema nuevo · volumen  ← el tuyo",
      "             hace 2 min · cobro: sin operaciones nuevas (2 carteras) · compra: nada que comprar",
      "  4J3En7ug…  keepers de siempre · beneficio",
      "  D5J5o2gS…  keepers de siempre · beneficio",
      "",
      "Vaults nuevos: van a los keepers de siempre.",
      "Timbre de Helius: lo lleva el keeper de beneficios.",
      "",
      "Keepers de siempre (sus recibos en la base):",
      "  keeper de beneficios: vivo · leyó hace 20 s · actuando · pérdidas en la base: dual · id p-profit",
      "  keeper de volumen: vivo · leyó hace 12 s · actuando · id p-volume",
      "  keeper de beneficios: viejo · leyó hace 2 h · actuando · pérdidas en la base: dual · id p-old",
      "    si su despliegue (dep-p-old) ya no existe en Railway: «marcar-ido p-old»",
      "  idos (marcados): 1",
      "Sus páginas:",
      "  el keeper de beneficios: contesta · actuando · última vuelta hace 30 s",
      "  el keeper de volumen: contesta · actuando · última vuelta hace 30 s",
      "",
      "Scheduler: sano · última vuelta hace 31 s (contestó la de reserva)",
      "  se arma solo: no (esta versión no lo hace)",
      "Trabajadores: 1 vivo · 1 de 2 huecos ocupados · 10 trabajos en 10 min",
      "Cola: nada esperando · 0 aparcados",
      "",
      "Siguiente:",
      "  - Hay keepers que llevan más de 15 min sin leer: comprueba en Railway que esos despliegues ya no existen y haz «marcar-idos-viejos».",
      "  - Quedan 2 con los keepers de siempre: «traspasar-todos» (uno detrás de otro) o «traspasar <vault>».",
    ]);
  });

  it("marks what needs looking at on a queue vault: the outcome, its detail, a streak, attempts, a park", () => {
    const db = fleet({
      vaults: [
        vault(OWNER_VAULT, "queue", {
          lastOutcome: "settle IDLE · invest REFUSED",
          lastDetail: "Jupiter answered 429",
          lastDoneAt: "2026-10-27T07:59:00Z",
          streaks: { investRefused: 7 },
          attempts: 2,
          holder: "worker:1",
        }),
        vault(PARKED, "queue", { parkedReason: "its lease lapsed 5 claims in a row without a completion: a job that never ends; parked by the scheduler until an operator clears parked_reason" }),
      ],
    });
    const lines = flotaLines(view(db));
    expect(lines).toContain("             OJO: hace 60 s · cobro: sin operaciones nuevas · compra: rechazada (precio o liquidez) · trabajando ahora");
    expect(lines).toContain("             detalle: Jupiter answered 429");
    expect(lines).toContain("             OJO: lleva 7 compras rechazadas seguidas");
    expect(lines).toContain("             OJO: 2 intentos seguidos sin terminar");
    expect(lines).toContain("  ParkedVa…  aparcado");
    expect(lines).toContain("             su trabajo se cortó 5 veces seguidas sin terminar · «desaparcar ParkedVa» para que lo vuelva a intentar");
    expect(nextSteps(view(db))[0]).toBe("ParkedVa… está aparcado: «desaparcar ParkedVa». Si se vuelve a aparcar, dímelo.");
  });

  it("an older CLI: no invented outcomes, and the list says what it cannot see", () => {
    const db = fleet({ vaults: [vault(OWNER_VAULT, "queue", { extended: false })], allListed: false, webhookOwner: null });
    const lines = flotaLines(view(db));
    expect(lines.slice(0, 3)).toEqual(["Vaults (1):", "  EFXK995P…  sistema nuevo  ← el tuyo", "  (esta versión de dispatch-handover solo me enseña los que no son de los keepers de siempre)"]);
    expect(lines.some((line) => line.startsWith("Timbre"))).toBe(false);
    expect(nextSteps(view(db))).toEqual(["Para ver todos los vaults hace falta la versión nueva de dispatch-handover (status --all)."]);
  });

  it("a vault in transit: nobody serves it unless the scheduler arms by itself, and then its last word", () => {
    const db = fleet({ vaults: [vault(OWNER_VAULT, "queue"), vault(DRAINING, "draining")] });
    expect(flotaLines(view(db))).toContain("             nadie lo cobra ni compra hasta que termine: «traspasar DrainVau» para acabar, o «volver DrainVau»");
    expect(nextSteps(view(db))[0]).toBe("DrainVau… está a medio pasar y nadie lo sirve: «traspasar DrainVau» o «volver DrainVau».");
    const auto = answered(
      readSchedulerPage(withAutoArm({ enabled: true, legacyRoles: [], lastResults: [{ vault: DRAINING, system: "draining", blockers: ["waiting for the finalized height to pass 1150 (now 1100)"] }] })),
    );
    const queued = { ...db, newVaultSystem: "queue" };
    expect(flotaLines(view(queued, auto))).toContain("             el scheduler lo pasa solo: esperando a que pasen los bloques (faltan 51 bloques)");
    expect(nextSteps(view(queued, auto))).toEqual([]);
  });

  it("new vaults to the queue without a scheduler that arms says so loudly, and what to type", () => {
    const db = fleet({ newVaultSystem: "queue", vaults: [vault(OWNER_VAULT, "queue")] });
    const lines = flotaLines(view(db));
    expect(lines).toContain("Vaults nuevos: van al sistema nuevo, PERO el scheduler no se arma solo: un vault nuevo se queda «pasando» sin que nadie lo sirva.");
    expect(nextSteps(view(db))).toContain("Los vaults nuevos van a la cola pero el scheduler no se arma solo: «nuevos-a-los-de-siempre».");
  });

  it("walks the cutover's next steps to the end", () => {
    const allQueued = fleet({ vaults: [vault(OWNER_VAULT, "queue"), vault(LEGACY_A, "queue")] });
    const armedWaiting = answered(readSchedulerPage(withAutoArm({ enabled: true, legacyRoles: ["profit", "volume"] })));
    const armedFree = answered(readSchedulerPage(withAutoArm({ enabled: true, legacyRoles: [] })));
    expect(nextSteps(view(allQueued))).toEqual([
      "Todos los vaults están en el sistema nuevo. Para mandar también los nuevos hace falta que el scheduler se arme solo (la versión nueva, encendida); luego «nuevos-a-la-cola».",
    ]);
    expect(nextSteps(view(allQueued, armedWaiting))).toEqual(["Todos los vaults están en el sistema nuevo. Siguiente: «nuevos-a-la-cola»."]);
    const everything = { ...allQueued, newVaultSystem: "queue" };
    expect(nextSteps(view(everything, armedWaiting))).toEqual([
      "Todo va al sistema nuevo. Antes de parar los keepers de siempre, el scheduler tiene que dejar de esperar sus recibos (ahora los espera): dímelo.",
    ]);
    expect(nextSteps(view(everything, armedFree))).toEqual(["Todo va al sistema nuevo. Cuando quieras, para los keepers de siempre en Railway (no los borres) y luego «marcar-idos-viejos»."]);
    const stopped = { ...everything, processes: [receipt("p-profit", "profit", { ageMs: 3_600_000, goneAt: "x" })] };
    expect(nextSteps(view(stopped, armedFree, { keepers: { profit: { answered: false, why: "no contesta" }, volume: { answered: false, why: "no contesta" } } }))).toEqual([
      "Todo va al sistema nuevo.",
    ]);
    // LEGACY VAULTS LEFT AND THEIR KEEPERS NOT READING: turn them on first.
    const orphaned = fleet({ processes: [] });
    expect(nextSteps(view(orphaned))).toEqual(["Quedan 2 con los keepers de siempre, y esos keepers no están leyendo: enciéndelos en Railway antes de traspasar."]);
  });

  it("a keeper whose page does not answer, or that runs without the dispatch variable", () => {
    const lines = flotaLines(view(fleet(), undefined, { keepers: { profit: { answered: false, why: "contestó 502" }, volume: keeperPage({ dispatch: null, mode: "dry", armed: false }) } }));
    expect(lines).toContain("  el keeper de beneficios: no contesta (contestó 502) — ¿parado en Railway?");
    expect(lines).toContain("  el keeper de volumen: contesta · en seco · última vuelta hace 30 s · SIN SIP_SOLANA_DISPATCH");
  });
});
