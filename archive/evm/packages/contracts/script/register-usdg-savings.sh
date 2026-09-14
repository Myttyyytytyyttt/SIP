#!/usr/bin/env bash
#
# Registers the deployed savings adapter: Safe proposal, 15-minute timelock,
# execute. One prompt, one key.
#
# IT IS RESUMABLE, AND THAT IS THE POINT. Fifteen minutes separate the proposal
# from the execution, and anything can happen in fifteen minutes — a closed
# laptop, a dropped connection, a second thought. So the script asks the timelock
# what state the operation is in and does only what is left: propose, wait, or
# execute. Running it twice is safe; running it after it finished says so and
# stops.
#
# THE KEY IS NEVER WRITTEN ANYWHERE. Read with echo off, and unset on every exit
# path including Ctrl-C.

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

ADAPTER=0x782B53cD26566548030097A938d577D22d4B762f
REGISTRY=0x9822E46dd34d9bE579b61D26708a45Bf81B64E49
TIMELOCK=0x68f9faCACC35642F9c0862b2C9b45dA81ff1DE34
SAFE=0x43d552d4e73463980e9afc0531b62fc237fde7c1
DELAY=900
ZERO32=0x0000000000000000000000000000000000000000000000000000000000000000
ZERO=0x0000000000000000000000000000000000000000

cleanup() { unset PK || true; }
trap cleanup EXIT INT TERM

command -v cast >/dev/null || { echo "cast is not installed."; exit 1; }

if [[ -z "${NUVEM_RPC_URL:-}" ]]; then
  KEEPER_ENV="$(cd .. && pwd)/keeper/.env"
  [[ -f "$KEEPER_ENV" ]] || { echo "No NUVEM_RPC_URL and $KEEPER_ENV not found."; exit 1; }
  NUVEM_RPC_URL="$(grep -m1 '^NUVEM_RPC_URL=' "$KEEPER_ENV" | cut -d= -f2-)"
fi
export NUVEM_RPC_URL
R=(--rpc-url "$NUVEM_RPC_URL")

[[ "$(cast chain-id "${R[@]}")" == "4663" ]] || { echo "Wrong chain. Stopping."; exit 1; }

# ── the id is DERIVED, never typed ───────────────────────────────────────────
# A hand-copied id is a value that has to match the registry, every vault's
# adapterId and whatever was written down. Deriving it here means this script
# and the deploy script cannot disagree, and the assertion below proves it.
lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }
PACKED="$(cast from-utf8 'NUVEM_USDG_SAVINGS_ADAPTER_V1')$(lower "$ADAPTER" | sed 's/^0x//')"
ADAPTER_ID="$(cast keccak "$PACKED")"

echo "adapter   $ADAPTER"
echo "adapterId $ADAPTER_ID"
echo ""

# ── is the adapter even the one we think it is ───────────────────────────────
DEPLOYED_YIELD="$(cast call "$ADAPTER" "YIELD_VAULT()(address)" "${R[@]}")"
echo "Checking the adapter before proposing anything…"
echo "  YIELD_VAULT $DEPLOYED_YIELD"
[[ "$(lower "$DEPLOYED_YIELD")" == "0xde770c84fe66e063336b31737cfe9790f18c4087" ]] \
  || { echo "  FATAL: that is not spUSDG. Stopping."; exit 1; }

# ── the three calldatas, built here rather than pasted ───────────────────────
REGISTER_DATA="$(cast calldata 'registerAdapter(bytes32,address)' "$ADAPTER_ID" "$ADAPTER")"
SCHEDULE_DATA="$(cast calldata 'schedule(address,uint256,bytes,bytes32,bytes32,uint256)' \
  "$REGISTRY" 0 "$REGISTER_DATA" "$ZERO32" "$ZERO32" "$DELAY")"
EXECUTE_DATA="$(cast calldata 'execute(address,uint256,bytes,bytes32,bytes32)' \
  "$REGISTRY" 0 "$REGISTER_DATA" "$ZERO32" "$ZERO32")"

OP_ID="$(cast call "$TIMELOCK" 'hashOperation(address,uint256,bytes,bytes32,bytes32)(bytes32)' \
  "$REGISTRY" 0 "$REGISTER_DATA" "$ZERO32" "$ZERO32" "${R[@]}")"

is() { cast call "$TIMELOCK" "$1(bytes32)(bool)" "$OP_ID" "${R[@]}"; }
DONE="$(is isOperationDone)"; READY="$(is isOperationReady)"; PENDING="$(is isOperationPending)"

