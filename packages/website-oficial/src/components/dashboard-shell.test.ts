// The dashboard frame rendered to HTML in each state Privy and the URL can put
// it in — the owner's rule, checked: a connected pension key can never reach the
// sample, and the Live|Mock choice is gone while one is connected.
//
// Privy is mocked the way WalletsScreen.test.ts mocks it, next/navigation is
// mocked for the URL, and the live store is a stub: this test is about WHICH
// body renders, not about reading Solana.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PENSION_KEY, TRADING_0, embedded, phantom, userWith } from "../../test/fixtures/privy-user";

const mocked = vi.hoisted(() => ({
  privy: { ready: true, authenticated: false, user: null as unknown },
  search: new URLSearchParams(),
  pathname: "/",
  replaced: [] as string[],
  pushed: [] as string[],
  live: { kind: "loading" } as { kind: string; message?: string; retryAt?: number | null; data?: unknown },
}));

vi.mock("@privy-io/react-auth", () => ({
  usePrivy: () => ({ ...mocked.privy, login: vi.fn(), logout: vi.fn() }),
  useLogin: () => ({ login: vi.fn() }),
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => mocked.search,
  usePathname: () => mocked.pathname,
}));

vi.mock("@/hooks/use-live-dashboard", () => ({
  useLiveDashboard: () => ({ view: mocked.live, refresh: vi.fn(), loadOlder: vi.fn(), older: { busy: false, retryAt: null, message: null, complete: false } }),
}));

// The landing is a video-and-scroll page of its own; this test only needs to
// know WHEN it is chosen.
vi.mock("@/components/landing", () => ({ Landing: () => createElement("div", null, "LANDING") }));
// recharts draws on a ResizeObserver, which node has none of.
vi.mock("@/components/pension-chart", () => ({ PensionChart: () => createElement("div", null, "CHART") }));

import { DashboardFrame, DashboardView, type DashboardLoadJson } from "@/components/dashboard-shell";
import { TooltipProvider } from "@/components/ui/tooltip";
import { usd } from "@/lib/format";
import { mock } from "@/mocks";

const SAMPLE: DashboardLoadJson = { source: "mock", data: mock, notice: null };

/** A figure that exists only in the seeded example, and is rendered without a chart. */
const MOCK_FIGURE = usd(mock.wallet.balanceUsd);

function render(walletsConfigured = true, view: "pension" | "activity" = "pension"): string {
  return renderToStaticMarkup(
    createElement(
      TooltipProvider,
      null,
      createElement(DashboardFrame, { mock: SAMPLE, walletsConfigured, children: createElement(DashboardView, { view }) }),
    ),
  );
}

/** The Live|Mock control, as the header renders it. */
const tablist = (html: string): string | null => html.match(/<div[^>]*role="tablist"[^>]*>[\s\S]*?<\/div>/)?.[0] ?? null;

/**
 * One trigger of that control, found BY ITS LABEL. Radix consumes `value` as a
 * React prop and never forwards it to the DOM, so there is no value="live"
 * attribute to match on — only the text a person actually reads.
 */
const trigger = (html: string, label: "Live" | "Mock"): string =>
  html.match(new RegExp(`<button[^>]*data-slot="tabs-trigger"[^>]*>\\s*${label}\\s*</button>`))?.[0] ?? "";

/**
 * Whether a rendered tag carries a real `disabled` ATTRIBUTE (React writes
 * disabled=""). The class list is stripped first: Tailwind's own
 * `disabled:pointer-events-none` variants put the word "disabled" in every
 * trigger's class, so a substring search would call an enabled tab disabled.
 */
