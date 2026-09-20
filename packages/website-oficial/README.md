# @sip/web

**SaverFi**, on Solana. A pension you build one trade at a
time: a slice of a linked wallet's trading, measured as volume or as realized
profit, is put aside in its owner's vault and invested in the assets they chose.
This package is the site: the landing, the example dashboard, the wallets page
and the two Solana routes the browser talks to.

## What it serves

| Path              | What it is |
| ----------------- | ---------- |
| `/`               | The landing for a visitor without a pension key. Signing in with a Solana wallet, or following "See the app", opens the dashboard. |
| `/?mode=mock`     | The dashboard on example data, badged **Sample data**, with **Live** disabled. There is no live data until the Solana vault screens land. |
| `/wallets`        | The wallets screen: connect the pension key with a Solana wallet; create trading wallets born with the keeper's seat (its Privy signer, bounded by its policy); see whether Privy records a signer on each wallet (not whose: `privy-policy verify` confirms the keeper's, with its policy), grant a missing seat, and export a trading wallet's key through Privy's dialog. The setup checklist when the configuration is incomplete. |
| `/api/health`     | Liveness. Always 200, whatever the configuration: check `/wallets` for that. |
| `/api/solana-rpc` | A narrow JSON-RPC relay for Privy's Solana signing UI. The keyed upstream URL never reaches the browser. |
| `/api/solana-tx`  | Verified broadcast: a transaction the user already signed is checked against the core's verifier, simulated and sent. The route never signs. |

The pension key is the external Solana wallet the user signed in with (Phantom,
Backpack, Solflare…), never a Privy-embedded wallet (`src/lib/pension-key.ts`).
The program refuses to link that key as a trading wallet.

## Quick start

```bash
pnpm install                              # from the repo root
pnpm --dir packages/website-oficial dev   # http://localhost:3002 (localhost, not 127.0.0.1)
```

The landing and the example dashboard need no environment. Connect, `/wallets`
and the two Solana routes need the configuration: copy `.env.example` to
`.env.local` and fill it in. `pnpm start` serves a production build on port 3002;
`./node_modules/.bin/next start --port <port>` serves it on another.

## Configuration

The server reads the environment at request time (`src/lib/load-config.ts`).
Nothing is inlined at build time, so one build runs in every environment. Every
variable, and how to obtain it, is described in [`.env.example`](.env.example).

- **Required:** `PRIVY_APP_ID`, `SIP_SOLANA_RPC_URLS` (server-side only: it
  carries an API key), `SIP_SOLANA_PROGRAM_ID`, `SIP_TRUSTED_CLIENT_IP_HEADER`.
- **Optional:** `SIP_SOLANA_KEEPER_URL` (the keeper's public URL; without it
  `/leaderboard` says the rankings are unavailable and names the variable);
  `SIP_SOLANA_PUBLIC_WS_URL`; `SIP_SOLANA_PRIVY_SIGNER_ID` and
  `SIP_SOLANA_PRIVY_POLICY_ID`, both or neither; `PRIVY_CLIENT_ID`; and the
  budgets `SIP_SOLANA_RELAY_PER_MIN`, `SIP_SOLANA_RELAY_SIGNING_GLOBAL_PER_MIN`,
  `SIP_SOLANA_RELAY_READS_GLOBAL_PER_MIN`, `SIP_SOLANA_SEND_PER_MIN` and
  `SIP_SOLANA_SEND_GLOBAL_PER_MIN`.
- **Refused:** every `NUVEM_SOLANA_*` name and the program id SaverFi never talks to;
  `SIP_SOLANA_RELAY_GLOBAL_PER_MIN`; the keeper's secrets
  `SIP_SOLANA_SETTLE_KEY`, `SIP_SOLANA_PRIVY_APP_SECRET` and
  `SIP_SOLANA_PRIVY_AUTHORIZATION_KEY`; Privy's server credentials
  `PRIVY_APP_SECRET` and `PRIVY_AUTHORIZATION_PRIVATE_KEY`; and `SIP_CHAIN` set
  to anything other than `solana`. An unset, blank or `solana` `SIP_CHAIN` is
  accepted, so the variable can simply be deleted. The secret names are refused
  by name, even when blank, and their values are never read.
