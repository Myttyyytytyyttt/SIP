# Contract deployment runbook

## Current status

A **single-wallet canary topology is live on Robinhood mainnet `4663`**, with its
addresses recorded in
[the mainnet settlement results](../canary/MAINNET_SETTLEMENT_RESULTS.md). It was
deployed to close the GMGN gate, not under this runbook's gate, and only one of
that gate's ten items was met at the time. Read it as evidence, not as a
sanctioned deployment.

### That deployment is SUPERSEDED, and it cannot be migrated

The contracts it runs no longer exist in this repository. Concretely:

- **The executor cannot be replaced at the factory.** `configureProtocol` is
  one-shot (`VaultFactory.sol:113-128`) and permanently pins the
  SettlementExecutor address. The current executor has a different `settle`
  selector (`0xf38ac34f` → `0xc8f2629d`) and a different EIP-712 typehash
  (`0x88e2beba…` → `0x9bd2dea2…`) because `startBlockL2`/`endBlockL2` were
  promoted into the attestation. Nothing on that factory can be repointed at it.
- **The vaults cannot be upgraded onto the current implementation either.**
  Removing the investment path deleted four `VaultStorage` fields and shifted
  `settlementExecutor` from offset 9 to offset 7. A beacon upgrade across that
  boundary makes the vault read its old `adapterRegistry` slot as its settlement
  executor — demonstrated in
  `test/unit/UpgradeContinuity.t.sol::testNewImplementationMisreadsALegacyStorageLayout`.
  `PrepareCohortUpgrade.s.sol` checks cohort separation, beacon ownership and the
  implementation address; it does **not** check storage layout, so it would build
  an executable timelock payload doing exactly this. The canary vault must stay on
  its own cohort forever.
- **`PersonalVault.setSettlementExecutor` is not a way out.** It exists, and it is
  the only migration path a vault has, but it does not help here. The canary vault
  still runs the old implementation, whose `acceptSettlement` takes a
  `SettlementRecord` without `startBlockL2`/`endBlockL2`; a current executor builds
  the new record and the call would not decode. Closing that gap means upgrading
  the vault, which is the storage-layout hazard above. And a second vault on that
  factory could not follow in any case.

**It still holds real money.** The canary vault
`0xF7309dC8e1914A5c3848250cec54Ebe7A20D8255` holds `403370889498747` wei of
canonical WETH from the one settlement it performed. That is withdrawable by its
vault admin (`0xaed788b3c69ca941a4302899f80ccad219942ca7`) through
`withdrawToken`, which deducts no protocol fee. Recovering it is an ordinary admin
withdrawal, not a migration, and it is the only remaining action that deployment
supports.

**Create no vaults on it.** `createVault` is permissionless and not pausable, so
this is a matter of discipline rather than an enforced restriction. A vault
created there today would be bound to a dead executor with no upgrade path and no
migration path.

Still outstanding on that deployment, and now permanently so:

- the factory ownership handoff was never scheduled, executed, or rehearsed;
- no contract source is verified on any explorer;
- no address manifest exists in `packages/contracts/deployments`.

`DeployLocal.s.sol` remains a simulation with mock assets. Do not present a local
simulation or a successful broadcast as end-to-end production validation.

### What this deployment does not contain

There is no investment path. `PersonalVault` has no `invest()`,
`NuvemTypes.VaultPolicy` is the single field `maxAggregateRolling30dWei`, and
`VaultFactory.ProtocolConfiguration` pins four addresses — weth, pauseController,
attesterRegistry, settlementExecutor. `AdapterRegistry` is not deployed at all.
`FeeCollector` and `FeeController` are still deployed but are deliberately **not**
pinned into the protocol configuration, so no vault can reach them; settlement
charges no protocol fee. The rationale is recorded at
`script/DeployNuvem.s.sol:131-141`.

Nothing in this runbook should instruct an operator to configure, verify, or
monitor an adapter, a target asset, or a fee-bearing call. If you find such an
instruction below, it is a bug in this document.

## Supported chains and governance

The script rejects every chain except:

| Environment | Chain ID | Current permission |
| --- | ---: | --- |
| Local Anvil | `31337` | Simulation only |
| Robinhood testnet | `46630` | Simulation/broadcast after preflight |
| Robinhood mainnet | `4663` | Superseded canary topology live; the full gate below remains unmet |

The deployment requires a Safe-compatible corporate wallet with exactly five
owners and threshold three. The script checks only `getOwners()` and
`getThreshold()`: it does not authenticate Safe bytecode, owners, signer
security, modules, or guards.

The Safe directly owns `FeeController` and `FeeCollector`, which no vault can
reach. It is the sole proposer for a seven-day timelock that governs the factory,
the attester registry, the pause controller, and the initial cohort beacon.
Timelock execution is permissionless after maturity.

