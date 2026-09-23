// The turn of the page between tabs (owner, 09-23): the app's loader, the mark
// in its ring, for a moment each time a tab is chosen — and never over a page
// that did not change, and never where nothing is loading.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/" }));

const { RouteLoaderProvider, turnsTo } = await import("@/components/route-loader");

describe("which links turn the page", () => {
  it("turns to another of the site's pages", () => {
    expect(turnsTo("/activity", "/")).toBe("/activity");
    expect(turnsTo("/", "/leaderboard")).toBe("/");
  });

  it("does not turn to the page already showing, whatever its query or fragment", () => {
    expect(turnsTo("/", "/")).toBeNull();
    expect(turnsTo("/activity?x=1", "/activity")).toBeNull();
    expect(turnsTo("/activity#top", "/activity")).toBeNull();
  });

  it("does not turn for an anchor or anywhere off the site", () => {
    expect(turnsTo("#", "/")).toBeNull();
    expect(turnsTo("https://solscan.io/tx/5nSt", "/")).toBeNull();
    expect(turnsTo("//evil.example/", "/")).toBeNull();
  });

  it("compares only the path of a link that carries a query", () => {
    expect(turnsTo("/?mode=mock", "/activity")).toBe("/");
  });
});

describe("the loader at rest", () => {
  it("is on the page from the start, hidden, and says nothing to a screen reader", () => {
    const html = renderToStaticMarkup(createElement(RouteLoaderProvider, null, createElement("p", null, "page")));
    expect(html).toContain("<p>page</p>");
    expect(html).toMatch(/class="app-loader"[^>]*aria-hidden="true"/);
    expect(html).not.toContain("data-shown");
    expect(html).not.toContain("Loading");
  });

  it("carries the app's own mark inside its ring", () => {
    const html = renderToStaticMarkup(createElement(RouteLoaderProvider, null, null));
    expect(html).toContain("app-loader-ring");
    expect(html).toContain("app-loader-mark");
  });
});
