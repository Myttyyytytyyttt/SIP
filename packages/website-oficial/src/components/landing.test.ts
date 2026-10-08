// The landing's ways out (owner, 10-08): Connect logs in and a login made here
// goes into the pension; somebody already connected gets "Open my pension";
// See the app opens the example; Leaderboard and Dashboard are real links, and
// the bar reads as the app's header does — the pages, a rule, then the account.
//
// Rendered to HTML with Privy mocked. Effects never run here, so the click and
// the fade are proven in a browser; the decisions are the pure functions, and a
// completed login is driven through the options the landing hands useLogin.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  privy: { ready: true, authenticated: false, user: null as unknown },
  opener: null as (() => void) | null,
  /** Whether a PrivyProvider is above: without one the real useLogin throws (measured 10-08). */
  provider: true,
  /** What the landing handed useLogin on its last render. */
  loginOptions: null as { onComplete?: (complete: { wasAlreadyAuthenticated: boolean }) => void } | null,
}));

vi.mock("@privy-io/react-auth", () => ({
  usePrivy: () => ({ ...mocked.privy, login: vi.fn(), logout: vi.fn() }),
  useLogin: (options: typeof mocked.loginOptions) => {
    if (!mocked.provider) throw new TypeError("Cannot read properties of undefined (reading 'current')");
    mocked.loginOptions = options;
    return { login: vi.fn() };
  },
}));
vi.mock("@/components/wallets-host", () => ({ useWalletsOpener: () => mocked.opener }));
// The ground is its own module, drawn by effects; this test is about the words and the ways out.
vi.mock("@/components/landing-backdrop", () => ({ LandingBackdrop: () => null, ExampleActivity: () => null }));
vi.mock("next/image", () => ({
  default: (props: { src: string; alt: string }) => createElement("img", { src: props.src, alt: props.alt }),
}));

import { EVM_EMBEDDED, embedded, phantom, userWith } from "../../test/fixtures/privy-user";
import { Landing, connectActionOf, goesInAfterLogin } from "./landing";

/** Signed in with a pension key (an external Solana wallet). */
const withKey = () => ({ ready: true, authenticated: true, user: userWith([phantom()]) });

const render = (walletsConfigured = true, props: { onEnter?: (to: "live" | "mock") => void; resumeSetup?: (() => void) | null } = {}) =>
  renderToStaticMarkup(createElement(Landing, { onEnter: () => undefined, walletsConfigured, ...props }));

const navOf = (html: string): string => {
  const start = html.indexOf("<nav");
  return html.slice(start, html.indexOf("</nav>", start));
};

