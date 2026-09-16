// The arming checklist's own rules, with no network, no keys and no keeper.
//
// These used to be literals inline in bin/ready.mts — a threshold, a ternary —
// and a bin script is the one place in this package nothing can test. The
// interesting case is the crank's: the old line sat exactly ON the reserve the
// wrap keeps back, so a balance just above it passed the checklist and wrapped
// zero for ever. That is asserted here against wrapPlan itself, so the
// checklist and the turn that moves the money cannot disagree.

import { describe, expect, it } from "vitest";
import { CRANK_WRAP_RESERVE_LAMPORTS, WRAP_DUST_LAMPORTS, wrapPlan } from "../src/invest-decision.js";
import {
  READY_CRANK_COMFORTABLE_LAMPORTS,
  READY_CRANK_MINIMUM_LAMPORTS,
  alertWebhookVerdict,
  crankHeadroom,
  privyIdCollision,
  privyIdProblem,
} from "../src/ready-checks.js";

/** The public ids the runbooks already print, in the shape Privy issues them. */
const APP_ID = "cmtrt36tb00080dlbrda5aqam";
const SIGNER_ID = "cbx133itb717vxp3dqwhk808";
const POLICY_ID = "jsuzcjv6njl0raqjjhzqe9fh";

/** A 64-number JSON array, the shape of an id.json — the paste with a catastrophic version. */
const KEY_SHAPED = JSON.stringify(Array.from({ length: 64 }, (_, i) => (i * 7) % 251));

describe("a Privy id's shape", () => {
  it("accepts the ids Privy actually issues", () => {
    for (const [name, id] of [
      ["SIP_SOLANA_PRIVY_APP_ID", APP_ID],
      ["SIP_SOLANA_PRIVY_SIGNER_ID", SIGNER_ID],
      ["SIP_SOLANA_PRIVY_POLICY_ID", POLICY_ID],
    ] as const) {
      expect(privyIdProblem(name, id), name).toBeNull();
    }
  });

  it("refuses what an id cannot be, and never prints the value it refused", () => {
    const cases: [string, string][] = [
      ["an empty value", ""],
      ["whitespace only", "   "],
      ["an id with spaces around it", ` ${SIGNER_ID} `],
      ["a URL", "https://api.privy.io/v1/wallets"],
      ["a did", `did:privy:${APP_ID}`],
      ["a quoted value", `"${APP_ID}"`],
      ["far too short", "abc"],
      ["a signing key", KEY_SHAPED],
    ];
    for (const [name, value] of cases) {
      const problem = privyIdProblem("SIP_SOLANA_PRIVY_SIGNER_ID", value);
      expect(problem, name).not.toBeNull();
      expect(problem, name).toContain("SIP_SOLANA_PRIVY_SIGNER_ID");
      // Public ids or not: once this fails, all that is known about the value
      // is that it is not the id it was supposed to be.
      if (value.trim() !== "") expect(problem!, name).not.toContain(value.trim());
    }
  });

  it("calls a pasted signing key what it is, and says to rotate it", () => {
    const problem = privyIdProblem("SIP_SOLANA_PRIVY_APP_ID", KEY_SHAPED)!;
    expect(problem).toContain("rotate");
    expect(problem).not.toContain(KEY_SHAPED.slice(1, 20));
  });
});

describe("two Privy variables holding one id", () => {
  it("names the pair, because no id is both", () => {
    expect(privyIdCollision([
      ["SIP_SOLANA_PRIVY_SIGNER_ID", SIGNER_ID],
      ["SIP_SOLANA_PRIVY_POLICY_ID", SIGNER_ID],
    ])).toBe("SIP_SOLANA_PRIVY_SIGNER_ID and SIP_SOLANA_PRIVY_POLICY_ID hold the same id, and no id is both.");
  });

  it("is silent when they differ, and counts nothing that is unset", () => {
    expect(
      privyIdCollision([
        ["SIP_SOLANA_PRIVY_APP_ID", APP_ID],
        ["SIP_SOLANA_PRIVY_SIGNER_ID", SIGNER_ID],
        ["SIP_SOLANA_PRIVY_POLICY_ID", POLICY_ID],
      ]),
    ).toBeNull();
    expect(
      privyIdCollision([
        ["SIP_SOLANA_PRIVY_SIGNER_ID", undefined],
        ["SIP_SOLANA_PRIVY_POLICY_ID", undefined],
      ]),
    ).toBeNull();
  });
});

