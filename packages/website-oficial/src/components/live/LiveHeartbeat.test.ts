// The header's dot (LiveHeartbeat.tsx): one dot at every width, its words in its
// popover and its accessible name, never text in the bar (owner, 10-09). Since
// plan B2 every state is a signal the store gives (`live`): solid when updated,
// breathing while a check is out or a change was heard, hollow when the last
// update failed — and that order when two are true — "Live" only while the push
// is live, a cadence only where the schedule keeps one, the next check only
// when one is armed, and a ring for a newer version, whose popover offers the
// reload. Check now counts down to when a press helps, and says it is checking
// while a check is out.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CheckNow,
  LiveHeartbeat,
  NEXT_IN_MAX_S,
  NextCheck,
  PULSE_DOT,
  PULSE_UPDATE,
  UpdateOffer,
  checkEnableAt,
  checkLook,
  nextCheckWords,
  pulseStateOf,
  pulseWords,
  pushOffCadenceMs,
  type PulseFacts,
} from "@/components/live/LiveHeartbeat";
import type { LiveLiveness, LiveStale } from "@/hooks/use-live-dashboard";
import { LIVE_COPY } from "@/lib/live-copy";
import { MANUAL_FLOOR_MS, UNHEARD_POLL_MS } from "@/lib/live-schedule";

import { liveLiveness } from "../../../test/fixtures/live-liveness";
import { liveRegions } from "../../../test/live-regions";

const T = Date.UTC(2026, 9, 9, 12, 0, 0);
const SNAPSHOT_MS = T - 2_000;
/** Held, but still focusable: aria-disabled, never the attribute that drops the focus. */
const DISABLED = /aria-disabled="true"/;
/** The machinery's words, which nothing a person reads may use. */
const MACHINERY = /\b(keeper|read|poll|wrap|policy|RPC|socket|push)\b/i;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T);
});
afterEach(() => vi.useRealTimers());

const failed = (over: Partial<LiveStale> = {}): LiveStale => ({ message: LIVE_COPY.network, retryAt: null, since: T, ...over });
const HEARD = { at: T - 1_000, wallets: [] };

/** The dot as drawn at browser time `at`, with the store saying `live`. */
const dotAt = (
  at: number,
  props: { readonly live?: Partial<LiveLiveness>; readonly nowMs?: number; readonly stale?: LiveStale | null; readonly activityRetryAt?: number | null; readonly updateAvailable?: boolean } = {},
): string => {
  vi.setSystemTime(at);
  return renderToStaticMarkup(
    createElement(LiveHeartbeat, {
      nowMs: props.nowMs ?? SNAPSHOT_MS,
      stale: props.stale ?? null,
      live: liveLiveness({ lastReadAt: T, refreshReadyAt: T + MANUAL_FLOOR_MS, ...props.live }),
      activityRetryAt: props.activityRetryAt ?? null,
      updateAvailable: props.updateAvailable ?? false,
      onCheck: () => undefined,
    }),
  );
};

/** The dot's accessible name, as a screen reader is given it. */
const nameOf = (html: string): string | null => html.match(/aria-label="([^"]*)"/)?.[1] ?? null;
/** What a person reads in the bar: the markup without its tags. */
const seen = (html: string): string => html.replace(/<[^>]*>/g, "").trim();
/** The dot's own box, the span inside the button. */
const boxOf = (html: string): string => html.match(/<span aria-hidden="true" class="([^"]*)"/)?.[1] ?? "";

const facts = (over: Partial<PulseFacts> = {}): PulseFacts => ({
  state: "fresh",
  socket: "none",
  ageMs: 12_000,
  asOf: "11:59 UTC",
  heard: false,
  cadenceMs: null,
  update: false,
  ...over,
});

describe("the dot's state", () => {
  it("is behind over heard over checking over fresh", () => {
    expect(pulseStateOf({ stale: true, heard: true, reading: true })).toBe("behind");
    expect(pulseStateOf({ stale: true, heard: false, reading: false })).toBe("behind");
    expect(pulseStateOf({ stale: false, heard: true, reading: true })).toBe("heard");
    expect(pulseStateOf({ stale: false, heard: false, reading: true })).toBe("checking");
    expect(pulseStateOf({ stale: false, heard: false, reading: false })).toBe("fresh");
  });
});

