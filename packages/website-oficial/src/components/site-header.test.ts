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
    expect(href(html, "Dashboard")).toBe("/dashboard?mode=mock");
  });

  it("are bare when the page names no mode", () => {
    const html = nav();
    expect(href(html, "Pension")).toBe("/");
    expect(href(html, "Activity")).toBe("/activity");
    expect(href(html, "Dashboard")).toBe("/dashboard");
  });

  it("leave a link that goes nowhere in the app as it is", () => {
    expect(href(nav("mock"), "Docs")).toBe("#");
  });
});

/**
 * TWO SIDES (owner, 10-07): your own pension's pages on the left; on the right
 * the Dashboard of every pension, a rule, then the settings of this visit
 * (Live|Mock, the account), with the theme switch the very last thing.
 */
describe("the navbar's two sides", () => {
  const html = renderToStaticMarkup(
    createElement(SiteHeader, {
      activitySheet: null,
      control: createElement("span", null, "MODE-CONTROL"),
      account: createElement("span", null, "ACCOUNT-SLOT"),
      current: "dashboard",
      mode: "mock",
    }),
  );
  const main = html.match(/<nav aria-label="Main"[\s\S]*?<\/nav>/)?.[0] ?? "";
  const at = (needle: string): number => html.indexOf(needle);

  it("keeps the Dashboard out of the left-hand tabs, and marks it current on its own page", () => {
    expect(main).toContain(">Leaderboard<");
    expect(main).not.toContain(">Dashboard<");
    expect(html).toMatch(/<nav aria-label="All pensions"[^>]*>[\s\S]*?aria-current="page"[^>]*>Dashboard</);
  });

  it("orders the right side: Dashboard, the rule, Live|Mock, the account, and the theme last", () => {
    const order = [at(">Dashboard<"), at('data-slot="separator"'), at("MODE-CONTROL"), at("ACCOUNT-SLOT"), at('aria-label="Toggle theme"')];
    expect(order.every((index) => index > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(at(">Dashboard<")).toBeGreaterThan(html.indexOf('aria-label="Main"'));
  });
});

describe("the footer's links", () => {
  const footer = (mode?: "mock") => renderToStaticMarkup(createElement(SiteFooter, { now: "2026-09-24T00:00:00.000Z", ...(mode === undefined ? {} : { mode }) }));

  it("keep the sample to the app's own pages, and only to them", () => {
    const html = footer("mock");
    expect(html).toContain('href="/?mode=mock"');
    expect(html).toContain('href="/activity?mode=mock"');
    expect(html).toContain('href="/leaderboard?mode=mock"');
    expect(html).toContain('href="/dashboard?mode=mock"');
    expect(html).not.toContain('href="#?mode=mock"');
  });

  it("are bare without a mode", () => {
    expect(footer()).toContain('href="/activity"');
    expect(footer()).toContain('href="/dashboard"');
  });
});

describe("the leaderboard's way back", () => {
  it("returns a visitor to the sample they came from", () => {
    expect(renderToStaticMarkup(createElement(OpenPension, { returning: false, mode: "mock" }))).toContain('href="/?mode=mock"');
    expect(renderToStaticMarkup(createElement(OpenPension, { returning: false }))).toContain('href="/"');
  });

  it("offers nothing to somebody returning: the Pension tab is their way back (owner, 10-07)", () => {
    expect(renderToStaticMarkup(createElement(OpenPension, { returning: true }))).toBe("");
  });
});

describe("the navbar's logo", () => {
  it("leads to the landing, which shows whoever is looking — '/' is a connected key's own pension", () => {
    const html = renderToStaticMarkup(createElement(SiteHeader, { activitySheet: null, control: null, account: null, current: "pension" }));
    expect(html).toMatch(/<h1[^>]*><a[^>]*href="\/welcome"[^>]*>[\s\S]*SaverFi[\s\S]*<\/a><\/h1>/);
  });
});
