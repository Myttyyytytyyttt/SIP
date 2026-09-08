# Threat model — the volume skim

## What is being modeled

SIP takes a slice of the **size** of every buy and every sell — basis points of
notional, 20 by default, so 0.2% — and moves it into the user's own
`PersonalVault`, where it accumulates and is invested in the basket that user
chose. It is not a slice of profit, and nothing in this document is about
measuring profit.

The trading wallet is meant to work anywhere. A user may export its key into
GMGN or Axiom, or import a key they already had. So the skim cannot be taken at
the moment of the trade: it is **observed on chain after the fill** and **pulled
afterwards** through a policy-bounded Privy signer seat. Collection is
best-effort by construction — a pull takes `min(owed, balance − reserve)` and
carries the shortfall forward — and the security analysis has to be read with
that in mind, because "we can always collect" is never one of the claims.

**No deployment exists.** There is no factory, no executor, no vault and no
attester registry live anywhere for this product. Every address in this
document's history has been abandoned; see *Nothing is deployed*, below. The
exact pre-deployment gate lives in the
[deployment runbook](../runbooks/DEPLOYMENT.md), and this document does not
duplicate it.

Solidity paths and bare `.sol` filenames are relative to `packages/contracts`;
everything else is written from the repository root.

Verified state at the time of writing: `@sip/worker` 511 tests, `packages/contracts`
425 tests, `@sip/web` builds against a 69-fragment ABI check. A dry-run tick
completed against mainnet and the observer reconstructed real fills to the wei.
That is evidence the mechanism works. It is not evidence that it is safe to arm.

## Nothing is deployed, and the old addresses are abandoned on purpose

The factory, executor and trading-account addresses that earlier versions of this
document carried are not a starting point to be reused. They were read from chain on
2026-09-08 and all 18 trading accounts linked to that factory are `ACTIVE` with
`savingsBps` between 1000 and 3000 — a **percentage of profit**, which is what
that product charged.

This product charges basis points of **volume**, and Phase 0 delivers the volume
through the attestation's cash field. Pointing a SIP worker at one of those
accounts would apply a 10–30% rate to a notional: roughly a hundred times what
the user agreed to, on somebody else's wallet. That is why:

- `packages/worker/src/config.ts` **requires** `SIP_VAULT_FACTORY`,
  `SIP_SETTLEMENT_EXECUTOR` and `SIP_LOGS_FROM_BLOCK`, and refuses to start
  without them. There is no fallback that happens to point somewhere real.
- `packages/worker/src/chain/constants.ts` pins only chain facts — WETH, the GMGN
  router, the Uniswap v4 PoolManager, the event topics — and no deployment.

Treat any address that reappears in a config, a default or an example as a bug,
not as a convenience.

## The central trust assumption, and how it changed

The old assumption was that an attester correctly measured **profit**. That was
unfalsifiable in practice: profit needs cost basis, a position-delta claim across
the window, and a judgement about airdropped inventory. A reader who disagreed
with the number had no cheap way to prove it wrong.

The new assumption is that SIP correctly measures **volume**, and the crucial
difference is that **volume is objectively recomputable by anyone from a public
RPC**:

- **A buy's notional is `tx.value`.** It is in the transaction itself. Nothing is
  inferred.
- **A GMGN sell's notional is stated by the router.** `FILL` and `FEE` are both
  indexed by the wallet; gross is `amountOut + fee`
  (`packages/worker/src/observe/venues/gmgn.ts`).
- **Anything else is a block residual, and the residual must be provable.** The
  reconciler will only attribute the block's leftover cash to a sale when nothing
  else in the block could have produced it (`packages/worker/src/observe/reconcile.ts`,
  §3.3–3.4 of `packages/worker/DESIGN.md`).

A window's `batchRoot` commits the sorted hashes of its fills, so a third party
with the same public data can recompute the root, the sum, and every individual
fill, and can contradict a false one with the same evidence SIP used. That is the
whole security gain of the volume design, and it is worth stating precisely:
**volume moves from unfalsifiable to falsifiable. It does not move from trusted
to verified.**

