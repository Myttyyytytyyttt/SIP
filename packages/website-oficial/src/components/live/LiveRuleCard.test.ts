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
      mocked.buttons.push({ label: mocked.textOf(props.children).trim(), onClick: props.onClick as unknown as ((event: unknown) => void) | undefined });
      return actual.Button(props);
    },
  };
});

import { LiveRuleCard } from "@/components/live/LiveRuleCard";
import { LIVE_COPY } from "@/lib/live-copy";
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

  it("sends the one control it has to the modal, where the verified flows live", () => {
    render();
    expect(buttons(LIVE_COPY.manageInWallets)).toHaveLength(1);
    buttons(LIVE_COPY.manageInWallets)[0]?.onClick?.({ type: "click" });
    expect(onOpenWallets).toHaveBeenCalledTimes(1);
  });
});

describe("what the chain says the rule is", () => {
  it("reads the vault's mode, its cap and its reserve", () => {
    const html = render();
    expect(html).toContain(LIVE_COPY.modeProfit("20 %"));
    expect(html).toContain(LIVE_COPY.mostPerSettlement("0.06"));
    expect(html).toContain(LIVE_COPY.alwaysLeft("0.05"));
  });

  it("shows the basket and what it buys at", () => {
    const html = render();
    expect(html).toContain("SPYx · 100 %");
    expect(html).toContain(INVEST_COPY.buysEach("$5.00"));
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
