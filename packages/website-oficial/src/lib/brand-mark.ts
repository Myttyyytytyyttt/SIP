/**
 * THE S, AS NUMBERS: the mark's seven pieces and the grid its edges lie on,
 * vectorised in launch-video (src/components/Logo.tsx, MarkBuild's
 * H_LINES/V_LINES), on its own 1272×1488 box.
 *
 * ONE COPY FOR EVERY PLACE THAT DRAWS IT IN CODE (10-22): the landing's ground
 * (landing-backdrop.tsx) and the share card's canvas (live/share-canvas.ts).
 * Pure numbers, so the card never fetches the PNG and never waits on an image.
 */

export const MARK_W = 1272;
export const MARK_H = 1488;

/** The S's edges: every piece's corner lies on one of these lines. */
export const MARK_H_LINES = [0, 271, 497, 607, 880, 989, 1219, 1488] as const;
export const MARK_V_LINES = [0, 275, 998, 1272] as const;

/** The seven pieces, each a closed polygon, on the 1272×1488 grid. */
export const MARK_PIECES: readonly (readonly (readonly [number, number])[])[] = [
  [[275, 0], [998, 0], [998, 271], [275, 271]],
  [[998, 0], [1272, 271], [1272, 497], [998, 497]],
  [[0, 271], [275, 271], [275, 607], [0, 607]],
  [[0, 607], [998, 607], [1272, 880], [275, 880]],
  [[998, 880], [1272, 880], [1272, 1219], [998, 1219]],
  [[0, 989], [275, 989], [275, 1219], [0, 1219]],
  [[0, 1219], [998, 1219], [998, 1488], [275, 1488]],
];
