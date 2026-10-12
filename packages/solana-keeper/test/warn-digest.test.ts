// warn-digest (src/warn-digest.ts): one message a day at 08:00 UTC, of the
// warnings that never left the box, by kind — and one even when there were none.
// Delivered here by the real createAlerter, at the two thresholds bin/keeper.mts
// uses: the production one (critical), which never sends a warn, and the
// digest's own sender (warn), which does.

import { Secret } from "@sip/solana-log";
import { describe, expect, it } from "vitest";
import { createAlerter, type Alert } from "../src/alerts.js";
import { settleAlert } from "../src/settle-decision.js";
import { DIGEST_ALERT_KEY, DIGEST_HOUR_UTC, DIGEST_MAX_KINDS, WarnDigest, nextDigestAt } from "../src/warn-digest.js";

const at = (iso: string): number => Date.parse(iso);

function sender(minSeverity: "warn" | "critical") {
  const sent: { readonly text: string; readonly key: string }[] = [];
  const alerter = createAlerter({
    webhookUrl: new Secret("https://hooks.example.test/digest", "SIP_SOLANA_ALERT_WEBHOOK"),
    minSeverity,
    log: () => {},
    post: async (_url, body) => {
      const parsed = JSON.parse(body) as { text: string; key: string };
      sent.push({ text: parsed.text, key: parsed.key });
    },
  });
  return { alerter, sent };
}

describe("nextDigestAt", () => {
  it(`is the next ${DIGEST_HOUR_UTC}:00 UTC strictly after now`, () => {
    expect(nextDigestAt(at("2026-10-12T07:59:00Z"))).toBe(at("2026-10-12T08:00:00Z"));
    expect(nextDigestAt(at("2026-10-12T08:00:00Z"))).toBe(at("2026-10-13T08:00:00Z"));
    expect(nextDigestAt(at("2026-10-12T19:30:00Z"))).toBe(at("2026-10-13T08:00:00Z"));
    expect(nextDigestAt(at("2026-12-31T23:59:00Z"))).toBe(at("2027-01-01T08:00:00Z"));
  });
});

describe("WarnDigest: the tap", () => {
  it("passes every fire, clear and delivery through to the alerter unchanged", () => {
    const fired: Alert[] = [];
    const cleared: string[] = [];
    const inner = { fire: (a: Alert) => void fired.push(a), clear: (k: string) => void cleared.push(k), delivery: () => ({ sent: 7, failed: 0, consecutiveFailures: 0, lastError: null, lastSentAt: null }) };
    const tapped = new WarnDigest(at("2026-10-12T19:00:00Z")).tap(inner, () => at("2026-10-12T19:00:00Z"));
    const alert = settleAlert("NO_SIGNER", { wallet: "W1", vault: "V1" }, "x").fire!;
    tapped.fire(alert);
    tapped.clear("no-signer:W1");
    expect(fired).toEqual([alert]);
    expect(fired[0]).toBe(alert);
    expect(cleared).toEqual(["no-signer:W1"]);
    expect(tapped.delivery().sent).toBe(7);
  });

  it("counts what is fired through it, which is what the day's message lists", () => {
    const inner = { fire: () => {}, clear: () => {}, delivery: () => ({ sent: 0, failed: 0, consecutiveFailures: 0, lastError: null, lastSentAt: null }) };
    const digest = new WarnDigest(at("2026-10-12T19:00:00Z"));
    const tapped = digest.tap(inner, () => at("2026-10-12T19:30:00Z"));
    tapped.fire(settleAlert("NO_SIGNER", { wallet: "W1", vault: "V1" }, "x").fire!);
    tapped.fire(settleAlert("NO_SIGNER", { wallet: "W1", vault: "V1" }, "x").fire!);
    expect(digest.status()).toMatchObject({ kinds: 1, raised: 2 });
    expect(digest.take(at("2026-10-13T08:00:00Z")).detail).toContain("no-signer: 1 key, raised 2 times, last 19:30Z");
  });
});

