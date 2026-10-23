// A SHARED CARD'S PREVIEW AND PAGE (owner, 10-22: "Enlace con vista previa"):
// the picture X shows under a post of /c/<token>, drawn on the server from a
// token it signed — at one address per picture, cached for a year — and the
// page around it, noindex, with nothing of anyone's on it. The picture is
// compared with the dialog's own PNG in a browser (the proof); here: that it
// draws every kind of card, from files a standalone build carries, and that a
// redrawn card gets a new address.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DRAWN_FROM, drawnVersion } from "../../scripts/check-share-render.mts";

import { GET as exampleCardImage } from "@/app/c/example/card.png/route";
import ExamplePage, { metadata as exampleMetadata } from "@/app/c/example/page";
import { GET as exampleOnImage, generateStaticParams as exampleBackgrounds } from "@/app/c/example/[background]/card.png/route";
import { GET as cardImage } from "@/app/c/[token]/card.png/route";
import SharedCard, { generateMetadata } from "@/app/c/[token]/page";
import { SHARE_IMAGE_IMMUTABLE, SHARE_OG_DIR, SHARE_OG_FONTS, drawnOnce, fontMetrics, shareCardImage } from "@/components/share-og";
import { SHARE_COPY } from "@/lib/live-copy";
import { toDashboardMock } from "@/lib/live-mock";
import { EXAMPLE_SHARE_LINKS, SHARE_BACKGROUNDS, shareCardOf, type ShareCardData } from "@/lib/live-share";
import { SHARE_RENDER_VERSION } from "@/lib/share-render-version";
import { SHARE_SECRET_ENV, payloadOf, signShareToken } from "@/lib/share-token";

import { OWNER, VAULT, WALLET_A, liveDashboard, liveSnapshot } from "../../test/fixtures/live-dashboard";

const PACKAGE = fileURLToPath(new URL("../../", import.meta.url));
const SECRET = "d".repeat(64);
const KEY = Buffer.from(SECRET);

const page = toDashboardMock(liveDashboard(), { complete: false });
const noPrice = toDashboardMock(liveDashboard({ snapshot: liveSnapshot({ prices: null }) }), { complete: false });
const card = (lifetimeSaved: bigint, over: Partial<ShareCardData> = {}, data = page): ShareCardData => ({
  ...shareCardOf({ lifetimeSaved, stats: data.stats, rule: data.rule, now: data.now }),
  ...over,
});

/** A PNG's size, from its IHDR, after checking it is one. */
async function pngSize(response: Response): Promise<[number, number]> {
  const bytes = Buffer.from(await response.arrayBuffer());
  expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

/** A baseline JPEG's size, from its SOF marker. */
function jpegSize(bytes: Buffer): [number, number] | null {
  let at = 2;
  while (at < bytes.length) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1]!;
    if (marker >= 0xc0 && marker <= 0xc3) return [bytes.readUInt16BE(at + 7), bytes.readUInt16BE(at + 5)];
    at += 2 + bytes.readUInt16BE(at + 2);
  }
  return null;
}

beforeEach(() => vi.stubEnv(SHARE_SECRET_ENV, SECRET));
afterEach(() => vi.unstubAllEnvs());

describe("the preview's own files", () => {
  it("Geist and Geist Mono at 400, 500 and 600, static TrueType, with their licence — and only those", () => {
    const dir = join(PACKAGE, SHARE_OG_DIR, "fonts");
    expect(readdirSync(dir).sort()).toEqual([...SHARE_OG_FONTS.map((font) => font.file), "OFL.txt"].sort());
    expect(readFileSync(join(dir, "OFL.txt"), "utf8")).toContain("SIL Open Font License, Version 1.1");
    for (const font of SHARE_OG_FONTS) {
      const bytes = readFileSync(join(dir, font.file));
      // TrueType outlines (0x00010000), not a variable font: Satori reads neither woff2 nor variations.
      expect(bytes.readUInt32BE(0), font.file).toBe(0x00010000);
      expect(bytes.includes(Buffer.from("fvar")), font.file).toBe(false);
    }
  });

  it("the metrics a baseline is placed by: the app's Geist, 1005 / -295 on 1000, a cap of 710", () => {
    const medium = readFileSync(join(PACKAGE, SHARE_OG_DIR, "fonts/Geist-Medium.ttf"));
    expect(fontMetrics(medium, "E")).toEqual({ unitsPerEm: 1000, ascender: 1005, descender: -295, glyphTop: 710 });
    const mono = fontMetrics(readFileSync(join(PACKAGE, SHARE_OG_DIR, "fonts/GeistMono-SemiBold.ttf")), "0");
    expect([mono.unitsPerEm, mono.ascender, mono.descender]).toEqual([1000, 1005, -295]);
    expect(mono.glyphTop).toBeGreaterThan(700);
  });

  it("each plate's frame 0 at the card's size, 1200 × 630", () => {
    for (const name of SHARE_BACKGROUNDS) expect(jpegSize(readFileSync(join(PACKAGE, SHARE_OG_DIR, "plates", `${name}.jpg`))), name).toEqual([1200, 630]);
  });
});

