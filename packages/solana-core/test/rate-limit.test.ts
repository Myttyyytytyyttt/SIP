// The weighted limiter and the single-header client identity.

import { describe, expect, it } from "vitest";

import {
  UNKNOWN_CLIENT,
  UNKNOWN_IDENTITY,
  clientIdentityFromHeaders,
  clientKeyFromHeaders,
  createWeightedLimiter,
  normalizeClientIdentity,
  normalizeClientIp,
  retryAfterSeconds,
} from "../src/server/rate-limit";

describe("createWeightedLimiter", () => {
  it("capacity 3: three takes pass, the fourth waits about 20 s, and 20 s later one token is back", () => {
    const limiter = createWeightedLimiter({ capacity: 3 });
    expect([limiter.take("a", 1, 0), limiter.take("a", 1, 0), limiter.take("a", 1, 0)]).toEqual([0, 0, 0]);
    const wait = limiter.take("a", 1, 0);
    expect(wait).toBeGreaterThanOrEqual(19_999);
    expect(wait).toBeLessThanOrEqual(20_001);
    expect(limiter.take("a", 1, 20_000)).toBe(0);
    expect(limiter.take("a", 1, 20_000)).toBeGreaterThan(0);
  });

  it("charges weights all or nothing: a cost of 10 from 120 leaves exactly 110", () => {
    const limiter = createWeightedLimiter({ capacity: 120 });
    expect(limiter.take("a", 10, 0)).toBe(0);
    expect(limiter.take("a", 111, 0)).toBeGreaterThan(0);
    expect(limiter.take("a", 110, 0)).toBe(0);
    expect(limiter.take("a", 1, 0)).toBeGreaterThan(0);
  });

  it("keeps keys independent", () => {
    const limiter = createWeightedLimiter({ capacity: 1 });
    expect(limiter.take("a", 1, 0)).toBe(0);
    expect(limiter.take("b", 1, 0)).toBe(0);
    expect(limiter.take("a", 1, 0)).toBeGreaterThan(0);
  });

  it("answers Infinity for a cost above capacity, which retry-after reports as 60 s", () => {
    const limiter = createWeightedLimiter({ capacity: 5 });
    expect(limiter.take("a", 6, 0)).toBe(Number.POSITIVE_INFINITY);
    expect(retryAfterSeconds(Number.POSITIVE_INFINITY)).toBe(60);
    expect(retryAfterSeconds(1)).toBe(1);
    expect(retryAfterSeconds(2_001)).toBe(3);
  });

  it("bounds the key map under an address-rotation flood", () => {
    const limiter = createWeightedLimiter({ capacity: 10 });
    for (let i = 0; i <= 10_000; i++) limiter.take(`k${i}`, 1, i);
    expect(limiter.size).toBeLessThanOrEqual(10_000);
  });

  it("forgets idle buckets after 5 minutes", () => {
    const limiter = createWeightedLimiter({ capacity: 10, maxKeys: 5 });
    for (let i = 0; i < 5; i++) limiter.take(`k${i}`, 1, 0);
    expect(limiter.size).toBe(5);
    limiter.take("fresh", 1, 5 * 60_000 + 1);
    expect(limiter.size).toBe(1);
  });

  it("as a process-wide budget, refuses fresh client keys once exhausted", () => {
    const perClient = createWeightedLimiter({ capacity: 100 });
    const global = createWeightedLimiter({ capacity: 30 });
    let refused = 0;
    for (let i = 0; i < 40; i++) {
      if (perClient.take(`client-${i}`, 1, 0) === 0 && global.take("global", 1, 0) > 0) refused += 1;
    }
    expect(refused).toBe(10);
  });
});

