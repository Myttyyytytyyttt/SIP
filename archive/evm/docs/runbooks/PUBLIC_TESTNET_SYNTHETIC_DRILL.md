# Public-testnet synthetic trading drill

## Scope and safety boundary

This drill is isolated from the local `31337` workflow and runs only when the
RPC reports Robinhood Chain testnet chain ID `46630`.

It proves a small, synthetic path:

1. a faucet-funded deployer creates test-only protocol components;
2. the deployer funds one vault admin, two trading accounts, and a deterministic
   native-ETH market;
3. the vault admin creates one permanent vault and invites both accounts;
4. trader A changes only its own savings percentage;
5. both traders buy and sell `DevnetSyntheticStock` at deterministic prices;
6. receipt and historical-balance evidence derives PnL after gas;
7. both traders settle their configured profit percentages into canonical testnet
   WETH;
8. the vault invests once at a zero fee and once at the configured normal fee;
9. the fee is swept to the test treasury;
10. while the normal investment fee remains active, the vault admin withdraws
    the exact remaining WETH with a zero protocol fee;
11. final WETH conservation and recipient deltas are checked.

This does **not** prove production readiness. The stock is minted test
infrastructure, not a share or Robinhood Stock Token. The market is not an
exchange or oracle. Administration is by disposable EOAs, the cohort timelock
has zero delay, and the adapter has an immutable synthetic rate. This drill does
not validate the production Safe, seven-day governance delay, restricted assets,
GMGN, eligibility, or mainnet liquidity.

Never use production keys or real funds.

## Current testnet facts to reverify

The following values were observed through the official testnet RPC on
2026-07-26:

- chain ID: `46630`;
- public RPC: `https://rpc.testnet.chain.robinhood.com`;
- explorer: `https://explorer.testnet.chain.robinhood.com`;
- WETH: `0x7943e237c7F95DA44E0301572D358911207852Fa`;
- WETH runtime size: `2202` bytes;
- WETH runtime codehash:
  `0x5706be52f64875fee65a2cec0d80e47a23d8793cbe85d214b48445e2d05f5353`;
- WETH metadata: name `WETH`, symbol `WETH`, decimals `18`.

