"use client";

/**
 * THE CLIP AT THE TOP OF A DOCS PAGE (owner, 10-22): a 16:9 loop, in the films'
 * style, that shows with pictures what the page says with words. So it is
 * hidden from screen readers, like the setup's step motion.
 *
 * THREE WAYS IT CAN LOOK:
 *  * NO CLIP YET (its slug is not in CLIPS, src/lib/docs/clips.ts): a quiet
 *    frame with the mark in it. Never a <video> pointing at a missing file.
 *  * A CLIP: the loop, muted, over its poster. It starts by itself unless the
 *    reader asked for less motion; then the poster stays, with a play button.
 *    A pause button sits in the corner while it plays: a loop that never ends
 *    needs a way to stop it.
 *  * A CLIP WHOSE FILE FAILS TO LOAD: back to the quiet frame.
 *
 * NO `autoPlay` ATTRIBUTE, ON PURPOSE. The server cannot know the reader's
 * motion setting, and an `autoplay` in the server's HTML starts the loop before
 * any script can ask. So the HTML holds a still video, and play() is called once
 * the browser has answered. useReducedMotion is not used for that answer: it
 * says "no preference" while hydrating, which would start the loop for one
 * frame on exactly the screens that asked for none.
 */

import { Pause, Play } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { SipMark } from "@/components/site-footer";
import { clipOf, type ClipFiles } from "@/lib/docs/clips";
import type { DocSlug } from "@/lib/docs/pages";
import { cn } from "@/lib/utils";

/** The same query use-reduced-motion.ts asks. */
const REDUCED = "(prefers-reduced-motion: reduce)";

/** The card every state shares, so the page below never moves when a clip arrives or fails. */
const FRAME = "relative aspect-video w-full overflow-hidden rounded-xl ring-1 ring-foreground/10";

export function Clip({ slug, className }: { readonly slug: DocSlug; readonly className?: string }) {
  // Keyed by its page, so a failed clip on one page never blanks the next one's.
  return <PageClip key={slug} slug={slug} className={className} />;
}

function PageClip({ slug, className }: { readonly slug: DocSlug; readonly className?: string | undefined }) {
  const files = clipOf(slug);
  const [broken, setBroken] = useState(false);
  if (files === null || broken) return <ClipFrame className={className} />;
  return <ClipVideo files={files} onBroken={() => setBroken(true)} className={className} />;
}

/** "idle" until the browser has said whether to play: no button shows over a loop about to start. */
type Playback = "idle" | "playing" | "paused";

function ClipVideo({ files, onBroken, className }: { readonly files: ClipFiles; readonly onBroken: () => void; readonly className?: string | undefined }) {
  const video = useRef<HTMLVideoElement>(null);
  const [playback, setPlayback] = useState<Playback>("idle");
  // Once the reader has pressed play or pause, their choice stands over the motion setting.
  const chosen = useRef(false);

  useEffect(() => {
    const element = video.current;
    if (element === null) return;
    const query = window.matchMedia(REDUCED);
    const follow = (): void => {
      if (chosen.current) return;
      if (query.matches) {
        element.pause();
        setPlayback("paused");
        return;
      }
      // React sets `muted` as a property, not always as an attribute, and a
      // browser refuses to start a video that might make sound unasked.
      element.muted = true;
      // Refused (low-power mode, data saver): the poster stays, with its play button.
      element.play().catch(() => setPlayback("paused"));
    };
    follow();
    query.addEventListener("change", follow);
    return () => query.removeEventListener("change", follow);
  }, []);

  const toggle = (): void => {
    const element = video.current;
    if (element === null) return;
    chosen.current = true;
    if (element.paused) {
      element.muted = true;
      element.play().catch(() => setPlayback("paused"));
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
          preload="metadata"
          aria-hidden
          onPlaying={() => setPlayback("playing")}
          onPause={() => setPlayback("paused")}
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

/** The quiet frame of a page whose clip is not made yet: a dotted ground, a vignette, and the mark, faint. */
function ClipFrame({ className }: { readonly className?: string | undefined }) {
  return (
    <figure data-slot="docs-clip" data-clip="placeholder" aria-hidden className={className}>
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
