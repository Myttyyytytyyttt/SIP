# Runbook: deploying `@sip/web` and `@sip/worker`

Two services, two images, one build context — the repository root, for both.

- **`@sip/web`** (`packages/website-oficial`) is the site: the dashboard, and
  `/wallets`, where a user creates a vault and binds the trading wallet whose
  volume gets skimmed. It holds **no signing key of any kind**. Every write is
  signed by the user's own wallet through Privy.
- **`@sip/worker`** (`packages/worker`) is the observer, the attester and the
  puller. It is the only thing here that can move money, and it is **dry run by
  default** — structurally, not by convention. See section 8.

Files this runbook covers:

| Path | Purpose |
| --- | --- |
| `packages/website-oficial/Dockerfile` | Multi-stage web image. Build context is the **repo root**. |
| `packages/worker/Dockerfile` | The worker image. Also built from the repo root. |
| `.dockerignore` | Repo root. Keeps `.env*` and the Solidity toolchain out of the context. |
| `docker-compose.yml` | Repo root. Local dev and plain-VPS deploys. Railway does not execute it. |
| `railway.json` | Repo root. Describes the **web** service on Railway; the worker is a second service. |

---

## 1. The Foundry problem — read this before your first build

**Foundry is not installed in either image, and it cannot be.** Both get their
ABIs from `packages/contracts-artifacts/dist/`, which is **committed to git**.

That is not a stylistic choice. Neither script in that package can run inside a
clean container:

- `pnpm build` shells out to `forge build`. There is no `forge` binary in the
  image.
- `pnpm build:from-out` (`--skip-forge`) **does not mean "build without
  Foundry."** It skips only the `forge build` subprocess. It still reads every
  artifact from `packages/contracts/out/<File>.sol/<Name>.json`, and
  `packages/contracts/out/` is gitignored and excluded from the build context.
- Worse: `scripts/export-artifacts.mjs` deletes `dist/` **before** it reads a
  single forge artifact. So running it defensively over a good `dist/` destroys
  it and *then* fails. It also imports `viem`, a devDependency, so it cannot run
  under a production install.

**Therefore: never invoke the artifacts build inside an image.** The `artifacts`
stage of the web Dockerfile only *validates* what it was given — `dist/index.js`,
`dist/index.json`, all eight contract JSONs, and that `index.json` lists eight
contracts — and fails the build with instructions if anything is missing.

### Regenerating `dist/` (host-side, needs Foundry)

```bash
pnpm --dir packages/contracts-artifacts build           # recompile and re-export
pnpm --dir packages/contracts-artifacts build:from-out  # skip forge; needs out/ present
git add packages/contracts-artifacts/dist
```

`.gitignore` has a deliberate exception for this directory. Order matters there:
git will not descend into an excluded directory, so `!…/dist/` must precede
`!…/dist/**`.

### Guard against drift

The export is deterministic — the script sorts every record and validates
ABI-derived selectors against forge's `methodIdentifiers` — so a committed
`dist/` can be checked on any Foundry-equipped runner:

```bash
pnpm --dir packages/contracts-artifacts build
git diff --exit-code packages/contracts-artifacts/dist
```

Add that to CI. A stale `dist/` means the site decodes vault state with the wrong
ABI: a silent-wrong-answer failure, not a crash. The site's own
`pnpm check:abis` is the second half of the same guard — it compares all 69
fragments in `src/lib/abi.ts` against the artifacts package byte for byte, and it
runs as `prebuild`, so a `next build` cannot succeed against drifted ABIs.

---

## 2. Secrets

**No secret is ever baked into an image.** Everything is injected at runtime.

`.dockerignore` excludes `.env`, `.env.*`, `**/.env*` and re-includes only
`.env.example`, along with key-shaped files by name and by extension. This
matters more than it looks: a `COPY . .` over a context containing a key writes
it into an image layer, where it survives a later `RUN rm` and can be recovered
by anyone who pulls the image. If you ever change `.dockerignore`, re-check the
context:

