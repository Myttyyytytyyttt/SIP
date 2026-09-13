"use client";

/**
 * WHAT SOMEBODY SEES BEFORE THEY CONNECT — the words on top, the app below,
 * and a scroll that brings the app to the screen.
 *
 * At rest: the headline and the ways in at the top, and under them a frame
 * holding a screenshot of the dashboard on example data, tilted back and
 * running off the bottom of the screen. Scroll, and the frame straightens,
 * rises and grows until it fills the screen — and at that moment you are in
 * the app. Hover the frame and the picture softens behind a Connect in the
 * middle; click anywhere else on it and you walk into the example.
 *
 * STICKY BY ITS FOOT. The hero is as tall as its content. `top: min(0, 100dvh −
 * hero height)` lets it scroll until its foot meets the bottom of the viewport
 * and pins it there, so the frame rises into view by plain scrolling and the
 * zoom happens against a still page. The runway is a spacer AFTER the hero, not
 * padding: sticky is constrained by the containing block's content box, and a
 * padding runway once left the hero scrolling away under a gesture that was
 * still "in progress".
 *
 * ONE MEASURED TRANSFORM. Each frame (coalesced to one per scroll or resize),
 * the loop reads layout first — the hero's height and the rect of the frame's
 * STAGE, an element that never transforms — and then writes: the frame's translate/tilt/scale toward "centred
 * and covering the viewport", the copy's fade, and the video's time. Transforms
 * and opacity never dirty layout, so nothing is forced.
 *
 * PROGRESSIVE, ON PURPOSE. Every way in except Connect is <a href="/?mode=mock">:
 * before hydration a click is a navigation and still arrives; after it, the
 * click becomes a fade. The shell pushes that URL on entry, so Back returns
 * here — and this page resets its scroll on mount and only enters on a
 * gesture the visitor made, so a restored scroll position cannot re-enter it.
 *
 * COMMITTED DARK, whatever the theme: the screenshot and the footage are dark.
 */

import Image from "next/image";
import { useCallback, useEffect, useRef, useState } from "react";

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
 * the host from media-src in security-headers.mjs. One constant, one swap.
 */
