/**
 * THE SHARE CARD'S BACKGROUNDS ARE THE FILMS' PLATES (owner, 10-22: "que las
 * imágenes tengan movimientos, motion algo simples pero vistosos"). The "Videos
 * Product SIP" session made three animated backgrounds with no words on them,
 * approved by the owner: Grid (the S drawn on the landing's blueprint), Streaks
 * and Vault (the S behind, fainter). The card's words are drawn over them in the
 * browser (live/share-canvas.ts); nothing here is drawn by hand any more.
 *
 * FOUR FILES EACH, in public/share/:
 *   <name>.mp4         the plate, H.264: what the video export decodes
 *                      (live/share-video.ts), and the preview's fallback source;
 *   <name>.webm        the plate, VP9: the preview's first source, a third to
 *                      half the MP4's weight;
 *   <name>.webp        frame 0 at 2400×1260: the still image's background, so
 *                      the still and the video open on the same picture;
 *   <name>-thumb.webp  600×315: the background picker's preview.
 *
 * THE STILL IS LOSSY WebP AT q88 (measured 10-22, against the films' PNG of
 * frame 0): 48.6 / 47.5 / 47.2 dB PSNR for grid / streaks / vault at 23 / 41 /
 * 42 KB, where near-lossless (56–60 dB) weighed 307 / 681 / 214 KB and the PNGs
 * 1.3–1.7 MB. The video's own frame 0 is 42.6–46.1 dB from the same PNG in
 * Chrome, WebKit and Firefox, so the q88 still is closer to the source than the
 * video it must match — at a tenth of the weight, on every dialog open. The
 * docs' posters use the same setting (scripts/docs-clip.mts).
 *
 * THE PLATES' RULES (the films', 10-22), checked before every build with the
 * same reader the browser uses (scripts/check-share-plates.mts): 1200×630,
 * 30 fps, exactly `frames` frames and ONE keyframe, at frame 0 — so a loop
 * decodes from its first frame and nothing refers across its seam, which is
 * what lets the export write one encoded loop twice (SHARE_VIDEO_LOOPS).
 * `codec` is what VideoDecoder.isConfigSupported is asked before the dialog
 * offers a video, so the question needs no download.
 *
 * EVERY URL CARRIES ITS FILE'S VERSION (?v=, the first 8 hex of its sha256),
 * because /share/ is cached for a year without asking again (next.config.mjs),
 * like /docs/clips/. TO RE-DELIVER THE PLATES: `pnpm run share:plates --from
 * <checkout>/launch-video/out/share` copies them in, makes both WebPs and
 * rewrites the lines below.
 */

import type { ShareBackground } from "@/lib/live-share";

export interface SharePlate {
  readonly mp4: string;
  readonly webm: string;
  /** Frame 0 at 2400×1260: the still image's background. */
  readonly still: string;
  /** 600×315, for the picker. */
  readonly thumb: string;
  /** Frames in one loop, at SHARE_FPS. */
  readonly frames: number;
  /** The MP4's codec, as WebCodecs names it ("avc1.640032"). */
  readonly codec: string;
}

/** The plates' frame rate, and the video's. */
export const SHARE_FPS = 30;

/** The plates' size: the card's logical size (SHARE_CARD, share-plates.test.ts), so the video is the card at 1×. */
export const PLATE_SIZE = { width: 1200, height: 630 } as const;

/** The still's size and the thumb's, in pixels: the build checks the files against them. */
export const STILL_SIZE = { width: 2400, height: 1260 } as const;
export const THUMB_SIZE = { width: 600, height: 315 } as const;

type Versions = { readonly mp4: string; readonly webm: string; readonly still: string; readonly thumb: string };

/** A plate's four files under /share/, each at its version. */
export function plateFiles(name: ShareBackground, plate: { readonly frames: number; readonly codec: string }, v: Versions): SharePlate {
  return {
    mp4: `/share/${name}.mp4?v=${v.mp4}`,
    webm: `/share/${name}.webm?v=${v.webm}`,
    still: `/share/${name}.webp?v=${v.still}`,
    thumb: `/share/${name}-thumb.webp?v=${v.thumb}`,
    ...plate,
  };
}

export const SHARE_PLATES: Readonly<Record<ShareBackground, SharePlate>> = {
  grid: plateFiles("grid", { frames: 180, codec: "avc1.640032" }, { mp4: "e6321a27", webm: "a438fd8f", still: "5327138b", thumb: "17c02446" }),
  streaks: plateFiles("streaks", { frames: 150, codec: "avc1.640032" }, { mp4: "8a64fb92", webm: "883189e0", still: "4c5cecb5", thumb: "6ee83e4e" }),
  vault: plateFiles("vault", { frames: 150, codec: "avc1.640032" }, { mp4: "b66e66f6", webm: "d7c5e993", still: "6d6a2ea4", thumb: "bf270c41" }),
};

/**
 * THE VIDEO IS TWO LOOPS (10-22): 12 s for Grid, 10 s for the others — a clip,
 * not a blip, where a player does not loop (Discord, a phone's gallery); X loops
 * anything under 60 s. One loop is encoded and written twice
 * (live/share-video.ts), so the second costs bytes, not time.
 */
export const SHARE_VIDEO_LOOPS = 2;

/** The video's length in seconds. */
export const videoSeconds = (plate: SharePlate): number => (SHARE_VIDEO_LOOPS * plate.frames) / SHARE_FPS;
