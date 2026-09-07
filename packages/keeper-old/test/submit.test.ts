// The dry-run gate, and the intent-before-broadcast ordering.
//
// "Dry run produces no transaction under any input" is asserted by handing the
// dry-run path a signer and a chain that THROW if used for anything that could
// move funds. A test that only checked the return value would still pass if the
// code sent the transaction and then reported a dry run.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selectors } from "@nuvem/contracts-artifacts";
import { afterEach, describe, expect, it } from "vitest";
import { buildAttestation } from "../src/attest.js";
import { ENGINE_SCHEMA, LEDGER_SCHEMA, Ledger, type LedgerInstance } from "../src/ledger.js";
import { silentLogger } from "../src/log.js";
import { decodeSettleCalldata } from "../src/onchain.js";
import { describePlan, submitSettlement } from "../src/submit.js";
import {
  ACCOUNT,
  CHAIN_ID,
  EXECUTOR,
  FACTORY,
  LIMITS,
  VAULT,
  attestableReport,
  countingAttesterSigner,
  forbiddenTradingSigner,
  realTradingSigner,
  stubChain,
  vaultSnapshot,
} from "./helpers.js";

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
  const dir = mkdtempSync(join(tmpdir(), "nuvem-submit-"));
  dirs.push(dir);
  const ledger = Ledger.open({ dir, instance: INSTANCE, noLock: true });
  openLedgers.push(ledger);
  ledger.ensureHeader({ settlementNonce: 1n, lifetimeContribution: 0n });
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

async function readyAttestation() {
  const outcome = await buildAttestation({
    chain: stubChain(),
    signer: countingAttesterSigner(),
    report: attestableReport(),
    snapshot: vaultSnapshot(),
    chainId: CHAIN_ID,
    account: ACCOUNT,
    vault: VAULT,
    executor: EXECUTOR,
    currentL1Block: 25_643_013n,
    limits: LIMITS,
    nowSeconds: Math.floor(Date.now() / 1000),
  });
  if (outcome.kind !== "READY") throw new Error(`expected READY, got ${outcome.kind}`);
  return outcome;
}

const report = attestableReport();

async function submitWith(over: Partial<Parameters<typeof submitSettlement>[0]> = {}) {
  const attested = await readyAttestation();
  const ledger = over.ledger ?? freshLedger();
  return submitSettlement({
    mode: "dry-run",
    chain: stubChain(),
    ledger,
    logger: silentLogger(),
    attestation: attested.attestation,
    signature: attested.signature,
    digest: attested.digest,
    chainId: CHAIN_ID,
    executor: EXECUTOR,
    account: ACCOUNT,
    startBlockL2: report.startBlockL2,
    endBlockL2: report.endBlockL2,
    attesterAddress: attested.attestation.account,
    reportCash: {
      cashStart: report.cashStart,
      cashEnd: report.cashEnd,
      externalDeposits: report.externalDeposits,
      externalWithdrawals: report.externalWithdrawals,
    },
    limits: LIMITS,
    tradingSigner: null,
    ...over,
  });
}

