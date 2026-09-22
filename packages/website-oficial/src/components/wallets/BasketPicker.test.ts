// The picker rendered to HTML: the catalogue, the ticks, the shares, and the
// two things the owner must not have to scroll for.
//
// basket-picker.test.ts pins the RULES as functions. This pins that the screen
// actually shows them — that a refused stock arrives with the reading that
// refused it rather than as a greyed row with no reason, that the ceiling of
// five is enforced where it is reached, and that "one refused leg stops the
// whole basket" is beside the ticks and not in the small print underneath.

import { ANDURIL_MINT, ANTHROPIC_MINT, CATALOGUE, FIGUREAI_MINT, OPENAI_MINT, PRESTOCKS_POWERS, SPYX_MINT, XSTOCKS_POWERS, isOfferable, offerProblems } from "@sip/solana-core/client";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { BasketPicker } from "@/components/wallets/BasketPicker";
import { PICKER_MAX_LEGS, type PickedRow } from "@/lib/basket-picker";
import { PICKER_COPY } from "@/lib/vault-copy";

const rows = (...picks: readonly (readonly [string, string])[]): PickedRow[] => picks.map(([mint, percent]) => ({ mint, percent }));

const DEFAULT = rows([SPYX_MINT, "50"], [ANTHROPIC_MINT, "50"]);

function render(props: Partial<Parameters<typeof BasketPicker>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(BasketPicker, {
      picked: DEFAULT,
      onPicked: () => undefined,
      blocked: false,
      problem: null,
      perBuyRaw: 149_000_000n,
      ...props,
    }),
  );
}

