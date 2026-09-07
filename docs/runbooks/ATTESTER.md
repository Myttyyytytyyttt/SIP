# Runbook: running the attester / keeper (`@nuvem/keeper`)

The keeper watches a trading account, reconstructs each finished session with
`@nuvem/session-engine`, and — only when explicitly armed — signs a
`SettlementAttestation` and submits `settle()` so 20% of realized profit lands in
the vault.

**This is the only service in the repo that holds a signing key and the only one
that can move money.** Everything below is written on that assumption.

Files this runbook covers:

| Path | Purpose |
| --- | --- |
| `packages/keeper-old/Dockerfile` | Multi-stage image. Build context is the **repo root**. Non-root, `tini` as PID 1, dry-run by default. Carries four named build gates — `[engine-contract]`, `[engine-graph]`, `[no-state]`, `[preflight]` — described in section 2. |
| `docker-compose.yml` | The `keeper` service, in the `keeper` **profile**. Declares the `nuvem-keeper-state` named volume and mounts the attester key file. |
| `.dockerignore` | Repo root. Keeps `.env*` **and the keeper's settled-window store** out of the build context. |
| `.gitignore` | Repo root. `secrets/`, `packages/keeper-old/state/`, `packages/keeper-old/.keeper-state/`, `.keeper-state/`. |

Read `docs/runbooks/DEPLOYMENT_WEB.md` first if you have not deployed the
dashboard — the Foundry constraint, the `.dockerignore` reasoning and the
`COMPOSE_ENV_FILES` mechanics are shared and are not repeated here.

---

## 1. Key custody — read this before anything else

**v1 serves the operator's own wallet, and only the operator's own wallet.**

The service holds two private keys at runtime:

| Key | What it is | Why the service has it |
| --- | --- | --- |
| `NUVEM_ATTESTER_PRIVATE_KEY` | The registered attester. **Signs** the attestation. | The protocol's design: `AttesterRegistry` names one attester and `SettlementExecutor` verifies its EIP-712 signature. |
| `TRADING_OWNER_PRIVATE_KEY` | The **trading account's own** key. Sends the `settle()` transaction and pays the contribution. | `SettlementExecutor.settle` resolves the vault via `factory.activeVaultOf(msg.sender)` (`SettlementExecutor.sol:85`) and takes `msg.value` from the caller (`:99,:104`). **`msg.sender` must be the trading account itself.** The attester service cannot call `settle` — it can only sign. |

The second one is the whole story, so say it without hedging: **v1 holds the
operator's own trading private key, and holding that key is TOTAL CUSTODY of that
wallet.** Not scoped access to its profit, not permission to call one function —
custody. Whoever holds it can move every asset in the account, to anywhere, at
any time, with no further authorisation from anyone. The keeper only ever uses it
to call `settle`, but nothing about the key restricts it to that; the restriction
is a property of this code, not of the credential.

That is acceptable here for exactly one reason: **the wallet belongs to the
operator running the service.** The operator is handing their own key to their own
process on their own host, and the worst case is self-inflicted.

> **This is why Nuvem cannot serve third parties, and will not until the upgrade
> path below is real.** Onboarding another trader would mean holding their trading
> key — total custody of their whole wallet — in exchange for automating a 20%
> savings skim. That is not a trade anyone should accept, and it is not one we
> should offer. There is no configuration of this service that makes it safe: the
> limitation is the credential, not the settings.

### The upgrade path that removes this limitation — documented, not built

Not in this milestone. Do not half-build it.

1. The trader delegates their EOA to a smart-account implementation with
   **EIP-7702** (`packages/aa-smoke-old` already has the tooling).
2. The trader authorises a **session key** on that delegated account, scoped as
   narrowly as the account permits: the `settle` selector on the one executor
   address, a value ceiling, an expiry. Nothing else — no transfers, no
   approvals, no other target.
3. The keeper holds only that session key and submits `settle` as an
   **ERC-4337 `UserOperation`** through a bundler, so `msg.sender` is still the
   delegated trading account and the executor's `activeVaultOf(msg.sender)`
   lookup keeps working unchanged.
4. Worst case then bounds to "an attacker can trigger a settlement", not "an
   attacker can drain the wallet". That is the difference between a scoped
   permission and custody, and it is the precondition for a second user.

Until step 4 is real and tested, the answer to "can you run this for me?" is no.

### Key hygiene the container enforces

- **Never a build `ARG`.** `packages/keeper-old/Dockerfile` declares none, and
  `docker-compose.yml`'s `keeper.build` has no `args:` block. A build arg is
  recorded in image history — `docker history --no-trunc` and the config blob of
  any pushed image show it in plain text to anyone who can pull, and no later
  `RUN rm` removes it because it is metadata, not a file. The same applies to a
  populated `ENV`: the only key-shaped `ENV` lines in the image are **empty**
  defaults that exist to document the names.
