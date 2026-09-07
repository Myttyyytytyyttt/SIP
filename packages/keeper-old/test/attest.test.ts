// Attestation building, and the refusal stance.
//
// The single most important assertion in this file is that a REFUSED report
// never reaches the signer. It is asserted on the SIGNER, not on the return
// value, because "we returned REFUSED" and "we did not sign" are different
// claims and only the second one is the safety property.

import { describe, expect, it } from "vitest";
import { buildAttestation, fabricatableInputs } from "../src/attest.js";
import {
  ACCOUNT,
  CHAIN_ID,
  EXECUTOR,
  LIMITS,
  TEST_ATTESTER,
  VAULT,
  attestableReport,
  countingAttesterSigner,
  refusedReport,
  stubChain,
  vaultSnapshot,
} from "./helpers.js";

const baseInput = (over: Partial<Parameters<typeof buildAttestation>[0]> = {}) => ({
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
  nowSeconds: 1_800_000_000,
  ...over,
});

describe("the refusal stance", () => {
  it("never signs a REFUSED report, for any refusal reason", async () => {
    for (const reasons of [
      ["NOT_RECONCILED"],
      ["NOT_DELTA_FLAT"],
      ["ZERO_BASIS_REALIZED"],
      ["INCOMPLETE_SCAN"],
      ["UNKNOWN_TRANSACTION"],
      ["REPLAY_TOO_SHORT"],
      ["NOT_RECONCILED", "UNKNOWN_TRANSACTION"],
    ] as const) {
      const signer = countingAttesterSigner();
      const chain = stubChain();
      const outcome = await buildAttestation(baseInput({ signer, chain, report: refusedReport(reasons) }));

      expect(outcome.kind).toBe("REFUSED");
      if (outcome.kind === "REFUSED") expect(outcome.reasons).toEqual(reasons);
      // The property that matters.
      expect(signer.signCount()).toBe(0);
      // And it stopped before spending anything at all on the chain: no
      // deriveSessionId, no previewContribution, no hashAttestation.
      expect(chain.calls).toEqual([]);
    }
  });

  it("has no override: a refused report with enormous profit is still refused", async () => {
    const signer = countingAttesterSigner();
    const outcome = await buildAttestation(
      baseInput({
        signer,
        report: refusedReport(["NOT_DELTA_FLAT"]),
      }),
    );
    expect(outcome.kind).toBe("REFUSED");
    expect(signer.signCount()).toBe(0);
  });
});

describe("preflight", () => {
  it("defers when the account is bound to a different vault (or to none at all)", async () => {
    // This is the vault-admin mix-up in concrete form: activeVaultOf returns the
    // zero address for an address that has no trading binding, and such an
    // address can never be msg.sender for settle.
    const signer = countingAttesterSigner();
    const outcome = await buildAttestation(
      baseInput({
        signer,
        snapshot: vaultSnapshot({ activeVault: "0x0000000000000000000000000000000000000000" }),
      }),
    );
    expect(outcome.kind).toBe("DEFER");
    if (outcome.kind === "DEFER") expect(outcome.reason).toBe("VAULT_MISMATCH");
    expect(signer.signCount()).toBe(0);
  });

  it("defers on a paused protocol, a paused vault and a non-ACTIVE account", async () => {
    const cases: [Parameters<typeof vaultSnapshot>[0], string][] = [
      [{ protocolPaused: true }, "PROTOCOL_PAUSED"],
      [{ settlementPaused: true }, "VAULT_PAUSED"],
      [{ status: 3 }, "ACCOUNT_NOT_ACTIVE"],
      [{ status: 4 }, "ACCOUNT_NOT_ACTIVE"],
    ];
    for (const [over, expected] of cases) {
      const signer = countingAttesterSigner();
      const outcome = await buildAttestation(baseInput({ signer, snapshot: vaultSnapshot(over) }));
      expect(outcome.kind).toBe("DEFER");
      if (outcome.kind === "DEFER") expect(outcome.reason).toBe(expected);
      expect(signer.signCount()).toBe(0);
    }
  });

  it("defers when the loaded key is not the registered attester", async () => {
    const signer = countingAttesterSigner();
    const outcome = await buildAttestation(
      baseInput({
        signer,
        snapshot: vaultSnapshot({ registeredAttester: "0x0000000000000000000000000000000000000123" }),
      }),
    );
    expect(outcome.kind).toBe("DEFER");
    if (outcome.kind === "DEFER") expect(outcome.reason).toBe("ATTESTER_MISMATCH");
    expect(signer.signCount()).toBe(0);
  });

  it("defers until the L1 head has advanced past endBlock", async () => {
    // The contract needs endBlock < block.number in L1 space. L1 advances every
    // ~12s while L2 advances ~7 blocks/s, so a just-closed session is briefly
    // unsettleable and waiting is correct rather than an error.
    const report = attestableReport({ endBlockL1: 25_643_013n });
    const outcome = await buildAttestation(baseInput({ report, currentL1Block: 25_643_013n }));
    expect(outcome.kind).toBe("DEFER");
    if (outcome.kind === "DEFER") expect(outcome.reason).toBe("L1_NOT_ADVANCED");
  });

  it("terminally skips a window that predates the current activationBlock", async () => {
    const outcome = await buildAttestation(
      baseInput({ snapshot: vaultSnapshot({ activationBlockL1: 25_641_000n }) }),
    );
    expect(outcome.kind).toBe("SKIP");
    if (outcome.kind === "SKIP") expect(outcome.reason).toBe("BINDING_EPOCH_ADVANCED");
  });

  it("defers when the balance cannot cover contribution plus reserves plus gas", async () => {
    const outcome = await buildAttestation(
      baseInput({ snapshot: vaultSnapshot({ accountBalanceWei: 500_000_000_000_000n }) }),
    );
    expect(outcome.kind).toBe("DEFER");
    if (outcome.kind === "DEFER") expect(outcome.reason).toBe("INSUFFICIENT_BALANCE");
  });
});

