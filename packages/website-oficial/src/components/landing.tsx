"use client";

/**
 * WHAT SOMEBODY SEES BEFORE THEY CONNECT — the words on top, and the app in the
 * middle of the S's own blueprint, brought to the screen by a scroll.
 *
 * On a screen with room (wide, landscape, at least 600px tall) the headline and
 * the ways in run across the top, and below them a frame playing the dashboard
 * on example data sits in the middle of the ground (landing-backdrop.tsx),
 * almost facing the viewer. On a phone, a portrait tablet or a short window
 * there is no room for that: the frame sits under the words, tilted back and
 * running off the bottom. Either way, scroll and the
 * frame straightens, rises and grows until it fills the screen — and at that
 * moment you are in the app. Hover the frame and the picture softens behind a
 * Connect; click anywhere else on it and you walk into the example.
 *
 * THE STAGE CONDITION LIVES IN TWO PLACES THAT MUST AGREE: the media query of
 * THE STAGED LANDING in globals.css, and `isStaged` below.
 *
 * STICKY BY ITS FOOT. The hero is as tall as its content (exactly one viewport
 * when staged). `top: min(0, 100dvh − hero height)` lets a taller hero scroll
 * until its foot meets the bottom of the viewport and pins it there. The runway
 * is a spacer AFTER the hero, not padding: sticky is constrained by the
 * containing block's content box, and a padding runway once left the hero
 * scrolling away under a gesture that was still "in progress".
 *
 * ONE MEASURED TRANSFORM. Each frame (coalesced to one per scroll or resize), the
 * loop reads layout first — the hero's height and the rect of the frame's STAGE,
 * an element that never transforms — and then writes: the frame's translate,
 * tilt and scale toward "centred and covering the viewport", the copy's fade,
 * the nav's fade, and --p, which the ground drifts with. Transforms and opacity
 * never dirty layout, so nothing is forced.
 *
 * THE WAYS OUT, EACH TO ONE PLACE (owner, 10-08):
 *  - Connect logs in, and a login that succeeds walks on into the app at
 *    ?mode=live, where the frame (lib/dashboard-mode.ts) shows the key's own
 *    pension, or the new-user setup when it has no vault yet. For somebody
 *    already connected the button is "Open my pension" and goes there too —
 *    except a key with no vault whose setup was closed in this tab (rule 4a),
 *    for which it is the app header's own "Connect": it reopens that setup,
 *    and the app comes in behind it.
 *  - See the app, and the scroll, open the example (?mode=mock). A connected key
 *    lands on its own pension from there instead (rule 4, kept by the owner on
 *    10-08); the one connected key shown the example is rule 4a's.
 *  - Leaderboard and Dashboard are other pages, public: real links, no fade.
 *
 * PROGRESSIVE, ON PURPOSE. See the app is <a href="/?mode=mock">: before
 * hydration a click is a navigation and still arrives; after it, the click
 * becomes a fade. The shell pushes that URL on entry, so Back returns here —
 * and this page resets its scroll on mount and only enters on a gesture the
 * visitor made, so a restored scroll position cannot re-enter it.
 *
 * THE LOADER, AND WHY THE SCENE COMES LAST. The page opens on a loader (the
 * intro below, or the SIP mark in a spinning ring) and stays there until the
 * frame's rest frame has decoded. Then the words and the frame rise, and only
 * once the frame has fully arrived (data-scene) does the app inside it start to
 * move — never under the loader, never before anybody can see it.
 *
 * THE GROUND (owner, 10-08: "prefiero los grids"). Until then the page stood on
 * the reference template's footage — another brand's credit card, on a third
 * party's CDN, with a whole geometry to keep the card hidden behind the frame.
 * It is gone: the ground is the launch film's blueprint, drawn in code.
 *
 * COMMITTED DARK, whatever the theme: the app and the ground are dark.
 *
 * THE INTRO (owner, 10-07). The loader is the launch film's green logo build
 * instead of the spinning ring: the point of light, the guides, the pieces of
 * the S locking together, the bloom. The page is revealed when the film has
 * ended AND the page is ready, whichever comes last; a click, a tap or a key
 * skips it. Reduced motion shows the film's last frame, still.
 * FIVE MINUTES OF MEMORY (owner, 10-08). Whoever saw it less than
 * INTRO_REMEMBER_MS ago gets the ring — Back from the app, a Disconnect, the
 * Live toggle all come here, and a film each time would be a toll; after that
 * it plays again. It used to be once per tab, which made it hard to see twice.
 * The decision is made BEFORE THE FIRST PAINT by a few lines of inline script
 * (localStorage is not readable on the server), so a returning visitor never
 * sees the film start and vanish.
 *
 * THEN THE PAGE ARRIVES OUT OF STEP (owner, 10-07): not one rise for everything
 * but each element with its own effect and its own moment — the headline line
 * by line out of a blur, the eyebrow from the side, the buttons popping in one
 * after another, the frame rising from below — see THE ENTRANCE in globals.css.
 */

import Image from "next/image";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { useLogin, usePrivy } from "@privy-io/react-auth";
import { ArrowDown, ArrowUpRight } from "lucide-react";

import { ExampleActivity, LandingBackdrop } from "@/components/landing-backdrop";
import { Separator } from "@/components/ui/separator";
import { useWalletsOpener } from "@/components/wallets-host";
import type { UrlMode } from "@/lib/dashboard-mode";
import { pensionKeyOf } from "@/lib/pension-key";
import { privyFailure } from "@/lib/privy-failure";
import { cn } from "@/lib/utils";

/**
 * How much scroll, after the hero has pinned, carries the frame from resting
 * to filling the screen — as a share of the viewport. A thumb gets a longer
 * gesture than a trackpad: one flick on a phone is not a decision. The runway
 * spacer is sized a little past each, and the comparison carries a tolerance
 * because floating point once left a visitor one ulp short of entering.
 */
const ZOOM_VH_FINE = 0.9;
const ZOOM_VH_COARSE = 1.0;
const ENTER_TOLERANCE = 0.985;
const LEAVE_MS = 420;

/**
 * THE INTRO'S FILM: the launch film's logo build (launch-video, F30Intro 0–2.6 s)
 * on the landing's own ground, so its edge never shows. The poster is its last
 * frame: what reduced motion sees, and what stands still if the film cannot play.
 */
