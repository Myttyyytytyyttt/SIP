// Every case here is drawn from real history on the mainnet canary wallet, and
// runs offline against a recorded fixture. The fixture client throws on any
// unrecorded request, so a change that needs new data fails loudly instead of
// quietly answering from less evidence.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fixtureRpcClient, type Recording } from "./rpc.js";
import { buildSessionReport } from "./session.js";
import { calculateRealizedProfit } from "./profit.js";

const WALLET = "0xc455bf7f16ebbc2b07cb26d1dd46194977974e7d";

/** The THEHOOD the wallet actually traded. */
const THEHOOD = "0xfd608e846681b1c0dba48d572c4fbb26a2d6a0d4";

/**
 * The token the four unsolicited airdrops came from. It is NOT the token above:
 * it is a different contract that declares the same symbol, and Alchemy's
 * transfer API reports it as "THEHOOD" because symbol comes from the token's own
 * metadata, which an impersonator sets freely.
 *
 * Reasoning about symbols is therefore unsafe. Everything here keys on the
 * contract address.
 */
const FAKE_THEHOOD = "0x2d5ce1a124f8c96eb271a606ff1f6b4da09ecdad";

const recording = JSON.parse(
  readFileSync(new URL("../test/fixtures/mainnet-4663.json", import.meta.url), "utf8"),
) as Recording;
const rpc = fixtureRpcClient(recording);

const report = (start: bigint, end: bigint) =>
  buildSessionReport({ rpc, wallet: WALLET, startBlockL2: start, endBlockL2: end, replayStartBlockL2: start });

describe("the canary window, which mainnet already accepted", () => {
  it("reproduces the settled numbers exactly", async () => {
    const session = await report(22080592n, 22080850n);

    // These are the values inside settle tx 0xd342d117…cad186, which the
    // SettlementExecutor validated and accepted onchain. The chain is the oracle.
    expect(session.cashStart).toBe(31229961908171659n);
    expect(session.cashEnd).toBe(33246816355665397n);
    expect(session.externalDeposits).toBe(0n);
    expect(session.externalWithdrawals).toBe(0n);
    expect(session.realizedProfit).toBe(2016854447493738n);
    expect(session.verdict).toBe("ATTESTABLE");
  });

  it("explains the balance change to the wei", async () => {
    const session = await report(22080592n, 22080850n);
    expect(session.reconciliation.residualWei).toBe(0n);
    expect(session.reconciliation.reconciled).toBe(true);
  });

  it("finds the gas-only approve that emits no Transfer", async () => {
    const session = await report(22080592n, 22080850n);
    // Invisible to getAssetTransfers and to logs; only the block scan sees it.
    // Miss it and the residual is wrong by exactly its gas.
    const approve = session.transactions.find((tx) => tx.kind === "APPROVE_OR_NOOP");
    expect(approve).toBeDefined();
    expect(approve!.gasPaid).toBeGreaterThan(0n);
    expect(approve!.cashIn).toBe(0n);
    expect(approve!.cashOut).toBe(0n);
  });

  it("agrees with the scan's own completeness oracle", async () => {
    const session = await report(22080592n, 22080850n);
    // The wallet's nonce delta is an independent fact none of the four data
    // sources can influence.
    expect(session.transactions.filter((tx) => tx.selfSent)).toHaveLength(3);
  });

  it("maps the window onto the coarser L1 numbering the contract validates", async () => {
    const session = await report(22080592n, 22080850n);
    expect(session.startBlockL1).toBe(25635381n);
    expect(session.endBlockL1).toBe(25635384n);
    // 258 L2 blocks collapse into 4 L1 blocks. This is why the attested range
    // alone cannot identify a session.
    expect(session.endBlockL2 - session.startBlockL2).toBe(258n);
    expect(session.endBlockL1 - session.startBlockL1).toBe(3n);
  });
});

