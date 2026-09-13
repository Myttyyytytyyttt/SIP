#!/usr/bin/env bash
# Nuvem-Solana on MAINNET, one verb at a time. Small money, recoverable rent.
#
#   ./scripts/mainnet.sh preflight   what would be spent, from where, checks
#   ./scripts/mainnet.sh deploy      deploy + init_config in one breath
#   ./scripts/mainnet.sh status      program, config, vault, balances
#   ./scripts/mainnet.sh ready       is everything wired for a real test?
#   ./scripts/mainnet.sh drill       the whole chain with real money (small)
#   ./scripts/mainnet.sh upgrade     ship new program bytes to the SAME id
#   ./scripts/mainnet.sh set-keeper  name who may crank — REQUIRED AFTER upgrade
#   ./scripts/mainnet.sh close       recover the rent — READ THE WARNING
#
# THE UPGRADE THAT CLOSED THE PERMISSIONLESS CRANK IS A TWO-STEP, IN ORDER.
# `wrap_sol` and `convert` now refuse every signer but the vault's owner and the
# one keeper named in the config — and the live config's keeper reads as the
# default pubkey, which means NOBODY. So the moment `upgrade` lands, the keeper
# stops being able to wrap or convert until `set-keeper` runs. Owners can still
# withdraw the whole time; only automation pauses. Run them back to back.
#
# NOTHING HERE PRINTS OR STORES A PRIVATE KEY. The operator key is the file at
# $NUVEM_SOLANA_KEYPAIR (default ~/.config/solana/id.json); the attester and
# trading-wallet keys persist under scripts/.local/ (gitignored).
#
# THE ECONOMY, measured not guessed:
#   * deploy locks ~2.79 SOL of rent in the ProgramData account
#   * `close` returns it TO THE LAMPORT (verified empirically) — but a closed
#     program id can NEVER be redeployed; to iterate, UPGRADE (anchor upgrade),
#     never close-and-redeploy
#   * the drill's capital+profit move between the operator's own pockets and
#     end as withdrawable NVDAx in the operator's vault; the true burn is
#     transaction fees plus two pool fees — cents
set -euo pipefail
cd "$(dirname "$0")/.."
# Operator-local overrides (RPC key etc.); gitignored.
[ -f .env.mainnet ] && set -a && . ./.env.mainnet && set +a

RPC="${NUVEM_SOLANA_MAINNET_RPC:-https://api.mainnet-beta.solana.com}"
KEYPAIR="${NUVEM_SOLANA_KEYPAIR:-$HOME/.config/solana/id.json}"
PROGRAM_KEYPAIR=target/deploy/sip_vault-keypair.json

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %-26s %s\n' "$1" "$2"; }
die()  { printf '\n\033[31m%s\033[0m\n\n' "$*" >&2; exit 1; }

[ -f "$KEYPAIR" ] || die "No keypair at $KEYPAIR. Set NUVEM_SOLANA_KEYPAIR or create one."
OPERATOR=$(solana-keygen pubkey "$KEYPAIR")
PROGRAM_ID=$(solana-keygen pubkey "$PROGRAM_KEYPAIR")

cmd_preflight() {
  say "operator"
  info "keypair" "$KEYPAIR"
  info "address" "$OPERATOR"
  info "balance" "$(solana balance "$OPERATOR" -u "$RPC" 2>/dev/null || echo unreachable)"
  say "rpc"
  info "url" "$RPC"
  [ "$RPC" = "https://api.mainnet-beta.solana.com" ] && \
    info "note" "public RPC throttles the drill's history walks; a free Helius key is smoother"
  say "program"
  info "id (from keypair)" "$PROGRAM_ID"
  info "deployed?" "$(solana program show "$PROGRAM_ID" -u "$RPC" >/dev/null 2>&1 && echo yes || echo 'not yet')"
  say "costs"
  info "deploy rent" "~2.79 SOL — RECOVERABLE via close (which kills the id forever)"
  info "drill" "capital+profit stay yours (end as NVDAx in your vault); burn = fees, cents"
  say "fund $OPERATOR with ~3.2 SOL, then: ./scripts/mainnet.sh deploy"
}

cmd_deploy() {
  solana program show "$PROGRAM_ID" -u "$RPC" >/dev/null 2>&1 && die "Already deployed. Use 'anchor upgrade' to iterate; never close-and-redeploy."
  say "building"
  anchor build 2>&1 | tail -1
  # ONLY sip_vault. `anchor deploy` with no -p ships the WHOLE workspace, so
  # it also deployed toy_venue — the test-only venue that must NEVER touch
  # mainnet (there the venue is Raydium) — burning 1.5 SOL and starving the
  # real deploy. `solana program deploy` of the one .so avoids the whole trap.
  say "deploying sip_vault only (locks ~2.79 SOL of recoverable rent)"
  solana program deploy target/deploy/sip_vault.so \
    --program-id "$PROGRAM_KEYPAIR" \
    --keypair "$KEYPAIR" -u "$RPC" 2>&1 | tail -3
  say "init_config — SAME BREATH as the deploy: first caller wins, so the ceremony leaves no window"
  ANCHOR_PROVIDER_URL="$RPC" ANCHOR_WALLET="$KEYPAIR" npx tsx scripts/mainnet-init-config.ts
  say "verify"
  cmd_status
}

