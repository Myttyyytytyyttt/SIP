// /c/<code> AND ITS PICTURE (owner, 10-23: "que sean como /c/xxxxxxx y ya"):
// a short link's page is its card's, told to a crawler at the short address —
// the same headline and picture as the long link, the picture at
// /c/<code>/card.png — read from the store once per instance. A code with no
// card is a 404; a store that cannot answer is a try-again, never a 404; and
// a long link is what it always was. The Blob SDK is in memory: nothing here
// reaches Vercel.

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET as cardImage } from "@/app/c/[token]/card.png/route";
import SharedCard, { generateMetadata } from "@/app/c/[token]/page";
import { toDashboardMock } from "@/lib/live-mock";
import { shareCardOf, unitsOf, type ShareCardData, type ShareLinks } from "@/lib/live-share";
import { SHARE_RENDER_VERSION } from "@/lib/share-render-version";
import { BLOB_TOKEN_ENV, forgetShareStore, shortLinksOf } from "@/lib/share-store";
import { SHARE_SECRET_ENV, signShareLinks } from "@/lib/share-token";

import { OWNER, VAULT, WALLET_A, liveDashboard } from "../../../test/fixtures/live-dashboard";
import { blobSdkMemory } from "../../../test/fixtures/share-store-memory";

const sdk = vi.hoisted(() => ({ current: null as ReturnType<typeof import("../../../test/fixtures/share-store-memory").blobSdkMemory> | null }));
vi.mock("@vercel/blob", async (importOriginal) => {
  const real = await importOriginal<typeof import("@vercel/blob")>();
  return {
    ...real,
    put: (...args: Parameters<ReturnType<typeof blobSdkMemory>["put"]>) => sdk.current!.put(...args),
    get: (...args: Parameters<ReturnType<typeof blobSdkMemory>["get"]>) => sdk.current!.get(...args),
  };
});

const SECRET = "d".repeat(64);
const KEY = Buffer.from(SECRET);
const BLOB_TOKEN = "vercel_blob_rw_TESTSTORE_THISISNOTAREALTOKEN";

const page = toDashboardMock(liveDashboard(), { complete: false });
const shown: ShareCardData = {
  ...shareCardOf({ lifetimeSaved: 11_420_734_512n, stats: page.stats, rule: page.rule, now: page.now }),
  usdText: "$2,073.42",
  usdCompact: "$2.1K",
  streakDays: 13,
};

const params = (of: string) => ({ params: Promise.resolve({ token: of }) });
const image = (path: string, of: string) => cardImage(new Request(`https://saverfi.cash${path}`), params(of));
const pictureOf = (of: string) => `/c/${of}/card.png?v=${SHARE_RENDER_VERSION}`;

/** The card's links, long and short, its record in the (memory) store — and this instance's memory of it forgotten, so a page reads it. */
async function kept(): Promise<{ long: ShareLinks; short: ShareLinks }> {
  const long = signShareLinks(shown, unitsOf(shown), KEY);
  const short = await shortLinksOf(long, KEY);
  forgetShareStore();
  return { long, short };
}

let warnings: string[] = [];
beforeEach(() => {
  vi.stubEnv(SHARE_SECRET_ENV, SECRET);
  vi.stubEnv(BLOB_TOKEN_ENV, BLOB_TOKEN);
  forgetShareStore();
  sdk.current = blobSdkMemory();
  warnings = [];
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => void warnings.push(args.map(String).join(" ")));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  forgetShareStore();
});

