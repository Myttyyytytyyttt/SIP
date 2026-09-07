// One interface, two backings: local-only, and local mirrored to Postgres.
//
// The keeper does not care which it has. What it cares about is that when an
// append resolves, the record will still exist for whatever process runs next —
// and with a local-only store on an ephemeral filesystem, that is simply untrue.
//
// WRITES ARE ASYNCHRONOUS EVEN LOCALLY. The local adapter's append resolves
// immediately; it is still declared async so that both backings present the same
// shape and the call sites do not have to know which one they have. A store that
// was sync in one configuration and async in another would mean the awaits are
// only exercised when Postgres is configured — that is, never in the test run
// most likely to catch a mistake.
//
// THE DURABILITY ASSERTION IS THE POINT, NOT THE AWAITS. Nothing in this project
// lints for floating promises, so a missing `await` would compile, run, and
// silently leave a record undurable. Rather than depend on 24 call sites all
// being right, `assertDurable()` exists to be called at the ONE place where the
// consequence lands: immediately before a transaction is broadcast. If the
// durable log is behind the local index there, the keeper refuses to send —
// which turns a silent loss into a loud refusal.

import type { JournalRead, JournalRecord, Ledger, LedgerState, RecordBody, RecordType } from "./ledger.js";

/**
 * Sync or async, because both backings are legitimate.
 *
 * The local store completes its write before returning; the mirrored one cannot,
 * because durability is a network round trip. Callers `await` either way —
 * awaiting a plain value is a no-op — and using the result WITHOUT awaiting is a
 * type error, because a union has none of the record's properties.
 */
type MaybeAsync<T> = T | Promise<T>;

export interface JournalStore {
  append<T extends RecordBody>(type: RecordType, body: T): MaybeAsync<JournalRecord<T>>;
  ensureHeader(baseline: { settlementNonce: bigint; lifetimeContribution: bigint }): MaybeAsync<void>;
  writeSnapshot(extra?: Record<string, unknown>): void;

  readonly state: LedgerState;
  readRecords(): JournalRead;
  readonly journalPath: string;
  readonly lockReclaimed: Ledger["lockReclaimed"];
  readonly permissionWarnings: readonly string[];

  /**
   * Throws unless every local record is also durable.
   *
   * Call this immediately before broadcasting. It is cheap — a length
   * comparison — and it is the difference between "a settlement nobody has a
   * record of" and "a keeper that refused to send".
   */
  assertDurable(): void;

  /** Where the durable copy lives, for logs. Null when there is none. */
  readonly durableLocation: string | null;

  /**
   * Why this journal's connection died, or null while it is healthy.
   *
   * Always null for a local-only store: a file has no connection to lose.
   */
  readonly lost: string | null;

  close(): MaybeAsync<void>;
}

/**
 * The store as it has always been: one SQLite file, and nothing else.
 *
 * Correct on a machine whose disk outlives the process. On Railway it is not,
 * which is why the mirrored backing exists — but this remains the right choice
 * for local development and for the tests, where a network round trip per record
 * would buy nothing.
 */
export class LocalJournalStore implements JournalStore {
  constructor(private readonly ledger: Ledger) {}

  async append<T extends RecordBody>(type: RecordType, body: T): Promise<JournalRecord<T>> {
    return this.ledger.append(type, body);
  }

  async ensureHeader(baseline: { settlementNonce: bigint; lifetimeContribution: bigint }): Promise<void> {
    this.ledger.ensureHeader(baseline);
  }

  writeSnapshot(extra: Record<string, unknown> = {}): void {
    this.ledger.writeSnapshot(extra);
  }

  get state(): LedgerState {
    return this.ledger.state;
  }

  readRecords(): JournalRead {
    return this.ledger.readRecords();
  }

  get journalPath(): string {
    return this.ledger.journalPath;
  }

  get lockReclaimed(): Ledger["lockReclaimed"] {
    return this.ledger.lockReclaimed;
  }

  get permissionWarnings(): readonly string[] {
    return this.ledger.permissionWarnings;
  }

  /** Nothing to be behind: the only copy is the one being written. */
  assertDurable(): void {}

  get durableLocation(): string | null {
    return null;
  }

  /** A file has no connection to lose. */
  get lost(): string | null {
    return null;
  }

  async close(): Promise<void> {
    this.ledger.close();
  }
}
