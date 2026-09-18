// The keeper-seat work on each wallet lives outside the row that started it, so a row mounted again sees it running
// and then how it ended — and while a re-seat runs, the page holds back leaving it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  IDLE_ACTIVITY,
  beginSeatTask,
  clearSeatActivity,
  endSeatTask,
  reseatRunning,
  seatActivity,
  subscribeSeatActivity,
} from "@/lib/seat-activity";

const A = "WalletAP1aceho1der1111111111111111111111111";
const B = "WalletBP1aceho1der1111111111111111111111111";

beforeEach(() => clearSeatActivity());
afterEach(() => {
  clearSeatActivity();
  vi.unstubAllGlobals();
});

describe("seat activity, by address", () => {
  it("one operation at a time on a wallet, and each wallet on its own", () => {
    expect(seatActivity(A)).toBe(IDLE_ACTIVITY);
    expect(beginSeatTask(A, "reseating")).toBe(true);
    expect(beginSeatTask(A, "granting")).toBe(false);
    expect(beginSeatTask(A, "checking")).toBe(false);
    expect(seatActivity(A).busy).toBe("reseating");
    expect(beginSeatTask(B, "granting")).toBe(true);
    endSeatTask(A, { notice: "Done." });
    expect(seatActivity(A)).toStrictEqual({ busy: null, failure: null, notice: "Done." });
    expect(beginSeatTask(A, "granting")).toBe(true);
  });

  it("keeps the outcome until the next operation, which clears it — a re-read keeps the notice", () => {
    beginSeatTask(A, "reseating");
    endSeatTask(A, { notice: "Done." });
    beginSeatTask(A, "checking", { keepNotice: true });
    endSeatTask(A);
    expect(seatActivity(A)).toStrictEqual({ busy: null, failure: null, notice: "Done." });
    beginSeatTask(A, "granting");
    expect(seatActivity(A).notice).toBeNull();
    endSeatTask(A, { failure: "Privy said no." });
    expect(seatActivity(A)).toStrictEqual({ busy: null, failure: "Privy said no.", notice: null });
  });

  it("hands useSyncExternalStore the same object until something changes, and tells every subscriber when it does", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeSeatActivity(listener);
    beginSeatTask(A, "reseating");
    const running = seatActivity(A);
    expect(seatActivity(A)).toBe(running);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    endSeatTask(A);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("reseatRunning is true only while a re-seat runs on some wallet", () => {
    beginSeatTask(A, "granting");
    beginSeatTask(B, "checking");
    expect(reseatRunning()).toBe(false);
    beginSeatTask("C", "reseating");
    expect(reseatRunning()).toBe(true);
    endSeatTask("C");
    expect(reseatRunning()).toBe(false);
  });
});

describe("leaving the page mid-re-seat", () => {
  class FakeElement {
    constructor(private readonly insideLink: boolean) {}
    closest(selector: string): FakeElement | null {
      return selector === "a[href]" && this.insideLink ? this : null;
    }
  }

  function stubBrowser() {
    const windowListeners = new Map<string, unknown>();
    const documentListeners = new Map<string, { listener: unknown; capture: unknown }>();
    vi.stubGlobal("Element", FakeElement);
    vi.stubGlobal("window", {
      addEventListener: vi.fn((type: string, listener: unknown) => windowListeners.set(type, listener)),
      removeEventListener: vi.fn((type: string) => windowListeners.delete(type)),
    });
    vi.stubGlobal("document", {
      addEventListener: vi.fn((type: string, listener: unknown, capture: unknown) => documentListeners.set(type, { listener, capture })),
      removeEventListener: vi.fn((type: string) => documentListeners.delete(type)),
    });
    return { windowListeners, documentListeners };
  }

  it("asks before unloading and stops link clicks while a re-seat runs, and only then", () => {
    const { windowListeners, documentListeners } = stubBrowser();
    beginSeatTask(A, "granting");
    expect(windowListeners.size).toBe(0);
    beginSeatTask(B, "reseating");
    expect([...windowListeners.keys()]).toStrictEqual(["beforeunload"]);
    expect(documentListeners.get("click")?.capture).toBe(true);

    const unload = { preventDefault: vi.fn(), returnValue: "unset" };
    (windowListeners.get("beforeunload") as (event: unknown) => void)(unload);
    expect(unload.preventDefault).toHaveBeenCalledTimes(1);
    expect(unload.returnValue).toBe("");

    const onClick = documentListeners.get("click")?.listener as (event: unknown) => void;
    const onLink = { target: new FakeElement(true), preventDefault: vi.fn(), stopPropagation: vi.fn() };
    onClick(onLink);
    expect(onLink.preventDefault).toHaveBeenCalledTimes(1);
    expect(onLink.stopPropagation).toHaveBeenCalledTimes(1);
    const onButton = { target: new FakeElement(false), preventDefault: vi.fn(), stopPropagation: vi.fn() };
    onClick(onButton);
    expect(onButton.preventDefault).not.toHaveBeenCalled();
    expect(onButton.stopPropagation).not.toHaveBeenCalled();

    endSeatTask(B, { notice: "Done." });
    expect(windowListeners.size).toBe(0);
    expect(documentListeners.size).toBe(0);
  });
});
