import { describe, expect, it } from "vitest";

import { createAlerter, createHeartbeat, type AlertSeverity } from "../src/alerts.js";

function harness(options: { repeatAfterMs?: number } = {}) {
  const lines: string[] = [];
  const posted: string[] = [];
  let clock = 1_000_000;
  const alerter = createAlerter({
    webhookUrl: "https://hooks.example/none",
    repeatAfterMs: options.repeatAfterMs ?? 60_000,
    now: () => clock,
    log: (_severity: AlertSeverity, line: string) => lines.push(line),
    post: async (_url, body) => {
      posted.push(body);
    },
  });
  return { alerter, lines, posted, advance: (ms: number) => (clock += ms) };
}

const ALERT = {
  key: "parked:0xabc",
  severity: "critical" as const,
  title: "Keeper will not start",
  detail: "three immediate exits",
};

describe("alerting", () => {
  it("reports a condition once rather than on every occurrence", async () => {
    const { alerter, lines } = harness();
    for (let i = 0; i < 5; i += 1) alerter.fire(ALERT);
    // An alert that repeats every minute is an alert that gets muted, and a muted
    // alert is worse than none: it is a channel everyone has learned to ignore.
    expect(lines).toHaveLength(1);
  });

  it("re-fires after the quiet window, and says how long it has been going", async () => {
    const { alerter, lines, advance } = harness({ repeatAfterMs: 60_000 });
    alerter.fire(ALERT);
    for (let i = 0; i < 4; i += 1) alerter.fire(ALERT);
    advance(61_000);
    alerter.fire(ALERT);

    expect(lines).toHaveLength(2);
    // A long outage must not read as one old message.
    expect(lines[1]).toContain("x6");
  });

  it("alerts again once the condition has cleared and returned", () => {
    const { alerter, lines } = harness();
    alerter.fire(ALERT);
    alerter.clear(ALERT.key);
    alerter.fire(ALERT);
    expect(lines).toHaveLength(2);
  });

  it("logs even with no webhook configured", () => {
    const lines: string[] = [];
    const alerter = createAlerter({ log: (_s, line) => lines.push(line) });
    alerter.fire(ALERT);
    expect(lines).toHaveLength(1);
  });

  /**
   * The monitoring must never be able to take down the thing it monitors. A
   * webhook that is down is an inconvenience; a keeper that dies because its
   * webhook is down is an outage caused by the alerting.
   */
  it("survives an alerting endpoint that is itself broken", async () => {
    const lines: string[] = [];
    const alerter = createAlerter({
      webhookUrl: "https://hooks.example/none",
      log: (_s, line) => lines.push(line),
      post: async () => {
        throw new Error("webhook down");
      },
    });
    expect(() => alerter.fire(ALERT)).not.toThrow();
    await new Promise((resolve) => setImmediate(resolve));
    expect(lines[0]).toContain("Keeper will not start");
  });

  it("sends a payload Slack and Discord both render", () => {
    const { alerter, posted } = harness();
    alerter.fire(ALERT);
    const body = JSON.parse(posted[0]!) as Record<string, unknown>;
    expect(body.text).toContain("Keeper will not start");
    expect(body.severity).toBe("critical");
    expect(body.key).toBe("parked:0xabc");
  });
});

describe("the heartbeat", () => {
  /**
   * The only alert that can catch a process that is UP and no longer working.
   * Every other one is raised by something going wrong; a wedged keeper raises
   * nothing at all, and that is the failure mode that hides longest.
   */
  it("says nothing while progress is being made", () => {
    const { alerter, lines, advance } = harness();
    let clock = 0;
    const beat = createHeartbeat({ alerter, name: "keeper", silenceMs: 10_000, now: () => clock });
    for (let i = 0; i < 5; i += 1) {
      clock += 5_000;
      advance(5_000);
      beat.beat();
      beat.check();
    }
    expect(lines).toHaveLength(0);
  });

  it("fires once the process has gone quiet for too long", () => {
    const { alerter, lines, advance } = harness();
    let clock = 0;
    const beat = createHeartbeat({ alerter, name: "keeper", silenceMs: 10_000, now: () => clock });
    beat.beat();
    clock += 11_000;
    advance(11_000);
    beat.check();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("gone quiet");
  });

  it("stops complaining as soon as progress resumes", () => {
    const { alerter, lines, advance } = harness();
    let clock = 0;
    const beat = createHeartbeat({ alerter, name: "keeper", silenceMs: 10_000, now: () => clock });
    beat.beat();
    clock += 11_000;
    advance(11_000);
    beat.check();
    beat.beat();
    clock += 11_000;
    advance(11_000);
    beat.check();
    // Two separate outages, not one deduplicated forever: clearing on recovery
    // is what makes the second one visible.
    expect(lines).toHaveLength(2);
  });
});
