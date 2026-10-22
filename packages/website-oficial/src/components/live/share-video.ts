/**
 * THE SHARE CARD AS A SHORT MP4 (owner, 10-22: "Vídeo corto MP4"): the plate's
 * motion with the card's words over it, made in this browser, to download and
 * attach — X, Telegram and Discord play a short soundless MP4 like a GIF. Only
 * a PNG can go on a clipboard, so the still keeps Copy; the video is Download,
 * and the system's sheet where it takes a video file (phones).
 *
 * BROWSER ONLY, AND ONLY ON REQUEST: SharePanel calls makeShareVideo from a
 * click, never on open. Nothing leaves the browser: the plate comes from this
 * site (/share/, connect-src 'self'), and the MP4 is a Blob handed to a
 * download or the sheet.
 *
 * HOW (measured on prototypes, 10-22, Chrome 155, WebKit 18, Firefox 131):
 * WebCodecs' VideoDecoder decodes the plate's MP4 (read by src/lib/share-mp4.ts),
 * each frame is drawn on a canvas with the words over it, WebCodecs'
 * VideoEncoder encodes it to H.264, and share-mp4.ts writes the MP4. No
 * dependency, and no real time: a 10–12 s video in 0.8–0.9 s in Chrome
 * (0.9–1.0 s with DevTools' CPU ×4: the codecs work off the main thread),
 * 0.9–1.1 s in Firefox and 1.0–2.3 s in WebKit — click to "ready", headless on
 * a laptop.
 *   * Not by seeking a <video>: headless Chrome returned frame 0 for every seek,
 *     and each seek into a one-keyframe loop decodes again from frame 0.
 *   * Not by a <video> playing into a canvas: real time (6 s for 6 s), and it
 *     lost one frame in 180.
 *   * Not by MediaRecorder: real time, not deterministic, and Firefox records
 *     no MP4. Every engine with MediaRecorder MP4 also has VideoEncoder.
 *
 * FRAME-EXACT. Exactly the plate's frames, each once, in order (asserted at the
 * end, or no video): the plates have B-frames, and WebKit hands them back in
 * DECODE order (measured: 150 of 180 Grid frames out of place without this) —
 * so decoded frames wait in `held` and are drawn strictly by timestamp (at most
 * three wait, measured). Backpressure comes from the codecs' own output and
 * 'dequeue' events, never from a timer; one watchdog fails a codec that stops
 * answering, rather than leave a progress bar standing.
 *
 * ONE LOOP ENCODED, WRITTEN SHARE_VIDEO_LOOPS TIMES. The loop opens on a
 * keyframe and nothing in it refers across its seam, so its frames written
 * twice are a valid stream of two loops — for the cost of one. Two passes (12 s
 * for Grid, 10 s for the others) read as a clip, not a blip, where a player
 * does not loop (Discord, a phone's gallery); X loops anything under 60 s.
 *
 * WEBKIT ANSWERS LATE (measured 10-22): its encoder reports an empty queue
 * throughout and hands back no chunk until every frame is in — in "realtime"
 * mode too. Its processes grew by 27–41 MB through an export, so it is not
 * holding the frames raw; the progress bar counts frames drawn for that reason
 * (SharePanel).
 *
 * TWO WARM-UP FRAMES, THROWN AWAY. An encoder's rate control starts cold: the
 * first frame came out at 15 dB in Firefox and 37.7 dB in Chrome; after two
 * keyframes of the same picture, dropped, 39.7–40.3 dB and 39.6–39.8 dB.
 *
 * CANCEL: the AbortSignal closes both codecs and every held frame, and the
 * promise rejects with an AbortError. SharePanel aborts when the dialog
 * closes, or when the background or the unit changes under it.
 */

import { cardFonts, drawCardWords } from "@/components/live/share-canvas";
import type { ShareBackground, ShareCardData, ShareUnit } from "@/lib/live-share";
import { mp4ColorOf, muxMp4, parseMp4, type MuxSample, type ParsedMp4 } from "@/lib/share-mp4";
import { PLATE_SIZE, SHARE_FPS, SHARE_PLATES, SHARE_VIDEO_LOOPS } from "@/lib/share-plates";