## Prerequisites

From the repository root:

```powershell
nvm use 22.14.0
corepack enable
corepack prepare pnpm@10.18.1 --activate
pnpm install --frozen-lockfile
pnpm build
pnpm test
Copy-Item .env.example .env
```

Fill only the required values in the gitignored `.env`. Do not commit or print
private keys. `DeployNuvem.s.sol` currently reads
`DEPLOYER_PRIVATE_KEY` directly from the environment; that plaintext
process-environment dependency is a production hardening blocker.

The deployment variables are:

| Variable | Requirement |
| --- | --- |
| `RH_TESTNET_RPC_URL` | Robinhood testnet RPC used by the commands below. |
| `DEPLOYER_PRIVATE_KEY` | Funded deployer key; never reuse an admin, Safe owner, attester, trading, or session key. |
| `NUVEM_INITIAL_FEE_BPS` | Integer from `0` through `10000`. **Still required** — `DeployNuvem.s.sol:279` reads it with `vm.envUint`, which reverts when it is unset — but it now configures only the constructor of a `FeeController` that no vault can reach, so it sets no user-visible percentage. `scripts/deploy-mainnet.ps1` sets it to `0` and says so in its banner; zero rather than a placeholder, so that if the fee path is ever wired up the default is "charge nothing". |
| `NUVEM_CORPORATE_MULTISIG` | Deployed Safe-compatible contract, exactly 3-of-5. |
| `NUVEM_GUARDIAN` | Nonzero emergency address, separate from deployer. |
| `NUVEM_TREASURY` | Nonzero recipient authority on the unpinned `FeeCollector`. |
| `NUVEM_ATTESTER` | Nonzero initial attester. This is the key the whole protocol's correctness rests on; see the [threat model](../security/THREAT_MODEL.md). |
| `NUVEM_WETH_ADDRESS` | Deployed WETH contract on the selected chain. Pinned permanently by `configureProtocol`. |
| `NUVEM_CANARY_APPROVED` | Keep `false` for any deployment intended as production. It is consulted only on chain `4663` and is an operator assertion, not evidence. `scripts/deploy-mainnet.ps1` sets it `true` because that script exists solely to reproduce the canary. |

`NUVEM_TARGET_ASSET_ADDRESS` is **no longer read by anything**. It belonged to the
vault's investment path: there is no `targetAsset` to validate and no adapter to
route to. `scripts/deploy-mainnet.ps1:61-72` records why it was removed from the
script rather than left set — the banner printed it, so the operator read back a
confirmation of configuration the deployment was not performing. Do not supply it.
It is still present in `.env.example` and `script/README.md`; those are stale.

Load the root `.env` into the current PowerShell process before changing into
the Foundry package:

```powershell
Get-Content .env | ForEach-Object {
  $entry = $_.Trim()
  if ($entry -and -not $entry.StartsWith("#")) {
    $name, $value = $entry -split "=", 2
    [Environment]::SetEnvironmentVariable($name, $value, "Process")
  }
}
```

This loader expects the simple unquoted `NAME=value` format used by
`.env.example`. Close the shell after deployment to discard the process values.

## Local simulation

No keys or RPC are required:

```powershell
Set-Location packages/contracts
forge script script/DeployLocal.s.sol:DeployLocal -vv
Set-Location ../..
```

The script refuses non-`31337`, does not broadcast, and deploys mock WETH, a
second mock ERC-20 with no protocol role (so `withdrawToken` can be exercised
against something that is not WETH), and unsafe local call executors. It advances
local time by seven days, completes governance setup, and creates a sample vault.
No adapter is deployed, because there is nothing to register one with. Ephemeral
addresses from this run are not deployment addresses.

## Robinhood testnet preflight

All assertions below must be checked against independently sourced intended
values:

```powershell
cast chain-id --rpc-url $env:RH_TESTNET_RPC_URL
cast call $env:NUVEM_CORPORATE_MULTISIG "getThreshold()(uint256)" --rpc-url $env:RH_TESTNET_RPC_URL
cast call $env:NUVEM_CORPORATE_MULTISIG "getOwners()(address[])" --rpc-url $env:RH_TESTNET_RPC_URL
cast code $env:NUVEM_CORPORATE_MULTISIG --rpc-url $env:RH_TESTNET_RPC_URL
cast code $env:NUVEM_WETH_ADDRESS --rpc-url $env:RH_TESTNET_RPC_URL
```

Each of these corresponds to a check the script actually performs:
`_validateConfig` refuses an unsupported chain, requires the multisig and WETH to
be contracts, and requires `getThreshold() == 3` with five owners
(`DeployNuvem.s.sol:186-243`). Stop unless the chain ID is exactly `46630`, the
Safe threshold is `3`, it has exactly five intended owners, and both code results
are non-empty. Separately inspect Safe bytecode/source, owners, modules, guards,
and nonce in the Safe interface.

