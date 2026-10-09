// The header's dot (LiveHeartbeat.tsx): one dot at every width, its words in its
// popover and its accessible name, never text in the bar (owner, 10-09). Solid
// when updated, breathing only for a check someone asked for, hollow when the
// last update failed, saying as of when — and that order when two are true. Check now counts down
// to when a press helps, and says it is checking once pressed.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CheckNow, LiveHeartbeat, PULSE_DOT, checkLook, pulseStateOf, pulseWords, seenAt } from "@/components/live/LiveHeartbeat";
import type { LiveStale } from "@/hooks/use-live-dashboard";
import { LIVE_COPY } from "@/lib/live-copy";
import { MANUAL_FLOOR_MS } from "@/lib/live-schedule";

import { liveRegions } from "../../../test/live-regions";

const T = Date.UTC(2026, 9, 9, 12, 0, 0);
const SNAPSHOT_MS = T - 2_000;
/** Held, but still focusable: aria-disabled, never the attribute that drops the focus. */
const DISABLED = /aria-disabled="true"/;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T);
});
afterEach(() => vi.useRealTimers());

const failed = (over: Partial<LiveStale> = {}): LiveStale => ({ message: LIVE_COPY.network, retryAt: null, since: T, ...over });

/** The dot as drawn at browser time `at`. Each test names its own pension, so the remembered moments never cross. */
const dotAt = (at: number, props: { readonly pensionKey: string; readonly nowMs?: number; readonly stale?: LiveStale | null; readonly readyAt?: number }): string => {
  vi.setSystemTime(at);
  return renderToStaticMarkup(
    createElement(LiveHeartbeat, {
      pensionKey: props.pensionKey,
      nowMs: props.nowMs ?? SNAPSHOT_MS,
      stale: props.stale ?? null,
      readyAt: props.readyAt ?? T + MANUAL_FLOOR_MS,
      onCheck: () => undefined,
    }),
  );
};

/** The dot's accessible name, as a screen reader is given it. */
const nameOf = (html: string): string | null => html.match(/aria-label="([^"]*)"/)?.[1] ?? null;
/** What a person reads in the bar: the markup without its tags. */
const seen = (html: string): string => html.replace(/<[^>]*>/g, "").trim();

