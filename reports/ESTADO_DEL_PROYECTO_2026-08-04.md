# Nuvem — Estado exacto del proyecto

**Fecha del análisis:** 4 de agosto de 2026
**Método:** análisis desde cero de todo el repositorio + compilación + ejecución de todas las suites de tests + drill completo en devnet local (anvil) + preflight contra el testnet público de Robinhood + verificación on-chain del despliegue en mainnet (RPC real, chainId 4663).

---

## 1. En una frase

Nuvem es un sistema de "ahorro automático para traders" en Robinhood Chain que **ya cerró su ciclo completo una vez en mainnet con dinero real**, pero cuyo despliegue actual quedó **congelado para siempre por un error de gobernanza**, y el equipo (una sola persona) está ahora preparando el **redespliegue** de una versión nueva de los contratos que **todavía no está en mainnet**.

## 2. Qué es Nuvem (en palabras simples)

- Un usuario tiene una **caja de ahorro personal** (PersonalVault) en la blockchain.
- Sus **billeteras de trading** (una o varias) operan normalmente en plataformas como GMGN.
- Después de cada sesión de trading con ganancia, un **atestador** (un servicio del propio equipo, off-chain) mide la ganancia real y firma un certificado.
- La billetera de trading presenta ese certificado al contrato y un **porcentaje de la ganancia** (ej. 20%) se guarda automáticamente en la caja como WETH.
- El dueño de la caja puede retirar todo cuando quiera, sin comisión.

**Importante:** no es un producto descentralizado. La empresa controla el atestador, puede pausar liquidaciones, y (con un multisig + 7 días de espera) puede cambiar el código de las cajas. El propio repo lo reconoce con honestidad en su threat model.

## 3. Qué probé y qué resultó

| Prueba | Resultado |
|---|---|
| `pnpm install` + `pnpm build` (contratos + 3 paquetes TS) | ✅ Compila limpio (solo warnings de lint) |
| Tests de contratos (Foundry): unit + invariantes + e2e | ✅ **133/133 pasan** (16 suites, incluye fuzzing e invariantes) |
| Tests contracts-artifacts (reproducibilidad byte a byte) | ✅ Pasan |
| Tests aa-smoke (19) y session-engine (54) | ✅ Pasan |
| Tests keeper (248) | ⚠️ **247/248** — 1 test roto (ver H2). **Ya arreglado: 248/248** |
| `pnpm typecheck` (3 paquetes TS) | ✅ Limpio |
| Web: checks de ABI + returndata + diagnostics + typecheck + build de producción Next.js | ✅ Todo pasa |
| **Drill de trading en devnet local** (anvil: deploy → trades → settlement → verificación) | ✅ **"VERIFIED"** — el script oficial estaba roto (H1); **ya arreglado y ahora corre con `pnpm devnet:drill`** |
| Preflight del drill en **testnet público de Robinhood** (chainId 46630, RPC real) | ✅ Pasa hasta el único punto que exige fondos del faucet (comprobación diseñada así). El codehash del WETH de testnet coincide exactamente con el fijado en `.env.example` |
| Verificación **on-chain en mainnet** (chainId 4663) de todo lo que afirman los docs | ✅ **Todo confirmado** (ver sección 5) |

### Detalle del drill de devnet (dinero simulado, cadena local financiada por mí)

- Trader A: compró 4 ETH de acción sintética, el precio subió 50%, vendió → ganancia neta ~2 ETH → **20% (0.3999… WETH) liquidado al vault**.
- Trader B: igual con 2 ETH → ganancia ~1 ETH → **30% (0.2999… WETH) liquidado**.
- El vault terminó con exactamente la suma (0.699996… WETH), cero residuo nativo, y la fase de verificación pasó todas las invariantes: `status: "verified"`.
- La conciliación de PnL incluyendo gas cuadró al wei.

## 4. Estado por componente