describe("contribution handling", () => {
  it("treats non-positive profit as a normal terminal skip, not an error", async () => {
    const outcome = await buildAttestation(
      baseInput({
        report: attestableReport({ realizedProfit: -14_480_924_700n, cashEnd: 29_999_985_519_075_300n }),
        chain: stubChain({ previewContribution: 0n }),
      }),
    );
    expect(outcome.kind).toBe("SKIP");
    if (outcome.kind === "SKIP") expect(outcome.reason).toBe("NON_POSITIVE_PROFIT");
  });

  it("skips when the executor's own preview is below minContributionWei", async () => {
    const outcome = await buildAttestation(baseInput({ chain: stubChain({ previewContribution: 999n }) }));
    expect(outcome.kind).toBe("SKIP");
    if (outcome.kind === "SKIP") expect(outcome.reason).toBe("BELOW_MINIMUM");
  });

  it("refuses a contribution the policy cannot justify, without signing", async () => {
    // The fixture's profit x 2000bps is 403_370_889_498_747, so a preview of
    // 900_000_000_000_000 is more than this policy could ever produce.
    const signer = countingAttesterSigner();
    const outcome = await buildAttestation(
      baseInput({ signer, chain: stubChain({ previewContribution: 900_000_000_000_000n }) }),
    );
    expect(outcome.kind).toBe("DEFER");
    if (outcome.kind === "DEFER") expect(outcome.reason).toBe("CONTRIBUTION_ABOVE_POLICY");
    // The safety property is on the SIGNER, not the return value.
    expect(signer.signCount()).toBe(0);
  });

  /**
   * THE PRODUCTION CASE THAT MOTIVATED THE CHANGE, in its own numbers.
   *
   * Account 0x94DdDAc0 earned about 0.0963 ETH and its 20% share came to
   * 0.019255 ETH — nineteen times the old NUVEM_KEEPER_MAX_CONTRIBUTION_WEI
   * default of 0.001 ETH. It halted, latched DEGRADED in Postgres, and stayed
   * there. Nothing about it was wrong: the dashboard's invite writes both policy
   * caps as UINT128_MAX, so the contract was perfectly willing.
   */
  it("settles a profit far above the ceiling that used to halt it", async () => {
    const signer = countingAttesterSigner();
    const outcome = await buildAttestation(
      baseInput({
        signer,
        report: attestableReport({ realizedProfit: 96_275_000_000_000_000n }),
        snapshot: vaultSnapshot({
          policy: {
            savingsBps: 2000,
            minContributionWei: 1_000_000_000_000n,
            maxPerSettlementWei: 2n ** 128n - 1n,
            maxRolling30dWei: 2n ** 128n - 1n,
            tradingFloorWei: 1_000_000_000_000_000n,
            gasReserveWei: 500_000_000_000_000n,
          },
          accountBalanceWei: 49_627_911_562_775_232n,
        }),
        chain: stubChain({ previewContribution: 19_255_000_000_000_000n }),
      }),
    );
    expect(outcome.kind).toBe("READY");
    expect(signer.signCount()).toBe(1);
  });

  it("is indifferent to how large the profit gets, so long as the share matches", async () => {
    // A thousand times the profit, the same 20%. The bound scales with it.
    const outcome = await buildAttestation(
      baseInput({
        report: attestableReport({ realizedProfit: 96_275_000_000_000_000_000n }),
        snapshot: vaultSnapshot({
          policy: {
            savingsBps: 2000,
            minContributionWei: 1_000_000_000_000n,
            maxPerSettlementWei: 2n ** 128n - 1n,
            maxRolling30dWei: 2n ** 128n - 1n,
            tradingFloorWei: 1_000_000_000_000_000n,
            gasReserveWei: 500_000_000_000_000n,
          },
          accountBalanceWei: 40_000_000_000_000_000_000n,
        }),
        chain: stubChain({ previewContribution: 19_255_000_000_000_000_000n }),
      }),
    );
    expect(outcome.kind).toBe("READY");
  });

  it("still refuses when a policy cap, not the profit, is the binding limit", async () => {
    // Profit alone would allow 403_370_889_498_747, but maxPerSettlementWei is
    // lower, and the executor mins against it — so a preview above it is
    // impossible too.
    const signer = countingAttesterSigner();
    const outcome = await buildAttestation(
      baseInput({
        signer,
        snapshot: vaultSnapshot({
          policy: {
            savingsBps: 2000,
            minContributionWei: 1_000_000_000_000n,
            maxPerSettlementWei: 200_000_000_000_000n,
            maxRolling30dWei: 10_000_000_000_000_000n,
            tradingFloorWei: 100_000_000_000_000n,
            gasReserveWei: 100_000_000_000_000n,
          },
        }),
        chain: stubChain({ previewContribution: 300_000_000_000_000n }),
      }),
    );
    expect(outcome.kind).toBe("DEFER");
    if (outcome.kind === "DEFER") expect(outcome.reason).toBe("CONTRIBUTION_ABOVE_POLICY");
    expect(signer.signCount()).toBe(0);
  });

  it("uses the executor's preview verbatim rather than recomputing the clamps", async () => {
    const chain = stubChain({ previewContribution: 123_456_789_000_000n });
    const outcome = await buildAttestation(baseInput({ chain }));
    expect(outcome.kind).toBe("READY");
    if (outcome.kind === "READY") {
      expect(outcome.contribution).toBe(123_456_789_000_000n);
      expect(outcome.attestation.contribution).toBe(123_456_789_000_000n);
    }
    expect(chain.calls).toContain("previewContribution");
  });
});

