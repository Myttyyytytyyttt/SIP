/**
 * THE LINK PREVIEW'S VERSION, CHECKED BEFORE A BUILD SHIPS IT (review, 10-22).
 *
 * Run: pnpm run check:render   (prebuild runs it, like check:clips and check:plates, so a deploy enforces it)
 *
 * WHY. A shared card's picture is served at /c/…/card.png?v=SHARE_RENDER_VERSION
 * (src/lib/share-render-version.ts), cached for a year without asking again —
 * by browsers, by the CDN and by X's own card cache. A picture that changes
 * under the same ?v is never fetched again by anyone who has it: the preview
 * under a post stays the old one, and stops matching the dialog's. The version
 * was pinned by a vitest test alone, which a deploy does not run, and it
 * hashed the renderer but not the sample's figures: re-seeding the sample drew
 * new numbers on /c/example/card.png under the old ?v (measured: the review
 * changed MOCK_NOW, the bytes changed, the test passed).
 *
 * WHAT THE VERSION IS A HASH OF — everything a card's picture is drawn from:
 *   * the files that draw it: components/share-og.tsx, lib/live-share.ts (the
 *     layout and the card's rules), lib/brand-mark.ts, lib/share-token.ts (a
 *     token's card: its day becomes the date), lib/format.ts (that date, and
 *     the sample's figures), lib/share-example.ts (which figures the sample's
 *     card takes), every font and plate in assets/share-og;
 *   * the words the card prints (SHARE_COPY.card; the link's own title and
 *     rule words, SHARE_COPY.page.card — "SaverFi’s Vault", owner 10-23; the
 *     example's card and its mark — not the dialog's own lines), a sentence
 *     with a slot hashed with "§" in it;
 *   * the sample's card itself, as /c/example draws it: so a re-seeded sample
 *     is a new version, wherever in src/mocks its figures live.
 * share-og.test.ts asks the same through drawnVersion().
 *
 * TO FIX A FAILURE: set SHARE_RENDER_VERSION to the value this prints. Every
 * card's picture then has a new address, and X fetches it again.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { SHARE_COPY } from "../src/lib/live-copy.ts";
import { SHARE_BACKGROUNDS } from "../src/lib/live-share.ts";
import { exampleCard } from "../src/lib/share-example.ts";
import { SHARE_RENDER_VERSION } from "../src/lib/share-render-version.ts";

const PACKAGE = fileURLToPath(new URL("../", import.meta.url));
/** assets/share-og: SHARE_OG_DIR and SHARE_OG_FONTS in components/share-og.tsx, which is server-only and is not imported here. */
const OG_DIR = "assets/share-og";
const OG_FONTS = ["Geist-Regular.ttf", "Geist-Medium.ttf", "Geist-SemiBold.ttf", "GeistMono-Regular.ttf", "GeistMono-Medium.ttf", "GeistMono-SemiBold.ttf"];

/** Every file a card's picture is drawn from, from the package's root. */
export const DRAWN_FROM: readonly string[] = [
  "src/components/share-og.tsx",
  "src/lib/live-share.ts",
  "src/lib/brand-mark.ts",
  "src/lib/share-token.ts",
  "src/lib/format.ts",
  "src/lib/share-example.ts",
  ...OG_FONTS.map((file) => `${OG_DIR}/fonts/${file}`),
  ...SHARE_BACKGROUNDS.map((name) => `${OG_DIR}/plates/${name}.jpg`),
];

/** The version the pictures drawn today should carry: 12 hex of a sha256 over everything above. */
export function drawnVersion(): string {
  const hash = createHash("sha256");
  for (const file of DRAWN_FROM) {
    hash.update(`${file}\0`);
    hash.update(readFileSync(join(PACKAGE, file)));
    hash.update("\0");
  }
  const printed = { card: SHARE_COPY.card, link: SHARE_COPY.page.card, example: { card: SHARE_COPY.example.card, mark: SHARE_COPY.example.mark } };
  hash.update(JSON.stringify(printed, (_key, value: unknown) => (typeof value === "function" ? (value as (slot: string) => string)("§") : value)));
  hash.update("\0");
  hash.update(JSON.stringify(exampleCard()));
  return hash.digest("hex").slice(0, 12);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log("[web] the link preview's version");
  const drawn = drawnVersion();
  if (drawn === SHARE_RENDER_VERSION) {
    console.log(`  ok    SHARE_RENDER_VERSION ${drawn}: the renderer, its words, its fonts and plates, and the sample's card`);
    console.log("[web] render version check passed\n");
  } else {
    console.log(`  FAIL  SHARE_RENDER_VERSION is ${SHARE_RENDER_VERSION}, but what draws a card hashes to ${drawn}:`);
    console.log(`        set it to "${drawn}" in src/lib/share-render-version.ts, so every card's picture gets a new address`);
    console.log("[web] render version check: FAILED\n");
    process.exit(1);
  }
}
