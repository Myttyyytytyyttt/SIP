// What the keeper examines before it signs, and the combination that examined
// nothing while looking configured.
//
// THE DEFECT. The start-up notice asked about ONE id: it fired when the policy
// id was missing, and said nothing otherwise. So the mirror combination — a
// policy id set with NO signer id — printed nothing at all, while /status showed
// a populated privyPolicyId, which an operator reads as "an unbounded seat would
// be refused". The opposite was true: with no signer id there is no seat to look
// for, so createPrivySolanaSigner skips the grant check as well and EVERY Solana
// wallet in the app resolves to a signer the keeper will sign for. Both ids are
// optional by design (the live healthcheck must not depend on a variable nobody
// has set yet), so nothing stops a keeper booting in that state.
//
// The rule is a pure function so this test can reach it; the CALL SITE is read
// from bin/keeper.mts the way test/read-model-rate.test.ts reads its own.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SEAT_CHECK_ALERT_KEY, seatCheck, seatCheckNotice } from "../src/seat-check.js";

const PACKAGE = new URL("..", import.meta.url);
const source = (path: string): string => readFileSync(fileURLToPath(new URL(path, PACKAGE)), "utf8");
const keeper = source("bin/keeper.mts");

// Shaped like Privy's, and belonging to nobody: this file never holds a real id.
const SIGNER = "keeperQuorum000000000001";
const POLICY = "keeperPolicy000000000001";

describe("what the keeper examines before it signs", () => {
  it("names it for every pair a deploy can hold", () => {
    expect(seatCheck(SIGNER, POLICY)).toBe("policy-enforced");
    expect(seatCheck(SIGNER, null)).toBe("seat-only");
    // THE DEFECT, in one line: no signer id means no seat is examined, whatever
    // policy id sits beside it in /status.
    expect(seatCheck(null, POLICY)).toBe("unchecked");
    expect(seatCheck(null, null)).toBe("unchecked");
  });

  it("says nothing at start-up when the seat is genuinely held to the keeper's policy", () => {
    expect(seatCheckNotice(SIGNER, POLICY)).toBeNull();
  });

  it("keeps the notice a missing policy id already had, and does not page for it", () => {
    const notice = seatCheckNotice(SIGNER, null);
    expect(notice?.severity).toBe("warn");
    expect(notice?.message).toBe("SIP_SOLANA_PRIVY_POLICY_ID is not set");
    expect(notice?.detail).toContain("The keeper accepts a wallet that seats its signer WITHOUT the keeper's policy");
    expect(notice?.detail).toContain("could sign any message, send any transaction and export that wallet's key");
    // Today's documented behaviour, and visible in /status: a log line, not a page.
    expect(notice?.alert).toBeNull();
  });

  it("pages for a policy id with no signer id, and says the page is not what it looks like", () => {
    const notice = seatCheckNotice(null, POLICY);
    expect(notice?.severity).toBe("critical");
    expect(notice?.message).toBe("SIP_SOLANA_PRIVY_SIGNER_ID is not set");
    expect(notice?.detail).toContain("EVERY Solana wallet in this Privy app resolves to a signer");
    expect(notice?.detail).toContain("neither the grant nor the policy bounding it is examined");
    // The reason it pages rather than only logging: no page an operator opens
    // shows this — /status looks MORE correct in this state, not less.
    expect(notice?.detail).toContain("/status shows a policy id while no seat is being held to it");
    expect(notice?.alert).toMatchObject({ key: SEAT_CHECK_ALERT_KEY, severity: "critical", title: "The keeper signs for every wallet in its Privy app" });
  });

  it("pages for no ids at all too, with the fix that belongs to that case", () => {
    const notice = seatCheckNotice(null, null);
    expect(notice?.severity).toBe("critical");
    expect(notice?.alert?.key).toBe(SEAT_CHECK_ALERT_KEY);
    expect(notice?.detail).toContain("Set it to the key quorum id");
    expect(notice?.detail, "there is no policy id to describe here").not.toContain("/status shows a policy id");
  });

  it("never prints an id, in any combination: names only", () => {
    for (const pair of [
      [SIGNER, POLICY],
      [SIGNER, null],
      [null, POLICY],
      [null, null],
    ] as const) {
      const notice = seatCheckNotice(pair[0], pair[1]);
      const printed = `${notice?.message ?? ""} ${notice?.detail ?? ""} ${notice?.alert?.detail ?? ""} ${notice?.alert?.title ?? ""}`;
      expect(printed).not.toContain(SIGNER);
      expect(printed).not.toContain(POLICY);
    }
  });
});

describe("where the keeper asks the question", () => {
  it("asks it once, about BOTH ids, and no longer about the policy id alone", () => {
    const calls = keeper.split("\n").filter((line) => line.includes("seatCheckNotice("));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("config.privySignerId, config.privyPolicyId");
    expect(keeper, "the one-id condition that missed the widening case").not.toContain("config.privyPolicyId === null");
    // Only a keeper that can sign asks at all: a dry run holds no privyConfig.
    expect(keeper).toMatch(/if \(privyConfig !== null\) \{[\s\S]{0,200}?seatCheckNotice\(/);
  });

  it("fires the page the notice carries, and serves the verdict from /status", () => {
    expect(keeper).toMatch(/if \(notice\.alert !== null\) alerter\.fire\(notice\.alert\);/);
    expect(keeper).toMatch(/seatCheck: seatCheck\(config\.privySignerId, config\.privyPolicyId\),/);
  });
});
