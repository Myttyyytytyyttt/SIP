# Contract threat model

## Security posture

Nuvem's current contract design is administratively controlled, upgradeable, and
dependent on an off-chain PnL attester. It is not a fully non-custodial or
trust-minimized system.

This threat model covers the Solidity implementation and deployment topology in
this repository. It does not claim a sanctioned public deployment or a completed
production gate.

**There is no investment path in this deployment.** `PersonalVault` has no
`invest()`, no investment operator, no adapter registry and no fee controller
reference; `NuvemTypes.VaultPolicy` is the single field
`maxAggregateRolling30dWei` (`NuvemTypes.sol:43-45`) and
`VaultFactory.ProtocolConfiguration` pins four addresses — weth, pauseController,
attesterRegistry, settlementExecutor (`VaultFactory.sol:27-32`). Settlement
charges no protocol fee. Investing is deferred, not cancelled; the analysis that
covers it is preserved at the end of this document, under a heading that says so,
and nothing in it describes a risk that exists today.

## The central trust assumption: the attester is trusted on the measurement

This is the first thing to understand about Nuvem and it is not mitigated by any
contract in this repository.

`SettlementExecutor.settle` recomputes `realizedProfit` from four attested cash
figures — `cashStart`, `cashEnd`, `externalDeposits`, `externalWithdrawals` — and
reverts `InvalidRealizedProfit` on any mismatch (`SettlementExecutor.sol:93-98`,
arithmetic at `:164-181`). That check proves the attestation is internally
consistent. It proves nothing about whether those four numbers describe what the
wallet actually did.

**No contract can close this gap.** A contract cannot read past state, cannot
observe a GMGN fill, and cannot see a balance at a historical height. The four
cash figures are the only place a wrong settlement can hide, and the executor
accepts any set of them that is arithmetically coherent. This is pinned as a
test, not asserted as prose:
`SettlementExecutor.t.sol::testTrustedAttesterCanAuthorizeCoherentFalseProfitButCapsBoundContribution`.

What actually bounds the damage is not verification but the clamps: `savingsBps`,
`maxPerSettlementWei`, the account and aggregate 30-day rolling caps, and the
trading floor plus gas reserve (`SettlementExecutor.sol:352-369`). A corrupted
attester can move a false number into the vault, but only up to those limits, and
only into that account's own registered vault — the executor has no arbitrary
recipient and no administrative withdrawal (`SettlementExecutor.sol:15-21`).

The off-chain answer to this is the soundness claim now carried inside
`ledgerRoot` v2 — `positionsRoot`, `zeroBasisRealized`, `verdictBits`,
`replayStartBlockL2` (`docs/architecture/SETTLEMENT_SCHEMA_FINDINGS.md`). Be
precise about what that buys: `ledgerRoot` is opaque `bytes32` to Solidity, folded
into `deriveSessionId` and emitted but never checked against a preimage
(`SettlementExecutor.sol:190-206`). A false claim therefore becomes
**attributable and publicly checkable against the published report**, which is a
real improvement, and remains **unenforced onchain**, which is the whole point of
this section.

## Protected assets and trust boundaries

Protected assets include vault WETH, settlement authorizations, account-to-vault
bindings, governance control, and the two private keys the keeper holds.

Trusted or privileged boundaries are:

- each vault admin;
- the corporate Safe and its owners, modules, guards, and transaction
  process;
- the seven-day timelock;
- the emergency guardian;
- the current PnL attester, and the host running `packages/keeper-old`;
- the current settlement executor;
- the off-chain session engine/indexer and the RPC infrastructure it reads,
  including the `debug_traceTransaction` provider.

## Actor analysis

