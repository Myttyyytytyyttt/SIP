// L3, the last-known-good link list (src/discovery-lkg.ts): what a failed
// listing does with the limit off (today, exactly), with it on, and at each of
// its edges — and the alert that says so.
//
// No chain: the listing and the re-read are injected, so every case says
// exactly which of them ran and with what. The re-read against real decoders is
// in test/bench-chain-stub.test.ts.

import { PublicKey } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";
import {
  DISCOVERY_STALE_ALERT_KEY,
  DISCOVERY_STALE_CRITICAL_STREAK,
  LastKnownGoodDiscovery,
  discoveryStaleAlert,
} from "../src/discovery-lkg.js";
import type { DiscoveryReport, ManagedLink } from "../src/discovery.js";

const linkAt = (address: PublicKey, nonce: bigint, frontier: bigint): ManagedLink => ({
  linkAddress: address,
  wallet: PublicKey.unique(),
  vault: PublicKey.unique(),
  epoch: 1n,
  settlementNonce: nonce,
  frontierSlot: frontier,
});

const A = PublicKey.unique();
const B = PublicKey.unique();
const LISTED: ManagedLink[] = [linkAt(A, 3n, 100n), linkAt(B, 9n, 200n)];
const listed = (): Promise<DiscoveryReport> => Promise.resolve({ links: LISTED, method: "v1", requests: 1 });
const OVERLOADED = new Error("every Solana endpoint refused (endpoint 1/1 HTTP 503)");
const failing = (): Promise<DiscoveryReport> => Promise.reject(OVERLOADED);
const LIMIT = 600_000;

describe("L3 off (SIP_SOLANA_DISCOVERY_LKG_MS = 0): today's keeper", () => {
  it("lets the listing's own error through unchanged, remembers nothing and re-reads nothing", async () => {
    const discovery = new LastKnownGoodDiscovery(0);
    const reread = vi.fn(async () => LISTED);
    await expect(discovery.discover(listed, reread, 0)).resolves.toMatchObject({ source: "fresh", links: LISTED });
    await expect(discovery.discover(failing, reread, 60_000)).rejects.toBe(OVERLOADED);
    expect(reread).not.toHaveBeenCalled();
    expect(discovery.status(60_000)).toMatchObject({ lkgMaxAgeMs: 0, lkgAgeMs: null, lkgUses: 0 });
  });
});

