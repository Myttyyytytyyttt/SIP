#!/usr/bin/env bash
# sip-deploy.sh against a throwaway local validator: every verb, the refusals
# that matter, the bytes check, a lean wallet that resumes an interrupted
# deploy, and closing a buffer before the program exists, before any of it
# meets mainnet. Nothing here reads a real key or talks to mainnet: every key is
# made in a temporary directory and deleted at the end, and the real program
# keypair is never opened (the program is preloaded at its id with
# --upgradeable-program).
#
#   scripts/sip-deploy-drill.sh
#
# Needs Node 22, target/deploy/sip_vault.so and target/deploy/toy_venue.so from
# anchor build (or SIP_PROGRAM_SO / SIP_DRILL_OTHER_SO), and a free port 18899
# (SIP_DRILL_RPC_PORT). SIP_DRILL_LOG keeps every command's output.
set -uo pipefail
cd "$(dirname "$0")/.."

PORT=${SIP_DRILL_RPC_PORT:-18899}
URL=http://127.0.0.1:$PORT
SO_SRC=${SIP_PROGRAM_SO:-target/deploy/sip_vault.so}
OTHER_SRC=${SIP_DRILL_OTHER_SO:-target/deploy/toy_venue.so}
PROGRAM_ID=$(sed -n 's/^declare_id!("\([1-9A-HJ-NP-Za-km-z]*\)");.*/\1/p' programs/sip-vault/src/lib.rs)
CANARY=drill-canary-$$
# What a lean admin wallet gets on top of the rent: the script's 0.05 SOL fee margin and a little more.
LEAN_EXTRA=80000000

for tool in solana solana-test-validator solana-keygen node shasum lsof awk; do
  command -v "$tool" >/dev/null 2>&1 || { echo "missing $tool"; exit 1; }
done
[ -f "$SO_SRC" ] && [ -f "$OTHER_SRC" ] || { echo "needs $SO_SRC and $OTHER_SRC: run anchor build first"; exit 1; }
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then echo "port $PORT is busy"; exit 1; fi
unset SIP_SOLANA_RPC_URLS SIP_ADMIN_KEYPAIR SIP_ADMIN_PUBKEY SIP_SETTLE_PUBKEY SIP_EXPECTED_SO_SHA256 SIP_PROGRAM_KEYPAIR \
  SIP_PROGRAM_ID SIP_PROGRAM_SO SIP_DEPLOY_CONFIRM SIP_DEPLOY_CLUSTER SIP_ADMIN_SKIP_PRECHECK SIP_DEPLOY_RPC

TMP=$(mktemp -d "${TMPDIR:-/tmp}/sip-deploy-drill.XXXXXX")
LOG=${SIP_DRILL_LOG:-$TMP/drill.log}
: >"$LOG"
VALIDATOR=""
DRILL_ID=none RESUME_ID=none CLOSE_ID=none
cleanup() {
  if [ -n "$VALIDATOR" ]; then kill "$VALIDATOR" 2>/dev/null; wait "$VALIDATOR" 2>/dev/null; fi
  rm -f scripts/.local/deploy-buffer-"$DRILL_ID"-*.json scripts/.local/deploy-buffer-"$RESUME_ID"-*.json scripts/.local/deploy-buffer-"$CLOSE_ID"-*.json
  rm -rf "$TMP"
}
trap cleanup EXIT

key() { solana-keygen new --no-bip39-passphrase --silent --outfile "$TMP/$1.json" >/dev/null && solana-keygen pubkey "$TMP/$1.json"; }
ADMIN=$(key admin)
SETTLE=$(key settle)
STRANGER=$(key stranger)
LEAN=$(key lean)
LEAN2=$(key lean2)
DRILL_ID=$(key drill-program)
RESUME_ID=$(key resume-program)
CLOSE_ID=$(key close-program)
cp "$SO_SRC" "$TMP/sip_vault.so"
cp "$OTHER_SRC" "$TMP/other.so"
SHA=$(shasum -a 256 "$TMP/sip_vault.so" | awk '{print $1}')
SO_BYTES=$(wc -c <"$TMP/sip_vault.so" | tr -d ' ')

