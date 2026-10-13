// The price tape on Postgres 16 (src/price-tape.ts, PgPriceTape; ADR §5.2.3):
// the table in sql/sip_solana.sql, the one lookup statement, and the proof that
// it answers exactly what pickSample answers, for every time in a range around
// a tape with gaps.
//
// RUN ONLY WITH A THROWAWAY DATABASE ON THE LOOPBACK (KEEPER_TEST_PG_URL), as the
// other *-pg tests: each run creates its own database, applies the schema file
// to it and drops it. Without the variable the block is skipped.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgPriceTape, TAPE_LOOKUP_SECONDS, missingTapeColumns, pickSample, type TapeSample } from "../src/price-tape.js";

const URL_RAW = process.env["KEEPER_TEST_PG_URL"];
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const usable = ((): boolean => {
  if (URL_RAW === undefined || URL_RAW.trim() === "") return false;
  const host = new URL(URL_RAW).hostname;
  if (!LOOPBACK.has(host)) throw new Error("KEEPER_TEST_PG_URL must point at the loopback; it names another host");
  return true;
})();
const SCHEMA_SQL = readFileSync(fileURLToPath(new URL("../sql/sip_solana.sql", import.meta.url)), "utf8");

describe.skipIf(!usable)("the price tape on Postgres 16 (needs KEEPER_TEST_PG_URL on the loopback)", () => {
  const database = `keeper_tape_${process.pid}_${Date.now()}`;
  let admin: pg.Pool;
  let db: pg.Pool;
  const urlFor = (name: string): string => {
    const url = new URL(URL_RAW!);
    url.pathname = `/${name}`;
    return url.toString();
  };

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: URL_RAW!, max: 2 });
    admin.on("error", () => undefined);
    await admin.query(`CREATE DATABASE ${database}`);
    db = new pg.Pool({ connectionString: urlFor(database), max: 2 });
    db.on("error", () => undefined);
  });

  afterAll(async () => {
    await db?.end().catch(() => undefined);
    if (admin !== undefined) {
      await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`).catch(() => undefined);
      await admin.end().catch(() => undefined);
    }
  });

  it("is missing until the schema is applied, then has every column, and the schema applies twice", async () => {
    expect(await missingTapeColumns(db)).toEqual(["sol_price_tape.publish_time", "sol_price_tape.slot", "sol_price_tape.price_e6", "sol_price_tape.conf_e6", "sol_price_tape.sampled_at"]);
    await db.query(SCHEMA_SQL);
    await db.query(SCHEMA_SQL);
    expect(await missingTapeColumns(db)).toEqual([]);
  });

  it("keeps the first sample of a publish, refuses a price that is not one, and prunes by publish time", async () => {
    const tape = new PgPriceTape(db);
    await tape.record({ publishTime: 1_000, slot: 10n, priceE6: 150_000_000n, confE6: 15_000n });
    await tape.record({ publishTime: 1_000, slot: 11n, priceE6: 999n, confE6: 0n });
    const rows = await db.query("SELECT publish_time, slot, price_e6 FROM sip_solana.sol_price_tape");
    expect(rows.rows).toEqual([{ publish_time: "1000", slot: "10", price_e6: "150000000" }]);
    await expect(tape.record({ publishTime: 1_001, slot: 1n, priceE6: 0n, confE6: 0n })).rejects.toThrow(/check constraint/);
    await tape.record({ publishTime: 5_000, slot: 50n, priceE6: 1n, confE6: 0n });
    expect(await tape.prune(2_000)).toBe(1);
    await db.query("DELETE FROM sip_solana.sol_price_tape");
  });

  it("answers, in one statement, exactly what pickSample answers, for every second around a tape with gaps", async () => {
    const tape = new PgPriceTape(db);
    const samples: TapeSample[] = [100, 160, 220, 600, 610, 1_000].map((publishTime, index) => ({ publishTime, slot: BigInt(index), priceE6: BigInt(150_000_000 + index), confE6: 0n }));
    for (const sample of samples) await tape.record(sample);
    const times: number[] = [];
    for (let at = -100; at <= 1_300; at++) times.push(at);
    let statements = 0;
    const counting = {
      connect: async () => {
        const client = await db.connect();
        return {
          query: (text: string, values?: unknown[]) => {
            statements += 1;
            return client.query(text, values);
          },
          release: (destroy?: boolean) => client.release(destroy),
        };
      },
    };
    const answers = await new PgPriceTape(counting).pricesAt(times);
    expect(statements).toBe(1);
    for (const at of times) {
      expect(answers.get(at)?.publishTime ?? null, `t = ${at}`).toBe(pickSample(samples, at)?.publishTime ?? null);
    }
    // The window's edges, as read: exactly 120 s either side, and not one more.
    expect(answers.get(100 - TAPE_LOOKUP_SECONDS)?.publishTime).toBe(100);
    expect(answers.get(100 - TAPE_LOOKUP_SECONDS - 1)).toBeNull();
    expect(answers.get(1_000 + TAPE_LOOKUP_SECONDS)?.publishTime).toBe(1_000);
    expect(answers.get(1_000 + TAPE_LOOKUP_SECONDS + 1)).toBeNull();
    expect(answers.get(610)?.priceE6).toBe(150_000_004n);
  });
});
