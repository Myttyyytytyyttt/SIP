# What the session engine says the attestation schema needs

**Date:** 2026-07-29
**Source:** `packages/session-engine-old`, run against the real mainnet history of the
canary wallet `0xc455bF7f16ebbc2b07cb26D1Dd46194977974E7d` on chain 4663.

The engine was built before changing the schema, deliberately: designing the
fields in the abstract risks getting them half-right, and the executor address is
cheap to change now and expensive later. These are its findings.

## What the prototype established

Reconciliation works. Across every window tested, the movements the engine
discovers explain the balance change **to the wei** — `residualWei == 0`. That
was the riskiest assumption and it holds.

It reproduces what mainnet already accepted. For the canary window the engine
independently derives `cashStart = 31229961908171659`,
`cashEnd = 33246816355665397`, `realizedProfit = 2016854447493738` — byte-identical
to the values inside settle tx `0xd342d117…cad186`, which the SettlementExecutor
validated onchain. The chain is the oracle and the engine agrees with it.

Four data sources are all necessary. Drop the block scan and the pre-sell
`approve` disappears — it emits no `Transfer`, moves nothing, and costs
1,289,501,640,000 wei of gas, so the residual is wrong by exactly that. Drop
`debug_traceTransaction` and sell proceeds disappear entirely, because the GMGN
router unwraps WETH and forwards native ETH by internal call. `trace_*` and the
asset-transfer `internal` category do not exist on this chain.

## The invariant is not "flat-to-flat"

The wallet holds 160 units of an airdropped token and will never be flat again,
yet the canary window is perfectly attestable. The condition that actually
matters is **position-delta-zero**, and it has two clauses:

> Every non-cash token has an identical balance at both boundaries, **and** every
> unit disposed of inside the window came from a lot with cash cost basis.

The first clause alone is not enough. An airdrop received before the window and
dumped inside it leaves the delta at zero while manufacturing profit from
nothing — which is why the FIFO lot inventory that tags each lot `CASH_BASIS` or
`ZERO_BASIS` is load-bearing rather than decorative.

## Findings that change the schema

**1. Position state must be committed.** Nothing in the current 24 fields encodes
it. Add a `positionsRoot` (keccak over sorted `(token, balanceStart, balanceEnd)`)
and a verdict code. The contract still cannot verify these — the attester remains
the data authority — but a false claim becomes attributable and publicly
checkable against the published report.

**2. `zeroBasisRealizedWei` needs its own field, required to be zero.** Without
it, airdrop-and-dump settles at 20% of pure fiction. This wallet contains that
exact hazard today.

**3. L2 heights belong in the struct.** They are currently smuggled inside
`ledgerRoot`, which works only because `ledgerRoot` is opaque. Making them
explicit also fixes the `lastEndBlock` liveness failure: 258 L2 blocks collapse
into 4 L1 blocks, so two distinct sessions inside one L1 block cannot both
satisfy the progression check.

**4. `externalWithdrawals` is overloaded.** It must currently absorb a genuine
user withdrawal *and* a prior settlement distribution, which are different things
— one is the user taking money out, the other is the protocol paying itself.
Either split them or commit the classified event list under a `flowsRoot`.

**5. `replayStartBlock` / coverage.** Cost basis is only knowable if the replay
began at or before `activationBlock`. A session whose replay starts mid-history
must be unattestable, and that should be visible onchain rather than assumed.

**6. Likely dead weight: `cashStart` / `cashEnd`.** The contract recomputes
`realizedProfit` from them purely as a coherence check, and
`testTrustedAttesterCanAuthorizeCoherentFalseProfitButCapsBoundContribution`
already proves coherence constrains nothing when the attester is trusted. Worth
measuring whether they buy anything once a positions root exists.

## Findings that need no schema change

**Symbols cannot be trusted; addresses can.** The four "40 THEHOOD" airdrops come
from `0x2d5ce1a1…`, **not** the THEHOOD the wallet actually traded
(`0xfd608e84…`). It is a different contract declaring the same symbol, and
Alchemy's transfer API reports that symbol because it reads the token's own
metadata, which an impersonator sets freely. Any classification, inventory, or
UI that keys on symbol will merge a real position with a fake one. The engine
keys on contract address throughout.

**The airdrop heuristic has a known expiry.** The signal is
`receipt.from != wallet` — the wallet neither initiated nor paid. That is sound
today and **breaks the moment trades route through UserOperations**, because then
`tx.from` is the bundler. The report carries `senderHeuristicValid` so the
assumption is visible rather than implicit. A replacement will be needed before
the keeper ships.

**`ledgerRoot` is a free upgrade slot.** Solidity folds it into `deriveSessionId`,
stores it, and emits it, but never checks its preimage. Findings 1, 2 and 5 can
therefore be delivered as an extended `ledgerRoot` encoding **with no contract
change and no deployment** — enough to start producing and auditing the data, and
to learn which fields are genuinely load-bearing before freezing them into the
EIP-712 typehash.

## Status: v2 has shipped

`packages/session-engine-old/src/ledger-root.ts` implements it, and
`packages/aa-smoke-old/scripts/settle.mjs` now uses it for every settlement.

```
keccak256(abi.encode(
  LEDGER_SCHEMA_V2,        // keccak("nuvem.ledger.v2"), domain separation
  startBlockL2, endBlockL2,
  cashStart, cashEnd,
  externalDeposits, externalWithdrawals,
  positionsRoot,           // keccak over (token, balStart, balEnd), sorted
  zeroBasisRealized,
  verdictBits,             // bitfield of refusal reasons; 0 means attestable
  replayStartBlockL2
))
```

Findings 1, 2, 3 and 5 are delivered by this with **no contract change and no
redeploy**. Finding 4 (`externalWithdrawals` overloading) and finding 6
(`cashStart`/`cashEnd` possibly redundant) are left alone deliberately: both are
arguments for *removing* or *splitting* real struct fields, which cannot be done
without the executor redeploy, and neither is urgent.

The legacy encoding is retained and pinned by a test against the root the chain
already accepted — `0xbc9407f1…674e5`, inside settle tx `0xd342d117…cad186`. That
is a fact about the chain, not about this package, so historical sessions stay
reproducible and the v2 rollout was verified against a known-good value rather
than against itself.

Two properties worth stating because they are what make the root meaningful:
`positionsRoot` sorts by token address, so two runs that discover the same
movements in a different order agree; and `verdictBits` commits *which* reasons
fired, so the same cash figures under a different soundness claim cannot share a
root.

### What changed in settle.mjs

It no longer decides anything about PnL. Previously it hardcoded
`externalDeposits` and `externalWithdrawals` to zero and performed no soundness
check whatsoever — which is precisely how a hand-picked window becomes a settled
number nobody can defend. It now derives every figure from the engine and
**refuses to sign a window the engine will not vouch for**, with no override
flag.

Verified live against real mainnet history: the canary window reproduces its
accepted numbers and produces a v2 root; the window containing the airdrops is
refused with `NOT_DELTA_FLAT` and the script aborts before signing anything.

### What still needs the redeploy

Promote to real struct fields only what proves load-bearing after this has run
for a while, and do that promotion together with the executor redeploy since
both require one anyway. In the meantime, do not create further vaults on the
live factory: `configureProtocol` is one-shot, so they could never be repointed
at a new executor.