- **Named, not refused:** the EVM-era names the old web read (`NUVEM_RPC_URL`,
  `PRIVY_SIGNER_ID`, `PRIVY_POLICY_ID`, the factory and executor addresses, …).
  Nothing reads them. The first time a server process sees one that is not
  blank, it logs one warning listing the names, never a value.

A problem never breaks a page. Connect and `/wallets` show the setup checklist,
which names each variable and never its value, and `/api/solana-rpc` and
`/api/solana-tx` answer 503 with no detail. `/api/health` stays 200.

## Stack

Next 16 (App Router) · React 19 · TypeScript strict · Tailwind v4 · shadcn 4
(`radix-nova`, base color `neutral`, CSS variables) · `next-themes` (class
strategy, light / dark / system from the header) · `recharts`, only through
shadcn's `chart` component · `@privy-io/react-auth`, for Solana wallets only ·
`@sip/solana-core`, for everything that touches the chain. Fonts are Geist for
words and Geist Mono for every number.

## The one screen

Three regions, borrowed from a reference layout and nothing else from it:

| Region                            | Component                                 |
| --------------------------------- | ----------------------------------------- |
| Sidebar — what the wallet did     | `WalletActivity`                          |
| Strip — what each trade put aside | `SavingsStrip`                            |
| Narrow panel — the rule           | `SavingsRulePanel`                        |
| Big panel — the pension           | `PensionPanel` (+ chart, stats, holdings) |
| Top bar                           | `SiteHeader`                              |

Below `lg` the sidebar disappears and the header opens the same component in a
sheet.

```
src/app/layout.tsx                  fonts, ThemeProvider, TooltipProvider
src/app/page.tsx                    reads the configuration; hands the shell the example and the wallets host
src/app/providers.tsx               the Solana PrivyProvider: wallet login, Solana wallets only, no embedded wallet on login
src/app/wallets/page.tsx            the wallets screen inside <Providers>, or the setup checklist
src/app/api/health/route.ts         liveness
src/app/api/solana-rpc/route.ts     the relay (handlers from @sip/solana-core/server)
src/app/api/solana-tx/route.ts      verified broadcast (handlers from @sip/solana-core/server)
src/proxy.ts, security-headers.mjs  the Content-Security-Policy and the other headers, on every response
src/lib/config.ts, load-config.ts   the configuration: its types, the readers, the refusals and the routes' gate
src/lib/solana-routes.ts            the core's route handlers, behind that gate
src/lib/pension-key.ts              the pension key, derived from Privy's user in the browser
src/lib/privy-failure.ts            what Privy's failures mean, in words someone can act on
src/lib/trading-wallets.ts          trading wallets and the keeper's seat: its signer with its policy, the list from Privy's record, the create, whether Privy records a signer (never whose), the repair, the export
src/components/landing.tsx          the front door
src/components/dashboard-shell.tsx  landing or dashboard, and the note over the example
src/components/wallets-host.tsx     "Manage wallets": the wallets modal, or the setup modal when the configuration is incomplete
src/components/wallets/*            WalletsScreen (both containers), WalletsModal, TradingWalletsCard, TradingWalletRow, AddressLine, SetupChecklist, WalletsSetupModal
src/hooks/use-create-trading-wallet.ts, use-keeper-seat.ts, use-export-trading-wallet.ts
                                    create born seated; read whether a signer is recorded, grant a missing seat, re-read; export through Privy's dialog
src/mocks/types.ts                  THE CONTRACT — what the backend will have to produce
src/mocks/data.ts                   one deterministic instance: a volume-mode vault at 2%, seeded, identical on server and client
src/lib/format.ts                   every number and date on the page (UTC, en-US, on purpose)
src/components/site-header.tsx, wallet-menu.tsx, data-mode.tsx, DashboardSource.tsx
src/components/wallet-activity.tsx, activity-row.tsx, copy-button.tsx
src/components/savings-strip.tsx, strip-chip.tsx
src/components/savings-rule-panel.tsx
src/components/pension-panel.tsx, pension-chart.tsx, pension-stats.tsx, pension-holdings.tsx
src/components/mode-toggle.tsx, theme-provider.tsx, site-footer.tsx
src/components/ui/*                 shadcn, generated — add with `pnpm dlx shadcn@4 add <name>`, never edit by hand
```

## Rules the code follows

- **Deterministic rendering.** No `Date.now()`, `Math.random()` or `toLocale*()`
  in anything that renders; "now" is data (`mock.now`), and dates format in UTC.
  That is what keeps server and client HTML identical.
