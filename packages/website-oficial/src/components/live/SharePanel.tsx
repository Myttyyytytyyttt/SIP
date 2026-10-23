"use client";

/**
 * THE SHARE DIALOG'S BODY (owner, 10-22): the card, its background and unit,
 * and what to do with it — as an image, or as a short video. Loaded on the
 * dialog's first open (ShareSavings.tsx), with the canvas that draws it
 * (share-canvas.ts) and the code that makes the video (share-video.ts).
 *
 * WHAT YOU SEE IS WHAT YOU POST. The preview is the plate the files are made
 * from — its loop, or its still under reduced motion — with the card's words
 * on top, drawn by the same function as the PNG and the MP4 (share-frame.tsx).
 * The words are drawn once per unit and kept while the dialog is open; the
 * three backgrounds' thumbs are the plates' own, with the same words over them.
 * The PNG for the actions is drawn for the background and unit chosen, and kept
 * the same way, so going back to one is instant. Every blob: URL is revoked when
 * its picture goes (useObjectUrl), and a download's once the browser has had
 * time to take the file.
 *
 * GRID FIRST (owner, 10-22: "La primera tiene que ser la del grid"): the dialog
 * opens on it, and the picker lists it first (SHARE_BACKGROUNDS).
 *
 * FOUR BUTTONS, AND ONLY THE ONES THIS BROWSER CAN CARRY OUT (live-share.ts
 * shareCaps; owner, 10-23: "Solo creo que deberíamos tener el download, share y
 * copy image, ¿no? Y el post"):
 *   Share image     the system's sheet with the file — on a phone, straight into
 *                   X, Telegram or anything else. Only where it works. The image
 *                   only: the video is Download's.
 *   Copy image      a PNG on the clipboard, to paste into any post. Only where a
 *                   browser takes an image there.
 *   Download        always: the image — or, where this browser can make the
 *                   video, a menu of the two files (THE VIDEO, below).
 *   Post on X       always: opens X's composer in a new tab with a short line
 *                   and a link — the card's own when there is one (below), the
 *                   site's otherwise — and copies the image where it can. A
 *                   plain link, so no popup blocker can swallow it.
 * A refusal says so in words (copy-button.tsx's rule: silence reads as success).
 * A download says nothing: the browser shows its own.
 *
 * THE CARD'S OWN LINK (owner, 10-22: "Enlace con vista previa"). A Live page's
 * dialog asks the server once, on open (lib/share-link-client.ts), for the card
 * as the server reads it from the chain and a signed link per background and
 * unit: saverfi.cash/c/<token>, whose preview on X is this card — nothing to
 * paste — titled "SaverFi’s Vault" where this one says "My pension" (review
 * finding S1; owner, 10-23: the server signs a card for any pension key, so
 * its picture speaks in the third person), which the hint under the actions
 * says before the click. The dialog ADOPTS the server's card, so the preview,
 * Copy, Download and the link all show the same figures. While it asks, Post on X waits,
 * disabled, a few seconds at most (SHARE_LINK_WAIT_MS); refused, off, or too
 * slow, Post on X shares the site and the image is pasted, as before. The
 * sample's dialog needs no asking: its links are fixed pages of the sample's
 * own card (/c/example). A Live card's picture is asked for once Post on X is
 * about to be pressed — the pointer on it, its focus, the tap — so X's crawler
 * finds it drawn; never on a background merely looked at, and never the
 * sample's, drawn at build time (review, 10-22: the sample's dialog fetched
 * 775 KB of pictures nobody saw, and a Live one a render per pick).
 *
 * THE VIDEO, INSIDE DOWNLOAD (owner, 10-22: "Vídeo corto MP4"; 10-23, of the
 * row it had: "¿qué es esto del make video?" — and, asked where the moving card
 * should go, "Dentro de Download"). No row and no sheet of its own: where this
 * browser can make the video (share-video.ts videoCaps), Download opens a menu
 * of two files, Image (PNG) and Video (MP4). Elsewhere Download stays the
 * image's plain button, rather than a menu of one entry: that would be a click
 * for nothing, and nothing in it could say why the other file is missing.
 *
 * MADE IN THE MENU, ON REQUEST, NEVER ON OPEN. Choosing Video keeps the menu
 * open and turns the entry into its progress, with Cancel under it — focus
 * moves there, since the entry it was on can no longer be chosen. When the
 * file is done it downloads and the menu closes. Closing the menu stops it —
 * Cancel, Escape, a click outside — as a change of background or unit and a
 * closed dialog do: no video is made where nobody is looking at its progress,
 * and none is left half made. A failure is said in the menu, its entry offers
 * Try again, and the image stays a click away above it. A finished video is
 * kept per background and unit, like the pictures: chosen again, it downloads
 * at once. While a Live card's link is being asked for, Video waits with Post
 * on X (a few seconds at most): the server's card may differ from the page's (a
 * streak it could not prove), and adopting it would drop a video made of the
 * page's figures without a word (review, 10-22).
 *
 * DOWNLOADED AT THE END, WHILE THE CLICK STILL COUNTS (measured 10-23). The
 * file is saved a second or two after the click that asked for it, from no
 * gesture of its own. On an idle page Chrome 155, and Playwright's WebKit 18
 * and Firefox 131, count a click as recent for 5 s (navigator.userActivation),
 * and all three saved a file started 5.5 s after the click, once they had
 * stopped counting it. Safari itself could not be driven here, so the dialog
 * does not lean on that: a video finished after the browser stopped counting
 * the click (a slow phone) is not saved by itself — its entry becomes
 * "Download video", focused, one click away.
 *
 * THE MENU IS NOT MODAL: a modal one hides the rest of the dialog from a screen
 * reader (aria-hidden) while it is open — the very time the video's polite
 * status, which lives in the dialog, has something to say.
 *
 * WHAT POST ON X DOES IS SAID BEFORE THE CLICK (review, 10-22). X opens in
 * front, so a "paste it" said after the click lands in the tab left behind, and
 * the person posts the words without the picture. The line under the actions
 * says it while nothing else is being said, and the link is described by it.
 *
 * Dollars by default, SOL on request (owner, 10-22); SOL only, and said, when
 * no price was read. A card with nothing saved has no unit to choose. The
 * sample's card (owner, 10-22) is dollars only — the sample has no SOL total —
 * and says so the same way: SOL off, and a line under it.
 */

