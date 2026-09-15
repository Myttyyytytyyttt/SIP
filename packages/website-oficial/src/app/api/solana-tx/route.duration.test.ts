// /api/solana-tx's function limit on Vercel. Every answer after a send must carry
// the signature, so the function has to outlive simulate plus send, each of which
// tries the endpoints one after another at DEFAULT_TIMEOUT_MS apiece. 300 s is
// what every Vercel plan allows under Fluid compute.

import { DEFAULT_TIMEOUT_MS } from "@sip/solana-core/server";
import { describe, expect, it } from "vitest";

import { maxDuration } from "./route";

/** Endpoints SIP_SOLANA_RPC_URLS is expected to hold at most. */
const ENDPOINTS = 3;

describe("/api/solana-tx on Vercel", () => {
  it("declares a maxDuration that outlives simulate plus send across every endpoint and fits every plan", () => {
    expect(maxDuration).toBeLessThanOrEqual(300);
    expect(maxDuration * 1000).toBeGreaterThanOrEqual(2 * ENDPOINTS * DEFAULT_TIMEOUT_MS);
  });
});
