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

## A third species: a test that pins another package by its text

`packages/website-oficial/src/lib/vault-copy.test.ts` keeps the words the vault
owner signs honest by checking them against the keeper's real numbers. It does
that by **reading the keeper's source as text** — three files, `readFileSync`
on `../../../solana-keeper/src/settle-decision.ts` and twice on
`invest-decision.ts` — and pulling `ZERO_BASE_MIN_TXS`, `MIN_POOL_DEPTH_MULTIPLE`
and `MAX_LEG_FEE_BPS` out with regexes. One of them matched the whole body of a
type, not a constant.

The intent is good: a signed sentence that quotes a number should break when
that number changes. The mechanism is not. A regex over another package's source
pins its **formatting**, not its meaning, so the web suite goes red when the
keeper reflows a comment, renames a local, or — this is the one that actually
happened — adds a purely **additive** field to a type. Nothing was broken;
nothing the web depends on changed; a package that the web does not even import
was edited, and a web test failed.

That last part is what makes it expensive. The break appears in a package the
author was not working in, with a message about a string, pointing at no defect.
The natural fixes under deadline are all bad: loosen the regex until it matches
nothing useful, delete the case, or — worst — edit the *other* package to keep a
grep happy.

### What to do instead

- Pin **exported values**, not source text. `import { MAX_LEG_FEE_BPS }` fails
  loudly and precisely when the constant moves or goes; a regex fails vaguely
  when anything nearby moves.
- If the value is not exported, **ask for the export** — or move the constant to
  the package both sides already share. A number that two packages must agree on
  is a shared constant, and reading it out of a neighbour's file is a way of
  pretending it is not.
- If a cross-package read is genuinely unavoidable, anchor it to the narrowest
  thing that carries the meaning — the export statement itself, never a type
  body — and say in the test what will break it.
- Ask of any cross-package assertion: *which edits in the other package should
  turn this red?* If the honest answer includes "renaming a local variable" or
  "adding a field nobody reads", the assertion is pinned to the wrong thing.

### Another instance, and what it cost (2026-09-23)

`solana-core/test/readers.test.ts` had the same shape against a different file:
it read `solana-keeper/src/venue-depth.ts` as text, pulled the four Raydium
CLMM PoolState offsets out with a regex, and required two expressions to appear
**verbatim** — the keeper's depth gate decoded a Raydium pool the same way the
web's reserve panel does, so a panel measuring the other side of the pair would
have promised exactly what the gate then refused. A real invariant, pinned to
formatting.

Then the keeper moved to Jupiter (2026-09-21) and retired Raydium by name —
`ROUTABLE_VENUES` holds Jupiter v6 alone, and a Raydium policy hits
`RETIRED_VENUES` and is refused — so the Raydium adapter that fed the
venue-agnostic census lost its last caller. The gate now censuses whatever
token accounts a Jupiter *route* names and never decodes a PoolState. **Deleting
that dead code in the keeper broke a green test in a package that does not
import the keeper**, and the cheapest way to keep the suite green was to keep
the dead adapter; for two days, it was. A text pin does not just fail vaguely;
it can make the neighbour's code undeletable.

The prescribed fix was the one taken. The four offsets are one fact about
somebody else's account layout, and they now live in
`@sip/solana-program/clmm-layout` — the package both sides already depend on —
imported by `live-route.ts`, `readers.ts` and `test/chain-fixtures.ts`, and
asserted by `readers.test.ts`. The
keeper's copy went with the adapter. Three things worth copying from it:

- **Count the copies before choosing where to put the constant.** There were
  seven, not two: the keeper's `venue-depth.ts`; core's `readers.ts`,
  `clmm-price.ts` (the mints only), `bin/check-legs.mts` (the vaults only) and
  `test/chain-fixtures.ts`; and the program package's `live-route.ts` and
  `rehearse-route.ts` (mint0 only). That is not counting the tests that write
  the offsets as literals on purpose, as pins — besides `readers.test.ts`'s own,
  three remain: `clmm-price.test.ts`, the web's `solana-build/route.test.ts` and
  the keeper's `live-route-from-pool.test.ts`. Three copies are still their own —
  `clmm-price.ts` sits in the browser-safe client entry, whose only permitted
  package import is the IDL, and the other two are operator scripts — and the
  shared module's header says so rather than claiming a single definition it
  does not have. The copy that matters most is `chain-fixtures.ts`: it
  *writes* the bytes the reader reads. Sharing one constant between them means
  they can no longer drift apart, and also that they now drift *together* —
  move the constant and every reserve case stays green over bytes mainnet
  would not recognise. Which is why the next point is not optional.
- **Assert the number against literals, somewhere that is not the
  definition.** `readers.test.ts` builds a pool through the fixture and reads it
  back at `73/105/137/169` typed out in the test. Change the shared constant and
  that case goes red — which is the whole job the regex was hired for.
