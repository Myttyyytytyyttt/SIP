#!/usr/bin/env bash
#
# The whole spot-listing shipping flow, one key paste: deploy the adapter for
# the asset named by the argument (INDEX, CASHCAT, …), then walk the Safe
# proposal, the 900-second timelock, and the execution. At the end it prints
# the exact env values the web and the keeper need.
#
# It is TWO SCRIPTS UNDER ONE PROMPT, not a rewrite of either: deploy and
# register keep their own validations and their own typed confirmations
# (DEPLOY, PROPOSE, EXECUTE — each is a last reversible moment and stays).
# This wrapper only asks for the key once and hands it to both through the
# environment, the same channel each already honors.
#
# Resumable like its parts: if the deploy already happened, deploy-index-adapter.sh
# is skipped (the broadcast artifact exists and register reads the address from
# it); if the registration is half-done, register-index-adapter.sh picks up at
# whatever step is left.
#
# THE KEY IS NEVER WRITTEN TO DISK OR SHELL HISTORY. Read with echo off, and
# unset on every exit path including Ctrl-C. It does pass through cast's argv
# during signing (same-user process table); on a shared machine prefer
# `cast wallet import` + --account in the underlying scripts instead.

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

# ── WHICH asset — the wrapper only needs the token, to know WHOSE artifact
# run-latest.json currently is. The full pin tables live in the two children;
# this row must merely agree with theirs on the address.
case "${1:-}" in
  INDEX)   TOKEN=0x56910D4409F3a0C78C64DD8D0545FF0705389870 ;;
  CASHCAT) TOKEN=0x020bfC650A365f8BB26819deAAbF3E21291018b4 ;;
  *)
    echo "Usage: $0 INDEX|CASHCAT"
    echo "The argument picks which token to ship; each pins its own pool and adapter."
    exit 1
    ;;
esac
ASSET="$1"

cleanup() { unset DEPLOYER_PRIVATE_KEY PK || true; }
trap cleanup EXIT INT TERM

BROADCAST=../broadcast/DeployIndexAdapter.s.sol/4663/run-latest.json

command -v cast >/dev/null || { echo "cast is not installed."; exit 1; }
command -v python3 >/dev/null || { echo "python3 is not installed."; exit 1; }

if [[ -z "${NUVEM_RPC_URL:-}" ]]; then
  KEEPER_ENV="$(cd ../.. && pwd)/keeper/.env"
  [[ -f "$KEEPER_ENV" ]] || { echo "No NUVEM_RPC_URL set and $KEEPER_ENV not found."; exit 1; }
  # `|| true`: under set -e a grep with no match would kill the script with no
  # diagnostic at all; the empty-check below is the one that gets to speak.
  NUVEM_RPC_URL="$(grep -m1 '^NUVEM_RPC_URL=' "$KEEPER_ENV" | cut -d= -f2- || true)"
  [[ -n "$NUVEM_RPC_URL" ]] || { echo "$KEEPER_ENV has no NUVEM_RPC_URL= line. Set NUVEM_RPC_URL and re-run."; exit 1; }
fi
export NUVEM_RPC_URL

lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

# WHOSE deploy run-latest.json is: read its CREATE address and ask the adapter
# itself which token it pins. The artifact file is shared by every asset this
# family ships, so existence alone proves nothing — skipping the deploy off a
# foreign artifact is exactly how the pHOOD3x run tried to register the pBTC3x
# desk (the register guard caught it; this asks first).
#
# FIVE ANSWERS, NOT TWO, because "cannot verify" must never be read as
# "foreign": an unparseable artifact can mean a half-finished broadcast whose
# immutable adapter ALREADY EXISTS on chain, and an RPC hiccup proves nothing
# about anything. Both must stop the operator, not walk them into a second
# deploy behind a normal-looking DEPLOY prompt.
artifact_state() {
  [[ -f "$BROADCAST" ]] || { echo absent; return; }
  local ADDR PINNED
  ADDR="$(python3 -c "
import json
d = json.load(open('$BROADCAST'))
print(next(t['contractAddress'] for t in d['transactions'] if t.get('transactionType') == 'CREATE'))
" 2>/dev/null)" || { echo unparseable; return; }
  PINNED="$(cast call "$ADDR" "INDEX()(address)" --rpc-url "$NUVEM_RPC_URL" 2>/dev/null)" || { echo unreadable; return; }
  if [[ "$(lower "$PINNED")" == "$(lower "$TOKEN")" ]]; then echo ours; else echo foreign; fi
}

refuse_to_guess() {
  echo ""
  echo "FATAL: cannot tell whose deployment $BROADCAST is ($1)."
  if [[ "$1" == "unparseable" ]]; then
    echo "  A broadcast may have HALF-FINISHED — the adapter may already exist on chain."
    echo "  Do NOT redeploy. Inspect the file; if the adapter exists, set"
    echo "  NUVEM_INDEX_ADAPTER=0x… and run ./register-index-adapter.sh $ASSET directly."
  else
    echo "  The RPC would not answer (or the recorded address has no code)."
    echo "  Nothing was decided. Check the endpoint and re-run — do NOT delete the artifact."
  fi
  exit 1
}

echo "════════════════════════════════════════════════════════════════════════"
echo "  Shipping $ASSET: deploy → register → the env values to configure."
echo "  One key, three typed confirmations (DEPLOY, PROPOSE, EXECUTE)."
echo "════════════════════════════════════════════════════════════════════════"
echo ""
read -rs -p "Private key for 0xB284f131eE5728272FA5fF1F6eae0896B4e2A3AA: " DEPLOYER_PRIVATE_KEY
echo ""
export DEPLOYER_PRIVATE_KEY
export PK="$DEPLOYER_PRIVATE_KEY"

# ── step 1: deploy, unless THIS asset's deploy already happened ──────────────
# The artifact is the authority on "already happened" — but only after it
# answers to this asset's token. A foreign artifact means the previous asset
# shipped from this machine; forge rotates it aside on the next broadcast.
STATE="$(artifact_state)"
case "$STATE" in
  ours)
    echo ""
    echo "A deployment artifact for $ASSET already exists; skipping the deploy."
    echo "  (delete $BROADCAST first if you truly mean to deploy a second adapter)"
    ;;
  absent|foreign)
    ./deploy-index-adapter.sh "$ASSET"
    ;;
  *)
    refuse_to_guess "$STATE"
    ;;
esac

# If the operator stopped at the DEPLOY prompt, deploy exits cleanly without
# broadcasting — the artifact is still absent, or still the previous asset's,
# and there is nothing to register. But an ERROR here is not "nothing
# happened": the broadcast may have just landed, and claiming otherwise on an
# RPC blip invites the operator to run the whole thing again.
STATE="$(artifact_state)"
case "$STATE" in
  ours) ;;
  absent|foreign)
    echo ""; echo "No $ASSET deployment happened; nothing to register. Stopped."; exit 0
    ;;
  *)
    refuse_to_guess "$STATE"
    ;;
esac

# ── step 2: register — proposes, waits out the timelock, executes ────────────
echo ""
./register-index-adapter.sh "$ASSET"
