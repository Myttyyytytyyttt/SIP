// AN UNREADABLE VAULT SCREEN READS ITSELF AGAIN (owner, 09-25): one failed
// /api/solana-vault read used to leave every card that waits on it dead until a
// reload. The wait is never shorter than 15 s, and never shorter than the
// route's own Retry-After.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { UNREADABLE_RETRY_MS, unreadableRetryMs, viewAfterFailure, type VaultView } from "@/hooks/use-vault-state";

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

/**
 * THE VAULT SCREEN FOLLOWS THE CHAIN (diagnosis 10-09, inventory D2): read
 * once at mount, it showed the modal the vault as it had been. The policy is
 * src/lib/vault-follow.ts's, tested there; pinned here is what the hook does
 * with it. This package has no DOM to render a hook in, so the wiring is read
 * from the source, as use-live-dashboard.test.ts reads it.
 */
const code = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join("\n");
const hook = code(readFileSync(fileURLToPath(new URL("./use-vault-state.ts", import.meta.url)), "utf8"));
const screen = code(readFileSync(fileURLToPath(new URL("../components/wallets/VaultScreen.tsx", import.meta.url)), "utf8"));
const host = code(readFileSync(fileURLToPath(new URL("../components/wallets-host.tsx", import.meta.url)), "utf8"));

describe("a read nobody pressed keeps what is on screen", () => {
  const ready = { kind: "ready", state: {} } as unknown as VaultView;
  const failed: VaultView = { kind: "unreadable", message: "Too many requests.", retryAfterSeconds: 3 };

  it("a catch-up or a poll that fails leaves a ready view where it is", () => {
    expect(viewAfterFailure(ready, failed, true)).toBe(ready);
  });

  it("Refresh and Retry, which someone pressed, still say what happened", () => {
    expect(viewAfterFailure(ready, failed, false)).toBe(failed);
  });

  it("with nothing ready on screen, the failure is all there is to show", () => {
    expect(viewAfterFailure({ kind: "loading" }, failed, true)).toBe(failed);
    const before: VaultView = { kind: "unreadable", message: "earlier", retryAfterSeconds: null };
    expect(viewAfterFailure(before, failed, true)).toBe(failed);
  });

  it("is how every failed answer is applied", () => {
    expect(hook).toMatch(/setView\(\(held\) => viewAfterFailure\(held, failed, quiet\)\);/);
    // A read someone asked for — mount, a key or wallet change, refresh() — is never quiet.
    expect(hook).toMatch(/useEffect\(\(\) => run\(false\), \[run, nonce\]\);/);
  });
});

describe("refreshing, and the read nobody pressed", () => {
  it("is busy while a read is out over a view already drawn — 'loading' says the first", () => {
    expect(hook).toMatch(/const refreshing = awaited !== null && view\.kind !== "loading";/);
    expect(hook).toMatch(/setAwaited\(request\);/);
    expect(hook).toMatch(/if \(!current \|\| request !== latest\.current\) return;\s*setAwaited\(null\);/);
  });

  it("catches up through one floor gate that every read reports to, quietly, for the newest key", () => {
    expect(hook).toMatch(/gateRef\.current\?\.started\(\);/);
    expect(hook).toMatch(/createFloorGate\(\{ run: \(\) => void runRef\.current\(true\) \}\)/);
    expect(hook).toMatch(/const catchUp = useCallback\(\(floorMs: number = VAULT_OPEN_FLOOR_MS\) => gateRef\.current\?\.ask\(floorMs\), \[\]\);/);
    expect(hook).toMatch(/useEffect\(\(\) => \(\) => gateRef\.current\?\.dispose\(\), \[run\]\);/);
  });

  it("polls only when asked to, only while visible and with nothing out, a sweep after the last answer", () => {
    expect(hook).toMatch(/if \(!poll \|\| typeof document === "undefined" \|\| document\.visibilityState !== "visible" \|\| awaited !== null\) return undefined;/);
    expect(hook).toMatch(/vaultPollDelayMs\(\{ answeredAt, now: Date\.now\(\) \}\)/);
    expect(hook).toMatch(/if \(document\.visibilityState === "visible"\) runRef\.current\(true\);/);
  });

  it("reads on coming back to the tab, under the person's floor, by visibility and by focus — only when polling", () => {
    expect(hook).toMatch(/if \(!poll \|\| typeof document === "undefined"\) return undefined;\s*const onShow/);
    expect(hook).toMatch(/catchUp\(VAULT_OPEN_FLOOR_MS\);/);
    expect(hook).toMatch(/document\.addEventListener\("visibilitychange", onShow\);/);
    expect(hook).toMatch(/window\.addEventListener\("focus", onShow\);/);
  });

  it("/wallets polls; the dashboard's shared screen does not — its live store reads the chain already", () => {
    expect(screen).toMatch(/poll = true,/);
    expect(screen).toMatch(/useVaultState\(api, pensionKey, wallets, \{ poll \}\)/);
    expect(screen).toMatch(/\(\{ pensionKey, view, refresh, api, refreshing, catchUp \}\)/);
    expect(host).toMatch(/<VaultScreen pensionKey=\{pensionKey\} poll=\{false\}>/);
  });
});
