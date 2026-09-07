# @nuvem/keeper

The unattended attester. It watches a trading account, finds finished sessions,
asks `@nuvem/session-engine` whether each one can be attested, and settles the
ones it can — at most once each.

It is a port of the working reference implementation,
`packages/aa-smoke-old/scripts/settle.mjs`, from "a human runs this and reads the
output" to "this runs without a human". Almost everything difficult was already
solved there and is preserved verbatim: the L2→L1 block mapping, the v2
`ledgerRoot`, binding to current onchain state, asking the executor what it will
accept rather than reimplementing its clamps, and cross-checking the local
EIP-712 digest against the contract's own before spending gas. What is new is
everything that only matters when nobody is watching.

---

## The four non-negotiables, and where each one lives

### 1. Dry run by default

Broadcasting requires **both** `--broadcast` on the command line **and**
`NUVEM_KEEPER_ALLOW_BROADCAST` set to the exact string
`i-understand-this-moves-real-funds`. The comparison is byte for byte —
a truthiness check would be satisfied by `0`, `false` and `no`, all of which a
human writes when they mean the opposite, and trailing whitespace does not count
either.

There are two enforcement points and the weaker one is the flag:

- `src/config.ts` **does not read the trading account's private key at all**
  outside live mode. A dry run cannot broadcast because the process does not hold
  a key capable of it. That is structural, not a check that could be bypassed.
- `src/submit.ts` checks the mode as its first statement and returns before the
  transaction signer or the sender is reachable. `test/submit.test.ts` proves it
  by handing dry-run mode a signer that throws if called.

A dry run still does the whole pipeline — verification, attestation, signing, the
digest cross-check, and `eth_estimateGas` against live state — so "it worked in
dry run" means something. It prints the exact transaction and writes an inert
`DRYRUN` record to the journal.

### 2. A REFUSED verdict never settles

`buildAttestation` returns `REFUSED` as its **first** statement, before the
signer or the chain is touched. There is no override flag, no environment
variable, no `--force`. `test/attest.test.ts` asserts this on the *signer's call
count* rather than on the return value, because "we returned REFUSED" and "we did
not sign" are different claims and only the second is the safety property.

Refusing is the normal, healthy outcome for a badly chosen window. Refusals log
at the **same fidelity** as settlements, deliberately: if a refusal logs less,
the operator's instinct becomes "make the refusal go away", which is the wrong
instinct.

### 3. Never settle the same window twice

Three independent layers, in increasing authority.

**Local** (`src/ledger.ts`, `localEligibility`) — cheap, prevents gas waste:

| rule | what it mirrors |
| --- | --- |
| `PROGRESSION_L1` / `PROGRESSION_L2` | `PersonalVault.sol:543-546` (`NonProgressiveBlockRange`) |
| `NOVELTY` | `PersonalVault.sol:548-549` (`usedSessions`) |
| `SINGLE_FLIGHT` | one unresolved intent per account, ever |
| `TERMINAL` | refused / unprofitable / too-wide windows are not reconsidered |
| `RATE_LIMIT`, `NOT_DEGRADED` | operator circuit breakers |

**Chain-derived** (`src/reconcile.ts`, `chainEligibility`) — survives total local
state loss: a node-side filtered `eth_getLogs` on the indexed `sessionId`, plus
the `settlementNonce` compare-and-swap.

**The contract** — `NonProgressiveBlockRange`, `SessionAlreadyUsed`,
`InvalidSettlementNonce`. This is what makes the worst case a revert rather than
a payment. For the keeper to pay twice, all three layers would have to fail at
once, and any one of them failing is loud.

#### A correction to the brief, which changed the design

The brief describes the double-settle hole as unmitigated onchain. That is true
of `SettlementExecutor` alone but **not** of the transaction as a whole:
`PersonalVault.acceptSettlement` carries both guards above, and they landed in
the pre-deploy Phase 1 commit, so they are live in the canary vault. A naive
replay reverts.

Service-side state is still correctness-critical, for four reasons:

1. `previousEnd != 0` leaves the first settlement of each `bindingEpoch`
   unguarded onchain.
2. `lastEndBlock` has **no public getter** — it is private ERC-7201 storage — so
   the last settled boundary cannot be read back and must be persisted or
   re-derived from calldata.
