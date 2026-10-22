/**
 * THE LINK PREVIEW'S VERSION (10-22): a hash of everything that draws a card on
 * the server — components/share-og.tsx, lib/live-share.ts (the layout and the
 * card's rules), lib/brand-mark.ts, the words the card prints (SHARE_COPY.card,
 * and the example's card and mark; not the dialog's own lines), and every font
 * and plate in assets/share-og — pinned by
 * share-og.test.ts, which fails with the new value when any of them changes.
 *
 * WHY A VERSION. A card's image is served at /c/<token>/card.png?v=<this>,
 * cached for a year without asking again, and X, Telegram, Discord and the rest
 * keep a preview by its address. A redrawn card needs a new address, or the old
 * picture stays; an image asked for at any other ?v is sent to this one.
 */
export const SHARE_RENDER_VERSION = "8b0540190fae";