- **A two-ends test has two ends to lose.** The keeper's deleted Raydium cases
  included one that ran its dead `vaultOwnedAmong` against the LIVE
  `findVaultOwnedTokenAccounts` over the same accounts. It was also, it turned
  out, the only case anywhere that fed the live function an account found by its
  owner bytes: every other stub either reported the accounts missing or served
  only accounts the vault does not own, so the on-chain pass could have been
  deleted, or read the mint instead of the owner, and stayed green. Before
  deleting one end, ask what the test proved about the other; here it needed a
  case of its own in `jupiter-route.test.ts`.

### The last two, and the gap one of them was hiding (2026-09-24)

`solana-keeper/src/invest-decision.ts` was still read as text from two
packages. `solana-core/test/handlers-live.test.ts` regexed
`MIN_VENUE_INVENTORY_MULTIPLE` out of it, and the web's `vault-copy.test.ts`
(this section's first case) read it three times. One of those reads matched
`DepthDecision`'s whole type body. One pinned `LegAdmission`'s refusal arm and
forbade the word `outcome` anywhere in its admit arm, comments included. The
third required two expressions of the transfer-hook switch verbatim. No core
or web test reads the keeper's source now. (Tests that read
`@sip/solana-program`'s files as text remain. Much of that package is Rust,
which no TypeScript test can import, so they are a different trade and are not
touched here.) What replaced the keeper reads, and why the obvious fix was not
taken:

