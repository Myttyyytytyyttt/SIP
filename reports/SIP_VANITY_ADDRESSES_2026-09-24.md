# Direcciones vanity para las trading wallets y los vaults

**Reporte y guía de implementación · jueves 24 de septiembre de 2026**
**Alcance:** ¿se pueden dar direcciones con marca (p. ej. que acaben en `…sip`) a las trading wallets y a los vaults de SaverFi con el sistema que hay hoy? Y si se puede, cómo se implementaría, paso a paso, para hacerlo en local.
**Nada de esto está implementado.** Este documento solo describe; ningún archivo de código ha cambiado.

---

## 0. Resumen

**Sí se puede, en los dos casos. Pero el esfuerzo es muy distinto.**

| | ¿Se puede con el sistema actual? | Qué hay que tocar | Riesgo | Esfuerzo estimado |
|---|---|---|---|---|
| **Trading wallets** | **Sí**, siempre que las 5 pruebas con Privy de §2.4 salgan bien. No hay que tocar ni el programa ni el keeper | Solo el web (`packages/website-oficial`) | **Alto hasta comprobar P2 y P3 (§2.4)**; después, medio. La clave privada pasa unos segundos por la página antes de entrar en Privy (§4, riesgos 3–5) | ~2–4 días + media jornada de pruebas en Privy |
| **Vaults** | **No sin actualizar el programa en mainnet** | Programa (13 sitios + 1 instrucción + 1 cuenta nuevas). `solana-core`: 18 derivaciones + ~12 cambios de IDL, cómputo, decoders, actividad y alquiler. Web: 7 derivaciones + ~10 cambios de estado, límites y presupuestos. Tests, fixtures y despliegue | Medio-alto: es un upgrade del programa que mueve dinero | ~2–3 semanas |

Las estimaciones de esfuerzo son orientativas. Las cifras de rendimiento están medidas, salvo las marcadas como *estimadas* en §1.

**Recomendación:**

1. **Hacer ya las trading wallets con un sufijo de 3 letras**, por ejemplo `…sip`. La búsqueda tarda de media unos **6 s en un portátil de 4 hilos** y unos 3 s en uno de 8. Es lo que hace pump.fun con sus mints `…pump`, que se convirtió en su marca. Allí son claves de mint desechables que genera la propia plataforma; aquí es la clave de una wallet con fondos, y por eso se busca en el navegador del usuario.
2. **Dejar los vaults para la próxima actualización del programa que ya tengas prevista**, y no hacer un despliegue solo para esto. El diseño está en §3 y es compatible hacia atrás: el vault que ya existe en mainnet (`EFXK995P…`) **no cambia de dirección**, siempre que sus bytes 88..125 sean cero, cosa que hay que comprobar (§3.7, paso 1).
3. **Usar sufijo, no prefijo.** En base58 el primer carácter está muy sesgado. Un prefijo de 3 caracteres que empiece por una letra de la `K` a la `z` (por ejemplo `Sip…`) cuesta unas **17 veces más** que `…sip`. Un prefijo de 4 como `Save…` es inviable en un navegador. Ojo también: `SIP` en mayúsculas es **imposible**, porque la `I` no existe en base58 (§1.2).

---

## 1. Lo que se ha medido

### 1.1 Velocidad de búsqueda

"Vanity" significa probar claves (o salts) al azar hasta que la dirección tenga el patrón. Solo cuenta cuántos intentos caben por segundo.

| Qué | Dónde | Intentos/s | Cómo se midió |
|---|---|---|---|
| Claves Ed25519 (trading wallet), WebCrypto | **Chromium 141 headless**, 1 Web Worker | **~11.000–12.000** | `crypto.subtle.generateKey({name:"Ed25519"})` + `exportKey("raw")` |
| Ídem | Chromium, **3 Web Workers** | **~30.000–34.000** | el worker de §2.5 Paso 3, tal cual |
| Ídem | Chromium, 4 Web Workers (4 núcleos) | ~38.000–41.000 | ídem |
| Ídem | Node 22, secuencial / 64 en paralelo | ~4.500–5.000 / ~22.000 | ídem |
| Ídem, JS puro (`@noble/curves`) | Node 22 / Chromium | ~2.400–2.800 | `ed25519.getPublicKey` |
| Hash de PDA (vault con salt), `@noble/hashes` sha256 | Node 22, 1 hilo | **~310.000–360.000** | entrada de 107 B |
| Ídem, `node:crypto` | Node 22, 1 hilo | ~260.000–400.000 | solo el hash; construir cada candidato lo baja |
| Ídem, `crypto.subtle.digest` | Chromium, 1 hilo | ~105.000–146.000 | asíncrono, más lento por llamada |

Conclusiones:

- **Una clave Ed25519 es unas 30 veces más cara que un hash de PDA.** Por candidato útil la ventaja baja a ~15×, porque la mitad de los hashes cae sobre la curva (§3.6). Aun así, el vault puede permitirse un patrón más largo que la wallet.
- **WebCrypto es la vía correcta en el navegador.** Es ~4 veces más rápido que JS puro, no necesita dependencias y cabe en tu CSP tal como está.
- **WASM no.** Pediría añadir `'wasm-unsafe-eval'` a `script-src`, y `check:csp` fallaría porque la CSP dejaría de coincidir con el golden (`scripts/check-csp.mts:142-143`). La regla "nothing anywhere may eval" (`:108`) no lo detectaría.
- Un portátil de 8 hilos, con 7 workers, rondará las 75.000 claves/s. **Estimado**, no medido: sale de ~11.000 por worker. Un móvil irá bastante más lento.

### 1.2 El sesgo de base58: por qué sufijo y no prefijo

Una dirección de Solana es un número de 256 bits escrito en base58. Cada byte inicial `0x00` se escribe como `1`. Sale con 44 caracteres el **94,5 %** de las veces y con 43 casi todo el resto. Como 2²⁵⁶ ≈ 17,4 · 58⁴³, **el primer carácter de una dirección de 44 caracteres solo puede ir de `2` a `J`**. Hay una excepción rara (~0,3 %): si el primer byte vale 0, empieza por `1`. Cálculo exacto, con la regla de los bytes cero:

| primer carácter | probabilidad exacta | si fuera uniforme |
|---|---|---|
| `5`…`H` (cada uno) | 5,904 % | 1,72 % |
| `2`, `3` / `4` | 5,804 % / 5,814 % | 1,72 % |
| `J` | 1,433 % | 1,72 % |
| `1` (primer byte = 0) | 0,39 % | 1,72 % |
| de `K` a `z` (p. ej. `S`, `s`, `z`) | **0,100 %** | 1,72 % |

Una muestra de 400.000 direcciones aleatorias da lo mismo: `S` 0,100 %, 44 caracteres 94,5 %.

**El último carácter, en cambio, sí es uniforme**, porque es el número módulo 58: medido 0,0295 % para `…ip`, frente a 0,0297 % teórico. De ahí la regla: **sufijo sí; prefijo solo si empieza por `2`–`H`.**

**Las letras `0`, `O`, `I` y `l` no existen en base58.** `sip`, `Sip` o `SiP` son válidos; `SIP` no puede aparecer nunca en una dirección, ni como prefijo ni como sufijo.

### 1.3 Cuánto tarda cada patrón

Media y percentil 95. La espera sigue una distribución geométrica: el p95 es unas 3 veces la media y el p99 unas 4,6 veces.

| patrón | intentos medios | **wallet**, 4 hilos → 3 workers (~32k/s, medido): media · p95 | wallet, 8 hilos → 7 workers (~75k/s, *estimado*) | **vault**, navegador, 4 workers (~1,3M/s, *estimado*): media · p95 | vault, servidor, 1 núcleo (~300k/s) |
|---|---|---|---|---|---|
| sufijo `sip` exacto | 195.112 | **6 s · 18 s** | 3 s | <1 s | 1 s |
| sufijo `sip` sin distinguir mayúsculas (4 variantes) | 48.778 | 2 s · 5 s | <1 s | <1 s | <1 s |
| sufijo `save` sin distinguir mayúsculas (16 variantes) | 707.281 | 22 s · 66 s | 9 s | 1 s · 3 s | 5 s |
| sufijo `Save` exacto | 11.316.496 | 5,9 min ✗ | 2,5 min ✗ | **17 s · 52 s** | 75 s |
| sufijo `saver` sin distinguir mayúsculas (32 variantes) | 20.511.149 | 10,7 min ✗ | 4,6 min ✗ | 32 s | 2,3 min |
| prefijo `Sip` | 3.361.701 | 1,8 min ✗ | 45 s | 5 s | 22 s |
| prefijo `Save` | 194.978.713 | 1,7 h ✗ | 43 min ✗ | 5 min ✗ | 22 min ✗ |

Notas:

- **"Sin distinguir mayúsculas" es más rápido, pero la marca queda irregular** (`…sIp` no existe, pero sí `…SiP` o `…siP`). Para marketing, el sufijo exacto de 3 letras es el punto dulce.
- En las dos columnas del vault cada salt cuenta doble: la mitad de los candidatos caen sobre la curva y no valen como PDA canónica (§3.6).
- La columna del servidor usa ~300k/s (solo el hash). Construir cada candidato lo baja algo.

### 1.4 La compatibilidad del vault con salt vacío