| Componente | Qué es | Estado real |
|---|---|---|
| `packages/contracts` | Los contratos (vault, factory, executor, registros, gobernanza) | **Maduro y bien testeado**, versión nueva ("post-eliminación de la inversión") lista pero **no desplegada en mainnet** |
| `packages/contracts-artifacts` | ABIs/bytecode congelados y reproducibles | ✅ Funciona, reproducible byte a byte |
| `packages/session-engine-old` | Reconstruye el PnL de una sesión leyendo solo la cadena | ✅ Real, denso, testeado. Solo soporta EOAs (no ERC-4337) |
| `packages/keeper-old` | El servicio que atesta y liquida solo (Docker) | ✅ Código real con ingeniería de seguridad seria; **su modo "en vivo" nunca se ha usado** — solo dry-run contra mainnet. Requiere Node ≥22.5 (`node:sqlite`) |
| `packages/aa-smoke-old` | Harness EIP-7702/Alchemy + scripts del canario | ✅ Funciona; su script de settle está marcado "SUPERSEDED... NOT YET REPLACED" |
| `packages/web` | Dashboard Next.js (Privy) de solo lectura | ✅ Compila y pasa sus checks; sin tests de componentes; fuera del pipeline raíz |
| Docs (`docs/`) | Runbooks, threat model, resultados de canarios | Muy extensos y honestos, pero con **partes obsoletas** (H4) |
| CI | — | ❌ **No existe ninguna CI** (ni GitHub Actions ni nada) |

## 5. Lo que hay en mainnet hoy (verificado por mí on-chain, 2026-08-04)

Todas las claims del doc `MAINNET_SETTLEMENT_RESULTS.md` son **ciertas**:

- Los **14 contratos** listados existen y tienen código en las direcciones indicadas (factory, executor, beacon, timelock, registros, Safe, vault canario, etc.).
- La transacción de settlement `0xd342d117…cad186` existe, fue exitosa y usó **exactamente 516,254 gas** como dice el doc.
- El vault canario `0xF730…8255` tiene **exactamente 403370889498747 wei de WETH** (0.0004033… ETH = el 20% de la ganancia medida del canario), igual que `lifetimeContribution` y el agregado.
- El timelock tiene 7 días de delay (604800 s). El epoch del atestador es 1.

**Pero el estado de gobernanza confirma la "congelación":**

- `VaultFactory.owner()` = el contrato Bootstrap **sellado** (no puede hacer nada).
- `VaultFactory.pendingOwner()` = el timelock, que **nunca ejecutó `acceptOwnership`**.
- El **nonce del Safe corporativo es 0**: el multisig 3-de-5 **jamás ha ejecutado ni una sola transacción**.

**Fiabilidad de la documentación:** un pase de verificación independiente cruzó 20 claims factuales de los docs contra el código: 14 confirmadas al detalle (incluido recomputar con `cast` el selector `0xc8f2629d` y el typehash EIP-712 desde el fuente), las on-chain las confirmé yo por RPC (esta sección), y las únicas contradicciones son menores: contadores de tests desactualizados (dicen 126/46/242; son 133/54/248), dos frases obsoletas del README y una inconsistencia interna sobre la dirección del gap L1/L2. En resumen: **los docs de este repo son inusualmente fiables.**

Consecuencia: en ese despliegue no se pueden registrar cohortes nuevas ni actualizar nada, nunca. `createVault` sigue funcionando, pero el despliegue está muerto en la práctica y los docs lo declaran **SUPERSEDED**. Además, el código del repo ya cambió la forma del settlement (selector `0xf38ac34f` → `0xc8f2629d`, campos L2 nuevos en la attestación), así que **todo el stack TS actual apunta a un despliegue que aún no existe**. El plan detallado está en `docs/runbooks/REDEPLOY_PLAN.md` (coste estimado: ~15.7M gas) y los últimos 5 commits del repo son exactamente la preparación de ese redespliegue (ensayo de la ceremonia de ownership incluida — el paso que mató el despliegue anterior).

## 6. Hallazgos (de más a menos grave)

