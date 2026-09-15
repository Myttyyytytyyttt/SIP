# syntax=docker/dockerfile:1.7
#
# @sip/web -- the SIP site on Solana: the landing and the example dashboard,
# /wallets, and the /api/solana-rpc and /api/solana-tx routes.
#
# THE BUILD CONTEXT IS THE REPO ROOT, NOT THIS DIRECTORY:
#
#   docker build -f packages/website-oficial/Dockerfile -t sip-web:local .
#   docker compose build web
#
# Building with packages/website-oficial as the context cannot work: the install
# needs pnpm-lock.yaml, pnpm-workspace.yaml and the @sip/solana-core and
# @sip/solana-program siblings, none of which live here.
#
# A LOCAL PRODUCTION REHEARSAL ONLY. No platform builds this image: the web is
# hosted on Vercel from source (docs/runbooks/VERCEL_WEB.md), and Railway runs
# only the keeper, configured by hand (docs/runbooks/RAILWAY_SOLANA.md).
#
# NOTHING ABOUT THE DEPLOYMENT IS BAKED IN. The server reads PRIVY_APP_ID and the
# SIP_SOLANA_* settings at request time, so this image takes no build argument and
# one image runs in every environment.

# =============================================================================
# base -- toolchain only
# =============================================================================
# Pinned to the exact patch in .nvmrc / root engines.node ("22.14.0"). A
# floating node:22-slim can drift past that pin and fail the install with
# ERR_PNPM_UNSUPPORTED_ENGINE.
#
# bookworm-slim rather than alpine: Next's image optimizer pulls in sharp,
# which needs libc6-compat plus a musl prebuild on Alpine. ~30 MB well spent.
FROM node:22.14.0-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
ENV NEXT_TELEMETRY_DISABLED=1
# pnpm version comes from the root "packageManager" field, so the container
# and the host resolve dependencies identically.
RUN corepack enable && corepack prepare pnpm@10.18.1 --activate
WORKDIR /repo


# =============================================================================
# deps -- lockfile-only layer, stays cached until dependencies change
# =============================================================================
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
# EVERY PATH BELOW MUST EXIST, and the ones this app DEPENDS ON must be here.
#
# Measured against pnpm 10.18.1 with this repo's lockfile: pnpm discovers
# packages from disk through the packages/* glob and ignores lockfile importers
# with no directory, so the manifests of packages the web does not depend on need
# not be here. What IS required is narrower, and worse when violated:
#
# A `workspace:*` DEPENDENCY WHOSE PACKAGE IS NOT IN THE CONTEXT DOES NOT FAIL
# cleanly. pnpm prints "Lockfile is up to date" and a scope one project short,
# exits 0, and leaves a DANGLING SYMLINK behind (node_modules/@sip/solana-core ->
# ../../../solana-core, pointing at nothing). The failure surfaces two stages
# later, out of `next build`, as a module-resolution error naming an import
# rather than this list.
#
# The reverse rot is as bad: a COPY of a manifest that no longer exists fails the
# build while BuildKit computes cache keys -- before any step runs, with the error
# reported against whatever stage was in flight. That is what took down the
# keeper's deploy on 2026-08-29, and why the archived EVM packages left this list
# in the same change that moved them.
COPY packages/website-oficial/package.json      packages/website-oficial/
# @sip/web depends on @sip/solana-core (workspace:*), and the core depends on
# @sip/solana-program (workspace:*) for the committed sip_vault IDL. Both
# manifests must be here, or the install leaves exactly the dangling symlink
# described above. Their sources are copied in the builder stage.
COPY packages/solana-core/package.json          packages/solana-core/
COPY packages/solana-program/package.json       packages/solana-program/
# "@sip/web..." means "web plus everything it depends on". Do NOT use a bare
# `pnpm install -r`: it would also install the keeper's server dependencies and
# the program's test toolchain, none of which the web can use.
#
# NO BUILDKIT CACHE MOUNT HERE, DELIBERATELY.
#
# This line used to carry `--mount=type=cache,id=pnpm-store,target=/pnpm/store`.
# Railway's builder rejects a bare id: it requires `id=s/<service id>-<target>`
# and forbids environment variables inside the id, so the only way to keep the
# mount is to hardcode one Railway service's UUID into the Dockerfile. That is a
# landmine — recreate the service, or add a second one for staging, and the build
# fails with "missing the cacheKey prefix", which reads as a broken Dockerfile
# rather than a stale identifier.
#
# What the mount bought was a warm pnpm store when the LOCKFILE changes; when it
# does not, Docker's own layer cache already skips this step entirely. That is a
# small, occasional saving, and not worth a build that only works on one service
# of one provider.
RUN pnpm install --frozen-lockfile --filter "@sip/web..."


# =============================================================================
# builder -- next build, then normalise the standalone tree
# =============================================================================
FROM deps AS builder

# The Solana core: TypeScript source that next build compiles (transpilePackages),
# plus the bin/ that prebuild's check:idl runs. From the program package, ONLY its
# manifest and the committed IDL. Never programs/, scripts/, tests/ or target/,
# where Anchor keeps the program's upgrade keypair (.dockerignore excludes it too).
COPY packages/solana-core packages/solana-core
COPY packages/solana-program/package.json packages/solana-program/package.json
COPY packages/solana-program/idl packages/solana-program/idl

COPY packages/website-oficial packages/website-oficial

# The web's own build: prebuild runs check:csp and check:idl, then next build.
RUN pnpm --filter @sip/web run build

