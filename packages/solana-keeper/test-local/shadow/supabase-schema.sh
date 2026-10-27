#!/bin/bash
# Crea en Supabase (producción) las tablas del repartidor (supabase-schema.mts):
# pide la DATABASE_URL de sip-solana-keeper sin enseñarla y no la guarda.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
KEEPER="$(cd "$HERE/../.." && pwd)"
export PATH="${SIP_TOOL_BIN:+$SIP_TOOL_BIN:}$HOME/.nvm/versions/node/v22.14.0/bin:$PATH"
printf '\nPega la DATABASE_URL de sip-solana-keeper (Railway → Variables) y pulsa Enter.\nNo se verá mientras la pegas: '
IFS= read -rs PROD_DB
echo
cd "$KEEPER" && PROD_DB="$PROD_DB" node_modules/.bin/tsx test-local/shadow/supabase-schema.mts
status=$?
unset PROD_DB
exit $status