const BACKGROUND_VIDEO =
  "https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260630_060707_72cd8ca2-3e4b-460c-9293-575573810866.mp4";

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
const REST_TILT_DEG = 16;

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

  useEffect(() => {
    const root = rootRef.current;
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
    let primed = false;

    const tick = () => {
      pending = 0;

      // ── READS ──
      const vw = window.innerWidth;
      const vh = window.innerHeight;
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

      // ── WRITES ──
      const heightChanged = heroH !== lastHeroH;
      if (heightChanged) {
        hero.style.setProperty("--hero-h", `${heroH}px`);
        lastHeroH = heroH;
      }
      // The hover's Connect sits in the middle of the part of the picture you
      // can SEE — at rest the frame runs off the bottom into the fade, and the
      // true centre of the picture is down there.
      const imageTop = stageRect.top + 33;
      const imageH = fH - 33;
      const seenTop = Math.max(imageTop, 0);
      const seenBottom = Math.min(imageTop + imageH, vh - 140);
      const hy = Math.min(Math.max((seenTop + seenBottom) / 2 - imageTop, 70), imageH - 70);
      frame.style.setProperty("--hy", `${hy}px`);
      root.style.setProperty("--p", String(p));
      root.style.setProperty("--z", String(clamp01((p - 0.8) / 0.15)));
      if (p > 0.01) root.setAttribute("data-zooming", "");
      else root.removeAttribute("data-zooming");

      copy.style.opacity = String(1 - clamp01(p / 0.3));
      copy.style.pointerEvents = p > 0.25 ? "none" : "";

      if (!reduced) {
        copy.style.transform = `translate3d(0, ${-32 * easeInOut(clamp01(p / 0.4))}px, 0)`;
        const tRot = easeInOut(clamp01(p / 0.5));
        const tMove = easeInOut(clamp01((p - 0.1) / 0.8));
        const tScale = easeInOut(clamp01((p - 0.3) / 0.65));
        const cx = stageRect.left + stageRect.width / 2;
        const cy = stageRect.top + fH / 2;
        // Cover the viewport on a wide screen; fill its width on a phone, where
        // covering would zoom into a slice of the dashboard.
        const fill = coarse || vw < 768 ? vw / fW : Math.max(vw / fW, vh / fH);
        frame.style.transform =
          `translate3d(${(vw / 2 - cx) * tMove}px, ${(vh / 2 - cy) * tMove}px, 0) ` +
          `perspective(1200px) rotateX(${REST_TILT_DEG * (1 - tRot)}deg) scale(${1 + (fill - 1) * tScale})`;

        if (video && video.readyState >= 1 && Number.isFinite(video.duration) && !video.seeking) {
          const t = p * video.duration * 0.999;
          if (Math.abs(video.currentTime - t) > 0.03) video.currentTime = t;
        }
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

    const INTENT = ["wheel", "touchstart", "keydown", "pointerdown"];
    const ro = new ResizeObserver(schedule);
    ro.observe(hero);
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
    };
  }, [enter]);

  return (
    <div
      ref={rootRef}
      className={cn(
        "relative bg-[#0A0B11] text-white transition-opacity duration-[420ms] ease-out",
        leaving && "opacity-0",
      )}
      style={{ ["--p" as string]: 0, ["--z" as string]: 0 }}
    >
      {/* ── Background footage, scrubbed by the scroll ─────────────────── */}
      <div aria-hidden className="landing-fade pointer-events-none fixed inset-0 z-0" style={{ animationDelay: "0.1s" }}>
        {/* BLURRED ON PURPOSE. Every frame of the placeholder clip carries another
            brand's name, and at rest "INFINITE" sat legibly between the headline
            and the paragraph — measured in the renders, on desktop and on a phone.
            As ambience the footage still moves with the scroll; as text it says
            nothing. scale-110 keeps the blurred edges off the screen. Drop the
            blur together with the placeholder. */}
        <video
          ref={videoRef}
          src={BACKGROUND_VIDEO}
          muted
          playsInline
          preload="auto"
          className="h-full w-full scale-110 object-cover opacity-60 blur-[10px]"
        />
        {/* The words sit over the top of it; the frame over the bottom. */}
        <div className="absolute inset-x-0 top-0 h-[75%] bg-gradient-to-b from-[#0A0B11] via-[#0A0B11]/75 to-transparent" />
        <div className="absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-[#0A0B11] to-transparent" />
        <div className="landing-grain absolute inset-0 opacity-70 mix-blend-soft-light" />
      </div>

      {/* ── Nav ─────────────────────────────────────────────────────────── */}
      <nav className="fixed inset-x-0 top-0 z-[60] flex items-center justify-between px-5 py-4 sm:px-8 sm:py-5 md:px-10">
        <span className="flex items-center gap-2.5">
          <Image src="/logo/sip-mark-white.png" alt="" width={22} height={26} priority />
          <span className="text-sm font-medium uppercase tracking-wide">SIP</span>
          <span className="hidden text-sm text-white/50 sm:inline">Self Implemented Pension</span>
        </span>
        <span className="flex items-center gap-2">
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
        className="sticky z-[3] flex min-h-dvh w-full flex-col overflow-clip pt-[104px] pb-12"
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
            <div className="md:col-span-7 lg:col-span-8">
              <p
                className="landing-rise mb-5 flex items-center gap-2.5 text-sm text-white/70 sm:text-[15px]"
                style={{ animationDelay: "0.2s" }}
              >
                <span className="size-2.5 rounded-full bg-white/80" />
                <span className="tracking-wide">A pension that builds itself, on Robinhood Chain</span>
              </p>
              <h1
                className="landing-rise mb-6 text-[clamp(2.2rem,6.5vw,5rem)] font-light leading-[0.95] tracking-[-0.03em] sm:mb-8"
                style={{ animationDelay: "0.35s" }}
              >
                A slice of every trade,
                <br />
                put aside for later.
              </h1>
              <div className="landing-rise flex flex-wrap items-center gap-3" style={{ animationDelay: "0.5s" }}>
                <ConnectButton connect={connect} size="lg" />
                <a
                  href="/?mode=mock"
                  onClick={enterFromLink}
                  className={cn(
                    "flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-6 py-3 text-sm font-medium text-white/90 backdrop-blur-sm transition-all hover:bg-white/15 sm:px-7 sm:py-3.5",
                    FOCUS,
                  )}
                >
                  See the app
                  <ArrowUpRight size={14} aria-hidden />
                </a>
              </div>
            </div>
            <div className="landing-rise md:col-span-5 lg:col-span-4" style={{ animationDelay: "0.65s" }}>
              <p className="text-[15px] leading-relaxed text-white/70 sm:text-base">
                SIP puts a slice of every buy and sell — 0.2% in the example, yours to set — into a pension of your own.
                Trade wherever you already trade — GMGN, Axiom, your own router — and it grows on its own.
              </p>
              {/* True of the chain today, and to be replaced by the new truth
                  when governance moves to hardware behind a delay — not by the
                  absolutes it replaced. */}
              <p className="mt-3 text-xs leading-relaxed text-white/45">
                Beta. The team has no key to your pension, but its contracts are upgradeable by SIP governance — today a
                single team key with no timelock.
              </p>
            </div>
          </div>
        </div>

        {/* The frame, below. Its wrapper carries the entrance; the frame carries
            the measured transform; they never share an element. The stage
            around both never transforms, which is why the loop measures it. */}
        <div ref={stageRef} className="mt-10 flex justify-center px-5 md:mt-14">
          <div className="landing-rise w-full max-w-[1100px]" style={{ animationDelay: "0.8s" }}>
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
                  src="/landing/app-dark.png"
                  alt="The SIP dashboard on example data: what each trade put aside, the pension's growth, and the savings rule"
                  fill
                  priority
                  sizes="(min-width: 1280px) 1440px, 100vw"
                  className="object-cover object-top"
                />
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

      {/* Bottom fade and the cue: the frame runs off the screen into them. */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-x-0 bottom-0 z-[6] h-40 bg-gradient-to-t from-[#0A0B11] to-transparent"
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