# Post-build normalisation and assertions.
#
# next.config must set output: "standalone" AND
#   outputFileTracingRoot: path.join(import.meta.dirname, "../../")
# (a TOP-LEVEL key in Next 15/16, not under experimental). Without the trace
# root, anything reached through a pnpm symlink pointing outside
# packages/website-oficial -- the @sip/solana-core and @sip/solana-program
# siblings, and the root store every dependency lives in -- can be silently
# dropped from the traced output: the build succeeds and the first request 500s
# with MODULE_NOT_FOUND.
#
# The trace root also RELOCATES the entrypoint to
# standalone/packages/website-oficial/server.js. The script below tolerates both layouts
# and records the entry path in nuvem-entry.path so the runner need not guess.
# It then copies .next/static and public/, which Next deliberately does not
# put into standalone (the usual cause of an unstyled page with 404ing
# /_next/static chunks), and finally fails the build on any dangling symlink,
# since pnpm's symlinked store can otherwise produce a container that dies at
# boot -- with one carve-out, explained at the prune step below.
RUN set -eu; \
    sa="/repo/packages/website-oficial/.next/standalone"; \
    if [ ! -d "$sa" ]; then \
      echo "FATAL: $sa does not exist."; \
      echo "packages/website-oficial/next.config.* must set: output: \"standalone\""; \
      exit 1; \
    fi; \
    if [ -f "$sa/packages/website-oficial/server.js" ]; then \
      appdir="packages/website-oficial"; \
      echo "[standalone] repo-root trace root detected (expected)"; \
    elif [ -f "$sa/server.js" ]; then \
      appdir="."; \
      echo "[standalone] WARNING: entrypoint sits at the standalone root,"; \
      echo "[standalone] so outputFileTracingRoot is NOT the repo root."; \
      echo "[standalone] Sibling workspace packages may have been omitted."; \
    else \
      echo "FATAL: no server.js anywhere under $sa"; \
      exit 1; \
    fi; \
    mkdir -p "$sa/$appdir/.next/static"; \
    cp -R /repo/packages/website-oficial/.next/static/. "$sa/$appdir/.next/static/"; \
    if [ -d /repo/packages/website-oficial/public ]; then \
      mkdir -p "$sa/$appdir/public"; \
      cp -R /repo/packages/website-oficial/public/. "$sa/$appdir/public/"; \
    fi; \
    printf '%s\n' "$appdir/server.js" > "$sa/nuvem-entry.path"; \
    echo "[standalone] entrypoint: $appdir/server.js"; \
# .pnpm/node_modules is pnpm's hoisted-alias directory: convenience links that
# exist so peer dependencies resolve. Next's tracer can copy such a link without
# its target when nothing traced ever reads through it, and that is what happens
# here with semver -- the standalone output carries semver@7.8.5 as a real
# package while the stale alias points at 6.3.1. A dangling entry THERE is a
# layout artifact, not a missing dependency: booting this exact output with the
# broken link in place served /api/health, / and /wallets, all 200. So prune
# those (a broken link can only ever fail) and stay fatal everywhere else, which
# is where a dangling link really does mean Next failed to copy something the
# server reaches for at boot.
    hoisted="$(find "$sa" -xtype l -path '*/.pnpm/node_modules/*' -print)"; \
    if [ -n "$hoisted" ]; then \
      echo "[standalone] pruning dangling pnpm hoist aliases:"; \
      echo "$hoisted"; \
      find "$sa" -xtype l -path '*/.pnpm/node_modules/*' -delete; \
    fi; \
    dangling="$(find "$sa" -xtype l -print)"; \
    if [ -n "$dangling" ]; then \
      echo "FATAL: dangling symlinks in the standalone output:"; \
      echo "$dangling"; \
      exit 1; \
    fi


# =============================================================================
# runner -- no pnpm, no lockfile, no node_modules install, non-root
# =============================================================================
FROM node:22.14.0-bookworm-slim AS runner
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# Next's standalone server reads HOSTNAME and PORT itself. 0.0.0.0 is required
# on Railway, which does not read EXPOSE and routes to the listening port. (If
# Railway health checks ever fail despite this, "::" for dual-stack is the
# known fallback -- their edge reaches containers over IPv6.)
ENV HOSTNAME=0.0.0.0
# Default for a bare `docker run`. A PORT injected at runtime -- by Railway or
# by compose -- overrides this, which is exactly the intent.
ENV PORT=3000

WORKDIR /app
RUN groupadd --gid 1001 nodejs \
 && useradd --uid 1001 --gid nodejs --create-home nextjs

COPY --from=builder --chown=nextjs:nodejs /repo/packages/website-oficial/.next/standalone ./

# The ISR / fetch cache is written at runtime and must be owned by the
# non-root user, or the first cache write throws EACCES.
RUN set -eu; \
    entry="$(cat /app/nuvem-entry.path)"; \
    appdir="$(dirname "$entry")"; \
    mkdir -p "/app/$appdir/.next/cache"; \
    chown -R nextjs:nodejs "/app/$appdir/.next"

USER nextjs

# Documentation only: Docker publishes nothing from this, and Railway ignores
# it entirely.
EXPOSE 3000

# curl and wget are absent from the slim runtime on purpose -- node's own
# fetch needs no extra attack surface. Uses $PORT so the probe follows the
# port the server actually bound. Requires packages/website-oficial to serve
# GET /api/health.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# The entry path is resolved at build time (see the builder stage) because it
# depends on outputFileTracingRoot. `exec` hands PID 1 to node, so SIGTERM
# reaches the server and `docker stop` is not a 10-second wait.
CMD ["/bin/sh", "-c", "exec node \"$(cat /app/nuvem-entry.path)\""]
