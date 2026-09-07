// The durable store, and the one thing it exists to make impossible.
//
// THE PROPERTY UNDER TEST is not "the database accepts the right rows". It is:
// after ANY sequence of events — a rebind, a crash mid-transaction, a second
// process, a wiped volume, an operator with sqlite3 — the store either refuses a
// window that is already covered, or it can prove the window is new. It never
// invents a settlement that did not happen, and it never forgets one that did.
//
// The most important block in this file is "a bindingEpoch rebind". Every one of
// those cases PASSED against the previous JSONL store: its boundaries were keyed
// on bindingEpoch, so a rebind handed it an empty namespace and the whole settled
// history became replayable. They are written here against a FRESH epoch and a
// FRESH sessionId every time, because that is exactly the shape the defect took.

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { MAINNET } from "../src/config.js";
import {
  ENGINE_SCHEMA,
  LEDGER_SCHEMA,
  Ledger,
  LedgerConstraintError,
  LedgerIdentityError,
  LedgerLockedError,
  LedgerWriteError,
  localEligibility,
  probeStoreFile,
  windowKey,
  type ConfirmedBody,
  type IntentBody,
  type LedgerInstance,
} from "../src/ledger.js";

const require = createRequire(import.meta.url);

const ACCOUNT = "0xc455bF7f16ebbc2b07cb26D1Dd46194977974E7d";
const VAULT = "0x0b5036063527bA4e32032e1b6B953c3677386BBD";

// DERIVED FROM THE CONSTANTS, NOT TRANSCRIBED ALONGSIDE THEM. The CLI tests
// below spawn `keeper status` against a store built from this, and the CLI
// resolves its own addresses from config.ts. Written out by hand, the two drift
// apart on the next redeployment and every one of those tests fails with an
// identity mismatch that has nothing to do with what it was testing — which is
// exactly what happened when these constants were last corrected.
const INSTANCE: LedgerInstance = {
  chainId: MAINNET.chainId,
  factory: MAINNET.factory,
  executor: MAINNET.executor,
  vault: VAULT,
  account: ACCOUNT,
  ledgerSchema: LEDGER_SCHEMA,
  engineSchema: ENGINE_SCHEMA,
};

const dirs: string[] = [];
const openLedgers: Ledger[] = [];
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "nuvem-keeper-"));
  dirs.push(dir);
  return dir;
}
function openIn(dir: string): Ledger {
  const ledger = Ledger.open({ dir, instance: INSTANCE, noLock: true });
  openLedgers.push(ledger);
  return ledger;
}

/**
 * A GENUINE SQLite write-ahead log, built from a throwaway database.
 *
 * The store itself is journal_mode=DELETE and therefore never produces one — that
 * is the whole point of the mode, since a -wal paired with the wrong .db rewinds
 * the settled history while passing every integrity check.
 *
 * But the shapes below must still be refused: a store an OLDER, WAL-mode build
 * created and left behind, or a file someone planted. Those are real bytes, so
 * the fixture is real bytes too rather than a plausible-looking blob — a probe
 * that only recognised a blob would pass this test and miss the real thing.
 */
function walDonor(sibling: "-wal" | "-shm"): Buffer {
  const scratch = freshDir();
  const path = join(scratch, "donor.db");
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
    DatabaseSync: new (p: string) => { exec(sql: string): void; close(): void };
  };
  const donor = new DatabaseSync(path);
  donor.exec("PRAGMA journal_mode = WAL");
  donor.exec("CREATE TABLE t(a INTEGER PRIMARY KEY, b TEXT)");
  // Enough rows to spill real frames; captured while the connection is OPEN,
  // because close() checkpoints them away.
  for (let i = 0; i < 64; i++) donor.exec(`INSERT INTO t VALUES (${i}, 'frame-${i}')`);
  const bytes = readFileSync(`${path}${sibling}`);
  donor.close();
  return bytes;
}
const syntheticWal = () => walDonor("-wal");
const syntheticShm = () => walDonor("-shm");
afterEach(() => {
  // Windows will not unlink an open database file, so every handle is closed
  // before the directory goes.
  while (openLedgers.length > 0) {
    try {
      openLedgers.pop()?.close();
    } catch {
      /* already closed */
    }
  }
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/** The real canary settlement's numbers, so no shape here is invented. */
const confirmed = (over: Partial<ConfirmedBody> = {}): ConfirmedBody => ({
  startBlockL2: 22080592n,
  endBlockL2: 22080850n,
  sessionId: "0xaaaa000000000000000000000000000000000000000000000000000000000001",
  bindingEpoch: 1n,
  settlementNonce: 0n,
  startBlockL1: 25635381n,
  endBlockL1: 25635384n,
  ledgerRoot: "0xbbbb000000000000000000000000000000000000000000000000000000000001",
  contribution: 403370889498747n,
  realizedProfit: 2016854447493738n,
  txHash: "0xd342d117000000000000000000000000000000000000000000000000000cad186",
  blockNumberL2: 22086130n,
  gasUsed: 516254n,
  source: "own",
  ...over,
});

const intent = (over: Partial<IntentBody> = {}): IntentBody => ({
  startBlockL2: 22090000n,
  endBlockL2: 22090500n,
  sessionId: "0xcccc000000000000000000000000000000000000000000000000000000000001",
  bindingEpoch: 1n,
  settlementNonce: 1n,
  startBlockL1: 25641000n,
  endBlockL1: 25641004n,
  ledgerRoot: "0xdddd000000000000000000000000000000000000000000000000000000000001",
  contribution: 1000000000000n,
  realizedProfit: 5000000000000n,
  attestationDigest: "0xeeee000000000000000000000000000000000000000000000000000000000001",
  attester: "0x864743540b6D6E0a38f535e1200c0373e0D7AAde",
  eoaNonce: 75,
  rawTxHash: "0xffff000000000000000000000000000000000000000000000000000000000001",
  gasLimit: 620000n,
  maxFeePerGas: 28050000n,
  validAfter: 1_700_000_000,
  deadline: 1_700_000_600,
  cashStart: 10n,
  cashEnd: 20n,
  externalDeposits: 0n,
  externalWithdrawals: 0n,
  ...over,
});

const LIMITS = { maxSettlementsPerDay: 8 };

/** Record bodies carry bigints, so they need a replacer to be stringified. */
const asText = (value: unknown): string =>
  JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));

// ---------------------------------------------------------------------------

describe("Ledger basics", () => {
  it("round-trips bigints through the store exactly", () => {
    // Wei-scale values exceed 2^63, so no SQLite INTEGER column may ever hold
    // one. They are decimal TEXT, and they must come back as the same bigint.
    const dir = freshDir();
    const ledger = openIn(dir);
    ledger.ensureHeader({ settlementNonce: 1n, lifetimeContribution: 403370889498747n });
    ledger.append("CONFIRMED", confirmed());
    ledger.close();

    const reopened = openIn(dir);
    const record = reopened.state.confirmedRecords[0];
    expect(record?.body.contribution).toBe(403370889498747n);
    expect(record?.body.realizedProfit).toBe(2016854447493738n);
    expect(reopened.state.header?.baselineSettlementNonce).toBe(1n);
    expect(reopened.state.settledFrontierL2).toBe(22080850n);
    expect(reopened.state.settledContributionWei).toBe(403370889498747n);
    expect(reopened.state.integrityOk).toBe(true);
  });

  it("holds a wei value larger than 2^63 without loss, which an INTEGER column could not", () => {
    // node:sqlite throws "BigInt value is too large to bind" at 2^64, and silently
    // wraps nothing in between — so a whale's settlement would have been the first
    // thing to break, long after the canary's small numbers passed every test.
    const huge = 2n ** 200n + 12345n;
    const dir = freshDir();
    const ledger = openIn(dir);
    ledger.append("CONFIRMED", confirmed({ contribution: huge, realizedProfit: -(2n ** 90n) }));
    ledger.close();

    const reopened = openIn(dir);
    expect(reopened.state.settledContributionWei).toBe(huge);
    expect(reopened.state.confirmedRecords[0]?.body.realizedProfit).toBe(-(2n ** 90n));
  });

  it("stays readable by eye: the record stream is a public, ordered, decoded query", () => {
    // The JSONL store's stated decisive advantage was `cat` during an incident.
    // That is revoked at the file level, so it has to be re-satisfied here and at
    // `keeper journal`: every record, in order, with a decoded body.
    const dir = freshDir();
    const ledger = openIn(dir);
    ledger.ensureHeader({ settlementNonce: 0n, lifetimeContribution: 0n });
    ledger.append("CONFIRMED", confirmed());
    const { records, integrityOk } = ledger.readRecords();
    ledger.close();

    expect(integrityOk).toBe(true);
    expect(records.map((r) => r.type)).toEqual(["HEADER", "CONFIRMED"]);
    expect(records.map((r) => r.seq)).toEqual([0, 1]);
    // The wei value is legible as a decimal string, exactly as it was in JSONL.
    expect(asText(records[1]?.body)).toContain('"contribution":"403370889498747"');
  });

  it("puts chainId, vault and account in the FILENAME, so a mis-pointed volume shows up in `ls`", () => {
    const dir = freshDir();
    const ledger = openIn(dir);
    expect(ledger.journalPath).toContain("keeper-4663-0x0b503606-0xc455bf7f.db");
    expect(ledger.snapshotPath).toContain("snapshot-4663-0x0b503606-0xc455bf7f.json");
    ledger.close();
  });

  it("refuses to reuse a state directory created for a different deployment", () => {
    const dir = freshDir();
    openIn(dir).close();
    expect(() => Ledger.open({ dir, instance: { ...INSTANCE, chainId: 46630 }, noLock: true })).toThrow(
      LedgerIdentityError,
    );
    expect(() => Ledger.open({ dir, instance: { ...INSTANCE, account: VAULT }, noLock: true })).toThrow(
      LedgerIdentityError,
    );
    // String fields compare case-insensitively; it never migrates and never
    // rewrites instance.json to make the message go away.
    const same = Ledger.open({ dir, instance: { ...INSTANCE, vault: VAULT.toUpperCase() }, noLock: true });
    same.close();
  });

  it("refuses a store written with a different schema version, and never migrates it", () => {
    const dir = freshDir();
    const ledger = openIn(dir);
    const path = ledger.journalPath;
    ledger.close();

    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    const db = new DatabaseSync(path);
    db.prepare("INSERT INTO schema_version (version, applied_at, description) VALUES (99, '2026', 'from the future')").run();
    db.close();

    expect(() => Ledger.open({ dir, instance: INSTANCE, noLock: true })).toThrow(LedgerIdentityError);
    expect(() => Ledger.open({ dir, instance: INSTANCE, noLock: true })).toThrow(/refusing to migrate in place/i);
  });

  it("writes the snapshot atomically and treats its loss as non-fatal", () => {
    const dir = freshDir();
    const ledger = openIn(dir);
    ledger.ensureHeader({ settlementNonce: 0n, lifetimeContribution: 0n });
    ledger.append("CONFIRMED", confirmed());
    ledger.writeSnapshot();
    const snapshot = JSON.parse(readFileSync(ledger.snapshotPath, "utf8")) as Record<string, unknown>;
    // The accounting an operator can check by eye during an incident.
    expect(snapshot.journalSeq).toBe(1);
    expect(snapshot.settledFrontierL2).toBe("22080850");
    expect(snapshot.settledSettlementNonces).toEqual(["0"]);
    expect(snapshot.acknowledgedNonceFloor).toBe("0");
    expect(snapshot.integrityOk).toBe(true);
    expect(snapshot.coverageUnresolved).toBe(0);
    ledger.close();

    // Destroy the snapshot entirely by name; state must rebuild from the store.
    rmSync(join(dir, "snapshot-4663-0x0b503606-0xc455bf7f.json"), { force: true });
    const reopened = openIn(dir);
    expect(reopened.state.settledFrontierL2).toBe(22080850n);
    reopened.close();
  });

  it("append returns the record it wrote, including its assigned seq", () => {
    // The acknowledgement ceremony rests on this: --acknowledge-degraded names a
    // seq, and the DEGRADED/RESUMED pairing is built from the returned value.
    const dir = freshDir();
    const ledger = openIn(dir);
    const first = ledger.append("DEGRADED", { reason: "X", detail: "y" });
    expect(first.seq).toBe(0);
    expect(first.type).toBe("DEGRADED");
    expect(ledger.state.degraded?.seq).toBe(first.seq);
    const second = ledger.append("RESUMED", { acknowledgedSeq: first.seq, note: "n" });
    expect(second.seq).toBe(1);
    ledger.close();
  });

  it("takes its timestamps from an injectable clock", () => {
    const dir = freshDir();
    const at = new Date("2026-07-30T12:00:00.000Z");
    const ledger = Ledger.open({ dir, instance: INSTANCE, noLock: true, now: () => at });
    openLedgers.push(ledger);
    const record = ledger.append("CONFIRMED", confirmed());
    expect(record.ts).toBe(at.toISOString());
    expect(ledger.state.confirmedAtMs).toEqual([at.getTime()]);
    ledger.close();
  });

  it("holds no key material: an INTENT carries the attester ADDRESS and nothing more", () => {
    const dir = freshDir();
    const ledger = openIn(dir);
    ledger.append("INTENT", intent());
    const text = asText(ledger.readRecords().records);
    ledger.close();
    expect(text).toContain("0x864743540b6D6E0a38f535e1200c0373e0D7AAde");
    for (const key of ["privateKey", "signature", "rpcUrl", "apiKey", "0x4c0883a69102937d"]) {
      expect(text).not.toContain(key);
    }
  });
});

