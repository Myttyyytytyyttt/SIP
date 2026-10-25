#!/bin/bash
# Prepara la base de la prueba en sombra en Railway (railway-setup.mts): pide su
# dirección pública sin enseñarla y no la guarda en ningún sitio.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
KEEPER="$(cd "$HERE/../.." && pwd)"
export PATH="${SIP_TOOL_BIN:+$SIP_TOOL_BIN:}$HOME/.nvm/versions/node/v22.14.0/bin:$PATH"
printf '\nPega la DATABASE_PUBLIC_URL de la base Postgres de la sombra (Railway) y pulsa Enter.\nNo se verá mientras la pegas: '
IFS= read -rs SHADOW_DB
echo
cd "$KEEPER" && SHADOW_DB="$SHADOW_DB" node_modules/.bin/tsx test-local/shadow/railway-setup.mts
status=$?
unset SHADOW_DB
exit $status
