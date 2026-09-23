# @sip/solana-keeper — SIP's Solana settle-and-invest keeper, as an image.
#
# BUILT FROM THE REPOSITORY ROOT: the install needs pnpm-lock.yaml and
# pnpm-workspace.yaml, and the keeper imports two workspace siblings
# (@sip/solana-program for the IDL and the attestation/route modules,
# @sip/solana-log for its redacting logger).
#
#   docker build -f packages/solana-keeper/Dockerfile -t sip-solana-keeper .
#
# ON RAILWAY, WITHOUT CONFIG AS CODE. Since 2026-08-28 Railway refuses railway.json
# for services that never used it, and a Railpack build of the repository root is
# the web, not the keeper. So the repository root holds a BYTE-IDENTICAL COPY of
# this file, named Dockerfile, which Railway detects on its own. Any service
# created from this repository builds the keeper, with or without the variable
# RAILWAY_DOCKERFILE_PATH=packages/solana-keeper/Dockerfile, even if a variable
# edit drops it. Root Directory stays empty, so the context is the repository
# root. Set the healthcheck path /health, one replica, restart on failure and the
# watch paths on the service by hand (docs/runbooks/RAILWAY_SOLANA.md).
# packages/solana-keeper/test/dockerfile-copy.test.ts fails as soon as the two
# copies differ. The web is on Vercel, which reads neither file.
#
# DRY RUN IS THE DEFAULT, AND A DRY RUN HOLDS NO KEY. The process reads no signing
# secret unless SIP_SOLANA_BROADCAST=1 and SIP_SOLANA_ALLOW_BROADCAST is the exact
# sentence; started without them it cannot sign anything, whatever else is in its
# environment. Going live is two Railway variables, never an image rebuild.
#
# SECRETS ARE RUNTIME ENVIRONMENT ONLY. NEVER A BUILD ARG. No ARG exists for
# SIP_SOLANA_SETTLE_KEY, the Privy app secret or authorization key, the RPC URLs
# (they carry provider keys), DATABASE_URL or the alert webhook. A build ARG is
# recorded in image history, visible to anyone who can pull the image. The root
# .dockerignore keeps .env files and Solana key material out of the context, and
# the COPYs below take the program's files BY NAME, never its whole directory.

FROM node:22.14.0-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable

FROM base AS deps
WORKDIR /repo
# Manifests first, so a dependency change is the only thing that busts this layer.
# pnpm needs every workspace manifest in the filtered graph to install against
# the lockfile.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/solana-log/package.json packages/solana-log/
COPY packages/solana-program/package.json packages/solana-program/
COPY packages/solana-keeper/package.json packages/solana-keeper/
# NO BUILDKIT CACHE MOUNT: Railway rejects a bare cache id and a keyed one
# hardcodes a service UUID.
RUN pnpm install --frozen-lockfile --filter "@sip/solana-keeper..."

FROM deps AS builder
WORKDIR /repo
# ONLY WHAT THE KEEPER'S MODULE GRAPH READS. @sip/solana-log contributes one file,
# its logger, which imports nothing but node:crypto. The program contributes its
# committed IDL and the exported scripts the keeper reaches — not target/, whose
# deploy directory holds the program's upgrade keypair, and not .localnet/.
#
# COPY BY NAME IS TRANSITIVE OR IT IS NOTHING. A named file drags in whatever IT
# imports, and those imports are named by no line of their own. live-route.ts
# reaches ./raydium-swap and jupiter-fork-test.ts reaches ./jupiter-sim, which
# are copied here because the keeper itself also reaches them — a coincidence,
# not a discipline. link-consent.ts is reached by test-local/, which vitest never
# loads and tsconfig.json's include DOES typecheck, so its absence broke the
# typecheck gate below and nothing else. test/dockerfile-copies.test.ts now walks
# the whole closure rather than one level of it.
COPY packages/solana-log/src/log.ts packages/solana-log/src/log.ts
COPY packages/solana-program/idl packages/solana-program/idl
COPY packages/solana-program/scripts/attestation.ts packages/solana-program/scripts/live-route.ts packages/solana-program/scripts/raydium-swap.ts \
     packages/solana-program/scripts/clmm-layout.ts \
     packages/solana-program/scripts/jupiter-route.ts packages/solana-program/scripts/jupiter-sim.ts \
     packages/solana-program/scripts/jupiter-fork-setup.ts packages/solana-program/scripts/jupiter-fork-test.ts \
     packages/solana-program/scripts/link-consent.ts \
     packages/solana-program/scripts/
