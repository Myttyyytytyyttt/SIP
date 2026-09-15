// Weighted token buckets and the one client identity they key on.
//
// IN MEMORY, PER PROCESS. On Vercel that means per Fluid compute instance: when
// Vercel adds an instance or starts a cold one, every bucket multiplies or
// refills. Accepted through the hackathon. No timers and no Redis: sweeping
// happens on use.
//
// ONE HEADER. The EVM relay trusted the first of six headers, so behind any edge a
// client could send `cf-connecting-ip: <random>` and get a fresh bucket per
// request. Here the operator names the single header the edge writes
// (SIP_TRUSTED_CLIENT_IP_HEADER); everything else is ignored, and a request
// without a parseable value shares the "unknown" bucket — throttling a
// misconfiguration instead of opening it.
//
// TWO KEYS PER CLIENT. The exact key is the IPv4 address or the IPv6 /64. A home
// connection is handed a /56 (256 /64s) and a tunnel broker a /48 (65,536), so
// per-/64 buckets alone let one person pose as hundreds of clients. The handlers
// therefore also charge the client's NETWORK, its IPv4 /24 or IPv6 /48, in a
// second bucket CLIENT_AGGREGATE_FACTOR times the per-client size. The exact
// bucket is charged first, so a client already refused spends nothing of its
// neighbours' allowance.

import { isIP } from "node:net";

export interface WeightedLimiter {
  /**
   * Takes `cost` tokens for `key` at time `now` (ms), all or nothing. Returns 0
   * when taken, otherwise how many ms until `cost` tokens would be available
   * (Infinity when `cost` exceeds the capacity).
   */
  take(key: string, cost: number, now: number): number;
  /** Buckets currently held. Diagnostic. */
  readonly size: number;
}

export interface LimiterOptions {
  /** Maximum tokens a bucket holds; also the refill per minute unless `refillPerMinute` says otherwise. */
  readonly capacity: number;
  readonly refillPerMinute?: number;
  /** A bucket idle this long is forgotten. Default 5 minutes. */
  readonly idleMs?: number;
  /** Hard bound on buckets; the oldest-updated are evicted past it. Default 10,000. */
  readonly maxKeys?: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export function createWeightedLimiter(options: LimiterOptions): WeightedLimiter {
  const capacity = options.capacity;
  const refillPerMs = (options.refillPerMinute ?? capacity) / 60_000;
  const idleMs = options.idleMs ?? 5 * 60_000;
  const maxKeys = options.maxKeys ?? 10_000;
  if (!(capacity > 0) || !(refillPerMs > 0)) throw new Error("a limiter needs a positive capacity and refill");
  const buckets = new Map<string, Bucket>();
  let sinceSweep = 0;

  const sweep = (now: number): void => {
    for (const [key, bucket] of buckets) {
      if (now - bucket.updatedAt > idleMs) buckets.delete(key);
    }
    // Map iteration is insertion order and every take re-inserts, so the first
    // keys are the least recently used.
    for (const key of buckets.keys()) {
      if (buckets.size <= maxKeys) break;
      buckets.delete(key);
    }
  };

  return {
    take(key: string, cost: number, now: number): number {
      if (!(cost >= 0)) throw new Error("a limiter cost must be zero or more");
      sinceSweep += 1;
      if (sinceSweep >= 256 || buckets.size >= maxKeys) {
        sinceSweep = 0;
        sweep(now);
      }
      const existing = buckets.get(key);
      const bucket: Bucket = existing ?? { tokens: capacity, updatedAt: now };
      const elapsed = Math.max(0, now - bucket.updatedAt);
      bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * refillPerMs);
      bucket.updatedAt = now;
      buckets.delete(key);
      buckets.set(key, bucket);
      if (buckets.size > maxKeys) sweep(now);
      if (bucket.tokens >= cost) {
        bucket.tokens -= cost;
        return 0;
      }
      if (cost > capacity) return Number.POSITIVE_INFINITY;
      return Math.ceil((cost - bucket.tokens) / refillPerMs);
    },
    get size(): number {
      return buckets.size;
    },
  };
}

/** Whole seconds for a retry-after header: at least 1, and 60 for "never at this capacity". */
export const retryAfterSeconds = (waitMs: number): number => (Number.isFinite(waitMs) ? Math.max(1, Math.ceil(waitMs / 1000)) : 60);