### H1 — Los dos runners de drill (`.ps1`) están rotos — ✅ **ARREGLADO**
`scripts/run-devnet-trading-drill.ps1` invoca `SettleAndInvestDevnetDrill.s.sol`, un archivo que **ya no existe** (el commit `289ec3e` lo renombró a `SettleDevnetDrill.s.sol`), y aunque se arreglara el nombre, el script de Foundry ahora exige 4 variables de entorno L2 (`DEVNET_TRADE_*_BLOCK_L2_*`) que el runner nunca define. El runner de testnet público está peor: exige variables de la época de la "inversión" que ya nada consume, lee campos del JSON de deployment que ya no se escriben (reventaría **a mitad del broadcast**, después de gastar fondos reales), e invoca otro archivo renombrado. Ninguno de los dos funcionaba en ninguna plataforma, y además se invocaban con el binario `powershell` de Windows.

**Ver H1b: al arreglarlos apareció un fallo peor, de fondo, en el runner de testnet.** El detalle de todo lo aplicado está en la sección 10.

### H1b — El runner de testnet mezclaba los relojes L1 y L2 (fallo grave, nuevo)
Este no era staleness: era el mismo error que mató la primera liquidación en mainnet, reintroducido. `New-TraderEvidence` tomaba el `blockNumber` de los recibos —que en esta cadena (Arbitrum Nitro) es la altura **L2**— y lo metía en `PUBLIC_TESTNET_DRILL_TRADE_START_BLOCK_*`, que es el rango **L1** con el que se acota la attestation. El contrato valida ese rango contra `block.number`, que es el reloj L1. **Lo medí en el testnet en vivo: L2 = 96,843,620 vs L1 = 11,414,292, unos 85 millones de bloques de diferencia.** Con `endBlock` (L2) siempre mayor que `block.number` (L1), la comprobación `endBlock > block.number` habría revertido con `InvalidTradeRange` **siempre**: ese drill nunca podría haber liquidado nada, ni una vez. Arreglado derivando los dos relojes por separado (el L1 se lee del campo `l1BlockNumber` que expone el RPC) y manteniéndolos separados por nombre de ahí en adelante.

### H2 — 1 test del keeper roto (y por qué nadie lo vio) — ✅ **ARREGLADO**
`test/ledger.test.ts` → "is 0600 on the .db, the -wal and the -shm" falla siempre en macOS/Linux: el keeper migró deliberadamente de WAL a `journal_mode=DELETE` (store de un solo archivo), así que los archivos `-wal`/`-shm` ya no existen, pero el test todavía hacía `statSync` sobre ellos. En Windows el test se salta (`it.runIf(platform !== "win32")`) y el autor desarrolla en Windows — por eso nunca lo vio fallar.

### H3 — Los 5 dueños del multisig viven en un solo archivo
`secrets.enc` (committeado al repo; el remoto de GitHub es **privado** — lo comprobé: devuelve 404 sin autenticación) es un bundle AES-256-CBC con ~16 claves privadas, **incluidas las 5 claves de los dueños del Safe 3-de-5**. El propio script lo admite: eso convierte el multisig en un 1-de-1 permanente. El cifrado depende de una sola passphrase, y el historial de git es para siempre: si el repo se hace público algún día (o se filtra un clon), el ciphertext queda brute-forceable offline. El control "aislar a los dueños del Safe en personas/dispositivos distintos" del threat model **no se cumple**.

### H4 — Documentación desincronizada del código
- El README dice que el workspace "no incluye el frontend ni el keeper" — **ambos existen** y son los dos servicios de docker-compose.
- El README y `docs/architecture/CONTRACTS.md` describen el sistema de fees/inversión ("la comisión puede ir de 0% a 100%…") — **esa vía fue eliminada**: hoy ningún código en producción lee `FeeController`; los contratos de fees están desplegados pero decorativos.
- El README del keeper defiende JSONL contra SQLite — el código ya es SQLite v2. Dice "115 tests" — son 248.
- El ejemplo de consumo de `contracts-artifacts` usa la firma vieja de `settle` (24 campos; la real tiene 26).

