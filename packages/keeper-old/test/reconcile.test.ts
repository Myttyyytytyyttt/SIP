// Chain-versus-local truth, including the case the whole package exists for:
// the local ledger says a window is unsettled and the chain says it is not.
//
// The bar these tests hold the code to is that the CHAIN always wins, and that
// the nonce is never used to answer the question on its own. The trading account
// is the trader's own actively-used EOA, so "the nonce advanced" is perfectly
// consistent with "we never settled" — a GMGN trade took it.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENGINE_SCHEMA, LEDGER_SCHEMA, Ledger, localEligibility, type LedgerInstance } from "../src/ledger.js";
import { silentLogger } from "../src/log.js";
import {
  chainEligibility,
  enumerateChainSettlements,
  reconcile,
  resolveIntent,
} from "../src/reconcile.js";
import { encodeSettleCalldata } from "../src/onchain.js";
import {
  ACCOUNT,
  CHAIN_ID,
  EXECUTOR,
  FACTORY,
  LIMITS,
  VAULT,
  attestableReport,
  countingAttesterSigner,
  l1BlockNumberAt,
  settlementLog,
  stubChain,
  vaultSnapshot,
} from "./helpers.js";
import { buildAttestation } from "../src/attest.js";

const INSTANCE: LedgerInstance = {
  chainId: CHAIN_ID,
  factory: FACTORY,
  executor: EXECUTOR,
  vault: VAULT,
  account: ACCOUNT,
  ledgerSchema: LEDGER_SCHEMA,
  engineSchema: ENGINE_SCHEMA,
};

