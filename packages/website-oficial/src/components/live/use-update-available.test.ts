// A newer version, once said, is held until the reload (use-update-available.ts):
// the live body is mounted again on every walk between / and /activity, and the
// version hook's own state starts false with it — the dot's ring must not go
// out on one view for minutes after it lit on the other. And it is asked only
// by the live body: the sample never mounts it.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { heldUpdate } from "@/components/live/use-update-available";

describe("a newer version", () => {
  it("is held once said, and a remount's fresh false does not put it out", () => {
    const seen = { update: false };
    expect(heldUpdate(seen, false)).toBe(false);
    expect(heldUpdate(seen, true)).toBe(true);
    // Mounted again on /activity: the version hook starts over at false.
    expect(heldUpdate(seen, false)).toBe(true);
  });

  it("is asked for only where it is drawn — by the live body — never by the sample's pieces", () => {
    const source = (path: string): string => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
    expect(source("./LiveBody.tsx")).toMatch(/const updateAvailable = useUpdateAvailable\(\);/);
    for (const path of ["../dashboard-shell.tsx", "../dashboard-main.tsx", "../site-header.tsx"]) {
      expect(source(path)).not.toMatch(/useNewVersion|useUpdateAvailable/);
    }
  });
});
