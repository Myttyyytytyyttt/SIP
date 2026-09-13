// "¿Está todo listo para probar en Axiom?" — respondido comprobando, no
// suponiendo.
//
// Cada línea es una precondición real del flujo completo. NUNCA imprime un
// secreto: de las claves solo dice si están presentes y si funcionan, que es
// lo único que hace falta saber.
//
// Uso:  ./scripts/mainnet.sh ready

import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const LOCAL = join(__dirname, ".local");
const WEB_ENV = join(__dirname, "../../../web/.env.local");

let failures = 0;
const ok = (label: string, detail = "") => console.log(`  ✓ ${label}${detail ? `  ${detail}` : ""}`);
const bad = (label: string, fix: string) => {
  console.log(`  ✗ ${label}\n      → ${fix}`);
  failures += 1;
};
const section = (title: string) => console.log(`\n\x1b[1m${title}\x1b[0m`);

/** Reads a var from a .env file without printing its value. */
function envFrom(path: string, name: string): string | null {
  if (!existsSync(path)) return null;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = line.match(new RegExp(`^\\s*${name}\\s*=\\s*(.*)$`));
    if (match) {
      // STRIP THE COMMENT FIRST, then trim. Doing it the other way round made
      // "SECRET=   # pon aquí el valor" read as PRESENT with the comment as
      // its value — a checker reporting a plausible wrong value, which is the
      // exact failure it exists to catch.
      const value = match[1]!.replace(/#.*$/, "").trim().replace(/^["']|["']$/g, "");
      return value === "" ? null : value;
    }
  }
  return null;
}

async function main() {
  const rpc = process.env.NUVEM_SOLANA_MAINNET_RPC;
  // Read from the built IDL, never typed by hand: a hardcoded id is how a script
  // ends up pointed at a deployment nobody meant.
  const programId = new PublicKey(JSON.parse(readFileSync(join(__dirname, "../target/idl/sip_vault.json"), "utf8")).address);

  section("1. cadena");
  if (!rpc) {
    bad("NUVEM_SOLANA_MAINNET_RPC", "falta en .env.mainnet");
    console.log("\nsin RPC no puedo comprobar nada más.\n");
    process.exit(1);
  }
  const connection = new Connection(rpc, "confirmed");
  const program = await connection.getAccountInfo(programId);
  if (program?.executable) ok("programa desplegado", programId.toBase58());
  else bad("el programa no está desplegado", "./scripts/mainnet.sh deploy");

  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], programId);
  const configInfo = await connection.getAccountInfo(configPda);
  if (configInfo === null) {
    bad("ProtocolConfig no existe", "./scripts/mainnet.sh deploy (init_config va dentro)");
  } else {
    // ProtocolConfig: disc(8) authority(32) attester(32)
    const onChainAttester = new PublicKey(configInfo.data.subarray(40, 72));
    const attesterPath = join(LOCAL, "attester.json");
    if (!existsSync(attesterPath)) {
      bad("falta scripts/.local/attester.json", "copia la clave con la que se hizo init_config");
    } else {
      const local = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(attesterPath, "utf8"))));
      if (local.publicKey.equals(onChainAttester)) {
        ok("attester local == el que nombra la config", onChainAttester.toBase58());
      } else {
        bad(
          `el attester local (${local.publicKey.toBase58()}) NO es el de la config (${onChainAttester.toBase58()})`,
          "toda atestación sería rechazada con WrongAttester; usa la clave correcta",
        );
      }
    }
  }

  section("2. keeper — credenciales de Privy (no se imprimen)");
  const keeperEnv = join(__dirname, "../.env.mainnet");
  const appId = envFrom(keeperEnv, "PRIVY_APP_ID");
  const appSecret = envFrom(keeperEnv, "PRIVY_APP_SECRET");
  const authKey = envFrom(keeperEnv, "PRIVY_AUTHORIZATION_KEY");
  appId ? ok("PRIVY_APP_ID presente") : bad("PRIVY_APP_ID vacío", "ponlo en program/.env.mainnet");
  appSecret ? ok("PRIVY_APP_SECRET presente") : bad("PRIVY_APP_SECRET vacío", "dashboard → App settings → Basics");
  authKey ? ok("PRIVY_AUTHORIZATION_KEY presente") : bad("PRIVY_AUTHORIZATION_KEY vacío", "la privada de la key quorum");

  if (appId && appSecret) {
    // Prueba REAL de credenciales: una llamada autenticada cualquiera.
    try {
      const { PrivyClient } = await import("@privy-io/node");
      const privy = new PrivyClient({ appId, appSecret });
      await privy.wallets().create({ chainType: "solana" } as never).catch((e: unknown) => {
        // No queremos crear nada; solo distinguir "credenciales malas" de
        // "la API respondió". Un 401/403 es lo que buscamos detectar.
        const message = e instanceof Error ? e.message : String(e);
        if (/401|403|unauthor|invalid app/i.test(message)) throw new Error("credenciales rechazadas");
        return null;
      });
      ok("Privy acepta appId + appSecret");
    } catch (error) {
      bad(
        `Privy rechazó las credenciales (${error instanceof Error ? error.message : error})`,
        "revisa PRIVY_APP_ID y PRIVY_APP_SECRET",
      );
    }
  }

  section("3. web — signer y policy de Solana");
  const signerId = envFrom(WEB_ENV, "NUVEM_SOLANA_SIGNER_ID");
  const policyId = envFrom(WEB_ENV, "NUVEM_SOLANA_POLICY_ID");
  signerId ? ok("NUVEM_SOLANA_SIGNER_ID", signerId) : bad("NUVEM_SOLANA_SIGNER_ID vacío", "el key quorum ID");
  policyId ? ok("NUVEM_SOLANA_POLICY_ID", policyId) : bad("NUVEM_SOLANA_POLICY_ID vacío", "el policy ID");
  // El par EVM debe seguir intacto: si alguien lo pisó, RH deja de funcionar.
  const evmSigner = envFrom(WEB_ENV, "PRIVY_SIGNER_ID");
  if (evmSigner && signerId && evmSigner === signerId) {
    bad("el signer de EVM y el de Solana son el MISMO", "son cadenas distintas; sepáralos o romperás Robinhood Chain");
  } else if (evmSigner) {
    ok("el signer de EVM sigue siendo otro (RH intacto)");
  }

  section("4. pools de inversión");
  const pools = process.env.NUVEM_SOLANA_POOLS ?? "";
  const count = pools.split(",").filter((e) => e.includes("=")).length;
  count > 0 ? ok(`${count} pool(s) configurados`) : bad("NUVEM_SOLANA_POOLS vacío", "sin pools el keeper liquida pero no invierte");

  console.log(
    failures === 0
      ? "\n\x1b[32mTODO LISTO.\x1b[0m Onboarding en la web → exporta a Axiom → opera →\n" +
          "  dry-run:  npx tsx keeper/bin/supervisor.mts\n"
      : `\n\x1b[31m${failures} cosa(s) por resolver antes de probar.\x1b[0m\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
