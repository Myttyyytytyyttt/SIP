// The overlapping deploy — the scenario the singleton lock exists for, and the
// one it was broken in. Ported from Nuvem's keeper/test/singleton.test.mts
// (node:test) to vitest, plus the lock key SIP derives.
//
// The bug it caught in review: the claim was attempted once at startup and
// `live` was frozen from it, so the container Railway boots WHILE THE OLD ONE IS
// STILL RUNNING lost that race — as it must — and then never acted again. Every
// ordinary deploy left a keeper that settled nothing with /health green.
//
// The fake below models the one property of a Postgres advisory lock that
// matters here: exactly one holder at a time, released with the session. No
// database is needed to reproduce the failure, because the failure was never in
// the database.

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { KEEPER_LOCK_NAME, KeeperClaim, advisoryKeyFor } from "../src/singleton.js";

/** One lock, one holder — the semantics of pg_try_advisory_lock on one key. */
function makeLock() {
  let holder: string | null = null;
  return {
    get holder() {
      return holder;
    },
    attemptFor(who: string) {
      return async () => {
        if (holder !== null) return { held: false };
        holder = who;
        return {
          held: true,
          release: () => {
            if (holder === who) holder = null;
          },
        };
      };
    },
  };
}

describe("the lock key", () => {
  it("is the worker's derivation over the name sip-solana-keeper, pinned by recomputing sha256 here", () => {
    expect(KEEPER_LOCK_NAME).toBe("sip-solana-keeper");
    const digest = createHash("sha256").update("sip-solana-keeper").digest();
    const expected = BigInt.asIntN(64, digest.readBigUInt64BE(0));
    expect(advisoryKeyFor(KEEPER_LOCK_NAME)).toBe(expected);
    // Signed 64-bit, which is what pg_advisory_lock takes.
    expect(expected >= -(2n ** 63n) && expected < 2n ** 63n).toBe(true);
    // And never the worker's own lock: two services on one database must not share a key.
    expect(advisoryKeyFor(KEEPER_LOCK_NAME)).not.toBe(advisoryKeyFor("sip-worker"));
  });
});

describe("the claim", () => {
  it("THE OVERLAPPING DEPLOY: the newcomer loses, waits, and takes over", async () => {
    const lock = makeLock();

    // The container already running, armed and holding the claim.
    const outgoing = new KeeperClaim({ armed: true, attempt: lock.attemptFor("old") });
    expect(await outgoing.ensure()).toBe(true);
    expect(outgoing.live, "the running container should be acting").toBe(true);

    // Railway boots the replacement while the old one is still up.
    let tookOver = 0;
    const incoming = new KeeperClaim({
      armed: true,
      attempt: lock.attemptFor("new"),
      onTakeover: () => (tookOver += 1),
    });

    expect(await incoming.ensure(), "it must lose the startup race").toBe(false);
    expect(incoming.live, "and must not act while someone else holds the claim").toBe(false);

    // Several sweeps pass with the old container still alive. THIS is where the
    // original bug lived: it stayed dry here forever.
    for (let sweep = 0; sweep < 5; sweep++) {
      expect(await incoming.ensure()).toBe(false);
      expect(incoming.live).toBe(false);
    }
    expect(tookOver, "no takeover while the claim is held elsewhere").toBe(0);

    // SIGTERM: the outgoing container lets go.
    outgoing.release();
    expect(outgoing.live, "a released claim must stop acting immediately").toBe(false);

    // The next sweep of the surviving container.
    expect(await incoming.ensure(), "it must take over once the claim is free").toBe(true);
    expect(incoming.live, "and start acting").toBe(true);
    expect(tookOver, "the takeover is announced exactly once").toBe(1);
  });

  it("the takeover fires once, not on every later sweep", async () => {
    const lock = makeLock();
    let announced = 0;
    const claim = new KeeperClaim({
      armed: true,
      attempt: lock.attemptFor("only"),
      onTakeover: () => (announced += 1),
    });
    for (let sweep = 0; sweep < 4; sweep++) await claim.ensure();
    expect(announced, "an announcement per sweep is an announcement that gets muted").toBe(1);
  });

  it("a failed claim never counts as a held one", async () => {
    // The other half of the same review finding: claimSingleton returned
    // held:true when the attempt ERRORED, sending an armed keeper live without
    // the lock — precisely what the lock exists to prevent.
    const claim = new KeeperClaim({
      armed: true,
      attempt: async () => ({ held: false }),
    });
    expect(await claim.ensure()).toBe(false);
    expect(claim.live, "an unclaimed keeper must not act").toBe(false);
  });

  it("an unarmed keeper claims nothing and acts on nothing", async () => {
    const lock = makeLock();
    const claim = new KeeperClaim({ armed: false, attempt: lock.attemptFor("dry") });
    await claim.ensure();
    expect(claim.live, "dry run is dry regardless of the claim").toBe(false);
    expect(lock.holder, "an unarmed instance must not take the lock from an armed one").toBeNull();
  });

  it("with no lock to take, an armed keeper still acts", async () => {
    // No DATABASE_URL. Exclusivity is unenforced and the keeper says so
    // elsewhere; refusing to act would disable the keeper for no benefit.
    let attempts = 0;
    const claim = new KeeperClaim({
      armed: true,
      unenforced: true,
      attempt: async () => {
        attempts += 1;
        return { held: true };
      },
    });
    expect(claim.live).toBe(true);
    await claim.ensure();
    expect(attempts, "there is nothing to claim, so nothing should be asked for").toBe(0);
  });

  it("releasing frees the lock for the next instance", async () => {
    const lock = makeLock();
    const first = new KeeperClaim({ armed: true, attempt: lock.attemptFor("first") });
    await first.ensure();
    expect(lock.holder).toBe("first");
    first.release();
    expect(lock.holder, "SIGTERM must hand the claim over, not leave it stale").toBeNull();

    const second = new KeeperClaim({ armed: true, attempt: lock.attemptFor("second") });
    expect(await second.ensure()).toBe(true);
    expect(second.live).toBe(true);
  });

  it("a claim lost with its session stops acting and is asked for again", async () => {
    const lock = makeLock();
    const claim = new KeeperClaim({ armed: true, attempt: lock.attemptFor("keeper") });
    await claim.ensure();
    expect(claim.live).toBe(true);
    // What the keeper does when the held connection errors.
    claim.release();
    expect(claim.live).toBe(false);
    expect(await claim.ensure()).toBe(true);
    expect(claim.live).toBe(true);
  });
});