const INTRO = {
  /** 1920×1080 from a 1024px-wide screen up; 1280×720 below, where it is never shown larger. */
  wide: { webm: "/landing/intro-logo-1080.webm", mp4: "/landing/intro-logo-1080.mp4" },
  narrow: { webm: "/landing/intro-logo-720.webm", mp4: "/landing/intro-logo-720.mp4" },
  poster: "/landing/intro-logo.jpg",
} as const;
const INTRO_WIDE_MEDIA = "(min-width: 1024px)";
/* The poster is NOT the video's poster attribute: see the intro's markup. */

/**
 * THE APP IN THE FRAME (owner, 10-07): a seamless loop of the sample page made by
 * the launch session — the chart's line lit, the strip's chips in turn, a
 * "+$" rising, "Invested in SPYx/ANTHROPIC" notices — over a REST FRAME that is a
 * capture of /?mode=mock itself. The rest frame is the poster: it is what the
 * loader waits for, what reduced motion keeps, and what the scroll-zoom hands
 * over to the real page, so the two must match (re-render the loop whenever the
 * sample page changes).
 */
const APP_LOOP = { webm: "/landing/app-loop.webm", mp4: "/landing/app-loop.mp4", poster: "/landing/app-loop.jpg" } as const;
/** localStorage: when this browser last saw the film, in ms since the epoch. */
const INTRO_KEY = "saverfi.intro";
/** How long the film is remembered: within it the landing opens on the ring. */
export const INTRO_REMEMBER_MS = 5 * 60_000;

/**
 * Whether the film was seen recently enough to skip. Anything that is not a
 * time in the past window — nothing stored, the old per-tab "seen", a clock that
 * moved backwards — plays it. The inline script below makes the same decision
 * in the same words; landing.test.ts keeps the two in step.
 */
export const introSeenRecently = (stored: string | null, now: number): boolean => {
  const at = Number(stored);
  return stored !== null && Number.isFinite(at) && at > 0 && now - at >= 0 && now - at < INTRO_REMEMBER_MS;
};
/**
 * WHERE THE S ENDS IN THE FILM, measured on its last frame (launch session,
 * 10-08): a 1920×1080 frame, the S's centre and height in it. The film is shown
 * with object-fit: cover, so on screen the S is these times
 * max(vw / 1920, vh / 1080), centred. The mark image has the S's proportions
 * (218×256 against 325×380) and no padding, so one can stand in for the other.
 */
const INTRO_FRAME = { width: 1920, height: 1080 } as const;
const INTRO_S = { cx: 960.5, cy: 540, height: 380 } as const;
const MARK_ASPECT = 218 / 256;
/** The S flies only if the film got far enough to have built it: a skip at the point of light just fades. */
const INTRO_S_BUILT_S = 2.5;
/** How long the S takes to fly to the bar; the CSS transition is set from this. */
const INTRO_FLY_MS = 750;
/** How long the still stands when the film cannot play (reduced motion, autoplay refused, a failed load). */
const INTRO_STILL_MS = 900;
/**
 * TWO LIMITS, NOT ONE. A film that has not STARTED this long after navigation
 * (a slow connection still fetching it) is skipped: the page is not held for a
 * logo. A film that has started is let finish — the cap then runs from its
 * start, its length plus a margin — so it is never cut halfway through the build.
 */
const INTRO_START_MS = 2500;
const INTRO_END_MARGIN_MS = 800;
/**
 * Runs while the HTML is parsed, before the first paint: a visitor who saw the
 * film in the last INTRO_REMEMBER_MS gets the ring (data-intro-seen), anybody
 * else's film starts now rather than at hydration. The same decision is made
 * again in a layout effect for a landing React mounts on the client, where this
 * does not run. Its test is introSeenRecently's, spelled in ES5.
 */
export const INTRO_SCRIPT = `(function(){var r=document.currentScript&&document.currentScript.parentElement;if(!r)return;var s=false;try{var v0=localStorage.getItem(${JSON.stringify(INTRO_KEY)});var t=Number(v0),d=Date.now()-t;s=v0!==null&&isFinite(t)&&t>0&&d>=0&&d<${INTRO_REMEMBER_MS}}catch(e){}if(s){r.setAttribute("data-intro-seen","");return}if(window.matchMedia&&matchMedia("(prefers-reduced-motion: reduce)").matches)return;var v=r.querySelector(".landing-intro-video");if(v){var p=v.play();if(p&&p.catch)p.catch(function(){})}})();`;

/**
 * THE LOADER lifts when the screenshot has decoded and the fonts are in (so
 * nothing reflows under the frame), but not before MIN — a fast load should not
 * flash the mark — and no later than MAX: if the screenshot never arrives the
 * frame's own opaque ground still stands, and a page is better than a spinner.
 * The app's loop then waits for the frame's entrance to END; the fallback covers
 * an animationend that never fires (a backgrounded tab throttles them).
 */
const MIN_LOADER_MS = 700;
const MAX_LOADER_MS = 8000;
const FRAME_RISE_DELAY_S = 0.35;
/** The frame's entrance (landing-in-frame in globals.css): keep the two equal. */
const FRAME_RISE_S = 1.3;
const SCENE_FALLBACK_MS = (FRAME_RISE_DELAY_S + FRAME_RISE_S) * 1000 + 250;
/** Tilt at rest: slight where the frame faces the viewer from the middle of the scene, steep under the words elsewhere. */
const REST_TILT_STAGED_DEG = 5;
const REST_TILT_DEG = 16;

/** Mirrors the media query of THE STAGED LANDING in globals.css. Change both. */
function isStaged(vw: number, vh: number): boolean {
  return vw >= 768 && vh >= 600 && vw / vh >= 1.25;
}

const FOCUS =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0A0B11]";

/**
 * WHAT THE WHITE BUTTON DOES, in its four honest states: opens the setup modal
 * when the deployment is incomplete; for somebody already signed in, goes in
 * at ?mode=live (their pension, or the card telling a session with no Solana
 * wallet what it lacks — rule 5); logs in when Privy can; otherwise it waits — a named,
 * focusable, aria-disabled button, never a nameless placeholder. Without a
 * configuration there is no Privy provider, so `ready` never comes.
 */
export type ConnectAction = "setup" | "open-pension" | "login" | "waiting";

