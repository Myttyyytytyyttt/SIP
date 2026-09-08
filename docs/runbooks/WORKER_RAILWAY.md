# Running the observation worker on Railway

## Why this file exists

The repository root holds a `railway.json` that points at
`packages/website-oficial/Dockerfile`. A Railway service created without a config
file of its own inherits that one, so a service named "worker" would happily
build and run **the website**, be healthy, and observe nothing. This is not a
hypothetical: it is how the parent project lost an afternoon.

So the worker carries `packages/worker/railway.json`, and the Railway service
must be pointed at that path in Settings → Config-as-code.

## What the service actually is

`packages/worker/Dockerfile` ends in `CMD ["node_modules/.bin/tsx", "bin/worker.mts", "run"]`,
which runs the **loop**, not the one-shot `tick`. It polls every `SIP_POLL_MS`
milliseconds, default **300000 (5 minutes)**.

It listens on no port. Do **not** give this service a healthcheck path: there is
nothing to answer it, and Railway would restart a perfectly healthy worker
forever.

For a single pass instead of the loop, override the command with
`node_modules/.bin/tsx bin/worker.mts tick`.

## The two modes, and why dry run is not a lesser version

`SIP_WORKER_ALLOW_BROADCAST` is compared **byte for byte** against
`i-understand-this-moves-real-funds`. Anything else — a trailing newline, a
different case, an empty string — is dry run, and the worker says so in a warning
rather than silently.

In dry run the secrets are **never read at all** (`config.ts`: the attester key
and the Privy credentials are only taken from the environment inside
`if (mode === "live")`). A dry-run worker on Railway with the live secrets already
in its variables is therefore not "armed but polite" — it is a process that has
not touched them. That is what makes it a safe first deploy.

## Postgres is not optional in live mode

- The per-wallet scan cursor (`cursor_l2`) lives in Postgres. With no
  `DATABASE_URL` the ledger is in **memory**, so every restart — and Railway
  restarts — rescans from `SIP_LOGS_FROM_BLOCK`.
- `pg_advisory_lock` is the only thing stopping two workers from pulling the same
  debt twice. A second worker on the same database refuses to start.
- Live mode with a memory ledger is refused outright by `config.ts`.

Two consequences for Railway:

1. **`numReplicas` stays 1.** The lock would catch a second instance, but as a
   refusal-to-start, not as a graceful handover.
2. **Use the session pooler, port 5432 — never 6543.** Advisory locks are session
   scoped and do not survive a transaction pooler: the lock would appear granted
   and hold nothing. `config.ts` refuses port 6543 by name for exactly this.

## Variables

Required in both modes:

    SIP_RPC_URLS            comma-separated; first is preferred, rest are failover
    SIP_CHAIN_ID            4663
    SIP_VAULT_FACTORY       0xf38448a0550eB31530f58a6d613e74fb109D02Ef
    SIP_SETTLEMENT_EXECUTOR 0xB87fBBAC92d52D543CB289Ee4cBdB23b6330C15c
    SIP_LOGS_FROM_BLOCK     57746389
    SIP_MAX_LOG_SPAN        the provider's eth_getLogs range cap

Required additionally to go live:

    SIP_WORKER_ALLOW_BROADCAST   i-understand-this-moves-real-funds
    SIP_ATTESTER_PRIVATE_KEY     the key registered in AttesterRegistry; holds no funds
    DATABASE_URL                 postgres://… on port 5432
    PRIVY_APP_ID / PRIVY_APP_SECRET
    PRIVY_AUTHORIZATION_PRIVATE_KEY / PRIVY_SIGNER_ID / PRIVY_POLICY_ID

## The order that keeps the first mistake cheap

1. Deploy in **dry run** with the chain variables only. Confirm from the logs that
   it starts, reaches the RPC, and reports the factory it is watching.
2. Add Postgres and confirm it takes the advisory lock.
3. Create the first vault and set the trading account's `savingsBps`. Until a
   vault exists the worker is correctly doing nothing.
4. Let it observe one real fill **in dry run** and check the reconstructed
   notional by hand against the transaction.
5. Only then add the sentinel and the secrets, and redeploy.

Step 4 is the one worth not skipping. It is the last point at which a wrong
number costs nothing.

## The web service, which is the other half

The root `railway.json` builds `packages/website-oficial/Dockerfile`. One thing
about it is easy to get wrong and invisible until a user opens the page:

**`NEXT_PUBLIC_PRIVY_APP_ID` must be set on the web service, because Next bakes
`NEXT_PUBLIC_*` into the browser bundle at BUILD time.** A value supplied only at
runtime arrives too late; the page renders, answers its healthcheck, and has no
Privy. The Dockerfile declares it as `ARG NEXT_PUBLIC_PRIVY_APP_ID=""`, so an
unset variable is not an error — it is an empty string baked into the bundle.
The app id is public by design (it ships to every browser), so it is a plain
variable, not a secret.