// ---------------------------------------------------------------------------
// THE REASON THIS REWRITE WAS AUTHORISED
// ---------------------------------------------------------------------------
describe("a bindingEpoch rebind does not re-arm the replay", () => {
  /**
   * The canary window, settled under bindingEpoch 1. Every attack below arrives
   * under bindingEpoch 2 with a brand new sessionId, which is exactly what an
   * admin pause/resume plus a re-derivation produces — and which the old
   * epoch-keyed maps waved straight through.
   */
  const seedCanary = (ledger: Ledger): void => {
    ledger.ensureHeader({ settlementNonce: 0n, lifetimeContribution: 0n });
    ledger.append("CONFIRMED", confirmed());
  };

  const rebound = (over: Record<string, bigint | string>) => ({
    startBlockL2: 22080592n,
    endBlockL2: 22080850n,
    startBlockL1: 25635381n,
    endBlockL1: 25635384n,
    bindingEpoch: 2n,
    sessionId: "0x259ef15b491b09f13f6e782aa76d7a4de101d7fced859393113dcc6921ea07f4",
    ...over,
  });

  it("refuses an exact replay under a new epoch and a new sessionId", () => {
    const dir = freshDir();
    const ledger = openIn(dir);
    seedCanary(ledger);
    const candidate = rebound({});
    // Neither of the epoch-scoped signals sees anything wrong.
    expect(ledger.state.settledSessionIds.has(candidate.sessionId)).toBe(false);
    expect(ledger.state.chainGuardL1.get("2")).toBeUndefined();
    // The epoch-INDEPENDENT frontier does.
    const verdict = localEligibility(ledger.state, candidate, LIMITS, Date.now());
    ledger.close();
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.rule).toBe("PROGRESSION_L2");
  });

  it("refuses a SUBSET of a settled window under a new epoch", () => {
    // The nastiest shape, and the one a bare UNIQUE(account, start, end) accepts:
    // re-running the engine after a rebind with a tighter replay start yields a
    // strictly narrower window over the same profitable trades.
    const dir = freshDir();
    const ledger = openIn(dir);
    seedCanary(ledger);
    const verdict = localEligibility(
      ledger.state,
      rebound({ startBlockL2: 22080600n, endBlockL2: 22080700n }),
      LIMITS,
      Date.now(),
    );
    ledger.close();
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.rule).toBe("PROGRESSION_L2");
  });

  it("refuses an OVERLAP and a SUPERSET of a settled window under a new epoch", () => {
    const dir = freshDir();
    const ledger = openIn(dir);
    seedCanary(ledger);
    for (const window of [
      { startBlockL2: 22080700n, endBlockL2: 22080900n }, // right overlap
      { startBlockL2: 22080000n, endBlockL2: 22081000n }, // superset
      { startBlockL2: 22080592n, endBlockL2: 22080850n }, // exact
    ]) {
      const verdict = localEligibility(ledger.state, rebound(window), LIMITS, Date.now());
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.rule).toBe("PROGRESSION_L2");
    }
    ledger.close();
  });

  it("THE SCHEMA REFUSES IT TOO, even if every application rule were wrong", () => {
    // This is the whole point of moving the guard into the database. Not one of
    // these inserts consults localEligibility, and every one of them is refused.
    const dir = freshDir();
    const ledger = openIn(dir);
    seedCanary(ledger);

    for (const [label, window] of [
      ["exact replay", { startBlockL2: 22080592n, endBlockL2: 22080850n }],
      ["subset", { startBlockL2: 22080600n, endBlockL2: 22080700n }],
      ["right overlap", { startBlockL2: 22080700n, endBlockL2: 22080900n }],
      ["superset", { startBlockL2: 22080000n, endBlockL2: 22081000n }],
    ] as const) {
      let thrown: unknown = null;
      try {
        ledger.append(
          "CONFIRMED",
          confirmed({
            ...window,
            bindingEpoch: 2n,
            settlementNonce: 5n,
            sessionId: "0x9999000000000000000000000000000000000000000000000000000000000001",
            txHash: "0x9999000000000000000000000000000000000000000000000000000000000002",
          }),
        );
      } catch (error) {
        thrown = error;
      }
      expect(thrown, label).toBeInstanceOf(LedgerConstraintError);
      expect((thrown as LedgerConstraintError).rule, label).toBe("REPLAY");
    }
    // And the store is unchanged: exactly one settlement, at the original window.
    expect(ledger.state.settlementCount).toBe(1);
    expect(ledger.state.settledFrontierL2).toBe(22080850n);
    ledger.close();
  });

  it("REGRESSION: BOTH LAYERS STILL REFUSE A REBIND REPLAY, and the store stays intact", () => {
    // THE HEADLINE DEFECT, RE-PROVED AFTER THE DAMAGE WORK. The three-state store,
    // the decision-table reconciliation and the write-path integrity assertion all
    // touch the frontier — the reconciliation walks the very prev_end_block_l2
    // chain the dedup is built on — so this is the test that says none of it moved.
    //
    // Both independent layers are asserted here, together, in the order they fire:
    //   LAYER 1  localEligibility, rule PROGRESSION_L2 (epoch-independent)
    //   LAYER 2  the SCHEMA, LedgerConstraintError rule REPLAY, with no application
    //            rule consulted at all
    const dir = freshDir();
    const ledger = openIn(dir);
    seedCanary(ledger);
    expect(ledger.state.settledFrontierL2).toBe(22080850n);
    expect(ledger.state.integrityOk).toBe(true);
    expect(ledger.state.condition).toBe("HEALTHY");

    // Reopened, so both layers are read back off disk rather than out of a cache —
    // and so the new reconciliation runs over a real, healthy frontier chain.
    ledger.close();
    const reopened = openIn(dir);
    expect(reopened.state.integrityOk).toBe(true);
    expect(reopened.state.settledFrontierL2).toBe(22080850n);

    for (const [label, window] of [
      ["exact replay", { startBlockL2: 22080592n, endBlockL2: 22080850n }],
      ["subset", { startBlockL2: 22080600n, endBlockL2: 22080700n }],
      ["right overlap", { startBlockL2: 22080700n, endBlockL2: 22080900n }],
      ["superset", { startBlockL2: 22080000n, endBlockL2: 22081000n }],
      ["left overlap", { startBlockL2: 22080100n, endBlockL2: 22080600n }],
    ] as const) {
      // LAYER 1 — the polite half.
      const verdict = localEligibility(reopened.state, rebound(window), LIMITS, Date.now());
      expect(verdict.ok, `${label} (layer 1)`).toBe(false);
      if (!verdict.ok) expect(verdict.rule, `${label} (layer 1)`).toBe("PROGRESSION_L2");

      // LAYER 2 — the half with no way around it. Nothing below consults layer 1.
      let thrown: unknown = null;
      try {
        reopened.append(
          "CONFIRMED",
          confirmed({
            ...window,
            bindingEpoch: 7n,
            settlementNonce: 9n,
            sessionId: "0x7777000000000000000000000000000000000000000000000000000000000001",
            txHash: "0x7777000000000000000000000000000000000000000000000000000000000002",
          }),
        );
      } catch (error) {
        thrown = error;
      }
      expect(thrown, `${label} (layer 2)`).toBeInstanceOf(LedgerConstraintError);
      expect((thrown as LedgerConstraintError).rule, `${label} (layer 2)`).toBe("REPLAY");
    }

    // Nothing was recorded, the frontier did not move, and the store is still a
    // complete, unedited record of what this keeper did.
    expect(reopened.state.settlementCount).toBe(1);
    expect(reopened.state.settledFrontierL2).toBe(22080850n);
    expect(reopened.state.integrityOk).toBe(true);
    expect(reopened.state.integrityDetail).toBeNull();
    expect(reopened.state.condition).toBe("HEALTHY");
    // And the one genuinely new session after the rebind is STILL settleable:
    // fail-closed must not mean fail-always.
    expect(
      localEligibility(
        reopened.state,
        rebound({ startBlockL2: 22080851n, endBlockL2: 22080900n, startBlockL1: 25635385n, endBlockL1: 25635390n }),
        LIMITS,
        Date.now(),
      ).ok,
    ).toBe(true);
  });

  it("ALLOWS the one genuinely new session after a rebind", () => {
    // Fail-closed must not mean fail-always. A session strictly above the
    // frontier is settleable, whatever the epoch says.
    const dir = freshDir();
    const ledger = openIn(dir);
    seedCanary(ledger);
    const verdict = localEligibility(
      ledger.state,
      rebound({ startBlockL2: 22080851n, endBlockL2: 22080900n, startBlockL1: 25635385n, endBlockL1: 25635390n }),
      LIMITS,
      Date.now(),
    );
    expect(verdict.ok).toBe(true);
    ledger.append(
      "CONFIRMED",
      confirmed({
        startBlockL2: 22080851n,
        endBlockL2: 22080900n,
        startBlockL1: 25635385n,
        endBlockL1: 25635390n,
        bindingEpoch: 2n,
        settlementNonce: 1n,
        sessionId: "0x7777000000000000000000000000000000000000000000000000000000000001",
        txHash: "0x7777000000000000000000000000000000000000000000000000000000000002",
      }),
    );
    expect(ledger.state.settledFrontierL2).toBe(22080900n);
    expect(ledger.state.settlementCount).toBe(2);
    ledger.close();
  });

  it("keeps bindingEpoch as audit data only: it appears in no key that governs replay", () => {
    const dir = freshDir();
    const ledger = openIn(dir);
    seedCanary(ledger);
    // The frontier is a single number, not a per-epoch map.
    expect(ledger.state.settledFrontierL2).toBe(22080850n);
    // The one place bindingEpoch still keys anything is the chain-guard mirror,
    // which is documented as a REVERT PREDICTOR and authorises nothing. It
    // faithfully reproduces the contract's weakness, quarantined.
    expect(ledger.state.chainGuardL1.get("1")).toBe(25635384n);
    expect(ledger.state.chainGuardL1.get("2")).toBeUndefined();
    // And the settlement nonce set — the other epoch-independent signal — is
    // untouched by a rebind, exactly as the vault's own settlementNonce is.
    expect([...ledger.state.settledSettlementNonces]).toEqual(["0"]);
    ledger.close();
  });

  it("keeps a SKIPPED refusal terminal across a rebind", () => {
    // Non-negotiable #2 in its durable form: a REFUSED verdict is keyed on the
    // epoch-independent L2 window, so a rebind does not re-offer it.
    const dir = freshDir();
    const ledger = openIn(dir);
    ledger.append("SKIPPED", {
      startBlockL2: 22090000n,
      endBlockL2: 22090500n,
      reason: "REFUSED",
      detail: "NOT_DELTA_FLAT",
      bindingEpoch: 1n,
    });
    const verdict = localEligibility(
      ledger.state,
      {
        startBlockL2: 22090000n,
        endBlockL2: 22090500n,
        startBlockL1: 25641000n,
        endBlockL1: 25641005n,
        bindingEpoch: 9n,
        sessionId: "0xfeed000000000000000000000000000000000000000000000000000000000001",
      },
      LIMITS,
      Date.now(),
    );
    ledger.close();
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.rule).toBe("TERMINAL");
  });
});

