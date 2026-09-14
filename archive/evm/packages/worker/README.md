# @sip/worker

The volume worker. Every few minutes, for every trading wallet bound to a SIP vault, it finds the buys
and sells that wallet made **anywhere** on Robinhood Chain 4663, works out each fill's gross cash
notional, closes a window of fills behind a finality margin, signs a volume attestation, and — through
the app signer seat the website attached to the wallet in Privy — has the wallet itself pay
`bps × Σnotional` (or whatever it can) into its `PersonalVault`. **Dry run by default.**

Design: [`DESIGN.md`](DESIGN.md). Why this shape: `reports/SIP_BACKEND_ASSESSMENT_2026-09-07.md` §4.

## Run

```bash
pnpm install                                  # repo root
cp packages/worker/.env.example packages/worker/.env   # fill SIP_RPC_URLS at least
cd packages/worker
set -a; . ./.env; set +a
pnpm tick        # one pass, prints a TickSummary as JSON, exits
pnpm worker      # loop every SIP_POLL_MS (default 5 min) with a heartbeat
pnpm test        # 511 tests, no network
pnpm typecheck
```

A pass in dry run does everything except sign and send: discovers linked wallets from the factory's
logs, scans, reconciles every (wallet, block), closes windows, builds the attestation against the live
vault state, and logs the pull it *would* make with its amounts.

## Live mode

Requires, all at once: `SIP_WORKER_ALLOW_BROADCAST=i-understand-this-moves-real-funds` (byte-exact —
`true`, `1`, a trailing space all keep you in dry run), `SIP_ATTESTER_PRIVATE_KEY` (the key registered in
`AttesterRegistry`; signs attestations, holds no funds), `PRIVY_APP_ID` / `PRIVY_APP_SECRET` /
`PRIVY_AUTHORIZATION_PRIVATE_KEY` (the app's additional-signer key, policy-bounded to the executor's
call), and `DATABASE_URL` (a live worker must remember what it sent). In dry run the process deletes the
secret variables by name without reading them; there is no key in memory that could broadcast.

## What it needs from the outside

- **An archive-capable, range-uncapped RPC.** Discovery uses `eth_getLogs` over long ranges with a
  coverage check per chunk, and balance reads at `N−1` for blocks older than 128. Alchemy **Pay-As-You-Go**
  (Robinhood Mainnet range "unlimited"); the Free tier caps ranges at 10 blocks, and Robinhood's public
  RPC is pruned at ~10k blocks — the worker detects both and **refuses to report a scan that did not
  happen** rather than advancing a cursor. Put the public RPC second in `SIP_RPC_URLS` as a read fallback.
- **A Privy app in TEE mode**, with the trading wallets born seated (`signers` at creation, or
  `additionalSigners` on import) under a policy pinned to the executor's selector.
- **Phase 0** points at the deployed `SettlementExecutor`; **Phase 1** at `SipVolumeExecutor` once
  each vault admin has called `setSettlementExecutor` — see `DESIGN.md` §5 and §7.

## Layout

```
src/types.ts              THE CONTRACT between modules (frozen during a build wave)
src/config.ts, log.ts     env, dry-run sentinel, Redactor (every 64-hex and URL masked)
src/rpc/                  JSON-RPC client with backoff, record/replay fixture client, index-addressed failover
src/chain/                4663 constants (WETH, GMGN router, PoolManager, factory…), typed reads, chunked getLogs with coverage check
src/observe/discover.ts   wallet-topic Transfer logs (OR arrays) ∪ wallet-sent txs per candidate block; nonce reconciliation with bisection
src/observe/context.ts    a (wallet, block): txs with receipts, native+WETH at N−1/N, eth_getCode
src/observe/reconcile.ts  DESIGN §3 rule by rule; fills, exclusions, refusals; the zero-wei cash identity
src/observe/venues/       GMGN decoder (FILL 0x8619026a…, FEE 0x205442d6…) — exact gross notional without a tracer
src/attest/               batch root, one-height vault snapshot, Phase 0 attestation (preflight → sign → digest cross-check)
src/pull/                 Privy seat signer (fresh seat check per call), broadcast ordering: nonce → estimate → sign → INTENT → send
src/ledger/               Postgres (advisory lock, wei as numeric(78,0), immutability triggers) and an in-memory twin
src/tick.ts, bin/         the pass, the loop, skip-while-running, heartbeat
test/                     511 tests; test/fixtures/mainnet-4663.json is recorded mainnet truth (four GMGN fills, approve, unwrap, airdrop, settle, deposit, withdrawal)
```

## Known limits (v1)

Token-for-token swaps and multi-fill transactions carry no cash notional and are excluded by policy;
a wallet with code (EIP-7702) is only decodable through venue decoders; a plain inbound native transfer is
invisible unless it shares a block with a candidate (it is cash, not volume); volume before the worker
first watched a wallet is not observed (the cursor bootstraps at the close line).