describe("the crank's headroom", () => {
  it("draws its line where the wrap does, not where the fees do", () => {
    expect(READY_CRANK_MINIMUM_LAMPORTS).toBe(CRANK_WRAP_RESERVE_LAMPORTS + WRAP_DUST_LAMPORTS);
  });

  it("fails a crank whose every wrap would be zero, the old threshold included", () => {
    // 21_000_000 passed the old check (`< 20_000_000`) and fronts 1_000_000 —
    // under the dust floor, so wrapPlan wraps nothing, for ever.
    for (const lamports of [0n, 19_999_999n, CRANK_WRAP_RESERVE_LAMPORTS, 21_000_000n, READY_CRANK_MINIMUM_LAMPORTS - 1n]) {
      const headroom = crankHeadroom(lamports);
      expect(headroom.verdict, `${lamports}`).toBe("CANNOT_WRAP");
      // The proof that this line is the real one: the turn that moves the money
      // would wrap zero out of a whole SOL of free balance.
      expect(wrapPlan({ free: 1_000_000_000n, crankLamports: lamports }).amount, `${lamports}`).toBe(0n);
    }
  });

  it("passes the first balance that can front a wrap, thinly, and a comfortable one outright", () => {
    const atTheLine = crankHeadroom(READY_CRANK_MINIMUM_LAMPORTS);
    expect(atTheLine.verdict).toBe("THIN");
    expect(atTheLine.allowance).toBe(WRAP_DUST_LAMPORTS);
    expect(wrapPlan({ free: 1_000_000_000n, crankLamports: READY_CRANK_MINIMUM_LAMPORTS }).amount).toBe(WRAP_DUST_LAMPORTS);

    expect(crankHeadroom(READY_CRANK_COMFORTABLE_LAMPORTS - 1n).verdict).toBe("THIN");
    expect(crankHeadroom(READY_CRANK_COMFORTABLE_LAMPORTS).verdict).toBe("OK");
    expect(crankHeadroom(2_000_000_000n)).toMatchObject({
      verdict: "OK",
      allowance: 2_000_000_000n - CRANK_WRAP_RESERVE_LAMPORTS,
    });
  });
});

describe("the alert webhook", () => {
  const WEBHOOK = "https://hooks.slack.example.test/services/T000/B000/TokenNeverPrinted";

  it("is required to arm, because that is the only way an escalation reaches a person", () => {
    expect(alertWebhookVerdict(undefined, true)).toBe("MISSING_ARMED");
    expect(alertWebhookVerdict("", true)).toBe("MISSING_ARMED");
    expect(alertWebhookVerdict("   ", true)).toBe("MISSING_ARMED");
  });

  it("stays optional in a dry run, as the runbook says", () => {
    expect(alertWebhookVerdict(undefined, false)).toBe("MISSING_DRY");
  });

  it("accepts only an http(s) URL — the same rule loadConfig refuses to start on", () => {
    expect(alertWebhookVerdict(WEBHOOK, true)).toBe("OK");
    expect(alertWebhookVerdict(` ${WEBHOOK} `, true)).toBe("OK");
    expect(alertWebhookVerdict("http://localhost:9000/hook", false)).toBe("OK");
    for (const bad of ["ftp://x.example.test/hook", "hooks.slack.example.test/services", "not a url", "javascript:alert(1)"]) {
      expect(alertWebhookVerdict(bad, true), bad).toBe("NOT_HTTP");
    }
  });
});
