/**
 * THE SAMPLE'S SHARED CARD, /c/example (owner, 10-22): what Post on X links to
 * from the sample's dialog. The sample's own figures, marked "Example" like its
 * image (exampleShareCardOf), built at build time: no secret, no read, nobody's
 * pension — so nothing to sign. One page per background, in dollars (the
 * sample has no SOL total): EXAMPLE_SHARE_LINKS in lib/live-share.ts.
 */
import { EXAMPLE_SHARE_LINKS, exampleShareCardOf, type ShareBackground, type ShareCardData } from "@/lib/live-share";
import { mock } from "@/mocks";

/** The sample's card, as its dialog draws it (dashboard-shell.tsx MockBody). */
export const exampleCard = (): ShareCardData => exampleShareCardOf({ stats: mock.stats, rule: mock.rule, now: mock.now });

/** The sample's page for a background: its path, its card, its unit. */
export const exampleShared = (background: ShareBackground) => ({ page: EXAMPLE_SHARE_LINKS[background].usd!, card: exampleCard(), unit: "usd" as const, background });

/** The backgrounds with a page of their own under /c/example/: every one but Grid, which is /c/example itself. */
export const EXAMPLE_SUBPAGES: readonly ShareBackground[] = ["streaks", "vault"];