describe("the picture", () => {
  const EVERY_CARD: Readonly<Record<string, [ShareCardData, "usd" | "sol"]>> = {
    savedUsd: [card(60_000_000n), "usd"],
    savedSol: [card(11_420_734_512n, { streakDays: 45, basket: ["SPYx", "ANTHROPIC", "OPENAI", "SPACEX"] }), "sol"],
    long: [card(60_000_000n, { usdText: "$1,234,567.89", usdCompact: "$1.2M" }), "usd"],
    noPrice: [card(60_000_000n, {}, noPrice), "usd"],
    zero: [card(0n), "usd"],
    zeroPaused: [card(0n, { paused: true, mode: "volume", rate: "2%" }), "usd"],
  };

  it("draws every kind of card, on every background, at 1200 × 630, cached for a year", async () => {
    for (const [name, [shown, unit]] of Object.entries(EVERY_CARD)) {
      for (const background of SHARE_BACKGROUNDS) {
        const response = await shareCardImage({ card: shown, background, unit });
        expect(response.headers.get("cache-control"), name).toBe(SHARE_IMAGE_IMMUTABLE);
        expect(await pngSize(response), `${name} ${background}`).toEqual([1200, 630]);
      }
    }
  });

  it("is named by a version of what draws it, so a redrawn card gets a new address (scripts/check-share-render.mts, run before every build)", () => {
    // Every font and plate the preview reads is among what the version hashes.
    for (const font of SHARE_OG_FONTS) expect(DRAWN_FROM).toContain(`${SHARE_OG_DIR}/fonts/${font.file}`);
    for (const name of SHARE_BACKGROUNDS) expect(DRAWN_FROM).toContain(`${SHARE_OG_DIR}/plates/${name}.jpg`);
    // A failure here means the picture changed: set SHARE_RENDER_VERSION in src/lib/share-render-version.ts to the "Expected" value.
    expect(SHARE_RENDER_VERSION, "SHARE_RENDER_VERSION in src/lib/share-render-version.ts").toBe(drawnVersion());
  });

  it("the sample's figures are part of it: a re-seeded sample is a new address (review, 10-22)", async () => {
    const before = drawnVersion();
    const { mock } = await import("@/mocks");
    const saved = mock.stats.totalSavedUsd;
    try {
      (mock.stats as { totalSavedUsd: number | null }).totalSavedUsd = (saved ?? 0) + 1;
      expect(drawnVersion()).not.toBe(before);
    } finally {
      (mock.stats as { totalSavedUsd: number | null }).totalSavedUsd = saved;
    }
    expect(drawnVersion()).toBe(before);
  });
});

