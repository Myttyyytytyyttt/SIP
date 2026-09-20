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

## The minimum that only two legs could reveal

`InvestingCard` checked the owner's per-call cap against the minimum of the
whole BASKET. `invest.rs:135` requires it PER LEG — `invest` is called once per
`leg_index`, and each call carries only that leg's share. With one leg the two
readings give the same number, so the test that existed could not tell them
apart: it passed by arithmetic coincidence, not because the rule was right.

The moment the basket grew to two, the correct bar became
`maxPerCall x lightest weight / 10_000 >= minInvestment`, and the form began
accepting policies that can never buy at any balance — the owner would have paid
the account rent, signed, and only then found out.

Same shape again, in a third disguise: not a fixture with an arbitrary default
and not a stand-in runtime, but a TEST CASE in which two different formulas
collapse into one. Nothing was missing from the coverage. What was missing was a
case where the two answers differ.

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
- When a product constant goes from 1 to N — one leg to two, one venue to two,
  one anything to many — hunt for every formula where N=1 made two distinct
  rules agree. Those are the places a passing test was only ever a coincidence.
