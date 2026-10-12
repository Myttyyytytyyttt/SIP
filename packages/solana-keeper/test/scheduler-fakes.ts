// In-memory stand-ins for what the scheduler (src/scheduler.ts) talks to: its
// lock, its store and its chain. They keep the SEMANTICS the Postgres versions
// have (src/scheduler-pg.ts, proved on Postgres 16 by test/scheduler-pg.test.ts)
// and record every call, so test/scheduler.test.ts can watch what a tick asks
// for, in what order, and how often — across two schedulers sharing one fake
// database and one fake chain.

import { Keypair, PublicKey } from "@solana/web3.js";
import type { Alert } from "../src/alerts.js";
import type { ChainSnapshot } from "../src/chain-state.js";
import type { DiscoveryReport, ManagedLink } from "../src/discovery.js";
import type { Lane } from "../src/dispatch-store.js";
import { LANE_PRIORITY } from "../src/dispatch-store.js";
import type { FleetRead, HookEvidence, LinkRow, LockState, ParkedVault, SchedulerLock, StaleIntent, VaultSystem, WebhookOwner, WorkRow } from "../src/scheduler-pg.js";
import type { InvestRestVerdict, SchedulerChain, SchedulerStore } from "../src/scheduler.js";
import { REST_DUE_SECONDS } from "../src/worker-job.js";

/** One advisory lock, shared by every FakeLock built over it: the database's side. */
export class LockServer {
  holder: string | null = null;
  attempts = 0;
}

export class FakeLock implements SchedulerLock {
  #held = false;
  /** The session died under the holder (the server dropped it): the next ensure() finds out. */
  sessionDied = false;
  constructor(
    readonly server: LockServer,
    readonly name: string,
  ) {}

  get held(): boolean {
    return this.#held;
  }

  async ensure(): Promise<LockState> {
    if (this.#held) {
      if (!this.sessionDied && this.server.holder === this.name) return "held";
      this.#held = false;
      this.sessionDied = false;
      if (this.server.holder === this.name) this.server.holder = null;
      return "lost";
    }
    this.server.attempts += 1;
    if (this.server.holder === null) {
      this.server.holder = this.name;
      this.#held = true;
      return "took";
    }
    return "standby";
  }

  release(): void {
    if (this.#held && this.server.holder === this.name) this.server.holder = null;
    this.#held = false;
  }
}

type MutableRow = { -readonly [K in keyof WorkRow]: WorkRow[K] };

/** vault_work, keeper_link and the fleet row, in memory, with the statements' rules. */
export class MemoryStore implements SchedulerStore {
  now = 1_000_000_000;
  newVaultSystem: VaultSystem = "queue";
  /**
   * The handover's `arm`, taken as done: ENSURE_VAULTS_SQL enrols a vault as
   * 'draining' under new_vault_system = 'queue' (never the queue itself), and
   * these unit tests are about the selection, so by default the fake moves it
   * on to 'queue' at once. false leaves it draining, as the statement does.
   */
  armOnEnrol = true;
  webhookOwner: WebhookOwner = "legacy";
  readonly links = new Map<string, LinkRow & { gone: boolean; seenAt: number }>();
  readonly rows = new Map<string, MutableRow>();
  readonly calls: string[] = [];
  readonly marks: { vault: string; lane: Lane }[][] = [];
  readonly completions: string[][] = [];
  readonly ticks: { id: string; discoveryOk: boolean }[] = [];
  stale: StaleIntent[] = [];
  evidence: HookEvidence = { lastBellAt: null, lastEchoAt: null, deafSince: null };
  fail: Partial<Record<keyof SchedulerStore, Error>> = {};

  #maybeFail(name: keyof SchedulerStore): void {
    this.calls.push(name);
    const error = this.fail[name];
    if (error !== undefined) throw error;
  }

  row(vault: string): MutableRow {
    const row = this.rows.get(vault);
    if (row === undefined) throw new Error(`no row for ${vault}`);
    return row;
  }

  /** A worker's job ending on `vault`: claimed at `claimedAt`, completed at `doneAt`. */
  complete(vault: string, input: { claimedAt: number; doneAt: number; rests: boolean; dueAt?: number; lane?: string }): void {
    const row = this.row(vault);
    row.fence += 1n;
    row.claimedAt = input.claimedAt;
    row.doneAt = input.doneAt;
    row.rests = input.rests;
    row.held = false;
    row.lane = input.lane ?? (input.rests ? "safety" : "retry");
    row.priority = LANE_PRIORITY[(row.lane as Lane) ?? "safety"] ?? 4;
    // A RESTING JOB'S DUE TIME IS THE WORKER'S BACKSTOP (src/worker-job.ts, REST_DUE_SECONDS).
    row.dueAt = input.dueAt ?? input.doneAt + (input.rests ? REST_DUE_SECONDS * 1_000 : 30 * 60_000);
  }