echo "validator on :$PORT, $PROGRAM_ID preloaded and upgradeable by the drill's admin $ADMIN"
solana-test-validator --reset --quiet --ledger "$TMP/ledger" --bind-address 127.0.0.1 \
  --rpc-port "$PORT" --faucet-port $((PORT + 1000)) --gossip-port $((PORT + 1100)) \
  --dynamic-port-range $((PORT + 1200))-$((PORT + 1300)) \
  --upgradeable-program "$PROGRAM_ID" "$TMP/sip_vault.so" "$TMP/admin.json" >"$TMP/validator.log" 2>&1 &
VALIDATOR=$!
for _ in $(seq 1 90); do
  solana cluster-version --url "$URL" >/dev/null 2>&1 && break
  sleep 1
done
rent() { solana rent "$1" --lamports --url "$URL" 2>/dev/null | awk '/Rent-exempt minimum/ {print $3}'; }
lamports() { solana balance "$1" --lamports --url "$URL" 2>/dev/null | awk '{print $1}'; }
exists() { solana account "$1" --url "$URL" >/dev/null 2>&1; }
sol() { awk -v l="$1" 'BEGIN { printf "%.4f SOL", l / 1e9 }'; }
buffer_count() {
  solana program show --buffers --buffer-authority "$1" --url "$URL" --output json 2>/dev/null |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(String(JSON.parse(s).buffers.length)))'
}
PROGRAMDATA_RENT=$(rent $((SO_BYTES + 45)))
PROGRAM_RENT=$(rent 36)
LEAN_FUNDING=$((PROGRAMDATA_RENT + PROGRAM_RENT + LEAN_EXTRA))
LEAN_SOL=$(awk -v l="$LEAN_FUNDING" 'BEGIN { printf "%.9f", l / 1e9 }')
if ! { solana airdrop 50 "$ADMIN" --url "$URL" && solana airdrop 1 "$SETTLE" --url "$URL" && solana airdrop 5 "$STRANGER" --url "$URL" &&
  solana airdrop "$LEAN_SOL" "$LEAN" --url "$URL" && solana airdrop "$LEAN_SOL" "$LEAN2" --url "$URL"; } >/dev/null 2>&1; then
  echo "the validator did not come up"; tail -20 "$TMP/validator.log"; exit 1
fi

PASS=0
FAIL=0
# sip-deploy.sh with the drill's inputs. D_* changes one of them for one call.
sd() {
  SIP_SOLANA_RPC_URLS="${D_URL:-$URL}" SIP_DEPLOY_CLUSTER="${D_CLUSTER-localnet}" \
    SIP_ADMIN_KEYPAIR="${D_ADMIN_KEYPAIR:-$TMP/admin.json}" SIP_ADMIN_PUBKEY="${D_ADMIN_PUBKEY:-$ADMIN}" \
    SIP_SETTLE_PUBKEY="${D_SETTLE-$SETTLE}" SIP_PROGRAM_SO="${D_SO:-$TMP/sip_vault.so}" SIP_EXPECTED_SO_SHA256="${D_SHA-$SHA}" \
    scripts/sip-deploy.sh "$@" </dev/null
}
# sip-admin.ts alone, as a stranger, to prove the program refuses what the checks would have stopped.
admin_alone() {
  SIP_DEPLOY_RPC="$URL" SIP_DEPLOY_CLUSTER=localnet SIP_ADMIN_SKIP_PRECHECK=1 \
    SIP_ADMIN_KEYPAIR="$TMP/stranger.json" SIP_ADMIN_PUBKEY="$STRANGER" SIP_SETTLE_PUBKEY="$SETTLE" \
    node_modules/.bin/tsx scripts/sip-admin.ts "$@" </dev/null
}
# expect <0|fail> <extended regex | -> <what it proves> -- command...
expect() {
  local want=$1 pattern=$2 what=$3 out code good=yes
  shift 4
  out=$("$@" 2>&1)
  code=$?
  printf '\n===== %s (exit %s)\n%s\n' "$what" "$code" "$out" >>"$LOG"
  if [ "$want" = 0 ] && [ "$code" -ne 0 ]; then good=no; fi
  if [ "$want" = fail ] && [ "$code" -eq 0 ]; then good=no; fi
  # One line of text, so a pattern like "pinned copy.*all checks pass" can span the lines between.
  if [ "$pattern" != - ] && ! printf '%s' "$out" | tr '\n' ' ' | grep -Eq -- "$pattern"; then good=no; fi
  if [ "$good" = yes ]; then
    PASS=$((PASS + 1))
    printf '  ✓ %s\n' "$what"
  else
    FAIL=$((FAIL + 1))
    printf '  ✗ %s (exit %s, wanted %s, pattern %s)\n' "$what" "$code" "$want" "$pattern"
    printf '%s\n' "$out" | tail -12 | sed 's/^/      /'
  fi
}
# check <what it proves> -- test...
check() {
  local what=$1
  shift 2
  if "$@"; then PASS=$((PASS + 1)); printf '  ✓ %s\n' "$what"; else FAIL=$((FAIL + 1)); printf '  ✗ %s\n' "$what"; fi
}
# interrupt <program keypair> <program id> <admin keypair> <admin address>: starts a deploy and kills it once its buffer is on chain.
# INTERRUPTED is yes, finished (the upload beat the kill) or no (the buffer never showed up).
interrupt() {
  local program_keypair=$1 id=$2 admin_keypair=$3 admin=$4 buffer_file deploying
  (SIP_PROGRAM_KEYPAIR=$program_keypair SIP_DEPLOY_CONFIRM=$id D_ADMIN_KEYPAIR=$admin_keypair D_ADMIN_PUBKEY=$admin sd deploy >>"$LOG" 2>&1) &
  deploying=$!
  INTERRUPTED=no
  for _ in $(seq 1 150); do
    buffer_file=$(ls scripts/.local/deploy-buffer-"$id"-*.json 2>/dev/null | head -1)
    if [ -n "$buffer_file" ] && solana account "$(solana-keygen pubkey "$buffer_file" 2>/dev/null)" --url "$URL" >/dev/null 2>&1; then
      pkill -f "deploy-buffer-$id" 2>/dev/null
      INTERRUPTED=yes
      break
    fi
    sleep 0.2
  done
  wait "$deploying" 2>/dev/null
  if [ "$INTERRUPTED" = yes ] && solana account "$id" --url "$URL" >/dev/null 2>&1; then INTERRUPTED=finished; fi
}

