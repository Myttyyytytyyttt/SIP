# SaverFi

A pension you build one trade at a time, on Solana. A slice of your trading goes
into a vault of your own and buys the assets you chose. Only your pension key —
the Solana wallet you sign in with — can take anything out of it. The program is
upgradeable during the beta.

The code name is SIP: the package names, the environment variables, the
`sip-vault` program and its signed domains all keep it.

## What a vault does

A vault measures its trading in one of two modes, and carries a rate for each:

- **Realized profit.** A slice of what the trading made. The rate the web offers
  is **20 %** (2,000 bps). The program accepts 2.01 % to 100 %.
- **Volume.** A slice of the size of every buy and every sell, winning or losing.
  The rate the web offers is **2 %** (200 bps). The program accepts 0.01 % to
  2 %.

**Only profit vaults are offered today.** The keeper cannot yet measure volume
from real trades, so the web greys that choice out and the build route refuses
it; the program itself still accepts a volume vault from any client.

What is put aside accumulates in the vault and is invested under the policy the
vault's owner signed. The first policy the web signs buys **SPYx** (SP500
xStock) every **$5**, at most $1,000 in one buy and $31,000 in any 30 days. Its
owner can pause investing, sign the policy again at today's prices, and take out
the vault's SOL above its rent floor, or any token it holds.

## How the slice is collected

**The trading wallet has to work anywhere.** Trade on GMGN, Axiom or your own
router and the slice is still collected. That rules out anything in the
execution path: a Privy policy can allow or deny a transaction but cannot add an
instruction to it, and a router of ours would only ever see our own trades.

So the keeper (`packages/solana-keeper`) works from the chain after the fact. It
finds every trading wallet linked to a vault, measures what that wallet traded
since its last settlement, attests the figure and settles it with `settle_v2`.
The trading wallet signs that transaction through a Privy signer seat. A Solana
policy limits the seat to transactions built only from the SaverFi program's
instructions and Ed25519 signature checks. A settlement pays at most the vault's
maximum contribution and is refused if it would leave the wallet below its
reserve. The same keeper invests what has accumulated, as far as the owner's
investment policy allows.

The keeper runs dry by default. A dry run reads no signing secret and only
reports what it would settle. Moving funds takes an explicit arming variable,
and the on-chain configuration must name the keeper's key.

## Layout

```
packages/solana-program   Anchor workspace: the sip-vault program and its IDL, and toy-venue, the venue its invest guards are tested against
packages/solana-core      @sip/solana-core: the IDL codec the browser may load, and the server-only relay, verifier and builders behind the web's Solana routes
packages/solana-keeper    @sip/solana-keeper: discovers links, settles and invests; dry run by default
packages/solana-log       @sip/solana-log: the keeper's redacting logger
packages/website-oficial  @sip/web: the landing, the example dashboard, the vault screens on /wallets, and the Solana routes the browser talks to
tools/landing-shot        regenerates the landing's screenshot of the dashboard (not a workspace package)
archive/evm               retired EVM code: not installed, built, tested or deployed
```

## Quick start

```bash
pnpm install
pnpm dev          # the site on http://localhost:3002 (localhost, not 127.0.0.1)
pnpm typecheck    # solana-log, solana-core, solana-keeper and the web
pnpm test         # the same four packages
pnpm test:keeper  # the keeper alone
pnpm build        # the web's production build; its prebuild runs check:csp and check:idl
```

The landing and the example dashboard need no environment. Connect, `/wallets`
and the Solana routes read the variables in
[`packages/website-oficial/.env.example`](packages/website-oficial/.env.example).

The program has its own toolchain. `pnpm --dir packages/solana-program test`
runs `anchor test` against a local validator and is not part of `pnpm test`.

## Where things are written down

- [docs/runbooks/RAILWAY_SOLANA.md](docs/runbooks/RAILWAY_SOLANA.md) — deploying
  the keeper on Railway: the service settings, every variable, which ones are
  secret, and when each is added.
- [docs/runbooks/VERCEL_WEB.md](docs/runbooks/VERCEL_WEB.md) — deploying the web
  on Vercel: project settings, every variable and its environment, and the
  Privy domain.
- [docs/runbooks/PRIVY_SOLANA.md](docs/runbooks/PRIVY_SOLANA.md) — the keeper's
  Privy signer, the policy that bounds it, and what that policy does not prevent.
- [docs/runbooks/SECRETS.md](docs/runbooks/SECRETS.md) — which keys exist, where
  each one lives, and the rules that keep them out of chats and servers.
- [reports/SIP_SOLANA_BACKEND_ASSESSMENT_2026-09-13.md](reports/SIP_SOLANA_BACKEND_ASSESSMENT_2026-09-13.md)
  — the assessment the Solana design was decided from.
- [reports/SIP_SOLANA_ROADMAP_2026-09-13.md](reports/SIP_SOLANA_ROADMAP_2026-09-13.md)
  — the plan, task by task.
- [packages/website-oficial/README.md](packages/website-oficial/README.md) and
  [packages/solana-core/README.md](packages/solana-core/README.md).

The runbooks and reports are in Spanish.

## State

Beta. The dashboard shows example data; a pension key's own vault, its trading
wallets, investing and withdrawals are on `/wallets`. The keeper stays dry
unless it is armed. The SaverFi program
(`6kA9H9zQT6PW5xWkXoAFCS3NotxarzaYqj66mjMf9w4J`) is upgradeable by its upgrade
authority, today a single team key with no timelock.