describe("the dot's words", () => {
  it("say how long ago, coarsely: just now under 90 s, then minutes, hours and days", () => {
    expect(LIVE_COPY.pulse.ago(0)).toBe("just now");
    expect(LIVE_COPY.pulse.ago(89_999)).toBe("just now");
    expect(LIVE_COPY.pulse.ago(120_000)).toBe("2 min ago");
    expect(LIVE_COPY.pulse.ago(3 * 3_600_000)).toBe("3 hours ago");
    expect(LIVE_COPY.pulse.ago(3 * 86_400_000)).toBe("3 days ago");
    // A clock that ran backwards is not the future.
    expect(LIVE_COPY.pulse.ago(-5_000)).toBe("just now");
  });

  it("say when the figures were updated, and nothing more, while all is well and no push is wanted", () => {
    expect(pulseWords(facts())).toEqual({ lines: ["Updated just now"], name: "Updated just now" });
    expect(pulseWords(facts({ ageMs: 120_000 })).name).toBe("Updated 2 min ago");
  });

  it("say an unknown age as a dash, never as just now", () => {
    expect(pulseWords(facts({ ageMs: null })).lines).toEqual(["Updated —"]);
  });

  it("say Live only while the push is live, and never with a dot read out as a word", () => {
    const words = pulseWords(facts({ socket: "live" }));
    expect(words.lines).toEqual(["Live · updated just now"]);
    expect(words.name).toBe("Live, updated just now");
    for (const socket of ["none", "connecting", "off"] as const) {
      const other = pulseWords(facts({ socket, cadenceMs: UNHEARD_POLL_MS }));
      for (const text of [...other.lines, other.name]) expect(text).not.toMatch(/\bLive\b/);
    }
  });

  it("say the page is not live while the push connects or is off, with the cadence only when the schedule keeps one", () => {
    for (const socket of ["connecting", "off"] as const) {
      expect(pulseWords(facts({ socket, cadenceMs: UNHEARD_POLL_MS })).lines).toEqual(["Updated just now", "Not live right now · checks Solana about every 20 s"]);
      expect(pulseWords(facts({ socket, cadenceMs: null })).lines).toEqual(["Updated just now", "Not live right now"]);
    }
    expect(pulseWords(facts({ socket: "off", cadenceMs: UNHEARD_POLL_MS })).name).toBe("Updated just now. Not live right now, checks Solana about every 20 s");
  });

  it("name a check under way, and leave the popover to Check now's own label", () => {
    const words = pulseWords(facts({ state: "checking", ageMs: 120_000 }));
    expect(words.name).toBe("Checking… Updated 2 min ago");
    expect(words.lines).toEqual(["Updated 2 min ago"]);
  });

  it("say a change was seen on Solana and is on its way", () => {
    const words = pulseWords(facts({ state: "heard", heard: true }));
    expect(words.lines).toEqual(["Updated just now", "Change seen on Solana · updating"]);
    expect(words.name).toBe("Updated just now. Change seen on Solana, updating");
  });

  it("say the page is behind, and as of when — the stale note's own moment", () => {
    const words = pulseWords(facts({ state: "behind", ageMs: 6 * 60_000, asOf: "11:54 UTC", socket: "off", cadenceMs: UNHEARD_POLL_MS }));
    expect(words.lines).toEqual(["Behind — couldn’t update", "As of 11:54 UTC"]);
    expect(words.name).toBe("Behind — couldn’t update. As of 11:54 UTC");
  });

  it("say, while behind, that a change seen is not on this page yet — not that it is updating", () => {
    const words = pulseWords(facts({ state: "behind", heard: true, asOf: "11:54 UTC" }));
    expect(words.lines).toEqual(["Behind — couldn’t update", "As of 11:54 UTC", "Change seen on Solana · not on this page yet"]);
    expect(words.lines.join(" ")).not.toContain("updating");
  });

  it("name a newer version in the dot's name, and leave the popover's lines to the state", () => {
    const words = pulseWords(facts({ update: true }));
    expect(words.lines).toEqual(["Updated just now"]);
    expect(words.name).toBe(`Updated just now. ${LIVE_COPY.pulse.update}`);
  });

  it("use none of the machinery's words, and promise no time of their own", () => {
    const sentences = (["fresh", "checking", "heard", "behind"] as const).flatMap((state) =>
      (["none", "connecting", "live", "off"] as const).flatMap((socket) =>
        [true, false].flatMap((update) => {
          const words = pulseWords(facts({ state, socket, heard: state === "heard", cadenceMs: UNHEARD_POLL_MS, update, ageMs: 300_000 }));
          return [...words.lines, words.name];
        }),
      ),
    );
    for (const sentence of [...sentences, LIVE_COPY.pulse.checkNow, LIVE_COPY.pulse.checking, LIVE_COPY.pulse.reloadPage]) {
      expect(sentence).not.toMatch(MACHINERY);
      expect(sentence).not.toMatch(/shortly|next (update|check)|in a (moment|minute)/i);
    }
  });
});

