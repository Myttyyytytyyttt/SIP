// That SIP_SOLANA_CARRY_STORE is wired in bin/keeper.mts ONLY when it is not
// `off`, and that the schema holds what src/carry-store.ts reads and writes. The
// rules live in src/carry-store.ts and test/carry-store*.test.ts; this file pins
// the switch and the table.
//
// WHY THE SOURCE IS READ, as in test/cuts-wiring.test.ts: the sweep is a closure
// inside a top-level script that connects to a chain, a database and Privy before
// it defines one. What regresses here is structural — a store handed to a turn
// while `off`, a keeper that acts in `on` without its table, a /status that grew
// a key for everyone — and it reads back from the text.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LOSS_CARRY_COLUMNS } from "../src/carry-store.js";

const source = (path: string): string => readFileSync(fileURLToPath(new URL(path, new URL("..", import.meta.url))), "utf8");
const keeper = source("bin/keeper.mts");
const sql = source("sql/sip_solana.sql");
const tick = source("src/settle-tick.ts");

const sweepBody = ((): string => {
  const start = keeper.indexOf("async function sweep(): Promise<void> {");
  expect(start).toBeGreaterThan(-1);
  return keeper.slice(start, keeper.indexOf("\n}\n", start));
})();

describe("the keeper's switch", () => {
  it("builds no store while off, and one store, on its own pool, when dual or on", () => {
    expect(keeper).toMatch(/const carryStore: DurableCarries \| null =\n\s+config\.carryStore === "off" \|\| config\.databaseUrl === null\n\s+\? null\n\s+: new DurableCarries\(/);
    expect(keeper.match(/new DurableCarries\(/g)).toHaveLength(1);
    expect(keeper).toContain("createCarryPool(config.databaseUrl,");
  });

  it("hands the store to the settle turn only when there is one", () => {
    expect(sweepBody).toContain("...(carryStore === null ? {} : { carryStore }),");
    expect(keeper.match(/\{ carryStore \}/g)).toHaveLength(1);
  });

  it("does not act in on until the store is ready: the live blocker asks it after every other condition", () => {
    expect(keeper).toMatch(
      /const liveBlocker = \(\): string \| null =>\n(?:[\s\S]{0,600}\n)?\s+missingLiveCondition\(\{[^}]*\}\) \?\?\n(\s+\/\/[^\n]*\n)*\s+carryStore\?\.liveBlocker\(\) \?\?\n\s+null;/,
    );
  });

  it("prepares the store before the first sweep and before every sweep, ahead of the live decision", () => {
    const boot = keeper.indexOf("await carryStore.prepare(settleCarries);");
    const firstMode = keeper.indexOf('health.mode = isLive() ? "live" : "dry-run";', boot);
    expect(boot).toBeGreaterThan(-1);
    expect(firstMode).toBeGreaterThan(boot);
    const perSweep = sweepBody.indexOf("if (carryStore !== null) await carryStore.prepare(settleCarries);");
    expect(perSweep).toBeGreaterThan(-1);
    expect(sweepBody.indexOf("const liveAtStart = isLive();")).toBeGreaterThan(perSweep);
  });

  it("adds /status's carryStore block only when there is a store, beside the cuts' blocks every render serves", () => {
    const start = keeper.indexOf("function cutsStatusBlocks(): Pick<KeeperStatus, \"discovery\" | \"cuts\" | \"carryStore\" | \"ops\" | \"dispatch\"> {");
    expect(start).toBeGreaterThan(-1);
    const blocks = keeper.slice(start);
    expect(blocks.slice(0, blocks.indexOf("\n}\n"))).toContain("...(carryStore === null ? {} : { carryStore: carryStore.status() }),");
    expect(keeper).toContain("doorbell: doorbellStatus(), ...cutsStatusBlocks() }, sharedRedactor)");
  });
});

describe("the settle turn's two call sites", () => {
  it("reads and writes memory exactly as before when no store is passed", () => {
    expect(tick).toContain("if (deps.carryStore === undefined) {\n    carry = carryFor(deps.carries, link);");
    expect(tick).toContain("if (deps.carryStore === undefined) {\n    recordCarry(deps.carries, link, decision.endSlot, decision.carry ?? null);");
  });

  it("writes the carry before the send, never after it, on every path", () => {
    const write = tick.indexOf("deps.carryStore.recordCarry(");
    const send = tick.indexOf("signature = await connection.sendRawTransaction(");
    const privy = tick.indexOf("signature = await walletSigner.submit(");
    expect(write).toBeGreaterThan(-1);
    expect(send).toBeGreaterThan(write);
    expect(privy).toBeGreaterThan(write);
  });
});

describe("sip_solana.loss_carry", () => {
  const ddl = sql.slice(sql.indexOf("CREATE TABLE IF NOT EXISTS sip_solana.loss_carry ("), sql.indexOf(");", sql.indexOf("CREATE TABLE IF NOT EXISTS sip_solana.loss_carry (")));

  it("declares every column the store reads and writes", () => {
    for (const column of LOSS_CARRY_COLUMNS) expect(ddl, column).toMatch(new RegExp(`\\n\\s+${column}\\s`));
  });

  it("is keyed exactly as the memory book, and refuses a loss that is not one", () => {
    expect(ddl).toContain("PRIMARY KEY (link_addr, epoch, settlement_nonce, frontier_slot)");
    expect(ddl).toContain("loss_lamports          bigint      NOT NULL CHECK (loss_lamports > 0)");
  });

  it("is additive, and the file's header no longer calls every table rebuildable", () => {
    expect(sql).toContain("DERIVED AND REBUILDABLE — EXCEPT sip_solana.loss_carry");
    expect(sql).toContain("loss_carry IS NOT DERIVED AND CANNOT BE REBUILT");
    // NO STATEMENT IN THE FILE DROPS OR EMPTIES A TABLE (comments may name the rule).
    const statements = sql
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");
    expect(statements).not.toMatch(/DROP\s+TABLE|TRUNCATE|DELETE\s+FROM/i);
  });
});