export const UNKNOWN_CLIENT = "unknown";

function expandIpv6(address: string): number[] | null {
  let text = address;
  const groupsFromV4: number[] = [];
  const lastColon = text.lastIndexOf(":");
  const tail = text.slice(lastColon + 1);
  if (tail.includes(".")) {
    if (isIP(tail) !== 4) return null;
    const [a, b, c, d] = tail.split(".").map(Number) as [number, number, number, number];
    groupsFromV4.push((a << 8) | b, (c << 8) | d);
    text = text.slice(0, lastColon + 1) + "0:0";
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string): number[] => (part === "" ? [] : part.split(":").map((group) => Number.parseInt(group, 16)));
  const head = parse(halves[0]!);
  const rest = halves.length === 2 ? parse(halves[1]!) : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 0) return null;
  const groups = [...head, ...new Array<number>(halves.length === 2 ? missing : 0).fill(0), ...rest];
  if (groupsFromV4.length === 2) groups.splice(6, 2, ...groupsFromV4);
  return groups.length === 8 && groups.every((group) => Number.isInteger(group) && group >= 0 && group <= 0xffff) ? groups : null;
}

/** A client's two bucket keys. */
export interface ClientIdentity {
  /** IPv4 as is, IPv6 as its /64, or "unknown". */
  readonly exact: string;
  /** The network it sits in: IPv4 as its /24, IPv6 as its /48, or "unknown". */
  readonly aggregate: string;
}

export const UNKNOWN_IDENTITY: ClientIdentity = Object.freeze({ exact: UNKNOWN_CLIENT, aggregate: UNKNOWN_CLIENT });

/** A network bucket (IPv4 /24, IPv6 /48) holds this many clients' allowance. */
export const CLIENT_AGGREGATE_FACTOR = 4;

const ipv4Identity = (address: string): ClientIdentity => ({
  exact: address,
  aggregate: `${address.slice(0, address.lastIndexOf("."))}.0/24`,
});

/**
 * Both keys from one IP literal: IPv4 as is, IPv4-mapped IPv6 unwrapped, IPv6
 * truncated to its /64 (one connection owns a /64, and rotating inside it must
 * not mint buckets) and to its /48 (one subscriber or tunnel owns a /48, and
 * rotating /64s inside it must not mint them either). Null for anything that is
 * not a single IP.
 */
export function normalizeClientIdentity(raw: string): ClientIdentity | null {
  let text = raw.trim();
  if (text.startsWith("[")) {
    const close = text.indexOf("]");
    if (close < 0) return null;
    text = text.slice(1, close);
  } else if (/^\d{1,3}(\.\d{1,3}){3}:\d{1,5}$/.test(text)) {
    text = text.slice(0, text.lastIndexOf(":"));
  }
  const zone = text.indexOf("%");
  if (zone >= 0) text = text.slice(0, zone);
  const kind = isIP(text);
  if (kind === 4) return ipv4Identity(text);
  if (kind !== 6) return null;
  const groups = expandIpv6(text.toLowerCase());
  if (groups === null) return null;
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    const high = groups[6]!;
    const low = groups[7]!;
    return ipv4Identity(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`);
  }
  const prefix = (count: number): string => groups.slice(0, count).map((group) => group.toString(16)).join(":");
  return { exact: `${prefix(4)}::/64`, aggregate: `${prefix(3)}::/48` };
}

/** The exact key alone (IPv4 address, IPv6 /64). Null for anything that is not a single IP. */
export function normalizeClientIp(raw: string): string | null {
  return normalizeClientIdentity(raw)?.exact ?? null;
}

/** Both bucket keys for a request: from the trusted header's IP, or the shared "unknown" identity. */
export function clientIdentityFromHeaders(headers: Headers, trustedHeader: string | null): ClientIdentity {
  if (trustedHeader === null || trustedHeader === "") return UNKNOWN_IDENTITY;
  const value = headers.get(trustedHeader);
  if (value === null) return UNKNOWN_IDENTITY;
  return normalizeClientIdentity(value) ?? UNKNOWN_IDENTITY;
}

/** The exact bucket key for a request: the trusted header's IP, or the shared "unknown" bucket. */
export function clientKeyFromHeaders(headers: Headers, trustedHeader: string | null): string {
  return clientIdentityFromHeaders(headers, trustedHeader).exact;
}
