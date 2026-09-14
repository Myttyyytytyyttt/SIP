# Web wave 2 — wallets: pension key, vault, N trading wallets, skim status

**Where:** `packages/website-oficial` (`@sip/web`, Next 16 App Router, shadcn 4 `radix-nova`, Tailwind v4).
The dashboard at `/` stays on mock data. This wave adds the first REAL surfaces under `/wallets`, wired to
Privy and to Robinhood Chain 4663, and the read-only skim status fed by `@sip/worker`'s ledger.

Read first: `reports/SIP_BACKEND_ASSESSMENT_2026-09-07.md` §4.3, §4.5 and Annex D (claims 2 and 4) — the
product rules below come from there. The old site's Privy code is the quarry: read it with
`git -C /Users/walch/ProyectosCT/SIP show HEAD:packages/website-oficial/src/<path>` (HEAD = `fd927b0`;
the working tree no longer contains it). Port with a one-line attribution comment; never import from it.

## 0. Non-negotiables

1. **Server-side RPC only.** `NUVEM_RPC_URL` carries a key and is read at request time inside route
   handlers (`export const dynamic = "force-dynamic"`), never in a client bundle, never `NEXT_PUBLIC_*`.
   The browser sees only `PublicConfig`. Wallet chain definition uses `walletRpcUrl` (the `/api/rpc`
   allowlist relay by default).
2. **`Read<T> = {ok, value} | {ok: false, error}` everywhere** a chain read can fail; a failed read renders
   as "unknown", never as zero or "not linked". Errors that can reach a browser go through a redactor
   that strips anything URL- or key-shaped.
3. **Hydration.** Server components render nothing that depends on Privy or wallet state. Client
   components gate on `ready` from `usePrivy()` and render a skeleton until then. No `Date.now()`,
   `Math.random()` or `toLocale*()` during render; use `src/lib/format.ts`.
4. **Stock shadcn, tokens only, the vocabulary of the dashboard** (put aside / saved · invested ·
   bought/sold for orders; "pension key" for the vault admin, "trading wallet" for a bound account;
   never "vault admin" in copy — say "pension key"). Every number `font-mono tabular-nums` via
   `<Num>` / `MONO` from `@/lib/classes`. Labels via `LABEL`.
