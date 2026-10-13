// THE PER-TRADE MODES AS DISPATCHER MODULES, END TO END ON A STUB CHAIN (plan
// §3.4; ADR §5): one worker job (src/worker-job.ts) over a ROUND-UP or FIXED
// vault — the module chosen by the vault's own byte under SIP_SOLANA_EXTRA_MODES,
// its PerTradePolicy and the oracle read once for the job, the walk's swaps
// counted by the real volume probe, priced from the tape, charged, and the
// settle_v3 gated by the fence:
//   * in the SHADOW world, as a 'shadow' intent, nothing sent;
//   * in the live world with SIP_SOLANA_EXTRA_MODES_LIVE=0 (M4), dry: no intent,
//     no signer asked for, nothing sent, no history;
//   * with LIVE=1 (M5), sent as [Ed25519SigVerify, settle_v3] behind its intent;
//   * and without SIP_SOLANA_EXTRA_MODES — today — not at all: UNSUPPORTED_MODE
//     before any RPC call, exactly as a vault in an undefined mode.
// The COMPLETE says when the vault is due again: its clock when it waits, its
// mode's probe cadence when it rests.

import { Keypair, PublicKey, type Connection } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { perTradePolicyAddress } from "../src/accounts.js";
import { idl, instructionDiscriminator } from "../src/idl.js";
import type { InvestResult } from "../src/invest-tick.js";
import { dayIndexOf } from "../src/per-trade-base.js";
import type { PolicyBoundaryBook } from "../src/policy-boundary.js";
import { MemoryPriceTape } from "../src/price-tape.js";
import { MODE_FIXED, MODE_ROUNDUP } from "../src/program-scripts.js";
import { MODE_FIXED_BYTE, MODE_ROUNDUP_BYTE, PER_TRADE_PROBE_EVERY_MS } from "../src/role-registry.js";
import type { PerTradeServing } from "../src/settle-modules.js";
import { runSettleTick } from "../src/settle-tick.js";
import { REST_DUE_SECONDS, jobLogFields, runVaultJob, type VaultJobDeps } from "../src/worker-job.js";
import { MemoryDb, MemoryDispatchStore } from "./memory-dispatch-store.js";
import { perTradePolicyBytes, pythAccount, signatureFor } from "./per-trade-fixtures.js";
import { SettleWorld, vaultOf } from "./settle-world.js";
import { deps, history, jobChain, keysFor, queued } from "./worker-world.js";

const programId = new PublicKey(idl.address);
const NOW = 1_800_000_000;
const ORACLE = Keypair.generate().publicKey;
const SETTLE_V3 = instructionDiscriminator("settle_v3");
const restingInvest = async (): Promise<InvestResult> => ({ outcome: "IDLE", detail: "nothing to invest" });

/** One per-trade vault with one link: its PerTradePolicy and Pyth's account on the stub chain, a tape, a job's deps. */
async function perTradeVault(
  mode: typeof MODE_ROUNDUP | typeof MODE_FIXED,
  options: { readonly world?: "shadow" | "live"; readonly serving?: Partial<PerTradeServing> | null; readonly maxContribution?: bigint } = {},
) {
  const world = new SettleWorld();
  const db = new MemoryDb();
  const vault = queued(db, [world]);
  const store = new MemoryDispatchStore(db, "worker-per-trade", options.world ?? "shadow");
  world.accounts.set(perTradePolicyAddress(programId, world.link.vault).toBase58(), {
    data: perTradePolicyBytes({ vault: world.link.vault }),
    owner: programId,
    lamports: 1_000_000,
    executable: false,
    rentEpoch: 0,
  });
  world.accounts.set(ORACLE.toBase58(), pythAccount({ price: 15_000_000_000n, publishTime: BigInt(NOW) }));
  const tape = new MemoryPriceTape();
  await tape.record({ publishTime: NOW - 700, slot: 1n, priceE6: 150_000_000n, confE6: 0n });
  const state = { vault: { ...vaultOf(mode), maxContribution: options.maxContribution ?? 4_000_000n } };
  const { chain, calls } = jobChain([world], () => db.intents.length, state);
  const serving: PerTradeServing | null =
    options.serving === null
      ? null
      : { modes: new Set([MODE_ROUNDUP_BYTE, MODE_FIXED_BYTE]), vaults: new Set([vault]), live: false, fromSlot: null, tape, oracle: ORACLE, ...options.serving };
  const h = history();
  const asked: string[] = [];
  const keys = keysFor([world]);
  const jobDeps = (over: Partial<VaultJobDeps> = {}): VaultJobDeps => {
    const base = deps(store, chain, { history: h.writer, invest: restingInvest, now: () => NOW * 1_000 });
    return {
      ...base,
      shared: { ...base.shared, perTrade: serving, boundaries: { boundary: async () => ({ slot: null, detail: "no change" }) } as unknown as PolicyBoundaryBook },
      ...(options.world === "live"
        ? {
            keys: {
              ...keys,
              signerFor: async (wallet: PublicKey) => {
                asked.push(wallet.toBase58());
                return keys.signerFor(wallet);
              },
            },
          }
        : {}),
      ...over,
    };
  };
  return { world, db, vault, store, chain, calls, h, asked, jobDeps };
}

