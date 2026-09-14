# archive/evm

SIP's retired EVM stack (Robinhood Chain), kept for its history and records.

**Why.** On 2026-09-14 SIP became Solana-only. The EVM code was moved here, not
deleted.

**What is here.** It is laid out as it was at the repository root:

- `packages/contracts`: the Solidity contracts, Foundry scripts and tests, and
  the deployment records. The forge-std submodule was removed. `foundry.lock`
  still pins its commit, so `forge install` can restore it.
- `packages/contracts-artifacts`: the ABIs exported from those contracts.
- `packages/worker`: the EVM volume worker (`@sip/worker`). Its logger was
  copied, unchanged, to `packages/solana-log`.
- `docs/runbooks`, `docs/architecture`, `docs/security`: the nine EVM documents
  (SETUP, DEPLOYMENT, DEPLOYMENT_WEB, WORKER_RAILWAY, DEVNET_TRADING_DRILL,
  PUBLIC_TESTNET_SYNTHETIC_DRILL, CONTRACTS, WEB_WALLETS, THREAT_MODEL).

**Status.** None of this is installed, built, tested or deployed. It sits
outside the pnpm workspace (`packages/*`) and is excluded from the Docker build
context (`.dockerignore`). The files are byte-identical to their state before
the move, except for relative links the move broke. Commands and paths inside
them still describe the old layout.
