# Contract deployment runbook

SIP has **no deployment**. This document is how one is made.

The absence is deliberate. The addresses this repository used to carry belong to
a product that took a percentage of *profit*; every trading account linked to
that factory is still active with a savings rate between 1000 and 3000 bps, read
from chain on 2026-09-08. SIP takes basis points of *volume*, and Phase 0 carries
the volume in the attestation's cash field, so aiming the worker at one of those
accounts would apply twenty percent to a notional — about a hundred times what a
user agreed to, on somebody else's wallet. That is why nothing points there any
more: `packages/worker/src/config.ts` requires `SIP_VAULT_FACTORY`,
`SIP_SETTLEMENT_EXECUTOR` and `SIP_LOGS_FROM_BLOCK` and refuses to start without
them, and `packages/worker/src/chain/constants.ts` pins only facts that belong to
the chain rather than to a deployment.

**A fresh deployment starts with zero trading accounts, and that is the whole
point.** No account on it carries a profit-era savings rate, because no account
on it carries anything at all. Everything below exists to get from that empty
state to a factory SIP can safely aim at.

`packages/contracts/deployments/` holds only public-testnet drill artifacts. It
contains no mainnet manifest, and it must not gain one before the receipts exist.

---

## Two paths, and which one is happening

| | Path A — `script/DeploySip.s.sol:DeploySip` | Path B — `script/DeployNuvem.s.sol:DeployNuvem` |
| --- | --- | --- |
| Governance | One person, one Ledger | Corporate Safe, separate guardian |
| Timelock delay | `0` | 7 days |
| Guardian | The same Ledger, acting directly | A third address, cancel/pause only |
| Factory ownership at the end of the run | **Accepted** | *Pending* — a manual Safe cycle finishes it |
| Written for | SIP's own money, today | Somebody else's money, later |

**Path A is the deployment that is happening.** It is not a throwaway and it is
not a stage that Path B replaces. Every difference in that table except the first
column's contracts is a *setting* on Path A, changeable later through the timelock
with no redeploy: the delay can be raised, the roles can be granted to a Safe and
revoked from the Ledger, and each ownership can be split off to different
governance. Path A is written to survive becoming Path B's posture.

