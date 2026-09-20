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

function poolState(overrides: { tickSpacing?: number; status?: number } = {}): Buffer {
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
  data[389] = overrides.status ?? 0; // status: every one of the four pools reads 0
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

/** A classic SPL mint: 82 bytes, no extensions, nothing to charge. */
const classicMint = (): Buffer => Buffer.alloc(82);

interface FeeSchedule {
  readonly epoch: number;
  readonly bps: number;
}

/**
 * A Token-2022 mint carrying a TransferFeeConfig, laid out the way the two
 * PreStock mints really are: account type 1 at byte 165, then TLV entries.
 * A leading MetadataPointer is written first so the walk has to WALK — both
 * real mints carry the fee config third, not first.
 */
function feeMint(older: FeeSchedule, newer: FeeSchedule, options: { readonly length?: number } = {}): Buffer {
  const metadataPointer = 4 + 64;
  const length = options.length ?? 108;
  const data = Buffer.alloc(166 + metadataPointer + 4 + length);
  data[165] = 1; // Mint
  data.writeUInt16LE(18, 166); // MetadataPointer
  data.writeUInt16LE(64, 168);
  const at = 166 + metadataPointer;
  data.writeUInt16LE(1, at); // TransferFeeConfig
  data.writeUInt16LE(length, at + 2);
  const body = at + 4;
  // 32 authority + 32 authority + 8 withheld, then older and newer: epoch u64,
  // maximum_fee u64, basis points u16.
  data.writeBigUInt64LE(BigInt(older.epoch), body + 72);
  data.writeBigUInt64LE(0xffffffffffffffffn, body + 80);
  data.writeUInt16LE(older.bps, body + 88);
  data.writeBigUInt64LE(BigInt(newer.epoch), body + 90);
  data.writeBigUInt64LE(0xffffffffffffffffn, body + 98);
  data.writeUInt16LE(newer.bps, body + 106);
  return data;
}

/** SPYx's real shape: Token-2022, extensions, and no TransferFeeConfig anywhere. */
function noFeeMint(): Buffer {
  const data = Buffer.alloc(166 + 4 + 64);
  data[165] = 1; // Mint
  data.writeUInt16LE(18, 166); // MetadataPointer
  data.writeUInt16LE(64, 168);
  return data;
}

/** What ANTHROPIC and FIGUREAI both carried on mainnet the day this was written. */
const PRESTOCK_FEE = { older: { epoch: 1032, bps: 50 }, newer: { epoch: 1039, bps: 100 } } as const;

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
  /** Mint accounts by address, for a side that is not a plain SPL mint. */
  readonly mints?: Readonly<Record<string, { readonly owner: PublicKey; readonly data: Buffer }>>;
  readonly epoch?: number;
}