// ---------------------------------------------------------------------------
describe("the L1 collision stays distinguishable from an already-settled window", () => {
  /**
   * Two genuinely distinct L2 sessions inside one L1 block. Measured 64:1 to
   * 120:1 on this chain, and the ratio is not constant, so this is not a corner
   * case — it is arithmetic.
   */
  const seedFirst = (ledger: Ledger): void => {
    ledger.append(
      "CONFIRMED",
      confirmed({ startBlockL2: 22080592n, endBlockL2: 22080850n, startBlockL1: 25635381n, endBlockL1: 25635384n }),
    );
  };

  it("a REPLAY refuses with PROGRESSION_L2, the replay rule", () => {
    const dir = freshDir();
    const ledger = openIn(dir);
    seedFirst(ledger);
    const verdict = localEligibility(
      ledger.state,
      {
        startBlockL2: 22080592n,
        endBlockL2: 22080850n,
        startBlockL1: 25635381n,
        endBlockL1: 25635384n,
        bindingEpoch: 1n,
        sessionId: "0x1234000000000000000000000000000000000000000000000000000000000001",
      },
      LIMITS,
      Date.now(),
    );
    ledger.close();
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.rule).toBe("PROGRESSION_L2");
  });

  it("ACCEPTS a new session whose L1 range starts on the already-consumed L1 end", () => {
    // THE HEADLINE CASE, AND THE REASON THE CONTRACTS WERE REDEPLOYED.
    //
    // Same epoch, L2 strictly above the frontier, L1 start landing exactly on
    // the previous L1 end. That is a round-tripper: a trader who closed and
    // re-entered inside the same ~12s L1 block. It used to refuse here as
    // PROGRESSION_L1 and forfeit real revenue, mirroring a vault that refused it
    // too. The vault now progresses on the L2 range and requires the L1 range
    // only to be NON-DECREASING, so this window settles — and this rule must not
    // be the thing that still refuses it. Round-trippers are 43% of the measured
    // cohort; a local mirror stuck one version behind would hide the entire fix
    // behind a green contract suite.
    const dir = freshDir();
    const ledger = openIn(dir);
    seedFirst(ledger);
    const verdict = localEligibility(
      ledger.state,
      {
        startBlockL2: 22080851n,
        endBlockL2: 22080900n,
        startBlockL1: 25635384n,
        endBlockL1: 25635384n,
        bindingEpoch: 1n,
        sessionId: "0x4321000000000000000000000000000000000000000000000000000000000001",
      },
      LIMITS,
      Date.now(),
    );
    ledger.close();
    expect(verdict.ok).toBe(true);
  });

  it("still refuses an L1 range that RUNS BACKWARDS, with PROGRESSION_L1", () => {
    // The guard is relaxed, not removed. An L1 range below the last settled L1
    // end while the L2 range runs forwards is incoherent — the L2->L1 map is
    // monotone, so an honest pair cannot produce it — and the vault raises a
    // DISTINCT error (NonProgressiveL1BlockRange) for exactly this. Reaching it
    // is forfeited revenue on a window that is NOT a duplicate, which is why it
    // must not share a reason code with the replay rule: keeper.ts turns this
    // one into outcome L1_RANGE_COLLAPSED and exit code 6.
    const dir = freshDir();
    const ledger = openIn(dir);
    seedFirst(ledger);
    const verdict = localEligibility(
      ledger.state,
      {
        startBlockL2: 22080851n,
        endBlockL2: 22080900n,
        startBlockL1: 25635383n,
        endBlockL1: 25635383n,
        bindingEpoch: 1n,
        sessionId: "0x4321000000000000000000000000000000000000000000000000000000000001",
      },
      LIMITS,
      Date.now(),
    );
    ledger.close();
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.rule).toBe("PROGRESSION_L1");
      expect(verdict.detail).toContain("NonProgressiveL1BlockRange");
    }
  });

  it("reaching PROGRESSION_L1 PROVES the window is new, because PROGRESSION_L2 runs first", () => {
    // The old code had to guess this with `lastEndBlockL2 > 0n`. It is now a
    // property of the rule ORDER: the epoch-independent replay rule is primary.
    const dir = freshDir();
    const ledger = openIn(dir);
    seedFirst(ledger);
    const state = ledger.state;
    ledger.close();
    const rewound = {
      startBlockL2: 22080851n,
      endBlockL2: 22080900n,
      startBlockL1: 25635383n,
      endBlockL1: 25635383n,
      bindingEpoch: 1n,
      sessionId: "0x4321000000000000000000000000000000000000000000000000000000000001",
    };
    expect(state.settledFrontierL2).not.toBeNull();
    expect(rewound.startBlockL2 > (state.settledFrontierL2 ?? 0n)).toBe(true);
    const verdict = localEligibility(state, rewound, LIMITS, Date.now());
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.rule).toBe("PROGRESSION_L1");
  });

  it("still refuses the replay even when its L1 range is impeccable", () => {
    // Relaxing the L1 rule must not have moved any replay protection onto it.
    // Same L2 window as the settled one, L1 range pushed far forward so the L1
    // rule cannot possibly fire: PROGRESSION_L2 alone has to catch this.
    const dir = freshDir();
    const ledger = openIn(dir);
    seedFirst(ledger);
    const verdict = localEligibility(
      ledger.state,
      {
        startBlockL2: 22080592n,
        endBlockL2: 22080850n,
        startBlockL1: 25999999n,
        endBlockL1: 26000000n,
        bindingEpoch: 1n,
        sessionId: "0x9999000000000000000000000000000000000000000000000000000000000001",
      },
      LIMITS,
      Date.now(),
    );
    ledger.close();
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.rule).toBe("PROGRESSION_L2");
  });
});

// ---------------------------------------------------------------------------
describe("why PROGRESSION is the primary rule, not NOVELTY", () => {
  it("catches a replay whose sessionId changed because the ledgerRoot encoding changed", () => {
    // THIS IS NOT HYPOTHETICAL. The real canary settlement (tx
    // 0xd342d117…cad186) committed the LEGACY ledger root
    // 0xbc9407f1a72d27440e211568ad4842bd2fe0cbb2eeb686b88edfd4062cc674e5 and so
    // has sessionId 0x0d176cd3…2168. The same L2 window (22080592, 22080850]
    // re-derived today produces the v2 root and therefore sessionId
    // 0x259ef15b…07f4 — a DIFFERENT id for an already-settled window. Both values
    // were read back off mainnet.
    //
    // A novelty-only rule waves that through. Progression does not care what the
    // root says, which is exactly why it is checked first.
    const dir = freshDir();
    const ledger = openIn(dir);
    ledger.ensureHeader({ settlementNonce: 0n, lifetimeContribution: 0n });
    ledger.append("ADOPTED", {
      // Recovered from chain: the L1 range comes from decoded settle calldata and
      // the L2 range is CLAMPED back out of it, which is a superset of the truth.
      // It used to be written as 0/0 — and 0/0 left the epoch-scoped L1 rule as
      // the only protection an adopted window had.
      startBlockL2: 22080500n,
      endBlockL2: 22080900n,
      l2Precision: "L1_CLAMP",
      sessionId: "0x0d176cd39f2e1e5d415ab74379bef9d4c8027073f41995e1b7cc5bbb089c2168",
      bindingEpoch: 1n,
      settlementNonce: 0n,
      startBlockL1: 25_635_381n,
      endBlockL1: 25_635_384n,
      ledgerRoot: "0xbc9407f1a72d27440e211568ad4842bd2fe0cbb2eeb686b88edfd4062cc674e5",
      contribution: 403_370_889_498_747n,
      realizedProfit: 2_016_854_447_493_738n,
      txHash: "0xd342d117634464f9c6c5b9b463dd8c0be1e638fdf623ea78334a097ad1cad186",
      blockNumberL2: 22_086_139n,
      gasUsed: 0n,
      source: "adopted",
    });

    const replay = {
      startBlockL2: 22_080_592n,
      endBlockL2: 22_080_850n,
      startBlockL1: 25_635_381n,
      endBlockL1: 25_635_384n,
      bindingEpoch: 1n,
      // The v2 sessionId: genuinely novel, and genuinely a replay.
      sessionId: "0x259ef15b491b09f13f6e782aa76d7a4de101d7fced859393113dcc6921ea07f4",
    };
    expect(ledger.state.settledSessionIds.has(replay.sessionId)).toBe(false);
    const verdict = localEligibility(ledger.state, replay, LIMITS, Date.now());
    ledger.close();
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.rule).toBe("PROGRESSION_L2");
  });
});