**No contract closes this gap either.** `SipVolumeExecutor.pull` recomputes
`owedWei = sumNotionalWei × savingsBps / 10_000` and reverts `InvalidOwed` on any
mismatch. That proves the attestation is arithmetically consistent with the rate
the user set. It proves nothing about whether `sumNotionalWei` describes trades
that happened. A contract cannot read a past balance, cannot see a router log
from a block ago, and cannot recompute a residual.

So the honest statement of the trust model is: the contract enforces the *rate*,
the public chain enforces the *auditability*, and nothing but the operator's
discipline enforces the *number* at the moment it is signed.

## What a corrupted attester can still do, and what actually bounds it

A corrupted or buggy attester can sign a window whose `sumNotionalWei` is larger
than the wallet really traded. What stops that from being unbounded:

1. **`savingsBps` is the user's, and the executor recomputes against it.** At the
   default 20 bps, an attester must claim 500 wei of fabricated volume for every
   wei it wants to skim. It is a multiplier on the lie, and it is the single most
   effective bound in the system. A user who set the rate to 0 cannot be charged
   at all, whatever is attested.
2. **`outstanding` bounds the value.** `msg.value` may not exceed
   `owed + a.owedWei − collected`; a fuzz test pins that value never exceeds owed
   (`SipVolumeExecutor.t.sol::testFuzzValueNeverExceedsOwed`).
3. **The balance clamp, but read the phase carefully.** In Phase 0 the deployed
   `SettlementExecutor` clamps the contribution against the wallet's balance less
   `tradingFloorWei + gasReserveWei`, and `packages/worker/src/attest/phase0.ts`
   refuses to sign a window where that clamp would bind — because a clamp that
   binds makes the recomputed amount disagree with the signed one. In **Phase 1**
   there is deliberately **no balance clamp in the contract** at all
   (`SipVolumeExecutor.t.sol::testNoBalanceClampAndNoExactMaximum`): the caller
   chooses `msg.value`. So under Phase 1 the trading floor is enforced by the
   worker, off chain, and not by the executor. That is a real reduction in
   contract-level protection and it is the price of allowing partial pulls.
4. **`minContributionWei` from below** — anti-dust, not a security bound.
5. **The executor has no arbitrary recipient.** Value goes to
   `factory.activeVaultOf(msg.sender)` and nowhere else. `SipVolumeExecutor` is
   ownerless and immutable: no withdrawal, no admin call, no upgrade,
   no sweep.
6. **Replay is per batch root.** `usedBatch[batchRoot]` refuses a second
   presentation even under a fresh settlement nonce
   (`testBatchReplayRevertsEvenWithAFreshNonce`), which matters precisely because
   a partial pull leaves an attestation that was only partly collected.
7. **The attestation is bound to live vault state.** `policyHash`,
   `settlementNonce`, `bindingEpoch`, `policyNonce`, `adminEpoch`,
   `localPauseEpoch`, `globalPauseEpoch` and `attesterEpoch` are all committed and
   all re-read at execution. A rate change, a pause or an executor repoint between
   signature and pull fails the pull closed
   (`testPausesPolicyChangeAndRepointFailClosed`,
   `testAccountPolicyChangedUnderASignedAttestationRevertsOnThePolicyHash`).
8. **The wallet has to agree.** The pull is sent *by the trading wallet*, signed
   through its Privy seat. An inflated attestation is inert without a wallet
   willing to spend value on it.

### The caps exist in the contract and SIP currently sets them to no-ops

`maxPerSettlementWei`, the account 30-day rolling cap `maxRolling30dWei`, and the
vault's `maxAggregateRolling30dWei` are all enforced by the executor and the
vault. **SIP's own provisioning sets all three to `UINT128_MAX`** — see
`tradingPolicy()` in `packages/website-oficial/src/lib/wallets/policy.ts` and the
vault creation path in `src/app/api/create-vault/route.ts`, which record the
reason: a shared aggregate ceiling is consumed by whichever wallet trades first
and silently blocks the rest of the vault.

