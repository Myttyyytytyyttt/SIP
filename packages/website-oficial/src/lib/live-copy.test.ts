// Every sentence the live dashboard says: the public name, and what it promises.

import { describe, expect, it } from "vitest";

import { BRAND, LIVE_COPY, MODE_COPY } from "@/lib/live-copy";

/** Sample arguments for the copy functions, so their OUTPUT is checked too, not just the literals. */
const SAMPLES: readonly unknown[][] = [[12], [null], ["14:32", 30], [7]];

/** Every string this module can produce: the literals, and each function called with sample arguments. */
function everySentence(): string[] {
  const out: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === "string") {
      out.push(value);
      return;
    }
    if (typeof value === "function") {
      for (const args of SAMPLES) {
        try {
          const produced = (value as (...rest: unknown[]) => unknown)(...args);
          if (typeof produced === "string") out.push(produced);
        } catch {
          // Wrong arity for this sample; another one fits.
        }
      }
      return;
    }
    if (value !== null && typeof value === "object") for (const entry of Object.values(value)) walk(entry);
  };
  walk({ BRAND, LIVE_COPY, MODE_COPY });
  return out;
}

describe("the public name", () => {
  it("is SaverFi", () => {
    expect(BRAND).toBe("SaverFi");
  });

  it("NO sentence — literal or produced — carries the old name", () => {
    const sentences = everySentence();
    expect(sentences.length).toBeGreaterThan(25);
    const offenders = sentences.filter((sentence) => /\bSIP\b/i.test(sentence));
    expect(offenders).toEqual([]);
  });

  it("names itself where a person is being asked to trust it", () => {
    expect(LIVE_COPY.connectBody).toContain(BRAND);
    expect(MODE_COPY.sample).toContain(BRAND);
    expect(MODE_COPY.keyless).toContain(BRAND);
    expect(LIVE_COPY.unreadableBody).toContain(BRAND);
  });
});

describe("what the sample is allowed to promise", () => {
  it("every notice says the numbers are an example and belong to nobody", () => {
    for (const notice of [MODE_COPY.sample, MODE_COPY.keyless]) {
      expect(notice).toMatch(/example/i);
      expect(notice).toMatch(/nobody/i);
    }
  });

  it("it no longer says live numbers arrive later: they arrive when a key is connected", () => {
    expect(MODE_COPY.sample).not.toMatch(/arrive|later|coming soon/i);
    expect(MODE_COPY.sample).toContain("Connect your pension key");
  });

  it("the keyless notice says what to do about it, rather than leaving a dead end", () => {
    expect(MODE_COPY.keyless).toMatch(/disconnect/i);
    expect(MODE_COPY.keyless).toMatch(/Phantom/);
  });
});

describe("the states that show no numbers", () => {
  it("the connect card says what Live would show, and that nothing is shown until it can", () => {
    expect(LIVE_COPY.connectTitle).toBe("Connect your pension key");
    expect(LIVE_COPY.connectBody).toMatch(/read from Solana/);
    expect(LIVE_COPY.connectFootnote).toMatch(/Nothing is shown until a wallet is connected/);
    // The one place sample numbers may appear is named, so Live can never imply them.
    expect(LIVE_COPY.connectFootnote).toMatch(/only under Mock/);
  });

  it("an unreadable pension says it could not be read, NOT that there is nothing", () => {
    expect(LIVE_COPY.unreadableBody).toMatch(/could not read/i);
    expect(LIVE_COPY.unreadableBody).toMatch(/rather than a guess/);
    expect(LIVE_COPY.unreadableBody).not.toMatch(/\bno vault\b|\bempty\b|\b0\b/i);
  });

  it("a stalled Privy names the host to unblock, because that is the actual fix", () => {
    expect(LIVE_COPY.stalledBody).toContain("auth.privy.io");
    expect(LIVE_COPY.stalledBody).toMatch(/extension may be blocking/);
  });
});

describe("refusals say when, not just that", () => {
  it("a rate limit counts down when the server said how long", () => {
    expect(LIVE_COPY.rateLimited(12)).toContain("12 s");
    expect(LIVE_COPY.rateLimited(null)).not.toContain("null");
    expect(LIVE_COPY.rateLimited(null)).toMatch(/shortly/);
  });

  it("a stale reading says as of when, and never falls back to the sample", () => {
    const stale = LIVE_COPY.staleAsOf("14:32", 30);
    expect(stale).toContain("14:32");
    expect(stale).toContain("30 s");
    expect(stale).not.toMatch(/sample|example/i);
  });
});
