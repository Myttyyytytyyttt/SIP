// The route fetchLiveRoute derives from a PoolState account, with no network.
//
// WHY THIS FILE EXISTS. On 2026-09-20 live-route.ts stopped borrowing its
// accounts from a stranger's recent swap and started deriving them from the
// pool account's own bytes. scripts/rehearse-route.ts proves that derivation
// against real mainnet swaps, which is the proof that matters — but it needs
// mainnet, it takes minutes, and it cannot run in CI. What it cannot catch is a
// silent edit to an OFFSET: shift `vault0` by four bytes and the rehearsal
// fails loudly the next time someone runs it, while every test in this
// repository stays green in between.
//
// So this pins the bytes. The layout constants, the direction the vaults flip,
// the tick-array start index, the bitmap extension's seed, and the fee applied
// to the reference price — each against a hand-built account whose every field
// is visible in this file. The numbers are the SOL/USDC pool's real ones, read
// off mainnet the same day: sqrt price 6128978966923050895, spacing 1, tick
// -22039, and amm config 8's 400/1e6 fee.
//
// A NEW FILE ON PURPOSE. The code under test lives in @sip/solana-program,
// whose own suite is Anchor's and needs a validator. The keeper is where it is
// consumed and where vitest already runs, and a new file merges cleanly beside
// a branch that is rewriting the keeper's own tests.

import { PublicKey, type Connection } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { fetchLiveRoute } from "../src/program-scripts.js";

const RAYDIUM_CLMM = new PublicKey("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK");
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

// The real SOL/USDC pool and its real neighbours, so the derived PDAs are the
// mainnet ones and can be compared with what real swaps carry.
const POOL = new PublicKey("3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv");
const AMM_CONFIG = new PublicKey("3h2e43PunVA5K34vwKCLHWhZF4aZpyaC9RmxvshGAQpL");
const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const VAULT0 = new PublicKey("4ct7br2vTPzfdmY3S5HLtTxcGSBfn6pnw98hsS6v359A");
const VAULT1 = new PublicKey("5it83u57VRrVgc51oNV19TTmAJuffPx5GtGwQr7gQNUo");
const OBSERVATION = new PublicKey("3Y695CuQ8AP4anbwAqiEBeQF9KxqHFr8piEwvw3UePnQ");

/**
 * The bitmap extension's real address for this pool.
 *
 * GOLDEN, not derived here: 210 of the 240 real swap_v2 instructions surveyed
 * across SaverFi's four pools carried this account as the first of their
 * remaining accounts, and this one is the SOL/USDC pool's. If the seed string
 * in live-route.ts is ever retyped, this line is what notices.
 */
const EXTENSION = new PublicKey("4NFvUKqknMpoe6CWTzK758B8ojVLzURL5pC6MtiaJ8TQ");

const SQRT_PRICE_X64 = 6128978966923050895n;
const TICK_CURRENT = -22039;
const TICK_SPACING = 1;
const TRADE_FEE_RATE = 400; // 0,04 %, over a denominator of 1e6