That reasoning is defensible as a product choice and it must not be quietly
reported as a security control. **As provisioned today, the rolling and
per-settlement caps bound nothing.** The bounds that are actually load-bearing
are `savingsBps`, `outstanding`, the balance floor (off chain in Phase 1), and
the absence of any recipient other than the user's own vault.

If the caps are to count as mitigations, someone has to choose real numbers and
this document has to say what they are.

## The reconciler's refusal discipline is a security property

The worker's first rule is that **fabricated volume is the one unforgivable
output** (`packages/worker/DESIGN.md` §0.3). A `(wallet, block)` whose cash
movement cannot be attributed to exactly one thing is refused: recorded, retried
on later ticks, never attested. A refusal voids every fill *and* every exclusion
of that block, so the ledger holds either the whole block placed or the single
reason it was not.

The refusal reasons are `MULTI_FILL_BLOCK`, `UNEXPLAINED_INFLOW`,
`WALLET_HAS_CODE`, `STATE_UNAVAILABLE`, `INCOMPLETE_RANGE` and `UNDECODED_SELL`
(`packages/worker/src/types.ts`). Two are worth naming for what they defend:

- **`WALLET_HAS_CODE`** — a delegated (EIP-7702) or contract wallet can move cash
  by paths balance reasoning cannot see, so anything trade-shaped without a venue
  decoder refuses rather than being priced. This is exactly the population the
  product invites, so expect it to fire.
- **`UNDECODED_SELL`** — a sale the decoder would not parse produces no
  attributable proceeds unless the residual is positive and provable.

The GMGN decoder refuses rather than guesses too: every shape check returns
`null`, and a `null` costs nothing because the reconciler still prices a buy from
`tx.value` and a lone sell from the residual.

### Two ways the residual could have been made to lie, fixed 2026-09-07

Both were found by adversarial review, both are closed, and both are recorded
here because the reasoning generalizes.

**1. A residual sell absorbing an unrelated inflow from another wallet-sent
transaction in the same block.** The residual is *defined* as whatever the
closing cash identity would otherwise call missing, so the identity can never
contradict it — that is the structural trap. Native cash reaches an EOA through
internal calls that leave no log, so any other transaction the wallet sent
carrying native value could have had some of it returned inside the same block,
and the residual would book that refund as trading proceeds. Routers refund what
a swap did not spend, so this is an ordinary event, not an exotic one. The
reconciler now refuses `UNEXPLAINED_INFLOW` when an undecoded sell shares its
block with any transaction the wallet sent carrying value, names those
transactions in the refusal detail, and — when the venue paid in WETH, which
moves only by `Transfer` log — additionally requires the residual to equal the
sell's own WETH leg exactly.

**2. A stranger's `Transfer` log parking a wallet's cursor.** Candidate blocks are
nominated by `Transfer` logs, whose indexed fields any third party can fill with
any address. A refusal parks that wallet's cursor for the whole retention window,
so a spam log was a denial-of-service anyone could mount for the price of one
log. A block where the wallet **sent nothing and its cash did not move** now
yields an *exclusion*, not a refusal. The distinction is deliberate and narrow:
the same log still refuses when the wallet transacted in that block, or when its
cash moved, because that could be a genuine relayed sell.

**The residual exposure that remains is bounded on purpose.** A spam log in a
block where the wallet *did* transact still refuses that block. Widening it needs
a joint decision by the reconciler and the tick, and it is open item 3 below.

### The direction of error matters

A residual notional is **net** of the venue's fee, because the fee never touches
the wallet's balance. The decoded path reports **gross**. So the same sale is
worth slightly less when the decoder could not parse it, and the residual is a
**lower bound on gross, never above it**. Every failure mode in the measurement
path therefore under-charges. That is the right direction for a fee, and it is
the reason the gross-vs-net question below is a product decision rather than an
incident.

## The Privy seat is a claim on the signing path, never on the funds

