# syntax=docker/dockerfile:1.7
#
# @nuvem/keeper -- the attester / settlement service.
#
# THIS IS THE ONLY IMAGE IN THIS REPO THAT RUNS WITH SIGNING KEYS.
# It is a long-running loop, not a web server. It detects finished trading
# sessions, asks @nuvem/session-engine for a verdict, and -- only when explicitly
# told to -- signs a SettlementAttestation and submits settle() from the trading
# account. It serves a small heartbeat/status HTTP surface on 127.0.0.1-or-bridge
# port 8787 so a container probe and an operator can tell a halted keeper from a
# wedged one; it serves no user-facing traffic.
#
# THE BUILD CONTEXT IS THE REPO ROOT, NOT THIS DIRECTORY:
#
#   docker build -f packages/keeper-old/Dockerfile -t nuvem-keeper:local .
#   docker compose --profile keeper build keeper
#
# Building with packages/keeper-old as the context cannot work: the install needs
# pnpm-lock.yaml, pnpm-workspace.yaml and the @nuvem/session-engine and
# @nuvem/contracts-artifacts siblings, none of which live here.
#
# =============================================================================
# SECRETS ARE RUNTIME ENVIRONMENT ONLY. NEVER A BUILD ARG.
# =============================================================================
# There is deliberately no ARG in this file for NUVEM_ATTESTER_PRIVATE_KEY,
# TRADING_OWNER_PRIVATE_KEY, NUVEM_ATTESTER_KEY_FILE's contents, or NUVEM_RPC_URL
# (which carries an Alchemy API key).
#
# A build ARG is recorded in image history. `docker history --no-trunc <image>`
# and the config blob of any pushed image show it in plain text, to anyone who
# can pull. `RUN rm` does not remove it; neither does a later stage, because the
# history entry is metadata, not a file. The same is true of ENV: an ENV set to a
# secret value is baked into the image config. So the only secret-shaped ENV
# lines below are EMPTY defaults whose sole purpose is to document the variable
# name and to guarantee the process sees an empty string rather than inheriting a
# stale value from somewhere else.
#
# Provide the keys at `docker run -e` / compose `environment:` time, or -- better
# -- as a mounted file referenced by NUVEM_ATTESTER_KEY_FILE, so the value never
# appears in `docker inspect` or /proc/1/environ either. See
# docs/runbooks/ATTESTER.md.
#
# FOUNDRY IS NOT IN THIS IMAGE, BY DESIGN, exactly as for @nuvem/web. The keeper
# imports @nuvem/contracts-artifacts (committed dist/) and must never read
# packages/contracts/out/ at runtime the way
# packages/aa-smoke-old/scripts/settle.mjs:24-25 does -- that directory is gitignored
# and excluded from the build context, so it will not exist here.


# =============================================================================
# base -- toolchain only
# =============================================================================
# Pinned to the exact patch in .nvmrc / root engines.node ("22.14.0"). A floating
# node:22-slim can drift past that pin and fail the install with
# ERR_PNPM_UNSUPPORTED_ENGINE.
#
# bookworm-slim rather than alpine, matching packages/web/Dockerfile: one base
# image for the whole repo is one set of CVEs to track, and viem's optional
# native bits and tini both come as ordinary Debian packages.
FROM node:22.14.0-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# pnpm version comes from the root "packageManager" field, so the container and
# the host resolve dependencies identically.
RUN corepack enable && corepack prepare pnpm@10.18.1 --activate
WORKDIR /repo


# =============================================================================
# artifacts -- provision the @nuvem/contracts-artifacts sibling FIRST
# =============================================================================
# Same stage, same reasoning, as packages/web/Dockerfile: turn "the ABIs are
# missing" into a build failure with a usable message instead of a
# MODULE_NOT_FOUND on the first tick. It matters more here than for the
# dashboard: the keeper decodes vault state and encodes an EIP-712 attestation
# with these ABIs, and a stale ABI is a silent-wrong-answer failure that ends in
# a signature over the wrong numbers.
FROM base AS artifacts
COPY packages/contracts-artifacts packages/contracts-artifacts
RUN set -eu; \
    d=packages/contracts-artifacts/dist; \
    if [ ! -f "$d/index.js" ] || [ ! -f "$d/index.json" ]; then \
      echo "=============================================================="; \
      echo "FATAL: packages/contracts-artifacts/dist is missing or partial."; \
      echo ""; \
      echo "It cannot be generated inside this image: Foundry is not"; \
      echo "installed, and the --skip-forge path still reads"; \
      echo "packages/contracts/out/, which is gitignored."; \
      echo ""; \
      echo "Regenerate on a host that has forge, then rebuild:"; \
      echo "  pnpm --dir packages/contracts-artifacts build"; \
      echo "=============================================================="; \
      exit 1; \
    fi; \
    for c in PersonalVault VaultFactory SettlementExecutor AttesterRegistry \
             AdapterRegistry FeeController FeeCollector ProtocolPauseController; do \
      if [ ! -f "$d/artifacts/$c.json" ]; then \
        echo "FATAL: $d/artifacts/$c.json missing -- dist/ is stale or truncated."; \
        echo "Regenerate with: pnpm --dir packages/contracts-artifacts build"; \
        exit 1; \
      fi; \
    done; \
    node -e "const j=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));const n=Object.keys(j.contracts||{}).length;if(n<8){throw new Error('index.json lists only '+n+' contracts');}console.log('[artifacts] ok: '+n+' contracts, schema v'+j.schemaVersion);" "$d/index.json"


