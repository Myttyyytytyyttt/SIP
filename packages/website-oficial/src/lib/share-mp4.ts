/**
 * THE SHARE VIDEO'S CONTAINER, READ AND WRITTEN (owner, 10-22: "Vídeo corto
 * MP4"): the plate's MP4 read into the samples a VideoDecoder takes, and the
 * encoder's samples written into an MP4 that X, Telegram and Discord play like
 * a GIF. live/share-video.ts drives both, in the browser; the build reads the
 * plates with the same reader (scripts/check-share-plates.mts).
 *
 * NO DEPENDENCY, AND NOT A GENERAL MP4 LIBRARY. The reader takes ONE known kind
 * of file — one H.264 (avc1) video track, the plates the films make — and
 * throws on anything else. The writer makes ONE kind: one avc1 track, every
 * sample in one chunk, the index before the data ("faststart", so a player can
 * start before the end arrives), no edit list. Both fit in this file and are
 * tested in node, byte for byte (share-mp4.test.ts): a library for this would
 * be the largest thing the dialog loads.
 *
 * THE PLATES HAVE B-FRAMES (measured 10-22: has_b_frames 2, a ctts box), so a
 * sample's place in the file is not its place on screen. The reader gives each
 * sample both: `frame`, its index in presentation order — the frame of the loop
 * it shows — and its decode order, which is the order of `samples`. The
 * encoders' output has no B-frames (WebCodecs' H.264 encoders make none, and
 * share-video.ts asserts its timestamps rise), so the writer's samples are in
 * one order and need no ctts.
 *
 * Pure: no DOM, no Node. Big-endian throughout, as ISO BMFF is.
 */

/** One sample of the video track, in decode order. */
export interface Mp4Sample {
  /** Where its bytes are, in the file. */
  readonly offset: number;
  readonly size: number;
  /** A sync sample (an IDR frame): decoding can start here. */
  readonly key: boolean;
  /** Its index in presentation order: the frame of the loop it shows, from 0. */
  readonly frame: number;
  /** Decode time, in `timescale` ticks, from the first sample's. */
  readonly dts: number;
  /** Presentation time, in `timescale` ticks, the first frame's at 0. */
  readonly pts: number;
}

export interface ParsedMp4 {
  /** "avc1.640032": profile, constraint flags and level, from the avcC, as WebCodecs names it. */
  readonly codec: string;
  /** The avcC box's body: what VideoDecoder.configure takes as `description`. */
  readonly description: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly timescale: number;
  readonly frames: number;
  /** In decode order. */
  readonly samples: readonly Mp4Sample[];
  /** Whether the track reorders frames (a ctts box): B-frames. */
  readonly reorders: boolean;
  /** level_idc: 50 is level 5.0. */
  readonly level: number;
}

interface Box {
  readonly type: string;
  readonly start: number;
  readonly body: number;
  readonly end: number;
}

/** The boxes that only hold other boxes, on the way down to the sample table. */
const CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl", "edts", "dinf"]);

const fourcc = (bytes: Uint8Array, at: number): string => String.fromCharCode(bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!);

function* boxesIn(view: DataView, bytes: Uint8Array, start: number, end: number): Generator<Box> {
  let at = start;
  while (at + 8 <= end) {
    let size = view.getUint32(at);
    const type = fourcc(bytes, at + 4);
    let header = 8;
    if (size === 1) {
      size = Number(view.getBigUint64(at + 8));
      header = 16;
    } else if (size === 0) {
      size = end - at;
    }
    if (size < header || at + size > end) throw new Error(`share-mp4: a broken ${type} box at byte ${at}`);
    yield { type, start: at, body: at + header, end: at + size };
    at += size;
  }
}

const hex2 = (n: number): string => n.toString(16).padStart(2, "0");

/**
 * THE PLATE, READ: its one video track's samples in decode order, each with the
 * frame it shows, and what a VideoDecoder needs. Throws on a file that is not
 * that — a second track, another codec, a missing table — rather than guess.
 */