describe("the happy path", () => {
  it("produces a signature whose digest matches the contract's own", async () => {
    const signer = countingAttesterSigner();
    const outcome = await buildAttestation(baseInput({ signer }));
    expect(outcome.kind).toBe("READY");
    if (outcome.kind !== "READY") return;

    expect(signer.signCount()).toBe(1);
    expect(outcome.signature).toMatch(/^0x[0-9a-f]{130}$/);
    expect(outcome.digest).toMatch(/^0x[0-9a-f]{64}$/);

    // Every epoch and nonce the contract checks is bound.
    const snapshot = vaultSnapshot();
    expect(outcome.attestation.bindingEpoch).toBe(snapshot.bindingEpoch);
    expect(outcome.attestation.policyNonce).toBe(snapshot.policyNonce);
    expect(outcome.attestation.adminEpoch).toBe(snapshot.adminEpoch);
    expect(outcome.attestation.localPauseEpoch).toBe(snapshot.localPauseEpoch);
    expect(outcome.attestation.globalPauseEpoch).toBe(snapshot.globalPauseEpoch);
    expect(outcome.attestation.settlementNonce).toBe(snapshot.settlementNonce);
    expect(outcome.attestation.policyHash).toBe(snapshot.policyHash);
    expect(outcome.attestation.attesterEpoch).toBe(snapshot.attesterEpoch);

    // BOTH RANGES ARE ATTESTED, and they are not interchangeable. The L1 pair is
    // what the contract compares against block.number; the L2 pair is what the
    // vault progresses on. The two are millions apart on this chain and the gap
    // is not constant, so a crossed assignment is not a subtle mistake — it would
    // make every settlement revert. Asserted against the engine's own numbers, in
    // both directions, because the fields sit adjacent in the struct.
    const report = attestableReport();
    expect(outcome.attestation.startBlock).toBe(report.startBlockL1);
    expect(outcome.attestation.endBlock).toBe(report.endBlockL1);
    expect(outcome.attestation.startBlockL2).toBe(report.startBlockL2);
    expect(outcome.attestation.endBlockL2).toBe(report.endBlockL2);
    expect(outcome.attestation.startBlock).not.toBe(outcome.attestation.startBlockL2);
    expect(outcome.attestation.ledgerRoot).toBe(report.ledgerRootV2);

    // The four fabricatable inputs are carried verbatim from the engine.
    expect(outcome.attestation.cashStart).toBe(report.cashStart);
    expect(outcome.attestation.cashEnd).toBe(report.cashEnd);
    expect(outcome.attestation.externalDeposits).toBe(report.externalDeposits);
    expect(outcome.attestation.externalWithdrawals).toBe(report.externalWithdrawals);
    expect(outcome.attestation.realizedProfit).toBe(report.realizedProfit);

    // The validity window stays inside the contract's ceiling.
    expect(outcome.attestation.deadline - outcome.attestation.validAfter).toBe(660);
  });

  it("recovers the attester address from its own signature", async () => {
    const outcome = await buildAttestation(baseInput());
    expect(outcome.kind).toBe("READY");
    if (outcome.kind !== "READY") return;
    const { verifyTypedData } = await import("viem");
    const { ATTESTATION_TYPES, DOMAIN_NAME, DOMAIN_VERSION } = await import("../src/onchain.js");
    const valid = await verifyTypedData({
      address: TEST_ATTESTER.address,
      domain: { name: DOMAIN_NAME, version: DOMAIN_VERSION, chainId: CHAIN_ID, verifyingContract: EXECUTOR },
      types: ATTESTATION_TYPES,
      primaryType: "SettlementAttestation",
      message: outcome.attestation,
      signature: outcome.signature,
    });
    expect(valid).toBe(true);
  });

  it("halts when the local digest disagrees with hashAttestation, before signing", async () => {
    const signer = countingAttesterSigner();
    const outcome = await buildAttestation(
      baseInput({
        signer,
        chain: stubChain({
          forcedDigest: "0x9999999999999999999999999999999999999999999999999999999999999999",
        }),
      }),
    );
    expect(outcome.kind).toBe("HALT");
    if (outcome.kind === "HALT") expect(outcome.reason).toBe("DIGEST_MISMATCH");
    // The cross-check runs BEFORE the signature, so a drifted type list costs
    // nothing rather than costing an InvalidAttesterSignature revert.
    expect(signer.signCount()).toBe(0);
  });
});