# =============================================================================
# deps -- lockfile-only layer, stays cached until dependencies change
# =============================================================================
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
# THE ONLY RULE THAT MATTERS HERE: EVERY PATH BELOW MUST EXIST.
#
# A COPY whose source is missing does not fail the step -- it fails the build
# before any step runs, while BuildKit is computing cache keys, with
# "failed to compute cache key: ... not found". Every other stage is cancelled
# and reported as an error, so the log blames whichever step happened to be in
# flight. That is what broke the deploy on 2026-08-29: this list still copied
# packages/web/package.json, deleted in 9dce569 ("eliminar web normal/testing")
# when the dashboard became packages/website-oficial, and the build log accused
# an unrelated apt-get in the runner stage.
#
# THE COMMENT THAT USED TO BE HERE WAS WRONG, and being wrong is how the rot
# survived. It claimed all workspace manifests were required, because
# --frozen-lockfile validates against every importer in the lockfile and a
# missing one "fails the install outright". Measured against pnpm 10.18.1, with
# this repo's lockfile: it does not. pnpm discovers packages from disk via the
# packages/* glob and ignores lockfile importers with no directory -- the
# lockfile still carries a stale packages/web importer today and the install
# prints "Lockfile is up to date". packages/solana-core-old and
# packages/website-oficial have never been in this list, for the same reason.
#
# So this is NOT the workspace's manifest list; it is the subset the keeper's
# own dependency closure needs, and adding to it has a real cost: a manifest
# listed here puts that package's dependency changes in the keeper's install
# layer, so an unrelated edit busts this cache. `--filter "@nuvem/keeper..."`
# resolves to 3 of 6 projects; the rest are here only because they are cheap and
# already correct.
#
# packages/keeper-old/test/dockerfile-copy-sources.test.ts asserts every path below
# exists, so the next deletion breaks a test instead of a deploy.
COPY packages/contracts/package.json            packages/contracts/
COPY packages/contracts-artifacts/package.json  packages/contracts-artifacts/
COPY packages/session-engine-old/package.json       packages/session-engine-old/
COPY packages/aa-smoke-old/package.json             packages/aa-smoke-old/
COPY packages/keeper-old/package.json               packages/keeper-old/
# "@nuvem/keeper..." means "keeper plus everything it depends on", which pulls in
# @nuvem/session-engine and @nuvem/contracts-artifacts and nothing else. Do NOT
# use a bare `pnpm install -r`: packages/contracts drags in
# @openzeppelin/contracts and -upgradeable (tens of MB of Solidity source) that
# the keeper cannot use, and its forge-std submodule may be uninitialised in a CI
# or Railway clone. packages/web would drag in Next.
#
# devDependencies of the SELECTED workspace packages are installed on purpose:
# @nuvem/session-engine's package "exports" point at dist/src/session.js, so the
# image has to run its `tsc` to have anything to import, and typescript is a
# devDependency.
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
RUN pnpm install --frozen-lockfile --filter "@nuvem/keeper..."


# =============================================================================
# builder -- build session-engine, build the keeper, then prune to a deploy tree
# =============================================================================
FROM deps AS builder

# Committed ABIs from the stage above, copied before the sources so an edit to
# keeper code does not invalidate this layer.
COPY --from=artifacts /repo/packages/contracts-artifacts/dist packages/contracts-artifacts/dist

COPY packages/session-engine-old packages/session-engine-old
COPY packages/keeper-old packages/keeper-old