const dirs: string[] = [];
const openLedgers: Ledger[] = [];
function freshLedger(): Ledger {
  const dir = mkdtempSync(join(tmpdir(), "nuvem-reconcile-"));
  dirs.push(dir);
  const ledger = Ledger.open({ dir, instance: INSTANCE, noLock: true });
  openLedgers.push(ledger);
  return ledger;
}
afterEach(() => {
  // The store is a real database file now, and Windows will not unlink one that
  // is still open. Close before removing.
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

const RAW_TX = "0xffff000000000000000000000000000000000000000000000000000000000001" as const;
const SESSION_ID = "0xcccc000000000000000000000000000000000000000000000000000000000001" as const;

// The real canary settlement, as it actually sits on Robinhood Chain mainnet. It
// consumed settlementNonce 0 (the attestation carries the pre-increment value, so
// account.settlementNonce reads 1 afterwards) over L1 blocks 25635381..25635384.
interface SettlementFixture {
  settlementNonce: bigint;
  bindingEpoch: bigint;
  startBlockL1: bigint;
  endBlockL1: bigint;
  /**
   * Zero by default, which is what "this settlement did not declare its L2
   * window" looks like on the wire. Every fixture below keeps that default on
   * purpose: they are models of the settlement history that already exists, made
   * before the attestation carried startBlockL2/endBlockL2, and the L1 clamp is
   * precisely the machinery that exists to read it. A test that populated them
   * would quietly stop testing the clamp at all.
   */
  startBlockL2: bigint;
  endBlockL2: bigint;
  sessionId: `0x${string}`;
  ledgerRoot: `0x${string}`;
  txHash: `0x${string}`;
  blockNumberL2: bigint;
  contribution: bigint;
  realizedProfit: bigint;
}

const CANARY: SettlementFixture = {
  settlementNonce: 0n,
  bindingEpoch: 1n,
  startBlockL1: 25_635_381n,
  endBlockL1: 25_635_384n,
  startBlockL2: 0n,
  endBlockL2: 0n,
  sessionId: "0x0d176cd39f2e1e5d415ab74379bef9d4c8027073f41995e1b7cc5bbb089c2168",
  ledgerRoot: "0xbc9407f1a72d27440e211568ad4842bd2fe0cbb2eeb686b88edfd4062cc674e5",
  txHash: "0xd342d1170000000000000000000000000000000000000000000000000000cad18",
  blockNumberL2: 22_086_130n,
  contribution: 403_370_889_498_747n,
  realizedProfit: 2_016_854_447_493_738n,
};

/**
 * Builds the chain-side evidence one past settlement leaves behind: the indexed
 * SettlementExecuted log, plus the settle transaction whose calldata is the only
 * place the block boundary survives. Recovery has to work from exactly this and
 * nothing else, because PersonalVault exposes no getter for lastEndBlock.
 */
function pastSettlement(over: Partial<SettlementFixture> = {}): {
  log: ReturnType<typeof settlementLog>;
  txByHash: Record<string, { hash: `0x${string}`; input: `0x${string}`; blockNumber: bigint }>;
} {
  const facts = { ...CANARY, ...over };
  const calldata = encodeSettleCalldata(
    {
      account: ACCOUNT,
      vault: VAULT,
      executor: EXECUTOR,
      chainId: BigInt(CHAIN_ID),
      bindingEpoch: facts.bindingEpoch,
      policyNonce: 1n,
      adminEpoch: 1n,
      localPauseEpoch: 0n,
      globalPauseEpoch: 0n,
      settlementNonce: facts.settlementNonce,
      policyHash: "0x4444444444444444444444444444444444444444444444444444444444444444",
      sessionId: facts.sessionId,
      ledgerRoot: facts.ledgerRoot,
      startBlock: facts.startBlockL1,
      endBlock: facts.endBlockL1,
      startBlockL2: facts.startBlockL2,
      endBlockL2: facts.endBlockL2,
      cashStart: 30_000_000_000_000_000n,
      cashEnd: 32_016_854_447_493_738n,
      externalDeposits: 0n,
      externalWithdrawals: 0n,
      realizedProfit: facts.realizedProfit,
      contribution: facts.contribution,
      attesterEpoch: 1,
      validAfter: 0,
      deadline: 600,
    },
    `0x${"22".repeat(65)}`,
  );
  const log = settlementLog({
    sessionId: facts.sessionId,
    ledgerRoot: facts.ledgerRoot,
    // The event carries the POST-increment nonce; the calldata carries the
    // pre-increment one. Recovery reads the boundary and the nonce from the
    // calldata, so the two never have to agree.
    settlementNonce: facts.settlementNonce + 1n,
    contribution: facts.contribution,
    realizedProfit: facts.realizedProfit,
    transactionHash: facts.txHash,
    blockNumber: facts.blockNumberL2,
  });
  return {
    log,
    txByHash: {
      [facts.txHash.toLowerCase()]: { hash: facts.txHash, input: calldata, blockNumber: facts.blockNumberL2 },
    },
  };
}

const openIntent = {
  startBlockL2: 22090000n,
  endBlockL2: 22090500n,
  sessionId: SESSION_ID,
  bindingEpoch: 1n,
  settlementNonce: 1n,
  startBlockL1: 25641000n,
  endBlockL1: 25641004n,
  ledgerRoot: "0xdddd000000000000000000000000000000000000000000000000000000000001",
  contribution: 403_370_889_498_747n,
  realizedProfit: 2_016_854_447_493_738n,
  attestationDigest: "0xeeee000000000000000000000000000000000000000000000000000000000001",
  attester: "0x864743540b6D6E0a38f535e1200c0373e0D7AAde",
  eoaNonce: 75,
  rawTxHash: RAW_TX,
  gasLimit: 620_000n,
  maxFeePerGas: 28_050_000n,
  validAfter: 1_800_000_000,
  deadline: 1_800_000_600,
  cashStart: 1n,
  cashEnd: 2n,
  externalDeposits: 0n,
  externalWithdrawals: 0n,
};

describe("resolveIntent: what became of one broadcast", () => {
  it("CONFIRMED when the receipt succeeded", async () => {
    const chain = stubChain({
      receipts: {
        [RAW_TX]: { transactionHash: RAW_TX, status: "success", blockNumber: 22_090_600n, gasUsed: 516_254n },
      },
    });
    const outcome = await resolveIntent(chain, ACCOUNT, openIntent, 1_800_000_100);
    expect(outcome.kind).toBe("CONFIRMED");
  });

  it("FAILED when the receipt reverted", async () => {
    const chain = stubChain({
      receipts: {
        [RAW_TX]: { transactionHash: RAW_TX, status: "reverted", blockNumber: 22_090_600n, gasUsed: 120_000n },
      },
    });
    const outcome = await resolveIntent(chain, ACCOUNT, openIntent, 1_800_000_100);
    expect(outcome.kind).toBe("FAILED");
  });

  it("PENDING while it is in the mempool and inside its own deadline", async () => {
    const chain = stubChain({ transactions: { [RAW_TX]: { hash: RAW_TX, input: "0x", blockNumber: null } } });
    const outcome = await resolveIntent(chain, ACCOUNT, openIntent, 1_800_000_100);
    expect(outcome.kind).toBe("PENDING");
  });

  it("ABANDONED once a still-pending transaction is past its deadline", async () => {
    const chain = stubChain({ transactions: { [RAW_TX]: { hash: RAW_TX, input: "0x", blockNumber: null } } });
    // Past the deadline it can only revert AttestationExpired, so it must stop
    // blocking progress rather than pinning single-flight forever.
    const outcome = await resolveIntent(chain, ACCOUNT, openIntent, 1_800_001_000);
    expect(outcome.kind).toBe("ABANDONED");
  });

  it("ABANDONED when the reserved nonce is still unused: nothing was spent", async () => {
    const chain = stubChain({ minedNonce: 75 });
    const outcome = await resolveIntent(chain, ACCOUNT, openIntent, 1_800_000_100);
    expect(outcome.kind).toBe("ABANDONED");
    if (outcome.kind === "ABANDONED") expect(outcome.reason).toContain("still unused");
  });

  it("does NOT infer a settlement from an advanced nonce with no log", async () => {
    // The nonce moved because the trader made a trade. Inferring a settlement here
    // would mark a window settled that never was, and the profit would be lost
    // forever.
    const chain = stubChain({ minedNonce: 76, settlementLogs: [] });
    const outcome = await resolveIntent(chain, ACCOUNT, openIntent, 1_800_000_100);
    expect(outcome.kind).toBe("ABANDONED");
    if (outcome.kind === "ABANDONED") expect(outcome.reason).toContain("consumed by something else");
  });

  it("CONFIRMED from the indexed log when the nonce advanced and a log exists", async () => {
    const chain = stubChain({
      minedNonce: 76,
      settlementLogs: [settlementLog({ sessionId: SESSION_ID, transactionHash: "0xaaaa000000000000000000000000000000000000000000000000000000000009" })],
    });
    const outcome = await resolveIntent(chain, ACCOUNT, openIntent, 1_800_000_100);
    expect(outcome.kind).toBe("CONFIRMED");
    // The hash comes from the LOG, not from our record: a re-priced rebroadcast
    // has a different hash and the same effect.
    if (outcome.kind === "CONFIRMED") {
      expect(outcome.txHash).toBe("0xaaaa000000000000000000000000000000000000000000000000000000000009");
    }
  });
});

describe("crash after broadcast", () => {
  it("local ledger says unsettled, chain says settled -> does NOT re-settle", async () => {
    // The scenario, exactly: an INTENT was written and the process died before it
    // could record the outcome. The chain has since mined it and settlementNonce
    // has advanced.
    const ledger = freshLedger();
    ledger.ensureHeader({ settlementNonce: 1n, lifetimeContribution: 0n });
    ledger.append("INTENT", openIntent);
    expect(ledger.state.openIntents).toHaveLength(1);
    expect(ledger.state.settledSessionIds.size).toBe(0); // local view: unsettled

    const settleCalldata = encodeSettleCalldata(
      {
        account: ACCOUNT,
        vault: VAULT,
        executor: EXECUTOR,
        chainId: BigInt(CHAIN_ID),
        bindingEpoch: 1n,
        policyNonce: 1n,
        adminEpoch: 1n,
        localPauseEpoch: 0n,
        globalPauseEpoch: 0n,
        settlementNonce: 1n,
        policyHash: "0x4444444444444444444444444444444444444444444444444444444444444444",
        sessionId: SESSION_ID,
        ledgerRoot: "0xdddd000000000000000000000000000000000000000000000000000000000001",
        startBlock: 25641000n,
        endBlock: 25641004n,
        startBlockL2: 0n,
        endBlockL2: 0n,
        cashStart: 1n,
        cashEnd: 2n,
        externalDeposits: 0n,
        externalWithdrawals: 0n,
        realizedProfit: 2_016_854_447_493_738n,
        contribution: 403_370_889_498_747n,
        attesterEpoch: 1,
        validAfter: 1_800_000_000,
        deadline: 1_800_000_600,
      },
      `0x${"11".repeat(65)}`,
    );

    // The canary settlement (settlementNonce 0) is also on chain — it has to be,
    // because the chain reports two consumed nonces and this journal was created
    // after the first one. Recovery must account for BOTH: the one it is resolving
    // and the one it has never seen.
    const prior = pastSettlement();
    const chain = stubChain({
      // The chain's own account state has moved on: nonce 1 -> 2.
      snapshot: vaultSnapshot({ settlementNonce: 2n }),
      l1BlockNumberOf: l1BlockNumberAt,
      receipts: {
        [RAW_TX]: { transactionHash: RAW_TX, status: "success", blockNumber: 22_090_600n, gasUsed: 516_254n },
      },
      transactions: {
        [RAW_TX]: { hash: RAW_TX, input: settleCalldata, blockNumber: 22_090_600n },
        ...prior.txByHash,
      },
      settlementLogs: [
        prior.log,
        settlementLog({ sessionId: SESSION_ID, settlementNonce: 2n, transactionHash: RAW_TX }),
      ],
    });

    const outcome = await reconcile({
      chain,
      ledger,
      logger: silentLogger(),
      account: ACCOUNT,
      snapshot: await chain.readVaultSnapshot(ACCOUNT),
      logsFromBlockL2: 0n,
      nowSeconds: 1_800_000_100,
    });

    // Recovery closed the intent as CONFIRMED and the nonce now reconciles.
    expect(outcome.resolvedIntents).toBe(1);
    expect(outcome.nonceReconciled).toBe(true);
    expect(outcome.degraded).toBeNull();
    expect(ledger.state.openIntents).toHaveLength(0);
    expect(ledger.state.settledSessionIds.has(SESSION_ID.toLowerCase())).toBe(true);
    // The chain-guard mirror is epoch-keyed BECAUSE THE CONTRACT'S MAP IS; it
    // predicts a revert and authorises nothing.
    expect(ledger.state.chainGuardL1.get("1")).toBe(25641004n);
    // The epoch-independent replay boundary is the one that matters.
    expect(ledger.state.settledFrontierL2).toBe(22090500n);

    // And the window is now refused by BOTH layers.
    const candidate = {
      startBlockL2: openIntent.startBlockL2,
      endBlockL2: openIntent.endBlockL2,
      startBlockL1: openIntent.startBlockL1,
      endBlockL1: openIntent.endBlockL1,
      bindingEpoch: 1n,
      sessionId: SESSION_ID,
    };
    const local = localEligibility(ledger.state, candidate, LIMITS, Date.now());
    expect(local.ok).toBe(false);

    const onchain = await chainEligibility(
      chain,
      await chain.readVaultSnapshot(ACCOUNT),
      { sessionId: SESSION_ID, account: ACCOUNT, expectedSettlementNonce: outcome.expectedSettlementNonce },
      0n,
    );
    expect(onchain.ok).toBe(false);
    if (!onchain.ok) expect(onchain.rule).toBe("CHAIN_NOVELTY");

    ledger.close();
  });

  it("COLD START: a process that died between INTENT and CONFIRMED resolves it against the chain", async () => {
    // The crash-after-broadcast case in the shape production produces it: the
    // INTENT was committed and fsynced BEFORE the send, the process died, and a
    // BRAND NEW process opens the same state directory and has to work out what
    // happened from the chain alone.
    const dir = mkdtempSync(join(tmpdir(), "nuvem-coldstart-"));
    dirs.push(dir);

    const first = Ledger.open({ dir, instance: INSTANCE, noLock: true });
    first.ensureHeader({ settlementNonce: 1n, lifetimeContribution: 0n });
    first.append("INTENT", openIntent);
    expect(first.state.openIntents).toHaveLength(1);
    first.close(); // the process is gone; the intent is not

    // A NEW handle on the same directory, exactly as a restarted container gets.
    const restarted = Ledger.open({ dir, instance: INSTANCE, noLock: true });
    openLedgers.push(restarted);
    expect(restarted.state.openIntents).toHaveLength(1);
    expect(restarted.state.openIntents[0]?.body.rawTxHash).toBe(RAW_TX);
    // Single flight holds until it is resolved: we do not know whether the money
    // moved, so nothing else may be settled.
    const other = {
      startBlockL2: 22_500_000n,
      endBlockL2: 22_500_100n,
      startBlockL1: 25_700_000n,
      endBlockL1: 25_700_004n,
      bindingEpoch: 1n,
      sessionId: "0x9999000000000000000000000000000000000000000000000000000000000001" as const,
    };
    const blocked = localEligibility(restarted.state, other, LIMITS, Date.now());
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.rule).toBe("SINGLE_FLIGHT");

    // The canary (settlementNonce 0) is also on chain — it has to be, because the
    // chain reports two consumed nonces and this store only ever knew about the
    // second. Recovery must account for BOTH: the one it is resolving and the one
    // it has never seen.
    const prior = pastSettlement();
    const ours = pastSettlement({
      settlementNonce: 1n,
      sessionId: SESSION_ID,
      ledgerRoot: openIntent.ledgerRoot as `0x${string}`,
      txHash: RAW_TX,
      startBlockL1: openIntent.startBlockL1,
      endBlockL1: openIntent.endBlockL1,
      blockNumberL2: 22_090_600n,
    });
    const chain = stubChain({
      snapshot: vaultSnapshot({ settlementNonce: 2n }),
      l1BlockNumberOf: l1BlockNumberAt,
      receipts: {
        [RAW_TX]: { transactionHash: RAW_TX, status: "success", blockNumber: 22_090_600n, gasUsed: 516_254n },
      },
      transactions: { ...prior.txByHash, ...ours.txByHash },
      settlementLogs: [prior.log, ours.log],
    });

    const outcome = await reconcile({
      chain,
      ledger: restarted,
      logger: silentLogger(),
      account: ACCOUNT,
      snapshot: await chain.readVaultSnapshot(ACCOUNT),
      logsFromBlockL2: 0n,
      nowSeconds: 1_800_000_100,
    });

    // The receipt was conclusive: the money DID move, and the window is now
    // recorded settled rather than being offered again.
    expect(outcome.resolvedIntents).toBe(1);
    expect(restarted.state.openIntents).toHaveLength(0);
    expect(restarted.state.settledSessionIds.has(SESSION_ID.toLowerCase())).toBe(true);
    expect(restarted.state.settledFrontierL2).toBe(22_090_500n);
    const replay = {
      startBlockL2: openIntent.startBlockL2,
      endBlockL2: openIntent.endBlockL2,
      startBlockL1: openIntent.startBlockL1,
      endBlockL1: openIntent.endBlockL1,
      bindingEpoch: 1n,
      sessionId: SESSION_ID,
    };
    expect(localEligibility(restarted.state, replay, LIMITS, Date.now()).ok).toBe(false);
    // ...and still refused after a rebind, with a re-derived sessionId.
    const afterRebind = localEligibility(
      restarted.state,
      { ...replay, bindingEpoch: 7n, sessionId: "0xdead000000000000000000000000000000000000000000000000000000000001" },
      LIMITS,
      Date.now(),
    );
    expect(afterRebind.ok).toBe(false);
    if (!afterRebind.ok) expect(afterRebind.rule).toBe("PROGRESSION_L2");
    restarted.close();
  });

  it("total local state loss: rebuilds the settled boundary from logs plus calldata", async () => {
    // TOTAL LOCAL STATE LOSS, WITH THE BASELINE runTick ACTUALLY WRITES.
    //
    // This test used to be neutralized, and its own comment said so. It called
    // ensureHeader({ settlementNonce: 0n }) — a pre-settlement baseline — while the
    // stub chain reported 1. That made the old `observed > baseline + records`
    // adoption trigger fire, so the assertions below passed. But keeper.ts writes
    // the header from the LIVE snapshot moments before reconcile runs
    // (keeper.ts:170 ensureHeader({ settlementNonce: snapshot.settlementNonce })),
    // so production could only ever produce baseline == observed, the trigger was
    // dead, nothing was adopted, and nonceReconciled came back true over an empty
    // model of history. The test was passing on a baseline the keeper cannot write.
    //
    // So it now writes what runTick writes, and asserts the recovery anyway.
    const ledger = freshLedger();
    const { log, txByHash } = pastSettlement();
    const chain = stubChain({
      snapshot: vaultSnapshot({ settlementNonce: 1n, lifetimeContribution: CANARY.contribution }),
      transactions: txByHash,
      settlementLogs: [log],
      l1BlockNumberOf: l1BlockNumberAt,
    });
    const snapshot = await chain.readVaultSnapshot(ACCOUNT);
    // Exactly what runTick does, in runTick's order: header first, from the live
    // chain, then recovery.
    ledger.ensureHeader({
      settlementNonce: snapshot.settlementNonce,
      lifetimeContribution: snapshot.lifetimeContribution,
    });
    expect(ledger.state.header?.baselineSettlementNonce).toBe(1n);

    const outcome = await reconcile({
      chain,
      ledger,
      logger: silentLogger(),
      account: ACCOUNT,
      snapshot,
      logsFromBlockL2: 0n,
    });

    // The scan ran because the journal could not NAME settlement nonce 0 — not
    // because an arithmetic difference happened to be positive.
    expect(outcome.enumeratedChain).toBe(true);
    expect(outcome.adopted).toBe(1);
    expect(outcome.unaccountedNonces).toEqual([]);
    expect(outcome.nonceReconciled).toBe(true);
    expect(outcome.degraded).toBeNull();
    // The boundary was recovered from decoded calldata, not from local state...
    expect(ledger.state.chainGuardL1.get("1")).toBe(CANARY.endBlockL1);
    // ...and the L2 coverage was clamped back out of the L1 range, per block,
    // never from a stored offset. It is a SUPERSET of the true window
    // (22080592, 22080850], which can forfeit a session and can never double-pay.
    expect(ledger.state.coverageUnresolved).toBe(0);
    expect(ledger.state.settledFrontierL2).toBe(22080899n);
    expect(ledger.state.confirmedRecords[0]?.body.l2Precision).toBe("L1_CLAMP");
    expect(ledger.state.settledSessionIds.has(CANARY.sessionId.toLowerCase())).toBe(true);
    // And the nonce is now nameable, which is what makes the next tick cheap.
    expect([...ledger.state.settledSettlementNonces]).toEqual(["0"]);
    ledger.close();
  });

  it("adopts the EXACT L2 window when the settle calldata declares one", async () => {
    // The attestation now carries startBlockL2/endBlockL2, so a settlement made
    // against this executor states its own window and nothing has to be inferred.
    //
    // This matters beyond tidiness. The clamp above deliberately claims a
    // SUPERSET — it widened the real window (22080592, 22080850] out to
    // (22080500, 22080899] — and every block of that overreach is a block in
    // which a genuine later session would be refused as already covered. Reading
    // the declared pair forfeits nothing, needs no RPC, and cannot be off by a
    // block. The clamp remains for settlements that predate these fields.
    const ledger = freshLedger();
    const { log, txByHash } = pastSettlement({ startBlockL2: 22_080_592n, endBlockL2: 22_080_850n });
    const chain = stubChain({
      snapshot: vaultSnapshot({ settlementNonce: 1n, lifetimeContribution: CANARY.contribution }),
      transactions: txByHash,
      settlementLogs: [log],
      l1BlockNumberOf: l1BlockNumberAt,
    });
    const snapshot = await chain.readVaultSnapshot(ACCOUNT);
    ledger.ensureHeader({
      settlementNonce: snapshot.settlementNonce,
      lifetimeContribution: snapshot.lifetimeContribution,
    });

    const outcome = await reconcile({
      chain,
      ledger,
      logger: silentLogger(),
      account: ACCOUNT,
      snapshot,
      logsFromBlockL2: 0n,
    });

    expect(outcome.adopted).toBe(1);
    expect(outcome.degraded).toBeNull();
    expect(ledger.state.confirmedRecords[0]?.body.l2Precision).toBe("EXACT");
    // The true end, not the clamp's 22080899. The 49 blocks between them are the
    // difference between a session settling and a session being forfeited.
    expect(ledger.state.settledFrontierL2).toBe(22_080_850n);
    expect(ledger.state.coverageUnresolved).toBe(0);
    expect(ledger.state.settledSessionIds.has(CANARY.sessionId.toLowerCase())).toBe(true);
    ledger.close();
  });

  it("pins the arithmetic that made the old adoption trigger unreachable", async () => {
    // A REGRESSION PIN, not a behaviour test. The trigger used to be
    //   observed > header.baselineSettlementNonce + journalSettlementRecords
    // and this asserts, on the exact state a wiped volume produces, that both
    // sides are EQUAL — so that condition is false and the log scan never runs.
    // Any future change that reintroduces baseline arithmetic as the trigger for
    // recovery will be reintroducing a guard that cannot fire, and this test says
    // so out loud rather than leaving it to be rediscovered by an adversary.
    const ledger = freshLedger();
    const chain = stubChain({ snapshot: vaultSnapshot({ settlementNonce: 1n }) });
    const snapshot = await chain.readVaultSnapshot(ACCOUNT);
    ledger.ensureHeader({
      settlementNonce: snapshot.settlementNonce,
      lifetimeContribution: snapshot.lifetimeContribution,
    });

    const baseline = ledger.state.header?.baselineSettlementNonce ?? -1n;
    const journalRecords = ledger.state.settlementCount;
    expect(baseline).toBe(snapshot.settlementNonce); // seeded from the live chain
    expect(journalRecords).toBe(0); // and the journal knows nothing
    expect(baseline + BigInt(journalRecords)).toBe(snapshot.settlementNonce); // ...so expected == observed
    expect(snapshot.settlementNonce > baseline + BigInt(journalRecords)).toBe(false); // the old trigger

    // The evidence-based invariant, on the same state, is not satisfiable by
    // construction: the journal cannot name the nonce the chain says was consumed.
    expect(ledger.state.settledSettlementNonces.has("0")).toBe(false);
    expect(ledger.state.acknowledgedNonceFloor).toBe(0n);
    ledger.close();
  });

  it("total local state loss: refuses the already-settled window instead of re-attesting it", async () => {
    // THE HEADLINE CASE, end to end. Wiped volume, real mainnet facts, and the
    // window offered back to the keeper is the one that is already settled. Both
    // reviewers reached signing here; the assertion is that we no longer do.
    const ledger = freshLedger();
    const { log, txByHash } = pastSettlement();
    const chain = stubChain({
      snapshot: vaultSnapshot({ settlementNonce: 1n, lifetimeContribution: CANARY.contribution }),
      transactions: txByHash,
      settlementLogs: [log],
      l1BlockNumberOf: l1BlockNumberAt,
    });
    const snapshot = await chain.readVaultSnapshot(ACCOUNT);
    ledger.ensureHeader({
      settlementNonce: snapshot.settlementNonce,
      lifetimeContribution: snapshot.lifetimeContribution,
    });
    await reconcile({ chain, ledger, logger: silentLogger(), account: ACCOUNT, snapshot, logsFromBlockL2: 0n });

    // The window re-derives to a DIFFERENT sessionId today, because ledgerRoot
    // moved from the legacy scheme to v2. That is exactly why neither novelty rule
    // can be the primary defence, and why the recovered BOUNDARY has to be.
    const rederived = {
      startBlockL2: 22_080_592n,
      endBlockL2: 22_080_850n,
      startBlockL1: CANARY.startBlockL1,
      endBlockL1: CANARY.endBlockL1,
      bindingEpoch: 1n,
      sessionId: "0x259ef15b491b09f13f6e782aa76d7a4de101d7fced859393113dcc6921ea07f4",
    };
    expect(rederived.sessionId).not.toBe(CANARY.sessionId);
    expect(ledger.state.settledSessionIds.has(rederived.sessionId)).toBe(false);

    const local = localEligibility(ledger.state, rederived, LIMITS, Date.now());
    expect(local.ok).toBe(false);
    // PROGRESSION_L2, the EPOCH-INDEPENDENT replay rule, and the reason a
    // bindingEpoch rebind can no longer re-arm this replay.
    if (!local.ok) expect(local.rule).toBe("PROGRESSION_L2");

    // And it still refuses under a FRESH bindingEpoch with the FRESH sessionId a
    // re-derivation produces, which is exactly the case the old epoch-keyed
    // boundaries waved through.
    const afterRebind = localEligibility(
      ledger.state,
      { ...rederived, bindingEpoch: 2n },
      LIMITS,
      Date.now(),
    );
    expect(afterRebind.ok).toBe(false);
    if (!afterRebind.ok) expect(afterRebind.rule).toBe("PROGRESSION_L2");
    ledger.close();
  });

  it("total local state loss the scan cannot cover: halts rather than reporting itself reconciled", async () => {
    // OPTION (b). The chain says a settlement happened and the log scan cannot see
    // it — the log floor is above it, or a provider answered a capped range with an
    // empty list. There is no boundary to recover, so there is nothing to be
    // confident about. The one thing that must never happen is the thing the old
    // code did: report nonceReconciled true and carry on.
    const ledger = freshLedger();
    const chain = stubChain({
      snapshot: vaultSnapshot({ settlementNonce: 1n, lifetimeContribution: CANARY.contribution }),
      settlementLogs: [],
    });
    const snapshot = await chain.readVaultSnapshot(ACCOUNT);
    ledger.ensureHeader({
      settlementNonce: snapshot.settlementNonce,
      lifetimeContribution: snapshot.lifetimeContribution,
    });

    const outcome = await reconcile({
      chain,
      ledger,
      logger: silentLogger(),
      account: ACCOUNT,
      snapshot,
      logsFromBlockL2: 22_000_000n,
    });

    expect(outcome.enumeratedChain).toBe(true);
    expect(outcome.adopted).toBe(0);
    expect(outcome.unaccountedNonces).toEqual([0n]);
    expect(outcome.nonceReconciled).toBe(false);
    expect(outcome.degraded?.reason).toBe("UNACCOUNTED_SETTLEMENTS");
    expect(ledger.state.degraded?.reason).toBe("UNACCOUNTED_SETTLEMENTS");

    // The halt is what refuses the window, and it refuses EVERY window, including
    // ones that look nothing like the settled one.
    const unrelated = {
      startBlockL2: 22_500_000n,
      endBlockL2: 22_500_500n,
      startBlockL1: 25_700_000n,
      endBlockL1: 25_700_004n,
      bindingEpoch: 1n,
      sessionId: "0xabcd000000000000000000000000000000000000000000000000000000000001",
    };
    const local = localEligibility(ledger.state, unrelated, LIMITS, Date.now());
    expect(local.ok).toBe(false);
    if (!local.ok) expect(local.rule).toBe("NOT_DEGRADED");

    // And the CAS token handed to the chain layer is the unexplained nonce, so even
    // a caller that ignored the halt would be refused by NONCE_AGREEMENT.
    expect(outcome.expectedSettlementNonce).toBe(0n);
    const onchain = await chainEligibility(
      chain,
      snapshot,
      { sessionId: unrelated.sessionId as `0x${string}`, account: ACCOUNT, expectedSettlementNonce: outcome.expectedSettlementNonce },
      22_000_000n,
    );
    expect(onchain.ok).toBe(false);
    if (!onchain.ok) expect(onchain.rule).toBe("NONCE_AGREEMENT");
    ledger.close();
  });

  it("an operator acknowledgement of unaccounted history is durable, and bounded", async () => {
    // An acknowledgement that does not survive the next tick is not one: reconcile
    // would re-detect the same shortfall and latch DEGRADED again, which is how a
    // documented recovery procedure turns into a crash loop. And an
    // acknowledgement that covers FUTURE settlements would be a licence to replay,
    // so the bound the DEGRADED recorded is the bound the RESUMED inherits.
    const ledger = freshLedger();
    const chain = stubChain({ snapshot: vaultSnapshot({ settlementNonce: 1n }), settlementLogs: [] });
    const snapshot = await chain.readVaultSnapshot(ACCOUNT);
    ledger.ensureHeader({ settlementNonce: snapshot.settlementNonce, lifetimeContribution: 0n });
    const first = await reconcile({
      chain, ledger, logger: silentLogger(), account: ACCOUNT, snapshot, logsFromBlockL2: 22_000_000n,
    });
    expect(first.degraded?.reason).toBe("UNACCOUNTED_SETTLEMENTS");

    const degradedSeq = ledger.state.degraded?.seq;
    expect(degradedSeq).toBeDefined();
    ledger.append("RESUMED", { acknowledgedSeq: degradedSeq ?? -1, note: "verified by hand" });
    // The floor is now durable derived state, recovered by replaying the journal.
    expect(ledger.state.acknowledgedNonceFloor).toBe(1n);

    const second = await reconcile({
      chain, ledger, logger: silentLogger(), account: ACCOUNT, snapshot, logsFromBlockL2: 22_000_000n,
    });
    expect(second.unaccountedNonces).toEqual([]);
    expect(second.nonceReconciled).toBe(true);
    expect(second.degraded).toBeNull();
    // No wasted scan either: the accounting squares, so no log hunt runs.
    expect(second.enumeratedChain).toBe(false);

    // BOUNDED. A settlement that happens AFTER the acknowledgement is unaccounted
    // all over again — the operator excused nonce 0, not the future.
    const later = vaultSnapshot({ settlementNonce: 2n });
    const third = await reconcile({
      chain, ledger, logger: silentLogger(), account: ACCOUNT, snapshot: later, logsFromBlockL2: 22_000_000n,
    });
    expect(third.unaccountedNonces).toEqual([1n]);
    expect(third.nonceReconciled).toBe(false);
    ledger.close();
  });

  it("survives the reload: the floor and the nameable nonces come back from the journal", async () => {
    const ledger = freshLedger();
    const chain = stubChain({ snapshot: vaultSnapshot({ settlementNonce: 1n }), settlementLogs: [] });
    const snapshot = await chain.readVaultSnapshot(ACCOUNT);
    ledger.ensureHeader({ settlementNonce: snapshot.settlementNonce, lifetimeContribution: 0n });
    await reconcile({ chain, ledger, logger: silentLogger(), account: ACCOUNT, snapshot, logsFromBlockL2: 22_000_000n });
    ledger.append("RESUMED", { acknowledgedSeq: ledger.state.degraded?.seq ?? -1, note: "ack" });
    const dir = ledger.dir;
    ledger.close();

    const reopened = Ledger.open({ dir, instance: INSTANCE, noLock: true });
    expect(reopened.state.acknowledgedNonceFloor).toBe(1n);
    expect(reopened.state.degraded).toBeNull();
    reopened.close();
  });

  it("halts when the journal claims more settlements than the chain performed", async () => {
    const ledger = freshLedger();
    ledger.ensureHeader({ settlementNonce: 5n, lifetimeContribution: 0n });
    ledger.append("CONFIRMED", {
      startBlockL2: 1n,
      endBlockL2: 2n,
      sessionId: "0x01",
      bindingEpoch: 1n,
      settlementNonce: 5n,
      startBlockL1: 1n,
      endBlockL1: 2n,
      ledgerRoot: "0x02",
      contribution: 1n,
      realizedProfit: 1n,
      txHash: "0x03",
      blockNumberL2: 1n,
      gasUsed: 1n,
      source: "own",
    });
    // The chain still reports 5: our CONFIRMED describes something that did not
    // happen here. That means a wrong model of history, which must halt.
    const chain = stubChain({ snapshot: vaultSnapshot({ settlementNonce: 5n }) });
    const outcome = await reconcile({
      chain,
      ledger,
      logger: silentLogger(),
      account: ACCOUNT,
      snapshot: await chain.readVaultSnapshot(ACCOUNT),
      logsFromBlockL2: 0n,
    });
    expect(outcome.degraded).not.toBeNull();
    expect(outcome.degraded?.reason).toBe("NONCE_REGRESSION");
    expect(ledger.state.degraded).not.toBeNull();
    ledger.close();
  });

  it("halts on a SettlementExecuted whose calldata cannot be decoded", async () => {
    const ledger = freshLedger();
    ledger.ensureHeader({ settlementNonce: 0n, lifetimeContribution: 0n });
    const log = settlementLog();
    const chain = stubChain({
      snapshot: vaultSnapshot({ settlementNonce: 1n }),
      // Some other route settled: an unrecognised selector.
      transactions: { [log.transactionHash.toLowerCase()]: { hash: log.transactionHash, input: "0xdeadbeef", blockNumber: 1n } },
      settlementLogs: [log],
    });
    const outcome = await reconcile({
      chain,
      ledger,
      logger: silentLogger(),
      account: ACCOUNT,
      snapshot: await chain.readVaultSnapshot(ACCOUNT),
      logsFromBlockL2: 0n,
    });
    expect(outcome.degraded?.reason).toBe("UNDECODABLE_SETTLEMENT");
    ledger.close();
  });
});

describe("chainEligibility", () => {
  it("refuses on a stale settlementNonce, which is a CAS token not a race", async () => {
    const chain = stubChain();
    const verdict = await chainEligibility(
      chain,
      vaultSnapshot({ settlementNonce: 7n }),
      { sessionId: SESSION_ID, account: ACCOUNT, expectedSettlementNonce: 1n },
      0n,
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.rule).toBe("NONCE_AGREEMENT");
  });

  it("allows a session with no matching log", async () => {
    const chain = stubChain({ settlementLogs: [settlementLog({ sessionId: "0x99" })] });
    const verdict = await chainEligibility(
      chain,
      vaultSnapshot(),
      { sessionId: SESSION_ID, account: ACCOUNT, expectedSettlementNonce: 1n },
      0n,
    );
    expect(verdict.ok).toBe(true);
  });

  it("ignores a log for the same sessionId belonging to a different account", async () => {
    const chain = stubChain({
      settlementLogs: [settlementLog({ sessionId: SESSION_ID, account: "0x0000000000000000000000000000000000000abc" })],
    });
    const verdict = await chainEligibility(
      chain,
      vaultSnapshot(),
      { sessionId: SESSION_ID, account: ACCOUNT, expectedSettlementNonce: 1n },
      0n,
    );
    expect(verdict.ok).toBe(true);
  });
});

describe("re-attesting a settled window", () => {
  it("produces the same sessionId, which is exactly why the ledger is needed", async () => {
    // The engine is stateless and deterministic: re-running it over an
    // already-settled window returns the identical positive profit and the
    // identical ATTESTABLE verdict, because the settlement outflow is provably
    // outside the window (the contract requires endBlockL1 < block.number) and
    // cashEnd is an archival read at the end boundary. So sessionId is identical
    // too — and nothing in the engine will ever stop a second settlement.
    const report = attestableReport();
    const first = await buildAttestation({
      chain: stubChain(),
      signer: countingAttesterSigner(),
      report,
      snapshot: vaultSnapshot({ settlementNonce: 1n }),
      chainId: CHAIN_ID,
      account: ACCOUNT,
      vault: VAULT,
      executor: EXECUTOR,
      currentL1Block: 25_643_013n,
      limits: LIMITS,
      nowSeconds: 1_800_000_000,
    });
    const second = await buildAttestation({
      chain: stubChain(),
      signer: countingAttesterSigner(),
      report,
      // Only the nonce moved, exactly as it would after a real settlement.
      snapshot: vaultSnapshot({ settlementNonce: 2n }),
      chainId: CHAIN_ID,
      account: ACCOUNT,
      vault: VAULT,
      executor: EXECUTOR,
      currentL1Block: 25_643_013n,
      limits: LIMITS,
      nowSeconds: 1_800_000_000,
    });

    expect(first.kind).toBe("READY");
    expect(second.kind).toBe("READY");
    if (first.kind !== "READY" || second.kind !== "READY") return;
    // Identical sessionId, different digest: a genuinely fresh, valid signature
    // over an already-settled window. The service's state is the only thing
    // standing between the engine and a second contribution.
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.digest).not.toBe(first.digest);
  });
});

