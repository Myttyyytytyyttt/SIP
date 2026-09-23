/**
 * WHOSE NUMBERS THE DASHBOARD SHOWS — decided ONCE, here, and nowhere else.
 *
 * THE OWNER'S RULE. With a pension key connected the dashboard is Live: the
 * Live/Mock choice leaves the navbar, and a ?mode=mock in the address bar does
 * not bring it back. Without a connection the choice is offered, and Live then
 * shows an honest "connect your pension key" card — never the sample under a
 * label promising someone their own pension.
 *
 * ONE EXCEPTION (owner, 09-23): a connected key with NO VAULT whose new-user
 * setup was closed. It sees the sample exactly as a visitor does — the badge,
 * the toggle, a Connect button — and Connect or Live reopens the setup where it
 * was left (src/components/onboarding). The key has no pension yet, so the
 * sample cannot be mistaken for one.
 *
 * WHY ONE PURE FUNCTION. The frame, the header, both pages and the tests all ask
 * this function. A component that worked the mode out on its own is how the
 * badge and the numbers drift apart, and that drift is somebody mistaking a
 * seeded example for their savings.
 *
 * NOTHING IS PAINTED BEFORE PRIVY ANSWERS. On the server `ready` is false, so
 * /?mode=mock and /?mode=live render a skeleton; the sample HTML is never sent
 * to a browser that might be a connected user's. The front door (`/` with no
 * mode) is the one exception and deliberately does NOT wait — it holds no
 * numbers, and a landing page gated on a third party's initialisation is a
 * landing page that sometimes never opens.
 */

export type DashboardKind =
  /** The front door: no numbers, and it never waits for Privy. */
  | "landing"
  /** Privy has not answered yet. A skeleton, never the sample. */
  | "loading"
  /** The seeded example, under its Sample data badge. */
  | "mock"
  /** Live, with nobody connected: the connect card. No numbers. */
  | "live-connect"
  /** Signed in, but with no external Solana wallet to be a pension key. */
  | "live-keyless"
  /** This deployment has no Solana configuration, so Live cannot exist here. */
  | "live-unavailable"
  /** A connected pension key's own pension, read from Solana. */
  | "live";

/** Which sentence goes over the sample, when the sample is what is showing. */
export type DashboardNotice = "sample" | "keyless" | null;

/** What stands at the right of the header. */
export type DashboardAccount =
  /** Connect, which opens the setup modal (there is no Privy provider here). */
  | "connect-setup"
  /** A skeleton while Privy is asked: never a Connect that cannot act. */
  | "placeholder"
  | "connect"
  | "disconnect"
  /** The pension key's short address, then Disconnect. */
  | "key-and-disconnect"
  /** Connect, which reopens this key's setup where it was left. The key IS connected; it has no vault yet. */
  | "connect-onboarding";

export type UrlMode = "live" | "mock";

export interface DashboardState {
  readonly kind: DashboardKind;
  /** Whether the navbar offers the Live|Mock choice at all. */
  readonly toggle: boolean;
  readonly notice: DashboardNotice;
  readonly account: DashboardAccount;
  /** A URL to normalize to with history.replaceState, applied once per change; null when the URL already says it. */
  readonly replaceUrlWith: string | null;
}

export interface DashboardInput {
  /** From the server's loadConfig: whether there is a Privy provider at all. */
  readonly walletsConfigured: boolean;
  /** The 15 s patience ran out and the visitor asked for the sample anyway. */
  readonly privyGaveUp: boolean;
  /** usePrivy().ready */
  readonly ready: boolean;
  /** usePrivy().authenticated */
  readonly authenticated: boolean;
  /** usePrivy().user !== null */
  readonly hasUser: boolean;
  /** pensionKeyOf(user): an EXTERNAL Solana wallet only. */
  readonly pensionKey: string | null;
  /** ?mode=, already narrowed; anything else counts as null. */
  readonly urlMode: UrlMode | null;
  readonly pathname: string;
  /** Only "/" has a landing behind it; /activity never does. */
  readonly landingAllowed: boolean;
  /**
   * This browser has connected before (the session hint cookie, read by the
   * server before the first paint). NOT authentication and not a claim that
   * the session is still valid — only that the front door is the wrong thing
   * to show while Privy is still answering. Absent means "not known", which is
   * the same as false — the field is a hint, and a hint can simply be missing.
   */
  readonly knownSession?: boolean;
  /**
   * The new-user setup, for a connected key: whether this tab closed it, and
   * what the vault read says. Absent means today's rule exactly — always Live.
   */
  readonly onboarding?: OnboardingInput;
}