import { Check, ChevronDown, CircleAlert, Copy, Download, Film, ImageIcon, LoaderCircle, RotateCcw, Share, X } from "lucide-react";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";

import { renderShareCard, renderShareWords } from "@/components/live/share-canvas";
import { SharePreviewFrame } from "@/components/live/share-frame";
import { PlateUnavailable, makeShareVideo, videoCaps } from "@/components/live/share-video";
import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useFlash } from "@/hooks/use-flash";
import { SAVED } from "@/lib/classes";
import { SHARE_COPY } from "@/lib/live-copy";
import {
  EXAMPLE_SHARE_LINKS,
  SHARE_BACKGROUNDS,
  SHARE_CARD,
  SHARE_SITE,
  defaultUnit,
  shareAlt,
  shareCaps,
  shareFileName,
  shareImagePath,
  shareIntentUrl,
  shareLinkFor,
  sharePostText,
  unitFor,
  unitsOf,
  type ShareBackground,
  type ShareCardData,
  type ShareLinkSource,
  type ShareScope,
  type ShareUnit,
} from "@/lib/live-share";
import { SHARE_LINK_WAIT_MS, askShareLink, keptShareLink, shareLinkKey, shareLinkUrl, warmShareImage, type ShareLinkState } from "@/lib/share-link-client";
import { SHARE_PLATES, videoSeconds, type SharePlate } from "@/lib/share-plates";
import { SHARE_RENDER_VERSION } from "@/lib/share-render-version";
import { cn } from "@/lib/utils";

/** How long a line under the actions stays. */
const SAID_MS = 6_000;

type Said = "copied" | "copiedForX" | "copiedLinked" | "copyFailed" | "noCopyForX" | "shareFailed";
const SAID: Readonly<Record<Said, { readonly good: boolean; readonly words: string }>> = {
  copied: { good: true, words: SHARE_COPY.copied },
  copiedForX: { good: true, words: SHARE_COPY.copiedForX },
  copiedLinked: { good: true, words: SHARE_COPY.copiedLinked },
  copyFailed: { good: false, words: SHARE_COPY.copyFailed },
  noCopyForX: { good: false, words: SHARE_COPY.noCopyForX },
  shareFailed: { good: false, words: SHARE_COPY.shareFailed },
};

/** A picture drawn, or the draw that failed. */
type Drawn = Blob | "failed";

const isBackground = (value: string): value is ShareBackground => (SHARE_BACKGROUNDS as readonly string[]).includes(value);
const isUnit = (value: string): value is ShareUnit => value === "usd" || value === "sol";

/**
 * A PHONE LEADS WITH THE SHEET, A DESKTOP WITH X. Where the system's share
 * sheet exists it is the primary action below `sm` and an outline beside the
 * others above it; Post on X is the opposite. Without a sheet, Post on X leads
 * everywhere.
 */
const OUTLINE_FROM_SM = "sm:border-border sm:bg-background sm:text-foreground sm:hover:bg-muted dark:sm:border-input dark:sm:bg-input/30 dark:sm:hover:bg-input/50";
const OUTLINE_UNDER_SM =
  "max-sm:border-border max-sm:bg-background max-sm:text-foreground max-sm:hover:bg-muted dark:max-sm:border-input dark:max-sm:bg-input/30 dark:max-sm:hover:bg-input/50";

/** X's own mark, for its button. Lucide has no brand marks. */
function XMark() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" fill="currentColor" className="size-4">
      <path d="M17.75 3h3.07l-6.7 7.66L22 21h-6.17l-4.83-6.32L5.47 21H2.4l7.17-8.2L2 3h6.33l4.37 5.77L17.75 3Zm-1.08 16.2h1.7L7.4 4.73H5.58L16.67 19.2Z" />
    </svg>
  );
}

/** A blob: URL for as long as its blob is shown, revoked as it goes. */
function useObjectUrl(blob: Blob | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (blob === null) {
      setUrl(null);
      return;
    }
    const next = URL.createObjectURL(blob);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [blob]);
  return url;
}

