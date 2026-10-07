// The Manage wallets modal's section ids, and the one check that stands between a raw onClick and the opener:
// the sidebar and the landing hand the opener straight to onClick, so its first argument is often a click event,
// and only a known id may choose the tab.

import { describe, expect, it } from "vitest";

import { DEFAULT_WALLETS_SECTION, WALLETS_SECTIONS, isWalletsSection } from "@/lib/wallets-sections";

describe("isWalletsSection", () => {
  it.each(WALLETS_SECTIONS)("accepts %s", (id) => {
    expect(isWalletsSection(id)).toBe(true);
  });

  it("opens on the overview by default, and the overview is the rail's first tab", () => {
    expect(DEFAULT_WALLETS_SECTION).toBe("overview");
    expect(WALLETS_SECTIONS[0]).toBe(DEFAULT_WALLETS_SECTION);
  });

  it.each<[string, unknown]>([
    ["a click event", { type: "click", target: {}, currentTarget: {}, preventDefault: () => undefined }],
    ["undefined", undefined],
    ["null", null],
    ["an empty string", ""],
    ["an unknown id", "settings"],
    ["an id in another case", "Vault"],
    ["an array holding an id", ["vault"]],
  ])("rejects %s", (_name, value) => {
    expect(isWalletsSection(value)).toBe(false);
  });
});