| Actor or compromise | What it can do | Principal control | Residual risk |
| --- | --- | --- | --- |
| Vault admin | Withdraw all vault assets, change the vault and every account policy, replace the settlement executor, pause/unpause, and transfer admin. | Two-step admin transfer; policy epochs/nonces; `setSettlementExecutor` force-pauses settlement and bumps `localPauseEpoch` and `vaultPolicyNonce`, killing every already-signed attestation (`PersonalVault.sol:392-403`). | Admin-key compromise is a complete compromise of that vault. No protocol delay stands between the key and the funds. |
| Trading account | Accept an invite, alter only its own savings bps, and self-revoke. A compromised account may submit trades outside Nuvem. | Global one-vault binding; account caps, floor, reserve, L2 progression, and aggregate cap. | Nuvem cannot stop external trading or guarantee profit data without the attester. |
| Keeper host (`packages/keeper-old`) | Sign attestations **and** send the `settle` transaction. In v1 it holds `TRADING_OWNER_PRIVATE_KEY`, the trading account's own key. | Two broadcast gates (argv `--broadcast` plus an exact-match env sentinel); mounted key file rather than env var; per-settlement and per-day circuit breakers; a durable settled-window store. | **Holding that key is total custody of the trading wallet**, not scoped access to its profit — the restriction to `settle` is a property of this code, not of the credential. This is why Nuvem cannot serve third parties. See `docs/runbooks/ATTESTER.md` section 1. |
| PnL attester | Authorize the four cash figures used to calculate realized profit and contribution. | Registry rotation/disable, expiry, `attesterEpoch`, settlement nonce, L2 session progression, executor-side arithmetic, and the contribution clamps. | A malicious or incorrect current attester can authorize false but internally consistent economic inputs. See the section above; this is the protocol's central assumption. |
| Session key (AA path) | Execute the narrowly encoded settlement call within its native limit. | Exact executor/function permission, native limit, replay controls in contracts. | The native cap rests entirely on the selector allowlist containing `execute` **alone**, because `NativeTokenLimitModule` does not decode `executeBatch` (measured live on 46630). Widening that one line silently removes the value cap. Not installed on mainnet; testnet smoke is not mainnet proof. |
| Settlement executor | Call vault settlement entry points. | Factory account/vault binding, detailed attestation/policy checks, immutable with no withdrawal or arbitrary-call surface. | A vault admin can replace its executor; a malicious replacement may change the expected trust model even though the vault re-checks every frontier invariant itself (`PersonalVault.sol:511-552`). |
| Guardian | Pause globally and disable the attester. | Cannot unpause, re-enable, upgrade, or withdraw (`ProtocolPauseController.sol:22-29`, `AttesterRegistry.sol:44`). | Compromise can deny service until timelock governance acts. |
| Corporate Safe | Propose all delayed governance operations, and immediately change fee/collector/treasury on `FeeController`/`FeeCollector`. | Threshold COHERENCE checked at deployment (non-zero, not above owner count) — **not** a quorum. The Safe live on mainnet is **1-of-2**, so this row's real mitigation is the seven-day delay and the guardian's `CANCELLER_ROLE`, not the multisig shape. A single key proposes. | **The fee contracts are deployed but not pinned into `ProtocolConfiguration`, so no vault can reach them** (`DeployNuvem.s.sol:131-141`); a fee change today moves no money and touches no vault. Safe bytecode, owner identity/security, modules, and guards are not authenticated by the script, and Safe compromise can still queue an upgrade of protocol logic. |
| Timelock governance | Upgrade a cohort and govern the factory, the attester registry, and global pause. | Seven-day minimum delay; Safe-only proposer; open execution after maturity. | A malicious queued upgrade remains dangerous after the observation window. Monitoring and an operational exit path are required. |
| Deployer/bootstrap | Creates the initial topology and starts the factory ownership handoff. | Chain/config checks; sealed bootstrap has no post-deployment owner action. | Wrong inputs are irreversible. Until timelock acceptance, factory governance is frozen rather than held by the deployer. |

## Critical scenarios

### False profit attestation

The executor recomputes arithmetic and the vault enforces progression, but
neither can observe an external platform fill or a historical balance. A
corrupted attester can sign false source data that passes every onchain check.
Independent reconciliation, monitoring, rapid guardian disablement, and attester
key isolation remain mandatory. The clamps bound the loss per settlement and per
30 days; they do not detect the lie.

Concretely, the by-hand check that catches this is: take an `ATTESTABLE` decision
line, independently recompute `realizedProfit` from the four cash figures, and
confirm `contributionBps == 2000`. Nobody else performs it
(`docs/runbooks/ATTESTER.md` section 5, step 4).

### Keeper host compromise

The v1 keeper holds the trading account's own private key. An attacker with that
key does not need Nuvem at all: they can move every asset in the wallet, to
anywhere, immediately. The broadcast gates, circuit breakers and refusal logic
constrain the keeper's own behavior and constrain an attacker not at all.

The consequences that follow are operational rather than contractual: the key
must belong to the operator running the service, the host must be treated as a
signing host, and no second user may be onboarded until the EIP-7702 session-key
path in `docs/runbooks/ATTESTER.md` section 1 is real and tested.