# -----------------------------------------------------------------------------
# [engine-contract] -- THE PRECONDITION packages/keeper-old/src/engine.ts RIDES ON.
#
# engine.ts imports @nuvem/session-engine through PATH specifiers into that
# package's own src/ (see its header for why the bare specifier cannot work:
# the "exports" map publishes one entry, dist ships no .d.ts, and its committed
# dist is missing detector.js). A path import bypasses "exports". It does NOT
# bypass packaging.
#
# `pnpm deploy` copies each workspace package as it is on disk, HONOURING its
# "files" field. session-engine declaring NO "files" field is therefore the only
# reason src/*.ts reaches /out at all — and it is a silent dependency on the
# ABSENCE of a field, in a package the keeper does not own, with no signal
# anywhere else. Adding `"files": ["dist"]` over there is a reasonable, local,
# tidy-up-looking change; the workspace would keep working (pnpm links the
# package directory), `pnpm build` here would keep passing (the typecheck
# resolves through that same symlink), and only the CONTAINER would break, at
# boot, in the service that holds the signing keys.
#
# So the precondition is checked directly, at its root cause, early, and loudly.
# The downstream file-level check is [engine-graph], after the deploy below.
# -----------------------------------------------------------------------------
RUN set -eu; \
    node -e ' \
      const fs=require("fs"); \
      const p="/repo/packages/session-engine-old/package.json"; \
      const pkg=JSON.parse(fs.readFileSync(p,"utf8")); \
      if (pkg.files === undefined) { console.log("[engine-contract] ok: @nuvem/session-engine declares no \"files\" field, so pnpm deploy copies src/"); process.exit(0); } \
      console.error("=============================================================="); \
      console.error("FATAL [engine-contract]: packages/session-engine-old/package.json"); \
      console.error("now declares a \"files\" field:"); \
      console.error("  " + JSON.stringify(pkg.files)); \
      console.error(""); \
      console.error("packages/keeper-old/src/engine.ts imports that package through"); \
      console.error("  ../node_modules/@nuvem/session-engine/src/<module>.js"); \
      console.error("and `pnpm deploy` honours \"files\", so src/ will no longer"); \
      console.error("reach the deploy tree and the image will die at boot with"); \
      console.error("ERR_MODULE_NOT_FOUND. Nothing else in this repo would have"); \
      console.error("told you: the workspace symlink hides it from `pnpm build`."); \
      console.error(""); \
      console.error("Pick one:"); \
      console.error("  a) include \"src\" in that \"files\" field, or"); \
      console.error("  b) better, give @nuvem/session-engine a subpath export"); \
      console.error("     (\"./src/*\": \"./dist/src/*.js\") AND \"declaration\": true"); \
      console.error("     in its tsconfig, then switch engine.ts to bare"); \
      console.error("     specifiers and delete this check."); \
      console.error("=============================================================="); \
      process.exit(1); \
    '

# @nuvem/session-engine MUST be built here. Its package.json exports
# "./dist/src/session.js" with no source fallback, so an unbuilt sibling is a
# boot-time ERR_MODULE_NOT_FOUND, not a type error. This is also why the runner
# below cannot simply copy the source tree.
RUN pnpm --filter @nuvem/session-engine run build \
 && test -f packages/session-engine-old/dist/src/session.js \
    || { echo "FATAL: session-engine build produced no dist/src/session.js"; exit 1; }

# Run the keeper's build script if it has one. As of writing that script is
# `tsc -p tsconfig.json --noEmit`, i.e. a TYPECHECK THAT EMITS NOTHING, so the
# entry point stays bin/keeper.mts and is run through tsx's in-process loader
# below.
#
# Keeping the typecheck in the image build is deliberate rather than incidental:
# tsx STRIPS types without checking them, so for a .mts entry point this is the
# only thing standing between a type error and a runtime crash in a service that
# signs transactions. It also typechecks test/ (see the package's tsconfig
# "include"), which is why test/ is not excluded from the build context.
#
# If the keeper ever gains an EMITTING build, everything downstream adapts on its
# own: the entry resolves to the compiled JS, the deploy tree below is pruned with
# --prod, and tsx stops being needed at runtime.
#
# Never the root `pnpm build` -- its first step is
# `pnpm --dir packages/contracts build`, i.e. forge build.
RUN set -eu; \
    if node -e "const s=require('/repo/packages/keeper-old/package.json').scripts||{};process.exit(s.build?0:1)"; then \
      echo "[keeper] running its build script"; \
      pnpm --filter @nuvem/keeper run build; \
    else \
      echo "[keeper] no build script; the TypeScript entry point will be run through tsx"; \
    fi

# -----------------------------------------------------------------------------
# Resolve the entry point ONCE, here, and record the decision.
#
# The same trick as packages/web/Dockerfile's nuvem-entry.path: the runner must
# not have to guess, and a wrong guess is a container that dies at boot instead
# of a build that fails with an explanation. The path is recorded RELATIVE to the
# package root, because that is what survives the `pnpm deploy` relocation.
# -----------------------------------------------------------------------------
RUN set -eu; \
    cd /repo/packages/keeper-old; \
    entry="$(node -e ' \
      const fs=require("fs"); \
      const pkg=JSON.parse(fs.readFileSync("package.json","utf8")); \
      const c=[]; const push=(p)=>{ if(typeof p==="string"&&p) c.push(p.replace(/^\.\//,"")); }; \
      if (typeof pkg.bin==="string") push(pkg.bin); \
      else if (pkg.bin && typeof pkg.bin==="object") Object.values(pkg.bin).forEach(push); \
      push(pkg.main); \
      ["dist/bin/keeper.mjs","dist/bin/keeper.js","dist/keeper.mjs","dist/keeper.js", \
       "dist/src/keeper.js","bin/keeper.mjs","bin/keeper.js","bin/keeper.mts"].forEach(push); \
      const hit=c.find((p)=>{ try { return fs.statSync(p).isFile(); } catch { return false; } }); \
      process.stdout.write(hit||""); \
    ')"; \
    if [ -z "$entry" ]; then \
      echo "=============================================================="; \
      echo "FATAL: cannot find an entry point for @nuvem/keeper."; \
      echo ""; \
      echo "Looked at package.json \"bin\" and \"main\", then at:"; \
      echo "  dist/bin/keeper.mjs  dist/bin/keeper.js"; \
      echo "  dist/keeper.mjs      dist/keeper.js   dist/src/keeper.js"; \
      echo "  bin/keeper.mjs       bin/keeper.js    bin/keeper.mts"; \
      echo ""; \
      echo "Fix packages/keeper-old/package.json to name it, e.g."; \
      echo "  \"bin\": { \"keeper\": \"bin/keeper.mts\" }"; \
      echo "=============================================================="; \
      exit 1; \
    fi; \
    printf '%s\n' "$entry" > /repo/keeper-entry.path; \
    echo "[keeper] entry point: $entry"

