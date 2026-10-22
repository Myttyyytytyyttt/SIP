"use client";

/**
 * THE SHARE DIALOG'S BODY (owner, 10-22): the image, its background and unit,
 * and what to do with it. Loaded on the dialog's first open (ShareSavings.tsx),
 * with the canvas that draws it (share-canvas.ts).
 *
 * WHAT YOU SEE IS WHAT YOU POST: the preview is the PNG itself. Each choice of
 * background and unit is drawn once and kept while the dialog is open, so
 * going back to one is instant; a choice not drawn yet keeps the last picture
 * under a spinner. The three backgrounds' previews are the same card, smaller.
 * Every preview's blob: URL is revoked when its picture goes (useObjectUrl),
 * and a download's once the browser has had time to take the file.
 *
 * THE ACTIONS ARE THE ONES THIS BROWSER CAN CARRY OUT (live-share.ts shareCaps):
 *   Share image  the system's sheet with the file — on a phone, straight into
 *                X, Telegram or anything else. Only where it works.
 *   Copy image   a PNG on the clipboard, to paste into any post. Only where a
 *                browser takes an image there.
 *   Download     always.
 *   Post on X    always: copies the image first where it can, then opens X's
 *                composer in a new tab with a short line and saverfi.cash. A
 *                plain link, so no popup blocker can swallow it.
 * A refusal says so in words (copy-button.tsx's rule: silence reads as success).
 * A download says nothing: the browser shows its own.
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

import { Check, CircleAlert, Copy, Download, Share } from "lucide-react";
import { useCallback, useEffect, useId, useState } from "react";

import { renderShareCard } from "@/components/live/share-canvas";
import { SharePreviewFrame } from "@/components/live/share-frame";
import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useFlash } from "@/hooks/use-flash";
import { SAVED } from "@/lib/classes";
import { SHARE_COPY } from "@/lib/live-copy";
import {
  SHARE_BACKGROUNDS,
  SHARE_CARD,
  SHARE_SCALE,
  SHARE_SITE,
  THUMB_SCALE,
  defaultUnit,
  shareAlt,
  shareCaps,
  shareFileName,
  shareIntentUrl,
  sharePostText,
  unitFor,
  unitsOf,
  type ShareBackground,
  type ShareCardData,
  type ShareScope,
  type ShareUnit,
} from "@/lib/live-share";
import { cn } from "@/lib/utils";

/** How long a line under the actions stays. */
const SAID_MS = 6_000;

type Said = "copied" | "copiedForX" | "copyFailed" | "noCopyForX" | "shareFailed";
const GOOD: Readonly<Record<Said, boolean>> = { copied: true, copiedForX: true, copyFailed: false, noCopyForX: false, shareFailed: false };

/** A picture drawn, or the draw that failed. */
type Drawn = Blob | "failed";

const isBackground = (value: string): value is ShareBackground => (SHARE_BACKGROUNDS as readonly string[]).includes(value);

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

/**
 * EVERY PICTURE THIS DIALOG HAS DRAWN, by what it shows. The card is a new
 * object on each of the Live page's renders, so pictures are keyed by its
 * CONTENT: the same figures are the same picture, and a saving that lands while
 * the dialog is open draws the new one — and lets the old ones go.
 */
function useSharePictures(card: ShareCardData) {
  const cardKey = JSON.stringify(card);
  const [started] = useState(() => new Map<string, Promise<Blob>>());
  const [drawn, setDrawn] = useState<ReadonlyMap<string, Drawn>>(() => new Map());
  const keyOf = useCallback((background: ShareBackground, unit: ShareUnit, scale: number) => `${background}|${unit}|${scale}|${cardKey}`, [cardKey]);

  const request = useCallback(
    (background: ShareBackground, unit: ShareUnit, scale: number): Promise<Blob> => {
      const key = keyOf(background, unit, scale);
      let picture = started.get(key);
      if (picture === undefined) {
        picture = renderShareCard(JSON.parse(cardKey) as ShareCardData, { background, unit, scale });
        started.set(key, picture);
        // Set even after the dialog closed: a no-op then, and a StrictMode remount must still see it.
        picture.then(
          (blob) => setDrawn((prev) => new Map(prev).set(key, blob)),
          () => setDrawn((prev) => new Map(prev).set(key, "failed")),
        );
      }
      return picture;
    },
    [cardKey, keyOf, started],
  );

  // Figures changed: the pictures of the old ones go.
  useEffect(() => {
    const current = `|${cardKey}`;
    for (const key of [...started.keys()]) if (!key.endsWith(current)) started.delete(key);
    setDrawn((prev) => (([...prev.keys()].every((key) => key.endsWith(current)) ? prev : new Map([...prev].filter(([key]) => key.endsWith(current))))));
  }, [cardKey, started]);

  const get = (background: ShareBackground, unit: ShareUnit, scale: number): Drawn | undefined => drawn.get(keyOf(background, unit, scale));
  return { request, get };
}

