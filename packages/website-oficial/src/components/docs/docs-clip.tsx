"use client";

/**
 * THE CLIP AT THE TOP OF A DOCS PAGE (owner, 10-22): a 16:9 loop, in the films'
 * style, that shows with pictures what the page says with words. So it is
 * hidden from screen readers, like the setup's step motion. Only some pages
 * have one: where a clip makes the page easier to understand.
 *
 * THREE WAYS IT CAN LOOK:
 *  * NO CLIP (its slug is not in CLIPS, src/lib/docs/clips.ts): nothing at all.
 *    Never a <video> pointing at a missing file.
 *  * A CLIP: the loop, muted, over its poster. It starts by itself unless the
 *    reader asked for less motion or less data; then the poster stays, with a
 *    play button. A pause button sits in the corner while it plays: a loop that
 *    never ends needs a way to stop it.
 *  * A CLIP WHOSE FILE FAILS TO LOAD: back to the quiet frame.
 *
 * NO `autoPlay` ATTRIBUTE, ON PURPOSE. The server cannot know the reader's
 * motion setting, and an `autoplay` in the server's HTML starts the loop before
 * any script can ask. So the HTML holds a still video, and play() is called once
 * the browser has answered. useReducedMotion is not used for that answer: it
 * says "no preference" while hydrating, which would start the loop for one
 * frame on exactly the screens that asked for none.
 *
 * THE LOOP LOADS ONLY TO PLAY (10-22, measured on a throttled phone). The HTML
 * says preload="none", so until the loop is about to play a page costs its
 * poster and nothing else: no video byte for a reader who asked for less motion
 * or less data (Save-Data), none for a refused play(), none while the clip is
 * out of view. It pauses as it leaves the screen or the tab is hidden, and plays
 * again on the way back, unless the reader paused it. The poster stays on screen
 * until the loop's first frame is painted, so its start is never black.
 *
 * THE POSTER IS ASKED FOR FIRST. It is the page's largest paint, and as a plain
 * poster it was fetched at medium priority beside all of the page's scripts and
 * arrived with the last of them (2.5 s on a throttled phone). A high-priority
 * preload, from here and not from the server page: a server component's preload
 * travels in the page's prefetch payload too, so the sidebar, prefetching every
 * page, fetched the other pages' posters as well.
 */

import { Pause, Play } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { preload } from "react-dom";

import { SipMark } from "@/components/sip-mark";
import { clipOf, type ClipFiles } from "@/lib/docs/clips";
import type { DocSlug } from "@/lib/docs/pages";
import { cn } from "@/lib/utils";

/** The same query use-reduced-motion.ts asks. */
const REDUCED = "(prefers-reduced-motion: reduce)";

/** "Near" the screen: the loop starts loading a little before it scrolls in, and pauses a little after it scrolls out. */
const NEAR_PX = 200;

/** The card every state shares, so the page below never moves when a clip arrives or fails. */
const FRAME = "relative aspect-video w-full overflow-hidden rounded-xl ring-1 ring-foreground/10";

/**
 * Save-Data, the reader's "use less data" (Chrome and Edge report it). Not in
 * every browser, nor in TypeScript's DOM types: absent means no.
 */
function savesData(): boolean {
  return (navigator as Navigator & { readonly connection?: { readonly saveData?: boolean } }).connection?.saveData === true;
}

export function Clip({ slug, className }: { readonly slug: DocSlug; readonly className?: string }) {
  // Keyed by its page, so a failed clip on one page never blanks the next one's.
  return <PageClip key={slug} slug={slug} className={className} />;
}

function PageClip({ slug, className }: { readonly slug: DocSlug; readonly className?: string | undefined }) {
  const files = clipOf(slug);
  const [broken, setBroken] = useState(false);
  if (files === null) return null;
  if (broken) return <ClipFrame className={className} />;
  return <ClipVideo files={files} onBroken={() => setBroken(true)} className={className} />;
}

/**
 * "idle" until the browser has said whether to play, and while the page itself
 * holds the loop (out of view, tab hidden): no button over a loop about to start.
 */
type Playback = "idle" | "playing" | "paused";