```bash
docker build --no-cache -f - . <<'EOF'
FROM busybox
COPY . /ctx
RUN find /ctx -name '.env*' ! -name '.env.example' | grep . && exit 1 || echo "clean"
EOF
```

The site needs no private key. It makes `eth_call`s, and for `createVault` it
builds a transaction the user's own wallet signs through Privy. If you find
yourself adding a signing key to the web service, you are building the worker —
stop, and put it in the worker's environment instead.

The worker's secrets are **runtime environment only, never a build `ARG`**: build
args are recorded in image history and no later layer removes them.

---

## 3. The web image: environment variables

The image is **environment-agnostic**. No `NEXT_PUBLIC_*` value is baked in, so
one image runs unchanged locally, on a VPS and on Railway. Changing the RPC
endpoint is a restart, not a rebuild.

### Required

| Variable | Notes |
| --- | --- |
| `NUVEM_RPC_URL` | Chain 4663 JSON-RPC. **Server-side only.** It carries an API key; never expose it as `NEXT_PUBLIC_*`, or that key ships to every browser. |
| `NUVEM_VAULT_FACTORY` | The VaultFactory address. **No default, on purpose** — see section 9. Everything else about the protocol is read from `VaultFactory.protocolConfiguration()` at runtime. |
| `PRIVY_APP_ID` | See section 4. You must obtain this yourself. |

### Optional

| Variable | Notes |
| --- | --- |
| `PRIVY_SIGNER_ID`, `PRIVY_POLICY_ID` | The seat and the policy that bounds it. **Both or neither** — a signer with no policy is full permission at Privy, so the server refuses half a pair rather than degrading. Unset means wallets are created without a seat, and the page says so. |
| `NUVEM_PUBLIC_RPC_URL` | The endpoint handed to the *user's* wallet. Leave it unset and the app relays through its own same-origin `/api/rpc` instead, keeping the API key server-side. Whatever you put here is visible to the user. |
| `DATABASE_URL` | The worker's Postgres, read by `GET /api/skims`. Without it the skim figures render "Status unavailable" and the rest of the page is unaffected. |
| `NUVEM_CHAIN_ID`, `NUVEM_EXPLORER_URL`, `NUVEM_LOGS_FROM_BLOCK`, `NUVEM_COHORT_ID` | Defaults documented in `packages/website-oficial/.env.example`. |

Every `NUVEM_*` name also accepts a `SIP_*` spelling and several other aliases;
`packages/website-oficial/.env.example` lists them per variable and is the
authority.

### Set by the platform

| Variable | Notes |
| --- | --- |
| `PORT` | The image defaults to `3000`. **Railway injects its own and that wins** — required, because Railway does not read `EXPOSE`. See the port note in section 6. |
| `HOSTNAME` | `0.0.0.0` in the image. Must not be `127.0.0.1`, or the platform cannot reach the container. |

### Two things `packages/website-oficial` must keep providing

1. **`GET /api/health`** returning `200` and **making no RPC call** — it returns
   a static object and touches nothing that can be down. Both the image's
   `HEALTHCHECK` and Railway's `healthcheckPath` probe it. A health check that
   pings the chain turns an RPC hiccup into a restart loop.
2. **`next.config.mjs` must set both:**
   ```js
   output: "standalone",
   outputFileTracingRoot: path.join(import.meta.dirname, "../../"),
   ```
   `outputFileTracingRoot` is a **top-level** key in Next 15/16, not under
   `experimental`. Without it the trace root defaults to
   `packages/website-oficial`, and `@nuvem/contracts-artifacts` — reached through
   a pnpm symlink pointing *outside* that directory — is silently omitted from
   the traced output. The build succeeds, the container starts, and the first
   request throws `MODULE_NOT_FOUND`. The Dockerfile prints a loud warning if it
   detects the wrong trace root, and hard-fails on any dangling symlink in the
   standalone tree.

