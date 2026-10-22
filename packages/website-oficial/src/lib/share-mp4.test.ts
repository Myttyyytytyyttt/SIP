// THE SHARE VIDEO'S CONTAINER (owner, 10-22: "Vídeo corto MP4"): the reader
// on the plates the site ships — B-frames and all — and the writer, byte for
// byte. What a player makes of the writer's files (ffprobe, ffmpeg, Chrome,
// WebKit, Firefox) is checked against real exports; here, that the bytes are
// the ones meant.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { mp4ColorOf, muxMp4, parseMp4, type MuxSample } from "@/lib/share-mp4";
import { SHARE_PLATES } from "@/lib/share-plates";

const PUBLIC = fileURLToPath(new URL("../../public/", import.meta.url));
const plateFile = (name: keyof typeof SHARE_PLATES): Uint8Array => readFileSync(join(PUBLIC, "share", `${name}.mp4`));

/** A box tree, as "type:size" lines, children indented: what a failing golden is read by. */
function tree(bytes: Uint8Array, start = 0, end = bytes.length, depth = 0): string[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const lines: string[] = [];
  for (let at = start; at + 8 <= end; ) {
    const size = view.getUint32(at);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    lines.push(`${"  ".repeat(depth)}${type}:${size}`);
    const children: Record<string, number> = { moov: 8, trak: 8, mdia: 8, minf: 8, dinf: 8, stbl: 8, stsd: 16, avc1: 86 };
    if (children[type] !== undefined) lines.push(...tree(bytes, at + children[type], at + size, depth + 1));
    at += size;
  }
  return lines;
}

/** An avcC for High 4.0 with a made-up SPS and PPS: the writer copies it, the reader names it. */
const AVCC = Uint8Array.from([1, 0x64, 0x00, 0x28, 0xff, 0xe1, 0, 4, 0x67, 0x64, 0x00, 0x28, 1, 0, 2, 0x68, 0xee]);
const THREE: readonly MuxSample[] = [
  { data: Uint8Array.from([0, 0, 0, 3, 0x65, 0x88, 0x80]), key: true },
  { data: Uint8Array.from([0, 0, 0, 2, 0x41, 0x9a]), key: false },
  { data: Uint8Array.from([0, 0, 0, 2, 0x41, 0x9b]), key: false },
];
const BT709 = { primaries: 1, transfer: 1, matrix: 1, fullRange: false };

describe("the reader, on the plates the site ships", () => {
  it("one H.264 track, 1200×630 at 30 fps, the registry's frames, ONE keyframe — the first sample, frame 0", () => {
    for (const [name, plate] of Object.entries(SHARE_PLATES)) {
      const mp4 = parseMp4(plateFile(name as keyof typeof SHARE_PLATES));
      expect({ codec: mp4.codec, width: mp4.width, height: mp4.height, frames: mp4.frames }, name).toEqual({ codec: plate.codec, width: 1200, height: 630, frames: plate.frames });
      expect(mp4.samples.filter((sample) => sample.key).length, name).toBe(1);
      expect(mp4.samples[0], name).toMatchObject({ key: true, frame: 0, pts: 0, dts: 0 });
      expect(mp4.samples.every((sample, i) => sample.dts === (i * mp4.timescale) / 30), name).toBe(true);
      // The avcC is what VideoDecoder.configure takes: version 1, its profile and level in the codec string.
      expect(mp4.description[0]).toBe(1);
      expect(mp4.codec).toBe(`avc1.${[...mp4.description.subarray(1, 4)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`);
    }
  });

  it("reorders B-frames: decode order is not the screen's, and `frame` puts every sample in its place once", () => {
    const mp4 = parseMp4(plateFile("grid"));
    expect(mp4.reorders).toBe(true);
    // Measured: the plates decode 0, 6, 3, 1, 2, 4, 5, 11, … — a frame shown later is decoded first.
    expect(mp4.samples.slice(0, 8).map((sample) => sample.frame)).toEqual([0, 6, 3, 1, 2, 4, 5, 11]);
    const frames = mp4.samples.map((sample) => sample.frame);
    expect([...frames].sort((a, b) => a - b)).toEqual(Array.from({ length: 180 }, (_, i) => i));
    // In screen order, every frame is 1/30 s after the last.
    const byFrame = [...mp4.samples].sort((a, b) => a.frame - b.frame);
    expect(byFrame.every((sample, i) => sample.pts === (i * mp4.timescale) / 30)).toBe(true);
  });

  it("each sample's bytes are where it says: an H.264 frame, length-prefixed, inside the file", () => {
    const bytes = plateFile("vault");
    const mp4 = parseMp4(bytes);
    for (const sample of mp4.samples) {
      expect(sample.offset + sample.size).toBeLessThanOrEqual(bytes.length);
      const length = new DataView(bytes.buffer, bytes.byteOffset + sample.offset, 4).getUint32(0);
      expect(length).toBeLessThanOrEqual(sample.size - 4);
    }
    // The first NAL of the one keyframe: an IDR slice (type 5), or the SEI/parameter sets before it.
    const first = bytes[mp4.samples[0]!.offset + 4]! & 0x1f;
    expect([5, 6, 7, 8, 9]).toContain(first);
  });

  it("throws on a file that is not a plate, rather than guess", () => {
    expect(() => parseMp4(new Uint8Array(16))).toThrow(/tracks/);
    expect(() => parseMp4(Uint8Array.from([0, 0, 0, 99, 0x6d, 0x6f, 0x6f, 0x76]))).toThrow(/broken moov/);
  });
});