const isDisabled = (tag: string): boolean => /\sdisabled[=\s>]/.test(tag.replace(/\sclass="[^"]*"/g, ""));

beforeEach(() => {
  mocked.privy = { ready: true, authenticated: false, user: null };
  mocked.search = new URLSearchParams();
  mocked.pathname = "/";
  mocked.live = { kind: "loading" };
});

describe("before Privy answers, the sample is never painted", () => {
  it("?mode=mock renders a skeleton — no sample figures, no badge, no toggle", () => {
    mocked.privy = { ready: false, authenticated: false, user: null };
    mocked.search = new URLSearchParams("mode=mock");
    const html = render();

    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain("Sample data");
    expect(html).not.toContain(MOCK_FIGURE);
    expect(html).not.toContain("Sold HOODx");
    // The choice is not offered before there is anything to choose between.
    expect(tablist(html)).toBeNull();
  });

  it("the front door still opens without waiting: it holds no numbers", () => {
    mocked.privy = { ready: false, authenticated: false, user: null };
    const html = render();
    expect(html).toContain("LANDING");
  });
});

describe("nobody connected", () => {
  it("Mock shows the sample under its badge, and Live is a real choice — not a disabled one", () => {
    mocked.search = new URLSearchParams("mode=mock");
    const html = render();

    expect(html).toContain("Sample data");
    expect(html).toContain(MOCK_FIGURE);
    expect(tablist(html)).not.toBeNull();
    // Live is reachable now: it shows the connect card, so it is never greyed out.
    expect(trigger(html, "Live")).not.toBe("");
    expect(isDisabled(trigger(html, "Live"))).toBe(false);
    expect(trigger(html, "Mock")).toContain('data-state="active"');
  });

  it("Live asks for a pension key and shows NO sample numbers", () => {
    mocked.search = new URLSearchParams("mode=live");
    const html = render();

    expect(html).toContain("Connect your pension key");
    expect(html).not.toContain("Sample data");
    expect(html).not.toContain(MOCK_FIGURE);
    expect(html).not.toContain("Sold HOODx");
    // …and the choice is still offered, so Mock is one click away.
    expect(trigger(html, "Live")).toContain('data-state="active"');
  });
});

describe("a connected pension key", () => {
  beforeEach(() => {
    mocked.privy = { ready: true, authenticated: true, user: userWith([phantom(), embedded(TRADING_0, 0, true)]) };
  });

  it("?mode=mock CANNOT force the sample: it is Live, the toggle is gone, and the URL is normalized", () => {
    mocked.search = new URLSearchParams("mode=mock");
    const html = render();

    expect(html).not.toContain("Sample data");
    expect(html).not.toContain(MOCK_FIGURE);
    expect(html).not.toContain("Sold HOODx");
    // The owner's rule: the choice disappears from the navbar.
    expect(tablist(html)).toBeNull();
    // The live body, waiting on its first read — never the example.
    expect(html).toContain('aria-busy="true"');
  });

  it("wears the pension key and a Disconnect, never a Connect", () => {
    mocked.search = new URLSearchParams("mode=live");
    const html = render();
    expect(html).toContain("Disconnect");
    expect(html).toContain(PENSION_KEY.slice(0, 4));
    expect(html).toContain(`https://solscan.io/account/${PENSION_KEY}`);
    expect(html).not.toContain("Connect pension key");
  });

  it("is Live on /activity too, with the same rule", () => {
    mocked.pathname = "/activity";
    mocked.search = new URLSearchParams("mode=mock");
    const html = render(true, "activity");
    expect(tablist(html)).toBeNull();
    expect(html).not.toContain("Sample data");
  });

  it("says it could not read, rather than showing a sample or an empty pension", () => {
    mocked.search = new URLSearchParams("mode=live");
    mocked.live = { kind: "unreadable", message: "SaverFi could not read your pension on Solana just now.", retryAt: null };
    const html = render();
    expect(html).toContain("could not read your pension");
    expect(html).not.toContain("Sample data");
    expect(html).not.toContain(MOCK_FIGURE);
  });
});

describe("a session with no pension key", () => {
  beforeEach(() => {
    mocked.privy = { ready: true, authenticated: true, user: userWith([embedded(TRADING_0, 0, true)]) };
  });

  it("KEEPS the toggle, and offers the one control that helps", () => {
    mocked.search = new URLSearchParams("mode=live");
    const html = render();
    expect(html).toContain("This session has no pension key");
    expect(html).toContain("Disconnect");
    expect(tablist(html)).not.toBeNull();
  });

  it("on Mock, says WHY the numbers are an example", () => {
    mocked.search = new URLSearchParams("mode=mock");
    const html = render();
    expect(html).toContain("Sample data");
    expect(html).toContain("This session has no Solana wallet");
  });
});

describe("a deployment with no Solana configuration", () => {
  it("never waits for a Privy that will never mount, and offers the setup instead", () => {
    mocked.privy = { ready: false, authenticated: false, user: null };
    mocked.search = new URLSearchParams("mode=live");
    const html = render(false);

    expect(html).not.toContain('aria-busy="true"');
    expect(html).toContain("Live data is not available on this deployment yet.");
    expect(html).toContain("Connect");
  });

  it("still shows the sample on Mock, because the example needs no configuration", () => {
    mocked.privy = { ready: false, authenticated: false, user: null };
    mocked.search = new URLSearchParams("mode=mock");
    const html = render(false);
    expect(html).toContain("Sample data");
    expect(html).toContain(MOCK_FIGURE);
  });
});