- **`@solana/web3.js`:** en 2000 de 2000 owners aleatorios, `PDA(["vault", owner, <vacío>])` es igual que `PDA(["vault", owner])`, con el mismo bump.
- **`@solana/kit`:** lo mismo.
- **Código fuente:** en `solana-pubkey 2.4.0` (el SDK contra el que compila el programa) y en la syscall de `agave-syscalls 3.0.0` (el runtime), una semilla de longitud 0 se acepta y no añade bytes al sha256.

Esto es lo que permite añadir un salt **sin mover el vault que ya existe**.

---

## 2. Trading wallets: se puede hacer ya

### 2.1 Por qué hoy no hay forma directa

Las trading wallets son **embedded wallets de Privy en modo TEE, derivadas por HD**. Las crea `useCreateWallet` (`src/hooks/use-create-and-link.ts:5`) a través de `createTradingWallet` (`src/lib/trading-wallets.ts:166`). Privy genera la clave dentro de su TEE y elige el siguiente índice HD.

- **No hay ninguna API de Privy para "crear una wallet con esta dirección".** `WalletCreateParams` no tiene campo de dirección, semilla ni prefijo (`@privy-io/node`, `src/resources/wallets/wallets.ts:4574`).
- **Tampoco sirve crear wallets hasta que salga una bonita.** No se puede ver la dirección antes de crearla, y cada intento deja una wallet real en la cuenta del usuario.
- **El "split-key" de las vanity de Bitcoin/Ethereum no sirve en Solana.** En Ethereum la clave privada es el escalar, así que se le puede sumar un ajuste. En Ed25519 la clave es una semilla de 32 bytes y el escalar es `clamp(SHA-512(semilla))`. Encontrar una semilla que dé el escalar sumado sería una preimagen de SHA-512, computacionalmente inviable. Los importadores de Solana esperan semilla o semilla‖pubkey, no un escalar expandido (no verificado para Privy ni Phantom). **Quien busca la clave, la conoce.**

### 2.2 El camino que sí funciona

1. **El navegador del propio usuario busca la clave**, en Web Workers con WebCrypto.
2. **La importa en Privy con `useImportWallet`** del entry Solana, con el signer y la política del keeper **en la misma llamada**.

Está en el SDK que ya tienes, `@privy-io/react-auth` 3.36.0:

```ts
// node_modules/@privy-io/react-auth/dist/dts/solana.d.ts:19-40
importWallet: (input: {
    privateKey: string;                       // base58
    additionalSigners?: SessionSignerInput;   // "Only supported for TEE wallets"
}) => Promise<Wallet>;
```

Así se mantiene la regla **"born seated"** de `trading-wallets.ts`: la wallet nunca existe sin el asiento del keeper, igual que hoy con `createWallet({ signers })`.

**Qué no hay que tocar:**

- **Programa:** nada. Una trading wallet es una cuenta normal que firma.
- **Keeper:** nada de código. `buildPrivySolanaIndex` (`solana-keeper/src/privy-signer.ts:251-271`) indexa por dirección y por `additional_signers`, y nunca mira `walletIndex`, `imported` ni `delegated`.
  - Si el signer está pero sin exactamente la política, `createPrivySolanaSigner` devuelve `SEAT_NOT_BOUNDED` (`privy-signer.ts:349-358`). El keeper no firma y lanza una alerta crítica (`bin/keeper.mts:1319-1329`).
  - Si falta el signer, devuelve `SIGNER_NOT_GRANTED`.
  - Queda por confirmar en real que el listado de wallets de Privy (`privy-signer.ts:256`) incluye las importadas con su `id` (Paso 10).
- **CSP:** nada. Ya permite `worker-src 'self' blob:` (`security-headers.mjs:163`).
- **Listado y export:** nada. `tradingWalletsOf` ya lista las wallets importadas (`imported: true`, al final; `trading-wallets.ts:126-144`), y el export a Axiom va por dirección (`exportTradingWallet`, `trading-wallets.ts:730`).

### 2.3 El compromiso de seguridad (léelo antes de decidir)

Hoy la clave de una trading wallet **nunca pasa por el JavaScript de la página de SaverFi**. Incluso el export a Axiom ocurre dentro del iframe de Privy. Con vanity, en cambio, la clave:

1. se genera en un Web Worker de la página de SaverFi;
2. pasa al hilo principal;
3. se manda por `postMessage` al iframe de `auth.privy.io`, con el origen fijado por el SDK (`index-B2_w5Cud.mjs:179`). A partir de ahí, lo más probable es que Privy la cifre hacia su TEE con HPKE, como hace su SDK de servidor (`@privy-io/node`: `/v1/wallets/import/init` y `/submit`). El código del iframe no es público.

Durante esos segundos, **un XSS en la página o una extensión maliciosa podría copiarla**. Mitigaciones obligatorias:

- **Generar solo con `crypto.subtle.generateKey`**, el CSPRNG del navegador. Nunca con un PRNG propio ni con contadores. El fallo de la herramienta vanity *Profanity* (una semilla de 32 bits) costó unos 160 M$ a Wintermute en septiembre de 2022.
- **Transferir el `ArrayBuffer` del worker**, sin copiarlo, y **terminar el worker en cuanto encuentre la clave**: la `CryptoKey` sigue viva en él hasta el `terminate()`.
- Construir el string base58 **justo antes** de `importWallet` y poner a cero los `Uint8Array` después. Los strings de JS no se pueden borrar, así que hay que mantenerlos el menor tiempo posible.
- No registrar, persistir ni mandar nunca la clave a ningún servidor de SaverFi.
- **Nunca buscar en el servidor.** Convertiría a SaverFi en custodio.
- Contarlo en el texto previo al botón: "la clave se crea en este navegador y se entrega directamente a Privy".

**Sobre el export:** en este SDK ninguna wallet de Solana, HD o importada, ofrece frase semilla; todas se exportan como clave privada (`EmbeddedWalletKeyExportScreen-CurfPz_S.mjs:6`). Lo que cambia con una importada es que **no queda cubierta por la semilla HD del usuario**. Para Axiom no cambia nada.

### 2.4 Lo que no se puede saber sin probarlo en Privy (hacerlo primero)

El código del iframe de Privy no está en npm. Estas cinco cosas **hay que comprobarlas con una wallet de prueba** antes de escribir la UI:

| # | Pregunta | Por qué importa | Cómo comprobarlo |
|---|---|---|---|
| P1 | ¿`privateKey` es el secreto de 64 bytes (`semilla‖pubkey`, 87–88 caracteres base58) o la semilla de 32? | Con el formato equivocado, la importación falla o crea otra dirección | Importar y comparar `wallet.address` con la dirección buscada |
| P2 | `createWallet` convierte `policyIds` en `override_policy_ids` **dentro del propio SDK** y llama a la API directamente. `importWallet` manda `additionalSigners` **sin convertir** al iframe. ¿El iframe hace la misma conversión? | Si la política quedara a nivel de wallet, **el usuario no podría exportar** (le afectaría el DENY `exportPrivateKey`). Si se perdiera, **el asiento no tendría límites** | `privy-policy verify --wallet <id> --policy <id>` (runbook `PRIVY_SOLANA.md` §6) debe dar `PASS`; además, comprobar que el usuario puede exportar |
| P3 | Una importación que no lanza ya garantiza `walletClientType: "privy"` e `imported: true`: el SDK lo exige antes de volver. ¿Trae además un `id` de servidor y `recoveryMethod: "privy-v2"`? | Grant y Re-seat dependen de `teeWalletId` (`trading-wallets.ts:224`). Sin esos dos campos, **una rotación de la llave del keeper dejaría esas wallets sin asiento** | Leer `user.linkedAccounts` tras importar y probar Re-seat |
| P4 | ¿`useWallets` (Solana) lista la wallet importada con `isPrivyWallet === true`? | La firma del link la busca así (`src/lib/signing-wallets.ts:41`) | Enlazarla a un vault de prueba |
| P5 | ¿Hace falta activar la importación en el dashboard? ¿Hay límite por usuario? | Podría fallar solo en producción | Mirar Wallets → Advanced en el dashboard e importar 2–3 wallets |

**Cómo hacer la prueba.** `importWallet` solo existe como retorno del hook `useImportWallet()`, y `@solana/kit` no está en el ámbito de la consola. Por eso hace falta **una página o componente temporal, solo de desarrollo**, montado bajo el `PrivyProvider`, con un botón que haga esto (no es el código final):

```ts
import { useImportWallet } from "@privy-io/react-auth/solana";
import { getBase58Decoder } from "@solana/kit";

const { importWallet } = useImportWallet();

async function probe() {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey)); // 48 B: 16 de cabecera + 32 de semilla
  const secret = new Uint8Array(64);
  secret.set(pkcs8.subarray(16), 0);
  secret.set(pub, 32);
  const b58 = getBase58Decoder();
  const expected = b58.decode(pub);
  const wallet = await importWallet({
    privateKey: b58.decode(secret),
    additionalSigners: [{ signerId: SIGNER_ID, policyIds: [POLICY_ID] }],
  });
  console.log({ expected, got: wallet.address, same: wallet.address === expected });
}
```

Después, en Terminal.app y con las variables como en el runbook:

```bash
pnpm --silent --dir packages/solana-keeper privy-policy verify --wallet <id de la wallet importada> --policy <policyId>
```

