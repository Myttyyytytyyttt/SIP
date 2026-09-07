// The read model's ONE non-negotiable property: it can never take settlement
// down. A missing database, a broken connection, a bad row — each must become a
// `false` and a warning, never a throw into the settlement path. These tests
// prove that with NO database at all (the DISABLED case) and with a pool
// pointed at a dead host (the failure case). The happy path is exercised
// end-to-end by the drills against real Supabase.

import { describe, expect, it, vi } from "vitest";

import { ReadModel } from "../src/read-model.js";
import type { Logger } from "../src/log.js";

const logger = (): Logger =>
  ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() }) as never;

const settlement = {
  walletAddr: "0xwallet",
  nonce: 1n,
  vaultAddr: "0xvault",
  profitRaw: 1_000_000n,
  contributionRaw: 200_000n,
  txRef: "0xtx",
  height: 42n,
};

describe("the read model never blocks settlement", () => {
  it("is DISABLED, not broken, without a database URL", async () => {
    const rm = ReadModel.create("nuvem_rh", logger(), undefined);
    expect(rm.enabled).toBe(false);
    // Every write is a no-op that returns false, never a throw.
    expect(await rm.recordSettlement(settlement)).toBe(false);
    expect(await rm.recordInvestment({ vaultAddr: "0xv", target: "NVDA", spentRaw: 1n, receivedRaw: 1n, txRef: "0xa", height: 1n })).toBe(false);
    expect(await rm.upsertVault("0xv", "0xo", 2000)).toBe(false);
  });

  it("treats an empty URL as disabled", () => {
    expect(ReadModel.create("nuvem_solana", logger(), "   ").enabled).toBe(false);
  });

  it("swallows a dead-host write into false + a warning, never a throw", async () => {
    const log = logger();
    // A syntactically valid URL that will never connect.
    const rm = ReadModel.create("nuvem_rh", log, "postgresql://x:y@127.0.0.1:1/none?sslmode=disable");
    expect(rm.enabled).toBe(true);
    const ok = await rm.recordSettlement(settlement);
    expect(ok).toBe(false);
    expect(log.warn).toHaveBeenCalled();
    await rm.close();
  });

  it("reports enabled when a URL is present", () => {
    const rm = ReadModel.create("nuvem_rh", logger(), "postgresql://x:y@127.0.0.1:1/none?sslmode=disable");
    expect(rm.enabled).toBe(true);
    return rm.close();
  });
});