describe("the rebuild path", () => {
  it("recovers the whole settled set from several SettlementExecuted logs", async () => {
    // Three settlements, out of block order in the log list on purpose: the
    // recovered boundary must be the HIGHEST end block, not the last one seen.
    const ledger = freshLedger();
    const first = pastSettlement();
    const second = pastSettlement({
      settlementNonce: 1n,
      sessionId: "0x1111000000000000000000000000000000000000000000000000000000000001",
      ledgerRoot: "0x1111000000000000000000000000000000000000000000000000000000000002",
      txHash: "0x1111000000000000000000000000000000000000000000000000000000000003",
      startBlockL1: 25_636_000n,
      endBlockL1: 25_636_010n,
      blockNumberL2: 22_100_000n,
    });
    const third = pastSettlement({
      settlementNonce: 2n,
      sessionId: "0x2222000000000000000000000000000000000000000000000000000000000001",
      ledgerRoot: "0x2222000000000000000000000000000000000000000000000000000000000002",
      txHash: "0x2222000000000000000000000000000000000000000000000000000000000003",
      startBlockL1: 25_637_000n,
      endBlockL1: 25_637_020n,
      blockNumberL2: 22_200_000n,
    });
    const chain = stubChain({
      snapshot: vaultSnapshot({ settlementNonce: 3n }),
      settlementLogs: [third.log, first.log, second.log],
      transactions: { ...first.txByHash, ...second.txByHash, ...third.txByHash },
      l1BlockNumberOf: l1BlockNumberAt,
    });
    const snapshot = await chain.readVaultSnapshot(ACCOUNT);
    ledger.ensureHeader({ settlementNonce: snapshot.settlementNonce, lifetimeContribution: snapshot.lifetimeContribution });

    const outcome = await reconcile({
      chain, ledger, logger: silentLogger(), account: ACCOUNT, snapshot, logsFromBlockL2: 0n,
    });

    expect(outcome.adopted).toBe(3);
    expect(outcome.nonceReconciled).toBe(true);
    expect(outcome.degraded).toBeNull();
    expect([...ledger.state.settledSettlementNonces].sort()).toEqual(["0", "1", "2"]);
    expect(ledger.state.chainGuardL1.get("1")).toBe(25_637_020n);
    // Adopted in settlementNonce order, so the frontier chain is contiguous and
    // ends at the HIGHEST recovered L2 boundary, not the last log seen.
    expect(ledger.state.settledFrontierL2).toBe(22_244_499n);
    expect(ledger.state.settledSessionIds.size).toBe(3);
    expect(ledger.state.counts.ADOPTED).toBe(3);
    ledger.close();
  });

  it("adopts idempotently: a second recovery pass adds nothing and scans nothing", async () => {
    const ledger = freshLedger();
    const { log, txByHash } = pastSettlement();
    const chain = stubChain({
      snapshot: vaultSnapshot({ settlementNonce: 1n }),
      settlementLogs: [log],
      transactions: txByHash,
      l1BlockNumberOf: l1BlockNumberAt,
    });
    const snapshot = await chain.readVaultSnapshot(ACCOUNT);
    ledger.ensureHeader({ settlementNonce: snapshot.settlementNonce, lifetimeContribution: 0n });
    const args = { chain, ledger, logger: silentLogger(), account: ACCOUNT, snapshot, logsFromBlockL2: 0n };

    const first = await reconcile(args);
    expect(first.adopted).toBe(1);
    const second = await reconcile(args);
    expect(second.adopted).toBe(0);
    // The steady state costs nothing: the journal names every consumed nonce, so
    // there is no reason to hunt and no scan is issued.
    expect(second.enumeratedChain).toBe(false);
    expect(second.nonceReconciled).toBe(true);
    expect(ledger.state.counts.ADOPTED).toBe(1);
    ledger.close();
  });
});