`pull` (and Phase 0's `settle`) resolve the vault from `msg.sender`, so the
transaction has to come from the trading wallet. The only other way to satisfy
that is to hold the wallet's private key, which is total custody of everything in
it — the thing that made the earlier design unable to serve anyone but its own
operator.

The seat replaces it. The user's wallet stays theirs; the app is added as an
additional **signer** with a **policy**, and Privy's enclave refuses anything the
policy does not allow. Concretely, the app is key quorum
`zdhe35f97hmzxes5iuzga7d0` and the policy is `nxakvhwt6dctmvorrfp4xlk9`:
ALLOW `settle` (sign and send) to the executor address only, ALLOW `invest` with
value 0, DENY `exportPrivateKey` and `exportSeedPhrase`.

Be exact about what that buys and what it does not:

- **The containment is Privy's policy engine, not a contract.** The honest
  sentence is "we cannot take your money because Privy will not let us", not
  "check the chain yourself". The policy is the security boundary, and it is a
  weaker guarantee than an on-chain module.
- **The seat is read fresh on every pull.** `walletIdOf` returns `null` when our
  signer is gone, and the answer is never cached, because the user can remove
  every signer through Privy's API without touching any UI of ours
  (`packages/worker/src/pull/privy.ts`).
- **It must be *our* seat.** A wallet counts as seated only when
  `PRIVY_SIGNER_ID` is among its additional signers; without that check, any
  other app's signer would be mistaken for ours.
- **`signTransaction`, not `sendTransaction`, on purpose.** The worker holds the
  raw bytes — and therefore the hash — before the network sees them, so the
  crash-after-broadcast window is closed by ordering (reserve nonce → estimate →
  sign → record INTENT → send raw), not by detection
  (`packages/worker/src/pull/submit.ts`). A signature already issued but not yet
  broadcast survives a revocation; that window is closed by the same ordering.
- **The policy pins the Phase 0 executor's address.** A new deployment therefore
  needs the policy updated to the new executor before any live pull. Until it is,
  the enclave denies the signature — which fails safe, and is the behavior to
  want. The scripts that created and updated the policy lived in the package
  deleted in the clean break; the procedure must be redone against Privy's API
  and is described here rather than linked.

### What an exported key means

Exporting the trading key to GMGN or Axiom is a supported, intended action. An
exported key is **a second signer with no policy**. Therefore:

- It can empty the wallet at any moment, and it can trade in ways the seat cannot
  see coming. Nothing SIP holds can stop it.
- **Collection is best-effort, and that is a design statement rather than an
  apology.** A pull takes what is available above the floor and reserve; the
  shortfall is carried forward as debt. The product must never describe the skim
  as guaranteed.
- **The seat is not a lien.** It cannot freeze, pre-empt, or claw back.
- **The DENY on export constrains only our path.** The user's own Privy session
  can export the key. That is the product working as intended, and it should be
  said out loud in user-facing copy rather than implied.

### The unowned policy is the live weakness here

`authorization_context` is not accepted on `create` with `@privy-io/node` 0.28,
so **the policy today can be modified with the app credentials alone**. Anyone
holding `PRIVY_APP_ID` and `PRIVY_APP_SECRET` can widen it — which makes the app
secret, not the policy, the real security boundary at this moment. This is open
item 2 below and it must be closed before any live pull.

## The rate is the user's, and so is the exit

`PersonalVault.setMySavingsBps` (`:470`) and `revokeMyTradingAccount` (`:526`) are
callable by the trading wallet's own key. **This is deliberate.** A user can set
the skim to zero, or leave the vault entirely, without asking the vault admin or
SIP, and without a delay. It is the counterweight to a design in which a service
signs transactions on their wallet.

The consequences are accepted rather than mitigated:

- A user may trade at 20 bps and set the rate to 0 before the window is pulled.
  The attestation commits `policyHash` and `settlementNonce`, so the pull reverts
  `InvalidPolicyHash` instead of charging the old rate. Refusing is the correct
  outcome; the volume is simply not collected.
- Carried debt in `SipVolumeExecutor` is indexed **by account only**, so it
  survives a rate change and a move to another vault. That is an open, low-severity
  finding in the pending report, and it is the one place where the user's exit is
  not fully clean.
- In the web UI, a rate change signs from the trading wallet whenever Privy holds
  it, with an admin route offered when the wallet has no gas. **Revoke has no
  equivalent admin route**: `revokeTradingAccount` is the vault admin's own
  action, not a proxy for the user's. A gasless wallet can therefore be slower to
  leave than to re-rate.

## Protected assets and trust boundaries

Protected assets: vault WETH and native balances; the accumulated basket
positions; volume attestations; account-to-vault bindings; the attester key; the
Privy app credentials and the seat; governance control.

Trusted or privileged boundaries:

- each vault admin (the "pension key");
- the trading wallet's own key **and every exported copy of it**;
- the corporate Safe, its owners, modules, guards and transaction process;
- the seven-day timelock (`GOVERNANCE_DELAY`, `script/DeployNuvem.s.sol:112`);
- the emergency guardian;
- the attester key, and the host running `packages/worker`;
- the Privy app: its secret, its authorization key, and the policy;
- the settlement executor in force for a vault;
- the RPC provider the worker reads the world through.

## Actor analysis

| Actor or compromise | What it can do | Principal control | Residual risk |
| --- | --- | --- | --- |
| Vault admin | Withdraw everything in the vault, change the vault and every account policy, replace the settlement executor, set the investment basket and adapter, pause settlement or investment, transfer admin. | Two-step admin transfer; policy epochs and nonces; `setSettlementExecutor` (`PersonalVault.sol:851`) force-pauses settlement and bumps the epochs, killing every already-signed attestation. | Admin-key compromise is total compromise of that vault's savings. No protocol delay stands between the key and the funds. |
| Trading wallet key (including exported copies) | Trade anywhere; set its own rate, including to zero; self-revoke; call `invest` on its own vault; move every asset out of the wallet before a pull lands. | Global one-vault binding; `policyHash`/`settlementNonce` binding on every attestation; the vault decides where investment output lands. | This is the design, not a gap. It is also why collection is best-effort and why the shortfall mechanism exists. |
| Worker host (`packages/worker`) | Sign volume attestations, and ask the seat to sign a pull. **It holds no trading key.** | Dry run is structural: outside live mode the process never reads the attester key or the Privy secrets, and `submitPull` returns before touching a signer. Live mode needs a byte-exact sentinel and a durable Postgres ledger. | A live host is a signing host. It can inflate volume up to the bounds above and can deny service by not attesting. It cannot move a user's funds anywhere but that user's own vault. |
| Attester key | Authorize `sumNotionalWei` and the derived `owedWei`. | Registry rotation and guardian disablement; `attesterEpoch`; settlement nonce; the executor's `InvalidOwed` recomputation; the bounds above. | A wrong or malicious attester can sign a coherent false volume. **This is the protocol's central assumption** — but unlike a false profit claim, a false volume claim can be contradicted by anyone with a public RPC. |
| Privy app credentials | Ask the enclave to sign anything the policy allows — and, today, **widen the policy** (open item 2). | The policy's ALLOW list pins the executor address and the `pull`/`settle` selector (`testPullSelectorIsPinnedForThePrivyPolicy`); DENY on key export. | Until the policy has an owner, `PRIVY_APP_SECRET` is the real boundary and must be treated as a custody-grade secret. |
| Settlement executor | Call the vault's settlement entry point. | Factory account/vault binding; the vault re-checks every frontier invariant itself in `acceptSettlement` (`:945`); ownerless and immutable, no withdrawal and no arbitrary call. | A vault admin can repoint its own vault at a different executor, changing the trust model for that vault only. |
| Investment operator (vault admin, or any ACTIVE trading account — `_requireInvestmentAuthority`, `PersonalVault.sol:745`) | Trigger `invest` (`:639`) under the admin's stored basket and thresholds. | Basket hash is a compare-and-swap; `investmentPolicyNonce`; per-leg `minOutRateWad` floors that a caller may only tighten; min/max per call; a 30-day investment rolling cap; deadline; adapter status epoch; `setInvestmentPause` (`:616`) is separate from settlement pause. | Can choose *timing*, including straight after an adverse market move. A static admin-set output floor is not live pricing, and loosens in real terms if the admin never revises it. |
| Adapter | Receive the vault's WETH and return the target assets. | Append-only registry id; runtime codehash pinned at registration and re-checked on resolve; status epoch; guardian deactivation; the vault's own min-out and deadline. | A codehash pin does not detect a proxy whose implementation changes. Production adapter ids must point at direct immutable deployments. |
| Guardian | Pause globally; disable the attester. | Cannot unpause, re-enable, upgrade or withdraw. | Compromise denies service until timelock governance acts. |
| Corporate Safe | Propose every delayed governance operation; own the fee contracts, which no vault reads. | The deploy script checks only *coherence* of `getThreshold()`/`getOwners()` — non-zero and not above owner count — **not a quorum**, and does not authenticate Safe bytecode, owners, modules or guards. | The real mitigation is the seven-day delay and the guardian's cancel role, not the multisig's shape. |
| Timelock governance | Upgrade a cohort; govern the factory, the attester registry and global pause. | Seven-day minimum delay; Safe-only proposer; permissionless execution after maturity. | A malicious queued upgrade is still dangerous once the window matures. Monitoring and an exit path are required, not optional. |
| RPC provider | Decide what the worker believes happened. | Multiple endpoints with failover (`packages/worker/src/rpc/failover.ts`); refusals on unreadable state rather than skipped blocks. | A provider that serves wrong or partial logs produces wrong volume, and the worker cannot tell the difference between "no fills" and "logs withheld" except through the refusal paths. Today this is one Alchemy Pay-As-You-Go plan on chain 4663. |

## Critical scenarios

### Fabricated volume

A corrupted attester signs a window whose fills did not happen, or whose
notionals are inflated. The executor's recomputation catches only inconsistency
with the rate, not falsity. What contains it is the bound list above; what
*detects* it is that anyone can recompute `batchRoot` and every fill from public
data.

The by-hand check that catches it: take a `VolumePulled` event, pull its
`batchRoot`, recompute the sorted fill hashes for that wallet and window from an
independent RPC, and confirm the root and `sumNotionalWei`. Until somebody
actually runs that on a schedule, the auditability is a property of the design
and not of the operation.

### Undercounted volume, which is the ordinary failure

Refusals, undecoded fills valued by residual, and unparsed `FILL` payloads all
push the measured number **down**. The product loses revenue; the user is not
harmed. This is the failure the system is tuned for, and it is why every
ambiguous branch refuses instead of guessing.

### The same sale valued on two different bases

Measured on chain on 2026-09-07 against a real wallet: sells the GMGN decoder
understands return `amountOut + fee` (gross), while sells that fall to the
residual return what the wallet's balance actually gained (net of the router's
~1% fee). Recomputed by hand against chain, the residual matches to the wei — the
arithmetic is right, the *base* differs. On real data, 11 of 35 fills were valued
by residual.

