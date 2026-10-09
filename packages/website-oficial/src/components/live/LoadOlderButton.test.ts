// Load older (LoadOlderButton.tsx): drawn only when there is an older page to
// ask for, counting down to the history's own retry-after, and saying "Load
// older" again the moment it can help.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LoadOlderButton, loadOlderLook } from "@/components/live/LoadOlderButton";
import type { LiveOlder } from "@/hooks/use-live-dashboard";
import { ACTIVITY_COPY, LIVE_COPY } from "@/lib/live-copy";

const T = Date.UTC(2026, 9, 9, 12, 0, 0);
/** The attribute, not the `disabled:` classes every button carries. */
const DISABLED = /\sdisabled=""/;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T);
});
afterEach(() => vi.useRealTimers());

const older = (over: Partial<LiveOlder> = {}): LiveOlder => ({ busy: false, retryAt: null, message: null, complete: false, available: true, ...over });
const draw = (state: LiveOlder): string => renderToStaticMarkup(createElement(LoadOlderButton, { older: state, onLoadOlder: () => undefined }));

describe("Load older", () => {
  it("is not drawn once the history is complete, nor before a head page named an older one", () => {
    expect(draw(older({ complete: true }))).toBe("");
    expect(draw(older({ available: false }))).toBe("");
  });

  it("counts down to the history's retry-after, then is pressable exactly at it", () => {
    const refused = older({ retryAt: T + 7_200, message: LIVE_COPY.rateLimited(8) });
    expect(draw(refused)).toContain(LIVE_COPY.retryIn(8));
    expect(draw(refused)).toMatch(DISABLED);

    vi.setSystemTime(T + 7_200);
    expect(draw(refused)).toContain(ACTIVITY_COPY.loadOlder);
    expect(draw(refused)).not.toMatch(DISABLED);
  });

  it("says it is loading while a page is on its way", () => {
    expect(loadOlderLook({ busy: true, left: null })).toEqual({ label: ACTIVITY_COPY.loadingOlder, disabled: true });
    expect(loadOlderLook({ busy: false, left: 3 })).toEqual({ label: LIVE_COPY.retryIn(3), disabled: true });
    expect(loadOlderLook({ busy: false, left: null })).toEqual({ label: ACTIVITY_COPY.loadOlder, disabled: false });
  });
});