export function parseMp4(input: ArrayBuffer | Uint8Array): ParsedMp4 {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const found = new Map<string, Box>();
  let tracks = 0;
  const walk = (start: number, end: number, inTable: boolean): void => {
    for (const box of boxesIn(view, bytes, start, end)) {
      if (box.type === "trak") tracks += 1;
      if (CONTAINERS.has(box.type)) walk(box.body, box.end, box.type === "stbl");
      else if (inTable || box.type === "mdhd" || box.type === "hdlr") found.set(box.type, box);
    }
  };
  for (const top of boxesIn(view, bytes, 0, bytes.length)) if (top.type === "moov") walk(top.body, top.end, false);
  if (tracks !== 1) throw new Error(`share-mp4: ${tracks} tracks, where a plate has one`);
  const need = (type: string): Box => {
    const box = found.get(type);
    if (box === undefined) throw new Error(`share-mp4: no ${type} box`);
    return box;
  };
  const hdlr = need("hdlr");
  if (fourcc(bytes, hdlr.body + 8) !== "vide") throw new Error("share-mp4: the track is not video");

  const mdhd = need("mdhd");
  const timescale = view.getUint32(mdhd.body + (view.getUint8(mdhd.body) === 1 ? 20 : 12));

  // stsd → avc1 → avcC. The avc1 entry's children follow its 78 bytes of fixed fields.
  const stsd = need("stsd");
  const entry = stsd.body + 8;
  if (fourcc(bytes, entry + 4) !== "avc1") throw new Error(`share-mp4: codec ${fourcc(bytes, entry + 4)}, where a plate is avc1`);
  const width = view.getUint16(entry + 8 + 24);
  const height = view.getUint16(entry + 8 + 26);
  let description: Uint8Array | null = null;
  for (const child of boxesIn(view, bytes, entry + 8 + 78, entry + view.getUint32(entry))) {
    if (child.type === "avcC") description = bytes.slice(child.body, child.end);
  }
  if (description === null || description.length < 4) throw new Error("share-mp4: no avcC");
  const codec = `avc1.${hex2(description[1]!)}${hex2(description[2]!)}${hex2(description[3]!)}`;

  // Sizes.
  const stsz = need("stsz");
  const fixed = view.getUint32(stsz.body + 4);
  const count = view.getUint32(stsz.body + 8);
  const sizes = Array.from({ length: count }, (_, i) => (fixed !== 0 ? fixed : view.getUint32(stsz.body + 12 + 4 * i)));

  // Chunk offsets, then each sample's offset through sample-to-chunk.
  const co = found.get("stco") ?? found.get("co64");
  if (co === undefined) throw new Error("share-mp4: no stco or co64 box");
  const wide = co.type === "co64";
  const chunks = view.getUint32(co.body + 4);
  const chunkOffsets = Array.from({ length: chunks }, (_, i) => (wide ? Number(view.getBigUint64(co.body + 8 + 8 * i)) : view.getUint32(co.body + 8 + 4 * i)));
  const stsc = need("stsc");
  const runs = Array.from({ length: view.getUint32(stsc.body + 4) }, (_, i) => ({
    firstChunk: view.getUint32(stsc.body + 8 + 12 * i),
    perChunk: view.getUint32(stsc.body + 12 + 12 * i),
  }));
  const offsets: number[] = [];
  for (let chunk = 0; chunk < chunks && offsets.length < count; chunk += 1) {
    let perChunk = 0;
    for (const run of runs) if (chunk + 1 >= run.firstChunk) perChunk = run.perChunk;
    let at = chunkOffsets[chunk]!;
    for (let k = 0; k < perChunk && offsets.length < count; k += 1) {
      offsets.push(at);
      at += sizes[offsets.length - 1]!;
    }
  }
  if (offsets.length !== count) throw new Error(`share-mp4: ${offsets.length} of ${count} samples placed`);

  // Decode times.
  const stts = need("stts");
  const dts: number[] = [];
  let time = 0;
  for (let e = 0, n = view.getUint32(stts.body + 4); e < n; e += 1) {
    const samples = view.getUint32(stts.body + 8 + 8 * e);
    const delta = view.getUint32(stts.body + 12 + 8 * e);
    for (let k = 0; k < samples; k += 1, time += delta) dts.push(time);
  }
  if (dts.length !== count) throw new Error(`share-mp4: ${dts.length} decode times for ${count} samples`);

  // Composition offsets: version 1 is signed.
  const ctts = found.get("ctts");
  const offsetOf: number[] = new Array<number>(count).fill(0);
  if (ctts !== undefined) {
    const signed = view.getUint8(ctts.body) === 1;
    let i = 0;
    for (let e = 0, n = view.getUint32(ctts.body + 4); e < n; e += 1) {
      const samples = view.getUint32(ctts.body + 8 + 8 * e);
      const offset = signed ? view.getInt32(ctts.body + 12 + 8 * e) : view.getUint32(ctts.body + 12 + 8 * e);
      for (let k = 0; k < samples && i < count; k += 1) offsetOf[i++] = offset;
    }
  }

  // Sync samples: no stss means every sample is one.
  const stss = found.get("stss");
  const keys = stss === undefined ? null : new Set(Array.from({ length: view.getUint32(stss.body + 4) }, (_, i) => view.getUint32(stss.body + 8 + 4 * i) - 1));

  const pts = dts.map((d, i) => d + offsetOf[i]!);
  const first = Math.min(...pts);
  // A sample's frame is its rank on screen.
  const frameOf: number[] = new Array<number>(count);
  pts
    .map((p, i) => [p, i] as const)
    .sort((a, b) => a[0] - b[0])
    .forEach(([, i], rank) => (frameOf[i] = rank));

  const samples = sizes.map((size, i) => ({
    offset: offsets[i]!,
    size,
    key: keys === null || keys.has(i),
    frame: frameOf[i]!,
    dts: dts[i]! - dts[0]!,
    pts: pts[i]! - first,
  }));
  return { codec, description, width, height, timescale, frames: count, samples, reorders: ctts !== undefined, level: description[3]! };
}

