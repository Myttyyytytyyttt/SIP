#!/usr/bin/env bash
# SIP on mainnet: publish the tested binary, configure it, check it, stop it.
#
#   scripts/sip-deploy.sh preflight [deploy|upgrade|configure]   read-only: what is missing before any SOL moves
#   scripts/sip-deploy.sh deploy                    publish the tested sip_vault.so; resumable
#   scripts/sip-deploy.sh configure                 init_config(attester = settle) + set_keeper(settle)
#   scripts/sip-deploy.sh status                    read-only: bytes on chain == tested, authorities, config
#   scripts/sip-deploy.sh panic [--disarm-keeper]   pause settle, link, wrap, convert and invest; never withdrawals
#   scripts/sip-deploy.sh unpause
#   scripts/sip-deploy.sh set-keeper <address>      rotate the crank; 11111111111111111111111111111111 names nobody
#   scripts/sip-deploy.sh set-attester <address>    rotate the attester
#   scripts/sip-deploy.sh upgrade                   new tested bytes at the SAME id; config, vaults and links stay
#   scripts/sip-deploy.sh buffers [--close]         write buffers an interrupted deploy left behind
#
# WHAT GOES ON CHAIN IS WHAT WAS TESTED. This script never runs `anchor build`,
# and never `anchor deploy`, which ships every program in the workspace, the
# test-only toy venue included. deploy and upgrade accept target/deploy/sip_vault.so
# only when its sha256 equals SIP_EXPECTED_SO_SHA256, the hash reported when the
# tests passed. They then copy it into a private directory, hash the copy again
# and upload the copy, so a rebuild in another terminal during the confirmation
# cannot swap the bytes. status compares the bytes on chain with that file.
#
# TWO KEYS (owner's decision, 2026-09-14). The admin wallet deploys, holds the
# upgrade authority and the config authority, and never goes to a server. On
# mainnet it is pinned to EE46GmYq… below: moving it is a code change, on
# purpose. The settle wallet is the attester and the keeper, and its secret
# lives only in Railway. This script takes the settle wallet's address, never
# its secret.
#
# NOTHING HERE PRINTS A SECRET. The RPC URL carries the Helius key. `solana`
# reads it from a 0600 config file in a private directory, never from its
# command line, which other accounts on the machine can list. Only the host is
# printed, and every line from `solana` and sip-admin.ts passes through a
# filter. An address variable that holds something else is refused without
# being echoed.
#
# ENVIRONMENT, SIP_* ONLY, NODE 22. Any NUVEM_* variable refuses, and the
# Nuvem-era .env.mainnet is never sourced.
#   SIP_SOLANA_RPC_URLS      the first URL is used. Load only this one variable from the credentials file.
#   SIP_ADMIN_KEYPAIR        default ~/sip-keys/admin.json
#   SIP_ADMIN_PUBKEY         default and, on mainnet, the only accepted value: EE46GmYqiKwMve9qyriRYQ5MjQ4wR6t5kDA9B92VfGXg
#   SIP_SETTLE_PUBKEY        the settle wallet's address; configure and status need it
#   SIP_EXPECTED_SO_SHA256   the tested binary's sha256; deploy and upgrade need it
#   SIP_PROGRAM_SO           default target/deploy/sip_vault.so
#   SIP_DEPLOY_CU_PRICE      priority fee, micro-lamports per compute unit, default 20000, at most 5000000
#   SIP_DEPLOY_SEND          "rpc" (default) sends the upload's writes through the RPC; "tpu" straight to validators
# For scripts/sip-deploy-drill.sh against a local validator, refused on mainnet:
#   SIP_DEPLOY_CLUSTER=localnet, SIP_DEPLOY_CONFIRM, SIP_PROGRAM_KEYPAIR, SIP_PROGRAM_ID, SIP_ADMIN_SKIP_PRECHECK
#
# COSTS, for the 563,656-byte binary of 2026-09-14 on mainnet: about 2.87 SOL
# leaves the admin wallet and stays locked in ProgramData and the program
# account for as long as the program lives. The write buffer is funded with
# that rent while the bytes upload, and the loader returns it to the admin
# wallet just before it pays for ProgramData, so the peak is one rent plus
# fees, not two. A resumed deploy counts what its buffer already holds.
# preflight computes all of it from the file and the cluster's rent.
set -euo pipefail
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
cd "$(dirname "$SELF")/.."

MAINNET_GENESIS=5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d
OWNER_ADMIN=EE46GmYqiKwMve9qyriRYQ5MjQ4wR6t5kDA9B92VfGXg
NOBODY=11111111111111111111111111111111
# The upgradeable loader's accounts: ProgramData and Buffer headers, and the program account itself.
PROGRAMDATA_HEADER=45
BUFFER_HEADER=37
PROGRAM_ACCOUNT_BYTES=36
# Bytes per buffer write transaction, roughly: only used to tell the owner how long the upload is.
BYTES_PER_WRITE=950
# Fees for ~600 buffer writes and the deploy itself, with room to spare.
DEPLOY_FEE_MARGIN=50000000
# init_config's rent and a handful of fees.
ADMIN_VERB_MINIMUM=10000000
PAUSE_MINIMUM=1000000
SETTLE_LOW=50000000
# sip-admin.ts refuses more than this; the shell refuses it first, before anything is confirmed.
CU_PRICE_MAX=5000000
TSX=node_modules/.bin/tsx
USE_NODE22='export PATH="$HOME/.nvm/versions/node/v22.14.0/bin:$PATH"'

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
row()  { printf '  %s %-20s %s\n' "$1" "$2" "$3"; }
ok()   { row "✓" "$1" "$2"; }
note() { row "·" "$1" "$2"; }
warn() { row "!" "$1" "$2"; }
bad()  { row "✗" "$1" "$2"; BLOCKERS=$((BLOCKERS + 1)); }
die()  { printf '\n\033[31m%s\033[0m\n\n' "$*" >&2; exit 1; }

