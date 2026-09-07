#!/usr/bin/env bash
# Bring up everything a Nuvem user touches, plus the service that saves for them.
#
# There are two halves and only one of them is the user's:
#
#   THE WEB APP is the product. Connect a wallet, create a vault, generate a
#   trading wallet, watch savings arrive. Nothing here is ever typed by a user.
#
#   THE SUPERVISOR is the startup's backend. It discovers every linked trading
#   account from the factory's logs, resolves each one to a Privy wallet, and
#   runs a keeper per account. A user never runs this; that was the whole point
#   of moving to Privy signers.
#
# BROADCASTING IS OPT-IN, AND DELIBERATELY SO. Without --live this comes up in
# dry run: every settlement is computed, journalled and reported, and nothing is
# sent. `--live` arms it, and requires the same byte-for-byte sentinel the
# single-account keeper has always required, because it is the point where real
# money starts moving.
#
#   ./scripts/nuvem-up.sh            # safe: computes everything, sends nothing
#   ./scripts/nuvem-up.sh --live     # arms settlement for every managed account

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT="$PWD"

LIVE=0
[[ "${1:-}" == "--live" ]] && LIVE=1

# The keeper's ledger is `node:sqlite`, which exists only from Node 22. Under an
# older Node the SUPERVISOR still starts — it never touches sqlite — and then
# every child it spawns dies instantly on ERR_UNKNOWN_BUILTIN_MODULE and is
# restarted forever. The visible symptom is a healthy-looking supervisor next to
# a vault that never grows, so the version is checked here, before anything runs.
WANT="$(tr -d 'v \n' < .nvmrc)"
HAVE="$(node --version 2>/dev/null | tr -d 'v')"
if [[ "${HAVE%%.*}" != "${WANT%%.*}" ]]; then
  if [[ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]]; then
    # shellcheck disable=SC1091
    . "${NVM_DIR:-$HOME/.nvm}/nvm.sh"
    nvm use "$WANT" >/dev/null 2>&1 || true
    HAVE="$(node --version 2>/dev/null | tr -d 'v')"
  fi
fi
if [[ "${HAVE%%.*}" != "${WANT%%.*}" ]]; then
  echo "Node $WANT is required (.nvmrc); this shell has ${HAVE:-none}." >&2
  echo "The keeper's ledger uses node:sqlite, which older versions do not have," >&2
  echo "so every keeper would crash-loop while the supervisor looked healthy." >&2
  echo "Run:  nvm use $WANT" >&2
  exit 2
fi
echo "Node $HAVE"

if [[ ! -f packages/keeper-old/.env ]]; then
  echo "packages/keeper-old/.env is missing. It holds the Privy credentials and the" >&2
  echo "chain endpoints the supervisor needs." >&2
  exit 2
fi

set -a
# shellcheck disable=SC1091
. packages/keeper-old/.env
set +a

: "${NUVEM_RPC_URL:?NUVEM_RPC_URL must be set in packages/keeper-old/.env}"
: "${NUVEM_VAULT_FACTORY:?NUVEM_VAULT_FACTORY must be set in packages/keeper-old/.env}"

# A tracing endpoint is not optional. The engine reconstructs native value flows
# from callTracer, and GMGN pays out by internal call with no log at all — so
# without traces every session is unmeasurable and nothing is ever saved.
if ! curl -s -m 20 -X POST "$NUVEM_RPC_URL" \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"debug_traceTransaction","params":["0x0000000000000000000000000000000000000000000000000000000000000000",{"tracer":"callTracer"}]}' \
  | grep -qv "does not exist/is not available"; then
  echo "NUVEM_RPC_URL does not support debug_traceTransaction." >&2
  echo "The session engine cannot measure a trade without it, so nothing would" >&2
  echo "ever be saved. Point NUVEM_RPC_URL at a tracing endpoint." >&2
  exit 2
fi

LOGS="$ROOT/.nuvem-logs"
mkdir -p "$LOGS"

cleanup() {
  echo ""
  echo "Stopping…"
  [[ -n "${WEB_PID:-}" ]] && kill "$WEB_PID" 2>/dev/null || true
  [[ -n "${SUP_PID:-}" ]] && kill "$SUP_PID" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "Starting the web app…"
(cd packages/web && pnpm dev > "$LOGS/web.log" 2>&1) &
WEB_PID=$!

echo "Starting the keeper supervisor…"
SUP_ARGS=()
if [[ $LIVE -eq 1 ]]; then
  export NUVEM_KEEPER_ALLOW_BROADCAST="i-understand-this-moves-real-funds"
  SUP_ARGS+=("--broadcast")
fi
(cd packages/keeper-old && npx tsx bin/keeper-supervisor.mts "${SUP_ARGS[@]:-}" > "$LOGS/supervisor.log" 2>&1) &
SUP_PID=$!

# Wait for the app rather than guessing at a sleep, so the URL printed below is
# one that actually answers.
for _ in $(seq 1 60); do
  if [[ "$(curl -s -m 2 -o /dev/null -w '%{http_code}' http://localhost:3000/ 2>/dev/null)" == "200" ]]; then
    break
  fi
  sleep 2
done

echo ""
echo "  Nuvem is up:  http://localhost:3000"
if [[ $LIVE -eq 1 ]]; then
  echo "  Settlement:   LIVE — profitable sessions will be swept into vaults."
else
  echo "  Settlement:   dry run. Everything is computed and journalled, nothing is sent."
  echo "                Re-run with --live to arm it."
fi
echo "  Logs:         $LOGS/web.log, $LOGS/supervisor.log"
echo ""
echo "Ctrl-C to stop both."
wait
