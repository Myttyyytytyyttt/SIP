#!/usr/bin/env bash
#
# Registers the deployed INDEX adapter: Safe proposal, 15-minute timelock,
# execute. One prompt, one key.
#
# IT IS RESUMABLE, AND THAT IS THE POINT — the same shape as
# register-usdg-savings.sh: it asks the timelock what state the operation is in
# and does only what is left: propose, wait, or execute. Running it twice is
# safe; running it after it finished says so and stops.
#
# THE KEY IS NEVER WRITTEN TO DISK OR SHELL HISTORY. Read with echo off, and
# unset on every exit path including Ctrl-C. It DOES appear in cast's argv for
# the duration of each signing call — visible to processes of the same user —
# so on a shared machine prefer `cast wallet import` once and `--account` here.

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

REGISTRY=0x9822E46dd34d9bE579b61D26708a45Bf81B64E49
TIMELOCK=0x68f9faCACC35642F9c0862b2C9b45dA81ff1DE34
SAFE=0x43d552d4e73463980e9afc0531b62fc237fde7c1
DELAY=900
ZERO32=0x0000000000000000000000000000000000000000000000000000000000000000
ZERO=0x0000000000000000000000000000000000000000

# ── WHICH asset, by argument — must match the deploy's table exactly ─────────
# The INDEX() check below doubles as ARTIFACT OWNERSHIP: run-latest.json is
# shared by every asset this script family deploys, so registering CASHCAT
# against an artifact that is really INDEX's dies here, loudly, before any
# proposal — the same guard that saved the pHOOD3x run.
case "${1:-}" in
  INDEX)
    EXPECT_INDEX=0x56910D4409F3a0C78C64DD8D0545FF0705389870
    EXPECT_FEE=9500
    EXPECT_TICK=190
    DISPLAY_NAME="The Index"
    ;;
  CASHCAT)
    EXPECT_INDEX=0x020bfC650A365f8BB26819deAAbF3E21291018b4
    EXPECT_FEE=2690
    EXPECT_TICK=54
    DISPLAY_NAME="CashCat"
    ;;
  *)
    echo "Usage: $0 INDEX|CASHCAT"
    echo "The argument says which token the deployed adapter must pin."
    exit 1
    ;;
esac
ASSET="$1"

cleanup() { unset PK || true; }
trap cleanup EXIT INT TERM

command -v cast >/dev/null || { echo "cast is not installed."; exit 1; }
command -v python3 >/dev/null || { echo "python3 is not installed."; exit 1; }

# ── the adapter address: from the broadcast, or NUVEM_INDEX_ADAPTER ──────────
# Read from the deploy's own artifact rather than typed, so this script and the
# deployment cannot disagree about which contract is being put into service.
# "File absent" and "file unparseable" are DIFFERENT failures: the first means
# deploy first, the second must never be answered with a second deployment.
BROADCAST=broadcast/DeployIndexAdapter.s.sol/4663/run-latest.json
if [[ -z "${NUVEM_INDEX_ADAPTER:-}" ]]; then
  [[ -f "$BROADCAST" ]] || {
    echo "No deployment artifact at $BROADCAST."
    echo "Run ./script/deploy-index-adapter.sh first, or set NUVEM_INDEX_ADAPTER=0x… explicitly."
    exit 1
  }
  NUVEM_INDEX_ADAPTER="$(python3 -c "
import json
d = json.load(open('$BROADCAST'))
print(next(t['contractAddress'] for t in d['transactions'] if t.get('transactionType') == 'CREATE'))
")" || {
    echo "Could not parse $BROADCAST — the deployment may have half-finished."
    echo "Do NOT redeploy; inspect the file, then set NUVEM_INDEX_ADAPTER=0x… by hand."
    exit 1
  }
fi
ADAPTER="$NUVEM_INDEX_ADAPTER"

if [[ -z "${NUVEM_RPC_URL:-}" ]]; then
  KEEPER_ENV="$(cd .. && pwd)/keeper/.env"
  [[ -f "$KEEPER_ENV" ]] || { echo "No NUVEM_RPC_URL and $KEEPER_ENV not found."; exit 1; }
  # `|| true`: under pipefail a missing line would kill the script with no
  # diagnostic; the empty-check below is the one that gets to speak.
  NUVEM_RPC_URL="$(grep -m1 '^NUVEM_RPC_URL=' "$KEEPER_ENV" | cut -d= -f2- || true)"
  [[ -n "$NUVEM_RPC_URL" ]] || { echo "$KEEPER_ENV has no NUVEM_RPC_URL= line. Set NUVEM_RPC_URL and re-run."; exit 1; }
