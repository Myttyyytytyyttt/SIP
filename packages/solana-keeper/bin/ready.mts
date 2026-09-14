#!/usr/bin/env node
// "¿Está todo listo para que el keeper de Solana liquide de verdad?" —
// respondido comprobando, no suponiendo.
//
// Movido desde packages/solana-program/scripts/ready.ts: comprueba al keeper, así
// que vive con él y habla sus nombres, SIP_SOLANA_*. Lee el ENTORNO — lo mismo
// que leerá el keeper — y no ficheros .env, y el id del programa sale del IDL
// exportado, nunca escrito a mano.
//
// NUNCA imprime un secreto: de las claves solo dice si están presentes y si
// funcionan, que es lo único que hace falta saber. A diferencia del keeper, lee
// la clave de liquidación y los secretos de Privy sin estar armado, porque
// comprobarlos es su trabajo; todo lo que lee se registra en el redactor antes de
// que salga una sola línea, y cada línea pasa por él.
//
// Uso:  pnpm --dir packages/solana-keeper ready        (o ./scripts/mainnet.sh ready)

// Primero: lo que las librerías impriman al cargar pasa también por el redactor.
import "../src/console-bridge.js";
import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import { PrivyClient } from "@privy-io/node";
import { Secret, sharedRedactor, summarizeUpstreamError } from "@sip/solana-log";
import { readProtocolConfig } from "../src/accounts.js";
import { BROADCAST_ACK, copiedConfigProblems, parsePools, parseSettleKey, privySdkOverrideProblems } from "../src/config.js";
import { OLD_NUVEM_PROGRAM_ID, SIP_PROGRAM_ID, idl } from "../src/idl.js";
import { PRIVY_API_URL } from "../src/privy-signer.js";
import { SolanaReadModel } from "../src/read-model.js";
import { poolFetch } from "../src/rpc-pool.js";

