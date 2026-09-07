# Nuvem

Nuvem is a backend-first Robinhood Chain savings system. One permanent personal
vault is administered by the user's `VaultAdmin` wallet and can receive
settlements from any number of separately authorized trading wallets.

The current workspace contains the Phase 1 smart-contract system, deterministic
deployment scripts, Foundry verification, a minimal Alchemy MAv2/EIP-7702 smoke
harness, and the [GMGN mainnet canary results](docs/canary/GMGN_EIP7702_RESULTS.md).
It intentionally does not include the product frontend, PnL indexer, keeper, or
production Stock Token adapter.

The canary gate passed and the loop closed on mainnet: a 7702-delegated EOA
traded on GMGN, and 20% of the measured profit settled into its PersonalVault as
WETH. Addresses and evidence are in the
[mainnet settlement results](docs/canary/MAINNET_SETTLEMENT_RESULTS.md).

Two constraints found the hard way and worth knowing before reading further.
`block.number` on this chain is the **L1** block number, millions apart from the
L2 numbers an indexer observes — mixing them makes every settlement revert. And
the delegation must be applied with a plain EIP-7702 type-4 transaction, because
the low-level Alchemy SDK path ships the authorization unsigned; the SDK works
normally once the account is delegated.

## Safety boundary

The protocol is administratively controlled. A company multisig can upgrade a
vault cohort after a seven-day timelock and can change the investment fee
immediately from 0% to 100%. At 100%, the selected WETH investment amount is
transferred to the fee collector without purchasing the target asset. This must
not be represented as a fully non-custodial or trust-minimized product.

## Local commands

```powershell
nvm use 22.14.0
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm devnet:drill
pnpm public-testnet:drill
```

Secrets belong only in the gitignored root `.env`. Copy `.env.example` and fill
it locally before broadcasting or running a Robinhood Testnet flow. The public
testnet drill is preflight-only by default; broadcasting requires its separate
explicit command and confirmation value.

## Documentation

- [Contract architecture](docs/architecture/CONTRACTS.md)
- [Contract threat model](docs/security/THREAT_MODEL.md)
- [GMGN / EIP-7702 canary results](docs/canary/GMGN_EIP7702_RESULTS.md)
- [Mainnet deployment and first settlement](docs/canary/MAINNET_SETTLEMENT_RESULTS.md)
- [Deployment runbook](docs/runbooks/DEPLOYMENT.md)
- [Signed local devnet trading drill](docs/runbooks/DEVNET_TRADING_DRILL.md)
- [Robinhood Testnet synthetic trading drill](docs/runbooks/PUBLIC_TESTNET_SYNTHETIC_DRILL.md)
- [Alchemy MAv2/EIP-7702 smoke runbook](docs/AA_SMOKE_RUNBOOK.md)
- [Versioned contract artifacts](packages/contracts-artifacts/README.md)
