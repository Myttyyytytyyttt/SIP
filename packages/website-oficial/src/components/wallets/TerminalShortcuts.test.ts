// The terminals' icons beside Export key, what a press on one does (pressShortcut, the rule the component calls),
// and the guide inside the row, rendered as the server draws them (node, no DOM). The icons are plain links to
// fixed hosts, so they work before any script runs. The row's guide (where no floating window exists, or it was
// refused, or the press asked for a tab) is drawn at its first step, the step after the open, the copy, the
// paste and the end; the no-key-field check draws every step.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import { FloatingTerminalGuide } from "@/components/wallets/FloatingTerminalGuide";
import { TerminalShortcuts, pressShortcut, type Guide } from "@/components/wallets/TerminalShortcuts";
import { TERMINAL_COPY, destinationById, guideSteps, type LinkPress } from "@/lib/terminal-handoff";

const ADDRESS = "EFXK995PV49Qz8xPSYMEUDBU5AKRR466JkgsfuGak5iU";
const copy = { run: vi.fn(async () => {}), busy: false, failure: null };
const escaped = (text: string) => text.replaceAll("'", "&#x27;");

function shortcuts() {
  return renderToStaticMarkup(
    createElement(TooltipProvider, null, createElement(TerminalShortcuts, { address: ADDRESS, walletLabel: "Trading wallet 2", saving: true, wsUrl: "wss://example.invalid", copy })),
  );
}

function inlineGuide(startAt: number, saving = true) {
  return renderToStaticMarkup(
    createElement(FloatingTerminalGuide, {
      target: null,
      destination: destinationById("axiom"),
      walletLabel: "Trading wallet 2",
      address: ADDRESS,
      saving,
      wsUrl: "wss://example.invalid",
      copy,
      startAt,
      onClose: () => {},
    }),
  );
}

const stepOf = (kind: string) => guideSteps(destinationById("axiom")).findIndex((step) => step.kind === kind);

describe("TerminalShortcuts", () => {
  it("draws one icon per terminal: a plain link on its fixed host, new tab, no opener, no referrer", () => {
    const html = shortcuts();
    for (const [id, url, name] of [
      ["axiom", "https://axiom.trade/portfolio", "Axiom"],
      ["gmgn", "https://gmgn.ai/?chain=sol", "GMGN"],
    ] as const) {
      const link = html.match(new RegExp(`<a [^>]*data-terminal-shortcut="${id}"[^>]*>`))?.[0] ?? "";
      expect(link).toContain(`href="${url}"`);
      expect(link).toContain('target="_blank"');
      expect(link).toContain('rel="noopener noreferrer"');
      expect(link).toContain(`aria-label="${escaped(TERMINAL_COPY.shortcut(name))}"`);
      expect(html).toContain(`src="/landing/terminals/${id}.png"`);
    }
  });

  it("opens no guide before a press", () => {
    expect(shortcuts()).not.toContain("data-terminal-guide");
  });
});

