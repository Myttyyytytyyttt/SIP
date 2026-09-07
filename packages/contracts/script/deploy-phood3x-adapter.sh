#!/usr/bin/env bash
#
# Deploys NuvemPerpTokenAdapter for Arcus pHOOD3x. One prompt, one key —
# BUT TODAY THIS SCRIPT'S JOB IS TO REFUSE.
#
# Measured 2026-08-30: Arcus pToken deposits are gated (previewDeposit reverts;
# real deposits settle asynchronously via their operator's bot) and the pToken
# beacon is owned by an EOA. This script probes previewDeposit BEFORE asking
# for a key: while it reverts, the script prints the listing checklist and
# exits — nothing to sign, nothing to decide. The day Arcus opens synchronous
# deposits, the probe passes and the flow arms itself.
#
# THE CHECKLIST THE PROBE CANNOT CHECK (confirm by hand before typing DEPLOY):
#   [ ] pToken implementation VERIFIED on Blockscout
#   [ ] pToken beacon owned by Arcus's timelocked multisig, not an EOA
#   [ ] deposit() confirmed synchronous on a small real deposit
#   [ ] the web listing copy says "a 3x token can lose its entire value"
#
# THE KEY IS NEVER WRITTEN TO DISK OR SHELL HISTORY. Read with echo off, unset
# on every exit path. It does appear in cast's argv briefly during the balance
# check — same-user process table — so on a shared machine prefer
# `cast wallet import` + forge --account.

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

# ── the addresses, all verified against mainnet 4663 ─────────────────────────
WETH=0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73
USDG=0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168
POOL_MANAGER=0x8366a39CC670B4001A1121B8F6A443A643e40951
WETH_USDG_FEE=200
WETH_USDG_TICK=4
# Arcus HOOD (3x Long) — PINNED, not an env override. Every machine check below
# verifies "an open 4626 over USDG", which any contract can satisfy; the ADDRESS
# is the identity, so targeting a different pToken must cost an edit to this
# file that a review can see — the same rule every sibling deploy script keeps.
PERP_TOKEN=0xe24CABDf76DD1c2576049167eB1755C84b985C36

cleanup() { unset DEPLOYER_PRIVATE_KEY || true; }
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

CHAIN_ID="$(cast chain-id --rpc-url "$NUVEM_RPC_URL")"
[[ "$CHAIN_ID" == "4663" ]] || { echo "This RPC is chain $CHAIN_ID, not Robinhood Chain (4663). Stopping."; exit 1; }

lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

# ── the destination, checked before a key is even asked for ──────────────────
echo "Checking the pToken before anything is signed…"

ASSET="$(cast call "$PERP_TOKEN" "asset()(address)" --rpc-url "$NUVEM_RPC_URL")"
[[ "$(lower "$ASSET")" == "$(lower "$USDG")" ]] \
  || { echo "  FATAL: $PERP_TOKEN holds $ASSET, not USDG. Wrong vault."; exit 1; }

SYMBOL="$(cast call "$PERP_TOKEN" "symbol()(string)" --rpc-url "$NUVEM_RPC_URL" | tr -d '"')"
NAV="$(cast call "$PERP_TOKEN" "convertToAssets(uint256)(uint256)" 1000000000000000000 --rpc-url "$NUVEM_RPC_URL" | awk '{print $1}')"
echo "  pToken   $SYMBOL at $PERP_TOKEN"
echo "  NAV      1e18 shares = $NAV USDG (6 dec)"

# ── THE ARMING GATE ──────────────────────────────────────────────────────────
# "Reverted" and "unreachable" are DIFFERENT answers: the first is Arcus's gate
# (expected today, exit clean), the second is a broken RPC (an error, loudly).
# 2>/dev/null conflated them and an outage read as "still gated".
PROBE_ERR="$(mktemp)"
SHARES="$(cast call "$PERP_TOKEN" "previewDeposit(uint256)(uint256)" 1000000 --rpc-url "$NUVEM_RPC_URL" 2>"$PROBE_ERR" | awk '{print $1}')" || SHARES=""
if [[ -z "$SHARES" ]]; then
  if grep -qi "execution reverted" "$PROBE_ERR"; then
    rm -f "$PROBE_ERR"
    echo ""
    echo "════════════════════════════════════════════════════════════════════════"
    echo "  NOT ARMED — previewDeposit still reverts on chain."
    echo ""
    echo "  This is today's expected outcome: Arcus keeps pToken deposits gated"
    echo "  and settles them asynchronously through their operator. An adapter"
    echo "  deployed now would be installable but permanently useless, so this"
    echo "  script refuses. Nothing was signed; no key was asked for."
    echo ""
    echo "  Re-run after Arcus opens synchronous deposits."
    echo "════════════════════════════════════════════════════════════════════════"
    exit 0
  fi
  echo "  FATAL: the probe FAILED WITHOUT A REVERT — RPC or transport trouble,"
  echo "  not Arcus's gate. Not concluding anything from an unreachable chain:"
  sed 's/^/    /' "$PROBE_ERR" | head -4
  rm -f "$PROBE_ERR"
  exit 1