## What was actually verified, and how

Both images were built and run locally before any of this was written down.
Not "should work" — run.

**Worker.** `docker build -f packages/worker/Dockerfile -t sip-worker .` succeeds
(590 MB). `docker run --env-file …` starts and reaches the chain:

    worker.start  mode=dry-run  chainId=4663  command=run  ledger=memory
                  pollMs=300000  maxLogSpan=100000
                  factory=0xf38448a0…  executor=0xb87fbbac…
    worker.heartbeat  pass=1  tickMs=322  headL2=57813180  wallets=0  pulls=0

Zero wallets is the correct answer for a factory nobody has used yet. On
`docker stop` (SIGTERM, which is what Railway sends on redeploy) it logs
`worker.signal` then `worker.stop` with `fatal: null` and exits 0, in under a
fifth of a second — no waiting out a kill timeout.

The dry-run gate was observed doing its job: with the secrets present in the
environment, the process printed that they were *"removed unread"*.

**Web.** Builds (449 MB) and serves `/api/health` -> `{"ok":true,"service":"@sip/web"}`,
`/` and `/wallets`, all 200, with the Privy app id present in the served HTML.

Two real defects were found by running the images that reading them had not
revealed, and both would have failed the first Railway deploy:

1. The worker's `CMD` went through `pnpm`, and corepack resolves the pinned pnpm
   on first use by writing under `$HOME` — which this system user does not have.
   The image built perfectly and died at startup with
   `EACCES … mkdir '/home/sip/.cache/node/corepack/v1'`. It now invokes `tsx`
   directly; the runtime needs one binary, not a package manager.
2. The web build failed its own dangling-symlink guard on a stale pnpm hoist
   alias (`.pnpm/node_modules/semver` -> `semver@6.3.1`, while the output carries
   7.8.5 as a real package). Booting that exact output proved the link inert, so
   the guard now prunes dangling aliases under `.pnpm/node_modules` and stays
   fatal everywhere else.

If you change either Dockerfile, build and RUN it before deploying. Both of these
were invisible to a careful reading.

## Running the whole thing locally first

`docker compose up --build` brings up the same two images Railway builds, plus
the Postgres Railway would give you as a plugin. Railway does not read the
compose file; compose is the rehearsal, `railway.json` is the performance.

    cp .env.example .env      # then fill in the RPC URL and the Privy values
    docker compose up --build

`SIP_WEB_PORT` moves the web container's host port when your own dev server is
already on 3002. The container always listens on 3002 regardless, because its
healthcheck runs inside it.

What a good local run looks like, measured on the first one:

    db      Healthy
    worker  worker.start … ledger=postgres … factory=0xf38448a0…
            worker.heartbeat pass=1 tickMs=357 headL2=…  wallets=0
    web     /api/health 200, /wallets 200

Zero wallets is right until a vault exists. The worker creates its seven tables
on first connection: `sip_wallet`, `sip_fill`, `sip_window`, `sip_pull`,
`sip_refusal`, `sip_exclusion`, `sip_instance`.

To see the single-writer guarantee rather than trust it, start a second worker
against the same database:

    docker compose run --rm --no-deps worker

It refuses, naming who holds the lock and since when, and the first keeps
running. That refusal is the whole reason `numReplicas` is 1.

## Supabase

The project is `sgjwrlrixeoqnzbrtjby`, in **eu-west-1**, and the connection that
works is the **session pooler**:

    postgres://postgres.sgjwrlrixeoqnzbrtjby:<password>@aws-1-eu-west-1.pooler.supabase.com:5432/postgres

Three things about that string are load-bearing:

- **Port 5432, never 6543.** 6543 is the transaction pooler; advisory locks are
  session scoped and do not survive it, so the lock would appear granted while
  holding nothing and two workers would run believing they were alone.
  `config.ts` refuses port 6543 by name rather than letting that happen.
- **The pooler, not the direct connection.** `db.<ref>.supabase.co` resolves to
  an AAAA record only — no IPv4 — so it is unreachable from a default Docker
  bridge network. The pooler has an A record.
- **`aws-1-`, not `aws-0-`.** Older projects use the `aws-0-` hosts; this one is
  on `aws-1-`. The wrong prefix fails with
  `(ENOTFOUND) tenant/user postgres.<ref> not found`, which reads like a
  credentials problem and is not one.

Verified end to end: the worker connected through this string, created all seven
tables in the Supabase project, and held one advisory lock while ticking.

The Supabase MCP server is configured in `.mcp.json` (its `project_ref` had been
inherited from the parent project and pointed at the wrong database until this
was written). Authenticating it is an OAuth flow that needs a real terminal:

```bash
claude /mcp
```