describe("L3 on", () => {
  it("answers a failed listing with the remembered ADDRESSES, every field read fresh", async () => {
    const discovery = new LastKnownGoodDiscovery(LIMIT);
    await discovery.discover(listed, async () => [], 0);
    // ON CHAIN SINCE: A settled (nonce and frontier moved) and B was closed.
    const moved = linkAt(A, 4n, 150n);
    const reread = vi.fn(async (addresses: readonly PublicKey[]) => {
      expect(addresses.map((address) => address.toBase58())).toEqual([A.toBase58(), B.toBase58()]);
      return [moved];
    });

    const outcome = await discovery.discover(failing, reread, 60_000);

    expect(outcome.source).toBe("lkg");
    // THE MONEY PATH SEES TODAY'S NONCE AND FRONTIER, never the remembered ones.
    expect(outcome.links).toEqual([moved]);
    expect(outcome.lkgAgeMs).toBe(60_000);
    expect(outcome.failure).toBe(OVERLOADED);
    expect(outcome.consecutiveFailures).toBe(1);
    expect(reread).toHaveBeenCalledTimes(1);
    expect(discovery.status(60_000)).toMatchObject({ source: "lkg", lkgUses: 1, consecutiveFailures: 1, method: "v1" });
  });

  it("has nothing to fall back to before its first listing: boot always needs a fresh one", async () => {
    const discovery = new LastKnownGoodDiscovery(LIMIT);
    const reread = vi.fn(async () => LISTED);
    await expect(discovery.discover(failing, reread, 0)).rejects.toBe(OVERLOADED);
    expect(reread).not.toHaveBeenCalled();
  });

  it("fails as today once the list is older than the limit — and the re-reads do not make it younger", async () => {
    const discovery = new LastKnownGoodDiscovery(LIMIT);
    await discovery.discover(listed, async () => [], 0);
    const reread = vi.fn(async () => LISTED);
    for (const at of [60_000, 300_000, LIMIT]) {
      await expect(discovery.discover(failing, reread, at)).resolves.toMatchObject({ source: "lkg", lkgAgeMs: at });
    }
    await expect(discovery.discover(failing, reread, LIMIT + 1)).rejects.toBe(OVERLOADED);
    expect(reread).toHaveBeenCalledTimes(3);
    expect(discovery.status(LIMIT + 1).consecutiveFailures).toBe(4);
  });

  it("fails with the LISTING's error when the fresh re-read fails too: nothing cached is ever used unread", async () => {
    const discovery = new LastKnownGoodDiscovery(LIMIT);
    await discovery.discover(listed, async () => [], 0);
    await expect(discovery.discover(failing, async () => Promise.reject(new Error("getMultipleAccounts 429")), 60_000)).rejects.toBe(OVERLOADED);
    expect(discovery.status(60_000).lkgUses).toBe(0);
  });

  it("starts counting again, and keeps the newer list, at the next listing that succeeds", async () => {
    const discovery = new LastKnownGoodDiscovery(LIMIT);
    await discovery.discover(listed, async () => [], 0);
    await discovery.discover(failing, async () => LISTED, 60_000);
    await discovery.discover(failing, async () => LISTED, 120_000);
    const C = PublicKey.unique();
    const newer = (): Promise<DiscoveryReport> =>
      Promise.resolve({ links: [...LISTED, linkAt(C, 0n, 300n)], method: "v2", requests: 2 });
    await expect(discovery.discover(newer, async () => [], 180_000)).resolves.toMatchObject({ source: "fresh", consecutiveFailures: 0 });
    const reread = vi.fn(async (addresses: readonly PublicKey[]) => addresses.map((address) => linkAt(address, 0n, 0n)));
    const outcome = await discovery.discover(failing, reread, 200_000);
    expect(outcome.links.map((link) => link.linkAddress.toBase58())).toContain(C.toBase58());
    expect(outcome.lkgAgeMs).toBe(20_000);
    expect(outcome.consecutiveFailures).toBe(1);
  });

  it("reports the V2 fallback's reason on /status only while the last listing was one", async () => {
    const discovery = new LastKnownGoodDiscovery(LIMIT);
    await discovery.discover(
      () => Promise.resolve({ links: LISTED, method: "v1-fallback", requests: 2, fallbackReason: "getProgramAccountsV2 answered a JSON-RPC error (-32601)" }),
      async () => [],
      0,
    );
    expect(discovery.status(0)).toMatchObject({ method: "v1-fallback", fallbackReason: "getProgramAccountsV2 answered a JSON-RPC error (-32601)" });
    await discovery.discover(() => Promise.resolve({ links: LISTED, method: "v2", requests: 2 }), async () => [], 1);
    expect(discovery.status(1)).toMatchObject({ method: "v2", fallbackReason: null });
  });
});

describe("discovery-stale", () => {
  it("warns — on the box only — for the first two failed listings, and pages from the third", () => {
    expect(DISCOVERY_STALE_CRITICAL_STREAK).toBe(3);
    expect(discoveryStaleAlert(1, 60_000, "x").severity).toBe("warn");
    expect(discoveryStaleAlert(2, 120_000, "x").severity).toBe("warn");
    const paged = discoveryStaleAlert(3, 180_000, "HTTP 503");
    expect(paged).toMatchObject({ key: DISCOVERY_STALE_ALERT_KEY, severity: "critical", context: { sweeps: 3, lkgAgeMs: 180_000 } });
    expect(paged.detail).toContain("3 listings in a row failed");
    expect(paged.detail).toContain("180 s old");
    expect(paged.detail).toContain("HTTP 503");
  });
});