describe("the log scan floor", () => {
  it("resolveIntent honours the configured floor instead of hardcoding block 0", async () => {
    // Hardcoding 0 here threw on any endpoint that caps eth_getLogs by range, which
    // aborted the tick, left the INTENT unresolved, and let SINGLE_FLIGHT block
    // every future settlement — permanently, on provider policy alone.
    const seen: (bigint | undefined)[] = [];
    const base = stubChain({ minedNonce: 76, settlementLogs: [] });
    const chain = {
      ...base,
      getSettlementLogs: async (filter: Parameters<typeof base.getSettlementLogs>[0]) => {
        seen.push(filter.fromBlockL2);
        return base.getSettlementLogs(filter);
      },
    };
    await resolveIntent(chain, ACCOUNT, openIntent, 1_800_000_100, 22_000_000n);
    expect(seen).toEqual([22_000_000n]);
  });
});

describe("enumerateChainSettlements", () => {
  it("reports undecodable settlements rather than skipping them", async () => {
    const log = settlementLog();
    const chain = stubChain({
      settlementLogs: [log],
      transactions: { [log.transactionHash.toLowerCase()]: { hash: log.transactionHash, input: "0x1234", blockNumber: 1n } },
    });
    const { settlements, undecodable } = await enumerateChainSettlements(chain, ACCOUNT, 0n);
    expect(settlements).toHaveLength(0);
    expect(undecodable).toEqual([log.transactionHash]);
  });
});
