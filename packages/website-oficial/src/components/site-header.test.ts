// The brand's mark sits before its name in the navbar (owner, 09-23), in the
// ink the theme calls for — the same two images the footer wears.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

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
