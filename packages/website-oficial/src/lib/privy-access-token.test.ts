// Who is asking, from Privy's access token and Privy's PUBLISHED keys — no secret (owner, 10-23). Signed here
// with a key pair made for the test and checked against a local key set, so nothing reaches the network:
// the good token, and every way a token is not one this server can believe.

import { SignJWT, createLocalJWKSet, errors, exportJWK, generateKeyPair, type JWTVerifyGetKey } from "jose";
import { beforeAll, describe, expect, it } from "vitest";

import { bearerTokenOf, privyJwksUrl, verifyPrivyAccessToken } from "@/lib/privy-access-token";

const APP_ID = "cmtrt36tb00080dlbrda5aqam";
const USER = "did:privy:cm1testuser0000000000000a";
const NOW = Date.UTC(2026, 9, 23, 12, 0, 0);
const KID = "test-key-1";

type Key = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
let signer: Key;
let stranger: Key;
let keys: JWTVerifyGetKey;

beforeAll(async () => {
  const pair = await generateKeyPair("ES256", { extractable: true });
  signer = pair.privateKey;
  stranger = (await generateKeyPair("ES256")).privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: KID, alg: "ES256", use: "sig" };
  keys = createLocalJWKSet({ keys: [jwk] });
});

/** A token as Privy issues one: ES256, typ JWT, iss privy.io, aud the app, sub the user, sid the session, an hour long. */
async function token(over: { claims?: Record<string, unknown>; key?: Key; kid?: string; alg?: string; issuedAt?: number; expiresAt?: number } = {}): Promise<string> {
  const issuedAt = over.issuedAt ?? Math.floor(NOW / 1_000) - 60;
  return new SignJWT({ sid: "session-1", ...over.claims })
    .setProtectedHeader({ alg: over.alg ?? "ES256", typ: "JWT", kid: over.kid ?? KID })
    .setIssuer("privy.io")
    .setAudience(APP_ID)
    .setSubject(USER)
    .setIssuedAt(issuedAt)
    .setExpirationTime(over.expiresAt ?? issuedAt + 3_600)
    .sign(over.key ?? signer);
}

const verify = (jwt: string | null, keySet: JWTVerifyGetKey = keys) => verifyPrivyAccessToken(jwt, { appId: APP_ID, keys: keySet, now: () => NOW });

describe("verifyPrivyAccessToken", () => {
  it("believes a live token signed with a published key, and names its user", async () => {
    expect(await verify(await token())).toEqual({ ok: true, userId: USER });
  });

  it("refuses an expired token as expired, so the browser asks Privy for a fresh one", async () => {
    const issuedAt = Math.floor(NOW / 1_000) - 7_200;
    expect(await verify(await token({ issuedAt, expiresAt: issuedAt + 3_600 }))).toEqual({ ok: false, status: 401, code: "token_expired" });
  });

  it("refuses another app's token, another issuer's, and a forged one", async () => {
    const otherApp = await new SignJWT({ sid: "s" }).setProtectedHeader({ alg: "ES256", typ: "JWT", kid: KID }).setIssuer("privy.io").setAudience("someotherappid00000000000").setSubject(USER).setIssuedAt(Math.floor(NOW / 1_000)).setExpirationTime(Math.floor(NOW / 1_000) + 600).sign(signer);
    const otherIssuer = await new SignJWT({ sid: "s" }).setProtectedHeader({ alg: "ES256", typ: "JWT", kid: KID }).setIssuer("evil.example").setAudience(APP_ID).setSubject(USER).setIssuedAt(Math.floor(NOW / 1_000)).setExpirationTime(Math.floor(NOW / 1_000) + 600).sign(signer);
    for (const jwt of [otherApp, otherIssuer, await token({ key: stranger })]) {
      expect(await verify(jwt)).toEqual({ ok: false, status: 401, code: "token_invalid" });
    }
  });

  it("refuses a key Privy never published, and an algorithm it does not use", async () => {
    expect(await verify(await token({ kid: "unknown-kid" }))).toEqual({ ok: false, status: 401, code: "token_invalid" });
    const hmac = await new SignJWT({ sid: "s" })
      .setProtectedHeader({ alg: "HS256", typ: "JWT", kid: KID })
      .setIssuer("privy.io")
      .setAudience(APP_ID)
      .setSubject(USER)
      .setIssuedAt(Math.floor(NOW / 1_000))
      .setExpirationTime(Math.floor(NOW / 1_000) + 600)
      .sign(new TextEncoder().encode("a shared secret anyone could guess at all"));
    expect(await verify(hmac)).toEqual({ ok: false, status: 401, code: "token_invalid" });
  });

  it("refuses a token without a session, or whose subject is not a Privy user id", async () => {
    expect(await verify(await token({ claims: { sid: undefined } }))).toEqual({ ok: false, status: 401, code: "token_invalid" });
    const notADid = await new SignJWT({ sid: "s" }).setProtectedHeader({ alg: "ES256", typ: "JWT", kid: KID }).setIssuer("privy.io").setAudience(APP_ID).setSubject("../../wallet-names/x").setIssuedAt(Math.floor(NOW / 1_000)).setExpirationTime(Math.floor(NOW / 1_000) + 600).sign(signer);
    expect(await verify(notADid)).toEqual({ ok: false, status: 401, code: "token_invalid" });
  });

  it("refuses no token, and junk", async () => {
    expect(await verify(null)).toEqual({ ok: false, status: 401, code: "no_token" });
    expect(await verify("")).toEqual({ ok: false, status: 401, code: "no_token" });
    expect(await verify("not.a.token")).toEqual({ ok: false, status: 401, code: "token_invalid" });
  });

  it("answers 503, never 401, when Privy's keys cannot be had: an outage is not a logout", async () => {
    const jwt = await token();
    const unreachable: JWTVerifyGetKey = async () => {
      throw new TypeError("fetch failed");
    };
    const slow: JWTVerifyGetKey = async () => {
      throw new errors.JWKSTimeout();
    };
    expect(await verify(jwt, unreachable)).toEqual({ ok: false, status: 503, code: "auth_unavailable" });
    expect(await verify(jwt, slow)).toEqual({ ok: false, status: 503, code: "auth_unavailable" });
  });
});

describe("bearerTokenOf", () => {
  const request = (authorization?: string) => new Request("https://saverfi.cash/api/wallet-names", authorization === undefined ? {} : { headers: { authorization } });

  it("reads the token from Authorization: Bearer, whatever the scheme's case", () => {
    expect(bearerTokenOf(request("Bearer abc.def.ghi"))).toBe("abc.def.ghi");
    expect(bearerTokenOf(request("bearer abc.def.ghi"))).toBe("abc.def.ghi");
  });

  it("reads nothing else", () => {
    expect(bearerTokenOf(request())).toBeNull();
    expect(bearerTokenOf(request("Basic dXNlcjpwYXNz"))).toBeNull();
    expect(bearerTokenOf(request("Bearer a b"))).toBeNull();
    expect(bearerTokenOf(request("Bearer"))).toBeNull();
  });
});

describe("Privy's key set", () => {
  it("is the app's published JWKS, the URL Privy's own server SDK reads", () => {
    expect(privyJwksUrl(APP_ID).href).toBe(`https://api.privy.io/v1/apps/${APP_ID}/jwks.json`);
  });
});