**El dry run del keeper no toca Privy** y no prueba nada del asiento (`bin/keeper.mts:535-539`). Lo que lo prueba es `privy-policy verify` más un ciclo **armado**: enlazar la wallet a un vault de prueba, hacer una operación con beneficio y ver en `/status` que el keeper la liquida.

### 2.5 Guía de implementación, archivo por archivo

Respeta las convenciones del repo:

- la lógica pura va en `src/lib` y recibe los métodos de Privy como argumentos;
- los hooks de Solana se importan de `@privy-io/react-auth/solana` y **nunca de la raíz**, porque el `importWallet` de la raíz es de Ethereum;
- todo el texto va en constantes `*_COPY`;
- nada de `Date.now()` ni `Math.random()` en lo que se renderiza;
- los tests son vitest en entorno `node`.

Los esbozos de los pasos 2, 3, 5 y 6 **se comprobaron**: pasan `tsc` con el tsconfig del web, y el worker encontró claves de verdad en Chromium (§Anexo A).

#### Paso 1 — Configuración: `SIP_SOLANA_VANITY_SUFFIX`

| archivo | cambio |
|---|---|
| `src/lib/config.ts:83` (`SolanaPublicConfig`) | añadir `readonly vanitySuffix: string \| null;`. Es público por naturaleza: se ve en cada dirección |
| `src/lib/config.ts:134` (`toSolanaPublicConfig`) | copiar `vanitySuffix: config.vanitySuffix` |
| `src/lib/load-config.ts:39` | `const VANITY = "SIP_SOLANA_VANITY_SUFFIX";` |
| `src/lib/load-config.ts:194` (bloque `if (needPrivyAppId)`) | leerlo y validarlo con `vanitySuffixProblem()` (Paso 2). Si es inválido: `ConfigProblem { variable, message, howToFix }`, nombrando la variable y nunca el valor. El vacío ya se convierte en `null` antes (`load-config.ts:83-84`) |
| `src/lib/load-config.ts:229` (objeto final, junto a `privySignerId: signer`) | `vanitySuffix: vanity` (`null` = apagado = el comportamiento de hoy) |
| Documentación: `.env.example` (raíz), `packages/website-oficial/.env.example` (junto a `SIP_SOLANA_PRIVY_SIGNER_ID`, :76), `docker-compose.yml`, `packages/website-oficial/README.md` y la tabla de variables de `docs/runbooks/VERCEL_WEB.md` | documentar la variable: opcional, base58, ≤ 3 caracteres, vacía = apagado |

**Decisión:** ¿un sufijo inválido debe ser un "problema de página" (la convención actual, que muestra el checklist) o simplemente apagarse? Mi recomendación: problema de página, igual que el asiento.

#### Paso 2 — Módulo puro `src/lib/vanity.ts` (nuevo)

Hace el match por **residuo módulo 58^k**. No hace falta codificar cada clave en base58: los últimos k dígitos base58 son exactamente `valor mod 58^k`. Se comprobó con 20.000 claves y k = 1..4, sin ningún fallo.

```ts
/**
 * VANITY SUFFIXES, pure and client-safe: which addresses count as a match,
 * how long the search is expected to take, and the key encoding Privy imports.
 *
 * SUFFIX, NEVER PREFIX. The last base58 digit of a 32-byte key is uniform; the
 * first is not (a 44-char address almost always starts 2…J), so a prefix like
 * "Sip" costs ~17× what the suffix "sip" does.
 */
export const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export const VANITY_VARIABLE = "SIP_SOLANA_VANITY_SUFFIX";
export const MAX_VANITY_LENGTH = 3;

export function vanitySuffixProblem(raw: string): string | null {
  if (raw.length === 0 || raw.length > MAX_VANITY_LENGTH) return `${VANITY_VARIABLE} must be 1 to ${MAX_VANITY_LENGTH} characters.`;
  if ([...raw].some((c) => !BASE58_ALPHABET.includes(c))) return `${VANITY_VARIABLE} may only use base58 characters (no 0, O, I or l).`;
  return null;
}

export interface SuffixTarget { readonly modulus: number; readonly residues: readonly number[] }

/** The residues mod 58^k whose base58 ends in `suffix`. */
export function suffixTarget(suffix: string): SuffixTarget {
  let value = 0;
  for (const c of suffix) value = value * 58 + BASE58_ALPHABET.indexOf(c);
  return { modulus: 58 ** suffix.length, residues: [value] };
}

/** Big-endian bytes mod `modulus`. Exact in doubles while modulus·256 ≤ 2^53 (k ≤ 7). */
export function residue(bytes: Uint8Array, modulus: number): number {
  let r = 0;
  for (const b of bytes) r = (r * 256 + b) % modulus;
  return r;
}

export const expectedAttempts = (t: SuffixTarget): number => t.modulus / t.residues.length;

/** Solana's 64-byte secret key from WebCrypto's PKCS#8 export (16-byte header + 32-byte seed) and the raw public key. */
export function solanaSecretKey(pkcs8: Uint8Array, publicKey: Uint8Array): Uint8Array {
  if (pkcs8.length !== 48 || publicKey.length !== 32) throw new Error("unexpected Ed25519 key encoding");
  const secret = new Uint8Array(64);
  secret.set(pkcs8.subarray(16, 48), 0);
  secret.set(publicKey, 32);
  return secret;
}
```

- **Sobre el formato PKCS#8:** 48 bytes con la semilla en 16..48 está verificado en Chromium 141 y Node 22. Safari y Firefox no se pudieron probar. Si algún motor exportara PKCS#8 v2 (con la clave pública dentro), la alternativa es sacar la semilla de `exportKey("jwk", privateKey).d` (base64url, 32 bytes); se comprobó que coincide con `pkcs8[16..48]`.
- **Sin distinguir mayúsculas:** si lo quieres más adelante, `suffixTarget` devuelve un residuo por cada variante.

#### Paso 3 — El worker `src/lib/vanity.worker.ts` (nuevo)

```ts
/// <reference lib="webworker" />
import { residue, solanaSecretKey } from "./vanity";

self.onmessage = async ({ data }: MessageEvent<{ modulus: number; residues: number[] }>) => {
  const targets = new Set(data.residues);
  let tried = 0;
  let last = performance.now();
  try {
    for (;;) {
      const batch = await Promise.all(Array.from({ length: 32 }, async () => {
        const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
        return { pair, pub: new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)) };
      }));
      tried += batch.length;
      const hit = batch.find((k) => targets.has(residue(k.pub, data.modulus)));
      if (hit) {
        const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", hit.pair.privateKey));
        const secret = solanaSecretKey(pkcs8, hit.pub);
        pkcs8.fill(0);
        // TRANSFERRED, not copied: no exported bytes stay here. The CryptoKey
        // itself lives until the hook terminate()s this worker, which it must do
        // on the first "found".
        self.postMessage({ type: "found", tried, secret: secret.buffer }, [secret.buffer]);
        return;
      }
      if (performance.now() - last > 250) {
        self.postMessage({ type: "progress", tried });
        tried = 0;
        last = performance.now();
      }
    }
  } catch {
    // A browser without Ed25519 in WebCrypto (or a key it will not export).
    self.postMessage({ type: "unsupported" });
  }
};
```

#### Paso 4 — El hook `src/hooks/use-vanity-grinder.ts` (nuevo, `"use client"`)

- **Arranque de workers.** Arranca `min(max(navigator.hardwareConcurrency - 1, 1), 8)` workers. `hardwareConcurrency` cuenta hilos lógicos, y se deja uno libre para la UI: con 4 hilos salen 3 workers, y de ahí los ~6 s de §1.3. Cada worker se crea con **exactamente**:
  ```ts
  new Worker(new URL("../lib/vanity.worker.ts", import.meta.url), { type: "module" })
  ```
  - Las opciones tienen que ser un literal: con opciones dinámicas, Turbopack da los errores TP1201–1203.
  - Los workers se crean solo dentro del handler del botón, nunca durante el render ni en SSR.
  - **Es el primer Web Worker del repo**, así que el `next build` es la prueba real.
- **`search(suffix): Promise<{ address: string; privateKey: string } | null>`.** Gana el primer `found`. Entonces termina **todos** los workers, construye `privateKey` (base58 de los 64 bytes) y `address` (base58 de los bytes 32–64) y pone los bytes a cero. `null` significa cancelado.
- **Estado expuesto:** `tried` (la suma del progreso), `expected` (`expectedAttempts`) y `cancel()`.
- **Al desmontar, `terminate()` de todos los workers.** Cerrar el modal desmonta la tarjeta (`WalletsModal.tsx:25-28`), y `closeHeldBack` (`:48-50`) no retiene el cierre durante una búsqueda.
- **La barra de progreso** debe mostrar "intentos / esperados" o "probabilidad de haberla encontrado ya" (`1 − e^(−tried/expected)`). Nunca un porcentaje que llegue al 100 %: la búsqueda es aleatoria.

#### Paso 5 — Importar con asiento: `src/lib/trading-wallets.ts`

Junto a `CreateWalletFn` (:147) y `createTradingWallet` (:166):

