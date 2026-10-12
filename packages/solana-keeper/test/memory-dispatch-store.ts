// The dispatcher's store (src/dispatch-store.ts) as a model in memory, for the
// worker's tests: the same four statements' rules over the same columns, on a
// clock the test owns. It is a MODEL, and the real thing is held to it where it
// matters: test/worker-pg.test.ts runs the same job proofs against the real
// store on Postgres 16, and test-local/fence-pg.local.test.ts proves the
// statements' races there.
//
// WHAT IT KEEPS FROM THE SQL, rule for rule:
//   * CLAIM — system 'queue', not parked, due, and free or with its lease run
//     out; by priority, then this holder's own last vaults, then due time; fence
//     + 1, a 45 s lease, attempts + 1;
//   * HEARTBEAT — only (vault, fence) pairs still this holder's, and none
//     claimed more than 6 minutes ago;
//   * GATE — the row still this holder's at this fence with more than 10 s of
//     lease left; the plan floor (plan_cleared_height above every earlier
//     fence's COALESCE(resolved_height, last_valid_block_height), NULL only when
//     there is none); a shadow store's rows are 'shadow' and its carries dropped;
//   * COMPLETE / RELEASE — only while still held at this fence; a bell rung after
//     the claim makes the vault due at once;
//   * the overlap audit, NULL-aware as the store's is.

import type {
  ClaimedVault,
  Completion,
  DispatchWorld,
  GateAnswer,
  GateCarry,
  HeldVault,
  IntentDraft,
  IntentOutcome,
  IntentState,
  OpenIntent,
  PriorIntents,
} from "../src/dispatch-store.js";
import { GATE_MARGIN_SECONDS, JOB_CEILING_MINUTES, LANE_PRIORITY, LEASE_SECONDS } from "../src/dispatch-store.js";

export interface MemoryVaultRow {
  vault: string;
  system: "legacy" | "draining" | "queue";
  skimMode: number | null;
  lane: string;
  priority: number;
  dueAt: number;
  rests: boolean;
  bellAt: number | null;
  holder: string | null;
  fence: bigint;
  leaseUntil: number | null;
  claimedAt: number | null;
  lastHolder: string | null;
  attempts: number;
  lastOutcome: string | null;
  lastDetail: string | null;
  streaks: Record<string, unknown>;
  parkedReason: string | null;
}

export interface MemoryIntent {
  readonly id: bigint;
  readonly vault: string;
  readonly link: string | null;
  readonly kind: IntentDraft["kind"];
  readonly fence: bigint;
  readonly worker: string;
  readonly blockhash: string;
  readonly lastValidBlockHeight: bigint;
  readonly planClearedHeight: bigint | null;
  signature: string | null;
  readonly idempotencyKey: string | null;
  readonly amountRaw: bigint | null;
  state: IntentState;
  resolvedHeight: bigint | null;
  resolvedAt: number | null;
}

/** A carry the gate wrote: what the real store's loss_carry row would hold. */
export interface MemoryCarry {
  readonly link: string;
  readonly fence: bigint;
  readonly intentId: bigint;
  readonly endSlot: bigint;
  readonly lossLamports: bigint | null;
}

/** The database every store of a test shares, and its clock. */
export class MemoryDb {
  readonly vaults = new Map<string, MemoryVaultRow>();
  readonly intents: MemoryIntent[] = [];
  readonly carries: MemoryCarry[] = [];
  readonly links = new Map<string, string[]>();
  readonly gateCalls: { form: "transaction" | "one-statement"; draft: IntentDraft; carry: GateCarry | null; answer: GateAnswer["kind"] }[] = [];
  boardDirty = 0;
  /** Set to make every statement throw, as a database that is down. */
  down = false;
  #nextId = 1n;

  constructor(public now: number = 1_700_000_000_000) {}

  advance(ms: number): void {
    this.now += ms;
  }

  /** A vault on the queue, due now, free. */
  addVault(vault: string, over: Partial<MemoryVaultRow> = {}): MemoryVaultRow {
    const row: MemoryVaultRow = {
      vault,
      system: "queue",
      skimMode: 0,
      lane: "new",
      priority: LANE_PRIORITY.new,
      dueAt: this.now,
      rests: false,
      bellAt: null,
      holder: null,
      fence: 0n,
      leaseUntil: null,
      claimedAt: null,
      lastHolder: null,
      attempts: 0,
      lastOutcome: null,
      lastDetail: null,
      streaks: {},
      parkedReason: null,
      ...over,
    };
    this.vaults.set(vault, row);
    return row;
  }