3. Both guards are keyed on `bindingEpoch`, which an admin pause/resume
   increments. That resets `lastEndBlock` to zero and makes the whole settled
   history replayable onchain. The keeper's key is therefore the **L2 window**,
   which does not move when that happens.
4. Every duplicate the local rule fails to stop burns the trader's gas.

**Why `PROGRESSION` is checked before `NOVELTY`, with a real example.** The
historical canary settlement committed the *legacy* ledger root
(`0xbc9407f1…74e5`), giving `sessionId 0x0d176cd3…2168`. Re-deriving the same L2
window today produces the *v2* root (`0x114187428a…0955`) and therefore
`sessionId 0x259ef15b…07f4` — a genuinely different id for an already-settled
window. A novelty-only rule waves that straight through. Progression does not
care what the root says. Both values were read back off mainnet and are pinned in
`test/ledger.test.ts`; the chain agrees, reverting
`NonProgressiveBlockRange(25635384, 25635381, 25635384)`.

#### The crash-after-broadcast case, closed by ordering

`settle.mjs` does `simulateContract` then `writeContract(request)`, where viem
picks the nonce internally and the transaction hash is unknown until after the
send. Fine for a human watching a terminal; fatal without one.

viem can sign a transaction locally and return the raw bytes, whose keccak **is**
the transaction hash, before the network sees anything. So the keeper owns both:

```
reserve nonce → estimate → sign locally → APPEND INTENT + fsync → send
```

Crash anywhere and exactly one thing is true: nothing was sent and no local trace
exists (the window is simply still unsettled), or an `INTENT` exists carrying the
exact nonce and raw hash. There is no third case. A torn journal line degrades
into the second, which is why a torn write is not corruption.

Recovery then asks the chain, in this order and never the nonce alone:

```
receipt?  → CONFIRMED / FAILED
tx?       → PENDING (inside its deadline) / ABANDONED (past it)
absent    → mined nonce still ≤ ours?  → ABANDONED, nothing was spent
                              advanced? → ask the indexed SettlementExecuted log
                                          present → CONFIRMED (hash from the LOG)
                                          absent  → ABANDONED
```

The last branch matters: the trading account is the trader's own actively-used
EOA, so a GMGN trade can consume the reserved nonce. **"The nonce advanced" is
perfectly consistent with "we never settled."** Only the log decides.

### 4. The attester key never reaches a log line

Three independent mechanisms in `src/log.ts`, deliberately overlapping:

1. `Secret` never yields its value to a serializer — `toString`, `toJSON` and
   node's inspect hook all return a label, so `JSON.stringify(config)` is safe by
   construction rather than by discipline.
2. `Redactor.scrub` substitutes registered secrets out of the **fully serialized
   line**, so nested error messages, `error.stack` and viem's `metaMessages` are
   all covered. It also drops viem's `URL:` / `Request body:` metadata lines
   wholesale — the endpoint carries an Alchemy API key, and a routine 429 would
   otherwise publish it.
3. A post-substitution assertion: if a registered value somehow survives, the
   whole line is discarded and replaced with a failure marker.

Substitution is exact-match, never pattern-based, because "looks like a 32-byte
hex string" would also redact `ledgerRoot`, `sessionId` and every EIP-712
digest — precisely the values an auditor needs. The attester **address** is
logged loudly and often; it is public and it is the thing being held accountable.

---

## Layout

| file | responsibility |
| --- | --- |
| `src/config.ts` | env loading; refuses to start rather than guessing |
| `src/log.ts` | structured logging that cannot print a secret |
| `src/ledger.ts` | the durable store: hash-chained JSONL + atomic snapshot, and the local idempotency rules |
| `src/onchain.ts` | the chain seam — one narrow, stubbable interface, so the dangerous paths are testable offline |
| `src/reconcile.ts` | chain-versus-local truth; the authority on what is already settled |
| `src/watch.ts` | incremental discovery with an IDLE-anchor watermark |
| `src/attest.ts` | build + sign the EIP-712 attestation (the `settle.mjs` port) |
| `src/submit.ts` | broadcast, and the dry-run gate |
| `src/keeper.ts` | the loop that wires it together |
| `src/health.ts` | the heartbeat: `GET /health` and `GET /status` |
| `src/engine.ts` | the single place `@nuvem/session-engine` is imported from |
| `bin/keeper.mts` | CLI |