export function connectActionOf(input: {
  readonly walletsConfigured: boolean;
  /** Whether the wallets modal can be opened from here (wallets-host). */
  readonly canOpenSetup: boolean;
  readonly ready: boolean;
  readonly authenticated: boolean;
}): ConnectAction {
  if (!input.walletsConfigured) return input.canOpenSetup ? "setup" : "waiting";
  if (!input.ready) return "waiting";
  return input.authenticated ? "open-pension" : "login";
}

/**
 * A LOGIN THAT SUCCEEDS GOES IN — only one made now. Privy calls every mounted
 * useLogin's onComplete, a session it restored included (wasAlreadyAuthenticated);
 * that one is somebody looking at the front door on purpose, and stays.
 */
export const goesInAfterLogin = (complete: { readonly wasAlreadyAuthenticated: boolean }): boolean => !complete.wasAlreadyAuthenticated;

/**
 * A LOGIN'S WAY IN OUTLIVES THE LANDING THAT TOOK IT. A login re-mounts the
 * whole page: wallets-host wraps everything in the pension's vault screen once
 * a key is connected. Privy 3.36.0 calls onComplete about 1.4 s after the
 * session is set, as its dialog closes — after that re-mount, so the new
 * landing hears it. Were the order ever the other way round, the landing that
 * started the fade would be gone, and its timer with it: on 10-08 a stub that
 * answered first left /welcome on the front door, connected. So the way in to
 * the pension is kept here, beside the module, with the page it was taken on,
 * until a timer delivers it; a landing that mounts on that page while it is
 * pending starts faded and delivers it itself. Only the pension's way in: the
 * example's is never cut short by a login. It expires, and any move through
 * history drops it — Back or Forward is the visitor choosing somewhere else.
 */
let pendingWayIn: { readonly at: number; readonly path: string } | null = null;
const PENDING_WAY_IN_MS = 2000;
if (typeof window !== "undefined") {
  window.addEventListener("popstate", () => {
    pendingWayIn = null;
  });
}
const pendingWayInHere = (): boolean =>
  typeof window !== "undefined" &&
  pendingWayIn !== null &&
  pendingWayIn.path === window.location.pathname &&
  performance.now() - pendingWayIn.at < PENDING_WAY_IN_MS;

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const easeInOut = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);