echo
echo "a fresh program"
expect fail "not initialised" "status fails while the config is missing" -- sd status
expect 0 "the first [0-9]+ bytes have the same sha256" "status --allow-unconfigured: the bytes match and the admin is the authority" -- sd status --allow-unconfigured
expect 0 "ready to configure" "preflight picks configure for a deployed program" -- sd preflight

echo
echo "refused before anything is sent"
mkdir -p "$TMP/node20" && printf '#!/bin/sh\necho 20\n' >"$TMP/node20/node" && chmod +x "$TMP/node20/node"
PATH="$TMP/node20:$PATH" expect fail "Node 22 is required" "a shell on Node 20 is refused before anything runs" -- sd status
NUVEM_SOLANA_KEYPAIR=/nonexistent expect fail "legacy variable names are set" "a NUVEM_* variable refuses" -- sd status
D_CLUSTER="" expect fail "is not mainnet" "a local validator without SIP_DEPLOY_CLUSTER=localnet refuses" -- sd status
D_URL="127.0.0.1:$PORT/?api-key=$CANARY" expect fail "does not start with http\(s\)://host \(the value is not shown\)" "an RPC value without a scheme refuses without echoing it" -- sd status
D_URL="http://localhost:1@127.0.0.1:$PORT/" expect fail "does not start with http\(s\)://host" "a user@ prefix cannot dress a host as localhost" -- sd status
D_ADMIN_PUBKEY=not-an-address expect fail "SIP_ADMIN_PUBKEY is not a base58 address \(the value is not shown\)" "a malformed admin address refuses without echoing it" -- sd status
SIP_DEPLOY_CONFIRM=--help expect fail "not a base58 address" "an option like --help never passes for an address" -- sd set-keeper --help
SIP_DEPLOY_CU_PRICE=10000000 expect fail "at most 5000000" "a priority fee above the admin tool's cap refuses before anything is confirmed" -- sd status
SIP_DEPLOY_SEND=smoke expect fail "SIP_DEPLOY_SEND is rpc" "an unknown send mode refuses" -- sd status
D_SETTLE=$ADMIN SIP_DEPLOY_CONFIRM=CONFIGURE expect fail "IS the admin wallet" "the settle wallet cannot be the admin wallet" -- sd configure
D_SETTLE=not-an-address SIP_DEPLOY_CONFIRM=CONFIGURE expect fail "not a base58 address \(the value is not shown\)" "a malformed settle address refuses configure without echoing it" -- sd configure
D_ADMIN_PUBKEY=$STRANGER expect fail "holds $ADMIN, not the admin wallet $STRANGER" "an admin file that is not the admin wallet refuses" -- sd preflight configure
D_ADMIN_KEYPAIR=$TMP/stranger.json D_ADMIN_PUBKEY=$STRANGER SIP_DEPLOY_CONFIRM=CONFIGURE expect fail "upgrade authority .*not the admin wallet" "a stranger's configure stops at preflight" -- sd configure
expect fail "NotUpgradeAuthority \(6024\)" "the program itself refuses init_config from anyone but the upgrade authority" -- admin_alone init-config
SIP_DEPLOY_CONFIRM=nope expect fail "not confirmed" "a wrong confirmation word sends nothing" -- sd panic
if (: </dev/tty) 2>/dev/null; then
  echo "  - skipped: no-terminal confirmation (this shell has a terminal)"