These are time-sensitive observations, not permanent constants. Reconfirm them
against the [official connection documentation](https://docs.robinhood.com/chain/connecting/)
and [testnet explorer](https://explorer.testnet.chain.robinhood.com/tokens)
before every run. Obtain test ETH from the
[official faucet](https://faucet.testnet.chain.robinhood.com/). Faucet
eligibility and grant size are determined interactively and must not be assumed.

The public RPC is rate-limited. The wrapper requires historical native and WETH
balances at exact blocks, so use an archive-capable Robinhood testnet RPC if the
public endpoint rejects historical reads.

## Prerequisites

- Node `22.14.0`, pnpm `10.18.1`, Foundry, and PowerShell.
- A gitignored root `.env` copied from `.env.example`.
- Five new and distinct disposable private keys:
  deployer, vault admin, trader A, trader B, and attester.
- Only the deployer funded with faucet ETH. The script funds the three
  transaction-paying participants; the attester signs offchain.
- A fresh vault-admin wallet for every run. `VaultFactory` enforces one vault
  per admin.
- An RPC capable of historical `eth_getBalance` and ERC-20 `balanceOf` calls.

The example values require at least `0.0074 ETH` at preflight:

```text
vault-admin funding       0.0003 ETH
trader A funding          0.0005 ETH
trader B funding          0.0004 ETH
market liquidity          0.0002 ETH
deployer gas budget       0.0060 ETH
                          ---------
minimum preflight total   0.0074 ETH
```

The gas budget is a safety reserve, not a gas-price guarantee. If the simulation
or public RPC indicates it is insufficient, increase only the gas budget. Do not
increase trade sizes merely because the faucet granted more ETH.

## Configure and verify

Copy the environment template:

```powershell
Copy-Item .env.example .env
```

Set `RH_TESTNET_RPC_URL` without printing it. Generate a non-secret, unique run
identifier:

```powershell
cast keccak "nuvem-public-testnet-synthetic-YYYYMMDD-unique-label"
```

Place that bytes32 value in `PUBLIC_TESTNET_DRILL_RUN_ID`.

Before accepting the observed WETH configuration, independently read it:

```powershell
$env:ETH_RPC_URL = "<archive-capable testnet RPC>"
$weth = "0x7943e237c7F95DA44E0301572D358911207852Fa"
cast chain-id
cast codehash $weth
cast call $weth "name()(string)"
cast call $weth "symbol()(string)"
cast call $weth "decimals()(uint8)"
```

Set the verified address and codehash in `.env`. The Solidity preflight checks:

- exact chain ID `46630`;
- nonempty WETH bytecode;
- exact runtime codehash;
- exact `WETH` name and symbol;
- 18 decimals;
- five nonzero, distinct participant keys;
- positive-price trade economics;
- enough market liquidity for both profitable exits;
- enough participant balance for trades, floor, reserve, and gas budget;
- enough deployer balance for every configured transfer plus its gas budget.

Set:

```text
PUBLIC_TESTNET_DRILL_ACKNOWLEDGE_SYNTHETIC=true
```

This acknowledges only that the environment is synthetic. It does not authorize
a transaction.

## Read-only preflight

From the workspace root:

```powershell
pnpm public-testnet:drill
```

This command:

- loads `.env` without echoing secrets;
- checks chain ID and an historical-state read;
- runs the public-testnet guard/config and immutable-adapter tests;
- executes the read-only Solidity preflight;
- performs no broadcast.

Stop if the RPC cannot serve historical state, WETH validation changes, the
deployer is underfunded, any wallet is reused, or any configuration check fails.

## Explicit broadcast

Review the preflight, then set the second independent gate:

```text
PUBLIC_TESTNET_DRILL_BROADCAST_CONFIRMATION=46630_SYNTHETIC_ONLY
```

The only supported full-run command is:

```powershell
pnpm public-testnet:drill:broadcast
```

The wrapper refuses an RPC whose chain ID is not `46630` and refuses to
overwrite any existing deployment, results, receipt-ledger, or broadcast
evidence file. It neither derives keys nor prints them. It passes the RPC to
child processes through environment/config rather than displaying a potentially
secret provider URL.

After the trades, the wrapper waits for a later public block and the configured
confirmation count. The settlement script itself requires
`tradeEndBlock < block.number`; it never uses `vm.roll`.

## Gas-inclusive evidence

Trader A's evidence window starts at its `setMySavingsBps` transaction. Trader
B's starts at its buy. Both end at their sell. This makes the balance snapshots
correct even if trader A's BPS update and buy share a block.

For each account the wrapper proves:

```text
cash = native ETH + WETH
net realized PnL = cashEnd - cashStart
net realized PnL = deterministic gross trade profit - included transaction gas
contribution = floor(net realized PnL * current savingsBps / 10,000)
```

It hashes the canonical receipt ledger, injects only the resulting roots and
numeric cash fields into the settlement phase, and derives each investment as
one third of the aggregate net contribution. The remaining third stays in WETH.
Rounding must still produce a nonzero normal fee and nonzero adapter output. At
the end, the vault admin withdraws that exact remaining third. The verifier
requires the recipient WETH delta to equal the vault debit and the fee
collector's balance to remain unchanged, even though the normal investment fee
is still configured.

## Evidence outputs

A successful run produces:

```text
packages/contracts/deployments/public-testnet-synthetic-drill-46630.json
packages/contracts/deployments/public-testnet-synthetic-drill-receipts-46630.json
packages/contracts/deployments/public-testnet-synthetic-drill-broadcasts-46630.json
packages/contracts/deployments/public-testnet-synthetic-drill-results-46630.json
packages/contracts/broadcast/DeployPublicTestnetDrill.s.sol/46630/run-latest.json
packages/contracts/broadcast/ExecutePublicTestnetTrades.s.sol/46630/run-latest.json
packages/contracts/broadcast/SettleAndInvestPublicTestnetDrill.s.sol/46630/run-latest.json
```

The final verifier checks:

- two active accounts and one settlement nonce each;
- trader A's updated BPS and trader B's independent BPS;
- no open synthetic positions;
- exact lifetime and aggregate contributions;
- exact zero-fee and normal-fee investment deltas;
- exact admin WETH withdrawal, a zero withdrawal fee, and no collector delta;
- the empty-WETH vault remains registered to its admin and both trading
  accounts remain bound to it;
- the configured immutable adapter bindings and rate;
- fee collector swept and treasury WETH increased only by the normal fee;
- conservation across withdrawn WETH, adapter WETH, and treasury fee.

Preserve all four JSON evidence files with their matching broadcast directories.
If a run fails after deployment, do not blindly rerun or delete evidence. Inspect
receipts and nonces first. A new clean run needs five fresh wallets, a fresh run
ID, and archived prior outputs.

## Local validation

These commands remain non-broadcasting:

```powershell
Push-Location packages/contracts
forge build
forge test --match-path "test/unit/script/PublicTestnetDrillScripts.t.sol" -vv
Pop-Location
```

The existing `pnpm devnet:drill` remains local-only on `31337`; none of its chain
guards, mock WETH, deterministic Anvil accounts, or `.local.json` artifacts are
reused by this public-testnet workflow.
