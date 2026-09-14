/**
 * ONE LIMITER FOR THE ROUTES THAT THROTTLE, and the one rule for who a client is.
 *
 * The buckets are @sip/solana-core's weighted token buckets, refilled
 * continuously, with idle buckets forgotten after five minutes and the key map
 * bounded. They are in memory and PER PROCESS, which is honest for exactly one
 * web replica. SIP runs one (railway.json pins numReplicas to 1): two replicas
 * would be two buckets, and a restart is a refill. A deployment that needs a real
 * limit puts one at its edge.
 *
 * The Solana routes (/api/solana-rpc, /api/solana-tx) use the same buckets from
 * inside the core's handlers, keyed by the rule below with the header required,
 * and they also charge a second bucket per client network (IPv4 /24, IPv6 /48)
 * so one home /56 cannot pose as hundreds of clients. This module is what the
 * EVM routes (/api/rpc, /api/vault) share; they keep the one exact key.
 *
 * WHO A CLIENT IS. Two rules, and the environment picks one.
 *
 * SIP_TRUSTED_CLIENT_IP_HEADER SET: that one header, and nothing else. It names
 * the header the edge in front of this process overwrites from the socket it
 * sees (Railway's Envoy writes x-envoy-external-address). Every other header is
 * ignored. A request without a parseable IP in it, or a variable naming a header
 * the client can write itself, lands in the shared "unknown" bucket, which
 * throttles the mistake instead of opening it. IPv6 is keyed by its /64, because
 * one connection owns a /64 and rotating inside it must not mint buckets.
 *
 * UNSET: the rule the EVM routes shipped with, kept byte for byte so a deployment
 * that never sets the variable behaves exactly as before. The first non-empty
 * header of six that some edge writes (Cloudflare, Vercel, Railway's Envoy, Fly,
 * Akamai, then the x-real-ip convention), then the first hop of x-forwarded-for,
 * then "unknown". `x-forwarded-for` is consulted last because it is APPENDED to:
 * its first entry is whatever the client sent.
 *
 * THE HOLE IN THE OLD RULE, STATED. Trusting the FIRST of six names is only right
 * behind the edge that writes that name. Behind Railway alone, a client can send
 * `cf-connecting-ip: <random>` and get a fresh bucket per request. Setting
 * SIP_TRUSTED_CLIENT_IP_HEADER closes it; it is not forced on the EVM routes
 * because a deployment without the variable would collapse every visitor into
 * one shared bucket, which is a behaviour change nobody asked for.
 */
import { clientKeyFromHeaders, createWeightedLimiter, retryAfterSeconds } from "@sip/solana-core/server";

import type { Env } from "./config";

export { retryAfterSeconds };

/** The pre-SIP_TRUSTED_CLIENT_IP_HEADER precedence, in order. */
export const LEGACY_TRUSTED_CLIENT_IP_HEADERS = [
  "cf-connecting-ip",
  "x-vercel-forwarded-for",
  "x-envoy-external-address",
  "fly-client-ip",
  "true-client-ip",
  "x-real-ip",
] as const;

/** Headers a client writes itself. Never an identity, even when named; @sip/solana-core refuses the same list. */
const SPOOFABLE_HEADERS: ReadonlySet<string> = new Set(["x-forwarded-for", "forwarded", "x-forwarded", "x-client-ip"]);

export type ClientKeyRule =
  | { readonly kind: "legacy" }
  /** `header` is null when the variable is set but unusable: every request then shares one bucket. */
  | { readonly kind: "header"; readonly header: string | null };

export function clientKeyRule(env: Env = process.env): ClientKeyRule {
  const raw = env["SIP_TRUSTED_CLIENT_IP_HEADER"]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return { kind: "legacy" };
  return { kind: "header", header: /^[a-z0-9-]{1,64}$/.test(raw) && !SPOOFABLE_HEADERS.has(raw) ? raw : null };
}

/** The bucket key for a request, by the rule the environment selects. */
export function clientKey(request: Request, env: Env = process.env): string {
  const rule = clientKeyRule(env);
  if (rule.kind === "header") return clientKeyFromHeaders(request.headers, rule.header);
  for (const name of LEGACY_TRUSTED_CLIENT_IP_HEADERS) {
    const value = request.headers.get(name)?.trim();
    if (value !== undefined && value !== "") return value;
  }
  const first = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (first !== undefined && first !== "") return first;
  return "unknown";
}

export interface Limiter {
  /** Takes `cost` tokens (default 1) for `key`. Returns 0 when taken, otherwise the ms until they would be. */
  take(key: string, cost?: number, now?: number): number;
}

/** A limiter owning its own buckets, so every route and purpose counts separately. */
export function createLimiter(options: { readonly capacity: number; readonly refillPerMinute?: number }): Limiter {
  const buckets = createWeightedLimiter(options);
  return {
    take: (key, cost = 1, now = Date.now()) => buckets.take(key, cost, now),
  };
}