const W = PLATE_SIZE.width;
const H = PLATE_SIZE.height;

/** H.264 High, Main, then Baseline, at levels that hold 1200×630 at 30 fps. The first this browser encodes is used. */
const ENCODER_CODECS = ["avc1.640028", "avc1.4d0028", "avc1.42e01f"] as const;
/** 1.5 Mbps, variable: 0.7–1.8 MB for two loops, measured — under X's and Discord's limits by far. */
const BITRATE = 1_500_000;
/** How many frames may wait in each codec before feeding pauses. */
const QUEUE = 6;
const WARMUP = 2;
/** More than this many decoded frames waiting for an earlier one: the plate is not what share-plates.ts says. */
const HELD_MAX = 16;
/** A codec that answers nothing for this long has stopped (measured worst case: 15.8 s for the WHOLE video, Chrome at background priority). */
const STALL_MS = 20_000;

/** A frame's timestamp in microseconds: WebCodecs' unit. */
const usOf = (frame: number): number => Math.round((frame * 1_000_000) / SHARE_FPS);

const encoderConfig = (codec: string): VideoEncoderConfig => ({
  codec,
  width: W,
  height: H,
  bitrate: BITRATE,
  bitrateMode: "variable",
  framerate: SHARE_FPS,
  latencyMode: "quality",
  avc: { format: "avc" },
});

let encoderOnce: Promise<string | null> | null = null;

/** The first H.264 profile this browser encodes at the video's size; null when none. */
function encoderCodec(): Promise<string | null> {
  encoderOnce ??= (async () => {
    for (const codec of ENCODER_CODECS) {
      try {
        if ((await VideoEncoder.isConfigSupported(encoderConfig(codec))).supported === true) return codec;
      } catch {
        // A config this browser cannot even parse is one it cannot encode.
      }
    }
    return null;
  })();
  return encoderOnce;
}

/**
 * WHETHER THIS BROWSER CAN MAKE THE VIDEO — asked before the dialog offers it,
 * without downloading a plate: the codecs and canvas exist, it decodes the
 * plates' codec (from the registry, which the build checks against the files),
 * and it encodes H.264 at 1200×630. Where not, the dialog offers no video at
 * all: a button that can only fail is worse than none.
 */
export async function videoCaps(): Promise<boolean> {
  if (
    typeof VideoEncoder !== "function" ||
    typeof VideoDecoder !== "function" ||
    typeof VideoFrame !== "function" ||
    typeof EncodedVideoChunk !== "function" ||
    typeof OffscreenCanvas !== "function"
  ) {
    return false;
  }
  try {
    for (const codec of new Set(Object.values(SHARE_PLATES).map((plate) => plate.codec))) {
      if ((await VideoDecoder.isConfigSupported({ codec, codedWidth: W, codedHeight: H })).supported !== true) return false;
    }
    return (await encoderCodec()) !== null;
  } catch {
    return false;
  }
}

const plates = new Map<ShareBackground, Promise<{ readonly bytes: Uint8Array; readonly mp4: ParsedMp4 }>>();

/** A plate's MP4, fetched and read once per dialog's life; a failure is not kept. */
function plateOf(background: ShareBackground): Promise<{ readonly bytes: Uint8Array; readonly mp4: ParsedMp4 }> {
  let plate = plates.get(background);
  if (plate === undefined) {
    plate = fetch(SHARE_PLATES[background].mp4)
      .then((response) => (response.ok ? response.arrayBuffer() : Promise.reject(new Error(`plate ${response.status}`))))
      .then((buffer) => ({ bytes: new Uint8Array(buffer), mp4: parseMp4(buffer) }));
    plate.catch(() => plates.delete(background));
    plates.set(background, plate);
  }
  return plate;
}

/** A BufferSource's bytes, copied. */
function bytesOf(source: AllowSharedBufferSource): Uint8Array {
  return ArrayBuffer.isView(source) ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength).slice() : new Uint8Array(source).slice();
}

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((byte, i) => byte === b[i]);

const cancelled = (): DOMException => new DOMException("The video was cancelled.", "AbortError");

