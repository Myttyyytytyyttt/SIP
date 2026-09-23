# Changelog

Written once a day from that day's commits and that day's conversations, newest first.
It describes what changed for the project, not what changed in a file: commit messages say
what was edited, and this says what it means. Decisions, reversals and things deliberately
dropped are in here too — those live only in the conversations and never in the commits.

Days with no commits and no decisions get no entry. A gap is honest; a "nothing happened"
line is not.

---

## 2026-09-23

*Partial: written at 06:00 Lisbon and extended at 15:35 Lisbon from the work up to then. The
next run extends this section rather than adding a second one.*

A night spent on two questions: how many users the keeper can carry, and making the live
page *be* the sample page rather than resemble it. 13 commits across three sessions by
mid-afternoon, none after 06:19.

**The decision.** After several rounds of restyling live to look like the sample, the owner
changed the approach: "cojas y mires el codigo de mock exactamente como esta y lo copies a
LIVE pero lo cableas correctamente en todo" — take the sample's own component files as they
are and feed them real data. He also chose that the sample's controls should *do* what they
say, which means each one becomes a signature by the pension key.

**Web — live is now the sample's components with chain data (five phases)**

- An adapter turns the live dashboard into the sample's data contract, in dollars at today's
  price `2f30360`. Where a real pension can't know something (an unread price, a window the
  loaded history doesn't cover) the field is `null` and prints as a dash, never `$0`. Where
  the sample counts something the chain doesn't record, the tile says what the real
  equivalent is — settlements where the sample says trades.
- The big panel `1771cd5`, the strip of settlement chips `c9ddb70`, the rule card `4b4b6ae`
  and the wallet column `c740cbd` are each now the sample's own file. The old live-only
  components are deleted; the rules they enforced moved into tests on the new ones. Each
  phase was checked against the sample page and changed 0 pixels of it.