/** A buy the probe counts: `x` lamports out (and the 5 000 fee), a token in. */
const buy = (world: SettleWorld, x: number, blockTime: number, seed: string) => world.swap(-(x + 5_000), blockTime, signatureFor(seed));

/**
 * TWO LINKS OF ONE FIXED VAULT, each wallet's chain its own world, and a job
 * whose every RPC goes to the world of the link being settled (the job's own
 * settle, routed). F = 0.03 SOL, max_contribution 0.06 SOL, a 0.3 SOL daily cap
 * with 0.27 SOL saved today: the first link's settle fills the day.
 */
async function twoLinkFixedVault(options: { readonly world: "shadow" | "live"; readonly live?: boolean }) {
  const links = [new SettleWorld(), new SettleWorld()];
  const db = new MemoryDb();
  const vault = queued(db, links);
  const store = new MemoryDispatchStore(db, "worker-per-trade", options.world);
  links[0]!.accounts.set(perTradePolicyAddress(programId, links[0]!.link.vault).toBase58(), {
    data: perTradePolicyBytes({ vault: links[0]!.link.vault, fixedLamports: 30_000_000, dailyCapLamports: 300_000_000n, dayIndex: dayIndexOf(NOW), daySavedLamports: 270_000_000n }),
    owner: programId,
    lamports: 1_000_000,
    executable: false,
    rentEpoch: 0,
  });
  const calls: string[] = [];
  const connections = links.map((world) => world.connection(calls) as unknown as Record<string, (...args: unknown[]) => unknown>);
  let current = 0;
  const routed = new Proxy({}, { get: (_t, prop) => (typeof prop !== "string" || prop === "then" ? undefined : (...args: unknown[]) => connections[current]![prop]!(...args)) }) as Connection;
  const router = { connection: () => routed } as unknown as SettleWorld;
  const { chain } = jobChain([router], () => db.intents.length, { vault: { ...vaultOf(MODE_FIXED), maxContribution: 60_000_000n }, links });
  const keys = keysFor(links);
  const h = history();
  const base = deps(store, chain, { history: h.writer, invest: restingInvest, now: () => NOW * 1_000 });
  const jobDeps: VaultJobDeps = {
    ...base,
    shared: {
      ...base.shared,
      perTrade: { modes: new Set([MODE_FIXED_BYTE]), vaults: new Set([vault]), live: options.live ?? false, fromSlot: null, tape: new MemoryPriceTape(), oracle: ORACLE },
      boundaries: { boundary: async () => ({ slot: null, detail: "no change" }) } as unknown as PolicyBoundaryBook,
    },
    settle: async (turn) => {
      current = links.findIndex((world) => world.wallet.equals(turn.link.wallet));
      return runSettleTick(turn);
    },
    ...(options.world === "live" ? { keys } : {}),
  };
  for (const [i, world] of links.entries()) buy(world, 20_000_000, NOW - 60, `two-links-${i}`);
  for (const world of links) world.finalizeTo(world.tip);
  // THE JOB TURNS ITS LINKS IN LINK-ADDRESS ORDER.
  const [first, second] = [...links].sort((a, b) => (a.link.linkAddress.toBase58() < b.link.linkAddress.toBase58() ? -1 : 1)) as [SettleWorld, SettleWorld];
  return { db, store, h, jobDeps, first, second };
}