describe("the EIP-712 type list against the compiled contract", () => {
  it("matches SettlementAttestation field for field, in order", async () => {
    // ATTESTATION_TYPES is a HAND-WRITTEN transcription of a struct, and EIP-712
    // hashes the type string, so a missing, renamed or reordered field produces a
    // digest the contract does not agree with — reported as
    // InvalidAttesterSignature, which reads like a key problem rather than a
    // schema problem. attest.ts catches it by cross-checking against
    // hashAttestation(), but only on a live chain and only once a real session is
    // ready to settle, which is the worst moment to find out. onchain.ts checks it
    // at import; this asserts the check is actually comparing the right things.
    const { abis } = await import("@nuvem/contracts-artifacts");
    const { ATTESTATION_TYPES } = await import("../src/onchain.js");
    const settle = (abis.SettlementExecutor as readonly { type: string; name?: string; inputs?: readonly unknown[] }[])
      .find((entry) => entry.type === "function" && entry.name === "settle");
    const components = (settle?.inputs?.[0] as { components: { name: string; type: string }[] }).components;

    expect(components.map((c) => `${c.name}:${c.type}`)).toEqual(
      ATTESTATION_TYPES.SettlementAttestation.map((f) => `${f.name}:${f.type}`),
    );
    // Named explicitly, so a future struct reshape that drops them fails here
    // with a sentence rather than as an opaque list diff.
    expect(components.map((c) => c.name)).toEqual(
      expect.arrayContaining(["startBlock", "endBlock", "startBlockL2", "endBlockL2"]),
    );
  });
});

describe("fabricatableInputs", () => {
  it("exposes exactly the four numbers the contract cannot check against history", () => {
    expect(Object.keys(fabricatableInputs(attestableReport())).sort()).toEqual([
      "cashEnd",
      "cashStart",
      "externalDeposits",
      "externalWithdrawals",
    ]);
  });
});
