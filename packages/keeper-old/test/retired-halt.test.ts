// Clearing a latch left behind by a check that no longer exists.
//
// The DEGRADED latch is durable so that a keeper which stopped for a reason
// nobody understood cannot quietly resume. That is right. What it did not
// anticipate is the latch OUTLIVING ITS OWN CHECK: two production accounts sat
// halted citing CONTRIBUTION_CIRCUIT_BREAKER, a rule deleted from the code,
// clearable only by an operator holding DATABASE_URL. The keeper refused to work
// and named a reason that no longer existed.
//
// The rule that fixes it has to be narrow or it is just a way of ignoring halts.
// The narrowness is the point of the first test here.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { RETIRED_HALT_REASONS, clearRetiredHalt } from "../src/account-runner.js";
import type { JournalStore } from "../src/journal-store.js";
import type { Logger } from "../src/log.js";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src");

const silent = (): Logger => {
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => logger,
  };
  return logger;
};

/** A journal that records what was appended and nothing else. */
const journalWith = (degraded: { seq: number; reason: string; detail: string } | null) => {
  const appended: { type: string; body: Record<string, unknown> }[] = [];
  const store = {
    state: { degraded },
    append: (type: string, body: Record<string, unknown>) => {
      appended.push({ type, body });
      return { seq: 1 };
    },
  };
  return { store: store as unknown as JournalStore, appended };
};

describe("which halts may clear themselves", () => {
  /**
   * THE TEST THAT KEEPS THIS SAFE.
   *
   * reconcile.ts raises the halts that mean the CHAIN AND THE JOURNAL DISAGREE
   * about settled money. Those are the only ones carrying `unaccountedBelow`,
   * which travels into the RESUMED record and RAISES acknowledgedNonceFloor — so
   * auto-clearing one would move a safety floor with nobody watching.
   *
   * Rather than trust a comment saying "do not add reconcile reasons here", this
   * reads reconcile.ts and fails if any reason it can raise has been added to the
   * retired set. Someone retiring a check in a year does not have to know why.
   */
  it("never retires a reason reconcile.ts can raise", () => {
    const source = readFileSync(join(SRC, "reconcile.ts"), "utf8");
    const raised = new Set(
      [...source.matchAll(/reason:\s*"([A-Z_]+)"/g)].map((match) => match[1] as string),
    );
    // A parser that matched nothing would make this test vacuously green.
    expect(raised.size).toBeGreaterThan(0);

    const overlap = [...RETIRED_HALT_REASONS].filter((reason) => raised.has(reason));
    expect(
      overlap,
      "a reconcile halt means settled money is unaccounted for; it must never clear itself",
    ).toEqual([]);
  });

  it("only retires reasons this build can no longer raise", () => {
    // Every retired reason must be absent from the whole source tree, save the
    // retired list itself — otherwise the latch would be cleared and immediately
    // written again, once per sweep, forever.
    const attest = readFileSync(join(SRC, "attest.ts"), "utf8");
    for (const reason of RETIRED_HALT_REASONS) {
      expect(attest.includes(`"${reason}"`), `${reason} is still raised in attest.ts`).toBe(false);
    }
  });
});

describe("clearing a retired latch", () => {
  it("writes a RESUMED naming the exact record it clears", () => {
    const { store, appended } = journalWith({
      seq: 74,
      reason: "CONTRIBUTION_CIRCUIT_BREAKER",
      detail: "contribution 19255000000000000 exceeds …",
    });

    expect(clearRetiredHalt(store, silent())).toBe(true);
    expect(appended).toHaveLength(1);
    expect(appended[0]?.type).toBe("RESUMED");
    // Naming the seq is what stops a stale acknowledgement clearing a new halt.
    expect(appended[0]?.body.acknowledgedSeq).toBe(74);
  });

  it("leaves a halt it does not recognise exactly where it is", () => {
    const { store, appended } = journalWith({
      seq: 12,
      reason: "UNACCOUNTED_SETTLEMENTS",
      detail: "the chain reports settlements this journal has never seen",
    });

    expect(clearRetiredHalt(store, silent())).toBe(false);
    expect(appended).toEqual([]);
  });

  it("does nothing at all when there is no latch", () => {
    const { store, appended } = journalWith(null);
    expect(clearRetiredHalt(store, silent())).toBe(false);
    expect(appended).toEqual([]);
  });

  it("says so out loud, because a latch disappearing must never be silent", () => {
    const lines: { msg: string; fields?: Record<string, unknown> }[] = [];
    const logger = {
      debug: () => {},
      info: () => {},
      warn: (msg: string, fields?: Record<string, unknown>) => lines.push({ msg, ...(fields ? { fields } : {}) }),
      error: () => {},
      child: () => logger,
    } as unknown as Logger;

    const { store } = journalWith({ seq: 11, reason: "CONTRIBUTION_CIRCUIT_BREAKER", detail: "…" });
    clearRetiredHalt(store, logger);

    expect(lines).toHaveLength(1);
    expect(lines[0]?.fields?.acknowledgedSeq).toBe(11);
  });
});
