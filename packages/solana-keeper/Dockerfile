# @sip/solana-keeper — SIP's Solana settle-and-invest keeper, as an image.
#
# BUILT FROM THE REPOSITORY ROOT: the install needs pnpm-lock.yaml and
# pnpm-workspace.yaml, and the keeper imports two workspace siblings
# (@sip/solana-program for the IDL and the attestation/route modules,
# @sip/solana-log for its redacting logger).
#
#   docker build -f packages/solana-keeper/Dockerfile -t sip-solana-keeper .
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
# committed IDL and the three scripts its package exports — not target/, whose
# deploy directory holds the program's upgrade keypair, and not .localnet/.
COPY packages/solana-log/src/log.ts packages/solana-log/src/log.ts
COPY packages/solana-program/idl packages/solana-program/idl
COPY packages/solana-program/scripts/attestation.ts packages/solana-program/scripts/live-route.ts packages/solana-program/scripts/raydium-swap.ts packages/solana-program/scripts/
COPY packages/solana-keeper packages/solana-keeper
# The keeper runs from TypeScript through tsx; typecheck is the build gate, so a
# type error cannot reach a deployed image.
RUN pnpm --dir packages/solana-keeper typecheck

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
