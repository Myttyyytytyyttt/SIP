# Runbook: setting up Nuvem on another machine

Everything needed to go from a bare machine to a working checkout. Written for
moving between a desktop and a laptop, so it assumes you own both and can carry a
passphrase between them out of band.

The short version: `git clone` gives you all the code and none of the credentials,
because sixteen private keys are deliberately excluded from version control.
Section 3 is the part that actually needs doing.

---

## 1. Prerequisites

| Tool | Version | Needed for |
| --- | --- | --- |
| Node | **22.14.0** exactly | everything. Pinned in `package.json` `engines`. `node:sqlite`, which the keeper's store depends on, is a Node 22 built-in. |
| pnpm | **10.18.1** | pinned in `package.json` `packageManager`. `corepack enable` picks it up automatically. |
| Foundry | forge 1.5.1 | **only if you touch Solidity.** See below. |
| Docker | any recent | only for the container path |
| Git Bash / WSL | — | Windows only. `scripts/secrets-bundle.sh` is a shell script. |

### You probably do not need Foundry

`packages/contracts-artifacts/dist/` is **committed** — an exception carved into
`.gitignore` on purpose, because Railway builds from git and the container has no
Foundry. So the dashboard, the keeper and the session engine all build and run
from a fresh clone with no Solidity toolchain at all.

You need Foundry only to run `forge test` or to change a contract. If you do
install it, `packages/contracts-artifacts/scripts/check-dist-fresh.mjs` will start
verifying that the committed ABIs still match the Solidity — it silently skips
when forge is absent, so a machine without Foundry is not silently trusting stale
artifacts, it simply is not checking.

---

## 2. Clone and install

```bash
git clone https://github.com/Myttyyytytyyttt/Nuvem.git
cd Nuvem
corepack enable
pnpm install --frozen-lockfile
```

`--frozen-lockfile` matters: it fails rather than silently resolving different
versions. `@privy-io/react-auth` pins viem to an exact patch, so a drifting
install produces peer warnings that are easy to ignore and occasionally are not
warnings.

At this point everything that does not need a credential already works:

```bash
pnpm --dir packages/session-engine-old test     # 46, fully offline against a fixture
pnpm --dir packages/keeper-old test             # 242, offline
pnpm --dir packages/contracts-artifacts test
```

---

## 3. Credentials

**Nothing in section 2 gave you a single key.** Four files are gitignored and hold
sixteen secrets between them. Without them you cannot deploy, attest, or start the
dashboard.

### The four files

| File | Secrets | Without it |
| --- | --- | --- |
| `.env` | 8 | no deploys, no aa-smoke, no RPC |
| `.env.mainnet` | 9 | no mainnet deploy, no Safe operations |
| `packages/web/.env.local` | 2 | dashboard shows a setup checklist instead of a vault |
| `.env.docker` | 1 | `docker compose` refuses to start |

### Option A — the encrypted bundle (syncs through git)

```bash
# on the machine that has the files
./scripts/secrets-bundle.sh seal      # -> secrets.enc
git add secrets.enc && git commit -m "Update the sealed credential bundle"
git push

# on the other machine
git pull
./scripts/secrets-bundle.sh open      # -> the four files, mode 0600
```

`secrets.enc` is AES-256 with 600k PBKDF2 iterations. The passphrase travels by
password manager — one string instead of sixteen keys — and never through git,
chat or email.

Understand the trade before choosing this. **The ciphertext is permanent once
committed.** Its entire security is the passphrase, so if that passphrase ever
leaks, every bundle ever pushed becomes readable and you must treat it as key
compromise and rotate. Use a long random passphrase, not one you invent.

`./scripts/secrets-bundle.sh list` prints what a bundle contains without writing
anything to disk. Run it after sealing; a bundle nobody verified is a bundle that
might not open.

### Option B — copy the four files directly

USB stick, or your password manager's secure-file attachment. Slower to repeat,
but it leaves nothing permanent anywhere. If you are only moving once, this is the
better choice.

### What must never happen

Do not remove the `.env` rules from `.gitignore` to make syncing easier. Git
history is permanent: a key committed once survives in every clone, reflog and
fork, and a later commit removing it hides nothing. Undoing it means rewriting
history, force-pushing, and rotating every key anyway.

It matters more here than usual because `.env.mainnet` holds all five
`SAFE_OWNER_*_PRIVATE_KEY` values. A five-owner Safe exists precisely so that
compromising one owner is not enough; five keys in one commit makes it a 1-of-1,
permanently.

---

## 4. What goes where

Names only — no values. Use it as a checklist against a machine that is missing
something.

### `.env` — deployment, drills and AA tooling

**Secrets:** `DEPLOYER_PRIVATE_KEY`, `TRADING_OWNER_PRIVATE_KEY`,
`SESSION_KEY_PRIVATE_KEY`, `ALCHEMY_API_KEY`, and the five
`PUBLIC_TESTNET_DRILL_*_PRIVATE_KEY` drill keys.

