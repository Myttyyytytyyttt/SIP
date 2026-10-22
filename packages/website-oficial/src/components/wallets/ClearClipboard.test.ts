// Clear clipboard: what the press writes, and what it says when there is no clipboard or the browser refuses.

import { describe, expect, it, vi } from "vitest";

import { clearClipboard } from "@/components/wallets/ClearClipboard";

describe("clearClipboard", () => {
  it("writes an empty string over the clipboard", async () => {
    const writeText = vi.fn(async () => {});
    expect(await clearClipboard({ writeText })).toBe("cleared");
    expect(writeText).toHaveBeenCalledWith("");
  });

  it("fails without a clipboard, and when the browser refuses the write", async () => {
    expect(await clearClipboard(undefined)).toBe("failed");
    expect(await clearClipboard({ writeText: async () => Promise.reject(new DOMException("Document is not focused.", "NotAllowedError")) })).toBe("failed");
  });
});