else
  expect fail "no terminal to ask in" "without a terminal, a verb that asks for confirmation refuses" -- sd panic
fi

echo
echo "configure"
SIP_DEPLOY_CONFIRM=CONFIGURE expect 0 "all checks pass" "configure names the settle wallet attester and keeper, and every check passes" -- sd configure
SIP_DEPLOY_CONFIRM=CONFIGURE expect 0 "already done" "configure again changes nothing" -- sd configure
D_URL="$URL/?api-key=$CANARY" expect 0 "all checks pass" "status passes, through an RPC URL that carries a key" -- sd status
D_SETTLE="" expect fail "SIP_SETTLE_PUBKEY is not set" "status without the settle address does not pass" -- sd status
D_SHA=0000000000000000000000000000000000000000000000000000000000000000 expect fail "not the tested binary" "status fails when the local binary is not the tested one" -- sd status

echo
echo "panic, and back"
D_SETTLE=not-an-address SIP_DEPLOY_CONFIRM=PAUSE expect 0 "PAUSED" "panic works even with a malformed settle address, and pauses" -- sd panic
SIP_DEPLOY_CONFIRM=PAUSE expect 0 "keeper +nobody" "panic --disarm-keeper on a paused protocol names no keeper" -- sd panic --disarm-keeper
expect fail "keeper +nobody, not the settle wallet" "status fails while paused and disarmed" -- sd status
expect fail "set_keeper was refused in simulation" "the program refuses set_keeper from a stranger" -- admin_alone set-keeper "$SETTLE"
SIP_DEPLOY_CONFIRM=UNPAUSE expect 0 "protocol +running" "unpause" -- sd unpause
SIP_DEPLOY_CONFIRM=${SETTLE:0:6} expect 0 "keeper +$SETTLE" "set-keeper back to the settle wallet" -- sd set-keeper "$SETTLE"
expect 0 "all checks pass" "status passes again" -- sd status

echo
echo "rotations"
SIP_DEPLOY_CONFIRM=${STRANGER:0:6} expect 0 "attester +$STRANGER" "set-attester to another key" -- sd set-attester "$STRANGER"
expect fail "attester .*not the settle wallet" "status names the wrong attester" -- sd status
SIP_DEPLOY_CONFIRM=${SETTLE:0:6} expect 0 "attester +$SETTLE" "set-attester back to the settle wallet" -- sd set-attester "$SETTLE"
SIP_DEPLOY_CONFIRM=${ADMIN:0:6} expect fail "admin wallet cannot be the keeper" "the admin wallet cannot become the keeper" -- sd set-keeper "$ADMIN"

echo
echo "bytes"
D_SO=$TMP/other.so expect fail "not the local binary" "status catches a local binary that is not the deployed one" -- sd status
D_SHA=0000000000000000000000000000000000000000000000000000000000000000 SIP_DEPLOY_CONFIRM=$PROGRAM_ID expect fail "not the tested" "upgrade refuses a binary whose hash is not the tested one" -- sd upgrade
D_SHA="" SIP_DEPLOY_CONFIRM=$PROGRAM_ID expect fail "set SIP_EXPECTED_SO_SHA256" "upgrade refuses without the tested hash" -- sd upgrade
SIP_DEPLOY_CONFIRM=$PROGRAM_ID expect 0 "pinned copy.*all checks pass" "upgrade uploads a pinned copy of the tested binary and keeps the config" -- sd upgrade