# -----------------------------------------------------------------------------
# Prune to a self-contained deploy tree at /out.
#
# `--legacy` is mandatory: pnpm 10 refuses a non-legacy `deploy` unless
# inject-workspace-packages=true, and this repo has no .npmrc setting it.
# `deploy` copies each workspace package AS IT IS ON DISK and honours its `files`
# field, which is why session-engine had to be built first.
#
# --prod is applied only when the entry point is already JavaScript. A .mts entry
# needs tsx, which is a devDependency, so pruning devDependencies there would
# produce an image that cannot start. Compiling the keeper (give it a `build`
# script) is the leaner option and gets you the --prod tree automatically.
# -----------------------------------------------------------------------------
RUN set -eu; \
    entry="$(cat /repo/keeper-entry.path)"; \
    case "$entry" in \
      *.mts|*.cts|*.ts) prod="" ; echo "[deploy] TypeScript entry -> keeping devDependencies (tsx)" ;; \
      *)               prod="--prod"; echo "[deploy] JavaScript entry -> --prod tree" ;; \
    esac; \
    pnpm deploy --legacy --filter @nuvem/keeper $prod /out; \
    test -f "/out/$entry" || { \
      echo "=============================================================="; \
      echo "FATAL: /out/$entry is missing after pnpm deploy."; \
      echo ""; \
      echo "pnpm deploy honours the package's \"files\" field. If"; \
      echo "packages/keeper-old/package.json declares one, it must include the"; \
      echo "directory holding the entry point (\"bin\" and/or \"dist\")."; \
      echo "=============================================================="; \
      exit 1; \
    }; \
    test -f /out/node_modules/@nuvem/contracts-artifacts/dist/index.js || { \
      echo "FATAL: @nuvem/contracts-artifacts/dist did not land in the deploy tree."; \
      echo "Its \"files\" field is [\"dist\",\"README.md\"], so dist/ must exist"; \
      echo "before pnpm deploy runs. The artifacts stage above copies it in."; \
      exit 1; \
    }

# -----------------------------------------------------------------------------
# [engine-graph] -- assert every module packages/keeper-old/src/engine.ts actually
# imports exists in the pruned tree.
#
# WHAT USED TO BE HERE, AND WHY IT WAS WORSE THAN NOTHING. This slot held
#
#     test -f /out/node_modules/@nuvem/session-engine/dist/src/session.js
#
# which asserted the presence of a path THE KEEPER DOES NOT LOAD. engine.ts
# imports `.../session-engine/src/session.js` — the package's own SOURCE, resolved
# by tsx — not `dist/src/session.js`. dist could be present and complete while
# src/ was absent, and this check would pass while the image was already
# guaranteed to die at boot. A green check on the wrong path is worse than no
# check: it is the reason nobody looked here.
#
# The list of modules is DERIVED FROM engine.ts ITSELF, by matching its
# `../node_modules/@nuvem/session-engine/...` specifiers, so there is no second
# list to keep in sync. Add an import over there and it is verified here on the
# next build. engine.ts's header documents the one thing that keeps this honest:
# the specifiers must stay plain double-quoted literals on the `from` line.
#
# The `.js` -> `.ts` fallback is the resolution tsx performs at runtime: engine.ts
# writes NodeNext-correct `.js` specifiers, and what has to be ON DISK is the
# TypeScript source they name.
# -----------------------------------------------------------------------------
RUN set -eu; \
    node -e ' \
      const fs=require("fs"); \
      const src=fs.readFileSync("/repo/packages/keeper-old/src/engine.ts","utf8"); \
      const specs=[...new Set([...src.matchAll(/"(\.\.\/node_modules\/@nuvem\/[^"]+)"/g)].map(m=>m[1]))]; \
      if (specs.length===0) { console.error("FATAL [engine-graph]: found no ../node_modules specifiers in src/engine.ts."); console.error("Either the import style changed (update this check, it is now blind) or the file moved."); process.exit(1); } \
      const missing=[]; \
      for (const spec of specs) { \
        const rel=spec.replace(/^\.\.\//,""); \
        const base="/out/"+rel; \
        const cands=[base, base.replace(/\.js$/,".ts"), base.replace(/\.js$/,".mts")]; \
        if (!cands.some((c)=>{ try { return fs.statSync(c).isFile(); } catch { return false; } })) missing.push({spec,cands}); \
      } \
      if (missing.length===0) { console.log("[engine-graph] ok: all "+specs.length+" session-engine modules present in the deploy tree"); process.exit(0); } \
      console.error("=============================================================="); \
      console.error("FATAL [engine-graph]: packages/keeper-old/src/engine.ts imports"); \
      console.error("modules that are NOT in the pruned deploy tree:"); \
      for (const m of missing) { console.error("  "+m.spec); for (const c of m.cands) console.error("      tried "+c); } \
      console.error(""); \
      console.error("The container would boot into ERR_MODULE_NOT_FOUND. The usual"); \
      console.error("cause is packages/session-engine-old/package.json gaining a"); \
      console.error("\"files\" field that omits src/ -- see [engine-contract] above,"); \
      console.error("which checks that directly and should have fired first."); \
      console.error("=============================================================="); \
      process.exit(1); \
    '

