// Every sentence the live dashboard says: the public name, and what it promises.
//
// The walk below calls every copy FUNCTION as well as reading every literal, so
// a brand name or a false promise smuggled into a template string fails here
// rather than reaching a screenshot.

import { DEFAULT_VAULT_POLICY, VOLUME_MODE_OFFERED } from "@sip/solana-core/client";
import { describe, expect, it } from "vitest";

import { ACTIVITY_COPY, BRAND, LIVE_COPY, MODE_COPY, ONBOARDING_COPY, START_BUYING_COPY, STATS_COPY, stripTooltip } from "@/lib/live-copy";
import { LOSS_DROPPED_AFTER_TXS, VAULT_COPY, ratePercent } from "@/lib/vault-copy";

/** Sample arguments for the copy functions, so their OUTPUT is checked too, not just the literals. */
const SAMPLES: readonly unknown[][] = [
  [12],
  [null],
  ["14:32", 30],
  [7],
  ["0.06"],
  ["0.06", "0.05"],
  ["Trading wallet 1", "20 %", "0.5"],
  ["Trading wallet 1", "20 %", "0.5", "profit"],
  [{ label: "Trading wallet 1", rate: "20 %", base: "0.5", measure: "profit", capped: "0.06", when: "4m ago" }],
];

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
  walk({ BRAND, LIVE_COPY, MODE_COPY, ACTIVITY_COPY, STATS_COPY, stripTooltip, ONBOARDING_COPY, START_BUYING_COPY });
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
    expect(LIVE_COPY.staleAsOfPending("14:32")).toContain("14:32");
  });
});

describe("the rate a sentence quotes is the product's own", () => {
  it("the profit sentences carry ratePercent(DEFAULT_VAULT_POLICY.skimBps)", () => {
    const rate = ratePercent(DEFAULT_VAULT_POLICY.skimBps);
    expect(rate).toBe("20 %");
    expect(LIVE_COPY.heroProfit(rate)).toContain(rate);
    expect(LIVE_COPY.modeProfit(rate)).toBe(`Profit · ${rate}`);
    // The keeper's sweep is explained at the vault's OWN rate, not a hardcoded one.
    expect(LIVE_COPY.waiting.body(rate)).toContain(rate);
  });
});

describe("VOLUME is not offered, so nothing here offers it", () => {
  it("says a volume vault receives nothing, and never invites anyone to choose it", () => {
    expect(VOLUME_MODE_OFFERED).toBe(false);
    expect(LIVE_COPY.volumeNotOffered).toMatch(/cannot settle/);
    const offers = everySentence().filter((sentence) => /switch to volume|choose volume|volume mode is available/i.test(sentence));
    expect(offers).toEqual([]);
  });
});

describe("a row never claims more than the chain said", () => {
  it("a settlement that moved nothing is said as itself", () => {
    expect(ACTIVITY_COPY.settledNothing("a trading wallet")).toMatch(/nothing to save/i);
  });

  it("a plain transfer is labelled as one, and never counted as saved", () => {
    expect(ACTIVITY_COPY.receivedSub).toMatch(/not counted as saved/);
  });

  it("a cap says what was owed and that the rest is gone, not carried", () => {
    expect(ACTIVITY_COPY.settledCapped("0.1", "0.06")).toMatch(/not carried over/);
  });

  /**
   * NO TITLE CARRIES A FIGURE ANY MORE. Every one used to, so a row printed
   * the same number twice — once in a title that ran out of room in a 320px
   * column and was cut mid-word, and once in full on the right. The amount
   * lives in its own column now, and the amount-less twins that existed for
   * the unreadable case went with the figures: when a number cannot be read
   * the COLUMN empties and the title is unchanged.
   */
  it("no row title carries a figure, and no amount-less twin is left behind", () => {
    // A digit-free label, because a wallet's own name may hold one ("Trading
    // wallet 1") and that is the label, not an amount.
    const titles = [
      ACTIVITY_COPY.settled("a trading wallet"),
      ACTIVITY_COPY.settledNothing("a trading wallet"),
      ACTIVITY_COPY.wrapped,
      ACTIVITY_COPY.converted,
      ACTIVITY_COPY.invested("SPYx"),
      ACTIVITY_COPY.withdrewSol,
      ACTIVITY_COPY.withdrewToken("SPYx"),
      ACTIVITY_COPY.receivedSol,
    ];
    for (const title of titles) expect(title, title).not.toMatch(/\d/);
    expect(ACTIVITY_COPY).not.toHaveProperty("convertedPlain");
    expect(ACTIVITY_COPY).not.toHaveProperty("investedPlain");
    expect(ACTIVITY_COPY).not.toHaveProperty("wrappedPlain");
  });

  it("an empty history says what WILL appear, and an unreadable one says it failed", () => {
    expect(ACTIVITY_COPY.empty).toMatch(/Solscan/);
    expect(ACTIVITY_COPY.unreadableNow).toMatch(/could not be read/i);
    expect(ACTIVITY_COPY.empty).not.toBe(ACTIVITY_COPY.unreadableNow);
  });
});