cmd_status() {
  say "program $PROGRAM_ID"
  solana program show "$PROGRAM_ID" -u "$RPC" 2>&1 | grep -E "Balance|Authority|Data Length" | sed 's/^/  /'
  ANCHOR_PROVIDER_URL="$RPC" ANCHOR_WALLET="$KEYPAIR" npx tsx scripts/mainnet-status.ts
}

cmd_ready() {
  # The readiness check lives with the keeper it checks (packages/solana-keeper,
  # bin/ready.mts) and speaks only its SIP_SOLANA_* names.
  #
  # THIS SCRIPT'S OWN TWO OVERRIDES ARE STRIPPED FIRST. NUVEM_SOLANA_MAINNET_RPC
  # and NUVEM_SOLANA_KEYPAIR are this script's documented operator variables
  # (read above for deploy, status, upgrade and set-keeper), and `set -a` exported
  # them from .env.mainnet. Left in, the keeper's check reported them as copied
  # config and `ready` failed for an operator who followed this header. The RPC
  # is already forwarded as SIP_SOLANA_RPC_URLS, and the keypair is the
  # operator's, never the keeper's. Any OTHER NUVEM_* or bare PRIVY_* name
  # exported from .env.mainnet is still reported there as copied config.
  env -u NUVEM_SOLANA_MAINNET_RPC -u NUVEM_SOLANA_KEYPAIR \
    SIP_SOLANA_RPC_URLS="${SIP_SOLANA_RPC_URLS:-$RPC}" \
    SIP_SOLANA_POOLS="${SIP_SOLANA_POOLS:-}" \
    pnpm --dir ../solana-keeper ready
}

cmd_drill() {
  ANCHOR_PROVIDER_URL="$RPC" ANCHOR_WALLET="$KEYPAIR" npx tsx scripts/mainnet-drill.ts
}

cmd_upgrade() {
  say "UPGRADE $PROGRAM_ID"
  echo "  This replaces the program's bytes at the SAME id — PDAs, vaults, links and the"
  echo "  config all survive. It is the ONLY safe way to iterate: close-and-redeploy kills"
  echo "  the id forever (see the close warning)."
  echo
  echo "  AFTER this completes the keeper cannot wrap or convert until you run:"
  echo "      $0 set-keeper <keeper-pubkey>"
  echo
  read -r -p "  type the program id to confirm: " CONFIRM
  [ "$CONFIRM" = "$PROGRAM_ID" ] || die "not confirmed"
  anchor build
  # The single .so, never the whole workspace: `anchor deploy` ships every
  # program in it, which once cost 1.5 SOL deploying the toy venue to mainnet.
  solana program deploy target/deploy/sip_vault.so \
    --program-id "$PROGRAM_KEYPAIR" -u "$RPC" -k "$KEYPAIR"
  say "NOW RUN:  $0 set-keeper <keeper-pubkey>"
}

cmd_set_keeper() {
  KEEPER="${2:-}"
  [ -n "$KEEPER" ] || die "usage: $0 set-keeper <keeper-pubkey>
  Pass 11111111111111111111111111111111 to disarm the keeper entirely
  (owner-only cranking) — the panic switch if its key is ever suspected."
  ANCHOR_PROVIDER_URL="$RPC" ANCHOR_WALLET="$KEYPAIR" npx tsx scripts/mainnet-set-keeper.ts "$KEEPER"
}

cmd_close() {
  say "WARNING"
  echo "  Closing returns the ~2.79 SOL of rent but KILLS program id $PROGRAM_ID forever:"
  echo "  it can never be redeployed, and every vault/link/policy PDA derived from it"
  echo "  becomes unreachable. Withdraw everything from the vault FIRST."
  echo
  read -r -p "  type the program id to confirm: " CONFIRM
  [ "$CONFIRM" = "$PROGRAM_ID" ] || die "not confirmed"
  solana program close "$PROGRAM_ID" --bypass-warning -u "$RPC" -k "$KEYPAIR"
}

case "${1:-}" in
  preflight) cmd_preflight ;;
  deploy)    cmd_deploy ;;
  status)    cmd_status ;;
  ready)     cmd_ready ;;
  drill)     cmd_drill ;;
  upgrade)   cmd_upgrade ;;
  set-keeper) cmd_set_keeper "$@" ;;
  close)     cmd_close ;;
  *) echo "usage: $0 preflight|deploy|status|ready|drill|upgrade|set-keeper|close"; exit 2 ;;
esac
