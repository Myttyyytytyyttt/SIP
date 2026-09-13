"use client";

/**
 * WHAT SOMEBODY SEES BEFORE THEY CONNECT — and the three ways in.
 *
 * The centrepiece is not an illustration of the product; it is the product. A
 * screenshot of the dashboard, exactly as the example renders it, sits in a
 * device frame, tilted a few degrees like something on a desk, and brightens
 * under the cursor as if lit by a lamp. Click it and you are inside, on the
 * example. Scroll and the tilt flattens, the frame grows, the copy recedes —
 * and at the end of that gesture you are inside too. Or press Connect.
 *
 * THE LAYOUT COMPUTES ITSELF. Nav, frame and copy are one flex column: the
 * frame takes whatever height the copy leaves, at every viewport and every
 * line-wrap. A first version derived the frame's height from a constant and
 * collided with the copy at 1366×683, on an iPhone SE and on an iPad — the
 * commonest screens there are. On a phone, or on any screen too short for all
 * three, the frame keeps the dashboard's own aspect and the hero is taller
 * than the viewport: it scrolls until its foot meets the bottom, then pins.
 *
 * THE ENTRANCE MUST NOT TOUCH THE TILT. `landing-rise` animates transform, and
 * an animation's fill would keep beating the frame's own perspective forever
 * (measured: identity matrix at rest and mid-scroll). So the entrance lives on
 * a wrapper and the tilt on the anchor, and the two never share an element.
 *
 * WHY A SCREENSHOT AND NOT THE LIVE COMPONENT. The dashboard is a client tree
 * with a chart, a sidebar and a Privy provider above it; mounting it as a
 * decoration would cost every visitor the whole bundle before they have
 * decided anything. A PNG costs one request and says the same thing. It goes
 * stale as the UI evolves, which is the price; tools/landing-shot regenerates
 * it, which is the remedy. The frame's title strip says "Example" in the
 * page's own type, outside the dimming filter, because the badge inside the
 * image is 7px tall at this scale and that is not a disclosure.
 *
 * PROGRESSIVE, ON PURPOSE. Every way in except Connect is <a href="/?mode=mock">:
 * before hydration a click is a navigation and still arrives; after it, the
 * click is intercepted and does the same thing with a fade instead of a reload.
 * The shell pushes that URL into history on entry, so Back returns here.
 *
 * ONE rAF LOOP THAT SLEEPS. Cursor and scroll write custom properties; the
 * compositor does the rest. Reads happen before writes (interleaving forces a
 * style recalc per frame), and the loop stops when everything has settled and
 * wakes on the next event. The spotlight is a CSS mask, not a canvas.
 *
 * COMMITTED DARK. This page paints its own ground and type regardless of the
 * theme: the screenshot is dark and a light frame around it reads as a mistake.
 */

import Image from "next/image";
import { useCallback, useEffect, useRef, useState } from "react";

import { usePrivy } from "@privy-io/react-auth";
import { ArrowDown, ArrowUpRight } from "lucide-react";

import { useWalletsOpener } from "@/components/wallets-host";
import { cn } from "@/lib/utils";

/**
 * How far the page scrolls before the gesture is complete and we go in, as a
 * share of the viewport. A fine pointer (mouse, trackpad) enters at half a
 * screen; a coarse one (a thumb) needs most of one, because a single flick on
 * a phone is not a decision. The runway below the hero is sized to match
 * (70dvh / 100dvh), with travel to spare; the comparison carries a tolerance
 * because floating point once put progress at 0.9999999999999999 and left a
 * visitor one ulp from entering, forever.
 */
const ENTER_AT_VH_FINE = 0.5;
const ENTER_AT_VH_COARSE = 0.8;
const ENTER_TOLERANCE = 0.985;
/** The fade between the last frame of the landing and the first of the app. */
const LEAVE_MS = 420;
/** Parallax: the grid drifts by at most this many px against the cursor. */
const GRID_DRIFT = 16;
const GRID_CELL = 48;