beforeEach(() => {
  mocked.privy = { ready: true, authenticated: false, user: null };
  mocked.opener = null;
  mocked.provider = true;
  mocked.loginOptions = null;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("what the white button does", () => {
  it("logs in a visitor once Privy is ready, and waits before", () => {
    expect(connectActionOf({ walletsConfigured: true, canOpenSetup: true, ready: true, authenticated: false })).toBe("login");
    expect(connectActionOf({ walletsConfigured: true, canOpenSetup: true, ready: false, authenticated: false })).toBe("waiting");
  });

  it("opens the pension of somebody already connected", () => {
    expect(connectActionOf({ walletsConfigured: true, canOpenSetup: true, ready: true, authenticated: true })).toBe("open-pension");
  });

  it("opens the setup modal on an incomplete deployment, and never pretends Privy could answer there", () => {
    expect(connectActionOf({ walletsConfigured: false, canOpenSetup: true, ready: false, authenticated: false })).toBe("setup");
    expect(connectActionOf({ walletsConfigured: false, canOpenSetup: false, ready: true, authenticated: true })).toBe("waiting");
  });
});

describe("a login that succeeds", () => {
  it("goes into the pension only when it was made now", () => {
    expect(goesInAfterLogin({ wasAlreadyAuthenticated: false })).toBe(true);
    // Privy reports a restored session to every useLogin as well: somebody looking at the front door stays on it.
    expect(goesInAfterLogin({ wasAlreadyAuthenticated: true })).toBe(false);
  });
});

describe("a login completed while the landing is up", () => {
  // Just what enter() touches: its timer, the scroll, and the page it was taken on.
  const browserish = () =>
    vi.stubGlobal("window", {
      setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
      clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
      scrollTo: () => undefined,
      location: { pathname: "/welcome" },
    });

  it("walks on into the pension once the fade has run", () => {
    vi.useFakeTimers();
    browserish();
    const onEnter = vi.fn();
    render(true, { onEnter });
    mocked.loginOptions?.onComplete?.({ wasAlreadyAuthenticated: false });
    expect(onEnter).not.toHaveBeenCalled();
    vi.advanceTimersByTime(420);
    expect(onEnter).toHaveBeenCalledExactlyOnceWith("live");
  });

  it("leaves a restored session where it is", () => {
    vi.useFakeTimers();
    browserish();
    const onEnter = vi.fn();
    render(true, { onEnter });
    mocked.loginOptions?.onComplete?.({ wasAlreadyAuthenticated: true });
    vi.advanceTimersByTime(5000);
    expect(onEnter).not.toHaveBeenCalled();
  });

  it("hands Privy nothing to call on a deployment with no Privy", () => {
    mocked.opener = () => undefined;
    render(false);
    expect(mocked.loginOptions).toBeNull();
  });
});

describe("the bar", () => {
  it("lists the pages, Dashboard last, then a rule, then Connect", () => {
    const nav = navOf(render());
    const at = (needle: string) => {
      const i = nav.indexOf(needle);
      expect(i, needle).toBeGreaterThanOrEqual(0);
      return i;
    };
    const order = [
      at('href="/leaderboard"'),
      at('href="/?mode=mock"'),
      at('href="/dashboard"'),
      at('data-slot="separator"'),
      at(">Connect</button>"),
    ];
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(nav).toContain('data-orientation="vertical"');
    expect(nav).toContain(">Dashboard</a>");
  });

  it("leaves Leaderboard and Dashboard as real links: other pages, not the fade into the example", () => {
    const html = render();
    expect(html).not.toMatch(/href="\/dashboard\?mode=/);
    expect(html).not.toMatch(/href="\/leaderboard\?mode=/);
    // See the app is the example, wherever it appears.
    expect(html.match(/href="\/\?mode=mock"/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("keeps Dashboard reachable on a phone, where the bar shows Connect alone", () => {
    const html = render();
    const links = html.match(/<a href="\/dashboard"[^>]*>/g) ?? [];
    expect(links).toHaveLength(2);
    // The bar's from sm up, the hero's below it: never both on one screen.
    expect(links.filter((a) => a.includes("sm:inline-flex"))).toHaveLength(1);
    expect(links.filter((a) => a.includes("sm:hidden"))).toHaveLength(1);
  });
});

describe("the button's words", () => {
  it("says Connect to a visitor", () => {
    const html = render();
    expect(html).toContain(">Connect</button>");
    expect(html).not.toContain("Open my pension");
  });

  it("says Open my pension to somebody already connected, on every copy of the button", () => {
    mocked.privy = withKey();
    const html = render();
    expect(html).not.toContain(">Connect</button>");
    // The bar, the hero, and the frame's hover.
    expect(html.match(/>Open my pension<\/button>/g)?.length).toBe(3);
  });

  it("is the header's Connect for a key with no vault whose setup was closed (rule 4a): it reopens the setup", () => {
    mocked.privy = withKey();
    const html = render(true, { resumeSetup: () => undefined });
    expect(html).not.toContain("Open my pension");
    expect(html.match(/>Connect<\/button>/g)?.length).toBe(3);
    // That key is shown the example, so the frame may still say so.
    expect(html).toContain("or click anywhere to explore the example");
  });

  it("does not offer a connected key the example the picture will not show it", () => {
    mocked.privy = withKey();
    const html = render();
    expect(html).not.toContain("explore the example");
    expect(html).toContain('aria-label="Open the app"');
  });

  it("keeps Connect, and the example, for a session with no Solana wallet: it has no pension to open (rule 5)", () => {
    mocked.privy = { ready: true, authenticated: true, user: userWith([embedded(EVM_EMBEDDED, 0, false, { chainType: "ethereum" })]) };
    const html = render();
    expect(html).not.toContain("Open my pension");
    expect(html).toContain(">Connect</button>");
    expect(html).toContain("or click anywhere to explore the example");
  });

  it("waits, named and dimmed, while Privy has not answered", () => {
    mocked.privy = { ready: false, authenticated: false, user: null };
    const html = render();
    expect(html).toContain(">Connect</button>");
    expect(html).toContain('aria-disabled="true"');
  });

  it("stays Connect on an incomplete deployment, where it opens the setup — and never asks Privy's login, which has no provider there", () => {
    mocked.privy = { ready: false, authenticated: true, user: null };
    mocked.opener = () => undefined;
    mocked.provider = false;
    const html = render(false);
    expect(html).toContain(">Connect</button>");
    expect(html).not.toContain("Open my pension");
    expect(html).not.toContain('aria-disabled="true"');
  });
});
