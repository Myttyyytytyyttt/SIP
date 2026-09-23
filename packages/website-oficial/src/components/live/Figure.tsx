/**
 * A LONG FIGURE THAT STILL READS AT A GLANCE, and loses nothing doing it.
 *
 * Lamports are nine decimals. "0.036634582" set at one weight is a wall of
 * digits with no figure in it, and a column of them is a ledger dump — which
 * is exactly how the live panel read beside the sample, whose every value is a
 * short even thing like "$54.95".
 *
 * THE SAMPLE'S ANSWER IS NOT AVAILABLE HERE. It is short because its numbers
 * are dollars invented by a fixture; ours are a chain's own units, and the
 * digits after the fourth are real money somebody can check on Solscan.
 *
 * So the tail steps down in SIZE ONLY. Not in colour: muting real digits reads
 * as a rounding, and nothing here is rounded — `head + tail` is always exactly
 * the text handed in. The eye lands on the head, the whole figure stays on the
 * page, and no tooltip has to be opened to see what was actually saved.
 *
 * One treatment, kept in one place so the shares column and the feed's amount
 * column cannot drift apart one file at a time.
 *
 * WHERE IT BELONGS, AND WHERE IT IS A LIE ABOUT ITSELF. A tail is a SIZE, so
 * it needs a size to step down FROM. At the 12px of a sub-line the step is a
 * fraction of a pixel and the figure reads exactly as it did — markup
 * pretending to have done something. So this is for a figure that is the
 * subject of its own line (a tile value, a shares cell, the amount column, the
 * hero), never for one inside a 12px sub-line: there, either the figure is
 * short enough already or the line has the wrong thing on it.
 */

import { splitDecimal } from "@/lib/amounts";

export function Figure({
  children,
  keep = 4,
  className,
  tailClassName = "text-[0.85em]",
}: {
  /** An ALREADY FORMATTED figure. Nothing here parses or rounds. */
  readonly children: string;
  /** Decimals kept at full size, measured from the decimal point. */
  readonly keep?: number;
  readonly className?: string;
  /** How the tail steps down. Relative by default, so it follows whatever size it is set in. */
  readonly tailClassName?: string;
}) {
  const [head, rest] = splitDecimal(children, keep);
  // One span, not two, when there is no tail: an empty element still opens a
  // font-size context and a unit word after it would inherit the smaller face.
  if (rest === "") return <span className={className}>{head}</span>;
  /*
   * ONLY DIGITS STEP DOWN. These figures are handed in with their unit
   * attached — "0.036634582 SOL" — and a cut measured from the decimal point
   * lands mid-number, so everything after it, the word included, would have
   * shrunk. "0.0366·34582 SOL" with a 10px SOL is not a smaller unit, it is a
   * typo. The run of digits after the cut is the tail; whatever follows it
   * comes back to full size.
   */
  const digits = /^\d*/.exec(rest)?.[0] ?? "";
  const after = rest.slice(digits.length);
  return (
    <span className={className}>
      {head}
      {digits === "" ? null : <span className={tailClassName}>{digits}</span>}
      {after}
    </span>
  );
}