- **The shared module was the wrong home for this one.** `clmm-layout` worked
  because the offsets are one fact read by two modules in two packages (core's
  `readers.ts`, the program's `live-route.ts`) and written by the fixture that
  builds their bytes. The multiple has one executable reader, the keeper's
  `legDepthDecision`. Moving it into `@sip/solana-program` would route a number
  the depth gate multiplies by through `program-scripts.ts`'s CommonJS unwrap,
  one more value on the money path that has to survive it, to serve a single
  core test. Neither other copy takes the multiple from there today: core's
  `product.ts` sits in the browser-safe entry, whose only permitted package
  import is the IDL (`test/client-entry.test.ts`), and the web does not
  list that package as a dependency: its app code (`src/`) reaches it only
  through `@sip/solana-core`. Those copies already meet in
  `solana-core/test/fixtures/keeper-policy.ts`, so the vector was the place.
  The doctrine pins stayed in the keeper for a different reason: the ones
  that matter most run the gates themselves (a basket with one bad leg, a
  mint whose hook is filled in), and no other package depends on the
  keeper. The two unions could also have moved to the shared
  package type-only, the way `program-scripts.ts` re-exports
  `AttestationInputs`; that would have added a second place to pin their
  shape, not a pin on what the gates do.
- **A vector asserted from one side is a vector in name only.** The fixture's
  header said the keeper's tests held its constants to it. For the venue
  entry they did. For the multiple, none did: the keeper pinned `50n` as a
  bare literal, and what actually tied the keeper's 50 to the vector was the
  regex in `handlers-live.test.ts`. Delete that regex alone, and a keeper
  that moved to 40 and updated its own literal would have gone green
  everywhere while the web still printed "50 times". (The fee ceiling had
  the same gap, a bare `100n`, until the same day's 300 bps raise added a
  keeper case holding `MAX_LEG_FEE_BPS` to `LEG_FEE`, now titled "THE
  KEEPER'S HALF OF LEG_FEE".) So the keeper's half came first:
  `invest-decision.test.ts` now holds `MIN_VENUE_INVENTORY_MULTIPLE` to
  `POOL_DEPTH`, holds the `POOL_DEPTH` and `LEG_FEE` boundaries each to its
  own number, and runs both through the real gates. Before deleting a text
  pin, ask what else binds its two ends. Here the answer was nothing.
- **A field renamed in the vector arrives as `undefined`, and a gate can
  swallow it.** The keeper loads the vector through a runtime-built specifier,
  so `tsc` never sees its shape. A fee of `Number(undefined)` written into a
  mint is 0 bps, and admitted, so a boundary run through the gate stayed green
  with the field gone. Each case now compares the fields it uses with each
  other before any gate sees them.
- **Doctrine is pinned where the type lives, twice.** `DepthDecision` and
  `LegAdmission` are held to `ALL_OR_NOTHING` as whole unions, both arms
  exactly (`expectTypeOf`, so `tsc` goes red, which is also the keeper image's
  build gate). They are also held as return values: a two-leg basket with one
  bad leg must come back as exactly one refusal of three fields, and, for
  `LegAdmission`, whose admit arm carries each leg's fees, a sound two-leg
  basket as one admission naming both legs. Each catches what the other
  cannot. An optional per-leg field that nothing fills is caught by the type
  pin alone, and a gate that quietly buys the good legs is caught by the
  return value alone. The first draft pinned `LegAdmission`'s admit arm only
  for the absence of `outcome`. On a union, `keyof` keeps only the keys every
  member shares, so a second admit arm carrying one passed, and so did a
  per-leg field under any other name. An independent review caught it before
  it shipped.
- **One pin was already a duplicate.** The keeper's own suite already proved
  both hook expressions by behaviour: the real ANTHROPIC mint, whose hook
  field is empty, is decoded and bought, and a real hook is refused. The web's
  regex was a weaker second copy. It would have gone red for an equivalent
  rewrite, such as comparing the 32 bytes to zero instead of to
  `PublicKey.default`. The new `TRANSFER_HOOK` entry adds one thing that was
  missing: "empty" written out as 32 zero bytes, so neither side's library
  supplies it.

Each new pin was mutation-checked: the keeper's constant moved with its
literal, a per-leg field in either union, a second admit arm, either gate
buying a partial basket, each vector entry flipped, and each vector boundary
loosened. Each goes red in the package that caused it. An equivalent
rewording of the hook check stays green. A harmless field added to either
union goes red in the keeper, on purpose, because that is where whoever adds
it can judge whether it is an escape hatch.

`LOSS_FORGIVEN` still has the gap the multiple had. `settle-decision.test.ts`
pins `ZERO_BASE_MIN_TXS` to a literal 100, and nothing holds that literal to
the vector the web's copy is held to.

## Three species, one question

The six cases fall into three shapes, and each one hides somewhere different:

- **A test that cannot tell two cases apart.** The fixture randomised the field
  under dispute; the runner substituted the runtime under dispute; a one-leg
  basket made two different formulas agree. Caught by writing a case where the
  two sides differ.
- **Prose whose scope is narrower than its reading.** True of what was measured,
  read as true in general. Caught by writing the conditions beside the claim.
- **A test coupled to another package's text.** Red for an edit that broke
  nothing, far from whoever made it. Caught by pinning exported values.

The question that finds all three is the same one: **what would it take for this
to be green and wrong?** Ask it of the suite, of the comment, and of the thing
the assertion is actually pinned to.

## The instrument has no instrument

Every rule above is enforced by something — a test, a check, a script. That
something is itself code nobody tested, and on the night of 2026-09-21 it failed
three times in a row while looking healthy.

The question was narrow and mechanical: does the keeper's Docker image contain
every file the keeper's code reaches? Docker does not run on this machine, so
each of us wrote a checker.

- **The first checker read the destination as a source.** In `COPY a b c dest/`
  the last token is where the files land, not a file to copy. Counting it made
  `packages/solana-program/scripts/` look copied wholesale, and the checker
  announced that all nine specifiers were present. Four were not, and the image
  could not build.
- **The second checker asked about one package.** It resolved every `@sip/*`
  specifier and passed a tree that still did not build: `pyth.test.ts` reaches
  two files in a sibling by *relative path*, assembling part of each path from a
  `const` at runtime so the type-checker never follows it. A scan for `@sip/`
  sees none of that.
- **The third checker made the first mistake again, by another door.** Written
  specifically to close the relative-path hole, it matched the destination
  `packages/solana-program/scripts/` against a "copied directory" pattern — and
  once more reported four uncopied scripts as present.

Three instruments, all green, all wrong, each about a question whose true answer
was already known to somebody.

### What actually caught it

Not a test. Twice, what caught it was **a number remembered from before that the
new result contradicted**. The first checker's "all nine present" collided with a
COPY list read minutes earlier that plainly named three scripts. The third
checker's clean run collided with a *measured* four-missing from the same tree an
hour before. In both cases the discrepancy was the finding, and the instrument —
not the tree — was the thing at fault.

That is a habit, not a mechanism, and habits do not survive a tired evening. So
the habit gets a mechanical first step:

- **Show the detector failing before you trust it passing.** Point it at a case
  known to be bad and require it to go red *naming the right thing*. A checker
  that has only ever printed "ok" has been run, not tested. Both broken checkers
  here would have been caught by one run against a tree whose answer was already
  known.
- **Keep the old number, and when a new result disagrees, suspect the
  instrument first.** A green that contradicts a measurement you already hold is
  not a green; it is an unexplained discrepancy, and it is cheaper to doubt the
  tool than the tree.
- **When a checker answers a question of the form "does X reach anything
  outside itself?", enumerate the ways out before the ways in.** Here there were
  two — a package specifier and a relative path — and each checker knew about
  one. The failure was never in the matching; it was in the list of routes.

This is the same disease as everything above, one level up: an assertion that
could not fail. The difference is that the suite is watched and the instrument is
not, so the question has to be asked deliberately: **what would it take for this
checker to be green and wrong?**
