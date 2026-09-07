# Runbook: deploying `@nuvem/web`

The dashboard. Connect with Privy, create a vault if you do not have one, otherwise
see your vault, your trading accounts, and whether each account is correctly
configured. **This milestone is read-only plus `createVault`.** There is no settle
button and the dashboard holds no signing key of any kind.

The attester/keeper now exists as a separate, profile-gated compose service with
its own image — see `docs/runbooks/ATTESTER.md` and section 9. Nothing described
below builds, starts, or depends on it, and `docker compose up` does not touch it.

Files this runbook covers:

| Path | Purpose |
| --- | --- |
| `packages/web/Dockerfile` | Multi-stage image. Build context is the **repo root**. |
| `.dockerignore` | Repo root. Keeps `.env*` and 200 MB of Solidity toolchain out of the context. |
| `docker-compose.yml` | Repo root. Local dev and plain-VPS deploys. Not used by Railway. |
| `railway.json` | Repo root. Tells Railway to use the Dockerfile and where the health check lives. |

---

## 1. The Foundry problem — read this before your first build

**Foundry is not installed in the container, and it cannot be.** The web image gets
its ABIs from `packages/contracts-artifacts/dist/`, which is **committed to git**.

That is not a stylistic choice. Neither script in that package can run inside a
clean container:

- `pnpm build` shells out to `forge build`. No `forge` binary in the image.
- `pnpm build:from-out` (`--skip-forge`) **does not mean "build without Foundry."**
  It skips only the `forge build` subprocess. It still reads every artifact from
  `packages/contracts/out/<File>.sol/<Name>.json`, and `packages/contracts/out/` is
  gitignored (`.gitignore:8`) and excluded from the build context.
- Worse: `scripts/export-artifacts.mjs` calls `rmSync(distRoot, {recursive:true,
  force:true})` **before** it reads a single forge artifact. So running it
  defensively over a good `dist/` deletes it and *then* fails. The script also
  imports `viem`, a devDependency, so it cannot run under a production install.

**Therefore: never invoke the artifacts build inside the image.** The `artifacts`
stage of the Dockerfile only *validates* what it was given — it checks
`dist/index.js`, `dist/index.json`, all 8 contract JSONs, and that `index.json`
lists 8 contracts — and fails the build with instructions if anything is missing.

### Regenerating `dist/` (host-side, needs Foundry)

```bash
# Normal path: recompiles and re-exports.
pnpm --dir packages/contracts-artifacts build

# If packages/contracts/out/ is already populated (forge build has run) and you
# want to skip recompiling. Still requires out/ to be present on disk.
pnpm --dir packages/contracts-artifacts build:from-out

git add packages/contracts-artifacts/dist
```

