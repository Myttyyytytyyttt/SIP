#!/bin/bash
# Tu vault entre los keepers de siempre y la cola (handover-prod.mts):
#   handover-prod.sh estado | traspasar | volver | marcar-ido <process_id>
# Pide la DATABASE_URL de sip-solana-keeper sin enseñarla y no la guarda.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
KEEPER="$(cd "$HERE/../.." && pwd)"
export PATH="${SIP_TOOL_BIN:+$SIP_TOOL_BIN:}$HOME/.nvm/versions/node/v22.14.0/bin:$PATH"
case "${1:-}" in
  estado|traspasar|volver) ;;
  marcar-ido) [ -n "${2:-}" ] || { echo "marcar-ido necesita un process_id."; exit 2; } ;;
  *) echo "Uso: $0 estado | traspasar | volver | marcar-ido <process_id>"; exit 2 ;;
esac
printf '\nPega la DATABASE_URL de sip-solana-keeper (Railway → Variables) y pulsa Enter.\nNo se verá mientras la pegas: '
IFS= read -rs PROD_DB
echo
cd "$KEEPER" && PROD_DB="$PROD_DB" node_modules/.bin/tsx test-local/shadow/handover-prod.mts "$@"
status=$?
unset PROD_DB
exit $status