```ts
/**
 * Privy's importWallet from @privy-io/react-auth/solana, narrowed. additionalSigners
 * is REQUIRED here although Privy makes it optional: omitted, it imports an
 * unseated wallet, which is exactly what keeperSigners() exists to prevent.
 */
export type ImportWalletFn = (input: { privateKey: string; additionalSigners: KeeperSigner[] }) => Promise<{ address?: string } | undefined>;

export class ImportedAddressMismatch extends Error {
  override readonly name = "ImportedAddressMismatch";
}

/**
 * Import a wallet whose key this browser made, born with the keeper's seat.
 * REFUSES FIRST, like createTradingWallet. THE ADDRESS IS KNOWN BEFORE PRIVY IS
 * ASKED, so Privy's answer is checked against it rather than trusted.
 */
export async function importTradingWallet(importWallet: ImportWalletFn, config: SeatConfig, key: { address: string; privateKey: string }): Promise<string> {
  const signers = keeperSigners(config);
  if (signers === null) throw new SeatNotConfigured(seatProblem(config) ?? "The keeper's seat is not configured.");
  const imported = await importWallet({ privateKey: key.privateKey, additionalSigners: signers });
  if (typeof imported?.address === "string" && imported.address !== key.address) {
    throw new ImportedAddressMismatch(`Privy imported ${imported.address}, not the address this browser made.`);
  }
  return key.address;
}
```

Además:

- Añade `ImportedAddressMismatch` a la lista `instanceof` de `failureText` (:752).
- En `src/lib/privy-failure.ts:82`, añade la clase `/failed to import wallet/i`.
- **Si salta `ImportedAddressMismatch`, Privy sí creó una wallet**, aunque en otra dirección, y ya aparece en la lista (`tradingWalletsOf` lista las importadas). El flujo no puede decir "no se creó nada" (Paso 6).

#### Paso 6 — El flujo `src/lib/create-and-link.ts`

- **`CreateAndLinkStopKind` (:96) gana tres casos:**
  - `"cancelled"`: el usuario paró la búsqueda. No se creó nada. `message: null`, como un diálogo cerrado.
  - `"search"`: no se pudo buscar (sin Ed25519, o un worker falló). No se creó nada, con mensaje.
  - `"import_mismatch"`: Privy creó una wallet en otra dirección. **Sí** se creó algo, y el mensaje lo dice.
- **`CreateAndLinkDeps` (:143) gana un campo opcional:**
  ```ts
  readonly vanity?: {
    readonly suffix: string;
    readonly importWallet: ImportWalletFn;
    /** null = cancelled; throws = could not search */
    readonly search: () => Promise<{ address: string; privateKey: string } | null>;
  };
  ```
  **Sin `vanity`, el flujo tiene que ser byte a byte el de hoy.**
- **Orden en `createAndLinkFlow` (:184) con `vanity`:**
  1. El mismo rechazo por asiento no configurado (:186-188), **antes de buscar**.
  2. `onStep("finding_address")` y `await vanity.search()`. Si devuelve `null`, parar en `cancelled`; si lanza, parar en `search`.
  3. `onStep("creating_wallet")` e `importTradingWallet(...)`.
  4. **Nunca reintentar la importación.** Privy lanza `"Failed to import wallet"` **después** de haber importado si su relectura todavía no la lista (función `se` en `usePrivy-DxYlI9y9.mjs`), y la importación no tiene clave de idempotencia. Ante cualquier excepción: `refreshUser()` y buscar **la dirección que ya conocemos** en el registro. Si está, seguir como creada; si no, parar en `"create"` (salvo `ImportedAddressMismatch`, que va a `"import_mismatch"`).
  5. A partir de ahí, lo de siempre: `onCreated`, el gate, `signableSoon` y el link.
- **Actualiza el comentario de cabecera:** "born seated" ahora cubre también `importWallet` con `additionalSigners`.

#### Paso 7 — Hooks, pasos y textos

| archivo | cambio |
|---|---|
| `src/hooks/use-create-and-link.ts` | `import { useImportWallet } from "@privy-io/react-auth/solana"` y `useVanityGrinder()`. Si `typeof config.vanitySuffix === "string"`, pasa `vanity: { suffix, importWallet, search: () => grinder.search(suffix) }`. Mantén el `inFlight` ref: la importación no deduplica. Amplía el tipo `config`, que hoy es `SeatConfig` (:33) |
| `src/hooks/use-vault-actions.ts:63` (`WriteKind`) | añadir `"createLinkVanity"` (o un flag) |
| `src/hooks/use-vault-actions.ts:199, :366` | `CreateAndLinkRequest` gana `vanity?` y `createAndLink` lo reenvía. La búsqueda ocurre **dentro del mismo bloqueo de escritura**, lo cual solo es aceptable porque el sufijo tiene ≤ 3 caracteres |
| `src/lib/vault-flows.ts:105` (`FlowStep`) | añadir `"finding_address"` |
| `src/lib/vault-copy.ts:1266` (`PROGRESS_COPY`) | `finding_address: "Finding your address"` |
| `src/lib/vault-copy.ts:611` (`CREATE_LINK_COPY`) | textos nuevos: `aheadVanity(suffix, estimate)` ("Before Privy stores it, this browser searches for an address ending in “sip” — about 6 s here. The key is made in this browser and handed straight to Privy with SaverFi's keeper seat."), `searching(tried, expected)`, `cancel`, `searchUnsupported`, `importMismatch` y `vanityRow(suffix)` |
| `src/components/wallets/TxProgress.tsx:27, :73` | `VANITY_LINK_STEPS = ["finding_address", "creating_wallet", ...LINK_STEPS]` |
| `src/components/wallets/TradingWalletsCard.tsx:94, :119` | la frase `ahead` con la estimación; mientras busca, el contador y un botón **Cancel** (`onClick={() => cancel()}`, con llamada explícita). Sin Ed25519, desactiva el botón con una frase. **No caigas en silencio a `createWallet`**: la tarjeta promete solo lo que va a hacer |
| `src/components/wallets/TradingWalletRow.tsx:156` | una wallet `imported` que acaba en el sufijo se muestra como "Trading wallet …sip" en vez de "Imported wallet" |
| `src/lib/vault-copy.ts:83` (`shortAddress`) | **cambiar a 6 + 6 caracteres** (o dejar 4 + 4 y no contar el sufijo). Con un sufijo fijo, 3 de los 4 caracteres finales son iguales en todas las wallets, y un sufijo conocido facilita el *address poisoning*. Hay que actualizar también `src/components/wallets/WithdrawCard.test.ts:217`, que fija el formato 4…4 |

#### Paso 8 — Stubs y mocks (si no, se rompen tests y la herramienta de capturas)

| archivo | cambio |
|---|---|
| `test/stubs/privy-react-auth-solana.ts:40-54` | exportar `useImportWallet` (que lance "the Privy stub never imports a wallet"). Sin esto se rompe `next dev` con `SIP_WEB_PRIVY_STUB=1` (lo usa `tools/landing-shot`); el build de producción no se ve afectado |
| `src/components/wallets/TradingWalletsCard.test.ts:39-45` y `WalletsScreen.test.ts:76-83` | añadir `useImportWallet` al `vi.mock` y hacer `vi.mock` del hook del grinder (en Node no hay `Worker`) |
| Mocks de config: `TradingWalletsCard.test.ts:23, :47`, `WalletsScreen.test.ts:41, :85` y `LinkControl.test.ts:41` | **Cuidado: por eso el Paso 7 compara con `typeof … === "string"`.** Estos mocks solo traen `{privySignerId, privyPolicyId}`, así que `vanitySuffix` es `undefined`, y un `!== null` **encendería la vanity en todos los tests**. Si prefieres añadir el campo a los mocks: `vanitySuffix: null as string \| null` en el inicializador **y** en cada reasignación (`TradingWalletsCard.test.ts:125, :204`; `WalletsScreen.test.ts:132, :172, :376`), o el typecheck falla con TS2741 |
| `src/lib/config.test.ts:66-75` (el `toEqual` de `toSolanaPublicConfig`) | añadir `vanitySuffix: null` al objeto esperado |
| `src/components/leaderboard-account.test.ts:53` | opcional, por coherencia: el `CONFIG` de entrada lleva `as never` y no rompe |

#### Paso 9 — Tests nuevos

- **`src/lib/vanity.test.ts`:**
  - `vanitySuffixProblem` rechaza `0`, `O`, `I`, `l`, `SIP`, vacío y más de 3 caracteres; acepta `sip` y `Sfi`.
  - `expectedAttempts(suffixTarget("sip")) === 195112`.
  - `residue` coincide con el final de la codificación base58 de 10.000 claves aleatorias.
  - Con el `crypto.subtle` real de Node 22 y un sufijo de 1 carácter: encuentra un match, el secreto tiene 64 bytes y `createKeyPairFromBytes` de `@solana/kit` da la misma dirección.
- **`src/lib/trading-wallets.test.ts`**, junto a los tests de `createTradingWallet` (:98-117), un `describe("importTradingWallet")`:
  - llama a Privy una sola vez, con exactamente `{ privateKey, additionalSigners: EXACT_SIGNERS }`;
  - `it.each(UNSEATED)` rechaza antes de llamar a Privy;
  - lanza `ImportedAddressMismatch` si Privy nombra otra dirección.
- **`src/lib/create-and-link.test.ts`:**
  - asiento no configurado: `search` no se llama;
  - `search → null`: parada `cancelled`, e `importWallet` no se llama;
  - `search` lanza: parada `search`;
  - `importWallet` lanza pero la dirección aparece al releer: sigue como creada, **y `importWallet` se llamó una sola vez**;
  - mismatch: parada `import_mismatch`, con la wallet nombrada;
  - sin `vanity`: `createWallet` se llama exactamente como hoy.