echo
echo "deploy, at drill ids (the real program keypair is never opened)"
SIP_PROGRAM_KEYPAIR=$TMP/drill-program.json SIP_DEPLOY_CONFIRM=$DRILL_ID expect 0 "the first [0-9]+ bytes have the same sha256" "deploy publishes the tested binary, upgradeable by the admin" -- sd deploy
SIP_PROGRAM_KEYPAIR=$TMP/drill-program.json SIP_DEPLOY_CONFIRM=$DRILL_ID expect fail "already deployed: run .*status" "deploy refuses an id that is taken, and says to check status first" -- sd deploy
SIP_PROGRAM_ID=$DRILL_ID expect 0 "upgrade authority +$ADMIN \(admin\)" "the drill program's upgrade authority is the admin" -- sd status --allow-unconfigured
check "no write buffer of the admin is left behind" -- [ "$(buffer_count "$ADMIN")" = 0 ]

echo
echo "a lean admin wallet: ProgramData rent + program account + $(sol "$LEAN_EXTRA")"
LEAN_START=$(lamports "$LEAN")
interrupt "$TMP/resume-program.json" "$RESUME_ID" "$TMP/lean.json" "$LEAN"
case "$INTERRUPTED" in
  yes)
    check "the killed deploy left its buffer on chain, holding the rent" -- [ "$(buffer_count "$LEAN")" = 1 ]
    D_ADMIN_KEYPAIR=$TMP/lean.json D_ADMIN_PUBKEY=$LEAN SIP_PROGRAM_KEYPAIR=$TMP/resume-program.json SIP_DEPLOY_CONFIRM=$RESUME_ID \
      expect 0 "resuming [1-9A-HJ-NP-Za-km-z]+, which already holds.*same sha256" "the lean wallet resumes the interrupted deploy on what it has left, and it lands" -- sd deploy
    ;;
  finished) echo "  - the upload finished before the kill: the lean wallet deployed without a resume" ;;
  *) FAIL=$((FAIL + 1)); echo "  ✗ the lean wallet's deploy never put its buffer on chain" ;;
esac
check "the program exists at the resume id" -- exists "$RESUME_ID"
LEAN_SPENT=$((LEAN_START - $(lamports "$LEAN")))
check "the lean wallet spent $(sol "$LEAN_SPENT"): one rent and fees, never two rents" -- [ "$LEAN_SPENT" -le "$LEAN_FUNDING" ]
check "and no buffer of the lean wallet is left" -- [ "$(buffer_count "$LEAN")" = 0 ]

echo
echo "closing a buffer before the program exists"
LEAN2_START=$(lamports "$LEAN2")
interrupt "$TMP/close-program.json" "$CLOSE_ID" "$TMP/lean2.json" "$LEAN2"
if [ "$INTERRUPTED" = yes ]; then
  D_ADMIN_KEYPAIR=$TMP/lean2.json D_ADMIN_PUBKEY=$LEAN2 SIP_DEPLOY_CONFIRM=CLOSE expect 0 "-" "buffers --close works while the program does not exist" -- sd buffers --close
  check "no buffer of that wallet is left" -- [ "$(buffer_count "$LEAN2")" = 0 ]
  LEAN2_LOST=$((LEAN2_START - $(lamports "$LEAN2")))
  check "closing gave the buffer's SOL back ($(sol "$LEAN2_LOST") went to fees)" -- [ "$LEAN2_LOST" -le 20000000 ]
  check "the local buffer file is gone" -- [ -z "$(ls scripts/.local/deploy-buffer-"$CLOSE_ID"-*.json 2>/dev/null)" ]
elif [ "$INTERRUPTED" = finished ]; then
  echo "  - skipped: the upload finished before it could be interrupted"
else
  FAIL=$((FAIL + 1)); echo "  ✗ the deploy to close never put its buffer on chain"
fi

echo
if grep -q "$CANARY" "$LOG"; then
  FAIL=$((FAIL + 1)); echo "  ✗ an RPC key reached the output"
else
  PASS=$((PASS + 1)); echo "  ✓ no RPC key in any output"
fi
echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
