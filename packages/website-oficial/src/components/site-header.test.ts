// The brand's mark sits before its name in the navbar (owner, 09-23), in the
// ink the theme calls for — the same two images the footer wears.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { OpenPension } from "@/components/open-pension";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

describe("the navbar's brand", () => {
  it("wears the mark before the name, in both inks", () => {
    const html = renderToStaticMarkup(createElement(SiteHeader, { activitySheet: null, control: null, account: null, current: "pension" }));
    const mark = html.search(/sip-mark-black\.png/);
    const name = html.indexOf(">SaverFi<");
    expect(mark).toBeGreaterThan(-1);
    expect(html).toMatch(/sip-mark-white\.png/);
    expect(mark).toBeLessThan(name);
  });
});

/**
 * THE TABS CARRY THE PAGE'S MODE (owner, 09-24): in the sample a bare "/" was
 * the landing and a bare "/activity" was Live's connect card.
 */
describe("the navbar's tabs", () => {
  const nav = (mode?: "mock" | "live") =>
    renderToStaticMarkup(createElement(SiteHeader, { activitySheet: null, control: null, account: null, current: "pension", ...(mode === undefined ? {} : { mode }) }));
  const href = (html: string, label: string): string | undefined => html.match(new RegExp(`<a[^>]*href="([^"]*)"[^>]*>${label}</a>`))?.[1];

  it("keep the sample when the page is showing it", () => {
    const html = nav("mock");
    expect(href(html, "Pension")).toBe("/?mode=mock");
    expect(href(html, "Activity")).toBe("/activity?mode=mock");
    expect(href(html, "Leaderboard")).toBe("/leaderboard?mode=mock");
  });

  it("are bare when the page names no mode", () => {
    const html = nav();
    expect(href(html, "Pension")).toBe("/");
    expect(href(html, "Activity")).toBe("/activity");
  });

  it("leave a link that goes nowhere in the app as it is", () => {
    expect(href(nav("mock"), "Docs")).toBe("#");
  });
});

describe("the footer's links", () => {
  const footer = (mode?: "mock") => renderToStaticMarkup(createElement(SiteFooter, { now: "2026-09-24T00:00:00.000Z", ...(mode === undefined ? {} : { mode }) }));

  it("keep the sample to the app's own pages, and only to them", () => {
    const html = footer("mock");
    expect(html).toContain('href="/?mode=mock"');
    expect(html).toContain('href="/activity?mode=mock"');
    expect(html).toContain('href="/leaderboard?mode=mock"');
    expect(html).not.toContain('href="#?mode=mock"');
  });

  it("are bare without a mode", () => {
    expect(footer()).toContain('href="/activity"');
  });
});

describe("the leaderboard's way back", () => {
  it("returns a visitor to the sample they came from", () => {
    expect(renderToStaticMarkup(createElement(OpenPension, { returning: false, mode: "mock" }))).toContain('href="/?mode=mock"');
    expect(renderToStaticMarkup(createElement(OpenPension, { returning: false }))).toContain('href="/"');
  });
});

describe("the navbar's logo", () => {
  it("leads to the landing, which shows whoever is looking — '/' is a connected key's own pension", () => {
    const html = renderToStaticMarkup(createElement(SiteHeader, { activitySheet: null, control: null, account: null, current: "pension" }));
    expect(html).toMatch(/<h1[^>]*><a[^>]*href="\/welcome"[^>]*>[\s\S]*SaverFi[\s\S]*<\/a><\/h1>/);
  });
});