  async readFleet(): Promise<FleetRead> {
    this.#maybeFail("readFleet");
    return { now: this.now, newVaultSystem: this.newVaultSystem, webhookOwner: this.webhookOwner, boardDirtyAt: null };
  }

  async upsertLinks(links: readonly LinkRow[]): Promise<number> {
    this.#maybeFail("upsertLinks");
    for (const link of links) this.links.set(link.link, { ...link, gone: false, seenAt: this.now });
    return links.length;
  }

  async markGone(listed: readonly string[]): Promise<readonly string[]> {
    this.#maybeFail("markGone");
    const gone: string[] = [];
    for (const [address, link] of this.links) {
      if (!link.gone && !listed.includes(address)) {
        link.gone = true;
        gone.push(address);
      }
    }
    return gone;
  }

  async cachedLinks(): Promise<{ readonly links: readonly LinkRow[]; readonly newestSeenAt: number | null }> {
    this.#maybeFail("cachedLinks");
    const live = [...this.links.values()].filter((l) => !l.gone);
    return { links: live.map(({ gone: _g, seenAt: _s, ...link }) => link), newestSeenAt: live.length === 0 ? null : Math.max(...live.map((l) => l.seenAt)) };
  }

  async ensureVaults(vaults: readonly string[]): Promise<readonly { readonly vault: string; readonly system: VaultSystem }[]> {
    this.#maybeFail("ensureVaults");
    const made: { vault: string; system: VaultSystem }[] = [];
    const enrolled: VaultSystem = this.newVaultSystem === "queue" ? "draining" : "legacy";
    for (const vault of new Set(vaults)) {
      if (this.rows.has(vault)) continue;
      this.rows.set(vault, {
        vault,
        system: enrolled === "draining" && this.armOnEnrol ? "queue" : enrolled,
        lane: "new",
        priority: 2,
        rests: false,
        held: false,
        parked: false,
        fence: 0n,
        bellAt: null,
        claimedAt: null,
        doneAt: null,
        dueAt: this.now,
        lastOutcome: null,
        openIntents: 0,
      });
      made.push({ vault, system: enrolled });
    }
    return made;
  }

  async readWork(vaults: readonly string[]): Promise<{ readonly now: number | null; readonly rows: readonly WorkRow[] }> {
    this.#maybeFail("readWork");
    const rows = [...new Set(vaults)].flatMap((vault) => {
      const row = this.rows.get(vault);
      return row === undefined ? [] : [{ ...row }];
    });
    return { now: rows.length === 0 ? null : this.now, rows };
  }

  async markDue(entries: readonly { readonly vault: string; readonly lane: Lane }[]): Promise<readonly string[]> {
    this.#maybeFail("markDue");
    this.marks.push(entries.map((e) => ({ ...e })));
    const done: string[] = [];
    for (const entry of entries) {
      const row = this.rows.get(entry.vault);
      if (row === undefined || row.system !== "queue" || row.parked || row.held) continue;
      row.dueAt = Math.min(row.dueAt, this.now);
      row.lane = entry.lane;
      row.priority = LANE_PRIORITY[entry.lane];
      done.push(entry.vault);
    }
    return done;
  }

  async completeIdle(
    entries: readonly { readonly vault: string; readonly fence: bigint; readonly bellAt: number | null }[],
    dueInMs: number,
  ): Promise<readonly string[]> {
    this.#maybeFail("completeIdle");
    const done: string[] = [];
    for (const entry of entries) {
      const row = this.rows.get(entry.vault);
      if (row === undefined || row.held || !row.rests || row.fence !== entry.fence || row.bellAt !== entry.bellAt) continue;
      row.doneAt = this.now;
      row.lastOutcome = "IDLE";
      row.lane = "safety";
      row.priority = 4;
      row.dueAt = this.now + dueInMs;
      done.push(entry.vault);
    }
    this.completions.push(done);
    return done;
  }

  async retireUnlinked(listedVaults: readonly string[]): Promise<readonly string[]> {
    this.#maybeFail("retireUnlinked");
    const retired: string[] = [];
    for (const row of this.rows.values()) {
      if (row.system === "queue" && !row.held && Number.isFinite(row.dueAt) && !listedVaults.includes(row.vault)) {
        row.dueAt = Number.POSITIVE_INFINITY;
        retired.push(row.vault);
      }
    }
    return retired;
  }