### Why the state store is JSONL and not SQLite

SQLite buys concurrent writers, indexed queries over large tables and
transactional multi-row updates. None applies: one writer, one user, single-digit
settlements per day, a table that holds hundreds of rows in a year. Against that
it costs either a native module in the Docker build — the one thing that makes an
image fragile to rebuild — or `node:sqlite`, which is experimental and
flag-gated on the pinned Node 22.14.0.

The decisive argument is different: the money-critical artefact has to be
readable with `cat` during an incident and diffable in a bug report. A JSONL
journal is. A SQLite page file is not. bigints are written as decimal strings for
the same reason.

Each line commits the hash of the previous one, so truncation and silent editing
are detectable in one pass, and the loader has a principled rule for the only
thing a crash really produces: it stops at the first unparseable or unlinked
line, discards it and everything after, and reports a truncated tail.

### Why the watermark is an IDLE anchor and not detector state

`detectSessions` is a fold with mutable position state. Persisting that map would
create a second source of truth about what the wallet holds, and drift there
silently mislocates a boundary — and therefore the profit.

Instead one number is persisted: the highest L2 block at which the wallet was
provably **IDLE**, every position flat. IDLE is an *empty* state, so re-running
detection from the anchor reproduces byte-identical sessions with no carried
state. The anchor is a cursor into chain history, not a cache of a computation.
Losing it costs time; it cannot cost correctness.

---

## Running it

```bash
cd packages/keeper-old
pnpm install

# the loop, dry run — this is what NO ARGUMENTS does, and what the container runs
npx tsx bin/keeper.mts --account 0x…

# one pass, dry run
pnpm tick --account 0x…

# operator view — no writes, no lock, no chain writes
npx tsx bin/keeper.mts status --account 0x…

# one explicit window, end to end, without touching the ledger
npx tsx bin/keeper.mts verify --start 22080592 --end 22080850 --account 0x…

# what does the CHAIN say this account has already settled?
npx tsx bin/keeper.mts recover --account 0x…

# dump and verify the journal's hash chain
npx tsx bin/keeper.mts journal --account 0x…

# clear a halt, naming the exact record so a stale script cannot clear a new one
npx tsx bin/keeper.mts tick --acknowledge-degraded 7 --note "checked by hand"
```

`--env-file <path>` is repeatable, because this repo keeps its credentials across
`.env`, `.env.mainnet` and `.env.docker`. Real environment variables win over
files.

The keeper runs from source under `tsx`, the same way `session-engine`'s own
`scripts/*.mts` do; `pnpm build` typechecks rather than emitting. See
"A change `@nuvem/session-engine` needs" below for why.

### Cold start

Set `NUVEM_KEEPER_FROM_BLOCK` near the current head. The engine's block scan
issues one sequential `eth_getBlockByNumber` per block — measured at ~21
blocks/second against the mainnet endpoint — and the keeper **refuses** a
discovery scan wider than `NUVEM_KEEPER_MAX_TICK_SCAN_SPAN_BLOCKS` (default
2,000) rather than scanning part of the range. Leaving `FROM_BLOCK` at 0 on a
23-million-block chain therefore refuses every tick, loudly, instead of
half-answering.

---

## Verified

`pnpm install` · `pnpm typecheck` · `pnpm test` → **115 tests, 9 files, green**,
all offline and deterministic.

### A real dry run, mainnet chain 4663

Against the actual trading account `0xc455bF7f…974E7d`, over the window the real
canary settlement covered. Log lines abbreviated; every field shown is verbatim.