The cause is that the `FILL` payload is dynamic ABI: in the short form word 5 is
the pool kind and words 6–7 the path, while in the long form word 5 is 27 and the
path is shifted. The decoder reads fixed indices and **refuses rather than
guesses, which is correct** — the cost is only that the sale is priced on the
other base. Parsing by real ABI offsets would eliminate most residual falls.

Security-relevant conclusion: the error is always in the user's favour. It is
open item 1 because it is a product decision about what is charged, not because
it is a hazard.

### RPC dependence

The worker's entire view of the world is one provider's `eth_getLogs` and archive
reads. On the free tier that provider caps `eth_getLogs` at 10 blocks, which
makes discovery impossible outright; the Pay-As-You-Go plan on chain 4663 is
archive-confirmed and is what the measurements above were taken on. A single
provider is a single point of both failure and truth. Failover exists in code; a
second independent provider is an operational requirement, not a code change.

### Reorg

Neither the contracts nor the worker name a confirmation depth beyond the L2
finality margin (default 64 blocks) that the scan stops at. A fill recorded from
inside the margin would survive a reorg in the ledger — its row is keyed by tx
hash and nothing deletes it — and would be attested once the margin passed, which
is fabricated volume; that is precisely why the scan stops short of the head. A
reorg that unwinds an already-*settled* window is still not handled: the local
frontier ends up ahead of the chain, and the account's next genuine window is
refused. Nothing detects that today.