describe("a press on an icon", () => {
  function press(options: { supported: boolean; kind?: LinkPress; showing?: "axiom" | "gmgn" | null; showingInRow?: "axiom" | "gmgn" | null }) {
    const preventDefault = vi.fn();
    const openTab = vi.fn();
    const focus = vi.fn();
    const shown: Guide[] = [];
    let settle: (opened: boolean) => void = () => {};
    const open = vi.fn(() => new Promise<boolean>((resolve) => (settle = resolve)));
    pressShortcut(
      "axiom",
      { kind: options.kind ?? "plain", preventDefault, openTab },
      { supported: options.supported, showing: options.showing ?? null, showingInRow: options.showingInRow ?? null, open, focus },
      (guide) => shown.push(guide),
    );
    // Read before anything awaits: what the press itself did.
    const during = {
      preventDefault: preventDefault.mock.calls.length,
      openTab: openTab.mock.calls.length,
      open: open.mock.calls.length,
      focus: focus.mock.calls.length,
      shown: [...shown],
    };
    return { during, shown, settle: async (opened: boolean) => (settle(opened), await Promise.resolve(), await Promise.resolve()) };
  }

  it("asks for the floating window inside the press, and keeps the link from opening the terminal", () => {
    for (const kind of ["plain", "other"] as const) {
      const { during } = press({ supported: true, kind });
      expect(during.open).toBe(1);
      expect(during.preventDefault).toBe(1);
      expect(during.openTab).toBe(0);
      // The guide floats from its first step: the terminal's link, the second press.
      expect(during.shown).toEqual([{ id: "axiom", mode: "floating", startAt: 0 }]);
    }
  });

  it("moves the guide into the row, from its first step, when the browser refuses the window", async () => {
    const result = press({ supported: true });
    await result.settle(false);
    expect(result.shown.at(-1)).toEqual({ id: "axiom", mode: "inline", startAt: 0 });
  });

  it("lets the link open the terminal where no floating window exists, and starts the row's guide after that step", () => {
    const { during } = press({ supported: false });
    expect(during.open).toBe(0);
    expect(during.preventDefault).toBe(0);
    expect(during.openTab).toBe(0);
    expect(during.shown).toEqual([{ id: "axiom", mode: "inline", startAt: 1 }]);
  });

  it("leaves a press for a tab (Cmd, Ctrl, the middle button) to the browser", () => {
    for (const supported of [true, false]) {
      const { during } = press({ supported, kind: "tab" });
      expect(during.open).toBe(0);
      expect(during.preventDefault).toBe(0);
      expect(during.openTab).toBe(0);
      expect(during.shown).toEqual([{ id: "axiom", mode: "inline", startAt: 1 }]);
    }
  });

  it("never leaves Alt or Shift alone to the browser where no floating window exists: the page opens the terminal", () => {
    const { during } = press({ supported: false, kind: "other" });
    expect(during.preventDefault).toBe(1);
    expect(during.openTab).toBe(1);
    expect(during.shown).toEqual([{ id: "axiom", mode: "inline", startAt: 1 }]);
  });

  it("keeps a guide already floating for that terminal: focuses it, never reopens it", () => {
    for (const kind of ["plain", "other"] as const) {
      const { during } = press({ supported: true, kind, showing: "axiom" });
      expect(during.open).toBe(0);
      expect(during.preventDefault).toBe(1);
      expect(during.focus).toBe(1);
      expect(during.shown).toEqual([]);
    }
  });

  it("gives a press for a tab its tab, and keeps the floating guide as it is", () => {
    const { during } = press({ supported: true, kind: "tab", showing: "axiom" });
    expect(during.preventDefault).toBe(0);
    expect(during.open).toBe(0);
    expect(during.focus).toBe(0);
    expect(during.shown).toEqual([]);
  });

  it("keeps the row's guide of that terminal, steps and all, and lets the press open the terminal", () => {
    for (const supported of [true, false]) {
      for (const kind of ["plain", "tab"] as const) {
        const { during } = press({ supported, kind, showingInRow: "axiom" });
        expect(during.preventDefault).toBe(0);
        expect(during.open).toBe(0);
        expect(during.shown).toEqual([]);
      }
      const other = press({ supported, kind: "other", showingInRow: "axiom" }).during;
      expect(other.preventDefault).toBe(1);
      expect(other.openTab).toBe(1);
      expect(other.open).toBe(0);
      expect(other.shown).toEqual([]);
    }
  });

  it("replaces the row's guide of another terminal", () => {
    const { during } = press({ supported: true, showingInRow: "gmgn" });
    expect(during.open).toBe(1);
    expect(during.shown).toEqual([{ id: "axiom", mode: "floating", startAt: 0 }]);
  });

  it("replaces another terminal's floating guide", () => {
    const { during } = press({ supported: true, showing: "gmgn" });
    expect(during.open).toBe(1);
    expect(during.shown).toEqual([{ id: "axiom", mode: "floating", startAt: 0 }]);
  });
});

describe("the guide inside the row", () => {
  it("starts with the terminal's link, under the title alone", () => {
    const html = inlineGuide(0);
    expect(html).toContain('href="https://axiom.trade/portfolio" target="_blank" rel="noopener noreferrer"');
    expect(html).toContain("Use Trading wallet 2 in Axiom");
    expect(html).not.toContain("data-terminal-link-again");
  });

  it("keeps the terminal's link at its foot once the open step is behind", () => {
    const end = guideSteps(destinationById("axiom")).length;
    for (const step of [1, stepOf("paste"), end]) {
      const link = inlineGuide(step).match(/<a [^>]*data-terminal-link-again[^>]*>/)?.[0] ?? "";
      expect(link).toContain('href="https://axiom.trade/portfolio"');
      expect(link).toContain('target="_blank"');
      expect(link).toContain('rel="noopener noreferrer"');
    }
  });

  it("copies with the plain Copy key label here, where Privy's window opens in this same tab", () => {
    const html = inlineGuide(stepOf("copy"));
    expect(html).toContain(`>${TERMINAL_COPY.copy}</button>`);
    expect(html).not.toContain(TERMINAL_COPY.guideCopyHere);
    expect(html).toContain(TERMINAL_COPY.clipboard);
  });

  it("offers Clear clipboard at the paste, and names SaverFi's only key field", () => {
    const html = inlineGuide(stepOf("paste"));
    expect(html).toContain(TERMINAL_COPY.clear);
    expect(html).toContain(escaped(TERMINAL_COPY.neverAsks));
  });

  it("promises saving at the end only on a row that saves", () => {
    const end = guideSteps(destinationById("axiom")).length;
    expect(inlineGuide(end, true)).toContain(TERMINAL_COPY.guideFinished);
    const notSaving = inlineGuide(end, false);
    expect(notSaving).toContain(escaped(TERMINAL_COPY.guideFinishedNotSaving));
    expect(notSaving).not.toContain(TERMINAL_COPY.guideFinished);
  });

  it("never renders a key field, at any step: the copy is Privy's", () => {
    const end = guideSteps(destinationById("axiom")).length;
    for (let step = 0; step <= end; step++) expect(inlineGuide(step)).not.toMatch(/<input|<textarea/i);
  });
});