**Not secret:** `RH_TESTNET_RPC_URL`, `RH_TESTNET_CHAIN_ID`, the protocol
addresses (`NUVEM_GUARDIAN`, `NUVEM_TREASURY`, `NUVEM_ATTESTER`,
`NUVEM_WETH_ADDRESS`, `NUVEM_CORPORATE_MULTISIG`, `NUVEM_TARGET_ASSET_ADDRESS`),
`NUVEM_INITIAL_FEE_BPS`, `NUVEM_CANARY_APPROVED`, `SETTLEMENT_EXECUTOR_ADDRESS`,
`SESSION_NATIVE_LIMIT_WEI`, `SESSION_ENTITY_ID`, `AA_SMOKE_ACTION`, the Alchemy
paymaster and gas-policy ids, and the ~25 `PUBLIC_TESTNET_DRILL_*` tuning numbers.

The mainnet RPC is **not** a variable here. It is built from `ALCHEMY_API_KEY`:
`https://robinhood-mainnet.g.alchemy.com/v2/<key>`. `RH_TESTNET_RPC_URL` is a
*testnet* endpoint and is not a substitute.

### `.env.mainnet` — nine private keys, nothing else

`NUVEM_VAULT_ADMIN_PRIVATE_KEY`, `NUVEM_ATTESTER_PRIVATE_KEY`,
`NUVEM_GUARDIAN_PRIVATE_KEY`, `NUVEM_TREASURY_PRIVATE_KEY`, and
`SAFE_OWNER_1..5_PRIVATE_KEY`.

The most sensitive file in the repository. The attester key signs the profit
measurement behind every settlement.

### `packages/web/.env.local` — the dashboard

**Server-only, never `NEXT_PUBLIC_`:** `PRIVY_APP_SECRET`, `RPC_URL`. `RPC_URL`
carries the Alchemy key, which is why contract reads go through the server and the
browser talks to `/api/rpc`.

**Public by design:** `NEXT_PUBLIC_PRIVY_APP_ID`,
`NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID`, `NEXT_PUBLIC_CHAIN_ID`,
`NEXT_PUBLIC_CHAIN_NAME`, and the deployed contract addresses.

Anything with a `NEXT_PUBLIC_` prefix is compiled into the browser bundle. Never
put a secret behind one.

### `.env.docker` — compose runtime

`NUVEM_RPC_URL` (secret — carries the Alchemy key), `PRIVY_APP_ID`,
`WALLETCONNECT_PROJECT_ID`, `WEB_PORT`.

Compose reads `env_file:` for the *container's* environment, but `${VAR:?}`
placeholders are *interpolation*, resolved at parse time from your shell. So a
bare `docker compose up` aborts even with the file present. Export once per shell:

```bash
export COMPOSE_ENV_FILES=.env.docker
```

---

## 5. Verify

```bash
pnpm --dir packages/contracts-artifacts test
pnpm --dir packages/session-engine-old test
pnpm --dir packages/keeper-old test
cd packages/web && RPC_URL="$(grep '^RPC_URL=' .env.local | cut -d= -f2-)" pnpm run verify
```

The last one matters: `verify`'s `check:chainguard` stage **self-skips when no RPC
URL is set**, and a skip is not a pass. Run it with the variable so it actually
reaches the chain and confirms both that a foreign chain is refused and that 4663
is readable.

With Foundry:

```bash
cd packages/contracts && forge build && forge test
node packages/contracts-artifacts/scripts/check-dist-fresh.mjs
```

`forge build` before the artifacts test, not just `forge test`. That test
re-exports from `packages/contracts/out/`, which is gitignored and therefore
absent on a fresh clone; without it the test skips and says so. A skip there is
correct and not a pass — it means the committed ABIs were not checked against the
Solidity on this machine.

Containers:

```bash
export COMPOSE_ENV_FILES=.env.docker
docker compose build web && docker compose up -d
curl -s http://localhost:3000/api/health
```

The keeper is behind a compose profile and does **not** start with a plain
`docker compose up`. That is deliberate: it is the only service that can move
money. See [ATTESTER.md](ATTESTER.md).

---

## 6. Things that will confuse you at 2am

- **Two addresses, two roles.** The vault admin owns the savings; the trading
  account is the one that trades and calls `settle`. The protocol forbids one
  address from being both. Connecting the dashboard with the trading account shows
  "no vault" and that is correct.
- **Two block clocks.** Solidity `block.number` on chain 4663 is the **L1** block
  number and sits millions above the L2 number, by a gap that is **not constant**.
  Never store an offset; read `l1BlockNumber` off the L2 block.
- **The keeper is dry-run by default.** Broadcasting needs both `--broadcast` and
  an environment acknowledgement. If a settlement is not happening, that is
  probably why, and it is working as intended.
- **Never `git add -A` right after `secrets-bundle.sh open`.** The four files are
  gitignored, and `open` prints a confirmation of that for each one. Read it.
