# syntax=docker/dockerfile:1.7
#
# @nuvem solana supervisor -- the Solana settlement/investment keeper.
#
# THE SECOND IMAGE IN THIS REPO THAT RUNS WITH SIGNING KEYS (the EVM keeper is
# the first, and this file follows its doctrine). A long-running sweep loop:
# discovers TradingLink accounts from the chain, measures unsettled profit,
# attests, settles via the wallet's Privy session signer, and invests what the
# owner's on-chain policy allows. It serves a heartbeat on $PORT so an operator
# can tell a halted keeper from a wedged one; it serves no user traffic.
#
# THE BUILD CONTEXT IS THE REPO ROOT (Railway's default for a monorepo):
#
#   docker build -f packages/solana-lab-old/program/Dockerfile -t nuvem-solana-keeper:local .
#
# The lab is deliberately OUTSIDE the pnpm workspace (see pnpm-workspace.yaml),
# with its own package-lock.json, so this image needs no workspace siblings and
# builds with plain npm ci.
#
# =============================================================================
# SECRETS ARE RUNTIME ENVIRONMENT ONLY. NEVER A BUILD ARG.
# =============================================================================
# No ARG exists here for NUVEM_SOLANA_ATTESTER_KEY, NUVEM_SOLANA_CRANK_KEY,
# PRIVY_APP_SECRET, PRIVY_AUTHORIZATION_KEY or the RPC URL (it carries the
# Helius key). A build ARG is recorded in image history, visible to anyone who
# can pull the image. The root .dockerignore additionally keeps .env files and
# scripts/.local out of the context, so no COPY can capture a key by accident.

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY packages/solana-lab-old/program/package.json packages/solana-lab-old/program/package-lock.json ./
# Dev deps stay: the supervisor runs under tsx, which the lab lists as one.
RUN npm ci

FROM node:22-bookworm-slim
# tini -g: signal the whole process group so a SIGTERM arriving mid-sweep stops
# the loop cleanly instead of being absorbed by npx.
#
# THE RETRY IS ALL THAT SURVIVED of an attempt to make this step non-fatal. That
# attempt was based on a misdiagnosis -- the EVM keeper's deploy was broken by a
# COPY of a deleted package, which fails while BuildKit computes cache keys and
# cancels every sibling stage mid-flight, so apt looked guilty and was not. A
# build allowed to finish without tini would hand Railway an image whose start
# command names a missing file, turning a loud build failure into a silent
# crash-loop. Three attempts against a hiccuping mirror, then fail honestly.
RUN set -eu; \
    for attempt in 1 2 3; do \
      if apt-get update && apt-get install -y --no-install-recommends tini; then \
        rm -rf /var/lib/apt/lists/*; \
        echo "init: tini installed; it will be PID 1"; \
        exit 0; \
      fi; \
      echo "tini: apt attempt ${attempt}/3 failed"; \
      sleep 5; \
    done; \
    echo "FATAL: could not install tini after 3 attempts. It is this image's"; \
    echo "ENTRYPOINT and npx will not forward SIGTERM without it."; \
    exit 1
WORKDIR /app
ENV NODE_ENV=production

# NON-ROOT, because this image runs with signing keys — the same uid the EVM
# keeper uses, switched BEFORE the preflight so an ownership mistake fails the
# build, not the deploy. install -d pre-creates the one directory the
# supervisor writes (the local-signers fallback), owned by the runtime user.
RUN groupadd -g 1001 keeper && useradd -u 1001 -g keeper -m keeper

COPY --from=deps --chown=keeper:keeper /app/node_modules ./node_modules
COPY --chown=keeper:keeper packages/solana-lab-old/program/package.json ./
COPY --chown=keeper:keeper packages/solana-lab-old/program/tsconfig.json ./
COPY --chown=keeper:keeper packages/solana-lab-old/program/keeper ./keeper
COPY --chown=keeper:keeper packages/solana-lab-old/program/scripts ./scripts
COPY --chown=keeper:keeper packages/solana-lab-old/program/target/idl/nuvem_vault.json ./target/idl/nuvem_vault.json
RUN install -d -o keeper -g keeper /app/scripts/.local/signers
USER keeper

# The image must be provably runnable at BUILD time: --preflight loads the full
# module graph under tsx plus the committed IDL, with no network, no keys and
# no secrets in the environment — run AS the runtime user, so a permission
# mistake in the COPYs above fails here, not on Railway.
RUN npx tsx keeper/bin/supervisor.mts --preflight

# BAKED so the heartbeat ALWAYS serves: the supervisor starts its server only
# when PORT is set, and a probe against a port nothing listens on marks every
# healthy dry-run container unhealthy forever. Railway overrides PORT with its
# own value; the probe follows whatever is in effect.
ENV PORT=8080
EXPOSE 8080

# For LOCAL docker only — Railway does not execute Docker HEALTHCHECKs. Its
# deploy-time gate is the healthcheckPath in this package's railway.json, which
# points at the same /health.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "-g", "--"]
# DRY RUN BY DEFAULT, same doctrine as the EVM keeper's empty CMD: broadcasting
# requires NUVEM_SOLANA_BROADCAST=1 AND the NUVEM_SOLANA_ALLOW_BROADCAST
# sentinel -- two Railway variables, no image rebuild, and the supervisor
# refuses loudly if only one is present.
CMD ["npx", "tsx", "keeper/bin/supervisor.mts"]
