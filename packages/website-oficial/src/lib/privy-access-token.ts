/**
 * WHO IS ASKING, FROM PRIVY'S ACCESS TOKEN — WITH NO SECRET (owner, 10-23: the
 * wallet names are saved to the account, and nothing may ask for a signature
 * to do it).
 *
 * The web never holds Privy's app secret and refuses it by name
 * (src/lib/load-config.ts), so it cannot ask Privy's server API who a session
 * belongs to. It does not need to: Privy signs every access token (ES256) with
 * a key it PUBLISHES for the app, and checking that signature, the issuer, the
 * audience (this app's id) and the expiry is how Privy's own server SDK
 * verifies one (@privy-io/node 0.28 verifyAccessToken — the same URL, the same
 * claims, the same cache times). The user is the token's `sub`, a
 * did:privy:… id.
 *
 * THE KEY SET, NEVER ONE PASTED KEY. The published set held two keys when it
 * was read (10-23), so a single key in an env var would refuse half the
 * sessions on the day Privy rotates. The set is fetched by kid, cached an hour,
 * and re-fetched for an unknown kid at most every ten minutes.
 *
 * PRIVY BEING DOWN IS NOT BEING LOGGED OUT. A set that could not be fetched is
 * 503, never 401: the browser keeps the names it shows and says the save
 * failed, rather than acting as if the session had ended.
 *
 * The token is read from `Authorization: Bearer` and nowhere else — never a
 * URL, never a cookie (the web does not run Privy's HttpOnly cookie mode) —
 * and it is never logged, nor is the id it yields.
 */
import "server-only";

import { createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey } from "jose";

/** Privy's published key set for one app: the URL @privy-io/node's createPrivyAppJWKS builds. */
export const privyJwksUrl = (appId: string): URL => new URL(`https://api.privy.io/v1/apps/${encodeURIComponent(appId)}/jwks.json`);

/** A Privy user id as the token's `sub` carries it. Anything else is not a Privy session. */
const PRIVY_DID = /^did:privy:[A-Za-z0-9]{10,64}$/;

export type AccessCheck =
  | { readonly ok: true; readonly userId: string }
  | {
      readonly ok: false;
      /** 401: no session this server can believe. 503: Privy's keys could not be read, so nothing was decided. */
      readonly status: 401 | 503;
      readonly code: "no_token" | "token_expired" | "token_invalid" | "auth_unavailable";
    };

const SETS = Symbol.for("sip.web.privy.jwks");

/**
 * One remote set per app id, on globalThis like the routes' budgets, so the
 * route's bundles share one cache and one cooldown rather than one each.
 */
function remoteSetOf(appId: string): JWTVerifyGetKey {
  const holder = globalThis as unknown as Record<symbol, Map<string, JWTVerifyGetKey> | undefined>;
  const sets = (holder[SETS] ??= new Map());
  let set = sets.get(appId);
  if (set === undefined) {
    set = createRemoteJWKSet(privyJwksUrl(appId), { cacheMaxAge: 60 * 60_000, cooldownDuration: 10 * 60_000, timeoutDuration: 5_000 });
    sets.set(appId, set);
  }
  return set;
}

/**
 * WHAT THE TOKEN ITSELF GOT WRONG — the only failures that are 401: a bad
 * signature, a key Privy never published, the wrong issuer, audience, type or
 * algorithm, a malformed token. Listed by name, so every failure not named
 * here — jose's bare JOSEError for a key set answered with a 503, above all —
 * counts as Privy being unreachable, never as the session having ended.
 */
const TOKEN_FAULTS = [
  errors.JWSSignatureVerificationFailed,
  errors.JWTClaimValidationFailed,
  errors.JWTInvalid,
  errors.JWSInvalid,
  errors.JOSEAlgNotAllowed,
  errors.JOSENotSupported,
  errors.JWKSNoMatchingKey,
  errors.JWKSMultipleMatchingKeys,
] as const;

/** The bearer token of a request, or null. Case-insensitive scheme, one token, nothing else. */
export function bearerTokenOf(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (header === null) return null;
  const match = /^Bearer[ ]+([A-Za-z0-9._~+/=-]+)[ ]*$/i.exec(header);
  return match === null ? null : match[1]!;
}

export interface VerifyOptions {
  /** This app's Privy id: the token's audience. */
  readonly appId: string;
  /** The key set. Default: Privy's published one for `appId`. Tests pass a local set. */
  readonly keys?: JWTVerifyGetKey;
  /** The clock, in ms. Default Date.now. */
  readonly now?: () => number;
}

/** Whether `token` is a live Privy access token for this app, and whose. */
export async function verifyPrivyAccessToken(token: string | null, options: VerifyOptions): Promise<AccessCheck> {
  if (token === null || token === "") return { ok: false, status: 401, code: "no_token" };
  try {
    const { payload } = await jwtVerify(token, options.keys ?? remoteSetOf(options.appId), {
      issuer: "privy.io",
      audience: options.appId,
      algorithms: ["ES256"],
      typ: "JWT",
      requiredClaims: ["sub", "sid", "iat", "exp"],
      currentDate: new Date((options.now ?? Date.now)()),
    });
    const userId = payload.sub;
    if (typeof userId !== "string" || !PRIVY_DID.test(userId) || typeof payload.sid !== "string") return { ok: false, status: 401, code: "token_invalid" };
    return { ok: true, userId };
  } catch (error) {
    if (error instanceof errors.JWTExpired) return { ok: false, status: 401, code: "token_expired" };
    if (TOKEN_FAULTS.some((fault) => error instanceof fault)) return { ok: false, status: 401, code: "token_invalid" };
    // Anything else is the key set that could not be had, and nothing about the token was decided: a
    // timeout, no answer at all (fetch throws a TypeError, no JOSE error), and — as a bare JOSEError —
    // an answer that is not 200 (a 5xx, a 429, a redirect) or not JSON.
    return { ok: false, status: 503, code: "auth_unavailable" };
  }
}