`.gitignore` has a deliberate three-line exception for this directory (the bare
`dist/` rule still hides every other package's output). Order matters there: git
will not descend into an excluded directory, so `!.../dist/` must precede
`!.../dist/**`.

### Guard against drift

The export is deterministic — the script sorts every record and validates
ABI-derived selectors against forge's `methodIdentifiers` — so a committed `dist/`
can be checked in CI on a Foundry-equipped runner:

```bash
pnpm --dir packages/contracts-artifacts build
git diff --exit-code packages/contracts-artifacts/dist
```

Add that to CI. A stale committed `dist/` means the dashboard decodes vault state
with the wrong ABI, which is a silent-wrong-answer failure, not a crash.

---

## 2. Secrets

**No secret is ever baked into the image.** Everything is injected at runtime.

`.env` and `.env.mainnet` in this repo hold real private keys —
`DEPLOYER_PRIVATE_KEY`, `NUVEM_ATTESTER_PRIVATE_KEY`,
`TRADING_OWNER_PRIVATE_KEY`, and the drill keys. Before `.dockerignore` existed,
any `COPY . .` would have written them into an image layer, where they survive a
later `RUN rm` and can be recovered by anyone who pulls the image. The
`.dockerignore` excludes `.env`, `.env.*`, `**/.env*` and re-includes only
`.env.example`.

Verified empirically: the build context is 3.7 MB and contains zero dotenv files.
If you ever change `.dockerignore`, re-check with:

```bash
docker build --no-cache -f - . <<'EOF'
FROM busybox
COPY . /ctx
RUN find /ctx -name '.env*' ! -name '.env.example' | grep . && exit 1 || echo "clean"
EOF
```

The dashboard needs no private key of any kind. It makes `eth_call`s and, for
`createVault`, builds a transaction the user's own wallet signs through Privy. If
you ever find yourself adding a signing key to the web service, you are building
the keeper — stop, and put it in the next milestone.

---

## 3. Environment variables

The image is **environment-agnostic**: no `NEXT_PUBLIC_*` values are baked in, so
one image runs unchanged locally, on a VPS, and on Railway. Changing the RPC
endpoint is a restart, not a rebuild.

### Required

| Variable | Example | Notes |
| --- | --- | --- |
| `NUVEM_RPC_URL` | `https://…` | Robinhood Chain RPC. **Server-side only.** Never expose as `NEXT_PUBLIC_*`; if it carries an API key, that key would ship to every browser. The repo `.env` has `RH_TESTNET_RPC_URL`, which is a *testnet* endpoint and is not this variable — set this one explicitly for the chain you mean. |
| `PRIVY_APP_ID` | `clx…` | See section 4. You must obtain this yourself. |

### Chain constants (defaults are mainnet; override per environment)

| Variable | Default |
| --- | --- |
| `NUVEM_CHAIN_ID` | `4663` |
| `NUVEM_VAULT_FACTORY` | `0xDf411fdCc7C31e4F6bCa6F6BCaB40FE812Ab4A46` |
| `NUVEM_SETTLEMENT_EXECUTOR` | `0xCe676c73bd9fb76a73058EC135106b81A5ABd0f5` |
| `NUVEM_WETH` | `0x0bd7d308f8e1639fab988df18a8011f41eacad73` |
| `NUVEM_PAUSE_CONTROLLER` | `0x2dbbc211dbfe0f15e88e5388c96530f2721baefc` |
| `NUVEM_ATTESTER_REGISTRY` | `0x2a3309931a6db1e1b253224551912566d647f921` |

The factory address comes from `docs/canary/MAINNET_SETTLEMENT_RESULTS.md:17`.
These addresses are currently hardcoded in `packages/aa-smoke-old/scripts/settle.mjs`
lines 35-39; moving them to env is tracked work, and the compose file's
`x-chain-env` anchor is the canonical list to migrate toward.

### Runtime, set by the platform

| Variable | Notes |
| --- | --- |
| `PORT` | Defaults to `3000` in the image. **Railway injects its own and that wins** — required, Railway does not read `EXPOSE`. |
| `HOSTNAME` | `0.0.0.0` in the image. Must not be `127.0.0.1` or the platform cannot reach the container. |

### Two things `packages/web` must provide for this setup to work

1. **`GET /api/health`** returning `200`, with `export const dynamic =
   "force-dynamic"`, and **no RPC call in it**. Both the Docker `HEALTHCHECK` and
   Railway's `healthcheckPath` probe it. A health check that pings the chain turns
   an RPC hiccup into a restart loop.
2. **`next.config.*` must set both:**
   ```js
   output: "standalone",
   outputFileTracingRoot: path.join(import.meta.dirname, "../../"),
   ```
   `outputFileTracingRoot` is a **top-level** key in Next 15/16, not under
   `experimental`. Without it the trace root defaults to `packages/web`, and
   `@nuvem/contracts-artifacts` — reached through a pnpm symlink pointing *outside*
   that directory — is silently omitted from the traced output. The build succeeds,
   the container starts, and the first request throws `MODULE_NOT_FOUND`. The
   Dockerfile prints a loud warning if it detects the wrong trace root, and it also
   hard-fails the build on any dangling symlink in the standalone tree.

Do the contract reads **server-side** (route handlers or server components) and send
only decoded results to the browser. Two reasons beyond keeping the RPC URL secret:
`contracts-artifacts/dist/index.js` is a single 388 KB frozen object holding all
eight contracts *including creation and deployed bytecode*, with every named export
aliasing into it, so it is completely un-tree-shakeable — importing one contract
retains all eight. And server-side reads mean no `NEXT_PUBLIC_*` build args, which
is what keeps one image usable everywhere.

---

## 4. Privy app id — you have to get this yourself

**There is no Nuvem-provided Privy app id, and one cannot be generated for you.**

1. Go to **https://dashboard.privy.io** and sign in (or create an account).
2. Create an app.
3. Copy the **App ID** from the app's settings.
4. In that dashboard, configure the app for this deployment:
   - add each origin you will serve from to the allowed origins /
     allowed domains list — `http://localhost:3000` for local work, plus your
     Railway domain or VPS domain;
   - add **Robinhood Chain, chain id 4663** as a supported chain, with
     `NUVEM_RPC_URL` as its RPC;
   - enable external wallet connection. Traders use an ordinary EOA on GMGN, so
     the flow must support connecting an existing wallet, not only embedded
     wallets.
5. Provide it as `PRIVY_APP_ID` at runtime (see the sections below).

The app id is **public by design** — it ships to the browser and is not a secret.
The Privy **app secret** is a different value: the dashboard does not need it, so do
not put it in this service at all.

---

## 5. Local development (no Docker)

Fastest loop. Docker is for shipping, not for iterating.

```bash
pnpm install
# One-time, and only if packages/contracts-artifacts/dist is absent (needs forge):
pnpm --dir packages/contracts-artifacts build

export NUVEM_RPC_URL="https://…"
export PRIVY_APP_ID="clx…"
pnpm --filter @nuvem/web run dev
```

Never run the root `pnpm build` or root `pnpm test` if you do not have Foundry —
their first step is `forge build`.

---

## 6. Local Docker

`.env.docker` is uncommitted and holds the two values that have no safe default.

> **The flag is not optional.** Compose uses a file listed under `env_file:` only
> to populate the *container's* environment. The `${PRIVY_APP_ID:?…}` and
> `${NUVEM_RPC_URL:?…}` placeholders in `docker-compose.yml` are *interpolation*,
> which is resolved while the file is being parsed — from your shell or from a
> compose env-file, never from `env_file:`. Run a bare `docker compose up` and it
> aborts with "required variable PRIVY_APP_ID is missing a value" even though
> `.env.docker` sits right there containing it. Verified on Compose v2.40.3.

Export once per shell, then every ordinary command works:

```bash
export COMPOSE_ENV_FILES=.env.docker
```

```bash
cat > .env.docker <<'EOF'
NUVEM_RPC_URL=https://…
PRIVY_APP_ID=clx…
EOF

docker compose build web
docker compose up -d
docker compose logs -f web
# http://localhost:3000
```

Without the export, pass `--env-file .env.docker` to **every** invocation
(`docker compose --env-file .env.docker up -d`) — including `config` and `ps`,
which parse the same placeholders.

`WEB_PORT=8080 docker compose up -d` to publish elsewhere. The container always
listens on 3000 internally.

Equivalent without compose — note `-f` plus the trailing `.`, because the context
is the repo root:

```bash
docker build -f packages/web/Dockerfile -t nuvem-web:local .
docker run --rm --init -p 3000:3000 \
  -e NUVEM_RPC_URL="https://…" \
  -e PRIVY_APP_ID="clx…" \
  nuvem-web:local
```

Compose also auto-loads the repo-root `.env` for `${...}` *interpolation*. That is
convenient, but it means `docker compose config` will print resolved values to your
terminal — do not paste that output into a ticket. Interpolation is not injection:
nothing from `.env` enters the image, and only the variables named explicitly in
`docker-compose.yml` reach the container.

Useful checks:

```bash
docker compose config                       # validate + see resolved values
docker build --check -f packages/web/Dockerfile .   # lint the Dockerfile, no build
docker compose ps                           # health status
docker compose exec web sh -c 'echo $PORT'  # confirm the port the server bound
```

---

## 7. VPS with compose

Same file, one host.

```bash
git clone <repo> && cd Nuvem
# Confirm the committed ABIs came along -- the build fails loudly without them.
ls packages/contracts-artifacts/dist/artifacts/

install -m 600 /dev/null .env.docker
$EDITOR .env.docker          # NUVEM_RPC_URL, PRIVY_APP_ID

docker compose build web
docker compose up -d
```

Notes for a real VPS:

- **`.env.docker` must be `chmod 600`** and owned by the deploying user. On a VPS
  you are the secret manager; nothing does it for you.
- **TLS is yours.** Put Caddy, Traefik or nginx in front and terminate there. Do
  not publish 3000 to the internet directly. If you add a reverse proxy to this
  compose file, drop the `ports:` block from `web` and put it on the same `nuvem`
  network instead.
- `restart: unless-stopped` plus the image `HEALTHCHECK` means an unhealthy
  container is visible in `docker compose ps`, but compose does **not** restart on
  unhealthy by itself. Watch it, or add a supervisor.
- Redeploy: `git pull && docker compose build web && docker compose up -d`.
- Rollback: images are tagged `nuvem-web:local`. For a VPS you actually care
  about, tag by commit — `docker build -t nuvem-web:$(git rev-parse --short HEAD)` —
  so rollback is a tag change rather than a rebuild from an older checkout.
- `docker compose logs --tail=200 web`. Log rotation is capped at 3 x 10 MB in the
  compose file so a chatty deploy cannot fill the disk.

---

## 8. Railway

Railway builds from git, in the repo root, using the Dockerfile.

### Setup

1. Create a project, connect the repo.
2. **Leave Root Directory at the repo root.** Do not set it to `packages/web` — the
   build context would then lack `pnpm-lock.yaml`, `pnpm-workspace.yaml` and
   `packages/contracts-artifacts`, which is everything the install needs. This is
   the single most common way to break this deployment.
3. `railway.json` at the repo root already sets `builder: DOCKERFILE` and
   `dockerfilePath: packages/web/Dockerfile`. Railway looks for a file named
   literally `Dockerfile` (capital D, case-sensitive) at the source-directory root,
   which is not where ours lives, so the explicit path matters. The equivalent
   escape hatch is the `RAILWAY_DOCKERFILE_PATH` service variable.
4. Set service **Variables**: `NUVEM_RPC_URL`, `PRIVY_APP_ID`, and any chain
   address you want to override. Railway has no `.env` file on disk — variables are
   the only mechanism.
5. Generate a domain, then add that domain to the Privy dashboard's allowed
   origins (section 4).

Values in `railway.json` **always override the dashboard**, and the dashboard is not
written back. So `healthcheckPath`, `restartPolicyType` and the builder settings are
owned by the file from now on. There is deliberately **no `startCommand`**, so
Railway and compose run the identical Dockerfile `CMD`.

`watchPatterns` in `railway.json` stops unrelated commits (contracts, session-engine,
docs) from triggering a web rebuild.

### Things that will bite you

- **`PORT`.** Railway injects it and the app must listen on it, bound to `0.0.0.0`.
  Railway ignores `EXPOSE` entirely. Next's standalone server reads `PORT` and
  `HOSTNAME` itself, and a runtime `PORT` overrides the image default, so this
  works with no changes. If health checks still fail with everything else correct,
  the known fallback is binding `::` instead of `0.0.0.0` — Railway's edge reaches
  containers over IPv6, and `0.0.0.0` is IPv4-only.
- **Build-time variables need an explicit `ARG`.** Railway injects build variables
  only into stages that declare them. The only one declared is
  `NEXT_PUBLIC_PRIVY_APP_ID`, and you should normally leave it unset: setting it
  inlines the id into the client bundle and makes the image environment-specific.
- **The config file path does not follow Root Directory.** Config paths are
  absolute from the repo root. Relevant next milestone: the keeper needs its own
  `/packages/keeper-old/railway.toml` (or `.json`), its own Dockerfile path, and its own
  `watchPatterns`.
- **Committed `dist/` is mandatory here.** Building the artifacts on a host and
  injecting with `docker build --build-context` works on a VPS but is impossible on
  Railway — there is nowhere to inject from.

### Railway is not compose

`docker-compose.yml` is **not** the Railway deployment description. Railway can
*import* a compose file, converting each service into a separate Railway service,
but it does not execute one. Keep the two in sync by hand; the `x-chain-env` anchor
exists so the list of variables to mirror is one readable block.

| | Railway | VPS + compose |
| --- | --- | --- |
| Compose file | not executed (import-only) | is the deployment |
| `depends_on` | ignored — apps must retry on startup | honoured, `condition: service_healthy` |
| `ports:` | no port-mapping layer; services talk on real app ports | explicit `host:container` |
| Service-to-service | `<name>.railway.internal`, IPv6, Wireguard | `http://web:3000` on the bridge network |
| `restart:` | not honoured — use `deploy.restartPolicyType` | `restart: unless-stopped` |
| Secrets | Railway Variables, no file on disk | `.env.docker`, `chmod 600`, yours to protect |
| TLS + domains | edge terminates, certs managed | you run Caddy/Traefik/nginx |

---

## 9. The attester/keeper — see `docs/runbooks/ATTESTER.md`

`docker-compose.yml` now carries a real `keeper` service, gated behind the
**`keeper` profile**: a plain `docker compose up` neither builds nor starts it, so
nothing that can move money starts by accident. It has its own Dockerfile
(`packages/keeper-old/Dockerfile`) and its own named volume
(`nuvem-keeper-state`) for the correctness-critical settled-window ledger.

**Everything about running it is in `docs/runbooks/ATTESTER.md`** — the key
custody statement, the dry-run-first procedure, the two broadcast gates, volume
backup, and ledger recovery. Do not run it from this runbook.

The constraints that shaped its image, recorded here because they generalise to
any future Node service in this workspace:

- The signing keys are **runtime** environment only, never a build `ARG` — build
  args are recorded in image history and no later `RUN rm` removes them.
- It imports `@nuvem/contracts-artifacts`, **not** `packages/contracts/out` the
  way `packages/aa-smoke-old/scripts/settle.mjs:24-25` does. That path depends on
  untracked forge output and does not exist in a container.
- `output: "standalone"` has no equivalent for a plain Node process. The image
  uses `pnpm deploy --legacy --filter @nuvem/keeper [--prod] /out` — pnpm 10
  refuses a non-legacy `deploy` unless `inject-workspace-packages=true`, and this
  repo has no `.npmrc` setting it. Workspace dependencies must be built *before*
  `pnpm deploy`, because deploy copies each package as-is and honours its `files`
  field: `contracts-artifacts` declares `files: ["dist", "README.md"]`, and
  `session-engine`'s `exports` point at `dist/src/session.js` with no source
  fallback, so an unbuilt sibling is a boot-time `ERR_MODULE_NOT_FOUND`.
- Beware `environment:` versus `env_file:` in compose. `environment:` wins,
  **including when it interpolates to an empty string**, so a `FOO: ${FOO:-}`
  line silently discards what the env file said. Verified on Compose v2.40.3.
- Keep `${VAR:?}` out of a profile-gated service. Compose interpolates the whole
  file before applying profiles, so a required-variable placeholder there aborts
  `config`, `up` and `ps` for the `web` service too, for everyone, with the
  profile off. That is why the original keeper sketch was a comment, and why the
  real service uses `:-` defaults and validates its configuration at startup
  instead.

---

## 10. Troubleshooting

| Symptom | Cause |
| --- | --- |
| `FATAL: packages/contracts-artifacts/dist is missing or partial` | The committed ABIs are absent. Section 1. |
| `ERR_PNPM_OUTDATED_LOCKFILE` during build | `pnpm-lock.yaml` predates `packages/web`. Run `pnpm install` at the root and commit the lockfile. `--frozen-lockfile` validates against every importer. |
| `MODULE_NOT_FOUND` for `@nuvem/contracts-artifacts` at first request | `outputFileTracingRoot` is not the repo root. Section 3. |
| `FATAL: dangling symlinks in the standalone output` | pnpm's symlinked store leaked links pointing outside the trace root. Fix `outputFileTracingRoot` first. Last resort: `node-linker=hoisted` in an `.npmrc` scoped to the Docker build, at the cost of diverging from local resolution. |
| `FATAL: … does not exist. packages/web/next.config.* must set output: "standalone"` | Exactly that. |
| Page renders unstyled, `/_next/static/*` 404s | `.next/static` did not land beside the entrypoint. The Dockerfile copies it explicitly; if you edited that block, re-check the `appdir` nesting. |
| `EACCES` writing `.next/cache` | The cache dir is not owned by `nextjs`. The runner stage `chown`s it; preserve that if you edit. |
| Railway: "Application failed to respond" | Not listening on injected `PORT`, or bound to localhost. Section 8. |
| Container ignores `docker stop` for 10s | PID 1 is not receiving SIGTERM. `init: true` in compose, `--init` for `docker run`. |
| Health check red but the site loads | `/api/health` is missing from `packages/web`. Section 3. |