### Compromised vault admin

The admin has intentionally complete control of the vault and can withdraw
everything to any nonzero recipient; `withdrawToken` (`:1051`) and
`withdrawNative` (`:1059`) deduct no protocol fee and consult no fee contract. No
protocol delay protects the user from their own compromised key. A contract
wallet or a hardware signer is preferable to an everyday hot wallet, and the
product should say so where the pension key is created.

### Malicious cohort upgrade, and the storage layout

Every vault in a cohort delegates to the same upgradeable beacon, so one
timelocked upgrade changes custody behavior for all of them. The delay gives
observation time, not prevention.

**Storage layout is the sharp edge and no tooling checks it.** Promoting an
implementation onto a beacon whose vaults carry a different layout makes the
vault read the wrong slot as its settlement executor — demonstrated by
`test/unit/UpgradeContinuity.t.sol::testNewImplementationMisreadsALegacyStorageLayout`.
`PrepareCohortUpgrade.s.sol` validates cohort separation, beacon ownership and the
implementation address, and would happily build an executable timelock payload
doing exactly this. Verify layout by hand; nothing else will.

### The synthetic frontier

`SipVolumeExecutor` drives the vault's L2 frontier with a per-account counter
rather than real heights, because a late-discovered fill behind a real frontier
would be unskimmable. The counter is seeded on first use by reading the vault's
own frontier through `extsload` at a **pinned slot** — the same word
`VaultLens.settlementFrontier` reads. A storage-layout change would silently
reseed at zero and make the first pull revert forever; that is why the slot is
pinned by `testSyntheticSeedMatchesTheVaultsOwnFrontierSlot` and the migration
path by `testPhase0FrontierSeedsTheSyntheticCounterSoMigrationNeedsNoRebind`. Do
not "tidy" either.