```
msg: "engine report"
  verdict            ATTESTABLE      reasons []
  windowL2           [22080592, 22080850]
  windowL1           [25635381, 25635384]      ← 258 L2 blocks collapse into 4 L1 blocks
  cashStart          31229961908171659
  cashEnd            33246816355665397
  externalDeposits   0        externalWithdrawals 0
  realizedProfit     2016854447493738          ← matches the historical settlement exactly
  residualWei        0                          ← reconciled to the wei
  gasPaid            11941865418000
  zeroBasisRealized  0
  ledgerRootV2       0x114187428abcb4dc2350ef240dee485ca1f236c2e4601d92063e4cf5f2e40955
  transactions       ["TRADE_BUY 0x27259f99e2…", "TRADE_SELL 0x0688bd5725…", "APPROVE_OR_NOOP 0xc81c59bba7…"]

msg: "attestation outcome"   kind: READY
  (the local EIP-712 digest matched hashAttestation(); a mismatch would HALT here)

msg: "settle gas estimation reverted; using the fallback limit"
  estimateError: NonProgressiveBlockRange(previousEndBlock 25635384, startBlock 25635381, endBlock 25635384)
  ↑ THE VAULT REFUSING THE REPLAY, in its own words. This window is already
    settled, and `verify` deliberately does not consult the ledger, so this is
    the chain's third-layer guard talking.

msg: "DRY RUN: this is exactly what would be sent"     decision: DRYRUN
  from 0xc455bF7f16ebbc2b07cb26D1Dd46194977974E7d
  to   0xCe676c73bd9fb76a73058EC135106b81A5ABd0f5
  valueWei 403370889498747  (0.000403370889498747 ETH)
  nonce null                 ← nothing was reserved, because nothing will be sent
  gasLimit 900000  maxFeePerGas 24031200  calldataBytes 932
  calldataHash 0xa5956cafa8388e2410edd24de87926ddd7090c16ebd9ddfd0a4fd1cd33497ab2
  attestationDigest 0xa5419ddf7942ed1c22246c8ee643d0b3f9a8f6aa102b15d3cb9b30f3730a6ca3
  attestation: bindingEpoch 1, policyNonce 1, adminEpoch 1, localPauseEpoch 1,
               globalPauseEpoch 0, settlementNonce 1, attesterEpoch 1,
               policyHash 0xfb06032d…7add, sessionId 0x259ef15b…07f4,
               contribution 403370889498747
```

Nothing was broadcast. `NUVEM_KEEPER_ALLOW_BROADCAST` was never set and
`--broadcast` was never passed, so the trading key was never even read
(`tradingKeyPresent: false` in the startup line).

A full `tick`, same account, `FROM_BLOCK` 1,200 blocks behind the head:

```
outcome NO_CANDIDATE   "0 transaction(s) scanned, no closed session"
headBlockL2 23038029   anchorBlockL2 23037965   rpcCalls 1172   durationMs 55877
inFlight 0   degraded null   journalSeq 1
```

Chain id verified, vault snapshot read, recovery reconciled, discovery scan
complete, anchor advanced, `CHECKPOINT` written.

The loop, invoked **exactly as the container does** — no subcommand, no
`--broadcast`, heartbeat on 8787:

```
msg "heartbeat listening"   host 127.0.0.1  port 8787
msg "tick"   outcome NO_CANDIDATE   rpcCalls 271   durationMs 13268

GET /health  → 200
  {"status":"ok","service":"@nuvem/keeper","mode":"dry-run","uptimeS":28,"lastTickAgeS":15}

GET /status  → 200   (excerpt)
  chainOk true   chainIdObserved {"ok":true,"value":4663}
  headBlockL2 23044634   anchorBlockL2 23044161   anchorLagBlocks 473
  attester 0x864743540b6D6E0a38f535e1200c0373e0D7AAde   attesterMatchesRegistry true
  inFlight []   lastSettlement null   degraded null
  vault: activeVault 0xF7309dC8…8255, status 2 (ACTIVE), bindingEpoch 1,
         settlementNonce 1, lifetimeContribution 403370889498747,
         accountBalanceWei 30274037447092363, protocolPaused false,
         settlementPaused false
  journal: seq 1, counts {HEADER 1, CHECKPOINT 1, …all others 0}, truncatedTail false
  mode dry-run   tradingKeyPresent false
```

The journal, dumped and hash-chain verified:

```
records: 2  hash chain: intact
0000 HEADER      baselineSettlementNonce "1"  baselineLifetimeContribution "403370889498747"
0001 CHECKPOINT  anchorBlockL2 "23044161"  anchorBlockHash 0x5e9dc33e…1bf1  headBlockL2 "23044225"
```