// ── the writer ───────────────────────────────────────────────────────────────

/** One encoded frame, in decode order (which, with no B-frames, is the screen's). */
export interface MuxSample {
  readonly data: Uint8Array;
  readonly key: boolean;
}

/** The colour the stream was encoded in, as ISO/IEC 23091-2 code points (1 = BT.709). */
export interface Mp4Color {
  readonly primaries: number;
  readonly transfer: number;
  readonly matrix: number;
  readonly fullRange: boolean;
}

/** WebCodecs' names for colour (VideoColorSpaceInit), as an encoder reports them. */
export interface ColorNames {
  readonly primaries?: string | null;
  readonly transfer?: string | null;
  readonly matrix?: string | null;
}

const PRIMARIES: Readonly<Record<string, number>> = { bt709: 1, bt470bg: 5, smpte170m: 6, bt2020: 9, smpte432: 12 };
const TRANSFERS: Readonly<Record<string, number>> = { bt709: 1, smpte170m: 6, linear: 8, "iec61966-2-1": 13, pq: 16, hlg: 18 };
const MATRICES: Readonly<Record<string, number>> = { rgb: 0, bt709: 1, bt470bg: 5, smpte170m: 6, "bt2020-ncl": 9 };

/**
 * THE colr BOX: the primaries, transfer and matrix the encoder said it encoded
 * (its decoderConfig's colorSpace), BT.709 where it said nothing — and ALWAYS
 * LIMITED RANGE. Never left out: a 630-line stream with no colour of its own
 * is SD to many players, which read its matrix as BT.601, and the card's
 * emerald turns.
 *
 * WHY THE RANGE IS NOT THE ENCODER'S WORD (measured 10-22): WebKit reports
 * `fullRange: true` — the canvas's range, not its stream's — and writes no
 * range of its own into the stream, so the container's word is the one
 * players read. Written as full, ffmpeg decoded the card's ground, (9,10,16)
 * in the still, as (24,25,32): washed out. Written as limited, (8,10,16).
 * Chrome's and Firefox's streams are limited too, and say so themselves.
 */
export function mp4ColorOf(names: ColorNames | undefined): Mp4Color {
  return {
    primaries: PRIMARIES[names?.primaries ?? ""] ?? 1,
    transfer: TRANSFERS[names?.transfer ?? ""] ?? 1,
    matrix: MATRICES[names?.matrix ?? ""] ?? 1,
    fullRange: false,
  };
}

export interface MuxInput {
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  /** The encoder's avcC (its decoderConfig.description). */
  readonly description: Uint8Array;
  readonly samples: readonly MuxSample[];
  /** Written as a colr box, so a player that reads the container's colour reads the encoder's. */
  readonly color: Mp4Color;
}