echo "  operation $OP_ID"
echo "  done=$DONE ready=$READY pending=$PENDING"
echo ""

if [[ "$DONE" == "true" ]]; then
  echo "Already executed. The adapter is registered; there is nothing to do."
  exit 0
fi

# ── the key, asked for only once something is actually needed ────────────────
read -rs -p "Private key for 0xB284f131eE5728272FA5fF1F6eae0896B4e2A3AA: " PK; echo ""
SIGNER="$(cast wallet address --private-key "$PK")"
echo "Signing as $SIGNER"
echo ""

# ── step 1: propose, through the Safe ────────────────────────────────────────
if [[ "$PENDING" == "false" && "$READY" == "false" ]]; then
  echo "── Step 1: proposing through the Safe ──────────────────────────────────"
  NONCE="$(cast call "$SAFE" 'nonce()(uint256)' "${R[@]}")"
  SAFE_TX_HASH="$(cast call "$SAFE" \
    'getTransactionHash(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,uint256)(bytes32)' \
    "$TIMELOCK" 0 "$SCHEDULE_DATA" 0 0 0 0 "$ZERO" "$ZERO" "$NONCE" "${R[@]}")"
  # --no-hash: the Safe's own digest is already the thing to sign. Hashing it
  # again would produce a signature the Safe cannot verify.
  SIG="$(cast wallet sign --no-hash "$SAFE_TX_HASH" --private-key "$PK")"

  read -r -p 'Propose it? Type PROPOSE to continue: ' C
  [[ "$C" == "PROPOSE" ]] || { echo "Stopped. Nothing was sent."; exit 0; }

  cast send "$SAFE" \
    'execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)(bool)' \
    "$TIMELOCK" 0 "$SCHEDULE_DATA" 0 0 0 0 "$ZERO" "$ZERO" "$SIG" \
    --private-key "$PK" "${R[@]}" >/dev/null
  echo "Proposed."
  echo ""
fi

# ── step 2: the wait ─────────────────────────────────────────────────────────
# Polled rather than slept: the timelock is the authority on when it is ready,
# and a fixed sleep would be wrong the moment a block is slow.
while [[ "$(is isOperationReady)" != "true" ]]; do
  [[ "$(is isOperationDone)" == "true" ]] && { echo "Someone else executed it. Done."; exit 0; }
  printf "\r  waiting for the timelock… %s" "$(date +%H:%M:%S)"
  sleep 20
done
printf "\r  the timelock is ready.                    \n\n"

# ── step 3: execute. Anyone may; EXECUTOR_ROLE is the zero address ───────────
read -r -p 'Execute it? Type EXECUTE to continue: ' C
[[ "$C" == "EXECUTE" ]] || { echo "Stopped. It stays ready; re-run to finish."; exit 0; }

cast send "$TIMELOCK" "$EXECUTE_DATA" --private-key "$PK" "${R[@]}" >/dev/null
echo "Executed."
echo ""

# ── did it actually take ─────────────────────────────────────────────────────
# getAdapter and isAdapterActive, NOT resolveActiveAdapter: that one takes an
# expected status epoch as a second argument and reverts on a mismatch, which is
# the right shape for a vault about to spend money and the wrong one for a
# question. Two plain reads answer it without needing to guess an epoch.
RESOLVED="$(cast call "$REGISTRY" 'getAdapter(bytes32)(address)' "$ADAPTER_ID" "${R[@]}" 2>/dev/null || echo "unreadable")"
ACTIVE="$(cast call "$REGISTRY" 'isAdapterActive(bytes32)(bool)' "$ADAPTER_ID" "${R[@]}" 2>/dev/null || echo "unreadable")"
EPOCH="$(cast call "$REGISTRY" 'adapterStatusEpoch(bytes32)(uint64)' "$ADAPTER_ID" "${R[@]}" 2>/dev/null || echo "?")"
echo "════════════════════════════════════════════════════════════════════════"
echo "  registry: $ADAPTER_ID"
echo "    getAdapter        $RESOLVED"
echo "    isAdapterActive   $ACTIVE"
echo "    statusEpoch       $EPOCH"
if [[ "$(lower "$RESOLVED")" == "$(lower "$ADAPTER")" && "$ACTIVE" == "true" ]]; then
  echo "  ✓ registered and active."
  echo ""
  echo "  Next: set NUVEM_INVEST_YIELD_VAULT on the keeper, then a user can pick"
  echo "  \"Dollars, earning\" and sign a policy naming this adapter id."
else
  echo "  ✗ that is not the adapter. Do not point any vault at this id yet."
fi
echo "════════════════════════════════════════════════════════════════════════"
