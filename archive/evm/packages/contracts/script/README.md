# Contract deployment scripts

`DeployNuvem.s.sol` deploys the production-style contract topology. It accepts
only Anvil (`31337`), Robinhood testnet (`46630`), and Robinhood mainnet
(`4663`). Mainnet additionally requires `NUVEM_CANARY_APPROVED=true`.

Required environment values:

```dotenv
DEPLOYER_PRIVATE_KEY=
NUVEM_CORPORATE_MULTISIG=
NUVEM_GUARDIAN=
NUVEM_TREASURY=
NUVEM_ATTESTER=
NUVEM_WETH_ADDRESS=
NUVEM_TARGET_ASSET_ADDRESS=
NUVEM_INITIAL_FEE_BPS=
NUVEM_CANARY_APPROVED=false
```

The corporate multisig must expose the standard Safe `getThreshold()` and
`getOwners()` views, and its threshold must be COHERENT — non-zero and no greater
than the owner count. It is **not** required to be 3-of-5; that requirement was
removed deliberately, and `DeployNuvem.s.sol:_requireMultisigInterface` explains
why at length: the probe is the control, and forcing a 3-of-5 on a solo operator
buys five keys from one seed on one machine, which passes the check and makes this
document's claim true in letter and false in substance.

This structural check does not authenticate Safe bytecode, owner identity,
modules, or guards.

**The Safe deployed on mainnet today, `0x43d552d4…`, is 1-of-2** — owners
`0xB284f131…` and `0xdA47CCcf…`, threshold 1. One key proposes any governance
operation. Read that number here rather than "3-of-5" wherever this document
previously implied a quorum.

Run a simulation without broadcasting from `packages/contracts`:

```powershell
forge script script/DeployNuvem.s.sol:DeployNuvem `
  --rpc-url $env:RH_TESTNET_RPC_URL `
  -vvvv
```

The initial cohort beacon is owned by the seven-day timelock immediately.
Factory ownership is temporarily frozen in a sealed bootstrap contract. The
script prints the calldata and operation salt that the corporate multisig must
schedule through the timelock; after seven days, execution makes the timelock
the final factory owner. Timelock execution is open, but only the corporate
multisig can propose operations.

`FeeController` and `FeeCollector` are owned directly by the corporate
multisig, preserving immediate fee and treasury changes. Registries, factory,
pause governance, and beacon upgrades use the timelock; the guardian retains
its narrowly scoped immediate emergency actions.

For a complete local deployment with mock assets, mock adapter, governance
finalization, and a sample permanent vault:

```powershell
forge script script/DeployLocal.s.sol:DeployLocal -vv
```

The local script refuses non-Anvil chain IDs, performs no broadcast, and moves
local time forward by seven days to exercise the real governance delay.

For the signed multi-wallet faucet, synthetic-stock, settlement, and fee drill,
run `pnpm devnet:drill` from the repository root. Unlike `DeployLocal`, this
starts a fresh Anvil and broadcasts real local transactions. Its accounting and
receipt-evidence procedure is documented in the
[devnet trading drill](../../../docs/runbooks/DEVNET_TRADING_DRILL.md).

For the isolated Robinhood Testnet `46630` canary, run
`pnpm public-testnet:drill` first. That command is read-only. The separately
gated `pnpm public-testnet:drill:broadcast` flow uses disposable wallets,
canonical testnet WETH, a synthetic stock, gas-inclusive receipt accounting,
zero/normal investment fees, and a zero-fee admin withdrawal. It deliberately
does not use the production Safe or governance delay. Follow the
[public-testnet synthetic drill](../../../docs/runbooks/PUBLIC_TESTNET_SYNTHETIC_DRILL.md).

The authoritative prerequisites, broadcast procedure, governance handoff,
evidence requirements, and mainnet hard stop are in the
[deployment runbook](../../../docs/runbooks/DEPLOYMENT.md).

## Cohort upgrades

Never promote a fresh implementation directly into an existing stable beacon.
First register it as a separate canary cohort through the timelock, create only
canary vaults there, and complete the contract, storage-continuity, and
operational canary suite.

`PrepareCohortUpgrade.s.sol` is a read-only payload builder. It verifies that
the requested implementation is currently active in a distinct canary cohort,
that the stable beacon belongs to the expected timelock, and that a non-zero
canary evidence hash is supplied. It returns the stable beacon target,
`upgradeTo(newImplementation)` calldata, operation salt, and seven-day delay.
It does not broadcast, schedule, or execute the operation.

The corporate multisig must schedule that exact payload on the timelock.
Promotion can execute only after the seven-day delay. The evidence hash binds
the operation to the reviewed canary report but does not prove that the report
is correct; reviewers must verify the referenced evidence independently.
