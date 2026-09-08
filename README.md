# SIP — Self Implemented Pension

A pension you build one trade at a time. A slice of the **size** of every buy and
every sell goes aside the moment the order fills, accumulates, and buys the assets
you chose. Not a slice of profit: of volume. Winning or losing never enters into it.

## The constraint that shapes everything

**The trading wallet has to work anywhere.** Export the key and trade on GMGN or
Axiom, or import one you already had, and the skim still happens. That rules out
every mechanism living in the execution path — EIP-7702 code does not run on an
EOA's outbound transactions, a Privy policy permits or denies but cannot insert a
call, and a router of ours would only ever see our own trades.

So the skim is **observed on chain after the fill** and **pulled** from the wallet
afterwards, through a policy-bounded Privy signer seat. Collection is best-effort
and the product says so: the pull takes `min(owed, balance − reserve)` and carries
the shortfall forward, because a wallet full of tokens has no ETH to pay with.

## Layout

```
packages/contracts            the vault system, and SipVolumeExecutor
packages/contracts-artifacts  ABIs and bytecode, exported deterministically
packages/worker               @sip/worker — observe, attest, pull
packages/website-oficial      @sip/web — the dashboard, and /wallets
```

## Quick start

```bash
pnpm install
pnpm --dir packages/website-oficial dev     # the site on :3002
pnpm --dir packages/worker tick             # one worker pass, dry run
pnpm test                                   # contracts + worker
```

Nothing is deployed. The worker refuses to start without `SIP_VAULT_FACTORY` and
`SIP_SETTLEMENT_EXECUTOR`, on purpose: this project does not reuse the deployment
it was forked from, whose trading accounts carry a savings rate meaning a
*percentage of profit*. Applying that rate to a volume would skim roughly a
hundred times what a user agreed to. See `docs/runbooks/DEPLOYMENT.md`.

## Where the reasoning lives

- `reports/SIP_BACKEND_ASSESSMENT_2026-09-07.md` — why this architecture and not
  another. Annex D is the part worth reading: five adversarial verifications, all
  of which came back "partially", each one changing the design.
- `reports/PENDING_REVIEW_FINDINGS_2026-09-07.md` — what a 35-finding review
  fixed, and the three things still open.
- `packages/worker/DESIGN.md` — how the observer decides what a fill is worth, and
  when it refuses to decide.
- `docs/security/THREAT_MODEL.md` — what SIP is trusted for, and what bounds it.

## State

Worker: 511 tests. Contracts: 425 tests. The site builds with a 69-fragment ABI
check against the artifacts. A dry-run pass has run against Robinhood Chain
mainnet and reconstructed real fills to the wei — but nothing has ever collected
a single wei, because no SIP deployment exists yet.
