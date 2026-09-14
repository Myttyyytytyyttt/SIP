# Local devnet trading drill

This drill proves the Nuvem contract path with signed transactions against a
fresh Anvil RPC. It deploys a faucet, two independent trading wallets, a
synthetic `nSPY` ERC-20, a fixed-price stock venue, the Nuvem protocol, one
permanent vault, and two platform bindings.

It is local-only. `nSPY` is test inventory, not a security, oracle price, or
claim on a real share. The scripts reject every chain except `31337`, and the
wrapper refuses to reuse an RPC already listening on its port.

## One-command execution

From `packages/contracts` on Windows:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\run-devnet-trading-drill.ps1
```

Use another unused port if needed:

```powershell
.\scripts\run-devnet-trading-drill.ps1 -Port 9545
```

The wrapper:

1. starts a hidden, ephemeral Anvil with a public local-test mnemonic;
2. derives distinct admin, vault-admin, attester, and trading keys without
   writing the keys to disk;
3. runs the focused Forge E2E tests;
4. deploys and configures Nuvem with `--broadcast`;
5. funds fresh wallets from the on-chain faucet;
6. broadcasts buys, approvals, and sales from two trading wallets;
7. rejects any missing or failed receipt;
8. derives receipt-bound ledger roots and gas-inclusive cash PnL;
9. broadcasts both settlements and the 0%, 2.5%, and 100% investment-fee cases;
10. queries the post-broadcast chain state and exports verification evidence.

Anvil is stopped in `finally`. Pass `-KeepAnvil` only when you need to inspect
the final state manually.

## Executed scenario

- Trading account A is tagged `DEVNET_GMGN_SIM`, saves 20%, buys 4 nSPY for
  4 ETH, then sells it for 6 ETH.
- Trading account B is tagged `DEVNET_BROKER_SIM`, saves 30%, buys 2 nSPY for
  2 ETH, then sells it for 3 ETH.
- The market reprices from 1 ETH to 1.5 ETH per nSPY between buys and sells.
- PnL uses `native balance + WETH balance` immediately before the buy and at
  the sale block. The balance delta therefore includes the actual gas paid for
  buy, approve, and sell.
- Faucet funding and account activation happen before the measured session;
  they are recorded as pre-session funding, not trading profit.
- Contribution is calculated from net PnL after gas, then wrapped into WETH by
  the vault.
- The vault invests 0.2 WETH at 0% fee, 0.2 WETH at 2.5% fee, and sends
  0.1 WETH entirely to fees at 100%. The 100% case requires `minAmountOut=0`
  and skips the adapter.

Gas prices vary, so exact PnL and contributions vary slightly between runs.
The deterministic terminal balances are:

- vault nSPY: `0.395e18`;
- adapter WETH: `0.395e18`;
- treasury WETH fees: `0.105e18`;
- vault WETH: `aggregate contributions - 0.5e18`.

The verifier also checks conservation:

```text
vault WETH + adapter WETH + treasury WETH
    == aggregate lifetime contributions
```

## Evidence

All generated evidence is ignored by Git:

- `deployments/devnet-trading-drill-31337.local.json`
- `deployments/devnet-trading-drill-receipts-31337.local.json`
- `deployments/devnet-trading-drill-broadcasts-31337.local.json`
- `deployments/devnet-trading-drill-results-31337.local.json`
- `broadcast/*/31337/run-latest.json`

Each trader ledger root commits to a canonical JSON record containing the
account, market, stock, cash snapshots, block range, and the buy/approve/sell
transaction hashes, block hashes, full logs, logs hashes, `gasUsed`, and
`effectiveGasPrice`. The settlement attestation uses that root.

The wrapper validates every setup, trade, settlement, investment, fee-change,
and treasury-sweep receipt has success status and both transaction and block
hashes. The final read-only script independently checks post-broadcast state.

## Trust boundary

The contract proves that `realizedProfit` matches the cash fields signed by the
current attester. It cannot prove those signed cash fields are truthful. A
compromised attester could falsify cash fields and `realizedProfit`
consistently.

This drill creates its roots from canonical local receipts as a reference
pipeline. A production attester still needs an independently operated indexer,
chain-ID and contract allowlists, canonical-receipt verification, reorg/finality
rules, token-flow classification, and durable evidence retention. The Forge
loss test only rejects a profit value that contradicts the signed cash fields;
it is not proof against a malicious attester.

## Focused deterministic tests

```powershell
forge test --match-path "test/e2e/DevnetTradingDrill.t.sol" -vv
```

They cover the profitable two-platform path, all three fee modes, WETH
conservation, fee sweeping, faucet replay, slippage, deadlines, a losing stock
trade, contradictory PnL, and the invalid `minAmountOut>0` full-fee case.
