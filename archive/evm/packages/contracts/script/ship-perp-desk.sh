#!/usr/bin/env bash
#
# The whole pToken desk flow, one key paste: deploy desk + adapter (armed),
# then the Safe proposal, the 900-second timelock, and the execution. Prints
# the funding instruction and the env values at the end.
#
# WORKS TODAY, unlike deploy-phood3x-adapter.sh: the desk only needs the
# pToken's convertToAssets (live), not its gated previewDeposit — that is the
# desk's whole reason to exist.
#
# Typed confirmations at every irreversible moment: DEPLOY, PROPOSE, EXECUTE.
# Resumable: a finished deploy is detected by its broadcast artifact; a
# half-done registration picks up at whatever step is left.
#
# THE KEY IS NEVER WRITTEN TO DISK OR SHELL HISTORY. Read with echo off, unset
# on every exit path. It appears in cast's argv briefly during signing —
# same-user process table — so on a shared machine prefer cast wallet import.

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

# ── pinned configuration ─────────────────────────────────────────────────────
WETH=0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73
USDG=0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168
POOL_MANAGER=0x8366a39CC670B4001A1121B8F6A443A643e40951
WETH_USDG_FEE=200
WETH_USDG_TICK=4
# The immutable spread. 100 bps covers the operator's ~70 bps RFQ round trip.
SPREAD_BPS=100

# THE PINNED TABLE, selected by argument — a new pToken is an edit a review can
# see here, never an env var a typo can reach. Usage: ./ship-perp-desk.sh pHOOD3x
case "${1:-}" in
  pBTC3x)  PERP_TOKEN=0x4472C69d299382F8847ebCE4FC6Ed8e295510E3e; DISPLAY_NAME="Arcus BTC 3x Long" ;;
  pHOOD3x) PERP_TOKEN=0xe24CABDf76DD1c2576049167eB1755C84b985C36; DISPLAY_NAME="Arcus HOOD 3x Long" ;;
  *) echo "Usage: $0 <pBTC3x|pHOOD3x> — the pToken must be one this file pins."; exit 1 ;;
esac
echo "Shipping a desk for ${1}: $PERP_TOKEN"

REGISTRY=0x9822E46dd34d9bE579b61D26708a45Bf81B64E49
TIMELOCK=0x68f9faCACC35642F9c0862b2C9b45dA81ff1DE34
SAFE=0x43d552d4e73463980e9afc0531b62fc237fde7c1
DELAY=900
ZERO32=0x0000000000000000000000000000000000000000000000000000000000000000
ZERO=0x0000000000000000000000000000000000000000
BROADCAST=broadcast/DeployPerpDesk.s.sol/4663/run-latest.json

cleanup() { unset DEPLOYER_PRIVATE_KEY PK || true; }
trap cleanup EXIT INT TERM

command -v forge   >/dev/null || { echo "forge is not installed."; exit 1; }
command -v cast    >/dev/null || { echo "cast is not installed."; exit 1; }
command -v python3 >/dev/null || { echo "python3 is not installed."; exit 1; }

if [[ -z "${NUVEM_RPC_URL:-}" ]]; then
  KEEPER_ENV="$(cd .. && pwd)/keeper/.env"
  [[ -f "$KEEPER_ENV" ]] || { echo "No NUVEM_RPC_URL set and $KEEPER_ENV not found."; exit 1; }
  NUVEM_RPC_URL="$(grep -m1 '^NUVEM_RPC_URL=' "$KEEPER_ENV" | cut -d= -f2-)"
fi
export NUVEM_RPC_URL
R=(--rpc-url "$NUVEM_RPC_URL")

[[ "$(cast chain-id "${R[@]}")" == "4663" ]] || { echo "Wrong chain. Stopping."; exit 1; }

lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

# ── preflight, before a key is asked for ─────────────────────────────────────
echo "Checking the pToken before anything is signed…"
SYMBOL="$(cast call "$PERP_TOKEN" "symbol()(string)" "${R[@]}" | tr -d '"')"
NAV="$(cast call "$PERP_TOKEN" "convertToAssets(uint256)(uint256)" 1000000000000000000 "${R[@]}" | awk '{print $1}')"
[[ -n "$NAV" && "$NAV" != "0" ]] || { echo "  FATAL: NAV unreadable or zero. Stopping."; exit 1; }
echo "  $SYMBOL — NAV: 1e18 shares = $NAV USDG (6 dec); desk will sell at NAV minus $SPREAD_BPS bps"
echo ""

read -rs -p "Private key for 0xB284f131eE5728272FA5fF1F6eae0896B4e2A3AA: " DEPLOYER_PRIVATE_KEY
echo ""
export DEPLOYER_PRIVATE_KEY
export PK="$DEPLOYER_PRIVATE_KEY"

