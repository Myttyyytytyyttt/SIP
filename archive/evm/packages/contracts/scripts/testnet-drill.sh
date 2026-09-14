#!/usr/bin/env bash
# The disposable mainnet rehearsal, one step at a time.
#
#   ./scripts/testnet-drill.sh status      where the chain is, and what comes next
#   ./scripts/testnet-drill.sh deploy      core: timelock, registries, factory, cohort 1
#   ./scripts/testnet-drill.sh adapter     the stock adapter, 12 stocks
#   ./scripts/testnet-drill.sh schedule    queue the governance operations
#   ./scripts/testnet-drill.sh execute     run them once the delay has passed
#   ./scripts/testnet-drill.sh all         every step above, waiting out the delay
#   ./scripts/testnet-drill.sh preflight   check the environment before spending
#
# WHY A SCRIPT AND NOT A LIST IN A DOCUMENT. Every step here reads chain state
# before it acts and refuses when the state is not what it expects. A runbook in
# markdown cannot do that, and the failure it lets through is the expensive kind:
# a step run twice, or run against a deployment that has moved on.
#
# NOTHING IS SIGNED BY THIS FILE. It shells out to `forge script --broadcast` and
# `cast send`, which read DEPLOYER_PRIVATE_KEY and SAFE_OWNER_PRIVATE_KEY from
# YOUR environment. Export them in your own shell; they never appear here, in a
# log line, or in any file this writes.
#
# `all` IS THE WHOLE SEQUENCE UNATTENDED, and it is worth knowing what that costs.
# Run step by step, there is a human between "the adapter is deployed" and "the
# adapter is live", who can read the addresses and stop. `all` removes that
# pause: it deploys, queues, sleeps out the governance delay and executes. For a
# rehearsal you fund yourself that is the point. For anything else the checkpoint
# is the feature.
#
# It is resumable either way. Every step records what it built under
# $NUVEM_DRILL_STATE and refuses to run twice, so a dropped connection or a
# closed laptop costs the wait and nothing else — rerun `all` and it picks up.
#
# THIS PRODUCES A DISPOSABLE DEPLOYMENT. The governance delay is fifteen minutes
# rather than seven days, which means one proposer key can upgrade every vault in
# the cohort inside that window. That is a fine trade for a rehearsal you fund
# yourself and a terrible one for anything else. Do not point other people's
# money at what this creates.

set -euo pipefail

RPC="${NUVEM_RPC_URL:?export NUVEM_RPC_URL first}"
STATE="${NUVEM_DRILL_STATE:-.drill-state}"

# ── the pinned world, measured this session ──────────────────────────────────
WETH=0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73
USDG=0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168
POOL_MANAGER=0x8366a39CC670B4001A1121B8F6A443A643e40951
STOCK_REGISTRY=0xe10B6f6b275de231345c20D14Ab812db62151b00
STOCK_IMPL=0xb35490d6f9163DE4F80d88dc75c3516eb64C5aE2
STOCK_CODEHASH=0x6c1fdd40002dcb440c7fff6a84171404d279ccb057803b65826f7546acd65630
SAFE=0x43d552d4e73463980e9afc0531b62fc237fde7c1
GUARDIAN=0xB284f131eE5728272FA5fF1F6eae0896B4e2A3AA
ATTESTER=0x90b5Ca8e6474A855db5EeA210FBb5326CDC26DCa

# The twelve stocks and their pools, each verified against mainnet by
# scripts/discover-stock-pools.mjs: a $500 purchase costs 5 to 91 bps.
STOCKS=0x117cc2133c37B721F49dE2A7a74833232B3B4C0C,0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC,0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5,0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9,0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3,0xe93237C50D904957Cf27E7B1133b510C669c2e74,0x322F0929c4625eD5bAd873c95208D54E1c003b2d,0xdF0992E440dD0be65BD8439b609d6D4366bf1CB5,0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35,0x1D11f0496982706C5e14A514D4E79F2e6BdE4516,0x5e81213613b6B86EaB4c6c50d718d34359459786,0xa30FA36Db767ad9eD3f7a60fC79526fB4d56D344
STOCK_FEES=500,3000,2500,3000,3000,3000,3000,3000,3000,4762,8000,2500
STOCK_TICKS=5,60,25,60,60,60,60,30,60,48,80,25
WETH_USDG_FEE=200
WETH_USDG_TICK=4