### The investment path

Savings are invested into a basket the vault admin configured. The controls are
real: the basket hash is a compare-and-swap so a caller holding replaced legs
cannot present them; every leg carries a non-zero, bounded `minOutRateWad` floor
that a caller may only tighten; per-call minimum and ceiling; a 30-day investment
rolling cap; a deadline; an adapter status epoch and a runtime codehash re-checked
on resolve; and an investment pause deliberately separate from the settlement
pause, because halting purchases must not halt savings arriving.

What they do not do: make a malicious or mispriced adapter safe, and substitute
for live pricing. A static admin floor loosens in real terms while the market
moves. The vault charges no protocol fee on investment or on withdrawal, and
consults no fee controller — `FeeController`/`FeeCollector` exist and are Safe-owned
but no vault reads them. Pinning either into a vault's reach reinstates a whole
class of hazard (an immediately-changeable fee on an operator-triggered call) and
must be treated as a new design, not a configuration change.

## Invariants relied upon

- One registered vault per current admin; one active vault per trading account.
- `owedWei == sumNotionalWei × savingsBps / 10_000`, recomputed by the executor
  against the vault's live policy, never taken from the attestation.
- `msg.value` never exceeds `owed + owedWei − collected` for that account.
- Value reaches only `factory.activeVaultOf(msg.sender)`. The executor has no
  withdrawal, no arbitrary recipient and no owner.
- A batch root is collectible once, even under a fresh settlement nonce, and even
  when the first collection was partial.
- The attestation is bound to chain, vault, account, executor, every epoch, the
  policy hash, the settlement nonce, the batch root, the L2 window, the amounts
  and a validity window of at most 15 minutes.
- The attested L2 window is committed by the signature and never handed to the
  vault; the vault's frontier moves on the synthetic counter.
- Freshness and the activation floor are L1-only, because Solidity's
  `block.number` is the L1 height on this chain and no L2 clock is observable
  from inside a contract.
- A refusal voids every fill and every exclusion of its block; the block is
  retried whole.
- A block's closing cash identity must balance to the wei, gas included, before
  any fill from it is recorded.