### H5 — Sin CI, sin LICENSE
No hay ningún workflow de CI: los 133 tests de contratos, el ratchet de tamaño de bytecode y la frescura de los ABIs committeados solo se verifican cuando alguien lo ejecuta a mano. El perfil `[profile.ci]` de foundry.toml (fuzzing más fuerte) es configuración muerta. Tampoco hay LICENSE (hoy el repo es privado, así que es menor; importaría si algún día se publica). `test:fuzz` apunta a un directorio `test/fuzz/` que no existe (0 tests, falsa seguridad).

### H6 — Fricción de entorno reproducible
- Keeper requiere Node ≥22.5 (`node:sqlite`); con el Node 20 de esta máquina fallan 5 suites enteras. El `.nvmrc` (22.14.0) lo resuelve — hay que respetarlo.
- Scripts operativos divididos entre PowerShell (drills, deploy mainnet) y bash (secrets) — ninguna plataforma puede ejecutarlo todo.
- `deploy-mainnet.ps1` hardcodea `NUVEM_CANARY_APPROVED="true"`, convirtiendo una atestación del operador en una constante.

### H7 — Huecos de cobertura señalados (los admite el propio repo, más algunos extra)
- ~~`acceptOwnership` sigue sin test~~ — **corrección: sí tiene test.** Repetí la afirmación de `REDEPLOY_PLAN.md` sin comprobarla; el propio autor la cerró en el commit `a277bae` (1-ago) con `test/unit/script/FactoryOwnershipCeremony.t.sol`, **7 tests que pasan** y cubren el handoff, el rechazo antes del plazo, que solo el Safe puede programar, y que la ceremonia no se puede repetir. Lo que queda obsoleto es el doc, no el código. (Además la ensayé en anvil real: sección 11.)
- El handler de invariantes nunca avanza el tiempo → la liberación del cap rodante de 30 días no se fuzzea.
- 9 de 13 scripts de deploy/drill sin tests; sin fork-tests contra la cadena real.
- Sin tests de reentrancy hostil ni de wallets ERC-1271 maliciosas.

### H8 — Notas de seguridad más allá del threat model (que es honesto y bueno)
- La **pausa del guardián no puede parar un upgrade malicioso ya encolado** en el timelock: durante los 7 días la única defensa del usuario es retirar sus fondos.
- Un admin de vault puede **fabricar historial de contribuciones** apuntando su vault a un executor propio (auto-daño documentado, pero contamina métricas/eventos).
- Si el atestador se compromete, deshabilitarlo es instantáneo (guardián) pero **rotarlo tarda ≥7 días** (timelock) → parón de liquidaciones de una semana como suelo.
- El cap rodante agregado es compartido: una cuenta puede agotar el cupo de 30 días de todas las demás cuentas del mismo vault.
- El atestador **no puede robar** (solo puede forzar que el ETH del propio trader vaya al vault del propio trader, con caps), pero es el único punto de verdad del PnL: cobertura contigua de sesiones no se puede exigir on-chain (puede omitir tramos perdedores).

## 7. Lo que está pendiente (según el propio repo, confirmado por mi análisis)

1. **Ejecutar el redespliegue** de `REDEPLOY_PLAN.md` (contratos nuevos con ventanas L2 en la attestación), incluida la ceremonia de ownership ensayada.
2. Registrar el nuevo executor en `session-engine/chain.ts` (`SETTLEMENT_EXECUTORS`) y actualizar defaults del keeper/web.
3. Probar el **modo broadcast del keeper** en vivo (hoy solo dry-run) y la vía de session-keys (documentada, no construida — el keeper hoy custodia la clave completa del trader).
4. Indexador/clasificador real de depósitos externos (la ventana del canario se eligió a mano).
5. Manejo de reorgs/finalidad (hoy un reorg dejaría al keeper rechazando sesiones legítimas).
6. Cap de salida por período (abandonado en `63d59bb`, listado como bloqueante en el threat model).

## 8. Recomendaciones inmediatas (baratas y de alto valor)