fi
export NUVEM_RPC_URL
R=(--rpc-url "$NUVEM_RPC_URL")

[[ "$(cast chain-id "${R[@]}")" == "4663" ]] || { echo "Wrong chain. Stopping."; exit 1; }

lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

# ── the id is DERIVED, never typed — same rule as every adapter family ───────
PACKED="$(cast from-utf8 'NUVEM_INDEX_ADAPTER_V1')$(lower "$ADAPTER" | sed 's/^0x//')"
ADAPTER_ID="$(cast keccak "$PACKED")"

echo "adapter   $ADAPTER"
echo "adapterId $ADAPTER_ID"
echo ""

# ── is the adapter even the one we think it is ───────────────────────────────
echo "Checking the adapter before proposing anything…"
DEPLOYED_INDEX="$(cast call "$ADAPTER" "INDEX()(address)" "${R[@]}")"
echo "  INDEX $DEPLOYED_INDEX"
[[ "$(lower "$DEPLOYED_INDEX")" == "$(lower "$EXPECT_INDEX")" ]] \
  || { echo "  FATAL: that adapter does not pin the $ASSET token — the broadcast artifact"
       echo "  likely belongs to a DIFFERENT asset's deploy. Deploy $ASSET first. Stopping."; exit 1; }
# FIELD-EXACT, NOT A SUBSTRING MATCH over the flattened output — "190" is a
# substring of plenty of wrong tick spacings. cast prints one value per line,
# sometimes with a bracketed annotation; awk takes the first field of each.
CFG="$(cast call "$ADAPTER" "getIndexConfig()(uint24,int24)" "${R[@]}")"
GOT_FEE="$(printf '%s\n' "$CFG" | awk 'NR==1{print $1}')"
GOT_TICK="$(printf '%s\n' "$CFG" | awk 'NR==2{print $1}')"
echo "  USDG/$ASSET pool fee=$GOT_FEE tickSpacing=$GOT_TICK"
[[ "$GOT_FEE" == "$EXPECT_FEE" && "$GOT_TICK" == "$EXPECT_TICK" ]] \
  || { echo "  FATAL: the adapter pins $GOT_FEE/$GOT_TICK, not $EXPECT_FEE/$EXPECT_TICK. Stopping."; exit 1; }

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
# Honors a PK already in the environment, so ship-index.sh can ask once for the
# whole deploy-then-register flow — the same pattern the deploy script has with
# DEPLOYER_PRIVATE_KEY.
if [[ -z "${PK:-}" ]]; then
  read -rs -p "Private key for 0xB284f131eE5728272FA5fF1F6eae0896B4e2A3AA: " PK; echo ""
fi
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
  # --no-hash: the Safe's own digest is already the thing to sign.
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

# ── step 2: the wait, polled — the timelock is the authority on readiness ────
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

# ── did it actually take — two plain reads, not resolveActiveAdapter ─────────
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
  echo "  Next, the env values (paste the VALUE only, never the NAME= prefix):"
  echo ""
  echo "  Web — add this entry to NUVEM_INDEX_LISTINGS (comma-separated):"
  echo "    $ASSET:$EXPECT_INDEX:$ADAPTER_ID:$DISPLAY_NAME"
  echo "  APPEND if $ASSET is not listed yet; if this is a REDEPLOY of an"
  echo "  already-listed token, REPLACE its old entry — never keep two entries"
  echo "  for one token, the site refuses the duplicate."
  echo ""
  echo "  Keeper — APPEND this entry to NUVEM_INVEST_POOLS (comma-separated):"
  echo "    $(lower "$EXPECT_INDEX"):$EXPECT_FEE:$EXPECT_TICK"
  echo ""
  echo "  Then a user can pick $ASSET and sign a policy naming this adapter id."
else
  echo "  ✗ that is not the adapter. Do not point any vault at this id yet."
fi
echo "════════════════════════════════════════════════════════════════════════"