describe("the dot's state", () => {
  it("is behind over checking over fresh", () => {
    expect(pulseStateOf({ stale: true, checking: true })).toBe("behind");
    expect(pulseStateOf({ stale: true, checking: false })).toBe("behind");
    expect(pulseStateOf({ stale: false, checking: true })).toBe("checking");
    expect(pulseStateOf({ stale: false, checking: false })).toBe("fresh");
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

  it("say when the figures were updated, and nothing more, while all is well", () => {
    expect(pulseWords("fresh", 12_000, "11:59 UTC")).toEqual({ lines: ["Updated just now"], name: "Updated just now" });
    expect(pulseWords("fresh", 120_000, "11:58 UTC").name).toBe("Updated 2 min ago");
  });

  it("name a check under way, and leave the popover to Check now's own label", () => {
    const words = pulseWords("checking", 120_000, "11:58 UTC");
    expect(words.name).toBe("Checking… Updated 2 min ago");
    expect(words.lines).toEqual(["Updated 2 min ago"]);
  });

  it("say the page is behind, and as of when — the stale note's own moment", () => {
    const words = pulseWords("behind", 6 * 60_000, "11:54 UTC");
    expect(words.lines).toEqual(["Behind — couldn’t update", "As of 11:54 UTC"]);
    expect(words.name).toBe("Behind — couldn’t update. As of 11:54 UTC");
  });

  it("use none of the machinery's words, and promise no time", () => {
    const sentences = [
      ...(["fresh", "checking", "behind"] as const).flatMap((state) => [...pulseWords(state, 300_000, "11:55 UTC").lines, pulseWords(state, 300_000, "11:55 UTC").name]),
      LIVE_COPY.pulse.checkNow,
      LIVE_COPY.pulse.checking,
    ];
    for (const sentence of sentences) {
      expect(sentence).not.toMatch(/\b(keeper|read|poll|wrap|policy|RPC|socket)\b/i);
      expect(sentence).not.toMatch(/shortly|next (update|check)|in a (moment|minute)/i);
    }
  });
});

describe("when the figures were updated", () => {
  it("is the moment this browser first saw the snapshot, kept across a remount", () => {
    const store = new Map<string, { readonly nowMs: number; readonly at: number }>();
    expect(seenAt(store, "A", 100, T)).toBe(T);
    // The same snapshot, drawn again a minute later (a walk to /activity and back).
    expect(seenAt(store, "A", 100, T + 60_000)).toBe(T);
    // A newer snapshot is a new moment, and replaces the old one.
    expect(seenAt(store, "A", 200, T + 70_000)).toBe(T + 70_000);
    expect(store.size).toBe(1);
    // Another pension keeps its own.
    expect(seenAt(store, "B", 100, T + 80_000)).toBe(T + 80_000);
  });

  it("ages from there, not from when the dot was mounted", () => {
    expect(nameOf(dotAt(T, { pensionKey: "aging" }))).toBe("Updated just now");
    expect(nameOf(dotAt(T + 2 * 60_000, { pensionKey: "aging" }))).toBe("Updated 2 min ago");
    // A new snapshot landed: just now again.
    expect(nameOf(dotAt(T + 2 * 60_000, { pensionKey: "aging", nowMs: SNAPSHOT_MS + 120_000 }))).toBe("Updated just now");
  });
});

describe("in the bar", () => {
  it("is the dot only: a button with no words of its own, named by its state", () => {
    const html = dotAt(T, { pensionKey: "bar" });
    expect(seen(html)).toBe("");
    expect(nameOf(html)).toBe("Updated just now");
    expect(html).toMatch(/^<button\b/);
    expect(html).toContain('data-pulse="fresh"');
    // It opens a popover that holds Check now.
    expect(html).toContain('aria-haspopup="dialog"');
  });

  it("is hollow and says so when the last update failed, with the moment the figures are from", () => {
    expect(dotAt(T, { pensionKey: "behind" })).toContain('data-pulse="fresh"');
    // Six minutes on, the updates since have failed: the figures are the snapshot's, read at 11:59:58.
    const html = dotAt(T + 6 * 60_000, { pensionKey: "behind", stale: failed({ since: T + 6 * 60_000 }) });
    expect(html).toContain('data-pulse="behind"');
    expect(html).toMatch(/border border-muted-foreground bg-transparent/);
    expect(nameOf(html)).toBe("Behind — couldn’t update. As of 11:59 UTC");
  });

  it("names the day the figures are from once that is not this browser's today", () => {
    // Still behind the next morning: a bare "11:59 UTC" would read as minutes old.
    const html = dotAt(T + 20 * 3_600_000, { pensionKey: "overnight", stale: failed({ since: T + 60_000 }) });
    expect(nameOf(html)).toBe("Behind — couldn’t update. As of yesterday, 11:59 UTC");
  });

  it("is never a live region: its age changes every minute and must not be spoken", () => {
    for (const stale of [null, failed()]) {
      expect(liveRegions(dotAt(T, { pensionKey: "quiet", stale }))).toEqual([]);
    }
  });

  it("keeps one box in every state, so nothing beside it can move", () => {
    const boxes = [dotAt(T, { pensionKey: "box" }), dotAt(T, { pensionKey: "box", stale: failed() })].map(
      (html) => html.match(/<span aria-hidden="true" class="([^"]*)"/)?.[1] ?? "",
    );
    for (const box of boxes) expect(box).toMatch(/^size-2 rounded-full /);
  });
});

describe("Check now", () => {
  const button = (props: { readonly enableAt: number; readonly checking: boolean }): string =>
    renderToStaticMarkup(createElement(CheckNow, { ...props, onCheck: () => undefined }));

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

  it("says it is checking once pressed, and its glyph turns only for those who allow motion", () => {
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

describe("reduced motion", () => {
  it("the dot breathes only through the class globals.css stills, and is the hollow ring instead", () => {
    expect(PULSE_DOT.checking).toContain("live-breathe");
    expect(PULSE_DOT.checking).toContain("motion-reduce:border motion-reduce:border-muted-foreground motion-reduce:bg-transparent");
    for (const look of Object.values(PULSE_DOT)) expect(look).not.toMatch(/(^|\s)animate-/);
    // Only a check under way moves at all.
    expect(PULSE_DOT.fresh).not.toContain("live-");
    expect(PULSE_DOT.behind).not.toContain("live-");
  });
});
