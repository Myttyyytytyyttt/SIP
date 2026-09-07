// What a keeper calls itself in Postgres, and why it is not cosmetic.
//
// This string is the only thing a blocked instance can learn about the one
// holding the lock. It has to survive Postgres truncating application_name at 63
// bytes, and it has to carry the mode — because "another instance has it" is
// reassuring when that instance is armed and is a total outage when it is not.

import { describe, expect, it } from "vitest";

import { classifyLockHolder, keeperApplicationName, sslOptionsFor } from "../src/ledger-pg.js";

describe("deciding what is holding a lock", () => {
  /**
   * THE ONE THAT LET AN OUTAGE RUN SILENTLY. The first version asked only
   * "does the name contain dry-run?" and cleared the alert on every other
   * answer. Through Supavisor the answer is the literal "Supavisor" — the
   * pooler overwrites application_name — so for four consecutive sweeps the
   * supervisor ACTIVELY CLEARED the only alert that could have fired, while an
   * orphaned pooled backend held the account and nothing was settled.
   */
  it("does not mistake a connection pooler for a keeper", () => {
    const verdict = classifyLockHolder({ applicationName: "Supavisor", since: null, state: "idle" });
    expect(verdict.kind).toBe("NOT_A_KEEPER");
  });

  it("treats an unnamed connection as not a keeper", () => {
    expect(classifyLockHolder({ applicationName: null, since: null, state: null }).kind).toBe(
      "NOT_A_KEEPER",
    );
    // And an absent holder — Postgres would not say who — is equally not proof
    // of a healthy sibling.
    expect(classifyLockHolder(undefined).kind).toBe("NOT_A_KEEPER");
  });

  it("recognises an armed keeper", () => {
    const verdict = classifyLockHolder({
      applicationName: keeperApplicationName({ broadcast: true, env: { RAILWAY_DEPLOYMENT_ID: "abcdef12" } }),
      since: null,
      state: "idle",
    });
    expect(verdict).toEqual({ kind: "KEEPER", armed: true });
  });

  it("recognises a dry-run keeper as unarmed", () => {
    const verdict = classifyLockHolder({
      applicationName: keeperApplicationName({ broadcast: false, env: {} }),
      since: null,
      state: "idle",
    });
    expect(verdict).toEqual({ kind: "KEEPER", armed: false });
  });

  it("does not assume armed when a keeper's mode cannot be read", () => {
    // Guessing "armed" here would suppress the dry-run alarm, which is the
    // failure this whole classification exists to prevent.
    const verdict = classifyLockHolder({ applicationName: "nuvem-keeper ", since: null, state: null });
    expect(verdict).toEqual({ kind: "KEEPER", armed: false });
  });

  it("is not fooled by a name that merely mentions a keeper", () => {
    // Something else on the database calling itself "psql nuvem-keeper debug"
    // must not be able to pass as one and silence the alert.
    expect(classifyLockHolder({ applicationName: "psql nuvem-keeper debug", since: null, state: null }).kind)
      .toBe("NOT_A_KEEPER");
  });
});