- **`TradingWalletsCard.test.ts`:**
  - `vanitySuffix: null` no llama nunca a `importWallet`;
  - `vanitySuffix: "sip"` muestra la frase y el botón Cancel.
- **`test/fixtures/privy-user.ts`:** añadir una wallet TEE importada que acaba en el sufijo.

#### Paso 10 — Verificación antes de producción

1. `pnpm --dir packages/website-oficial run verify` (check:csp, check:idl, typecheck, vitest y **next build**). El build es la prueba de que Turbopack empaqueta el worker.
2. En local con la app de Privy de SIP: las comprobaciones P1–P5 de §2.4.
3. `privy-policy verify` sobre la primera wallet importada → `PASS`.
4. Un ciclo **armado** con una wallet vanity de prueba: enlace, una operación con beneficio y el cobro visible en `/status`. El dry run no sirve para esto, porque no toca Privy.
5. Una sección nueva en el runbook `docs/runbooks/PRIVY_SOLANA.md` sobre wallets importadas: cómo verificarlas y qué pasa con ellas al rotar la llave del keeper (§7 del runbook).
6. Añadir `SIP_SOLANA_VANITY_SUFFIX` en Vercel (Production) y **hacer Redeploy**: una variable nueva solo se aplica tras un redeploy (`docs/runbooks/VERCEL_WEB.md:40`).

---

## 3. Vaults: requiere actualizar el programa

### 3.1 Por qué hoy es imposible

El vault es una PDA con semillas `["vault", owner]` (`create_vault.rs:16`). Su dirección es **una función pura de la clave del dueño**: no queda ningún dato libre que variar. Y la clave del dueño es su wallet externa (Phantom, Backpack…), así que tampoco se puede buscar.

Tampoco vale un vault que sea una cuenta normal con clave buscada: el vault **firma CPIs como PDA** (`invest.rs:178`, `convert.rs:137`, `withdraw_token.rs:89`), y eso solo lo puede hacer una PDA.

**La única vía es añadir un salt a las semillas**: `["vault", owner, salt]`. Eso es un upgrade del programa.

### 3.2 El diseño

1. **`Vault` gana `salt_len: u8` y `salt: [u8; 16]`, tomados de `_reserved`.** Hoy hay 37 bytes reservados, en los offsets 88..125 (`state.rs:66`). Como 1 + 16 + 20 = 37, **la cuenta sigue midiendo 125 B** y el alquiler no cambia. Nada escribe nunca `_reserved` y `init` de Anchor pone la cuenta a cero, así que el vault de mainnet debería leer `salt_len = 0`. **Hay que comprobarlo antes** (§3.7, paso 1).
2. **Todas las semillas pasan a `[b"vault", owner, &vault.salt[..n]]`**, con `n = salt_len`. Con `salt_len = 0` el slice está vacío y la dirección es **idéntica** a la actual (§1.4). **El vault `EFXK995P…` sigue funcionando sin migración.**
3. **Salt de 16 bytes fijos** en todos los vaults nuevos, sea aleatorio o buscado. Es una simplificación: el programa y los clientes solo aceptan longitud 0 (antiguo) o 16 (nuevo), y hay una sola forma de vault nuevo. No es lo que evita colisiones: con un owner de 32 B fijos y un solo campo variable antes del bump, tampoco las habría con longitud variable.
4. **Un índice por dueño, `VaultIndex`, en `["owner_vault", owner]`.** Se usa un prefijo que no empieza por `vault`. Guarda `vault` y `salt`, y sirve para dos cosas:
   - **Uno por dueño:** su `init` falla si ya existe, el mismo truco que usa `TradingLink` con `["link", wallet]`.
   - **Resolución:** el web lee el índice y sabe cuál es el vault sin adivinar.
5. **`create_vault_v3(salt, …)`** crea el vault y el índice en la misma transacción. **Se niega si el dueño ya tiene un vault antiguo** en `["vault", owner]`, que no tiene índice.
6. **`create_vault_v2` se retira en el mismo upgrade.** Si se quedara, un dueño podría crear un vault con v3 y luego otro con v2, porque v2 no mira el índice.

### 3.3 Cambios en el programa (`packages/solana-program/programs/sip-vault/src`)

**Comprobado:** el esbozo completo de esta sección compila con anchor-lang 0.32.1 y 0 warnings, y genera el IDL. Se probó en una copia aparte del programa (§Anexo A). Incluye `state`, las 10 semillas, las 3 firmas, `create_vault_v3`, el error y `lib.rs`/`mod.rs`.

**`state.rs`:**

```rust
pub struct Vault {
    // … owner … wallet_reserve (sin cambios, offsets 8..88) …
    /// 0 for a vault created before create_vault_v3 (seeds ["vault", owner]);
    /// 16 for every vault created by it (seeds ["vault", owner, salt]).
    /// WRITTEN ONCE, in create_vault_v3. Any later write bricks the vault:
    /// every seeds constraint, withdraw included, would stop matching.
    pub salt_len: u8,
    pub salt: [u8; 16],
    /// The 37 reserved bytes minus the 17 taken above: the account stays 125 B.
    pub _reserved: [u8; 20],
}
const _: () = assert!(8 + Vault::INIT_SPACE == 125);

/// Seeds: ["owner_vault", owner]. One per owner: its `init` is what refuses a
/// second vault, exactly as ["link", wallet] refuses a second link.
#[account]
#[derive(InitSpace)]
pub struct VaultIndex {
    pub vault: Pubkey,
    pub salt: [u8; 16],
    pub bump: u8,
    pub _reserved: [u8; 15],
}   // 8 + 32 + 16 + 1 + 15 = 72 B → 1.392.000 lamports (~0,00139 SOL) de alquiler
```

**Solo `u8` y `[u8; N]`, nada de `bool` ni `Option`.** El test del keeper `test/accounts.test.ts:114` rellena `_reserved` con `0xee`, y borsh lanza "Invalid bool" con cualquier byte que no sea 0 o 1.

**Las semillas, en 10 restricciones.** Usa **el slice, no un método**. Con `vault.salt_seed()`, anchor-syn 0.32.1 escribe en el IDL una PDA **equivocada** (toma el propio vault como tercera semilla); con el slice, el IDL simplemente la omite. Ambos comportamientos están comprobados en el IDL generado.

El `.min(16)` evita un *panic* si un vault tuviera basura en `salt_len`. En ese caso fallaría la restricción de semillas en vez de abortar:

```rust
#[account(
    mut,
    seeds = [b"vault", owner.key().as_ref(), &vault.salt[..usize::from(vault.salt_len).min(16)]],
    bump = vault.bump,
    constraint = vault.owner == owner.key() @ NuvemError::NotOwner,
)]
pub vault: Account<'info, Vault>,
```

| archivo:línea | forma actual de la semilla |
|---|---|
| `set_policy.rs:12` | `owner.key()` |
| `withdraw.rs:23` | `owner.key()` |
| `withdraw_token.rs:38` | `owner.key()` |
| `link_wallet.rs:60` | `owner.key()`. No tiene `constraint` de dueño: **son las semillas las que atan el vault al firmante**. Añade `constraint = vault.owner == owner.key()` como defensa extra |
| `set_invest_policy.rs:20` | `owner.key()` |
| `unlink_wallet.rs:36` | `vault.owner` |
| `settle.rs:45` | `vault.owner` |
| `invest.rs:55` | `vault.owner` |
| `convert.rs:40` | `vault.owner` |
| `wrap_sol.rs:52` | `vault.owner` |

**Las 3 firmas del vault como PDA.** Si se olvida una, el vault con salt no puede firmar y **sus tokens quedan atrapados** hasta otro upgrade:

```rust
// invest.rs:177-178 y convert.rs:136-137
let owner_key = vault.owner;
let n = usize::from(vault.salt_len).min(16);
let seeds: &[&[u8]] = &[b"vault", owner_key.as_ref(), &vault.salt[..n], &[vault.bump]];

// withdraw_token.rs:88-89: lo mismo, leyendo de ctx.accounts.vault
```

Copiar antes el salt a una variable local es opcional (estilo): `&vault.salt[..n]` también compila, porque ese préstamo no choca con el `reload()` posterior.

`withdraw.rs:45` y `wrap_sol.rs:123` mueven lamports directamente, sin firmar, así que no cambian.

**La instrucción nueva, `instructions/create_vault_v3.rs`:**

