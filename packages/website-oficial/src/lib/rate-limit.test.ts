import { describe, expect, it } from "vitest";

import { LEGACY_TRUSTED_CLIENT_IP_HEADERS, clientKey, clientKeyRule, createLimiter, retryAfterSeconds } from "@/lib/rate-limit";

const request = (headers: Record<string, string>): Request => new Request("https://sip.example/api/rpc", { method: "POST", headers });

describe("clientKey with SIP_TRUSTED_CLIENT_IP_HEADER unset (the EVM routes' rule, unchanged)", () => {
  it("pins the old precedence", () => {
    expect([...LEGACY_TRUSTED_CLIENT_IP_HEADERS]).toEqual([
      "cf-connecting-ip",
      "x-vercel-forwarded-for",
      "x-envoy-external-address",
      "fly-client-ip",
      "true-client-ip",
      "x-real-ip",
    ]);
    expect(clientKeyRule({})).toEqual({ kind: "legacy" });
    expect(clientKeyRule({ SIP_TRUSTED_CLIENT_IP_HEADER: "   " })).toEqual({ kind: "legacy" });
  });

  it("takes the first edge header in that order, before x-forwarded-for", () => {
    expect(clientKey(request({ "x-envoy-external-address": "203.0.113.5", "cf-connecting-ip": "198.51.100.1" }), {})).toBe("198.51.100.1");
    expect(clientKey(request({ "x-envoy-external-address": "203.0.113.5", "x-forwarded-for": "10.0.0.1, 203.0.113.5" }), {})).toBe("203.0.113.5");
  });

  it("falls back to the first x-forwarded-for hop, then to the shared unknown bucket", () => {
    expect(clientKey(request({ "x-forwarded-for": "10.0.0.1, 203.0.113.5" }), {})).toBe("10.0.0.1");
    expect(clientKey(request({}), {})).toBe("unknown");
  });

  it("keeps the raw value, as the routes always did", () => {
    expect(clientKey(request({ "x-real-ip": "2a01:db8:1:2:aaaa::1" }), {})).toBe("2a01:db8:1:2:aaaa::1");
  });
});

describe("clientKey with SIP_TRUSTED_CLIENT_IP_HEADER set", () => {
  const env = { SIP_TRUSTED_CLIENT_IP_HEADER: " X-Envoy-External-Address " };

  it("reads that one header: rotating cf-connecting-ip and x-forwarded-for share one bucket", () => {
    const keys = new Set(
      Array.from({ length: 5 }, (_, i) =>
        clientKey(
          request({ "x-envoy-external-address": "203.0.113.5", "cf-connecting-ip": `198.51.100.${i}`, "x-forwarded-for": `10.0.0.${i}` }),
          env,
        ),
      ),
    );
    expect([...keys]).toEqual(["203.0.113.5"]);
  });

  it("keys IPv6 by its /64 and unwraps IPv4-mapped addresses", () => {
    const a = clientKey(request({ "x-envoy-external-address": "2a01:db8:1:2:aaaa::1" }), env);
    const b = clientKey(request({ "x-envoy-external-address": "2a01:db8:1:2:bbbb::9" }), env);
    expect(a).toBe(b);
    expect(clientKey(request({ "x-envoy-external-address": "::ffff:203.0.113.5" }), env)).toBe("203.0.113.5");
  });

  it("a missing header, or one that is not an IP, is the shared unknown bucket", () => {
    expect(clientKey(request({ "cf-connecting-ip": "198.51.100.1" }), env)).toBe("unknown");
    expect(clientKey(request({ "x-envoy-external-address": "not-an-ip" }), env)).toBe("unknown");
  });

  it("naming a header the client writes itself keys nobody apart", () => {
    const spoofable = { SIP_TRUSTED_CLIENT_IP_HEADER: "x-forwarded-for" };
    expect(clientKeyRule(spoofable)).toEqual({ kind: "header", header: null });
    expect(clientKey(request({ "x-forwarded-for": "203.0.113.9" }), spoofable)).toBe("unknown");
    expect(clientKeyRule({ SIP_TRUSTED_CLIENT_IP_HEADER: "not a header" })).toEqual({ kind: "header", header: null });
  });
});

describe("createLimiter", () => {
  it("60 a minute: the 61st waits about a second, other keys are independent, and a token refills", () => {
    const limiter = createLimiter({ capacity: 60 });
    for (let i = 0; i < 60; i++) expect(limiter.take("a", 1, 0)).toBe(0);
    const wait = limiter.take("a", 1, 0);
    expect(wait).toBeGreaterThanOrEqual(999);
    expect(wait).toBeLessThanOrEqual(1001);
    expect(retryAfterSeconds(wait)).toBe(1);
    expect(limiter.take("b", 1, 0)).toBe(0);
    expect(limiter.take("a", 1, 1_001)).toBe(0);
  });

  it("weighted costs draw several tokens at once", () => {
    const limiter = createLimiter({ capacity: 120 });
    expect(limiter.take("a", 10, 0)).toBe(0);
    expect(limiter.take("a", 110, 0)).toBe(0);
    expect(limiter.take("a", 1, 0)).toBeGreaterThan(0);
  });
});