# -----------------------------------------------------------------------------
# [no-state] -- nothing that looks like the keeper's settled-window store may be
# in the tree that becomes the image.
#
# .dockerignore is the primary defence and it has been wrong before: it carried
# `**/keeper-state`, which does not match the ACTUAL default directory
# `.keeper-state` (leading dot; packages/keeper-old/src/config.ts). Any operator who
# had run the keeper on the build host baked their own realized-profit history,
# and the vault nonces they had already consumed, into the image. A build-context
# filter is invisible when it silently stops matching, so the outcome is asserted
# here, where a regression is a failed build instead of a published journal.
#
# `pnpm deploy` copies packages/keeper-old AS IT IS ON DISK, so a state directory
# that reached the context reaches /out and then the runner.
# -----------------------------------------------------------------------------
# `*-journal`, NOT `journal-*`. The broad form also matched
# packages/keeper-old/src/journal-store.ts — a SOURCE file — and failed the build
# claiming the operator's records were in the image. The rollback journal this
# is meant to catch sits beside its database as `<name>.db-journal`, which the
# suffix form matches and a source file cannot.
RUN set -eu; \
    hits="$(find /out \
              \( -name '.keeper-state' -o -name 'keeper-state' \) -type d -print -o \
              -type f \( -name '*.jsonl' -o -name '*.sqlite' -o -name '*.sqlite-*' \
                         -o -name '*.db' -o -name '*.db-*' -o -name '*-journal' \
                         -o -name 'snapshot-*.json' -o -name 'keeper.lock' \) -print \
            | grep -v '/node_modules/\.pnpm/' || true)"; \
    if [ -n "$hits" ]; then \
      echo "=============================================================="; \
      echo "FATAL [no-state]: keeper state artefacts are in the image tree:"; \
      echo "$hits"; \
      echo ""; \
      echo "These are the operator's settled-window records. Shipping them"; \
      echo "means every container from this image starts believing a history"; \
      echo "it did not verify -- and shares it with every other container."; \
      echo ""; \
      echo "Fix the root .dockerignore (the keeper-state section), then"; \
      echo "rebuild with --no-cache. Do not delete them here: a build-context"; \
      echo "filter that silently stopped matching is the actual defect."; \
      echo "=============================================================="; \
      exit 1; \
    fi; \
    echo "[no-state] ok: no keeper state in the deploy tree"

