# Runbook: setting SIP up from scratch

From a bare machine to a checkout where the tests pass, the site runs and the
worker completes a pass. It takes about ten minutes, and none of it needs a
credential.

What it will **not** give you is a working product. **No deployment exists.**
The contracts are written and tested but not on chain anywhere, so the site can
show its setup checklist and the worker can refuse to start, and that is as far
as a fresh clone goes. Section 6 says exactly where the wall is and why it was
put there deliberately.

---

## 1. What is in the repository

Four packages, and only four.

| Package | Name | What it is |
| --- | --- | --- |
| `packages/contracts` | `@nuvem/contracts` | The vault system, plus `SipVolumeExecutor` — the executor that settles against a volume rather than a profit. Solidity, Foundry. |
| `packages/contracts-artifacts` | `@nuvem/contracts-artifacts` | The compiled ABIs, exported as an ES module. Its `dist/` is **committed**, which is what lets the other two build with no Solidity toolchain. |
| `packages/worker` | `@sip/worker` | The observer, the attester and the puller. Watches every buy and sell a bound trading wallet makes anywhere on chain 4663, attests the volume, and pulls the skim through the wallet's Privy seat. Dry run by default. |
| `packages/website-oficial` | `@sip/web` | The dashboard and `/wallets`: create a vault, bind a trading wallet, see what each trade put aside. |

The product itself, so the variable names below read as something rather than as
trivia: a slice of the **size** of every buy and every sell — basis points of
notional, 20 by default, which is 0.2% — goes aside the moment the order fills
and is invested in the assets the user chose. Not a slice of profit. The trading
wallet has to keep working anywhere the user already trades, which is why the
skim is *observed on chain after the fill* and *pulled afterwards*, rather than
taken by a contract that sits in the trade path.

---

## 2. Prerequisites

| Tool | Version | Needed for |
| --- | --- | --- |
| Node | **22.14.0** exactly | everything. Pinned twice, in `.nvmrc` and in `package.json` `engines`. |
| pnpm | **10.18.1** | pinned in `package.json` `packageManager`; `corepack enable` picks that up on its own. |
| Foundry | forge **1.5.1** | the contracts, and the root `pnpm build` / `pnpm test`. See below. |
| Docker | any recent | only for the container path — see [DEPLOYMENT_WEB.md](DEPLOYMENT_WEB.md). |

```bash
nvm install    # reads .nvmrc
corepack enable
```

### When you actually need Foundry

`packages/contracts-artifacts/dist/` is committed — a deliberate exception in
`.gitignore` — so **the site and the worker build and run from a fresh clone
with no Solidity toolchain at all.**

Foundry is needed for three things:

- `forge test` and any change to a contract;
- the **root** `pnpm build` and `pnpm test`, whose first step is `forge build` /
  `forge test`. Use `pnpm test:worker` instead if you have no forge;
- `pnpm --dir packages/contracts-artifacts test:from-out`, which re-exports from
  `packages/contracts/out/`. That directory is gitignored, so it does not exist
  until `forge build` has run on this machine.

Foundry also needs the `forge-std` submodule, which a plain `git clone` leaves
empty:

```bash
git submodule update --init --recursive
```

---

## 3. Clone and install

```bash
git clone https://github.com/Myttyyytytyyttt/SIP.git
cd SIP
corepack enable
pnpm install --frozen-lockfile
```

`--frozen-lockfile` matters: it fails rather than quietly resolving different
versions. `@privy-io/react-auth` pins viem to an exact patch, and a drifting
install turns that into peer warnings which are easy to scroll past and are
occasionally not warnings.

Everything that needs no credential already works:

```bash
pnpm test:worker                                   # 511 tests, no network
pnpm --dir packages/website-oficial check:abis     # 69 fragment comparisons
```

---

## 4. Where each variable lives

Three example files, one per thing you can run. Copy the one you need; each
carries its own reasoning inline, so read it rather than only diffing it.

| Example | Copy to | Read by |
| --- | --- | --- |
| `.env.example` | `.env` | the chain both services agree on, and the contract deploy |
| `packages/worker/.env.example` | `packages/worker/.env` | `@sip/worker` |
| `packages/website-oficial/.env.example` | `packages/website-oficial/.env.local` | `@sip/web` |

