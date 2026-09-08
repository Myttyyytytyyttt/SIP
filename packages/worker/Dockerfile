# @sip/worker — the volume observer, as an image.
#
# BUILT FROM THE REPOSITORY ROOT, like the web image: the install needs
# pnpm-lock.yaml and pnpm-workspace.yaml, and a build whose context is
# packages/worker cannot see either.
#
#   docker build -f packages/worker/Dockerfile -t sip-worker .
#
# DRY RUN IS THE DEFAULT AND IT IS STRUCTURAL. The process reads no signing
# secret unless SIP_WORKER_ALLOW_BROADCAST is the exact sentence; an image
# started without it cannot broadcast, whatever else is in its environment.

FROM node:22.14.0-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable

FROM base AS deps
WORKDIR /repo
# Manifests first, so a dependency change is the only thing that busts this layer.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/contracts-artifacts/package.json packages/contracts-artifacts/
COPY packages/worker/package.json packages/worker/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --filter @sip/worker...

FROM deps AS builder
WORKDIR /repo
COPY packages/contracts-artifacts packages/contracts-artifacts
COPY packages/worker packages/worker
# The worker runs from TypeScript through tsx; typecheck is the build gate, so a
# type error cannot reach a deployed image.
RUN pnpm --dir packages/worker typecheck

FROM base AS runtime
WORKDIR /repo
ENV NODE_ENV=production
# A non-root user: nothing here needs to write outside the ledger's database.
RUN groupadd --system --gid 1001 sip && useradd --system --uid 1001 --gid sip sip
COPY --from=builder --chown=sip:sip /repo /repo
USER sip
WORKDIR /repo/packages/worker
# tsx DIRECTLY, not `pnpm run worker`. corepack resolves the pinned pnpm on first
# use and writes it under $HOME, and this system user was created without one, so
# going through the package manager dies at startup with
#   EACCES: permission denied, mkdir '/home/sip/.cache/node/corepack/v1'
# after a build that looked perfectly healthy. Measured, not feared: it is what
# the first `docker run` of this image actually did. The runtime does not need a
# package manager, it needs one binary.
#
# `run` loops on SIP_POLL_MS (default 300000). For a cron-style platform, override
# the command with:  node_modules/.bin/tsx bin/worker.mts tick
CMD ["node_modules/.bin/tsx", "bin/worker.mts", "run"]
