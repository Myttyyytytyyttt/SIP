// The dashboard frame rendered to HTML in each state Privy and the URL can put
// it in — the owner's rule, checked: a connected pension key can never reach the
// sample, and the Live|Mock choice is gone while one is connected — except a key
// with no vault that closed its new-user setup, which sees the visitor's sample.
//
// Privy is mocked the way WalletsScreen.test.ts mocks it, next/navigation is
// mocked for the URL, and the live store is a stub: this test is about WHICH
// body renders, not about reading Solana.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PENSION_KEY, TRADING_0, embedded, phantom, userWith } from "../../test/fixtures/privy-user";
import { liveDashboard, liveSnapshot } from "../../test/fixtures/live-dashboard";

const mocked = vi.hoisted(() => ({
  privy: { ready: true, authenticated: false, user: null as unknown },
  search: new URLSearchParams(),
  pathname: "/",
  replaced: [] as string[],
  pushed: [] as string[],
  live: { kind: "loading" } as { kind: string; message?: string; retryAt?: number | null; data?: unknown; stale?: unknown },
  /** Whether this tab closed the setup (the real hook reads sessionStorage, which node has none of). */
  closed: false,
  /** What the frame handed the setup's host on the last render. */
  host: null as { wanted: boolean; pensionKey: string } | null,
}));

// No stocks choice in this browser: the start-buying card (its own test's subject) never mounts here.
vi.mock("@/hooks/use-onboarding-closed", () => ({ useOnboardingClosed: () => mocked.closed, useBasketChoice: () => null }));
// The host signs through Privy's wallet hooks; its own screens are OnboardingBody.test.ts's subject.
// Here only what the frame hands it matters.
vi.mock("@/components/onboarding/OnboardingHost", () => ({
  OnboardingHost: (props: { wanted: boolean; pensionKey: string }) => {
    mocked.host = { wanted: props.wanted, pensionKey: props.pensionKey };
    return createElement("div", { "data-setup": props.wanted ? "wanted" : "not-wanted" });
  },
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
  useLiveDashboard: () => ({
    view: mocked.live,
    refresh: vi.fn(),
    loadOlder: vi.fn(),
    older: { busy: false, retryAt: null, message: null, complete: false, available: false },
    activityUnreadable: false,
  }),
}));

// The landing is a video-and-scroll page of its own; this test only needs to
// know WHEN it is chosen.
vi.mock("@/components/landing", () => ({ Landing: () => createElement("div", null, "LANDING") }));
// recharts draws on a ResizeObserver, which node has none of.
// The rule card's gear signs through Privy's wallet hooks, which these tests do
// not provide; its own signing is LiveRulePanel.test.ts's subject. Here it is the
// shared card with a closed gear, so the page's markup stays real.
vi.mock("@/components/live/LiveRulePanel", async () => {
  const { SavingsRulePanel } = await import("@/components/savings-rule-panel");
  const closed = { open: false, onOpen: () => undefined, attention: false };
  return {
    LiveRulePanel: (props: Parameters<typeof SavingsRulePanel>[0]) => createElement(SavingsRulePanel, { ...props, settings: closed }),
  };
});
vi.mock("@/components/pension-chart", () => ({ PensionChart: () => createElement("div", null, "CHART") }));

import { DashboardFrame, DashboardView, type DashboardLoadJson } from "@/components/dashboard-shell";
import { TooltipProvider } from "@/components/ui/tooltip";
import { VaultScreenContext, type VaultScreenValue, type VaultView } from "@/hooks/use-vault-state";
import type { VaultApi, VaultStateJson } from "@/lib/vault-api";
import { shortAddress } from "@/lib/vault-copy";
import { usd } from "@/lib/format";
import { ACTIVITY_COPY, LIVE_COPY } from "@/lib/live-copy";
import { mock } from "@/mocks";

const SAMPLE: DashboardLoadJson = { source: "mock", data: mock, notice: null };