**Root `.env`** holds only what is shared plus `DEPLOYER_PRIVATE_KEY`: the RPC
URL, the chain id, the factory, the executor and the first block worth scanning.
The deploy script reads that key in plaintext from the environment — signer
handling for a real deployment is not hardened yet; see
[DEPLOYMENT.md](DEPLOYMENT.md).

**The worker** needs `SIP_RPC_URLS`, `SIP_CHAIN_ID`, `SIP_VAULT_FACTORY`,
`SIP_SETTLEMENT_EXECUTOR` and `SIP_LOGS_FROM_BLOCK` to start at all, and nothing
else for a dry run. `DATABASE_URL` (Postgres) is what makes a pass remember what
it did; a live worker cannot run without it. The signing secrets —
`SIP_ATTESTER_PRIVATE_KEY`, `PRIVY_APP_SECRET`,
`PRIVY_AUTHORIZATION_PRIVATE_KEY` — are read **only** in live mode. In dry run
the process deletes those variables by name without ever reading their values,
so a dry run cannot pull because nothing in the process could sign one.

**The site** needs `PRIVY_APP_ID`, `NUVEM_RPC_URL` and `NUVEM_VAULT_FACTORY`.
Everything else is optional or cross-check only: the executor, WETH, the pause
controller and the attester registry are all read from
`VaultFactory.protocolConfiguration()` at runtime, so setting them buys you a
"your environment disagrees with the chain" warning and nothing more. Every
`NUVEM_*` name also accepts a `SIP_*` spelling; the aliases are listed against
each variable in the example file.

### Loading them

`next dev` loads `.env.local` by itself. **The worker does not load any file** —
it reads the process environment and nothing else:

```bash
cd packages/worker && set -a && . ./.env && set +a
```

Never put a secret behind a `NEXT_PUBLIC_` prefix: Next inlines those into the
browser bundle at build time. The site is built to need none — the RPC URL stays
server-side and the browser reaches the chain through the app's own `/api/rpc`
relay.

---

## 5. Running things

```bash
pnpm dev          # the site on http://localhost:3002  (the port is not 3000)
pnpm tick         # one worker pass: prints a TickSummary as JSON and exits
pnpm test         # contracts (forge) + artifacts + worker
pnpm typecheck    # worker and site
```

More precisely:

| Command | What it does |
| --- | --- |
| `pnpm test:worker` | 511 tests, offline, no Foundry. The fast loop. |
| `pnpm --dir packages/contracts test` | 425 tests across 34 suites. Needs forge and the submodule. |
| `pnpm --dir packages/website-oficial verify` | ABI check, then typecheck, then a real `next build`. |
| `pnpm --dir packages/worker worker` | the loop rather than a single pass, every `SIP_POLL_MS` (default five minutes). |
| `node packages/contracts-artifacts/scripts/check-dist-fresh.mjs` | proves the committed ABIs still match the Solidity. |

Two of those deserve a warning about silence:

- `check-dist-fresh.mjs` **skips when forge is absent**, and a skip is not a
  pass. On a machine without Foundry the committed ABIs are simply not being
  checked; run `forge build` first so it has `packages/contracts/out/` to compare
  against.
- The site's `check:abis` is the opposite — it is hard, offline and always runs,
  because a stale fragment means the page decodes vault state with the wrong ABI
  and reports a wrong savings rate rather than crashing.

`pnpm tick` against a real RPC with no deployment configured stops at
configuration, which is section 6. Against a configured deployment, a dry-run
pass does everything except sign and send: it discovers linked wallets from the
factory's logs, reconstructs each fill, closes a window behind the finality
margin, builds the attestation against live vault state, and logs the pull it
*would* make with its amounts.

---

## 6. What you cannot do yet

**Nothing is deployed.** There is no factory and no executor on chain 4663 for
this product, so there is no vault to create, no wallet to bind and nothing for
the worker to observe.

The wall is deliberate, and it is worth understanding before you route around
it. Its shape:

