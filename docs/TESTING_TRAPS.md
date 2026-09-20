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

## A different species: prose that outruns its measurement

The traps above are all one disease — a *test* that could not tell two cases
apart. This one has the same root and a different hiding place, so it needs its
own name and its own defence.

While measuring how Jupiter quotes a Token-2022 mint with a transfer fee, three
claims went into comments and headers exactly as they had been observed, with
nothing beside them saying what they had been observed *of*:

- `RouteOutput`'s comments said the quote is **GROSS**. True — on the venues that
  were sampled. The quoting basis belongs to whichever AMM makes the final
  transfer, and Jupiter re-picks that per quote, per size, per minute. The same
  mint quoted both ways in the same hour once the venue changed.
- A test header said "every row below" came from one epoch-1038 run. Three of the
  blocks below it did not.
- Two comments said `FillTooSmall` happens "after the money has already left".
  The mechanism was described correctly and the consequence was not: Solana
  reverts the whole transaction, so what is lost is the attempt and its fee, not
  the principal.

The third is the dangerous one, and it is dangerous in a way the first two are
not. A reader who trusts the mechanism inherits the consequence without checking
it, and then designs retries, alarms and limits for a loss that does not happen.
A comment that is wrong about the *mechanism* gets caught the first time someone
reads the code beside it. A comment that is right about the mechanism and wrong
about the consequence never gets read again.

No test was going to catch any of these. Nothing was red, nothing was
randomised, nothing stood in for anything: the sentences were simply true of
less than they appeared to be true of.

### What to do instead

- Write the **conditions beside the claim**, in the same sentence where possible:
  not "the quote is gross" but "the quote is gross on the venues sampled here,
  and the basis follows the AMM that makes the final transfer". A measurement's
  scope travels with it, or the next reader supplies a wider one for free.
- When a measurement **cannot be retaken**, say so where it is stated. The
  gross-venue run in `jupiter-fork.sh` cannot be reproduced today — Jupiter no
  longer routes that pair through that AMM — and the header says that, so the
  next person finds a recorded fact instead of concluding the finding was wrong.
- Check consequences separately from mechanisms. Ask of every comment that
  explains a failure: *and therefore what is lost?* That question is not
  answered by reading the code the comment sits on.
- The first three traps are caught by writing a case where the two sides differ.
  This one is caught by writing, next to the assertion, the conditions under
  which it was measured. Different defence, same root: a thing true in the case
  at hand, read as true in general.