```rust
#[derive(Accounts)]
#[instruction(salt: [u8; 16])]          // salt tiene que ser el PRIMER argumento del handler
pub struct CreateVaultV3<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(init, payer = owner, space = 8 + Vault::INIT_SPACE,
              seeds = [b"vault", owner.key().as_ref(), salt.as_ref()], bump)]
    pub vault: Account<'info, Vault>,

    #[account(init, payer = owner, space = 8 + VaultIndex::INIT_SPACE,
              seeds = [b"owner_vault", owner.key().as_ref()], bump)]
    pub vault_index: Account<'info, VaultIndex>,

    /// CHECK: the pre-v3 address. A vault made before this instruction has no
    /// index, so this is what stops its owner making a second one. Program
    /// ownership, not lamports: anyone can send lamports to an address.
    #[account(seeds = [b"vault", owner.key().as_ref()], bump,
              constraint = legacy_vault.owner != &crate::ID @ NuvemError::VaultAlreadyExists)]
    pub legacy_vault: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn create_vault_v3_handler(ctx: Context<CreateVaultV3>, salt: [u8; 16], mode: u8, skim_bps: u16,
                               volume_bps: u16, max_contribution: u64, wallet_reserve: u64) -> Result<()> {
    validate_policy(mode, skim_bps, volume_bps, max_contribution)?;
    let vault = &mut ctx.accounts.vault;
    // … los mismos campos que create_vault_handler (create_vault.rs:36-49) …
    vault.salt_len = 16;
    vault.salt = salt;
    let index = &mut ctx.accounts.vault_index;
    index.vault = vault.key();
    index.salt = salt;
    index.bump = ctx.bumps.vault_index;
    Ok(())
}
```

**Nadie puede adelantarse al dueño.** `owner` es `Signer` y su clave está en todas las semillas, así que nadie más puede crear el vault ni el índice de otro. Además, `init` de Anchor acepta PDAs que ya tengan lamports.

**Resto del programa:**

| archivo | cambio |
|---|---|
| `lib.rs:39` | añadir `create_vault_v3` y **quitar `create_vault_v2`** del `#[program]` |
| `instructions/mod.rs` | `pub mod create_vault_v3; pub use create_vault_v3::*;` |
| `errors.rs` | **añadir al final**, tras el marcador "APPENDED ONLY" (:135): `VaultAlreadyExists`, que será el 6039 (hoy hay 39 variantes, la última es `LinkConsentMismatch` = 6038). Nunca intercalar: el keeper clasifica los errores por número a través del IDL (`settle-refusal.ts:81`) |
| `events.rs` (opcional) | `VaultCreated { owner, vault, salt }`, para indexadores |
| `state.rs:15` | reescribir el comentario "Seeds: ["vault", owner]. The address is a pure function of the owner…" |

**No hay forma de cerrar un vault** (el único `close =` es el de `trading_link`, `unlink_wallet.rs:46`). Por tanto **el vault de mainnet se queda con su dirección para siempre**. Hacerlo vanity exigiría una instrucción de migración que moviera lamports, ATAs, la política y los links: queda fuera de alcance.

### 3.4 Tests y scripts del programa (`packages/solana-program`)

**Qué cambia en la resolución de cuentas del IDL** (comprobado con el IDL generado y el cliente TS de anchor 0.32.1):

- **`create_vault_v3` sí resuelve** `vault` (desde `owner` y el argumento `salt`), `vault_index` y `legacy_vault`. `createVaultV3(salt, …).accounts({ owner })` funciona.
- **`link_wallet`, `set_policy_v2`, `withdraw`, `withdraw_token` y `set_invest_policy` dejan de resolver `vault`.** En `settle`, `invest`, `convert`, `wrap_sol` y `unlink` ya había que pasarlo antes.
- **Lo que se rompe de verdad:** unas **20 llamadas** `.accounts({ owner })` a `set_policy_v2`, `withdraw` y `link_wallet` (esta vía `link-consent.ts`), que fallarán con `Account \`vault\` not provided.`. Basta con pasar `vault` en `.accounts({ owner, vault })` o `.accountsPartial({ owner, vault })`. Las de `set_invest_policy` y `withdraw_token` ya pasan `vault` en los tests.
- **Además, 13 llamadas a `createVaultV2`** hay que reescribirlas como `createVaultV3(salt, …)`, porque v2 desaparece.

**Dónde están:**

- `tests/sip-vault.ts`:
  - derivación: :41-44
  - creación: :105-132, :155, :354-356
  - `withdraw`: :203-238
  - `setPolicyV2`: :228, :238, :285, :300-308
- `tests/a-protocol-config.ts`: :136-146
- `tests/invest.ts`: :43, :154, :250-252
- `tests/settle.ts`: :40, :76-79, :206-210, :292-295, :308, :552-556, :680-683
- `tests/z-review-exits.ts`: :73, :107-113, :222-224, :361-363
- `tests/z-review-invest.ts`: :100, :197-203, :208-210
- `tests/z-review-settle-link.ts`: :100, :152-159, :165-171
- `scripts/link-consent.ts:71`: añadirle un argumento opcional `vault` para no romper el typecheck del keeper, que lo importa.
- Scripts que usan `createVaultV2` o derivan `["vault", owner]`: `drill.ts`, `dump-fixtures.ts` (sin consumidor hoy), `fork-e2e.ts`, `fork-setup.ts`, `fork-test.ts`, `jupiter-fork-setup.ts` (lo copia la imagen del keeper), `jupiter-fork-test.ts`, `mainnet-drill.ts` y `mainnet-status.ts`.

**Tests nuevos imprescindibles:**

1. `create_vault_v3` guarda el salt, el índice apunta al vault, la cuenta mide 125 B y el alquiler del índice es el esperado.
2. **Un segundo vault falla:** v3 después de v3 (por el índice) y v3 con un vault antiguo (`VaultAlreadyExists`).
3. **Todas las instrucciones sobre un vault CON salt**, empezando por `withdraw_token`, `invest` y `convert` (las tres firmas PDA). Después `settle_v2`, `wrap_sol`, `link_wallet`, `unlink_wallet`, `set_policy_v2`, `set_invest_policy` y `withdraw`.
4. **Un vault antiguo** (`salt_len = 0`, sin índice), precargado en el validador (`[[test.validator.account]]` en `Anchor.toml`), pasa todas las restricciones.
5. El salt no cambia tras `set_policy_v2`, `settle_v2` y el resto de escrituras.

### 3.5 Cambios en `solana-core` y en el web

**25 llamadas fuera de tests derivan hoy el vault desde el dueño:**

- **core (18):** `readers.ts` 182/371/951/1197, `verify-tx.ts` 211/225/290, `build-handler.ts` 587/987/1111/1383 y `builders.ts` 260/275/315/409/424/449/560.
- **web (7):** todas en `vault-flows.ts`: 330/400/622/677/722/751/804.

**El keeper no deriva nunca el vault:** lo lee de `TradingLink` (`discovery.ts:62`) y lo pasa explícito con `accountsPartial` (`settle-tick.ts:224`). **No necesita cambios de código.**

**El principio que mantiene la seguridad del web.** Una dirección `PDA(["vault", owner, salt])` **solo puede ser un vault de ese dueño**: solo él puede firmar `create_vault_v3`, que lleva su clave en las semillas. Y como hay un solo vault por dueño (índice + guarda del antiguo), un salt falso solo apunta a una dirección sin vault, que falla en cadena: denegación de servicio, nunca robo. Basta con **llevar el salt** y seguir derivando en local. Eso sí, el comentario de `vault-pda.ts:1-11` ("never taken from the server") hay que reescribirlo, porque el salt llega del servidor en `VaultAccountJson`.

**La recomendación es la pista `vaultSalt`**, que la página manda en cada petición. Sin ella, casi todas las rutas necesitan una segunda ronda de lecturas, y cambian muchos pesos que los tests fijan a las llamadas reales (ver la fila `BUILD_READS_WEIGHT` de la tabla).