DELAY="${NUVEM_GOVERNANCE_DELAY:-900}"

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %-28s %s\n' "$1" "$2"; }
die()  { printf '\n\033[31m%s\033[0m\n\n' "$*" >&2; exit 1; }

remember() { mkdir -p "$STATE"; printf '%s' "$2" > "$STATE/$1"; }
# The first address on the line carrying this label.
#
# Matched on the label ANYWHERE in the line rather than immediately before the
# address: forge indents script output unpredictably, and "Adapter registry
# (vault immutable) 0x…" carries a parenthetical between the two. Both cost a
# silent empty capture before this was written this way.
capture()  { grep -F "$1" "$2" | grep -oE '0x[0-9a-fA-F]{40}' | head -1; }
recall()   { [ -f "$STATE/$1" ] && cat "$STATE/$1" || echo ""; }

need_key() {
  [ -n "${DEPLOYER_PRIVATE_KEY:-}" ] || die \
"DEPLOYER_PRIVATE_KEY is not set.

Export it in YOUR shell — this script never stores it and never prints it:

    export DEPLOYER_PRIVATE_KEY=0x…

Use a FRESH key funded with about 0.002 ETH. Any key that has been pasted into a
chat, an issue or a terminal you do not control should be considered spent."
}

# ── preflight ────────────────────────────────────────────────────────────────

