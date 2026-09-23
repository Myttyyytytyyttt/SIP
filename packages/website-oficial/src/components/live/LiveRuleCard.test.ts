// The rule card is READ-ONLY, and this is the test that keeps it so. The mock's
// panel has a slider, a threshold box, a pause switch and an "Update rule"
// button, every one of which changes nothing. On a live pension that is a lie
// about somebody's money, so none of them may appear here.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => {
  function textOf(node: unknown): string {
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (Array.isArray(node)) return node.map(textOf).join("");
    if (typeof node === "object" && node !== null && "props" in node) return textOf((node as { props: { children?: unknown } }).props.children);
    return "";
  }
  return { textOf, buttons: [] as { label: string; onClick: ((event: unknown) => void) | undefined }[] };
});

vi.mock("@/components/ui/button", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui/button")>();
  return {
    ...actual,
    Button: (props: Parameters<typeof actual.Button>[0]) => {
      // An icon button has no children to read, so its accessible name stands
      // in for the label — that is what a person is offered either way.
      const text = mocked.textOf(props.children).trim();
      const label = text === "" ? String((props as { "aria-label"?: string })["aria-label"] ?? "") : text;
      mocked.buttons.push({ label, onClick: props.onClick as unknown as ((event: unknown) => void) | undefined });
      return actual.Button(props);
    },
  };
});

import { LiveRuleCard } from "@/components/live/LiveRuleCard";
import { ACTIVITY_COPY, LIVE_COPY } from "@/lib/live-copy";
import type { LiveDashboard } from "@/lib/live-types";
import { INVEST_COPY } from "@/lib/vault-copy";

import { liveDashboard, liveSnapshot, policyState } from "../../../test/fixtures/live-dashboard";

const onOpenWallets = vi.fn();
const labelOf = (): string => "Trading wallet 1";

function render(data: LiveDashboard = liveDashboard()): string {
  mocked.buttons.length = 0;
  onOpenWallets.mockClear();
  return renderToStaticMarkup(createElement(LiveRuleCard, { data, labelOf, onOpenWallets }));
}

const buttons = (label: string) => mocked.buttons.filter((button) => button.label === label);

beforeEach(() => {
  mocked.buttons.length = 0;
});

describe("nothing here pretends to set the rule", () => {
  it("has no slider, no switch, no threshold box and no Update rule", () => {
    const html = render();
    expect(html).not.toContain('role="slider"');
    expect(html).not.toContain('data-slot="switch"');
    expect(html).not.toContain("Update rule");
    // No form control of any kind: the rule is changed by a signature, elsewhere.
    expect(html).not.toContain("<input");
  });

  /**
   * THE GEAR IS THE DOOR, and it is the only one. Every change to any of this
   * is a signed set_policy_v2 or set_invest_policy, and all of them live in
   * the wallets modal — so the card carries one control and it opens that.
   */
  it("sends its one control to the modal, where the verified flows live", () => {
    render();
    const gear = buttons(LIVE_COPY.ruleSettings);
    expect(gear).toHaveLength(1);
    gear[0]?.onClick?.({ type: "click" });
    expect(onOpenWallets).toHaveBeenCalledTimes(1);
  });

  /** An icon with no words is nothing to a screen reader without one. */
  it("gives that gear a name, since it has no label", () => {
    expect(render()).toContain(LIVE_COPY.ruleSettings);
  });
});

