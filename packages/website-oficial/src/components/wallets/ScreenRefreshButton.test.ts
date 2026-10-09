// THE WALLETS SCREEN'S REFRESH SHOWS A READ IS OUT (10-09, plan B4): busy —
// resting, aria-busy, its arrows turning for motion-safe — while the screen's
// read is out over what is drawn (useVaultScreen().refreshing), whoever asked
// for it; and exactly the button each card drew before while none is.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ScreenRefreshButton } from "@/components/wallets/ScreenRefreshButton";
import { VaultScreenContext, type VaultScreenValue } from "@/hooks/use-vault-state";
import type { VaultApi } from "@/lib/vault-api";

const screen = (refreshing?: boolean): VaultScreenValue => ({
  pensionKey: "owner",
  view: { kind: "loading" },
  refresh: vi.fn(),
  api: {} as VaultApi,
  ...(refreshing === undefined ? {} : { refreshing }),
});

const render = (value: VaultScreenValue | null, props: Partial<Parameters<typeof ScreenRefreshButton>[0]> = {}): string =>
  renderToStaticMarkup(createElement(VaultScreenContext.Provider, { value }, createElement(ScreenRefreshButton, { children: "Refresh", ...props })));

describe("the screen's Refresh", () => {
  it("is busy while a read is out: resting, said to be busy, its arrows turning only for motion-safe", () => {
    const html = render(screen(true));
    expect(html).toContain('disabled=""');
    expect(html).toContain('aria-busy="true"');
    expect(html).toMatch(/<svg[^>]*class="[^"]*motion-safe:animate-spin[^"]*"/);
    expect(html).not.toMatch(/class="[^"]*(?<!motion-safe:)animate-spin/);
  });

  it("is the plain button while none is — and on a screen that names no `refreshing`", () => {
    for (const value of [screen(false), screen(), null]) {
      const html = render(value);
      expect(html).not.toContain('disabled=""');
      expect(html).not.toContain("aria-busy");
      expect(html).not.toContain("animate-spin");
      expect(html).toContain(">Refresh</button>");
    }
  });

  it("keeps the card's own reason to rest beside the read's", () => {
    expect(render(screen(false), { disabled: true })).toContain('disabled=""');
    expect(render(screen(false), { disabled: true })).not.toContain("aria-busy");
  });
});
