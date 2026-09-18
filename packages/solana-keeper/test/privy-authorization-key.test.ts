// The local half of `privy-policy key`: deriving a Privy authorization key's
// PUBLIC key, and comparing it with a quorum's registered ones.
//
// THE GROUND TRUTH IS PRIVY'S OWN GENERATOR. generateP256KeyPair returns the
// pair exactly as Privy stores it — the base64 SPKI `publicKey` is the string
// the dashboard shows and the quorum registers — so a derivation that reproduces
// it from the private half is right by construction. Keys are generated per run,
// used against nothing, and no network is touched.
//
// THE SHAPES MATTER AS MUCH AS THE MATH. @privy-io/node signs with whatever 32
// bytes follow the first 0x04 0x20 of the base64-decoded value, and Node's
// base64 decoder drops characters it does not recognise: a prefix, quotes,
// whitespace, 64-column wrapping and a cut-off tail all sign identically. Each
// is pinned below, because a check stricter than the SDK would call a working
// key malformed.

import { generateP256KeyPair } from "@privy-io/node";
import { AuthenticationError, APIConnectionError, NotFoundError, PermissionDeniedError } from "@privy-io/node";
import { describe, expect, it } from "vitest";
import {
  AUTHORIZATION_KEY_BROKEN,
  AuthorizationKeyUnreadable,
  compareWithQuorum,
  derivePrivyPublicKey,
  normalizeSpki,
  notCheckedVerdict,
  quorumReadVerdict,
  unreadableKeyVerdict,
} from "../src/privy-authorization-key.js";

/** Throwaway: generated per run, registered nowhere, never used against Privy. */
const pair = await generateP256KeyPair();
const other = await generateP256KeyPair();

const quorum = (...publicKeys: string[]) => ({
  id: "keeperSignerQuorum0001",
  authorizationKeys: publicKeys.map((publicKey, index) => ({ publicKey, displayName: index === 0 ? "sip-solana-keeper" : null })),
});

const headers = new Headers();

describe("derivePrivyPublicKey", () => {
  it("reproduces the public key Privy's own generator returns", () => {
    expect(derivePrivyPublicKey(pair.privateKey)).toBe(pair.publicKey);
    // What Privy registers and displays: base64 SPKI, no PEM headers.
    expect(pair.publicKey).toMatch(/^MFkwEwYHKoZI/);
    expect(pair.publicKey).toHaveLength(124);
  });

  it("derives different public keys for different private keys", () => {
    expect(derivePrivyPublicKey(other.privateKey)).toBe(other.publicKey);
    expect(other.publicKey).not.toBe(pair.publicKey);
  });

  // EVERY ONE OF THESE SIGNS IDENTICALLY AT PRIVY, so every one of them must
  // derive the same public key here. isP256Pkcs8PrivateKey rejects all of them,
  // which is why `key` does not use it as its oracle.
  const tolerated: Readonly<Record<string, string>> = {
    "the wallet-auth: prefix the dashboard shows": `wallet-auth:${pair.privateKey}`,
    "the wallet-api: prefix": `wallet-api:${pair.privateKey}`,
    "a trailing newline": `${pair.privateKey}\n`,
    "surrounding spaces": `  ${pair.privateKey}  `,
    "double quotes from a shell paste": `"${pair.privateKey}"`,
    "single quotes from a shell paste": `'${pair.privateKey}'`,
    "64-column wrapping": pair.privateKey.replace(/(.{64})/g, "$1\n"),
    // The scalar sits near the FRONT of the DER, so cutting the tail leaves it whole.
    "a tail cut off": pair.privateKey.slice(0, -20),
  };
  for (const [what, value] of Object.entries(tolerated)) {
    it(`derives the same public key through ${what}`, () => {
      expect(derivePrivyPublicKey(value)).toBe(pair.publicKey);
    });
  }

  const unreadable: Readonly<Record<string, { value: string; reason: string }>> = {
    "an empty value": { value: "", reason: "NO_PRIVATE_KEY" },
    "plain words": { value: "not-a-key", reason: "NO_PRIVATE_KEY" },
    "a PEM block": { value: `-----BEGIN PRIVATE KEY-----\n${pair.privateKey}\n-----END PRIVATE KEY-----`, reason: "NO_PRIVATE_KEY" },
  };
  for (const [what, { value, reason }] of Object.entries(unreadable)) {
    it(`refuses ${what}`, () => {
      expect(() => derivePrivyPublicKey(value)).toThrow(AuthorizationKeyUnreadable);
      try {
        derivePrivyPublicKey(value);
      } catch (error) {
        expect((error as AuthorizationKeyUnreadable).reason).toBe(reason);
        // NEVER THE VALUE: a refusal quoting the key would print the secret.
        if (value !== "") expect((error as Error).message).not.toContain(value);
      }
    });
  }

  it("names a truncation that stops inside the scalar", () => {
    // The marker, then fewer than the 32 bytes that must follow it.
    const short = Buffer.concat([Buffer.from([0x30, 0x10, 0x04, 0x20]), Buffer.alloc(9, 7)]).toString("base64");
    try {
      derivePrivyPublicKey(short);
      expect.unreachable("a 9-byte scalar is not a key");
    } catch (error) {
      expect((error as AuthorizationKeyUnreadable).reason).toBe("TRUNCATED");
      expect((error as Error).message).toContain("9 of the 32 bytes");
    }
  });

  // NODE ACCEPTS BOTH OF THESE AND @noble/curves, WHICH THE SDK SIGNS WITH, DOES
  // NOT: a zero scalar exports a 36-character stub, and 32 bytes of 0xff export a
  // full-length public key that could never be registered anywhere. A key like
  // that throws inside the SDK before any request, so reporting a derived public
  // key for it would be a fiction with a plausible shape.
  const offCurve: Readonly<Record<string, Buffer>> = {
    "a scalar of zero": Buffer.alloc(32, 0),
    "a scalar past the curve's order": Buffer.alloc(32, 0xff),
  };
  for (const [what, scalar] of Object.entries(offCurve)) {
    it(`refuses ${what}`, () => {
      const value = Buffer.concat([Buffer.from([0x04, 0x20]), scalar]).toString("base64");
      try {
        derivePrivyPublicKey(value);
        expect.unreachable("not a private key");
      } catch (error) {
        expect((error as AuthorizationKeyUnreadable).reason).toBe("NOT_ON_THE_CURVE");
      }
    });
  }
});