# Removes the RPC URL and any api-key from a stream, line by line so progress still shows.
# It scans forward past each replacement, so a replacement can never be matched again.
redact() {
  SIP_REDACT_URL="${RPC:-}" SIP_REDACT_HOST="${HOST:-}" awk '
    {
      rest = $0; out = ""; url = ENVIRON["SIP_REDACT_URL"]
      if (url != "") {
        while ((i = index(rest, url)) > 0) {
          out = out substr(rest, 1, i - 1) "<rpc " ENVIRON["SIP_REDACT_HOST"] ">"
          rest = substr(rest, i + length(url))
        }
      }
      line = out rest
      gsub(/api-key=[^&" \t]+/, "api-key=<redacted>", line)
      gsub(/api_key=[^&" \t]+/, "api_key=<redacted>", line)
      gsub(/apikey=[^&" \t]+/, "apikey=<redacted>", line)
      print line; fflush()
    }'
}

NUVEM_SET=$(env | sed -n 's/^\(NUVEM_[A-Za-z0-9_]*\)=.*/\1/p' | tr '\n' ' ')
[ -z "$NUVEM_SET" ] || die "Refused: Nuvem-era variables are set (${NUVEM_SET% }). This script speaks SIP_* only: unset them."

# @solana/web3.js no longer loads on Node 20, and a login shell on this Mac starts on Node 20.
command -v node >/dev/null 2>&1 || die "node is not on PATH. Node 22 is required: $USE_NODE22"
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)
case "$NODE_MAJOR" in '' | *[!0-9]*) NODE_MAJOR=0 ;; esac
[ "$NODE_MAJOR" -ge 22 ] || die "Node 22 is required, and this shell runs $(node -v 2>/dev/null || echo 'an unknown version'): $USE_NODE22"

RPC=$(printf %s "${SIP_SOLANA_RPC_URLS:-}" | cut -d, -f1 | tr -d '[:space:]')
[ -n "$RPC" ] || die "SIP_SOLANA_RPC_URLS is not set. Load only that variable, not the whole credentials file:
  export SIP_SOLANA_RPC_URLS=\"\$(bash -c '. ~/sip-keys/sip-hackathon.env; printf %s \"\$SIP_SOLANA_RPC_URLS\"')\""
# scheme://host[:port] and nothing before the host: no user@, which could dress a remote host as localhost.
URL_RE='^https?://[A-Za-z0-9.-]+(:[0-9]+)?([/?#][^"\\]*)?$'
printf %s "$RPC" | grep -Eq "$URL_RE" || die "SIP_SOLANA_RPC_URLS does not start with http(s)://host (the value is not shown)"
HOST=$(printf %s "$RPC" | sed -E 's#^https?://([A-Za-z0-9.-]+).*#\1#')

TICKER=""
WORK=$(mktemp -d "${TMPDIR:-/tmp}/sip-deploy.XXXXXX") || die "could not create a private working directory"
chmod 700 "$WORK"
trap 'if [ -n "$TICKER" ]; then kill "$TICKER" 2>/dev/null; fi; rm -rf "$WORK"' EXIT
# A config file that does not parse sends `solana` back to its DEFAULT config, without a word:
# mainnet's public RPC and ~/.config/solana/id.json. keypair_path is a required field. So every
# field is written, the default signer is a file that does not exist, and the parse is checked
# before anything runs. Colour is off so the check reads plain text.
CLI_CONFIG=$WORK/solana-cli.yml
(umask 077 && printf 'json_rpc_url: "%s"\nwebsocket_url: ""\nkeypair_path: "%s"\naddress_labels: {}\ncommitment: confirmed\n' \
  "$RPC" "$WORK/no-default-signer.json" >"$CLI_CONFIG")
sol_cli() { env -u CLICOLOR_FORCE NO_COLOR=1 solana -C "$CLI_CONFIG" "$@"; }
sol_cli config get 2>/dev/null | SIP_EXPECT_LINE="RPC URL: $RPC" awk 'index($0, ENVIRON["SIP_EXPECT_LINE"]) == 1 { found = 1 } END { exit !found }' ||
  die "solana did not take the private config file, and would have fallen back to its default RPC and keypair"

sha256_of() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'; else sha256sum "$1" | awk '{print $1}'; fi
}
sol() { awk -v l="$1" 'BEGIN { printf "%.4f SOL", l / 1e9 }'; }
# A canonical 32-byte base58 address, checked with no dependency. Exit 10 means
# "not an address"; any other failure stops the script rather than reading as one.
# The "--" keeps a value like --help from reaching node as an option.
is_address() {
  local code=0
  node -e '
    const s = process.argv[1], digits = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
    if (typeof s !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) process.exit(10)
    let n = 0n
    for (const c of s) n = n * 58n + BigInt(digits.indexOf(c))
    let hex = n === 0n ? "" : n.toString(16)
    if (hex.length % 2) hex = "0" + hex
    process.exit(s.match(/^1*/)[0].length + hex.length / 2 === 32 ? 0 : 10)' -- "$1" 2>/dev/null || code=$?
  case "$code" in
    0) return 0 ;;
    10) return 1 ;;
    *) die "node could not check an address (exit $code)" ;;
  esac
}
other_users_bits() { node -e 'process.stdout.write(String(require("fs").statSync(process.argv[1]).mode & 0o077))' -- "$1"; }
json_get() {
  node -e '
    let s = ""
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      let v
      try { v = JSON.parse(s) } catch { process.exit(3) }
      for (const k of process.argv[1].split(".")) v = v == null ? undefined : v[k]
      process.stdout.write(v == null ? "" : String(v))
    })' -- "$1"
}
balance_of() { sol_cli balance "$1" --lamports 2>/dev/null | awk '{print $1}'; }
rent_for() {
  local lamports
  lamports=$(sol_cli rent "$1" --lamports 2>/dev/null | awk '/Rent-exempt minimum/ {print $3}') || die "could not read the rent from $HOST"
  [ -n "$lamports" ] || die "could not read the rent from $HOST"
  printf %s "$lamports"
}