### Malicious cohort upgrade

Every vault in a cohort delegates to the same upgradeable beacon. A timelocked
upgrade can change custody behavior for all of them. The delay provides
observation time, not technical prevention.

**Storage layout is the sharp edge here, and it is not checked by tooling.**
Removing `adapterRegistry`, `feeController`, `investmentOperator` and
`investmentPaused` from `VaultStorage` shifted `settlementExecutor` from offset 9
to offset 7 and everything after it. Promoting this implementation onto a beacon
whose vaults carry the pre-change layout makes the vault read its old
`adapterRegistry` slot as its settlement executor — demonstrated in
`test/unit/UpgradeContinuity.t.sol::testNewImplementationMisreadsALegacyStorageLayout`.
`PrepareCohortUpgrade` validates cohort separation, beacon ownership and the
implementation address; it does **not** validate storage layout, so it would
build an executable timelock payload doing exactly this. Upgrade bytecode,
storage layout, tests, and an exit procedure must be reviewed before scheduling.

### Position state crossing settlement windows

Recomputed cash deltas are only a valid realized-PnL measure when the session's
non-cash position is unchanged across the window. Buying for 5 ETH in one window
and selling for 6 ETH in the next produces cash deltas of -5 and +6, not the
1 ETH round-trip profit.

The measured condition is **position-delta-zero, not flat-to-flat**: every
non-cash token has an identical balance at both boundaries, *and* every unit
disposed of inside the window came from a lot with cash cost basis. The first
clause alone is insufficient — an airdrop received before the window and dumped
inside it leaves the delta at zero while manufacturing profit from nothing, and
the canary wallet contains that exact hazard today (160 units of an airdropped
token, and four impersonating "40 THEHOOD" transfers from a contract that is not
the THEHOOD the wallet traded).

`packages/session-engine-old` enforces this off-chain and refuses to sign a window it
will not vouch for, with no override flag; `ledgerRoot` v2 commits the claim.
**The contract still cannot check it.** Production settlement therefore rests on
the attester honoring its own refusal, which is the same trust assumption as
above wearing a different hat.

### Compromised vault admin

The admin has intentionally complete control of its vault and can withdraw all
assets to any nonzero recipient. No protocol-level delay protects the user from
its compromised key. A contract wallet or secure signer policy is preferable to
an everyday hot wallet.

### Degenerate L2 window

Zero is the settlement frontier's "nothing settled yet" sentinel. A window whose
`endBlockL2` is 0 would write that sentinel back as a real height, and every later
window — overlapping or not — would then clear the progression guard forever: one
signature permanently disabling replay protection for that account.

Both layers refuse it. `SettlementExecutor.sol:297-299` reverts
`InvalidL2BlockRange` when `startBlockL2 == 0` or `endBlockL2 <= startBlockL2`,
and `PersonalVault.sol:524-530` refuses the same window independently rather than
trusting the executor to have done so — which it must, because
`setSettlementExecutor` lets an admin repoint the vault at a different executor.
Pinned by `testDegenerateL2WindowIsRefusedSoTheFrontierSentinelStaysSound` and
`testInvertedL2RangeIsRefusedByBothExecutorAndVault`.

## Invariants relied upon

- One registered vault per current admin and one active vault per trading
  account.
- Trading accounts do not define the vault identity or address.
- Factory canonical configuration can be set only once.
- Settlement authorization is bound to chain, executor, vault, account, policy,
  epochs, nonce, session, both block ranges, expiry, and exact contribution.
- Account and aggregate rolling caps both apply, and the contribution is
  additionally clamped by the trading floor plus gas reserve.
- Session progression is strictly increasing on the **L2** range; the **L1**
  range is only required to be non-decreasing, under the distinct error
  `NonProgressiveL1BlockRange` (`PersonalVault.sol:541-552`).
- A degenerate L2 window is refused at both layers, so the frontier's zero
  sentinel is never a real height.
- The L2 heights are part of `sessionId` (`SettlementExecutor.sol:190-206`), so
  `usedSessions` keys on the window actually signed rather than on an L1 range two
  distinct sessions can share.
- Freshness (`endBlock < block.number`) and the activation floor are L1-only,
  because `block.number` and `activationBlock` are both L1 numbers here and no L2
  clock is observable from inside a contract.