describe("compareWithQuorum", () => {
  it("matches a quorum that registers this key", () => {
    const verdict = compareWithQuorum(pair.publicKey, quorum(pair.publicKey));
    expect(verdict.check).toBe("matches");
    expect(verdict.derivedPublicKey).toBe(pair.publicKey);
    expect(verdict.registered).toEqual([{ publicKey: pair.publicKey, displayName: "sip-solana-keeper" }]);
  });

  it("matches one key among several", () => {
    expect(compareWithQuorum(pair.publicKey, quorum(other.publicKey, pair.publicKey)).check).toBe("matches");
  });

  // PRIVY'S OWN EXAMPLES WRAP REGISTERED KEYS AT 64 COLUMNS. A === against the
  // single-line derived key would call the RIGHT key a mismatch, and send an
  // operator to re-seat a working credential.
  it("matches a registered key that carries line breaks", () => {
    const wrapped = pair.publicKey.replace(/(.{64})/g, "$1\n");
    expect(wrapped).not.toBe(pair.publicKey);
    const verdict = compareWithQuorum(pair.publicKey, quorum(wrapped));
    expect(verdict.check).toBe("matches");
    // What was compared is what is reported.
    expect(verdict.registered?.[0]?.publicKey).toBe(pair.publicKey);
  });

  it("says not-in-quorum when the quorum holds a different key", () => {
    const verdict = compareWithQuorum(pair.publicKey, quorum(other.publicKey));
    expect(verdict.check).toBe("not-in-quorum");
    expect(verdict.derivedPublicKey).toBe(pair.publicKey);
    expect(verdict.registered?.map((entry) => entry.publicKey)).toEqual([other.publicKey]);
    expect(verdict.next).toContain("Authorization keys");
  });

  it("says not-in-quorum for a quorum that registers no keys at all", () => {
    const verdict = compareWithQuorum(pair.publicKey, quorum());
    expect(verdict.check).toBe("not-in-quorum");
    expect(verdict.registered).toEqual([]);
  });

  // THE EXPENSIVE VERDICT, GUARDED. A KeyQuorum's membership is three lists —
  // authorization_keys, user_ids AND key_quorum_ids (nested, one level deep) —
  // and this check reads only the first. A keeper's key seated through a nested
  // quorum or a user signs perfectly well and is absent from the direct list, so
  // calling that not-in-quorum tells an operator the 401's cause has been found
  // and sends him to regenerate a working credential: new key, new signer id,
  // every trading wallet re-seated by its user, with each user present.
  describe("a quorum with members this check cannot read", () => {
    for (const [what, over] of [
      ["a nested key quorum", { keyQuorumIds: ["cbxnested00000000000001"] }],
      ["a member user", { userIds: ["did:privy:someuser0000001"] }],
      ["both", { keyQuorumIds: ["cbxnested00000000000001"], userIds: ["did:privy:someuser0000001"] }],
    ] as const) {
      it(`says members-unresolved, not not-in-quorum, for ${what}`, () => {
        const verdict = compareWithQuorum(pair.publicKey, { ...quorum(other.publicKey), ...over });
        expect(verdict.check).toBe("members-unresolved");
        // UNPROVEN IS NOT BROKEN: this must not page critical, and must not send
        // anyone to the lost-key procedure.
        expect(AUTHORIZATION_KEY_BROKEN.has(verdict.check)).toBe(false);
        expect(verdict.next).toContain("Do not regenerate anything yet");
        // AND IT SAYS WHERE TO LOOK, without naming a person.
        expect(verdict.unresolvedMembers).toEqual({
          keyQuorumIds: over.keyQuorumIds ?? [],
          users: over.userIds?.length ?? 0,
        });
        expect(JSON.stringify(verdict)).not.toContain("did:privy:");
      });
    }

    // The key being THERE settles it whatever else the quorum holds.
    it("still matches when the derived key is one of the direct keys", () => {
      const verdict = compareWithQuorum(pair.publicKey, {
        ...quorum(pair.publicKey),
        keyQuorumIds: ["cbxnested00000000000001"],
        userIds: ["did:privy:someuser0000001"],
      });
      expect(verdict.check).toBe("matches");
    });

    // A quorum of public keys and nothing else is the only one whose membership
    // is fully known, and the only one an absence can be proved against.
    it("keeps not-in-quorum for a quorum whose membership is fully known", () => {
      for (const over of [{}, { keyQuorumIds: [] }, { userIds: [] }, { keyQuorumIds: [], userIds: [] }]) {
        const verdict = compareWithQuorum(pair.publicKey, { ...quorum(other.publicKey), ...over });
        expect(verdict.check).toBe("not-in-quorum");
        expect(verdict.unresolvedMembers).toEqual({ keyQuorumIds: [], users: 0 });
      }
    });
  });

  it("carries a meaning and a next step for every verdict", () => {
    for (const verdict of [
      compareWithQuorum(pair.publicKey, quorum(pair.publicKey)),
      compareWithQuorum(pair.publicKey, quorum(other.publicKey)),
      compareWithQuorum(pair.publicKey, { ...quorum(other.publicKey), keyQuorumIds: ["cbxnested00000000000001"] }),
      unreadableKeyVerdict(),
      notCheckedVerdict(),
      quorumReadVerdict(new NotFoundError(404, {}, undefined, headers), null),
    ]) {
      expect(verdict.meaning.length).toBeGreaterThan(20);
      expect(verdict.next.length).toBeGreaterThan(20);
    }
  });
});