Review every non-secret input with a second operator. Confirm in particular that
the attester address is the key you intend and that it is held nowhere else — the
executor recomputes the arithmetic of an attestation but cannot check its four
cash figures against history, so that key is the protocol's trust root.

## Simulate before broadcast

From `packages/contracts`:

```powershell
forge script script/DeployNuvem.s.sol:DeployNuvem `
  --rpc-url $env:RH_TESTNET_RPC_URL `
  -vvvv
```

This is an RPC simulation only. Review reverts, gas, configuration, calculated
addresses, and the printed factory-ownership operation. Do not copy simulated
addresses into a manifest.

## Testnet broadcast

Broadcast only after the simulation and human review succeed:

```powershell
forge script script/DeployNuvem.s.sol:DeployNuvem `
  --rpc-url $env:RH_TESTNET_RPC_URL `
  --broadcast `
  --slow `
  -vvvv
```

Treat the resulting transaction receipts, not console text alone, as the source
of truth. Record only confirmed addresses from
`broadcast/DeployNuvem.s.sol/46630/run-latest.json`. Preserve:

- git commit and clean/dirty status;
- chain ID and RPC provider class, without credentials;
- every non-secret configuration value;
- transaction hashes, block numbers, deployed bytecode hashes, and addresses;
- the four addresses pinned by `configureProtocol`, read back from the factory;
- the `FeeCollector` and `FeeController` addresses, recorded explicitly as
  **deployed but not pinned**, so a later reader does not infer a fee path from
  their presence in the receipts;
- Safe owner/threshold/module/guard evidence; and
- the exact ownership target, value, calldata, predecessor, salt, and delay
  printed by the script.

Do not add an explorer verification claim until an actual verifier endpoint and
successful verification output exist. This repository does not currently
configure one.

## Complete factory governance

Immediately after broadcast, the factory owner is the sealed
`VaultFactoryBootstrap`, and the timelock is only the pending owner. The
bootstrap has no callable method that can govern the factory. This deliberate
freeze ends only after the following operation.

Using addresses confirmed from the receipts:

```powershell
$factory = "<confirmed factory address>"
$timelock = "<confirmed timelock address>"
cast call $factory "owner()(address)" --rpc-url $env:RH_TESTNET_RPC_URL
cast call $factory "pendingOwner()(address)" --rpc-url $env:RH_TESTNET_RPC_URL
cast call $timelock "getMinDelay()(uint256)" --rpc-url $env:RH_TESTNET_RPC_URL
```

Through the 3-of-5 Safe, schedule the exact target, value, calldata,
predecessor, salt, and seven-day delay printed by the deployment script. Do not
reconstruct or alter those fields manually. Confirm the scheduling transaction
on-chain, wait the full delay, then execute the matured operation. Execution is
open, but the schedule must have come from the Safe.

After execution:

```powershell
cast call $factory "owner()(address)" --rpc-url $env:RH_TESTNET_RPC_URL
cast call $factory "pendingOwner()(address)" --rpc-url $env:RH_TESTNET_RPC_URL
```

The confirmed owner must be the timelock and the pending owner must be zero.
Until this is true, factory deployment is incomplete.

## Post-deployment validation

Before creating a real user vault:

1. Verify deployed runtime bytecode against the exact build artifacts.
2. Verify the one-shot factory configuration and initial cohort/beacon on-chain.
   Read all four pinned addresses back and confirm they are weth, pauseController,
   attesterRegistry and settlementExecutor:

   ```powershell
   cast call $factory "protocolConfiguration()(address,address,address,address)" --rpc-url $env:RH_TESTNET_RPC_URL
   cast call $factory "protocolConfigured()(bool)" --rpc-url $env:RH_TESTNET_RPC_URL
   ```

   Confirm that neither the `FeeController` nor the `FeeCollector` address from
   the receipts appears among them. If either does, stop: a vault could then reach
   a fee path this deployment is not designed for, and `configureProtocol` cannot
   be called again to correct it.
3. Verify every owner, guardian, treasury, attester, delay, proposer, and
   executor role.
4. Propose and execute a harmless testnet timelock action after the real delay.
5. Exercise guardian pause/disable and governance recovery. The guardian can pause
   globally and disable the attester, and can do nothing else — confirm both, and
   confirm it cannot unpause.
6. Create a disposable test vault and test multiple accounts with different
   savings bps, admin override, self-revoke, caps, pauses, stale epochs, and
   replay.
