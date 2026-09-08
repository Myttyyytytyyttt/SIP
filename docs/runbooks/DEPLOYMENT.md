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

## What gets deployed, and who owns it

One script builds the whole topology: `script/DeployNuvem.s.sol:DeployNuvem`,
whose shared body is `NuvemDeploymentBase._deployCore`. In construction order:

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
| `NUVEM_ATTESTER` | Nonzero initial attester, epoch 1. This is the key the whole protocol's correctness rests on — see the [threat model](../security/THREAT_MODEL.md). It must be the key the worker will sign with; see "Wire SIP to it" below. |
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
creates a sample vault in cohort 1. Run it before every real deployment — it is
the cheapest proof that the governance path still closes. Its addresses are
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

**Cost.** The last recorded full deployment was **13,895,644 gas across 8
transactions** — one per top-level creation: the timelock bootstrap, the pause
controller, the attester registry, the fee collector, the fee controller, the
adapter registry, the vault implementation, and the factory bootstrap. The last
two are the expensive ones, and the factory bootstrap deploys three contracts
inside its constructor. At the gas price recorded in `foundry.toml` for a real
mainnet settlement — 450,545 gas for 0.0000188 ETH — that is roughly 0.0006 ETH,
on the order of a dollar. Fund the deployer with room for a retry regardless.

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
out.** The freeze is intentional, but leaving it in place is not.

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
thereby invalidates every attestation signed against the previous executor. That
last one is Phase 1's only migration path and it must be known to work before it
is needed.

## Wire SIP to it

The contracts are only half of a deployment. Four things point at them, and three
of the four fail loudly while the fourth fails silently.

**1. The attester.** There is no separate registration step: `AttesterRegistry`
takes its initial attester in its constructor, from `NUVEM_ATTESTER`, at epoch 1.
So the key the worker will sign with must be the key you deployed with. If it is
not, rotating it is `rotateAttester` on a timelock-owned registry — a full
governance cycle — and every attestation signed against the old epoch stops
verifying the moment it lands.

**2. `packages/worker/.env`.** The worker refuses to start without these; a wrong
value is a startup problem, never a fallback:

```
SIP_VAULT_FACTORY=<new factory>
SIP_SETTLEMENT_EXECUTOR=<new executor>
SIP_LOGS_FROM_BLOCK=<deploy block>
SIP_CHAIN_ID=4663
SIP_RPC_URLS=<archive endpoint>
```

The RPC must be an archive endpoint whose `eth_getLogs` range is not capped.
Alchemy's free tier caps it at 10 blocks on 4663, which makes trading-account
discovery impossible; Pay-As-You-Go lifts the cap.

**3. `packages/website-oficial/.env.local`.** `NUVEM_VAULT_FACTORY` is required
and has no default, on purpose — everything else the site needs is read from
`protocolConfiguration()` at runtime. Set `NUVEM_LOGS_FROM_BLOCK` to the deploy
block so wallet discovery stays inside the RPC's log window, and replace the
optional cross-check values (`NUVEM_SETTLEMENT_EXECUTOR`, `NUVEM_WETH`,
`NUVEM_PAUSE_CONTROLLER`, `NUVEM_ATTESTER_REGISTRY`) or unset them. They exist
only so the UI can say "your environment disagrees with the chain"; left stale
they say it constantly.

**4. The Privy policy — the one that fails silently.** The policy that bounds the
app's signer seat **pins the executor's address**. It currently names the
abandoned one, so against a new deployment every pull is denied by Privy's
enclave, the worker records a failure per wallet, and nothing on chain says why.

The app's key quorum is `zdhe35f97hmzxes5iuzga7d0` and its policy is
`nxakvhwt6dctmvorrfp4xlk9`. The policy allows `settle` to be signed and sent to
the executor address and nothing else, allows `invest` with value 0, and denies
`exportPrivateKey` and `exportSeedPhrase`. Update the executor address in the
`settle` rule — and, in Phase 1, update it again to `SipVolumeExecutor` — through
Privy's dashboard or its policies API. **This repository no longer carries a
script for it**; the ones that created and updated the policy lived in a package
that has been deleted, and they have not been replaced.

That policy is the security boundary, and it is worth being plain about what kind
of boundary it is: containment is enforced by Privy's policy engine, not by a
contract. The honest sentence is "we cannot take your money because Privy will
not let us", not "check the chain yourself". It is also a claim about the
*signing path* only — an exported key is a second signer with no policy at all,
which is exactly why collection is best-effort.

## Phase 0 versus Phase 1

**Phase 0 needs no new contract.** It uses the `SettlementExecutor` this script
deploys, and carries the volume through the attestation's cash fields:
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

**Phase 1 deploys `SipVolumeExecutor`** and each vault admin re-points their own
vault with `setSettlementExecutor`. It is immutable and ownerless, with no
withdrawal, no recipient other than the account's registered vault, and no
arbitrary call. What it changes: the caller decides `msg.value`, so a pull may be
partial and the shortfall stays as debt in the executor's storage to be paid down
later; replay is keyed per batch root in its own storage, so a partially
collected attestation can never be presented twice; and the vault's L2 frontier
is driven by a synthetic per-account counter, so a late fill discovered after a
window closed is still collectible. The attestation is a `VolumeAttestation` with
`sumNotionalWei` and `owedWei` as real fields rather than volume dressed as
profit.

Rolling out Phase 1 means, in order: deploy it, verify it, update the Privy policy
to the new address, then have each vault admin call `setSettlementExecutor` and
`setLocalPause(false)` — the re-point force-pauses settlement, which is a feature,
because it invalidates every attestation signed against the old executor.
`configureProtocol` is not involved and cannot be: the factory keeps answering
with the Phase 0 executor for newly created vaults, which is why the migration is
per-vault and voluntary.

## Incident posture

A broadcast cannot be rolled back. If something is wrong:

- stop creating vaults, and stop the worker — clear `SIP_WORKER_ALLOW_BROADCAST`
  rather than relying on anything else; without that exact sentence the process
  never reads a secret and cannot sign;
- have the guardian pause globally, and disable the attester if the attestation
  data or the attester key is what is in doubt. The guardian can do only those
  two things and can reverse neither; reversal is a timelock action;
- a vault admin can `setLocalPause(true)` on their own vault, which is faster than
  reaching the guardian and affects nobody else;
- notify vault admins of the admin-only withdrawal path. It deducts no protocol
  fee and consults no fee contract;
- if the seat itself is the problem, the containment is at Privy: narrowing or
  removing the policy stops every pull at once, without touching the chain;
- do not unpause until the root cause and the on-chain state are understood; and
- use the timelock for registry, factory or cohort recovery, and keep the full
  operation and receipt trail.

Fee and collector changes are immediate Safe actions but reach nothing in this
topology, since neither address is pinned. What deserves high-signal monitoring is
any change to the attester, the pause controller, a cohort beacon, or a vault's
settlement executor.
