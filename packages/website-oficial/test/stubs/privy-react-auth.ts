// A DEV-ONLY STAND-IN FOR @privy-io/react-auth, for screenshots.
//
// The live dashboard's states are decided by what Privy reports, and driving the
// real Privy from a headless browser means a real wallet extension and a real
// login. So for the screenshot script only, next.config.mjs aliases the SDK to
// this file and the script sets `globalThis.__SAVERFI_PRIVY_STUB__` before the
// page loads.
//
// IT IS NEVER READY ON THE SERVER, exactly like the real SDK. That is not a
// detail: the whole dashboard is built on `ready` being false during server
// rendering, so the sample is never painted before Privy has said who is
// looking. A stub that reported a connected user on the server would render one
// tree there and a different one in the browser, which React reports as a
// hydration mismatch — and would test a behaviour production does not have.
// useSyncExternalStore is what keeps the two straight: React uses the server
// snapshot for the hydrating render, then re-renders with the real one.
//
// IT MUST NEVER REACH PRODUCTION, and there are two independent guards: the
// alias in next.config.mjs is gated on NODE_ENV !== "production" AND on
// SIP_WEB_PRIVY_STUB, and this module throws on import if it is ever loaded in a
// production build. scripts/next-config.test.ts pins all of it.

import { useCallback, useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";

if (process.env.NODE_ENV === "production") {
  throw new Error("test/stubs/privy-react-auth.ts was imported in a production build. It is a screenshot stub and must never ship.");
}

/** What the screenshot script injects, and what login/logout move between. */
export interface PrivyStubState {
  ready: boolean;
  authenticated: boolean;
  user: unknown;
  /**
   * Who a login signs in as. A user injected up front counts as connected
   * already (the dashboard reads `user`, not `authenticated`), so a script that
   * wants to watch a visitor connect injects the user here instead.
   */
  loginUser?: unknown;
}

const EVENT = "saverfi-privy-stub";

/** What the SERVER always reports, because that is what the real SDK reports there. */
const NOT_READY: PrivyStubState = Object.freeze({ ready: false, authenticated: false, user: null });

const holder = globalThis as unknown as { __SAVERFI_PRIVY_STUB__?: PrivyStubState };

/** The injected object, mutated in place by login/logout. */
function injected(): PrivyStubState {
  holder.__SAVERFI_PRIVY_STUB__ ??= { ready: true, authenticated: false, user: null };
  return holder.__SAVERFI_PRIVY_STUB__;
}

// The injected object is mutated in place, so its identity cannot signal a
// change: a counter does, and the snapshot is rebuilt only when it moves.
let version = 0;
let cached: PrivyStubState | null = null;
let cachedVersion = -1;

function clientSnapshot(): PrivyStubState {
  if (cached === null || cachedVersion !== version) {
    const live = injected();
    cached = { ready: live.ready, authenticated: live.authenticated, user: live.user };
    cachedVersion = version;
  }
  return cached;
}

const serverSnapshot = (): PrivyStubState => NOT_READY;

function subscribe(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  window.addEventListener(EVENT, onChange);
  // The Solana half (its import) changes the user in place and says so with this event.
  const changed = () => announce();
  window.addEventListener(CHANGED, changed);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener(CHANGED, changed);
  };
}

const CHANGED = "saverfi-privy-stub-changed";

function announce(): void {
  version += 1;
  if (typeof window !== "undefined") window.dispatchEvent(new Event(EVENT));
}

export function PrivyProvider({ children }: { children: ReactNode }): ReactNode {
  return children;
}

export function usePrivy(): PrivyStubState & { login: () => void; logout: () => Promise<void> } {
  const current = useSyncExternalStore(subscribe, clientSnapshot, serverSnapshot);
  const login = useCallback(() => {
    const next = injected();
    next.authenticated = true;
    if (next.loginUser !== undefined) next.user = next.loginUser;
    announce();
  }, []);
  const logout = useCallback(async () => {
    const next = injected();
    next.authenticated = false;
    next.user = null;
    announce();
  }, []);
  return { ready: current.ready, authenticated: current.authenticated, user: current.user, login, logout };
}

/** What Privy hands every useLogin's onComplete. */
interface LoginComplete {
  user: unknown;
  isNewUser: boolean;
  wasAlreadyAuthenticated: boolean;
  loginMethod: string | null;
  loginAccount: unknown;
}

interface LoginOptions {
  onComplete?: (complete: LoginComplete) => void;
  onError?: (code: unknown) => void;
}

/** Like Privy's, a login made anywhere is heard by EVERY mounted useLogin. */
const loginListeners = new Set<(complete: LoginComplete) => void>();

/**
 * PRIVY'S ORDER (3.36.0, read in its dist): the session is set first, and
 * onComplete comes about 1.4 s later, when its dialog closes
 * (ConnectionStatusScreen → closePrivyModal). The page has re-rendered — and
 * re-mounted, see components/landing.tsx — by then, so the stub waits as long.
 */
const LOGIN_COMPLETES_AFTER_MS = 1400;

/**
 * A session the page opened with is reported ONCE per page load, from the
 * provider's own initialisation, to the hooks mounted then — not again to every
 * useLogin that mounts later.
 */
let restoredReported = false;

export function useLogin(options?: LoginOptions): { login: () => void } {
  const { login: signIn } = usePrivy();
  const latest = useRef(options);
  useEffect(() => {
    latest.current = options;
  });
  useEffect(() => {
    const hear = (complete: LoginComplete) => latest.current?.onComplete?.(complete);
    loginListeners.add(hear);
    if (!restoredReported) {
      restoredReported = true;
      const now = injected();
      if (now.ready && now.authenticated) {
        const restored = { user: now.user, isNewUser: false, wasAlreadyAuthenticated: true, loginMethod: null, loginAccount: null };
        window.setTimeout(() => {
          for (const each of loginListeners) each(restored);
        }, 0);
      }
    }
    return () => {
      loginListeners.delete(hear);
    };
  }, []);
  const login = useCallback(() => {
    signIn();
    restoredReported = true;
    const complete = { user: injected().user, isNewUser: false, wasAlreadyAuthenticated: false, loginMethod: "siws", loginAccount: null };
    window.setTimeout(() => {
      for (const hear of loginListeners) hear(complete);
    }, LOGIN_COMPLETES_AFTER_MS);
  }, [signIn]);
  return { login };
}

export function useUser(): { user: unknown; refreshUser: () => Promise<unknown> } {
  const { user } = usePrivy();
  // The record as it is NOW: an import made in this render's lifetime is in it.
  return { user, refreshUser: async () => injected().user };
}

/** removeSigners clears `delegated` on that wallet, as Privy's record shows a TEE wallet once its signers are gone. */
export function useSigners(): { addSigners: () => Promise<void>; removeSigners: (input: { address: string }) => Promise<void> } {
  return {
    addSigners: async () => undefined,
    removeSigners: async ({ address }) => {
      const state = injected();
      const user = state.user as { linkedAccounts: { address?: string }[] } | null;
      if (user !== null) {
        state.user = { ...user, linkedAccounts: user.linkedAccounts.map((account) => (account.address === address ? { ...account, delegated: false } : account)) };
      }
      announce();
    },
  };
}
