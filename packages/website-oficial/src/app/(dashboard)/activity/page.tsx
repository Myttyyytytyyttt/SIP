/**
 * /activity — the same pension, with its history full width.
 *
 * A REAL ROUTE, not an anchor. The feed used to be `#activity`, a link into a
 * sidebar that only exists from `lg` up: on a phone the nav item went nowhere.
 * Now it is a page, it shares the frame's Privy session and live store with `/`,
 * and the mode rules apply to it unchanged — a connected pension key gets its
 * own history here too, and ?mode=mock cannot force the sample onto it.
 */

import { DashboardView } from "@/components/dashboard-shell";

export const dynamic = "force-dynamic";

export default function ActivityPage() {
  return <DashboardView view="activity" />;
}