- **A mounted file, not an environment variable — and it is now the default.**
  An env var is visible in `docker inspect`, in `/proc/1/environ` for the
  container's whole life, in `docker compose config`, and in your shell history.
  `docker-compose.yml` sets `NUVEM_ATTESTER_KEY_FILE=/run/secrets/attester.key`
  and mounts the file `:ro` **out of the box**. This used to be the commented-out
  alternative, which meant the copy-paste default was the leaky one; that is the
  wrong way round for the file operators copy without reading. The inline
  variable is now the commented alternative, for hosts that cannot mount a file
  (Railway — section 10). Create the host file before the first `up`:

  ```bash
  mkdir -p secrets && chmod 700 secrets      # secrets/ is gitignored
  install -m 400 /dev/null secrets/attester.key
  $EDITOR secrets/attester.key               # the 0x… key, trailing newline is fine
  ```

  If you skip this, the keeper **refuses to start** and names the path — verified
  against the image:

  ```
  Refusing to start. Configuration problems:
    - NUVEM_ATTESTER_KEY_FILE points at /run/secrets/attester.key, which could
      not be read: EISDIR: illegal operation on a directory, read
  ```

  (`EISDIR` because Docker Desktop substitutes an empty directory for a missing
  bind source. `create_host_path: false` on the mount stops a Linux engine doing
  the same; on Desktop it does not, which is why the refusal that matters is the
  keeper's own. Both were measured.)
- **Verify the build context has no keys and no ledger** after any
  `.dockerignore` change. Do not skip the second half: the `.dockerignore` rule
  for the state directory was **wrong for the entire life of this file** — it
  said `**/keeper-state` while the actual default directory is `.keeper-state`,
  with a leading dot — so any operator who had run the keeper on the build host
  baked their own realized-profit history into the image. It was invisible
  because a build-context filter fails silently.

  ```bash
  docker build --no-cache -f - . <<'EOF'
  FROM busybox
  COPY . /ctx
  RUN find /ctx -name '.env*' ! -name '.env.example' | grep . && exit 1 || echo "no keys"
  RUN find /ctx \( -name 'journal*' -o -name '*.jsonl' -o -name '*.sqlite*' \
                   -o -name '*.db' -o -name '*.db-*' -o -name 'keeper.lock' \) \
                -o -type d \( -name '.keeper-state' -o -name 'keeper-state' \) \
        | grep . && exit 1 || echo "no ledger"
  EOF
  ```

  Create `.keeper-state/` with a dummy file first, or the probe passes for the
  boring reason. The image build now asserts the same thing itself, at
  `[no-state]`, so a future regression is a failed build rather than a published
  journal — but the probe is what tells you about the *context*, which is larger
  than what the image copies.

- **What is scrubbed, and what is not.** Every log line goes through the
  redactor, including the top-level fatal handler and the `unhandledRejection` /
  `uncaughtException` handlers — so nothing can reach the terminal through node's
  own printer, which has never heard of the redactor. `GET /status` and
  `keeper status` do not pass through the logger at all, so upstream errors are
  summarized (error name plus first meaningful lines, viem's `URL:` /
  `Request body:` metadata dropped, endpoint host substituted) before they enter
  the payload, and the whole payload is scrubbed again on the way out. This
  matters because that endpoint is unauthenticated and a routine RPC 429 is enough
  to produce an error carrying the API key.
- **Never paste keeper logs into a ticket without reading them.** The keeper
  scrubs its own log sink, but `docker inspect` output is not scrubbed and
  `docker compose config` prints your resolved `NUVEM_RPC_URL` (which carries an
  Alchemy API key) to the terminal.

---

## 2. What the keeper must provide for this container setup to work

The image and the compose service assume the following contract with
`packages/keeper-old`. If any of it changes, change it here too.

1. **Entry point.** As committed, `packages/keeper-old/package.json` declares
   `"bin": { "nuvem-keeper": "./bin/keeper.mts" }`, so **`bin/keeper.mts` must
   exist.** The builder resolves the entry once — `bin`, then `main`, then a
   fixed list of `dist/bin/keeper.mjs`, `dist/bin/keeper.js`, `dist/keeper.mjs`,
   `dist/keeper.js`, `dist/src/keeper.js`, `bin/keeper.mjs`, `bin/keeper.js`,
   `bin/keeper.mts` — and generates `/app/keeper-start.sh`. It does not guess at
   runtime.

   A `.mts` entry is run with `node --import tsx`: an in-process loader, so there
   is no child process for SIGTERM to be forwarded through. That requires `tsx`
   as a dependency of `@nuvem/keeper` (it is, pinned 4.23.1) and it means the
   deploy tree keeps devDependencies. The package's `build` script is currently
   `tsc --noEmit`, a typecheck that emits nothing — the image runs it anyway,
   because tsx strips types without checking them and that typecheck is the only
   thing between a type error and a runtime crash in a service that signs
   transactions. Give the package an *emitting* build and everything adapts on
   its own: the entry resolves to compiled JS, the deploy tree is pruned with
   `--prod`, and tsx is no longer in the runtime image. That is the leaner and
   preferable end state.
2. **No arguments means dry run.** The image's `CMD` is empty. Broadcasting is
   opted into with the `--broadcast` argument.
3. **`NUVEM_KEEPER_ALLOW_BROADCAST` must be an exact-match sentinel**, the string
   `i-understand-this-moves-real-funds`. Not a truthy check: `1`, `true` and
   `yes` are what a copied config file and a stale shell export contain and must
   not arm anything.
4. **`GET /health`** on `NUVEM_KEEPER_HTTP_PORT` (default `8787`), making **no
   RPC call** and touching **no volume**. The image's `HEALTHCHECK` probes it
   with node's own `fetch`. It must return non-2xx **only** when the tick loop is
   wedged. Being halted, degraded, dry-run, or unable to reach the RPC must keep
   it green: restarting has never once fixed an upstream RPC, and a halted keeper
   has to stay up to explain itself.
5. **`GET /status`** on the same port — the operator view (section 7). Never put
   this in a health check.
6. **`SIGTERM` stops it cleanly**, finishing or safely abandoning the current
   cycle. `tini -g` signals the whole process group and compose allows 45s
   (`stop_grace_period`).
7. **All durable state under `NUVEM_KEEPER_STATE_DIR`**, which is the only
   writable path in the container (`read_only: true`, plus a 16 MB `/tmp`
   tmpfs). Logs go to **stdout**, never to the volume — the volume holds the
   settled-window store and nothing else. The image creates the directory
   `0700 keeper:nuvem`; the process runs as uid 1001. **Whatever the store is
   implemented as, it must live entirely inside that one directory** — no
   `/tmp` spill that matters, no dot-file in `$HOME` — because that directory is
   the only thing backed up and the only thing that survives a redeploy.
8. **`@nuvem/contracts-artifacts` for ABIs**, never `packages/contracts/out/` the
   way `packages/aa-smoke-old/scripts/settle.mjs:24-25` does. That directory is
   gitignored and excluded from the build context, so it does not exist in the
   image.
9. **`node:sqlite` needs no flag and no native build.** Confirmed on the pinned
   runtime, `node:22.14.0-bookworm-slim`: `require("node:sqlite")` and
   `new DatabaseSync(...)` work as-is; WAL mode, `BEGIN IMMEDIATE`/`ROLLBACK` and
   `UNIQUE` constraint enforcement all behave on the mounted volume with
   `read_only: true` set on the container. The only visible effect is one line on
   stderr per process:

   ```
   (node:1) ExperimentalWarning: SQLite is an experimental feature and might change at any time
   ```

   That line is expected, is not an error, and does not need suppressing. If you
   read a comment in `packages/keeper-old/src/ledger.ts` saying `node:sqlite` is
   "flag-gated on the pinned Node 22.14.0", it is stale — measured, it is not.

### The four build gates, and what each one is actually for

Every one of these exists because the thing it checks failed silently at least
once. If a build stops here, the message names the fix; the summary is so you
know which layer you are in.

| Gate | Stage | Proves |
| --- | --- | --- |
| `[engine-contract]` | builder, before deploy | `packages/session-engine-old/package.json` still declares **no `files` field**. `src/engine.ts` imports that package by path into its `src/`, and `pnpm deploy` honours `files`; adding one over there would break only the container, only at boot. |
| `[engine-graph]` | builder, after deploy | Every `../node_modules/@nuvem/…` specifier **in `src/engine.ts` itself** resolves to a real file in the pruned `/out` tree. The list is parsed out of that file, so it cannot drift from the imports. |
| `[no-state]` | builder, after deploy | No settled-window store — directory or file, JSONL or SQLite — is in the tree that becomes the image. |
| `[preflight]` | runner, as `USER keeper` | **The entry point actually runs in the finished image.** It invokes `/app/keeper-start.sh` with an unknown subcommand, which `bin/keeper.mts` rejects *after* every top-level import has resolved and *before* it reads any configuration — so it needs no RPC, no key and no volume, and it cannot settle anything. |

`[preflight]` replaced a `test -f` on
`node_modules/@nuvem/session-engine/dist/src/session.js`, which asserted the
presence of a path **the keeper does not load** — it loads that package's `src/`,
through tsx. Demonstrated: re-introduce a `../../session-engine/...` import (the
escape that once killed this image at boot) and `[engine-graph]` and every `test
-f` still pass, while `[preflight]` fails with the exact stderr the container
would have printed:

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/session-engine/src/inventory.js' imported from /app/src/engine.ts
```

---

## 3. Prerequisites

```bash
# The committed ABIs must be present — the build fails loudly without them.
ls packages/contracts-artifacts/dist/artifacts/

# The lockfile must know about packages/keeper-old, or --frozen-lockfile fails with
# ERR_PNPM_OUTDATED_LOCKFILE. Run this at the repo root and commit the result.
pnpm install
git add pnpm-lock.yaml
```

You also need, before a live run:

- **An RPC endpoint for chain 4663** with `debug_traceTransaction` (callTracer)
  and **archive** historical state. Both are load-bearing, not nice-to-have: the
  callTracer is the only source of sell proceeds on this chain (the GMGN router
  unwraps WETH and forwards native ETH by internal call, with no log and no
  top-level transaction), and boundary balances are read at historical heights.
  Without the tracer every sell reads as a giveaway and the engine refuses
  everything; without archive state the boundary reads fail. The keeper probes
  both at startup — let it.
- **The attester key that `AttesterRegistry.attester()` currently returns.** A
  rotated or wrong key means every attempt reverts `InvalidAttester` and burns
  the trader's gas.
- **The trading account must be `ACTIVE`** on the vault, and the protocol and
  vault must not be paused.

Mainnet addresses (defaults in `docker-compose.yml`'s `x-chain-env` anchor):

| | |
| --- | --- |
| `NUVEM_VAULT_FACTORY` | `0xDf411fdCc7C31e4F6bCa6F6BCaB40FE812Ab4A46` |
| `NUVEM_SETTLEMENT_EXECUTOR` | `0xCe676c73bd9fb76a73058EC135106b81A5ABd0f5` |
| `NUVEM_VAULT` | `0xF7309dC8e1914A5c3848250cec54Ebe7A20D8255` (the canary) |
| `NUVEM_WETH` | `0x0bd7d308f8e1639fab988df18a8011f41eacad73` |
| `NUVEM_PAUSE_CONTROLLER` | `0x2dbbc211dbfe0f15e88e5388c96530f2721baefc` |
| `NUVEM_ATTESTER_REGISTRY` | `0x2a3309931a6db1e1b253224551912566d647f921` |

> That default deployment is a **spent canary**. `VaultFactory.configureProtocol`
> is one-shot and already called, so the executor address is pinned forever. Its
> vault admin is `0xaed788b3c69ca941a4302899f80ccad219942ca7`. Fine for
> validating against your own vault; not for onboarding anyone.

---

## 4. Configuration

Two sources, and **the precedence between them matters.** Verified on Compose
v2.40.3:

> `environment:` in `docker-compose.yml` **overrides** `env_file:`, **including
> when it resolves to an empty string.** A `FOO: ${FOO:-}` line does not "leave
> FOO to the env file" — it sets `FOO=""` and silently discards what the file
> said.

That is why the compose `environment:` map contains only settings with a real
default, and everything an operator would put in a file is absent from it.

### `.env.docker` — interpolation (shell-visible), shared with `web`

Feeds `${...}` **while the compose file is parsed**. Not injected by `env_file:`.

```bash
export COMPOSE_ENV_FILES=.env.docker   # or pass --env-file to EVERY command
```

| Variable | Notes |
| --- | --- |
| `NUVEM_RPC_URL` | Required. Arrives through the `x-chain-env` anchor. |
| `NUVEM_VAULT` | Defaults to the canary. |
| `NUVEM_KEEPER_POLL_MS` | Default `30000`. |
| `NUVEM_KEEPER_ALLOW_BROADCAST` | **The env half of the broadcast gate.** Can only come from here or your shell — see section 6. |

### `.env.keeper` — injected into the container, `chmod 600`, keeper-only

Separate from `.env.docker` on purpose: the dashboard's config file then never
contains a signing key. Gitignored by the root `.env.*` rule (verified with
`git check-ignore`).

```bash
install -m 600 /dev/null .env.keeper
$EDITOR .env.keeper
```

| Variable | Notes |
| --- | --- |
| `NUVEM_TRADING_ACCOUNT` | The EOA whose sessions to settle. **No default** — settling for the wrong account is not a mistake a default should be able to make. |
| `TRADING_OWNER_PRIVATE_KEY` | The trading account's own key. Section 1. |
| `NUVEM_KEEPER_MAX_CONTRIBUTION_WEI` | Circuit breaker, per settlement. |
| `NUVEM_KEEPER_MAX_SETTLEMENTS_PER_DAY` | Circuit breaker, checked against the store. |

Do **not** put `NUVEM_KEEPER_ALLOW_BROADCAST` here. It would be overridden to
empty and silently ignored. That asymmetry is deliberate: the file holding the
signing keys must not also be the thing that authorises spending.

#### The attester key

`NUVEM_ATTESTER_KEY_FILE` is **not** in the table above, because it is no longer
yours to set: `docker-compose.yml` pins it to `/run/secrets/attester.key` in
`environment:`, alongside the bind mount that puts the file there. The two have
to agree, so they are not independently overridable, and `environment:` beats
`env_file:` — a value in `.env.keeper` would be silently discarded. Point the
**host** side somewhere else with `NUVEM_ATTESTER_KEY_HOST_PATH` instead:

```bash
mkdir -p secrets && chmod 700 secrets      # secrets/ is gitignored
install -m 400 /dev/null secrets/attester.key
$EDITOR secrets/attester.key               # the 0x… key
```

To use the inline `NUVEM_ATTESTER_PRIVATE_KEY` fallback instead — only where a
file genuinely cannot be mounted — **comment out both** the
`NUVEM_ATTESTER_KEY_FILE` line and the bind mount in `docker-compose.yml`, then
put the key in `.env.keeper`. Both edits are needed: `config.ts` prefers the file
whenever that variable is non-empty. Read section 1 before choosing this; it puts
the key in `docker inspect` and `/proc/1/environ` for the life of the container.

---

## 5. Build, and the first (dry) run

The keeper is in the **`keeper` profile**, so a plain `docker compose up`
neither builds nor starts it.

```bash
export COMPOSE_ENV_FILES=.env.docker

docker compose --profile keeper build keeper
docker compose --profile keeper up -d keeper      # DRY RUN. Signs nothing.
docker compose logs -f keeper
```

`up -d keeper` starts only the keeper. `--profile keeper up -d` with no service
name starts the dashboard too.

> **Do not mistake the profile for a safety mechanism.** Measured on Compose
> v2.40.3: an unqualified `docker compose up -d` starts web only and
> `config --services` lists web only — but **`docker compose up -d keeper` starts
> it with no `--profile` flag anywhere** (naming a service auto-enables its
> profile), and `COMPOSE_PROFILES=keeper` in the environment enables it with
> neither a flag nor a service name. The profile keeps the dashboard's everyday
> commands from dragging in a service that holds signing keys. That is all it
> does. What actually stops a settlement is the two broadcast gates in section 6,
> which hold however the container was started.

Confirm from the outside that it really is in dry run:

```bash
docker compose exec keeper node -e \
  "fetch('http://127.0.0.1:8787/status').then(r=>r.json()).then(s=>console.log(s.config.mode, s.config.tradingKeyPresent, s.chainOk, s.history.accounted))"
# expect: dry-run false true true
```

`tradingKeyPresent false` is the load-bearing one. It is not a setting being
reported back — outside live mode `loadConfig` never reads a spending key at all,
so `false` means the process does not hold a credential capable of sending a
transaction. `history.accounted` is covered in section 7; `false` there means the
keeper will refuse every window until recovery squares up.

Note `/status` reports `rpcHost` as `<upstream RPC>` rather than the real host.
That endpoint is served unauthenticated and, in the shipped compose file, on a
shared bridge network — and the host is the string an API key hangs off. The real
host is on the `keeper starting` log line, which goes to local stdout.

Without compose (note `-f` plus the trailing `.`, because the context is the repo
root):

```bash
docker build -f packages/keeper-old/Dockerfile -t nuvem-keeper:local .

docker run --rm \
  -e NUVEM_RPC_URL="https://…" \
  -e NUVEM_TRADING_ACCOUNT="0x…" \
  -e NUVEM_ATTESTER_KEY_FILE=/run/secrets/attester.key \
  -v "$PWD/secrets/attester.key:/run/secrets/attester.key:ro" \
  -v nuvem-keeper-state:/var/lib/nuvem/keeper \
  nuvem-keeper:local
```

`--init` is not needed: `tini -g` is already PID 1 in the image. The plumbing was
verified with a stand-in process that installs a `SIGTERM` handler — `docker stop`
returned in under a second instead of waiting out the 10-second SIGKILL timer, so
the signal does reach the entry point. **The keeper still has to install the
handler**; without one, `node` takes the default SIGTERM action and dies
immediately, which is survivable (startup recovery resolves an unresolved intent)
but is not a clean mid-cycle stop.

### The dry-run-first procedure

Do not skip a step, and do not compress steps 1–5 into one afternoon on a day
you are also trading.

1. **Read-only, no keys.** Start with `NUVEM_TRADING_ACCOUNT` set and no key
   material at all. It should refuse to start, naming which key is missing and
   what it is for. A service that starts happily with no keys is a service whose
   configuration check does not work.
2. **Dry run, real keys, real chain.** Add the keys. Watch a full sweep. The
   pipeline runs end to end — detection, `buildSessionReport`,
   `previewContribution`, EIP-712 signing, `simulateContract`, and the
   cross-check of the local digest against the contract's own `hashAttestation`.
   Everything except `eth_sendRawTransaction`. "It worked in dry run" therefore
   means something.
3. **Reconcile against history, and know which of the two outcomes you got.**
   The canary has already settled once: tx `0xd342d117…cad186` moved
   `403370889498747` wei from a measured profit of `2016854447493738` wei. That
   settlement consumed vault settlement nonce `0`, so the vault now reports
   `settlementNonce: 1`.

   A chain `settlementNonce` of N is a statement that nonces `0 … N-1` were each
   consumed, exactly once. On a fresh volume the journal can name none of them, so
   startup recovery enumerates `SettlementExecuted` filtered by the account and
   ABI-decodes each `settle` transaction's calldata to recover the block range,
   and writes an `ADOPTED` record for each. Exactly one of these two things then
   happens, and both are correct:

   - **Every nonce is accounted for.** `/status` shows `history.accounted: true`,
     `journal.counts.ADOPTED` is at least 1, and `journal.lastEndBlockL1` has an
     entry for the current `bindingEpoch`. Offering that window again is then
     refused by `PROGRESSION_L1`. This is the good path.
   - **At least one nonce cannot be named.** Recovery writes `DEGRADED` with
     reason `UNACCOUNTED_SETTLEMENTS`, naming the nonces, and the keeper refuses
     every window. **This is not a bug and clearing it is not the fix.** The
     ordinary cause is `NUVEM_KEEPER_LOGS_FROM_BLOCK` sitting above the settlement
     so the scan cannot see it: lower it and restart. The cause that matters is a
     provider answering a capped `eth_getLogs` range with an empty list instead of
     an error, which looks identical from here.

   Verify it against the chain yourself rather than trusting the journal:

   ```bash
   docker compose exec keeper nuvem-keeper recover     # read-only, writes nothing
   ```

   `recover` prints what the chain says was settled — `found`, `contributionSum`,
   and each window's L1 range. `contributionSum` must equal the vault's
   `lifetimeContribution`, and `found` must equal the chain's `settlementNonce`.
   If those two identities hold and the keeper still says
   `history.accounted: false`, the log floor is wrong; if they do not hold, stop
   and work out why before going anywhere near `--broadcast`.

   What must NEVER happen: a cold start on a volume with no settlement record
   reporting itself reconciled and proceeding to attest. If you see
   `history.accounted: true` with `journal.counts.CONFIRMED` and
   `journal.counts.ADOPTED` both `0` against a non-zero `settlementNonce`, stop —
   that is the exact failure this whole section exists to detect.
4. **Check the arithmetic by hand, once.** Take a decision line for an
   `ATTESTABLE` window and independently recompute `realizedProfit` from
   `cashStart`, `cashEnd`, `externalDeposits`, `externalWithdrawals`, then check
   `contributionBps == 2000`. Those four inputs are the only place a wrong
   settlement can hide: `SettlementExecutor` recomputes `realizedProfit` from
   them onchain (`:93-96`) and rejects a mismatch, but it cannot check them
   against history. Nobody else will do this check for you.
5. **Confirm the refusals are honest.** A `REFUSED` verdict is the normal
   healthy outcome for a badly chosen window, and there is no override flag,
   deliberately (`packages/aa-smoke-old/scripts/settle.mjs:87-91`). Look at
   `reasons[]` and satisfy yourself they describe reality. If your instinct is
   "make the refusal go away", stop — that is the instinct this whole codebase
   is built to frustrate.
6. Only then, section 6.

---

## 6. Arming broadcast

**Two gates of different kinds, and both are required.** Neither is satisfiable
by a careless `docker compose up -d` or by a copied config file.

| Gate | Where | Value |
| --- | --- | --- |
| argv | compose `command:` / `docker run` args | `--broadcast` |
| env | shell or `COMPOSE_ENV_FILES` (**not** `.env.keeper`) | exactly `i-understand-this-moves-real-funds` |

The image's `CMD` is empty and `docker-compose.yml` sets no `command:`, so the
committed configuration cannot broadcast no matter which env file you point at
it. Arming it takes a visible, reviewable override file:

```bash
cat > docker-compose.keeper-live.yml <<'EOF'
# LIVE. This file makes the keeper spend real money. Keep it out of the default
# compose invocation and out of any deploy script that runs unattended.
services:
  keeper:
    command: ["--broadcast"]
EOF
```

```bash
NUVEM_KEEPER_ALLOW_BROADCAST=i-understand-this-moves-real-funds \
  docker compose -f docker-compose.yml -f docker-compose.keeper-live.yml \
  --profile keeper up -d keeper
```

`docker-compose.*.yml` is already excluded from the build context by
`.dockerignore`, and it is not auto-loaded by compose — you have to name it.

Before you do that, confirm the keeper agrees it should be live. It must refuse
to broadcast unless **all** of these hold, and none of them is overridable:

- the engine's verdict is `ATTESTABLE`;
- `chainId` reads exactly `4663`, checked every tick and never cached (viem
  asserts the chain only on wallet writes, never on reads — a testnet endpoint
  answers every read plausibly, with zeroed structs that look like "not
  configured");
- `AttesterRegistry.attester()` equals the loaded key's address, at the current
  `attesterEpoch`;
- the local ledger's progression and novelty rules pass, and a filtered
  `eth_getLogs` on the indexed `sessionId` finds no existing settlement;
- the live `settlementNonce` matches what the ledger expects;
- **every settlement nonce the chain has consumed is named by a `CONFIRMED` or
  `ADOPTED` record** (`/status` → `history.accounted: true`). A journal that
  cannot account for the chain's history does not know the boundary it must not
  cross, and refuses everything;
- no unresolved in-flight intent exists (single flight, ever);
- the degraded latch is clear;
- this window has not already reverted (two reverts and it is abandoned; one and
  it waits out a backoff);
- neither circuit breaker has tripped, including the consecutive-revert breaker.

After the first live settlement, check `lifetimeContribution` and the vault's
WETH balance moved by exactly the amount in the decision line, then go back to
dry run until you actually want it running unattended.

---

## 7. Observability

```bash
docker compose logs -f keeper                       # structured JSON, one object per line
docker compose ps                                   # health status
docker compose exec keeper node -e "fetch('http://127.0.0.1:8787/status').then(r=>r.text()).then(console.log)"
```

- **`/health`** — the container probe. No RPC, no volume. Red only when the tick
  loop is wedged. Note compose does **not** restart on unhealthy by itself, so a
  red probe is a signal in `docker compose ps`, not an action; watch it.
- **`/status`** — the operator view. Every chain-derived field is
  `{ok:true,value}` or `{ok:false,error}` rather than a bare value, so it can say
  "unknown" instead of reporting a failed read as a zero. A failed read's `error`
  is a SUMMARY — the error's name plus its first meaningful lines — never the
  upstream message: viem annotates every transport error with `URL: <endpoint>`,
  and this endpoint carries an Alchemy API key, so a routine 429 would otherwise
  publish that key to anything able to reach the port. If the summary ever says
  `<detail withheld: … tripwire>`, redaction found something it could not remove
  and dropped the detail on purpose; the full text is in the service log.
- **Heartbeat.** One info line per tick even when nothing happened. Silence is
  the alertable condition: the failure mode a keeper actually has is not crashing
  loudly, it is quietly doing nothing.

### The four `/status` fields worth alerting on before any other

| Field | Meaning when it is bad |
| --- | --- |
| `store.condition: "DAMAGED"` | **Read this one first.** The store file is zero bytes, truncated, not a SQLite database, missing a table the dedup reads, or has an orphaned `-wal`/`-shm`. `store.detail` names the file and the recovery. **Nothing is settled, no RPC call is even made, and the file is not repaired or re-created.** A one-shot `tick` exits `5`. See section 9's *"A damaged store is not an empty one"*. Its companion `store.integrityOk: false` means the contents were edited even though the file itself is sound; `store.settleable` is the AND of the two and is the single boolean to alert on. |
| `history.accounted: false` | The chain reports settlements this journal cannot name, so the last settled block boundary is unknown. **Nothing will be attested while this holds** — and this is the field to watch after any volume loss, restore or migration. `lastEndBlock` has no getter on `PersonalVault`, so this cannot be recovered from vault state; it is recovered from logs plus calldata, or not at all. |
| `degraded != null` | Latched halt. Requires `--acknowledge-degraded <seq>`. `REVERT_BREAKER` means three consecutive settles reverted; `UNACCOUNTED_SETTLEMENTS` is the row above. |
| `l1RangeCollapsed.count` rising | **Lost savings, not caught duplicates.** Each entry is a genuinely new session the protocol's L1-only block range can never accept. Section 11's `NonProgressiveBlockRange` row. |
| `reverts.consecutive > 0` | A settle reverted. Each attempt costs the trading account real gas. `reverts.perWindow[w].attempts` reaching `maxPerWindow` (2) means that window has been abandoned. |

Also alert on: no heartbeat for 5 intervals; an in-flight intent older than 900s
(past the attestation validity ceiling); `chainOk` false;
`attesterMatchesRegistry` false; the anchor lag growing monotonically across 10
ticks; two consecutive budget exhaustions; any `contributionBps` that is not
`2000`; and — pointedly — `config.mode == "live"` when nobody expected it to be.

`nonceReconciled` is **not** on `/status`. It is a per-tick result: it is on the
`tick` heartbeat line and in `snapshot-*.json` under `recovery`. Alert on
`history.accounted` instead, which is computed from the journal and the chain at
request time and does not depend on a tick having run recently.

### Exit codes from a one-shot `tick`

| Code | Meaning |
| --- | --- |
| `0` | Nothing to do, refused a window, or completed a dry run. |
| `2` | Configuration refusal. Nothing started. |
| `3` | The state lock, or a state-directory identity mismatch. |
| `4` | RPC error, or a chain-id mismatch. |
| `5` | `DEGRADED` — including the cold-start refusal above — **and `STORE_REFUSED`**: the store is damaged, or its schema refused a write it could prove was a replay. Both are halts, and neither used to be distinguishable from `0`. |
| `6` | `L1_RANGE_COLLAPSED` — a profitable session was forfeited. Countable without parsing logs. |
| `7` | `SETTLE_FAILED` — a settle reverted onchain. |

Log rotation is capped at 3 × 10 MB in the compose file so a chatty keeper cannot
fill the disk. The logs are on stdout only; nothing is written to the volume
except the ledger.

---

## 8. The volume: what it holds, and why it matters

```yaml
volumes:
  - nuvem-keeper-state:/var/lib/nuvem/keeper
```

> **A word on vocabulary, since this runbook spans a migration.** Where the text
> below says **"the journal"** without qualification — `CONFIRMED` records, the
> tail, what recovery adopts into — read it as **"the settled-window store,
> whichever implementation is on your volume"**. The record types, the nonce-set
> invariant and every procedure in sections 7 and 9 are identical either way.
> Where the distinction actually matters — backup, integrity checking, partial
> loss — it is called out explicitly as *legacy JSONL* or *SQLite*.

A **named** volume, `nuvem-keeper-state`, so the ledger survives
`docker compose down`, an image rebuild and a host reboot. Only
`docker compose down -v` or an explicit `docker volume rm` destroys it. The image
deliberately declares no `VOLUME` instruction: that would make a bare
`docker run` silently create an *anonymous* volume, invisible except as a hash
and orphaned on the next `docker rm`. A missing `-v` should be a visible
operator decision.

The directory is created **in the image** as `0700 keeper:nuvem`, because Docker
initialises a freshly created named volume from the image's content and
permissions at the mount point. Verified: a new volume comes up `drwx------
keeper nuvem` and the non-root process can write to it. If you pre-create the
volume some other way and it ends up root-owned, the first write to the store dies
with `EACCES` — fix with a one-off `docker run --rm -v
nuvem-keeper-state:/s alpine chown -R 1001:1001 /s`.

### Contents — and the move from JSONL to SQLite

**The store is being replaced.** The hand-rolled append-only JSONL journal — a
hash chain, tail repair, torn-write detection, a sequence tripwire and a
self-healing lock, about 1,300 lines of it — failed two consecutive adversarial
reviews, each time with *new* blocking defects, two of which were artifacts of
hand-rolling durability rather than of the design:

- `repairTail` silently destroyed every record after the **first** hash-chain
  break, wherever in the file that break was, while its own comment claimed it
  only ever trimmed a torn final line.
- The `append()` durability tripwire compared the **sequence number** rather than
  the **record**, so it passed whenever anyone else had written at that sequence.

Both cease to exist under a real transaction. The replacement is **`node:sqlite`**
— built into Node 22, zero dependencies, no native build step (which is what
makes it work inside this container), ACID transactions. See section 2 item 9 for
the measured facts about it on the pinned runtime.

> **The third defect was not a storage bug and is not fixed by SQLite.** Every
> service-side guard — `lastEndBlockL1`, `lastEndBlockL2`, `settlementCount` —
> was keyed by `bindingEpoch`, so a **rebind re-armed the replay** and all of
> them missed it. The contract's own guards are `bindingEpoch`-scoped too
> (`PersonalVault.sol:543-549`) — *that is precisely why a service-side dedup has
> to exist*, and mirroring the weakness defeated the whole point of having one.
> The new schema must key the progression facts on the **account**, not on
> `(account, bindingEpoch)`, and keep `bindingEpoch` as recorded history rather
> than as part of the key. If you are reviewing the migration, this is the thing
> to check first.

| Entry | What it is |
| --- | --- |
| `instance.json` | Pins `chainId`, factory, executor, vault, account, schema versions. Written once. **If any live value disagrees on startup, the keeper refuses to start rather than migrating** — this is what stops a volume that held testnet state from being reused against mainnet, which is the cheapest way to get a wrong settlement. Unchanged by the migration. |
| `keeper-<chainId>-<vault>-<account>.db` *(new)* | **The authority.** `0600`, and **its mere existence is meaningful**: it is only ever created by a rename of a fully-built store, so a file that exists but is empty, truncated or schema-less is damage and is refused rather than rebuilt over — see section 9.  One SQLite database, holding the same record history the journal held (`INTENT`, `CONFIRMED`, `FAILED`, `ABANDONED`, `SKIPPED`, `ADOPTED`, `DEGRADED`/`RESUMED`, `DRYRUN`, `CHECKPOINT`) plus the derived progression state, written in the **same transaction** as the record that changes it. Corrections are new rows, never edits — it is evidence. |
| `keeper-….db-wal`, `keeper-….db-shm` *(new)* | SQLite's write-ahead log and shared-memory index. **They are part of the database, not scratch files.** A `.db` copied without its `-wal` is a database missing its most recent committed transactions — which here means missing the most recent settlements. This is the single most important thing to know about backing it up. They are absent after a clean close, because the WAL is checkpointed back into the database — and because of that, a `-shm` present with **no** `-wal` beside it is treated as damage, not as a clean shutdown. All three are `0600`. |
| `snapshot-<chainId>-<vault>-<account>.json` | Derived index, kept for a fast start and for reading without SQLite. Rebuildable from the database; losing it is a slow start, never a fatal. |
| `journal-<chainId>-<vault>.jsonl` *(legacy)* | The old append-only hash-chained journal. Still the authority on any volume that has not been migrated. |
| `keeper.lock` | `O_EXCL` pidfile. Two keepers on one volume would both see the same unsettled window and both broadcast. SQLite's own locking stops two writers corrupting the file, but it would **not** stop two keepers each settling the same window through separate valid transactions, so this stays. |

The chain triple is in the filenames so a wrong-volume mistake is visible in
`ls`.

### If you already have a JSONL journal

**Do not delete it, and do not hand-convert it.** It is the only local record of
which vault `settlementNonce` values your keeper can account for, and section 9's
halt is keyed on exactly that set.

1. **Back up the volume first**, with the keeper stopped, using the recipe below.
   Keep that tarball until you have watched several successful ticks on the new
   store.
2. **Upgrade with the keeper stopped**, then start it **dry-run**
   (`docker compose --profile keeper up -d keeper`, no `--broadcast`, no
   sentinel) and read the first tick's output before anything else.
3. **Expect one of two outcomes, and treat both as normal:**
   - The keeper migrates the journal into the database on first open and says so.
     Check that the number of `CONFIRMED` + `ADOPTED` records it reports matches
     the vault's `settlementNonce`, and that it is not `DEGRADED`.
   - The keeper starts on an empty database and immediately reports `DEGRADED`
     with `UNACCOUNTED_SETTLEMENTS`, naming the nonces. **This is the correct
     failure**, not a bug — it is the cold-start path from section 9. Follow
     section 9: let recovery rebuild from `SettlementExecuted` logs and decoded
     `settle` calldata, cross-check by hand with `nuvem-keeper recover`, and only
     then clear the latch.
4. **Only re-arm broadcast after a dry-run tick has been clean.** Section 6.
5. Leave the `journal-*.jsonl` and `snapshot-*.json` files on the volume. They
   cost nothing, they are the audit trail for the migration itself, and
   `.dockerignore` and `.gitignore` both already keep them out of images and out
   of git.

What you must **not** do: start the new keeper live against a volume whose
journal it did not read, on the assumption that the chain will catch a duplicate.
The chain's guards are `bindingEpoch`-scoped and in coarse L1 block space — the
two holes this store exists to cover.

### Why this is correctness-critical even though the contracts also guard

Be precise about this, because overclaiming here is how people stop backing it
up. The vault **does** guard replay — `PersonalVault.sol:543-549`, reached via
`SettlementExecutor.settle` → `vault.acceptSettlement`:

```solidity
uint64 previousEnd = $.lastEndBlock[record.account][record.bindingEpoch];
if (previousEnd != 0 && record.startBlock <= previousEnd) revert NonProgressiveBlockRange(...);
bytes32 sessionKey = keccak256(abi.encode(record.account, record.bindingEpoch, record.sessionId));
if ($.usedSessions[sessionKey]) revert SessionAlreadyUsed(record.sessionId);
```

and writes both at `:561-562`. `SettlementExecutor` alone does **not** record the
last settled `endBlock`, so the executor's own checks would accept a fresh
attestation over an already-settled window with an incremented nonce; the vault
is what stops it.

So the ledger is **defense in depth plus an intent write-ahead log**, not the
only barrier. It is still correctness-critical, and these are the reasons:

1. **Both onchain guards are keyed by `bindingEpoch`.** `lastEndBlock[account][
   bindingEpoch]` and the `usedSessions` key both include the epoch, so a rebind
   resets them to zero for the whole settled history. A separate check —
   `startBlock < activationBlock` reverts, and `_activateTradingAccount` sets
   `activationBlock = block.number` on every rebind — covers much of that hole in
   practice. The point is that the guarantee then rests on an interaction between
   two mechanisms in an upgradeable contract, and `PersonalVault` sits behind a
   per-cohort beacon. The durable local record is what makes the guarantee not
   depend on that.
2. **`lastEndBlock` has no public getter.** It is private namespaced storage
   (`PersonalVault.sol:53-54`), so the last settled boundary **cannot be read back
   from the vault**. It is either persisted here, or re-derived from
   `SettlementExecuted` plus decoded `settle` calldata — those are the only two
   options, and `eth_getStorageAt` against ERC-7201 slots is not a supported third.
3. **The onchain guards are in coarse L1 block space.** Many L2 blocks map to one
   L1 block, so they cannot tell a genuinely new L2 session from an
   already-consumed one when both land in the same L1 block. The keeper keeps its
   own L2-space record precisely so it can tell "already settled" from "distinct
   session, unlucky L1 collision" — and report the second as lost revenue instead
   of as a duplicate.
4. Every duplicate attempt the local rule fails to stop **burns the trader's gas
   on a revert**.

Which is why the local rule is deliberately *the same rule the chain enforces* —
monotone progression on `endBlock`, plus `sessionId` novelty — rather than a
different invention. Mirroring means a local bug produces a revert, not a double
payment. And it is why `sessionId` novelty is not trusted on its own: `sessionId`
commits `ledgerRoot`, so a change to how the root is computed makes an
already-settled window re-derive to a *different* `sessionId`. It has already
happened here — the canary's settled window re-derives under the v2 root to an id
the chain has never seen. Progression does not care what the root says, which is
why it is the primary rule and why the boundary it compares against has to be
durable.

### Backup

The store is small — single-digit settlements a day, hundreds of rows a year — so
backup is cheap and there is no excuse for not doing it. **What changed with
SQLite is not the size, it is that a live copy is no longer safe.**

> **Stop the keeper, or use SQLite's own backup.** A JSONL journal could be
> `tar`red at any moment and the worst case was a torn final line, which the
> loader handled. A SQLite database in WAL mode is **three files that must be
> consistent with each other**, and `tar` reads them one after another while the
> keeper may be committing between them. The result is a backup that restores,
> opens, and is quietly missing your most recent settlements — the exact
> condition that makes the keeper settle a window twice.

**The recommended recipe. Stopping makes it unambiguous, and 45 seconds of
downtime costs nothing on a 30-second poll.**

```bash
docker compose --profile keeper stop keeper        # graceful; stop_grace_period 45s

docker run --rm \
  -v nuvem-keeper-state:/state:ro \
  -v "$PWD/backups:/backup" \
  alpine tar czf "/backup/keeper-state-$(date -u +%Y%m%dT%H%M%SZ).tar.gz" -C /state .

docker compose --profile keeper start keeper
```

Take the **whole directory**, not just the `.sqlite` file: `instance.json` is
what stops the volume being reused against the wrong chain, and any `-wal` /
`-shm` present must travel with the database.

**If you cannot stop it**, do not `tar` the live files. Use SQLite's own
consistent-copy path, which takes the right locks and folds the WAL in:

```bash
docker compose --profile keeper exec keeper node -e '
  const { DatabaseSync } = require("node:sqlite");
  const dir = process.env.NUVEM_KEEPER_STATE_DIR;
  const src = require("fs").readdirSync(dir).find((f) => f.endsWith(".sqlite"));
  const db = new DatabaseSync(dir + "/" + src, { readOnly: true });
  db.exec("VACUUM INTO " + "'/tmp/" + src + ".bak'");
  db.close();
  console.log("wrote /tmp/" + src + ".bak");
'
docker compose --profile keeper cp keeper:/tmp/<name>.sqlite.bak ./backups/
```

Two things that will bite if you retype this from memory, both hit while
verifying it against the image:

- **`exec`, not `run`.** `docker compose run keeper node -e …` goes through the
  image's `ENTRYPOINT`, so `node` is handed to the keeper's own argument parser
  and you get `unknown command "node"`. `exec` runs the command directly. If the
  service is not up and you must use `run`, pass `--entrypoint node`.
- **The destination path must be a SQL string literal in SINGLE quotes.** Double
  quotes make SQLite read it as an identifier and it fails with
  `no such column: "/tmp/…"`. `readOnly: true` is fine — verified, `VACUUM INTO`
  works on a read-only connection.

`VACUUM INTO` writes a single self-contained file with **no `-wal` beside it** —
verified, and it is the reason to prefer it over `cp`. Note `/tmp` is a 16 MB
tmpfs and the only other writable path; it disappears with the container, so copy
it out immediately. Do not write the backup into the state directory itself:
`[no-state]` and `.dockerignore` are keyed on these filenames for good reasons,
and a stray `.sqlite.bak` next to the live database is one `ls` away from being
mistaken for it.

Keep backups off the host, keep several, and **restore one and open it** rather
than assuming. The store names the vault, the account, every window and every
amount — it is not secret material, but it is a complete record of the operator's
trading profits. Treat it as private.

```bash
# Restore into a fresh volume.
docker volume create nuvem-keeper-state
docker run --rm -v nuvem-keeper-state:/state -v "$PWD/backups:/backup":ro \
  alpine sh -c 'tar xzf /backup/keeper-state-<stamp>.tar.gz -C /state && chown -R 1001:1001 /state'
```

**Verify before starting the keeper live**, whichever store you are on:

```bash
# Is the FILE intact? Read `store` in the output: condition HEALTHY, integrityOk
# true, settleable true. This is a keeper subcommand, so it goes through the
# entrypoint as normal, and it is read-only.
docker compose --profile keeper run --rm keeper status | head -20

# Does it name every settlement the CHAIN says happened?
docker compose --profile keeper run --rm keeper recover
```

> **Do not reach for a bare `PRAGMA integrity_check` here.** An earlier version of
> this runbook did, and it is exactly the check that cannot see the failure that
> matters: `integrity_check` on a **zero-byte** file returns `ok`, because SQLite
> considers a zero-byte file a valid empty database. `keeper status` runs the
> file-level probe *and* `quick_check` *and* `integrity_check` *and* the schema
> inventory *and* reconciles the decision tables against the record stream, and
> reports the answer as `store.condition`. See section 9's *"A damaged store is
> not an empty one"*.

`store.condition: "HEALTHY"` means the *file* is intact. It says nothing about
whether the history is complete — that is what `history.accounted` and `recover`
answer, and it is the question section 9 is about. A restored backup that is a
few settlements stale looks perfectly healthy to every file-level check and will
be caught by the nonce-set test instead.

---

## 9. Recovering when the ledger is lost

**The local store is a cache. Chain history is the ledger, and it is fully
recoverable.** So this is a procedure, not a disaster — but it is a procedure
with a halt in it, and the halt is the important part.

If the volume is gone, wrong, restored from a backup, or fails its integrity
check (`PRAGMA integrity_check` on SQLite; the hash chain on the legacy journal):

1. **Do not start in live mode.** Start with no `--broadcast` and no sentinel.
2. **Let recovery run and read what it says.** It reconstructs everything from
   chain data:
   - **Phase A** resolves any unterminated `INTENT` — receipt by
     `rawTxHash`; then `eth_getTransactionByHash`; then, if the recorded EOA
     nonce has been consumed, a filtered `eth_getLogs` on the indexed
     `sessionId`. **Never infer a settlement from the nonce alone** — the trading
     account is the trader's own actively-used EOA and a GMGN trade can take that
     nonce. Only the log decides.
   - **Phase B** hunts for settlements the journal never saw: enumerate
     `SettlementExecuted` filtered by the account from the vault's deployment
     block, then `eth_getTransactionByHash` and ABI-decode the `settle` calldata
     to recover `startBlock`, `endBlock`, `ledgerRoot`, `bindingEpoch` and
     `contribution` — neither `SettlementExecuted` nor `ContributionReceived`
     carries the block range, and there is no public getter for `lastEndBlock` or
     `usedSessions` (`PersonalVault.sol:53-54` are private storage). Decoded
     calldata is the supported path; do not reach for `eth_getStorageAt` against
     ERC-7201 namespaced slots.
   - **Phase C** halts on anything it cannot attribute. The test is a SET, not a
     sum: a chain `settlementNonce` of N means nonces `0 … N-1` were each
     consumed, and every one of them must be named by a `CONFIRMED` or `ADOPTED`
     record. Any that is not produces `DEGRADED` with reason
     `UNACCOUNTED_SETTLEMENTS`, naming the missing nonces, and the keeper refuses
     to settle until an operator acknowledges it explicitly. **Halting is cheap;
     the money is not.**

     Why a set and not `baseline + records == observed`: that arithmetic was
     unfalsifiable in exactly the case that mattered. A fresh journal's baseline
     used to be written from the live chain nonce *before* reconciliation ran, so
     the two sides were equal by construction and the keeper concluded there was
     nothing to learn — on the one volume state where it knew nothing at all. The
     baseline is now written *after* reconciliation and derived from what it
     actually accounted for.
3. **Cross-check by hand before clearing a halt.** `nuvem-keeper recover` is
   read-only and writes nothing to the ledger; it prints what the chain says was
   settled. Two identities must hold: `found` equals the vault's
   `settlementNonce`, and `contributionSum` equals its `lifetimeContribution`. For
   the canary that is `found: 1` and
   `contributionSum: 403370889498747`, from tx `0xd342d117…cad186`.

   If both hold and the keeper is still halted, the log floor is above the
   settlement — lower `NUVEM_KEEPER_LOGS_FROM_BLOCK` and restart, which is a
   configuration fix and needs no acknowledgement. Only acknowledge when you have
   confirmed by hand that a settlement the keeper cannot see is genuinely
   accounted for. The acknowledgement is **bounded**: it excuses the nonces named
   in that `DEGRADED` record and nothing that happens afterwards.
4. **Only then** acknowledge the degraded latch and, separately, re-arm
   broadcast. Two decisions, two commands.

Rehearse it before you need it, and expect one of two outcomes rather than a
single pass/fail. On a fork or against mainnet read-only, delete the volume and
run one `tick`:

```bash
docker compose --profile keeper run --rm -v nuvem-keeper-rehearsal:/var/lib/nuvem/keeper keeper tick
```

- If `NUVEM_KEEPER_LOGS_FROM_BLOCK` is at or below the settlement's L2 block, the
  journal ends up with an `ADOPTED` record, `history.accounted` is `true`, and
  offering that window again is refused by `PROGRESSION_L1`. Exit `0`.
- If it is above it, the journal ends with `DEGRADED / UNACCOUNTED_SETTLEMENTS`
  naming nonce `0`, and every window is refused. Exit `5`. **This is also a
  pass.** Rehearse both, because the second is what a misconfigured cold start
  looks like and you want to have seen it before it is real.

What is NOT a valid outcome, and what the earlier version of this runbook wrongly
told you to expect on every path: a cold start that adopts nothing, reports itself
reconciled, and proceeds. If a tick on a wiped volume ever reaches `DRY_RUN` on a
window while `journal.counts.ADOPTED` is `0` and the chain's `settlementNonce` is
non-zero, stop and do not arm broadcast.

A partial loss is easier, and it is where the SQLite migration changes the most.

**Under SQLite there is no torn record to reason about.** A crash mid-write is
resolved by the database on the next open: the transaction either committed or it
did not, and a half-written row cannot be observed. What *can* still be
outstanding is an `INTENT` that was committed and whose settlement then went
unwitnessed — a broadcast that may or may not have landed. That is not corruption
either; it is precisely the case **Phase A** exists for, and it is resolved
against the chain, never by guessing. Nothing here needs a "repair" step, and
there is no equivalent of the old `repairTail` — which is the point of the
change, since the old one silently destroyed every record after the first
hash-chain break rather than only a torn tail.

**Under the legacy JSONL journal**, a torn final line (a crash mid-write) is
also **not corruption** — the loader discards it and everything after it and
treats the discarded tail as an unresolved intent, which Phase A resolves. But be
aware of the defect while you are still on that store: the repair discarded
everything after the *first* hash-chain break wherever it occurred, so a break in
the *middle* of the file silently threw away good records after it. If you are
mid-migration and `keeper journal` reports a truncated tail, **take a copy of the
file before letting anything repair it**, and reconcile against `recover`.

`snapshot-*.json` has no successor: under SQLite the derived state is written in
the same transaction as the record that changes it, so it cannot be stale
relative to the history and cannot be lost separately from it.

**If the database itself will not open** — `SQLITE_CORRUPT`, `SQLITE_NOTADB`, a
`PRAGMA integrity_check` that is not `ok` — do not try to repair it in place and
do not delete it. Move it aside, restore the most recent backup into a fresh
volume, and then run the full section 9 procedure from step 1: the restored copy
is by definition behind the chain, and the nonce-set test is what tells you by
how much.

### A damaged store is not an empty one

**This is the single most dangerous state the volume can be in, because for a
while it did not look like a state at all.**

`SQLite accepts a zero-byte file as a valid, empty database.` Open it, create
tables, no error, no warning — verified independently. So a store that had been
truncated to nothing presented as a *pristine first run*: the schema was
re-created over the damage, the keeper started with no history and no complaint,
and every window it had already settled became settleable again. A disk full
during a write, a truncating restore, a volume mounted before the file
materialised, and a bad backup all produce exactly that file.

**The store therefore has three states, not two, and `store.condition` on
`/status` and `keeper status` names which one you are in:**

| Condition | What it means | What the keeper does |
| --- | --- | --- |
| `ABSENT` | The `.db` does not exist and neither does a `-wal` or `-shm` beside it. A **genuine first run**. | Creates the schema — at a temp path, then renames it into place, so "the file exists" always means "its schema was committed" and a crash during the first start cannot leave debris that looks like corruption. |
| `HEALTHY` | The file opened, passed `PRAGMA quick_check` **and** `PRAGMA integrity_check`, and holds every table the decisions are made from. | Normal operation. `store.integrityOk` is the separate question of whether the *contents* were edited. |
| `DAMAGED` | Anything else, listed below. | **Refuses.** Read paths still work and describe the damage; every write path refuses; a `tick` makes no RPC call and exits `5`. The file is never repaired, never truncated, and never has a schema written over it. |

What is classified `DAMAGED`, and how each is detected:

| Shape | How it is caught |
| --- | --- |
| **Zero bytes** | File size, before SQLite is opened at all. No SQLite call can distinguish this from a store that was simply never written, because to SQLite it is not distinguishable. |
| **Not a SQLite database** | The 16-byte header magic `SQLite format 3\0`. Decided from the file, so you get a sentence instead of an errcode — and a file of unknown provenance is never handed to the SQL parser to find out what it is. |
| **Truncated mid-file** | The header's own page accounting (page size at bytes 16–17, page count at 28–31, trusted only when the change counter at 24–27 equals version-valid-for at 92–95) against the actual file size. Only a *shortfall* is damage: under WAL the `.db` may legitimately lag the `-wal`, which makes it larger or equal, never smaller. |
| **Corrupt pages** | `PRAGMA quick_check`, run immediately after opening and **before any DDL** — that ordering is what stops a corrupt file being written to. `PRAGMA integrity_check` runs too, because it adds the index cross-check, and the rules that refuse a replay *are* partial indexes: a store whose indexes disagree with its tables is a store whose frontier constraints may not fire. |
| **A missing table** | The presence of `schema_version`, `instance`, `record`, `settlement`, `terminal_window`, `halt`, `chain_checkpoint`. `DROP TABLE settlement` is a one-line route to an empty frontier, and it is refused rather than rebuilt. |
| **`.db` gone, `-wal` survives** | The `-wal` holds committed transactions the `.db` never received. This is not a first run: the most recent settlements are in the file that *was* left behind, and they cannot be read from it alone. |
| **`-wal` gone, `-shm` survives** | The two are created together and unlinked together. A `-shm` alone means either the write-ahead log was deleted by hand — silently rewinding the store past settlements it committed — or a crash landed in the two-syscall gap of a clean shutdown. If, **and only if**, you are certain of the second, the `-shm` holds no durable data: delete it and start again. |

There is one shape the local store genuinely cannot detect: a `-wal` deleted
after it had been checkpointed, leaving a `.db` that is internally perfect and a
few settlements stale. Nothing in the file says so. That case is caught one layer
out, by the nonce-set test in step 3 above — which is the reason that test exists
and the reason it is a **set** and not a count.

**Recovery, in order.** Do not delete the file and do not "fix" it in place;
either of those turns a caught problem into an uncaught one.

```bash
# 1. See it. Read-only, works on a store too damaged to run against, and this is
#    the whole point: an inspection command has to work during the incident it
#    exists for. Neither of these ever throws.
docker compose --profile keeper run --rm keeper status | head -20   # store.condition
docker compose --profile keeper run --rm keeper journal | head -5   # state: DAMAGED

# 2. Preserve it. It is evidence, and it may still be partially readable.
docker run --rm -v nuvem-keeper-state:/state -v "$PWD/backups:/backup" alpine \
  tar czf /backup/keeper-state-DAMAGED-$(date +%Y%m%dT%H%M%SZ).tar.gz -C /state .
```

3. **Restore the most recent good backup into a *fresh* volume** (recipe in
   section 8) — `.db`, `-wal` and `-shm` together; a `.db` restored without its
   `-wal` is a database missing its most recent settlements.
4. **If there is no backup, do not improvise: use the chain.** Point
   `NUVEM_KEEPER_STATE_DIR` at a fresh, **empty** directory and let the
   adoption path rebuild the history. `keeper recover` first, read-only, to see
   what the chain says was settled; then one dry `tick` and confirm
   `journal.counts.ADOPTED` is non-zero and `history.accounted` is `true`. This
   is section 9's step 1–4 procedure verbatim — the damaged store changes
   nothing about it except that you must not reuse the directory.
5. **Only then** re-arm broadcast, as a separate decision.

**Integrity now covers the tables the decisions are made from, not only the
record stream.** The record table is an audit log with a per-row digest; the
`settlement`, `terminal_window` and `halt` tables are what actually refuse a
double settle, and they carry no digest. So on every read the derived frontier is
reconciled against the recorded settlements: every settlement row must be backed
by the record it cites and agree with it field by field, every recorded
settlement must appear in the settlement table, every `SKIPPED` must have its
`terminal_window` row and every `DEGRADED` its `halt` row, and the live rows must
form **one** strictly increasing chain from the genesis link to the frontier.
Deleting the single settlement row for a settled window used to leave a store
whose record stream said "settled", whose frontier said "nothing is settled", and
whose `integrityOk` was `true`. It now reports `store.integrityOk: false` with
`store.condition: "HEALTHY"` — the file is sound, the contents are not — refuses
every window with `STORE_INTEGRITY`, and refuses to record any `INTENT`,
`CONFIRMED` or `ADOPTED` at all, so the guarantee does not rest on the
application rule having been consulted. `CHECKPOINT`, `SKIPPED`, `FAILED` and
`DEGRADED` still record: they move no money, and a store in this state has to
stay able to write the records that explain it.

**File modes.** The `.db`, `-wal` and `-shm` are `0600`, matching `instance.json`,
the snapshot and `keeper.lock`. SQLite creates all three itself, honouring the
process umask, so they arrived `0644` on the volume until they were tightened
explicitly. A `chmod` that fails — Windows, where the mode is advisory, and some
container storage drivers, which refuse it — **warns and continues**; it appears
as `store.permissionWarnings` on `/status`. Losing the ability to start over a
permission bit would be a worse trade than the bit is worth.

---

## 10. Railway

Not wired up. The keeper needs **its own** Railway service, and Railway config
paths are absolute from the repo root and do **not** follow Root Directory, so it
needs its own config file — `packages/keeper-old/railway.json` — with
`dockerfilePath: packages/keeper-old/Dockerfile` and its own `watchPatterns`. The
repo-root `railway.json` is the web service's and must not be repointed.

Differences that matter for this service specifically:

- **Volumes.** Railway volumes are per-service and attach at a mount path; mount
  one at `/var/lib/nuvem/keeper` and confirm it is not wiped by a redeploy before
  you go live. If you cannot get a durable volume, do not run live there.
- **No `EXPOSE`, no `HEALTHCHECK`.** Railway ignores both. If you want a health
  check, set `healthcheckPath: /health` in the keeper's own config, and note that
  Railway kills a service that fails it — which is exactly the behaviour section
  2 says `/health` must avoid triggering for a halted keeper.
- **`profiles:` does not exist on Railway.** The compose profile keeps the
  keeper out of the dashboard's everyday local commands; it was never a safety
  mechanism anywhere (section 5). On Railway, as locally, the only things
  stopping a settlement are the two broadcast gates. Deploy it dry-run first and
  leave it that way until you have watched a full cycle.
- **`restart: unless-stopped` is ignored** — use `deploy.restartPolicyType`.
- **Variables are the only secret mechanism** (no file on disk), so
  `NUVEM_ATTESTER_KEY_FILE` is not available and the inline key variables are.
  Set `NUVEM_ATTESTER_PRIVATE_KEY` and leave `NUVEM_ATTESTER_KEY_FILE` unset —
  `config.ts` prefers the file whenever that variable is non-empty, so a leftover
  value pointing at a path that does not exist there is a refusal to start, not a
  fallback. This is a real downgrade in key hygiene; weigh it against a VPS.
- **Back the volume up from inside the service**, with `VACUUM INTO` (section 8),
  since you cannot `docker run` a sidecar against a Railway volume. If you cannot
  demonstrate a restore, you do not have a backup, and section 9 is what you will
  be doing instead.

---

## 11. Troubleshooting

| Symptom | Cause |
| --- | --- |
| `ERR_PNPM_OUTDATED_LOCKFILE` during build | `pnpm-lock.yaml` predates `packages/keeper-old`. `pnpm install` at the root and commit it. `--frozen-lockfile` validates against every importer. |
| `COPY packages/keeper-old/package.json` fails | `packages/keeper-old` does not exist in the build context yet. |
| `FATAL: cannot find an entry point for @nuvem/keeper` | `bin/keeper.mts` does not exist, or `package.json` `bin`/`main` points somewhere else. Section 2. |
| Keeper typecheck fails during `docker compose build keeper` | The package's `build` script is `tsc --noEmit` and the image runs it on purpose. Fix the type error; do not remove the gate — tsx strips types without checking them. |
| `FATAL: /out/<entry> is missing after pnpm deploy` | `pnpm deploy` honours the package's `files` field; it must include the directory holding the entry point. |
| `FATAL: entry point … is TypeScript but tsx is not a dependency` | Add `tsx` to `packages/keeper-old` devDependencies (the repo pins 4.23.1), or give the package a `build` script that compiles to JS. |
| `FATAL [engine-contract]: … now declares a "files" field` | `packages/session-engine-old/package.json` gained a `files` field, so `pnpm deploy` will stop copying its `src/` and the container will die at boot. Add `"src"` to it, or give that package a subpath export plus `"declaration": true` and switch `src/engine.ts` to bare specifiers. Section 2. |
| `FATAL [engine-graph]: … imports modules that are NOT in the pruned deploy tree` | Same root cause, caught one layer later, naming the exact specifiers. If `[engine-contract]` passed and this fired, something else is filtering the deploy tree. |
| `FATAL [no-state]: keeper state artefacts are in the image tree` | A settled-window store reached the build context. **Fix `.dockerignore`, do not delete the files in the Dockerfile** — the silently-stopped-matching filter is the actual defect. Section 1. |
| `FATAL [preflight]: the keeper's module graph does not load` | The image would have died at boot. The stderr printed just above it is what the container would have said. Usual causes, in order: a relative import that escapes the package (`../../something`), `src/engine.ts` reaching into a `session-engine/src/` that is not in the deploy tree, or a runtime dependency that was pruned as a devDependency. |
| `FATAL [preflight]: … did not produce the expected 'unknown command' rejection` | `bin/keeper.mts`'s argument grammar changed. Update the sentinel and the assertion in the Dockerfile together — do not loosen the check, it is the only thing proving the runtime graph loads. |
| `FATAL: packages/contracts-artifacts/dist is missing or partial` | The committed ABIs are absent. `DEPLOYMENT_WEB.md` section 1. |
| `EACCES` writing the store | The volume is root-owned. `chown -R 1001:1001`, section 8. |
| `ExperimentalWarning: SQLite is an experimental feature` | Expected, once per process, on stderr. `node:sqlite` is experimental on Node 22 but needs no flag and no native build — measured on the pinned runtime image. Not an error; do not suppress it. Section 2 item 9. |
| `SQLITE_BUSY` / `database is locked` | Two processes on one volume. Usually a `docker compose run` left over next to the running service. `keeper.lock` is meant to catch this first — if it did not, find out why before restarting anything. |
| `SQLITE_CORRUPT` / `PRAGMA integrity_check` is not `ok` | Restore from backup into a **fresh** volume and run section 9 from step 1. Do not repair in place and do not delete the file. Very often the real cause is a backup taken by `tar`ring a live WAL database — section 8. |
| A restored backup opens clean but the keeper halts `UNACCOUNTED_SETTLEMENTS` | Working as intended. `integrity_check` proves the *file* is intact; it says nothing about whether the *history* is complete. The backup is behind the chain. Section 9. |
| Keeper starts and immediately refuses, naming a key | Working as intended. Section 4. |
| Keeper refuses to start citing `instance.json` | The volume holds state for a different chain, vault or account. **Do not delete it to make the message go away** — work out which volume you are looking at. |
| Everything is `REFUSED`, 100% of windows | Almost always `debug_traceTransaction`/callTracer missing on the endpoint: sell proceeds arrive as an internal call with no log, so `cashIn` reads zero and reconciliation fails. Section 3. |
| Reverts `InvalidAttester` | The loaded key is not `AttesterRegistry.attester()` at the current epoch. |
| Reverts `ContributionBelowMinimum` | Realized profit was non-positive, or the contribution is under `minContributionWei`. Correct behaviour, not a failure — an attestable session can be unprofitable. |
| Reverts `NonProgressiveBlockRange`, or a tick reports `L1_RANGE_COLLAPSED` | Two distinct L2 sessions collapsed into one L1 block. **When the keeper reports it as `L1_RANGE_COLLAPSED`, real savings were forfeited** — the log line names the wei — and it is not a duplicate being caught. The keeper distinguishes the two by its own L2-space record: an overlap in L2 as well as L1 is a replay (`ALREADY_SETTLED`); a window that is above the last settled `endBlockL2` but at or below the last settled `endBlockL1` is a new session the vault can never accept, because the attestation commits an L1 range only. The only sanctioned remedy is offering the **merged** window to `buildSessionReport` and settling it if it is `ATTESTABLE` on its own merits. Never invent a boundary. A real fix needs the attestation schema to carry the L2 range — a contract change. |
| Reverts `InvalidBlockRange` | L1/L2 conflation. The attestation's `startBlock`/`endBlock` are **L1**; the engine works in **L2**. On this chain `block.number` in Solidity is the **L1** number and it is millions of blocks **ABOVE** the L2 number (3,551,127 above on 2026-07-29). **The gap is not a constant** — L2 advances far faster than L1, so it grew by roughly 2.65M in a single day. Never store an offset and add it: read `l1BlockNumber` off each L2 block, as `packages/aa-smoke-old/scripts/settle.mjs` does and as the engine does per boundary. This has bitten this project for real. |
| A tick reports `DEGRADED` with `COLD_START_UNACCOUNTED` or `UNACCOUNTED_SETTLEMENTS` | The chain reports settled nonces this journal cannot name. Working as intended — section 9. Do not delete the journal, and do not acknowledge it to make it go away. |
| A tick reports `DEGRADED` with `REVERT_BREAKER` | Three consecutive settles reverted. Each one cost real gas. Read the `FAILED` and `SKIPPED` records at the tail of the journal, fix the cause, then `--acknowledge-degraded <seq>`. |
| A tick reports `DEFERRED` with `REVERT_BACKOFF` | A settle for this window reverted and the keeper is waiting out an exponential backoff (60s, doubling, capped at 30 minutes) before trying again. Two reverts for one window and it is abandoned as terminal instead. |
| Reverts `InvalidSettlementNonce` | Something else settled — probably a manual `settle.mjs` run. This is a compare-and-swap failing safe, not a lost race. Let recovery adopt it. |
| Reverts `AttestationExpired` | The deadline passed before mining. Never rebroadcast the same raw tx and never re-sign the same attestation with more gas — build a fresh one, which yields the same `sessionId` and so cannot double-settle. Twice in a row means the gas policy is wrong. |
| `docker compose config` errors with the profile off | Something in the keeper block uses `${VAR:?}`. Compose interpolates the whole file before applying profiles, so that breaks the web service too, for everyone. Use `:-` and validate in the keeper. |
| `docker stop` waits 10s | PID 1 is not passing SIGTERM. The image uses `tini -g` and the generated launcher `exec`s; if you edited either, preserve both. |