describe("how often the page looks while it is not live", () => {
  const cadence = (over: Partial<Parameters<typeof pushOffCadenceMs>[0]> = {}): number | null =>
    pushOffCadenceMs({ socket: "off", backingOff: false, activityRetryAt: null, now: T, ...over });

  it("is the schedule's own 20 s, exactly when the schedule runs at it", () => {
    expect(cadence()).toBe(UNHEARD_POLL_MS);
    expect(cadence({ socket: "connecting" })).toBe(UNHEARD_POLL_MS);
    // A retry-after already passed holds nothing back.
    expect(cadence({ activityRetryAt: T - 1 })).toBe(UNHEARD_POLL_MS);
  });

  it("is nothing to name while backing off, while the history's retry-after is ahead, or with the push live or not wanted", () => {
    expect(cadence({ backingOff: true })).toBeNull();
    expect(cadence({ activityRetryAt: T + 5_000 })).toBeNull();
    expect(cadence({ socket: "live" })).toBeNull();
    expect(cadence({ socket: "none" })).toBeNull();
  });
});

describe("the next check", () => {
  const words = (over: Partial<Parameters<typeof nextCheckWords>[0]> = {}): string | null =>
    nextCheckWords({ at: T + 14_000, left: 14, backingOff: false, now: T, ...over });

  it("counts down while close, and names its moment when further off", () => {
    expect(words()).toBe("Next check in 14 s");
    expect(words({ at: T + NEXT_IN_MAX_S * 1_000, left: NEXT_IN_MAX_S })).toBe(`Next check in ${NEXT_IN_MAX_S} s`);
    expect(words({ at: T + 5 * 60_000, left: 300 })).toBe("Next check at 12:05 UTC");
  });

  it("is the next TRY while the checks back off after an error", () => {
    expect(words({ backingOff: true })).toBe("Waiting after an error · next try in 14 s");
    expect(words({ at: T + 4 * 60_000, left: 240, backingOff: true })).toBe("Waiting after an error · next try at 12:04 UTC");
  });

  it("names the day once the moment is not today", () => {
    expect(words({ at: Date.UTC(2026, 9, 10, 0, 1), left: 43_260, now: T })).toBe("Next check at Oct 10, 00:01 UTC");
  });

  it("says nothing with nothing armed, and nothing once its moment has come", () => {
    expect(words({ at: null, left: null })).toBeNull();
    expect(words({ left: null })).toBeNull();
  });

  it("is drawn from the moment the store armed, counting down, and is nothing without one", () => {
    expect(seen(renderToStaticMarkup(createElement(NextCheck, { at: T + 14_000, backingOff: false })))).toBe("Next check in 14 s");
    expect(renderToStaticMarkup(createElement(NextCheck, { at: null, backingOff: false }))).toBe("");
    expect(renderToStaticMarkup(createElement(NextCheck, { at: T - 1, backingOff: false }))).toBe("");
  });
});

