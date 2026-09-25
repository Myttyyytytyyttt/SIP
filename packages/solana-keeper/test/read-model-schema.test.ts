// The schema, the writer and the call site have to agree, and no unit test can
// call bin/keeper.mts — so this reads the sources, the way
// test/read-model-rate.test.ts and test/privy-client-sites.test.ts do.
//
// WHAT IT IS DEFENDING AGAINST, concretely: a column added to the DDL but not
// to the INSERT records nothing new; a column added to the INSERT but not to
// the DDL makes Postgres refuse the whole statement, and recordSettlement turns
// that into a warning nobody reads — every settlement row lost, silently, for
// as long as the deploy is ahead of its migration.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { REQUIRED_SETTLEMENT_COLUMNS } from "../src/read-model.js";

const PACKAGE = new URL("..", import.meta.url);
const source = (path: string): string => readFileSync(fileURLToPath(new URL(path, PACKAGE)), "utf8");

const sql = source("sql/sip_solana.sql");
const readModel = source("src/read-model.ts");
const keeper = source("bin/keeper.mts");
const backfill = source("bin/backfill-settlements.mts");
const setup = source("bin/setup-read-model.mts");

describe("the settlement mirror's shape", () => {
  it("declares every column the preflight demands", () => {
    for (const column of REQUIRED_SETTLEMENT_COLUMNS) {
      expect(sql, `${column} is required at boot but absent from the DDL`).toContain(column);
    }
  });

  it("adds volume_raw with an ALTER, because the schema is applied to a live database", () => {
    // CREATE TABLE IF NOT EXISTS does nothing at all to a table that exists, so
    // a column written into the CREATE would be missing on every database this
    // file has already run against — including the one in production.
    expect(sql).toMatch(/ALTER TABLE sip_solana\.settlement_event\s+ADD COLUMN IF NOT EXISTS volume_raw numeric NOT NULL DEFAULT 0;/);
  });

  it("writes volume_raw on insert and on conflict", () => {
    expect(readModel).toContain("(wallet_addr, nonce, vault_addr, mode, base_raw, contribution_raw, volume_raw, tx_ref, height, at)");
    expect(readModel).toContain("VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE($10::timestamptz, now()))");
    // A re-recorded settlement must not keep the old volume beside a new tx.
    expect(readModel).toContain("volume_raw = EXCLUDED.volume_raw");
  });

  it("dates a row by the block when one is given, and never moves an existing row's date", () => {
    // The leaderboard groups by calendar day. A backfill that let `at` default
    // to now() would pile months of settlements onto today and turn one
    // rebuilt history into one enormous day.
    expect(backfill).toContain("at,");
    expect(backfill).toContain("tx.blockTime");
    // And the LIVE path passes it too, from the receipt it already reads: a row
    // written as it happens and the same row rebuilt from the chain must carry
    // the same date, or a rebuild could move somebody between days.
    expect(keeper).toContain("at: new Date(settle.blockTimeMs)");
    expect(source("src/settle-tick.ts")).toContain("blockTimeMs = receipt.blockTime * 1_000;");
    // `at` is absent from the ON CONFLICT SET list on purpose.
    const onConflict = readModel.slice(readModel.indexOf("ON CONFLICT (wallet_addr, nonce) DO UPDATE"), readModel.indexOf("WHERE ${READ_MODEL_SCHEMA}.settlement_event.tx_ref"));
    expect(onConflict).not.toContain("at =");
  });

  it("reads the NEWEST days when the bound bites, not the oldest", () => {
    // ORDER BY day ASC LIMIT n keeps the FIRST rows in the ordering. Past the
    // cap the current week would simply not be in the result, and the season
    // board — the one the page opens on — would go permanently empty.
    expect(readModel).toContain("ORDER BY 2 DESC");
    expect(readModel).not.toContain("ORDER BY 2 ASC");
  });

  it("makes the setup script verify columns, not only tables", () => {
    // "read model ready" listing four tables answered a question nobody asked:
    // the tables have existed since day one, and what an operator needs to know
    // after running a migration is whether the COLUMN landed.
    expect(setup).toContain("REQUIRED_SETTLEMENT_COLUMNS");
    expect(setup).toContain("information_schema.columns");
    expect(setup).toContain("settlementColumns:");
  });

  it("is fed the notional the window actually measured: the volume keeper's own measure, else the walk's", () => {
    expect(keeper).toContain("volumeRaw: settle.volumeLamports ?? settle.tradedLamports ?? 0n,");
  });
});

describe("the leaderboard's wiring in bin/keeper.mts", () => {
  it("serves the rankings from the same heartbeat server as /health and /status", () => {
    expect(keeper).toContain("() => leaderboard,");
  });

  it("recomputes when the history changes, not only on its timer", () => {
    expect(keeper).toContain(".then(() => refreshLeaderboard());");
    expect(keeper).toContain("setInterval(() => void refreshLeaderboard(), LEADERBOARD_REFRESH_MS);");
  });

  it("re-asks the history verdict instead of serving the one from boot", () => {
    // /status is read by a human deciding whether to act. The boot snapshot
    // said "BROKEN — missing volume_raw" for the life of a container whose
    // writes had started working the moment the migration landed.
    expect(keeper).toContain("setInterval(() => void refreshHistoryVerdict(), HISTORY_RECHECK_MS);");
    expect(keeper).toContain("health.history = verdict.detail;");
    // Announced on the transition, not on every re-check.
    expect(keeper).toContain("if (verdict.detail === health.history) return;");
    expect(keeper).not.toContain("await refreshHistoryVerdict()");
  });

  it("keeps the rankings out of the settlement path", () => {
    // The refresher is called detached in both places. An `await` in the sweep
    // would put a page's database query in front of a settlement.
    expect(keeper).toContain("void refreshLeaderboard();");
    expect(keeper).not.toContain("await refreshLeaderboard()");
  });
});