- `packages/worker/src/config.ts` **requires** `SIP_VAULT_FACTORY`,
  `SIP_SETTLEMENT_EXECUTOR` and `SIP_LOGS_FROM_BLOCK`. There is no fallback. A
  missing one is a refusal to start with a sentence explaining it.
- `packages/worker/src/chain/constants.ts` pins **chain facts only** — WETH, the
  GMGN router, the v4 PoolManager, the log topics. No deployment.
- The site has no default factory either. Without `NUVEM_VAULT_FACTORY`,
  `/wallets` renders a setup checklist instead of a vault.

### Why no address was left in as a convenience

An earlier deployment exists on chain 4663 and it must **not** be pointed at.
Its trading accounts were read from chain on 2026-09-08: all eighteen are active
with a savings rate between 1000 and 3000 bps, and on that deployment the rate
means a **percentage of profit**. Phase 0 applies the same rate to the
attestation's cash field, which in this product carries a **volume**. Aiming a
worker at it would therefore skim twenty to thirty percent of notional instead
of twenty basis points — about a hundred times what a user agreed to, on
somebody else's wallet. That is why the defaults were removed rather than
updated, and why a startup refusal was chosen over a value that happens to point
somewhere real.

Deploy fresh, put the new addresses in the three env files, and update the Privy
policy (below) to the new executor.

---

## 7. Infrastructure that does exist

**RPC.** Alchemy Pay-As-You-Go on Robinhood Chain 4663, archive access
confirmed. The tier is not a preference: the free tier caps `eth_getLogs` at ten
blocks, which makes wallet discovery impossible, and Robinhood's own public RPC
is pruned at roughly ten thousand blocks while the reconciler reads balances at
the block *before* a fill. The worker detects both and refuses to report a scan
that did not happen rather than advancing its cursor over the gap. Put the
public endpoint second in `SIP_RPC_URLS` as a read fallback, never first.

**Privy.** An app exists, in TEE mode, with:

- key quorum `zdhe35f97hmzxes5iuzga7d0` — the seat, which goes in
  `PRIVY_SIGNER_ID`;
- policy `nxakvhwt6dctmvorrfp4xlk9` — which goes in `PRIVY_POLICY_ID`. It ALLOWs
  `settle`, sign and send, **to the executor's address only**; ALLOWs `invest`
  with value 0; and DENIES `exportPrivateKey` and `exportSeedPhrase`.

Both or neither: a signer with no policy is full permission at Privy, so the
site refuses half a pair as a configuration problem rather than letting it
degrade quietly.

**The policy pins the Phase 0 executor's address, so a new deployment needs the
policy updated to the new address before any pull can succeed.** The scripts
that created and updated it were deleted with the old backend; do it in the
Privy dashboard, or through Privy's API, against policy
`nxakvhwt6dctmvorrfp4xlk9`.

**Postgres.** The worker's ledger and the site's `/api/skims` read the same
database through `DATABASE_URL`. It is optional for the site — without it the
skim figures render "Status unavailable" and nothing else changes — and
mandatory for a live worker, which must remember what it sent.

---

## 8. Things that will confuse you at 2am

- **The site is on port 3002**, not 3000. Privy will not infer a port, so the
  allowed-origins list needs `http://localhost:3002` written out in full.
- **Two addresses, two roles.** The vault admin owns the savings; the trading
  account is the one that trades. One address cannot be both. Connecting with
  the trading account shows no vault, and that is correct.
- **Two block clocks.** Solidity's `block.number` on chain 4663 is the **L1**
  block number and sits millions above the L2 number, by a gap that is not
  constant. Never store an offset; read `l1BlockNumber` off the L2 block, which
  is what `packages/worker/src/chain/reads.ts` does.
- **The worker is dry run by default, and structurally so.**
  `SIP_WORKER_ALLOW_BROADCAST` must equal `i-understand-this-moves-real-funds`
  byte for byte — `true`, `1`, or the same sentence with a trailing newline all
  keep you in dry run, on purpose, because those are what a human types when
  they mean the opposite.
- **A refusal never echoes a value.** The worker names the variable and
  describes the *shape* of what it read — length and character class — because
  config validation runs before the logger exists and container logs get pasted
  into bug reports. If it tells you a variable holds something shaped like a
  private key, treat that key as exposed and rotate it.