/** The one `<input>` carrying `id`, so "is it disabled" is asked of that control and not of the page. */
const control = (html: string, id: string): string => html.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`))?.[0] ?? "";

describe("BasketPicker", () => {
  it("shows every stock the catalogue knows about, and marks the ones that cannot be bought", () => {
    const html = render();
    for (const asset of CATALOGUE) {
      expect(html).toContain(asset.symbol);
      expect(control(html, `invest-pick-${asset.mint}`)).not.toBe("");
    }
    // XAI is absent from the catalogue because no PreStocks mint for it was
    // found to pin — an asset with nothing measured is not a row with blanks.
    expect(html).not.toContain("XAI");
  });

  it("gives a refused stock its REASONS, each with the reading behind it, rather than a grey row", () => {
    const html = render();
    // ANDURIL is off the shelf on its depth and its price at the reference
    // size; every rule it failed is on its tile, not just the first.
    const problems = offerProblems(CATALOGUE.find((asset) => asset.mint === ANDURIL_MINT)!);
    expect(problems.length).toBeGreaterThan(1);
    for (const failure of problems) expect(html).toContain(failure.why.replaceAll("'", "&#x27;"));
    expect(html).toContain(PICKER_COPY.notOffered);

    // AND IT CANNOT BE TICKED. The limit is enforced where it is reached, so
    // nobody meets it for the first time at Sign — or, worse, at the build
    // route, after the form has already said yes.
    for (const mint of [ANDURIL_MINT, OPENAI_MINT, FIGUREAI_MINT]) expect(control(html, `invest-pick-${mint}`)).toContain("disabled");
    // What IS offered stays tickable, so the attribute above means something.
    expect(control(html, `invest-pick-${SPYX_MINT}`)).not.toContain("disabled");
  });

  it("says a buy is all-or-nothing WHERE HE PICKS, above the first tick", () => {
    const html = render();
    expect(html).toContain("A buy takes the whole basket or none of it.");
    expect(html).toContain("nothing is bought, no SOL is converted");
    expect(html).toContain("The thinner the market you add, the more often that day comes.");
    // Above the list, not under it: the consequence of adding a thin stock has
    // to be readable before the tick, not after scrolling past nine of them.
    expect(html.indexOf("A buy takes the whole basket")).toBeLessThan(html.indexOf(`invest-pick-${SPYX_MINT}`));
  });

  it("dates every depth figure on the face of the tile, and never rounds a count into a promise", () => {
    const html = render();
    expect(html).toContain("2026-09-21");
    expect(html).toContain(PICKER_COPY.depthMeaning.replaceAll("'", "&#x27;"));
    expect(html).toContain("The keeper counts again inside every buy");
  });

  /**
   * THREE KINDS OF NUMBER, THREE DIFFERENT SENTENCES — because they were one
   * sentence, under a line calling them all counts.
   *
   * A route census counts the accounts one route names, which is what the
   * keeper's own gate counts. A venue-wide figure sums a book no single buy
   * reaches: on ANTHROPIC the two differed by forty-five times on the day both
   * were read, and FIGUREAI's "$50,000.00" is a whole venue's book rendered in
   * the same words as SPYx's counted route. And one census is worked back from
   * another day's measurement rather than taken at all.
   */
  it("says which KIND of reading each figure is, not just its day: a counted route, a whole book, or one worked out", () => {
    const html = render();
    // SPYx: a route census, counted over the pool's own USDC account.
    expect(html).toContain("held $201,151.98 where a buy would land, counted on 2026-09-21");
    // ANTHROPIC: a route census that was DERIVED, and says so.
    expect(html).toContain("worked out on 2026-09-21 rather than counted directly");
    // FIGUREAI: a venue-wide figure, which no single buy reaches.
    expect(html).toContain("held $50,000.00 across its whole book when it was read on 2026-09-21 — no single buy reaches all of that");
    // AND THE SENTENCE UNDER THE LIST NO LONGER CALLS THEM ALL COUNTS.
    expect(html).not.toContain("Those are counts taken on a named day");
    expect(html).toContain("they are not all the same kind");
  });

  it("offers the fix as a press, and only while it is needed", () => {
    // Exactly 100: nothing to repair, and no button inviting a repair.
    const exact = render({ picked: DEFAULT });
    expect(exact).toContain(PICKER_COPY.exact);
    expect(exact).not.toContain(PICKER_COPY.evenOut);

    // Short, over, and unreadable: each says what is wrong in the owner's own
    // units and offers the same one press.
    const short = render({ picked: rows([SPYX_MINT, "50"], [ANTHROPIC_MINT, "20"]) });
    expect(short).toContain("30 % left to give");
    expect(short).toContain(PICKER_COPY.evenOut);

    const over = render({ picked: rows([SPYX_MINT, "80"], [ANTHROPIC_MINT, "40"]) });
    expect(over).toContain("20 % too much");
    expect(over).toContain(PICKER_COPY.evenOut);

    const empty = render({ picked: rows([SPYX_MINT, ""], [ANTHROPIC_MINT, ""]) });
    expect(empty).toContain("100 % left to give");
    expect(empty).toContain(PICKER_COPY.evenOut);

    // An empty basket has no shares to even out, so the button is not offered
    // against nothing.
    const none = render({ picked: [] });
    expect(none).not.toContain(PICKER_COPY.evenOut);
  });

  it("stops the basket at five where it is reached, and says why the other ticks went quiet", () => {
    const full = rows([ANTHROPIC_MINT, "20"], ...Array.from({ length: PICKER_MAX_LEGS - 1 }, (_, index) => [`Filler${index}`, "20"] as const));
    const html = render({ picked: full });
    expect(html).toContain(`That is ${PICKER_MAX_LEGS}, the most a basket holds. Untick one to choose another.`);
    // The unticked ones go quiet; the ticked ones can still be untainted off,
    // or the basket could never be changed once it was full.
    expect(control(html, `invest-pick-${SPYX_MINT}`)).toContain("disabled");
    expect(control(html, `invest-pick-${ANTHROPIC_MINT}`)).not.toContain("disabled");
  });

  it("shows each chosen stock its share of a real buy, in dollars, from the cap in the box", () => {
    // $149 a buy at half each: $74.50 a leg. The share is not a proportion in
    // the abstract — it is what one leg is handed, which is the number the
    // per-leg minimum and the depth gate are both applied to.
    const html = render({ picked: DEFAULT, perBuyRaw: 149_000_000n });
    expect(html).toContain("SPYx takes 50 % of every buy — $74.50 out of a full one");
    expect(html).toContain("ANTHROPIC takes 50 % of every buy — $74.50 out of a full one");
    // With an unreadable cap there is no dollar figure to show, and none is invented.
    expect(render({ picked: DEFAULT, perBuyRaw: null })).not.toContain("out of a full one");
  });

  it("carries the share the owner typed, exactly, and only for the stocks he ticked", () => {
    const html = render({ picked: rows([SPYX_MINT, "07"]) });
    expect(control(html, `invest-weight-${SPYX_MINT}`)).toContain('value="07"');
    // An unticked stock has no share box at all — there is no such thing as a
    // leg held at 0 %, so there is nothing for it to hold.
    expect(control(html, `invest-weight-${ANTHROPIC_MINT}`)).toBe("");
  });

  it("goes quiet while another write is in the air, and speaks a problem given to it", () => {
    const html = render({ blocked: true, picked: rows([SPYX_MINT, "50"]) });
    expect(control(html, `invest-pick-${SPYX_MINT}`)).toContain("disabled");
    expect(control(html, `invest-weight-${SPYX_MINT}`)).toContain("disabled");

    const problem = render({ problem: "The shares must add up to exactly 100 %. These add up to 99 %." });
    expect(problem).toContain('role="alert"');
    expect(problem).toContain("These add up to 99 %.");
  });

  it("names both issuers' powers once, as a group fact, not once per stock", () => {
    const html = render();
    // The stronger claim is the xStocks one, and it is stated with its
    // mechanism rather than as a promise: extensions are fixed at
    // initialisation, so no key anywhere can add a fee later.
    expect(html).toContain("no key anywhere able to add one");
    expect(html).toContain("a Token-2022 mint cannot gain one after it is made");
    // AND IT IS SAID OF THE MINTS SOMEBODY READ. 929 xStock mints exist and one
    // was read, so the plural was a promise about 928 unopened accounts — true
    // today only because SPYx is the sole xStock on the shelf, and applied
    // unchanged to the next one added. PreStocks earns its plural: all eight.
    expect(html).toContain("xStocks (read here: SPYx)");
    expect(html).toContain("this is not a promise about the rest of the range");
    expect(XSTOCKS_POWERS.mintsRead).toEqual(["SPYx"]);
    expect(PRESTOCKS_POWERS.by).toContain("the eight PreStocks mints");
    expect(html).toContain("The issuer still holds freeze, pause and a permanent delegate");
    // And the PreStocks fee is at SaverFi's own limit, with what that means.
    expect(html).toContain("one more raise and the whole basket stops");
    // Once each, however many stocks share the fact.
    expect(html.split("one more raise and the whole basket stops")).toHaveLength(2);
    expect(CATALOGUE.filter((asset) => !isOfferable(asset)).length).toBeGreaterThan(1);
  });
});