export NUVEM_WETH="$WETH" NUVEM_USDG="$USDG" NUVEM_PERP_TOKEN="$PERP_TOKEN" NUVEM_POOL_MANAGER="$POOL_MANAGER"
export NUVEM_WETH_USDG_FEE="$WETH_USDG_FEE" NUVEM_WETH_USDG_TICK_SPACING="$WETH_USDG_TICK"
export NUVEM_DESK_SPREAD_BPS="$SPREAD_BPS"

# ── step 1: deploy desk + adapter, unless THIS token's already happened ──────
# forge overwrites run-latest.json per script, so the artifact may belong to a
# PREVIOUS token's desk. Resume only if its adapter pins THIS pToken; otherwise
# deploy fresh (the old desk is registered on chain and needs no artifact).
RESUME=no
if [[ -f "$BROADCAST" ]]; then
  PRIOR_ADAPTER="$(python3 -c "
import json
d = json.load(open('$BROADCAST'))
creates = [t['contractAddress'] for t in d['transactions'] if t.get('transactionType') == 'CREATE']
print(creates[1] if len(creates) > 1 else '')
" 2>/dev/null || true)"
  if [[ -n "$PRIOR_ADAPTER" ]]; then
    PRIOR_TOKEN="$(cast call "$PRIOR_ADAPTER" "PERP_TOKEN()(address)" "${R[@]}" 2>/dev/null || echo "")"
    if [[ "$(lower "$PRIOR_TOKEN")" == "$(lower "$PERP_TOKEN")" ]]; then RESUME=yes; fi
  fi
fi
if [[ "$RESUME" == "yes" ]]; then
  echo "This token's deployment artifact already exists; skipping the deploy."
else
  echo "── Simulating. Nothing is broadcast. ─────────────────────────────────"
  forge script script/DeployPerpDesk.s.sol "${R[@]}"
  echo ""
  read -r -p 'Deploy for real? Type DEPLOY to continue: ' CONFIRM
  [[ "$CONFIRM" == "DEPLOY" ]] || { echo "Stopped. Nothing was broadcast."; exit 0; }
  echo ""
  echo "── Broadcasting ──────────────────────────────────────────────────────"
  forge script script/DeployPerpDesk.s.sol "${R[@]}" --broadcast
fi
[[ -f "$BROADCAST" ]] || { echo "No deployment happened; nothing to register. Stopped."; exit 0; }

# Desk first, adapter second — the script deploys them in that order.
DESK="$(python3 -c "
import json
d = json.load(open('$BROADCAST'))
creates = [t['contractAddress'] for t in d['transactions'] if t.get('transactionType') == 'CREATE']
print(creates[0])
")" || { echo "Could not parse $BROADCAST. Do NOT redeploy; inspect it."; exit 1; }
ADAPTER="$(python3 -c "
import json
d = json.load(open('$BROADCAST'))
creates = [t['contractAddress'] for t in d['transactions'] if t.get('transactionType') == 'CREATE']
print(creates[1])
")" || { echo "Could not parse $BROADCAST. Do NOT redeploy; inspect it."; exit 1; }

# ── the id is DERIVED, never typed ───────────────────────────────────────────
PACKED="$(cast from-utf8 'NUVEM_PERP_DESK_ADAPTER_V1')$(lower "$ADAPTER" | sed 's/^0x//')"
ADAPTER_ID="$(cast keccak "$PACKED")"

echo ""
echo "desk      $DESK"
echo "adapter   $ADAPTER"
echo "adapterId $ADAPTER_ID"
echo ""

# ── is the pair even wired the way we think ──────────────────────────────────
echo "Checking the pair before proposing anything…"
GOT_PT="$(cast call "$ADAPTER" "PERP_TOKEN()(address)" "${R[@]}")"
[[ "$(lower "$GOT_PT")" == "$(lower "$PERP_TOKEN")" ]] || { echo "  FATAL: adapter pins $GOT_PT. Stopping."; exit 1; }
GOT_BUYER="$(cast call "$DESK" "buyer()(address)" "${R[@]}")"
[[ "$(lower "$GOT_BUYER")" == "$(lower "$ADAPTER")" ]] || { echo "  FATAL: desk armed with $GOT_BUYER. Stopping."; exit 1; }
GOT_SPREAD="$(cast call "$DESK" "SPREAD_BPS()(uint16)" "${R[@]}" | awk '{print $1}')"
[[ "$GOT_SPREAD" == "$SPREAD_BPS" ]] || { echo "  FATAL: desk spread is $GOT_SPREAD bps. Stopping."; exit 1; }
echo "  adapter pins the pToken, desk armed with the adapter, spread $GOT_SPREAD bps."