# AND THE TWO FILES ONLY THE TEST SUITE READS, now that the suite runs here too.
# attestation.rs is the program's own attestation encoder, which
# test/attestation-golden.test.ts holds the keeper's mirror against character for
# character; the root Dockerfile is the copy Railway actually builds, which
# test/dockerfile-copy.test.ts holds byte-identical to this one. Both BY NAME,
# like every COPY above: nothing from target/, nothing from .localnet, no key
# material. WITHOUT THEM THE SUITE FAILS HERE, WHICH IS THE POINT: the image
# runs the tests, so a file the COPYs above do not name breaks the BUILD
# rather than the boot. No count is quoted, because a count written here
# goes stale the next time a test is added and then reads as a measurement
# nobody took — test/dockerfile-copies.test.ts checks the coverage instead.
COPY packages/solana-program/programs/sip-vault/src/attestation.rs packages/solana-program/programs/sip-vault/src/attestation.rs
# AND THE FILES THE MIRROR TEST REACHES ACROSS FOR. test/pyth.test.ts decodes the
# same committed mainnet vector with BOTH implementations and asserts they agree
# to the unit — that assertion is the only thing keeping src/pyth.ts honest
# against the copy it was mirrored from. Named one by one like everything else
# here: these are eight files, NOT a dependency on @sip/solana-core, which
# src/pyth.ts explains the keeper must never take.
#
# EIGHT AND NOT TWO, BECAUSE THE TWO REACH FURTHER. pyth-price.ts imports
# ./addresses, ./base58, ./clmm-price, ./idl and ./rules; clmm-price and rules
# import each other's neighbours; pyth-accounts.ts imports ../../src/client/base64.
# Naming only the two entry points made `RUN pnpm --dir packages/solana-keeper
# test` die in the image with "Cannot find module './addresses'" while every
# gate on a developer's machine stayed green, because there the files are simply
# present. core's idl.ts then reaches @sip/solana-program/idl, which the COPY
# above already carries, and the closure stops there.
COPY packages/solana-core/src/client/pyth-price.ts packages/solana-core/src/client/addresses.ts \
     packages/solana-core/src/client/base58.ts packages/solana-core/src/client/base64.ts \
     packages/solana-core/src/client/clmm-price.ts packages/solana-core/src/client/idl.ts \
     packages/solana-core/src/client/rules.ts \
     packages/solana-core/src/client/
COPY packages/solana-core/test/fixtures/pyth-accounts.ts packages/solana-core/test/fixtures/pyth-accounts.ts
COPY packages/solana-core/test/fixtures/keeper-policy.ts packages/solana-core/test/fixtures/keeper-policy.ts
COPY Dockerfile Dockerfile
COPY packages/solana-keeper packages/solana-keeper
# The keeper runs from TypeScript through tsx; typecheck is the build gate, so a
# type error cannot reach a deployed image.
RUN pnpm --dir packages/solana-keeper typecheck

# AND THE SUITE, because a typecheck cannot see the class of bug that took the
# keeper down on 2026-09-18: the broken BN spelling typechecks perfectly and is
# undefined at runtime under Node ESM. Until now vitest was run by NOTHING
# automatic — this repository has no .github, no hooks, no CI, and the image
# built with exactly two checks — so every guard that generalizes beyond the
# money-path builders (one source of BN, no second bn.js, the two module-system
# facts, the preflight's own size) protected nothing on a deploy: a push
# straight to Railway from a branch where nobody typed `pnpm test` shipped
# whatever they would have caught. No network, no keys, 1.53 s. devDependencies
# are present in this stage — the typecheck above already depends on that.
RUN pnpm --dir packages/solana-keeper test

FROM base AS runtime
WORKDIR /repo
ENV NODE_ENV=production
# NON-ROOT, because armed this image holds a signing key. Nothing here writes
# outside the temp directory tsx caches into.
RUN groupadd --system --gid 1001 sip && useradd --system --uid 1001 --gid sip sip
COPY --from=builder --chown=sip:sip /repo /repo
USER sip
WORKDIR /repo/packages/solana-keeper

# The image must be provably runnable at BUILD time: --preflight loads the full
# module graph under tsx plus the exported IDL and checks the classification
# invariants, with no network, no keys and no environment — run AS the runtime
# user, so a permission mistake in the COPYs above fails here, not on Railway.
RUN node_modules/.bin/tsx bin/keeper.mts --preflight

# BAKED so the heartbeat ALWAYS serves: the keeper starts its server only when
# PORT is set, and a probe against a port nothing listens on marks every healthy
# dry-run container unhealthy forever. Railway overrides PORT with its own value.
ENV PORT=8080
EXPOSE 8080

# tsx DIRECTLY, not `pnpm run keeper`: corepack writes under $HOME on first use
# and this system user has none (measured on the archived EVM image), and
# SIGTERM must reach node so the keeper releases its claim on every redeploy.
CMD ["node_modules/.bin/tsx", "bin/keeper.mts"]