/** A file handed to the browser's download: its URL revoked once the browser has had time to take it (at once, Firefox can lose the save). */
function saveFile(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/**
 * Whether this browser has stopped counting the last click as recent
 * (navigator.userActivation: 5 s on an idle page in Chrome, WebKit and
 * Firefox, measured 10-23); false where it cannot say.
 */
const clickLapsed = (): boolean => (navigator as { userActivation?: { isActive?: unknown } }).userActivation?.isActive === false;

/** "0.9 MB", "740 KB". */
const sizeLabel = (bytes: number): string => (bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1_000))} KB`);

/**
 * EVERY BLOB THIS DIALOG HAS DRAWN FOR THIS CARD, by what it shows (`part`).
 * The card is a new object on each of the Live page's renders, so blobs are
 * keyed by its CONTENT: the same figures are the same picture, and a saving
 * that lands while the dialog is open draws the new one — and lets the old ones
 * go. `render` must be a stable function.
 */
function useCardBlobs(card: ShareCardData, render: (card: ShareCardData, part: string) => Promise<Blob>) {
  const cardKey = JSON.stringify(card);
  const [started] = useState(() => new Map<string, Promise<Blob>>());
  const [drawn, setDrawn] = useState<ReadonlyMap<string, Drawn>>(() => new Map());

  const request = useCallback(
    (part: string): Promise<Blob> => {
      const key = `${part}|${cardKey}`;
      let picture = started.get(key);
      if (picture === undefined) {
        picture = render(JSON.parse(cardKey) as ShareCardData, part);
        started.set(key, picture);
        // Set even after the dialog closed: a no-op then, and a StrictMode remount must still see it.
        picture.then(
          (blob) => setDrawn((prev) => new Map(prev).set(key, blob)),
          () => setDrawn((prev) => new Map(prev).set(key, "failed")),
        );
      }
      return picture;
    },
    [cardKey, render, started],
  );

  // Figures changed: the pictures of the old ones go.
  useEffect(() => {
    const current = `|${cardKey}`;
    for (const key of [...started.keys()]) if (!key.endsWith(current)) started.delete(key);
    setDrawn((prev) => ([...prev.keys()].every((key) => key.endsWith(current)) ? prev : new Map([...prev].filter(([key]) => key.endsWith(current)))));
  }, [cardKey, started]);

  const get = (part: string): Drawn | undefined => drawn.get(`${part}|${cardKey}`);
  return { request, get };
}

/** The PNG of a background and a unit: "grid|usd". */
const drawCard = (card: ShareCardData, part: string): Promise<Blob> => {
  const [background = "", unit = ""] = part.split("|");
  if (!isBackground(background) || !isUnit(unit)) return Promise.reject(new Error(`no card ${part}`));
  return renderShareCard(card, { background, unit });
};
/** The words alone, for a unit: "usd". */
const drawWords = (card: ShareCardData, unit: string): Promise<Blob> => (isUnit(unit) ? renderShareWords(card, unit) : Promise.reject(new Error(`no unit ${unit}`)));

/**
 * A video made, being made, or failed — by the network (the plate did not
 * arrive: try again) or by the browser. A made one is `saved` once it has been
 * handed to the browser's download; until then its entry says "Download video".
 */
export type Video =
  | { readonly status: "making" }
  | { readonly status: "ready"; readonly blob: Blob; readonly saved: boolean }
  | { readonly status: "failed"; readonly network: boolean };

/**
 * THE BAR OF THE VIDEO BEING MADE, MOVED BY HAND (measured 10-22). Its percent
 * is written straight into the bar's DOM, not through React state: in WebKit
 * the frames are drawn steadily (frame 30 at 360 ms, frame 150 at 841 ms) and
 * the page paints between them, yet React committed no update until the very
 * end — the bar said 0 %, then done. Written by hand, every engine shows it
 * move, and nothing re-renders 100 times. `show` is the bar on screen, if any.
 */
export interface ProgressSink {
  percent: number;
  show: ((percent: number) => void) | null;
}

/**
 * THE VIDEOS THIS DIALOG HAS MADE, by background and unit, for this card — and
 * the one being made, which a new request, a closed dialog or menu, or a change
 * of background or unit cancels (the caller's effects).
 */
function useShareVideos(card: ShareCardData) {
  const cardKey = JSON.stringify(card);
  const [videos, setVideos] = useState<ReadonlyMap<string, Video>>(() => new Map());
  const making = useRef<{ readonly key: string; readonly controller: AbortController } | null>(null);
  const progress = useRef<ProgressSink>({ percent: 0, show: null });
  const keyOf = useCallback((background: ShareBackground, unit: ShareUnit) => `${background}|${unit}|${cardKey}`, [cardKey]);

  const set = useCallback(
    (key: string, video: Video | null): void =>
      setVideos((prev) => {
        const next = new Map(prev);
        if (video === null) next.delete(key);
        else next.set(key, video);
        return next;
      }),
    [],
  );

  /** Stop the video being made, unless it is `keep`'s; it leaves no trace. */
  const cancel = useCallback(
    (keep?: string): void => {
      const current = making.current;
      if (current === null || current.key === keep) return;
      making.current = null;
      current.controller.abort();
      set(current.key, null);
    },
    [set],
  );

  /** Make the video of a background and unit: how it ended, or null when it was cancelled. */
  const make = useCallback(
    (background: ShareBackground, unit: ShareUnit): Promise<Video | null> => {
      cancel();
      const key = keyOf(background, unit);
      const controller = new AbortController();
      making.current = { key, controller };
      progress.current.percent = 0;
      set(key, { status: "making" });
      return makeShareVideo({
        card: JSON.parse(cardKey) as ShareCardData,
        unit,
        background,
        signal: controller.signal,
        onProgress: (done) => {
          const percent = Math.min(99, Math.floor(done * 100));
          if (percent === progress.current.percent || controller.signal.aborted) return;
          progress.current.percent = percent;
          progress.current.show?.(percent);
        },
      }).then(
        (blob): Video | null => {
          if (controller.signal.aborted) return null;
          making.current = null;
          const made: Video = { status: "ready", blob, saved: false };
          set(key, made);
          return made;
        },
        (error: unknown): Video | null => {
          if (controller.signal.aborted) return null;
          making.current = null;
          const failed: Video = { status: "failed", network: error instanceof PlateUnavailable };
          set(key, failed);
          return failed;
        },
      );
    },
    [cancel, cardKey, keyOf, set],
  );

  /** A made video handed to the browser's download: its entry reads "Video (MP4)" again. */
  const markSaved = useCallback(
    (key: string): void =>
      setVideos((prev) => {
        const video = prev.get(key);
        return video?.status === "ready" && !video.saved ? new Map(prev).set(key, { ...video, saved: true }) : prev;
      }),
    [],
  );

  // Figures changed: the old card's videos go, and one in flight stops.
  useEffect(() => {
    const current = `|${cardKey}`;
    if (making.current !== null && !making.current.key.endsWith(current)) cancel();
    setVideos((prev) => ([...prev.keys()].every((key) => key.endsWith(current)) ? prev : new Map([...prev].filter(([key]) => key.endsWith(current)))));
  }, [cancel, cardKey]);

  // The dialog closed: nothing keeps encoding behind it.
  useEffect(() => () => cancel(), [cancel]);

  const get = (background: ShareBackground, unit: ShareUnit): Video | undefined => videos.get(keyOf(background, unit));
  return { make, cancel, markSaved, get, keyOf, progress: progress.current };
}

/** The video being made, in its menu entry: its percent and bar, written by the sink (ProgressSink says why). */
function MakingProgress({ sink }: { sink: ProgressSink }) {
  // Spans: the entry is a row of phrasing content.
  const bar = useRef<HTMLSpanElement>(null);
  const fill = useRef<HTMLSpanElement>(null);
  const label = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const show = (percent: number): void => {
      bar.current?.setAttribute("aria-valuenow", String(percent));
      if (fill.current !== null) fill.current.style.width = `${percent}%`;
      if (label.current !== null) label.current.textContent = `${percent}%`;
    };
    sink.show = show;
    show(sink.percent);
    return () => {
      if (sink.show === show) sink.show = null;
    };
  }, [sink]);
  return (
    <span className="flex w-full flex-col gap-1.5">
      <span className="flex items-center gap-2">
        <LoaderCircle aria-hidden className="motion-safe:animate-spin" />
        <span className="flex-1">{SHARE_COPY.video.making}</span>
        <span ref={label} aria-hidden className="text-xs text-muted-foreground tabular-nums">
          0%
        </span>
      </span>
      {/* Its own bar, not ui/progress: that one keeps the value off the bar's role, so a screen reader would hear no number. */}
      <span ref={bar} role="progressbar" aria-label={SHARE_COPY.video.makingSaid} aria-valuemin={0} aria-valuemax={100} aria-valuenow={0} className="block h-1.5 overflow-hidden rounded-full bg-muted">
        <span ref={fill} className="block h-full w-0 rounded-full bg-emerald-500 transition-[width] duration-150 motion-reduce:transition-none" />
      </span>
    </span>
  );
}

/** A background's preview in the picker: the plate's thumb, the card's words over it. */
function Thumb({ plate, words }: { plate: SharePlate; words: string | null }) {
  return (
    <span
      className="relative block w-full overflow-hidden rounded-md bg-[#0A0B11] ring-1 ring-foreground/10 ring-offset-2 ring-offset-popover group-data-[state=on]/toggle:ring-2 group-data-[state=on]/toggle:ring-emerald-500 sm:w-22"
      style={{ aspectRatio: `${SHARE_CARD.width} / ${SHARE_CARD.height}` }}
    >
      <img src={plate.thumb} alt="" className="absolute inset-0 block size-full" draggable={false} />
      {words === null ? null : <img src={words} alt="" className="relative block size-full" draggable={false} />}
    </span>
  );
}

/** What the menu's Video entry says and does, by its video's state — while it is made, it is its progress instead (MakingProgress). */
export interface VideoEntry {
  /** Make it (keeping the menu open for its progress), or save the one already made. */
  readonly does: "make" | "save";
  readonly label: string;
  /** Beside the label: its length, its weight once made, or Try again. */
  readonly hint: string;
  /** Why the last one failed, said under the entry. */
  readonly failed: string | null;
}

export function videoEntry(video: Video | undefined, seconds: number): VideoEntry {
  const make = { does: "make", label: SHARE_COPY.downloadVideo, hint: SHARE_COPY.video.length(seconds), failed: null } as const;
  if (video?.status === "failed") return { ...make, hint: SHARE_COPY.video.retry, failed: video.network ? SHARE_COPY.video.failedNetwork : SHARE_COPY.video.failed };
  if (video?.status !== "ready") return make;
  // Made and not yet saved — it outlived the click that asked for it: the one click left (the header's DOWNLOADED AT THE END).
  return video.saved ? { ...make, does: "save" } : { does: "save", label: SHARE_COPY.video.save, hint: sizeLabel(video.blob.size), failed: null };
}

/** A menu entry with room for a finger. */
const ENTRY = "gap-2 px-2 py-1.5 max-sm:py-2.5";

/**
 * DOWNLOAD (owner, 10-23: "Dentro de Download"): the image's own button where
 * this browser cannot make the video, the menu of the two files where it can
 * (the header's THE VIDEO, INSIDE DOWNLOAD).
 */
export function DownloadButton({ canVideo, disabled, onImage, ...menu }: DownloadMenuProps & { canVideo: boolean }) {
  if (canVideo) return <DownloadMenu disabled={disabled} onImage={onImage} {...menu} />;
  return (
    <Button type="button" variant="outline" disabled={disabled} onClick={onImage} data-share-action="download">
      <Download aria-hidden />
      {SHARE_COPY.download}
    </Button>
  );
}

interface DownloadMenuProps {
  /** The image is still being drawn. */
  disabled: boolean;
  video: Video | undefined;
  progress: ProgressSink;
  seconds: number;
  /** The card's link is still being asked for: Video waits with Post on X. */
  waiting?: boolean;
  open: boolean;
  /** Closing the menu cancels a video being made (SharePanel). */
  onOpenChange: (open: boolean) => void;
  onImage: () => void;
  onMake: () => void;
  onSave: (blob: Blob) => void;
  onCancel: () => void;
}

function DownloadMenu({ disabled, video, progress, seconds, waiting = false, open, onOpenChange, onImage, onMake, onSave, onCancel }: DownloadMenuProps) {
  const failedId = useId();
  const content = useRef<HTMLDivElement>(null);
  const videoItem = useRef<HTMLDivElement>(null);
  const cancelItem = useRef<HTMLDivElement>(null);
  const making = video?.status === "making";
  const entry = videoEntry(video, seconds);
  const state = making ? "making" : video?.status === "failed" ? "failed" : video?.status === "ready" ? (video.saved ? "saved" : "unsaved") : "idle";

  // FOCUS FOLLOWS THE VIDEO, inside the menu only: to Cancel while it is made (the entry it was on can no longer
  // be chosen), back to the entry when it failed or waits for its one click. Never taken from outside the menu.
  const was = useRef(state);
  useEffect(() => {
    if (was.current === state) return;
    was.current = state;
    const to = state === "making" ? cancelItem.current : state === "failed" || state === "unsaved" ? videoItem.current : null;
    const at = document.activeElement;
    if (to !== null && (at === null || at === document.body || content.current?.contains(at) === true)) to.focus();
  }, [state]);

  return (
    <DropdownMenu modal={false} open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" disabled={disabled} data-share-action="download">
          {/* Under sm the three buttons share a phone's width to the pixel: the chevron that says "menu" takes the icon's place. */}
          <Download aria-hidden className="max-sm:hidden" />
          {SHARE_COPY.download}
          <ChevronDown aria-hidden data-icon="inline-end" className="size-3.5 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent ref={content} align="end" collisionPadding={8} className="w-60" data-share-menu="">
        <DropdownMenuItem onSelect={onImage} className={ENTRY} data-share-action="download-image">
          <ImageIcon aria-hidden />
          {SHARE_COPY.downloadImage}
        </DropdownMenuItem>
        {/* One entry in every state, so the element — and the focus on it — stays. */}
        {making ? (
          <DropdownMenuItem
            ref={videoItem}
            disabled
            textValue={SHARE_COPY.downloadVideo}
            aria-label={SHARE_COPY.video.makingSaid}
            className={cn(ENTRY, "data-disabled:opacity-100")}
            data-share-action="download-video"
            data-share-video={state}
          >
            <MakingProgress sink={progress} />
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem
            ref={videoItem}
            disabled={waiting && entry.does === "make"}
            textValue={SHARE_COPY.downloadVideo}
            aria-describedby={entry.failed === null ? undefined : failedId}
            onSelect={(event) => {
              if (video?.status === "ready") return onSave(video.blob);
              // The menu stays open: the video's progress is shown in it.
              event.preventDefault();
              onMake();
            }}
            className={ENTRY}
            data-share-action="download-video"
            data-share-video={state}
          >
            {state === "failed" ? <RotateCcw aria-hidden /> : state === "unsaved" ? <Download aria-hidden /> : <Film aria-hidden />}
            <span className="flex-1">{entry.label}</span>
            {/* The length is for the eye (a reader would say "12 s"); Try again and a weight are read out. */}
            <span aria-hidden={state === "idle" || state === "saved" ? true : undefined} className="text-xs text-muted-foreground tabular-nums">
              {entry.hint}
            </span>
          </DropdownMenuItem>
        )}
        {making ? (
          <DropdownMenuItem ref={cancelItem} onSelect={onCancel} className={ENTRY} data-share-action="video-cancel">
            <X aria-hidden />
            {SHARE_COPY.video.cancel}
          </DropdownMenuItem>
        ) : null}
        {entry.failed !== null && !making ? (
          <div id={failedId} className="px-2 pt-0.5 pb-1.5 text-xs text-destructive">
            {entry.failed}
          </div>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * THE CARD'S LINK FOR THIS DIALOG (lib/share-link-client.ts): the sample's at
 * once, a Live page's from one POST — taken from what was already asked for
 * the same figures when there is an answer. Keyed by what the PAGE shows, so
 * adopting the server's card never asks again.
 */
function useShareLink(card: ShareCardData, source: ShareLinkSource | undefined): ShareLinkState {
  const live = source?.kind === "live" ? source : null;
  const key = live === null ? (source?.kind ?? "none") : shareLinkKey(live, card);
  const initial = (): ShareLinkState => {
    if (source === undefined) return { status: "none" };
    if (source.kind === "example") return { status: "ready", card: null, links: EXAMPLE_SHARE_LINKS };
    const kept = keptShareLink(source, card);
    return kept === undefined ? { status: "pending" } : kept === null ? { status: "failed" } : { status: "ready", card: kept.card, links: kept.links };
  };
  const [state, setState] = useState<ShareLinkState>(initial);

  // Runs again only when the key does: this render's source and card are then exactly the ones the key names.
  useEffect(() => {
    const asking = live;
    if (asking === null) {
      setState(initial());
      return;
    }
    let current = true;
    const kept = keptShareLink(asking, card);
    if (kept !== undefined) {
      setState(kept === null ? { status: "failed" } : { status: "ready", card: kept.card, links: kept.links });
      return;
    }
    setState({ status: "pending" });
    // Never more than a few seconds of a disabled button: then the site's link, and a late answer is still taken.
    const timer = window.setTimeout(() => {
      if (current) setState((prev) => (prev.status === "pending" ? { status: "failed" } : prev));
    }, SHARE_LINK_WAIT_MS);
    void askShareLink(asking, card).then((answer) => {
      if (!current) return;
      window.clearTimeout(timer);
      setState(answer === null ? { status: "failed" } : { status: "ready", card: answer.card, links: answer.links });
    });
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps -- the key is the source's and the card's identity

  return state;
}

export function SharePanel({ card: pageCard, link }: { card: ShareCardData; link?: ShareLinkSource }) {
  // THE CARD SHOWN IS THE SERVER'S ONCE IT ANSWERS: the figures the link was signed for.
  const linked = useShareLink(pageCard, link);
  const card = linked.status === "ready" && linked.card !== null ? linked.card : pageCard;
  const ids = { background: useId(), unit: useId(), xHint: useId() };
  const [background, setBackground] = useState<ShareBackground>(SHARE_BACKGROUNDS[0]);
  const [picked, setPicked] = useState<ShareUnit>(() => defaultUnit(card));
  const unit = unitFor(card, picked);
  const units = unitsOf(card);
  // Asked once, in the browser: this body is only ever mounted by an open dialog.
  const [caps] = useState(() => shareCaps(globalThis as ShareScope));
  // Whether this browser can make the video: asked once, asynchronously; no row until it answers yes.
  const [canVideo, setCanVideo] = useState(false);
  useEffect(() => {
    let live = true;
    void videoCaps().then((can) => {
      if (live) setCanVideo(can);
    });
    return () => {
      live = false;
    };
  }, []);

  const pictures = useCardBlobs(card, drawCard);
  const words = useCardBlobs(card, drawWords);
  const videos = useShareVideos(card);
  const { request } = pictures;
  const requestWords = words.request;

  // The words first (the preview waits on them), then the image the actions take.
  useEffect(() => {
    void requestWords(unit).catch(() => undefined);
    void request(`${background}|${unit}`).catch(() => undefined);
  }, [request, requestWords, background, unit]);

  // A video being made for another background or unit stops.
  const { cancel: cancelVideo, keyOf: videoKeyOf } = videos;
  useEffect(() => cancelVideo(videoKeyOf(background, unit)), [cancelVideo, videoKeyOf, background, unit]);

  const main = pictures.get(`${background}|${unit}`);
  const ready = main instanceof Blob ? main : null;
  const wordsDrawn = words.get(unit);
  const wordsReady = wordsDrawn instanceof Blob ? wordsDrawn : null;
  // The last words shown stay up while the next are drawn.
  const [lastWords, setLastWords] = useState<Blob | null>(null);
  useEffect(() => {
    if (wordsReady !== null) setLastWords(wordsReady);
  }, [wordsReady]);
  const wordsUrl = useObjectUrl(wordsReady ?? lastWords);

  const [said, setSaid] = useState<Said>("copied");
  const [saying, flash] = useFlash(SAID_MS);
  const say = (what: Said): void => {
    setSaid(what);
    flash();
  };

  const fileName = shareFileName(card);
  const text = sharePostText(card, unit);
  const plate = SHARE_PLATES[background];
  // The page this card's link names, for what is shown: its background and unit.
  const linkPath = linked.status === "ready" ? shareLinkFor(linked.links, background, unit) : null;
  const postUrl = linkPath === null ? SHARE_SITE : shareLinkUrl(linkPath);
  /** The picture X will ask for, asked first — a Live card's, once Post on X is about to be pressed (the header says why). */
  const warm = (): void => {
    if (link?.kind === "live" && linkPath !== null) warmShareImage(shareImagePath(linkPath, SHARE_RENDER_VERSION));
  };

  function copy(then: "copied" | "copiedForX" | "copiedLinked"): void {
    try {
      // BUILT IN THE CLICK, WITH A PROMISE: Safari takes a ClipboardItem only
      // inside the gesture, and lets its data arrive after it.
      const item = new ClipboardItem({ "image/png": request(`${background}|${unit}`) });
      navigator.clipboard.write([item]).then(
        () => say(then),
        () => say("copyFailed"),
      );
    } catch {
      say("copyFailed");
    }
  }

  function download(): void {
    if (ready !== null) saveFile(ready, fileName);
  }

  // ── the video, inside Download (the header's THE VIDEO, INSIDE DOWNLOAD) ──
  const [menuOpen, setMenuOpen] = useState(false);
  const [videoSaid, setVideoSaid] = useState("");
  /** Which request the video's status speaks for: a cancelled one's late answer says nothing. */
  const videoRun = useRef(0);
  const seconds = videoSeconds(plate);
  const videoName = shareFileName(card, "mp4");

  function onMenu(open: boolean): void {
    setMenuOpen(open);
    // Closed — Cancel, Escape, a click outside: the video being made goes with it.
    if (!open) videos.cancel();
  }

  function saveVideo(blob: Blob, key: string): void {
    saveFile(blob, videoName);
    videos.markSaved(key);
  }

  function makeVideo(): void {
    const run = (videoRun.current += 1);
    const key = videos.keyOf(background, unit);
    const name = videoName;
    const length = seconds;
    setVideoSaid(SHARE_COPY.video.makingSaid);
    void videos.make(background, unit).then((done) => {
      if (run !== videoRun.current) return;
      if (done === null) return setVideoSaid("");
      if (done.status !== "ready") return setVideoSaid(done.status === "failed" && done.network ? SHARE_COPY.video.failedNetwork : SHARE_COPY.video.failed);
      setVideoSaid(SHARE_COPY.video.ready(length, sizeLabel(done.blob.size)));
      // Past the click's window the browser may not take a download it did not see asked for: one click is left.
      if (clickLapsed()) return;
      saveFile(done.blob, name);
      videos.markSaved(key);
      setMenuOpen(false);
    });
  }

  function shareFile(blob: Blob, name: string, failed: Said): void {
    const file = new File([blob], name, { type: blob.type });
    // The site inside the text: with a file attached, most targets drop a separate `url`.
    navigator.share({ files: [file], text: `${text} ${postUrl}` }).then(
      () => undefined,
      (error: unknown) => {
        // Closing the sheet is a choice, not a failure.
        if ((error as { name?: unknown } | null)?.name !== "AbortError") say(failed);
      },
    );
  }

  // The link opens X whatever happens here; this only puts the image where a paste can find it —
  // even while it is still being drawn: the clipboard takes the picture's promise (copy()).
  // With the card's own link there is nothing to paste: the image is copied as a bonus, and nothing is said where it cannot be.
  function postOnX(): void {
    warm();
    if (linkPath !== null) {
      if (caps.copy) copy("copiedLinked");
      return;
    }
    if (caps.copy) copy("copiedForX");
    else say("noCopyForX");
  }
  // A pension's link shows its card as "SaverFi’s Vault" (S1; owner, 10-23); the sample's (/c/example) shows this very card.
  const xHint = linkPath !== null ? (link?.kind === "example" ? SHARE_COPY.example.xHintLinked : SHARE_COPY.xHintLinked) : linked.status === "pending" ? SHARE_COPY.xHintPending : caps.copy ? SHARE_COPY.xHint : SHARE_COPY.xHintNoCopy;

  const drawFailed = main === "failed" || wordsDrawn === "failed";

  return (
    <>
      <SharePreviewFrame plate={plate} src={wordsUrl} alt={shareAlt(card, unit)} drawing={wordsReady === null && !drawFailed} failed={drawFailed ? SHARE_COPY.drawFailed : null} />

      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0 space-y-1.5">
          <p id={ids.background} className="text-xs font-medium text-muted-foreground">
            {SHARE_COPY.background}
          </p>
          <ToggleGroup
            type="single"
            value={background}
            aria-labelledby={ids.background}
            className="grid w-full grid-cols-3 sm:flex sm:w-auto"
            onValueChange={(value) => {
              if (isBackground(value)) setBackground(value);
            }}
          >
            {SHARE_BACKGROUNDS.map((each) => (
              <ToggleGroupItem
                key={each}
                value={each}
                className="h-auto min-w-0 flex-col gap-1.5 p-0 text-xs font-normal text-muted-foreground hover:bg-transparent data-[state=on]:bg-transparent data-[state=on]:font-medium data-[state=on]:text-foreground"
              >
                <Thumb plate={SHARE_PLATES[each]} words={wordsUrl} />
                {SHARE_COPY.backgrounds[each]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>

        {card.state === "saved" ? (
          <div className="space-y-1.5">
            <p id={ids.unit} className="text-xs font-medium text-muted-foreground">
              {SHARE_COPY.showIn}
            </p>
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              value={unit}
              aria-labelledby={ids.unit}
              className="w-full sm:w-auto"
              onValueChange={(value) => {
                if (isUnit(value)) setPicked(value);
              }}
            >
              <ToggleGroupItem value="usd" disabled={!units.includes("usd")} className="flex-1 px-3 font-mono">
                USD
              </ToggleGroupItem>
              <ToggleGroupItem value="sol" disabled={!units.includes("sol")} className="flex-1 px-3 font-mono">
                SOL
              </ToggleGroupItem>
            </ToggleGroup>
          </div>
        ) : null}
      </div>
      {card.state === "saved" && !units.includes("usd") ? <p className="-mt-2 text-xs text-muted-foreground">{SHARE_COPY.noPrice}</p> : null}
      {card.state === "saved" && !units.includes("sol") ? <p className="-mt-2 text-xs text-muted-foreground">{SHARE_COPY.example.dollarsOnly}</p> : null}

      <DialogFooter className="flex-col sm:flex-row sm:items-center">
        {/*
          One band, two voices: what an action did — a live region, always in
          the tree so a screen reader hears what lands in it — and, while it is
          empty, what Post on X will do.
        */}
        <div className="order-last flex min-h-4 items-center justify-center text-center text-xs sm:order-first sm:mr-auto sm:justify-start sm:text-left">
          <p role="status" aria-live="polite" className={cn("flex items-center gap-1.5", SAID[said].good ? SAVED : "text-muted-foreground")}>
            {saying ? (
              <>
                {SAID[said].good ? <Check aria-hidden className="size-3.5 shrink-0" /> : <CircleAlert aria-hidden className="size-3.5 shrink-0" />}
                {SAID[said].words}
              </>
            ) : null}
          </p>
          <p id={ids.xHint} className="text-muted-foreground" hidden={saying} data-share-x-hint={linkPath !== null ? "linked" : linked.status}>
            {xHint}
          </p>
          {/* The video's own voice, for a screen reader: made, ready or failed — once per state, never per percent. */}
          <p role="status" aria-live="polite" className="sr-only" data-share-video-said="">
            {videoSaid}
          </p>
        </div>
        {caps.share ? (
          <Button type="button" disabled={ready === null} onClick={() => ready !== null && shareFile(ready, fileName, "shareFailed")} className={cn("max-sm:h-10", OUTLINE_FROM_SM)} data-share-action="share">
            <Share aria-hidden />
            {SHARE_COPY.share}
          </Button>
        ) : null}
        <div className="flex gap-2 *:flex-1 max-sm:*:h-10 sm:*:flex-none">
          {caps.copy ? (
            <Button type="button" variant="outline" disabled={ready === null} onClick={() => copy("copied")} data-share-action="copy">
              <Copy aria-hidden />
              <span className="sm:hidden">{SHARE_COPY.copyShort}</span>
              <span className="max-sm:hidden">{SHARE_COPY.copy}</span>
            </Button>
          ) : null}
          <DownloadButton
            canVideo={canVideo}
            disabled={ready === null}
            video={videos.get(background, unit)}
            progress={videos.progress}
            seconds={seconds}
            waiting={linked.status === "pending"}
            open={menuOpen}
            onOpenChange={onMenu}
            onImage={download}
            onMake={makeVideo}
            onSave={(blob) => saveVideo(blob, videos.keyOf(background, unit))}
            onCancel={() => videos.cancel()}
          />
          {linked.status === "pending" ? (
            // Waiting for the card's link: a button that says so, not a link to the site that would be posted instead.
            <Button type="button" disabled className={caps.share ? OUTLINE_UNDER_SM : undefined} aria-describedby={ids.xHint} data-share-action="x">
              <XMark />
              {SHARE_COPY.postOnX}
            </Button>
          ) : (
            <Button asChild className={caps.share ? OUTLINE_UNDER_SM : undefined}>
              <a
                href={shareIntentUrl(text, postUrl)}
                target="_blank"
                rel="noopener noreferrer"
                onClick={postOnX}
                onPointerEnter={warm}
                onFocus={warm}
                aria-describedby={ids.xHint}
                data-share-action="x"
              >
                <XMark />
                {SHARE_COPY.postOnX}
              </a>
            </Button>
          )}
        </div>
      </DialogFooter>
    </>
  );
}