describe("the zone the page buckets money by is named", () => {
  it("the Today tile says which day it means", () => {
    // statsOf cuts the day at Date.UTC(midnight), so for an owner in Lisbon a
    // settlement after 01:00 local counts towards the NEXT day's tile.
    expect(STATS_COPY.today).toBe("Today (UTC)");
  });

  it("…and This week claims no zone, because it is a rolling seven days and not a calendar week", () => {
    expect(STATS_COPY.thisWeek).not.toMatch(/UTC/);
  });

  it("a day heading carries the zone its rows were bucketed in", () => {
    expect(ACTIVITY_COPY.dayHeading("Today")).toBe("Today · UTC");
    expect(ACTIVITY_COPY.dayHeading("Sep 5")).toBe("Sep 5 · UTC");
  });
});

describe("two different quantities never share a label", () => {
  it("the program's invested counter and the basket's market value are named apart", () => {
    // The old live card showed both at once: policy.lifetimeInvested, which only
    // invest() advances, and the leg holdings valued at today's prices. They
    // differ whenever a leg reached the vault by any other route, so a reader
    // saw "Invested so far $0.00" above "Invested $86.41".
    expect(LIVE_COPY.invested).not.toBe(LIVE_COPY.investedSoFar);
    expect(LIVE_COPY.investedSoFar.startsWith(LIVE_COPY.invested)).toBe(false);
    expect(LIVE_COPY.invested).not.toMatch(/^invested/i);
  });

  it("and the counter says what it counts, where the figure is", () => {
    expect(LIVE_COPY.investedSoFarTooltip).toMatch(/spent/i);
    expect(LIVE_COPY.investedSoFarTooltip).toMatch(/any other way are not/i);
  });
});

describe("the stats claim only what exists", () => {
  it("has no tile for anything the chain cannot answer", () => {
    const labels = Object.values(STATS_COPY).filter((value) => typeof value === "string");
    for (const banned of ["Avg per trade", "Volume", "Biggest trade", "Streak", "Active days", "At this pace"]) {
      expect(labels).not.toContain(banned);
    }
  });

  it("the settlement strip names its own population rather than implying a lifetime", () => {
    expect(STATS_COPY.lastSettlements("40")).toBe("last 40 settlements");
  });

  it("counts one settlement as a settlement, not as `1 settlements`", () => {
    expect(LIVE_COPY.settlementCount("1")).toBe("1 settlement");
    expect(LIVE_COPY.settlementCount("3")).toBe("3 settlements");
    expect(STATS_COPY.lastSettlements("1")).toBe("last 1 settlement");
  });
});

describe("the strip's tooltip", () => {
  /**
   * THE EXACT FIGURE LEADS IT. The chip's own face is rounded to three places
   * so it can be read at a glance, so this is the one place the whole amount
   * survives — and it is also the chip's accessible name, because the face's
   * unit is a decorative mark a screen reader never sees.
   */
  it("leads with the exact amount, then who, how much of what, and when", () => {
    const capped = stripTooltip({ paid: "0.036634582", label: "Trading wallet 1", rate: "20 %", base: "0.5", measure: "profit", capped: "0.06", when: "4m ago" });
    expect(capped).toBe("0.036634582 SOL · Trading wallet 1 · 20 % of 0.5 SOL profit · capped at 0.06 SOL · 4m ago");
    const plain = stripTooltip({ paid: "0.06", label: "Trading wallet 1", rate: "20 %", base: "0.5", measure: "profit", capped: null, when: "4m ago" });
    expect(plain).toBe("0.06 SOL · Trading wallet 1 · 20 % of 0.5 SOL profit · 4m ago");
  });
});