describe("/c/<token>/card.png", () => {
  const token = signShareToken(payloadOf(card(60_000_000n), "streaks", "usd"), KEY);
  const get = (path: string, of = token) => cardImage(new Request(`https://saverfi.cash${path}`), { params: Promise.resolve({ token: of }) });

  it("at its version: the card's picture, cached for a year, immutable", async () => {
    const response = await get(`/c/${token}/card.png?v=${SHARE_RENDER_VERSION}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, s-maxage=31536000, immutable");
    expect(await pngSize(response)).toEqual([1200, 630]);
  });

  it("at any other query: sent to that one, so nobody can make it draw again", async () => {
    for (const query of ["", "?v=old", `?v=${SHARE_RENDER_VERSION}&x=1`]) {
      const response = await get(`/c/${token}/card.png${query}`);
      expect([response.status, response.headers.get("location")], query).toEqual([308, `/c/${token}/card.png?v=${SHARE_RENDER_VERSION}`]);
    }
  });

  it("at its token with a character percent-encoded in the path: sent to the plain one (review, 10-22)", async () => {
    const encoded = `%${token.charCodeAt(0).toString(16)}${token.slice(1)}`;
    // The route is handed the token decoded, as Next hands it; the path it was asked at still says how it was written.
    const response = await get(`/c/${encoded}/card.png?v=${SHARE_RENDER_VERSION}`, token);
    expect([response.status, response.headers.get("location")]).toEqual([308, `/c/${token}/card.png?v=${SHARE_RENDER_VERSION}`]);
  });

  it("is drawn once per instance: a second ask of the same address is the same bytes, not a second render", async () => {
    const first = Buffer.from(await (await get(`/c/${token}/card.png?v=${SHARE_RENDER_VERSION}`)).arrayBuffer());
    const draw = vi.fn(async () => new Response("never"));
    const again = await drawnOnce(`/c/${token}/card.png?v=${SHARE_RENDER_VERSION}`, draw);
    expect(draw).not.toHaveBeenCalled();
    expect(Buffer.from(again).equals(first)).toBe(true);
  });

  it("a draw that failed is not kept: the next ask draws again", async () => {
    const failing = vi.fn(async () => new Response("no", { status: 500 }));
    await expect(drawnOnce("failing-card", failing)).rejects.toThrow(/did not draw/);
    const working = vi.fn(async () => new Response(new Uint8Array([1, 2, 3])));
    expect([...(await drawnOnce("failing-card", working))]).toEqual([1, 2, 3]);
    expect([failing.mock.calls.length, working.mock.calls.length]).toEqual([1, 1]);
  });

  it("a token changed by one character, signed by another key, or links off: 404, kept five minutes", async () => {
    const tampered = `${token.slice(0, 10)}${token[10] === "A" ? "B" : "A"}${token.slice(11)}`;
    const other = signShareToken(payloadOf(card(60_000_000n), "streaks", "usd"), Buffer.from("e".repeat(64)));
    for (const bad of [tampered, other, "example", "x"]) {
      const response = await get(`/c/${bad}/card.png?v=${SHARE_RENDER_VERSION}`, bad);
      expect([response.status, response.headers.get("cache-control")], bad.slice(0, 12)).toEqual([404, "public, max-age=300"]);
    }
    vi.stubEnv(SHARE_SECRET_ENV, "");
    expect((await get(`/c/${token}/card.png?v=${SHARE_RENDER_VERSION}`)).status).toBe(404);
  });
});

describe("/c/<token>", () => {
  const shown = card(11_420_734_512n, { usdText: "$2,073.42", usdCompact: "$2.1K", streakDays: 13 });
  const token = signShareToken(payloadOf(shown, "grid", "usd"), KEY);
  const params = (of: string) => ({ params: Promise.resolve({ token: of }) });

  it("tells a crawler the card: its picture as og:image and a large Twitter card, noindex, its links followed — nothing of anyone's", async () => {
    const metadata = await generateMetadata(params(token));
    const image = { url: `/c/${token}/card.png?v=${SHARE_RENDER_VERSION}`, width: 1200, height: 630, type: "image/png", alt: "A SaverFi pension: $2,073.42 saved" };
    expect(metadata).toMatchObject({
      title: "$2,073.42 saved for a pension — SaverFi",
      robots: { index: false, follow: true },
      openGraph: { images: [image], url: `/c/${token}`, siteName: "SaverFi" },
      twitter: { card: "summary_large_image", images: [image] },
    });
    expect(metadata.alternates).toBeUndefined();
    const text = JSON.stringify(metadata);
    for (const secret of [OWNER, VAULT, WALLET_A]) expect(text).not.toContain(secret);
  });

  it("shows the card, where and when it was read, and the way in", async () => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const html = renderToStaticMarkup(await SharedCard(params(token)));
    expect(html).toContain(`src="/c/${token}/card.png?v=${SHARE_RENDER_VERSION}"`);
    expect(html).toContain("Read from Solana by SaverFi on Sep 16, 2026.");
    expect(html).toContain(`href="/">${SHARE_COPY.page.start}<`);
    expect(html).toContain(SHARE_COPY.page.docs);
  });

  it("a token that does not verify is not found", async () => {
    const tampered = `${token.slice(0, -2)}${token.endsWith("AA") ? "BB" : "AA"}`;
    await expect(SharedCard(params(tampered))).rejects.toMatchObject({ digest: expect.stringContaining("404") });
    expect(await generateMetadata(params(tampered))).toEqual({ robots: { index: false, follow: true } });
  });
});

describe("/c/example: the sample's card, nobody's", () => {
  it("its page says Example, in its title and its picture's description, and links its picture", async () => {
    expect(exampleMetadata).toMatchObject({
      title: "Example pension — SaverFi",
      robots: { index: false, follow: true },
      twitter: { card: "summary_large_image", images: [{ url: `/c/example/card.png?v=${SHARE_RENDER_VERSION}` }] },
    });
    expect(String((exampleMetadata.twitter as { images: { alt: string }[] }).images[0]!.alt)).toMatch(/^Example SaverFi image, nobody’s pension/);
    const { renderToStaticMarkup } = await import("react-dom/server");
    expect(renderToStaticMarkup(ExamplePage())).toContain(SHARE_COPY.page.example.readOn);
  });

  it("has a picture for every background the dialog's links name, needing no secret", async () => {
    vi.stubEnv(SHARE_SECRET_ENV, "");
    expect(Object.values(EXAMPLE_SHARE_LINKS).map((links) => links.usd)).toEqual(["/c/example", "/c/example/streaks", "/c/example/vault"]);
    expect(await pngSize(await exampleCardImage())).toEqual([1200, 630]);
    expect(exampleBackgrounds()).toEqual([{ background: "streaks" }, { background: "vault" }]);
    for (const { background } of exampleBackgrounds()) {
      expect(await pngSize(await exampleOnImage(new Request("https://saverfi.cash"), { params: Promise.resolve({ background }) }))).toEqual([1200, 630]);
    }
  });
});
