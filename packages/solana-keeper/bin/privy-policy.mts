#!/usr/bin/env node
// "¿El signer del keeper está acotado de verdad?" — la política de Privy que lo
// acota: imprimirla, crearla, comprobarla y demostrar que rechaza lo que debe.
//
//   pnpm --dir packages/solana-keeper privy-policy --print
//   pnpm --dir packages/solana-keeper privy-policy create --admin-key-out ~/sip-keys/privy-policy-admin.key
//   pnpm --dir packages/solana-keeper privy-policy check --policy <id de la política>
//   pnpm --dir packages/solana-keeper privy-policy verify --wallet <id de la wallet en Privy> --policy <id de la política>
//
// Paso a paso, para el dueño: docs/runbooks/PRIVY_SOLANA.md.
//
// NUNCA imprime un secreto. Lee del ENTORNO solo las variables que usa cada
// comando (--print no lee ninguna, ni toca la red), registra cada secreto en el
// redactor antes de que salga una sola línea, y cada línea pasa por el logger del
// keeper: los resultados por stdout, lo demás por stderr. La clave de
// administración que genera `create` se escribe una vez, con modo 0600, fuera del
// repositorio, y no aparece en ninguna línea.
//
// Aquí solo se conecta: las decisiones viven en src/privy-policy.ts y
// src/privy-policy-cli.ts, y se prueban allí contra un Privy falso, sin red.

// Primero: lo que las librerías impriman al cargar pasa también por el redactor.
import "../src/console-bridge.js";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { generateP256KeyPair } from "@privy-io/node";
import { sharedRedactor, summarizeUpstreamError } from "@sip/solana-log";
import { createKeeperLogger } from "../src/keeper-log.js";
import { findRepositoryRoot } from "../src/privy-policy.js";
import { runPrivyPolicyCli } from "../src/privy-policy-cli.js";
import { createPrivyPolicyClient, createProbeChain } from "../src/privy-policy-client.js";

const stderr = (line: string): void => void process.stderr.write(`${line}\n`);
const stdout = (line: string): void => void process.stdout.write(`${line}\n`);

// Un fallo inesperado es una línea como otra: el manejador por defecto de Node
// escribe la pila directamente en stderr, sin redactor, y una pila puede citar un endpoint.
const crash = createKeeperLogger({ sink: stderr });
process.on("uncaughtException", (error) => {
  crash.error("uncaught exception", { detail: summarizeUpstreamError(error, { take: 5, maxChars: 1_000 }) });
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  crash.error("unhandled rejection", { detail: summarizeUpstreamError(reason, { take: 5, maxChars: 1_000 }) });
  process.exit(1);
});

const code = await runPrivyPolicyCli(process.argv.slice(2), {
  env: process.env,
  stdout,
  stderr,
  redactor: sharedRedactor,
  client: createPrivyPolicyClient,
  chain: createProbeChain,
  generateKeyPair: generateP256KeyPair,
  // El repositorio que contiene este fichero: la clave de administración nunca se escribe dentro.
  repoRoot: findRepositoryRoot(dirname(fileURLToPath(import.meta.url))),
});

// En macOS stdout hacia una tubería es asíncrono: se vacía antes de salir, o
// `create` podría perder la línea con los ids.
const drain = (stream: NodeJS.WriteStream): Promise<void> => new Promise((done) => stream.write("", () => done()));
await Promise.all([drain(process.stdout), drain(process.stderr)]);
process.exit(code);
