# @sip/web

**SIP — Self Implemented Pension.** A pension you build one trade at a time: a
rule takes a slice of the size of every buy and every sell, puts it aside the
moment the order fills, and once the pile reaches a threshold it invests it in
the assets you chose. Winning or losing does not enter into it — volume does.
This is the dashboard: what each trade put aside, what it adds up to, and the
wallet activity behind it.

**Two surfaces.** The dashboard at `/` is still **mock data** (one deterministic
object in `src/mocks`, the contract in `src/mocks/types.ts`). `/wallets` is **real**:
sign in with the pension key through Privy, create the vault, create / import /
export trading wallets, link them with the two-signature flow, set each wallet's
rate, and read what `@sip/worker` has put aside, collected and still owes per
wallet.

## Quick start

```bash
pnpm install                              # from the repo root
pnpm --dir packages/website-oficial dev   # http://localhost:3002
```

The dashboard needs no environment. `/wallets` reads `PRIVY_APP_ID`, `PRIVY_SIGNER_ID`,
`PRIVY_POLICY_ID`, `NUVEM_RPC_URL`, `NUVEM_VAULT_FACTORY` (+ optional cross-check addresses,
`NUVEM_PUBLIC_RPC_URL`, `NUVEM_EXPLORER_URL`, `DATABASE_URL` for the skim status) — every
variable is documented in `.env.example`; a missing one renders a setup checklist, never a crash.

## Stack

Next 16 (App Router) · React 19 · TypeScript strict · Tailwind v4 · shadcn 4
(`radix-nova`, base color `neutral`, CSS variables) · `next-themes` (class
strategy, light / dark / system from the header) · `recharts`, only through
shadcn's `chart` component. Fonts are Geist for words and Geist Mono for every
number.

## The one screen

Three regions, borrowed from a reference layout and nothing else from it:

| Region                          | Component                         |
| ------------------------------- | --------------------------------- |
| Sidebar — what the wallet did   | `WalletActivity`                  |
| Strip — what each trade put aside | `SavingsStrip`                    |
| Narrow panel — the rule         | `SavingsRulePanel`                |
| Big panel — the pension         | `PensionPanel` (+ chart, stats, holdings) |
| Top bar                         | `SiteHeader`                      |

Below `lg` the sidebar disappears and the header opens the same component in a
sheet.

```
src/app/layout.tsx              fonts, ThemeProvider, TooltipProvider
src/app/page.tsx                reads the mock once; every component takes the slice it renders
src/app/api/health/route.ts     liveness for the Dockerfile's HEALTHCHECK
src/app/wallets/page.tsx        the real surface: pension key → vault → N trading wallets → skim status
src/app/providers.tsx           PrivyProvider (EVM only, chain 4663 by defineChain), wallet login, embedded wallets on demand
src/app/api/rpc/route.ts        allowlisted JSON-RPC relay for wallets to add chain 4663 (rate-limited; the key never reaches a browser)
src/app/api/create-vault/route.ts  preview (initData from the factory's own protocolConfiguration, CREATE2 prediction, named simulation) + receipt
src/app/api/vault/route.ts      vault of an admin and its trading accounts (from logs); activeVaultOf of an account
src/app/api/skims/route.ts      put aside / collected / pending per wallet from the worker's Postgres, or { source: "unavailable" }
src/lib/config.ts, chain.ts, abi.ts, vault.ts, serialize.ts, redact.ts   server-side reads (Read<T>), ABI fragments checked against the artifacts (pnpm check:abis), tagged-bigint JSON
src/lib/wallets/judge.ts, policy.ts   the pasted-key judge; the volume-mode policy (10/20/50 bps, caps UINT128_MAX)
src/components/wallets/*        WalletsScreen, TradingWalletsList/Row, Create/Import/Export/Link, RateControl, SeatStatus, CreateVaultCard, SkimStatus
src/mocks/types.ts              THE CONTRACT — what the backend will have to produce
src/mocks/data.ts               one deterministic instance: seeded, identical on server and client
src/lib/format.ts               every number and date on the page (UTC, en-US, on purpose)
src/components/site-header.tsx, wallet-menu.tsx
src/components/wallet-activity.tsx, activity-row.tsx, copy-button.tsx
src/components/savings-strip.tsx, strip-chip.tsx
src/components/savings-rule-panel.tsx
src/components/pension-panel.tsx, pension-chart.tsx, pension-stats.tsx, pension-holdings.tsx
src/components/mode-toggle.tsx, theme-provider.tsx
src/components/ui/*             shadcn, generated — add with `pnpm dlx shadcn@4 add <name>`, never edit by hand
```

## Rules the code follows

- **Deterministic rendering.** No `Date.now()`, `Math.random()` or `toLocale*()`
  in anything that renders; "now" is data (`mock.now`), and dates format in UTC.
  That is what keeps server and client HTML identical.
- **Tokens only.** `background`, `foreground`, `muted`, `border`, `card`,
  `primary`, `destructive`. One accent — emerald — and it means exactly one
  thing: money put aside.
- **Vocabulary.** Orders are *bought* / *sold*; the slice is *put aside*; the
  pension *invests* when the pile reaches the threshold. Nothing is a profit, a
  win or a loss — the rule never looks.
- **Every number is `font-mono tabular-nums`.**
- **Server components by default.** `"use client"` only where there is state,
  an effect, a handler or a chart.

## Verify

```bash
pnpm --dir packages/website-oficial check:abis   # 69 ABI fragments against @nuvem/contracts-artifacts (also runs as prebuild)
pnpm --dir packages/website-oficial typecheck
pnpm --dir packages/website-oficial build
```

Privy must run the app in **TEE mode** for wallet seats to attach on create/import; the pension key
can never be a trading wallet (the factory forbids it), and one imported wallet per user is a Privy
limit.

`security-headers.mjs` sends a same-origin CSP on every response;
`'unsafe-eval'` is granted in development only, for React's debugging overlay.

## Deployment

`Dockerfile` (root context) still builds this package — its filter is `@sip/web`
— but it still provisions the sibling workspace packages the old dashboard
needed and this one does not. Trim it when the backend's shape is known.