describe("the client identity", () => {
  const headers = (entries: Record<string, string>): Headers => new Headers(entries);

  it("reads ONLY the configured header: rotating every other header shares one bucket", () => {
    const keys = new Set<string>();
    for (let i = 0; i < 30; i++) {
      keys.add(
        clientKeyFromHeaders(
          headers({
            "x-envoy-external-address": "203.0.113.7",
            "cf-connecting-ip": `198.51.100.${i}`,
            "true-client-ip": `192.0.2.${i}`,
            "x-real-ip": `10.0.0.${i}`,
            "x-forwarded-for": `172.16.0.${i}, 203.0.113.7`,
          }),
          "x-envoy-external-address",
        ),
      );
    }
    expect([...keys]).toEqual(["203.0.113.7"]);
  });

  it("puts a request without the header, or with a non-IP value, in the shared unknown bucket", () => {
    expect(clientKeyFromHeaders(headers({ "cf-connecting-ip": "198.51.100.1" }), "x-envoy-external-address")).toBe(UNKNOWN_CLIENT);
    expect(clientKeyFromHeaders(headers({ "x-envoy-external-address": "1.2.3.4, 5.6.7.8" }), "x-envoy-external-address")).toBe(UNKNOWN_CLIENT);
    expect(clientKeyFromHeaders(headers({ "x-envoy-external-address": "not-an-ip" }), "x-envoy-external-address")).toBe(UNKNOWN_CLIENT);
    expect(clientKeyFromHeaders(headers({ "x-envoy-external-address": "203.0.113.7" }), null)).toBe(UNKNOWN_CLIENT);
  });

  it.each([
    ["2a01:db8:1:2:aaaa::1", "2a01:db8:1:2::/64"],
    ["2a01:db8:1:2:bbbb::9", "2a01:db8:1:2::/64"],
    ["2A01:0DB8:0001:0002:0000:0000:0000:0001", "2a01:db8:1:2::/64"],
    ["[2a01:db8::1]:443", "2a01:db8:0:0::/64"],
    ["::1", "0:0:0:0::/64"],
    ["::ffff:203.0.113.5", "203.0.113.5"],
    ["::ffff:cb00:7105", "203.0.113.5"],
    ["203.0.113.5", "203.0.113.5"],
    ["203.0.113.5:8080", "203.0.113.5"],
    ["fe80::1%eth0", "fe80:0:0:0::/64"],
  ])("normalizes %s to %s", (raw, key) => {
    expect(normalizeClientIp(raw)).toBe(key);
  });

  it.each(["", "999.1.1.1", "1:2:3", "gggg::1", "1.2.3.4.5"])("rejects %j", (raw) => {
    expect(normalizeClientIp(raw)).toBeNull();
    expect(normalizeClientIdentity(raw)).toBeNull();
  });

  it.each([
    ["203.0.113.5", "203.0.113.5", "203.0.113.0/24"],
    ["203.0.113.5:8080", "203.0.113.5", "203.0.113.0/24"],
    ["::ffff:203.0.113.5", "203.0.113.5", "203.0.113.0/24"],
    ["2001:db8:0:ab01::1", "2001:db8:0:ab01::/64", "2001:db8:0::/48"],
    ["2001:db8:0:ab05:ffff::9", "2001:db8:0:ab05::/64", "2001:db8:0::/48"],
    ["2A01:0DB8:0001:0002:0000:0000:0000:0001", "2a01:db8:1:2::/64", "2a01:db8:1::/48"],
    ["[2a01:db8::1]:443", "2a01:db8:0:0::/64", "2a01:db8:0::/48"],
  ])("keys %s as %s within the network %s", (raw, exact, aggregate) => {
    expect(normalizeClientIdentity(raw)).toEqual({ exact, aggregate });
  });

  it("gives the /64s of one /56 their own exact keys and one network key", () => {
    const identities = Array.from({ length: 5 }, (_, i) =>
      clientIdentityFromHeaders(headers({ "x-envoy-external-address": `2001:db8:0:ab0${i + 1}::1` }), "x-envoy-external-address"),
    );
    expect(new Set(identities.map((identity) => identity.exact)).size).toBe(5);
    expect(new Set(identities.map((identity) => identity.aggregate))).toEqual(new Set(["2001:db8:0::/48"]));
  });

  it("gives a request without a usable trusted header the unknown identity on both keys", () => {
    expect(clientIdentityFromHeaders(headers({ "cf-connecting-ip": "198.51.100.1" }), "x-envoy-external-address")).toEqual(UNKNOWN_IDENTITY);
    expect(clientIdentityFromHeaders(headers({ "x-envoy-external-address": "not-an-ip" }), "x-envoy-external-address")).toEqual(UNKNOWN_IDENTITY);
    expect(clientIdentityFromHeaders(headers({ "x-envoy-external-address": "203.0.113.7" }), null)).toEqual(UNKNOWN_IDENTITY);
    expect(UNKNOWN_IDENTITY).toEqual({ exact: UNKNOWN_CLIENT, aggregate: UNKNOWN_CLIENT });
  });
});