describe("unsolicited inbound tokens", () => {
  it("does not let a stranger veto the window", async () => {
    const session = await report(21799700n, 21799720n);

    // A token that only ever arrived, and was never sold, moved no cash: nothing
    // was paid for it and nothing received. It cannot change realizedProfit, so
    // refusing over it would hand anyone a free, permanent veto over any
    // settlement for the price of one wei of junk.
    const airdrop = session.transactions.find((tx) => tx.kind === "AIRDROP_IN");
    expect(airdrop).toBeDefined();
    expect(airdrop!.selfSent).toBe(false);
    expect(airdrop!.cashOut).toBe(0n);
    expect(airdrop!.cashIn).toBe(0n);

    expect(session.verdict).toBe("ATTESTABLE");
    expect(session.reasons).not.toContain("NOT_DELTA_FLAT");
  });

  it("excludes it from the position test but still records the movement", async () => {
    const session = await report(21799700n, 21799720n);
    // Excluded from positionDeltas, so it cannot trip delta-flat...
    expect(session.positionDeltas.map((p) => p.token)).not.toContain(FAKE_THEHOOD);
    // ...but the transaction and its token delta are still there to audit.
    const delta = session.transactions.flatMap((tx) => tx.tokenDeltas).find((d) => d.token === FAKE_THEHOOD);
    expect(delta!.delta).toBe(40n * 10n ** 18n);
  });

  it("keys on contract address, not on the symbol a token claims", async () => {
    const session = await report(21799700n, 21799720n);
    // The airdrop declares the same symbol as the token this wallet actually
    // traded. Matching on symbol would merge them, and a later sale of the real
    // THEHOOD would draw down a phantom zero-basis inventory.
    expect(FAKE_THEHOOD).not.toBe(THEHOOD);
    expect(session.transactions.flatMap((tx) => tx.tokenDeltas).map((d) => d.token)).toEqual([FAKE_THEHOOD]);
  });

  it("still refuses if the free tokens are sold", async () => {
    // The exemption is for inbound-only. Selling them is the actual hazard: it
    // is cash in with no cost basis, i.e. profit from nothing.
    const session = await report(21799700n, 21799720n);
    expect(session.zeroBasisRealized).toBe(0n);
    // Sanity: the guard exists and is wired to a refusal reason.
    expect(session.reasons).not.toContain("ZERO_BASIS_REALIZED");
  });
});

describe("flows that are not trading results", () => {
  it("treats the settlement outflow as a withdrawal, not a loss", async () => {
    const session = await report(22086130n, 22086150n);

    const settlement = session.transactions.find((tx) => tx.kind === "SETTLEMENT");
    expect(settlement).toBeDefined();
    expect(session.externalWithdrawals).toBe(403370889498747n);

    // The whole point: a naive cash delta would book the contribution as a loss.
    // Declaring it as an external withdrawal adds it back, leaving only gas.
    expect(session.naiveDelta).toBeLessThan(0n);
    expect(session.realizedProfit).toBe(session.naiveDelta + 403370889498747n);
    expect(session.realizedProfit).toBe(-session.gasPaid);
  });

  it("treats funding the vault admin as an external withdrawal", async () => {
    const session = await report(21844340n, 21844345n);
    expect(session.externalWithdrawals).toBe(400000000000000n);
    expect(session.realizedProfit).toBe(-session.gasPaid);
  });

  it("treats inbound cash as a deposit, contributing no profit", async () => {
    const session = await report(22078500n, 22078510n);
    expect(session.externalDeposits).toBe(27000000000000000n);
    // The wallet did not send this transaction, so it paid no gas either.
    expect(session.gasPaid).toBe(0n);
    expect(session.realizedProfit).toBe(0n);
  });

  it("nets a WETH unwrap to zero within cash", async () => {
    const session = await report(21774620n, 21774630n);
    // Cash is native + WETH aggregated, so both legs cancel. Counting only the
    // WETH leg would fabricate a 0.0025 ETH loss.
    expect(session.positionDeltas).toHaveLength(0);
    expect(session.realizedProfit).toBe(-session.gasPaid);
    expect(session.reconciliation.reconciled).toBe(true);
  });
});

describe("losing sessions", () => {
  it("attests a real round trip that lost money", async () => {
    const session = await report(21787560n, 21787640n);

    expect(session.verdict).toBe("ATTESTABLE");
    // Correct behaviour, not a failure: the executor contributes 0 for
    // non-positive profit and settle() reverts ContributionBelowMinimum.
    expect(session.realizedProfit).toBeLessThan(0n);
    expect(session.reconciliation.reconciled).toBe(true);
  });
});

describe("the profit formula mirrors the contract", () => {
  it("adds back withdrawals and removes deposits", () => {
    expect(calculateRealizedProfit(100n, 150n, 0n, 0n)).toBe(50n);
    expect(calculateRealizedProfit(100n, 150n, 60n, 0n)).toBe(-10n);
    expect(calculateRealizedProfit(100n, 90n, 0n, 30n)).toBe(20n);
  });
});
