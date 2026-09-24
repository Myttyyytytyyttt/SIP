// What the browser remembers of the setup: per key, never the address, and
// still working when storage is blocked.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ONBOARDING_DONE_KEY,
  clearOnboardingMirror,
  forgetOnboarding,
  keyTag,
  readBasketChoice,
  readOnboardingClosed,
  readOnboardingStep,
  saveBasketChoice,
  saveOnboardingStep,
  setOnboardingClosed,
  subscribeOnboarding,
} from "@/lib/onboarding-memory";

const A = "PensionKeyP1aceho1der111111111111111111111";
const B = "OtherKeyP1aceho1der1111111111111111111111";

class FakeStorage {
  readonly items = new Map<string, string>();
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
  removeItem(key: string): void {
    this.items.delete(key);
  }
}

let local: FakeStorage;
let session: FakeStorage;

beforeEach(() => {
  clearOnboardingMirror();
  local = new FakeStorage();
  session = new FakeStorage();
  vi.stubGlobal("window", { localStorage: local, sessionStorage: session });
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearOnboardingMirror();
});

describe("the step", () => {
  it("is remembered per key, and a key with nothing stored starts at welcome", () => {
    expect(readOnboardingStep(A)).toBe("welcome");
    saveOnboardingStep(A, "vault");
    expect(readOnboardingStep(A)).toBe("vault");
    expect(readOnboardingStep(B)).toBe("welcome");
  });

  it("is read back from storage by a fresh page", () => {
    saveOnboardingStep(A, "vault");
    clearOnboardingMirror();
    expect(readOnboardingStep(A)).toBe("vault");
  });

  it("never stores the address, only its tag", () => {
    saveOnboardingStep(A, "vault");
    setOnboardingClosed(A, true);
    const stored = [...local.items.values(), ...session.items.values()].join(" ");
    expect(stored).not.toContain(A);
    expect(stored).not.toContain(A.slice(0, 8));
    expect(local.items.get("saverfi.onboarding.step")).toMatch(/^[0-9a-f]{8}:(welcome|vault)$/);
    expect(keyTag(A)).toMatch(/^[0-9a-f]{8}$/);
    expect(keyTag(A)).not.toBe(keyTag(B));
  });
});

describe("the close", () => {
  it("is per tab (sessionStorage) and per key", () => {
    expect(readOnboardingClosed(A)).toBe(false);
    setOnboardingClosed(A, true);
    expect(readOnboardingClosed(A)).toBe(true);
    expect(readOnboardingClosed(B)).toBe(false);
    expect(readOnboardingClosed(null)).toBe(false);
    expect(session.items.size).toBe(1);
    expect(local.items.has("saverfi.onboarding.closed")).toBe(false);
    setOnboardingClosed(A, false);
    expect(readOnboardingClosed(A)).toBe(false);
  });

  it("opening another key's setup does not clear this one's close", () => {
    setOnboardingClosed(A, true);
    setOnboardingClosed(B, false);
    expect(readOnboardingClosed(A)).toBe(true);
  });
});

describe("forgetting", () => {
  it("drops one key's memory, and leaves another key's alone", () => {
    saveOnboardingStep(A, "vault");
    setOnboardingClosed(A, true);
    forgetOnboarding(B);
    expect(readOnboardingStep(A)).toBe("vault");
    forgetOnboarding(A);
    expect(readOnboardingStep(A)).toBe("welcome");
    expect(readOnboardingClosed(A)).toBe(false);
  });

  it("drops everything when the session ends", () => {
    saveOnboardingStep(A, "vault");
    setOnboardingClosed(A, true);
    forgetOnboarding(null);
    expect(local.items.size).toBe(0);
    expect(session.items.size).toBe(0);
  });

  it("tells the other tabs only when asked to", () => {
    forgetOnboarding(A);
    expect(local.items.has(ONBOARDING_DONE_KEY)).toBe(false);
    forgetOnboarding(A, { announce: true });
    expect(local.items.get(ONBOARDING_DONE_KEY)).toMatch(new RegExp(`^${keyTag(A)}:\\d+$`));
  });
});

describe("listeners", () => {
  it("hear a change once, hear nothing for a write that changes nothing, and can leave", () => {
    const heard = vi.fn();
    const leave = subscribeOnboarding(heard);
    setOnboardingClosed(A, true);
    expect(heard).toHaveBeenCalledTimes(1);
    setOnboardingClosed(A, true);
    expect(heard).toHaveBeenCalledTimes(1);
    forgetOnboarding(A);
    expect(heard).toHaveBeenCalledTimes(2);
    forgetOnboarding(A);
    expect(heard).toHaveBeenCalledTimes(2);
    leave();
    saveOnboardingStep(A, "vault");
    expect(heard).toHaveBeenCalledTimes(2);
  });
});

describe("blocked storage", () => {
  it("still answers for the life of the page when every access throws", () => {
    const throwing = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    vi.stubGlobal("window", { localStorage: throwing, sessionStorage: throwing });
    saveOnboardingStep(A, "vault");
    setOnboardingClosed(A, true);
    expect(readOnboardingStep(A)).toBe("vault");
    expect(readOnboardingClosed(A)).toBe(true);
    expect(() => forgetOnboarding(null, { announce: true })).not.toThrow();
  });

  it("answers the defaults with no window at all", () => {
    vi.unstubAllGlobals();
    expect(readOnboardingStep(A)).toBe("welcome");
    expect(readOnboardingClosed(A)).toBe(false);
  });
});

describe("what the savings become", () => {
  it("is remembered per key in localStorage, and outlives the setup and the session", () => {
    expect(readBasketChoice(A)).toBeNull();
    saveBasketChoice(A, { kind: "stocks", mints: ["MintOne", "MintTwo"] });
    expect(readBasketChoice(A)).toEqual({ kind: "stocks", mints: ["MintOne", "MintTwo"] });
    expect(readBasketChoice(B)).toBeNull();
    // The vault landing, and a session ending, forget the setup — not this: the dashboard reads it after.
    forgetOnboarding(A);
    forgetOnboarding(null);
    expect(readBasketChoice(A)).toEqual({ kind: "stocks", mints: ["MintOne", "MintTwo"] });
    saveBasketChoice(A, { kind: "sol" });
    clearOnboardingMirror();
    expect(readBasketChoice(A)).toEqual({ kind: "sol" });
    expect(local.items.get("saverfi.basket")).toBe(`${keyTag(A)}:sol`);
  });
});
