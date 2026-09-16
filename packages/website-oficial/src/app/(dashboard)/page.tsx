/**
 * THE ONE SCREEN: the pension.
 *
 * Three regions, taken from the reference layout and nothing else from it: a
 * sidebar on the left (there: chat; here: what this pension did), a strip across
 * the top of the main column (there: past multipliers; here: what each
 * settlement put aside), and the main panel (there: the game; here: the pension).
 *
 * Everything that decides WHOSE numbers these are lives in the frame
 * (src/components/dashboard-shell.tsx) and in src/lib/dashboard-mode.ts. This
 * file only says which of the two views it is.
 */

import { DashboardView } from "@/components/dashboard-shell";

export const dynamic = "force-dynamic";

export default function PensionPage() {
  return <DashboardView view="pension" />;
}
