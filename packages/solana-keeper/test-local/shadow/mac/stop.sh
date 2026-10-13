#!/bin/bash
# SaverFi · la sombra local de 7 días: PARA, limpio, y guarda el estado.
#
# El arnés recibe SIGTERM: para sus procesos (cada uno cierra su fila y su
# contador), apaga Postgres sin perder nada (los datos siguen en el volumen
# sip-shadow-7d-pgdata) y escribe el informe. Tarda hasta 2–3 minutos.
# Después, start.sh reanuda la misma corrida y anota el hueco.
#
# Si el arnés no termina en 4 minutos, lo mata, junto con lo que dejó en
# marcha (solo procesos de este código o de esta carpeta, y solo el
# contenedor con la etiqueta de esta corrida).
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
CODE="${SHADOW_CODE:-$HERE/code}"
KEEPER="$CODE/packages/solana-keeper"
STATE="${SHADOW_STATE:-$HERE/state}"
LOOP_PID="$STATE/start.pid"
export PATH="/opt/homebrew/bin:/usr/local/bin:/Applications/Docker.app/Contents/Resources/bin:/usr/bin:/bin:/usr/sbin:/sbin"

if [ ! -d "$STATE" ]; then
  echo "No hay ninguna corrida en $STATE."
  exit 0
fi
# EL BUCLE NO DEBE VOLVER A ARRANCARLO.
touch "$STATE/stop.requested"

harness_pid=""
if [ -f "$STATE/harness.pid" ] && ps -o command= -p "$(cat "$STATE/harness.pid")" 2>/dev/null | grep -q "harness.ts"; then
  harness_pid="$(cat "$STATE/harness.pid")"
fi

if [ -n "$harness_pid" ]; then
  echo "Parando el arnés (pid $harness_pid): cierra los procesos, apaga la base de datos y escribe el informe. Puede tardar 2–3 minutos."
  kill -TERM "$harness_pid" 2>/dev/null
  waited=0
  while kill -0 "$harness_pid" 2>/dev/null && [ "$waited" -lt 240 ]; do
    sleep 5
    waited=$((waited + 5))
    printf "."
  done
  echo
  if kill -0 "$harness_pid" 2>/dev/null; then
    echo "No terminó en 4 minutos: lo mato."
    kill -KILL "$harness_pid" 2>/dev/null
  fi
else
  echo "El arnés no está corriendo."
fi

# LO QUE PUDO QUEDAR: hijos de este código o de esta carpeta, y el contenedor de esta corrida.
if [ -f "$STATE/children.json" ]; then
  for pid in $(grep -o '"pid": [0-9]*' "$STATE/children.json" | grep -o '[0-9]*'); do
    cmd="$(ps -o command= -p "$pid" 2>/dev/null)"
    case "$cmd" in
      *"$KEEPER"* | *"$STATE"*)
        kill -KILL "$pid" 2>/dev/null && echo "Quedaba un proceso del arnés ($pid): parado."
        ;;
    esac
  done
fi
container="$(grep -o '"pgName": "[^"]*"' "$STATE/run.json" 2>/dev/null | sed 's/.*: "//; s/"$//')"
if [ -n "$container" ] && docker info >/dev/null 2>&1; then
  label="$(docker inspect -f '{{ index .Config.Labels "sip.shadow.state" }}' "$container" 2>/dev/null)"
  if [ "$label" = "$STATE" ]; then
    docker unpause "$container" >/dev/null 2>&1
    docker stop -t 30 "$container" >/dev/null 2>&1 && echo "Quedaba la base de datos en marcha ($container): apagada; sus datos siguen en el volumen."
    docker rm -f "$container" >/dev/null 2>&1
  fi
fi

if [ -f "$LOOP_PID" ]; then
  loop="$(cat "$LOOP_PID")"
  for _ in $(seq 1 30); do
    kill -0 "$loop" 2>/dev/null || break
    sleep 1
  done
  if kill -0 "$loop" 2>/dev/null; then
    # EL BUCLE QUE LLEVA DENTRO caffeinate, y luego caffeinate.
    pkill -TERM -P "$loop" 2>/dev/null
    sleep 1
    kill -TERM "$loop" 2>/dev/null
  fi
  rm -f "$LOOP_PID"
fi

echo "Parada. El estado se queda en $STATE (y la base de datos en su volumen)."
echo "Para reanudar: $HERE/start.sh   ·   Para ver el resultado: $HERE/status.sh"