describe("dry run", () => {
  it("produces no transaction, even when handed a working signer and a live chain", async () => {
    const chain = stubChain();
    const result = await submitWith({ mode: "dry-run", chain, tradingSigner: forbiddenTradingSigner() });

    expect(result.kind).toBe("DRY_RUN");
    // Nothing was signed and nothing was sent.
    expect(chain.sentRaw).toEqual([]);
    expect(chain.calls).not.toContain("sendRawTransaction");
    expect(chain.calls).not.toContain("waitForReceipt");
    // No nonce was even reserved: there is nothing to reserve one for.
    expect(chain.calls).not.toContain("getPendingTransactionCount");
  });

  it("stays a dry run for every mode value that is not exactly \"live\"", async () => {
    for (const mode of ["dry-run", "DRY-RUN", "", "LIVE", "live " , "1", "true"] as unknown as ("live" | "dry-run")[]) {
      const chain = stubChain();
      const result = await submitWith({ mode, chain, tradingSigner: forbiddenTradingSigner() });
      expect(result.kind).toBe("DRY_RUN");
      expect(chain.sentRaw).toEqual([]);
    }
  });

  it("shows exactly what would be sent, and the calldata decodes back to the attestation", async () => {
    const result = await submitWith({ mode: "dry-run" });
    expect(result.kind).toBe("DRY_RUN");
    if (result.kind !== "DRY_RUN") return;

    const plan = result.plan;
    expect(plan.from).toBe(ACCOUNT);
    expect(plan.to).toBe(EXECUTOR);
    expect(plan.value).toBe(403_370_889_498_747n);
    expect(plan.chainId).toBe(CHAIN_ID);
    expect(plan.nonce).toBeNull();
    expect(plan.gasLimit).toBeGreaterThan(0n);
    expect(plan.maxFeePerGas).toBeGreaterThan(0n);
    // The selector the whole system is built around. Read from the compiled ABI
    // rather than pinned to a literal: settle() takes the whole attestation
    // struct, so this selector moves whenever a field is added — it went
    // 0xf38ac34f -> 0xc8f2629d when startBlockL2/endBlockL2 were promoted to real
    // fields, with settle() itself untouched. A literal here would either have to
    // be edited on every such change (and would then be testing the edit, not the
    // code) or would quietly pin a shape the contracts no longer have.
    // packages/session-engine-old/scripts/check-settle-selector.mts is where the
    // value itself is held to the ABI, because that is where a stale copy does
    // real damage.
    const settleSelector = selectors.SettlementExecutor.functions[
      Object.keys(selectors.SettlementExecutor.functions).find((signature) => signature.startsWith("settle(")) ?? ""
    ];
    expect(settleSelector).toBeDefined();
    expect(plan.data.startsWith(settleSelector!)).toBe(true);

    const decoded = decodeSettleCalldata(plan.data);
    expect(decoded).not.toBeNull();
    expect(decoded?.attestation.contribution).toBe(plan.value);
    expect(decoded?.attestation.ledgerRoot).toBe(report.ledgerRootV2);
    expect(decoded?.attestation.startBlock).toBe(report.startBlockL1);
    expect(decoded?.attestation.endBlock).toBe(report.endBlockL1);
    // BOTH RANGES SURVIVE THE ROUND TRIP. The L2 pair is what the vault
    // progresses on, and calldata is the only place it is recoverable from —
    // reconcile.ts reads it back from exactly here when adopting a settlement
    // the journal never saw.
    expect(decoded?.attestation.startBlockL2).toBe(report.startBlockL2);
    expect(decoded?.attestation.endBlockL2).toBe(report.endBlockL2);

    const described = describePlan(plan, false);
    expect(described.valueWei).toBe("403370889498747");
    expect(described.calldata).toBeUndefined();
    expect(describePlan(plan, true).calldata).toBe(plan.data);
  });

  it("leaves an inert DRYRUN record: an audit trail that changes no eligibility", async () => {
    const ledger = freshLedger();
    await submitWith({ mode: "dry-run", ledger });
    expect(ledger.state.counts.DRYRUN).toBe(1);
    // The window is NOT recorded as settled, so tomorrow's live run still sees it.
    expect(ledger.state.settledSessionIds.size).toBe(0);
    expect(ledger.state.settledFrontierL2).toBeNull();
    expect(ledger.state.settlementCount).toBe(0);
    expect(ledger.state.openIntents).toHaveLength(0);
    ledger.close();
  });
});

