// The bar on the PUBLIC page, in each state Privy can put it in.
//
// This component exists so that somebody who is already connected sees the same
// bar on /leaderboard as inside the app — their key, what it is worth, and the
// way out. What it must never do is claim a figure it does not have, or show a
// session to somebody who has none.
//
// Privy and the live store are mocked the way dashboard-shell.test.ts mocks
// them: this is about WHICH bar renders, not about reading Solana.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PENSION_KEY, embedded, phantom, userWith } from "../../test/fixtures/privy-user";
import { liveDashboard, liveSnapshot } from "../../test/fixtures/live-dashboard";

const mocked = vi.hoisted(() => ({
  privy: { ready: true, authenticated: false, user: null as unknown },
  live: { kind: "loading" } as { kind: string; data?: unknown; stale?: unknown },
  logouts: 0,
}));

vi.mock("@privy-io/react-auth", () => ({
  usePrivy: () => ({
    ...mocked.privy,
    login: vi.fn(),
    logout: () => {
      mocked.logouts += 1;
    },
  }),
}));

vi.mock("@/hooks/use-live-dashboard", () => ({
  useLiveDashboard: () => ({
    view: mocked.live,
    refresh: vi.fn(),
    loadOlder: vi.fn(),
    older: { busy: false, retryAt: null, message: null, complete: false },
    activityUnreadable: false,
  }),
}));

// The provider mounts the real Privy SDK; this test is about what is inside it.
vi.mock("@/app/providers", () => ({ default: ({ children }: { children: unknown }) => children }));

import { LeaderboardAccount } from "@/components/leaderboard-account";
import { TooltipProvider } from "@/components/ui/tooltip";

const CONFIG = {
  privyAppId: "app-id-0000000000000000",
  privyClientId: null,
  privySignerId: null,
  privyPolicyId: null,
  solanaRpcUrl: "/api/solana-rpc",
  solanaWsUrl: "wss://example.test",
  programId: "6kA9H9zQT6PW5xWkXoAFCS3NotxarzaYqj66mjMf9w4J",
  explorer: "solscan",
} as const;

const render = (): string =>
  renderToStaticMarkup(
    createElement(TooltipProvider, null, createElement(LeaderboardAccount, { config: CONFIG as never })),
  );

beforeEach(() => {
  mocked.privy = { ready: true, authenticated: false, user: null };
  mocked.live = { kind: "loading" };
  mocked.logouts = 0;
});

describe("before Privy answers", () => {
  it("shows a placeholder, never a control that cannot act yet", () => {
    mocked.privy = { ready: false, authenticated: false, user: null };
    const html = render();
    expect(html).toContain("animate-pulse");
    expect(html).not.toContain("Open my pension");
    expect(html).not.toContain("Disconnect");
  });
});

describe("with no session", () => {
  it("offers the way in and nothing else", () => {
    const html = render();
    expect(html).toContain("Open my pension");
    expect(html).not.toContain("Disconnect");
    expect(html).not.toContain(PENSION_KEY.slice(0, 4));
  });
});

describe("with a connected pension key", () => {
  beforeEach(() => {
    mocked.privy = { ready: true, authenticated: true, user: userWith([phantom(PENSION_KEY)]) };
  });

  it("wears the key and the way out, like the bar inside the app", () => {
    const html = render();
    expect(html).toContain(PENSION_KEY.slice(0, 4));
    expect(html).toContain("Disconnect");
    expect(html).toContain("Back to my pension");
    expect(html).not.toContain("Open my pension");
  });

  it("shows what the pension is worth once the chain has answered", () => {
    mocked.live = { kind: "ready", data: liveDashboard({ snapshot: liveSnapshot({}) }), stale: null };
    expect(render()).toMatch(/\$[\d,]+\.\d\d/);
  });

  it("claims NO figure while the read is still in flight", () => {
    expect(render()).not.toMatch(/\$[\d,]+\.\d\d/);
  });

  it("claims NO figure on a read whose vault failed, as the app's own bar does not", () => {
    // A partial RPC failure still carries prices, so "ready" alone would put a
    // dollar amount beside a pension that could not be read.
    mocked.live = {
      kind: "ready",
      data: liveDashboard({ snapshot: liveSnapshot({ vault: { status: "unreadable", address: "v" } }) }),
      stale: null,
    };
    expect(render()).not.toMatch(/\$[\d,]+\.\d\d/);
  });
});

describe("with a session that has no pension key", () => {
  it("shows the way out and no chip to copy", () => {
    mocked.privy = { ready: true, authenticated: true, user: userWith([embedded("TradingWa11et1111111111111111111111111111111", 0, true)]) };
    const html = render();
    expect(html).toContain("Disconnect");
    expect(html).not.toContain(PENSION_KEY.slice(0, 4));
  });
});
