// A retry that says when it will help (RetryButton.tsx): it counts down to the
// later of the server's retry-after and the store's floor after the last read, is
// pressable exactly then, says "Retrying…" once pressed, and never ticks inside
// a live region. And the unreadable card it sits on says its sentence once.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FeedBanner } from "@/components/live/LiveColumn";
import { LiveUnreadable } from "@/components/live/LiveStates";
import { RetryButton, pressKeyOf, retryEnableAt, retryLook } from "@/components/live/RetryButton";
import { LIVE_COPY } from "@/lib/live-copy";
import { MANUAL_FLOOR_MS } from "@/lib/live-schedule";

import { tickingInRegion } from "../../../test/live-regions";

const T = Date.UTC(2026, 9, 9, 12, 0, 0);
/** Held, but still focusable: aria-disabled, never the attribute that drops the focus (RetryButton.tsx). */
const DISABLED = /aria-disabled="true"/;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T);
});
afterEach(() => vi.useRealTimers());

/** The button as drawn at browser time `at`. */
const buttonAt = (at: number, props: { readonly retryAt: number | null; readonly readyAt: number }): string => {
  vi.setSystemTime(at);
  return renderToStaticMarkup(createElement(RetryButton, { ...props, onRetry: () => undefined }));
};

describe("when a press can help", () => {
  it("is the later of the server's retry-after and the floor", () => {
    expect(retryEnableAt(null, T + 10_000)).toBe(T + 10_000);
    expect(retryEnableAt(T + 30_000, T + 10_000)).toBe(T + 30_000);
    expect(retryEnableAt(T + 3_000, T + 10_000)).toBe(T + 10_000);
  });

  it("is exactly then: disabled a millisecond before, pressable at the moment", () => {
    const props = { retryAt: T + 12_500, readyAt: T + 10_000 };
    const before = buttonAt(T + 12_499, props);
    expect(before).toContain(LIVE_COPY.retryIn(1));
    expect(before).toMatch(DISABLED);

    const at = buttonAt(T + 12_500, props);
    expect(at).toContain(LIVE_COPY.retry);
    expect(at).not.toMatch(DISABLED);
  });

  it("counts down the whole wait, in whole seconds rounded up", () => {
    expect(buttonAt(T, { retryAt: T + 12_500, readyAt: T + 10_000 })).toContain(LIVE_COPY.retryIn(13));
    expect(buttonAt(T, { retryAt: null, readyAt: T + MANUAL_FLOOR_MS })).toContain(LIVE_COPY.retryIn(10));
  });
});

describe("what it says", () => {
  it("never drops the focus: held with aria-disabled, never with the disabled attribute", () => {
    const html = buttonAt(T, { retryAt: null, readyAt: T + MANUAL_FLOOR_MS });
    expect(html).toMatch(DISABLED);
    expect(html).not.toMatch(/\sdisabled=""/);
  });

  it("counts down, then offers the retry, then says it is retrying", () => {
    expect(retryLook({ left: 12, retrying: false })).toEqual({ label: LIVE_COPY.retryIn(12), disabled: true });
    expect(retryLook({ left: null, retrying: false })).toEqual({ label: LIVE_COPY.retry, disabled: false });
    expect(retryLook({ left: null, retrying: true })).toEqual({ label: LIVE_COPY.retrying, disabled: true });
  });
});

describe("what ends a press", () => {
  // The floor is the store's own `live.refreshReadyAt` (plan B2): every read
  // that finishes, good or failed, moves it — and that alone ends "Retrying…".
  it("is a new floor or a new retry-after, and nothing else", () => {
    expect(pressKeyOf(null, T + MANUAL_FLOOR_MS)).not.toBe(pressKeyOf(null, T + 60_000 + MANUAL_FLOOR_MS));
    expect(pressKeyOf(null, T + MANUAL_FLOOR_MS)).not.toBe(pressKeyOf(T + 30_000, T + MANUAL_FLOOR_MS));
    expect(pressKeyOf(T + 30_000, T + MANUAL_FLOOR_MS)).toBe(pressKeyOf(T + 30_000, T + MANUAL_FLOOR_MS));
  });
});

describe("the unreadable card", () => {
  /** The card with the store's floor ten seconds after a read that failed just now, unless given. */
  const card = (message: string, retryAt: number | null = null, readyAt = T + MANUAL_FLOOR_MS): string =>
    renderToStaticMarkup(createElement(LiveUnreadable, { message, retryAt, readyAt, onRetry: () => undefined }));
  const times = (html: string, text: string): number => html.split(text).length - 1;

  it("says its own sentence once when the vault itself could not be read (G10)", () => {
    expect(times(card(LIVE_COPY.unreadableBody), LIVE_COPY.unreadableBody)).toBe(1);
    expect(times(card(""), LIVE_COPY.unreadableBody)).toBe(1);
  });

  it("says the reason, then its own sentence, when there is a reason", () => {
    const html = card(LIVE_COPY.rateLimited(30));
    expect(times(html, LIVE_COPY.rateLimited(null))).toBe(1);
    expect(times(html, LIVE_COPY.unreadableBody)).toBe(1);
    expect(html.indexOf(LIVE_COPY.rateLimited(null))).toBeLessThan(html.indexOf(LIVE_COPY.unreadableBody));
  });

  it("counts down to the server's retry-after, or to the store's floor after the read that failed", () => {
    expect(card(LIVE_COPY.rateLimited(30), T + 30_000)).toContain(LIVE_COPY.retryIn(30));
    expect(card(LIVE_COPY.network)).toContain(LIVE_COPY.retryIn(MANUAL_FLOOR_MS / 1_000));
    // The store's moment, not a floor counted from when the card was mounted: a card drawn 4 s after its read counts 6.
    expect(card(LIVE_COPY.network, null, T + MANUAL_FLOOR_MS - 4_000)).toContain(LIVE_COPY.retryIn(6));
    // Its floor already passed: the retry is offered at once.
    expect(card(LIVE_COPY.network, null, T - 1)).toContain(`>${LIVE_COPY.retry}</button>`);
  });

  it("keeps the countdown out of its live region", () => {
    const html = card(LIVE_COPY.rateLimited(30), T + 30_000);
    expect(html).toContain('role="status"');
    expect(tickingInRegion(html)).toBe(false);
  });
});

describe("the history's banner", () => {
  it("announces its sentence, not its countdown", () => {
    const html = renderToStaticMarkup(createElement(FeedBanner, { retryAt: T + 12_000, readyAt: T + MANUAL_FLOOR_MS, onRetry: () => undefined }));
    expect(html).toContain(LIVE_COPY.retryIn(12));
    expect(html).toContain('role="status"');
    expect(tickingInRegion(html)).toBe(false);
  });
});