Note `baselineSettlementNonce: 1`. The canary had already settled once by hand, so
"chain nonce == journal count" is false from the start; the reconciliation
invariant is stated against that recorded baseline rather than against zero.

`recover`, proving the total-state-loss path against real chain data — the whole
settled history rebuilt from indexed logs plus ABI-decoded `settle` calldata, with
no local state at all:

```
settlementNonce 1   lifetimeContribution 403370889498747
found 1   undecodable []   contributionSum 403370889498747   ← reconciles exactly
  sessionId      0x0d176cd39f2e1e5d415ab74379bef9d4c8027073f41995e1b7cc5bbb089c2168
  txHash         0xd342d117634464f9c6c5b9b463dd8c0be1e638fdf623ea78334a097ad1cad186
  blockNumberL2  22086139
  windowL1       [25635381, 25635384]     ← recovered from calldata; no getter exists
  ledgerRoot     0xbc9407f1a72d27440e211568ad4842bd2fe0cbb2eeb686b88edfd4062cc674e5
  contribution   403370889498747   realizedProfit 2016854447493738
```

### The address in the milestone brief is the wrong role

`0xaED788B3C69CA941A4302899f80cCAD219942CA7` is the **vault admin**, not the
trading account. Read back from mainnet this session:

```
account 0xaed788b3…942ca7
  activeVault           0x0000000000000000000000000000000000000000
  status                0 (NONE)     bindingEpoch 0     settlementNonce 0
  accountBalanceWei     375217450840000
```

`factory.activeVaultOf()` returns the zero address for it, so it can never be
`msg.sender` for `settle` — `SettlementExecutor.sol:85` resolves the vault from
`msg.sender` and a zero vault fails `_validateAttestationBinding`. Pointed at
that address the keeper does the right thing and says so, rather than producing a
signature that could never be used: `DEFER{VAULT_MISMATCH}`, with the reason
spelled out. Its `status`/`tick` output above is real.

The actual trading account is `0xc455bF7f16ebbc2b07cb26D1Dd46194977974E7d`, which
`activeVaultOf` maps to the canary vault `0xF7309dC8…8255`.

---

## Custody, honestly

**v1 serves the operator's own wallet, and holds two keys:**

| key | what it can do |
| --- | --- |
| `NUVEM_ATTESTER_PRIVATE_KEY` | sign only. Cannot move a wei. Needs no gas and no balance — the live attester `0x8647…AAde` holds 0, and it should stay that way. |
| `TRADING_OWNER_PRIVATE_KEY` | **total custody of the whole wallet**: every token, trading, and revoking the EIP-7702 delegation. |

They are kept in separate code paths and separate config surfaces because the
migration story is precisely "delete the trading key, keep the attester key".

**This is why multi-user is not yet possible.** Holding a third party's trading
key would be custody of their entire trading wallet, not just of their savings
policy. That sentence is the whole reason, and it should not be softened.

The trading key is required because `SettlementExecutor.settle` resolves the
vault via `factory.activeVaultOf(msg.sender)`, so `msg.sender` **must be the
trading account itself**. The attester service can never call `settle`; it can
only sign.

### The upgrade path — documented, not built

Install a session key on the 7702-delegated account, scoped to the `settle`
selector on the allowlisted executor under a native-token spend cap. The service
then holds a key that cannot move funds elsewhere, cannot trade for you, and cannot
revoke the delegation.

Two shapes exist. The brief nominates the ERC-4337 UserOperation; chain evidence
favours the **direct call** — a service-owned EOA sends a plain type-2
transaction to `account.execute(EXECUTOR, contribution, settleCalldata)` and the
account is `msg.sender` at the executor:

- no bundler, no EntryPoint, no paymaster, no gas policy — it removes three live
  dependencies instead of adding them;
- the **service** pays gas, decoupling "can we settle" from "does the trader hold
  gas". Under ERC-4337 the account self-funds each UserOp from its own ETH;
- an ordinary type-2 transaction, simulable and debuggable with the same tools
  that produced the working settle;
- both are equally uninstalled today, so it costs no more to reach.

