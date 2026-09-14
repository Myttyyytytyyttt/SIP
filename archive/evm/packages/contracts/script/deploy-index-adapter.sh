#!/usr/bin/env bash
#
# Deploys NuvemIndexAdapter to Robinhood Chain. One prompt, one key.
#
# WHAT THIS WILL NOT DO IS BROADCAST WITHOUT SHOWING YOU THE SIMULATION FIRST.
# The adapter is immutable — no owner, no setters, no pause — so a wrong
# constructor argument is not a bug to fix, it is a redeploy and another
# governance cycle.
#
# AND IT CHECKS THE POOL BEFORE ASKING FOR A KEY, because for INDEX that check
# is the whole game: at review time 107 of the 108 hookless INDEX/USDG pools
# were empty shells or fee traps charging 85–99.99%. Exactly one — fee 9500,
# tickSpacing 190 — carries real liquidity. Two eth_calls here confirm we are
# pinning that one and not a trap.
#
# It does not register the adapter. That is a Safe proposal plus a timelock,
# and nothing reaches this contract until it lands.
#
# THE KEY IS NEVER WRITTEN TO DISK OR SHELL HISTORY. Read with echo off,
# exported for the two forge invocations, and unset on every exit path
# including Ctrl-C. The balance check does pass it in cast's argv briefly —
# visible to processes of the same user — so on a shared machine prefer
# `cast wallet import` once and forge's `--account` instead.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

# ── the addresses, all verified against mainnet 4663 ─────────────────────────
WETH=0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73
USDG=0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168
POOL_MANAGER=0x8366a39CC670B4001A1121B8F6A443A643e40951
WETH_USDG_FEE=200
WETH_USDG_TICK=4

# ── WHICH asset, by argument — the adapter is generic, the pins are not ──────
# Each row is the ONE real hookless USDG pool for that token, verified on chain
# at listing time. For INDEX, 107 of 108 candidate pools were shells or fee
# traps charging 85–99.99% — the fee/tick pair below is the entire game. Do not
# "correct" these to rounder numbers.
case "${1:-}" in
  INDEX)
    INDEX=0x56910D4409F3a0C78C64DD8D0545FF0705389870
    USDG_INDEX_FEE=9500
    USDG_INDEX_TICK=190
    ;;
  CASHCAT)
    INDEX=0x020bfC650A365f8BB26819deAAbF3E21291018b4
    USDG_INDEX_FEE=2690
    USDG_INDEX_TICK=54
    ;;
  *)
    echo "Usage: $0 INDEX|CASHCAT"
    echo "The argument picks which token's adapter to deploy; each pins its own pool."
    exit 1
    ;;
esac
ASSET="$1"

cleanup() { unset DEPLOYER_PRIVATE_KEY || true; }
trap cleanup EXIT INT TERM

command -v forge   >/dev/null || { echo "forge is not installed."; exit 1; }
command -v cast    >/dev/null || { echo "cast is not installed."; exit 1; }
command -v python3 >/dev/null || { echo "python3 is not installed."; exit 1; }

# ── the RPC, from the keeper's own env so there is one source for it ─────────
if [[ -z "${NUVEM_RPC_URL:-}" ]]; then
  KEEPER_ENV="$(cd .. && pwd)/keeper/.env"
  [[ -f "$KEEPER_ENV" ]] || { echo "No NUVEM_RPC_URL set and $KEEPER_ENV not found."; exit 1; }
  # `|| true`: under pipefail a missing line would kill the script with no
  # diagnostic; the empty-check below is the one that gets to speak.
  NUVEM_RPC_URL="$(grep -m1 '^NUVEM_RPC_URL=' "$KEEPER_ENV" | cut -d= -f2- || true)"
  [[ -n "$NUVEM_RPC_URL" ]] || { echo "$KEEPER_ENV has no NUVEM_RPC_URL= line. Set NUVEM_RPC_URL and re-run."; exit 1; }
fi
export NUVEM_RPC_URL

CHAIN_ID="$(cast chain-id --rpc-url "$NUVEM_RPC_URL")"
[[ "$CHAIN_ID" == "4663" ]] || { echo "This RPC is chain $CHAIN_ID, not Robinhood Chain (4663). Stopping."; exit 1; }

# `tr` and not ${VAR,,}: macOS ships bash 3.2, where that expansion is a
# runtime syntax error `bash -n` does not catch.
lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

# ── preflight, before a key is even asked for ────────────────────────────────
echo "Checking the token and both pools before anything is signed…"

SYMBOL="$(cast call "$INDEX" "symbol()(string)" --rpc-url "$NUVEM_RPC_URL" | tr -d '"')"
DECIMALS="$(cast call "$INDEX" "decimals()(uint8)" --rpc-url "$NUVEM_RPC_URL")"
echo "  token          $SYMBOL ($DECIMALS decimals) at $INDEX"

