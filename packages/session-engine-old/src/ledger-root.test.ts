import { describe, expect, it } from "vitest";
import {
  LEDGER_SCHEMA_V2,
  ledgerRootV2,
  legacyLedgerRoot,
  positionsRoot,
  verdictBits,
  type LedgerV2Input,
} from "./ledger-root.js";

/**
 * The exact values inside settle tx
 * 0xd342d117634464f9c6c5b9b463dd8c0be1e638fdf623ea78334a097ad1cad186,
 * which the SettlementExecutor validated and accepted on chain 4663.
 */
const ACCEPTED = {
  startBlockL2: 22080592n,
  endBlockL2: 22080850n,
  cashStart: 31229961908171659n,
  cashEnd: 33246816355665397n,
  ledgerRoot: "0xbc9407f1a72d27440e211568ad4842bd2fe0cbb2eeb686b88edfd4062cc674e5",
  sessionId: "0x0d176cd39f2e1e5d415ab74379bef9d4c8027073f41995e1b7cc5bbb089c2168",
} as const;

const WAN = "0xc9aa29987bb4a3a9c1e0e1d1b64f8b0e4e1a5c3d";
const FAKE_THEHOOD = "0x2d5ce1a124f8c96eb271a606ff1f6b4da09ecdad";

const baseInput: LedgerV2Input = {
  startBlockL2: ACCEPTED.startBlockL2,
  endBlockL2: ACCEPTED.endBlockL2,
  cashStart: ACCEPTED.cashStart,
  cashEnd: ACCEPTED.cashEnd,
  externalDeposits: 0n,
  externalWithdrawals: 0n,
  positions: [{ token: WAN, balanceStart: 0n, balanceEnd: 0n }],
  zeroBasisRealized: 0n,
  reasons: [],
  replayStartBlockL2: ACCEPTED.startBlockL2,
};

describe("legacy encoding", () => {
  it("reproduces the root mainnet already accepted", () => {
    // Not a self-consistency check: this is the value the contract took, folded
    // into a sessionId that is now permanently recorded in usedSessions.
    expect(
      legacyLedgerRoot(ACCEPTED.startBlockL2, ACCEPTED.endBlockL2, ACCEPTED.cashStart, ACCEPTED.cashEnd),
    ).toBe(ACCEPTED.ledgerRoot);
  });

  it("uses L2 heights, not the L1 heights the attestation carries", () => {
    // The attestation's startBlock/endBlock were 25635381/25635384. Feeding
    // those here produces a different root, which is exactly why the L2 pair has
    // to live in the preimage: it is what keeps sessionId unique when the coarse
    // L1 range collapses two sessions onto the same numbers.
    expect(legacyLedgerRoot(25635381n, 25635384n, ACCEPTED.cashStart, ACCEPTED.cashEnd)).not.toBe(
      ACCEPTED.ledgerRoot,
    );
  });
});

describe("positionsRoot", () => {
  it("does not depend on discovery order", () => {
    const a = [
      { token: WAN, balanceStart: 1n, balanceEnd: 1n },
      { token: FAKE_THEHOOD, balanceStart: 160n, balanceEnd: 160n },
    ];
    // Two runs may find the same movements in a different sequence. If the root
    // disagreed, it would not be a fact about the session.
    expect(positionsRoot(a)).toBe(positionsRoot([...a].reverse()));
  });

  it("distinguishes a changed position from a constant one", () => {
    const flat = positionsRoot([{ token: FAKE_THEHOOD, balanceStart: 160n, balanceEnd: 160n }]);
    const moved = positionsRoot([{ token: FAKE_THEHOOD, balanceStart: 120n, balanceEnd: 160n }]);
    expect(flat).not.toBe(moved);
  });

  it("distinguishes tokens that declare the same symbol", () => {
    // The airdrop token and the traded token both call themselves THEHOOD.
    expect(positionsRoot([{ token: WAN, balanceStart: 0n, balanceEnd: 0n }])).not.toBe(
      positionsRoot([{ token: FAKE_THEHOOD, balanceStart: 0n, balanceEnd: 0n }]),
    );
  });

  it("has a stable empty value", () => {
    expect(positionsRoot([])).toBe(positionsRoot([]));
  });
});

describe("verdict bits", () => {
  it("is zero when attestable", () => {
    expect(verdictBits([])).toBe(0n);
  });

  it("commits which reasons fired, not merely that some did", () => {
    expect(verdictBits(["NOT_DELTA_FLAT"])).not.toBe(verdictBits(["ZERO_BASIS_REALIZED"]));
    expect(verdictBits(["NOT_DELTA_FLAT", "ZERO_BASIS_REALIZED"])).toBe(
      verdictBits(["NOT_DELTA_FLAT"]) | verdictBits(["ZERO_BASIS_REALIZED"]),
    );
  });

  it("does not depend on the order reasons were appended", () => {
    expect(verdictBits(["NOT_RECONCILED", "REPLAY_TOO_SHORT"])).toBe(
      verdictBits(["REPLAY_TOO_SHORT", "NOT_RECONCILED"]),
    );
  });
});

describe("v2 encoding", () => {
  it("is domain-separated from v1", () => {
    // A v2 root must never be mistakable for a legacy one over the same window.
    expect(ledgerRootV2(baseInput)).not.toBe(
      legacyLedgerRoot(ACCEPTED.startBlockL2, ACCEPTED.endBlockL2, ACCEPTED.cashStart, ACCEPTED.cashEnd),
    );
    expect(LEDGER_SCHEMA_V2).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("is deterministic", () => {
    expect(ledgerRootV2(baseInput)).toBe(ledgerRootV2({ ...baseInput }));
  });

  it("changes when any committed field changes", () => {
    const base = ledgerRootV2(baseInput);
    const variants: LedgerV2Input[] = [
      { ...baseInput, cashEnd: baseInput.cashEnd + 1n },
      { ...baseInput, externalDeposits: 1n },
      { ...baseInput, externalWithdrawals: 1n },
      { ...baseInput, zeroBasisRealized: 1n },
      { ...baseInput, replayStartBlockL2: baseInput.replayStartBlockL2 - 1n },
      { ...baseInput, reasons: ["NOT_DELTA_FLAT"] },
      { ...baseInput, positions: [{ token: WAN, balanceStart: 0n, balanceEnd: 1n }] },
    ];
    for (const variant of variants) expect(ledgerRootV2(variant)).not.toBe(base);
  });

  it("separates an attestable session from a refused one over identical numbers", () => {
    // This is the point of committing the verdict: the same cash figures with a
    // different soundness claim must not share a root.
    expect(ledgerRootV2({ ...baseInput, reasons: ["ZERO_BASIS_REALIZED"] })).not.toBe(ledgerRootV2(baseInput));
  });
});