**Neither is a basis for onboarding anyone until the negative tests exist.** On
the direct-call path `NativeTokenLimitModule.preRuntimeValidationHook` is an
empty no-op, so the value cap survives only via its execution hook and the
target/selector restriction only via `AllowlistModule`'s pre-runtime hook — two
single points of failure instead of belt-and-braces. Wrong target, wrong
selector, over-cap value, `executeBatch`, and revocation must all be proven to
fail against the real executor first.

There is also work in `@nuvem/session-engine` before either can ship: `SETTLEMENT`
is recognised purely by top-level `tx.to === executor && tx.input.startsWith(0xf38ac34f)`,
so under a bundler the settle transaction is not merely misclassified — it is
never *discovered*, and the window fails `NOT_RECONCILED` by exactly the
contribution. That fails closed, but permanently: every later session whose window
contains a settle transaction becomes unsettleable forever. v1 stays on a plain
top-level EOA call for that reason.

---

## Operational notes

### Health vs status

`src/health.ts` serves two endpoints on `NUVEM_KEEPER_HTTP_PORT`, split for the
reason `packages/web`'s health route already documents: a probe that talks to the
chain turns an RPC hiccup into a restart loop, and restarting has never once fixed
an upstream RPC.

- **`GET /health`** — the container probe. Makes no RPC call, touches no file.
  Returns 503 **only** when the tick loop is wedged, which is the one condition a
  restart fixes. Being degraded, dry-run or unable to reach the RPC does *not*
  fail it: a halted keeper must stay up to explain itself.
- **`GET /status`** — the operator and alerting view. Reads the chain and the
  journal, allowed to be slow, and must never appear in a `HEALTHCHECK`. Every
  chain-derived field is `{ok:true,value} | {ok:false,error}` rather than a bare
  value — a failed read is never silently a zero or a false, because a green tick
  for something that was not verified is the bug this whole codebase exists to
  prevent.

The port is deliberately unpublished in `docker-compose.yml`: `/status` describes
a service holding a signing key. Only `GET`/`HEAD` are accepted; a keeper holding
a signing key should not grow a mutating HTTP surface by accident.

### Alert on

No heartbeat for 5 intervals (silence is the real failure mode — a keeper quietly
doing nothing, not a keeper crashing); `degraded != null`; an in-flight intent
older than its own deadline; `nonceReconciled == false`; `chainOk == false`;
`attesterMatchesRegistry == false`; a monotonically growing anchor lag;
`contributionBps != savingsBps`; a rising refusal rate (a classifier regression
looks exactly like a quiet trader); and — pointedly — `mode == "live"` when
nobody expected it to be.

### Container posture

`read_only: true`, `tmpfs: /tmp`, `no-new-privileges`, and the state volume as
the single writable mount. The attester key arrives as a **file** (0400 docker
secret or bind mount), never as a build ARG — build args live in image history
forever. `NUVEM_KEEPER_STATE_DIR` is pinned to
`(chainId, factory, executor, vault, account)` on first use and refuses to start
on a mismatch rather than migrating: a volume that once held testnet state is the
cheapest available route to a wrong settlement. A `keeper.lock` pidfile makes two
keepers on one volume an error, because both would see an unsettled window and
both would broadcast.

### A change `@nuvem/session-engine` needs

`@nuvem/session-engine` is a declared workspace dependency, but its
`package.json` `exports` map publishes exactly one entry point
(`./dist/src/session.js`) re-exporting only `buildSessionReport`. The keeper also
needs `detectSessions`, `openSessionStatus`, `classifyWindow`, `scanWindow` and
`httpRpcClient`, and Node answers a deep import with
`ERR_PACKAGE_PATH_NOT_EXPORTED`.

Modifying that package is out of scope for this milestone, so `src/engine.ts`
imports the engine's source through relative paths, funnelled through that **one**
auditable module rather than scattered through `src/`. Reimplementing detection
locally was the alternative and was not on the table: two implementations of
session boundaries would eventually disagree, and the disagreement would be about
money.

The fix, when the engine can be touched, is either a subpath export or
re-exporting those five symbols from `session.ts`. After that, `src/engine.ts`
changes its import specifiers and nothing else does, and this package can emit
JavaScript instead of running from source.