describe("TLS for a journal connection", () => {
  /**
   * THE ONLY DIRECTION THAT MATTERS. Getting this wrong the safe way is a
   * connection that refuses to open; getting it wrong the other way ships the
   * journal — and the credentials that open it — in plaintext.
   */
  it("encrypts by default", () => {
    expect(sslOptionsFor("postgresql://u:p@db.example.com:5432/postgres")).toEqual({
      rejectUnauthorized: false,
    });
  });

  it("encrypts a real Supabase pooler URL", () => {
    expect(
      sslOptionsFor("postgresql://postgres.abc:pw@aws-0-eu-west-2.pooler.supabase.com:5432/postgres"),
    ).toEqual({ rejectUnauthorized: false });
  });

  it("encrypts when the string cannot be parsed at all", () => {
    // An unparseable string means nothing was explicitly disabled. Falling back
    // to plaintext on a parse failure would be a plaintext production database
    // caused by a typo.
    expect(sslOptionsFor("not a url")).toEqual({ rejectUnauthorized: false });
    expect(sslOptionsFor("")).toEqual({ rejectUnauthorized: false });
  });

  it("encrypts for every sslmode except disable", () => {
    for (const mode of ["require", "verify-full", "verify-ca", "prefer", "allow"]) {
      expect(sslOptionsFor(`postgresql://u:p@h:5432/db?sslmode=${mode}`)).toEqual({
        rejectUnauthorized: false,
      });
    }
  });

  it("honours an explicit sslmode=disable, so the journal is testable locally", () => {
    // Without this the advisory lock — the thing that stops two keepers settling
    // for one user — could only be exercised against production infrastructure,
    // which means in practice it stops being exercised.
    expect(sslOptionsFor("postgresql://postgres:test@127.0.0.1:55433/nuvem?sslmode=disable")).toBe(
      false,
    );
  });

  it("is not tricked by sslmode=disable appearing somewhere other than the query", () => {
    // A password or database name containing the phrase must not turn TLS off.
    expect(sslOptionsFor("postgresql://u:sslmode=disable@h:5432/db")).toEqual({
      rejectUnauthorized: false,
    });
    expect(sslOptionsFor("postgresql://u:p@h:5432/sslmode=disable")).toEqual({
      rejectUnauthorized: false,
    });
  });
});

describe("how a keeper identifies itself to Postgres", () => {
  /**
   * THE PART THAT CHANGES THE ANSWER. An armed keeper blocked by a dry-run one
   * looks exactly like a healthy multi-instance deployment in every log line,
   * while nothing at all is being settled. The supervisor keys a critical alert
   * off this substring.
   */
  it("says whether it is armed", () => {
    expect(keeperApplicationName({ broadcast: true, env: {} })).toContain("live");
    expect(keeperApplicationName({ broadcast: false, env: {} })).toContain("dry-run");
  });

  it("does not call a dry run live, nor the reverse", () => {
    expect(keeperApplicationName({ broadcast: false, env: {} })).not.toMatch(/\blive\b/);
  });

  it("carries the deployment and replica when the platform provides them", () => {
    const name = keeperApplicationName({
      broadcast: true,
      env: {
        RAILWAY_DEPLOYMENT_ID: "18773083-b626-45cc-a721-5a6c97cb52e4",
        RAILWAY_REPLICA_ID: "bb0059f4-794e-4d76-8a9d-fe0e27a36ad4",
      },
    });
    expect(name).toContain("d:18773083");
    expect(name).toContain("r:bb0059f4");
  });

  it("stays inside the 63 bytes Postgres keeps, so nothing is silently cut", () => {
    // Truncation happens server side and without complaint. Were it left to
    // Postgres it would eat the tail, which is the half that says which
    // container — leaving every instance looking identical.
    const name = keeperApplicationName({
      broadcast: true,
      env: {
        RAILWAY_DEPLOYMENT_ID: "18773083-b626-45cc-a721-5a6c97cb52e4",
        RAILWAY_REPLICA_ID: "bb0059f4-794e-4d76-8a9d-fe0e27a36ad4",
      },
    });
    expect(Buffer.byteLength(name)).toBeLessThanOrEqual(63);
    // And the mode survives, because it is what the alert reads.
    expect(name).toContain("live");
  });

  it("works on a platform that provides neither", () => {
    const name = keeperApplicationName({ broadcast: true, env: {} });
    expect(name).toContain("nuvem-keeper");
    expect(name).not.toContain("undefined");
  });

  it("ignores empty values, which a dashboard can produce by accident", () => {
    const name = keeperApplicationName({
      broadcast: false,
      env: { RAILWAY_DEPLOYMENT_ID: "", RAILWAY_REPLICA_ID: "" },
    });
    expect(name).not.toContain("d:");
    expect(name).not.toContain("r:");
  });
});