export function Landing({
  onEnter,
  walletsConfigured,
  resumeSetup = null,
}: {
  /** Where the visitor goes in: the example ("mock"), or their own pension after a Connect ("live"). */
  onEnter: (to: UrlMode) => void;
  /**
   * Whether the wallets modal has a configuration. Without one there is no
   * Privy provider above us, `ready` never comes, and the honest Connect is the
   * one that opens the setup modal naming the missing variables.
   */
  walletsConfigured: boolean;
  /**
   * Set when the connected key has no vault and closed its setup in this tab
   * (lib/dashboard-mode.ts, rule 4a): reopens that setup. The button is then
   * the app header's "Connect" for that state, and like it, the setup opens at
   * the click — before the fade, not with the way in: clearing the close moves
   * the frame, which rewrites this page's URL, and a URL rewritten while Next
   * navigates drops the navigation (measured, 10-08). Only /welcome passes it:
   * "/" never shows a connected key the landing.
   */
  resumeSetup?: (() => void) | null;
}) {
  const { ready, authenticated, user } = usePrivy();
  // A pension key, not just a session: rule 5's session with no Solana wallet has no pension to open.
  const hasPensionKey = user !== null && user !== undefined && pensionKeyOf(user) !== null;
  const openWallets = useWalletsOpener();
  const [failure, setFailure] = useState<string | null>(null);

  const rootRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const heroRef = useRef<HTMLElement>(null);
  const copyRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);

  // Faded from the first paint when this landing is the remount of one that was leaving.
  const [leaving, setLeaving] = useState(pendingWayInHere);
  const enteredRef = useRef(false);
  const timerRef = useRef<number | null>(null);

  // THE LATEST onEnter, READ AT THE MOMENT OF LEAVING. Callers pass a fresh
  // arrow on every render; were `enter` to change with it, the scene's effect
  // (which depends on `enter`) would tear down mid-fade — clearing the leave
  // timer and leaving the page at opacity 0 with nowhere to go.
  const onEnterRef = useRef(onEnter);
  useEffect(() => {
    onEnterRef.current = onEnter;
  });

  const enter = useCallback((to: UrlMode) => {
    if (enteredRef.current) return;
    enteredRef.current = true;
    pendingWayIn = to === "live" ? { at: performance.now(), path: window.location.pathname } : null;
    setLeaving(true);
    timerRef.current = window.setTimeout(() => {
      pendingWayIn = null;
      window.scrollTo({ top: 0, behavior: "auto" });
      onEnterRef.current(to);
    }, LEAVE_MS);
  }, []);

  // Deliver a way in that a previous mount of this page took and could not
  // finish. Re-armed on every run: React's development double-mount clears the
  // timer between the two (the scene's cleanup), and the second run must set it again.
  useEffect(() => {
    if (!pendingWayInHere()) return;
    enteredRef.current = false;
    enter("live");
  }, [enter]);

  // A modified click (new tab, new window) is a real navigation to the same
  // URL; a plain one becomes the fade.
  const enterFromLink = useCallback(
    (e: React.MouseEvent<HTMLAnchorElement>) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
      e.preventDefault();
      enter("mock");
    },
    [enter],
  );

  // A login made here walks into the pension (goesInAfterLogin). Closing
  // Privy's dialog is a choice, not an error. Privy's login lives in
  // LoginWatcher, mounted only where there is a provider to log in with.
  const loginRef = useRef<(() => void) | null>(null);
  const onLoginComplete = useCallback(
    (complete: { readonly wasAlreadyAuthenticated: boolean }) => {
      if (goesInAfterLogin(complete)) enter("live");
    },
    [enter],
  );
  const onLoginError = useCallback((code: unknown) => {
    const described = privyFailure(code);
    setFailure(described.kind === "exited" ? null : described.message);
  }, []);

  const action = connectActionOf({ walletsConfigured, canOpenSetup: openWallets !== null, ready, authenticated });
  const connect: (() => void) | null =
    action === "setup"
      ? openWallets
      : action === "open-pension"
        ? () => {
            resumeSetup?.();
            enter("live");
          }
        : action === "login"
          ? () => {
              setFailure(null);
              loginRef.current?.();
            }
          : null;
  // "Open my pension" only where there is one to open (rule 4). Rule 4a's key
  // reopens its setup and rule 5's session sees the keyless card: both keep the
  // header's "Connect", and the picture still shows them the example.
  const opensPension = action === "open-pension" && resumeSetup === null && hasPensionKey;
  const connectLabel = opensPension ? "Open my pension" : "Connect";

  // THE INTRO'S DECISION, for a landing React mounts on the client (INTRO_SCRIPT
  // ran only if the server sent this page). Before paint, so the film never
  // flashes for somebody who has seen it. Idempotent with the script.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let seen = false;
    try {
      seen = introSeenRecently(window.localStorage.getItem(INTRO_KEY), Date.now());
    } catch {
      // Storage refused (a private window, blocked site data): the film plays, once per page load.
    }
    if (seen) root.setAttribute("data-intro-seen", "");
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    const nav = navRef.current;
    const hero = heroRef.current;
    const copy = copyRef.current;
    const stage = stageRef.current;
    const frame = frameRef.current;
    if (!root || !hero || !copy || !stage || !frame) return;

    // Marks the moment the page can respond. Before this, every way in is a
    // plain link to /?mode=mock — which is why they are links.
    root.setAttribute("data-hydrated", "1");
    window.scrollTo(0, 0);

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const coarse = window.matchMedia("(pointer: coarse)").matches;

    let intent = false;
    const markIntent = () => {
      intent = true;
    };
    let pending = 0;
    let lastHeroH = -1;

    const tick = () => {
      pending = 0;

      // ── READS ──
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const staged = isStaged(vw, vh);
      const heroH = hero.offsetHeight;
      // Position comes from the STAGE, never from the frame's offsetTop: while
      // the entrance animates the frame's wrapper, Blink makes that wrapper the
      // offsetParent, and a first pass measured the frame at 0 — which left the
      // hover's Connect in the wrong place until the next scroll.
      const stageRect = stage.getBoundingClientRect();
      const fW = frame.offsetWidth;
      const fH = frame.offsetHeight;
      const start = Math.max(0, heroH - vh);
      const zoom = vh * (coarse ? ZOOM_VH_COARSE : ZOOM_VH_FINE);
      const p = clamp01(window.scrollY / (start + zoom));

      const tRot = easeInOut(clamp01(p / 0.5));
      const tMove = reduced ? 0 : easeInOut(clamp01((p - 0.1) / 0.8));
      const tScale = easeInOut(clamp01((p - 0.3) / 0.65));
      // The frame's centre: in its layout box now, and where the transform puts it.
      const cx = stageRect.left + stageRect.width / 2;
      const cy = stageRect.top + fH / 2;

      // ── WRITES ──
      const heightChanged = heroH !== lastHeroH;
      if (heightChanged) {
        hero.style.setProperty("--hero-h", `${heroH}px`);
        lastHeroH = heroH;
      }
      // The hover's Connect sits in the middle of the part of the picture you
      // can SEE. Staged, all of it is visible; elsewhere the frame runs off the
      // bottom into the fade, and the true centre of the picture is down there.
      const imageTop = stageRect.top + 33;
      const imageH = fH - 33;
      const seenTop = Math.max(imageTop, 0);
      const seenBottom = Math.min(imageTop + imageH, vh - (staged ? 40 : 140));
      const hy = Math.min(Math.max((seenTop + seenBottom) / 2 - imageTop, 70), imageH - 70);
      frame.style.setProperty("--hy", `${hy}px`);
      root.style.setProperty("--p", String(p));
      root.style.setProperty("--z", String(clamp01((p - 0.8) / 0.15)));
      if (p > 0.01) root.setAttribute("data-zooming", "");
      else root.removeAttribute("data-zooming");

      // The nav leaves before the frame covers the screen, so it never prints
      // over the dashboard's own header row on the way in.
      if (nav) {
        const navOpacity = 1 - clamp01((p - 0.55) / 0.25);
        nav.style.opacity = String(navOpacity);
        nav.style.pointerEvents = navOpacity < 0.5 ? "none" : "";
      }

      copy.style.opacity = String(1 - clamp01(p / 0.3));
      copy.style.pointerEvents = p > 0.25 ? "none" : "";

      const tilt = staged ? REST_TILT_STAGED_DEG : REST_TILT_DEG;
      if (reduced) {
        frame.style.transform = `perspective(1200px) rotateX(${tilt}deg)`;
      } else {
        copy.style.transform = `translate3d(0, ${-32 * easeInOut(clamp01(p / 0.4))}px, 0)`;
        // Cover the viewport on a wide screen; fill its width on a phone, where
        // covering would zoom into a slice of the dashboard.
        const fill = coarse || vw < 768 ? vw / fW : Math.max(vw / fW, vh / fH);
        frame.style.transform =
          `translate3d(${(vw / 2 - cx) * tMove}px, ${(vh / 2 - cy) * tMove}px, 0) ` +
          `perspective(1200px) rotateX(${tilt * (1 - tRot)}deg) scale(${1 + (fill - 1) * tScale})`;
      }

      if (intent && p >= ENTER_TOLERANCE) enter("mock");
      // The sticky top just moved with the height: measure again next frame.
      if (heightChanged) schedule();
    };
    function schedule() {
      if (!pending) pending = window.requestAnimationFrame(tick);
    }
    const onScroll = () => schedule();

    // ── THE INTRO ──
    // The page waits for the film to end (or be skipped), then for itself.
    const intro = root.querySelector<HTMLElement>(".landing-intro");
    const introVideo = intro?.querySelector<HTMLVideoElement>("video") ?? null;
    let introDone = intro === null || root.hasAttribute("data-intro-seen");
    const introTimers: number[] = [];
    let skippedByVisitor = false;
    const finishIntro = () => {
      if (introDone) return;
      introDone = true;
      const built = introVideo !== null && !root.hasAttribute("data-intro-still") && (introVideo.ended || introVideo.currentTime >= INTRO_S_BUILT_S);
      flyFromFilm = !reduced && built;
      // SEEN MEANS SEEN. Only a film that got as far as the S, a skip the visitor
      // chose, or the still that reduced motion asked for counts — and the five
      // minutes run from then. A film that was too slow to start, failed or was
      // refused autoplay does not: it gets another chance on the next load
      // (owner, 10-08: he never saw it).
      if (built || skippedByVisitor || reduced) {
        try {
          window.localStorage.setItem(INTRO_KEY, String(Date.now()));
        } catch {
          // Not remembered: the next visit plays it again. Harmless.
        }
      }
      tryFinish();
    };
    // THE S FLIES TO THE BAR. When the film has built the S, the mark image takes
    // its place on screen — same centre, same size — and travels to the bar's own
    // mark while the page assembles; the bar's mark shows once it lands. Only
    // when the film played: a still, a skip at the point of light, or a returning
    // visitor gets no flight.
    let flyFromFilm = false;
    const fly = () => {
      const plane = root.querySelector<HTMLImageElement>(".landing-intro-fly");
      const mark = root.querySelector<HTMLElement>(".landing-nav-mark");
      if (!plane || !mark) return;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const c = Math.max(vw / INTRO_FRAME.width, vh / INTRO_FRAME.height);
      const h = INTRO_S.height * c;
      const w = h * MARK_ASPECT;
      const left = vw / 2 + (INTRO_S.cx - INTRO_FRAME.width / 2) * c - w / 2;
      const top = vh / 2 + (INTRO_S.cy - INTRO_FRAME.height / 2) * c - h / 2;
      // The bar is not moving yet: its entrance waits for data-loaded, which is set after this.
      const to = mark.getBoundingClientRect();
      if (to.width === 0 || w === 0) return;
      Object.assign(plane.style, { left: `${left}px`, top: `${top}px`, width: `${w}px`, height: `${h}px`, transform: "none" });
      root.setAttribute("data-intro-fly", "");
      const land = () => root.removeAttribute("data-intro-fly");
      plane.addEventListener("transitionend", land, { once: true });
      introTimers.push(window.setTimeout(land, INTRO_FLY_MS + 400));
      // Two frames: the plane must be painted at the film's S before it is told to move.
      window.requestAnimationFrame(() =>
        window.requestAnimationFrame(() => {
          plane.style.transform = `translate(${to.left - left}px, ${to.top - top}px) scale(${to.width / w}, ${to.height / h})`;
          plane.style.filter = "drop-shadow(0 0 0 rgba(52, 211, 153, 0))";
        }),
      );
    };

    let introStarted = false;
    const onIntroPlaying = () => {
      if (introStarted || !introVideo) return;
      introStarted = true;
      const left = Number.isFinite(introVideo.duration) ? (introVideo.duration - introVideo.currentTime) * 1000 : 4000;
      introTimers.push(window.setTimeout(finishIntro, left + INTRO_END_MARGIN_MS));
    };
    const stillThenFinish = () => {
      root.setAttribute("data-intro-still", "");
      introTimers.push(window.setTimeout(finishIntro, INTRO_STILL_MS));
    };
    const skipIntro = (e: Event) => {
      if (introDone) return;
      // A key that means "go on", or any press on the film itself.
      if (e instanceof KeyboardEvent && !["Escape", "Enter", " ", "ArrowDown", "PageDown"].includes(e.key)) return;
      skippedByVisitor = true;
      finishIntro();
    };
    if (!introDone) {
      if (reduced || !introVideo) {
        stillThenFinish();
      } else {
        introVideo.addEventListener("ended", finishIntro);
        introVideo.addEventListener("error", stillThenFinish);
        introVideo.addEventListener("playing", onIntroPlaying);
        // INTRO_SCRIPT started a server-sent film while the page was parsed (play()
        // clears `paused` at once), so its limit runs from navigation. A film this
        // effect starts — a landing React mounts on the client: Back, a Disconnect,
        // the Live toggle, five minutes after the last one — gets the whole limit
        // from now: timed from navigation it was long spent, and the film was cut
        // before its first frame.
        const introFrom = introVideo.paused ? performance.now() : 0;
        // Autoplay refused (iOS Low Power Mode, a strict browser): the poster stands, then the page.
        if (introVideo.paused) introVideo.play().catch(stillThenFinish);
        else onIntroPlaying();
        introTimers.push(
          window.setTimeout(() => {
            if (!introStarted) finishIntro();
          }, Math.max(0, INTRO_START_MS - (performance.now() - introFrom))),
        );
      }
      intro?.addEventListener("pointerdown", skipIntro);
      window.addEventListener("keydown", skipIntro);
    }

    // ── THE LOADER ──
    const img = frame.querySelector("img");
    const box = stage.firstElementChild as HTMLElement | null;
    const timers: number[] = [];
    let loaded = false;
    // The loop starts when the frame has arrived, never under the loader; reduced motion keeps the rest frame.
    const appLoop = frame.querySelector<HTMLVideoElement>(".landing-app-loop");
    const onLoopPlaying = () => root.setAttribute("data-app-loop", "");
    appLoop?.addEventListener("playing", onLoopPlaying);
    const showScene = () => {
      if (root.hasAttribute("data-scene")) return;
      root.setAttribute("data-scene", "");
      if (appLoop && !reduced) appLoop.play().catch(() => {});
    };
    const onBoxRise = (e: AnimationEvent) => {
      if (e.target !== box || e.animationName !== "landing-in-frame") return;
      showScene();
    };
    const finishLoading = () => {
      if (loaded) return;
      loaded = true;
      if (flyFromFilm) fly();
      root.setAttribute("data-loaded", "");
      schedule();
      if (reduced || !box) {
        showScene();
      } else {
        box.addEventListener("animationend", onBoxRise);
        timers.push(window.setTimeout(showScene, SCENE_FALLBACK_MS));
      }
    };
    function tryFinish() {
      if (loaded || !introDone) return;
      // A screenshot that failed before hydration fired its `error` before this
      // listener existed: complete with no pixels is broken, and waiting for it
      // is waiting for MAX (measured: 8.2 s of spinner for a blocked image).
      if (img && img.complete && img.naturalWidth === 0) {
        finishLoading();
        return;
      }
      const imageReady = !img || (img.complete && img.naturalWidth > 0);
      if (!imageReady || document.fonts.status !== "loaded") return;
      // performance.now() counts from navigation, so the time the mark was on
      // screen before hydration counts toward MIN; a remount (Back) is long past it.
      timers.push(window.setTimeout(finishLoading, Math.max(0, MIN_LOADER_MS - performance.now())));
    }
    img?.addEventListener("load", tryFinish);
    img?.addEventListener("error", finishLoading);
    void document.fonts.ready.then(tryFinish);
    timers.push(window.setTimeout(finishLoading, MAX_LOADER_MS));
    tryFinish();

    const INTENT = ["wheel", "touchstart", "keydown", "pointerdown"];
    const ro = new ResizeObserver(schedule);
    ro.observe(hero);
    // Staged, the hero is exactly one viewport tall and never resizes when the
    // words reflow — but the stage does, and the frame is placed from it.
    ro.observe(stage);
    // The entrance ends without a scroll or a resize; measure once more then.
    hero.addEventListener("animationend", schedule);
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", schedule);
    for (const ev of INTENT) window.addEventListener(ev, markIntent, { passive: true });
    schedule();

    return () => {
      ro.disconnect();
      hero.removeEventListener("animationend", schedule);
      window.cancelAnimationFrame(pending);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", schedule);
      for (const ev of INTENT) window.removeEventListener(ev, markIntent);
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      for (const t of timers) window.clearTimeout(t);
      for (const t of introTimers) window.clearTimeout(t);
      introVideo?.removeEventListener("ended", finishIntro);
      introVideo?.removeEventListener("error", stillThenFinish);
      introVideo?.removeEventListener("playing", onIntroPlaying);
      intro?.removeEventListener("pointerdown", skipIntro);
      window.removeEventListener("keydown", skipIntro);
      box?.removeEventListener("animationend", onBoxRise);
      appLoop?.removeEventListener("playing", onLoopPlaying);
      img?.removeEventListener("load", tryFinish);
      img?.removeEventListener("error", finishLoading);
    };
  }, [enter]);

  return (
    <div
      ref={rootRef}
      className={cn(
        "landing-root relative bg-[#0A0B11] text-white transition-opacity duration-[420ms] ease-out",
        leaving && "opacity-0",
      )}
      style={{ ["--p" as string]: 0, ["--z" as string]: 0 }}
      // INTRO_SCRIPT may mark this element (data-intro-seen) before React hydrates it.
      suppressHydrationWarning
    >
      {walletsConfigured ? <LoginWatcher loginRef={loginRef} onComplete={onLoginComplete} onError={onLoginError} /> : null}

      {/* ── The intro: the launch film's logo build, unless seen in the last five minutes ── */}
      <div className="landing-intro">
        {/* preload="none": a visitor who has seen it downloads nothing; INTRO_SCRIPT starts it for everybody else.
            NO POSTER: the still is the film's LAST frame, and as a poster it showed the finished S before the
            film started from its point of light. The ground is the film's first frame anyway. */}
        <video className="landing-intro-video" muted playsInline preload="none" aria-hidden>
          <source src={INTRO.wide.webm} type="video/webm" media={INTRO_WIDE_MEDIA} />
          <source src={INTRO.wide.mp4} type="video/mp4" media={INTRO_WIDE_MEDIA} />
          <source src={INTRO.narrow.webm} type="video/webm" />
          <source src={INTRO.narrow.mp4} type="video/mp4" />
        </video>
        {/* The finished S, for reduced motion and for a film that cannot play (data-intro-still). */}
        <img className="landing-intro-still" src={INTRO.poster} alt="" aria-hidden decoding="async" />
        <button type="button" className={cn("landing-intro-skip", FOCUS)}>
          Skip intro
        </button>
      </div>
      <script dangerouslySetInnerHTML={{ __html: INTRO_SCRIPT }} />
      {/* The S that flies from the film's centre to the bar (data-intro-fly). */}
      <img
        className="landing-intro-fly"
        src="/logo/sip-mark-white.png"
        alt=""
        aria-hidden
        style={{ transition: `transform ${INTRO_FLY_MS}ms cubic-bezier(0.65, 0, 0.35, 1), filter ${INTRO_FLY_MS}ms ease` }}
      />

      {/* ── The loader: the mark filling inside a spinning ring ─────────── */}
      <div className="landing-loader" role="status" aria-live="polite">
        <div className="landing-loader-spin">
          <svg className="landing-loader-ring" viewBox="0 0 80 80" aria-hidden>
            <circle cx="40" cy="40" r="37" fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="1.5" />
            <circle
              cx="40"
              cy="40"
              r="37"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeDasharray="58 175"
            />
          </svg>
          <span className="landing-loader-mark" aria-hidden />
        </div>
        <span className="sr-only">Loading</span>
      </div>

      {/* ── The ground: the S's blueprint, drifting with the scroll ──────── */}
      <div aria-hidden className="landing-fade pointer-events-none fixed inset-0 z-0" style={{ animationDelay: "0.1s" }}>
        <LandingBackdrop />
        {/* The words sit over the top of it. */}
        <div className="landing-scrim-top absolute inset-x-0 top-0 h-[75%] bg-gradient-to-b from-[#0A0B11] via-[#0A0B11]/75 to-transparent" />
        <div className="absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-[#0A0B11] to-transparent" />
        <div className="landing-grain absolute inset-0 opacity-70 mix-blend-soft-light" />
        {/* Over the scrims, so a card low in the gutter is not dimmed by the bottom fade. */}
        <ExampleActivity />
      </div>

      {/* ── Nav ─────────────────────────────────────────────────────────── */}
      <nav
        ref={navRef}
        className="landing-in landing-in-down fixed inset-x-0 top-0 z-[60] flex items-center justify-between px-5 py-4 sm:px-8 sm:py-5 md:px-10"
        style={{ animationDelay: "0.55s" }}
      >
        <span className="flex items-center gap-2.5">
          <Image src="/logo/sip-mark-white.png" alt="" width={22} height={26} priority className="landing-nav-mark" />
          <span className="text-sm font-medium tracking-wide">SaverFi</span>
        </span>
        <span className="flex items-center gap-2">
          {/*
            REAL NAVIGATIONS, NOT THE TRANSITION. The fade (enter) is for the
            ways into the app — See the app and the scroll to the example,
            Connect to the pension (THE WAYS OUT, at the top of this file). The
            rankings and the Dashboard are other pages, public, and must not be
            intercepted by it — so no onClick.

            FROM sm UP HERE: the rankings are also in the hero row at every
            size, the Dashboard only below sm. On a 375px phone a third item in
            this bar crowds Connect, and Connect is what this page is for.

            THEN THE BAR'S TWO SIDES (owner, 10-08), as in the app's own header:
            the pages, Dashboard last; a rule; and the account — Connect.
          */}
          <a
            href="/leaderboard"
            className={cn(
              "hidden rounded-full px-4 py-2 text-sm font-medium text-white/70 transition-colors hover:text-white sm:inline-flex",
              FOCUS,
            )}
          >
            Leaderboard
          </a>
          <a
            href="/?mode=mock"
            onClick={enterFromLink}
            className={cn(
              "hidden rounded-full px-4 py-2 text-sm font-medium text-white/70 transition-colors hover:text-white md:inline-flex",
              FOCUS,
            )}
          >
            See the app
          </a>
          <a
            href="/dashboard"
            className={cn(
              "hidden rounded-full px-4 py-2 text-sm font-medium text-white/70 transition-colors hover:text-white sm:inline-flex",
              FOCUS,
            )}
          >
            Dashboard
          </a>
          <Separator orientation="vertical" className="mr-2 ml-1 hidden h-5 bg-white/15 data-vertical:self-center sm:block" />
          <ConnectButton connect={connect} label={connectLabel} size="sm" />
        </span>
      </nav>

      {/* ── Hero: the words, then the frame. Pins by its foot. ──────────── */}
      <section
        ref={heroRef}
        className="landing-hero sticky z-[3] flex min-h-dvh w-full flex-col overflow-clip pt-[104px] pb-12"
        style={{ top: "min(0px, calc(100dvh - var(--hero-h, 100dvh)))" }}
      >
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{ background: "radial-gradient(55% 45% at 16% 16%, rgba(16,185,129,0.10) 0%, transparent 60%)" }}
        />

        {/* The copy, on top. */}
        <div ref={copyRef} className="relative z-[5] px-6 sm:px-10 md:px-14" style={{ willChange: "transform, opacity" }}>
          <div className="grid grid-cols-1 items-end gap-5 md:grid-cols-12 md:gap-12">
            <div className="landing-copy-main md:col-span-7 lg:col-span-8">
              <p
                className="landing-eyebrow landing-eyebrow-main landing-in landing-in-side mb-5 flex items-center gap-2.5 text-sm text-white/70 sm:text-[15px]"
                style={{ animationDelay: "0.1s" }}
              >
                <span className="size-2.5 rounded-full bg-white/80" />
                <span className="tracking-wide">A pension that builds itself, on Solana</span>
              </p>
              <h1 className="landing-h1 mb-6 text-[clamp(2.2rem,6.5vw,5rem)] font-light leading-[0.95] tracking-[-0.03em] sm:mb-8">
                {/* Line by line, each out of its own blur. One string per line, so the words never split. */}
                <span className="landing-in landing-in-blur block" style={{ animationDelay: "0.2s" }}>
                  A slice of every trade,
                </span>
                <span className="landing-in landing-in-blur block" style={{ animationDelay: "0.42s" }}>
                  put aside for later.
                </span>
              </h1>
              <div className="flex flex-wrap items-center gap-3">
                <span className="landing-in landing-in-pop inline-flex" style={{ animationDelay: "0.75s" }}>
                  <ConnectButton connect={connect} label={connectLabel} size="lg" />
                </span>
                <a
                  href="/?mode=mock"
                  onClick={enterFromLink}
                  className={cn(
                    "landing-in landing-in-pop flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-6 py-3 text-sm font-medium text-white/90 backdrop-blur-sm transition-all hover:bg-white/15 sm:px-7 sm:py-3.5",
                    FOCUS,
                  )}
                  style={{ animationDelay: "0.86s" }}
                >
                  See the app
                  <ArrowUpRight size={14} aria-hidden />
                </a>
                {/* Quieter than the two beside it, and shown at EVERY width:
                    this is the only way to the rankings from a phone, where the
                    bar above drops its links to leave Connect room. */}
                <a
                  href="/leaderboard"
                  className={cn(
                    "landing-in landing-in-pop flex items-center gap-1.5 px-2 py-3 text-sm font-medium text-white/60 transition-colors hover:text-white",
                    FOCUS,
                  )}
                  style={{ animationDelay: "0.98s" }}
                >
                  Leaderboard
                  <ArrowUpRight size={14} aria-hidden />
                </a>
                {/* The same, for the all-pensions page: only on a phone, where the bar shows Connect alone. */}
                <a
                  href="/dashboard"
                  className={cn(
                    "landing-in landing-in-pop flex items-center gap-1.5 px-2 py-3 text-sm font-medium text-white/60 transition-colors hover:text-white sm:hidden",
                    FOCUS,
                  )}
                  style={{ animationDelay: "1.04s" }}
                >
                  Dashboard
                  <ArrowUpRight size={14} aria-hidden />
                </a>
              </div>
              {/* A Connect that did not go through says why, where the buttons are. */}
              {failure !== null && (
                <p role="alert" className="mt-3 max-w-md text-xs leading-relaxed text-red-300/90">
                  {failure}
                </p>
              )}
            </div>
            <div className="landing-copy-aside landing-in landing-in-up md:col-span-5 lg:col-span-4" style={{ animationDelay: "0.62s" }}>
              {/* The same eyebrow, shown here instead of above the headline only
                  on a short, wide staged window: this column is the shorter one
                  there, so the line costs the frame nothing (THE STAGED LANDING
                  in globals.css). display:none on the other copy keeps assistive
                  technology from reading it twice. */}
              <p className="landing-eyebrow-aside mb-2 hidden items-center gap-2.5 text-sm text-white/70">
                <span className="size-2.5 rounded-full bg-white/80" />
                <span className="tracking-wide">A pension that builds itself, on Solana</span>
              </p>
              <p className="landing-copy-lede text-[15px] leading-relaxed text-white/70 sm:text-base">
                Trade as usual and grow your own onchain pension. Each trade automatically puts a share of its volume (or
                of its profit) into a pension only you control.
              </p>
              {/* True of the program today, and to be replaced by the new truth
                  when its upgrade authority moves behind a delay — not by the
                  absolutes it replaced. */}
              <p className="landing-in landing-in-up mt-3 text-xs leading-relaxed text-white/45" style={{ animationDelay: "1.1s" }}>
                Beta · Only you can manage your vault and withdraw whenever you wish. The team holds none of your keys or
                assets, but can still update the SaverFi program.
              </p>
            </div>
          </div>
        </div>

        {/* The frame. Staged, it sits in the middle of the scene and takes the
            height the words leave; elsewhere it runs off the bottom. Its wrapper
            carries the entrance; the frame carries the measured transform; they
            never share an element. The stage around both never transforms, which
            is why the loop measures it. */}
        <div ref={stageRef} className="landing-stage mt-10 flex justify-center px-5 md:mt-14">
          <div className="landing-box landing-in landing-in-frame w-full max-w-[1100px]" style={{ animationDelay: `${FRAME_RISE_DELAY_S}s` }}>
            <div
              ref={frameRef}
              className="group relative z-[6] flex w-full flex-col overflow-hidden border border-white/10 bg-[#0d0e15] shadow-[0_40px_120px_-20px_rgba(0,0,0,0.8),0_0_0_1px_rgba(255,255,255,0.04)_inset]"
              style={{
                borderRadius: "calc(12px * (1 - var(--z)))",
                transform: `perspective(1200px) rotateX(${REST_TILT_DEG}deg)`,
                transformOrigin: "50% 50%",
                willChange: "transform",
              }}
            >
              {/* Title strip — and the disclosure, in real text, in the page's own type. */}
              <span
                aria-hidden
                className="flex h-8 shrink-0 items-center gap-1.5 border-b border-white/[0.06] px-3.5"
                style={{ opacity: "calc(1 - var(--z))" }}
              >
                <span className="size-2.5 rounded-full bg-white/15" />
                <span className="size-2.5 rounded-full bg-white/15" />
                <span className="size-2.5 rounded-full bg-white/15" />
                <span className="ml-3 flex h-4 min-w-0 flex-1 items-center rounded-sm bg-white/[0.04] px-2 text-xs text-white/70">
                  <span className="truncate">Example — nobody&rsquo;s pension</span>
                </span>
              </span>

              <div className="relative aspect-[16/10] w-full">
                <Image
                  src={APP_LOOP.poster}
                  alt="The SaverFi dashboard on example data: what each trade put aside, the pension's growth, and the savings rule"
                  fill
                  priority
                  sizes="(min-width: 1280px) 1440px, 100vw"
                  className="object-cover object-top"
                />
                {/* The loop, over its own rest frame: shown once it is actually playing (data-app-loop). */}
                <video className="landing-app-loop absolute inset-0 h-full w-full object-cover object-top" muted playsInline loop preload="auto" aria-hidden>
                  <source src={APP_LOOP.webm} type="video/webm" />
                  <source src={APP_LOOP.mp4} type="video/mp4" />
                </video>
                {/* Anywhere on the picture opens the example. */}
                <a
                  href="/?mode=mock"
                  onClick={enterFromLink}
                  aria-label={opensPension ? "Open the app" : "Open the app with example data"}
                  className="absolute inset-0 z-10 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/60"
                />
                {/* Hover: the picture softens behind a Connect in the middle. A
                    sibling of the link, never inside it; it takes pointer events
                    only for the button, and only while it shows. */}
                <div className="landing-hover absolute inset-0 z-20 bg-[#0A0B11]/30 backdrop-blur-[6px]">
                  <div
                    className="absolute inset-x-0 flex -translate-y-1/2 flex-col items-center gap-3"
                    style={{ top: "var(--hy, 50%)" }}
                  >
                    <ConnectButton connect={connect} label={connectLabel} size="lg" />
                    {/* Not to a connected key: the picture takes it to its own pension (rule 4), not to the example. */}
                    {opensPension ? null : (
                      <span aria-hidden className="text-xs text-white/75">
                        or click anywhere to explore the example
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* The runway the gesture travels, after the hero so the hero can pin. */}
      <div aria-hidden className="h-[105dvh] pointer-coarse:h-[115dvh]" />

      {/* Bottom fade and the cue. */}
      <div
        aria-hidden
        className="landing-bottom-fade pointer-events-none fixed inset-x-0 bottom-0 z-[6] h-40 bg-gradient-to-t from-[#0A0B11] to-transparent"
        style={{ opacity: "clamp(0, calc(1 - var(--p) * 5), 1)" }}
      />
      <div
        aria-hidden
        className="pointer-events-none fixed inset-x-0 bottom-4 z-[7] flex justify-center"
        style={{ opacity: "clamp(0, calc(0.7 - var(--p) * 4), 0.7)" }}
      >
        <span className="flex items-center gap-1.5 text-[11px] uppercase tracking-[0.18em] text-white">
          <ArrowDown size={12} />
          Scroll to enter
        </span>
      </div>
    </div>
  );
}

