/**
 * THE LINK PREVIEW'S VERSION (10-22): a hash of everything a card's picture is
 * drawn from on the server — the renderer, the layout, the words it prints,
 * its fonts and plates, and the sample's own card (review, 10-22: a re-seeded
 * sample drew new figures under the old address). The list, and why, is
 * scripts/check-share-render.mts, which every build runs first (prebuild) and
 * which prints the new value when any of it changes; share-og.test.ts asks the
 * same.
 *
 * WHY A VERSION. A card's image is served at /c/<token>/card.png?v=<this>,
 * cached for a year without asking again, and X, Telegram, Discord and the rest
 * keep a preview by its address. A redrawn card needs a new address, or the old
 * picture stays; an image asked for at any other ?v is sent to this one.
 */
export const SHARE_RENDER_VERSION = "39013d44b1b4";
