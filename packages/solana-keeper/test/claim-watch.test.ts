// claim-flap (src/claim-watch.ts): the claim's takeovers, losses and regains by
// THIS process, and a page only on a regain (ADR §4.10 amendment 3, RT-18). Driven
// through the real KeeperClaim, the way bin/keeper.mts wires it: onTakeover tells
// the watch, the lost-session callback tells it why.

import { describe, expect, it } from "vitest";
import { CLAIM_FLAP_ALERT_KEY, ClaimWatch } from "../src/claim-watch.js";
import { KeeperClaim } from "../src/singleton.js";

const T0 = 1_700_000_000_000;

describe("ClaimWatch", () => {
  it("says nothing about a container's first takeover: that is a deploy", () => {
    const watch = new ClaimWatch();
    expect(watch.takeover(T0)).toBeNull();
    expect(watch.status()).toEqual({
      takeovers: 1,
      regains: 0,
      losses: 0,
      heldSince: new Date(T0).toISOString(),
      lastTakeoverAt: new Date(T0).toISOString(),
      lastLossAt: null,
      lastLoss: null,
    });
  });

  it("pages critical on a regain, naming the loss before it", () => {
    const watch = new ClaimWatch();
    watch.takeover(T0);
    watch.lost(T0 + 60_000, "session-dropped");
    expect(watch.status().heldSince).toBeNull();
    const page = watch.takeover(T0 + 120_000)!;
    expect(page).toMatchObject({ key: CLAIM_FLAP_ALERT_KEY, severity: "critical", context: { takeovers: 2, regains: 1, losses: 1 } });
    expect(page.detail).toContain("after its database session dropped (60 s earlier)");
    expect(watch.status()).toMatchObject({ takeovers: 2, regains: 1, losses: 1, lastLoss: "session-dropped" });
  });

  it("counts a release over a settle-key mismatch as a loss too", () => {
    const watch = new ClaimWatch();
    watch.takeover(T0);
    watch.lost(T0 + 1_000, "settle-key-mismatch");
    expect(watch.takeover(T0 + 2_000)!.detail).toContain("after the settle key stopped matching the chain");
  });
});

describe("claim-flap through KeeperClaim, as bin/keeper.mts wires it", () => {
  it("pages once for a regain, never for the first take, and not for a claim another instance holds", async () => {
    const watch = new ClaimWatch();
    const pages: string[] = [];
    let free = false;
    let release: (() => void) | undefined;
    const claim: KeeperClaim = new KeeperClaim({
      armed: true,
      attempt: async () => {
        if (!free) return { held: false };
        release = () => {
          free = true;
        };
        free = false;
        return { held: true, release: () => release?.() };
      },
      onTakeover: () => {
        const regained = watch.takeover(Date.now());
        if (regained !== null) pages.push(regained.key);
      },
    });
    // Another instance holds it: sweeps retry, nothing is taken, nothing pages.
    await claim.ensure();
    await claim.ensure();
    expect(watch.status().takeovers).toBe(0);
    // The deploy's handover: the first take.
    free = true;
    await claim.ensure();
    expect(pages).toEqual([]);
    // The session drops (keeper.mts's onLost: release, then tell the watch), and the next sweep takes it back.
    claim.release();
    watch.lost(Date.now(), "session-dropped");
    await claim.ensure();
    expect(pages).toEqual([CLAIM_FLAP_ALERT_KEY]);
    expect(watch.status()).toMatchObject({ takeovers: 2, regains: 1, losses: 1 });
  });
});