/** What the page knows of a connected key's vault: its one read (src/lib/onboarding.ts, vaultPresenceOf). */
export type VaultPresence = "reading" | "missing" | "exists" | "unreadable";

export interface OnboardingInput {
  /** This tab closed the setup for this key (src/lib/onboarding-memory.ts). */
  readonly closed: boolean;
  readonly vault: VaultPresence;
}

/** "/?mode=live", "/activity?mode=mock" — the pathname is kept exactly as it was. */
export const urlWithMode = (pathname: string, mode: UrlMode): string => `${pathname}?mode=${mode}`;

/** ?mode= as this app reads it. Any other value is no mode at all. */
export const readUrlMode = (value: string | null | undefined): UrlMode | null => (value === "live" || value === "mock" ? value : null);

const state = (
  kind: DashboardKind,
  toggle: boolean,
  account: DashboardAccount,
  notice: DashboardNotice = null,
  replaceUrlWith: string | null = null,
): DashboardState => ({ kind, toggle, notice, account, replaceUrlWith });

/**
 * The first rule that matches wins. The order is the whole of the behaviour, so
 * it is written as one sequence rather than spread across components.
 */
export function decideDashboard(input: DashboardInput): DashboardState {
  const { walletsConfigured, privyGaveUp, ready, authenticated, hasUser, pensionKey, urlMode, pathname, landingAllowed } = input;
  const knownSession = input.knownSession === true;
  const onLanding = urlMode === null && landingAllowed;

  // 1. No configuration: there is no PrivyProvider, so `ready` never comes.
  //    Never wait for it, and never claim Live could work here.
  if (!walletsConfigured) {
    if (onLanding) return state("landing", true, "connect-setup");
    if (urlMode === "mock") return state("mock", true, "connect-setup", "sample");
    return state("live-unavailable", true, "connect-setup");
  }

  // 2. Privy has not answered. The front door still opens; everything else waits.
  //    On the server `ready` is false, so the sample is never server-rendered.
  //
  //    EXCEPT FOR SOMEBODY WHO HAS CONNECTED BEFORE. Showing them the landing
  //    for the few hundred milliseconds Privy takes meant the front door
  //    flashed past on every arrival and then threw them into their pension —
  //    the state was never wrong, only unknowable that early, and a skeleton is
  //    what an unknowable moment looks like. If the hint turns out to be stale
  //    the next rule along lands them on the connect card, which is where a
  //    disconnected visitor belongs anyway.
  if (!ready && !privyGaveUp) {
    if (onLanding && !knownSession) return state("landing", false, "placeholder");
    return state("loading", false, "placeholder");
  }

  // 3. Privy reports the session one frame before the user object arrives.
  if (ready && authenticated && !hasUser) return state("loading", false, "placeholder");

  // 4. A CONNECTED PENSION KEY IS LIVE. The toggle is not rendered, and
  //    ?mode=mock is ignored and normalized away, so a reload cannot land on the
  //    sample or on the landing — with one exception.
  if (ready && hasUser && pensionKey !== null) {
    const closed = input.onboarding?.closed === true;
    const vault = input.onboarding?.vault ?? "reading";
    // 4a. THE ONE WAY A CONNECTED KEY REACHES THE SAMPLE: no vault, and its
    //     setup was closed in this tab. Exactly the visitor's sample, and its
    //     Connect reopens the setup instead of Privy's login.
    if (closed && vault === "missing") return state("mock", true, "connect-onboarding", "sample", urlMode === "mock" ? null : urlWithMode(pathname, "mock"));
    // 4b. Closed, but the vault read has not answered: neither the sample nor a
    //     pension yet. The URL is left alone until it does.
    if (closed && vault === "reading") return state("loading", false, "placeholder");
    // 4c. Everything else — a close that is out of date included: Live.
    return state("live", false, "key-and-disconnect", null, urlMode === "live" ? null : urlWithMode(pathname, "live"));
  }

  // 5. Signed in with no external Solana wallet. The toggle stays: the owner's
  //    rule hides it only for a connected pension key.
  if (ready && hasUser) {
    if (urlMode === "mock") return state("mock", true, "disconnect", "keyless");
    return state("live-keyless", true, "disconnect");
  }

  // 6. Disconnected — and a Privy that never loaded is treated the same way.
  if (onLanding) return state("landing", true, "connect");
  if (urlMode === "mock") return state("mock", true, "connect", "sample");
  return state("live-connect", true, "connect");
}

/** Which position the Live|Mock control shows for a state, when it is shown at all. */
export const toggleModeOf = (kind: DashboardKind): UrlMode =>
  kind === "live" || kind === "live-connect" || kind === "live-keyless" || kind === "live-unavailable" ? "live" : "mock";