describe("/c/<code>", () => {
  it("tells a crawler its card — the long link's headline and picture — at the short address, read from the store once", async () => {
    const { long, short } = await kept();
    const code = short.grid.usd!.slice(3);
    const token = long.grid.usd!.slice(3);
    expect(code).toMatch(/^[0-9A-Za-z]{8}$/);
    const metadata = await generateMetadata(params(code));
    expect(metadata).toMatchObject({
      title: "SaverFi’s Vault: $2,073.42 saved",
      robots: { index: false, follow: true },
      openGraph: { url: `/c/${code}`, images: [{ url: pictureOf(code), width: 1200, height: 630 }] },
      twitter: { card: "summary_large_image", images: [{ url: pictureOf(code) }] },
    });
    // Everything else is the long link's, word for word.
    expect(JSON.stringify(metadata).replaceAll(code, "<link>")).toBe(JSON.stringify(await generateMetadata(params(token))).replaceAll(token, "<link>"));
    const html = renderToStaticMarkup(await SharedCard(params(code)));
    expect(html).toContain(`src="${pictureOf(code)}"`);
    expect(html).toContain("Read from Solana by SaverFi on Sep 16, 2026.");
    for (const secret of [OWNER, VAULT, WALLET_A, token, SECRET, BLOB_TOKEN]) expect(`${JSON.stringify(metadata)}${html}`).not.toContain(secret);
    expect(sdk.current!.calls.map((call) => call.op)).toEqual(["put", "get"]);
  });

  it("its picture: the card at /c/<code>/card.png, cached for a year; any other query sent there", async () => {
    const { short } = await kept();
    const code = short.vault.sol!.slice(3);
    const response = await image(pictureOf(code), code);
    expect([response.status, response.headers.get("content-type"), response.headers.get("cache-control")]).toEqual([200, "image/png", "public, max-age=31536000, s-maxage=31536000, immutable"]);
    const bytes = Buffer.from(await response.arrayBuffer());
    expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([1200, 630]);
    const moved = await image(`/c/${code}/card.png?v=old`, code);
    expect([moved.status, moved.headers.get("location")]).toEqual([308, pictureOf(code)]);
    expect(sdk.current!.calls.filter((call) => call.op === "get")).toHaveLength(1);
  });

  it("a code this server never made: 404, page and picture, and the store is not asked", async () => {
    await kept();
    for (const guess of ["AAAAAAAA", "zZ09yY18"]) {
      await expect(SharedCard(params(guess))).rejects.toMatchObject({ digest: expect.stringContaining("404") });
      expect(await generateMetadata(params(guess))).toEqual({ robots: { index: false, follow: true } });
      const response = await image(pictureOf(guess), guess);
      expect([response.status, response.headers.get("cache-control")]).toEqual([404, "public, max-age=300"]);
    }
    expect(sdk.current!.calls.filter((call) => call.op === "get")).toEqual([]);
  });

  it("a stored record whose token was changed: 404 — the MAC refuses it as it would the long link", async () => {
    const { short } = await kept();
    const code = short.streaks.usd!.slice(3);
    const [path, text] = [...sdk.current!.records][0]!;
    const record = JSON.parse(text) as { v: 1; t: (string | null)[] };
    sdk.current!.records.set(path, JSON.stringify({ v: 1, t: record.t.map((token) => (token === null ? null : `${token.slice(0, 20)}${token[20] === "x" ? "y" : "x"}${token.slice(21)}`)) }));
    await expect(SharedCard(params(code))).rejects.toMatchObject({ digest: expect.stringContaining("404") });
    expect((await image(pictureOf(code), code)).status).toBe(404);
  });

  it("a store that cannot answer: not a 404 — an error page, a 503 picture that nothing keeps — and the next ask reads again", async () => {
    const { short } = await kept();
    const code = short.grid.sol!.slice(3);
    const blob = await import("@vercel/blob");
    sdk.current!.failure = () => new blob.BlobStoreSuspendedError();
    const failed = await SharedCard(params(code)).then(
      () => null,
      (error: unknown) => error as { digest?: string; message?: string },
    );
    expect(failed).not.toBeNull();
    expect(String(failed?.digest ?? "")).not.toContain("404");
    expect(failed?.message).not.toContain(code);
    const response = await image(pictureOf(code), code);
    expect([response.status, response.headers.get("cache-control"), response.headers.get("retry-after")]).toEqual([503, "no-store", "60"]);
    sdk.current!.failure = null;
    expect((await image(pictureOf(code), code)).status).toBe(200);
    expect(warnings.join("\n")).toContain('"kind":"read_store_suspended"');
    for (const secret of [code, BLOB_TOKEN, SECRET]) expect(warnings.join("\n")).not.toContain(secret);
  });

  it("no store on this deployment: a code is a 404 — and a long link is what it always was", async () => {
    const { long, short } = await kept();
    vi.stubEnv(BLOB_TOKEN_ENV, "");
    const code = short.grid.usd!.slice(3);
    await expect(SharedCard(params(code))).rejects.toMatchObject({ digest: expect.stringContaining("404") });
    const token = long.grid.usd!.slice(3);
    expect(renderToStaticMarkup(await SharedCard(params(token)))).toContain(`src="${pictureOf(token)}"`);
    expect((await image(pictureOf(token), token)).status).toBe(200);
    expect(sdk.current!.calls.filter((call) => call.op === "get")).toEqual([]);
  });
});
