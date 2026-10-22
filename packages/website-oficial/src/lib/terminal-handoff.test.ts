// Taking a trading wallet to a terminal: every place an icon or the guide can send someone is a constant on an
// exact host, no key or secret ever rides a URL, the icons are this site's own files, and the steps never ask
// for a paste before the copy.

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { TERMINAL_COPY, TERMINAL_DESTINATIONS, destinationById, guideSteps, linkPress } from "@/lib/terminal-handoff";

const PUBLIC = fileURLToPath(new URL("../../public", import.meta.url));

describe("terminal destinations", () => {
  it("opens each terminal on https at exactly the host the guide names", () => {
    for (const destination of TERMINAL_DESTINATIONS) {
      const url = new URL(destination.startUrl);
      expect(url.protocol).toBe("https:");
      expect(url.origin).toBe(`https://${destination.host}`);
      expect(url.username + url.password + url.hash).toBe("");
    }
  });

  it("carries no secret in any start URL: only the chain choice GMGN needs", () => {
    for (const destination of TERMINAL_DESTINATIONS) {
      const keys = [...new URL(destination.startUrl).searchParams.keys()];
      expect(keys.every((key) => key === "chain")).toBe(true);
    }
  });

  it("shows icons this site serves itself, so img-src 'self' admits them", () => {
    for (const destination of TERMINAL_DESTINATIONS) {
      expect(destination.icon).toMatch(/^\/landing\/terminals\/[a-z]+\.png$/);
      expect(existsSync(`${PUBLIC}${destination.icon}`)).toBe(true);
    }
  });

  it("offers Axiom and GMGN, and leaves out the destinations the research ruled out", () => {
    expect(TERMINAL_DESTINATIONS.map((destination) => destination.id)).toEqual(["axiom", "gmgn"]);
    const hosts = TERMINAL_DESTINATIONS.map((destination) => destination.host);
    // Telegram bots keep the key in a cloud chat; Photon documents no import; BullX disabled trading.
    for (const ruledOut of ["t.me", "photon-sol.tinyastro.io", "neo.bullx.io"]) expect(hosts).not.toContain(ruledOut);
  });

  it("says where the key goes on the exact host, and that SaverFi's only key field is Import", () => {
    const axiom = destinationById("axiom");
    expect(TERMINAL_COPY.stepPaste(axiom.pasteInto, axiom.host)).toBe("Paste it only into Axiom's Import box on axiom.trade.");
    expect(TERMINAL_COPY.neverAsks).toContain("Import");
  });
});

describe("the guide's steps", () => {
  it("opens the terminal first and copies the key just before the paste, then waits for the trade", () => {
    const steps = guideSteps(destinationById("axiom"));
    expect(steps.map((step) => step.kind)).toEqual(["open", "do", "do", "copy", "paste", "trade"]);
    expect(steps[0]?.text).toBe("Open axiom.trade in a new tab.");
    expect(steps[4]?.text).toBe("Paste it only into Axiom's Import box on axiom.trade. Then confirm in Axiom.");
  });

  it("never tells anyone to paste before the copy: every destination's own steps stop short of the paste", () => {
    for (const destination of TERMINAL_DESTINATIONS) {
      const kinds = guideSteps(destination).map((step) => step.kind);
      expect(kinds.indexOf("copy")).toBe(kinds.indexOf("paste") - 1);
      for (const step of destination.steps) expect(step.toLowerCase()).not.toContain("paste");
    }
  });
});

describe("a press on a terminal's link", () => {
  const keys = (held: string) => ({ metaKey: held.includes("cmd"), ctrlKey: held.includes("ctrl"), shiftKey: held.includes("shift"), altKey: held.includes("alt") });

  it("leaves Cmd or Ctrl to the browser, with or without Shift: the new-tab press", () => {
    for (const held of ["cmd", "ctrl", "cmd shift", "ctrl shift"]) expect(linkPress(keys(held))).toBe("tab");
  });

  it("never leaves Alt (with anything) or Shift alone to the browser: some save a file or a Reading List entry instead", () => {
    for (const held of ["alt", "shift", "alt shift", "cmd alt", "ctrl alt"]) expect(linkPress(keys(held))).toBe("other");
  });

  it("reads no key held as the link's own press", () => {
    expect(linkPress(keys(""))).toBe("plain");
  });
});