1. ~~Arreglar o retirar los dos runners `.ps1`~~ — ✅ hecho (sección 10).
2. ~~Arreglar el test 0600 del keeper~~ — ✅ hecho (sección 10).
3. **Añadir CI mínima** (forge test + vitest + typecheck + freshness de artifacts, con Node 22.14): una tarde de trabajo que protege todo lo anterior.
4. **Repartir de verdad las claves del Safe**: sacar las 5 claves de owners de `secrets.enc`, rotarlas y distribuirlas en personas/dispositivos distintos antes del redespliegue (mientras vivan juntas, el 3-de-5 es teatro; y el historial de git es permanente, así que si el repo se publica algún día, rotar será obligatorio igualmente).
5. **Sincronizar README/CONTRACTS.md** con la realidad post-eliminación de la inversión.
6. Añadir LICENSE si el repo se va a publicar algún día.
7. Antes del redespliegue: **test de `acceptOwnership`** + ensayo local completo de la ceremonia (el plan ya lo exige; conviene automatizarlo como test para siempre).

## 9. Veredicto simple

- **El código central es bueno**: compila, 133 tests de contratos pasan, las invariantes aguantan, el drill completo funciona de punta a punta en devnet, la app web compila con sus checks, y lo que dicen los docs de mainnet es verificablemente cierto on-chain.
- **El proyecto está a mitad de una transición**: la única instancia real en mainnet está congelada y obsoleta; la versión buena de los contratos espera redespliegue; el stack off-chain ya habla el idioma nuevo.
- **La operación es de una sola persona y depende de confianza total en el operador** (atestador + keeper con custodia de claves + los 5 dueños del multisig en un archivo). Es honesto al respecto, pero eso es lo que es hoy: un prototipo avanzado y cuidadosamente diseñado, **no un producto listo para usuarios**.

---

## 10. Cambios aplicados (4 de agosto de 2026)

Seis archivos tocados. Todo verificado ejecutándolo, no solo leyéndolo.

**`packages/keeper-old/test/ledger.test.ts` + `src/ledger.ts` (H2)**
El test ahora comprueba que el `.db` es 0600 y que el store **sigue siendo un solo archivo** (`-wal`, `-shm` y `-journal` ausentes), que es la invariante real desde que se migró a `journal_mode=DELETE`. Afirmar un modo sobre `-wal` afirmaba que existe, y su existencia es justo lo que el propio código trata como daño. En el fuente añadí `-journal` a la lista de endurecimiento: es el hermano que DELETE sí produce, y solo queda en disco cuando un crash deja un journal caliente — que contiene las mismas páginas que la base de datos. Resultado: **248/248 tests del keeper en verde** (antes 247/248).

**`packages/contracts/scripts/run-devnet-trading-drill.ps1` (H1)**
Nombre y ruta de broadcast del script renombrado; las 4 variables L2 que faltaban, derivadas con la **misma fórmula que usa `test/e2e/DevnetTradingDrill.t.sol:249-253`**, para que el ensayo en proceso y la corrida con broadcast describan las mismas ventanas; etiqueta `settlementAndFees` → `settlement`. Además `-WindowStyle Hidden` ahora solo se pasa en Windows: PowerShell 7 en macOS/Linux **rechaza** ese parámetro en vez de ignorarlo, y eso detenía el script antes de arrancar anvil. Verificado de punta a punta: `pnpm devnet:drill` → **VERIFIED**, con ventanas L2 disjuntas (23000-23400 vs 24500-24900) sobre rangos L1 solapados, que es la relación de producción que el drill existe para ejercitar.

**`packages/contracts/scripts/run-public-testnet-synthetic-drill.ps1` (H1 + H1b)**
Separación de los dos relojes (H1b, lo importante); eliminadas las 3 variables muertas que impedían arrancar y el bloque de inversión que habría reventado a mitad del broadcast; script de settlement renombrado; etiqueta corregida. El ledger canónico pasa a `v2` y **nombra los dos relojes** (`startBlockL2`/`startBlockL1`…): en v1 se llamaban `startBlock`/`endBlock`, y esa ambigüedad es exactamente la que produjo la liquidación que revertía en mainnet.