- **Tokens only.** `background`, `foreground`, `muted`, `border`, `card`,
  `primary`, `destructive`. One accent — emerald — and it means exactly one
  thing: money put aside.
- **Vocabulary.** Orders are *bought* / *sold*; the slice is *put aside*; the
  pension *invests* when the pile reaches the threshold. The example is a
  volume-mode vault, so its slice comes from each fill's size and it never shows
  a profit, a win or a loss. A profit-mode vault takes its slice from realized
  profit instead; the example does not model one.
- **Every number is `font-mono tabular-nums`.**
- **Server components by default.** `"use client"` only where there is state,
  an effect, a handler or a chart.

## Verify

```bash
pnpm --dir packages/website-oficial run typecheck
pnpm --dir packages/website-oficial run test
pnpm --dir packages/website-oficial run check:csp   # the production Content-Security-Policy, pinned byte for byte
pnpm --dir packages/website-oficial run check:idl   # solana-core's check of the program's IDL
pnpm --dir packages/website-oficial run build       # its prebuild runs check:csp and check:idl
pnpm --dir packages/website-oficial run verify      # all of the above
```

`security-headers.mjs` sends a same-origin CSP on every response;
`'unsafe-eval'` is granted in development only, for React's debugging overlay.

`public/landing/app-dark.png` is a picture of `/?mode=mock`. It does not change
when the mock does: regenerate it with `tools/landing-shot` against a running
server.

Privy must run the app in TEE mode for a signer seat to attach to a trading
wallet (step 4 in `.env.example`, and
[docs/runbooks/PRIVY_SOLANA.md](../../docs/runbooks/PRIVY_SOLANA.md)).

A trading wallet's badge says **Has a signer**, never "Seated". Privy's browser
SDK reports that a wallet has a signer (`delegated`), not which signer or which
policy, and the web holds no app secret to ask Privy's API (it refuses one by
name). The row prints the check with its ids,
`privy-policy verify --wallet <Privy wallet id> --policy <policy id>`
(`packages/solana-keeper`, step 6 of the runbook).

A wallet whose signer is wrong — another key quorum, the keeper's without its
policy, or the keeper's from before its authorization key was replaced — is its
owner's to fix, signed in, with **Re-seat keeper** on that wallet's row: Privy's
`removeSigners`, which removes every signer on the wallet, then the same grant
as Grant keeper permission. Because the page cannot tell a wrong signer from a
right one, the button is on every row with a signer, behind a confirmation that
says it removes every signer on this wallet. A re-seat that stops after the
removal leaves the wallet with no signer — only its owner can sign — and the row
then reads **No seat** with Grant keeper permission, one press. It is refused,
before anything is sent, for a wallet Privy would not clear on its own: for any
wallet but a TEE one with its own wallet id, Privy's removal revokes the signers
of every wallet on the account.

Privy's `addSigners` and `removeSigners` find the wallet in the user record of
the render they came from, so that record is the one checked (`teeWalletId`).
Whether a TEE wallet keeps its server id in Privy's record once its last signer
is gone is not established — Privy's types say the id is null unless the wallet
is delegated. So the re-seat sends the add in the same run, through the
`addSigners` captured before the removal, and if the record dropped the id it
stops as `id-dropped`, naming the id: a later Grant keeper permission comes from
a render without it and cannot reach the wallet, and the row disables it with
the reason. The order of a key rotation, with the rehearsal on a wallet with no
funds that settles the question, is in
[docs/runbooks/PRIVY_SOLANA.md](../../docs/runbooks/PRIVY_SOLANA.md), section 7.

## Deployment

`Dockerfile` builds this package from the **repo root** context:

```bash
docker build -f packages/website-oficial/Dockerfile -t sip-web:local .
```

It takes no build argument, because the server reads its configuration at
request time. **The web is hosted on Vercel**, not from this image: Root
Directory `packages/website-oficial`, the variables set in the Vercel project,
`SIP_TRUSTED_CLIENT_IP_HEADER=x-real-ip`, and the production domain in Privy, as
[docs/runbooks/VERCEL_WEB.md](../../docs/runbooks/VERCEL_WEB.md) walks through.
The `Dockerfile` and the root `docker-compose.yml` remain a local production
rehearsal only; no platform deploys them.