// THE NEW-USER SETUP says only what the program does, in plain words.
describe("the new-user setup's words", () => {
  /** Every sentence ONBOARDING_COPY can produce, literals and functions alike. */
  function setupSentences(): string[] {
    const out: string[] = [];
    const walk = (value: unknown): void => {
      if (typeof value === "string") out.push(value);
      else if (typeof value === "function") {
        for (const args of SAMPLES) {
          try {
            const produced = (value as (...rest: unknown[]) => unknown)(...args);
            if (typeof produced === "string") out.push(produced);
          } catch {
            // Wrong arity for this sample.
          }
        }
      } else if (value !== null && typeof value === "object") for (const entry of Object.values(value)) walk(entry);
    };
    walk(ONBOARDING_COPY);
    return out;
  }
  const rate = ratePercent(DEFAULT_VAULT_POLICY.skimBps);

  it("carries no jargon and no other name: SaverFi, never the keeper, SIP or Nuvem", () => {
    const sentences = setupSentences();
    expect(sentences.length).toBeGreaterThan(30);
    expect(sentences.filter((sentence) => /\bkeeper\b|nuvem|\bSIP\b|[áéíóúñ¿¡]/i.test(sentence))).toEqual([]);
    expect(ONBOARDING_COPY.welcome.title).toContain(BRAND);
  });

  it("promises profit only — volume is not offered — and says a loss carries only as far as the program carries it", () => {
    expect(VOLUME_MODE_OFFERED).toBe(false);
    expect(setupSentences().filter((sentence) => /volume|every trade|every buy/i.test(sentence))).toEqual([]);
    // The rule said right before the signature carries the loss AND its limit (VAULT_COPY.profitRule):
    // promising the loss forever would be a promise the program does not keep.
    // Under the bar, one line: it promises nothing about a loss carried forward (that rule has a limit,
    // LOSS_DROPPED_AFTER_TXS, said in full on the vault card), and says the settlement cap, a real limit
    // on what is saved, since the setup shows no field for it.
    const rule = ONBOARDING_COPY.vault.ruleLine("0.06");
    expect(rule).not.toMatch(/loss comes off|carried/);
    expect(rule).toMatch(/Only gains count/);
    expect(rule).toContain("at most 0.06 SOL per settlement");
    expect(LOSS_DROPPED_AFTER_TXS).toBeGreaterThan(0);
    expect(ONBOARDING_COPY.vault.cost("0.00128524", "0.000011")).toBe("Cost: 0.00128524 SOL + 0.000011 SOL of network fees");
    // The welcome's summary promises nothing about losses at all, rather than half the rule, and no fixed
    // share: the share is chosen on the next step.
    expect(ONBOARDING_COPY.welcome.save(rate)).toContain(rate);
    expect(ONBOARDING_COPY.welcome.save(rate)).toMatch(/You choose how much/);
    expect(ONBOARDING_COPY.welcome.save(rate)).not.toMatch(/loss comes off/);
    expect(ONBOARDING_COPY.welcome.points.join(" ")).not.toMatch(/\d/);
    expect(ONBOARDING_COPY.vault.points("15 %")[0]).toBe("Keeps 15 % of each gain");
  });

  it("keeps the product's name for the wallet that owns the vault", () => {
    expect(ONBOARDING_COPY.pensionKey("Pens…1111").toLowerCase()).toContain("pension key");
  });

  it("the ready screen agrees with the dashboard card behind it", () => {
    expect(ONBOARDING_COPY.ready.title).toBe(LIVE_COPY.noTradingWallet.title);
    expect(ONBOARDING_COPY.vault.title).not.toBe(VAULT_COPY.title);
  });
});

describe("the start-buying card's own words", () => {
  it("say SaverFi, never the keeper, and always say the SOL is converted", () => {
    const sentences = [
      START_BUYING_COPY.title,
      START_BUYING_COPY.lede("SPYx and ANTHROPIC, 50 % each"),
      START_BUYING_COPY.convert(null, null),
      START_BUYING_COPY.convert("$180.00", "$5.00"),
      START_BUYING_COPY.fee("ANTHROPIC", "1 %"),
      START_BUYING_COPY.limits("10 %", "5 %", "ANTHROPIC"),
      START_BUYING_COPY.limits("10 %", "5 %", ""),
      START_BUYING_COPY.depth("$298.00", "$25.00", "ANTHROPIC", "as counted on 2026-09-21"),
      START_BUYING_COPY.cost("0.0118", "0.000035"),
      START_BUYING_COPY.cannotPlan,
    ];
    expect(sentences.filter((sentence) => /\bkeeper\b|\bSIP\b|nuvem/i.test(sentence))).toEqual([]);
    expect(START_BUYING_COPY.convert(null, null)).toMatch(/sold for USDC/);
    expect(START_BUYING_COPY.convert(null, null)).not.toMatch(/null|undefined/);
    expect(START_BUYING_COPY.limits("10 %", "5 %", "ANTHROPIC")).toMatch(/less for ANTHROPIC/);
    expect(START_BUYING_COPY.limits("10 %", "5 %", "")).not.toMatch(/less for/);
    expect(START_BUYING_COPY.cost("0.0118", "0.000035")).toMatch(/not refundable/);
  });
});