**`packages/contracts/package.json`**
`powershell` → `pwsh` en los tres scripts. `powershell` es solo Windows; `pwsh` (PowerShell 7) es multiplataforma y hace que los drills funcionen también en macOS y Linux. Mantuve la compatibilidad con Windows PowerShell 5.1 en los `.ps1` (la comprobación de versión cortocircuita antes de tocar `$IsWindows`, que en 5.1 no existe), así que si en Windows solo hay 5.1 los scripts se pueden seguir invocando a mano con `powershell`. Nota: **en Windows ahora hace falta PowerShell 7** para usar los comandos `pnpm`.

**`.env.example`**
Fuera las 3 variables que ya nada lee (`ADAPTER_RATE_WAD`, `NORMAL_FEE_BPS`, `MIN_INVESTMENT_WEI`).

### Cómo lo verifiqué

- `pnpm devnet:drill` completo sobre anvil → **VERIFIED**, contribuciones y WETH del vault cuadrando al wei.
- Runner de testnet en modo preflight contra el RPC real de Robinhood: pasa carga de entorno, chequeo de chainId, sonda de estado histórico, los tests de Foundry del drill y el preflight on-chain; se detiene **solo** en el gate de saldo del faucet (`DEPLOYER_BALANCE`), que es el único punto que necesita fondos y que no puedo dar.
- **Prueba A/B**: con el mismo `.env`, el runner original se niega a arrancar ("Required environment variable is blank"); el arreglado llega hasta el gate de fondos.
- La función nueva `Get-L1BlockNumber` probada **extraída del archivo real vía AST** contra el RPC en vivo, incluido el caso borde del padding hexadecimal de BigInteger (255 → `0ff` → `ff`).
- Ambos `.ps1` pasan el parser de PowerShell sin errores.
- Suite completa del workspace: `pnpm test` y `pnpm typecheck` → **exit 0** (133 tests de contratos + 19 + 54 + 248 del keeper).

### Lo que NO pude verificar

La ruta de **broadcast** del drill de testnet nunca llega a ejecutarse: necesita cinco cuentas financiadas desde el faucet oficial. Los arreglos de esa ruta (relojes L1/L2, campos del deployment, nombre del script) están verificados por lectura cruzada contra los scripts de Foundry que los consumen y por el preflight, pero **la primera corrida con broadcast real sigue siendo la primera**. Hazla con poco dinero y revisando el `-Broadcast` con calma.

---

## 11. Ensayo de la ceremonia de ownership (el paso que mató el despliegue anterior)

`REDEPLOY_PLAN.md` Paso 0 pide una cosa concreta: *"no toques mainnet hasta haber visto `owner()` cambiar en una cadena local"*. Hecho, sobre un anvil real y con transacciones reales.

**Aclaración primero:** el plan dice que `acceptOwnership` no tiene cobertura de tests. **Ya no es cierto** — el commit `a277bae` añadió `FactoryOwnershipCeremony.t.sol` con 7 tests que pasan. Lo que sigue obsoleto es el documento. Aun así el ensayo aporta algo que los tests no pueden: aquellos usan un harness en proceso con `vm.warp`, mientras que esto ejecuta **el script `DeployNuvem` de verdad**, con su plumbing de variables de entorno, contra un nodo, avanzando el reloj real de la cadena.

| Paso | Resultado |
|---|---|
| Desplegar con el script real de mainnet | ✅ **15,686,948 gas** — clava la estimación de 15,686,995 del plan |
| Estado tras el deploy | ✅ `owner()` = bootstrap sellado, `pendingOwner()` = timelock — **idéntico al estado congelado de mainnet** |
| El Safe programa la operación | ✅ `isOperationPending: true`, `isOperationReady: false` |
| **Ejecutar antes de los 7 días** | ✅ **RECHAZADO** — el plazo se aplica de verdad, y `owner()` no se movió |
| Avanzar el reloj +604,801s | ✅ `isOperationReady: true` |
| Ejecutar el handoff | ✅ lo envió una cuenta **ajena** al Safe (ejecución abierta, como está diseñado) |
| **`owner()`** | ✅ **bootstrap → timelock**, y `pendingOwner()` a cero |
| ¿Gobernanza viva? | ✅ registré una **segunda cohorte** por el timelock (`cohortCount = 2`) — justo lo que mainnet no podrá hacer nunca |