- A residual is attributable only when nothing came in from outside, nothing else
  the wallet sent moved native value, and — when the venue paid in WETH — the
  leftover equals the sell's own WETH leg.
- A block the wallet did not touch and whose cash did not move cannot be refused
  by a third party's log.
- The worker never holds a trading key, in any mode.
- Outside live mode the process never reads the attester key or the Privy
  secrets; they are deleted from the environment by name in every mode.
- Vault admin withdrawals deduct no protocol fee and consult no fee contract.
- Guardian actions are restrictive only; reversal requires delayed governance.

These are implementation invariants. They are not proof that the measured volume
is the volume that happened.

## Required operational controls

- **Run the independent recomputation.** Recompute `batchRoot` and every fill from
  a second, independent RPC on a schedule, and alert on any disagreement. The
  volume design's whole advantage is worthless if nobody exercises it.
- **Treat `PRIVY_APP_SECRET` as custody-grade** until the policy has an owner.
  Rotate it on any suspicion, and keep it on a different blast radius from the
  attester key.
- **Keep a second RPC provider configured and healthy.** One provider is one
  source of truth.
- **Treat the worker host as a signing host.** Secrets mounted rather than baked;
  scrubbed logs (any 64-hex value is redacted before it reaches a sink); backups
  of the ledger taken with the worker stopped; alert on refusal rates by reason,
  on `STATE_UNAVAILABLE` bursts, on carried debt growing, and on heartbeat
  silence.
- **Never point a worker at a factory whose accounts were provisioned under a
  different meaning of `savingsBps`.** The config refuses a missing factory; it
  cannot tell a profit-rate account from a volume-rate one.
- **Decide real values for the three caps, or stop describing them as controls.**
- **Keep deployer, attester, guardian, vault-admin, trading and Privy
  authorization keys separate.**
- **Monitor every timelock, beacon, attester, pause, executor and admin change.**
- **Verify storage layout by hand before any cohort upgrade.** No script does it.
- **Keep the vault implementation inside the bounds asserted in
  `test/unit/UpgradeContinuity.t.sol` (24,000 bytes, and a ratchet at the same
  figure).** There is no CI in this repository — no `.github` directory — so those
  bounds hold only when someone runs `forge test`. Raising the ratchet must be a
  deliberate act with a reason attached.
- **Publish what a best-effort skim means** to users, in plain language, before
  the first live pull.

## Open items carried from the review

From [`reports/PENDING_REVIEW_FINDINGS_2026-09-07.md`](../../reports/PENDING_REVIEW_FINDINGS_2026-09-07.md),
the three findings still open, in that document's own order:

1. **Gross vs net notional.** The same sale is valued gross by the decoder and net
   by the residual; 11 of 35 fills on real data were valued net. The proposed fix
   is to add a parsable GMGN `FEE` amount back onto a residual whose `FILL` could
   not be parsed, returning gross; the alternative is to redefine notional as net
   on both sides. It is a product decision because it changes what is charged.
   Security-wise the current behavior only under-charges.
2. **The Privy policy has no owner.** `authorization_context` is not accepted on
   `create` with `@privy-io/node` 0.28, so the policy can be modified with the app
   credentials alone. **This must be closed before any live pull.**
3. **Bounded residual exposure, kept on purpose.** A spam log in a block where the
   wallet *did* transact still refuses that block. Narrowing it further requires a
   joint decision by the reconciler and the tick.

The same report carries the applied-and-verified list and a longer set of
medium/low findings in the worker, the contracts and the web app. Read it whole
before deployment; this document summarizes only what changes the trust model.

## The pre-deployment gate

There is no deployment. The exact gate that must be met before there is one — and
every step of the deployment itself — lives in the
[deployment runbook](../runbooks/DEPLOYMENT.md). Two items belong to this document
and are repeated here only because they are security preconditions rather than
deployment steps:

- the Privy policy must be updated to the **new** executor address, and must have
  an owner, before the seat is used live;
- the independent volume recomputation must be running before the first live
  pull, because it is the only control that detects the central failure.