  nextId(): bigint {
    const id = this.#nextId;
    this.#nextId += 1n;
    return id;
  }

  overlapAudit(): bigint[] {
    const rows: bigint[] = [];
    for (const a of this.intents) {
      for (const b of this.intents) {
        if (b.vault !== a.vault || b.fence <= a.fence) continue;
        const bound = a.resolvedHeight ?? a.lastValidBlockHeight;
        if ((b.planClearedHeight ?? -1n) <= bound) rows.push(b.id);
      }
    }
    return rows;
  }
}

/** One process's store over the shared MemoryDb. */
export class MemoryDispatchStore {
  constructor(
    readonly db: MemoryDb,
    readonly holder: string,
    readonly world: DispatchWorld = "live",
  ) {}

  #check(): void {
    if (this.db.down) throw new Error("connect ECONNREFUSED (the test's database is down)");
  }

  async claim(slots: number): Promise<readonly ClaimedVault[]> {
    this.#check();
    const now = this.db.now;
    const due = [...this.db.vaults.values()]
      .filter((row) => row.system === "queue" && row.parkedReason === null && row.dueAt <= now && (row.holder === null || (row.leaseUntil ?? 0) < now))
      .sort((a, b) => a.priority - b.priority || Number(b.lastHolder === this.holder) - Number(a.lastHolder === this.holder) || a.dueAt - b.dueAt)
      .slice(0, slots);
    return due.map((row) => {
      row.holder = this.holder;
      row.fence += 1n;
      row.claimedAt = now;
      row.leaseUntil = now + LEASE_SECONDS * 1_000;
      row.attempts += 1;
      return { vault: row.vault, fence: row.fence, lane: row.lane, skimMode: row.skimMode, streaks: { ...row.streaks }, attempts: row.attempts };
    });
  }

  async heartbeat(held: readonly HeldVault[]): Promise<ReadonlySet<string>> {
    this.#check();
    const now = this.db.now;
    const renewed = new Set<string>();
    for (const { vault, fence } of held) {
      const row = this.db.vaults.get(vault);
      if (row === undefined || row.holder !== this.holder || row.fence !== fence) continue;
      if ((row.claimedAt ?? 0) <= now - JOB_CEILING_MINUTES * 60_000) continue;
      row.leaseUntil = now + LEASE_SECONDS * 1_000;
      renewed.add(vault);
    }
    return renewed;
  }

  #gate(intent: IntentDraft, form: "transaction" | "one-statement", carry: GateCarry | null): GateAnswer {
    if (this.db.down) return { kind: "unavailable", detail: "the gate failed before it committed (the test's database is down); nothing was sent" };
    const row = this.db.vaults.get(intent.vault);
    const now = this.db.now;
    const held = row !== undefined && row.holder === this.holder && row.fence === intent.fence && (row.leaseUntil ?? 0) > now + GATE_MARGIN_SECONDS * 1_000;
    if (!held) return { kind: "refused", reason: "lease", detail: `vault ${intent.vault} is no longer held at fence ${intent.fence}` };
    const earlier = this.db.intents.filter((other) => other.vault === intent.vault && other.fence < intent.fence);
    const floor = earlier.length === 0 ? null : earlier.reduce((max, other) => {
      const bound = other.resolvedHeight ?? other.lastValidBlockHeight;
      return bound > max ? bound : max;
    }, -1n);
    const cleared = floor === null || (intent.planClearedHeight !== null && intent.planClearedHeight > floor);
    if (!cleared) return { kind: "refused", reason: "plan-floor", detail: `planned with ${intent.planClearedHeight} under the floor ${floor}` };
    const id = this.db.nextId();
    this.db.intents.push({
      id,
      vault: intent.vault,
      link: intent.link,
      kind: intent.kind,
      fence: intent.fence,
      worker: this.holder,
      blockhash: intent.blockhash,
      lastValidBlockHeight: intent.lastValidBlockHeight,
      planClearedHeight: intent.planClearedHeight,
      signature: intent.signature,
      idempotencyKey: intent.idempotencyKey,
      amountRaw: intent.amountRaw,
      state: this.world === "shadow" ? "shadow" : "intent",
      resolvedHeight: null,
      resolvedAt: null,
    });
    const written = this.world === "shadow" ? null : carry;
    if (written !== null) {
      this.db.carries.push({
        link: written.link.linkAddress.toBase58(),
        fence: intent.fence,
        intentId: id,
        endSlot: written.endSlot,
        lossLamports: written.carry?.lossLamports ?? null,
      });
    }
    void form;
    return { kind: "gated", intentId: id, carryWritten: written !== null };
  }

  async gate(intent: IntentDraft, options: { readonly carry?: GateCarry | null } = {}): Promise<GateAnswer> {
    const carry = options.carry ?? null;
    if (carry !== null && (intent.kind !== "settle" || intent.link !== carry.link.linkAddress.toBase58())) {
      throw new Error("a carry is written only with the settle of its own link");
    }
    const answer = this.#gate(intent, "transaction", carry);
    this.db.gateCalls.push({ form: "transaction", draft: intent, carry, answer: answer.kind });
    return answer;
  }

  async gateOneStatement(intent: IntentDraft): Promise<GateAnswer> {
    const answer = this.#gate(intent, "one-statement", null);
    this.db.gateCalls.push({ form: "one-statement", draft: intent, carry: null, answer: answer.kind });
    return answer;
  }

  async complete(held: HeldVault, done: Completion): Promise<boolean> {
    this.#check();
    const row = this.db.vaults.get(held.vault);
    if (row === undefined || row.holder !== this.holder || row.fence !== held.fence) return false;
    const now = this.db.now;
    row.holder = null;
    row.leaseUntil = null;
    row.lastHolder = this.holder;
    row.attempts = 0;
    row.rests = done.rests;
    row.lane = done.lane;
    row.priority = done.priority ?? LANE_PRIORITY[done.lane];
    row.streaks = { ...done.streaks };
    row.lastOutcome = done.outcome;
    row.lastDetail = done.detail;
    row.dueAt = row.bellAt !== null && row.claimedAt !== null && row.bellAt > row.claimedAt ? now : now + done.dueInSeconds * 1_000;
    return true;
  }

  async release(claimed: ClaimedVault, reason: string): Promise<boolean> {
    const lane = (Object.hasOwn(LANE_PRIORITY, claimed.lane) ? claimed.lane : "new") as Completion["lane"];
    return this.complete(claimed, { rests: false, lane, streaks: claimed.streaks, outcome: "RELEASED", detail: reason, dueInSeconds: 0 });
  }

  async priorIntents(held: HeldVault): Promise<PriorIntents> {
    this.#check();
    const earlier = this.db.intents.filter((intent) => intent.vault === held.vault && intent.fence < held.fence);
    const open: OpenIntent[] = earlier
      .filter((intent) => intent.resolvedAt === null)
      .map((intent) => ({
        id: intent.id,
        vault: intent.vault,
        link: intent.link,
        kind: intent.kind,
        fence: intent.fence,
        worker: intent.worker,
        blockhash: intent.blockhash,
        lastValidBlockHeight: intent.lastValidBlockHeight,
        planClearedHeight: intent.planClearedHeight,
        signature: intent.signature,
        idempotencyKey: intent.idempotencyKey,
        amountRaw: intent.amountRaw,
        state: intent.state,
      }));
    const planFloor = earlier.length === 0 ? null : earlier.reduce((max, intent) => {
      const bound = intent.resolvedHeight ?? intent.lastValidBlockHeight;
      return bound > max ? bound : max;
    }, -1n);
    return { open, planFloor };
  }

  async resolveIntent(id: bigint, outcome: IntentOutcome, resolvedHeight: bigint | null): Promise<boolean> {
    this.#check();
    const intent = this.db.intents.find((candidate) => candidate.id === id);
    if (intent === undefined || intent.resolvedAt !== null) return false;
    intent.state = intent.state === "shadow" ? "shadow" : outcome;
    intent.resolvedHeight = resolvedHeight;
    intent.resolvedAt = this.db.now;
    return true;
  }

  async recordSignature(id: bigint, signature: string): Promise<boolean> {
    this.#check();
    const intent = this.db.intents.find((candidate) => candidate.id === id);
    if (intent === undefined || intent.signature !== null) return false;
    intent.signature = signature;
    return true;
  }

  async overlapAudit(): Promise<readonly bigint[]> {
    return this.db.overlapAudit();
  }

  async linksOf(vault: string): Promise<readonly string[]> {
    this.#check();
    return [...(this.db.links.get(vault) ?? [])].sort();
  }

  async markBoardDirty(): Promise<void> {
    this.#check();
    this.db.boardDirty += 1;
  }
}