7. Exercise the settlement progression rules explicitly, because they are what
   replay protection rests on: two distinct L2 sessions inside one L1 block must
   both settle; an overlapping, contained, identical or inverted L2 window must be
   refused; an L1 range that rewinds must fail with `NonProgressiveL1BlockRange`
   rather than `NonProgressiveBlockRange`; and a degenerate L2 window
   (`startBlockL2 == 0`, or `endBlockL2 <= startBlockL2`) must be refused by the
   executor *and* independently by the vault. `test/unit/SettlementProgressionL2.t.sol`
   is the reference for all of these.
8. Validate that admin withdrawals deduct no Nuvem protocol fee, that
   `FeeCollector` receives nothing from any settlement, and that the two-step
   admin transfer works. ERC-20 behavior remains subject to the token's own
   transfer mechanics.
9. Exercise `setSettlementExecutor` on the disposable vault and confirm it
   force-pauses settlement, bumps `localPauseEpoch` and `vaultPolicyNonce`, and
   thereby invalidates every attestation signed against the previous executor.
   This is the only migration path a vault has and it must be known to work
   *before* it is needed.
10. Run the separate
    [Alchemy MAv2/EIP-7702 smoke](../AA_SMOKE_RUNBOOK.md) with disposable
    testnet keys and retain receipts. The session key's native cap rests entirely
    on the selector allowlist containing `execute` alone; assert that and assert
    that `executeBatch` is rejected at validation.

Create a deployment manifest only after these facts are confirmed. Never insert
placeholder or simulated addresses.

## Mainnet hard stop

A **production** Robinhood mainnet deployment is not authorized by this
repository's current evidence. `NUVEM_CANARY_APPROVED=true` merely bypasses the
script guard; it does not prove the canary.

The live canary topology on `4663` was deployed with that flag set, deliberately
and with one of the ten items below met. That does not retroactively authorise
anything: it is a disposable single-wallet experiment, it must not be built on,
and the gate below still governs any deployment meant to hold other people's
funds.

At minimum, an independent sign-off package must contain these ten items:

1. the complete testnet validation and governance evidence above;
2. an independently reviewed session engine and attester operation, with the
   position-delta-zero soundness claim in `ledgerRoot` v2 reproducible from a
   published report — the executor recomputes the arithmetic but cannot check the
   four cash figures against history, so this is the item that stands in for
   verification and nothing else does;
3. a smallest-size disposable-wallet GMGN mainnet buy and sell;
4. actual transaction receipts, router/calldata attribution, token movements,
   approvals/Permit2 behavior, and realized-PnL reconciliation;
5. confirmed EIP-7702/MAv2 installation and exact settlement execution with
   session-key limits and sponsorship behavior, including the negative cases
   (wrong target, wrong selector, over-cap value, revocation) against a real
   executor;
6. failure-path evidence showing funds remain recoverable and WETH is retained
   when settlement is deferred or reverts;
7. Safe bytecode/owners/modules/guards review and signer ceremony;
8. public source verification, monitoring, alerting, incident response, and a
   user exit procedure;
9. a keeper custody model that is not "hold the trader's own private key" — that
   is total custody of the wallet, and it is why v1 can serve only the operator
   themselves. See `ATTESTER.md` section 1; the EIP-7702 session-key path
   described there is the precondition for a second user; and
10. independent contract/security review with all critical findings resolved.

Unknown router, PnL, trace, liquidity, signing, or recovery evidence is a failed
gate. Do not deploy mainnet while any item is unknown.

None of this gate concerns an investment adapter, an oracle, slippage, or token
eligibility, because there is no investment path to gate. Those return to this
list on the cohort that reintroduces investing; the analysis waiting for them is
in the deferred section of the [threat model](../security/THREAT_MODEL.md).

## Incident posture

A broadcast cannot be rolled back. If a testnet issue is discovered:

- stop creating vaults, and stop the keeper — remove `--broadcast` and the
  `NUVEM_KEEPER_ALLOW_BROADCAST` sentinel rather than relying on either alone;
- have the guardian pause globally, and disable the attester if the attestation
  data or the attester key is what is in doubt. The guardian can do only these
  two things and cannot reverse either; reversal is a timelock action;
- a vault admin can also `setLocalPause(true)` on their own vault, which is
  faster than reaching the guardian and does not affect anyone else;
- notify vault admins to use their admin-only withdrawal path if safe. It deducts
  no protocol fee and consults no fee contract;
- do not unpause until the root cause and on-chain state are understood; and
- use the timelock for registry, factory, or cohort recovery and preserve the
  full operation/receipt trail.

Fee and collector changes remain immediate Safe actions, but in this deployment
they reach nothing: `FeeController` and `FeeCollector` are not pinned into the
factory's `ProtocolConfiguration`, so no vault can read them and settlement
charges no fee. They are low-signal today and become high-signal again the moment
either address is pinned. What does deserve high-signal monitoring is any change
to the attester, the pause controller, the beacon, or a vault's settlement
executor.