ADMIN_KEYPAIR=${SIP_ADMIN_KEYPAIR:-$HOME/sip-keys/admin.json}
ADMIN_PUBKEY=${SIP_ADMIN_PUBKEY:-$OWNER_ADMIN}
is_address "$ADMIN_PUBKEY" || die "SIP_ADMIN_PUBKEY is not a base58 address (the value is not shown)"
SETTLE_PUBKEY=${SIP_SETTLE_PUBKEY:-}
SO=${SIP_PROGRAM_SO:-target/deploy/sip_vault.so}
CU_PRICE=${SIP_DEPLOY_CU_PRICE:-20000}
case "$CU_PRICE" in '' | *[!0-9]*) die "SIP_DEPLOY_CU_PRICE must be a whole number of micro-lamports" ;; esac
{ [ "${#CU_PRICE}" -le 7 ] && [ "$CU_PRICE" -le "$CU_PRICE_MAX" ]; } || die "SIP_DEPLOY_CU_PRICE is at most $CU_PRICE_MAX micro-lamports per compute unit"
case "${SIP_DEPLOY_SEND:-rpc}" in
  rpc) SEND_FLAG=--use-rpc ;;
  tpu) SEND_FLAG="" ;;
  *) die "SIP_DEPLOY_SEND is rpc (the default) or tpu" ;;
esac
DECLARED_ID=$(sed -n 's/^declare_id!("\([1-9A-HJ-NP-Za-km-z]*\)");.*/\1/p' programs/sip-vault/src/lib.rs)
[ -n "$DECLARED_ID" ] || die "no declare_id! found in programs/sip-vault/src/lib.rs"
IDL_ID=$(node -p 'require("./idl/sip_vault.json").address') || die "could not read idl/sip_vault.json"
if [ -n "${SIP_PROGRAM_ID:-}" ]; then is_address "$SIP_PROGRAM_ID" || die "SIP_PROGRAM_ID is not a base58 address"; fi
PROGRAM_ID=${SIP_PROGRAM_ID:-$DECLARED_ID}
PROGRAM_KEYPAIR=${SIP_PROGRAM_KEYPAIR:-target/deploy/sip_vault-keypair.json}
CLUSTER=""
BLOCKERS=0
PINNED=""

cluster() {
  [ -z "$CLUSTER" ] || return 0
  local genesis
  genesis=$(sol_cli genesis-hash 2>/dev/null) || die "the RPC at $HOST did not answer"
  if [ "$genesis" = "$MAINNET_GENESIS" ]; then
    [ -z "${SIP_DEPLOY_CLUSTER:-}" ] || die "SIP_DEPLOY_CLUSTER=$SIP_DEPLOY_CLUSTER, but $HOST is mainnet: unset it to act on mainnet"
    [ -z "${SIP_DEPLOY_CONFIRM:-}${SIP_PROGRAM_KEYPAIR:-}${SIP_PROGRAM_ID:-}${SIP_ADMIN_SKIP_PRECHECK:-}" ] ||
      die "SIP_DEPLOY_CONFIRM, SIP_PROGRAM_KEYPAIR, SIP_PROGRAM_ID and SIP_ADMIN_SKIP_PRECHECK are for local drills: unset them to act on mainnet"
    [ "$ADMIN_PUBKEY" = "$OWNER_ADMIN" ] ||
      die "On mainnet the admin wallet is $OWNER_ADMIN, the owner's, and SIP_ADMIN_PUBKEY names $ADMIN_PUBKEY. Moving it is a code change, on purpose."
    CLUSTER=mainnet
  else
    [ "${SIP_DEPLOY_CLUSTER:-}" = localnet ] || die "$HOST is not mainnet (genesis ${genesis:0:8}…). A local drill sets SIP_DEPLOY_CLUSTER=localnet."
    case "$HOST" in 127.0.0.1 | localhost) ;; *) die "SIP_DEPLOY_CLUSTER=localnet only works against a validator on this machine" ;; esac
    CLUSTER=localnet
  fi
}