# -----------------------------------------------------------------------------
# Generate the launcher.
#
# Two things this buys, both about SIGTERM:
#
#  1. `exec` means the keeper is the direct child of tini and PID 1 signals reach
#     it. A shell that merely runs node stays in the middle and swallows them.
#  2. For a TypeScript entry it uses `node --import tsx`, NOT the `tsx` CLI. The
#     CLI re-executes node in a CHILD process; SIGTERM then has to be forwarded,
#     which is exactly the extra hop that turns "stops cleanly mid-cycle" into
#     "docker stop waits 10 seconds and SIGKILLs". `--import` registers the
#     loader in-process, so there is one process from start to finish.
#
# "$@" is forwarded, so `docker run … --broadcast` and compose's
# `command: ["--broadcast"]` reach the keeper's own argument parser. That is
# deliberate: the image's default CMD carries NO arguments, so the default run is
# a dry run and enabling broadcast takes a visible, explicit override.
# -----------------------------------------------------------------------------
RUN set -eu; \
    entry="$(cat /repo/keeper-entry.path)"; \
    case "$entry" in \
      *.mts|*.cts|*.ts) \
        if [ ! -d /out/node_modules/tsx ]; then \
          echo "=============================================================="; \
          echo "FATAL: entry point $entry is TypeScript but tsx is not a"; \
          echo "dependency of @nuvem/keeper, so it cannot be run."; \
          echo ""; \
          echo "Pick one:"; \
          echo "  a) add a \"build\" script that compiles it to JS (leanest"; \
          echo "     image: the deploy tree is then pruned with --prod), or"; \
          echo "  b) add tsx to packages/keeper-old devDependencies (the repo"; \
          echo "     already pins tsx 4.23.1 everywhere)."; \
          echo ""; \
          echo "Do NOT reach for node --experimental-strip-types on 22.14: it"; \
          echo "cannot erase type-only imports without"; \
          echo "--experimental-transform-types, and a keeper is not the place"; \
          echo "to discover that at boot."; \
          echo "=============================================================="; \
          exit 1; \
        fi; \
        printf '%s\n' \
          '#!/bin/sh' \
          '# Generated by packages/keeper-old/Dockerfile. Do not edit in the image.' \
          'set -eu' \
          '# ONE IMAGE, TWO ROLES. The entry point resolved at build time is the' \
          '# single-account keeper, which is also the CLI (status, journal,' \
          '# recover) an operator needs when something is wrong. The supervisor' \
          '# is what a deployment actually runs. Which one starts is a DEPLOYMENT' \
          '# decision, not a build one, so it is an environment variable rather' \
          '# than a second image that could drift from this one.' \
          'if [ "${NUVEM_KEEPER_ROLE:-}" = "supervisor" ]; then' \
          '  if [ ! -f /app/bin/keeper-supervisor.mts ]; then' \
          '    echo "FATAL: NUVEM_KEEPER_ROLE=supervisor but bin/keeper-supervisor.mts is not in this image." >&2' \
          '    exit 1' \
          '  fi' \
          '  exec node --import tsx --enable-source-maps /app/bin/keeper-supervisor.mts "$@"' \
          'fi' \
          "exec node --import tsx --enable-source-maps /app/$entry \"\$@\"" \
          > /out/keeper-start.sh ;; \
      *) \
        printf '%s\n' \
          '#!/bin/sh' \
          '# Generated by packages/keeper-old/Dockerfile. Do not edit in the image.' \
          'set -eu' \
          '# A compiled image has no .mts to run, so asking for the supervisor' \
          '# here means the build and the deployment disagree. Refusing beats' \
          '# silently starting a single-account keeper that would settle for one' \
          '# user and ignore everybody else.' \
          'if [ "${NUVEM_KEEPER_ROLE:-}" = "supervisor" ]; then' \
          '  echo "FATAL: NUVEM_KEEPER_ROLE=supervisor, but this image was built from compiled JS" >&2' \
          '  echo "and no compiled supervisor entry was resolved. Rebuild, or unset the role." >&2' \
          '  exit 1' \
          'fi' \
          "exec node --enable-source-maps /app/$entry \"\$@\"" \
          > /out/keeper-start.sh ;; \
    esac; \
    chmod 0755 /out/keeper-start.sh; \
    cat /out/keeper-start.sh; \
    dangling="$(find /out -xtype l -print)"; \
    if [ -n "$dangling" ]; then \
      echo "FATAL: dangling symlinks in the deploy tree:"; echo "$dangling"; exit 1; \
    fi


# =============================================================================
# runner -- no pnpm, no lockfile, no install, non-root, tini as PID 1
# =============================================================================
FROM node:22.14.0-bookworm-slim AS runner
ENV NODE_ENV=production

# tini, because this process must die well. `docker compose stop` and a Railway
# redeploy both send SIGTERM and then SIGKILL after a grace period; the keeper
# may be mid-cycle, and mid-cycle for this service can mean "has just written an
# INTENT journal record and is about to broadcast". tini reaps zombies and, with
# -g, signals the whole process group rather than PID 1 alone, so nothing is left
# holding the state directory. compose's `init: true` would inject docker-init
# for the same purpose, but the image must not depend on the caller remembering
# `--init`.
#
# =============================================================================
# A FAILURE HERE MUST FAIL THE BUILD. THE ALTERNATIVE WAS TRIED AND WAS WORSE.
# =============================================================================
# For one commit this step was allowed to give up and continue without tini,
# behind a /usr/local/bin/nuvem-init wrapper that picked tini at start if it was
# there. That was written to fix a deploy failure it had misdiagnosed -- the real
# cause was a COPY of packages/web, deleted in 9dce569, which fails while
# BuildKit computes cache keys and cancels every sibling stage, including this
# one mid-apt. apt was never failing.
#
# And the fallback could not work anyway, which is the part worth keeping in
# writing. docs/RAILWAY.md tells the operator to set a Custom Start Command of
#   /usr/bin/tini -g -- /app/keeper-start.sh --broadcast
# and Railway REPLACES the image ENTRYPOINT with it rather than appending. So the
# wrapper was never on the path in production: a build that "survived" a missing
# tini would have produced an image whose start command names a file that is not
# there, and the container would crash-loop on exec while the build showed green.
# A broken build is loud, safe and fixed in minutes. A crash-loop after a green
# build is neither.
#
# THE RETRY STAYS, because a Debian mirror really can hiccup and three attempts
# cost nothing. What is gone is the part that pretended success.
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
    echo "FATAL: could not install tini after 3 attempts."; \
    echo "It is the image ENTRYPOINT and the documented Railway start command,"; \
    echo "so an image without it cannot start. Failing the build on purpose."; \
    exit 1