export interface VideoRequest {
  readonly card: ShareCardData;
  readonly unit: ShareUnit;
  readonly background: ShareBackground;
  readonly signal?: AbortSignal;
  /** 0 to 1: the frames drawn and handed to the encoder so far; 1 once the file is written. */
  readonly onProgress?: (done: number) => void;
}

/** THE VIDEO: the plate's loop with the card's words, as an MP4 Blob. Rejects with an AbortError when cancelled. */
export async function makeShareVideo({ card, unit, background, signal, onProgress }: VideoRequest): Promise<Blob> {
  if (signal?.aborted) throw cancelled();
  const [{ bytes, mp4 }, fonts, codec] = await Promise.all([plateOf(background), cardFonts(), encoderCodec()]);
  if (signal?.aborted) throw cancelled();
  if (codec === null) throw new Error("this browser encodes no H.264");
  const frames = SHARE_PLATES[background].frames;
  if (mp4.frames !== frames || mp4.width !== W || mp4.height !== H) throw new Error(`the ${background} plate is not what share-plates.ts says`);

  // The words, once, on a transparent layer at the video's size.
  const words = new OffscreenCanvas(W, H);
  const wordsCtx = words.getContext("2d");
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext("2d", { alpha: false });
  if (wordsCtx === null || ctx === null) throw new Error("no 2d canvas");
  drawCardWords(wordsCtx, card, { unit, scale: 1 }, fonts);

  // ── failing, waiting, cancelling ──
  let failure: unknown = null;
  let rejectFailed: (error: unknown) => void = () => undefined;
  const failed = new Promise<never>((_, reject) => (rejectFailed = reject));
  failed.catch(() => undefined);
  let wake: (() => void) | null = null;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const fail = (error: unknown): void => {
    if (failure !== null) return;
    failure = error;
    rejectFailed(error);
  };
  /** Something moved: wake the feeder, and re-arm the watchdog. */
  const poke = (): void => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => fail(new Error("the video stopped making progress")), STALL_MS);
    const waiting = wake;
    wake = null;
    waiting?.();
  };
  /** A wait that ends at once when the video fails or is cancelled. */
  const step = <T>(promise: Promise<T>): Promise<T> => Promise.race([promise, failed]);
  /** A codec's promise that may reject after its codec is closed under it: never an unhandled rejection. */
  const quiet = <T>(promise: Promise<T>): Promise<T> => {
    promise.catch(() => undefined);
    return promise;
  };
  const onAbort = (): void => fail(cancelled());
  signal?.addEventListener("abort", onAbort, { once: true });

  // ── the encoder: every chunk copied out, and its parameter sets (the avcC) kept ──
  const chunks: { readonly data: Uint8Array; readonly key: boolean; readonly timestamp: number }[] = [];
  let avcC: Uint8Array | null = null;
  let colorSpace: VideoColorSpaceInit | undefined;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      const config = meta?.decoderConfig;
      if (config?.description !== undefined) {
        const description = bytesOf(config.description);
        if (avcC === null) avcC = description;
        // One avcC heads the file: parameter sets that changed mid-stream would make every frame after them undecodable.
        else if (!sameBytes(avcC, description)) fail(new Error("the encoder changed its parameter sets"));
      }
      if (config?.colorSpace !== undefined) colorSpace = config.colorSpace;
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      chunks.push({ data, key: chunk.type === "key", timestamp: chunk.timestamp });
      poke();
    },
    error: fail,
  });

  // ── the decoder: frames held until their turn, then drawn with the words and encoded ──
  const held = new Map<number, VideoFrame>();
  let next = 0;
  /**
   * ONE FRAME: the plate's picture, the words over it, and the result handed to
   * the encoder as pixels of its own. The canvas is TRANSFERRED into an
   * ImageBitmap (no copy: the canvas starts a fresh buffer), and only then is
   * the decoded frame closed. Measured 10-22: drawing on, closing the decoded
   * frame at once and encoding a VideoFrame of the canvas itself, Firefox put
   * a later frame's picture in an earlier frame's place in 6 of 12 videos (one
   * or two frames ahead, never behind) — its canvas painted after the next
   * draws, or from a decoder buffer already handed back. With the transfer:
   * 0 of 18 in Firefox, 0 of 9 in WebKit, 0 of 9 in Chrome.
   */
  const draw = (frame: VideoFrame, index: number): void => {
    ctx.drawImage(frame, 0, 0, W, H);
    ctx.drawImage(words, 0, 0);
    const picture = canvas.transferToImageBitmap();
    frame.close();
    try {
      if (index === 0) {
        for (let w = 0; w < WARMUP; w += 1) {
          const warm = new VideoFrame(picture, { timestamp: usOf(w), duration: usOf(1) });
          encoder.encode(warm, { keyFrame: true });
          warm.close();
        }
      }
      const out = new VideoFrame(picture, { timestamp: usOf(WARMUP + index), duration: usOf(1) });
      encoder.encode(out, { keyFrame: index === 0 });
      out.close();
    } finally {
      picture.close();
    }
  };
  const decoder = new VideoDecoder({
    output: (frame) => {
      if (failure !== null) {
        frame.close();
        return;
      }
      held.set(frame.timestamp, frame);
      if (held.size > HELD_MAX) return fail(new Error("the plate's frames came back too far out of order"));
      try {
        for (let ready = held.get(usOf(next)); ready !== undefined; ready = held.get(usOf(next))) {
          held.delete(usOf(next));
          draw(ready, next);
          next += 1;
          // Frames drawn and handed to the encoder: WebKit's encoder answers in one burst at the flush, so its chunks cannot show progress.
          onProgress?.(next / frames);
        }
      } catch (error) {
        fail(error);
      }
      poke();
    },
    error: fail,
  });

  try {
    encoder.configure(encoderConfig(codec));
    decoder.configure({ codec: mp4.codec, description: mp4.description, codedWidth: mp4.width, codedHeight: mp4.height });
    decoder.addEventListener("dequeue", poke);
    encoder.addEventListener("dequeue", poke);
    onProgress?.(0);
    poke();

    // Fed in decode order, each sample stamped with the frame it shows.
    for (const sample of mp4.samples) {
      while (failure === null && (decoder.decodeQueueSize > QUEUE || encoder.encodeQueueSize > QUEUE)) {
        await step(new Promise<void>((resolve) => (wake = resolve)));
      }
      if (failure !== null) throw failure;
      decoder.decode(
        new EncodedVideoChunk({ type: sample.key ? "key" : "delta", timestamp: usOf(sample.frame), duration: usOf(1), data: bytes.subarray(sample.offset, sample.offset + sample.size) }),
      );
    }
    await step(quiet(decoder.flush()));
    await step(quiet(encoder.flush()));
    if (failure !== null) throw failure;

    // Every frame once, in order — or no video.
    if (next !== frames || held.size > 0) throw new Error(`drew ${next} of ${frames} frames`);
    if (chunks.length !== WARMUP + frames) throw new Error(`the encoder gave ${chunks.length} frames for ${WARMUP + frames}`);
    const loop = chunks.slice(WARMUP);
    if (!chunks.every((chunk, i) => i === 0 || chunk.timestamp > chunks[i - 1]!.timestamp)) throw new Error("the encoder's frames came out of order");
    if (loop[0]?.key !== true) throw new Error("the loop does not open on a keyframe");
    if (avcC === null) throw new Error("the encoder gave no parameter sets");

    const samples: MuxSample[] = [];
    for (let pass = 0; pass < SHARE_VIDEO_LOOPS; pass += 1) samples.push(...loop);
    const file = muxMp4({ width: W, height: H, fps: SHARE_FPS, description: avcC, samples, color: mp4ColorOf(colorSpace) });
    onProgress?.(1);
    return new Blob([file], { type: "video/mp4" });
  } finally {
    clearTimeout(watchdog);
    signal?.removeEventListener("abort", onAbort);
    for (const frame of held.values()) frame.close();
    held.clear();
    if (decoder.state !== "closed") decoder.close();
    if (encoder.state !== "closed") encoder.close();
  }
}