- Admin withdrawals deduct no protocol fee and consult no fee contract
  (`PersonalVault.sol:596-611`).
- `policyHash` encodes `maxAggregateRolling30dWei` as a discrete `uint128` rather
  than encoding the `VaultPolicy` struct, which is what keeps the attestation
  preimage byte-identical across the removal of the investment path
  (`PersonalVault.sol:448-472`). Do not "tidy" it.
- Guardian actions are restrictive only; delayed governance performs reversal.
- Existing cohort upgrades require the seven-day timelock.

These are implementation invariants, not proof that external PnL, token value,
liquidity, or AA wallet behavior is correct.

## Required operational controls

- Isolate Safe owners across people/devices and inspect all enabled Safe modules
  and guards.
- Monitor every timelock, beacon, attester, pause, executor, and admin change.
  Fee and collector changes are currently unreachable by any vault and are
  therefore low-signal; they become high-signal again the moment a fee path
  returns.
- Treat the keeper host as a signing host: mounted key file, no build `ARG`, no
  populated `ENV`, scrubbed logs, and backups of the settled-window store taken
  with the keeper stopped. Alert on `store.settleable`, `history.accounted`,
  `degraded`, `l1RangeCollapsed.count` and heartbeat silence.
- Keep every vault implementation below the 24,000-byte bound asserted by
  `test/unit/UpgradeContinuity.t.sol:69`, and below the tighter 20,000-byte
  ratchet at `:75` that exists to stop the headroom being spent again. THERE IS NO
  CI: the repository has no `.github` directory, so both bounds hold only when
  someone runs `forge test`. Review
  review `forge build --sizes`. Note the second, tighter bound: a 20,000-byte
  **ratchet** (`test/unit/UpgradeContinuity.t.sol:69-88`). `PersonalVault` runtime
  is 18,641 bytes, leaving 5,935 against EIP-170's 24,576. The ratchet exists so
  the ~5 KB freed by removing `invest()` cannot be re-spent silently, which is
  exactly how commit `63d59bb` lost the per-period outflow cap. Raising it must be
  a deliberate act with a reason attached.
- Keep deployer, attester, guardian, vault-admin, trading, and session keys
  separate. `scripts/deploy-mainnet.ps1:45-50` enforces the deployer/trading half
  of this at runtime.
- Use per-vault and per-account limits conservatively; do not treat an unbounded
  account count as unbounded safe exposure.
- Preserve a tested admin withdrawal path and document what users should do
  during the seven-day upgrade window.
- Never promote an implementation onto a cohort whose vaults carry a different
  storage layout; verify layout by hand, because no script in this repository
  does.

## Unresolved production blockers

- The per-period outflow cap is still not implemented. It was abandoned in commit
  `63d59bb` for lack of contract size; that reason no longer holds — there are
  5,935 bytes of EIP-170 headroom and 1,359 against the repository ratchet — so
  the only remaining reason is that nobody has written it.
- **Contiguous ledger coverage is still not enforced onchain.** The attestation
  commits `replayStartBlockL2` inside `ledgerRoot` v2 and the session engine
  refuses a window whose replay did not begin at or before the account's
  activation, but `ledgerRoot` is opaque `bytes32` to Solidity, so nothing in the
  contract requires that consecutive settlements leave no unexamined gap between
  them. L2 progression proves each window starts after the last one ENDED; it
  does not prove the space in between was ever looked at. An attester that simply
  skips a losing stretch produces a chain of individually valid attestations.
- **No explicit finality level, and no reorg handling anywhere.** Neither the
  contracts nor `packages/keeper-old` name a confirmation depth. The keeper attests
  and settles against whatever the RPC returns as head, and its durable store
  records a settlement as final the moment the receipt arrives. On a chain whose
  L2 blocks arrive every ~0.1 s this is the assumption most likely to be wrong in
  practice, and the cost is not academic: a reorg that unwinds a settled window
  leaves the local frontier ahead of the chain, and the account's next genuine
  session is then refused as a replay. Nothing detects that today.
- The single-wallet canary topology on Robinhood mainnet 4663 is **superseded by
  this redeploy and cannot be migrated**: `configureProtocol` is one-shot and its
  executor is pinned, and its vaults carry the pre-change storage layout. No
  source is verified on any explorer and the factory ownership handoff to the
  timelock has never been executed or rehearsed on any deployment. See the
  [deployment runbook](../runbooks/DEPLOYMENT.md).