# -----------------------------------------------------------------------------
# Configuration defaults. Non-secret only -- see the header. Every one of these
# is overridable at runtime, and overriding them is a restart, not a rebuild.
# -----------------------------------------------------------------------------
# Robinhood Chain. NOTE for anything reading blocks: Solidity block.number on
# this chain is the L1 block number, ~3.5M below the L2 block number. The
# attestation's startBlock/endBlock are L1; the session engine works in L2.
ENV NUVEM_CHAIN_ID=4663

# The durable, correctness-critical settled-window ledger. MUST be a mounted
# volume in any real deployment: losing it is recoverable (the keeper rebuilds
# from chain logs) but only if the operator knows it happened. Docker copies this
# directory's ownership into a freshly created named volume, which is the only
# reason a non-root process can write to it -- see the mkdir/chown below.
ENV NUVEM_KEEPER_STATE_DIR=/var/lib/nuvem/keeper

# Heartbeat surface. /health is RPC-free and volume-free so a probe cannot turn
# an upstream RPC hiccup into a restart loop; /status is the operator view. Bound
# to 0.0.0.0 so a sibling container on the compose network can read /status; NOT
# published to the host by docker-compose.yml.
ENV NUVEM_KEEPER_HTTP_HOST=0.0.0.0
ENV NUVEM_KEEPER_HTTP_PORT=8787

# Poll interval. ~7 L2 blocks/second on this chain, so 30s is ~210 blocks per
# tick -- negligible latency against the ~12s L1 block the settle has to wait for
# anyway.
ENV NUVEM_KEEPER_POLL_MS=30000

# ===========================================================================
# DRY RUN IS THE DEFAULT, IN THE IMAGE, WITH NO ARGUMENTS.
#
# Broadcasting requires BOTH of:
#   * the --broadcast argument, which the default CMD does not pass, and
#   * NUVEM_KEEPER_ALLOW_BROADCAST set to the exact literal
#     i-understand-this-moves-real-funds
#
# An exact-match sentinel, not a truthy check: "1", "true" and "yes" must not
# enable it, because those are what a copied config file and a stale shell export
# contain. Two gates of different kinds (argv and env) mean no single careless
# `docker compose up -d` or `docker run` can move money.
# ===========================================================================
ENV NUVEM_KEEPER_ALLOW_BROADCAST=""

# -----------------------------------------------------------------------------
# Secret-shaped variables, declared EMPTY on purpose.
#
# Never given a value here and never an ARG: a build ARG or a populated ENV is
# recorded in image history and in the image config, readable by anyone who can
# pull. These lines exist only to document the names and to ensure the process
# starts from an empty string.
#
# Prefer NUVEM_ATTESTER_KEY_FILE (a mounted file, mode 0400) over the inline
# variable: a value passed as an environment variable is visible in
# `docker inspect` and in /proc/1/environ for the whole life of the container.
# -----------------------------------------------------------------------------
ENV NUVEM_ATTESTER_KEY_FILE=""
ENV NUVEM_ATTESTER_PRIVATE_KEY=""
ENV TRADING_OWNER_PRIVATE_KEY=""
ENV NUVEM_RPC_URL=""

WORKDIR /app
RUN groupadd --gid 1001 nuvem \
 && useradd --uid 1001 --gid nuvem --create-home keeper

COPY --from=builder --chown=keeper:nuvem /out ./

# The state directory must exist IN THE IMAGE with the right ownership. Docker
# initialises a newly created named volume from the image's content and
# permissions at the mount point; if the directory is absent, the volume is
# created root-owned and the first journal write dies with EACCES. 0700 because
# the journal records every settlement this service has made.
RUN install -d -m 0700 -o keeper -g nuvem /var/lib/nuvem/keeper

# No VOLUME instruction, deliberately. VOLUME would make a bare `docker run`
# silently create an ANONYMOUS volume for the ledger: the state would survive the
# container, be invisible in `docker volume ls` except as a hash, and be orphaned
# on the next `docker rm`. A missing `-v` should be a visible operator decision,
# not something the image papers over. docker-compose.yml declares the named
# volume explicitly.

USER keeper

