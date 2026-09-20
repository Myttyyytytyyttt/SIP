# When a green suite proves nothing

Two real bugs in this repository survived a full green test suite for weeks.
Neither suite was thin. Both were lying about a different thing, and they lied in
the same shape, so the shape is worth more than either bug.

## The keeper hardcoded the venue

`invest_tick` passed the Raydium CLMM literal as the venue account instead of the
venue the owner had signed into `policy.venue_program`. `convert.rs` and
`invest.rs` pin one against the other, so the first policy naming any other venue
would have failed on-chain, every tick, forever.

The suite never caught it because the policy fixture defaulted `venueProgram` to
a freshly generated key. Every case built a policy whose venue was random, every
case ignored it, and so no case ever compared the venue signed against the venue
sent.

The fixture did not fail to test that field. It *randomised the field under
dispute*, which is worse: a value nothing asserts on makes every assertion around
it pass, and the green suite then reads as evidence that the field is right. The
fixture now names the venue every signed policy really names
(`policyFields` in `packages/solana-keeper/test/accounts.test.ts`), and the
reader's own case — the one case that is about reading arbitrary bytes at that
offset — overrides it explicitly.

## The keeper could not start, and vitest said it could

The keeper's package is `"type": "module"`. Under real Node ESM, `anchor.BN` came
back undefined at import time and the process died before its first sweep. Vitest
resolved that module differently from the runtime that actually runs the keeper,
so the suite stayed green while roughly 2,900 sweeps were missed.

Same shape: the suite exercised a stand-in for the thing in dispute — here the
module graph, there the venue — and then reported on the stand-in.

## The shape

A test is evidence only about the values it pins. When a fixture's default is
arbitrary — a fresh key, a random number, whatever the runner happens to resolve
— the variable it stands for is untested *and looks tested*. The count goes up,
the run goes green, and the next reader trusts the number instead of the fixture.

## What to do instead

- Give a fixture the **real** value for anything the code under test is meant to
  carry through: the venue a policy actually names, the mint the catalogue
  actually lists. Randomise only what genuinely must not matter, and write in the
  fixture that it must not matter.
- For a field that travels — signed in one place, checked in another — write one
  case that compares the **two ends**: what was signed against what was sent. Two
  ends, one assertion, no third value invented in the middle.
- When the runtime is part of the claim, prove it **in that runtime**. The ESM
  break was caught by probing with `node --input-type=module` from inside the
  package; no amount of vitest could have caught it.
- Before trusting a green run, ask what it would take for the run to be green and
  wrong. The answer is usually one fixture default.
