// How live a page is (use-live-dashboard.ts LiveLiveness), for tests that draw
// the live body or its header dot. By default: no push wanted, nothing out,
// nothing heard, the last update landing at `lastReadAt` (this browser's
// clock when the fixture is made, unless given), nothing armed, nothing
// backing off — a quiet page that was updated just now.

import type { LiveLiveness } from "@/hooks/use-live-dashboard";

export function liveLiveness(overrides: Partial<LiveLiveness> = {}): LiveLiveness {
  return {
    socket: "none",
    reading: false,
    heard: null,
    lastReadAt: Date.now(),
    refreshReadyAt: 0,
    nextReadAt: null,
    backingOff: false,
    readId: 1,
    ...overrides,
  };
}