let failures = 0;
const print = (line: string): void => {
  process.stdout.write(`${sharedRedactor.scrub(line)}\n`);
};
const ok = (label: string, detail = ""): void => print(`  ✓ ${label}${detail ? `  ${detail}` : ""}`);
const note = (label: string, detail = ""): void => print(`  · ${label}${detail ? `  ${detail}` : ""}`);
const bad = (label: string, fix: string): void => {
  print(`  ✗ ${label}\n      → ${fix}`);
  failures += 1;
};
const section = (title: string): void => print(`\n\x1b[1m${title}\x1b[0m`);
const env = (name: string): string | undefined => {
  const value = process.env[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
};

section("0. configuración copiada de Nuvem y ajustes del SDK de Privy");
const copied = copiedConfigProblems(Object.keys(process.env));
if (copied.length === 0) ok("ninguna variable NUVEM_* ni PRIVY_*/ANCHOR_* sin prefijo");
for (const problem of copied) bad(problem.split(" is Nuvem's")[0] ?? "variable copiada", "el keeper se niega a arrancar con ella: renómbrala a su SIP_SOLANA_* o bórrala");
// Solo NOMBRES: con PRIVY_API_BASE_URL la app secret iría a otro host, con
// PRIVY_API_LOG se apuntarían las peticiones, con PRIVY_API_CUSTOM_HEADERS
// llevarían cabeceras que ninguna opción quita.
const sdkOverrides = privySdkOverrideProblems(Object.keys(process.env));
if (sdkOverrides.length === 0) ok("ninguna PRIVY_API_* que cambie adónde o cómo habla el SDK de Privy");
for (const problem of sdkOverrides) {
  bad(problem.split(" is the Privy SDK's")[0] ?? "ajuste del SDK de Privy", "cambia adónde o cómo van las peticiones con la app secret; el keeper se niega a arrancar con ella: bórrala");
}

section("1. cadena");
const rpcEntries = (env("SIP_SOLANA_RPC_URLS") ?? "")
  .split(",")
  .map((entry) => entry.trim())
  .filter((entry) => entry !== "");
rpcEntries.forEach((entry, index) => sharedRedactor.register(entry, `rpcUrl:${index}`));
const endpoints = rpcEntries.filter((entry) => /^https?:\/\//i.test(entry)).map((entry, index) => new Secret(entry, `rpcUrl:${index}`));
if (endpoints.length === 0) {
  bad("SIP_SOLANA_RPC_URLS", "falta o no tiene ninguna URL http(s); sin RPC no puedo comprobar nada más");
  print("");
  process.exit(1);
}
ok(`${endpoints.length} endpoint(s) en SIP_SOLANA_RPC_URLS`, "(las URLs no se imprimen: llevan la clave del proveedor)");

const programEnv = env("SIP_SOLANA_PROGRAM_ID");
if (programEnv === undefined) bad("SIP_SOLANA_PROGRAM_ID vacío", `ponlo a ${SIP_PROGRAM_ID}, el address del IDL exportado`);
else if (programEnv === OLD_NUVEM_PROGRAM_ID) bad("SIP_SOLANA_PROGRAM_ID es el programa viejo de Nuvem", `su clave de upgrade se filtró; usa ${SIP_PROGRAM_ID}`);
else if (programEnv !== SIP_PROGRAM_ID) bad("SIP_SOLANA_PROGRAM_ID no coincide con el IDL exportado", `debe ser ${SIP_PROGRAM_ID}`);
else ok("SIP_SOLANA_PROGRAM_ID == address del IDL", SIP_PROGRAM_ID);

const programId = new PublicKey(SIP_PROGRAM_ID);
const connection = new Connection(endpoints[0]!.reveal(), { commitment: "confirmed", fetch: poolFetch(endpoints) });
const refuse = async (): Promise<never> => {
  throw new Error("ready no firma nada");
};
const program = new anchor.Program(
  idl,
  new anchor.AnchorProvider(connection, { publicKey: PublicKey.default, signTransaction: refuse, signAllTransactions: refuse }, { commitment: "confirmed" }),
);

let attester: PublicKey | null = null;
let keeper: PublicKey | null = null;
try {
  const account = await connection.getAccountInfo(programId, "confirmed");
  if (account?.executable) ok("programa desplegado", programId.toBase58());
  else bad("el programa no está desplegado en este cluster", "./scripts/mainnet.sh deploy");
  const config = await readProtocolConfig(program);
  if (config === null) {
    bad("ProtocolConfig no existe", "./scripts/mainnet.sh deploy (init_config va dentro)");
  } else {
    attester = config.attester;
    keeper = config.keeper;
    ok("ProtocolConfig", `authority ${config.authority.toBase58()}`);
    note("attester", config.attester.toBase58());
    if (config.keeper.equals(PublicKey.default)) bad("la config no nombra keeper (pubkey por defecto = nadie)", "./scripts/mainnet.sh set-keeper <pubkey de la clave de liquidación>");
    else note("keeper", config.keeper.toBase58());
    if (config.paused) bad("el protocolo está en pausa", "set_protocol_paused false cuando toque");
  }
} catch (error) {
  bad(`no pude leer la cadena (${summarizeUpstreamError(error)})`, "revisa SIP_SOLANA_RPC_URLS o reintenta en un minuto");
}

section("2. clave de liquidación (attester Y keeper) — no se imprime");
const settleRaw = env("SIP_SOLANA_SETTLE_KEY");
if (settleRaw === undefined) {
  bad("SIP_SOLANA_SETTLE_KEY vacío", "el array JSON de la clave (un id.json); solo hace falta para ir en vivo");
} else {
  sharedRedactor.register(settleRaw, "settleKey");
  const settleKey = parseSettleKey(settleRaw, sharedRedactor);
  if (settleKey === null) {
    bad("SIP_SOLANA_SETTLE_KEY no es un array JSON de 64 bytes válido", "copia el contenido de un id.json; el valor no se muestra");
  } else {
    const pubkey = settleKey.publicKey;
    ok("SIP_SOLANA_SETTLE_KEY válida", pubkey.toBase58());
    if (attester !== null) {
      if (attester.equals(pubkey)) ok("es el attester que nombra la config");
      else bad(`NO es el attester de la config (${attester.toBase58()})`, "toda atestación sería rechazada con WrongAttester: set_attester o usa la clave correcta");
    }
    if (keeper !== null && !keeper.equals(PublicKey.default)) {
      if (keeper.equals(pubkey)) ok("es el keeper que nombra la config");
      else bad(`NO es el keeper de la config (${keeper.toBase58()})`, "wrap/convert/invest serían rechazados: ./scripts/mainnet.sh set-keeper <esta pubkey>");
    }
    try {
      const lamports = await connection.getBalance(pubkey, "confirmed");
      if (lamports < 20_000_000) bad(`le quedan ${lamports} lamports`, "paga las comisiones de cada wrap, convert e invest; fondéala");
      else ok("saldo para comisiones", `${lamports} lamports`);
    } catch (error) {
      bad(`no pude leer su saldo (${summarizeUpstreamError(error)})`, "reintenta");
    }
  }
}

section("3. Privy — credenciales (no se imprimen)");
const appId = env("SIP_SOLANA_PRIVY_APP_ID");
const appSecret = env("SIP_SOLANA_PRIVY_APP_SECRET");
const authorizationKey = env("SIP_SOLANA_PRIVY_AUTHORIZATION_KEY");
if (appSecret !== undefined) sharedRedactor.register(appSecret, "privyAppSecret");
if (authorizationKey !== undefined) {
  sharedRedactor.register(authorizationKey, "privyAuthorizationKey");
  sharedRedactor.register(authorizationKey.replace(/^wallet-auth:/, ""), "privyAuthorizationKey");
}
appId ? ok("SIP_SOLANA_PRIVY_APP_ID presente", appId) : bad("SIP_SOLANA_PRIVY_APP_ID vacío", "dashboard de Privy → App settings → Basics");
appSecret ? ok("SIP_SOLANA_PRIVY_APP_SECRET presente") : bad("SIP_SOLANA_PRIVY_APP_SECRET vacío", "dashboard de Privy → App settings → Basics");
authorizationKey
  ? ok("SIP_SOLANA_PRIVY_AUTHORIZATION_KEY presente")
  : bad("SIP_SOLANA_PRIVY_AUTHORIZATION_KEY vacío", "la clave privada de la key quorum (docs/runbooks/PRIVY_SOLANA.md, paso 2)");
if (appId !== undefined && appSecret !== undefined && sdkOverrides.length > 0) {
  note("no probé las credenciales de Privy", "hay una PRIVY_API_* puesta (sección 0): bórrala y repite");
} else if (appId !== undefined && appSecret !== undefined) {
  // Prueba REAL de credenciales, sin crear nada: una lectura autenticada de la
  // primera página de wallets de Solana. Un 401/403 es lo que buscamos detectar.
  // apiUrl y logLevel fijados: sin ellos el SDK los tomaría del entorno.
  try {
    const privy = new PrivyClient({ appId, appSecret, apiUrl: PRIVY_API_URL, logLevel: "warn" });
    for await (const _wallet of privy.wallets().list({ chain_type: "solana", limit: 1 })) break;
    ok("Privy acepta appId + appSecret");
  } catch (error) {
    bad(`Privy rechazó la lectura (${summarizeUpstreamError(error)})`, "revisa SIP_SOLANA_PRIVY_APP_ID y SIP_SOLANA_PRIVY_APP_SECRET");
  }
}

section("4. signer de Solana");
const signerId = env("SIP_SOLANA_PRIVY_SIGNER_ID");
signerId ? ok("SIP_SOLANA_PRIVY_SIGNER_ID", signerId) : bad("SIP_SOLANA_PRIVY_SIGNER_ID vacío", "el key quorum ID; sin él, «no concedido» aparece como un envío rechazado");

section("5. pools de inversión");
const poolProblems: string[] = [];
const pools = parsePools(env("SIP_SOLANA_POOLS"), poolProblems);
for (const problem of poolProblems) bad(problem, "el keeper se niega a arrancar con esto");
if (poolProblems.length === 0) {
  pools.size > 0 ? ok(`${pools.size} pool(s) configurados`) : bad("SIP_SOLANA_POOLS vacío", "sin pools el keeper liquida pero no invierte");
}

section("6. historia (read model)");
const databaseUrl = env("DATABASE_URL");
if (databaseUrl === undefined) {
  note("sin DATABASE_URL", "no se guarda historia y el lock de un solo keeper no se aplica");
} else {
  sharedRedactor.register(databaseUrl, "databaseUrl");
  const readModel = SolanaReadModel.create(new Secret(databaseUrl, "databaseUrl"), () => undefined);
  const result = await readModel.preflight();
  result.ok ? ok("read model", result.detail) : bad("read model", result.detail);
  await readModel.close().catch(() => undefined);
}

section("7. armado");
const flag = process.env["SIP_SOLANA_BROADCAST"];
const sentence = process.env["SIP_SOLANA_ALLOW_BROADCAST"];
if (flag === "1" && sentence === BROADCAST_ACK) note("ARMADO", "con la config verificada y el lock, liquidará e invertirá en vivo");
else if (flag === "1") bad("SIP_SOLANA_BROADCAST=1 sin la frase exacta", "el keeper se niega a arrancar así");
else note("dry run", "nada se envía; para armar: SIP_SOLANA_BROADCAST=1 y la frase exacta en SIP_SOLANA_ALLOW_BROADCAST");

print(
  failures === 0
    ? "\n\x1b[32mTODO LISTO.\x1b[0m Primero en dry run:\n  pnpm --dir packages/solana-keeper keeper\n"
    : `\n\x1b[31m${failures} cosa(s) por resolver antes de probar.\x1b[0m\n`,
);
process.exit(failures === 0 ? 0 : 1);