/** A figure that exists only in the seeded example, and is rendered without a chart. */
const MOCK_FIGURE = usd(mock.wallet!.balanceUsd);

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

/** The frame under the page's shared vault screen, as wallets-host mounts it for a connected key. */
function renderWithVault(view: VaultView, page: "pension" | "activity" = "pension"): string {
  const screen: VaultScreenValue = { pensionKey: PENSION_KEY, view, refresh: vi.fn(), api: {} as VaultApi };
  return renderToStaticMarkup(
    createElement(
      TooltipProvider,
      null,
      createElement(VaultScreenContext.Provider, { value: screen }, createElement(DashboardFrame, { mock: SAMPLE, walletsConfigured: true, children: createElement(DashboardView, { view: page }) })),
    ),
  );
}

const vaultRead = (status: "missing" | "exists" | "unreadable"): VaultView => ({ kind: "ready", state: { owner: PENSION_KEY, vault: { status, address: "v" } } as unknown as VaultStateJson });

beforeEach(() => {
  mocked.privy = { ready: true, authenticated: false, user: null };
  mocked.search = new URLSearchParams();
  mocked.pathname = "/";
  mocked.live = { kind: "loading" };
  mocked.closed = false;
  mocked.host = null;
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

/**
 * MOVING AROUND THE SAMPLE (owner, 09-24). A bare "/" is the landing and a bare
 * "/activity" is Live's connect card, so a tab without the mode threw a visitor
 * out of the example on their first click.
 */
describe("the sample keeps the visitor in it", () => {
  /** Every href on the page that points at one of the app's own pages. */
  const hrefsTo = (html: string, pathname: string): string[] => [...html.matchAll(new RegExp(`href="(${pathname.replace("/", "\\/")}(?:\\?[^"]*)?)"`, "g"))].map((m) => m[1]!);

  it("carries ?mode=mock on every tab and footer link to the app's pages", () => {
    mocked.search = new URLSearchParams("mode=mock");
    const html = render();
    for (const pathname of ["/activity", "/leaderboard"]) {
      const hrefs = hrefsTo(html, pathname);
      expect(hrefs.length, pathname).toBeGreaterThan(0);
      for (const href of hrefs) expect(href, pathname).toBe(`${pathname}?mode=mock`);
    }
    expect(html).toContain('href="/?mode=mock"');
    expect(html).not.toMatch(/href="\/"/);
  });

  it("carries ?mode=live from Live's connect card, so Pension is not the landing", () => {
    mocked.search = new URLSearchParams("mode=live");
    const html = render();
    expect(html).toContain('href="/?mode=live"');
    expect(html).toContain('href="/activity?mode=live"');
  });

  it("on /activity shows the history full width — not the pension page with another tab underlined", () => {
    mocked.pathname = "/activity";
    mocked.search = new URLSearchParams("mode=mock");
    const html = render(true, "activity");
    // Still the sample, still labelled as one.
    expect(html).toContain("Sample data");
    // The activity page: its filters and its full-width list, with the sample's own rows.
    expect(html).toContain(`aria-label="${ACTIVITY_COPY.filterLabel}"`);
    expect(html).toContain('id="activity-page"');
    // The pension page's cards are not drawn under it.
    expect(html).not.toContain("Savings rule");
    expect(html).not.toContain("CHART");
    // Every row the sample has is on this page: its coverage is the live page's "complete", not a date.
    expect(html).toContain(ACTIVITY_COPY.complete);
  });

  it("keeps the mode on the links while the skeleton waits for Privy", () => {
    mocked.privy = { ready: false, authenticated: false, user: null };
    mocked.search = new URLSearchParams("mode=mock");
    const html = render();
    expect(html).toContain('href="/activity?mode=mock"');
  });

  it("on / is still the pension page", () => {
    mocked.search = new URLSearchParams("mode=mock");
    const html = render();
    expect(html).toContain("Savings rule");
    expect(html).not.toContain('id="activity-page"');
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
    // THE CHIP NO LONGER LINKS TO SOLSCAN. It was the third way to the same
    // explorer from this screen; its place went to what the pension is worth,
    // which here is still unread — so the chip shows the key and nothing else.
    expect(html).not.toContain(`https://solscan.io/account/${PENSION_KEY}`);
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

describe("a connected pension key, once the chain has answered", () => {
  beforeEach(() => {
    mocked.privy = { ready: true, authenticated: true, user: userWith([phantom(), embedded(TRADING_0, 0, true)]) };
    mocked.search = new URLSearchParams("mode=live");
    mocked.live = { kind: "ready", data: liveDashboard(), stale: null };
  });

  it("carries what the pension is worth in the bar, from the same read as the card", () => {
    const html = render();
    // The header chip and the pension card cannot disagree: both are drawn
    // from this one snapshot, so the number appears at least twice.
    const worth = html.match(/\$[\d,]+\.\d\d/g) ?? [];
    expect(worth.length).toBeGreaterThan(1);
    expect(new Set(worth).size).toBeLessThan(worth.length + 1);
  });

  /**
   * THE HERO IS THE DOLLAR AND THE CAPTION IS THE SOL, which is the sample's
   * shape. The dollar is a VALUATION of the lamports the vault records, at the
   * price read in the same snapshot — never a sum of the dollars that were set
   * aside, which happened at prices nobody recorded.
   *
   * This used to assert only that "0.06 SOL" was somewhere in the markup, and
   * the stats tiles satisfied that on their own: it would have passed whatever
   * the hero did. Both halves are named now.
   */
  it("shows THEIR pension: the hero in dollars, the exact SOL beside it, and not one figure from the example", () => {
    const html = render();
    expect(html).toContain(LIVE_COPY.savedSoFar);
    // 0.06 SOL at the fixture's $100.038711 a SOL.
    expect(html).toContain("$6.00");
    // The chain's own figure, in full, in the caption — not a rounding of it.
    expect(html).toContain(LIVE_COPY.heroSolAtPrice("0.06"));
    // And no second dollar beside the hero to be subtracted from it.
    expect(html).not.toContain(LIVE_COPY.worthNowTooltip);
    expect(html).not.toContain("Sample data");
    expect(html).not.toContain(MOCK_FIGURE);
    expect(html).not.toContain("Sold HOODx");
    expect(tablist(html)).toBeNull();
  });

  it("links every landed movement to Solscan, and shows no invented trade", () => {
    const html = render();
    expect(html).toMatch(/href="https:\/\/solscan\.io\/tx\//);
    expect(html).not.toMatch(/\bSold\b/);
    expect(html).not.toContain("Funded wallet");
  });

  it("wears the last contributions in the bar on /activity, and never on the pension", () => {
    // AWAY FROM THE PENSION ONLY: there the same settlements are already on
    // screen in full, and repeating them in the chrome is noise.
    mocked.pathname = "/";
    expect(render()).not.toContain('aria-label="Recent contributions"');
    mocked.pathname = "/activity";
    const html = render(true, "activity");
    expect(html).toContain('aria-label="Recent contributions"');
    // A chip carries what MOVED, and the strip fades at both edges rather than
    // cutting a half-shown one.
    expect(html).toMatch(/\+[\d.]+\s*<span[^>]*>SOL<\/span>/);
    expect(html).toContain("mask-image");
  });

  it("renders the history full width on /activity, under the same rule", () => {
    mocked.pathname = "/activity";
    const html = render(true, "activity");
    expect(html).toMatch(/href="https:\/\/solscan\.io\/tx\//);
    expect(tablist(html)).toBeNull();
    expect(html).not.toContain(MOCK_FIGURE);
  });

  it("a vault that could not be READ is never offered a Create button", () => {
    // A 200 whose vault is unreadable says nothing about whether one exists, so
    // the frame shows the unreadable card rather than an offer to create one.
    mocked.live = { kind: "ready", data: liveDashboard({ snapshot: liveSnapshot({ vault: { status: "unreadable", address: "v" } }) }), stale: null };
    const html = render();
    expect(html).not.toContain(LIVE_COPY.noVault.create);
    expect(html).toContain("could not read");
    // AND NO FIGURE IN THE BAR. Prices and token accounts still read fine on a
    // partial failure, so "the snapshot is ready" put a dollar amount in the
    // header of the very screen that says the pension could not be read — two
    // answers to one question, on one screen.
    expect(html).not.toMatch(/\$[\d,]+\.\d\d/);
  });
});

describe("a connected key with no vault: the new-user setup", () => {
  beforeEach(() => {
    mocked.privy = { ready: true, authenticated: true, user: userWith([phantom()]) };
  });

  it("is wanted over the Live page, which stays Live underneath — no sample, no toggle", () => {
    mocked.search = new URLSearchParams("mode=live");
    const html = renderWithVault(vaultRead("missing"));
    expect(mocked.host).toEqual({ wanted: true, pensionKey: PENSION_KEY });
    expect(html).toContain('data-setup="wanted"');
    expect(html).not.toContain("Sample data");
    expect(tablist(html)).toBeNull();
    expect(html).toContain("Disconnect");
  });

  it("is not wanted once the live read shows a vault's stages, even if the vault read is behind", () => {
    mocked.search = new URLSearchParams("mode=live");
    mocked.live = { kind: "ready", data: liveDashboard({ snapshot: liveSnapshot({ wallets: [] }), privyWallets: [] }), stale: null };
    renderWithVault(vaultRead("missing"));
    expect(mocked.host?.wanted).toBe(false);
  });

  it("is never mounted for a key the vault screen is not reading", () => {
    mocked.search = new URLSearchParams("mode=live");
    render();
    expect(mocked.host).toBeNull();
  });

  it("once closed, the page is the visitor's sample: its badge, the toggle on Mock, and Connect instead of Disconnect", () => {
    mocked.closed = true;
    mocked.search = new URLSearchParams("mode=mock");
    const html = renderWithVault(vaultRead("missing"));
    expect(html).toContain("Sample data");
    expect(html).toContain(MOCK_FIGURE);
    expect(trigger(html, "Mock")).toContain('data-state="active"');
    expect(html).toMatch(/<button[^>]*>Connect<\/button>/);
    expect(html).not.toContain("Disconnect");
    // No key chip: its short address is nowhere ("Pens…" alone would match the Pension tab).
    expect(html).not.toContain(shortAddress(PENSION_KEY));
    expect(mocked.host?.wanted).toBe(false);
  });

  it("the same on /activity", () => {
    mocked.closed = true;
    mocked.pathname = "/activity";
    mocked.search = new URLSearchParams("mode=mock");
    const html = renderWithVault(vaultRead("missing"), "activity");
    expect(html).toContain("Sample data");
    expect(tablist(html)).not.toBeNull();
  });

  it("closed, but the vault read has not answered: a skeleton — neither the sample nor a pension", () => {
    mocked.closed = true;
    mocked.search = new URLSearchParams("mode=mock");
    const html = renderWithVault({ kind: "loading" });
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain("Sample data");
    expect(tablist(html)).toBeNull();
    // Rule 4b's own markup, which Live would not have: the account slot is a placeholder, not the key and Disconnect.
    expect(html).toContain(LIVE_COPY.checking);
    expect(html).not.toContain("Disconnect");
  });

  it("a close that is out of date — the vault exists, or its read failed — is Live, never the sample", () => {
    mocked.closed = true;
    mocked.search = new URLSearchParams("mode=mock");
    for (const status of ["exists", "unreadable"] as const) {
      const html = renderWithVault(vaultRead(status));
      expect(html).not.toContain("Sample data");
      expect(html).not.toContain(MOCK_FIGURE);
      expect(tablist(html)).toBeNull();
      // Live's own markup, which rule 4b's skeleton would not have: the key and its Disconnect.
      expect(html).toContain("Disconnect");
      expect(html).toContain(shortAddress(PENSION_KEY));
    }
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
