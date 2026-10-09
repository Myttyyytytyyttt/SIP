// THE WALLETS SCREEN'S REFRESH SHOWS A READ IS OUT (10-09, plan B4): busy —
// resting, aria-busy, its arrows turning for motion-safe — while the screen's
// read is out over what is drawn (useVaultScreen().refreshing), whoever asked
// for it; and exactly the button each card drew before while none is. Resting
// with aria-disabled, never `disabled` (review, 10-09): a poll under a focused
// button must not drop the focus on the page's body.

import { createElement, type ReactElement } from "react";
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

/** The button as drawn inside `value`, its own element kept so a test can press it. */
function drawn(value: VaultScreenValue): ReactElement<{ readonly onClick: () => void }> {
  let element: ReactElement<{ readonly onClick: () => void }> | null = null;
  function Probe() {
    element = ScreenRefreshButton({ children: "Refresh" }) as ReactElement<{ readonly onClick: () => void }>;
    return element;
  }
  renderToStaticMarkup(createElement(VaultScreenContext.Provider, { value }, createElement(Probe)));
  if (element === null) throw new Error("not drawn");
  return element;
}

describe("the screen's Refresh", () => {
  it("is busy while a read is out: resting but focusable, said to be busy, its arrows turning only for motion-safe", () => {
    const html = render(screen(true));
    // Held with aria-disabled: `disabled` under the focus would drop it on the body at every poll.
    expect(html).toContain('aria-disabled="true"');
    expect(html).not.toContain('disabled=""');
    expect(html).toContain("aria-disabled:pointer-events-none");
    expect(html).toContain('aria-busy="true"');
    expect(html).toMatch(/<svg[^>]*class="[^"]*motion-safe:animate-spin[^"]*"/);
    expect(html).not.toMatch(/class="[^"]*(?<!motion-safe:)animate-spin/);
  });

  it("does nothing when pressed while busy, and asks for the read when not", () => {
    const busy = screen(true);
    drawn(busy).props.onClick();
    expect(busy.refresh).not.toHaveBeenCalled();
    const idle = screen(false);
    drawn(idle).props.onClick();
    expect(idle.refresh).toHaveBeenCalledTimes(1);
  });

  it("is the plain button while none is — and on a screen that names no `refreshing`", () => {
    for (const value of [screen(false), screen(), null]) {
      const html = render(value);
      expect(html).not.toContain('disabled=""');
      expect(html).not.toContain("aria-disabled");
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