describe("WarnDigest: the message", () => {
  it("lists each kind of warning by its family, never by wallet, with what also paged marked", () => {
    const boot = at("2026-10-12T19:00:00Z");
    const digest = new WarnDigest(boot);
    for (let sweep = 0; sweep < 30; sweep += 1) {
      for (const wallet of ["W1", "W2"]) digest.note(settleAlert("NO_SIGNER", { wallet, vault: "V" }, "x").fire!, boot + sweep * 60_000);
    }
    digest.note({ key: "invest-failed:V9", severity: "warn", title: "t", detail: "d" }, at("2026-10-13T03:10:00Z"));
    digest.note({ key: "invest-failed:V9", severity: "critical", title: "t", detail: "d" }, at("2026-10-13T03:12:00Z"));
    expect(digest.due(at("2026-10-13T07:59:59Z"))).toBe(false);
    expect(digest.due(at("2026-10-13T08:00:00Z"))).toBe(true);
    const message = digest.take(at("2026-10-13T08:00:00Z"));
    expect(message).toMatchObject({ key: DIGEST_ALERT_KEY, severity: "warn", context: { kinds: 2, raised: 61, windowHours: 13 } });
    expect(message.detail).toContain("2 kinds of warning, raised 61 times over the last 13 h (since 2026-10-12T19:00Z, when this process started)");
    expect(message.detail).toContain("no-signer: 2 keys, raised 60 times, last 19:29Z");
    expect(message.detail).toContain("invest-failed: 1 key, raised 1 time, last 03:10Z (also paged)");
    expect(message.detail).not.toContain("W1");
    // A NEW WINDOW, FROM THE DIGEST.
    expect(digest.status()).toMatchObject({ kinds: 0, raised: 0, lastSentAt: "2026-10-13T08:00:00.000Z", nextAt: "2026-10-14T08:00:00.000Z" });
    expect(digest.take(at("2026-10-14T08:00:00Z")).detail).toContain("over the last 24 h (since 2026-10-13T08:00Z)");
  });

  it("is sent on a quiet day too, as the day's proof that alerts arrive", () => {
    const digest = new WarnDigest(at("2026-10-12T19:00:00Z"));
    digest.note({ key: "sweep-failed", severity: "critical", title: "t", detail: "d" }, at("2026-10-12T20:00:00Z"));
    expect(digest.take(at("2026-10-13T08:00:00Z")).detail).toMatch(/^No warning was raised over the last 13 h .*daily proof that alerts reach you\.$/);
  });

  it(`lists at most ${DIGEST_MAX_KINDS} kinds and counts the rest`, () => {
    const digest = new WarnDigest(at("2026-10-12T19:00:00Z"));
    for (let i = 0; i < DIGEST_MAX_KINDS + 4; i += 1) digest.note({ key: `kind${i}:x`, severity: "warn", title: "t", detail: "d" }, at("2026-10-12T20:00:00Z"));
    const detail = digest.take(at("2026-10-13T08:00:00Z")).detail;
    expect(detail.split("\n").filter((line) => /^kind\d+: /.test(line))).toHaveLength(DIGEST_MAX_KINDS);
    expect(detail).toContain("… and 4 more kinds");
  });
});

describe("WarnDigest: leaving the box", () => {
  it("is a warn, so the production threshold would keep it in — and the digest's own sender sends it", () => {
    const digest = new WarnDigest(at("2026-10-12T19:00:00Z"));
    const production = sender("critical");
    production.alerter.fire(digest.take(at("2026-10-13T08:00:00Z")));
    expect(production.sent).toEqual([]);
    const own = sender("warn");
    own.alerter.fire(digest.take(at("2026-10-14T08:00:00Z")));
    expect(own.sent.map((s) => s.key)).toEqual([DIGEST_ALERT_KEY]);
  });

  it("is never read as yesterday's repeat: cleared before each day's fire, as bin/keeper.mts does", () => {
    const digest = new WarnDigest(at("2026-10-12T19:00:00Z"));
    const own = sender("warn");
    for (const day of ["2026-10-13T08:00:00Z", "2026-10-14T08:00:00Z"]) {
      own.alerter.clear(DIGEST_ALERT_KEY);
      own.alerter.fire(digest.take(at(day)));
    }
    expect(own.sent).toHaveLength(2);
    expect(own.sent[1]!.text).not.toContain("(x2)");
  });
});