describe("the writer", () => {
  it("round trip: what it writes, the reader reads back — sizes, keys, offsets, 1/30 s, the avcC", () => {
    const file = muxMp4({ width: 1200, height: 630, fps: 30, description: AVCC, samples: THREE, color: BT709 });
    const mp4 = parseMp4(file);
    expect(mp4).toMatchObject({ codec: "avc1.640028", width: 1200, height: 630, timescale: 30_000, frames: 3, reorders: false, level: 0x28 });
    expect([...mp4.description]).toEqual([...AVCC]);
    mp4.samples.forEach((sample, i) => {
      expect(sample).toMatchObject({ key: i === 0, frame: i, dts: i * 1000, pts: i * 1000, size: THREE[i]!.data.length });
      expect([...file.subarray(sample.offset, sample.offset + sample.size)]).toEqual([...THREE[i]!.data]);
    });
  });

  it("faststart: the index before the frames, so a player starts before the file has arrived", () => {
    const file = muxMp4({ width: 1200, height: 630, fps: 30, description: AVCC, samples: THREE, color: BT709 });
    expect(tree(file).filter((line) => !line.startsWith(" ")).map((line) => line.split(":")[0])).toEqual(["ftyp", "moov", "mdat"]);
  });

  it("a loop written twice keeps one keyframe a loop: the sync table lists 1 and 4", () => {
    const file = muxMp4({ width: 1200, height: 630, fps: 30, description: AVCC, samples: [...THREE, ...THREE], color: BT709 });
    expect(parseMp4(file).samples.map((sample) => sample.key)).toEqual([true, false, false, true, false, false]);
  });

  /**
   * THE BYTES, PINNED. Its box tree, then its hash: a change to any field of
   * any box fails here, and the tree says which box moved. This exact file was
   * read by ffprobe on 10-22: 1200×630, SAR 1:1, bt709 tv, 30/1, 0.1 s, three
   * packets 1/30 s apart, the first a keyframe (its made-up SPS decodes to
   * nothing, as it should).
   */
  it("golden: three samples, 1200×630 at 30 fps, BT.709 limited", () => {
    const file = muxMp4({ width: 1200, height: 630, fps: 30, description: AVCC, samples: THREE, color: BT709 });
    expect(tree(file)).toEqual([
      "ftyp:32",
      "moov:654",
      "  mvhd:108",
      "  trak:538",
      "    tkhd:92",
      "    mdia:438",
      "      mdhd:32",
      "      hdlr:40",
      "      minf:358",
      "        vmhd:20",
      "        dinf:36",
      "          dref:28",
      "        stbl:294",
      "          stsd:162",
      "            avc1:146",
      "              avcC:25",
      "              colr:19",
      "              pasp:16",
      "          stts:24",
      "          stss:20",
      "          stsc:28",
      "          stsz:32",
      "          stco:20",
      "mdat:27",
    ]);
    expect(file.length).toBe(713);
    expect(createHash("sha256").update(file).digest("hex")).toBe("3d8a5b39cb839a3476484c3b007d0091b30da3613523d2232f302181e4ad0916");
  });
});

describe("the colour it is tagged with", () => {
  it("is the encoder's primaries, transfer and matrix — BT.709 where it said nothing", () => {
    expect(mp4ColorOf(undefined)).toEqual(BT709);
    expect(mp4ColorOf({ primaries: "bt709", transfer: "iec61966-2-1", matrix: "bt709" })).toEqual({ ...BT709, transfer: 13 });
    expect(mp4ColorOf({ primaries: "smpte170m", transfer: "smpte170m", matrix: "smpte170m" })).toEqual({ primaries: 6, transfer: 6, matrix: 6, fullRange: false });
    expect(mp4ColorOf({ primaries: null, transfer: "unheard-of", matrix: null })).toEqual(BT709);
  });

  it("is ALWAYS limited range: WebKit says full of a stream that is not (measured 10-22)", () => {
    const webkitSays = { primaries: "bt709", transfer: "iec61966-2-1", matrix: "bt709", fullRange: true };
    expect(mp4ColorOf(webkitSays).fullRange).toBe(false);
    const file = muxMp4({ width: 1200, height: 630, fps: 30, description: AVCC, samples: THREE, color: mp4ColorOf(webkitSays) });
    const at = Buffer.from(file).indexOf("colr");
    expect([...file.subarray(at + 4, at + 15)]).toEqual([...Buffer.from("nclx"), 0, 1, 0, 13, 0, 1, 0]);
  });
});