// ---------------------------------------------------------------------------
describe("localEligibility", () => {
  const candidate = {
    startBlockL2: 22090000n,
    endBlockL2: 22090500n,
    startBlockL1: 25641000n,
    endBlockL1: 25641005n,
    bindingEpoch: 1n,
    sessionId: "0xcccc000000000000000000000000000000000000000000000000000000000001",
  };

  it("allows a genuinely new window", () => {
    const dir = freshDir();
    const ledger = openIn(dir);
    ledger.ensureHeader({ settlementNonce: 0n, lifetimeContribution: 0n });
    ledger.append("CONFIRMED", confirmed());
    const verdict = localEligibility(ledger.state, candidate, LIMITS, Date.now());
    ledger.close();
    expect(verdict.ok).toBe(true);
  });

  it("refuses a window already in the store", () => {
    const dir = freshDir();
    const ledger = openIn(dir);
    ledger.append("CONFIRMED", confirmed({ ...candidate, txHash: "0x01", blockNumberL2: 1n, gasUsed: 1n }));
    const verdict = localEligibility(ledger.state, candidate, LIMITS, Date.now());
    ledger.close();
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.rule).toBe("PROGRESSION_L2");
  });

  it("refuses while any intent is unresolved (single flight)", () => {
    const dir = freshDir();
    const ledger = openIn(dir);
    ledger.append("INTENT", intent({ startBlockL2: 1n, endBlockL2: 2n }));
    const verdict = localEligibility(ledger.state, candidate, LIMITS, Date.now());
    ledger.close();
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.rule).toBe("SINGLE_FLIGHT");
  });

  it("refuses EVERYTHING while degraded, including a window that looks nothing like the halt", () => {
    const dir = freshDir();
    const ledger = openIn(dir);
    const halt = ledger.append("DEGRADED", { reason: "NONCE_UNRECONCILED", detail: "test" });
    const unrelated = { ...candidate, startBlockL2: 90_000_000n, endBlockL2: 90_000_100n };
    for (const window of [candidate, unrelated]) {
      const verdict = localEligibility(ledger.state, window, LIMITS, Date.now());
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.rule).toBe("NOT_DEGRADED");
    }
    // ...and an operator acknowledgement that NAMES the halt clears it.
    ledger.append("RESUMED", { acknowledgedSeq: halt.seq, note: "checked by hand" });
    expect(localEligibility(ledger.state, candidate, LIMITS, Date.now()).ok).toBe(true);
    ledger.close();
  });

  it("refuses a window recorded terminal, so a refusal is not re-verified forever", () => {
    const dir = freshDir();
    const ledger = openIn(dir);
    ledger.append("SKIPPED", {
      startBlockL2: candidate.startBlockL2,
      endBlockL2: candidate.endBlockL2,
      reason: "REFUSED",
      detail: "NOT_DELTA_FLAT",
    });
    const verdict = localEligibility(ledger.state, candidate, LIMITS, Date.now());
    ledger.close();
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.rule).toBe("TERMINAL");
  });

  it("a SKIPPED window advances the refusal boundary in L2 and NEVER an L1 one", () => {
    // The asymmetry the old store had and that is easy to lose in a schema
    // rewrite: a refused window must not fabricate an L1 boundary the chain does
    // not have, or it would start refusing genuinely-new windows as replays.
    const dir = freshDir();
    const ledger = openIn(dir);
    ledger.append("SKIPPED", {
      startBlockL2: 22090000n,
      endBlockL2: 22090500n,
      reason: "REFUSED",
      detail: "NOT_DELTA_FLAT",
      endBlockL1: 25641005n,
      bindingEpoch: 1n,
    });
    expect(ledger.state.refusedHighWaterL2).toBe(22090500n);
    // NOT the chain guard, and not the settled frontier: no money moved.
    expect(ledger.state.chainGuardL1.size).toBe(0);
    expect(ledger.state.settledFrontierL2).toBeNull();
    expect(ledger.state.settlementCount).toBe(0);
    // A re-cut that overlaps the refusal is not verified again...
    const overlapping = localEligibility(
      ledger.state,
      { ...candidate, startBlockL2: 22090100n, endBlockL2: 22090600n },
      LIMITS,
      Date.now(),
    );
    expect(overlapping.ok).toBe(false);
    // ...but a window strictly after it still is.
    expect(
      localEligibility(
        ledger.state,
        { ...candidate, startBlockL2: 22090600n, endBlockL2: 22090700n },
        LIMITS,
        Date.now(),
      ).ok,
    ).toBe(true);
    ledger.close();
  });

  it("enforces the per-day circuit breaker, fed only by CONFIRMED and ADOPTED", () => {
    const dir = freshDir();
    const ledger = openIn(dir);
    for (let i = 0; i < 3; i++) {
      ledger.append(
        "CONFIRMED",
        confirmed({
          sessionId: `0xaaaa0000000000000000000000000000000000000000000000000000000000${i}${i}`,
          settlementNonce: BigInt(i),
          startBlockL1: BigInt(25600000 + i * 100),
          endBlockL1: BigInt(25600050 + i * 100),
          startBlockL2: BigInt(22000000 + i * 1000),
          endBlockL2: BigInt(22000500 + i * 1000),
          txHash: `0xbbbb0000000000000000000000000000000000000000000000000000000000${i}${i}`,
        }),
      );
    }
    // A DRYRUN and a FAILED do not feed it.
    ledger.append("DRYRUN", {
      ...confirmed({ startBlockL2: 23000000n, endBlockL2: 23000100n }),
      attestationDigest: "0x00",
      attester: ACCOUNT,
      wouldSendTo: VAULT,
      wouldSendValue: 1n,
    });
    const verdict = localEligibility(ledger.state, candidate, { maxSettlementsPerDay: 3 }, Date.now());
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.rule).toBe("RATE_LIMIT");
    expect(localEligibility(ledger.state, candidate, { maxSettlementsPerDay: 4 }, Date.now()).ok).toBe(true);
    ledger.close();
  });

  it("counts only the last 24h, and every timestamp it counts is finite", () => {
    // The breaker is a ROLLING window fed from the store's own timestamps, and
    // the Number.isFinite filter means a bad ts can neither silently disable it
    // nor silently trip it.
    const dir = freshDir();
    const old = new Date("2026-07-01T00:00:00.000Z");
    const ledger = Ledger.open({ dir, instance: INSTANCE, noLock: true, now: () => old });
    openLedgers.push(ledger);
    ledger.append("CONFIRMED", confirmed());
    const state = ledger.state;
    ledger.close();
    expect(state.confirmedAtMs).toEqual([old.getTime()]);
    expect(state.confirmedAtMs.every((ms) => Number.isFinite(ms))).toBe(true);
    // A day later that settlement is outside the window, so it does not count.
    const later = old.getTime() + 25 * 60 * 60 * 1000;
    expect(localEligibility(state, candidate, { maxSettlementsPerDay: 1 }, later).ok).toBe(true);
    // ...and inside the window it does.
    const soon = old.getTime() + 60 * 1000;
    const tripped = localEligibility(state, candidate, { maxSettlementsPerDay: 1 }, soon);
    expect(tripped.ok).toBe(false);
    if (!tripped.ok) expect(tripped.rule).toBe("RATE_LIMIT");
  });

  it("is a pure function of (state, candidate, limits, nowMs) with an injected clock", () => {
    const dir = freshDir();
    const ledger = openIn(dir);
    ledger.append("CONFIRMED", confirmed());
    const state = ledger.state;
    ledger.close();
    // Callable after the store is closed: no I/O, which is what lets keeper.ts
    // check it early and submit.ts re-check it at the last possible moment.
    const a = localEligibility(state, candidate, LIMITS, 1_800_000_000_000);
    const b = localEligibility(state, candidate, LIMITS, 1_800_000_000_000);
    expect(a).toEqual(b);
    expect(a.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("the record types mean exactly what they meant before", () => {
  it("CONFIRMED and ADOPTED are equivalent for every purpose", () => {
    const dir = freshDir();
    const ledger = openIn(dir);
    ledger.append("ADOPTED", {
      ...confirmed({ settlementNonce: 7n, source: "adopted" }),
      l2Precision: "L1_CLAMP",
    });
    const state = ledger.state;
    ledger.close();
    expect(state.settledFrontierL2).toBe(22080850n);
    expect(state.chainGuardL1.get("1")).toBe(25635384n);
    expect([...state.settledSettlementNonces]).toEqual(["7"]);
    expect(state.settlementCount).toBe(1);
    expect(state.confirmedRecords).toHaveLength(1);
    expect(state.confirmedAtMs).toHaveLength(1);
  });

  it("a FAILED record RECORDS NO PROGRESS, and only clears the intent", () => {
    const dir = freshDir();
    const ledger = openIn(dir);
    ledger.append("INTENT", intent());
    expect(ledger.state.openIntents).toHaveLength(1);
    ledger.append("FAILED", {
      startBlockL2: intent().startBlockL2,
      endBlockL2: intent().endBlockL2,
      sessionId: intent().sessionId,
      txHash: "0xdead000000000000000000000000000000000000000000000000000000000001",
      reason: "mined with status 0",
    });
    const state = ledger.state;
    // Gas burned, EOA nonce consumed, no money moved: the window is still unsettled.
    expect(state.openIntents).toHaveLength(0);
    expect(state.settledFrontierL2).toBeNull();
    expect(state.chainGuardL1.size).toBe(0);
    expect(state.settlementCount).toBe(0);
    expect(state.settledSettlementNonces.size).toBe(0);
    expect(state.settledSessionIds.size).toBe(0);
    expect(state.confirmedAtMs).toHaveLength(0);
    expect(state.terminalWindows.size).toBe(0);
    // ...and the same window can be retried, because a terminal failure RELEASES
    // the frontier while the row stays on disk for audit.
    expect(localEligibility(state, { ...intent(), bindingEpoch: 1n }, LIMITS, Date.now()).ok).toBe(true);
    ledger.append("INTENT", intent({ rawTxHash: "0xffff000000000000000000000000000000000000000000000000000000000002" }));
    expect(ledger.state.openIntents).toHaveLength(1);
    ledger.close();
  });

  it("an ABANDONED record likewise records no progress", () => {
    const dir = freshDir();
    const ledger = openIn(dir);
    ledger.append("INTENT", intent());
    ledger.append("ABANDONED", {
      startBlockL2: intent().startBlockL2,
      endBlockL2: intent().endBlockL2,
      sessionId: intent().sessionId,
      rawTxHash: intent().rawTxHash,
      reason: "nonce still unused",
    });
    const state = ledger.state;
    ledger.close();
    expect(state.openIntents).toHaveLength(0);
    expect(state.settledFrontierL2).toBeNull();
    expect(state.settlementCount).toBe(0);
  });

  it("an open INTENT is resolved by any terminal record for the SAME WINDOW, not the same sessionId", () => {
    // A re-derivation after a rebind produces a different sessionId over the same
    // window, and the intent must still count as resolved — or SINGLE_FLIGHT
    // wedges permanently after a rebind.
    const dir = freshDir();
    const ledger = openIn(dir);
    ledger.append("INTENT", intent());
    ledger.append("CONFIRMED", {
      ...confirmed({
        startBlockL2: intent().startBlockL2,
        endBlockL2: intent().endBlockL2,
        // Different epoch, different sessionId, same window.
        bindingEpoch: 44n,
        sessionId: "0xbeef000000000000000000000000000000000000000000000000000000000001",
        settlementNonce: 1n,
        startBlockL1: intent().startBlockL1,
        endBlockL1: intent().endBlockL1,
      }),
    });
    const state = ledger.state;
    ledger.close();
    expect(state.openIntents).toHaveLength(0);
    expect(state.settlementCount).toBe(1);
    expect(state.settledFrontierL2).toBe(22090500n);
  });

  it("a DRYRUN record is DELIBERATELY INERT", () => {
    const dir = freshDir();
    const ledger = openIn(dir);
    ledger.append("DRYRUN", {
      ...confirmed(),
      attestationDigest: "0xaaaa",
      attester: ACCOUNT,
      wouldSendTo: VAULT,
      wouldSendValue: 403370889498747n,
    });
    const state = ledger.state;
    ledger.close();
    expect(state.counts.DRYRUN).toBe(1);
    expect(state.settledSessionIds.size).toBe(0);
    expect(state.settledFrontierL2).toBeNull();
    expect(state.settlementCount).toBe(0);
    expect(state.confirmedAtMs).toHaveLength(0);
  });

  it("a CHECKPOINT sets the scan anchor, last one wins", () => {
    const dir = freshDir();
    const ledger = openIn(dir);
    ledger.append("CHECKPOINT", { anchorBlockL2: 100n, anchorBlockHash: "0xaa", headBlockL2: 200n });
    ledger.append("CHECKPOINT", { anchorBlockL2: 150n, anchorBlockHash: "0xbb", headBlockL2: 250n });
    expect(ledger.state.anchorBlockL2).toBe(150n);
    expect(ledger.state.anchorBlockHash).toBe("0xbb");
    ledger.close();
    const reopened = openIn(dir);
    expect(reopened.state.anchorBlockL2).toBe(150n);
    reopened.close();
  });

  it("counts every record type, and they survive a reload", () => {
    const dir = freshDir();
    const ledger = openIn(dir);
    ledger.ensureHeader({ settlementNonce: 0n, lifetimeContribution: 0n });
    ledger.append("CHECKPOINT", { anchorBlockL2: 1n, anchorBlockHash: "0xaa", headBlockL2: 2n });
    ledger.append("CONFIRMED", confirmed());
    ledger.close();
    const reopened = openIn(dir);
    expect(reopened.state.counts.HEADER).toBe(1);
    expect(reopened.state.counts.CHECKPOINT).toBe(1);
    expect(reopened.state.counts.CONFIRMED).toBe(1);
    expect(reopened.state.counts.INTENT).toBe(0);
    expect(reopened.state.seq).toBe(2);
    reopened.close();
  });

  it("ensureHeader is idempotent", () => {
    const dir = freshDir();
    const ledger = openIn(dir);
    ledger.ensureHeader({ settlementNonce: 3n, lifetimeContribution: 9n });
    ledger.ensureHeader({ settlementNonce: 99n, lifetimeContribution: 99n });
    expect(ledger.state.counts.HEADER).toBe(1);
    expect(ledger.state.header?.baselineSettlementNonce).toBe(3n);
    ledger.close();
  });

  it("nothing reads header.baselineSettlementNonce for accounting: the store may never be confidently empty", () => {
    const dir = freshDir();
    const ledger = openIn(dir);
    // A baseline of 5 is an OBSERVATION of the chain, never a claim to have
    // accounted for nonces 0..4. This is the exact arithmetic that made the old
    // adoption trigger unreachable on a wiped volume.
    ledger.ensureHeader({ settlementNonce: 5n, lifetimeContribution: 0n });
    const state = ledger.state;
    ledger.close();
    expect(state.settledSettlementNonces.size).toBe(0);
    expect(state.settlementCount).toBe(0);
    expect(state.acknowledgedNonceFloor).toBe(0n);
  });
});

// ---------------------------------------------------------------------------
describe("the store names the settlement nonces it knows", () => {
  it("records each settlement's consumed nonce, so an empty store cannot bluff", () => {
    const dir = freshDir();
    const ledger = openIn(dir);
    ledger.ensureHeader({ settlementNonce: 1n, lifetimeContribution: 0n });
    expect([...ledger.state.settledSettlementNonces]).toEqual([]);
    expect(ledger.state.acknowledgedNonceFloor).toBe(0n);

    ledger.append("CONFIRMED", confirmed({ settlementNonce: 3n }));
    expect([...ledger.state.settledSettlementNonces]).toEqual(["3"]);
    ledger.close();

    const reopened = openIn(dir);
    expect([...reopened.state.settledSettlementNonces]).toEqual(["3"]);
    reopened.close();
  });

  it("refuses to record two settlements against one settlementNonce", () => {
    // PersonalVault consumes each nonce exactly once. Two live rows claiming the
    // same one means the store's model of history is wrong.
    const dir = freshDir();
    const ledger = openIn(dir);
    ledger.append("CONFIRMED", confirmed({ settlementNonce: 3n }));
    expect(() =>
      ledger.append(
        "CONFIRMED",
        confirmed({
          settlementNonce: 3n,
          startBlockL2: 23000000n,
          endBlockL2: 23000100n,
          startBlockL1: 25700000n,
          endBlockL1: 25700004n,
          sessionId: "0x5555000000000000000000000000000000000000000000000000000000000001",
          txHash: "0x5555000000000000000000000000000000000000000000000000000000000002",
        }),
      ),
    ).toThrow(LedgerConstraintError);
    ledger.close();
  });

  it("raises the acknowledgement floor only from the halt a RESUMED names, and only upward", () => {
    const dir = freshDir();
    const ledger = openIn(dir);
    ledger.ensureHeader({ settlementNonce: 0n, lifetimeContribution: 0n });
    const unbounded = ledger.append("DEGRADED", { reason: "SOMETHING_ELSE", detail: "no bound recorded" });
    ledger.append("RESUMED", { acknowledgedSeq: unbounded.seq, note: "n" });
    // A halt that recorded no bound excuses NOTHING: the latch clears, the
    // accounting floor does not move.
    expect(ledger.state.degraded).toBeNull();
    expect(ledger.state.acknowledgedNonceFloor).toBe(0n);

    const bounded = ledger.append("DEGRADED", {
      reason: "UNACCOUNTED_SETTLEMENTS",
      detail: "d",
      unaccountedBelow: 4n,
    });
    ledger.append("RESUMED", { acknowledgedSeq: bounded.seq, note: "n" });
    expect(ledger.state.acknowledgedNonceFloor).toBe(4n);

    // It only ever rises: acknowledging an older, narrower halt cannot walk it
    // back down into a licence to replay.
    const narrower = ledger.append("DEGRADED", {
      reason: "UNACCOUNTED_SETTLEMENTS",
      detail: "d",
      unaccountedBelow: 2n,
    });
    ledger.append("RESUMED", { acknowledgedSeq: narrower.seq, note: "n" });
    expect(ledger.state.acknowledgedNonceFloor).toBe(4n);
    ledger.close();

    // Durable: derived from the store, not held in memory, so reconcile does not
    // re-detect the same shortfall on the next tick and latch forever.
    const reopened = openIn(dir);
    expect(reopened.state.acknowledgedNonceFloor).toBe(4n);
    expect(reopened.state.degraded).toBeNull();
    reopened.close();
  });

  it("a RESUMED naming the wrong halt clears nothing", () => {
    const dir = freshDir();
    const ledger = openIn(dir);
    const halt = ledger.append("DEGRADED", { reason: "UNACCOUNTED_SETTLEMENTS", detail: "d", unaccountedBelow: 4n });
    ledger.append("RESUMED", { acknowledgedSeq: halt.seq + 999, note: "a stale script" });
    const state = ledger.state;
    ledger.close();
    expect(state.degraded?.reason).toBe("UNACCOUNTED_SETTLEMENTS");
    expect(state.acknowledgedNonceFloor).toBe(0n);
  });

  it("a halted store REFUSES to record a settlement intent at all", () => {
    // Non-negotiable #2, enforced structurally rather than politely: with an open
    // halt it is impossible to write the row that must precede a broadcast.
    const dir = freshDir();
    const ledger = openIn(dir);
    ledger.append("DEGRADED", { reason: "REVERT_BREAKER", detail: "three in a row" });
    let thrown: unknown = null;
    try {
      ledger.append("INTENT", intent());
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(LedgerConstraintError);
    expect((thrown as LedgerConstraintError).rule).toBe("NOT_DEGRADED");
    expect(ledger.state.openIntents).toHaveLength(0);
    ledger.close();
  });
});

// ---------------------------------------------------------------------------
describe("crash mid-write, and the write-ahead ordering", () => {
  it("a COMPLETE INTENT with no terminal record survives a restart as an open intent", () => {
    // The crash-after-broadcast case, and the one reconcile.ts Phase A exists to
    // settle against the chain.
    const dir = freshDir();
    const ledger = openIn(dir);
    ledger.ensureHeader({ settlementNonce: 0n, lifetimeContribution: 0n });
    ledger.append("INTENT", intent());
    ledger.close();

    const reopened = openIn(dir);
    expect(reopened.state.openIntents).toHaveLength(1);
    expect(reopened.state.openIntents[0]?.body.rawTxHash).toBe(intent().rawTxHash);
    expect(reopened.state.openIntents[0]?.body.eoaNonce).toBe(75);
    // Everything reconcile needs to interrogate the chain is durable.
    expect(reopened.state.openIntents[0]?.body.deadline).toBe(1_700_000_600);
    reopened.close();
  });

  it("a crash mid-commit leaves prior records intact and produces NO phantom intent", () => {
    // The JSONL store's torn-tail case, restated for ACID: the transaction either
    // committed whole or it did not happen. A half-written INTENT cannot exist,
    // so it cannot block progress via SINGLE_FLIGHT.
    const dir = freshDir();
    const ledger = openIn(dir);
    ledger.ensureHeader({ settlementNonce: 0n, lifetimeContribution: 0n });
    ledger.append("CONFIRMED", confirmed());
    const path = ledger.journalPath;
    ledger.close();

    // Open a raw connection, begin a write, and walk away without committing —
    // which is exactly what a SIGKILL mid-transaction leaves behind.
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    const raw = new DatabaseSync(path);
    raw.exec("BEGIN IMMEDIATE");
    raw.prepare("INSERT INTO record (seq, ts, type, prev_digest, digest, body) VALUES (2,'x','INTENT','0x','0x','{}')").run();
    raw.close(); // node:sqlite rolls back silently here. Verified.

    const reopened = openIn(dir);
    expect(reopened.state.openIntents).toHaveLength(0);
    expect(reopened.state.counts.INTENT).toBe(0);
    // The settlement before the crash is remembered, exactly.
    expect(reopened.state.settledFrontierL2).toBe(22080850n);
    expect(reopened.state.integrityOk).toBe(true);
    reopened.close();
  });

  it("does NOT pretend a lost write succeeded", () => {
    // A write that did not land is an ERROR, never a silent success. The old
    // mechanism was a sequence tripwire that compared the seq NUMBER; the
    // guarantee survives as transaction semantics plus a refusal to write into a
    // store whose integrity cannot be established.
    const dir = freshDir();
    const ledger = openIn(dir);
    ledger.close(); // the connection is gone; the handle is not
    expect(() => ledger.append("CONFIRMED", confirmed())).toThrow(LedgerWriteError);
    expect(() => ledger.append("CONFIRMED", confirmed())).toThrow(/must not accept a settlement record/);
  });
});

// ---------------------------------------------------------------------------
describe("a damaged store is described, never repaired and never settled from", () => {
  it("a file that is not a database opens, reports, and refuses", () => {
    // An inspection command must always be able to open a damaged store and
    // describe it. It must never throw, and it must never be settled from.
    const dir = freshDir();
    writeFileSync(join(dir, "keeper-4663-0x0b503606-0xc455bf7f.db"), "this is not a database at all\n");
    const ledger = openIn(dir);
    expect(ledger.state.integrityOk).toBe(false);
    expect(ledger.state.integrityDetail).toMatch(/could not be opened|not a database/i);
    expect(ledger.readRecords().records).toHaveLength(0);
    const verdict = localEligibility(
      ledger.state,
      {
        startBlockL2: 1n,
        endBlockL2: 2n,
        startBlockL1: 3n,
        endBlockL1: 4n,
        bindingEpoch: 1n,
        sessionId: "0xaa",
      },
      LIMITS,
      Date.now(),
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.rule).toBe("STORE_INTEGRITY");
    // And it refuses to write, rather than losing a settlement record silently.
    expect(() => ledger.append("CONFIRMED", confirmed())).toThrow(LedgerWriteError);
    ledger.close();
  });

  it("a TRUNCATED database is detected, not silently accepted", () => {
    // Half a real database file. SQLite reports SQLITE_CORRUPT rather than
    // pretending the missing pages were never there — which is the opposite of
    // what repairTail did, and the correct posture: damage is REPORTED, never
    // truncated away, and nothing is settled from it.
    const dir = freshDir();
    const ledger = openIn(dir);
    ledger.ensureHeader({ settlementNonce: 0n, lifetimeContribution: 0n });
    for (let i = 0; i < 200; i++) {
      ledger.append("CHECKPOINT", { anchorBlockL2: BigInt(i), anchorBlockHash: "0xaa", headBlockL2: BigInt(i) });
    }
    const path = ledger.journalPath;
    ledger.close();

    const bytes = readFileSync(path);
    writeFileSync(path, bytes.subarray(0, Math.floor(bytes.length / 2)));

    const read = Ledger.read(path);
    expect(read.integrityOk).toBe(false);
    expect(read.integrityDetail).toBeTruthy();

    const reopened = openIn(dir);
    expect(reopened.state.integrityOk).toBe(false);
    const verdict = localEligibility(
      reopened.state,
      { startBlockL2: 1n, endBlockL2: 2n, startBlockL1: 3n, endBlockL1: 4n, bindingEpoch: 1n, sessionId: "0xaa" },
      LIMITS,
      Date.now(),
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.rule).toBe("STORE_INTEGRITY");
    reopened.close();
  });

  it("Ledger.read never throws on a store it cannot open", () => {
    const dir = freshDir();
    const path = join(dir, "garbage.db");
    writeFileSync(path, "{not json");
    const read = Ledger.read(path);
    expect(read.records).toHaveLength(0);
    expect(read.integrityOk).toBe(false);
    expect(read.integrityDetail).toBeTruthy();
    // A store that does not exist is not damage.
    const absent = Ledger.read(join(dir, "nothing-here.db"));
    expect(absent.integrityOk).toBe(true);
    expect(absent.records).toHaveLength(0);
  });

  it("A SILENTLY EDITED RECORD IS DETECTED AND NOT BELIEVED", () => {
    // THE ONE GUARANTEE THE HASH CHAIN PROVIDED THAT AN ACID TRANSACTION DOES
    // NOT. A transaction protects against torn writes and interleaving; it does
    // not notice a human raising a contribution with sqlite3. Out-of-band editing
    // is IN SCOPE, and it is caught by a per-row digest.
    //
    // Note what does NOT happen, and used to: everything after the edited record
    // is still admitted. The old loader discarded the whole tail, which is how a
    // CONFIRMED settlement could be moved out of the store by a repair.
    const dir = freshDir();
    const ledger = openIn(dir);
    ledger.ensureHeader({ settlementNonce: 0n, lifetimeContribution: 0n });
    ledger.append("CONFIRMED", confirmed());
    ledger.append("CHECKPOINT", { anchorBlockL2: 9n, anchorBlockHash: "0xaa", headBlockL2: 10n });
    const path = ledger.journalPath;
    ledger.close();

    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    const db = new DatabaseSync(path);
    // The record table's own trigger refuses this, so an attacker has to drop it
    // first — which is the realistic shape of the attack, and which the digest
    // still catches.
    db.exec("DROP TRIGGER record_no_update");
    const body = db.prepare("SELECT body FROM record WHERE seq = 1").get() as { body: string };
    db.prepare("UPDATE record SET body = ? WHERE seq = 1").run(
      body.body.replace('"403370889498747"', '"999999999999999"'),
    );
    db.close();

    const reopened = openIn(dir);
    const read = reopened.readRecords();
    expect(read.integrityOk).toBe(false);
    expect(read.rejected).toEqual([1]);
    expect(read.integrityDetail).toContain("fails its integrity digest");
    // The edited record is NOT admitted...
    expect(read.records.map((r) => r.seq)).toEqual([0, 2]);
    expect(asText(read.records)).not.toContain("999999999999999");
    // ...and the record AFTER it still is. That is blocking defect 2 fixed rather
    // than reproduced.
    expect(read.records.map((r) => r.type)).toEqual(["HEADER", "CHECKPOINT"]);
    // Nothing is settled from a store in this state, whatever else it says.
    const verdict = localEligibility(
      reopened.state,
      {
        startBlockL2: 30000000n,
        endBlockL2: 30000100n,
        startBlockL1: 26000000n,
        endBlockL1: 26000004n,
        bindingEpoch: 1n,
        sessionId: "0xdd",
      },
      LIMITS,
      Date.now(),
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.rule).toBe("STORE_INTEGRITY");
    // AND the settlement itself is still on record in the table the constraints
    // police, so even a tampered record stream cannot un-settle a window.
    expect(reopened.state.settledFrontierL2).toBe(22080850n);
    reopened.close();
  });

  it("detects a record removed out of band", () => {
    const dir = freshDir();
    const ledger = openIn(dir);
    ledger.ensureHeader({ settlementNonce: 0n, lifetimeContribution: 0n });
    ledger.append("CHECKPOINT", { anchorBlockL2: 1n, anchorBlockHash: "0xaa", headBlockL2: 2n });
    ledger.append("CHECKPOINT", { anchorBlockL2: 2n, anchorBlockHash: "0xbb", headBlockL2: 3n });
    const path = ledger.journalPath;
    ledger.close();

    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    const db = new DatabaseSync(path);
    db.exec("DROP TRIGGER record_no_delete");
    db.prepare("DELETE FROM record WHERE seq = 1").run();
    db.close();

    const read = Ledger.read(path);
    expect(read.integrityOk).toBe(false);
    expect(read.integrityDetail).toContain("not dense");
  });

  it("REFUSES to delete or edit a settlement row, even from sqlite3", () => {
    const dir = freshDir();
    const ledger = openIn(dir);
    ledger.append("CONFIRMED", confirmed());
    const path = ledger.journalPath;
    ledger.close();

    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    const db = new DatabaseSync(path);
    expect(() => db.prepare("DELETE FROM settlement WHERE id = 1").run()).toThrow(/never deleted/);
    expect(() => db.prepare("UPDATE settlement SET contribution_wei = '1' WHERE id = 1").run()).toThrow(
      /immutable/,
    );
    expect(() => db.prepare("UPDATE settlement SET end_block_l2 = 1 WHERE id = 1").run()).toThrow(/immutable/);
    expect(() => db.prepare("UPDATE settlement SET status = 'FAILED' WHERE id = 1").run()).toThrow(
      /only an INTENT may change status/,
    );
    db.close();
  });
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// A DAMAGED STORE IS NOT AN EMPTY ONE.
//
// The store has THREE states — ABSENT, HEALTHY, DAMAGED — and the whole of this
// block exists because the code used to have two. An empty store refuses nothing:
// every rule here is keyed on rows it holds, so a keeper that starts from one
// believes it has never settled and will offer every already-settled window
// again. That is the same catastrophe the bindingEpoch rebind used to cause,
// reached by a different road — a disk full during a write, a truncating restore,
// a volume mounted before the file materialised, a bad backup.
//
// EVERY CASE BELOW FAILED BEFORE THE PROBE EXISTED. A zero-byte file was opened,
// had the schema written over it, and reported integrityOk TRUE with a null
// frontier: verified independently, and it is the reason `Ledger.open` no longer
// has any path that writes DDL to a file that already exists.
// ---------------------------------------------------------------------------
const DB_NAME = "keeper-4663-0x0b503606-0xc455bf7f.db";
const dbIn = (dir: string): string => join(dir, DB_NAME);

/** A real, healthy store with real records in it, then closed. */
function seededStore(dir: string): string {
  const ledger = Ledger.open({ dir, instance: INSTANCE, noLock: true });
  ledger.ensureHeader({ settlementNonce: 0n, lifetimeContribution: 0n });
  ledger.append("CONFIRMED", confirmed());
  const path = ledger.journalPath;
  ledger.close();
  return path;
}

describe("a damaged store is never mistaken for an empty one", () => {
  it("REFUSES A ZERO-BYTE DATABASE instead of treating it as a pristine first run", () => {
    // THE HEADLINE CASE. SQLite accepts a zero-byte file as a valid EMPTY
    // database — open it, create tables, no error — so nothing downstream of
    // `new DatabaseSync()` can tell this from a genuine first run. Verified
    // independently before the fix: a 0-byte file was opened and a table created
    // with no complaint.
    const dir = freshDir();
    writeFileSync(dbIn(dir), "");

    const probe = probeStoreFile(dbIn(dir));
    expect(probe.condition).toBe("DAMAGED");
    expect(probe.sizeBytes).toBe(0);
    expect(probe.detail).toContain("ZERO BYTES");

    const ledger = openIn(dir);
    expect(ledger.state.condition).toBe("DAMAGED");
    expect(ledger.state.integrityOk).toBe(false);
    // It NAMES THE FILE and says how to recover, because an operator reading this
    // during an incident has to know which file and what to do.
    expect(ledger.state.integrityDetail).toContain(DB_NAME);
    expect(ledger.state.integrityDetail).toContain("RESTORING THE VOLUME");
    expect(ledger.state.integrityDetail).toContain("keeper recover");
    // And the schema was NOT recreated over the damage: the file is untouched.
    expect(statSync(dbIn(dir)).size).toBe(0);
  });

  it("REFUSES A TRUNCATED DATABASE: a valid header over a file cut mid-write", () => {
    const dir = freshDir();
    const path = seededStore(dir);
    const bytes = readFileSync(path);
    writeFileSync(path, bytes.subarray(0, Math.floor(bytes.length / 2)));

    const probe = probeStoreFile(path);
    expect(probe.condition).toBe("DAMAGED");
    // Caught from the HEADER'S OWN PAGE COUNT against the file size, before
    // SQLite is asked anything: bytes 28..31 say how many pages there are and the
    // file is shorter than that many pages.
    expect(probe.detail).toContain("TRUNCATED");

    const ledger = openIn(dir);
    expect(ledger.state.condition).toBe("DAMAGED");
    expect(ledger.state.integrityOk).toBe(false);
    // The settled frontier is not reported as "nothing settled" — it is reported
    // as unknown, alongside a condition that says why.
    expect(ledger.state.settledFrontierL2).toBeNull();
    expect(ledger.state.integrityDetail).toContain(DB_NAME);
  });

  it("REFUSES A FILE THAT IS NOT SQLITE AT ALL, from the header magic", () => {
    const dir = freshDir();
    writeFileSync(dbIn(dir), "PK this is a zip file, not a database\n");
    const probe = probeStoreFile(dbIn(dir));
    expect(probe.condition).toBe("DAMAGED");
    expect(probe.detail).toContain("NOT A DATABASE");
    expect(probe.detail).toContain("SQLite format 3");

    const ledger = openIn(dir);
    expect(ledger.state.condition).toBe("DAMAGED");
    expect(ledger.state.integrityOk).toBe(false);
  });

  it("REFUSES A DATABASE THAT IS MISSING A DECISION TABLE rather than rebuilding it", () => {
    // `DROP TABLE settlement` is a one-line route to an empty frontier. Before the
    // fix the state getter THREW here (`no such table: settlement`), which broke
    // every inspection command at exactly the moment one was needed.
    const dir = freshDir();
    const path = seededStore(dir);
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    const db = new DatabaseSync(path);
    db.exec("DROP TABLE settlement");
    db.close();

    const ledger = openIn(dir);
    // It does not throw. That is inventory guarantee #26.
    expect(() => ledger.state).not.toThrow();
    expect(ledger.state.condition).toBe("DAMAGED");
    expect(ledger.state.integrityOk).toBe(false);
    expect(ledger.state.integrityDetail).toContain("settlement");
    // Repeated access is still a value, not an exception.
    expect(ledger.state.settledFrontierL2).toBeNull();
    expect(ledger.readRecords().condition).toBe("DAMAGED");
  });

  it("REFUSES A .db THAT IS GONE WHILE ITS -wal SURVIVES", () => {
    // A write-ahead log without its database is not a first run: the most recent
    // commits are in the file that WAS left behind, and they cannot be read from
    // it alone. Reading the missing .db as "never settled anything" is the
    // double-settle path.
    const dir = freshDir();
    const ledger = openIn(dir);
    ledger.ensureHeader({ settlementNonce: 0n, lifetimeContribution: 0n });
    ledger.append("CONFIRMED", confirmed());
    const path = ledger.journalPath;
    // A real -wal, of the shape an older WAL-mode build would have left behind.
    const wal = syntheticWal();
    ledger.close();
    unlinkSync(path);
    writeFileSync(`${path}-wal`, wal);

    const probe = probeStoreFile(path);
    expect(probe.condition).toBe("DAMAGED");
    expect(probe.sizeBytes).toBeNull();
    expect(probe.walBytes).toBeGreaterThan(0);
    expect(probe.detail).toContain("is GONE");

    const reopened = openIn(dir);
    expect(reopened.state.condition).toBe("DAMAGED");
    expect(reopened.state.integrityOk).toBe(false);
    // NOT read as empty: the frontier is unknown, and the condition says so.
    expect(reopened.state.settledFrontierL2).toBeNull();
    expect(reopened.state.condition).not.toBe("HEALTHY");
  });

  it("CANNOT BE REWOUND BY A STALE WRITE-AHEAD LOG, because it never has one", () => {
    // THE DEFECT THIS MODE EXISTS TO KILL, pinned as a regression.
    //
    // Under journal_mode=WAL this sequence silently rewound the store and every
    // integrity check still said ok:
    //   settle A -> capture the -wal while the connection is open -> settle B ->
    //   close (checkpoints A and B into the .db, removes the -wal) -> restore the
    //   captured -wal -> reopen. SQLite replays a self-consistent log and the
    //   store reads as holding only A. A store claiming LESS was settled than
    //   really was is the double-settle path.
    //
    // It is an ordinary backup accident: two snapshots taken at different
    // instants, `docker cp` on a running container, an rsync without --delete.
    // No validation can fix it, because SQLite is behaving correctly. Only having
    // one file can.
    const dir = freshDir();
    const ledger = openIn(dir);
    ledger.ensureHeader({ settlementNonce: 0n, lifetimeContribution: 0n });
    ledger.append("CONFIRMED", confirmed());
    const path = ledger.journalPath;

    // There is nothing to capture: the sibling files do not exist at any point.
    expect(existsSync(`${path}-wal`)).toBe(false);
    expect(existsSync(`${path}-shm`)).toBe(false);

    ledger.append(
      "CONFIRMED",
      confirmed({
        startBlockL2: 22080860n,
        endBlockL2: 22080900n,
        settlementNonce: 1n,
        sessionId: "0xaaaa000000000000000000000000000000000000000000000000000000000002",
        txHash: "0xd342d117000000000000000000000000000000000000000000000000000cad187",
      }),
    );
    const frontier = ledger.state.settledFrontierL2;
    ledger.close();

    // Both settlements survive a reopen, and the store is still one file.
    const reopened = openIn(dir);
    expect(reopened.state.settledFrontierL2).toBe(frontier);
    expect(reopened.state.condition).toBe("HEALTHY");
    expect(existsSync(`${path}-wal`)).toBe(false);
  });

  it("REFUSES A -wal THAT IS GONE WHILE ITS -shm SURVIVES", () => {
    // The vice versa. A -shm is a pure shared-memory index holding NO durable
    // data; a -wal holds committed transactions the .db does not yet contain. The
    // two are created together and unlinked together, so a -shm alone means either
    // the write-ahead log was removed by hand — silently rewinding this store past
    // settlements it committed — or a crash landed between two unlinks. The
    // message names the second case and its one-line escape.
    const dir = freshDir();
    const ledger = openIn(dir);
    ledger.ensureHeader({ settlementNonce: 0n, lifetimeContribution: 0n });
    ledger.append("CONFIRMED", confirmed());
    const path = ledger.journalPath;
    // Built the same way as syntheticWal: journal_mode=DELETE never makes one, but
    // an older WAL-mode build did, and the shape must still be refused.
    const shm = syntheticShm();
    ledger.close();
    writeFileSync(`${path}-shm`, shm);

    const probe = probeStoreFile(path);
    expect(probe.condition).toBe("DAMAGED");
    expect(probe.walBytes).toBeNull();
    expect(probe.detail).toContain("-wal is GONE");
    expect(probe.detail).toContain("holds no data and may be removed");

    const reopened = openIn(dir);
    expect(reopened.state.condition).toBe("DAMAGED");
    expect(reopened.state.integrityOk).toBe(false);
  });

  it("A .db THAT SIMPLY DOES NOT EXIST IS A GENUINE FIRST RUN, and still proceeds", () => {
    // Fail-closed must not mean fail-always. ABSENT is the one case that is not
    // damage, and it is the ONLY case in which a schema is ever created.
    const dir = freshDir();
    expect(probeStoreFile(dbIn(dir)).condition).toBe("ABSENT");
    expect(probeStoreFile(dbIn(dir)).detail).toBeNull();

    const ledger = openIn(dir);
    expect(ledger.state.condition).toBe("HEALTHY");
    expect(ledger.state.integrityOk).toBe(true);
    ledger.ensureHeader({ settlementNonce: 0n, lifetimeContribution: 0n });
    ledger.append("CONFIRMED", confirmed());
    expect(ledger.state.settledFrontierL2).toBe(22080850n);
    ledger.close();

    // And a healthy store reopens healthy, with its history intact.
    const reopened = openIn(dir);
    expect(reopened.state.condition).toBe("HEALTHY");
    expect(reopened.state.integrityOk).toBe(true);
    expect(reopened.state.settledFrontierL2).toBe(22080850n);
  });

  it("EVERY DAMAGED VARIANT REFUSES EVERY WRITE, and never loses a record silently", () => {
    // The write half of the rule: read paths degrade and report, WRITE PATHS
    // REFUSE. append() is what submit.ts must get through before it may broadcast,
    // so refusing here is refusing the broadcast.
    const variants: [string, (dir: string) => void][] = [
      ["zero-byte", (dir) => writeFileSync(dbIn(dir), "")],
      ["not a database", (dir) => writeFileSync(dbIn(dir), "definitely not sqlite\n")],
      [
        "truncated",
        (dir) => {
          const path = seededStore(dir);
          const bytes = readFileSync(path);
          writeFileSync(path, bytes.subarray(0, Math.floor(bytes.length / 2)));
        },
      ],
      [
        "missing decision table",
        (dir) => {
          const path = seededStore(dir);
          const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
          const db = new DatabaseSync(path);
          db.exec("DROP TABLE settlement");
          db.close();
        },
      ],
    ];

    for (const [label, damage] of variants) {
      const dir = freshDir();
      damage(dir);
      const ledger = openIn(dir);
      expect(ledger.state.condition, label).toBe("DAMAGED");

      // localEligibility refuses, with the reason code callers switch on.
      const verdict = localEligibility(
        ledger.state,
        {
          startBlockL2: 99000000n,
          endBlockL2: 99000100n,
          startBlockL1: 26000000n,
          endBlockL1: 26000004n,
          bindingEpoch: 9n,
          sessionId: "0xfeed",
        },
        LIMITS,
        Date.now(),
      );
      expect(verdict.ok, label).toBe(false);
      if (!verdict.ok) expect(verdict.rule, label).toBe("STORE_INTEGRITY");

      // And every write refuses outright rather than pretending to work.
      expect(() => ledger.append("CONFIRMED", confirmed()), label).toThrow(LedgerWriteError);
      expect(() => ledger.append("INTENT", intent()), label).toThrow(LedgerWriteError);
      expect(() => ledger.append("CHECKPOINT", { anchorBlockL2: 1n, anchorBlockHash: "0xaa", headBlockL2: 2n }), label).toThrow(
        LedgerWriteError,
      );
      expect(() => ledger.ensureHeader({ settlementNonce: 0n, lifetimeContribution: 0n }), label).toThrow(
        LedgerWriteError,
      );
      ledger.close();
    }
  });
});

// ---------------------------------------------------------------------------
// TAMPER DETECTION ON THE LOAD-BEARING PATH.
//
// `integrityOk` used to derive ONLY from the `record` table's digest chain. The
// record table is an AUDIT LOG. The tables that GATE a settlement are `settlement`
// (the frontier chain the dedup reads), `terminal_window` and `halt` — none of
// which carries a digest. Editing one of them was therefore invisible: before this
// block existed, deleting the single settlement row for a confirmed window left a
// store whose record stream said "settled", whose FRONTIER SAID NOTHING WAS
// SETTLED, and whose integrityOk was cheerfully TRUE.
// ---------------------------------------------------------------------------
describe("integrity covers the tables the decisions are made from", () => {
  const sqlite = (path: string): InstanceType<typeof import("node:sqlite").DatabaseSync> => {
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    return new DatabaseSync(path);
  };

  it("A DELETED SETTLEMENT ROW turns integrityOk FALSE, though the record stream verifies", () => {
    const dir = freshDir();
    const path = seededStore(dir);

    const db = sqlite(path);
    // The schema's own trigger refuses this, so an attacker has to drop it first —
    // which is the realistic shape, and which the reconciliation still catches.
    db.exec("DROP TRIGGER settlement_no_delete");
    db.prepare("DELETE FROM settlement WHERE id = 1").run();
    db.close();

    const reopened = openIn(dir);
    const read = reopened.readRecords();
    // The audit log is untouched and every digest verifies...
    expect(read.rejected).toEqual([]);
    expect(read.records.map((r) => r.type)).toEqual(["HEADER", "CONFIRMED"]);
    // ...and integrity is NOT ok anyway, because the frontier no longer follows
    // from the recorded settlements.
    expect(read.integrityOk).toBe(false);
    expect(read.integrityDetail).toContain("the settlement table does not contain");
    expect(reopened.state.integrityOk).toBe(false);
    // The store is HEALTHY (the file is sound) and NOT INTACT (the contents were
    // edited). Two different questions, two different fields.
    expect(reopened.state.condition).toBe("HEALTHY");

    const verdict = localEligibility(
      reopened.state,
      {
        startBlockL2: 30000000n,
        endBlockL2: 30000100n,
        startBlockL1: 26000000n,
        endBlockL1: 26000004n,
        bindingEpoch: 1n,
        sessionId: "0xdd",
      },
      LIMITS,
      Date.now(),
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.rule).toBe("STORE_INTEGRITY");

    // AND THE SECOND LAYER STILL FIRES. This is the part that matters: deleting
    // the settlement row makes the derived frontier NULL, so the schema's own
    // frontier trigger would happily accept the replay it used to refuse. The
    // store refuses the write itself rather than resting the whole guarantee on
    // localEligibility having been consulted.
    let thrown: unknown = null;
    try {
      reopened.append("CONFIRMED", confirmed({ txHash: "0xdeadbeef" }));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(LedgerConstraintError);
    expect((thrown as LedgerConstraintError).rule).toBe("STORE_INTEGRITY");
    // And an INTENT — the record that must exist durably before a broadcast — is
    // refused for the same reason, so no attestation can reach the wire.
    expect(() => reopened.append("INTENT", intent())).toThrow(LedgerConstraintError);
    // A CHECKPOINT still records: it moves no money, and a store in this state has
    // to stay able to write the records that explain it.
    expect(() =>
      reopened.append("CHECKPOINT", { anchorBlockL2: 1n, anchorBlockHash: "0xaa", headBlockL2: 2n }),
    ).not.toThrow();
  });

  it("AN EDITED SETTLEMENT ROW turns integrityOk FALSE and names the field", () => {
    const dir = freshDir();
    const path = seededStore(dir);

    const db = sqlite(path);
    db.exec("DROP TRIGGER settlement_immutable");
    // Raising the recorded contribution is exactly the edit an attacker makes; it
    // is also the one the record digest catches only in the AUDIT LOG.
    db.prepare("UPDATE settlement SET contribution_wei = '999999999999999' WHERE id = 1").run();
    db.close();

    const reopened = openIn(dir);
    const read = reopened.readRecords();
    expect(read.rejected).toEqual([]);
    expect(read.integrityOk).toBe(false);
    expect(read.integrityDetail).toContain("contributionWei");
    expect(read.integrityDetail).toContain("disagrees with record");
    expect(reopened.state.integrityOk).toBe(false);
  });

  it("A RELINKED FRONTIER ROW turns integrityOk FALSE: the chain must be ONE chain", () => {
    // The subtlest edit: leave every row present and correct, and move only the
    // link that says which frontier it extends. The derived MAX() is unchanged;
    // the chain is not.
    const dir = freshDir();
    const ledger = openIn(dir);
    ledger.ensureHeader({ settlementNonce: 0n, lifetimeContribution: 0n });
    ledger.append("CONFIRMED", confirmed());
    ledger.append(
      "CONFIRMED",
      confirmed({
        startBlockL2: 22080851n,
        endBlockL2: 22080900n,
        startBlockL1: 25635385n,
        endBlockL1: 25635390n,
        settlementNonce: 1n,
        sessionId: "0xaaaa000000000000000000000000000000000000000000000000000000000002",
        txHash: "0xd342d117000000000000000000000000000000000000000000000000000cad187",
      }),
    );
    const path = ledger.journalPath;
    ledger.close();

    const db = sqlite(path);
    db.exec("DROP TRIGGER settlement_immutable");
    // Point the second settlement at a frontier that is not the first one's end.
    // Every row is still present and still correct in itself; only the LINK moved,
    // and MAX(end_block_l2) is unchanged — which is precisely why a check that
    // looked at the derived frontier alone would see nothing. (Relinking it to the
    // genesis slot instead is refused by the schema's own settlement_live_genesis
    // index, which is the layer below this one.)
    db.prepare("UPDATE settlement SET prev_end_block_l2 = 22080000 WHERE id = 2").run();
    db.close();

    const reopened = openIn(dir);
    // The derived frontier is untouched: MAX() cannot see the break.
    expect(reopened.state.settledFrontierL2).toBe(22080900n);
    expect(reopened.state.integrityOk).toBe(false);
    expect(reopened.state.integrityDetail).toMatch(/not linked into the settled frontier chain/);
  });

  it("A DELETED terminal_window ROW turns integrityOk FALSE: a refusal that would not be honoured", () => {
    const dir = freshDir();
    const ledger = openIn(dir);
    ledger.ensureHeader({ settlementNonce: 0n, lifetimeContribution: 0n });
    ledger.append("SKIPPED", {
      startBlockL2: 22090000n,
      endBlockL2: 22090500n,
      reason: "REFUSED",
      detail: "the engine refused this window",
    });
    const path = ledger.journalPath;
    ledger.close();

    const db = sqlite(path);
    db.prepare("DELETE FROM terminal_window").run();
    db.close();

    const reopened = openIn(dir);
    expect(reopened.state.integrityOk).toBe(false);
    expect(reopened.state.integrityDetail).toContain("no terminal_window row records it");
  });

  it("A CLEARED halt ROW turns integrityOk FALSE: a halt that would not be enforced", () => {
    const dir = freshDir();
    const ledger = openIn(dir);
    ledger.ensureHeader({ settlementNonce: 0n, lifetimeContribution: 0n });
    ledger.append("DEGRADED", { reason: "NONCE_UNRECONCILED", detail: "planted by a test" });
    const path = ledger.journalPath;
    ledger.close();

    const db = sqlite(path);
    db.prepare("DELETE FROM halt").run();
    db.close();

    const reopened = openIn(dir);
    expect(reopened.state.degraded).toBeNull(); // the latch is gone from the table...
    expect(reopened.state.integrityOk).toBe(false); // ...and that is exactly what is reported
    expect(reopened.state.integrityDetail).toContain("no halt row records it");
  });

  it("leaves a HEALTHY, UNEDITED store intact: this check has no false positives", () => {
    // Every record type the projection knows about, plus an INTENT resolved by a
    // CONFIRMED (whose settlement row cites the INTENT's seq, not the CONFIRMED's)
    // and a RESUMED that clears a halt by name.
    const dir = freshDir();
    const ledger = openIn(dir);
    ledger.ensureHeader({ settlementNonce: 0n, lifetimeContribution: 0n });
    ledger.append("CHECKPOINT", { anchorBlockL2: 1n, anchorBlockHash: "0xaa", headBlockL2: 2n });
    ledger.append("CONFIRMED", confirmed());
    ledger.append("SKIPPED", {
      startBlockL2: 22080900n,
      endBlockL2: 22080950n,
      reason: "NON_POSITIVE_PROFIT",
      detail: "nothing to settle",
    });
    ledger.append("DRYRUN", {
      ...confirmed({ startBlockL2: 22081000n, endBlockL2: 22081100n }),
      attestationDigest: "0xdead",
      attester: "0x864743540b6D6E0a38f535e1200c0373e0D7AAde",
      wouldSendTo: "0x5D037fE7Fd65745BA51DDb433Aa5B17E965D46Ac",
      wouldSendValue: 0n,
    });
    const openIntent = intent({ startBlockL2: 22081200n, endBlockL2: 22081300n, settlementNonce: 1n });
    ledger.append("INTENT", openIntent);
    ledger.append(
      "CONFIRMED",
      confirmed({
        startBlockL2: 22081200n,
        endBlockL2: 22081300n,
        startBlockL1: 25641000n,
        endBlockL1: 25641004n,
        settlementNonce: 1n,
        sessionId: openIntent.sessionId,
        txHash: "0xd342d117000000000000000000000000000000000000000000000000000cad188",
      }),
    );
    const halt = ledger.append("DEGRADED", { reason: "TEST", detail: "planted", unaccountedBelow: 2n });
    ledger.append("RESUMED", { acknowledgedSeq: halt.seq, note: "acknowledged" });

    expect(ledger.state.integrityOk).toBe(true);
    expect(ledger.state.integrityDetail).toBeNull();
    expect(ledger.state.condition).toBe("HEALTHY");
    expect(ledger.state.settledFrontierL2).toBe(22081300n);
    ledger.close();

    const reopened = openIn(dir);
    expect(reopened.state.integrityOk).toBe(true);
    expect(reopened.state.integrityDetail).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// THE READ-ONLY COMMANDS, SPAWNED FOR REAL.
//
// Inventory guarantee #26: a corrupt store must never throw, because an
// inspection command has to work during exactly the incident it exists for. These
// spawn bin/keeper.mts as a child process and read its real stdout, stderr and
// exit code — a unit call to buildStatus would not catch a throw that escapes into
// the CLI's own error handling.
// ---------------------------------------------------------------------------
describe("keeper status and keeper journal stay usable on a store too damaged to run against", () => {
  const CLI = fileURLToPath(new URL("../bin/keeper.mts", import.meta.url));
  const CWD = fileURLToPath(new URL("..", import.meta.url));

  /**
   * Spawned ASYNCHRONOUSLY on purpose. `spawnSync` blocks this worker's event
   * loop for the whole run, and `keeper status` against a dead endpoint spends
   * ten-odd seconds in viem's retry backoff — long enough for vitest's own
   * worker RPC to time out and fail the run for a reason that has nothing to do
   * with the assertions.
   */
  const runCli = (
    command: string,
    stateDir: string,
  ): Promise<{ status: number | null; stdout: string; stderr: string }> =>
    new Promise((resolve, reject) => {
      const proc = spawn(process.execPath, ["--import", "tsx", CLI, command], {
        cwd: CWD,
        env: {
          ...process.env,
          // A closed port, so every chain read fails and is reported as "unknown"
          // rather than as a zero. `status` must survive that too.
          NUVEM_RPC_URL: "http://127.0.0.1:9/v2/notakey",
          NUVEM_KEEPER_ACCOUNT: ACCOUNT,
          // Explicit: there is no built-in vault, because a per-user address
          // must never come from a constant.
          NUVEM_VAULT: "0x0b5036063527bA4e32032e1b6B953c3677386BBD",
          // These tests are about the LOCAL store's damage detection, which is a
          // class of failure Postgres does not have. Inheriting a DATABASE_URL
          // from the runner would silently test a different backend.
          DATABASE_URL: "",
          NUVEM_KEEPER_DATABASE_URL: "",
          NUVEM_KEEPER_STATE_DIR: stateDir,
          NUVEM_ATTESTER_PRIVATE_KEY: "",
          NUVEM_ATTESTER_KEY_FILE: "",
          TRADING_OWNER_PRIVATE_KEY: "",
          NUVEM_TRADING_ACCOUNT: "",
          NUVEM_KEEPER_ALLOW_BROADCAST: "",
          NUVEM_KEEPER_HTTP_PORT: "0",
        },
      });
      let stdout = "";
      let stderr = "";
      proc.stdout.setEncoding("utf8");
      proc.stderr.setEncoding("utf8");
      proc.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      proc.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      proc.on("error", reject);
      proc.on("close", (status) => resolve({ status, stdout, stderr }));
    });

  const variants: [string, (dir: string) => void][] = [
    ["zero-byte", (dir) => writeFileSync(dbIn(dir), "")],
    ["not a database", (dir) => writeFileSync(dbIn(dir), "not sqlite, not even close\n")],
    [
      "truncated",
      (dir) => {
        const path = seededStore(dir);
        const bytes = readFileSync(path);
        writeFileSync(path, bytes.subarray(0, Math.floor(bytes.length / 2)));
      },
    ],
    [
      "missing decision table",
      (dir) => {
        const path = seededStore(dir);
        const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
        const db = new DatabaseSync(path);
        db.exec("DROP TABLE settlement");
        db.close();
      },
    ],
    [
      "orphaned -wal",
      (dir) => {
        const ledger = Ledger.open({ dir, instance: INSTANCE, noLock: true });
        ledger.ensureHeader({ settlementNonce: 0n, lifetimeContribution: 0n });
        ledger.append("CONFIRMED", confirmed());
        const path = ledger.journalPath;
        const wal = syntheticWal();
        ledger.close();
        unlinkSync(path);
        writeFileSync(`${path}-wal`, wal);
      },
    ],
  ];

  for (const [label, damage] of variants) {
    it(`keeper status exits without throwing and SHOWS the damage: ${label}`, { timeout: 120_000 }, async () => {
      const dir = freshDir();
      damage(dir);
      const { status, stdout, stderr } = await runCli("status", dir);

      // It EXITS, cleanly. It does not crash on a getter that throws, which is
      // what `state` used to do on a store missing a decision table.
      expect(status, `${label}: ${stderr}`).toBe(0);
      expect(`${stdout}${stderr}`, label).not.toMatch(/fatal: (uncaught exception|unhandled rejection)/);
      expect(`${stdout}${stderr}`, label).not.toContain("LedgerWriteError");

      // And it SHOWS the damage, in the block an operator reads first.
      const payload = JSON.parse(stdout.slice(stdout.indexOf("{\n"))) as {
        store: { condition: string; integrityOk: boolean; settleable: boolean; detail: string };
      };
      expect(payload.store.condition, label).toBe("DAMAGED");
      expect(payload.store.integrityOk, label).toBe(false);
      expect(payload.store.settleable, label).toBe(false);
      expect(payload.store.detail, label).toBeTruthy();
      // On stderr too, because stdout is JSON and an operator piping it into jq
      // would otherwise never see it.
      expect(stderr, label).toContain("STORE DAMAGED");
    });

    it(`keeper journal exits without throwing and SHOWS the damage: ${label}`, { timeout: 120_000 }, async () => {
      const dir = freshDir();
      damage(dir);
      const { status, stdout, stderr } = await runCli("journal", dir);
      // Non-zero, because integrity is not intact — but an ORDERLY non-zero.
      expect(status, `${label}: ${stderr}`).toBe(1);
      expect(stdout, label).toContain("state:   DAMAGED");
      expect(stdout, label).toContain("integrity: NOT INTACT");
      expect(`${stdout}${stderr}`, label).not.toMatch(/fatal: (uncaught exception|unhandled rejection)/);
    });
  }

  it("keeper status on a HEALTHY store reports HEALTHY and settleable", { timeout: 120_000 }, async () => {
    const dir = freshDir();
    seededStore(dir);
    const { status, stdout } = await runCli("status", dir);
    expect(status).toBe(0);
    const payload = JSON.parse(stdout.slice(stdout.indexOf("{\n"))) as {
      store: { condition: string; integrityOk: boolean; settleable: boolean };
    };
    expect(payload.store.condition).toBe("HEALTHY");
    expect(payload.store.integrityOk).toBe(true);
    expect(payload.store.settleable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The store is the operator's realized-profit history and the file the dedup
// depends on. instance.json, the snapshot and keeper.lock are all 0600; this was
// 0644 (observed -rw-r--r-- on the volume) because SQLITE CREATES THE FILE ITSELF,
// honouring the process umask — and does the same for any journal beside it.
// ---------------------------------------------------------------------------
describe("the store's file mode", () => {
  // Windows has no POSIX mode: chmod moves only the read-only bit and stat reports
  // 0666 for everything, including the files that ask for 0600 today. Asserting a
  // mode there would test the platform, not this code.
  const honoursMode = process.platform !== "win32";

  it.runIf(honoursMode)("is 0600 on the .db, and the store is still ONE file", () => {
    const dir = freshDir();
    const ledger = openIn(dir);
    ledger.ensureHeader({ settlementNonce: 0n, lifetimeContribution: 0n });
    // A committed write, so the store has been through the whole journal cycle by
    // the time it is inspected.
    ledger.append("CONFIRMED", confirmed());
    const path = ledger.journalPath;
    expect(statSync(path).mode & 0o777, path).toBe(0o600);
    // journal_mode=DELETE, so a committed store is ONE file. Asserting a mode on
    // -wal/-shm asserted they exist, which is the two-file store #configure
    // refuses to run on and the probe reports as damage — the mode is not the
    // question there, the presence is. The rollback journal is likewise unlinked
    // at commit; it is hardened when a crash leaves a hot one behind, and that
    // path is covered where recovery is.
    for (const sibling of [`${path}-wal`, `${path}-shm`, `${path}-journal`]) {
      expect(existsSync(sibling), sibling).toBe(false);
    }
    // And the files that were already 0600 have not regressed.
    expect(statSync(join(dir, "instance.json")).mode & 0o777).toBe(0o600);
    ledger.close();
  });

  it("never fails startup over a mode it could not set", () => {
    // A chmod failure DEGRADES AND WARNS. On Windows the mode is advisory and on
    // some container storage drivers chmod is refused outright; losing the ability
    // to start over a permission bit would be a worse trade than the bit is worth.
    const dir = freshDir();
    const ledger = openIn(dir);
    ledger.ensureHeader({ settlementNonce: 0n, lifetimeContribution: 0n });
    expect(ledger.state.condition).toBe("HEALTHY");
    expect(Array.isArray(ledger.permissionWarnings)).toBe(true);
    ledger.close();
  });
});

describe("two writers", () => {
  it("refuses two writers on one volume", () => {
    const dir = freshDir();
    const first = Ledger.open({ dir, instance: INSTANCE });
    openLedgers.push(first);
    expect(() => Ledger.open({ dir, instance: INSTANCE })).toThrow(LedgerLockedError);
    first.close();
    // Released on close, so a clean restart works without --force-unlock.
    Ledger.open({ dir, instance: INSTANCE }).close();
  });

  it("TWO CONCURRENT PROCESSES CANNOT BOTH RECORD THE SAME SETTLEMENT", () => {
    // Belt AND braces. The lock above is the belt; this is the braces, and it is
    // the one that holds when someone has bypassed the lock (--force-unlock in
    // compose's `command:`, a shared volume, two containers). Two INDEPENDENT
    // connections, no lock, racing for the same window.
    //
    // The frontier trigger's SELECT MAX(end_block_l2) runs inside the writer's
    // exclusive lock, so the second connection cannot observe a stale frontier.
    const dir = freshDir();
    const a = openIn(dir);
    const b = openIn(dir);
    expect(a.journalPath).toBe(b.journalPath);

    a.append("CONFIRMED", confirmed());
    // b's cached view is stale, exactly as a second process's would be.
    let thrown: unknown = null;
    try {
      b.append(
        "CONFIRMED",
        confirmed({
          bindingEpoch: 2n,
          settlementNonce: 9n,
          sessionId: "0x8888000000000000000000000000000000000000000000000000000000000001",
          txHash: "0x8888000000000000000000000000000000000000000000000000000000000002",
        }),
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(LedgerConstraintError);
    expect((thrown as LedgerConstraintError).rule).toBe("REPLAY");
    // And the operator gets told WHICH settlement blocked it, not "UNIQUE
    // constraint failed: settlement.account".
    expect((thrown as Error).message).toContain("Blocked by settlement");
    expect((thrown as Error).message).toContain("22080592");

    expect(b.state.settlementCount).toBe(1);
    b.close();
    a.close();
  });

  it("two concurrent processes cannot both hold an open INTENT", () => {
    const dir = freshDir();
    const a = openIn(dir);
    const b = openIn(dir);
    a.append("INTENT", intent());
    expect(() =>
      b.append(
        "INTENT",
        intent({
          startBlockL2: 23000000n,
          endBlockL2: 23000100n,
          settlementNonce: 9n,
          sessionId: "0x6666000000000000000000000000000000000000000000000000000000000001",
          rawTxHash: "0x6666000000000000000000000000000000000000000000000000000000000002",
        }),
      ),
    ).toThrow(LedgerConstraintError);
    expect(b.state.openIntents).toHaveLength(1);
    b.close();
    a.close();
  });
});

// ---------------------------------------------------------------------------
describe("the single-writer lock, and getting out of a stale one", () => {
  const lockPath = (dir: string): string => join(dir, "keeper.lock");
  const plant = (dir: string, body: unknown): void =>
    writeFileSync(lockPath(dir), `${JSON.stringify(body)}\n`, { mode: 0o600 });
  /**
   * A lockfile that genuinely describes THIS live process, taken from a real
   * Ledger.open rather than reconstructed. Reconstructing it is not safe: the
   * process start instant must be byte-identical to the one the lock recorded, and
   * `Date.now() - process.uptime()*1000` jitters by a millisecond between calls.
   */
  const ourLiveLockBody = (dir: string): string => {
    const ledger = Ledger.open({ dir, instance: INSTANCE });
    const body = readFileSync(lockPath(dir), "utf8");
    ledger.close(); // releases it, so the caller can plant it back deliberately
    return body;
  };

  it("records the owning pid, the host and the process start time", () => {
    const dir = freshDir();
    const ledger = Ledger.open({ dir, instance: INSTANCE });
    const body = JSON.parse(readFileSync(lockPath(dir), "utf8")) as Record<string, unknown>;
    ledger.close();
    expect(body.pid).toBe(process.pid);
    expect(typeof body.hostname).toBe("string");
    // Not the same thing as when the lock was taken: this is what makes a stale
    // pid-1 lock inside a restarted container decidable at all.
    expect(typeof body.processStartedAt).toBe("string");
    expect(typeof body.startedAt).toBe("string");
  });

  it("reclaims a lock whose recorded pid is not running, and says so", () => {
    const dir = freshDir();
    // A pid that cannot be running: the kernel never allocates 0 as a user pid,
    // and process.kill(0, 0) would signal our own group rather than probe.
    plant(dir, {
      pid: 2_147_483_646,
      hostname: hostname(),
      startedAt: "2026-07-01T00:00:00.000Z",
      processStartedAt: "2026-07-01T00:00:00.000Z",
    });
    const ledger = Ledger.open({ dir, instance: INSTANCE });
    openLedgers.push(ledger);
    expect(ledger.lockReclaimed).not.toBeNull();
    expect(ledger.lockReclaimed?.why).toContain("is not running");
    // The new lock preserves what it took over, so an operator can see it happened.
    const body = JSON.parse(readFileSync(lockPath(dir), "utf8")) as {
      pid: number;
      reclaimedFrom?: { pid: number };
    };
    expect(body.pid).toBe(process.pid);
    expect(body.reclaimedFrom?.pid).toBe(2_147_483_646);
    ledger.close();
  });

  it("reclaims a lock that records our own pid from an earlier incarnation", () => {
    // THE CONTAINER CASE, which pid liveness alone cannot decide: under tini the
    // keeper is pid 1, so after a hard kill the replacement is pid 1 too and the
    // stale holder looks alive — it is us. The process start time breaks the tie.
    const dir = freshDir();
    plant(dir, {
      pid: process.pid,
      hostname: hostname(),
      startedAt: "2026-07-01T00:00:00.000Z",
      processStartedAt: "2026-07-01T00:00:00.000Z", // not our start: a previous life
    });
    const ledger = Ledger.open({ dir, instance: INSTANCE });
    openLedgers.push(ledger);
    expect(ledger.lockReclaimed?.why).toContain("previous");
    ledger.close();
  });

  it("does NOT steal a live lock", () => {
    const dir = freshDir();
    const first = Ledger.open({ dir, instance: INSTANCE });
    openLedgers.push(first);
    expect(() => Ledger.open({ dir, instance: INSTANCE })).toThrow(LedgerLockedError);
    first.close();
    Ledger.open({ dir, instance: INSTANCE }).close();
  });

  it("does NOT reclaim a lock held by this very process", () => {
    // Same pid AND same process start: a genuine double-open, not a leftover.
    const dir = freshDir();
    writeFileSync(lockPath(dir), ourLiveLockBody(dir), { mode: 0o600 });
    expect(() => Ledger.open({ dir, instance: INSTANCE })).toThrow(LedgerLockedError);
  });

  it("does NOT reclaim a lock taken on another host", () => {
    // A state volume shared between hosts is unsupported, and a pid from over
    // there cannot be probed from here. Absence of evidence is not evidence.
    const dir = freshDir();
    plant(dir, {
      pid: 2_147_483_646,
      hostname: "some-other-box",
      startedAt: "2026-07-01T00:00:00.000Z",
      processStartedAt: "2026-07-01T00:00:00.000Z",
    });
    expect(() => Ledger.open({ dir, instance: INSTANCE })).toThrow(/different host/);
  });

  it("reclaims a stale lock left by an earlier build's lockfile format", () => {
    // The old format was {pid, startedAt} — no hostname, no process start. If that
    // could not be judged, the first start after upgrading would hit the crash loop
    // this whole mechanism exists to remove.
    const dir = freshDir();
    plant(dir, { pid: 2_147_483_646, startedAt: "2026-07-01T00:00:00.000Z" });
    const ledger = Ledger.open({ dir, instance: INSTANCE });
    openLedgers.push(ledger);
    expect(ledger.lockReclaimed?.why).toContain("is not running");
    ledger.close();
  });

  it("does NOT reclaim an old-format lock whose pid is still alive", () => {
    // Missing metadata is not a licence. A live pid is still a live pid, and
    // kill(pid,0) returning EPERM counts as ALIVE.
    const dir = freshDir();
    plant(dir, { pid: process.ppid, startedAt: "2026-07-01T00:00:00.000Z" });
    expect(() => Ledger.open({ dir, instance: INSTANCE })).toThrow(LedgerLockedError);
  });

  it("does NOT reclaim a lockfile it cannot parse, and clips what it echoes", () => {
    const dir = freshDir();
    writeFileSync(lockPath(dir), `not json at all ${"x".repeat(500)}\n`);
    let message = "";
    try {
      Ledger.open({ dir, instance: INSTANCE });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("could not be parsed");
    // Nothing of unknown provenance is spilled at length into an operator's terminal.
    expect(message).toContain("(clipped)");
    expect(message).not.toContain("x".repeat(200));
  });

  it("tells the operator not to bake --force-unlock into compose", () => {
    // The point of the message: the routine fix is automatic reclaim, and a flag
    // in `command:` is permanent. `command:` is also where --broadcast would go.
    const dir = freshDir();
    const first = Ledger.open({ dir, instance: INSTANCE });
    openLedgers.push(first);
    let message = "";
    try {
      Ledger.open({ dir, instance: INSTANCE });
    } catch (error) {
      message = (error as Error).message;
    }
    first.close();
    expect(message).toContain("reclaimed AUTOMATICALLY");
    expect(message).toMatch(/NEVER put --force-unlock in docker-compose's `command:`/);
  });

  it("still honours --force-unlock for the genuinely ambiguous case", () => {
    const dir = freshDir();
    writeFileSync(lockPath(dir), ourLiveLockBody(dir), { mode: 0o600 });
    const ledger = Ledger.open({ dir, instance: INSTANCE, forceUnlock: true });
    openLedgers.push(ledger);
    expect(ledger.lockReclaimed?.why).toContain("--force-unlock");
    ledger.close();
  });

  it("a read-only path opens WITHOUT taking the lock, and mutates nothing", () => {
    const dir = freshDir();
    const keeper = Ledger.open({ dir, instance: INSTANCE });
    openLedgers.push(keeper);
    keeper.append("CONFIRMED", confirmed());
    // An inspection command must not take a lock that would lock out the running
    // keeper, and must not change what it is inspecting.
    const inspector = Ledger.open({ dir, instance: INSTANCE, noLock: true });
    openLedgers.push(inspector);
    expect(inspector.lockPath).toBeNull();
    expect(inspector.state.settledFrontierL2).toBe(22080850n);
    expect(inspector.state.seq).toBe(0);
    inspector.close();
    // Closing the unlocked reader did not release the keeper's lock.
    expect(() => Ledger.open({ dir, instance: INSTANCE })).toThrow(LedgerLockedError);
    keeper.close();
  });
});

// ---------------------------------------------------------------------------
describe("coverage that is not known is not settled from", () => {
  it("an adopted settlement with an unknown L2 window refuses EVERY window, honestly", () => {
    // "New session" and "replay" are genuinely indistinguishable when the settled
    // frontier is unknown. Refusing is right; claiming lost revenue would not be,
    // and calling it ALREADY_SETTLED would bury it under the one label an
    // operator never investigates.
    const dir = freshDir();
    const ledger = openIn(dir);
    ledger.append("ADOPTED", {
      // Both L2 slots zero: 0 means UNKNOWN here, never "block zero".
      startBlockL2: 0n,
      endBlockL2: 0n,
      sessionId: "0xcccc000000000000000000000000000000000000000000000000000000000099",
      bindingEpoch: 1n,
      settlementNonce: 0n,
      startBlockL1: 25635381n,
      endBlockL1: 25635384n,
      ledgerRoot: "0x00",
      contribution: 1n,
      realizedProfit: 1n,
      txHash: "0xdddd000000000000000000000000000000000000000000000000000000000099",
      blockNumberL2: 3n,
      gasUsed: 0n,
      source: "adopted",
    });
    const state = ledger.state;
    expect(state.coverageUnresolved).toBe(1);
    // The nonce is still nameable — the settlement IS accounted for — and the
    // chain-guard mirror still has the L1 range from calldata.
    expect([...state.settledSettlementNonces]).toEqual(["0"]);
    expect(state.chainGuardL1.get("1")).toBe(25635384n);
    // But the L2 frontier is unknown, so nothing may be settled.
    expect(state.settledFrontierL2).toBeNull();
    const verdict = localEligibility(
      state,
      {
        startBlockL2: 90_000_000n,
        endBlockL2: 90_000_100n,
        startBlockL1: 26_000_000n,
        endBlockL1: 26_000_004n,
        bindingEpoch: 1n,
        sessionId: "0xabc0000000000000000000000000000000000000000000000000000000000001",
      },
      LIMITS,
      Date.now(),
    );
    ledger.close();
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.rule).toBe("COVERAGE_UNRESOLVED");
      expect(verdict.detail).toContain("keeper recover");
    }
  });
});

// ---------------------------------------------------------------------------
describe("windowKey", () => {
  it("keys on the L2 window, independent of bindingEpoch and sessionId", () => {
    // The vault's own guards are keyed on bindingEpoch, which an admin
    // pause/resume increments — resetting lastEndBlock to zero and making the
    // whole settled history replayable onchain. The keeper's key must not move
    // when that happens. This was the ONE place the old design got the rebind
    // question right, and it is the template the schema is now built on.
    expect(windowKey({ startBlockL2: 1n, endBlockL2: 2n })).toBe("1:2");
  });
});
