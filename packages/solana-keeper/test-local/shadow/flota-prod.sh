#!/bin/bash
# Toda la flota entre los keepers de siempre y el sistema nuevo (flota-prod.mts):
#   flota-prod.sh flota
#   flota-prod.sh traspasar <vault> | traspasar-todos | volver <vault>
#   flota-prod.sh nuevos-a-la-cola | nuevos-a-los-de-siempre
#   flota-prod.sh marcar-ido <id>... | marcar-idos-viejos | desaparcar <vault>
# Pide la DATABASE_URL de sip-solana-keeper sin enseñarla y no la guarda.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
KEEPER="$(cd "$HERE/../.." && pwd)"
export PATH="${SIP_TOOL_BIN:+$SIP_TOOL_BIN:}$HOME/.nvm/versions/node/v22.14.0/bin:$PATH"
case "${1:-}" in
  flota|traspasar-todos|nuevos-a-la-cola|nuevos-a-los-de-siempre|marcar-idos-viejos) ;;
  traspasar|volver|desaparcar) [ -n "${2:-}" ] || { echo "«$1» necesita un vault: su dirección, o sus primeras letras como las enseña «flota»."; exit 2; } ;;
  marcar-ido) [ -n "${2:-}" ] || { echo "marcar-ido necesita el id de un keeper (el que enseña «flota»)."; exit 2; } ;;
  *) echo "Uso: $0 flota | traspasar <vault> | traspasar-todos | volver <vault> | nuevos-a-la-cola | nuevos-a-los-de-siempre | marcar-ido <id>... | marcar-idos-viejos | desaparcar <vault>"; exit 2 ;;
esac
printf '\nPega la DATABASE_URL de sip-solana-keeper (Railway → Variables) y pulsa Enter.\nNo se verá mientras la pegas: '
IFS= read -rs PROD_DB
echo
cd "$KEEPER" && PROD_DB="$PROD_DB" node_modules/.bin/tsx test-local/shadow/flota-prod.mts "$@"
status=$?
unset PROD_DB
exit $status
