// The one decision about whose numbers are on screen, row by row.

import { describe, expect, it } from "vitest";

import { decideDashboard, readUrlMode, toggleModeOf, urlWithMode, type DashboardInput } from "@/lib/dashboard-mode";

const PENSION_KEY = "PensionKeyP1aceho1der111111111111111111111";

/** A configured deployment, Privy ready, nobody connected, on "/" with no mode. */
function input(overrides: Partial<DashboardInput> = {}): DashboardInput {
  return {
    walletsConfigured: true,
    privyGaveUp: false,
    ready: true,
    authenticated: false,
    hasUser: false,
    pensionKey: null,
    urlMode: null,
    pathname: "/",
    landingAllowed: true,
    ...overrides,
  };
}

/** A connected pension key. */
const connected = (overrides: Partial<DashboardInput> = {}): DashboardInput =>
  input({ authenticated: true, hasUser: true, pensionKey: PENSION_KEY, ...overrides });

describe("a connected pension key is always Live", () => {
  it("?mode=mock with a pension key is LIVE, the toggle is gone, and the URL is normalized to ?mode=live", () => {
    const decided = decideDashboard(connected({ urlMode: "mock" }));
    expect(decided.kind).toBe("live");
    expect(decided.toggle).toBe(false);
    expect(decided.replaceUrlWith).toBe("/?mode=live");
    expect(decided.account).toBe("key-and-disconnect");
    expect(decided.notice).toBeNull();
  });

  it("the same on /activity, keeping the pathname", () => {
    const decided = decideDashboard(connected({ urlMode: "mock", pathname: "/activity", landingAllowed: false }));
    expect([decided.kind, decided.toggle, decided.replaceUrlWith]).toEqual(["live", false, "/activity?mode=live"]);
  });

  it("a connected visitor on the bare front door is Live too, normalized to ?mode=live — never the landing", () => {
    const decided = decideDashboard(connected({ urlMode: null }));
    expect([decided.kind, decided.replaceUrlWith]).toEqual(["live", "/?mode=live"]);
  });

  it("already at ?mode=live, there is nothing to replace", () => {
    expect(decideDashboard(connected({ urlMode: "live" })).replaceUrlWith).toBeNull();
  });

  it("a connected pension key can NEVER reach the sample, at any URL", () => {
    for (const urlMode of ["mock", "live", null] as const) {
      for (const pathname of ["/", "/activity"]) {
        const decided = decideDashboard(connected({ urlMode, pathname, landingAllowed: pathname === "/" }));
        expect(decided.kind).toBe("live");
        expect(decided.notice).toBeNull();
        expect(decided.toggle).toBe(false);
      }
    }
  });

  it("a Privy that gave up still loses to a pension key that arrived", () => {
    expect(decideDashboard(connected({ privyGaveUp: true, urlMode: "mock" })).kind).toBe("live");
  });
});

describe("before Privy answers, nothing is painted", () => {
  it("?mode=mock is a skeleton, not the sample", () => {
    const decided = decideDashboard(input({ ready: false, urlMode: "mock" }));
    expect([decided.kind, decided.toggle, decided.account]).toEqual(["loading", false, "placeholder"]);
    expect(decided.notice).toBeNull();
  });

  it("?mode=live and /activity are skeletons too", () => {
    expect(decideDashboard(input({ ready: false, urlMode: "live" })).kind).toBe("loading");
    expect(decideDashboard(input({ ready: false, urlMode: null, pathname: "/activity", landingAllowed: false })).kind).toBe("loading");
  });

  it("the front door does NOT wait: it holds no numbers", () => {
    expect(decideDashboard(input({ ready: false, urlMode: null })).kind).toBe("landing");
  });

  it("authenticated one frame before the user object is still loading", () => {
    expect(decideDashboard(input({ ready: true, authenticated: true, hasUser: false, urlMode: "mock" })).kind).toBe("loading");
  });
});

