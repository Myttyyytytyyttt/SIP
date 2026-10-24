"use client";

import { LoaderCircle, Pause, Play } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useReducedMotion } from "@/hooks/use-reduced-motion";
import { SHARE_COPY } from "@/lib/live-copy";
import { SHARE_CARD } from "@/lib/live-share";
import type { SharePlate } from "@/lib/share-plates";
import { cn } from "@/lib/utils";

/**
 * THE PREVIEW'S FRAME: the card's own shape and ground (#0A0B11, always dark,
 * whatever the app's theme). The same box stands in while the dialog's code or
 * the first image is on its way, so the dialog never changes height when the
 * picture arrives. A redraw keeps the last picture under a quiet spinner rather
 * than blinking to empty.
 *
 * WHAT IS SEEN IS WHAT IS POSTED, MOVING (owner, 10-22: "que las imágenes
 * tengan movimientos"). Three layers, the same three the files are made of:
 * the plate's still (frame 0, the PNG's background), the plate's own loop over
 * it, and the card's words on top (`src`, a transparent PNG drawn by the same
 * function as the image and the video — share-canvas.ts). The loop is the
 * site's file under /share/, never the finished MP4: the CSP's media-src takes
 * 'self' only, and a blob: video was refused in all three engines (10-22).
 *
 * UNDER REDUCED MOTION, THE STILL ONLY, and the loop is not even fetched. And
 * a loop that never ends can be stopped (WCAG 2.2.2): a pause in the corner,
 * on hover, on focus, and always on a touch screen.
 */
export function SharePreviewFrame({
  src,
  alt,
  plate,
  drawing = false,
  failed,
}: {
  /** The picture on top: the card's words over a transparent ground. */
  src?: string | null;
  alt?: string;
  /** The background under it: its still, and its loop where motion is welcome. */
  plate?: SharePlate | null;
  drawing?: boolean;
  failed?: string | null;
}) {
  const reduced = useReducedMotion();
  const [paused, setPaused] = useState(false);
  const moving = plate !== undefined && plate !== null && !reduced;
  return (
    <div className="group/frame relative overflow-hidden rounded-lg bg-[#0A0B11] ring-1 ring-foreground/10" style={{ aspectRatio: `${SHARE_CARD.width} / ${SHARE_CARD.height}` }}>
      {plate ? (
        // The plate's frame 0, from this site: nothing for next/image to optimise that is not already a 2400×1260 WebP.
        <img src={plate.still} alt="" aria-hidden width={SHARE_CARD.width} height={SHARE_CARD.height} className="absolute inset-0 block size-full" draggable={false} />
      ) : null}
      {moving && plate ? <PlateLoop key={plate.mp4} plate={plate} paused={paused} /> : null}
      {src ? (
        // A blob: URL of a PNG drawn in this browser: nothing for next/image to optimise, and nothing it could fetch.
        <img src={src} alt={alt ?? ""} width={SHARE_CARD.width} height={SHARE_CARD.height} className="relative block size-full" draggable={false} />
      ) : null}
      {moving && src && !failed ? (
        <button
          type="button"
          onClick={() => setPaused((was) => !was)}
          aria-label={paused ? SHARE_COPY.playMotion : SHARE_COPY.pauseMotion}
          data-share-motion={paused ? "paused" : "playing"}
          className={cn(
            "absolute right-2 bottom-2 flex size-8 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur-sm transition-opacity outline-none hover:bg-black/70 focus-visible:ring-3 focus-visible:ring-white/60",
            paused ? "opacity-100" : "opacity-0 group-hover/frame:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100",
          )}
        >
          {paused ? <Play aria-hidden className="size-4 translate-x-px" /> : <Pause aria-hidden className="size-4" />}
        </button>
      ) : null}
      {failed ? (
        <p role="alert" className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-white/70">
          {failed}
        </p>
      ) : drawing ? (
        <span role="status" className={cn("absolute flex items-center gap-2 text-xs text-white/70", src ? "top-2 right-2" : "inset-0 justify-center")}>
          <LoaderCircle aria-hidden className="size-4 motion-safe:animate-spin" />
          <span className={src ? "sr-only" : undefined}>{SHARE_COPY.drawing}</span>
        </span>
      ) : null}
    </div>
  );
}

/**
 * The plate's loop, muted, over its still: transparent until its first frame,
 * so the still shows until then — and stays, if the loop never comes. Keyed by
 * its plate: another background is another element, with its own sources.
 */
function PlateLoop({ plate, paused }: { plate: SharePlate; paused: boolean }) {
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const element = video.current;
    if (element === null) return;
    if (paused) {
      element.pause();
      return;
    }
    // React sets `muted` as a property, not always as an attribute, and a browser refuses to start a video that might make sound unasked.
    element.muted = true;
    // Refused (low-power mode): the still stays, which is the image itself.
    element.play().catch(() => undefined);
  }, [paused]);
  return (
    <video ref={video} aria-hidden muted loop playsInline preload="auto" disablePictureInPicture className="absolute inset-0 block size-full">
      <source src={plate.webm} type="video/webm" />
      <source src={plate.mp4} type="video/mp4" />
    </video>
  );
}