What Path A cannot change afterwards is a short, specific list, and it is stated
in full below under [What is permanent](#what-is-permanent-and-what-only-looks-it).

---

# Path A — the permanent first deployment, one Ledger

## What it builds

One script, `script/DeploySip.s.sol:DeploySip`, whose shared body is
`SipDeploymentBase._deployCore`. Nine top-level creations and one handover
transaction, in this order:

| Contract | Created by | Owner / authority when the run ends |
| --- | --- | --- |
| `TimelockController` | `SipGovernanceBootstrap`'s constructor | Self-administered. `PROPOSER_ROLE`, `EXECUTOR_ROLE` and `CANCELLER_ROLE`: the owner Ledger. `minDelay` **0**. |
| `ProtocolPauseController` | script | Owner: the timelock. Guardian: **the Ledger, directly**. |
| `AttesterRegistry` | script | Owner: the timelock. Guardian: the Ledger. Attester: `SIP_ATTESTER`, epoch 1. |
| `AdapterRegistry` | script | Owner: the timelock. Guardian: the Ledger. **Empty.** |
| `PersonalVault` implementation | script | No owner. The adapter registry is an **immutable** of it. |
| `FeeCollector` | script | Owner **and** treasury: the Ledger, directly. |
| `FeeController` | script | Owner: the Ledger, directly. `0` bps. |
| `VaultFactory` + `SettlementExecutor` + cohort 1 beacon | `SipFactoryBootstrap`'s constructor | Factory owner: the timelock, **accepted**. Beacon owner: the timelock. |
| `SipVolumeExecutor` | script | No owner, immutable. Deployed now, pinned nowhere — see [Phase 0 versus Phase 1](#phase-0-versus-phase-1). |

The Ledger address is one value, `SIP_OWNER`, named once and reused as proposer,
executor, canceller, guardian on all three guardian surfaces, fee owner and
treasury. That is what "one Ledger" means, and it is worth seeing written out
before the run rather than discovered afterwards.

## Why there is a timelock at all when the delay is zero

Not for the delay. For the code.

`VaultFactory.registerCohort` reverts `NotAContract(upgradeAuthority)` when the
address it is handed to own the cohort beacon has no code —
`packages/contracts/src/factory/VaultFactory.sol:169`, the guard, with the revert
on the line below it. A Ledger EOA has no code, so **a Ledger cannot be the
upgrade authority**, and a deployment governed by nothing but a hardware wallet
cannot register a cohort at all. Something with code must hold that role.

There were two ways to satisfy that. A bespoke forwarder — a small contract that
relays the Ledger's calls — would be new, unaudited code sitting permanently
between the owner and every upgrade. `TimelockController` is OpenZeppelin 5.6.1,
already a dependency of this repository and already used by `DeployNuvem.s.sol`,
and it satisfies the requirement with code that has been read by more people than
will ever read this runbook.

It also happens to be the right shape for later, which is the second reason:

- **`updateDelay` is callable only by the timelock itself.** In OpenZeppelin
  5.6.1 the function reverts `TimelockUnauthorizedCaller` for every sender that
  is not `address(this)`, so the only way to change the delay is to schedule and
  execute a call from the timelock to the timelock. That is exactly why 0 today
  does not mean 0 forever, and why raising it needs no redeploy.
- **The roles are ordinary `AccessControl` roles on a self-administering
  timelock.** `TimelockController`'s constructor grants `DEFAULT_ADMIN_ROLE` to
  the timelock itself, so a call the timelock makes to itself can rewrite its own
  role set — grant to a Safe, revoke from the Ledger.

`SipGovernanceBootstrap` passes `address(0)` as the constructor's fourth
argument. That argument is an *extra* admin that exists only to be renounced
later; granting it to the hot deploy key and renouncing it three lines down would
reach the same end state through a window in which that key could rewrite every
role, plus a renounce a future edit could silently drop. Never granting it has no
window and nothing to forget.

## The handover, and why the run finishes rather than freezing

`Ownable2Step` means the incoming owner calls `acceptOwnership` itself. The
incoming owner is the timelock, which acts only through schedule/execute, and
only a proposer may schedule. The Ledger is a proposer but cannot sign inside a
`forge script` run — so without help the script would end with **ownership
pending**, which is the precise state that froze the deployment SIP was forked
from: a factory owned by a bootstrap incapable of acting, and no cohort ever
registrable again.

`SipGovernanceBootstrap` is therefore a second, temporary proposer/executor. Its
`completeHandover` schedules and executes one batch of four calls: the factory's
`acceptOwnership`, then `revokeRole` on its own `PROPOSER_ROLE`, `EXECUTOR_ROLE`
and `CANCELLER_ROLE`. There is no ordering in which it keeps power — either the
whole batch lands or none of it does. `completeHandover` is gated on the address
that created the bootstrap, so nobody can spend those temporary roles on a batch
of their own choosing and leave the real factory pending.

`_requireHandoverComplete` then re-reads the chain and reverts unless the factory
owner is the timelock, `pendingOwner()` is zero, and the bootstrap holds none of
the four roles. Under `forge script` the entire run is simulated before a single
transaction is broadcast, so that revert means **nothing is deployed** — strictly
better than a mainnet factory owned by a contract that cannot act.

This is also why `minDelay = 0` is load-bearing at deployment time and not only
afterwards: schedule and execute land in the same block, so the handover fits
inside the one run.

## What is permanent, and what only looks it

**`VaultFactory.configureProtocol` is one-shot.** It reverts
`ProtocolAlreadyConfigured` on a second call (`VaultFactory.sol:125`) and
`SipFactoryBootstrap` fires it during construction. It pins **four** addresses,
for the life of the factory:

- **`weth`** — what every vault denominates a user's savings in. On chain 4663
  that is `0x0bd7d308f8e1639fab988df18a8011f41eacad73`, which
  `packages/worker/src/chain/constants.ts` also pins as a chain fact. The script
  does not merely check for code: it reads `name()`, `symbol()` and `decimals()`
  and requires `WETH` / `WETH` / `18`, because a wrong-but-real token here would
  not fail loudly, it would quietly accumulate the wrong asset forever.
- **`pauseController`**
- **`attesterRegistry`**
- **`settlementExecutor`** — the Phase 0 one, and what every *newly created* vault
  initializes against forever. It is not a lock on the product: a vault admin can
  re-point their own vault with `setSettlementExecutor`, which is how Phase 1
  works.

`ProtocolConfiguration` has four fields and can never gain a fifth. If you have
been told this call pins six addresses including the adapter registry and the fee
controller, the tree disagrees, and the disagreement is deliberate design:

- The **adapter registry** is not pinned because a value in
  `ProtocolConfiguration` is read at `initialize`, and `initialize` runs once — so
  it could never reach a vault that already existed. It is an **immutable of the
  `PersonalVault` implementation** instead, which means a new one arrives by
  beacon upgrade, to every proxy in the cohort at once. Permanent per
  implementation, not per factory.
- The **fee contracts** are not pinned because nothing should reach them. They are
  deployed so the plumbing exists and is owner-rotatable if a protocol fee is ever
  a decision somebody takes; today `FeeController` is `0` bps and no vault can
  even reach it. SIP already takes its slice from the user's own trading volume;
  a protocol fee on top would be a second cut out of the savings the user is here
  to accumulate.

Two more things are effectively permanent:

- **Cohort 1.** Cohorts are append-only and each has one beacon, created inside
  `registerCohort`. The implementation registered here is what every vault in
  cohort 1 runs until governance upgrades that beacon.
- **The addresses themselves**, once anyone has a vault. Nothing in this system
  migrates user state between factories.

Everything else in the list below can still change.

## What is not permanent — the hardening surface

| Thing | How it changes | Gate |
| --- | --- | --- |
| Timelock `minDelay` | `updateDelay`, scheduled and executed by the timelock on itself | The timelock, i.e. the Ledger's two transactions |
| `PROPOSER_ROLE` / `EXECUTOR_ROLE` / `CANCELLER_ROLE` | `grantRole` / `revokeRole` on the timelock, through the timelock | Same |
| `VaultFactory` ownership | `Ownable2Step` transfer + accept | Timelock |
| `ProtocolPauseController`, `AttesterRegistry`, `AdapterRegistry` ownership | `Ownable2Step` transfer + accept (`GuardianOwnable`) | Timelock |
| The guardian on each of those three | `setGuardian` | Owner (the timelock) |
| `FeeCollector` / `FeeController` ownership, treasury, bps | `Ownable2Step` transfer, `setTreasury`, `setFeeBps`, `setFeeCollector` | The Ledger, directly — no timelock cycle |
| Attester key | `rotateAttester`, which bumps `attesterEpoch` | Timelock |
| A vault's settlement executor | `setSettlementExecutor` | That vault's admin |
| Cohort beacon implementation | `UpgradeableBeacon.upgradeTo` | Beacon owner (the timelock) |

`renounceOwnership` reverts `RenounceDisabled` on `VaultFactory`,
`GuardianOwnable` (so all three registries and the pause controller),
`FeeController` and `FeeCollector`. None of them can be dropped by accident.

**The one exception, and it is worth knowing:** the cohort beacon is
OpenZeppelin's `UpgradeableBeacon`, which is plain `Ownable` — single-step, and
its `renounceOwnership` is *not* disabled. A timelock operation that renounced
the beacon would freeze cohort 1's implementation permanently. Never schedule one.
Note also that `VaultFactory` records `upgradeAuthority` in the cohort struct as
history; the address that actually controls upgrades is the beacon's `owner()`,
and only that one moves.

## Decide these before you run, not after

### 1. Can the Ledger sign for chain 4663 at all?

**Check it before the deployment, not after.** The wallet is **Rabby**, driving a
Ledger.

That is a good fit and the site already accommodates it: Rabby is EVM-native and
handles custom networks and hardware wallets, `src/app/providers.tsx` lists
`detected_ethereum_wallets` FIRST so Rabby appears first in Privy's modal (Privy
deprecated the explicit `rabby_wallet` entry), and `src/lib/chain.ts` defines 4663
with an ABSOLUTE `/api/rpc` URL because `wallet_addEthereumChain` rejects a
relative one — so the wallet can add the network without ever seeing the RPC key.

None of that is proof that YOUR Ledger signs on 4663. Before deploying: add the
chain in Rabby, connect the Ledger, and sign one trivial transaction from the
governing address on that chain.

If the Ledger cannot sign on 4663, this deployment ends with a timelock whose
only proposer cannot propose — no upgrade, no unpause, no attester rotation, no
new cohort — and there is no fix short of deploying again. That is the single
cheapest check on this page and the most expensive one to skip.

### 2. What happens if the Ledger is lost

Say it plainly: **a lost Ledger with no other proposer means governance is gone
for good.** Not degraded — gone. The timelock is the owner of the factory, the
pause controller, both registries and the beacon, and it acts only for a
proposer/executor. With no key holding those roles:

- no beacon upgrade, ever, including to fix a bug in `PersonalVault`;
- no `unpause` — `pause` is `onlyOwnerOrGuardian` but `unpause` is `onlyOwner`, so
  a paused protocol stays paused;
- no attester rotation, so a compromised attester key cannot be replaced;
- no new cohort, and no way to hand any ownership to a replacement.

The guardian is the same key, so it goes at the same moment. Users keep their own
funds — the vault admin's withdrawal path is theirs and needs no governance — but
the protocol is frozen in whatever state it was in.

**DECIDED, 2026-09-08: one proposer, the Ledger. No second key.** The owner was
shown the alternatives and chose this deliberately, so treat it as settled rather
than as an omission to correct.

What that makes true, and what it costs:

- **The Ledger's recovery phrase IS the recovery plan.** Not a backup of it — it.
  A phrase that is lost or unreadable ends governance permanently, with user funds
  still sitting in vaults that nobody can upgrade, unpause or re-attest.
- The trade being accepted is a seed on paper (findable) against a single device
  (losable). The owner picked the second risk.
- If that ever stops being the right call, the fix needs no redeploy: schedule and
  execute a batch granting `PROPOSER_ROLE` and `EXECUTOR_ROLE` to a second address.
  At `minDelay 0` it is minutes. The door stays open; it is simply not being used
  today.

### 3. The attester key is chosen here and only here

There is no post-deploy registration step. `AttesterRegistry` takes its initial
attester in its constructor, from `SIP_ATTESTER`, at epoch 1. **The address you
pass must be the key the worker will sign with** — `SIP_ATTESTER_PRIVATE_KEY` in
`packages/worker/.env`. If it is not, the fix is `rotateAttester` through the
timelock, and every attestation signed against the old epoch stops verifying the
moment the rotation lands.

That key is the trust root: the executor recomputes an attestation's arithmetic
but cannot check its figures against history. See the
[threat model](../security/THREAT_MODEL.md).

### 4. The deployer key is not the governor

`DEPLOYER_PRIVATE_KEY` is a funded, single-purpose hot key that holds nothing
after the run. `_validateConfig` reverts `GovernorMustNotBeTheDeployer` if
`SIP_OWNER` equals it, because a deployment whose governor is the key sitting in
an environment variable looks identical on chain to this one and shares none of
its properties. Reading the key from the plaintext process environment is itself
a production hardening blocker and is not fixed.

## Configuration

Five variables. None has a default; `vm.envAddress` and `vm.envUint` revert on a
missing variable, which is the behaviour we want — a blank `SIP_OWNER` must stop
the run, never fall back to the deployer.

| Variable | Requirement |
| --- | --- |
| `DEPLOYER_PRIVATE_KEY` | Funded hot key. Holds no privilege afterwards. Never reuse an owner, guardian, attester or trading key. |
| `SIP_OWNER` | The Ledger. Nonzero, and not the deployer. Becomes proposer, executor, canceller, guardian ×3, fee owner and treasury. |
| `SIP_ATTESTER` | Nonzero. Epoch 1 attester, fixed at construction. |
| `SIP_WETH` | Must have code and answer `name()` = `WETH`, `symbol()` = `WETH`, `decimals()` = 18, or the run reverts `UnexpectedWethMetadata`. **Pinned permanently.** |
| `SIP_CHAIN_ID` | The chain you *believe* you are on. Compared against `block.chainid` and never defaulted. |

`SIP_CHAIN_ID` deserves a sentence of its own. Unlike Path B, this script carries
no allowlist of chains and no canary flag — it deploys on whatever chain you name,
provided the RPC agrees. That variable and the RPC URL are therefore the only two
things standing between a mainnet script and a testnet chain, in either direction.
Set it explicitly, every time, and read the `ChainIdMismatch` revert as the check
working rather than as an obstacle.

There is no guardian variable, no treasury variable, no fee-bps variable and no
delay variable, because `INITIAL_GOVERNANCE_DELAY = 0`, `INITIAL_FEE_BPS = 0` and
`INITIAL_COHORT_ID = 1` are named constants in `SipDeploymentBase`. The day one of
them changes, it changes in one place and shows up in a diff as a decision.

## Rehearse

The unit tests run the whole topology in-process, including the handover, the
delay being raised, and governance moving to a Safe:

```bash
cd packages/contracts
forge test --match-path "test/unit/DeploySip.t.sol" -vv
```

`test/unit/DeploySip.t.sol` is the cheapest proof that the governance path closes,
and it covers the two moves this runbook promises are possible later
(`testTheDelayCanBeRaisedThroughTheTimelockAndThenBinds`,
`testGovernanceCanMoveToASafeWithoutRedeploying`). Run it before every real
deployment.

Then simulate against the real RPC, with no `--broadcast`:

```bash
forge script script/DeploySip.s.sol:DeploySip --rpc-url "$RPC_URL" -vvvv
```

That runs everything the broadcast will run, handover included, against real
chain state and real WETH — the cheapest possible rehearsal of a permanent event.
Read the reverts, the gas report and the address block it prints. Do not copy
simulated addresses anywhere.

**Cost.** No gas figure has been recorded for this script; the 13.9M-gas figure
below belongs to Path B and to a different set of contracts. Take the number from
your own simulation's gas report and fund the deployer with room for a retry.

## Broadcast

```bash
forge script script/DeploySip.s.sol:DeploySip --rpc-url "$RPC_URL" \
  --broadcast --slow -vvvv
```

Treat receipts, not console text, as the source of truth. Record only confirmed
addresses from `broadcast/DeploySip.s.sol/<chainId>/run-latest.json`, and preserve
alongside them: the git commit and whether the tree was clean; the chain id and
RPC provider class without credentials; every non-secret configuration value;
transaction hashes, block numbers, deployed bytecode hashes and addresses; the
four addresses read back from `protocolConfiguration()`; and the `FeeCollector`
and `FeeController` addresses marked explicitly **deployed but not pinned**, so a
later reader does not infer a fee path from their presence.

Note the **deploy block**. The script prints it as `SIP_LOGS_FROM_BLOCK` and
`NUVEM_LOGS_FROM_BLOCK`; the worker and the website both need it, and recovering
it later means a log scan you could have avoided.

Do not claim explorer verification until a verifier endpoint exists and has
returned success. This repository configures none.

## Confirm on chain before anyone gets a vault

The script already reverted if the handover was incomplete, but the script and
the chain are two different claims:

```bash
cast call "$FACTORY"  "owner()(address)"          --rpc-url "$RPC_URL"
cast call "$FACTORY"  "pendingOwner()(address)"   --rpc-url "$RPC_URL"
cast call "$FACTORY"  "protocolConfigured()(bool)" --rpc-url "$RPC_URL"
cast call "$FACTORY"  "protocolConfiguration()(address,address,address,address)" --rpc-url "$RPC_URL"
cast call "$TIMELOCK" "getMinDelay()(uint256)"    --rpc-url "$RPC_URL"
cast call "$PAUSE_CONTROLLER" "guardian()(address)" --rpc-url "$RPC_URL"
cast call "$ATTESTER_REGISTRY" "attester()(address)" --rpc-url "$RPC_URL"
```

`owner()` must be the timelock and `pendingOwner()` must be zero. The four words
of `protocolConfiguration()` come back in the order weth / pauseController /
attesterRegistry / settlementExecutor — if either fee address appears among them,
stop, because `configureProtocol` cannot be called again to correct it.

Then check that the roles are where they should be, and in particular that the
spent bootstrap holds nothing:

```bash
PROPOSER=$(cast call "$TIMELOCK" "PROPOSER_ROLE()(bytes32)" --rpc-url "$RPC_URL")
cast call "$TIMELOCK" "hasRole(bytes32,address)(bool)" "$PROPOSER" "$LEDGER"    --rpc-url "$RPC_URL"
cast call "$TIMELOCK" "hasRole(bytes32,address)(bool)" "$PROPOSER" "$BOOTSTRAP" --rpc-url "$RPC_URL"
cast call "$TIMELOCK" "hasRole(bytes32,address)(bool)" "$PROPOSER" "$DEPLOYER"  --rpc-url "$RPC_URL"
```

`true`, `false`, `false`. Repeat for `EXECUTOR_ROLE`, `CANCELLER_ROLE` and
`DEFAULT_ADMIN_ROLE` — the last should be `true` only for the timelock itself.

Before creating a real vault, also confirm deployed runtime bytecode against the
build artifacts; that a harmless timelock action schedules and executes from the
Ledger; that the guardian can pause globally and disable the attester and
*cannot* unpause; and, on a disposable vault, that `setSettlementExecutor`
force-pauses settlement, bumps `localPauseEpoch` and `vaultPolicyNonce`, and
thereby invalidates every attestation signed against the previous executor. That
last one is Phase 1's only migration path and it must be known to work before it
is needed.

## Wire SIP to it — the steps that get forgotten

Four things point at the contracts. Three fail loudly. The fourth fails silently.

### 1. `packages/worker/.env`

The worker refuses to start without these; a wrong value is a startup problem,
never a fallback. The script prints them ready to paste:

```
SIP_VAULT_FACTORY=<new factory>
SIP_SETTLEMENT_EXECUTOR=<new Phase 0 SettlementExecutor>
SIP_LOGS_FROM_BLOCK=<deploy block>
SIP_CHAIN_ID=4663
SIP_RPC_URLS=<archive endpoint>
SIP_ATTESTER_PRIVATE_KEY=<the key registered as SIP_ATTESTER>
```

The RPC must be an archive endpoint whose `eth_getLogs` range is not capped.
Alchemy's free tier caps it at 10 blocks on 4663, which makes trading-account
discovery impossible; Pay-As-You-Go lifts the cap. Robinhood's public endpoint is
pruned at roughly ten thousand blocks, so put it second as a read fallback, never
first.

`SIP_LOGS_FROM_BLOCK` is the one people skip. Set to zero or to a block far below
the deployment, the worker scans a range the RPC will refuse or truncate; set
above it, discovery misses the vaults created first. It is the deploy block, and
the deploy block is in the script output and in the receipts.

### 2. `packages/website-oficial/.env.local`

`NUVEM_VAULT_FACTORY` is required and has no default, on purpose — the rest is
read from `protocolConfiguration()` at runtime. The `NUVEM_` prefix is what the
site reads (`src/lib/config.ts` also accepts `SIP_` spellings); the addresses are
SIP's own and share nothing with the forked deployment.

```
NUVEM_VAULT_FACTORY=<new factory>
NUVEM_SETTLEMENT_EXECUTOR=<new Phase 0 executor>
NUVEM_WETH=<pinned WETH>
NUVEM_PAUSE_CONTROLLER=<new pause controller>
NUVEM_ATTESTER_REGISTRY=<new attester registry>
NUVEM_COHORT_ID=1
NUVEM_CHAIN_ID=4663
NUVEM_LOGS_FROM_BLOCK=<deploy block>
```

The cross-check values exist so the UI can say "your environment disagrees with
the chain". Replace them or unset them; left stale they say it constantly.

### 3. The attester — nothing to do, and that is the point

Covered above: the initial attester is a constructor argument, not a
registration. Verify `attester()` and `attesterEpoch()` on chain match the key in
`SIP_ATTESTER_PRIVATE_KEY`, and move on.

### 4. The Privy policy — the one that fails silently

The policy that bounds the app's signer seat **pins the executor's address**. It
currently names the executor of the abandoned deployment, so against this new
deployment **every pull is denied inside Privy's enclave**: the worker records a
failure per wallet, and nothing on chain says why.

The app's key quorum is `zdhe35f97hmzxes5iuzga7d0` (`PRIVY_SIGNER_ID`) and its
policy is `nxakvhwt6dctmvorrfp4xlk9` (`PRIVY_POLICY_ID`). The policy ALLOWs
`settle` — sign and send, to the executor's address only — ALLOWs `invest` with
value 0, and DENIEs `exportPrivateKey` and `exportSeedPhrase`.

**The change to make:** in policy `nxakvhwt6dctmvorrfp4xlk9`, edit the `settle`
rule's destination-address condition to the new `SettlementExecutor` address from
this deployment. Leave the `invest` rule and both denials alone. In Phase 1 the
same field changes again, to `SipVolumeExecutor`. Do it in the Privy dashboard or
through Privy's policies API. **This repository no longer carries a script for
it** — the ones that created and updated the policy lived in a package that has
been deleted, and they have not been replaced.

Sequence matters: update the policy *before* switching `SIP_SETTLEMENT_EXECUTOR`
in the worker, not after, or the window between the two is a stretch of silent
denials.

That policy is the security boundary, and it is worth being plain about what kind
of boundary it is: containment is enforced by Privy's policy engine, not by a
contract. The honest sentence is "we cannot take your money because Privy will
not let us", not "check the chain yourself". It is also a claim about the
*signing path* only — an exported key is a second signer with no policy at all,
which is exactly why collection is best-effort.

## Hardening, with no redeploy

This deployment is meant to survive every one of these. None of them replaces it.

### (1) Raise the delay

`updateDelay` reverts for every caller except the timelock itself, so the owner
schedules a call from the timelock to the timelock and then executes it. The
script prints the exact calldata and salt for a two-day example
(`raiseDelayOperation` is `public pure`, so the same values can be recomputed for
any delay):

- target: the timelock address
- value: `0`
- data: `updateDelay(newDelay)` ABI-encoded
- predecessor: `0x0`
- salt: `keccak256(abi.encode("SIP_RAISE_GOVERNANCE_DELAY_V1", newDelay))`
- delay argument to `schedule`: the *current* `minDelay`

Do this first, before there is other people's money in vaults, because raising
the delay is what creates the window in which a user can see a hostile or coerced
upgrade coming and exit ahead of it. Note the second-order effect: once the delay
is nonzero, every governance action costs the delay, including the emergency ones
— which is precisely why the guardian's pause is *not* routed through the timelock.

### (2) Hand governance to a Safe

`PROPOSER_ROLE`, `EXECUTOR_ROLE` and `CANCELLER_ROLE` are ordinary AccessControl
roles on a self-administering timelock. As one batch, scheduled and executed on
the timelock:

1. `grantRole(PROPOSER_ROLE, safe)`
2. `grantRole(EXECUTOR_ROLE, safe)`
3. `grantRole(CANCELLER_ROLE, safe)`
4. `revokeRole(PROPOSER_ROLE, ledger)`
5. `revokeRole(EXECUTOR_ROLE, ledger)`
6. `revokeRole(CANCELLER_ROLE, ledger)`

**Grant before revoke, in that order.** A batch that revokes first and grants
second leaves governance dead in the same transaction that was meant to improve
it. Verify the Safe answers `getThreshold()` and `getOwners()` first, and consider
keeping the Ledger as canceller for a while — on a Safe-proposed timelock,
whoever queues is otherwise the only one who can un-queue.

### (3) Split the ownerships

The factory, the pause controller, the attester registry and the adapter registry
are four separate `Ownable2Step` surfaces that happen to point at one timelock
today. Any one can be transferred to different governance through a timelock
operation plus the new owner's `acceptOwnership`. `renounceOwnership` is disabled
on all four. The cohort beacon moves the same way but is plain `Ownable` — see the
caveat above.

### (4) Optionally move the fee contracts

`FeeCollector` and `FeeController` are owned by the Ledger directly, not by the
timelock, because a treasury address and a basis-point number are business
settings whose worst case is bounded — the collector can only ever pay out to its
own treasury. If a protocol fee is ever actually switched on, that calculus
changes: transfer both to the timelock (`Ownable2Step`, so the timelock must
`acceptOwnership` through an operation) before setting a nonzero `feeBps`, and
remember that neither contract is pinned in the factory, so a fee path also
requires a change no address on this deployment can currently reach.

---

## Phase 0 versus Phase 1

**Phase 0 needs no new contract.** It uses the `SettlementExecutor` this script
deploys and pins, and carries the volume through the attestation's cash fields:
`cashStart`, `externalDeposits` and `externalWithdrawals` are zero while `cashEnd`
and `realizedProfit` both hold the window's gross notional, so the executor's
`calculateRealizedProfit` returns the volume and the contribution comes out as
`savingsBps x volume`, clamped by the vault's own caps. Nothing about the vault
changes.

Two consequences follow, and both are why Phase 0 is **for the team's own wallets
only**:

- Every consumer of `SettlementExecuted` will read volume in a field named
  `realizedProfit` until Phase 1.
- A savings rate that was set to mean a percentage of profit becomes, unchanged,
  a percentage of notional. That is the whole reason a fresh factory exists, and
  the reason a fresh factory is safe: it has no accounts on it yet, so every rate
  on it was set under SIP's meaning from the start.

**Phase 1 uses `SipVolumeExecutor`, which Path A already deployed** in the same
run — deliberately, so Phase 1 never needs a second deployment event. It is
immutable and ownerless, with no withdrawal, no recipient other than the account's
registered vault, and no arbitrary call. What it changes: the caller decides
`msg.value`, so a pull may be partial and the shortfall stays as debt in the
executor's storage to be paid down later; replay is keyed per batch root in its
own storage, so a partially collected attestation can never be presented twice;
and the vault's L2 frontier is driven by a synthetic per-account counter, so a
late fill discovered after a window closed is still collectible. The attestation
is a `VolumeAttestation` with `sumNotionalWei` and `owedWei` as real fields rather
than volume dressed as profit.

Rolling out Phase 1 means, in order: verify the already-deployed executor, update
the Privy policy to its address, switch `SIP_SETTLEMENT_EXECUTOR` in the worker,
then have each vault admin call `setSettlementExecutor` and `setLocalPause(false)`
— the re-point force-pauses settlement, which is a feature, because it invalidates
every attestation signed against the old executor. `configureProtocol` is not
involved and cannot be: the factory keeps answering with the Phase 0 executor for
newly created vaults, which is why the migration is per-vault and voluntary.

---

# Path B — the full topology, for when it is somebody else's money

`script/DeployNuvem.s.sol:DeployNuvem` builds the same protocol under corporate
governance: a Safe as sole proposer, a separate guardian holding cancel, and a
seven-day delay. Path A can be hardened into this posture without redeploying, so
Path B is the right script only when the deployment is *starting* under a Safe.
Everything below describes Path B and Path B alone.

## What gets deployed, and who owns it

One script, whose shared body is `NuvemDeploymentBase._deployCore`. In
construction order:

| Contract | Owner / authority after the run |
| --- | --- |
| `TimelockController` (via `TimelockBootstrap`) | Self-administered. Sole proposer: the corporate Safe. Executor: `address(0)`, so execution is open after maturity. Guardian holds `CANCELLER_ROLE`. |
| `ProtocolPauseController` | Timelock owns it; guardian can pause. |
| `AttesterRegistry` | Timelock owns it; guardian can disable. Initial attester is `NUVEM_ATTESTER`, epoch 1. |
| `FeeCollector` | Corporate Safe, paying out to `NUVEM_TREASURY`. |
| `FeeController` | Corporate Safe, constructed at `NUVEM_INITIAL_FEE_BPS`. |
| `AdapterRegistry` | Timelock owns it; guardian can deactivate an adapter with no delay. |
| `PersonalVault` implementation | No owner. The adapter registry is an **immutable** of this contract. |
| `VaultFactory` + `SettlementExecutor` + cohort 1 beacon (via `VaultFactoryBootstrap`) | Beacon: timelock. Factory: timelock, but only *pending* — see the handoff below. |

Two of those are sealed one-shot bootstraps rather than script lines, and each has
a reason worth knowing before you run it.

`TimelockBootstrap` exists because OpenZeppelin grants `CANCELLER_ROLE` only to
proposers. On a timelock whose sole proposer is the Safe, the only address that
could cancel a queued operation would be the one that queued it — so a stolen
Safe key could schedule a hostile beacon upgrade and the delay would be a
countdown rather than a defense. The bootstrap grants the guardian the cancel
role and then renounces its own admin, so the guardian can stop an operation and
can do nothing else.

`VaultFactoryBootstrap` exists so the deployer never owns the factory. It
constructs the factory, constructs the `SettlementExecutor` against it, calls
`configureProtocol`, registers cohort 1 with the timelock as upgrade authority,
and transfers ownership to the timelock — all inside one constructor. Afterwards
it exposes no method that can call the factory. Factory governance is frozen
until the handoff below completes.

`AdapterRegistry` is deployed but **empty**. `registerAdapter` is `onlyOwner` on a
timelock-owned registry, so the first adapter costs a full governance cycle after
this script has run. Deploying the registry is not the same as being able to
invest.

## Decisions that cannot be changed afterwards

`VaultFactory.configureProtocol` is one-shot — it reverts with
`ProtocolAlreadyConfigured` on a second call — and the bootstrap fires it during
construction. It pins exactly four addresses, permanently:

- **`weth`** — the canonical WETH the vaults denominate in. On chain 4663 that is
  `0x0bd7d308f8e1639fab988df18a8011f41eacad73`, which the worker also pins as a
  chain fact. Verify name, symbol and decimals yourself before pasting it.
- **`pauseController`**
- **`attesterRegistry`**
- **`settlementExecutor`** — the *initial* one, and the executor the factory will
  answer with forever. This is not a lock on the product: a vault admin can
  re-point their own vault with `setSettlementExecutor`, which is how Phase 1
  works. It is a lock on what a newly created vault is initialized with.

`ProtocolConfiguration` has four fields and can never gain a fifth. The adapter
registry is deliberately **not** among them: pinning it there made it a per-vault
value chosen at creation, which could never reach a vault that already existed
because `initialize` runs once. It is an immutable of the `PersonalVault`
implementation instead, so a beacon upgrade delivers a new one to every proxy in
the cohort at once. `FeeCollector` and `FeeController` are deployed and are
deliberately *not* pinned either, so no vault can reach them and settlement
charges no protocol fee.

Two more decisions are effectively permanent:

- **Cohort 1.** Cohorts are append-only and each has one immutable beacon. The
  vault implementation registered here is what every vault created in cohort 1
  runs until governance upgrades the beacon.
- **The timelock delay.** `GOVERNANCE_DELAY` is seven days. It can be shortened
  only by setting `NUVEM_GOVERNANCE_DELAY` *and* `NUVEM_DISPOSABLE_TEST_DEPLOYMENT`
  together, with a floor of fifteen minutes (`MIN_TEST_GOVERNANCE_DELAY`) so that
  `schedule` and `execute` cannot land in the same block. The two variables are
  separate on purpose: a number can be lowered quietly and look like tuning,
  whereas the flag has to be written down. Never set it on a deployment that will
  hold anyone else's money — the delay is the only window in which the guardian's
  cancel role means anything.

## Configuration

| Variable | Requirement |
| --- | --- |
| `DEPLOYER_PRIVATE_KEY` | Read directly with `vm.envUint`. A funded, single-purpose key. It holds no privilege after the run, but never reuse an admin, Safe-owner, guardian, attester or trading key. That plaintext process-environment dependency is a production hardening blocker and is not fixed. |
| `NUVEM_CORPORATE_MULTISIG` | A deployed contract that answers `getThreshold()` and `getOwners()`. |
| `NUVEM_GUARDIAN` | Nonzero. Holds cancel, pause and disable-attester, and nothing else. Keep it separate from the deployer and from the Safe. |
| `NUVEM_TREASURY` | Nonzero recipient authority on the unpinned `FeeCollector`. |
| `NUVEM_ATTESTER` | Nonzero initial attester, epoch 1. This is the key the whole protocol's correctness rests on — see the [threat model](../security/THREAT_MODEL.md). It must be the key the worker will sign with. |
| `NUVEM_WETH_ADDRESS` | A deployed WETH contract on the selected chain. **Pinned permanently.** |
| `NUVEM_INITIAL_FEE_BPS` | Integer `0`–`10000`. Still required — the script reads it with `vm.envUint`, which reverts when unset — but it configures only a `FeeController` no vault can reach. Set `0`, so that if a fee path is ever wired up the default is "charge nothing". |
| `NUVEM_CANARY_APPROVED` | Consulted only on chain `4663`, where the script reverts `CanaryApprovalRequired` without it. It is an operator assertion, not evidence, and bypassing the guard proves nothing. |
| `NUVEM_GOVERNANCE_DELAY` | Optional. Defaults to seven days. |
| `NUVEM_DISPOSABLE_TEST_DEPLOYMENT` | Optional, default false. Required alongside any delay under seven days. |

`NUVEM_TARGET_ASSET_ADDRESS` is no longer read by anything and must not be
supplied.

The script accepts three chains and reverts `UnsupportedChain` on any other:

| Environment | Chain ID |
| --- | ---: |
| Local Anvil | `31337` |
| Robinhood testnet | `46630` |
| Robinhood mainnet | `4663` (needs `NUVEM_CANARY_APPROVED`) |

`packages/contracts/scripts/deploy-mainnet.ps1` still hardcodes the Safe,
guardian, treasury and attester of the abandoned run. Read it as a record of how
that deployment was invoked, not as a launcher for a new one.

## Local simulation

No keys and no RPC:

```bash
cd packages/contracts
forge script script/DeployLocal.s.sol:DeployLocal -vv
```

It refuses any chain but `31337`, never broadcasts, and stands in mock WETH, a
second ERC-20 with no protocol role (so `withdrawToken` can be exercised against
something that is not WETH), and a permissionless `LocalCallExecutor` in place of
the Safe. It then does the thing that is easiest to skip on a real chain: it
schedules the factory-ownership handoff, warps seven days, executes it, and
creates a sample vault in cohort 1. Run it before every real Path B deployment —
it is the cheapest proof that the governance path still closes. Its addresses are
ephemeral and are not deployment addresses.

## Pre-flight

Every assertion below corresponds to a check `_validateConfig` actually performs,
and each is worth making yourself first, because the script's revert tells you
only that something was wrong.

```bash
cast chain-id --rpc-url "$RPC_URL"
cast call "$NUVEM_CORPORATE_MULTISIG" "getThreshold()(uint256)" --rpc-url "$RPC_URL"
cast call "$NUVEM_CORPORATE_MULTISIG" "getOwners()(address[])"  --rpc-url "$RPC_URL"
cast code "$NUVEM_CORPORATE_MULTISIG" --rpc-url "$RPC_URL"
cast code "$NUVEM_WETH_ADDRESS"       --rpc-url "$RPC_URL"
```

The multisig check is a **probe, not a shape**. It requires only that the address
answers both calls and that `0 < threshold <= owners.length`. It used to demand
exactly 3-of-5; the numbers were never the control. A wrongly pasted address —
the single most dangerous field here — almost never answers both methods, so it
reverts either way, whereas the fixed shape forced a solo operator into five keys
from one seed on one machine, which passes the check and means nothing. An honest
1-of-2 carries the same real risk and names it. Inspect Safe bytecode, owner
identity, modules, guards and nonce in the Safe interface; the script
authenticates none of them.

Review every non-secret input with a second operator, and confirm in particular
that the attester address is the key you intend and is held nowhere else. The
executor recomputes an attestation's arithmetic but cannot check its cash figures
against history, so that key is the trust root.

## Simulate, then broadcast

```bash
forge script script/DeployNuvem.s.sol:DeployNuvem --rpc-url "$RPC_URL" -vvvv
```

That is an RPC simulation. Read the reverts, the gas, the configuration echo, and
the factory-ownership operation the script prints. Do not copy simulated
addresses anywhere.

```bash
forge script script/DeployNuvem.s.sol:DeployNuvem --rpc-url "$RPC_URL" \
  --broadcast --slow -vvvv
```

**Cost.** The last recorded full Path B deployment was **13,895,644 gas across 8
transactions** — one per top-level creation: the timelock bootstrap, the pause
controller, the attester registry, the fee collector, the fee controller, the
adapter registry, the vault implementation, and the factory bootstrap. The last
two are the expensive ones, and the factory bootstrap deploys three contracts
inside its constructor. At the gas price recorded in `foundry.toml` for a real
mainnet settlement — 450,545 gas for 0.0000188 ETH — that is roughly 0.0006 ETH,
on the order of a dollar. Fund the deployer with room for a retry regardless.
That figure describes this script and not Path A, which deploys a different set.

Treat receipts, not console text, as the source of truth. Record only confirmed
addresses from `broadcast/DeployNuvem.s.sol/<chainId>/run-latest.json`, and
preserve alongside them: the git commit and whether the tree was clean; the chain
id and RPC provider class without credentials; every non-secret configuration
value; transaction hashes, block numbers, deployed bytecode hashes and addresses;
the four addresses read back from `protocolConfiguration()`; the `FeeCollector`
and `FeeController` addresses marked explicitly **deployed but not pinned**, so a
later reader does not infer a fee path from their presence; Safe
owner/threshold/module/guard evidence; and the exact target, value, calldata,
predecessor, salt and delay the script printed.

Note the **deploy block**. The worker and the website both need it, and
recovering it later means a log scan you could have avoided.

Do not claim explorer verification until a verifier endpoint exists and has
returned success. This repository configures none.

## Finish the factory handoff — this is the step that gets forgotten

Immediately after broadcast the factory's owner is the sealed
`VaultFactoryBootstrap` and the timelock is only the *pending* owner. The
bootstrap has no method that can govern the factory. **Until the handoff
executes, factory governance is frozen: no new cohort, no future owner, no way
out.** The freeze is intentional, but leaving it in place is not. (Path A has no
equivalent step precisely because this one was left undone once already, and
`minDelay 0` lets the script complete it inside the run.)

```bash
cast call "$FACTORY"  "owner()(address)"        --rpc-url "$RPC_URL"
cast call "$FACTORY"  "pendingOwner()(address)" --rpc-url "$RPC_URL"
cast call "$TIMELOCK" "getMinDelay()(uint256)"  --rpc-url "$RPC_URL"
```

Through the Safe, schedule the exact target, value, calldata, predecessor, salt
and delay the deployment script printed. Do not reconstruct those fields by hand;
the salt is derived from a version constant and the factory address, and a
mismatch produces an operation that matures into nothing. Confirm the scheduling
transaction, wait the full delay, then execute — execution is permissionless, but
the schedule must have come from the Safe.

Afterwards, `owner()` must be the timelock and `pendingOwner()` must be zero.
Until both hold, the deployment is incomplete.

Then verify the one-shot configuration:

```bash
cast call "$FACTORY" "protocolConfiguration()(address,address,address,address)" --rpc-url "$RPC_URL"
cast call "$FACTORY" "protocolConfigured()(bool)" --rpc-url "$RPC_URL"
```

Four words, in the order weth / pauseController / attesterRegistry /
settlementExecutor. If either fee address appears among them, stop: a vault could
reach a fee path this deployment is not designed for, and `configureProtocol`
cannot be called again to correct it.

Before creating a real vault, also confirm deployed runtime bytecode against the
build artifacts; every owner, guardian, treasury, attester, delay, proposer and
executor role; that a harmless timelock action proposes and executes after the
real delay; that the guardian can pause globally and disable the attester and
*cannot* unpause; and, on a disposable vault, that `setSettlementExecutor`
force-pauses settlement, bumps `localPauseEpoch` and `vaultPolicyNonce`, and
thereby invalidates every attestation signed against the previous executor.

## Wiring SIP to a Path B deployment

Identical to Path A's four steps — worker `.env`, website `.env.local`, the
attester, and the Privy policy — with one difference: the addresses come from
`broadcast/DeployNuvem.s.sol/<chainId>/run-latest.json` and the deploy block from
those receipts rather than from a printed `SIP_LOGS_FROM_BLOCK` line.

---

## Incident posture

A broadcast cannot be rolled back. If something is wrong:

- stop creating vaults, and stop the worker — clear `SIP_WORKER_ALLOW_BROADCAST`
  rather than relying on anything else; without that exact sentence the process
  never reads a secret and cannot sign;
- have the guardian pause globally, and disable the attester if the attestation
  data or the attester key is what is in doubt. The guardian can do only those
  two things and can reverse neither; reversal is a timelock action. On Path A
  the guardian is the owner's own Ledger, acting directly and in one transaction,
  which is deliberate: every guardian power is restrictive, every reversal is
  owner-gated, and routing a pause through schedule/execute would add a second
  approval and a mempool announcement to the one action whose value is entirely
  in how fast it lands;
- a vault admin can `setLocalPause(true)` on their own vault, which is faster than
  reaching the guardian and affects nobody else;
- notify vault admins of the admin-only withdrawal path. It deducts no protocol
  fee and consults no fee contract;
- if the seat itself is the problem, the containment is at Privy: narrowing or
  removing the policy stops every pull at once, without touching the chain;
- do not unpause until the root cause and the on-chain state are understood — and
  remember that `unpause` is `onlyOwner`, so on both paths it is a timelock
  operation, not a guardian one; and
- use the timelock for registry, factory or cohort recovery, and keep the full
  operation and receipt trail.

Fee and collector changes reach nothing in either topology, since neither address
is pinned; on Path A they are immediate Ledger actions, on Path B immediate Safe
actions. What deserves high-signal monitoring is any change to the attester, the
pause controller, a cohort beacon, or a vault's settlement executor — and, on
Path A, any `RoleGranted` or `RoleRevoked` on the timelock, because a single
compromised Ledger is the whole governance surface.