- **The rule card signs.** Changing the rate or pausing sends `set_policy_v2`; changing the
  threshold sends `set_invest_policy` with only the minimum changed, carrying the stored
  caps, basket and `enabled` flag so a paused investment can't be silently resumed
  `4b4b6ae`. The card and the wallets modal share one signing lock, so nothing can be signed
  twice by two screens. **Verified on mainnet:** the owner changed his vault from 20 % to
  25 % of profit from this card at 04:52Z
  ([`4X6uaSry…`](https://solscan.io/tx/4X6uaSryqBgGHudJQCdtkxd7CFi3wRKBaii3nXhhMQwKL7eNqGvA9oCAcPfW3ZkhkRFhjpWP4boKHh13zMSVd1RK));
  the vault account now stores `skim_bps = 2500`.
- Before the switch, the old panel was tightened: long figures shrink their tail instead of
  being cut `4d3478f`, and a single wallet becomes the column's header instead of a list of
  one `df8ae05` `8ae9c9d`.

**Keeper — measuring the user ceiling instead of guessing it**

- The sweep now reports what it costs on `/status`: skipped sweeps (warned on the first,
  critical on the third in a row), sweep duration p50/p90, links discovered vs. actually
  looked at, per-phase timings, which RPC endpoint is answering (by index — URLs carry API
  keys and `/status` is public) and Jupiter calls per sweep `5d7e72c`. A skipped sweep used to
  be one log line; it once stalled settlement for hours unnoticed. **Deployed and visible on
  the live `/status` this morning.**
- A bench boots the *real* keeper against a fake Solana RPC over a synthetic fleet, so the
  ceiling can be measured before the users exist `c6e38d8`. Nothing in the money path moved,
  and the bench refuses any request that leaves the loopback.
- Its first headline (~99 users at the public endpoint's latency) was too flattering, and was
  corrected the same night `121d62d` after an adversarial review found three ways it overstated
  production: it mixed fleets with different shares of active traders, priced active users on
  their reads only, and treated a rate limit as a slowdown when it is a refusal. The corrected
  ceiling is a curve — at most 97 wallets when 2 % trade in a minute, 54 when 20 % do — and a
  sweep that exceeds the RPC plan's requests per second gets no ceiling at all. These are
  still numbers from a laptop, not from Railway, and the runbook says so.

**Web — the whole dashboard on one screen**

What the owner asked for at 05:00, right after checking the 20 → 25 % signature on chain,
landed in one commit `db2bb7b`:

- **No scrolling to see the pension.** On wide screens the main column is at least the height
  of the window and the pension chart is the part that grows, so a laptop gets a short chart
  and a large monitor a tall one, with the figures around it the same size on both. Measured in
  a real browser at eight sizes: it fits without scrolling from 1440×780 up to 2560×1300;
  shorter screens (1366×680, 1280×720) still scroll, because the minimum content does not fit.
  Nothing was removed to get there — rows were merged and padding tightened instead.
- **The feed is colour-coded:** green for what the rule set aside, blue for what the pension
  bought, mustard for the machinery and every change (convert, wrap, rule, policy, link,
  withdrawal), red for failures, grey for keeper housekeeping. The colour goes on the icon and
  the amount, never on the words.
- The SaverFi logo now sits before the name in the navbar; the pension key left the wallet
  column because the navbar chip already shows it with a copy button; this week's activity
  moved up beside "Saved so far" (and says "Last 1 week", not "1 weeks").
- The sample and live pages now share one main-column component, so their layouts can no
  longer drift apart.

**Process — the owner reviews before anything is published**

- The owner decided (05:15) that this changelog routine runs every day at 11:00, edits the
  changelog and roadmap, and reports in plain bullets what it changed and what it did not;
  the owner then decides whether it is pushed. The routine no longer commits on its own.
- The owner also asked whether several keeper deploys on Railway would carry more users at
  once. No change followed today; the measured ceiling above is still for one process.

---

## 2026-09-22

The day the Jupiter move reached mainnet, a two-stock basket bought both its legs for real,
and the owner's own basket became editable after he had signed it. 19 commits across four
sessions.

**On-chain — the aggregator route, proven with real money**

- The Jupiter branch was merged to main `e54199c`, and it also fixed the keeper image that
  Railway had failed to build that morning: the Dockerfile copied two `solana-core` files but
  none of the six they import. A follow-up `2ff2863` fixed the guard itself, which read
  `tsconfig` but ignored `.dockerignore` and died in the image on a directory Docker never
  sends.
- The owner re-signed his policy onto Jupiter (19:05Z) and sent $5; the vault wrapped,
  converted and bought SPYx through Jupiter → Orca Whirlpool within three minutes.
- **The first PreStocks purchase.** After the owner signed a new SPYx + ANTHROPIC basket
  (20:53Z), the next deposit bought *both* legs through Jupiter at 21:16Z — each leg on its own
  venue ([`2w5Uwo6X…`](https://solscan.io/tx/2w5Uwo6XonpG8s1epuoHtbPF7V5pnjNXDK6jch2k5pJDXmu9dyKYT1rFGFy9XiffTr7Lw8JZENfipYvXwF4h8SRS)
  SPYx, [`43S4uAxY…`](https://solscan.io/tx/43S4uAxYbAUQApfwBkybtG3DLMMeoXsPqrg3qYhTRWCiBqCnQTPupcwmYn7d6vtPf2TQ4gUHLCQcLnzT47LBh12C)
  ANTHROPIC). Verified by reading the vault's token accounts.
- When the keeper seemed stuck after that deposit, the owner moved it onto three RPC
  endpoints with failover, the public one last.

**Web — the owner could not sign, then could not edit**

- The owner could not re-sign his own policy: the browser asked to create an account for
  ANTHROPIC, a stock his basket no longer held, and the program refused the whole signature.
  The same mistake sat on both sides of the wire — the web's list `5a3c73a` and the server's
  build handler `8846cb7` — and the first fix passed every test unchanged while fixing nothing
  he could see. His exact position is now a test on each side `1695885`.
- The basket picker existed but was unreachable for anyone who had already signed: the card
  sent them to a summary whose two buttons both re-signed what was stored `2f5f337`. The same
  form now opens on the chain's values; a stored share that isn't a whole percent is refused
  rather than rounded, and a paused policy stays paused. Six more repairs followed `15cacd3`,
  including a policy that could never buy being told a threshold at which it would.
- Live took the sample's presentation with the chain's numbers `b58e717` `0122578` `50a84e2`
  `d3a9362`. The rule that came out of it: a **balance** at today's price may lead in dollars;
  a **window sum** ("saved this week") may not, because nobody stored the price at each
  moment; and the curve is never in dollars.
- The live panel had looked half-built because the settlement never reached it — settlements
  live on the wallet's link, not in the vault's noise `9c2381b`.
- Every asset now has its own mark `616ce9d` `1cb2840`. The eight PreStocks images are the ones
  the issuer publishes for each mint (read from the Token-2022 metadata, not found by search),
  and each carries a small PreStocks or xStocks badge — **owner's call**: the company is the
  face, the issuer is the corner mark, because the issuer decides what can happen to the token.
- The settlement strip shows three decimals with the SOL mark and "Profit: 20%" / "Volume: 2%"
  in words `7819c80`; the rule card lost its threshold figure and gained a single gear that
  opens every change `967dbf8` — both as the owner asked that evening.

**Process**

- A daily digest script and this changelog began `aa860be` `8f22560`.
- The owner asked for a full resilience audit of the keeper. It reported (among others) that
  nothing outside the process ever asks `/health`, so a wedged keeper would go unnoticed; that
  finding is not fixed yet.

---

## 2026-09-21

The day the product stopped being two frozen stocks bought through one pool, and became a
basket the owner picks, bought through an aggregator. Roughly 65 commits across four
parallel sessions.

**The decision.** The owner chose to put everything PreStocks/xStock through Jupiter rather
than keep walking a single Raydium pool ("Lo mejor tal vez es hacer todo lo posible de
PreStocks, xStock", 00:44, after "dale con jupiter" the previous evening). Everything below
follows from that one call.

**Keeper — routing**

- The vault now buys through Jupiter v6 and nothing else `3ca4a52`. `invest-tick` lost the
  Raydium route builder entirely: `convert` and `invest` pass the venue blob the program
  CPIs verbatim instead of assembling swap bytes, and the pool registry went with it —
  under an aggregator there is no pool to configure, and a registry check would have refused
  exactly the assets the move exists to buy. Raydium CLMM is *retired*, not forgotten: its
  refusal opens by saying the migration is expected and that no SOL has been wrapped,
  because that is the sentence that decides whether an operator is woken at 3am.
- A Jupiter route does not fit a legacy transaction, and now does not have to `2c66423`.
  Measured, not assumed: five live routes ran 1,266–1,936 bytes against the 1,232 limit, and
  all five fit once address lookup tables were used. Versioned alone buys nothing — it is two
  bytes *worse*. The legacy path is kept byte-for-byte for the vault that has been buying
  real money through Raydium since 09-19.
- The depth gate was structurally unusable for the new venues and was rebuilt `f2500a6`. It
  decoded a Raydium pool's reserve; ANTHROPIC trades on Hadron, OPENAI on a central limit
  order book, SPACEX on Meteora — there is no such account to read. It is now a census of the
  inventory the *route* names, over the one 165-byte token layout every venue shares,
  requiring 50× cover and excluding vault-owned accounts (counting our own holdings would let
  the gate grow until a drained venue is admitted), plus a same-instant probe that abstains
  rather than guesses when it re-routes.
- Five measurement bugs on the money path, all the same disease `c86f7fd`: a parallel Jupiter
  split was censused per sliver, so three venues' inventory was judged against one venue's
  4 % share (1,199× cover read where the truth was 1.81×); a venue could have bought cover by
  quoting us worse; the convert measured itself and threw the verdict away; a mid-basket
  refusal reported a turn that bought nothing while the chain showed a completed buy; and the
  route was never re-aged immediately before signing.
- **A bug that had made a whole guard dead code.** `decodeMintFacts` read Token-2022's
  account type at byte 82; it is at byte 165. The decoder threw on every real mint, so the
  leg-admission check had refused every Token-2022 leg it was ever shown and the fee ceiling
  had never once been evaluated against a real mint. Every fixture in the suite was built at
  the same wrong offset by a helper written beside it, so 97 tests agreed with each other and
  with nothing else. Real mainnet accounts are checked in now `3ca4a52`.
- The drained-venue replay was pointed at the measurer as well as the gate `8480bd4`, and the
  fee warning now reaches the alerter instead of being computed and dropped `bbf2914`.

**Web — the basket became something the owner chooses**

- A picker: 1–5 stocks and their shares, replacing a form that demanded a weight for every
  offered stock and could only ever sign the whole shelf `84c9bfd`. Both of its limits
  stopped being constants — the floor is arithmetic over the owner's own lightest share, and
  the depth ceiling is recomputed per keystroke from what each chosen leg's route was counted
  to hold, instead of a literal derived one night in September from one pool `9f46aa6`.
  Unticked means removed, never held at 0 %: the program rejects a zero weight, which would
  be a transaction that fails *after* Phantom has asked for the signature.
- The sentences the owner reads before signing are generated from the basket he picked
  `d4c2f31` `357aa21` `ce229a9`. They used to name SPYx and ANTHROPIC by hand, which with a
  picker means describing a basket he did not choose and quoting a fee no leg of his charges.
  An unread fee is now called unread and never given a zero.
- **The basket could not be bought at all, and nothing said so** `e00c650`. The web's closed
  venue set held Raydium alone while the keeper routed Jupiter alone and refused Raydium by
  name — so every policy the picker let the owner sign would have bought nothing at any
  balance. Both sides were green because neither asserted anything about the other. The fix
  is a shared fixture both packages assert against.
- Settlement history now reads the wallet's link rather than the vault `ab66681`. The vault
  PDA is the noisiest address in the system: on 09-19, twelve of its fifteen newest signatures
  were the keeper's own account-keeping and the one real settlement sat at position 24, so a
  dashboard that *had* read a page of history still said "0 in loaded history" over a pension
  whose own total said otherwise. The two streams deliberately do not share a store.
- The live dashboard looked half-built next to the sample because it had no data, and drew
  the nothing at full size `145abb7` — a 288px chart band spent on one grey sentence. Also: a
  429 on the activity page was being recorded as a success, so the feed apologised for a
  minute over a problem that had already cleared `94e06bd`.
- The leaderboard's copy lost the formula it was printing — **owner's decision**: a board that
  publishes its own thresholds invites someone to farm them `fc8175a`, reduced again to a
  single italic line `3f3e737`. It also stopped shipping a 1.96 MB wallet SDK to readers who
  have no session `6e3871e`.

**Catalogue**

- `pool` used to mean the market, the floor's price and the depth measurement at once; under
  Jupiter it is only the last `c0868f8`. The shelf is now a *result*, not a list: nine assets
  read on mainnet, each admitted or refused by six named rules carrying the dated reading that
  failed it. Two corrections the old file was still asserting — ANTHROPIC's mint says 50 bps
  and has charged 100 since epoch 1039, and FIGUREAI's pinned pool is not empty (it recovered
  from $51 to $2,786.97 overnight); it stays out on quarantine instead, and a test proves
  nothing else is quietly refusing it.

**Docs and tests**

- `docs/TESTING_TRAPS.md` gained a fourth and fifth trap and then a closing section `fabb39c`
  `63649ad` `4c52d2f`. The fourth is not a test that lies but prose that outruns its own
  measurement; the fifth is a test that pins another package by its *text*. The closing
  section names the three species all five fall into, and the one question that finds them:
  what would have to be true for this to be green and wrong?
- The keeper's Docker image gained a test that says which modules it must carry, so a new
  import can no longer be green locally and still fail to build `63e4552` `c0bc14c`, and the
  three constants the keeper and the web must agree on got one committed vector asserted from
  both sides `7a3d555`.

**Not yet true on this day:** every Jupiter transaction above was simulated against mainnet,
never sent. The live vault's signed policy still named Raydium CLMM, so nothing had actually
filled through an aggregator yet.

---

## 2026-09-20

Two threads ran in parallel all day: a usage leaderboard built end to end, and the
measurement work that made the Jupiter move possible the next day. Around 50 commits.

**The decision.** Asked whether the leaderboard should wait until after the hackathon
deadline, the owner overruled the deferral outright — "Olvida el calendario — vamos a
comenzar con esto y vamos a hacerlo bien de inicio a fin y completo!" — and it shipped the
same night. Separately, the investment limits were set by hand: a $5 minimum so it can be
tested, with purchases batched rather than taken in one lump to keep price impact down.

**Leaderboard**

- The keeper scores use, not size, and the web serves it at `/leaderboard` `e796a3b`. Most of
  a day's points are flat — everyone is paid the same for having saved at all — the amount
  enters through a capped logarithm, and coming back on consecutive days pays more than any
  single large day: 0.01 SOL five days running scores 84, one lot of 100 SOL scores 35.
- Two boards became one score `53e944e`: separate Ahorro and Volumen tables forced a newcomer
  to choose which to believe before reading either. A day pays participation once and adds
  each measure's size term on top; both single-measure boards stay in the payload, because a
  score has to be able to be taken apart to be argued with.
- The web never touches the database — it proxies the keeper and caches, and a failure is a
  503 with a reason rather than an empty table, which would read as "nobody has ever saved"
  `1196588`. The published breakdown has to add up to the published total `556844f`.
- The history mirror can now be rebuilt from the chain, which the SQL file had been promising
  for weeks `2b7b9df`. It follows the invocation stack and accepts a `Settled` event only
  while `sip-vault` is the program executing — anyone can emit a log with our discriminator —
  and dates rows by block time, not `now()`. Dry-run against mainnet it reconstructed the one
  real settlement from the program's twelve signatures.
- Ordering matters and is one-way: run `setup-read-model` *before* deploying, or a settlement
  loses its history row. Startup now checks columns, not just tables `f0905ab`.

**Keeper — alerts and measurement**

- Only what wakes somebody leaves the box `1305c9b`. Fifteen conditions were going out the
  same door; at 3am a resting warning is indistinguishable from a failed settle, and a box
  that rings for everything stops being looked at. The threshold is `critical` by default, the
  filter sits *after* deduplication so a resting warning keeps its one log line per window,
  and Telegram messages carry their chat in the body rather than the URL.
- `/status` now says whether alerts are actually *arriving* `51592cf` — "12 delivered", or
  "NOT ARRIVING: 7 refused in a row, last: webhook answered 403". A blocked bot makes Telegram
  refuse every critical while the old line went on looking healthy. A stuck single-writer
  claim escalates from warn to critical after five sweeps, so an ordinary deploy handover does
  not ring but a stale lock does.
- The route stopped being reconstructed by walking the pool's last 60 signatures hunting a
  stranger's swap to borrow accounts from `15a3cd4` `d84be21`. Measured: those 60 signatures
  are about six seconds of a pool that is 55 % failed transactions, three of five walks found
  nothing, and on SPYx the walk asked for a transaction version that 51 of 60 successful
  transactions do not use — six invest turns died that way. Every account it was borrowing is
  a field of the pool's own state. 0.1 s instead of a minute.
- A pool too thin to fill this turn's share refuses the basket before anything is wrapped
  `46685c2`, and the venue the owner signed is finally the venue the crank uses `b95588e` —
  the crank had been passing a literal, so a policy naming any other venue would have reverted
  with `WrongVenue` on every sweep, silently and forever. It survived because the test fixture
  defaulted the venue to a *random* key, so nothing ever compared the two.
- Jupiter quotes both gross and net depending on the last hop, which was measured on mainnet
  and turned into tests rather than left as an anecdote `48ae8e5` `c70eb14` `ef55219`
  `929832b`. At epoch 1039 the transfer fee eats the whole default slippage, so a venue that
  quotes gross stops filling `1e81233`.

**Web**

- Vault caps stopped being frozen at creation `70fd2e7`: `set_policy_v2` existed and nothing
  called it. All six fields travel on every call, because a field left out cannot mean "leave
  it alone" — it would mean "overwrite it with whatever the server guessed".
- The panel can set the minimum per stock, the basket shares and the venue, each in the one
  shape the route accepts `5d73c37`, and the venue list fails closed: the web offers only the
  intersection of the server's list and the venues whose built bytes it can check, so the day
  the server learns a new one the owner is not asked to sign a CPI target on the server's word.
- The card stopped saying anything the vault's own state contradicts `820b49e`, and the
  dashboard pages back for the settlement its state records `c6bce60`.
- The README started showing what already happened on mainnet, and admitting what has not
  `e4222ac` `90acdf7` `30df6bd`.

---

## 2026-09-19

A short day — nine commits, all before 01:00 — finishing the recovery from a lost Privy key,
and then the first real money moving.

- The keeper's authorization key for quorum `cbx133it…` was lost on 09-18 and replaced by
  `kyio853…`. Every trading wallet seated before that still named the dead signer, Privy's
  record showed it exactly like a live seat, and the page offered nothing — the grant is for
  "missing" only. **Re-seat keeper** now removes every signer and seats the current one in a
  single run `0e3c95f`, refusing to send anything unless both the rendered record and a fresh
  read show the same wallet with the same id, because on any other wallet Privy's removal
  revokes every delegated wallet on the account.
- An adversarial review of that flow found four things the first version missed, all fixed the
  same night: an add that lands before Privy's reply fails is reported as "most likely added",
  never "NOT added" `ed453d5`; the grant waits for Privy's record and holds itself back so the
  signer is not seated twice `bd28db8`; the flow outlives its row `c6ca746`; and a wallet
  seating the old signer is sent to Re-seat rather than to "onboarding step 3" `beeb32c`.
- One question could not be answered offline and is written down as open rather than guessed:
  whether a TEE wallet keeps its server id once its last signer is removed. The code is safe
  within a single run either way, and the runbook has the owner rehearse on an empty wallet
  first `615b13d`.
- Tests and runbooks were re-pointed at the current signer, with the retired one named only as
  retired `f0f141c` `91c1ea5`.
- The owner then did the re-seat by hand, sent 0.01 SOL to the vault, and watched the first
  real settlement and purchase go through — the loop the README documents.