Do the contract reads **server-side** and send only decoded results to the
browser. Beyond keeping the RPC URL secret: `contracts-artifacts/dist/index.js`
is a single frozen object holding all eight contracts *including bytecode*, with
every named export aliasing into it, so it is un-tree-shakeable — importing one
contract retains all eight.

---

## 4. Privy — you have to set this up yourself

**There is no project-provided Privy app id.**

1. Go to **https://dashboard.privy.io**, sign in, create an app, copy the **App
   ID** (25 characters; `@privy-io/react-auth` throws on any other length, which
   500s every page).
2. **Login methods → enable "Wallet".** Skip this and the login modal opens with
   no wallet option and no console error — it just looks broken.
3. **App settings → Domains → Allowed origins:** add `http://localhost:3002`
   (the port is mandatory, Privy will not infer it) and your production origin.
   HTTPS is required for anything that is not localhost. That list is the only
   thing stopping someone else using your app id, so treat it as a security
   control.
4. **Embedded wallets → execution mode: TEE** ("user-controlled server
   wallets"). Importing a trading wallet with a seat only works in TEE mode; in
   on-device mode no signer is attached and the page says so.
5. Add **chain 4663** as a supported chain, and keep external wallet connection
   enabled — a trader arrives with an EOA they already use.

The app id is **public by design**. The Privy **app secret** is a different
value: the site's configuration does not read it, and it belongs to the worker.

---

## 5. Local development (no Docker)

```bash
pnpm install
cp packages/website-oficial/.env.example packages/website-oficial/.env.local
$EDITOR packages/website-oficial/.env.local
pnpm dev            # http://localhost:3002
```

`next dev` loads `.env.local` itself. The production standalone server does not
load any file, and `.dockerignore` keeps `.env*` out of the image on purpose, so
a deployment must supply real environment variables.

Never run the root `pnpm build` without Foundry — its first step is `forge
build`. Use `pnpm --dir packages/website-oficial verify` for the site alone
(ABI check, typecheck, real build).

---

## 6. Local Docker

`docker-compose.yml` defines both services and shares the chain settings between
them through the `x-chain-env` anchor, which is also the canonical list of what
to mirror into Railway by hand.

> **The env-file flag is not optional.** Compose uses a file listed under
> `env_file:` only to populate the *container's* environment. The `${VAR:?…}`
> placeholders in `docker-compose.yml` are *interpolation*, resolved while the
> file is parsed — from your shell or from a compose env-file, never from
> `env_file:`. A bare `docker compose up` aborts with "required variable … is
> missing a value" even with the file sitting right there.

```bash
cat > .env.docker <<'EOF'
NUVEM_RPC_URL=https://…
NUVEM_VAULT_FACTORY=0x…
NUVEM_SETTLEMENT_EXECUTOR=0x…
PRIVY_APP_ID=…
SIP_RPC_URLS=https://…
SIP_LOGS_FROM_BLOCK=…
EOF
chmod 600 .env.docker
export COMPOSE_ENV_FILES=.env.docker      # once per shell

docker compose build
docker compose up -d
docker compose logs -f
```

Without the export, pass `--env-file .env.docker` to **every** invocation,
including `config` and `ps`, which parse the same placeholders.

Two things to know before the first `up`:

- **Interpolation covers the whole file, before anything is filtered.** The
  worker service's `${SIP_RPC_URLS:?}`, `${NUVEM_VAULT_FACTORY:?}`,
  `${NUVEM_SETTLEMENT_EXECUTOR:?}` and `${SIP_LOGS_FROM_BLOCK:?}` therefore abort
  `config`, `up` and `ps` for the **web** service too if they are unset. Set them
  or edit them out; there is no way to interpolate half a file.
- **A bare `docker compose up` starts the worker.** It is not gated behind a
  profile. That is safe — without `SIP_WORKER_ALLOW_BROADCAST` it holds no
  signing material at all — but it will start ticking, so point it at an RPC you
  are willing to spend requests on.

The compose file publishes and probes port **3002** for the web service, while
the image's own default is `PORT=3000`. Set `PORT: 3002` in the service's
`environment:` (or map `"3002:3000"`) so the mapping, the health check and the
listening socket agree — a container that is up but permanently unhealthy, with
a refused connection on the published port, is this mismatch.

Equivalent without compose — note `-f` plus the trailing `.`, because the context
is the repo root:

```bash
docker build -f packages/website-oficial/Dockerfile -t sip-web:local .
docker run --rm --init -p 3000:3000 \
  -e NUVEM_RPC_URL="https://…" \
  -e NUVEM_VAULT_FACTORY="0x…" \
  -e PRIVY_APP_ID="…" \
  sip-web:local
```

Compose also auto-loads the repo-root `.env` for `${…}` interpolation, so
`docker compose config` prints resolved values to your terminal — do not paste
that output into a ticket. Interpolation is not injection: nothing from `.env`
enters the image, and only the variables named in `docker-compose.yml` reach a
container.

Useful checks:

```bash
docker compose config                                          # validate, see resolved values
docker build --check -f packages/website-oficial/Dockerfile .  # lint, no build
docker compose ps                                              # health status
```

---

## 7. VPS with compose

Same file, one host.

```bash
git clone https://github.com/Myttyyytytyyttt/SIP.git && cd SIP
# Confirm the committed ABIs came along -- the build fails loudly without them.
ls packages/contracts-artifacts/dist/artifacts/

install -m 600 /dev/null .env.docker
$EDITOR .env.docker
export COMPOSE_ENV_FILES=.env.docker

docker compose build
docker compose up -d
```

- **`.env.docker` must be `chmod 600`** and owned by the deploying user. On a VPS
  you are the secret manager; nothing does it for you.
- **TLS is yours.** Put Caddy, Traefik or nginx in front and terminate there. Do
  not publish the web port to the internet directly; if you add a reverse proxy
  to the compose file, drop the `ports:` block and put both on the same network.
- `restart: unless-stopped` plus the image `HEALTHCHECK` makes an unhealthy
  container *visible* in `docker compose ps`, but compose does **not** restart on
  unhealthy by itself. Watch it, or add a supervisor.
- Redeploy: `git pull && docker compose build && docker compose up -d`.
- Rollback: tag by commit — `docker build -t sip-web:$(git rev-parse --short
  HEAD)` — so a rollback is a tag change rather than a rebuild from an older
  checkout.

---

## 8. The worker as a second service

`packages/worker/Dockerfile`, built from the repo root like the web image. Its
build gate is `pnpm --dir packages/worker typecheck`, so a type error cannot
reach a deployed image; it runs from TypeScript through `tsx`, as a non-root
`sip` user.

Two entry points:

- `pnpm --dir packages/worker worker` — the image's `CMD`. Loops every
  `SIP_POLL_MS` (default five minutes), skipping a tick while the previous one is
  still running.
- `pnpm --dir packages/worker tick` — one pass, prints a `TickSummary` as JSON,
  exits. That is the shape a cron-style platform wants.

### Dry run is the default and it is structural

The process reads **no signing secret at all** unless
`SIP_WORKER_ALLOW_BROADCAST` equals

```
i-understand-this-moves-real-funds
```

byte for byte. `true`, `1`, `yes`, or the same sentence with a trailing newline
all keep you in dry run — deliberately, because those are what a human writes
when they mean the opposite. In dry run `SIP_ATTESTER_PRIVATE_KEY`,
`PRIVY_APP_SECRET` and `PRIVY_AUTHORIZATION_PRIVATE_KEY` are deleted from the
environment by name without their values ever being read, so an image started
without the sentence *cannot* broadcast, whatever else is in its environment.

A dry-run pass still does everything else: discovery, scanning, reconciliation,
window closing, the attestation against live vault state, and a log line for the
pull it would have made, with amounts. Run it that way first, and read that line,
before arming anything.

### Its environment

| Variable | Notes |
| --- | --- |
| `SIP_RPC_URLS` | Comma-separated, preferred first. Must be archive-capable and range-uncapped; a free-tier key caps `eth_getLogs` at ten blocks and discovery becomes impossible. |
| `SIP_CHAIN_ID`, `SIP_VAULT_FACTORY`, `SIP_SETTLEMENT_EXECUTOR`, `SIP_LOGS_FROM_BLOCK` | All **required**. There is no fallback and the process refuses to start without them — section 9. |
| `SIP_DATABASE_URL` / `DATABASE_URL` | The ledger. Optional for a dry run, mandatory live: a worker that broadcasts must remember what it sent. |
| `SIP_WORKER_ALLOW_BROADCAST` | The exact sentence above, or nothing. |
| `SIP_ATTESTER_PRIVATE_KEY` | Live only. The key registered in `AttesterRegistry`; it signs volume attestations and holds no funds. |
| `PRIVY_APP_ID`, `PRIVY_APP_SECRET`, `PRIVY_AUTHORIZATION_PRIVATE_KEY`, `PRIVY_SIGNER_ID` | Live only. The seat through which a trading wallet pays its own skim — the worker never holds that wallet's key. |
| `SIP_POLL_MS`, `SIP_MAX_LOG_SPAN` | Tuning. The defaults live in `DEFAULTS` in `packages/worker/src/config.ts`. |

The worker serves no HTTP, so it has no health endpoint and needs no
`healthcheckPath` on a platform that offers one. Liveness is its heartbeat log
line.

---

## 9. No deployment exists yet

Neither service will do anything useful until the contracts are deployed, and
both refuse rather than guess:

- `packages/worker/src/config.ts` requires the factory, the executor and the
  start block; `packages/worker/src/chain/constants.ts` pins chain facts only —
  WETH, the GMGN router, the v4 PoolManager, the log topics — and no deployment.
- the site has no default factory either, and `/wallets` shows a setup checklist
  without one.

The reason those defaults were removed instead of updated: an earlier deployment
on chain 4663 is **abandoned**, and its trading accounts — read from chain on
2026-09-08, all eighteen active — carry a savings rate of 1000 to 3000 bps
meaning a *percentage of profit*. Phase 0 applies that same rate to the
attestation's cash field, which in this product carries a *volume*. A worker
aimed at it would skim roughly a hundred times what a user agreed to, on
somebody else's wallet. A startup refusal is the cheap version of that mistake.

When you do deploy, three things move together: the addresses in the environment
of both services, and **the Privy policy**, which pins the executor's address and
must be updated to the new one before any pull can succeed. The scripts that
created and updated it were deleted with the old backend; do it in the Privy
dashboard or through Privy's API. See [SETUP.md](SETUP.md) §7 for the app, quorum
and policy ids that exist today.

---

## 10. Railway

Railway builds from git, in the repo root, using a Dockerfile. It **does not**
execute `docker-compose.yml` — it can *import* one, converting each service into
a Railway service, but the compose file is not the deployment description. Keep
the two in sync by hand; that is what `x-chain-env` is for.

### The web service

1. Create a project, connect the repo.
2. **Leave Root Directory at the repo root.** Setting it to
   `packages/website-oficial` leaves the build context without
   `pnpm-lock.yaml`, `pnpm-workspace.yaml` and `packages/contracts-artifacts` —
   everything the install needs. This is the single most common way to break this
   deployment.
3. `railway.json` already sets `builder: DOCKERFILE`, `dockerfilePath:
   packages/website-oficial/Dockerfile`, `healthcheckPath: /api/health` and an
   `ON_FAILURE` restart policy. Railway otherwise looks for a file named
   literally `Dockerfile` at the source root, which is not where ours lives, so
   the explicit path matters. Values in `railway.json` **override the
   dashboard**, and the dashboard is not written back. There is deliberately no
   `startCommand`, so Railway and compose run the identical `CMD`.
4. Set service **Variables**: section 3's list. Railway has no `.env` file on
   disk; variables are the only mechanism.
5. Generate a domain, then add it to Privy's allowed origins (section 4).

### The worker service

A second Railway service on the same repo, with **Root Directory still at the
repo root** and `RAILWAY_DOCKERFILE_PATH=packages/worker/Dockerfile` as a service
variable — `railway.json` describes the web service, and config file paths are
absolute from the repo root, so they do not follow a per-service root directory.
Give it section 8's variables, no health check, and leave
`SIP_WORKER_ALLOW_BROADCAST` unset until a dry run has been read line by line.

### Things that will bite you

- **`PORT`.** Railway injects it and the app must listen on it, bound to
  `0.0.0.0`. Railway ignores `EXPOSE` entirely. Next's standalone server reads
  `PORT` and `HOSTNAME` itself and a runtime `PORT` overrides the image default,
  so this works unchanged. If health checks still fail with everything else
  correct, the known fallback is binding `::` — Railway's edge reaches containers
  over IPv6, and `0.0.0.0` is IPv4-only.
- **Build-time variables need an explicit `ARG`.** Railway injects build
  variables only into stages that declare them. The only one declared is
  `NEXT_PUBLIC_PRIVY_APP_ID`, and you should normally leave it unset: setting it
  inlines the id into the client bundle and makes the image environment-specific.
- **Committed `dist/` is mandatory here.** Building the artifacts on a host and
  injecting them with `docker build --build-context` works on a VPS but is
  impossible on Railway — there is nowhere to inject from.

| | Railway | VPS + compose |
| --- | --- | --- |
| Compose file | not executed (import-only) | is the deployment |
| `depends_on` | ignored — apps must retry on startup | honoured |
| `ports:` | no port-mapping layer; services talk on real app ports | explicit `host:container` |
| Service-to-service | `<name>.railway.internal`, IPv6 | `http://web:<port>` on the bridge network |
| `restart:` | not honoured — use the restart policy | `restart: unless-stopped` |
| Secrets | Railway Variables, no file on disk | `.env.docker`, `chmod 600`, yours to protect |
| TLS + domains | edge terminates, certs managed | you run Caddy/Traefik/nginx |

---

## 11. Troubleshooting

| Symptom | Cause |
| --- | --- |
| `FATAL: packages/contracts-artifacts/dist is missing or partial` | The committed ABIs are absent from the context. Section 1. |
| `[web] ABI check failed` during build | `src/lib/abi.ts` has drifted from the artifacts. Re-copy the fragment; never relax the check. |
| `ERR_PNPM_OUTDATED_LOCKFILE` during build | Run `pnpm install` at the root and commit the lockfile. |
| `MODULE_NOT_FOUND` for `@nuvem/contracts-artifacts` at first request | `outputFileTracingRoot` is not the repo root. Section 3. |
| `FATAL: dangling symlinks in the standalone output` | pnpm's symlinked store leaked links pointing outside the trace root. Fix `outputFileTracingRoot` first. |
| `FATAL: … does not exist. …must set output: "standalone"` | Exactly that. |
| Page renders unstyled, `/_next/static/*` 404s | `.next/static` did not land beside the entrypoint. The Dockerfile copies it explicitly; re-check that block if you edited it. |
| `EACCES` writing `.next/cache` | The cache directory is not owned by `nextjs`. The runner stage `chown`s it; preserve that. |
| `docker compose up` aborts on a missing variable while you only wanted `web` | Interpolation covers the whole file, worker service included. Section 6. |
| Container up but permanently unhealthy, connection refused on 3002 | `PORT` mismatch between the compose service and the image default. Section 6. |
| Railway: "Application failed to respond" | Not listening on the injected `PORT`, or bound to localhost. Section 10. |
| Container ignores `docker stop` for 10s | PID 1 is not receiving SIGTERM. The web image `exec`s node so it does; if a service you added does not, add `init: true` in compose or `--init` to `docker run`. |
| Worker exits immediately naming a variable | It is refusing to start rather than guessing. Section 9. |
| Worker runs, logs a pull, nothing happens on chain | It is in dry run, which is the default. Section 8. |