describe("disconnected", () => {
  it("Mock is the sample, with the sample notice and the toggle offered", () => {
    const decided = decideDashboard(input({ urlMode: "mock" }));
    expect(decided).toMatchObject({ kind: "mock", toggle: true, notice: "sample", account: "connect", replaceUrlWith: null });
  });

  it("Live is the connect card — never sample numbers", () => {
    const decided = decideDashboard(input({ urlMode: "live" }));
    expect(decided).toMatchObject({ kind: "live-connect", toggle: true, notice: null, account: "connect" });
  });

  it("/activity with no mode is Live, because there is no landing behind it", () => {
    expect(decideDashboard(input({ urlMode: null, pathname: "/activity", landingAllowed: false })).kind).toBe("live-connect");
  });

  it("the bare front door is the landing", () => {
    expect(decideDashboard(input({ urlMode: null })).kind).toBe("landing");
  });

  it("a Privy that never loaded behaves exactly as disconnected", () => {
    const gaveUp = { ready: false, privyGaveUp: true } as const;
    expect(decideDashboard(input({ ...gaveUp, urlMode: "mock" }))).toMatchObject({ kind: "mock", toggle: true, notice: "sample" });
    expect(decideDashboard(input({ ...gaveUp, urlMode: "live" })).kind).toBe("live-connect");
    expect(decideDashboard(input({ ...gaveUp, urlMode: null })).kind).toBe("landing");
  });
});

describe("a session with no pension key", () => {
  const keyless = (overrides: Partial<DashboardInput> = {}) => input({ authenticated: true, hasUser: true, pensionKey: null, ...overrides });

  it("keeps the toggle: the owner's rule hides it only for a connected pension key", () => {
    const decided = decideDashboard(keyless({ urlMode: "live" }));
    expect(decided).toMatchObject({ kind: "live-keyless", toggle: true, account: "disconnect" });
  });

  it("Mock says WHY it is the sample, and offers Disconnect rather than a dead end", () => {
    const decided = decideDashboard(keyless({ urlMode: "mock" }));
    expect(decided).toMatchObject({ kind: "mock", toggle: true, notice: "keyless", account: "disconnect" });
  });

  it("has no landing to fall back to: a session is a session", () => {
    expect(decideDashboard(keyless({ urlMode: null })).kind).toBe("live-keyless");
  });
});

describe("a deployment with no Solana configuration", () => {
  const unconfigured = (overrides: Partial<DashboardInput> = {}) => input({ walletsConfigured: false, ready: false, ...overrides });

  it("NEVER waits for a Privy that will never mount", () => {
    for (const urlMode of ["mock", "live", null] as const) {
      expect(decideDashboard(unconfigured({ urlMode })).kind).not.toBe("loading");
    }
  });

  it("says Live is not available here, and its Connect opens the setup modal", () => {
    const decided = decideDashboard(unconfigured({ urlMode: "live" }));
    expect(decided).toMatchObject({ kind: "live-unavailable", toggle: true, account: "connect-setup" });
    expect(decideDashboard(unconfigured({ urlMode: "mock" })).notice).toBe("sample");
    expect(decideDashboard(unconfigured({ urlMode: null })).kind).toBe("landing");
  });
});

describe("the toggle's own position", () => {
  it("every live state shows Live; the sample shows Mock", () => {
    expect((["live", "live-connect", "live-keyless", "live-unavailable"] as const).map(toggleModeOf)).toEqual(["live", "live", "live", "live"]);
    expect((["mock", "landing", "loading"] as const).map(toggleModeOf)).toEqual(["mock", "mock", "mock"]);
  });

  it("is only ever rendered when the state says so — and never for a connected key", () => {
    expect(decideDashboard(connected({ urlMode: "live" })).toggle).toBe(false);
    expect(decideDashboard(input({ urlMode: "live" })).toggle).toBe(true);
  });
});

describe("urlWithMode and readUrlMode", () => {
  it("keeps the pathname exactly", () => {
    expect(urlWithMode("/", "live")).toBe("/?mode=live");
    expect(urlWithMode("/activity", "mock")).toBe("/activity?mode=mock");
  });

  it("reads only the two modes this app has; anything else is no mode at all", () => {
    expect([readUrlMode("live"), readUrlMode("mock")]).toEqual(["live", "mock"]);
    for (const value of ["LIVE", "demo", "", null, undefined, "mock "]) expect(readUrlMode(value)).toBeNull();
  });
});