| sitio | cambio |
|---|---|
| `solana-core/src/server/pda.ts:38` | `deriveVaultPda(owner, salt: Uint8Array = EMPTY)`, que acepta **solo 0 o 16 bytes**. Añadir `deriveVaultIndexPda(owner)`. Con salt vacío el resultado es idéntico al de hoy |
| `website-oficial/src/lib/vault-pda.ts:29` | lo mismo con `@solana/kit`: `deriveVaultAddress(owner, salt?)` y `deriveVaultIndexAddress(owner)` |
| `solana-core/src/client/pda.ts:9` | `VAULT_INDEX_SEED = "owner_vault"`, fijado en `test/idl.test.ts` |
| `readers.ts:182, :371, :951, :1197` | **añadir la PDA del índice al `getMultipleAccounts` que ya se hace**. Sin índice, se usa la PDA antigua sin llamada extra. Con índice, `vault = PDA(owner, index.salt)`, comprobando que coincide con `index.vault`. `readLinkPrerequisites` (:371) y `readWithdrawTokenSource` (:951) pueden resolverlo en la misma respuesta. `readOwnerAccounts` (:182) y `readLiveSnapshot` (:1197) necesitan una segunda ronda para un vault con salt (la política y las ATAs dependen de la dirección), **salvo que el cliente mande la pista** |
| `build-handler.ts:587` (setPolicy), `:987` (withdraw), `:1111` (state), `:1383` (activity de `/api/solana-live`) | derivan del dueño solo: leen el índice o reciben `vaultSalt`. **Añadir `vaultSalt` a cada `*_FIELDS`** correspondiente: todos rechazan campos desconocidos con 400 (`build-handler.ts:413-416`) |
| `build-handler.ts:213` (`BUILD_READS_WEIGHT`) y `:225` (`LIVE_READS_WEIGHT`) | Sin la pista cambian `state`, `setPolicy`, `withdraw`, `investPolicy`, `pauseInvesting` y el peso de `signatures`, y los tests los fijan a las llamadas reales (`handlers-build.test.ts:404, :753, :927, :1143, :1192, :1236`). `state` tiene que seguir dividiendo 60 (`handlers-build.test.ts:216` es una restricción paramétrica). **Hallazgo aparte:** medido con el stub de los tests, `state` hace 12 llamadas sin wallets pero 13 con ≥ 1, porque `readWalletLinks` (`readers.ts:334-344`) añade un `getMultipleAccounts`; su peso es 12 |
| `build-handler.ts:480, :510, :514, :521, :523` (`createVault`) | aceptar `salt` (16 bytes). `vault_exists` (:514) también si existe el índice. **Presupuestar el alquiler del índice**: `readBlockhashAndRents(pool, [Vault, VaultIndex])` (:521) es una llamada más, así que el peso de `createVault` pasa de 4 a 5. El cómputo (:523) pasa a `create_vault_v3` |
| `builders.ts:260` | `buildCreateVaultV3` con las cuentas `vault = PDA(owner, salt)`, `vault_index` y **`legacy_vault = PDA(owner)`** (`sipInstruction` exige todas las cuentas del IDL, `builders.ts:142-165`), y `salt` como primer argumento |
| `builders.ts:275, :315, :409, :424, :449, :560` | reciben `vaultSalt` y derivan con él. Son puras |
| `verify-tx.ts:211, :225` | es pura y no puede leer la cadena. Binding puro con la pista: `accounts.vault === deriveVaultPda(owner, vaultSalt)`. Una pista falsa solo produce un rechazo, nunca un binding a un vault ajeno |
| `verify-tx.ts:290, :301` (regla 13b) | comparar con el `accounts["vault"]` de la propia `set_invest_policy` en lugar de derivar |
| `verify-tx.ts:234` | el caso por defecto: binding puro de `create_vault_v3` (vault, índice y cuenta antigua) |
| `client/idl.ts:87` | en `OWNER_INSTRUCTIONS`, `create_vault_v3` en lugar de `create_vault_v2`. Si no, **`check:idl` rompe el prebuild del web** |
| `client/product.ts:819` | `OWNER_TX_COMPUTE.create_vault_v3`, **medido en el validador local**: dos `init` más un `find_program_address` cuestan más que los 60.000 de v2 |
| `client/decoders.ts:57, :91` | `SIP_ACCOUNT_SPACE.VaultIndex = 72`, su decoder, y `saltLen`/`salt` en `VaultState` |
| `client/activity.ts:285` | clasificar `create_vault_v3` como `vault_created`. **Mantener el discriminador de `create_vault_v2` como histórico**, o la fila de creación del vault de mainnet pasará a `unknown` |
| `client/rules.ts:59`, `app/api/solana-build/route.ts:5`, `app/api/solana-tx/route.ts:11` | docstrings que nombran `create_vault_v2` |
| `website-oficial/src/lib/vault-api.ts:104` | `VaultAccountJson` gana `salt` (hex de 16 bytes o `null`) |
| `vault-flows.ts:330, :400, :622, :677, :722, :751, :804` | cada flujo recibe `vaultSalt` del estado que la pantalla ya leyó; `createVaultFlow`, del buscador local |
| `src/hooks/use-vault-actions.ts:282-294, :464-467` | "Build again" debe reutilizar el salt, para no volver a buscar y para que no cambie la dirección que la página espera. Si el primer intento aterrizó tarde, el segundo falla igual con cualquier salt (409 `vault_exists` o el `init`) |
| `vault-limits.ts:33` | `CREATE_VAULT_FEE_LAMPORTS` con `ownerComputeBudget("create_vault_v3")` |
| Presupuestos de alquiler: `VaultCard.tsx:124`, `TradingWalletsCard.tsx:86`, `OnboardingHost.tsx:175`, `LiveNextStep.tsx:73`, `live-model.ts:773`, `readers.ts:1243` | **sumar el alquiler del índice** (~0,00139 SOL), o la página promete menos de lo que cuesta |
| Orden de despliegue de las rutas | como los `*_FIELDS` rechazan campos desconocidos, **el servidor debe desplegarse antes que la página**, o los dos a la vez. En Vercel van juntos |

**Tests y fixtures que se rompen, por causa:**

- **Por tallar `_reserved`** (`encodeStruct` es estricto con la longitud de los arrays):
  - `solana-core/test/idl.test.ts:166-198`
  - `decoders.test.ts:72`
  - `chain-fixtures.ts:58` (lo usan `handlers-build`, `handlers-live` y `readers.test`)
  - `readers.test.ts:116`
  - los tres route tests del web: `solana-build/route.test.ts:142`, `solana-vault/route.test.ts:119` y `solana-live/route.test.ts:87`
- **Porque el IDL ya no tiene PDA para el vault:** `idl.test.ts:148-160` (`found.pda!` lanzará).
- **Por añadir el índice a las lecturas:** `readers.test.ts:173, :883, :915`.
- **Por retirar `create_vault_v2`:** todos los tests que lo usan, con este número de usos: `builders.test.ts` 17, `lighthouse.test.ts` 27, `verify-tx.test.ts` 8, `handlers-build.test.ts` 5, `activity.test.ts` 2, `message.test.ts` 2 y `product.test.ts` 1. En el web: `vault-flows.test.ts` 14, `solana-tx/route.test.ts` 4 y `solana-build/route.test.ts` 1. Además, el golden `CREATE_VAULT_V2_PROFIT_DEFAULTS` de `test/fixtures/owner-transactions.ts:105, :120`, que se sustituye por uno de `create_vault_v3`.

**Lo que no se rompe, y lo demuestra:**

- Los otros 7 goldens de `OWNER_WIRE_HEX` (`owner-transactions.ts:119`): `set_policy_v2`, link, unlink, `withdraw`, `withdraw_token` ×2 y `set_invest_policy`. Con salt vacío los bytes son idénticos, y eso **demuestra la compatibilidad**.
- Los rechazos de `verify-tx.test.ts:492-508, :745, :768`, que siguen pasando con salt vacío por defecto. Hay que **añadir** casos con salt: pista correcta, y pista falsa que acaba en rechazo.
- `idl.test.ts:136`: el vault sigue midiendo 125 B. Junto a esa línea, añadir `expect(SIP_ACCOUNT_SPACE.VaultIndex).toBe(72)`.

### 3.6 Buscar el salt del vault

Para cada `salt` candidato (8 bytes aleatorios más un contador de 8):

```
h = sha256("vault" ‖ owner ‖ salt ‖ [255] ‖ programId ‖ "ProgramDerivedAddress")   // 107 bytes
si residue(h, 58^k) está en los objetivos y h está FUERA de la curva → salt válido con bump 255
```

- **El bump tiene que ser el canónico.** El `init` de Anchor usa `find_program_address`, que prueba primero 255 y va bajando. Si `h` con bump 255 cae sobre la curva (la mitad de las veces), la dirección real sería otra: la del primer bump fuera de curva por debajo de 255 (254 la mitad de las veces, a veces menos). Por eso se busca solo con 255 y se exige que quede fuera de curva (`isOffCurveAddress` de `@solana/kit` 5.5.1, síncrona). Al final se comprueba una vez con `getProgramDerivedAddress([VAULT_SEED, owner, salt])`. **Comprobado:** un buscador de prueba encontró un salt para un sufijo de 2 caracteres, y `findProgramAddressSync(["vault", owner, salt])` devolvió esa dirección con bump 255.
- **Dónde buscar.** El salt es público, así que no hay problema de custodia. Dos opciones:
  - **Navegador (recomendado):** 4 workers con `@noble/hashes`, que hay que **añadir como dependencia directa de `website-oficial`** (hoy solo llega como transitiva, 1.8.0). El `crypto.subtle.digest` de WebCrypto es asíncrono y unas 2 veces más lento. Con 4 caracteres exactos (`…Save`): unos 17 s de media y ~50 s de p95, estimado. Con un solo worker, ~70 s.
  - **Servidor:** `node:crypto`, unos 260k–400k/s por núcleo. 3 caracteres en ~1 s, pero con coste de CPU por petición, que necesitaría su propio límite.
- **Como el hash es barato, el vault puede llevar un sufijo de 4 letras** (por ejemplo `…Save`) mientras la wallet lleva 3.

### 3.7 Despliegue (en tu máquina)

Los comandos de `scripts/` y `target/` se ejecutan **desde `packages/solana-program`**.

1. **Antes de nada**, comprobar que **los bytes 88..125 del vault de mainnet son cero** (desde aquí no se pudo, el proxy bloquea el RPC de mainnet). Si no lo son, el vault quedaría inutilizable tras el upgrade. Sácalos con `solana account EFXK995PV49Qz8xPSYMEUDBU5AKRR466JkgsfuGak5iU -u mainnet-beta --output json`: el campo `data` viene en base64.
2. Compilar y probar: `anchor build` (Rust 1.89.0, Anchor 0.32.1), `anchor test` y `pnpm idl:export`. **No editar el IDL a mano**: el keeper lee de él los discriminadores de `settle_v2`, `TradingLink` y `Settled`.
3. `shasum -a 256 target/deploy/sip_vault.so` para obtener el hash nuevo. **Actualiza ya `TESTED_PROGRAM_SHA256`** en `packages/website-oficial/test-local/local-validator.ts:51` y `packages/solana-keeper/test-local/local-validator.ts:44`: los tests locales rechazan cualquier `.so` con otro hash, así que sin esto el paso 4 no arranca.
4. Pasar a `create_vault_v3` los tests locales que hoy usan `create_vault_v2`:
   - keeper: `settle-local.local.test.ts:434` y `backlog-local.local.test.ts:362`;
   - web: `vault-local.local.test.ts:287-329, :432, :746` y `live-local.local.test.ts:238`.

   Añadir un participante con vault con salt en `settle-local` y en `vault-local`. Después: `pnpm --dir packages/solana-keeper test:local`, `pnpm --dir packages/website-oficial test:local`, y los tests normales más el `preflight` del keeper. (`pnpm test` a secas no arranca ningún validador.)
