// The overlapping deploy — the scenario the singleton lock exists for, and the
// one it was broken in.
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
//
// Run: node --test --experimental-strip-types keeper/test/*.test.mts

import assert from "node:assert/strict";
import { test } from "node:test";

import { SupervisorClaim } from "../src/singleton.ts";

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

test("THE OVERLAPPING DEPLOY: the newcomer loses, waits, and takes over", async () => {
  const lock = makeLock();

  // The container already running, armed and holding the claim.
  const outgoing = new SupervisorClaim({ armed: true, attempt: lock.attemptFor("old") });
  assert.equal(await outgoing.ensure(), true);
  assert.equal(outgoing.live, true, "the running container should be acting");

  // Railway boots the replacement while the old one is still up.
  let tookOver = 0;
  const incoming = new SupervisorClaim({
    armed: true,
    attempt: lock.attemptFor("new"),
    onTakeover: () => (tookOver += 1),
  });

  assert.equal(await incoming.ensure(), false, "it must lose the startup race");
  assert.equal(incoming.live, false, "and must not act while someone else holds the claim");

  // Several sweeps pass with the old container still alive. THIS is where the
  // original bug lived: it stayed dry here forever.
  for (let sweep = 0; sweep < 5; sweep++) {
    assert.equal(await incoming.ensure(), false);
    assert.equal(incoming.live, false);
  }
  assert.equal(tookOver, 0, "no takeover while the claim is held elsewhere");

  // SIGTERM: the outgoing container lets go.
  outgoing.release();
  assert.equal(outgoing.live, false, "a released claim must stop acting immediately");

  // The next sweep of the surviving container.
  assert.equal(await incoming.ensure(), true, "it must take over once the claim is free");
  assert.equal(incoming.live, true, "and start acting");
  assert.equal(tookOver, 1, "the takeover is announced exactly once");
});

test("the takeover fires once, not on every later sweep", async () => {
  const lock = makeLock();
  let announced = 0;
  const claim = new SupervisorClaim({
    armed: true,
    attempt: lock.attemptFor("only"),
    onTakeover: () => (announced += 1),
  });
  for (let sweep = 0; sweep < 4; sweep++) await claim.ensure();
  assert.equal(announced, 1, "an announcement per sweep is an announcement that gets muted");
});

test("a failed claim never counts as a held one", async () => {
  // The other half of the same review finding: claimSingleton returned
  // held:true when the attempt ERRORED, sending an armed supervisor live
  // without the lock — precisely what the lock exists to prevent.
  const claim = new SupervisorClaim({
    armed: true,
    attempt: async () => ({ held: false }),
  });
  assert.equal(await claim.ensure(), false);
  assert.equal(claim.live, false, "an unclaimed supervisor must not act");
});

test("an unarmed supervisor claims nothing and acts on nothing", async () => {
  const lock = makeLock();
  const claim = new SupervisorClaim({ armed: false, attempt: lock.attemptFor("dry") });
  await claim.ensure();
  assert.equal(claim.live, false, "dry run is dry regardless of the claim");
  assert.equal(lock.holder, null, "an unarmed instance must not take the lock from an armed one");
});

test("with no lock to take, an armed supervisor still acts", async () => {
  // No DATABASE_URL. Exclusivity is unenforced and the supervisor says so
  // elsewhere; refusing to act would disable the keeper for no benefit.
  let attempts = 0;
  const claim = new SupervisorClaim({
    armed: true,
    unenforced: true,
    attempt: async () => {
      attempts += 1;
      return { held: true };
    },
  });
  assert.equal(claim.live, true);
  await claim.ensure();
  assert.equal(attempts, 0, "there is nothing to claim, so nothing should be asked for");
});

test("releasing frees the lock for the next instance", async () => {
  const lock = makeLock();
  const first = new SupervisorClaim({ armed: true, attempt: lock.attemptFor("first") });
  await first.ensure();
  assert.equal(lock.holder, "first");
  first.release();
  assert.equal(lock.holder, null, "SIGTERM must hand the claim over, not leave it stale");

  const second = new SupervisorClaim({ armed: true, attempt: lock.attemptFor("second") });
  assert.equal(await second.ensure(), true);
  assert.equal(second.live, true);
});
