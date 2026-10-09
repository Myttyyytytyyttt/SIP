/**
 * The class strings every panel shares, in one place so a change to the label
 * style, the accent or a tone is one edit rather than six.
 */

/** Section and field labels: small, quiet, spaced caps. */
export const LABEL = "text-xs font-medium uppercase tracking-wide text-muted-foreground";

/**
 * THE ONE ACCENT ON THE PAGE, and it means exactly one thing: money put aside.
 * emerald-700 in light, not 600 — 600 on white is 3.4:1, under AA for the
 * 14px amounts it colours; 700 clears 4.5:1. 400 on the dark ground is ~10:1.
 */
export const SAVED = "text-emerald-700 dark:text-emerald-400";

/** Every number on the page: monospace and tabular. */
export const MONO = "font-mono tabular-nums";

/**
 * WHAT KIND OF THING HAPPENED, AT A GLANCE (owner, 09-23):
 *
 *   saved    green   money coming in — a slice the rule put aside (from gains
 *                    or from volume), and SOL that simply arrived;
 *   invest   blue    the pension buying what it holds;
 *   setting  mustard a change to how the pension behaves, and only that — a
 *                    new rule, a signed policy, a wallet linked or unlinked,
 *                    the vault itself created;
 *   quiet    grey    the system doing its job — a conversion, a wrap, the
 *                    keeper's upkeep, a settlement that found nothing to take,
 *                    a withdrawal whose minus sign already says it. Correct
 *                    and expected, so it steps back and lets the rest be seen;
 *   failed   red     kept rare on purpose: a transaction that did not land, or
 *                    one nobody could read. Red that shows up every day stops
 *                    meaning anything.
 *
 * The tint is on the icon's square and on the amount, never on the words: the
 * row still reads the same in any colour, and nothing is said only by hue.
 *
 * WHY THEY LIVE HERE (10-09): the feed's row (activity-row.tsx) kept these
 * privately; the live page's marks — a step in progress, a new row's wash —
 * speak the same five tones, and two copies of one palette drift. The strings
 * are the feed's own, unchanged, so the sample's markup is too. A failed READ is
 * quiet, never red: red is for a transaction that did not land.
 */
export type Tone = "saved" | "invest" | "setting" | "quiet" | "failed";

/** The icon's square: a faint ground in the tone, and the glyph in it. */
export const TONE_TILE: Readonly<Record<Tone, string>> = {
  saved: "bg-emerald-500/12 text-emerald-600 dark:text-emerald-400",
  invest: "bg-blue-500/12 text-blue-600 dark:text-blue-400",
  setting: "bg-amber-500/12 text-amber-700 dark:text-amber-400",
  quiet: "bg-muted text-muted-foreground",
  failed: "bg-destructive/10 text-destructive",
};

/** The amount beside it. */
export const TONE_TEXT: Readonly<Record<Tone, string>> = {
  saved: SAVED,
  invest: "text-blue-600 dark:text-blue-400",
  setting: "text-amber-700 dark:text-amber-400",
  // Muted, not the page's ink: in the dark theme plain white would be the
  // loudest figure in the column, on the rows that matter least.
  quiet: "text-muted-foreground",
  failed: "text-destructive",
};
