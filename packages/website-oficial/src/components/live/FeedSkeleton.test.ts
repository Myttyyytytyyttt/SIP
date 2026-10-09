// A history on its way, shaped like one (FeedSkeleton.tsx): the feed's own row
// shape, hidden from a screen reader, standing still for reduced motion — and
// never without the words that say what it is.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { FEED_SKELETON_ROWS, FeedSkeleton } from "@/components/live/FeedSkeleton";
import { ACTIVITY_COPY } from "@/lib/live-copy";

const draw = (props: { readonly label?: string; readonly className?: string } = {}): string => renderToStaticMarkup(createElement(FeedSkeleton, props));

describe("FeedSkeleton", () => {
  it("draws five rows the feed's shape: a size-8 rounded tile and two lines", () => {
    const html = draw();
    expect(FEED_SKELETON_ROWS).toBe(5);
    expect(html.match(/size-8 shrink-0/g)).toHaveLength(5);
    expect(html.match(/data-slot="skeleton"/g)).toHaveLength(15);
    expect(html).toContain("rounded-md");
  });

  it("hides its blocks from a screen reader, and pulses only for motion-safe", () => {
    const html = draw();
    expect(html).toMatch(/<div aria-hidden="true"[^>]*data-feed-skeleton=""/);
    expect(html).toContain("motion-safe:animate-pulse");
    expect(html).not.toMatch(/[\s"]animate-pulse/);
  });

  it("brings its words when it stands alone, as visible text outside the hidden blocks", () => {
    const html = draw({ label: ACTIVITY_COPY.readingHistory });
    // The words first, as a paragraph of their own; the hidden blocks after them.
    expect(html.startsWith('<div><p class="text-sm text-muted-foreground">')).toBe(true);
    expect(html).toContain(`${ACTIVITY_COPY.readingHistory.replaceAll("'", "&#x27;")}</p><div aria-hidden="true"`);
  });

  it("adds no words of its own beside a sentence that already says them", () => {
    expect(draw()).not.toContain("<p");
  });
});
