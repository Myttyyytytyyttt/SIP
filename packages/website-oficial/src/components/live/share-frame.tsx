import { LoaderCircle } from "lucide-react";

import { SHARE_COPY } from "@/lib/live-copy";
import { SHARE_CARD } from "@/lib/live-share";
import { cn } from "@/lib/utils";

/**
 * THE PREVIEW'S FRAME: the card's own shape and ground (#0A0B11, always dark,
 * whatever the app's theme), holding the PNG once it is drawn. The same box
 * stands in while the dialog's code or the first image is on its way, so the
 * dialog never changes height when the picture arrives. A redraw keeps the
 * last picture under a quiet spinner rather than blinking to empty.
 *
 * The picture is an <img> of the PNG itself, so what is seen here is exactly
 * what is posted.
 */
export function SharePreviewFrame({ src, alt, drawing = false, failed }: { src?: string | null; alt?: string; drawing?: boolean; failed?: string | null }) {
  return (
    <div className="relative overflow-hidden rounded-lg bg-[#0A0B11] ring-1 ring-foreground/10" style={{ aspectRatio: `${SHARE_CARD.width} / ${SHARE_CARD.height}` }}>
      {src ? (
        // A blob: URL of a PNG drawn in this browser: nothing for next/image to optimise, and nothing it could fetch.
        <img src={src} alt={alt ?? ""} width={SHARE_CARD.width} height={SHARE_CARD.height} className="block size-full" draggable={false} />
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