# Asks for a word typed on the terminal. A drill on localnet passes it in SIP_DEPLOY_CONFIRM instead.
confirm() {
  local word=$1 what=$2 answer=""
  printf '\n  %s\n' "$what"
  if [ "$CLUSTER" = localnet ] && [ -n "${SIP_DEPLOY_CONFIRM:-}" ]; then
    [ "$SIP_DEPLOY_CONFIRM" = "$word" ] || die "not confirmed: nothing was sent"
    return 0
  fi
  (: </dev/tty) 2>/dev/null || die "this asks for confirmation, and there is no terminal to ask in"
  printf '  type %s to confirm: ' "$word" >/dev/tty
  IFS= read -r answer </dev/tty || true
  [ "$answer" = "$word" ] || die "not confirmed: nothing was sent"
}

admin_tool() {
  [ -x "$TSX" ] || die "no $TSX here: run pnpm install first"
  SIP_DEPLOY_RPC="$RPC" SIP_ADMIN_PUBKEY="$ADMIN_PUBKEY" SIP_ADMIN_KEYPAIR="$ADMIN_KEYPAIR" \
    SIP_SETTLE_PUBKEY="$SETTLE_PUBKEY" SIP_PROGRAM_SO="${PINNED:-$SO}" SIP_PROGRAM_ID="$PROGRAM_ID" SIP_DEPLOY_CU_PRICE="$CU_PRICE" \
    "$TSX" scripts/sip-admin.ts "$@" 2>&1 | redact
}

# A node that lags a few seconds behind the one that confirmed can still show the old state.
status_until_ok() {
  local attempt
  for attempt in 1 2 3; do
    if admin_tool status "$@"; then return 0; fi
    if [ "$attempt" -lt 3 ]; then
      say "checking again in 10 s: the RPC node that answered can lag behind the one that confirmed"
      sleep 10
    fi
  done
  return 1
}

# solana hides its progress when its output is filtered, so the owner sees a line every 20 s instead.
start_ticker() {
  (
    elapsed=0
    while sleep 20; do
      elapsed=$((elapsed + 20))
      printf '  … %s, %d s so far; if it stops, the same command resumes\n' "$1" "$elapsed"
    done
  ) &
  TICKER=$!
}
stop_ticker() {
  if [ -n "$TICKER" ]; then
    kill "$TICKER" 2>/dev/null || true
    wait "$TICKER" 2>/dev/null || true
    TICKER=""
  fi
}

require_admin_file() {
  [ -f "$ADMIN_KEYPAIR" ] || die "no admin keypair at $ADMIN_KEYPAIR (SIP_ADMIN_KEYPAIR)"
  local bits file_pubkey
  bits=$(other_users_bits "$ADMIN_KEYPAIR") || die "could not read the permissions of $ADMIN_KEYPAIR"
  [ "$bits" = 0 ] || die "$ADMIN_KEYPAIR is readable by other users: chmod 600 it"
  file_pubkey=$(solana-keygen pubkey "$ADMIN_KEYPAIR" 2>/dev/null || true)
  [ "$file_pubkey" = "$ADMIN_PUBKEY" ] || die "$ADMIN_KEYPAIR holds ${file_pubkey:-no readable key}, not the admin wallet $ADMIN_PUBKEY"
}

# Returns when nothing is at PROGRAM_ID; stops with what is there when it is not an upgradeable program.
require_empty_id() {
  local out owner lamports
  if out=$(sol_cli account "$PROGRAM_ID" --output json 2>"$WORK/account.err"); then
    owner=$(printf %s "$out" | json_get account.owner 2>/dev/null) || owner=""
    lamports=$(printf %s "$out" | json_get account.lamports 2>/dev/null) || lamports=""
    if [ "$owner" = "$NOBODY" ]; then
      die "$PROGRAM_ID is an ordinary account holding ${lamports:-some} lamports that someone sent there, so the loader cannot create the program at this id"
    fi
    die "$PROGRAM_ID holds an account owned by ${owner:-an unknown program}, not an upgradeable program"
  fi
  case "$(cat "$WORK/account.err" 2>/dev/null)" in
    *AccountNotFound* | *"not found"*) return 0 ;;
    *) die "could not read $PROGRAM_ID from $HOST: $(head -1 "$WORK/account.err" 2>/dev/null | redact)" ;;
  esac
}