**Veredicto: la ceremonia funciona.** Lo que falló en el despliegue anterior no fue el código, fue que nadie ejecutó el paso. El script imprime la operación exacta que hay que programar; el fallo estuvo en la operación, no en el software.

---

## 12. Drill de testnet público con broadcast: VERIFIED

Ejecutado con broadcast real en Robinhood Chain testnet (46630), 31 transacciones (20 de setup, 8 de trading, 3 de settlement), con cinco cuentas desechables y 0.0074 ETH de faucet. Resultado: **`status: verified`**.

**Esto es la prueba definitiva del arreglo H1b.** Las ventanas medidas en cadena real:

```
traderA   L2 97,141,333-97,141,386    L1 11,420,713-11,420,715
traderB   L2 97,141,359-97,141,415    L1 11,420,715-11,420,715
separación entre relojes: 85,720,620 bloques
```

Con el código anterior, ese `endBlock` L2 de 97,141,386 se habría metido en el hueco L1 y comparado contra `block.number` ≈ 11,420,715. La comprobación `endBlock > block.number` habría revertido con `InvalidTradeRange` sin excepción posible. Con los dos relojes separados, los dos settlements entraron:

```
settle()  0xa5a6c8bf…9393   534,015 gas
settle()  0x64591baf…a84ee  482,534 gas
```

El drill además ejerció el ciclo completo hasta el final: retirada total del WETH del vault (`withdrawalWeth` = `vaultWeth`), el vault **sigue registrado** tras vaciarlo, y `treasuryWethDelta: 0` — confirmando en cadena que hoy no fluye ninguna comisión.

Nota: el propio script lo recuerda y conviene repetirlo — esto valida la topología sintética aislada, **no** la de producción. No usa Stock Tokens reales, ni el Safe, ni el timelock.

---

## 13. Simulación del despliegue de mainnet (sin broadcast)

`forge script DeployNuvem` ejecutado contra el estado **real** de la cadena 4663, sin `--broadcast`: no se envió ninguna transacción. Todas las validaciones pasan:

| Gate | Resultado |
|---|---|
| Cadena permitida (4663) | ✅ |
| `NUVEM_CANARY_APPROVED` | ✅ |
| Safe corporativo **real** `0x5364…8205` con forma 3-de-5 | ✅ threshold 3, 5 owners |
| WETH canónico **real** `0x0bd7d308…ad73` tiene código | ✅ |
| Despliegue completo simulado | ✅ **15,685,871 gas** |

Coste real al precio de gas actual de la cadena (0.0217 gwei): **~0.00034 ETH**. El deployer designado `0xB284…A3AA` tiene 0.007 ETH — **20x el coste**.

El script imprime además la operación exacta que el Safe debe programar en el timelock (target, value, delay 604800, predecessor, salt y calldata `0x79ba5097`), que es la ceremonia ya ensayada en la sección 11.

**Conclusión: el despliegue está mecánicamente listo.** Lo único que falta no es código, son tres decisiones de configuración: las direcciones de **guardián**, **treasury** y **attester**. En la simulación se usaron placeholders (`0x…dEaD`) — desplegar con esos valores produciría un despliegue permanentemente inservible, porque el attester es quien firma las liquidaciones y nadie tiene esa clave.

---

*Verificaciones dinámicas ejecutadas en esta máquina (macOS, Node 22.14.0 vía nvm, Foundry 1.5.1): build completo, 133 tests Foundry, 19+54+248 tests TS, verify completo del paquete web, drill devnet VERIFIED sobre anvil (chainId 31337), preflight read-only contra `rpc.testnet.chain.robinhood.com` (46630) y lecturas on-chain contra `rpc.mainnet.chain.robinhood.com` (4663).*
