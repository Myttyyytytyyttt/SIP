"use client";

/**
 * WHAT SOMEBODY SEES BEFORE THEY CONNECT — the words on top, and the app in the
 * middle of a night scene, brought to the screen by a scroll.
 *
 * On a screen with room (wide, landscape, at least 600px tall) the headline and
 * the ways in run across the top, and below them a frame holding a screenshot of
 * the dashboard on example data sits in the middle of the background footage,
 * almost facing the viewer. On a phone, a portrait tablet or a short window
 * there is no room for that: the frame sits under the words, tilted back and
 * running off the bottom, over blurred footage. Either way, scroll and the
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
 * the nav's fade, the footage's placement and the video's time. Transforms and
 * opacity never dirty layout, so nothing is forced.
 *
 * PROGRESSIVE, ON PURPOSE. Every way in except Connect is <a href="/?mode=mock">:
 * before hydration a click is a navigation and still arrives; after it, the
 * click becomes a fade. The shell pushes that URL on entry, so Back returns
 * here — and this page resets its scroll on mount and only enters on a gesture
 * the visitor made, so a restored scroll position cannot re-enter it.
 *
 * THE LOADER, AND WHY THE SCENE COMES LAST. The page opens on the SIP mark in a
 * spinning ring and stays there until the frame can stand in front of the
 * footage. Then the words and the frame rise, and only once the frame has fully
 * arrived does the footage fade in behind it. The order is the point: a first
 * version showed the footage at ~0.3 s while the frame's entrance ran from 0.8
 * to 1.7 s, so for about a second the placeholder's card stood alone in the
 * middle of the page — correctly placed, behind a frame nobody could see yet.
 *
 * COMMITTED DARK, whatever the theme: the screenshot and the footage are dark.
 *
 * THE INTRO (owner, 10-07). The first time somebody opens the landing in a tab,
 * the loader is the launch film's green logo build instead of the spinning
 * ring: the point of light, the guides, the pieces of the S locking together,
 * the bloom. The page is revealed when the film has ended AND the page is ready,
 * whichever comes last; a click, a tap or a key skips it. Later visits in the
 * same tab get the ring. Reduced motion shows the film's last frame, still.
 * The decision is made BEFORE THE FIRST PAINT by a few lines of inline script
 * (sessionStorage is not readable on the server), so a returning visitor never
 * sees the film start and vanish.
 *
 * THEN THE PAGE ARRIVES OUT OF STEP (owner, 10-07): not one rise for everything
 * but each element with its own effect and its own moment — the headline line
 * by line out of a blur, the eyebrow from the side, the buttons popping in one
 * after another, the frame rising from below — see THE ENTRANCE in globals.css.
 */

import Image from "next/image";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { usePrivy } from "@privy-io/react-auth";
import { ArrowDown, ArrowUpRight } from "lucide-react";

import { useWalletsOpener } from "@/components/wallets-host";
import { cn } from "@/lib/utils";

/**
 * THE BACKGROUND FOOTAGE IS A PLACEHOLDER. It is the reference template's clip:
 * a credit card branded "INFINITE". It is here because the owner asked for the
 * template's video; it must be replaced with SIP's own before anyone outside
 * the team sees this page — another brand's name and a credit card on a
 * pension's front door is not a detail. It also lives on a third party's CDN,
 * which can vanish: self-host the replacement under public/landing/ and drop
 * the host from media-src in security-headers.mjs. Everything under THE
 * PLACEHOLDER'S GEOMETRY is fitted to this clip and is void for any other.
 */
const BACKGROUND_VIDEO =
  "https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260630_060707_72cd8ca2-3e4b-460c-9293-575573810866.mp4";

/**
 * THE PLACEHOLDER'S GEOMETRY — measured on that clip, void for any other.
 *
 * On a staged screen the clip is moved and scaled so its card sits behind the
 * frame, which is what lets the footage play unblurred: the card, and the brand
 * printed on it, are hidden rather than smeared. CLIP_CARD_BOX is the largest
 * extent the card reaches over the scrubbed range, as shares of the clip's
 * frame: measured frame by frame every 0.1 s from 0 to 1.4 s by detecting its
 * rim and glow against their surroundings (union left 0.417, right 0.591, top
 * 0.287, bottom 0.710 — two independent prototype measurements agreed within
 * 0.01), then padded by 0.008 on every side. A first, eyeballed box that
 * included the unscrubbed 1.6 s was 11% taller and blurred the footage on the
 * commonest laptop screens for a card that is never that big. FOOTAGE_TOP_ALLOWANCE is how far the clip's top edge may sit below
 * the viewport's top, hidden under the top scrim. SCRUB_SECONDS stops the scroll
 * at the calm first stretch: from ~1.9 s the clip fills the screen with the card
 * and its brand at a size no frame can cover. Replace the clip, re-measure all
 * of these, and redo the brand check at rest and mid-scroll.
 */