5. **Privy facts to honour** (Annex D, claim 2): create trading wallets *born seated* —
   `createWallet({ createAdditional: true when the user already has one, signers: [{ signerId, policyIds:
   [policyId] }] })`; NEVER an empty `policyIds` (Privy reads it as full permission); import with
   `importWallet({ privateKey, additionalSigners: [{ signerId, policyIds }] })` — only valid in TEE mode,
   so the page must surface a clear error if the app is not TEE-enabled; read the seat from the wallet's
   `delegated` flag on the Privy user object every time, never from local state; export via
   `useExportWallet().exportWallet({ address })` (Privy's own dialog — never render a key in our DOM);
   one imported wallet per user (SDK limit): show that message on the second import; `addSigners` with
   the HEAD backoff `[1,2,4,6,8,10] s` and one `refreshUser` on the first attempt when a wallet reports
   no seat.
6. **Volume-mode policy values** (this replaces HEAD's profit presets): rate presets 10 / 20 / 50 bps
   shown as 0.1 % / 0.2 % / 0.5 % (default 20); `minContributionWei = 1e12`; `maxPerSettlementWei =
   maxRolling30dWei = UINT128_MAX`; `tradingFloorWei = 1e15` (0.001 ETH); `gasReserveWei = 5e14`;
   `platformId = keccak256("sip")`; vault aggregate cap at creation = **`UINT128_MAX`** (HEAD's 1e18 default
   would block skims after 1 ETH per month — do not port it).
7. **Own your files only.** Owners and files are listed in §2. Shared modules others depend on
   (`src/lib/config.ts`, `src/lib/abi.ts`, `src/lib/vault.ts`, `src/lib/serialize.ts`, `src/lib/chain.ts`)
   are W1's; their exported names are fixed in §3 so W2–W4 can code against them before they exist.
   Do not run the dev server or `next build` (the orchestrator does); verify with:
   ```
   export PATH="$HOME/.nvm/versions/node/v22.14.0/bin:$PATH"
   cd /Users/walch/ProyectosCT/SIP/packages/website-oficial && ./node_modules/.bin/tsc -p tsconfig.json --noEmit --incremental false
   ```
   Other owners' files may be mid-edit; wait ~20 s and re-run; only errors in your files block you.
8. Do not touch `src/mocks`, `src/components/ui`, the dashboard components, `packages/*-old`, or
   `/Users/walch/ProyectosCT/Nuvem`. Deps already present: `@privy-io/react-auth` 3.36.0, `viem` 2.55.8,
   `pg`; add nothing.

## 1. Environment (already in the package's `.env.local`; names unchanged from HEAD)

`PRIVY_APP_ID` (25 chars), `PRIVY_SIGNER_ID`, `PRIVY_POLICY_ID`, `PRIVY_APP_SECRET` (server only, only the
skims/seat routes), `NUVEM_RPC_URL` (privileged), `NUVEM_PUBLIC_RPC_URL` (optional key-free; when absent
the relay is on), `NUVEM_VAULT_FACTORY` (required, no default), `NUVEM_SETTLEMENT_EXECUTOR`,
`NUVEM_WETH`, `NUVEM_PAUSE_CONTROLLER`, `NUVEM_ATTESTER_REGISTRY` (cross-check only; the factory's
`protocolConfiguration()` is the truth), `NUVEM_CHAIN_ID` (4663), `NUVEM_LOGS_FROM_BLOCK`,
`NUVEM_COHORT_ID` (default 1), `NUVEM_EXPLORER_URL` (optional), `DATABASE_URL` (optional; the worker's
Postgres for `/api/skims`). Accept `SIP_*` spellings as aliases of the `NUVEM_*` ones.

## 2. Owners

### W1 · foundation — `src/lib/config.ts`, `src/lib/chain.ts`, `src/lib/abi.ts`, `src/lib/vault.ts`, `src/lib/serialize.ts`, `src/lib/redact.ts`, `src/app/providers.tsx`, `src/app/api/rpc/route.ts`, `src/app/api/create-vault/route.ts`, `src/app/api/vault/route.ts`, `security-headers.mjs`, `.env.example`
Port from HEAD: `src/lib/addresses.ts` + `src/lib/config.ts` → one `config.ts` (EVM only; drop every
Solana/basket/stock field; keep the "collect every problem into a checklist" shape and the
`PRIVY_APP_ID` length check); `src/lib/chain.ts` (defineChain 4663, no multicall3); `src/lib/abi.ts`
narrow `as const` fragments for exactly the functions in §3; `src/lib/vault.ts` reads; `serialize.ts`
(tagged bigint JSON); `providers.tsx` EVM-only (`loginMethods: ["wallet"]`, `embeddedWallets.ethereum.
createOnLogin: "off"`, `defaultChain`/`supportedChains` = the 4663 chain, `walletList` with
`detected_ethereum_wallets` first, `appearance.loginMessage` rewritten for SIP: "SIP is permissionless.
Only your pension key can withdraw — the team has no access to your funds."); `api/rpc/route.ts`
relay (allowlist, body cap, batch cap, timeout, off-switch) with an in-memory per-IP token bucket added
(60 req/min); `api/create-vault/route.ts` verbatim contract (preview/receipt) with `capWei` defaulting to
`UINT128_MAX`; NEW `api/vault/route.ts` (§3); `security-headers.mjs`: restore HEAD's Privy entries
(`auth.privy.io` in child/frame-src, `https://*.rpc.privy.systems` and `auth.privy.io` in connect-src,
`explorer-api.walletconnect.com` in img-src) — read HEAD's file for the exact list and the reasons.

### W2 · wallets UI — `src/app/wallets/page.tsx`, `src/app/wallets/loading.tsx`, `src/components/wallets/WalletsScreen.tsx`, `TradingWalletsList.tsx`, `TradingWalletRow.tsx`, `CreateWalletButton.tsx`, `ImportWalletDialog.tsx`, `ExportWalletButton.tsx`, `LinkWalletDialog.tsx`, `RateControl.tsx`, `SeatStatus.tsx`, `src/lib/wallets/judge.ts`, `src/lib/wallets/policy.ts`, and the one-line change in `src/components/wallet-activity.tsx` pointing "Manage wallets" at `/wallets`
`page.tsx` is a server component: `loadConfig()` → if problems, render the setup checklist; else
`<Providers config={public}><WalletsScreen config={public} /></Providers>`. `WalletsScreen` (client):
`usePrivy()` gate → "Connect your pension key" (`login()`), then the admin address = the wallet the
user logged in with (`user.wallet` / first `wallets` entry with `walletClientType !== "privy"`); fetch
`/api/vault?admin=` → no vault: render W3's `<CreateVaultCard>`; vault: header card (vault address,
copy, explorer link) + `<TradingWalletsList>` + W4's `<SkimStatus>`. `TradingWalletsList`: union of
Privy embedded/imported wallets (`useWallets()` filtered to `walletClientType === "privy"`) and the
vault's accounts from `/api/vault` — one row per address with: address, origin (created / imported /
external), seat (`delegated` flag → "Authorised" / "Not authorised" + re-authorise), link status
(PENDING / ACTIVE / PAUSED / REVOKED / not linked), rate (`RateControl`: ToggleGroup 0.1/0.2/0.5 % →
`setMySavingsBps` signed by that trading wallet, or `setTradingAccountPolicy` by the admin when the
trading wallet cannot sign), actions: Link (→ `LinkWalletDialog`), Export, Revoke (self-revoke by the
trading wallet). `CreateWalletButton`: born-seated per §0.5. `ImportWalletDialog`: `judgePastedKey`
(port verbatim into `src/lib/wallets/judge.ts` with its comments), address preview, preflights —
pasted key == admin → refuse; `/api/vault?account=` says linked elsewhere → refuse; key cleared from
state on every exit; second import → the one-imported-wallet message. `LinkWalletDialog`: the two-signature
flow from HEAD `InviteTradingWallet.tsx` `link()` (admin `inviteTradingAccount` with §0.6 policy →
read back `vaultId`/`getTradingAccount` → trading wallet signs `AcceptTradingAccount` EIP-712 (domain
`Nuvem Personal Vault` / `1` / 4663 / vault) → admin `acceptTradingAccountBySig`), with the chain-switch
dance and the "1 of 2 / 2 of 2" copy; `src/lib/wallets/policy.ts` holds §0.6's constants and
`ACCEPT_TYPES`. Every action shows named revert reasons (from the RPC error's second line).

### W3 · vault — `src/components/wallets/CreateVaultCard.tsx`, `src/components/wallets/useCreateVault.ts`
Port HEAD `CreateVaultCard.tsx` into shadcn: label input (default "SIP pension"), preview via
`POST /api/create-vault {action:"preview", owner, label, capWei: UINT128_MAX}` → show predicted
address + simulation verdict by name → sign `VaultFactory.createVault(userSalt, cohortId, initData)`
with the admin wallet (viem `createWalletClient` over `wallet.getEthereumProvider()`, after
`switchChain(4663)`) → `POST {action:"receipt", hash}` poll → `onCreated(vault)`. Props:
`{ admin: Address; config: PublicConfig; wallet: ConnectedWallet | null; onCreated: (vault: Address) => void }`.

### W4 · skim status — `src/app/api/skims/route.ts`, `src/components/wallets/SkimStatus.tsx`, `src/lib/skims.ts`
`GET /api/skims?vault=0x…` reads the worker's tables (`packages/worker/src/ledger/schema.ts` is the
truth; if it is still a stub when you start, code against `packages/worker/DESIGN.md` §2 "ledger":
`sip_wallet(address, vault, cursor_l2, owed_total_wei, collected_total_wei)`, `sip_window(id, wallet,
vault, start_l2, end_l2, batch_root, sum_notional_wei, owed_wei, status, detail)`, `sip_pull(window_id,
tx_hash, nonce, contribution_wei, outcome, detail)`) with `pg` and `DATABASE_URL` (pool max 3, 5 s
connect timeout); response per wallet: `{ address, owedTotalWei, collectedTotalWei, pendingWei,
lastWindow: {endL2, sumNotionalWei, status} | null, lastPull: {txHash, contributionWei, at} | null }`
as tagged-bigint JSON via W1's `serialize.ts`; without `DATABASE_URL` or on any DB error respond
`{ source: "unavailable", reason }` with 200 — the page must not break. `SkimStatus({ vault, wallets:
readonly Address[] })`: a compact table "Put aside · Collected · Pending" per wallet with the
best-effort copy from the assessment ("collected when the wallet holds ETH; the rest carries forward"),
a muted "Status unavailable" state, and a "last pull" line with tx link.

## 3. Contracts between owners (fixed)

```ts
// src/lib/config.ts
export interface PublicConfig { privyAppId; privyClientId: string|null; privySignerId; privyPolicyId; walletRpcUrl; explorerUrl: string|null; factory: Address; cohortId: bigint; chainId: 4663 }
export interface ServerConfig extends PublicConfig { rpcUrl; logsFromBlock: bigint; rpcProxyDisabled: boolean; rpcRelayInUse: boolean; databaseUrl: string|null; expected: {...|null} }
export function loadConfig(env = process.env): { ok: true; config: ServerConfig } | { ok: false; problems: ConfigProblem[] }
export function toPublicConfig(c: ServerConfig): PublicConfig
export const UINT128_MAX: bigint
// src/lib/chain.ts
export const ROBINHOOD_CHAIN_ID = 4663; export function robinhoodChain(walletRpcUrl: string): Chain
// src/lib/abi.ts — as-const fragments: vaultFactoryAbi (createVault, predictVault, vaultOfAdmin, activeVaultOf, protocolConfiguration, cohorts), personalVaultAbi (vaultId, inviteTradingAccount, acceptTradingAccountBySig, getTradingAccount, setMySavingsBps, setTradingAccountPolicy, revokeMyTradingAccount, activeTradingAccountCount), vaultInitializationParam
// src/lib/vault.ts (server only)
export type Read<T> = { ok: true; value: T } | { ok: false; error: string }
export function createReadClient(config: ServerConfig): PublicClient
export async function readProtocol(client, config): Promise<{ configuration: Read<{weth; pauseController; attesterRegistry; settlementExecutor}> }>
export async function readCohort(client, config, id): Promise<Read<{ registered: boolean; beacon: Address }>>
export async function predictVault(client, config, owner, userSalt, cohortId, initData): Promise<Read<{ vaultId: Hex; predicted: Address }>>
export async function vaultOfAdmin(client, config, admin): Promise<Read<Address | null>>
export async function activeVaultOf(client, config, account): Promise<Read<Address | null>>
export async function readTradingAccount(client, vault, account): Promise<Read<TradingAccountView>>   // status, savingsBps, inviteNonce, inviteAdminEpoch, inviteDeadline, policy
export async function listTradingAccounts(client, config, vault): Promise<Read<readonly Address[]>>  // from TradingAccountInvited/Activated/Revoked logs since logsFromBlock, deduplicated
// src/lib/serialize.ts
export function jsonResponse(body: unknown, status = 200): Response   // bigint -> {"$bigint":"123"}
export function parseTagged<T>(text: string): T
// GET /api/vault?admin=0x…  -> { vault: Address|null, cohortId, accounts: { address, status: "PENDING"|"ACTIVE"|"PAUSED"|"REVOKED", savingsBps, inviteDeadline, inviteNonce, inviteAdminEpoch }[] }
// GET /api/vault?account=0x… -> { activeVaultOf: Address|null }
// POST /api/create-vault -> HEAD's CreateVaultPreview / ReceiptState (port src/lib/api-types.ts into vault.ts or a new api-types.ts owned by W1)
```

## 4. Verification the orchestrator runs after the wave
`tsc` clean; `next build` clean; headless Chrome: `/wallets` renders the pension-key gate with zero console
errors and no hydration warnings (Privy app id present in `.env.local`); `/` unchanged.

## 5. Report
`filesWritten`, `typecheckPassed`, `deviations`, `needs`, `summary`.