describe("in the bar", () => {
  it("is the dot only: a button with no words of its own, named by its state", () => {
    const html = dotAt(T);
    expect(seen(html)).toBe("");
    expect(nameOf(html)).toBe("Updated just now");
    expect(html).toMatch(/^<button\b/);
    expect(html).toContain('data-pulse="fresh"');
    expect(html).not.toContain("data-update");
    // It opens a popover that holds Check now.
    expect(html).toContain('aria-haspopup="dialog"');
  });

  it("ages from the last update that landed, not from when the dot was mounted", () => {
    expect(nameOf(dotAt(T + 2 * 60_000))).toBe("Updated 2 min ago");
    expect(nameOf(dotAt(T + 2 * 60_000, { live: { lastReadAt: T + 2 * 60_000 - 5_000 } }))).toBe("Updated just now");
  });

  it("says Live only while the push is live", () => {
    expect(nameOf(dotAt(T, { live: { socket: "live" } }))).toBe("Live, updated just now");
    expect(nameOf(dotAt(T, { live: { socket: "off" } }))).toBe("Updated just now. Not live right now, checks Solana about every 20 s");
    // Backing off, the schedule keeps no 20 s: no cadence is named.
    expect(nameOf(dotAt(T, { live: { socket: "off", backingOff: true } }))).toBe("Updated just now. Not live right now");
  });

  it("breathes while a check is out — the page's own included — and while a change heard has not arrived", () => {
    const reading = dotAt(T, { live: { reading: true } });
    expect(reading).toContain('data-pulse="checking"');
    expect(boxOf(reading)).toContain("live-breathe");
    expect(nameOf(reading)).toBe("Checking… Updated just now");

    const heard = dotAt(T, { live: { heard: HEARD } });
    expect(heard).toContain('data-pulse="heard"');
    expect(boxOf(heard)).toContain("live-breathe");
    expect(nameOf(heard)).toBe("Updated just now. Change seen on Solana, updating");

    expect(boxOf(dotAt(T))).not.toContain("live-breathe");
  });

  it("is hollow and says so when the last update failed, with the moment the figures are from", () => {
    // Six minutes on, the updates since have failed: the figures are the snapshot's, read at 11:59:58.
    const html = dotAt(T + 6 * 60_000, { stale: failed({ since: T + 6 * 60_000 }), live: { heard: HEARD, reading: true } });
    expect(html).toContain('data-pulse="behind"');
    expect(boxOf(html)).toMatch(/border border-muted-foreground bg-transparent/);
    expect(nameOf(html)).toBe("Behind — couldn’t update. As of 11:59 UTC. Change seen on Solana, not on this page yet");
  });

  it("names the day the figures are from once that is not this browser's today", () => {
    // Still behind the next morning: a bare "11:59 UTC" would read as minutes old.
    const html = dotAt(T + 20 * 3_600_000, { stale: failed({ since: T + 60_000 }) });
    expect(nameOf(html)).toBe("Behind — couldn’t update. As of yesterday, 11:59 UTC");
  });

  it("wears a ring over whichever look is true while a newer version is served, and says so in its name", () => {
    for (const [props, state] of [
      [{}, "fresh"],
      [{ live: { reading: true } }, "checking"],
      [{ stale: failed() }, "behind"],
    ] as const) {
      const html = dotAt(T, { ...props, updateAvailable: true });
      expect(html).toContain(`data-pulse="${state}"`);
      expect(html).toContain('data-update=""');
      expect(boxOf(html)).toContain(PULSE_UPDATE);
      expect(nameOf(html)).toContain(LIVE_COPY.pulse.update);
      // Still no words in the bar.
      expect(seen(html)).toBe("");
    }
  });

  it("is never a live region: its age changes every minute and must not be spoken", () => {
    for (const stale of [null, failed()]) {
      expect(liveRegions(dotAt(T, { stale, updateAvailable: true, live: { heard: HEARD } }))).toEqual([]);
    }
  });

  it("keeps one box in every state, so nothing beside it can move", () => {
    const boxes = [
      dotAt(T),
      dotAt(T, { live: { reading: true } }),
      dotAt(T, { live: { heard: HEARD } }),
      dotAt(T, { stale: failed() }),
      dotAt(T, { updateAvailable: true }),
    ].map(boxOf);
    for (const box of boxes) expect(box).toMatch(/^size-2 rounded-full /);
  });
});