describe("what the chain says the rule is", () => {
  it("reads the vault's rate, which of its two fields it is, its cap and its reserve", () => {
    const html = render();
    expect(html).toContain(LIVE_COPY.rateOf(ACTIVITY_COPY.measureProfit));
    expect(html).toContain("20%");
    expect(html).toContain(LIVE_COPY.mostPerSettlement("0.06"));
    expect(html).toContain(LIVE_COPY.alwaysLeft("0.05"));
  });

  /**
   * THE TRACK IS THE MODE'S OWN RANGE. The program allows a profit rate up to
   * 100 % and a volume rate up to 2 %, so the same figure is a sliver of one
   * track and the whole of the other — and the far end is printed, because a
   * bar with no scale is a fraction of nothing.
   */
  it("scales the bar to what the PROGRAM allows this mode, and says where the track ends", () => {
    // The indicator is translated by (100 - value)%, so the fill IS the number.
    const profit = render();
    expect(profit).toContain("translateX(-80%)");
    expect(profit).toContain("100%");

    const base = liveSnapshot();
    const volume = render(
      liveDashboard({ snapshot: { ...base, vault: { ...base.vault, state: { ...base.vault.state!, skimMode: 1, volumeBps: 200 } } } }),
    );
    expect(volume).toContain(LIVE_COPY.rateOf(ACTIVITY_COPY.measureVolume));
    // 2 % of a 2 % track is the whole of it.
    expect(volume).toContain("translateX(-0%)");
  });

  it("lists the basket with a mark and a weight per leg, as the sample does", () => {
    const html = render();
    expect(html).toContain(LIVE_COPY.investsIn);
    expect(html).toContain("SPYx");
    expect(html).toContain("100%");
  });

  /**
   * THE CAPS, NOT THE SPEND. "Used in the last 30 days" is a figure that moves
   * on its own, and it has a tile in the stats grid where it is printed over
   * the cap it is a fraction of. Printed here as well it carried no
   * denominator, and two places holding one number is two places that can come
   * to disagree — so the card keeps only what somebody signed.
   */
  it("shows the two signed caps and leaves the spend against them to its own tile", () => {
    const html = render();
    expect(html).toContain(INVEST_COPY.mostPerBuy);
    expect(html).toContain(INVEST_COPY.mostPer30Days);
    expect(html).not.toContain(INVEST_COPY.usedLast30);
  });

  /**
   * NO THRESHOLD FIGURE ON THIS CARD. min_investment is enforced PER LEG, so a
   * basket of two at $5 does not buy at $5; "Next investment" reads
   * investsAtRaw, which is the balance that actually unblocks a buy.
   */
  it("states no threshold of its own, so the card cannot disagree with itself", () => {
    const html = render();
    expect(html).not.toContain(INVEST_COPY.buysEach("$5.00"));
    expect(html).toContain(LIVE_COPY.nextInvestment);
  });
});

describe("what is not set up is said, never zeroed", () => {
  it("a missing policy offers to set investing up, and shows no $0 of $5", () => {
    const html = render(liveDashboard({ snapshot: liveSnapshot({ policy: { status: "missing", address: "p" } }) }));
    expect(html).toContain(LIVE_COPY.investingNotSetUp);
    expect(buttons(LIVE_COPY.setUpInvesting)).toHaveLength(1);
    expect(html).not.toContain(LIVE_COPY.nextInvestment);
    expect(html).not.toContain(LIVE_COPY.lastInvestment);
  });

  it("a policy that could not be READ is never treated as missing", () => {
    const html = render(liveDashboard({ snapshot: liveSnapshot({ policy: { status: "unreadable", address: "p" } }) }));
    expect(html).toContain(LIVE_COPY.policyUnreadable);
    expect(html).not.toContain(LIVE_COPY.investingNotSetUp);
    expect(buttons(LIVE_COPY.setUpInvesting)).toHaveLength(0);
  });

  it("a paused vault says what that stops, and offers no button that cannot work", () => {
    const snapshot = liveSnapshot();
    const html = render(
      liveDashboard({ snapshot: liveSnapshot({ vault: { ...snapshot.vault, state: { ...snapshot.vault.state!, paused: true } } }) }),
    );
    expect(html).toContain(LIVE_COPY.vaultPausedBadge);
    expect(html).toContain(LIVE_COPY.vaultPaused);
  });

  it("paused investing says savings stay as SOL, and offers Resume", () => {
    const html = render(
      liveDashboard({ snapshot: liveSnapshot({ policy: { status: "exists", address: "p", state: policyState({ enabled: false }) } }) }),
    );
    expect(html).toContain(LIVE_COPY.investingPausedNote);
    expect(buttons(LIVE_COPY.resumeInvesting)).toHaveLength(1);
  });

  it("says when no investment is in the loaded history, rather than showing nothing", () => {
    expect(render()).toContain(LIVE_COPY.noInvestmentLoaded);
  });
});