function ClipVideo({ files, onBroken, className }: { readonly files: ClipFiles; readonly onBroken: () => void; readonly className?: string | undefined }) {
  // Rendered on the server, this lands in the <head>, ahead of the scripts.
  preload(files.poster, { as: "image", fetchPriority: "high" });
  const video = useRef<HTMLVideoElement>(null);
  const [playback, setPlayback] = useState<Playback>("idle");
  // Once the reader has pressed play (true) or pause (false), their choice stands over the motion and data settings.
  const chosen = useRef<boolean | null>(null);
  // Set while the page pauses the loop itself, so that pause shows no play button: the loop comes back on its own.
  const holding = useRef(false);

  // A pause() that cuts a play() short rejects it too; that is the page holding the loop, not a refusal.
  const refused = (error: unknown): void => {
    if (!(error instanceof DOMException && error.name === "AbortError")) setPlayback("paused");
  };

  useEffect(() => {
    const element = video.current;
    if (element === null) return;
    const query = window.matchMedia(REDUCED);
    // Asked at once, not on the observer's first answer a frame later: the clip sits at the top of its page.
    const box = element.getBoundingClientRect();
    let near = box.bottom > -NEAR_PX && box.top < window.innerHeight + NEAR_PX;

    const follow = (): void => {
      const wanted = chosen.current ?? (!query.matches && !savesData());
      if (!wanted) {
        // The poster and its play button, and nothing loads.
        if (!element.paused) element.pause();
        setPlayback("paused");
      } else if (near && document.visibilityState === "visible") {
        if (!element.paused) return;
        // React sets `muted` as a property, not always as an attribute, and a
        // browser refuses to start a video that might make sound unasked.
        element.muted = true;
        // Refused (low-power mode, data saver): the poster stays, with its play button.
        element.play().catch(refused);
      } else if (!element.paused) {
        holding.current = true;
        element.pause();
      }
    };

    const seen = new IntersectionObserver(
      (entries) => {
        near = entries.at(-1)?.isIntersecting ?? near;
        follow();
      },
      { rootMargin: `${NEAR_PX}px 0px` },
    );
    follow();
    seen.observe(element);
    query.addEventListener("change", follow);
    document.addEventListener("visibilitychange", follow);
    return () => {
      seen.disconnect();
      query.removeEventListener("change", follow);
      document.removeEventListener("visibilitychange", follow);
    };
  }, []);

  const toggle = (): void => {
    const element = video.current;
    if (element === null) return;
    chosen.current = element.paused;
    if (element.paused) {
      element.muted = true;
      element.play().catch(refused);
    } else {
      element.pause();
    }
  };

  const playing = playback === "playing";
  return (
    <figure data-slot="docs-clip" data-clip="video" className={cn("group/clip", className)}>
      <div className={cn(FRAME, "bg-[#0A0B11]")}>
        <video
          ref={video}
          className="size-full object-cover object-top"
          poster={files.poster}
          muted
          loop
          playsInline
          preload="none"
          aria-hidden
          onPlaying={() => setPlayback("playing")}
          onPause={() => {
            setPlayback(holding.current ? "idle" : "paused");
            holding.current = false;
          }}
        >
          <source src={files.webm} type="video/webm" />
          {/* The last source: when it fails too, the browser has nothing left to play. */}
          <source src={files.mp4} type="video/mp4" onError={onBroken} />
        </video>
        {playback === "idle" ? null : (
          <button
            type="button"
            onClick={toggle}
            aria-label={playing ? "Pause the clip" : "Play the clip"}
            className={cn(
              "absolute flex items-center justify-center rounded-full bg-black/55 text-white backdrop-blur-sm transition-opacity outline-none hover:bg-black/70 focus-visible:ring-3 focus-visible:ring-white/60",
              // Playing: a small pause in the corner, shown on hover, on focus, and always on a touch screen.
              // Paused: a play in the middle of the poster.
              playing
                ? "right-3 bottom-3 size-8 opacity-0 group-hover/clip:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
                : "top-1/2 left-1/2 size-14 -translate-x-1/2 -translate-y-1/2",
            )}
          >
            {playing ? <Pause className="size-4" aria-hidden /> : <Play className="size-6 translate-x-px" aria-hidden />}
          </button>
        )}
      </div>
      {files.caption === undefined ? null : <figcaption className="mt-2 text-xs text-muted-foreground">{files.caption}</figcaption>}
    </figure>
  );
}

/** The quiet frame of a clip whose file failed to load, so the page below never jumps: a dotted ground, a vignette, and the mark, faint. */
function ClipFrame({ className }: { readonly className?: string | undefined }) {
  return (
    <figure data-slot="docs-clip" data-clip="fallback" aria-hidden className={className}>
      <div className={cn(FRAME, "bg-muted/40")}>
        <div className="absolute inset-0 bg-[radial-gradient(circle,var(--color-border)_1px,transparent_1px)] [background-size:16px_16px]" />
        <div className="absolute inset-0 bg-[radial-gradient(70%_70%_at_50%_50%,transparent_30%,var(--color-background)_100%)] opacity-80" />
        <div className="absolute inset-0 flex items-center justify-center">
          <SipMark className="h-10 w-auto opacity-15" />
        </div>
      </div>
    </figure>
  );
}