describe("a per-trade vault's job", () => {
  it("SHADOW: the ROUND-UP module prices the swap from the tape, gates its settle_v3 as a 'shadow' intent and sends nothing", async () => {
    const v = await perTradeVault(MODE_ROUNDUP);
    buy(v.world, 10_666_667, NOW - 650, "shadow-buy");
    v.world.finalizeTo(v.world.tip);
    const claimed = (await v.store.claim(1))[0]!;
    const end = await runVaultJob(claimed, v.jobDeps());
    expect(end.kind).toBe("complete");
    expect(end.report).toMatchObject({ world: "shadow", live: false, mode: MODE_ROUNDUP, module: "ROUND-UP", settles: [{ outcome: "SETTLED" }] });
    expect(end.report.settles[0]!.detail).toMatch(/^DRY RUN — would settle 2666666 lamports in ROUND-UP through settle_v3/);
    // THE PER-TRADE ROWS RIDE IN THE JOB'S LOG LINE, by wallet.
    expect(jobLogFields(end)).toMatchObject({
      module: "ROUND-UP",
      wallets: [{ settle: "SETTLED", perTrade: [{ status: "charged", price: "150000000", priced: "tape", owed: "2666666" }] }],
    });
    expect(v.db.intents.map((row) => [row.kind, row.state, row.amountRaw])).toEqual([["settle", "shadow", 2_666_666n]]);
    expect(v.world.sent).toEqual([]);
    // ONE READ OF THE POLICY AND THE ORACLE FOR THE JOB.
    expect(v.calls.filter((call) => call === "getMultipleAccountsInfo")).toHaveLength(1);
    expect(await v.store.overlapAudit()).toEqual([]);
  });

  it("DARK BY DEFAULT: without SIP_SOLANA_EXTRA_MODES the vault's link rests at UNSUPPORTED_MODE before any RPC, and nothing is read for it", async () => {
    const v = await perTradeVault(MODE_FIXED, { serving: null });
    buy(v.world, 20_000_000, NOW - 4_000, "unserved");
    v.world.finalizeTo(v.world.tip);
    const end = await runVaultJob((await v.store.claim(1))[0]!, v.jobDeps());
    expect(end.report).toMatchObject({ module: null, mode: MODE_FIXED, settles: [{ outcome: "UNSUPPORTED_MODE" }] });
    expect(v.calls).toEqual([]);
    expect(v.db.intents).toEqual([]);
    // Nor for a vault the list does not name.
    const other = await perTradeVault(MODE_FIXED, { serving: { vaults: new Set([Keypair.generate().publicKey.toBase58()]) } });
    expect((await runVaultJob((await other.store.claim(1))[0]!, other.jobDeps())).report).toMatchObject({ module: null, settles: [{ outcome: "UNSUPPORTED_MODE" }] });
    expect(other.calls).toEqual([]);
  });

  it("LIVE WORLD, LIVE=0 (M4): measured and reported dry — no signer asked for, no intent, nothing sent, no history", async () => {
    const v = await perTradeVault(MODE_FIXED, { world: "live", serving: { live: false }, maxContribution: 1_500_000n });
    buy(v.world, 20_000_000, NOW - 30, "m4");
    v.world.finalizeTo(v.world.tip);
    const end = await runVaultJob((await v.store.claim(1))[0]!, v.jobDeps());
    expect(end.report).toMatchObject({ world: "live", live: true, module: "FIXED", settles: [{ outcome: "SETTLED" }] });
    expect(end.report.settles[0]!.detail).toMatch(/^DRY RUN — would settle 1000000 lamports in FIXED through settle_v3/);
    expect(v.asked).toEqual([]);
    expect(v.db.intents).toEqual([]);
    expect(v.world.sent).toEqual([]);
    expect(v.h.settlements).toEqual([]);
  });

  it("LIVE WORLD, LIVE=1 (M5): settle_v3 leaves behind its intent, and the history row says mode 3", async () => {
    const v = await perTradeVault(MODE_FIXED, { world: "live", serving: { live: true, fromSlot: 1n }, maxContribution: 1_500_000n });
    buy(v.world, 20_000_000, NOW - 30, "m5");
    v.world.finalizeTo(v.world.tip);
    v.world.receiptVaultDelta = 1_000_000;
    const end = await runVaultJob((await v.store.claim(1))[0]!, v.jobDeps());
    expect(end.report).toMatchObject({ module: "FIXED", settles: [{ outcome: "SETTLED" }], intents: 1 });
    expect(v.asked).toEqual([v.world.wallet.toBase58()]);
    expect(v.db.intents.map((row) => [row.kind, row.state, row.amountRaw])).toEqual([["settle", "landed", 1_000_000n]]);
    expect(v.world.sent).toHaveLength(1);
    const settle = v.world.sent[0]!.message.compiledInstructions[1]!;
    expect(Buffer.from(settle.data).subarray(0, 8).equals(SETTLE_V3)).toBe(true);
    expect(v.h.settlements).toEqual([expect.objectContaining({ mode: MODE_FIXED, baseRaw: 1_000_000n, contributionRaw: 1_000_000n })]);
  });

  it("is due again when its clock fires while it waits, and within its probe cadence when it rests — not the safety backstop", async () => {
    // Waiting: one FIXED trade 55 minutes old, owing under half the cap: its clock fires in 5 minutes.
    const soon = await perTradeVault(MODE_FIXED, { maxContribution: 60_000_000n });
    buy(soon.world, 20_000_000, NOW - 3_300, "waits");
    soon.world.finalizeTo(soon.world.tip);
    const waited = await runVaultJob((await soon.store.claim(1))[0]!, soon.jobDeps());
    expect(waited.report.settles).toMatchObject([{ outcome: "NO_PROFIT", dueAt: NOW + 300 }]);
    expect(waited.kind === "complete" && waited.completion).toMatchObject({ rests: true, lane: "safety", dueInSeconds: 300 });
    // A clock further off than the probe cadence: the cadence comes first (new trades may settle it on size).
    const later = await perTradeVault(MODE_FIXED, { maxContribution: 60_000_000n });
    buy(later.world, 20_000_000, NOW - 600, "waits-longer");
    later.world.finalizeTo(later.world.tip);
    const probed = await runVaultJob((await later.store.claim(1))[0]!, later.jobDeps());
    expect(probed.report.settles).toMatchObject([{ outcome: "NO_PROFIT", dueAt: NOW + 3_000 }]);
    expect(probed.kind === "complete" && probed.completion).toMatchObject({ rests: true, dueInSeconds: PER_TRADE_PROBE_EVERY_MS / 1_000 });
    // Resting: nothing since the link.
    const idle = await perTradeVault(MODE_ROUNDUP);
    const rested = await runVaultJob((await idle.store.claim(1))[0]!, idle.jobDeps());
    expect(rested.report.settles).toMatchObject([{ outcome: "IDLE" }]);
    expect(rested.kind === "complete" && rested.completion).toMatchObject({ rests: true, dueInSeconds: PER_TRADE_PROBE_EVERY_MS / 1_000 });
    expect(PER_TRADE_PROBE_EVERY_MS / 1_000).toBeLessThan(REST_DUE_SECONDS);
  });

  it("TWO LINKS, ONE DAILY CAP (shadow): the second link is worked out against the counter the first one's settle leaves — it waits on the clock instead of settling on size", async () => {
    const v = await twoLinkFixedVault({ world: "shadow" });
    const end = await runVaultJob((await v.store.claim(1))[0]!, v.jobDeps);
    expect(end.report.settles.map((turn) => turn.wallet)).toEqual([v.first.wallet.toBase58(), v.second.wallet.toBase58()]);
    expect(end.report.settles[0]).toMatchObject({ outcome: "SETTLED", detail: expect.stringMatching(/^DRY RUN — would settle 30000000 lamports in FIXED through settle_v3/) });
    expect(end.report.settles[1]).toMatchObject({ outcome: "NO_PROFIT", dueAt: NOW - 60 + 3_600, detail: expect.stringContaining("saved its daily cap today") });
    // ONE SHADOW INTENT, the first link's: the second sends no forgiving zero settle on size.
    expect(v.db.intents.map((row) => [row.kind, row.state, row.amountRaw])).toEqual([["settle", "shadow", 30_000_000n]]);
  });

  it("TWO LINKS, ONE DAILY CAP (live, LIVE=1): the first link's settle_v3 lands and fills the day; the second sends nothing and records nothing", async () => {
    const v = await twoLinkFixedVault({ world: "live", live: true });
    v.first.receiptVaultDelta = 30_000_000;
    const end = await runVaultJob((await v.store.claim(1))[0]!, v.jobDeps);
    expect(end.report.settles).toMatchObject([
      { outcome: "SETTLED", wallet: v.first.wallet.toBase58() },
      { outcome: "NO_PROFIT", wallet: v.second.wallet.toBase58(), dueAt: NOW - 60 + 3_600 },
    ]);
    expect(v.first.sent).toHaveLength(1);
    expect(v.second.sent).toEqual([]);
    expect(v.db.intents.map((row) => [row.kind, row.state, row.amountRaw])).toEqual([["settle", "landed", 30_000_000n]]);
    expect(v.h.settlements).toEqual([expect.objectContaining({ walletAddr: v.first.wallet.toBase58(), mode: MODE_FIXED, contributionRaw: 30_000_000n })]);
  });

  it("a vault whose PerTradePolicy the job cannot read is a RETRY for each link, with nothing walked or sent", async () => {
    const v = await perTradeVault(MODE_ROUNDUP);
    v.world.accounts.clear();
    buy(v.world, 10_666_667, NOW - 650, "no-policy");
    v.world.finalizeTo(v.world.tip);
    const end = await runVaultJob((await v.store.claim(1))[0]!, v.jobDeps());
    expect(end.report.settles).toMatchObject([{ outcome: "RETRY", detail: expect.stringContaining("no PerTradePolicy") }]);
    expect(v.calls).toEqual(["getMultipleAccountsInfo"]);
    expect(v.db.intents).toEqual([]);
  });
});