describe("Check now", () => {
  const button = (props: { readonly enableAt: number; readonly checking: boolean }): string =>
    renderToStaticMarkup(createElement(CheckNow, { ...props, onCheck: () => undefined }));

  it("opens at the store's floor, or at a retry-after the server named, whichever is later", () => {
    expect(checkEnableAt({ refreshReadyAt: T + MANUAL_FLOOR_MS, staleRetryAt: null, activityRetryAt: null })).toBe(T + MANUAL_FLOOR_MS);
    expect(checkEnableAt({ refreshReadyAt: T + MANUAL_FLOOR_MS, staleRetryAt: null, activityRetryAt: T + 30_000 })).toBe(T + 30_000);
    expect(checkEnableAt({ refreshReadyAt: T + MANUAL_FLOOR_MS, staleRetryAt: T + 45_000, activityRetryAt: T + 30_000 })).toBe(T + 45_000);
    expect(checkEnableAt({ refreshReadyAt: T + MANUAL_FLOOR_MS, staleRetryAt: T + 3_000, activityRetryAt: T + 2_000 })).toBe(T + MANUAL_FLOOR_MS);
    // Before the first read the store says 0: nothing to wait for.
    expect(checkEnableAt({ refreshReadyAt: 0, staleRetryAt: null, activityRetryAt: null })).toBe(0);
  });

  it("counts down to when a press reads at once, then offers itself", () => {
    const counting = button({ enableAt: T + MANUAL_FLOOR_MS, checking: false });
    expect(counting).toContain(LIVE_COPY.pulse.checkIn(10));
    expect(counting).toMatch(DISABLED);

    vi.setSystemTime(T + MANUAL_FLOOR_MS);
    const ready = button({ enableAt: T + MANUAL_FLOOR_MS, checking: false });
    expect(ready).toContain(LIVE_COPY.pulse.checkNow);
    expect(ready).not.toMatch(DISABLED);
    // Held with aria-disabled, never with the attribute that would drop the focus.
    expect(counting).not.toMatch(/\sdisabled=""/);
  });

  it("says it is checking while a check is out, and its glyph turns only for those who allow motion", () => {
    const html = button({ enableAt: T - 1, checking: true });
    expect(html).toContain(LIVE_COPY.pulse.checking);
    expect(html).toMatch(DISABLED);
    expect(html).toContain("motion-safe:animate-spin");
    expect(html).not.toMatch(/(^|[\s"])animate-spin/);
  });

  it("is checking over counting, and counting over ready", () => {
    expect(checkLook({ left: 4, checking: true })).toEqual({ label: LIVE_COPY.pulse.checking, disabled: true });
    expect(checkLook({ left: 4, checking: false })).toEqual({ label: LIVE_COPY.pulse.checkIn(4), disabled: true });
    expect(checkLook({ left: null, checking: false })).toEqual({ label: LIVE_COPY.pulse.checkNow, disabled: false });
  });
});

describe("a newer version, in the popover", () => {
  it("is said, with the one control that loads it — a real button, its glyph still", () => {
    const html = renderToStaticMarkup(createElement(UpdateOffer));
    expect(html).toContain(LIVE_COPY.pulse.update);
    expect(html).toMatch(new RegExp(`<button[^>]*>.*${LIVE_COPY.pulse.reloadPage}</button>`));
    expect(html).not.toMatch(/animate-/);
    expect(liveRegions(html)).toEqual([]);
  });
});

describe("reduced motion", () => {
  it("the dot breathes only through the class globals.css stills, and is the hollow ring instead", () => {
    for (const state of ["checking", "heard"] as const) {
      expect(PULSE_DOT[state]).toContain("live-breathe");
      expect(PULSE_DOT[state]).toContain("motion-reduce:border motion-reduce:border-muted-foreground motion-reduce:bg-transparent");
    }
    for (const look of [...Object.values(PULSE_DOT), PULSE_UPDATE]) expect(look).not.toMatch(/(^|\s)animate-/);
    // Only a check out or a change heard moves at all; the update's ring never does.
    expect(PULSE_DOT.fresh).not.toContain("live-");
    expect(PULSE_DOT.behind).not.toContain("live-");
    expect(PULSE_UPDATE).not.toContain("live-");
  });
});
