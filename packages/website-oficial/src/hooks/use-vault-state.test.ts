// AN UNREADABLE VAULT SCREEN READS ITSELF AGAIN (owner, 09-25): one failed
// /api/solana-vault read used to leave every card that waits on it dead until a
// reload. The wait is never shorter than 15 s, and never shorter than the
// route's own Retry-After.

import { describe, expect, it } from "vitest";

import { UNREADABLE_RETRY_MS, unreadableRetryMs } from "@/hooks/use-vault-state";

describe("how long an unreadable view waits before it is read again", () => {
  it("is 15 s when the route named no Retry-After, or a shorter one", () => {
    expect(UNREADABLE_RETRY_MS).toBe(15_000);
    expect(unreadableRetryMs(null)).toBe(15_000);
    expect(unreadableRetryMs(undefined)).toBe(15_000);
    expect(unreadableRetryMs(3)).toBe(15_000);
  });

  it("honours a longer Retry-After, as a 429 asks", () => {
    expect(unreadableRetryMs(60)).toBe(60_000);
  });

  it("ignores a Retry-After that is not a positive number", () => {
    expect(unreadableRetryMs(0)).toBe(15_000);
    expect(unreadableRetryMs(-5)).toBe(15_000);
    expect(unreadableRetryMs(Number.NaN)).toBe(15_000);
  });
});