# ── register: propose, wait, execute — resumable ─────────────────────────────
REGISTER_DATA="$(cast calldata 'registerAdapter(bytes32,address)' "$ADAPTER_ID" "$ADAPTER")"
SCHEDULE_DATA="$(cast calldata 'schedule(address,uint256,bytes,bytes32,bytes32,uint256)' \
  "$REGISTRY" 0 "$REGISTER_DATA" "$ZERO32" "$ZERO32" "$DELAY")"
EXECUTE_DATA="$(cast calldata 'execute(address,uint256,bytes,bytes32,bytes32)' \
  "$REGISTRY" 0 "$REGISTER_DATA" "$ZERO32" "$ZERO32")"
OP_ID="$(cast call "$TIMELOCK" 'hashOperation(address,uint256,bytes,bytes32,bytes32)(bytes32)' \
  "$REGISTRY" 0 "$REGISTER_DATA" "$ZERO32" "$ZERO32" "${R[@]}")"

is() { cast call "$TIMELOCK" "$1(bytes32)(bool)" "$OP_ID" "${R[@]}"; }
DONE="$(is isOperationDone)"; READY="$(is isOperationReady)"; PENDING="$(is isOperationPending)"
echo "  operation $OP_ID  done=$DONE ready=$READY pending=$PENDING"
echo ""

if [[ "$DONE" != "true" ]]; then
  if [[ "$PENDING" == "false" && "$READY" == "false" ]]; then
    echo "── Proposing through the Safe ──────────────────────────────────────"
    NONCE="$(cast call "$SAFE" 'nonce()(uint256)' "${R[@]}")"
    SAFE_TX_HASH="$(cast call "$SAFE" \
      'getTransactionHash(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,uint256)(bytes32)' \
      "$TIMELOCK" 0 "$SCHEDULE_DATA" 0 0 0 0 "$ZERO" "$ZERO" "$NONCE" "${R[@]}")"
    SIG="$(cast wallet sign --no-hash "$SAFE_TX_HASH" --private-key "$PK")"
    read -r -p 'Propose it? Type PROPOSE to continue: ' C
    [[ "$C" == "PROPOSE" ]] || { echo "Stopped. Nothing was sent."; exit 0; }
    cast send "$SAFE" \
      'execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)(bool)' \
      "$TIMELOCK" 0 "$SCHEDULE_DATA" 0 0 0 0 "$ZERO" "$ZERO" "$SIG" \
      --private-key "$PK" "${R[@]}" >/dev/null
    echo "Proposed."
  fi
  while [[ "$(is isOperationReady)" != "true" ]]; do
    [[ "$(is isOperationDone)" == "true" ]] && { echo "Someone else executed it. Done."; break; }
    printf "\r  waiting for the timelock… %s" "$(date +%H:%M:%S)"
    sleep 20
  done
  if [[ "$(is isOperationDone)" != "true" ]]; then
    printf "\r  the timelock is ready.                    \n"
    read -r -p 'Execute it? Type EXECUTE to continue: ' C
    [[ "$C" == "EXECUTE" ]] || { echo "Stopped. It stays ready; re-run to finish."; exit 0; }
    cast send "$TIMELOCK" "$EXECUTE_DATA" --private-key "$PK" "${R[@]}" >/dev/null
    echo "Executed."
  fi
fi

# ── did it actually take ─────────────────────────────────────────────────────
RESOLVED="$(cast call "$REGISTRY" 'getAdapter(bytes32)(address)' "$ADAPTER_ID" "${R[@]}" 2>/dev/null || echo unreadable)"
ACTIVE="$(cast call "$REGISTRY" 'isAdapterActive(bytes32)(bool)' "$ADAPTER_ID" "${R[@]}" 2>/dev/null || echo unreadable)"
echo ""
echo "════════════════════════════════════════════════════════════════════════"
echo "  getAdapter      $RESOLVED"
echo "  isAdapterActive $ACTIVE"
if [[ "$(lower "$RESOLVED")" == "$(lower "$ADAPTER")" && "$ACTIVE" == "true" ]]; then
  echo "  ✓ registered and active."
  echo ""
  echo "  NEXT:"
  echo "  1. FUND THE DESK: buy ${1} on app.arcus.xyz and transfer it to"
  echo "     $DESK  (a plain wallet transfer; inventory is balanceOf)."
  echo "  2. Web env:    add to NUVEM_PERP_LISTINGS: ${1}:$PERP_TOKEN:$ADAPTER_ID:$DISPLAY_NAME"
  echo "     (one entry per pToken, comma-separated; the legacy single-listing"
  echo "      pair NUVEM_PERP_TOKEN_LISTING + NUVEM_PERP_ADAPTER_ID still works)"
  echo "     (the web wiring for this family ships in the next phase)"
  echo "  3. Keeper: the desk quotes via previewDeposit at $DESK —"
  echo "     keeper support ships in the next phase; nothing buys until then."
else
  echo "  ✗ that is not the adapter. Do not point any vault at this id yet."
fi
echo "════════════════════════════════════════════════════════════════════════"