describe("live mode", () => {
  it("refuses without a trading key rather than guessing", async () => {
    const chain = stubChain();
    const result = await submitWith({ mode: "live", chain, tradingSigner: null });
    expect(result.kind).toBe("BLOCKED");
    if (result.kind === "BLOCKED") expect(result.reason).toBe("NO_TRADING_KEY");
    expect(chain.sentRaw).toEqual([]);
  });

  it("refuses a signer that is not the trading account itself", async () => {
    // msg.sender MUST be the trading account: SettlementExecutor resolves the
    // vault via factory.activeVaultOf(msg.sender).
    const chain = stubChain();
    const result = await submitWith({ mode: "live", chain, tradingSigner: realTradingSigner() });
    expect(result.kind).toBe("BLOCKED");
    if (result.kind === "BLOCKED") expect(result.reason).toBe("WRONG_SENDER");
    expect(chain.sentRaw).toEqual([]);
  });

  it("writes the INTENT before the send, with the nonce and the raw hash", async () => {
    const ledger = freshLedger();
    const chain = stubChain({ pendingNonce: 75 });
    // A signer whose address matches the trading account. Same throwaway key as
    // realTradingSigner, but the account is overridden so the sender check passes;
    // the signature itself is never verified by this test.
    const inner = realTradingSigner();
    const signer = { address: ACCOUNT, signTransaction: inner.signTransaction };

    const result = await submitWith({ mode: "live", chain, ledger, tradingSigner: signer });
    expect(result.kind).toBe("CONFIRMED");

    const { records, integrityOk } = ledger.readRecords();
    expect(integrityOk).toBe(true);
    const types = records.map((r) => r.type);
    // The order is the whole safety argument.
    expect(types).toEqual(["HEADER", "INTENT", "CONFIRMED"]);

    const intent = records[1];
    expect(intent?.type).toBe("INTENT");
    const body = intent?.body as { eoaNonce: number; rawTxHash: string; deadline: number };
    expect(body.eoaNonce).toBe(75);
    expect(body.rawTxHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(body.deadline).toBeGreaterThan(0);

    // The INTENT is durable ON DISK, not just in memory: it was committed and
    // fsynced BEFORE the send, so a crash immediately after the send still leaves
    // it readable by an independent reader.
    ledger.close();
    const reread = Ledger.read(ledger.journalPath);
    expect(reread.integrityOk).toBe(true);
    const persisted = reread.records.find((r) => r.type === "INTENT");
    expect(persisted).toBeDefined();
    const text = JSON.stringify(reread.records, (_k, v: unknown) =>
      typeof v === "bigint" ? v.toString() : v,
    );
    expect(text).toContain('"type":"INTENT"');
    expect(text).toContain(body.rawTxHash);
    // And it carries no signature material beyond the attester's address.
    expect(text).not.toContain(result.kind === "CONFIRMED" ? result.plan.data.slice(2, 60) : "impossible");
  });

  it("records FAILED, and no progress, when the transaction reverts", async () => {
    const ledger = freshLedger();
    const inner = realTradingSigner();
    const signer = { address: ACCOUNT, signTransaction: inner.signTransaction };
    const chain = stubChain();
    // Override the receipt to a revert.
    const reverting = {
      ...chain,
      waitForReceipt: async (hash: `0x${string}`) => ({
        transactionHash: hash,
        status: "reverted" as const,
        blockNumber: 22_996_900n,
        gasUsed: 120_000n,
      }),
    };

    const result = await submitWith({ mode: "live", chain: reverting, ledger, tradingSigner: signer });
    expect(result.kind).toBe("FAILED");
    // Gas burned, EOA nonce consumed, NO money moved — so the window must not be
    // recorded as progress.
    expect(ledger.state.settledFrontierL2).toBeNull();
    expect(ledger.state.chainGuardL1.size).toBe(0);
    expect(ledger.state.settledSessionIds.size).toBe(0);
    expect(ledger.state.openIntents).toHaveLength(0);
    ledger.close();
  });

  it("leaves the intent open when the send itself errors, rather than assuming nothing was sent", async () => {
    const ledger = freshLedger();
    const inner = realTradingSigner();
    const signer = { address: ACCOUNT, signTransaction: inner.signTransaction };
    const chain = stubChain();
    const failing = {
      ...chain,
      sendRawTransaction: async () => {
        throw new Error("socket hang up");
      },
    };

    const result = await submitWith({ mode: "live", chain: failing, ledger, tradingSigner: signer });
    expect(result.kind).toBe("UNRESOLVED");
    // A timeout can hide a transaction that reached the mempool, so the intent
    // stays open and single-flight keeps everything else from moving.
    expect(ledger.state.openIntents).toHaveLength(1);
    ledger.close();
  });

  it("refuses to broadcast while an earlier intent is unresolved", async () => {
    const ledger = freshLedger();
    ledger.append("INTENT", {
      startBlockL2: 1n,
      endBlockL2: 2n,
      sessionId: "0xabc0000000000000000000000000000000000000000000000000000000000001",
      bindingEpoch: 1n,
      settlementNonce: 1n,
      startBlockL1: 1n,
      endBlockL1: 2n,
      ledgerRoot: "0x00",
      contribution: 1n,
      realizedProfit: 1n,
      attestationDigest: "0x00",
      attester: ACCOUNT,
      eoaNonce: 1,
      rawTxHash: "0xabc0000000000000000000000000000000000000000000000000000000000002",
      gasLimit: 1n,
      maxFeePerGas: 1n,
      validAfter: 0,
      deadline: 0,
      cashStart: 0n,
      cashEnd: 0n,
      externalDeposits: 0n,
      externalWithdrawals: 0n,
    });
    const inner = realTradingSigner();
    const signer = { address: ACCOUNT, signTransaction: inner.signTransaction };
    const chain = stubChain();
    const result = await submitWith({ mode: "live", chain, ledger, tradingSigner: signer });
    expect(result.kind).toBe("BLOCKED");
    if (result.kind === "BLOCKED") expect(result.reason).toBe("SINGLE_FLIGHT");
    expect(chain.sentRaw).toEqual([]);
    ledger.close();
  });
});
