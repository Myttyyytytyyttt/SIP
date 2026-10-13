#!/bin/bash
# SaverFi · la sombra local de 7 días: CÓMO VA, en una pantalla.
#
# Solo lee archivos (status.json, que el arnés reescribe cada minuto, y
# report.json, el informe que rehace cada 30 minutos); no toca nada.
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
STATE="${SHADOW_STATE:-$HERE/state}"
NODE_DIR="${SHADOW_NODE_DIR:-$HOME/.nvm/versions/node/v22.14.0/bin}"
export PATH="$NODE_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

running="no"
harness_pid=""
if [ -f "$STATE/harness.pid" ] && ps -o command= -p "$(cat "$STATE/harness.pid")" 2>/dev/null | grep -q "harness.ts"; then
  running="si"
  harness_pid="$(cat "$STATE/harness.pid")"
fi
loop="no"
if [ -f "$STATE/start.pid" ] && kill -0 "$(cat "$STATE/start.pid")" 2>/dev/null; then loop="si"; fi

node - "$STATE" "$running" "$harness_pid" "$loop" "$HERE" <<'EOF'
const fs = require("node:fs");
const path = require("node:path");
const [state, running, harnessPid, loop, here] = process.argv.slice(2);
const read = (file) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(state, file), "utf8"));
  } catch {
    return null;
  }
};
const status = read("status.json");
const report = read("report.json");
const run = read("run.json");
const now = Date.now();
const when = (iso) => (iso ? new Date(iso).toLocaleString("es-ES", { dateStyle: "short", timeStyle: "short" }) : "—");
const ago = (iso) => {
  if (!iso) return "";
  const min = Math.round((now - Date.parse(iso)) / 60000);
  return min < 120 ? `hace ${min} min` : `hace ${(min / 60).toFixed(1)} h`;
};
const h = (x) => (x === null || x === undefined ? "—" : Number(x).toFixed(1));
/** Hours, or minutes under an hour. */
const hm = (x) => (x === null || x === undefined ? "—" : x < 1 ? `${Math.round(x * 60)} min` : `${Number(x).toFixed(1)} h`);
const cause = (text) => {
  const known = [
    ["the harness's minute did not run", "el Mac durmió o el proceso estuvo congelado"],
    ["the shadow's fleet was not whole", "faltaban procesos de la sombra"],
    ["the harness was stopped", "se paró (stop.sh) y se volvió a arrancar"],
    ["the Mac restarted", "el Mac se reinició"],
    ["the harness ended without stopping cleanly", "el arnés terminó sin pararse bien (matado, un fallo o un corte de luz)"],
    ["the harness exited", "el arnés salió por un error y se volvió a arrancar"],
    ["setup failed", "el arranque falló y se volvió a intentar"],
    ["no beat since", "sin registros desde entonces: el arnés no corre o el Mac duerme"],
  ];
  for (const [prefix, es] of known) if (text.includes(prefix)) return es;
  return text;
};
const verdict = { PASS: "OK", FAIL: "FALLA", PENDING: "pendiente" };
const out = [];
out.push("SaverFi · sombra local de 7 días (mainnet solo lectura, sin claves)");
out.push("");
if (!status && !run) {
  out.push(`No hay ninguna corrida en ${state}.`);
  out.push(`Para empezar: ${here}/start.sh`);
  console.log(out.join("\n"));
  process.exit(0);
}
if (run && run.completedAt) {
  out.push(`TERMINADA el ${when(run.completedAt)}: se cubrieron las horas pedidas.`);
} else if (running === "si") {
  out.push(`Estado: CORRIENDO (arnés pid ${harnessPid}, sesión ${status?.session ?? "?"}, desde ${when(status?.sessionStartedAt)})`);
} else if (loop === "si") {
  out.push("Estado: NO CORRE AHORA, pero el bucle de start.sh está vivo: espera a Docker o va a reintentar en un minuto.");
} else {
  out.push("Estado: PARADA");
}
const covered = status?.coveredHours ?? report?.coverage?.coveredHours ?? 0;
const target = status?.targetHours ?? report?.coverage?.targetHours ?? 168;
out.push(`Horas cubiertas: ${h(covered)} de ${h(target)} (${((100 * covered) / target).toFixed(1)} %); faltan ${hm(Math.max(0, target - covered))}`);
const lastBeat = status?.lastBeatAt ?? report?.coverage?.lastBeat ?? null;
out.push(`Último minuto registrado: ${when(lastBeat)} (${ago(lastBeat)})`);
if (running !== "si" && lastBeat && !(run && run.completedAt)) {
  out.push(`  → ahora mismo hay un hueco abierto desde ${when(lastBeat)}; contará como hueco cuando se reanude.`);
}
const gaps = status?.gaps ?? null;
if (gaps) {
  out.push(`Huecos: ${gaps.count} (en total ${hm(gaps.hours)})${gaps.count > 0 ? "; los últimos:" : ""}`);
  for (const gap of gaps.last.slice(-3)) out.push(`  ${when(gap.from)} → ${when(gap.to)} (${gap.minutes} min): ${cause(gap.cause)}`);
}
if (report) {
  const a = report.agreement;
  out.push(
    `Acuerdo con producción: ${a.percent === null ? "todavía sin filas" : `${a.percent.toFixed(2)} %`} (${a.agree} de ${a.compared} filas); desacuerdos sin explicar: ${a.explained.unexplained}  [informe de ${when(report.generatedAt)}]`,
  );
  const d = report.discovery;
  out.push(`Listados por minuto: ${d.quietMinutesWithExactlyOne} de ${d.quietMinutesJudged} minutos tranquilos con exactamente 1`);
  const c = report.credits;
  const ratio = c.quietOverModel ? ` · frente al modelo ×${c.quietOverModel.archival1.toFixed(2)} / ×${c.quietOverModel.archival10.toFixed(2)}` : "";
  out.push(`Créditos al día: ${Math.round(c.quiet.perDay.archival1)} (archivo 1), ${Math.round(c.quiet.perDay.archival10)} (archivo 10)${ratio}`);
} else {
  out.push("Acuerdo con producción: todavía sin informe (el primero sale 10 minutos después de arrancar).");
}
const overlap = status?.overlap;
out.push(`Filas de solape: ${overlap?.lastAudit ?? "—"} en la última auditoría (máximo visto ${overlap?.maxSeen ?? "—"}; debe ser 0)`);
const drills = status?.drills;
if (drills) {
  const next = drills.next ? `; el siguiente: ${drills.next.id}, cuando haya ${hm(drills.next.atCoveredHours)} cubiertas` : "";
  const now_ = drills.running ? `; AHORA: ${drills.running}` : "";
  out.push(`Simulacros: ${drills.done} de ${drills.planned} hechos (${drills.passed} bien, ${drills.failed.length} mal)${now_}${next}`);
  if (drills.failed.length > 0) out.push(`  fallaron: ${drills.failed.join(", ")}`);
  if (drills.interruptedAttempts > 0) out.push(`  interrumpidos y repetidos: ${drills.interruptedAttempts}`);
}
if ((status?.exitsOnTheirOwn ?? 0) > 0) out.push(`Procesos que se cayeron solos (y se repusieron): ${status.exitsOnTheirOwn}`);
if (report?.gate) {
  out.push(`Puerta: ${Object.entries(report.gate).map(([k, v]) => `${k} ${verdict[v.verdict] ?? v.verdict}`).join(" · ")}`);
}
out.push("");
out.push(`Reanudar: ${here}/start.sh   ·   Parar: ${here}/stop.sh   ·   Informe: ${state}/summary.txt`);
console.log(out.join("\n"));
EOF