fi
rm -f "$PROBE_ERR"
if [[ "$SHARES" == "0" ]]; then
  echo "  FATAL: previewDeposit answers ZERO shares — it would take the money and mint nothing."; exit 1
fi
echo "  1 USDG buys $SHARES shares — deposits look OPEN."
echo ""

# ── THE GOVERNANCE GATE, machine-checked where a machine can ─────────────────
# The pToken is a beacon proxy. Its beacon's owner being an EOA means one key
# can rewrite the token under every holder — a listing blocker this script can
# READ instead of trusting an operator to remember a checklist.
BEACON_SLOT=0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50
BEACON_RAW="$(cast storage "$PERP_TOKEN" "$BEACON_SLOT" --rpc-url "$NUVEM_RPC_URL")"
BEACON="0x$(printf '%s' "$BEACON_RAW" | sed 's/^0x//' | cut -c25-64)"
if [[ "$BEACON" != "0x0000000000000000000000000000000000000000" ]]; then
  BOWNER="$(cast call "$BEACON" "owner()(address)" --rpc-url "$NUVEM_RPC_URL" 2>/dev/null || echo unknown)"
  if [[ "$BOWNER" == "unknown" ]]; then
    echo "  FATAL: the pToken's beacon ($BEACON) owner is unreadable. Not deployable blind."; exit 1
  fi
  OWNER_CODE="$(cast code "$BOWNER" --rpc-url "$NUVEM_RPC_URL")"
  if [[ "$OWNER_CODE" == "0x" || -z "$OWNER_CODE" ]]; then
    echo ""
    echo "  FATAL: the pToken's beacon owner $BOWNER is an EOA — one key can"
    echo "  rewrite the token under every holder. Listing precondition unmet."
    echo "  (Arcus already runs a timelocked multisig for their wrapped tokens;"
    echo "  ask them to move the pToken beacon behind it.)"
    exit 1
  fi
  echo "  beacon owner $BOWNER is a contract — governance gate passed."
fi
echo ""
echo "  ⚠ Still confirm BY HAND before DEPLOY: implementation verified on"
echo "    Blockscout, and a small real deposit observed synchronous."
echo ""

# ── the key ──────────────────────────────────────────────────────────────────
if [[ -z "${DEPLOYER_PRIVATE_KEY:-}" ]]; then
  read -rs -p "Private key for 0xB284f131eE5728272FA5fF1F6eae0896B4e2A3AA: " DEPLOYER_PRIVATE_KEY
  echo ""
fi
export DEPLOYER_PRIVATE_KEY

SIGNER="$(cast wallet address --private-key "$DEPLOYER_PRIVATE_KEY")"
echo "Signing as $SIGNER"
echo "Balance      $(cast balance "$SIGNER" --rpc-url "$NUVEM_RPC_URL" | cast from-wei) ETH"
echo ""

export NUVEM_WETH="$WETH" NUVEM_USDG="$USDG" NUVEM_PERP_TOKEN="$PERP_TOKEN" NUVEM_POOL_MANAGER="$POOL_MANAGER"
export NUVEM_WETH_USDG_FEE="$WETH_USDG_FEE" NUVEM_WETH_USDG_TICK_SPACING="$WETH_USDG_TICK"

echo "── Simulating. Nothing is broadcast. ─────────────────────────────────────"
forge script script/DeployPerpTokenAdapter.s.sol --rpc-url "$NUVEM_RPC_URL"
echo ""

read -r -p 'Deploy for real? Type DEPLOY to continue: ' CONFIRM
[[ "$CONFIRM" == "DEPLOY" ]] || { echo "Stopped. Nothing was broadcast."; exit 0; }

echo ""
echo "── Broadcasting ──────────────────────────────────────────────────────────"
forge script script/DeployPerpTokenAdapter.s.sol --rpc-url "$NUVEM_RPC_URL" --broadcast

DEPLOYED="$(python3 -c "
import json
d = json.load(open('broadcast/DeployPerpTokenAdapter.s.sol/4663/run-latest.json'))
print(next(t['contractAddress'] for t in d['transactions'] if t.get('transactionType') == 'CREATE'))
" 2>/dev/null || true)"

echo ""
echo "════════════════════════════════════════════════════════════════════════"
echo "  Deployed: ${DEPLOYED:-see the output above}"
echo ""
echo "  NOT REGISTERED, and nothing reaches it until it is. Registration is"
echo "  the proven Safe + 900s timelock walk — clone register-index-adapter.sh"
echo "  with label NUVEM_PERP_TOKEN_ADAPTER_V1 when this actually arms."
echo "════════════════════════════════════════════════════════════════════════"