const ascii = (text: string): Uint8Array => Uint8Array.from(text, (c) => c.charCodeAt(0));
const u8 = (...values: number[]): Uint8Array => Uint8Array.from(values);
const u16 = (n: number): Uint8Array => u8((n >>> 8) & 255, n & 255);
const u32 = (n: number): Uint8Array => u8((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
const zeros = (n: number): Uint8Array => new Uint8Array(n);

type Part = Uint8Array | readonly Part[];
const flat = (parts: readonly Part[]): Uint8Array[] => parts.flatMap((part) => (part instanceof Uint8Array ? [part] : flat(part)));

function box(type: string, ...parts: Part[]): Uint8Array {
  const body = flat(parts);
  const size = 8 + body.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(size);
  out.set(u32(size), 0);
  out.set(ascii(type), 4);
  let at = 8;
  for (const part of body) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const fullBox = (type: string, version: number, flags: number, ...parts: Part[]): Uint8Array => box(type, u8(version, (flags >>> 16) & 255, (flags >>> 8) & 255, flags & 255), ...parts);

/** The identity matrix, in 16.16 and 2.30 fixed point. */
const MATRIX = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000].map(u32);

/**
 * THE VIDEO, WRITTEN: ftyp, then moov (the index), then mdat (the frames).
 * Every sample lasts 1000 ticks of a fps × 1000 timescale (30/1 exactly), the
 * sync samples are listed (stss), and all samples are one chunk, so the index
 * is a handful of numbers. The moov is built twice: once to learn its size,
 * once with the data's real offset.
 */
export function muxMp4({ width, height, fps, description, samples, color }: MuxInput): Uint8Array<ArrayBuffer> {
  if (samples.length === 0) throw new Error("share-mp4: nothing to write");
  const timescale = fps * 1000;
  const delta = 1000;
  const n = samples.length;
  const durationMs = Math.round((n * 1000) / fps);
  const dataSize = samples.reduce((sum, sample) => sum + sample.data.length, 0);
  if (dataSize + 8 > 0xffff_ffff) throw new Error("share-mp4: too large for one mdat");
  const syncNumbers = samples.flatMap((sample, i) => (sample.key ? [i + 1] : []));

  const moovAt = (dataOffset: number): Uint8Array => {
    const avc1 = box(
      "avc1",
      zeros(6),
      u16(1), // data_reference_index
      zeros(16),
      u16(width),
      u16(height),
      u32(0x00480000), // 72 dpi, twice
      u32(0x00480000),
      u32(0),
      u16(1), // one frame per sample
      zeros(32), // no compressor name
      u16(0x0018), // depth: colour, no alpha
      u16(0xffff),
      box("avcC", description),
      box("colr", ascii("nclx"), u16(color.primaries), u16(color.transfer), u16(color.matrix), u8(color.fullRange ? 0x80 : 0)),
      box("pasp", u32(1), u32(1)),
    );
    const stbl = box(
      "stbl",
      fullBox("stsd", 0, 0, u32(1), avc1),
      fullBox("stts", 0, 0, u32(1), u32(n), u32(delta)),
      fullBox("stss", 0, 0, u32(syncNumbers.length), syncNumbers.map(u32)),
      fullBox("stsc", 0, 0, u32(1), u32(1), u32(n), u32(1)),
      fullBox("stsz", 0, 0, u32(0), u32(n), samples.map((sample) => u32(sample.data.length))),
      fullBox("stco", 0, 0, u32(1), u32(dataOffset)),
    );
    const minf = box("minf", fullBox("vmhd", 0, 1, zeros(8)), box("dinf", fullBox("dref", 0, 0, u32(1), fullBox("url ", 0, 1))), stbl);
    const mdia = box(
      "mdia",
      fullBox("mdhd", 0, 0, u32(0), u32(0), u32(timescale), u32(n * delta), u16(0x55c4), u16(0)), // language "und"
      fullBox("hdlr", 0, 0, u32(0), ascii("vide"), zeros(12), ascii("SaverFi\0")),
      minf,
    );
    const tkhd = fullBox("tkhd", 0, 3, u32(0), u32(0), u32(1), u32(0), u32(durationMs), zeros(8), u16(0), u16(0), u16(0), u16(0), MATRIX, u32(width * 65536), u32(height * 65536));
    const mvhd = fullBox("mvhd", 0, 0, u32(0), u32(0), u32(1000), u32(durationMs), u32(0x00010000), u16(0x0100), zeros(10), MATRIX, zeros(24), u32(2));
    return box("moov", mvhd, box("trak", tkhd, mdia));
  };

  const ftyp = box("ftyp", ascii("isom"), u32(0x200), ascii("isomiso2avc1mp41"));
  const sized = moovAt(0);
  const dataOffset = ftyp.length + sized.length + 8;
  const moov = moovAt(dataOffset);
  if (moov.length !== sized.length) throw new Error("share-mp4: the index changed size");

  const out = new Uint8Array(dataOffset + dataSize);
  out.set(ftyp, 0);
  out.set(moov, ftyp.length);
  out.set(u32(8 + dataSize), ftyp.length + moov.length);
  out.set(ascii("mdat"), ftyp.length + moov.length + 4);
  let at = dataOffset;
  for (const sample of samples) {
    out.set(sample.data, at);
    at += sample.data.length;
  }
  return out;
}
