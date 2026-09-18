// The Manage wallets modal does not close while a re-seat runs: closing unmounts the row between the removal and
// the add, which only this page holds.

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/wallets/WalletsScreen", () => ({ WalletsScreen: () => null }));

import { closeHeldBack, guardedOpenChange } from "@/components/wallets/WalletsModal";
import { beginSeatTask, clearSeatActivity, endSeatTask } from "@/lib/seat-activity";

const WALLET = "WalletAP1aceho1der1111111111111111111111111";

afterEach(() => clearSeatActivity());

describe("WalletsModal while a re-seat runs", () => {
  it("drops every close request, and passes opening and every request after the re-seat through", () => {
    const onOpenChange = vi.fn();
    const change = guardedOpenChange(onOpenChange);
    beginSeatTask(WALLET, "reseating");
    expect(closeHeldBack()).toBe(true);
    change(false);
    expect(onOpenChange).not.toHaveBeenCalled();
    change(true);
    expect(onOpenChange.mock.calls).toStrictEqual([[true]]);
    endSeatTask(WALLET, { notice: "Done." });
    expect(closeHeldBack()).toBe(false);
    change(false);
    expect(onOpenChange.mock.calls).toStrictEqual([[true], [false]]);
  });

  it("a grant or a re-read does not hold it: only the re-seat has a moment with no signer", () => {
    beginSeatTask(WALLET, "granting");
    expect(closeHeldBack()).toBe(false);
  });
});