/** Every account this connection serves is one of these; anything else is null. */
function stubConnection(options: StubOptions = {}): { connection: Connection; asked: string[][]; epochsAsked: number[] } {
  const asked: string[][] = [];
  const epochsAsked: number[] = [];
  const missing = new Set((options.missing ?? []).map((key) => key.toBase58()));
  const mints = options.mints ?? {};
  const connection = {
    getAccountInfoAndContext: async (key: PublicKey) => ({
      context: { slot: 448833176 },
      value: key.equals(POOL)
        ? { owner: options.poolOwner ?? RAYDIUM_CLMM, data: options.pool ?? poolState(), lamports: 1, executable: false }
        : null,
    }),
    getEpochInfo: async () => {
      epochsAsked.push(options.epoch ?? 1038);
      return { epoch: options.epoch ?? 1038, slotIndex: 1, slotsInEpoch: 432_000, absoluteSlot: 448_833_176 };
    },
    getMultipleAccountsInfo: async (keys: PublicKey[]) => {
      asked.push(keys.map((key) => key.toBase58()));
      return keys.map((key) => {
        if (missing.has(key.toBase58())) return null;
        if (key.equals(AMM_CONFIG)) return { owner: RAYDIUM_CLMM, data: options.config ?? ammConfig(), lamports: 1, executable: false };
        const mint = mints[key.toBase58()];
        if (mint !== undefined) return { owner: mint.owner, data: mint.data, lamports: 1, executable: false };
        // The pool's own mints, unless a case above replaced one.
        if (key.equals(WSOL) || key.equals(USDC)) return { owner: TOKEN_PROGRAM, data: classicMint(), lamports: 1, executable: false };
        // The extension and the tick arrays: the route only checks existence.
        return { owner: RAYDIUM_CLMM, data: Buffer.alloc(8), lamports: 1, executable: false };
      });
    },
  } as unknown as Connection;
  return { connection, asked, epochsAsked };
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

    // TWO RPC CALLS, and the second asks for everything left in one batch:
    // the amm config, the bitmap extension, both mints and the three arrays.
    expect(asked).toHaveLength(1);
    expect(asked[0]).toHaveLength(7);
    expect(asked[0]).toContain(WSOL.toBase58());
    expect(asked[0]).toContain(USDC.toBase58());
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

  it("refuses a pool whose own status byte says swaps are switched off", async () => {
    // Bit 4 SET is Raydium's "disabled"; the byte is 0 on all four live pools,
    // so a polarity mistake here would refuse every route rather than none —
    // which the mainnet rehearsal catches, and this pins without a network.
    const { connection } = stubConnection({ pool: poolState({ status: 1 << 4 }) });
    await expect(fetchLiveRoute(connection, POOL, WSOL, USDC, TOKEN_PROGRAM)).rejects.toThrow(/swaps switched off/);

    // The other bits are other permissions — opening a position, collecting a
    // fee — and none of them stops a swap.
    const open = stubConnection({ pool: poolState({ status: 0b0000_1111 }) });
    await expect(fetchLiveRoute(open.connection, POOL, WSOL, USDC, TOKEN_PROGRAM)).resolves.toBeTruthy();
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

// ── the fee that is taken between the pool and the vault's own account ───────
//
// invest.rs checks `received >= min_out` against the vault_target ATA's delta,
// and a Token-2022 transfer fee comes out of exactly that delta. The two
// PreStock mints — Pren1FvF… and PreZad18… — held older {epoch 1032, 50 bps}
// and newer {epoch 1039, 100 bps} on 2026-09-20, with the network at epoch
// 1038, so the number below doubles on a date that was hours away when this was
// written. A rate quoted gross of it spends half of min-out.ts's 200 bps of
// tolerance before the swap has moved a tick.
describe("the Token-2022 transfer fee the output mint charges", () => {
  const prestock = (mint: PublicKey, program = TOKEN_2022) => ({
    [mint.toBase58()]: { owner: program, data: feeMint(PRESTOCK_FEE.older, PRESTOCK_FEE.newer) },
  });

  it("is netted out of the reference rate, at the schedule in force this epoch", async () => {
    const { connection, epochsAsked } = stubConnection({ mints: prestock(USDC), epoch: 1038 });
    const route = await fetchLiveRoute(connection, POOL, WSOL, USDC, TOKEN_2022);

    // 110,347,643 raw out per 1e9 in is the rate net of the pool's own 0,04 %.
    // 50 bps of transfer fee takes it to 109,795,905 — 551,738 raw units, $0.55
    // on a $110 swap, which is what min_out was over-demanding by.
    expect(per1e9(route.observed!)).toBe(109_795_905n);
    expect(epochsAsked).toEqual([1038]);
  });

  it("doubles at epoch 1039, the way the issuer's own schedule says it will", async () => {
    const { connection } = stubConnection({ mints: prestock(USDC), epoch: 1039 });
    const route = await fetchLiveRoute(connection, POOL, WSOL, USDC, TOKEN_2022);
    expect(per1e9(route.observed!)).toBe(109_244_167n);
  });

  it("comes off the INPUT side too, because the pool only swaps what reaches its vault", async () => {
    const { connection } = stubConnection({ mints: prestock(WSOL), epoch: 1038 });
    const route = await fetchLiveRoute(connection, POOL, WSOL, USDC, TOKEN_PROGRAM);
    expect(per1e9(route.observed!)).toBe(109_795_905n);
    // And the route carries the mint's OWN program rather than a guess.
    expect(route.inputTokenProgram.toBase58()).toBe(TOKEN_2022.toBase58());
  });

  it("costs no extra RPC call when no mint has a fee change pending", async () => {
    // Both SPYx's real shape (Token-2022, many extensions, no fee config) and a
    // plain SPL mint answer without the epoch, so the convert leg stays at two calls.
    const { connection, epochsAsked, asked } = stubConnection({
      mints: { [USDC.toBase58()]: { owner: TOKEN_2022, data: noFeeMint() } },
    });
    const route = await fetchLiveRoute(connection, POOL, WSOL, USDC, TOKEN_2022);
    expect(per1e9(route.observed!)).toBe(110_347_643n);
    expect(epochsAsked).toEqual([]);
    expect(asked).toHaveLength(1);
  });

  it("REFUSES a fee the slippage budget cannot absorb, rather than quoting past it", async () => {
    const { connection } = stubConnection({ mints: { [USDC.toBase58()]: { owner: TOKEN_2022, data: feeMint({ epoch: 1032, bps: 50 }, { epoch: 1039, bps: 150 }) } }, epoch: 1039 });
    await expect(fetchLiveRoute(connection, POOL, WSOL, USDC, TOKEN_2022)).rejects.toThrow(/150 bps Token-2022 transfer fee/);
    // At 100 bps it still quotes: epoch 1039 is meant to go through, tightly.
    const still = stubConnection({ mints: prestock(USDC), epoch: 1039 });
    await expect(fetchLiveRoute(still.connection, POOL, WSOL, USDC, TOKEN_2022)).resolves.toBeTruthy();
  });

  it("refuses an output mint whose own program is not the one the route was asked for", async () => {
    const { connection } = stubConnection({ mints: { [USDC.toBase58()]: { owner: TOKEN_2022, data: classicMint() } } });
    await expect(fetchLiveRoute(connection, POOL, WSOL, USDC, TOKEN_PROGRAM)).rejects.toThrow(/not the .* this route was asked to build for/);
  });

  it("refuses a mint account that does not exist at all", async () => {
    const { connection } = stubConnection({ missing: [USDC] });
    await expect(fetchLiveRoute(connection, POOL, WSOL, USDC, TOKEN_PROGRAM)).rejects.toThrow(/output mint .* does not exist/);
  });
});