- The GMGN/EIP-7702 mainnet canary has passed for market and limit trading; see
  [the results](../canary/GMGN_EIP7702_RESULTS.md). It covers a single session on
  a single token and does not cover partial sells, failed-transaction refunds, or
  concurrent settlement. Session-key installation succeeds once the delegation
  has been applied by a type-4 transaction, but none of its negative cases
  (wrong target, wrong selector, over-cap value, revocation) has been exercised
  against a real executor, so the permission is not yet evidence of containment.
- The indexer must use `debug_traceTransaction`: `trace_*` and the
  asset-transfer `internal` category are unavailable on this chain, and sell
  proceeds arrive only as internal native transfers.
- `block.number` is the L1 block number on this Arbitrum Nitro chain, and it sits
  millions of blocks **above** the L2 numbers an indexer reads. The gap is **not
  constant** — measured at 3,551,127 on 2026-07-29 and about 2.65M a day later,
  because L2 advances far faster — so anything that stores an offset and adds it
  will drift into `InvalidBlockRange`. Read `l1BlockNumber` off the L2 block.
  Freshness and the activation floor are attested in L1 because `block.number` is
  the only clock a contract here can compare against; balance reads are L2.

  **The liveness failure this used to record is fixed.** At ~120 L2 blocks per L1
  block, a trader re-entering within ~12 seconds produced two genuinely distinct
  sessions whose L1 ranges were identical, and an L1 strict-increase rule refused
  the second one permanently — which struck round-trippers hardest, the 43% of the
  measured cohort the product works best for. Progression now runs on
  `startBlockL2`/`endBlockL2`, promoted from `ledgerRoot` v2 into real attestation
  fields; the L1 range is only required to be non-decreasing, under the distinct
  error `NonProgressiveL1BlockRange` so an operator can tell a genuine replay from
  an incoherent attestation. Pinned by
  `test/unit/SettlementProgressionL2.t.sol::testTwoDistinctL2SessionsInsideOneL1BlockBothSettle`.

  One consequence to keep in view: zero is the frontier's "nothing settled yet"
  sentinel, so a window ending at L2 block 0 would disable progression for that
  account forever. Both layers refuse a degenerate L2 window for exactly that
  reason — see `testDegenerateL2WindowIsRefusedSoTheFrontierSentinelStaysSound`.
  See [mainnet settlement results](../canary/MAINNET_SETTLEMENT_RESULTS.md).
- The session key's native-token cap is bypassable through `executeBatch`, which
  `NativeTokenLimitModule` does not decode. The installed permission contains it
  by authorising the `execute` selector alone; that single line is the whole
  containment and is now pinned by a regression test.
- The keeper holds the operator's own trading key, which is total custody of that
  wallet. This is the blocker on serving anyone but the operator, and it is not
  fixable by configuration — the limitation is the credential.
- The deployment script consumes a plaintext private key from process
  environment; production signer/keystore handling has not been hardened.
- Safe bytecode, owners, modules, and guards require external verification.
- Alerting, incident response, and user disclosures remain to be implemented.
- The attestation struct does not encode position state. `ledgerRoot` v2 commits
  `positionsRoot`, `zeroBasisRealized`, `verdictBits` and `replayStartBlockL2`,
  which makes a false soundness claim attributable — but `ledgerRoot` is opaque to
  the contract, so nothing is enforced onchain. Promoting the load-bearing fields
  into the struct requires another executor redeploy.
- The market is thinner than the mechanism. Across a 77-wallet GMGN cohort census
  (`packages/session-engine-old/scripts/market-census.mts`; `census.mts` is the deep single-wallet one): 43% round-trippers, 38% mixed,
  20% accumulators; 0.246 settleable sessions per buy, and 39.4% of attestable
  sessions profitable. Most trading this protocol observes produces nothing to
  settle, which is a product fact before it is a security one — but it also means
  live settlement volume will be too low to surface a rare fault quickly.

The exact pre-deployment gate is in the
[deployment runbook](../runbooks/DEPLOYMENT.md).

---

## Deferred: the investment path — NOT IN THIS DEPLOYMENT

**Nothing below describes a risk that exists today.** It is retained because the
analysis was correct, the path is intended to return with a real adapter and a
price oracle, and whoever reintroduces investing should inherit this thinking
rather than rediscover it. Read it as a design constraint on future work, never
as a live finding.

What makes it unreachable, precisely:

