// The journal made durable without rewriting it.
//
// THE PROBLEM. On Railway a container's filesystem does not survive a redeploy,
// and the SQLite journal lives on it. The records lost that way include
// unresolved INTENT rows — the ones startup recovery needs to resolve a
// settlement that was in flight when the process died.
//
// THE SHAPE OF THE FIX. Postgres holds the record stream; SQLite stays exactly
// as it is and is rebuilt from that stream at boot. Nothing in the 3,366 lines
// that actually refuse a double settlement is touched, because those refusals
// live in SQLite's eight partial unique indexes and three triggers, and they go
// on firing unchanged. Postgres is the durable log; SQLite is a local index
// derived from it.
//
// ORDER IS THE WHOLE DESIGN, AND IT IS NOT ARBITRARY.
//
//   1. SQLite first. Its constraints are the gate: an illegal record is refused
//      there, before anything is durable and before anything is broadcast.
//   2. Postgres second. When that write resolves, the record survives the
//      container.
//   3. Only then does append() return, and only then does the keeper act.
//
// Consider the crash windows that leaves:
//
//   * Between (1) and (2): the record is local-only and no broadcast has
//     happened, because the broadcast is downstream of append() returning. The
//     next container starts from the durable log, which does not contain it.
//     Nothing was sent, nothing is claimed. Correct.
//   * Between (2) and the broadcast: the INTENT is durable and nothing was sent.
//     Recovery resolves it against the chain, finds no transaction, and abandons
//     it. Correct.
//
// The reverse order — Postgres first — would put records in the durable log that
// the constraints then refuse, and the next boot would fail replaying its own
// history.
//
// IF THE MIRROR FAILS, THE KEEPER STOPS. A local record that could not be made
// durable means the log is behind the index, and every later decision would rest
// on a history the next container will not have. Continuing is how a settlement
// gets made twice.

import {
  Ledger,
  type JournalRead,
  type JournalRecord,
  type LedgerInstance,
  type LedgerState,
  type OpenLedgerOptions,
  type RecordBody,
  type RecordType,
} from "./ledger.js";
import type { JournalStore } from "./journal-store.js";
import { PostgresJournal, type StoredRecord } from "./ledger-pg.js";

export class MirrorWriteError extends Error {
  constructor(message: string, readonly cause: unknown) {
    super(message);
    this.name = "MirrorWriteError";
  }
}

export interface MirroredLedgerOptions {
  readonly connectionString: string;
  readonly dir: string;
  readonly instance: LedgerInstance;
  readonly noLock?: boolean;
  readonly forceUnlock?: boolean;
  /** Names this process in pg_stat_activity, so a blocked keeper can say who holds the lock. */
  readonly applicationName?: string;
}

/**
 * A Ledger whose history is durable.
 *
 * Reads delegate straight through to SQLite and stay SYNCHRONOUS, because
 * `ledger.state` is consulted at 47 call sites, usually as a property inside a
 * decision. Only the writes became asynchronous, and that await is precisely the
 * durability guarantee.
 */
export class MirroredLedger implements JournalStore {
  readonly #local: Ledger;
  readonly #remote: PostgresJournal;

  private constructor(local: Ledger, remote: PostgresJournal) {
    this.#local = local;
    this.#remote = remote;
  }

  static async open(options: MirroredLedgerOptions): Promise<MirroredLedger> {
    const remote = await PostgresJournal.open({
      connectionString: options.connectionString,
      instance: options.instance,
      ...(options.noLock === undefined ? {} : { noLock: options.noLock }),
      ...(options.applicationName === undefined
        ? {}
        : { applicationName: options.applicationName }),
    });

    try {
      const durable = remote.records;

      // REPLAYED WITH THEIR ORIGINAL TIMESTAMPS, not with the current clock. The
      // digest covers ts, so replaying with `new Date()` would produce a
      // different chain for the same history — the local index would disagree
      // with the durable log about what happened, which is worse than having no
      // index at all.
      let cursor = 0;
      const openOptions: OpenLedgerOptions = {
        dir: options.dir,
        instance: options.instance,
        ...(options.noLock === undefined ? {} : { noLock: options.noLock }),
        ...(options.forceUnlock === undefined ? {} : { forceUnlock: options.forceUnlock }),
        now: () => new Date(durable[cursor]?.ts ?? new Date().toISOString()),
      };
      const local = Ledger.open(openOptions);

      // Replaying through append() re-runs every constraint, so a history that
      // could not legally have happened is caught at boot rather than trusted.
      const already = local.readRecords().records.length;
      for (cursor = already; cursor < durable.length; cursor += 1) {
        const record = durable[cursor]!;
        local.append(record.type as JournalRecord["type"], record.body as never);
      }
      cursor = durable.length;

      const mirrored = new MirroredLedger(local, remote);
      mirrored.#assertChainsAgree();
      return mirrored;
    } catch (error) {
      await remote.close();
      throw error;
    }
  }