const FOCUS =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0A0B11]";

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
  const cropRef = useRef<HTMLSpanElement>(null);
  const gridRef = useRef<SVGPatternElement>(null);

  const [leaving, setLeaving] = useState(false);
  const enteredRef = useRef(false);
  const timerRef = useRef<number | null>(null);

  // Leave with a fade rather than a cut, then hand over. Scroll back to the
  // top first: the gesture that got us here left the page scrolled, and the
  // dashboard should not start halfway down.
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
    // Marks the moment the page can respond. Before this, every way in is a
    // plain link to /?mode=mock — which is why they are links.
    rootRef.current?.setAttribute("data-hydrated", "1");

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const hoverable = window.matchMedia("(hover: hover)").matches;
    const coarse = window.matchMedia("(pointer: coarse)").matches;

    const raw = { x: -1000, y: -1000 };
    const smooth = { x: -1000, y: -1000 };
    const drift = { x: 0, y: 0 };
    let progress = 0;
    let written = -1;
    let frame = 0;
    let running = false;

    const tick = () => {
      // READS, then writes. The crop span is where the spotlight mask lives, so
      // its rect is the coordinate space that puts the lamp under the pointer.
      const crop = hoverable ? cropRef.current : null;
      const rect = crop?.getBoundingClientRect();

      let settled = true;

      if (hoverable) {
        smooth.x += (raw.x - smooth.x) * 0.1;
        smooth.y += (raw.y - smooth.y) * 0.1;
        if (Math.abs(raw.x - smooth.x) > 0.05 || Math.abs(raw.y - smooth.y) > 0.05) settled = false;
        if (crop && rect) {
          crop.style.setProperty("--sx", `${smooth.x - rect.left}px`);
          crop.style.setProperty("--sy", `${smooth.y - rect.top}px`);
        }
        if (!reduced) {
          // The hero is the viewport (sticky, full height), so its centre needs no rect.
          const tx = ((smooth.x - window.innerWidth / 2) / window.innerWidth) * GRID_DRIFT;
          const ty = ((smooth.y - window.innerHeight / 2) / window.innerHeight) * GRID_DRIFT;
          drift.x += (tx - drift.x) * 0.06;
          drift.y += (ty - drift.y) * 0.06;
          if (Math.abs(tx - drift.x) > 0.05 || Math.abs(ty - drift.y) > 0.05) settled = false;
          gridRef.current?.setAttribute("x", String(drift.x));
          gridRef.current?.setAttribute("y", String(drift.y));
        }
      }

      const p = reduced ? 0 : progress;
      if (p !== written) {
        rootRef.current?.style.setProperty("--p", String(p));
        written = p;
        settled = false;
      }

      if (settled) {
        running = false;
        return;
      }
      frame = window.requestAnimationFrame(tick);
    };
    const wake = () => {
      if (running) return;
      running = true;
      frame = window.requestAnimationFrame(tick);
    };

    const onMove = (e: MouseEvent) => {
      raw.x = e.clientX;
      raw.y = e.clientY;
      wake();
    };
    const onScroll = () => {
      // A hero taller than the viewport pins by its foot, so the gesture starts
      // once it has been read — a no-op wherever it is exactly one viewport tall.
      const hero = heroRef.current;
      const start = hero ? Math.max(0, hero.offsetHeight - window.innerHeight) : 0;
      const limit = window.innerHeight * (coarse ? ENTER_AT_VH_COARSE : ENTER_AT_VH_FINE);
      progress = Math.min(Math.max(0, window.scrollY - start) / limit, 1);
      if (progress >= ENTER_TOLERANCE) enter();
      wake();
    };

    // STICKY BY ITS FOOT. `top: min(0, 100dvh − hero height)` pins a hero that
    // fits at the top, and one that does not only once its foot reaches the
    // bottom of the viewport — so every word is read before the runway begins,
    // and the gesture never scrolls past an empty screen. CSS cannot read an
    // element's own height, so this writes it.
    const heroEl = heroRef.current;
    const ro = heroEl
      ? new ResizeObserver(() => {
          heroEl.style.setProperty("--hero-h", `${heroEl.offsetHeight}px`);
          onScroll();
        })
      : null;
    if (heroEl && ro) ro.observe(heroEl);

    if (hoverable) window.addEventListener("mousemove", onMove, { passive: true });
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => {
      ro?.disconnect();
      window.cancelAnimationFrame(frame);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("scroll", onScroll);
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, [enter]);

  return (
    <div
      ref={rootRef}
      className={cn(
        // The runway: what the scroll gesture travels across, below the hero.
        "relative bg-[#0A0B11] pb-[70dvh] text-white transition-opacity duration-[420ms] ease-out pointer-coarse:pb-[100dvh]",
        leaving && "opacity-0",
      )}
      style={{ ["--p" as string]: 0 }}
    >
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

      {/* ── Hero: one flex column — nav space, the frame, the copy ────────
          One viewport tall where all three fit. On a phone, or a screen too
          short for them, it takes its natural height and pins by its foot
          (the `top` below, fed by the ResizeObserver in the effect). */}
      <section
        ref={heroRef}
        className={cn(
          "sticky z-[3] flex h-dvh w-full flex-col overflow-clip pt-[96px]",
          "max-md:h-auto max-md:min-h-dvh [@media(max-height:640px)]:h-auto [@media(max-height:640px)]:min-h-dvh",
        )}
        style={{ top: "min(0px, calc(100dvh - var(--hero-h, 100dvh)))" }}
      >
        {/* Atmosphere: two soft lights and a grain, instead of a stock image. */}
        <div
          aria-hidden
          className="landing-fade absolute inset-0"
          style={{
            animationDelay: "0.1s",
            background:
              "radial-gradient(60% 50% at 18% 78%, rgba(16,185,129,0.14) 0%, transparent 60%)," +
              "radial-gradient(45% 40% at 84% 14%, rgba(255,255,255,0.08) 0%, transparent 60%)",
          }}
        />
        <div aria-hidden className="landing-grain pointer-events-none absolute inset-0 opacity-70 mix-blend-soft-light" />

        {/* Grid, drifting against the cursor, held under the frame by a mask
            so it is a texture there rather than a faint haze everywhere. */}
        <svg
          aria-hidden
          className="absolute inset-0 h-full w-full opacity-[0.12] [mask-image:radial-gradient(60%_50%_at_50%_32%,#000,transparent)]"
        >
          <defs>
            <pattern ref={gridRef} id="landing-grid" width={GRID_CELL} height={GRID_CELL} patternUnits="userSpaceOnUse">
              <path d={`M ${GRID_CELL} 0 L 0 0 0 ${GRID_CELL}`} fill="none" stroke="#94a3b8" strokeWidth={0.5} />
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#landing-grid)" />
        </svg>

        {/* The watermark. On desktop the frame and the copy cover all but a
            sliver of it, which reads as stray shapes; on a phone it has room. */}
        <div aria-hidden className="pointer-events-none absolute inset-0 flex select-none items-center justify-center overflow-hidden md:hidden">
          <span className="whitespace-nowrap font-medium uppercase tracking-[-0.05em] text-white/[0.04]" style={{ fontSize: "26vw" }}>
            SIP
          </span>
        </div>

        {/* The frame takes what the copy leaves. Its wrapper carries the
            entrance; the anchor carries the tilt; they never share an element. */}
        <div
          className={cn(
            // Where all three fit, the frame takes what the copy leaves, up to
            // image cap + title bar + border; past the cap the auto margins
            // centre it instead of leaving the gap all below.
            "relative my-auto flex max-h-[calc(640px+2rem+2px)] min-h-0 flex-1 justify-center px-5",
            // Where they do not, it takes the dashboard's own aspect.
            "max-md:h-[min(calc(min(100vw_-_40px,1100px)*0.625_+_2rem_+_2px),calc(640px_+_2rem_+_2px))] max-md:flex-none",
            "[@media(max-height:640px)]:h-[min(calc(min(100vw_-_40px,1100px)*0.625_+_2rem_+_2px),calc(640px_+_2rem_+_2px))] [@media(max-height:640px)]:flex-none",
          )}
          style={{ opacity: "clamp(0, calc(1.3 - var(--p) * 0.5), 1)" }}
        >
          <div className="landing-rise flex min-h-0 w-full max-w-[1100px] justify-center" style={{ animationDelay: "0.25s" }}>
            <a
              href="/?mode=mock"
              onClick={enterFromLink}
              aria-label="Open the app with example data"
              className={cn(
                "landing-device group relative flex w-full cursor-pointer flex-col rounded-xl border border-white/10 bg-[#0d0e15] text-left",
                "shadow-[0_40px_120px_-20px_rgba(0,0,0,0.8),0_0_0_1px_rgba(255,255,255,0.04)_inset]",
                "outline-none focus-visible:ring-2 focus-visible:ring-white/60",
              )}
            >
              {/* Title strip — and the disclosure, in real text, outside the filter. */}
              <span aria-hidden className="flex h-8 shrink-0 items-center gap-1.5 border-b border-white/[0.06] px-3.5">
                <span className="size-2.5 rounded-full bg-white/15" />
                <span className="size-2.5 rounded-full bg-white/15" />
                <span className="size-2.5 rounded-full bg-white/15" />
                <span className="ml-3 flex h-4 min-w-0 flex-1 items-center rounded-sm bg-white/[0.04] px-2 text-xs text-white/70">
                  <span className="truncate">Example — nobody&rsquo;s pension</span>
                </span>
              </span>
              <span ref={cropRef} className="relative block min-h-0 flex-1 overflow-hidden rounded-b-xl">
                {/* Dimmed base where a cursor can light it; full brightness on
                    touch, where no lamp will ever arrive. Then the lit copy,
                    revealed under the cursor — not painted at all on touch. */}
                <Image
                  src="/landing/app-dark.png"
                  alt="The SIP dashboard on example data: what each trade put aside, the pension's growth, and the savings rule"
                  fill
                  priority
                  sizes="(min-width: 1280px) 1024px, 92vw"
                  className="object-cover object-top brightness-[0.55] transition-[filter] duration-500 group-hover:brightness-[0.62] pointer-coarse:brightness-100"
                />
                <Image
                  src="/landing/app-dark.png"
                  alt=""
                  aria-hidden
                  fill
                  loading="eager"
                  sizes="(min-width: 1280px) 1024px, 92vw"
                  className="landing-reveal pointer-events-none object-cover object-top pointer-coarse:hidden"
                />
                <span aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-[#0d0e15] to-transparent" />
                {/* A quiet invitation on hover and on keyboard focus. */}
                <span className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center pb-4 opacity-0 transition-opacity duration-300 group-hover:opacity-100 group-focus-visible:opacity-100">
                  <span className="rounded-full bg-white px-4 py-2 text-sm font-medium text-gray-900 shadow-lg">Open the app</span>
                </span>
              </span>
            </a>
          </div>
        </div>

        {/* Ground under the words. */}
        <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 z-[40] h-64 bg-gradient-to-t from-[#0A0B11] via-[#0A0B11]/70 to-transparent" />

        {/* The copy, in flow, so the frame above always leaves it room. It
            recedes late in the scroll gesture: still readable while the frame
            comes forward, gone just before the app arrives. */}
        <div
          className="relative z-[50] px-6 pt-6 pb-8 sm:px-10 sm:pb-12 md:px-14 md:pt-8 md:pb-14"
          style={{ opacity: "clamp(0, calc(1 - max(0, var(--p) - 0.45) * 2), 1)" }}
        >
          <div className="grid grid-cols-1 items-end gap-5 md:grid-cols-12 md:gap-12">
            <div className="md:col-span-7 lg:col-span-8">
              <p className="landing-rise mb-5 flex items-center gap-2.5 text-sm text-white/70 sm:text-[15px]" style={{ animationDelay: "0.4s" }}>
                <span className="size-2.5 rounded-full bg-white/80" />
                <span className="tracking-wide">A pension that builds itself, on Robinhood Chain</span>
              </p>
              <h1
                className="landing-rise mb-6 text-[clamp(2.2rem,6.5vw,5rem)] font-light leading-[0.95] tracking-[-0.03em] sm:mb-10"
                style={{ animationDelay: "0.55s" }}
              >
                A slice of every trade,
                <br />
                put aside for later.
              </h1>
              <div className="landing-rise flex flex-wrap items-center gap-3" style={{ animationDelay: "0.7s" }}>
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
            <div className="landing-rise md:col-span-5 lg:col-span-4" style={{ animationDelay: "0.85s" }}>
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

        {/* Scroll cue: the third way in, shown wherever scrolling enters. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-3 z-[50] flex justify-center"
          style={{ opacity: "clamp(0, calc(0.6 - var(--p) * 2), 0.6)" }}
        >
          <span className="flex items-center gap-1.5 text-[11px] uppercase tracking-[0.18em] text-white">
            <ArrowDown size={12} />
            Scroll to enter
          </span>
        </div>
      </section>
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