# =============================================================================
# [preflight] -- RUN THE REAL ENTRY POINT, IN THIS IMAGE, AT BUILD TIME.
# =============================================================================
# This is the check that replaces a `test -f` on a path nobody loads. Nothing
# short of executing the entry proves the runtime graph resolves: the keeper is
# TypeScript run through tsx's in-process loader, its dependency on
# @nuvem/session-engine is a PATH into that package's src/, and the tree it runs
# from is a pruned `pnpm deploy` copy, not the workspace. Every one of those is a
# way for the image to build green and die at boot -- which is exactly what
# happened once already (`../../session-engine` resolving to /session-engine).
#
# `__nuvem_preflight__` is not a known subcommand, so bin/keeper.mts rejects it
# in its argument parser and exits. THE POINT IS WHERE THAT HAPPENS: argv is
# parsed AFTER every top-level import of the entry has resolved and evaluated --
# src/attest, config, engine (and through it all of session-engine's src/),
# keeper, ledger, health, log, onchain, reconcile, submit, plus viem and the
# contracts artifacts -- and BEFORE loadConfig(). So reaching the rejection is
# proof the whole graph loaded, and it needs no RPC URL, no signing key, no
# state directory and no network. It cannot settle anything: it exits before the
# process has read a key or looked at a chain.
#
# Run as USER keeper on purpose, so a permission mistake in the COPY --chown
# fails here rather than in production.
#
# Output goes to FILES, not to the pipe docker gives us: node's stderr to a pipe
# is asynchronous, and `process.exit()` immediately after a write can truncate
# it. To a file it is synchronous, so the assertion below cannot flake.
#
# Nothing secret can appear in what is echoed: every secret-shaped ENV above is
# the empty string at build time and this process exits before reading config.
#
# IF THIS FAILS AND THE GRAPH IS FINE: bin/keeper.mts's argument grammar changed.
# Update the sentinel and the expected diagnostic below together -- deliberately,
# noisily, in one place -- rather than loosening the assertion.
# =============================================================================
RUN <<'PREFLIGHT'
set -eu
out=/tmp/preflight.out
err=/tmp/preflight.err
code=0
/app/keeper-start.sh __nuvem_preflight__ >"$out" 2>"$err" || code=$?

echo "[preflight] exit=$code"
echo "[preflight] --- stderr ---"
cat "$err"
echo "[preflight] --------------"

# A module-resolution or type-stripping failure. These are the failures this
# check exists for, and they are named so the build log says which one it was.
if grep -qE 'ERR_MODULE_NOT_FOUND|ERR_PACKAGE_PATH_NOT_EXPORTED|ERR_UNKNOWN_FILE_EXTENSION|ERR_REQUIRE_ESM|Cannot find (module|package)|SyntaxError' "$err"; then
  echo "=============================================================="
  echo "FATAL [preflight]: the keeper's module graph does not load in"
  echo "this image. The stderr above is what the container would print"
  echo "at boot, before reading a line of configuration."
  echo ""
  echo "Most likely causes, in order:"
  echo "  * packages/keeper-old/src/engine.ts imports session-engine by path"
  echo "    into its src/; if src/ is missing from the deploy tree the"
  echo "    [engine-contract] / [engine-graph] checks above should have"
  echo "    fired first -- if they did not, they have gone blind."
  echo "  * a relative import that escapes the package (../../something)"
  echo "    and only resolves in the monorepo checkout."
  echo "  * a runtime dependency that is a devDependency and was pruned."
  echo "=============================================================="
  exit 1
fi

# The positive proof: the CLI's own argument parser answered. It runs only after
# every top-level import above it has been evaluated.
if ! grep -q 'unknown command' "$err"; then
  echo "=============================================================="
  echo "FATAL [preflight]: the entry point ran but did not produce the"
  echo "expected 'unknown command' rejection for __nuvem_preflight__."
  echo ""
  echo "Either bin/keeper.mts's argument grammar changed -- in which"
  echo "case update the sentinel and this assertion together -- or the"
  echo "process died before reaching the parser. Either way this check"
  echo "is no longer proving the module graph loads, so it fails rather"
  echo "than passing on a technicality."
  echo "=============================================================="
  exit 1
fi

# Exit 2 is what bin/keeper.mts uses for a bad invocation. A different code with
# the right message means the grammar moved under us; say so rather than pass.
if [ "$code" != "2" ]; then
  echo "FATAL [preflight]: expected exit 2 for an unknown command, got $code."
  exit 1
fi

echo "[preflight] ok: the full runtime module graph loads under tsx in this image"
rm -f "$out" "$err"
PREFLIGHT

# Documentation only -- Docker publishes nothing from this and Railway ignores it
# entirely. docker-compose.yml deliberately does NOT map it to a host port: the
# keeper is reachable at http://keeper:8787/status from inside the compose
# network and nowhere else.
EXPOSE 8787

# curl and wget are absent from the slim runtime on purpose -- node's own fetch
# needs no extra attack surface. The probe hits /health, which by contract makes
# no RPC call and touches no volume.
#
# Note what this probe must NOT do: it must not fail because the keeper is halted
# (degraded latch set), in dry-run mode, or unable to reach the RPC. Restarting
# has never once fixed an upstream RPC, and a halted keeper has to stay up to
# explain itself. Only a wedged tick loop should turn this red. compose does not
# restart on unhealthy by itself, so at worst a red probe is a signal in
# `docker compose ps` -- watch it, and alert on /status.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.NUVEM_KEEPER_HTTP_PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# tini -g: signal the process group, not just PID 1, so a SIGTERM arriving
# mid-cycle stops the keeper cleanly instead of being absorbed. Keep this in step
# with the Custom Start Command in docs/RAILWAY.md -- Railway replaces this line
# rather than appending to it, so the two must name the same program.
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/app/keeper-start.sh"]

# EMPTY ON PURPOSE. The default run takes no arguments, and no arguments means
# dry run. Broadcasting is an explicit `command: ["--broadcast"]` override plus
# the NUVEM_KEEPER_ALLOW_BROADCAST sentinel above.
CMD []