# Reads the pool's own storage: pools mapping at slot 6, sqrtPrice at +0,
# liquidity at +3. A shell pool shows liquidity 0 and stops us here — the same
# two reads validate() repeats in the forge simulation, done early so a trap
# pool is caught before anyone types a key.
check_pool() {
  local A="$1" B="$2" FEE="$3" TICK="$4" NAME="$5"
  local C0 C1
  # Lexicographic comparison of equal-length lowercase hex IS numeric order.
  if [[ "$(lower "$A")" < "$(lower "$B")" ]]; then C0="$A"; C1="$B"; else C0="$B"; C1="$A"; fi
  local POOL_ID BASE LIQ_SLOT PRICE LIQ
  POOL_ID="$(cast keccak "$(cast abi-encode 'f(address,address,uint24,int24,address)' "$C0" "$C1" "$FEE" "$TICK" 0x0000000000000000000000000000000000000000)")"
  BASE="$(cast keccak "$(cast abi-encode 'f(bytes32,uint256)' "$POOL_ID" 6)")"
  LIQ_SLOT="$(python3 -c "print('0x'+format(int('$BASE',16)+3,'064x'))")"
  PRICE="$(cast call "$POOL_MANAGER" 'extsload(bytes32)(bytes32)' "$BASE" --rpc-url "$NUVEM_RPC_URL")"
  [[ "$PRICE" != "0x0000000000000000000000000000000000000000000000000000000000000000" ]] \
    || { echo "  FATAL: the $NAME pool ($FEE/$TICK) is not initialized. Stopping."; exit 1; }
  LIQ="$(cast call "$POOL_MANAGER" 'extsload(bytes32)(bytes32)' "$LIQ_SLOT" --rpc-url "$NUVEM_RPC_URL")"
  [[ "$LIQ" != "0x0000000000000000000000000000000000000000000000000000000000000000" ]] \
    || { echo "  FATAL: the $NAME pool ($FEE/$TICK) has ZERO liquidity — a shell or a trap. Stopping."; exit 1; }
  echo "  $NAME pool     initialized with liquidity, fee $FEE, tickSpacing $TICK"
}

check_pool "$WETH" "$USDG"  "$WETH_USDG_FEE"  "$WETH_USDG_TICK"  "WETH/USDG "
check_pool "$USDG" "$INDEX" "$USDG_INDEX_FEE" "$USDG_INDEX_TICK" "USDG/$ASSET"
echo ""

# ── the key ──────────────────────────────────────────────────────────────────
if [[ -z "${DEPLOYER_PRIVATE_KEY:-}" ]]; then
  read -rs -p "Private key for 0xB284f131eE5728272FA5fF1F6eae0896B4e2A3AA: " DEPLOYER_PRIVATE_KEY
  echo ""
fi
export DEPLOYER_PRIVATE_KEY

SIGNER="$(cast wallet address --private-key "$DEPLOYER_PRIVATE_KEY")"
echo "Signing as $SIGNER"
BALANCE="$(cast balance "$SIGNER" --rpc-url "$NUVEM_RPC_URL")"
echo "Balance      $(cast from-wei "$BALANCE") ETH"
echo ""

export NUVEM_WETH="$WETH" NUVEM_USDG="$USDG" NUVEM_INDEX="$INDEX" NUVEM_POOL_MANAGER="$POOL_MANAGER"
export NUVEM_WETH_USDG_FEE="$WETH_USDG_FEE" NUVEM_WETH_USDG_TICK_SPACING="$WETH_USDG_TICK"
export NUVEM_USDG_INDEX_FEE="$USDG_INDEX_FEE" NUVEM_USDG_INDEX_TICK_SPACING="$USDG_INDEX_TICK"

echo "── Simulating. Nothing is broadcast. ─────────────────────────────────────"
forge script script/DeployIndexAdapter.s.sol --rpc-url "$NUVEM_RPC_URL"
echo ""

# ── the one deliberate pause ─────────────────────────────────────────────────
read -r -p 'Deploy for real? Type DEPLOY to continue: ' CONFIRM
[[ "$CONFIRM" == "DEPLOY" ]] || { echo "Stopped. Nothing was broadcast."; exit 0; }

echo ""
echo "── Broadcasting ──────────────────────────────────────────────────────────"
forge script script/DeployIndexAdapter.s.sol --rpc-url "$NUVEM_RPC_URL" --broadcast

DEPLOYED="$(python3 -c "
import json
d = json.load(open('broadcast/DeployIndexAdapter.s.sol/4663/run-latest.json'))
print(next(t['contractAddress'] for t in d['transactions'] if t.get('transactionType') == 'CREATE'))
" 2>/dev/null || true)"

echo ""
echo "════════════════════════════════════════════════════════════════════════"
echo "  Deployed: ${DEPLOYED:-see the output above}"
echo ""
echo "  NOT REGISTERED, and nothing reaches it until it is. Next:"
echo "    ./script/register-index-adapter.sh $ASSET"
echo "  (reads the address from the broadcast automatically, walks the Safe"
echo "   proposal, the 900-second timelock, and the execution, resumably)."
echo "════════════════════════════════════════════════════════════════════════"
