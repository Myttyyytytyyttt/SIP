#!/usr/bin/env bash
#
# Deploys NuvemUsdgSavingsAdapter to Robinhood Chain. One prompt, one key.
#
# WHAT THIS WILL NOT DO IS BROADCAST WITHOUT SHOWING YOU THE SIMULATION FIRST.
# The adapter is immutable — no owner, no setters, no pause — so a wrong
# constructor argument is not a bug to fix, it is a redeploy and another
# governance cycle. The dry run costs nothing and is the only free moment.
#
# It also does not register the adapter. That is a Safe proposal followed by a
# timelock, and nothing reaches this contract until it lands.
#
# THE KEY IS NEVER WRITTEN ANYWHERE. It is read with echo off, exported for the
# two forge invocations, and unset on every exit path including a Ctrl-C.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

# ── the addresses, all verified against mainnet 4663 ───────────────────────────
WETH=0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73
USDG=0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168
POOL_MANAGER=0x8366a39CC670B4001A1121B8F6A443A643e40951
FEE=200
TICK_SPACING=4
# spUSDG — Spark Savings USDG. NOT steakUSDG, which mints 18-decimal shares and
# whose Vault V2 max* semantics are a trap; this one is a standard 4626.
YIELD_VAULT=0xde770c84FE66E063336b31737cFE9790f18c4087

cleanup() { unset DEPLOYER_PRIVATE_KEY || true; }
trap cleanup EXIT INT TERM

command -v forge >/dev/null || { echo "forge is not installed."; exit 1; }
command -v cast  >/dev/null || { echo "cast is not installed."; exit 1; }

# ── the RPC, from the keeper's own env so there is one source for it ──────────
if [[ -z "${NUVEM_RPC_URL:-}" ]]; then
  KEEPER_ENV="$(cd .. && pwd)/keeper/.env"
  [[ -f "$KEEPER_ENV" ]] || { echo "No NUVEM_RPC_URL set and $KEEPER_ENV not found."; exit 1; }
  NUVEM_RPC_URL="$(grep -m1 '^NUVEM_RPC_URL=' "$KEEPER_ENV" | cut -d= -f2-)"
fi
export NUVEM_RPC_URL

CHAIN_ID="$(cast chain-id --rpc-url "$NUVEM_RPC_URL")"
[[ "$CHAIN_ID" == "4663" ]] || { echo "This RPC is chain $CHAIN_ID, not Robinhood Chain (4663). Stopping."; exit 1; }

# ── preflight, before a key is even asked for ────────────────────────────────
# Each of these is a value welded into an immutable contract. Checking them here
# costs one eth_call; checking them after deployment costs a governance cycle.
echo "Checking the destination before anything is signed…"

ASSET="$(cast call "$YIELD_VAULT" "asset()(address)" --rpc-url "$NUVEM_RPC_URL")"
# `tr` and not ${VAR,,}: macOS ships bash 3.2, where that expansion is a syntax
# error the shell only reaches at runtime — `bash -n` passes and the script dies
# mid-flight, after the operator has already been asked for a key.
lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }
if [[ "$(lower "$ASSET")" != "$(lower "$USDG")" ]]; then
  echo "  FATAL: $YIELD_VAULT holds $ASSET, not USDG. Wrong vault."; exit 1
fi

DECIMALS="$(cast call "$YIELD_VAULT" "decimals()(uint8)" --rpc-url "$NUVEM_RPC_URL")"
NAME="$(cast call "$YIELD_VAULT" "name()(string)" --rpc-url "$NUVEM_RPC_URL" | tr -d '"')"

# previewDeposit AND NOT maxDeposit. Morpho Vault V2 returns zero from every
# max* by design, so gating on it would refuse a vault that works perfectly.
SHARES="$(cast call "$YIELD_VAULT" "previewDeposit(uint256)(uint256)" 1000000 --rpc-url "$NUVEM_RPC_URL" | awk '{print $1}')"
if [[ "$SHARES" == "0" ]]; then
  echo "  FATAL: $YIELD_VAULT prices one dollar at zero shares. It would take the money and mint nothing."; exit 1
fi

echo "  vault          $NAME"
echo "  asset          USDG"
echo "  share decimals $DECIMALS"
echo "  1 USDG buys    $SHARES shares"
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

export NUVEM_WETH="$WETH" NUVEM_USDG="$USDG" NUVEM_POOL_MANAGER="$POOL_MANAGER"
export NUVEM_WETH_USDG_FEE="$FEE" NUVEM_WETH_USDG_TICK_SPACING="$TICK_SPACING"
export NUVEM_INVEST_YIELD_VAULT="$YIELD_VAULT"

echo "── Simulating. Nothing is broadcast. ─────────────────────────────────────"
forge script script/DeployUsdgSavingsAdapter.s.sol --rpc-url "$NUVEM_RPC_URL"
echo ""

# ── the one deliberate pause ─────────────────────────────────────────────────
# Typed in full, not a y/n. This is the last reversible moment.
read -r -p 'Deploy for real? Type DEPLOY to continue: ' CONFIRM
[[ "$CONFIRM" == "DEPLOY" ]] || { echo "Stopped. Nothing was broadcast."; exit 0; }

echo ""
echo "── Broadcasting ──────────────────────────────────────────────────────────"
forge script script/DeployUsdgSavingsAdapter.s.sol --rpc-url "$NUVEM_RPC_URL" --broadcast

DEPLOYED="$(python3 -c "
import json
d = json.load(open('broadcast/DeployUsdgSavingsAdapter.s.sol/4663/run-latest.json'))
print(next(t['contractAddress'] for t in d['transactions'] if t.get('transactionType') == 'CREATE'))
" 2>/dev/null || true)"

echo ""
echo "════════════════════════════════════════════════════════════════════════"
echo "  Deployed: ${DEPLOYED:-see the output above}"
echo ""
echo "  NOT REGISTERED, and nothing reaches it until it is. Next:"
echo "    1. Propose registerAdapter(<id>, ${DEPLOYED:-<address>}) from the Safe"
echo "       0x43d552d4e73463980e9afc0531b62fc237fde7c1 (threshold 1, and"
echo "       $SIGNER is an owner)."
echo "    2. Wait 900 seconds — the timelock's minimum delay."
echo "    3. Execute. EXECUTOR_ROLE is the zero address, so anyone can."
echo "════════════════════════════════════════════════════════════════════════"