# DEPLOYED, CHAIN_AUTHORITY and CHAIN_DATA_LEN for PROGRAM_ID. Only "Unable to find the account"
# means not deployed; any other error stops here instead of passing for it.
# --buffer-authority is there because `program show` otherwise loads the default signer, and there is none.
load_chain_program() {
  local show errors
  DEPLOYED=no CHAIN_AUTHORITY="" CHAIN_DATA_LEN=0
  if show=$(sol_cli program show "$PROGRAM_ID" --buffer-authority "$ADMIN_PUBKEY" --output json 2>"$WORK/program-show.err"); then
    DEPLOYED=yes
    CHAIN_AUTHORITY=$(printf %s "$show" | json_get authority) || die "unexpected output from solana program show"
    CHAIN_DATA_LEN=$(printf %s "$show" | json_get dataLen) || die "unexpected output from solana program show"
    CHAIN_DATA_LEN=${CHAIN_DATA_LEN:-0}
    return 0
  fi
  errors=$({ cat "$WORK/program-show.err"; printf '%s\n' "$show"; } 2>/dev/null)
  require_empty_id
  case "$errors" in
    *"Unable to find the account"*) ;;
    *) die "could not read $PROGRAM_ID from $HOST: $(printf %s "$errors" | head -1 | redact)" ;;
  esac
}