describe("quorumReadVerdict", () => {
  it("reads 404 as an id this app does not have", () => {
    expect(quorumReadVerdict(new NotFoundError(404, {}, undefined, headers), pair.publicKey).check).toBe("quorum-not-found");
  });

  it("reads 401 and 403 as the app credentials", () => {
    expect(quorumReadVerdict(new AuthenticationError(401, {}, undefined, headers), null).check).toBe("credentials-refused");
    expect(quorumReadVerdict(new PermissionDeniedError(403, {}, undefined, headers), null).check).toBe("credentials-refused");
  });

  // UNKNOWN IS NOT WRONG. Only not-in-quorum and key-unreadable are evidence of a
  // broken keeper; a dropped connection proves nothing and must not read as proof.
  it("reads anything else as unknown, not as a mismatch", () => {
    const verdict = quorumReadVerdict(new APIConnectionError({ message: "socket hang up" }), pair.publicKey);
    expect(verdict.check).toBe("quorum-unreadable");
    expect(verdict.derivedPublicKey).toBe(pair.publicKey);
    expect(AUTHORIZATION_KEY_BROKEN.has(verdict.check)).toBe(false);
  });

  it("counts only a mismatch and an unreadable key as broken", () => {
    expect([...AUTHORIZATION_KEY_BROKEN].sort()).toEqual(["key-unreadable", "not-in-quorum"]);
  });
});

describe("normalizeSpki", () => {
  it("removes every kind of whitespace and nothing else", () => {
    expect(normalizeSpki(" MFkw\nEwYH\tKoZI\r\n")).toBe("MFkwEwYHKoZI");
    expect(normalizeSpki(pair.publicKey)).toBe(pair.publicKey);
  });
});