function writeU128LE(data: Buffer, at: number, value: bigint): void {
  let rest = value;
  for (let i = 0; i < 16; i++) {
    data[at + i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
}

function poolState(overrides: { tickSpacing?: number } = {}): Buffer {
  const data = Buffer.alloc(1544);
  Buffer.from("f7ede3f5d7c3de46", "hex").copy(data, 0);
  data[8] = 255; // bump
  AMM_CONFIG.toBuffer().copy(data, 9);
  POOL.toBuffer().copy(data, 41); // owner, unused by the route
  WSOL.toBuffer().copy(data, 73); // mint0
  USDC.toBuffer().copy(data, 105); // mint1
  VAULT0.toBuffer().copy(data, 137);
  VAULT1.toBuffer().copy(data, 169);
  OBSERVATION.toBuffer().copy(data, 201);
  data[233] = 9; // decimals0
  data[234] = 6; // decimals1
  data.writeUInt16LE(overrides.tickSpacing ?? TICK_SPACING, 235);
  writeU128LE(data, 237, 146591640500536n); // liquidity
  writeU128LE(data, 253, SQRT_PRICE_X64);
  data.writeInt32LE(TICK_CURRENT, 269);
  return data;
}

function ammConfig(overrides: { tradeFeeRate?: number; tickSpacing?: number } = {}): Buffer {
  const data = Buffer.alloc(117);
  Buffer.from("daf42168cbcb2b6f", "hex").copy(data, 0);
  data[8] = 255;
  data.writeUInt16LE(8, 9); // config index
  data.writeUInt32LE(120_000, 43); // protocol fee rate
  data.writeUInt32LE(overrides.tradeFeeRate ?? TRADE_FEE_RATE, 47);
  data.writeUInt16LE(overrides.tickSpacing ?? TICK_SPACING, 51);
  return data;
}

/** The tick array holding `start`, by the seed Raydium uses (BIG-endian index). */
function tickArray(start: number): PublicKey {
  const seed = Buffer.alloc(4);
  seed.writeInt32BE(start);
  return PublicKey.findProgramAddressSync([Buffer.from("tick_array"), POOL.toBuffer(), seed], RAYDIUM_CLMM)[0];
}

interface StubOptions {
  readonly pool?: Buffer;
  readonly poolOwner?: PublicKey;
  readonly config?: Buffer;
  /** Addresses getMultipleAccountsInfo should report as not existing. */
  readonly missing?: readonly PublicKey[];
}

/** Every account this connection serves is one of these; anything else is null. */
function stubConnection(options: StubOptions = {}): { connection: Connection; asked: string[][] } {
  const asked: string[][] = [];
  const missing = new Set((options.missing ?? []).map((key) => key.toBase58()));
  const connection = {
    getAccountInfoAndContext: async (key: PublicKey) => ({
      context: { slot: 448833176 },
      value: key.equals(POOL)
        ? { owner: options.poolOwner ?? RAYDIUM_CLMM, data: options.pool ?? poolState(), lamports: 1, executable: false }
        : null,
    }),
    getMultipleAccountsInfo: async (keys: PublicKey[]) => {
      asked.push(keys.map((key) => key.toBase58()));
      return keys.map((key) => {
        if (missing.has(key.toBase58())) return null;
        if (key.equals(AMM_CONFIG)) return { owner: RAYDIUM_CLMM, data: options.config ?? ammConfig(), lamports: 1, executable: false };
        // The extension and the tick arrays: the route only checks existence.
        return { owner: RAYDIUM_CLMM, data: Buffer.alloc(8), lamports: 1, executable: false };
      });
    },
  } as unknown as Connection;
  return { connection, asked };
}

/** Output raw per 1e9 input raw, the readable form of the reference rate. */
const per1e9 = (rate: { readonly inRaw: bigint; readonly outRaw: bigint }): bigint =>
  (1_000_000_000n * rate.outRaw) / rate.inRaw;

describe("a route derived from the pool account", () => {
  it("reads the config, the vaults and the observation off the PoolState, and passes the bitmap extension first", async () => {
    const { connection, asked } = stubConnection();
    const route = await fetchLiveRoute(connection, POOL, WSOL, USDC, TOKEN_PROGRAM);

    expect(route.ammConfig.toBase58()).toBe(AMM_CONFIG.toBase58());
    expect(route.poolState.toBase58()).toBe(POOL.toBase58());
    expect(route.inputVault.toBase58()).toBe(VAULT0.toBase58());
    expect(route.outputVault.toBase58()).toBe(VAULT1.toBase58());
    expect(route.observationState.toBase58()).toBe(OBSERVATION.toBase58());
    expect(route.inputTokenProgram.toBase58()).toBe(TOKEN_PROGRAM.toBase58());
    expect(route.capturedFrom).toBe("pool state, slot 448833176");
    expect(route.directionMatched).toBe(true);

    // tickCurrent -22039 with spacing 1 is 60 ticks per array, so the array that
    // holds it starts at -22080 — NOT -22020, which is what truncating toward
    // zero would give and what an earlier bug shipped.
    expect(route.tickArrays.map((key) => key.toBase58())).toEqual([
      EXTENSION.toBase58(),
      tickArray(-22080).toBase58(),
      tickArray(-22140).toBase58(),
      tickArray(-22200).toBase58(),
    ]);

    // TWO RPC CALLS, and the second asks for everything left in one batch.
    expect(asked).toHaveLength(1);
    expect(asked[0]).toHaveLength(5);
  });

  it("quotes the pool's own price net of the pool's own fee, and both directions cross the spread", async () => {
    const { connection } = stubConnection();
    const sell = await fetchLiveRoute(connection, POOL, WSOL, USDC, TOKEN_PROGRAM);
    const buy = await fetchLiveRoute(connection, POOL, USDC, WSOL, TOKEN_PROGRAM);

    // 1 SOL sells for 110,347,643 raw USDC — $110.35 — and $1,000 buys
    // 9.055020346 SOL, which is $110.44. The $0.09 between them is the 0,04 %
    // fee paid twice, which is what proves the fee is taken off the INPUT in
    // both directions rather than added to one of them.
    expect(per1e9(sell.observed!)).toBe(110_347_643n);
    expect(per1e9(buy.observed!)).toBe(9_055_020_346n);

    // The gross price, fee not taken, would be 110,391,800: a route that forgot
    // to net the fee would quote 4 bps above what the pool can actually pay.
    expect(per1e9(sell.observed!)).toBeLessThan(110_391_800n);
  });

  it("flips the vaults and walks the tick arrays upward when the input is mint1", async () => {
    const { connection } = stubConnection();
    const route = await fetchLiveRoute(connection, POOL, USDC, WSOL, TOKEN_PROGRAM);
    expect(route.inputVault.toBase58()).toBe(VAULT1.toBase58());
    expect(route.outputVault.toBase58()).toBe(VAULT0.toBase58());
    expect(route.tickArrays.slice(1).map((key) => key.toBase58())).toEqual([
      tickArray(-22080).toBase58(),
      tickArray(-22020).toBase58(),
      tickArray(-21960).toBase58(),
    ]);
  });

  it("keeps only the tick arrays that exist, and drops the extension when there is none", async () => {
    const { connection } = stubConnection({ missing: [EXTENSION, tickArray(-22200)] });
    const route = await fetchLiveRoute(connection, POOL, WSOL, USDC, TOKEN_PROGRAM);
    expect(route.tickArrays.map((key) => key.toBase58())).toEqual([
      tickArray(-22080).toBase58(),
      tickArray(-22140).toBase58(),
    ]);
  });

  it("refuses a pool account that Raydium does not own", async () => {
    const { connection } = stubConnection({ poolOwner: TOKEN_2022 });
    await expect(fetchLiveRoute(connection, POOL, WSOL, USDC, TOKEN_PROGRAM)).rejects.toThrow(/not Raydium CLMM/);
  });

  it("refuses the mint pair the pool does not hold, rather than routing the wrong way", async () => {
    const { connection } = stubConnection();
    await expect(fetchLiveRoute(connection, POOL, TOKEN_2022, USDC, TOKEN_PROGRAM)).rejects.toThrow(/not the input mint/);
    await expect(fetchLiveRoute(connection, POOL, WSOL, TOKEN_2022, TOKEN_PROGRAM)).rejects.toThrow(/not the requested/);
  });

  it("refuses an amm config whose tick spacing disagrees with the pool's, because then the fee offset has moved", async () => {
    const { connection } = stubConnection({ config: ammConfig({ tickSpacing: 60 }) });
    await expect(fetchLiveRoute(connection, POOL, WSOL, USDC, TOKEN_PROGRAM)).rejects.toThrow(/layout this file reads the fee from has moved/);
  });

  it("refuses the first tick array being absent, rather than sending a swap that cannot start", async () => {
    const { connection } = stubConnection({ missing: [tickArray(-22080)] });
    await expect(fetchLiveRoute(connection, POOL, WSOL, USDC, TOKEN_PROGRAM)).rejects.toThrow(/no initialised tick array/);
  });
});