cmd_preflight() {
  MODE=${1:-auto}
  case "$MODE" in auto | deploy | upgrade | configure | admin) ;; *) die "usage: $SELF preflight [deploy|upgrade|configure]" ;; esac
  BLOCKERS=0
  cluster
  say "preflight · $CLUSTER · rpc $HOST (key hidden)"

  say "program"
  if [ "$IDL_ID" = "$DECLARED_ID" ]; then ok "declare_id = IDL" "$DECLARED_ID"; else bad "declare_id = IDL" "declare_id $DECLARED_ID, but idl/sip_vault.json says $IDL_ID"; fi
  load_chain_program
  if [ "$MODE" = auto ]; then
    if [ "$DEPLOYED" = yes ]; then MODE=configure; else MODE=deploy; fi
    note "checking for" "$MODE"
  fi
  if [ "$MODE" = deploy ]; then
    local keypair_id=""
    if [ -f "$PROGRAM_KEYPAIR" ]; then keypair_id=$(solana-keygen pubkey "$PROGRAM_KEYPAIR" 2>/dev/null || true); fi
    if [ -z "$keypair_id" ]; then
      bad "program keypair" "nothing readable at $PROGRAM_KEYPAIR"
    elif [ "$keypair_id" = "$DECLARED_ID" ]; then
      ok "program keypair" "$keypair_id"
    elif [ "$CLUSTER" = localnet ]; then
      warn "program keypair" "drill id $keypair_id: the program refuses every instruction at an id it was not built for"
      PROGRAM_ID=$keypair_id
      load_chain_program
    else
      bad "program keypair" "$PROGRAM_KEYPAIR holds $keypair_id, not $DECLARED_ID"
    fi
    if [ "$DEPLOYED" = yes ]; then
      bad "on chain" "$PROGRAM_ID is already deployed: run '$SELF status', and if its bytes are the tested binary the deploy is done; to change them, use upgrade"
    else
      ok "on chain" "$PROGRAM_ID is free"
    fi
  elif [ "$DEPLOYED" = no ]; then
    bad "on chain" "$PROGRAM_ID is not deployed: run deploy first"
  elif [ "$CHAIN_AUTHORITY" = "$ADMIN_PUBKEY" ]; then
    ok "upgrade authority" "$CHAIN_AUTHORITY (admin)"
  elif [ "$MODE" = admin ]; then
    warn "upgrade authority" "${CHAIN_AUTHORITY:-none}, not the admin wallet (the config's own authority decides here)"
  else
    bad "upgrade authority" "${CHAIN_AUTHORITY:-none}, not the admin wallet $ADMIN_PUBKEY"
  fi

  say "binary"
  SO_BYTES=0 SO_SHA=""
  if [ -f "$SO" ]; then
    SO_BYTES=$(wc -c <"$SO" | tr -d ' ')
    SO_SHA=$(sha256_of "$SO") || die "could not hash $SO"
    note "file" "$SO · $SO_BYTES bytes"
    local expected
    expected=$(printf %s "${SIP_EXPECTED_SO_SHA256:-}" | tr 'A-F' 'a-f' | tr -d '[:space:]')
    case "$MODE" in
      deploy | upgrade)
        if [ -z "$expected" ]; then
          bad "sha256" "$SO_SHA: set SIP_EXPECTED_SO_SHA256 to the hash reported when the tests passed"
        elif [ "$expected" = "$SO_SHA" ]; then
          ok "sha256" "$SO_SHA, the tested binary"
        else
          bad "sha256" "$SO_SHA, not the tested $expected: rebuilt since the tests? test it again"
        fi
        ;;
      *) note "sha256" "$SO_SHA" ;;
    esac
  else
    case "$MODE" in
      deploy | upgrade) bad "file" "no binary at $SO: build and test it first, never inside this script" ;;
      *) note "file" "no binary at $SO, so status cannot compare bytes" ;;
    esac
  fi

  say "admin wallet"
  if [ ! -f "$ADMIN_KEYPAIR" ]; then
    bad "file" "no keypair at $ADMIN_KEYPAIR (SIP_ADMIN_KEYPAIR)"
  else
    local bits file_pubkey
    bits=$(other_users_bits "$ADMIN_KEYPAIR") || die "could not read the permissions of $ADMIN_KEYPAIR"
    if [ "$bits" = 0 ]; then ok "file" "$ADMIN_KEYPAIR, readable only by you"; else bad "file" "$ADMIN_KEYPAIR is readable by other users: chmod 600 it"; fi
    file_pubkey=$(solana-keygen pubkey "$ADMIN_KEYPAIR" 2>/dev/null || true)
    if [ "$file_pubkey" = "$ADMIN_PUBKEY" ]; then ok "address" "$ADMIN_PUBKEY"; else bad "address" "$ADMIN_KEYPAIR holds ${file_pubkey:-no readable key}, not the admin wallet $ADMIN_PUBKEY"; fi
  fi
  ADMIN_LAMPORTS=$(balance_of "$ADMIN_PUBKEY") || die "could not read the admin wallet's balance from $HOST"
  [ -n "$ADMIN_LAMPORTS" ] || die "could not read the admin wallet's balance from $HOST"
  note "balance" "$(sol "$ADMIN_LAMPORTS")"

  say "settle wallet"
  if [ -z "$SETTLE_PUBKEY" ]; then
    if [ "$MODE" = configure ]; then bad "address" "SIP_SETTLE_PUBKEY is not set"; else note "address" "SIP_SETTLE_PUBKEY not set yet; configure needs it"; fi
  else
    local settle_problem=""
    if ! is_address "$SETTLE_PUBKEY"; then
      settle_problem="SIP_SETTLE_PUBKEY is not a base58 address (the value is not shown)"
    elif [ "$SETTLE_PUBKEY" = "$ADMIN_PUBKEY" ]; then
      settle_problem="the settle wallet IS the admin wallet"
    fi
    if [ -n "$settle_problem" ]; then
      # Pausing must never wait on the settle wallet being right.
      if [ "$MODE" = admin ]; then warn "address" "$settle_problem"; else bad "address" "$settle_problem"; fi
    else
      ok "address" "$SETTLE_PUBKEY, not the admin wallet"
      local settle_lamports
      settle_lamports=$(balance_of "$SETTLE_PUBKEY") || die "could not read the settle wallet's balance from $HOST"
      settle_lamports=${settle_lamports:-0}
      if [ "$settle_lamports" -lt "$SETTLE_LOW" ]; then warn "balance" "$(sol "$settle_lamports"): the keeper pays its fees from here"; else note "balance" "$(sol "$settle_lamports")"; fi
    fi
  fi

  say "money"
  local need=0
  BUFFER_FILE=""
  if { [ "$MODE" = deploy ] || [ "$MODE" = upgrade ]; } && [ -n "$SO_SHA" ]; then
    BUFFER_FILE=scripts/.local/$MODE-buffer-$PROGRAM_ID-${SO_SHA:0:12}.json
    local buffer_lamports=0 other
    for other in scripts/.local/"$MODE"-buffer-"$PROGRAM_ID"-*.json; do
      if [ -e "$other" ] && [ "$other" != "$BUFFER_FILE" ]; then
        warn "old write buffer" "$other is from another binary: '$SELF buffers --close' returns its SOL"
      fi
    done
    if [ -f "$BUFFER_FILE" ]; then
      local buffer_address show buffer_authority buffer_len
      buffer_address=$(solana-keygen pubkey "$BUFFER_FILE" 2>/dev/null || true)
      if [ -z "$buffer_address" ]; then
        bad "write buffer" "$BUFFER_FILE is unreadable"
      elif show=$(sol_cli program show "$buffer_address" --buffer-authority "$ADMIN_PUBKEY" --output json 2>"$WORK/buffer-show.err"); then
        buffer_authority=$(printf %s "$show" | json_get authority) || die "unexpected output from solana program show"
        buffer_len=$(printf %s "$show" | json_get dataLen) || die "unexpected output from solana program show"
        if [ "$buffer_authority" != "$ADMIN_PUBKEY" ]; then
          bad "write buffer" "$buffer_address belongs to ${buffer_authority:-nobody}, not the admin wallet"
        elif [ "$buffer_len" != "$SO_BYTES" ]; then
          bad "write buffer" "$buffer_address has room for ${buffer_len:-an unknown number of} bytes, not $SO_BYTES: '$SELF buffers --close' first"
        else
          buffer_lamports=$(printf %s "$show" | json_get lamports) || die "unexpected output from solana program show"
          buffer_lamports=${buffer_lamports:-0}
          note "write buffer" "resuming $buffer_address, which already holds $(sol "$buffer_lamports")"
        fi
      else
        case "$(cat "$WORK/buffer-show.err" 2>/dev/null)" in
          *"Unable to find the account"*) note "write buffer" "$buffer_address was never created; the upload starts from the beginning" ;;
          *) bad "write buffer" "could not read $buffer_address from $HOST: $(head -1 "$WORK/buffer-show.err" 2>/dev/null | redact)" ;;
        esac
      fi
    fi
    local programdata_rent
    programdata_rent=$(rent_for $((SO_BYTES + PROGRAMDATA_HEADER)))
    if [ "$MODE" = deploy ]; then
      local program_rent
      program_rent=$(rent_for "$PROGRAM_ACCOUNT_BYTES")
      note "ProgramData rent" "$(sol "$programdata_rent"), locked while the program lives"
      note "program account" "$(sol "$program_rent"), locked too"
      note "while uploading" "the write buffer holds that rent, and hands it back to pay for ProgramData"
      need=$((programdata_rent + program_rent + DEPLOY_FEE_MARGIN - buffer_lamports))
    else
      local buffer_rent grow=0
      buffer_rent=$(rent_for $((SO_BYTES + BUFFER_HEADER)))
      # A longer binary grows ProgramData, and the admin wallet pays for the extra bytes.
      if [ "$SO_BYTES" -gt "$CHAIN_DATA_LEN" ]; then
        grow=$((programdata_rent - $(rent_for $((CHAIN_DATA_LEN + PROGRAMDATA_HEADER)))))
      fi
      note "write buffer rent" "$(sol "$buffer_rent"), given back when the bytes land"
      note "ProgramData growth" "$(sol "$grow")"
      need=$((buffer_rent + grow + DEPLOY_FEE_MARGIN - buffer_lamports))
    fi
    if [ -n "$SEND_FLAG" ]; then
      note "upload" "about $((SO_BYTES / BYTES_PER_WRITE + 1)) write transactions through the RPC; one that allows ~1 send a second (a free Helius key) stretches that to 10-20 min, and SIP_DEPLOY_SEND=tpu sends straight to validators"
    else
      note "upload" "about $((SO_BYTES / BYTES_PER_WRITE + 1)) write transactions straight to validators (SIP_DEPLOY_SEND=tpu); if they stall, SIP_DEPLOY_SEND=rpc resumes the same buffer"
    fi
  elif [ "$MODE" = configure ]; then
    need=$ADMIN_VERB_MINIMUM
  fi
  [ "$need" -ge "$PAUSE_MINIMUM" ] || need=$PAUSE_MINIMUM
  if [ "$ADMIN_LAMPORTS" -ge "$need" ]; then ok "admin balance" "$(sol "$ADMIN_LAMPORTS"), needs $(sol "$need")"; else bad "admin balance" "$(sol "$ADMIN_LAMPORTS"), needs $(sol "$need")"; fi
  local left
  if left=$(sol_cli program show --buffers --buffer-authority "$ADMIN_PUBKEY" --output json 2>/dev/null | json_get buffers.length); then
    if [ "${left:-0}" -gt 0 ]; then
      warn "write buffers" "$left on chain: the command that was interrupted resumes its own; '$SELF buffers --close' returns the SOL of all"
    else
      note "write buffers" "none on chain"
    fi
  else
    warn "write buffers" "could not list them"
  fi

  if [ "$BLOCKERS" -eq 0 ]; then
    if [ "$MODE" = admin ]; then say "ready"; else say "ready to $MODE"; fi
    return 0
  fi
  say "$BLOCKERS blocker(s); nothing was sent"
  return 1
}