# Everything that has to be true before `all` can work, checked in one command.
#
# WHY THIS EXISTS AS ITS OWN VERB. Diagnosing a shell by pasting one-liners back
# and forth is slow and error-prone — an unset variable and a variable set in a
# DIFFERENT shell look identical from the outside, and `cast` reports both as
# "a value is required". This prints one block an operator can read or paste.
#
# IT NEVER PRINTS A KEY. Lengths and derived addresses only: a private key is 66
# characters, so a length is enough to tell "unset" from "set" from "pasted with
# a line break in it" without the secret leaving the machine.
cmd_preflight() {
  local ok=1

  say "environment"
  # DEFAULTED BEFORE MEASURING. `set -u` makes ${#VAR} on an unset variable a
  # fatal "unbound variable", so the first version of this check crashed in the
  # exact case it exists to diagnose: nothing exported at all.
  local dkey="${DEPLOYER_PRIVATE_KEY:-}" skey="${SAFE_OWNER_PRIVATE_KEY:-}"
  local dlen=${#dkey} slen=${#skey}
  info "NUVEM_RPC_URL" "$(echo "$RPC" | sed -E 's|(https?://[^/]+).*|\1|')"
  info "DEPLOYER_PRIVATE_KEY" "$( [ "$dlen" -eq 0 ] && echo "NOT SET" || echo "$dlen chars$( [ "$dlen" -ne 66 ] && echo '  <- expected 66')" )"
  info "SAFE_OWNER_PRIVATE_KEY" "$( [ "$slen" -eq 0 ] && echo "NOT SET" || echo "$slen chars$( [ "$slen" -ne 66 ] && echo '  <- expected 66')" )"
  [ "$dlen" -eq 66 ] || ok=0
  [ "$slen" -eq 66 ] || ok=0

  if [ "$ok" -eq 0 ]; then
    printf '\n  Export BOTH in the shell you will run the drill from — a variable set in\n'
    printf '  another window or another command block is not visible here:\n\n'
    printf '    export DEPLOYER_PRIVATE_KEY=0x…\n    export SAFE_OWNER_PRIVATE_KEY=0x…\n\n'
    return 1
  fi

  say "keys"
  local deployer signer balance
  deployer=$(cast wallet address --private-key "$dkey" 2>/dev/null) || { die "DEPLOYER_PRIVATE_KEY is 66 characters but not a valid key."; }
  signer=$(cast wallet address --private-key "$skey" 2>/dev/null) || { die "SAFE_OWNER_PRIVATE_KEY is 66 characters but not a valid key."; }
  balance=$(cast balance "$deployer" --rpc-url "$RPC")
  info "deployer" "$deployer"
  info "deployer balance (wei)" "$balance"
  info "safe signer" "$signer"

  # 0.002 ETH covers the core and the adapter with room; below that the run dies
  # partway and the operator pays twice for the half that landed.
  if [ "$(printf '%s' "$balance")" -lt 2000000000000000 ] 2>/dev/null; then
    info "" "NOT ENOUGH — fund the deployer with about 0.002 ETH"; ok=0
  fi

  local owners; owners=$(cast call "$SAFE" 'getOwners()(address[])' --rpc-url "$RPC")
  if printf '%s' "$owners" | grep -qi "${signer#0x}"; then
    info "safe owner" "yes"
  else
    info "safe owner" "NO — the timelock will refuse a proposal from $signer"
    info "" "owners: $owners"
    ok=0
  fi

  say "verdict"
  if [ "$ok" -eq 1 ]; then
    printf '  ready.  ./scripts/testnet-drill.sh all\n\n'
  else
    printf '  not ready. Nothing has been deployed and no gas has been spent.\n\n'
    return 1
  fi
}

# ── status ───────────────────────────────────────────────────────────────────

cmd_status() {
  say "chain"
  info "rpc" "$(echo "$RPC" | sed -E 's|(https?://[^/]+).*|\1|')"
  info "block" "$(cast block-number --rpc-url "$RPC")"

  local factory timelock adapter registry beacon
  factory=$(recall factory); timelock=$(recall timelock)
  adapter=$(recall adapter); registry=$(recall adapterRegistry); beacon=$(recall beacon)

  say "this drill"
  if [ -z "$factory" ]; then
    info "core" "NOT DEPLOYED"
    printf '\n  next:  ./scripts/testnet-drill.sh deploy\n\n'
    return
  fi
  info "factory" "$factory"
  info "timelock" "$timelock"
  info "adapterRegistry" "$registry"
  info "beacon (cohort 1)" "$beacon"
  info "delay (seconds)" "$(cast call "$timelock" 'getMinDelay()(uint256)' --rpc-url "$RPC")"
  info "factory owner" "$(cast call "$factory" 'owner()(address)' --rpc-url "$RPC")"
  info "factory pendingOwner" "$(cast call "$factory" 'pendingOwner()(address)' --rpc-url "$RPC")"

  if [ -z "$adapter" ]; then
    printf '\n  next:  ./scripts/testnet-drill.sh adapter\n\n'
    return
  fi
  info "stock adapter" "$adapter"
  local adapter_id registered
  adapter_id=$(recall adapterId)
  registered=$(cast call "$registry" 'isAdapterActive(bytes32)(bool)' "$adapter_id" --rpc-url "$RPC" 2>/dev/null || echo false)
  info "adapter registered" "$registered"

  if [ "$registered" != "true" ]; then
    printf '\n  next:  ./scripts/testnet-drill.sh schedule   (then wait %ss, then execute)\n\n' "$DELAY"
  else
    printf '\n  core is live. Create a vault, invite a trading wallet, then:\n'
    printf '    NUVEM_VAULT=<your vault> npx tsx ../keeper/bin/invest.mts status\n\n'
  fi
}

# ── deploy ───────────────────────────────────────────────────────────────────

cmd_deploy() {
  need_key
  [ -z "$(recall factory)" ] || die "core already deployed at $(recall factory). Delete $STATE to start over."

  say "deploying core with a ${DELAY}s governance delay"
  printf '  This is a DISPOSABLE deployment. One proposer key can upgrade every\n'
  printf '  vault in its cohort within %ss. Do not give it other people'"'"'s money.\n\n' "$DELAY"

  DEPLOYER_PRIVATE_KEY="$DEPLOYER_PRIVATE_KEY" \
  NUVEM_CORPORATE_MULTISIG="$SAFE" \
  NUVEM_GUARDIAN="$GUARDIAN" \
  NUVEM_TREASURY="$GUARDIAN" \
  NUVEM_ATTESTER="$ATTESTER" \
  NUVEM_WETH_ADDRESS="$WETH" \
  NUVEM_INITIAL_FEE_BPS=0 \
  NUVEM_CANARY_APPROVED=true \
  NUVEM_GOVERNANCE_DELAY="$DELAY" \
  NUVEM_DISPOSABLE_TEST_DEPLOYMENT=true \
  forge script script/DeployNuvem.s.sol:DeployNuvem --rpc-url "$RPC" --broadcast | tee /tmp/drill-deploy.log

  # Parsed from the script's own log rather than from the broadcast file: the log
  # is what the script SAYS it built, so a mismatch between the two is visible.
  #
  # NOT ANCHORED ON LEADING SPACES. The first version matched '^  adapter 0x…'
  # and silently captured nothing, because forge indents script output by two
  # more spaces than console2.log writes and the adapter's line arrives with
  # four. `status` then reported the adapter as undeployed one command after
  # deploying it. Anchoring on the LABEL is the thing that is actually stable.
  remember factory        "$(capture 'Factory' /tmp/drill-deploy.log)"
  remember timelock       "$(capture 'Timelock' /tmp/drill-deploy.log)"
  remember adapterRegistry "$(capture 'Adapter registry' /tmp/drill-deploy.log)"
  remember beacon         "$(capture 'Cohort beacon' /tmp/drill-deploy.log)"

  for k in factory timelock adapterRegistry beacon; do
    [ -n "$(recall "$k")" ] || die "deployed, but could not read $k out of the log.
The transactions landed — see /tmp/drill-deploy.log and the broadcast/ directory —
but this script cannot continue without the address. Record it in $STATE/$k by hand."
  done

  say "recorded"; cmd_status
}

# ── adapter ──────────────────────────────────────────────────────────────────

cmd_adapter() {
  need_key
  local registry; registry=$(recall adapterRegistry)
  [ -n "$registry" ] || die "deploy the core first."
  [ -z "$(recall adapter)" ] || die "adapter already deployed at $(recall adapter)."

  say "deploying the stock adapter"
  printf '  Twelve stocks, each pool verified against mainnet. The script refuses\n'
  printf '  an uninitialised pool, an empty one, or a fee above 1%%.\n\n'

  DEPLOYER_PRIVATE_KEY="$DEPLOYER_PRIVATE_KEY" \
  NUVEM_WETH_ADDRESS="$WETH" NUVEM_USDG="$USDG" NUVEM_POOL_MANAGER="$POOL_MANAGER" \
  NUVEM_STOCK_REGISTRY="$STOCK_REGISTRY" NUVEM_STOCK_IMPLEMENTATION="$STOCK_IMPL" \
  NUVEM_STOCK_PROXY_CODEHASH="$STOCK_CODEHASH" \
  NUVEM_WETH_USDG_FEE="$WETH_USDG_FEE" NUVEM_WETH_USDG_TICK_SPACING="$WETH_USDG_TICK" \
  NUVEM_STOCKS="$STOCKS" NUVEM_STOCK_FEES="$STOCK_FEES" NUVEM_STOCK_TICK_SPACINGS="$STOCK_TICKS" \
  forge script script/DeployStockAdapter.s.sol:DeployStockAdapter --rpc-url "$RPC" --broadcast | tee /tmp/drill-adapter.log

  remember adapter   "$(capture 'adapter' /tmp/drill-adapter.log)"
  remember adapterId "$(grep -A1 'adapterId' /tmp/drill-adapter.log | grep -oE '0x[0-9a-fA-F]{64}' | head -1)"

  for k in adapter adapterId; do
    [ -n "$(recall "$k")" ] || die "adapter deployed, but could not read $k out of the log.
See /tmp/drill-adapter.log; record it in $STATE/$k by hand before continuing."
  done

  say "recorded"; cmd_status
}

# ── governance ───────────────────────────────────────────────────────────────

# CHECKED BEFORE ANY GAS IS SPENT, not when the proposal is sent.
#
# `schedule` sits in the middle of the sequence, so a key that is not a Safe
# owner used to surface after the core and the adapter had already been deployed
# and paid for. The run was recoverable — state is recorded and `all` resumes —
# but the gas was not. The address is derived locally with `cast wallet address`;
# nothing is signed and nothing leaves the machine.
preflight_safe_owner() {
  [ -n "${SAFE_OWNER_PRIVATE_KEY:-}" ] || die \
"SAFE_OWNER_PRIVATE_KEY is not set. It must be an owner of $SAFE, which is the
only address the timelock will accept a proposal from."

  # THE ENV VAR, NOT $skey. `skey` is a `local` of cmd_preflight and is unbound
  # here, so with `set -u` this died with "skey: unbound variable" and then
  # reported "not a valid private key" about a key that was perfectly fine —
  # after the core and the adapter had already been deployed and paid for.
  local signer owners
  signer=$(cast wallet address --private-key "$SAFE_OWNER_PRIVATE_KEY" 2>/dev/null) \
    || die "SAFE_OWNER_PRIVATE_KEY is set but cast cannot derive an address from it."
  owners=$(cast call "$SAFE" 'getOwners()(address[])' --rpc-url "$RPC")

  if ! printf '%s' "$owners" | grep -qi "${signer#0x}"; then
    die "SAFE_OWNER_PRIVATE_KEY signs as $signer, which is NOT an owner of the Safe.

  Safe    $SAFE
  owners  $owners

Nothing has been deployed and no gas has been spent. Export a key belonging to
one of those owners — the timelock accepts a proposal from nobody else, and the
sequence would have failed halfway with the deployments already paid for."
  fi
  info "safe owner verified" "$signer"
}

cmd_schedule() {
  preflight_safe_owner

  local factory timelock registry adapter adapter_id
  factory=$(recall factory); timelock=$(recall timelock)
  registry=$(recall adapterRegistry); adapter=$(recall adapter); adapter_id=$(recall adapterId)
  [ -n "$adapter" ] || die "deploy the adapter first."

  say "queuing two operations on the timelock"
  printf '  1. factory.acceptOwnership()          — unfreezes cohort registration\n'
  printf '  2. adapterRegistry.registerAdapter()  — puts the adapter in service\n'
  printf '  Both become executable in %ss.\n\n' "$DELAY"

  node scripts/safe.mjs exec --rpc "$RPC" --safe "$SAFE" --to "$timelock" \
    --data "$(cast calldata 'schedule(address,uint256,bytes,bytes32,bytes32,uint256)' \
      "$factory" 0 "$(cast calldata 'acceptOwnership()')" \
      0x0000000000000000000000000000000000000000000000000000000000000000 \
      "$(cast keccak "nuvem-drill-accept-$factory")" "$DELAY")"

  node scripts/safe.mjs exec --rpc "$RPC" --safe "$SAFE" --to "$timelock" \
    --data "$(cast calldata 'schedule(address,uint256,bytes,bytes32,bytes32,uint256)' \
      "$registry" 0 "$(cast calldata 'registerAdapter(bytes32,address)' "$adapter_id" "$adapter")" \
      0x0000000000000000000000000000000000000000000000000000000000000000 \
      "$(cast keccak "nuvem-drill-register-$adapter")" "$DELAY")"

  remember scheduledAt "$(date +%s)"
  say "queued. Execute in ${DELAY}s:  ./scripts/testnet-drill.sh execute"
}

cmd_execute() {
  need_key
  local factory timelock registry adapter adapter_id scheduled now
  factory=$(recall factory); timelock=$(recall timelock)
  registry=$(recall adapterRegistry); adapter=$(recall adapter); adapter_id=$(recall adapterId)
  scheduled=$(recall scheduledAt); now=$(date +%s)
  [ -n "$scheduled" ] || die "nothing scheduled yet."

  local elapsed=$(( now - scheduled ))
  if [ "$elapsed" -lt "$DELAY" ]; then
    die "only ${elapsed}s have passed of the ${DELAY}s delay. The timelock will refuse.
Waiting is the property being rehearsed — do not shorten it here."
  fi

  say "executing (open to anyone once the delay has passed)"
  cast send "$timelock" 'execute(address,uint256,bytes,bytes32,bytes32)' \
    "$factory" 0 "$(cast calldata 'acceptOwnership()')" \
    0x0000000000000000000000000000000000000000000000000000000000000000 \
    "$(cast keccak "nuvem-drill-accept-$factory")" \
    --rpc-url "$RPC" --private-key "$DEPLOYER_PRIVATE_KEY" >/dev/null
  info "factory owner now" "$(cast call "$factory" 'owner()(address)' --rpc-url "$RPC")"

  cast send "$timelock" 'execute(address,uint256,bytes,bytes32,bytes32)' \
    "$registry" 0 "$(cast calldata 'registerAdapter(bytes32,address)' "$adapter_id" "$adapter")" \
    0x0000000000000000000000000000000000000000000000000000000000000000 \
    "$(cast keccak "nuvem-drill-register-$adapter")" \
    --rpc-url "$RPC" --private-key "$DEPLOYER_PRIVATE_KEY" >/dev/null
  info "adapter active" "$(cast call "$registry" 'isAdapterActive(bytes32)(bool)' "$adapter_id" --rpc-url "$RPC")"

  cmd_status
}

# ── everything, in order ─────────────────────────────────────────────────────

cmd_all() {
  cmd_preflight || exit 1

  say "running the whole sequence"
  printf '  Roughly %s minutes, most of it waiting out the governance delay.\n' "$(( DELAY / 60 + 2 ))"
  printf '  Every step is recorded in %s and refuses to run twice, so this is\n' "$STATE"
  printf '  safe to rerun if it dies.\n' 

  [ -n "$(recall factory)" ] || cmd_deploy
  [ -n "$(recall adapter)" ] || cmd_adapter
  [ -n "$(recall scheduledAt)" ] || cmd_schedule

  local scheduled remaining
  scheduled=$(recall scheduledAt)
  while :; do
    remaining=$(( DELAY - ( $(date +%s) - scheduled ) ))
    [ "$remaining" -le 0 ] && break
    printf '\r  waiting out the delay: %4ss remaining ' "$remaining"
    sleep 10
  done
  printf '\r  delay elapsed%*s\n' 30 ''

  cmd_execute
  say "done"
  printf '  Create a vault in the web app, invite a trading wallet, then:\n'
  printf '    NUVEM_VAULT=<vault> npx tsx ../keeper/bin/invest.mts status\n\n'
}

case "${1:-status}" in
  status)    cmd_status ;;
  preflight) cmd_preflight ;;
  deploy)   cmd_deploy ;;
  adapter)  cmd_adapter ;;
  schedule) cmd_schedule ;;
  execute)  cmd_execute ;;
  all)      cmd_all ;;
  *) die "unknown command \"$1\". Use preflight, status, deploy, adapter, schedule, execute or all." ;;
esac
