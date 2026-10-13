#!/bin/bash
# SaverFi · la sombra local de 7 días: ARRANCA o REANUDA.
#
# Copia este archivo, status.sh y stop.sh a la carpeta de la corrida (por
# ejemplo ~/sip-shadow-7d), con el código en <carpeta>/code y el modelo de
# costes en <carpeta>/model/model.py. El estado (resultados, logs, informes)
# queda en <carpeta>/state; la base de datos, en el volumen de Docker
# sip-shadow-7d-pgdata. Nada de eso se borra al parar ni al reiniciar el Mac.
#
# Lo que hace:
#   1. si ya corre, lo dice y no hace nada (nunca dos a la vez);
#   2. si la corrida ya terminó (168 h cubiertas), lo dice;
#   3. si Docker no está en marcha, lo dice y no arranca;
#   4. arranca, separado de la terminal (nohup) y con el Mac despierto
#      (caffeinate -i -s), un bucle que corre el arnés; si ya hay estado, con
#      --resume: sigue la misma corrida, anota el hueco y no repite simulacros.
#      Si el arnés se cae por un error, el bucle espera a Docker y lo vuelve a
#      arrancar (hasta 50 veces); stop.sh lo para de verdad.
#
# Variables solo para pruebas (la corrida real no necesita ninguna):
#   SHADOW_STATE, SHADOW_PG_VOLUME, SHADOW_TARGET_HOURS, SHADOW_DRILLS,
#   SHADOW_MODEL, SHADOW_CODE, SHADOW_NODE_DIR, SHADOW_EXTRA_ARGS.
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
SELF="$HERE/$(basename "$0")"
CODE="${SHADOW_CODE:-$HERE/code}"
KEEPER="$CODE/packages/solana-keeper"
STATE="${SHADOW_STATE:-$HERE/state}"
VOLUME="${SHADOW_PG_VOLUME:-sip-shadow-7d-pgdata}"
TARGET_HOURS="${SHADOW_TARGET_HOURS:-168}"
DRILLS="${SHADOW_DRILLS:-week}"
MODEL="${SHADOW_MODEL:-$HERE/model/model.py}"
EXTRA="${SHADOW_EXTRA_ARGS:-}"
NODE_DIR="${SHADOW_NODE_DIR:-$HOME/.nvm/versions/node/v22.14.0/bin}"
LOOP_PID="$STATE/start.pid"
export PATH="$NODE_DIR:/opt/homebrew/bin:/usr/local/bin:/Applications/Docker.app/Contents/Resources/bin:/usr/bin:/bin:/usr/sbin:/sbin"

stamp() { date -u +%Y-%m-%dT%H:%M:%SZ; }
harness_alive() {
  [ -f "$STATE/harness.pid" ] || return 1
  ps -o command= -p "$(cat "$STATE/harness.pid")" 2>/dev/null | grep -q "harness.ts"
}

# ── EL BUCLE (corre bajo nohup y caffeinate; no se llama a mano) ─────────────
if [ "${1:-}" = "__loop" ]; then
  restarts=0
  while :; do
    [ -f "$STATE/stop.requested" ] && break
    resume=""
    [ -f "$STATE/run.json" ] && resume="--resume"
    model=""
    [ -f "$MODEL" ] && model="--model $MODEL"
    echo "$(stamp) bucle: arranca el arnés ${resume:-(corrida nueva)}"
    # shellcheck disable=SC2086
    (cd "$KEEPER" && exec node --import tsx test-local/shadow/harness.ts --state "$STATE" $resume \
      --pg-volume "$VOLUME" --target-hours "$TARGET_HOURS" --drills "$DRILLS" $model $EXTRA)
    code=$?
    echo "$(stamp) bucle: el arnés salió con código $code"
    [ -f "$STATE/stop.requested" ] && break
    # 0: terminó o lo pararon; 2: opciones o estado que no sirven; 3: ya corre otro. Nada de eso se arregla reintentando.
    case "$code" in 0|2|3) break ;; esac
    restarts=$((restarts + 1))
    if [ "$restarts" -gt 50 ]; then
      echo "$(stamp) bucle: 50 reinicios; me rindo. Mira $STATE/harness.out y $STATE/events.jsonl"
      break
    fi
    sleep 60
    until docker info >/dev/null 2>&1; do
      [ -f "$STATE/stop.requested" ] && break 2
      echo "$(stamp) bucle: Docker no está en marcha; espero"
      sleep 30
    done
  done
  rm -f "$LOOP_PID"
  exit 0
fi

# ── ARRANCAR ──────────────────────────────────────────────────────────────────
mkdir -p "$STATE"

if [ -f "$LOOP_PID" ] && kill -0 "$(cat "$LOOP_PID")" 2>/dev/null; then
  echo "Ya está corriendo (proceso $(cat "$LOOP_PID")). No arranco otra."
  echo "Para ver cómo va: $HERE/status.sh"
  exit 0
fi
if harness_alive; then
  echo "Ya está corriendo (arnés $(cat "$STATE/harness.pid")). No arranco otra."
  echo "Para ver cómo va: $HERE/status.sh"
  exit 0
fi
if [ -f "$STATE/run.json" ] && grep -q '"completedAt": "' "$STATE/run.json"; then
  echo "La corrida ya terminó: tiene sus horas cubiertas. No hay nada que reanudar."
  echo "El informe: $STATE/summary.txt"
  exit 0
fi
if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "Docker no está en marcha, así que no arranco."
  echo "Abre Docker Desktop (Aplicaciones → Docker), espera a que diga que está en marcha"
  echo "y vuelve a ejecutar: $SELF"
  exit 1
fi
if [ ! -x "$NODE_DIR/node" ]; then
  echo "No encuentro Node 22 en $NODE_DIR. No arranco."
  exit 1
fi
if [ ! -d "$KEEPER/node_modules" ]; then
  echo "Faltan las dependencias del código en $CODE (pnpm install). No arranco."
  exit 1
fi
free_kb=$(df -k "$STATE" | awk 'NR==2 {print $4}')
if [ "${free_kb:-0}" -lt 2000000 ]; then
  echo "Quedan menos de 2 GB libres en el disco; la corrida escribe unos 250 MB en 7 días. Libera espacio y vuelve a probar."
  exit 1
fi
if pmset -g batt 2>/dev/null | grep -q "Battery Power"; then
  echo "AVISO: el Mac está con batería. Enchúfalo: con batería caffeinate no impide que se duerma, y la batería no dura 7 días."
fi
if [ ! -f "$MODEL" ]; then
  echo "AVISO: no encuentro el modelo de costes en $MODEL; los créditos se medirán pero no se compararán con el modelo."
fi

rm -f "$STATE/stop.requested"
if [ -f "$STATE/run.json" ]; then what="Reanudo la corrida que hay en $STATE"; else what="Empiezo una corrida nueva en $STATE"; fi
nohup caffeinate -i -s "$SELF" __loop >>"$STATE/harness.out" 2>&1 &
echo $! >"$LOOP_PID"
echo "$what (proceso $(cat "$LOOP_PID"))."

for _ in $(seq 1 30); do
  harness_alive && break
  sleep 1
done
if harness_alive; then
  echo "El arnés corre (pid $(cat "$STATE/harness.pid")). Tarda 1–3 minutos en tener la flota en marcha."
  echo "Para ver cómo va: $HERE/status.sh   ·   Para pararlo: $HERE/stop.sh"
else
  echo "El arnés no arrancó en 30 s. Las últimas líneas de $STATE/harness.out:"
  tail -n 15 "$STATE/harness.out"
  exit 1
fi