# Uploads a private copy whose hash is checked again, so the checked bytes are the bytes that go up.
pin_binary() {
  PINNED=$WORK/sip_vault-${SO_SHA:0:12}.so
  (umask 077 && cp "$SO" "$PINNED") || die "could not copy $SO"
  [ "$(sha256_of "$PINNED")" = "$SO_SHA" ] || die "$SO changed while it was being copied: test it again"
  note "pinned copy" "sha256 checked again; this copy is what gets uploaded"
}

new_buffer_keypair() {
  mkdir -p scripts/.local && chmod 700 scripts/.local
  if [ -f "$BUFFER_FILE" ]; then
    say "resuming: only the bytes the interrupted run did not write are sent"
  else
    (umask 077 && solana-keygen new --no-bip39-passphrase --silent --outfile "$BUFFER_FILE" >/dev/null)
  fi
  note "write buffer" "$(solana-keygen pubkey "$BUFFER_FILE")"
}

cmd_deploy() {
  cmd_preflight deploy
  pin_binary
  new_buffer_keypair
  confirm "$PROGRAM_ID" "Publish $SO (sha256 $SO_SHA) as $PROGRAM_ID on $CLUSTER, paid for by and upgradeable only by $ADMIN_PUBKEY."
  say "deploying: about $((SO_BYTES / BYTES_PER_WRITE + 1)) writes, then the deploy; if this stops for any reason, run the same command again"
  start_ticker "uploading"
  # shellcheck disable=SC2086 # SEND_FLAG is one flag or nothing
  sol_cli program deploy "$PINNED" --program-id "$PROGRAM_KEYPAIR" --buffer "$BUFFER_FILE" \
    --upgrade-authority "$ADMIN_KEYPAIR" --fee-payer "$ADMIN_KEYPAIR" --keypair "$ADMIN_KEYPAIR" \
    $SEND_FLAG --with-compute-unit-price "$CU_PRICE" --max-sign-attempts 100 2>&1 | redact
  stop_ticker
  rm -f "$BUFFER_FILE"
  say "what landed"
  status_until_ok --allow-unconfigured || die "the deploy command finished, but status does not pass: read the lines above"
  say "next: SIP_SETTLE_PUBKEY=<settle wallet address> $SELF configure"
}