- `PersonalVault` has no `invest()`, no `investmentOperator`, no
  `investmentPaused`, no `adapterRegistry`, no `feeController`, and no
  `onlyInvestmentAuthority` modifier.
- `NuvemTypes.VaultPolicy` holds one field. `targetAsset`, `adapterId`,
  `minInvestmentWei`, `maxInvestmentPerCallWei`, `minOutputRateWad` and
  `investmentEnabled` are gone.
- `VaultFactory.ProtocolConfiguration` pins four addresses and none of them is a
  fee or adapter contract, so a vault cannot be initialized against one
  (`PersonalVault.sol:699-709` requires `isProtocolConfiguration` to agree).
- `DeployNuvem.s.sol` does not deploy `AdapterRegistry` at all, and deploys
  `FeeCollector`/`FeeController` **without** pinning them into the protocol
  configuration, so no vault can reach them (`DeployNuvem.s.sol:131-144`). They
  are the treasury plumbing a future settlement-time fee would land in.

### Actors that return with it

| Actor or compromise | What it could do | Principal control | Residual risk |
| --- | --- | --- | --- |
| Investment operator | Trigger investments under the admin-selected policy and current fee. | Cannot change policy or withdraw; exact gross input, deadline, fee/adapter/policy epochs; automatically cleared on admin transfer. The output bound was `max(admin floor, caller min-out)`, so the operator could only tighten it — the caller-supplied minimum was not a control on the caller. | Can choose timing, including immediately after an adverse fee or market move. The floor is a static rate: if the admin leaves it unrevised while the market moves, the bound loosens in real terms, and the operator may still repeat calls up to the vault's balance. |
| Adapter | Receive approved WETH and return the target asset. | Append-only versioned ID, pinned runtime codehash, status epoch, guardian deactivation, vault min-out/deadline, failed-call rollback behavior. | Malicious or incorrectly valued adapter behavior can lose assets; proxy implementation changes are not detected by proxy runtime-codehash pinning. |

### Scenario: immediate 100% fee

`FeeController.setFeeBps(10_000)` was a valid immediate Safe action, outside the
seven-day timelock. A vault investment then transferred the selected gross WETH
to `FeeCollector`, bypassed the adapter, and produced zero target tokens. No
autonomous transfer occurred merely from changing the fee, and admin-only
withdrawals always charged `0` bps.

This is the hazard to design against when a fee returns. Two properties made it
severe and both are structural rather than incidental: the fee was changeable
without delay, and the fee-bearing call was operator-triggered, so the party who
chose the fee and the party who chose the timing could be the same principal.
Product UI and monitoring must show the current fee and fee epoch before any
fee-bearing call, and automation must stop on an unexpected change.

`FeeController` and `FeeCollector` still exist and the Safe still owns them; what
removed the hazard is that no vault reads them. A future change that pins either
into `ProtocolConfiguration` reinstates this scenario in full.

### Scenario: malicious adapter or stale quote

An adapter executes external investment logic. The vault constrained the
registered adapter, pinned runtime codehash, status epoch, target, amount,
deadline, and minimum output, but could not make a malicious adapter safe. There
is no universal on-chain detector for proxy or delegatecall upgradeability:
production adapter IDs must point to direct immutable deployments with immutable
or equally governed dependencies, never a proxy. The repository's adapter mocks
are test fixtures and are not production evidence.

A real adapter requires allowlisted targets and routers, a vault-fixed recipient,
oracle and eligibility policy, slippage limits, allowance hygiene, fork testing,
and an independent review.

### Invariants that must be re-established

- Investment cannot be enabled without an output floor, and no caller can execute
  below it; the vault measures its own target-balance delta.
- Failed adapter execution charges no fee.
- A 100% fee path skips the adapter and sends the complete selected amount to the
  fee collector — stated as an invariant because the alternative is a silent
  partial execution.
- A per-period investment ceiling bounds outflow independently of the per-call
  cap. This is the same missing control as the per-period outflow cap in the
  blocker list above; it now fits.

### Preconditions before investing returns

A production adapter, a price oracle and a token eligibility module must exist
and be independently reviewed. A static admin-set output floor is not a
substitute for live pricing. `AdapterRegistry` returns with the adapter and the
oracle that justify it — an empty timelock-owned registry that nothing reads is a
governance surface with no consumer, which is why it is not deployed today
(`DeployNuvem.s.sol:137-141`).