5. `scripts/sip-deploy-drill.sh` contra el `.so` nuevo.
6. **Tamaño del binario.** `sip-deploy.sh upgrade` ya presupuesta que ProgramData crezca (`sip-deploy.sh:477-483`), porque cuenta con que `solana program deploy` lo amplíe solo. Ejecuta `solana program extend` a mano únicamente si tu versión del CLI no lo hace.
7. `SIP_EXPECTED_SO_SHA256=<hash> scripts/sip-deploy.sh upgrade`, firmado con la wallet de administración `EE46GmYq…`. **No usar `scripts/mainnet.sh upgrade`**: compila por su cuenta y no tiene la puerta del hash.
8. Tras el upgrade, actualizar el README:
   - el hash, en `README.md:108`;
   - los números, en `README.md:101`: 4 → 5 tipos de cuenta y 39 → 40 errores; siguen siendo 17 instrucciones;
   - la fila "Setting up" de la tabla, en `README.md:118`: `create_vault_v2` → `create_vault_v3`.

**Orden del lanzamiento.** Al quitar `create_vault_v2`, una web vieja contra el programa nuevo no puede crear vaults, y una web nueva contra el programa viejo tampoco. `check:idl` solo obliga a que el IDL y `OWNER_INSTRUCTIONS` cambien en el mismo commit; **no protege del orden de despliegue**. Y **fusionar en `main` ya es desplegar dos cosas a la vez**:

- la web, porque cada push a `main` despliega producción en Vercel (`docs/runbooks/VERCEL_WEB.md:99`);
- el keeper, porque Railway reconstruye cuando cambian `packages/solana-program/idl/**` o `scripts/**` (`packages/solana-keeper/railway.json`).

Así que:

1. Preparar la PR (programa + core + web + IDL nuevo) y **no fusionarla**.
2. Hacer el upgrade del programa.
3. Fusionar la PR justo después.

Durante esos minutos crear un vault falla **en la simulación**, antes de enviar nada, así que no se pierde dinero. Según el README (:195), el onboarding todavía no ha creado ningún vault, así que la ventana es asumible.

---

## 4. Riesgos, ordenados

| # | riesgo | gravedad | mitigación |
|---|---|---|---|
| 0 | Los bytes 88..125 del vault de mainnet no son cero → el vault queda inutilizable tras el upgrade, `withdraw` incluido | **bloqueante** | Comprobarlo con `solana account … -u mainnet-beta` antes de compilar (§3.7, paso 1). El `.min(16)` del slice evita un *panic*, no el fallo |
| 1 | Olvidar una de las 3 firmas del vault (`invest`, `convert`, `withdraw_token`) → tokens atrapados en vaults con salt | **bloqueante** | Test 3 de §3.4, **sobre un vault con salt** |
| 2 | Dejar `create_vault_v2` → dos vaults por dueño | **bloqueante** | Quitarlo en el mismo upgrade |
| 3 | La clave de la trading wallet pasa por la página | alto | §2.3: worker, transferencia, `terminate()`, borrado y aviso en el texto |
| 4 | La política del keeper no queda como override al importar (P2) → export bloqueado o asiento sin límites | alto | `privy-policy verify` sobre la primera wallet importada, **antes de encender la variable** |
| 5 | Wallets importadas sin `id`/`privy-v2` (P3) → una rotación de la llave del keeper las deja sin asiento | alto | Comprobar P3; si falla, documentar un procedimiento de rotación propio para ellas |
| 6 | Escribir el salt después de crear el vault → vault inutilizable, `withdraw` incluido | alto | Solo lo escribe `create_vault_v3`; test 5 de §3.4 |
| 7 | Reintentar `importWallet` → doble importación o wallet "perdida" | medio | Nunca reintentar; releer el registro por la dirección conocida |
| 8 | El IDL pierde la resolución automática del vault → tests y scripts rotos | medio | `accounts({ owner, vault })` en todas partes (§3.4) |
| 9 | Web y programa desfasados al quitar v2, o fusionar antes del upgrade | medio | El orden de §3.7 |
| 10 | Un sufijo fijo hace que las direcciones se parezcan más entre sí (*address poisoning*) | bajo-medio | `shortAddress` a 6 + 6, y mostrar siempre la dirección completa en el detalle |
| 11 | Navegadores sin Ed25519 en WebCrypto, o con otro formato PKCS#8 | bajo | Detectarlo y desactivar el botón con una frase; no caer a `createWallet` en silencio. `jwk.d` como alternativa |
| 12 | El alquiler del índice no se presupuesta → la página promete menos de lo que cuesta | bajo | Sumarlo en todos los presupuestos (§3.5) |

---

## 5. Decisiones que necesito de ti

1. **El sufijo.** `sip` o `Sfi` (~6 s en 4 hilos). `save` sin distinguir mayúsculas tarda 22 s y deja la marca irregular. Además exige subir `MAX_VANITY_LENGTH` a 4, que `suffixTarget` devuelva 16 residuos y revisar la búsqueda dentro del bloqueo de escritura (§2.5, Paso 7). Para el vault puede ser más largo: `Save` exacto, unos 17 s estimados.
2. **¿Vanity siempre o por elección?** "Siempre que la variable esté puesta" es lo más simple. "Por elección" (quiero dirección con marca) hace explícito el compromiso de §2.3.
3. **¿Un sufijo inválido es problema de página o se apaga en silencio?** Recomiendo problema de página.
4. **Vaults: ¿esperar a la próxima actualización del programa o hacer un upgrade dedicado?** Recomiendo esperar.
5. **Vaults: ¿un vault nuevo sin vanity lleva salt aleatorio o 16 bytes a cero?** Recomiendo salt aleatorio. En los dos casos `salt_len = 16`, nunca 0: con 0 sería la dirección antigua y chocaría con la guarda `legacy_vault`.
6. **Vaults: ¿buscar el salt en el navegador o en el servidor?** Recomiendo el navegador, con `@noble/hashes`.

---

## Anexo A — Método

- **Mapa del código.** 5 lectores en paralelo, solo lectura: programa, core/web, keeper, flujo de trading wallets y SDK de Privy. Después, un crítico de completitud comprobó en el código las afirmaciones de más peso: corrigió 9 y añadió 13.
- **Verificación adversarial del reporte.** 5 revisores independientes, uno por sección, intentaron refutar cada `archivo:línea` y cada afirmación. Encontraron 74 problemas, casi todos líneas desplazadas o matices, y todos están corregidos en esta versión. Además de leer el código, ejecutaron:
  - **el esbozo del programa (§3.3):** aplicado a una copia aparte, compila con anchor-lang 0.32.1 sin warnings. El IDL se generó con `cargo test __anchor_private_print_idl --features idl-build`, y la resolución de cuentas se probó con el cliente TS de anchor 0.32.1;
  - **los esbozos del web (§2.5 Pasos 2, 3, 5 y 6):** pasan `tsc` con el tsconfig del web. El worker, transpilado y ejecutado en Chromium 141, encontró claves con sufijos de 1–2 caracteres; su secreto de 64 bytes reconstruye la misma dirección con `@solana/kit`;
  - **el buscador de salt (§3.6):** probado en Node contra `findProgramAddressSync`.
- **Rendimiento.** Medido en este contenedor (4 núcleos), en Chromium headless (Playwright, Chromium 1194/141) con Web Workers reales, y en Node 22.22.2.
- **Base58.** Muestras de 200.000–400.000 direcciones aleatorias frente al cálculo exacto por intervalos de enteros, con la regla de Solana de los bytes cero iniciales.
- **PDA con salt vacío.** Probado con `@solana/web3.js` y `@solana/kit`, y leyendo el código de `solana-pubkey 2.4.0`, `agave-syscalls 3.0.0` y `anchor-syn 0.32.1` (descargados de crates.io; no había caché de cargo).
- **Privy.** Leído del SDK instalado (`@privy-io/react-auth` 3.36.0 y `@privy-io/node` 0.28). **docs.privy.io no se pudo leer**: el MCP de Privy no conectó. Por eso P1–P5 quedan abiertas y hay que probarlas.
- **Referencias.** Todas las `archivo:línea` corresponden al código de `main` a fecha de este reporte (commit `c346632`).

## Anexo B — Lo que no se pudo verificar desde aquí

- El contenido real de los bytes 88..125 del vault de mainnet (RPC bloqueado).
- Compilar el programa a SBF y obtener el hash de un binario nuevo (no hay `anchor` ni `solana` CLI; solo se compiló para el host).
- Las unidades de cómputo reales de `create_vault_v3`.
- El comportamiento del iframe de Privy al importar (P1–P5).
- Que Turbopack empaquete el primer Web Worker del repo (no se ejecutó `next build`).
- La velocidad de la búsqueda del salt en el navegador, y la de todo en Safari, Firefox y móviles.
- Las estimaciones de esfuerzo.