cmd_upgrade() {
  cmd_preflight upgrade
  pin_binary
  new_buffer_keypair
  confirm "$PROGRAM_ID" "Replace the bytes of $PROGRAM_ID on $CLUSTER with $SO (sha256 $SO_SHA). The config, vaults, links and policies stay."
  say "upgrading: about $((SO_BYTES / BYTES_PER_WRITE + 1)) writes, then the upgrade; if this stops for any reason, run the same command again"
  start_ticker "uploading"
  # For an upgrade --program-id is the address: the program keypair is not needed, and not read.
  # shellcheck disable=SC2086 # SEND_FLAG is one flag or nothing
  sol_cli program deploy "$PINNED" --program-id "$PROGRAM_ID" --buffer "$BUFFER_FILE" \
    --upgrade-authority "$ADMIN_KEYPAIR" --fee-payer "$ADMIN_KEYPAIR" --keypair "$ADMIN_KEYPAIR" \
    $SEND_FLAG --with-compute-unit-price "$CU_PRICE" --max-sign-attempts 100 2>&1 | redact
  stop_ticker
  rm -f "$BUFFER_FILE"
  say "what landed"
  status_until_ok || die "the upgrade command finished, but status does not pass: read the lines above"
}

cmd_configure() {
  cmd_preflight configure
  confirm CONFIGURE "Configure $PROGRAM_ID on $CLUSTER: authority $ADMIN_PUBKEY (admin), attester and keeper $SETTLE_PUBKEY (settle)."
  admin_tool init-config
  say "status"
  status_until_ok || die "configure finished, but status does not pass: read the lines above"
}

cmd_panic() {
  local disarm=${1:-} failed=0
  case "$disarm" in "" | --disarm-keeper) ;; *) die "usage: $SELF panic [--disarm-keeper]" ;; esac
  cmd_preflight admin
  local what="Pause the protocol"
  [ -z "$disarm" ] || what="Pause the protocol AND name no keeper"
  confirm PAUSE "$what on $CLUSTER: settle, link_wallet, wrap_sol, convert and invest stop for every vault. Withdrawals and unlinking keep working."
  # Each step runs even if the one before it failed: in an emergency, half a panic beats none.
  admin_tool pause || failed=1
  if [ -n "$disarm" ]; then admin_tool set-keeper "$NOBODY" || failed=1; fi
  say "status"
  admin_tool status || true
  [ "$failed" -eq 0 ] || die "a step above did not complete: read it, then run panic again (it skips what is already done)"
  if [ -z "$disarm" ]; then say "paused; to resume: $SELF unpause"; else say "paused and disarmed; to resume: $SELF unpause, then $SELF set-keeper <settle wallet address>"; fi
}

cmd_unpause() {
  cmd_preflight admin
  confirm UNPAUSE "Resume the protocol on $CLUSTER: settle, link_wallet, wrap_sol, convert and invest run again."
  admin_tool unpause
  say "status"
  # Informational: after panic --disarm-keeper the keeper is still nobody until set-keeper.
  admin_tool status || say "running again; status still differs above (after --disarm-keeper: $SELF set-keeper <settle wallet address>)"
}

cmd_set_role() {
  local role=$1 key=${2:-}
  [ -n "$key" ] || die "usage: $SELF set-$role <address>"
  is_address "$key" || die "that is not a base58 address (the value is not shown)"
  cmd_preflight admin
  confirm "${key:0:6}" "Name $key as the $role of $PROGRAM_ID on $CLUSTER."
  admin_tool "set-$role" "$key"
}

cmd_status() {
  cluster
  admin_tool status "$@"
}

# Its own checks: closing must work before the program exists, which is exactly when a deploy was interrupted.
cmd_buffers() {
  cluster
  say "write buffers owned by $ADMIN_PUBKEY on $CLUSTER"
  sol_cli program show --buffers --buffer-authority "$ADMIN_PUBKEY" 2>&1 | redact
  [ "${1:-}" = --close ] || return 0
  require_admin_file
  local lamports
  lamports=$(balance_of "$ADMIN_PUBKEY") || die "could not read the admin wallet's balance from $HOST"
  [ "${lamports:-0}" -ge "$PAUSE_MINIMUM" ] || die "the admin wallet holds $(sol "${lamports:-0}"), not enough for the fees"
  confirm CLOSE "Close every write buffer owned by $ADMIN_PUBKEY on $CLUSTER and return its SOL to it. An interrupted deploy then starts over."
  sol_cli program close --buffers --authority "$ADMIN_KEYPAIR" --recipient "$ADMIN_PUBKEY" --keypair "$ADMIN_KEYPAIR" 2>&1 | redact
  rm -f scripts/.local/deploy-buffer-*.json scripts/.local/upgrade-buffer-*.json
  say "write buffers left"
  sol_cli program show --buffers --buffer-authority "$ADMIN_PUBKEY" 2>&1 | redact
}

case "${1:-}" in
  preflight) cmd_preflight "${2:-auto}" ;;
  deploy) cmd_deploy ;;
  configure) cmd_configure ;;
  status) shift && cmd_status "$@" ;;
  panic) cmd_panic "${2:-}" ;;
  unpause) cmd_unpause ;;
  set-keeper) cmd_set_role keeper "${2:-}" ;;
  set-attester) cmd_set_role attester "${2:-}" ;;
  upgrade) cmd_upgrade ;;
  buffers) cmd_buffers "${2:-}" ;;
  *)
    sed -n '4,13p' "$SELF" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