/**
 * PRIVY'S LOGIN, WHERE THERE IS A PRIVY. useLogin reads the provider's context
 * and throws without one (measured, 10-08: "Cannot read properties of
 * undefined (reading 'current')" on a deployment with no configuration — where
 * there is no PrivyProvider and Connect opens the setup modal instead). So the
 * landing mounts this only when the deployment is configured, and it hands the
 * login function up through a ref.
 */
function LoginWatcher({
  loginRef,
  onComplete,
  onError,
}: {
  readonly loginRef: React.RefObject<(() => void) | null>;
  readonly onComplete: (complete: { readonly wasAlreadyAuthenticated: boolean }) => void;
  readonly onError: (code: unknown) => void;
}) {
  const { login } = useLogin({ onComplete, onError });
  useEffect(() => {
    loginRef.current = () => login();
    return () => {
      loginRef.current = null;
    };
  }, [login, loginRef]);
  return null;
}

/**
 * The one white button, in two sizes: Connect, or "Open my pension" for somebody
 * already connected. While it cannot act it is still a real, named, focusable
 * button — dimmed and aria-disabled — so its place in the tab order and on the
 * page never changes.
 */
function ConnectButton({ connect, label, size }: { connect: (() => void) | null; label: string; size: "sm" | "lg" }) {
  const cls =
    size === "lg"
      ? "rounded-full bg-white px-7 py-3 text-sm font-medium text-gray-900 transition-all hover:bg-white/90 sm:px-8 sm:py-3.5"
      : "rounded-full bg-white px-5 py-2 text-sm font-medium text-gray-900 transition-colors hover:bg-white/90";
  return (
    <button
      type="button"
      aria-disabled={connect === null ? true : undefined}
      onClick={connect ?? undefined}
      className={cn(cls, FOCUS, connect === null && "animate-pulse cursor-default bg-white/30 text-white/40 hover:bg-white/30")}
    >
      {label}
    </button>
  );
}
