// The live regions in a piece of rendered markup — every element that is
// `role="status"` or carries `aria-live` — each as its whole outer markup, so a
// test can ask what a screen reader would hear change inside it.
//
// A COUNTDOWN MUST NEVER BE IN ONE: a polite region reads out what changes in
// it, and "Try again in 12 s" changes every second (RetryButton.tsx).

const OPENS_A_REGION = /<([a-z][a-z0-9]*)\b[^>]*\b(?:role="status"|aria-live="[^"]*")[^>]*>/g;

/** Every live region's outer markup, outermost and nested alike, in document order. */
export function liveRegions(html: string): string[] {
  const out: string[] = [];
  for (const open of html.matchAll(OPENS_A_REGION)) {
    const tag = open[1]!;
    const tags = new RegExp(`<(/?)${tag}\\b[^>]*>`, "g");
    tags.lastIndex = open.index;
    let depth = 0;
    for (let next = tags.exec(html); next !== null; next = tags.exec(html)) {
      depth += next[1] === "/" ? -1 : 1;
      if (depth === 0) {
        out.push(html.slice(open.index, next.index + next[0].length));
        break;
      }
    }
  }
  return out;
}

/** Whether any live region holds a control or a ticking count. */
export function tickingInRegion(html: string): boolean {
  return liveRegions(html).some((region) => /<button\b|Try again in|Retrying/.test(region));
}