  async writeTick(id: string, discoveryOk: boolean): Promise<void> {
    this.#maybeFail("writeTick");
    this.ticks.push({ id, discoveryOk });
  }

  async park(): Promise<readonly ParkedVault[]> {
    this.#maybeFail("park");
    return [];
  }

  async staleIntents(): Promise<readonly StaleIntent[]> {
    this.#maybeFail("staleIntents");
    return this.stale;
  }

  async pruneIntents(): Promise<number> {
    this.#maybeFail("pruneIntents");
    return 0;
  }

  async hookEvidence(): Promise<HookEvidence> {
    this.#maybeFail("hookEvidence");
    return this.evidence;
  }
}

/** A link of the fake chain. */
export function fakeLink(vault: PublicKey, over: Partial<ManagedLink> = {}): ManagedLink {
  const wallet = Keypair.generate().publicKey;
  return {
    linkAddress: Keypair.generate().publicKey,
    wallet,
    vault,
    epoch: 300_000_000n,
    settlementNonce: 0n,
    frontierSlot: 0n,
    ...over,
  };
}

/** The chain every fake scheduler reads: links, wallets' fingerprints, invest verdicts, and a log of calls. */
export class FakeChain implements SchedulerChain {
  links: ManagedLink[] = [];
  readonly calls: string[] = [];
  listFails: Error | null = null;
  rereadFails: Error | null = null;
  fingerprintFails: Error | null = null;
  slot = 400_000_000;
  paused = false;
  crankLamports: bigint | null = 1_000_000_000n;
  /** wallet → lamports; absent = 1 SOL. */
  readonly lamports = new Map<string, bigint>();
  /** vault → whether its invest half rests; absent = rests. */
  readonly investRests = new Map<string, boolean>();
  finalized = 1_000n;
  readonly statuses = new Map<string, { err: unknown } | null>();
  /** When set, snapshot() never answers: a tick blocked on a call that never returns. */
  hang = false;

  async snapshot(): Promise<ChainSnapshot> {
    this.calls.push("snapshot");
    if (this.hang) return new Promise<ChainSnapshot>(() => undefined);
    const keeper = Keypair.generate().publicKey;
    return {
      at: new Date().toISOString(),
      programDeployed: true,
      config: {
        address: Keypair.generate().publicKey,
        authority: Keypair.generate().publicKey,
        attester: keeper,
        keeper,
        pendingAuthority: PublicKey.default,
        paused: this.paused,
        version: 1,
      } as unknown as ChainSnapshot["config"],
      configReadable: true,
      crankLamports: this.crankLamports,
      errors: [],
    };
  }

  async list(): Promise<DiscoveryReport> {
    this.calls.push("list");
    if (this.listFails !== null) throw this.listFails;
    return { links: [...this.links], method: "v1", requests: 1, contextSlot: this.slot };
  }

  async reread(addresses: readonly string[]): Promise<readonly ManagedLink[]> {
    this.calls.push("reread");
    if (this.rereadFails !== null) throw this.rereadFails;
    return this.links.filter((l) => addresses.includes(l.linkAddress.toBase58()));
  }

  async fingerprints(wallets: readonly string[]) {
    this.calls.push("fingerprints");
    if (this.fingerprintFails !== null) throw this.fingerprintFails;
    return { slot: this.slot, byWallet: new Map(wallets.map((w) => [w, { lamports: this.lamports.get(w) ?? 1_000_000_000n, wsol: 0n }] as const)) };
  }

  async investAtRest(vaults: readonly string[]): Promise<ReadonlyMap<string, InvestRestVerdict>> {
    this.calls.push("investAtRest");
    return new Map(vaults.map((v) => [v, { rests: this.investRests.get(v) ?? true, outcome: "IDLE", detail: "below the policy minimum" }] as const));
  }

  async finalizedHeight(): Promise<bigint> {
    this.calls.push("finalizedHeight");
    return this.finalized;
  }

  async signatureStatuses(signatures: readonly string[]) {
    this.calls.push("signatureStatuses");
    return signatures.map((s) => this.statuses.get(s) ?? null);
  }
}

/** An alerter that remembers what is firing. */
export class FakeAlerter {
  readonly fired: Alert[] = [];
  readonly firing = new Map<string, Alert>();
  fire(alert: Alert): void {
    this.fired.push(alert);
    this.firing.set(alert.key, alert);
  }
  clear(key: string): void {
    this.firing.delete(key);
  }
}