/** A background's preview in the picker: the whole card, small. */
function Thumb({ drawn }: { drawn: Drawn | undefined }) {
  const url = useObjectUrl(drawn instanceof Blob ? drawn : null);
  return (
    <span
      className="block w-full overflow-hidden rounded-md bg-[#0A0B11] ring-1 ring-foreground/10 ring-offset-2 ring-offset-popover group-data-[state=on]/toggle:ring-2 group-data-[state=on]/toggle:ring-emerald-500 sm:w-22"
      style={{ aspectRatio: `${SHARE_CARD.width} / ${SHARE_CARD.height}` }}
    >
      {url === null ? null : <img src={url} alt="" className="block size-full" draggable={false} />}
    </span>
  );
}

export function SharePanel({ card }: { card: ShareCardData }) {
  const ids = { background: useId(), unit: useId(), xHint: useId() };
  const [background, setBackground] = useState<ShareBackground>("vault");
  const [picked, setPicked] = useState<ShareUnit>(() => defaultUnit(card));
  const unit = unitFor(card, picked);
  const units = unitsOf(card);
  // Asked once, in the browser: this body is only ever mounted by an open dialog.
  const [caps] = useState(() => shareCaps(globalThis as ShareScope));
  const pictures = useSharePictures(card);
  const { request } = pictures;

  // The picture asked for first, then the three previews in the same unit.
  useEffect(() => {
    void request(background, unit, SHARE_SCALE).catch(() => undefined);
    for (const each of SHARE_BACKGROUNDS) void request(each, unit, THUMB_SCALE).catch(() => undefined);
  }, [request, background, unit]);

  const main = pictures.get(background, unit, SHARE_SCALE);
  const ready = main instanceof Blob ? main : null;
  // The last picture shown stays up while the next is drawn.
  const [last, setLast] = useState<Blob | null>(null);
  useEffect(() => {
    if (ready !== null) setLast(ready);
  }, [ready]);
  const shownUrl = useObjectUrl(ready ?? last);

  const [said, setSaid] = useState<Said>("copied");
  const [saying, flash] = useFlash(SAID_MS);
  const say = (what: Said): void => {
    setSaid(what);
    flash();
  };

  const fileName = shareFileName(card);
  const text = sharePostText(card, unit);

  function copy(then: "copied" | "copiedForX"): void {
    try {
      // BUILT IN THE CLICK, WITH A PROMISE: Safari takes a ClipboardItem only
      // inside the gesture, and lets its data arrive after it.
      const item = new ClipboardItem({ "image/png": request(background, unit, SHARE_SCALE) });
      navigator.clipboard.write([item]).then(
        () => say(then),
        () => say("copyFailed"),
      );
    } catch {
      say("copyFailed");
    }
  }

  function download(): void {
    if (ready === null) return;
    const url = URL.createObjectURL(ready);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    document.body.append(link);
    link.click();
    link.remove();
    // Once the browser has taken the file: revoked at once, Firefox can lose the save.
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }

  function share(): void {
    if (ready === null) return;
    const file = new File([ready], fileName, { type: "image/png" });
    // The site inside the text: with a file attached, most targets drop a separate `url`.
    navigator.share({ files: [file], text: `${text} ${SHARE_SITE}` }).then(
      () => undefined,
      (error: unknown) => {
        // Closing the sheet is a choice, not a failure.
        if ((error as { name?: unknown } | null)?.name !== "AbortError") say("shareFailed");
      },
    );
  }

  // The link opens X whatever happens here; this only puts the image where a paste can find it —
  // even while it is still being drawn: the clipboard takes the picture's promise (copy()).
  function postOnX(): void {
    if (caps.copy) copy("copiedForX");
    else say("noCopyForX");
  }

  const drawFailed = main === "failed";

  return (
    <>
      <SharePreviewFrame src={shownUrl} alt={shareAlt(card, unit)} drawing={ready === null && !drawFailed} failed={drawFailed ? SHARE_COPY.drawFailed : null} />

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
                <Thumb drawn={pictures.get(each, unit, THUMB_SCALE)} />
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
                if (value === "usd" || value === "sol") setPicked(value);
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
          <p role="status" aria-live="polite" className={cn("flex items-center gap-1.5", GOOD[said] ? SAVED : "text-muted-foreground")}>
            {saying ? (
              <>
                {GOOD[said] ? <Check aria-hidden className="size-3.5 shrink-0" /> : <CircleAlert aria-hidden className="size-3.5 shrink-0" />}
                {SHARE_COPY[said]}
              </>
            ) : null}
          </p>
          <p id={ids.xHint} className="text-muted-foreground" hidden={saying}>
            {caps.copy ? SHARE_COPY.xHint : SHARE_COPY.xHintNoCopy}
          </p>
        </div>
        {caps.share ? (
          <Button type="button" disabled={ready === null} onClick={share} className={cn("max-sm:h-10", OUTLINE_FROM_SM)} data-share-action="share">
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
          <Button type="button" variant="outline" disabled={ready === null} onClick={download} data-share-action="download">
            <Download aria-hidden />
            {SHARE_COPY.download}
          </Button>
          <Button asChild className={caps.share ? OUTLINE_UNDER_SM : undefined}>
            <a href={shareIntentUrl(text)} target="_blank" rel="noopener noreferrer" onClick={postOnX} aria-describedby={ids.xHint} data-share-action="x">
              <XMark />
              {SHARE_COPY.postOnX}
            </a>
          </Button>
        </div>
      </DialogFooter>
    </>
  );
}
