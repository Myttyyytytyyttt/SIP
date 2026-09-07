/**
 * The three class strings every panel shares, in one place so a change to
 * the label style or the accent is one edit rather than six.
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