const CLIP_CARD_BOX = { left: 0.409, right: 0.599, top: 0.279, bottom: 0.718 } as const;
const FOOTAGE_TOP_ALLOWANCE = 80;
const SCRUB_SECONDS = 1.4;

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
/** sessionStorage: the film is for the first visit in a tab. */
const INTRO_KEY = "saverfi.intro";
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
 * Runs while the HTML is parsed, before the first paint: a visitor who has seen
 * the film in this tab gets the ring (data-intro-seen), anybody else's film
 * starts now rather than at hydration. The same decision is made again in a
 * layout effect for a landing React mounts on the client, where this does not run.
 */
const INTRO_SCRIPT = `(function(){var r=document.currentScript&&document.currentScript.parentElement;if(!r)return;var s=false;try{s=sessionStorage.getItem(${JSON.stringify(INTRO_KEY)})==="seen"}catch(e){}if(s){r.setAttribute("data-intro-seen","");return}if(window.matchMedia&&matchMedia("(prefers-reduced-motion: reduce)").matches)return;var v=r.querySelector(".landing-intro-video");if(v){var p=v.play();if(p&&p.catch)p.catch(function(){})}})();`;

/**
 * THE LOADER lifts when the screenshot has decoded and the fonts are in (so
 * nothing reflows under the frame), but not before MIN — a fast load should not
 * flash the mark — and no later than MAX: if the screenshot never arrives the
 * frame's own opaque ground still covers the card, and a page is better than a
 * spinner. The footage then waits for the frame's entrance to END; the fallback
 * covers an animationend that never fires (a backgrounded tab throttles them).
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

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const easeInOut = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);

export function Landing({
  onEnter,
  walletsConfigured,
}: {
  onEnter: () => void;
  /**
   * Whether the wallets modal has a configuration. Without one there is no
   * Privy provider above us, `ready` never comes, and the honest Connect is the
   * one that opens the setup modal naming the missing variables.
   */
  walletsConfigured: boolean;
}) {
  const { ready, login } = usePrivy();
  const openWallets = useWalletsOpener();

  const rootRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const heroRef = useRef<HTMLElement>(null);
  const copyRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  const [leaving, setLeaving] = useState(false);
  const enteredRef = useRef(false);
  const timerRef = useRef<number | null>(null);

  const enter = useCallback(() => {
    if (enteredRef.current) return;
    enteredRef.current = true;
    setLeaving(true);
    timerRef.current = window.setTimeout(() => {
      window.scrollTo({ top: 0, behavior: "auto" });
      onEnter();
    }, LEAVE_MS);
  }, [onEnter]);

  // A modified click (new tab, new window) is a real navigation to the same
  // URL; a plain one becomes the fade.
  const enterFromLink = useCallback(
    (e: React.MouseEvent<HTMLAnchorElement>) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
      e.preventDefault();
      enter();
    },
    [enter],
  );

  // Connect, in its three honest states: opens the setup modal when the
  // deployment is incomplete; logs in when Privy can; otherwise a named,
  // focusable, aria-disabled button — never a nameless placeholder.
  const connect: (() => void) | null =
    !walletsConfigured && openWallets !== null ? openWallets : ready ? () => login() : null;

  // THE INTRO'S DECISION, for a landing React mounts on the client (INTRO_SCRIPT
  // ran only if the server sent this page). Before paint, so the film never
  // flashes for somebody who has seen it. Idempotent with the script.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let seen = false;
    try {
      seen = window.sessionStorage.getItem(INTRO_KEY) === "seen";
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
    const video = videoRef.current;
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
    let lastFootage: string | null = null;
    let primed = false;

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
      const clipW = video?.videoWidth || 1920;
      const clipH = video?.videoHeight || 1080;

      const tRot = easeInOut(clamp01(p / 0.5));
      const tMove = reduced ? 0 : easeInOut(clamp01((p - 0.1) / 0.8));
      const tScale = easeInOut(clamp01((p - 0.3) / 0.65));
      // The frame's centre: in its layout box now, and where the transform puts it.
      const cx = stageRect.left + stageRect.width / 2;
      const cy = stageRect.top + fH / 2;
      const cyNow = cy + (vh / 2 - cy) * tMove;

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

        if (video && video.readyState >= 1 && Number.isFinite(video.duration) && !video.seeking) {
          const t = p * Math.min(video.duration, SCRUB_SECONDS) * 0.999;
          if (Math.abs(video.currentTime - t) > 0.03) video.currentTime = t;
        }
      }

      // THE FOOTAGE, STAGED: the clip's card behind the frame, following it as
      // it rises. The scale is fixed at rest — enough that the clip's top edge
      // stays under the scrim and its bottom edge off the screen — and only the
      // translation tracks the frame, so the landscape moves with the gesture
      // instead of the card slipping out from under it (a first version kept the
      // footage still, and the card's edge showed under the rising frame).
      if (video) {
        let footage = "";
        let exposed = false;
        if (staged) {
          const c = Math.max(vw / clipW, vh / clipH);
          const W = clipW * c;
          const H = clipH * c;
          const ox = (vw - W) / 2;
          const oy = (vh - H) / 2;
          const boxCx = (CLIP_CARD_BOX.left + CLIP_CARD_BOX.right) / 2;
          const boxCy = (CLIP_CARD_BOX.top + CLIP_CARD_BOX.bottom) / 2;
          const cyRest = cy + Math.min(window.scrollY, start);
          const S = Math.max(1, (cyRest - FOOTAGE_TOP_ALLOWANCE) / (boxCy * H), (vh - cyRest) / ((1 - boxCy) * H));
          const tx = cx - vw / 2 - S * (ox + boxCx * W - vw / 2);
          const ty = cyNow - vh / 2 - S * (oy + boxCy * H - vh / 2);
          footage = `translate3d(${tx.toFixed(1)}px, ${ty.toFixed(1)}px, 0) scale(${S.toFixed(4)})`;
          // THE SAFETY NET. On a screen shape nobody measured, a frame smaller
          // than the card gets the blur back, not the brand.
          const cardW = S * (CLIP_CARD_BOX.right - CLIP_CARD_BOX.left) * W;
          const cardH = S * (CLIP_CARD_BOX.bottom - CLIP_CARD_BOX.top) * H;
          exposed = cardW > fW - 16 || cardH > fH - 16;
        }
        if (footage !== lastFootage) {
          video.style.transform = footage;
          lastFootage = footage;
        }
        root.toggleAttribute("data-footage-exposed", exposed);
        root.setAttribute("data-footage-ready", "");
      }

      if (intent && p >= ENTER_TOLERANCE) enter();
      // The sticky top just moved with the height: measure again next frame.
      if (heightChanged) schedule();
    };
    function schedule() {
      if (!pending) pending = window.requestAnimationFrame(tick);
    }
    const onScroll = () => {
      // iOS will not paint a seeked frame of a video that has never played.
      if (!primed && video && coarse) {
        primed = true;
        video.play().then(() => video.pause()).catch(() => {});
      }
      schedule();
    };

    // ── THE INTRO ──
    // The page waits for the film to end (or be skipped), then for itself.
    const intro = root.querySelector<HTMLElement>(".landing-intro");
    const introVideo = intro?.querySelector<HTMLVideoElement>("video") ?? null;
    let introDone = intro === null || root.hasAttribute("data-intro-seen");
    const introTimers: number[] = [];
    const finishIntro = () => {
      if (introDone) return;
      introDone = true;
      flyFromFilm = !reduced && introVideo !== null && !root.hasAttribute("data-intro-still") && (introVideo.ended || introVideo.currentTime >= INTRO_S_BUILT_S);
      try {
        window.sessionStorage.setItem(INTRO_KEY, "seen");
      } catch {
        // Not remembered: the next visit in this tab plays it again. Harmless.
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
      finishIntro();
    };
    if (!introDone) {
      if (reduced || !introVideo) {
        stillThenFinish();
      } else {
        introVideo.addEventListener("ended", finishIntro);
        introVideo.addEventListener("error", stillThenFinish);
        introVideo.addEventListener("playing", onIntroPlaying);
        // Autoplay refused (iOS Low Power Mode, a strict browser): the poster stands, then the page.
        if (introVideo.paused) introVideo.play().catch(stillThenFinish);
        else onIntroPlaying();
        introTimers.push(
          window.setTimeout(() => {
            if (!introStarted) finishIntro();
          }, Math.max(0, INTRO_START_MS - performance.now())),
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
      // iOS loads nothing for a video it has not been asked to play. A muted,
      // inline play() is allowed; pausing at once leaves the first frame showing.
      if (video && coarse && !primed) {
        primed = true;
        video.play().then(() => video.pause()).catch(() => {});
      }
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
    const onVideoData = () => root.setAttribute("data-footage-loaded", "");
    if (video && video.readyState >= 2) onVideoData();
    video?.addEventListener("loadeddata", onVideoData);
    img?.addEventListener("load", tryFinish);
    img?.addEventListener("error", finishLoading);
    void document.fonts.ready.then(tryFinish);
    timers.push(window.setTimeout(finishLoading, MAX_LOADER_MS));
    tryFinish();

    const INTENT = ["wheel", "touchstart", "keydown", "pointerdown"];
    const ro = new ResizeObserver(schedule);
    ro.observe(hero);
    // Staged, the hero is exactly one viewport tall and never resizes when the
    // words reflow — but the stage does, and the footage is placed from it.
    ro.observe(stage);
    // The entrance ends without a scroll or a resize; measure once more then.
    hero.addEventListener("animationend", schedule);
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", schedule);
    for (const ev of INTENT) window.addEventListener(ev, markIntent, { passive: true });
    video?.addEventListener("seeked", schedule);
    video?.addEventListener("loadedmetadata", schedule);
    schedule();

    return () => {
      ro.disconnect();
      hero.removeEventListener("animationend", schedule);
      window.cancelAnimationFrame(pending);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", schedule);
      for (const ev of INTENT) window.removeEventListener(ev, markIntent);
      video?.removeEventListener("seeked", schedule);
      video?.removeEventListener("loadedmetadata", schedule);
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
      video?.removeEventListener("loadeddata", onVideoData);
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
      {/* ── The intro: the launch film's logo build, first visit only ───── */}
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

      {/* ── Background footage, scrubbed by the scroll ─────────────────── */}
      <div aria-hidden className="landing-fade pointer-events-none fixed inset-0 z-0" style={{ animationDelay: "0.1s" }}>
        {/* BLURRED WHERE IT CANNOT BE HIDDEN. Every stretch of the placeholder
            clip shows another brand's card. Staged, the card sits behind the
            frame and the footage plays sharp (THE STAGED LANDING in globals.css
            lifts the blur, and hides the video until the loop has placed it).
            On a phone, a portrait tablet or a short window the frame is smaller
            than the card, so there the blur stays: as ambience the footage
            still moves with the scroll; as text it says nothing. Drop the blur
            together with the placeholder. Everywhere, it is invisible until the
            frame has fully arrived in front of it (THE LOADER). */}
        <video
          ref={videoRef}
          src={BACKGROUND_VIDEO}
          muted
          playsInline
          preload="auto"
          className="landing-footage h-full w-full scale-110 object-cover opacity-60 blur-[10px]"
        />
        {/* The words sit over the top of it. */}
        <div className="landing-scrim-top absolute inset-x-0 top-0 h-[75%] bg-gradient-to-b from-[#0A0B11] via-[#0A0B11]/75 to-transparent" />
        <div className="absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-[#0A0B11] to-transparent" />
        <div className="landing-grain absolute inset-0 opacity-70 mix-blend-soft-light" />
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
            A REAL NAVIGATION, NOT THE TRANSITION. Every other way out of this
            page is `/?mode=mock` through enterFromLink, which is the in-page
            scroll into the dashboard; the rankings are a different page, public,
            and must not be intercepted by it — so no onClick.

            FROM sm UP HERE, and in the hero row at every size: on a 375px phone
            a third item in this bar crowds Connect, and Connect is what this
            page is for.
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
          <ConnectButton connect={connect} size="sm" />
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
                  <ConnectButton connect={connect} size="lg" />
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
              </div>
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
                SaverFi puts a slice of your trading — 1% of its volume or 20% of its realized profit, yours to set — into a
                pension of your own. Trade wherever you already trade — GMGN, Axiom, your own router — and it grows on
                its own.
              </p>
              {/* True of the program today, and to be replaced by the new truth
                  when its upgrade authority moves behind a delay — not by the
                  absolutes it replaced. */}
              <p className="landing-in landing-in-up mt-3 text-xs leading-relaxed text-white/45" style={{ animationDelay: "1.1s" }}>
                Beta. The team has no key to your pension, but the SaverFi program is upgradeable by its upgrade authority —
                today a single team key with no timelock.
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
                  aria-label="Open the app with example data"
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
                    <ConnectButton connect={connect} size="lg" />
                    <span aria-hidden className="text-xs text-white/75">
                      or click anywhere to explore the example
                    </span>
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
 * The one white button, in two sizes and three states. While it cannot act it
 * is still a real, named, focusable button — dimmed and aria-disabled — so its
 * place in the tab order and on the page never changes.
 */
function ConnectButton({ connect, size }: { connect: (() => void) | null; size: "sm" | "lg" }) {
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
      Connect
    </button>
  );
}