  /**
   * The local index must reproduce the durable log exactly.
   *
   * A mismatch means the replay produced a different history — a schema change,
   * a clock that leaked in, an edited row. Any of those makes the index a
   * different story from the log, and a keeper that decides from the wrong one
   * settles the wrong window.
   */
  #assertChainsAgree(): void {
    const local = this.#local.readRecords().records;
    const durable = this.#remote.records;
    if (local.length !== durable.length) {
      throw new Error(
        `Replay produced ${local.length} records from a durable log of ${durable.length}. ` +
          "The local index does not reproduce the log; refusing to run on either.",
      );
    }
    for (let i = 0; i < local.length; i += 1) {
      if (local[i]!.hash !== durable[i]!.digest) {
        throw new Error(
          `Replay diverges at record ${i}: local ${local[i]!.hash} vs durable ${durable[i]!.digest}. ` +
            "Refusing to run on a history the two stores disagree about.",
        );
      }
    }
  }

  /** Mirrors every local record the durable log does not yet have. */
  async #flush(): Promise<void> {
    const local = this.#local.readRecords().records;
    while (this.#remote.records.length < local.length) {
      const next = local[this.#remote.records.length]!;
      try {
        await this.#remote.appendRaw({
          seq: next.seq,
          ts: next.ts,
          type: next.type,
          prevDigest: next.prevHash,
          digest: next.hash,
          body: next.body as unknown as Record<string, unknown>,
        });
      } catch (error) {
        throw new MirrorWriteError(
          `Record ${next.seq} (${next.type}) was accepted locally but could not be made durable. ` +
            "The keeper is stopping: every later decision would rest on a history the next " +
            "container will not have.",
          error,
        );
      }
    }
  }

  // ---- writes: local first (the gate), then durable ----------------------

  async append<T extends RecordBody>(type: RecordType, body: T): Promise<JournalRecord<T>> {
    const record = this.#local.append(type, body);
    await this.#flush();
    return record;
  }

  /**
   * Refuses unless every local record is also durable.
   *
   * Called immediately before a broadcast. Without it, one missing `await` among
   * two dozen call sites would produce a settlement that moved real money and
   * left no record the next container can see — and nothing in this project
   * lints for a floating promise.
   */
  assertDurable(): void {
    const local = this.#local.readRecords().records.length;
    const durable = this.#remote.records.length;
    if (local !== durable) {
      throw new Error(
        `Refusing to broadcast: ${local - durable} record(s) are not durable yet ` +
          `(local ${local}, durable ${durable}). Sending now would move funds with no record ` +
          "the next container could recover from.",
      );
    }
  }

  /**
   * Why this journal is dead, or null while it is healthy.
   *
   * Surfaced so the supervisor can RELEASE the account rather than keep ticking
   * it. A held account whose connection died holds no advisory lock and can
   * write nothing, so leaving it in `held` means nobody settles for that user
   * and no other instance may take over — the outage looks like a claim.
   */
  get lost(): string | null {
    return this.#remote.lost;
  }

  get durableLocation(): string | null {
    return this.#remote.schema;
  }

  async ensureHeader(baseline: { settlementNonce: bigint; lifetimeContribution: bigint }): Promise<void> {
    this.#local.ensureHeader(baseline);
    await this.#flush();
  }

  /** The snapshot is a derived convenience file and is deliberately NOT mirrored. */
  writeSnapshot(extra: Record<string, unknown> = {}): void {
    this.#local.writeSnapshot(extra);
  }

  // ---- reads: straight through, and synchronous --------------------------

  get state(): LedgerState {
    return this.#local.state;
  }

  readRecords(): JournalRead {
    return this.#local.readRecords();
  }

  get journalPath(): string {
    return this.#local.journalPath;
  }

  get lockReclaimed(): Ledger["lockReclaimed"] {
    return this.#local.lockReclaimed;
  }

  get permissionWarnings(): readonly string[] {
    return this.#local.permissionWarnings;
  }

  async close(): Promise<void> {
    this.#local.close();
    await this.#remote.close();
  }
}
