# SIP — el backend Solana heredado de Nuvem, frente a un skim por beneficio *y* por volumen

**Fecha:** 2026-09-13 · **Versión 1 (borrador con verificación parcial; ver Anexo C)**
**Alcance:** solo Solana (programa `nuvem_vault`, keeper, `solana-core`, web `/solana`, drills). EVM excluido salvo como referencia.
**Encargo del owner:** portar el backend a Solana para SIP, mejorarlo y optimizarlo, y soportar **dos modos de skim —
por beneficio y por volumen— elegibles por el usuario**. Además, responder si Solana permite "manejar las EOA" y el
sistema entero de forma más simple.
**Método:** cinco lectores (programa, keeper, superficie web+drills, cadena, deudas), cinco diseñadores (dos modos,
volumen, observación, cobro, inversión+seguridad), y refutación adversarial de afirmaciones y recomendaciones. Todo en
solo lectura; **nada se ha modificado ni desplegado**. Los números de cadena los contrasté yo con lecturas propias
(Anexo C). **Plazo que condiciona el "cuándo":** hackathon Stocklana, entrega **viernes 18-sept 16:00 ET (21:00 Lisboa)**.

---

## 0. Resumen ejecutivo

**La hipótesis del owner es medio cierta, y la mitad que falla es la que importa.** Solana simplifica *todo lo que
rodea* al cobro: la identidad es derivación de PDA (un wallet, un vault, sin factory ni executor ni allowance), el
vínculo es una transacción con dos firmas, el ahorro vive en los lamports del PDA, y **cada transacción confirmada
trae los saldos antes/después de SOL y de tokens en su propio meta**, así que observar volumen no necesita tracer, ni
nodo de archivo, ni el método residual de EVM. Una liquidación cuesta 10.000 lamports (≈ $0,001), unas mil veces menos
que los 445k de gas del `settle` de EVM. **Pero el cobro en sí no cambia:** el SOL nativo no tiene autoridad de
delegación, y **toda primitiva que quita la firma de la wallet del cobro le quita también la clave a GMGN y Axiom**
(un PDA no tiene clave; `Assign` rompe cualquier swap externo; Squads/session keys mueven los fondos a otra dirección).
En `Settle`, la wallet es `Signer` *y* paga. **La cuestión de custodia — asiento de Privy o firmante del usuario —
sobrevive intacta al cambio de cadena.**

**El gemelo del "100×" está abierto en Solana.** `settle` calcula `atestado × skim_bps / 10.000` sin saber qué
significa la cifra; el mensaje firmado (152 bytes, dominio `NUVEM_SETTLE_V1`) no lleva modo ni bps ni nonce de
política; `Vault` no tiene campo de modo. Una atestación de *volumen* contra cualquier vault vivo (todos a 2000–3000
bps de *beneficio*) cobraría 100–150× lo previsto. Cerrarlo es un cambio de programa **pequeño y sin migración**: los 64
bytes reservados de `Vault` están a cero en los 16 vaults vivos (verificado), y ahí caben el modo, una tasa de volumen
con cotas disjuntas, el nonce de política y un tope por liquidación; el modo y la tasa se leen del `Vault` firmado por
el dueño y se reconstruyen *dentro* del mensaje que `settle_v2` verifica, de modo que una atestación en otro modo, a
otra tasa o bajo otra política falla por bytes antes de mover nada.

**Tres hechos sobre dinero real, hoy, en el despliegue viejo** (no es código de SIP, pero son tus claves):

1. **Una sola clave pegada en un chat es autoridad de upgrade, autoridad del `ProtocolConfig`, keeper y crank.**
   Quien la tenga puede sustituir el programa por cualquier cosa. Bajo él hay **22,36 SOL de un tercero** (vault
   `5xGB3psh…`, 8 liquidaciones). `ProtocolConfig` no tiene instrucción para transferir su autoridad.
2. **El atestador filtrado el 27-ago sigue siendo el atestador vivo.** Lo verifiqué decodificando el config PDA hoy:
   `attester = 9vCzvLF8…`, la misma clave cuyo secreto se pegó en un chat. `set_attester` existe en cadena desde ese
   día; el lector que recorrió las 55 firmas del PDA solo encontró `InitConfig` y `SetKeeper` — **nunca se ejecutó**.
   Cada liquidación en mainnet se verifica contra una clave expuesta.
3. **El keeper lleva días en silencio y su inversión está estructuralmente muerta para ese vault.** `wrap_sol` obliga
   al crank a adelantar el importe entero, el keeper envuelve *todo* el saldo libre, y el crank tiene 3,27 SOL frente a
   22,36: decenas de `WrapSol` fallidos (`System error 0x1`) entre el 31-ago y el 8-sept, y ninguna transacción del crank
   desde el **9-sept 12:54 UTC**. Mientras tanto la wallet del tercero **ha seguido operando a diario** — 60
   transacciones desde el 9-sept, 34 solo el 12-sept, la última hoy 13-sept a las 11:02 UTC (verificado por mí) — con
   su último `settle` real el **4-sept 22:25 UTC** (`TradingLink` nonce 8, `frontier_slot` 444358657, verificado por
   mí): **~11 días sin liquidar**, con ~17–34 txs diarias, es decir, un tramo que ya ronda las **300 firmas** del tope
   del paseo — el bloqueo de la frontera (§1.1) no es teórico, le está pasando a este usuario. Un `invest FAILED` no
   dispara alerta y `/health` siempre responde `ok:true`.

**Recomendación.** SIP se despliega **con program id nuevo y cuatro claves nuevas** (autoridad de upgrade fría,
autoridad de config, atestador, keeper/crank); nunca se reutiliza `7rtg…`. En el programa viejo, sin código: rotar la
autoridad de upgrade a una clave fría, ejecutar `set_attester`, desarmar el keeper (`set-keeper` al programa System) y
**no cerrarlo** mientras haya vaults ajenos con saldo. Para el hackathon: **el modo BENEFICIO no necesita cambio de
programa** (web + keeper + Raydium ya corrieron en mainnet de punta a punta); **el modo VOLUMEN necesita el upgrade
pequeño** de arriba (horas de programa, días de keeper). Los dos caben en cinco días si se secuencian (§5).

---

## 1. Lo que hay hoy

### 1.1 El programa (`nuvem_vault`, Anchor 0.32.1, 1.691 líneas de Rust)

Trece instrucciones, cuatro tipos de cuenta, **sin eventos**. El binario en mainnet es byte a byte el `target/deploy`
local del commit `19ec063` (sha256 `4c7195a2…`): la guarda `UnauthorizedCrank`, `set_keeper` y `set_attester` **están**
desplegadas (slot 442148458 = 2026-08-27T17:04:55Z; ProgramData extendida a mano 10.240 bytes).

| instrucción | firma | qué hace | qué rechaza |
|---|---|---|---|
| `create_vault(skim_bps)` | owner | PDA `["vault", owner]`, 125 B; `version=1`, `paused=false` | `skim_bps ∉ 1..10000`; segundo `init` |
| `link_wallet()` | **owner + wallet** | PDA `["link", wallet]`, 129 B; `epoch=slot`, nonce 0, frontier 0 | link ya existe (un wallet, un vault) |
| `unlink_wallet()` | owner *o* wallet | cierra el link, rent al owner | `UnlinkUnauthorized` |
| `set_policy(skim_bps, paused)` | owner | actualiza tasa/pausa | cotas |
| `withdraw` / `withdraw_token` | owner | saca SOL / SPL del PDA (ignora `paused`) | `NotOwner` |
| `init_config(attester)` | **primero que llegue** | PDA `["config"]`, 105 B | — |
| `set_attester` / `set_keeper` | config.authority | rota atestador / nombra crank | `set_attester(0)` → `InvalidPolicy` (mensaje equivocado, cosmético) |
| `set_invest_policy(…)` | owner | 938 B: `venue_program`, hasta 8 legs (mint, peso, floor WAD), `min_convert_rate`, `min_investment`, `max_per_call`, cubos de 31 días, `policy_nonce` | pesos ≠ 10000, floors 0 |
| `wrap_sol(amount)` | owner *o* keeper | **el crank adelanta `amount`** al ATA de wSOL del vault y el vault le reembolsa | `may_crank` |
| `convert` / `invest` | owner *o* keeper | CPI al `venue_program` con la firma del PDA; mide deltas; exige `≥ min_out ≥ floor` | ruta por encima de `max(max_per_call, 1 SOL)` |
| `settle(start, end, profit_lamports)` | **wallet (firma y paga)** | ver abajo | ver abajo |

**Cómo cobra `settle`.** Reconstruye desde el estado en cadena un mensaje fijo de **152 bytes** —
`"NUVEM_SETTLE_V1\0"`, program id, wallet, vault, `link.epoch`, `link.settlement_nonce`, `start`, `end`, `profit` —,
prueba mediante el sysvar `Instructions` que la instrucción *inmediatamente anterior* es un `Ed25519SigVerify` de
`config.attester` sobre exactamente esos bytes (con la tabla de offsets tratada como entrada hostil), y hace un
**transfer del System de wallet → vault PDA por `profit × skim_bps / 10.000`**; sube el nonce y fija
`frontier_slot = end`. Una liquidación real (tx `3Ro1fM2M…`, slot 444358698): **un firmante, dos instrucciones, 10.000
lamports de fee, 11.683 CU**; la wallet perdió 87.406.975 y el vault ganó 87.396.975 — la wallet paga la contribución
*y* la fee.

Tres propiedades que deciden el diseño de SIP:

- **Es atómico y total:** o entra la contribución completa o falla la transacción. No hay contribución parcial, ni
  `owed/collected`, ni deuda. **El "best-effort con arrastre" que aceptaste no existe en Solana.**
- **La frontera solo avanza con beneficio:** `settle` exige `profit > 0` y es el único escritor de `frontier_slot`. Una
  wallet que pierde o empata acumula un tramo sin liquidar que crece hasta superar las 300 firmas del paseo y queda
  `INCOMPLETE` para siempre.
- **El significado de la cifra no está en el mensaje.** Ni modo, ni bps, ni nonce de política (`policy_nonce` existe
  solo en `InvestmentPolicy`, para la inversión).

Además: `convert` e `invest` **no fijan el mint de la cuenta de entrada** (solo `owner == vault`): un keeper
comprometido podría enrutar el wSOL del vault por un pool basura propio, 1 SOL por llamada, sin tope rodante.

### 1.2 El keeper (2.494 líneas de TypeScript, un proceso Node)

Cada `NUVEM_SOLANA_SWEEP_MS` (60 s) hace **un barrido serial**: reclama el advisory lock de Postgres,
`getProgramAccounts(dataSize=129)` para listar links, un `wallets.list` paginado de Privy para indexar asientos,
`getBalance(crank)`, y por link: resuelve el firmante (asiento Privy o keypair local), `runSettleTick`, `runInvestTick`,
actualiza `/status`.

**Medición de beneficio** (`measure-window.ts`): pasea `getSignaturesForAddress` de nuevo a viejo hasta la frontera
(100/página, tope 300, incluye fallidas) y hace `getTransaction` por firma; `profit = (últimoPost − primerPre) −
depósitos + retiradas`, donde una tx es *flujo externo* solo si **todos** los programas que toca están en {System,
ComputeBudget, Ed25519} ∪ {nuvem} — exclusividad, no presencia (cierra el lavado "añade un `wrap_sol` de 1 lamport a un
swap real"). Cualquier tx no recuperable, truncado o `pre ≠ prevPost` → `INCOMPLETE`, no atesta.

**Liquidación**: transacción legacy `[Ed25519, settle]`, `feePayer = wallet`, firmada y difundida por Privy
`signAndSendTransaction` bajo la clave de autorización de la app (policy solo por `programId`), confirmada por altura
de bloque.

**Inversión**: lee policy, lamports, rent floor y ATAs; **rechaza cualquier cesta con un pool no registrado antes de
convertir**; envuelve, convierte y compra **cada leg en su propia transacción** (CU 600k a 10.000 µlamports = 6.000
lamports; el comentario dice "≈0,006 SOL", error de 1000×, inocuo) con `min_out = max(floor, 98 % de la tasa de un
`swap_v2` reciente real del pool)` — observada con un paseo de hasta 60 `getTransaction` a 1,2 s por leg.

**Coste**: una wallet ociosa cuesta ~6 llamadas por barrido; un tramo `NO_PROFIT` de N txs cuesta **N `getTransaction`
en cada barrido, para siempre** (sin memo). **Fragilidades**: `/health` siempre `ok:true`; el heartbeat "gone quiet"
existe y no está cableado; `invest FAILED` no alerta; un nodo con retención corta hace **medición parcial silenciosa**
(página vacía y frontera alcanzada son indistinguibles); el endpoint público es el último failover *en la ruta del
dinero*.

### 1.3 La web y los drills

`solana-core` (3.515 líneas) hace once tipos de lectura con layouts fijados (`Vault` 125 B, `TradingLink` 129 B,
`InvestmentPolicy` 938 B, `sqrt_price` de Raydium en el offset 253) y construye **siete transacciones firmadas por el
dueño** en servidor que el navegador firma con Privy: `create_vault`, `link_wallet` (dos firmas), `set_invest_policy`
con floors cotizados en vivo y recorte del 15 %, `withdraw`, `withdraw_token`, `unlink_wallet`, `set_policy`. Nunca
construye `settle/wrap/convert/invest`: son del keeper. El catálogo de 20 acciones y cestas de 8 legs (commit `ba1ef14`)
es real en cadena; pero `min_investment` es **por leg**, así que una cesta de seis necesita $50 antes de comprar nada —
por eso el vault `78tAhcf4…` lleva 7,48 USDC sin invertir desde el 27-ago.

**Demostrado en mainnet**: el drill por script (22-ago, vault `6zwdbPa6…`: 0,2 SOL "beneficio" → 0,04 liquidados →
wrap → 0,04 SOL → 3,748848 USDC en Raydium CLMM `3ucNos…` → 1.737.042 NVDAx raw en `49iMat…`, aún en cartera) y el
supervisor firmando `settle` *como la wallet del usuario* vía Privy (vault `7KFV5mrQ…`: 3 liquidaciones, 1,00 USDC →
464.278 NVDAx raw; vault `5xGB3psh…`: 8 liquidaciones, 22,76 SOL). En fork: la misma cadena con estado de pools
clonado. Dos policies vivas **conservan los floors de laboratorio del drill** (1e15 WAD por leg, 3e16 de conversión ≈
$30/SOL).

### 1.4 La cadena, hoy (2026-09-13)

| dato | valor | verificado por |
|---|---|---|
| programa / ProgramData | `7rtgXTu8…` / `G4QuwkYS…`, 478.317 B, **3,33 SOL** de rent | agente + yo |
| upgrade authority | `6NqwGGfH…` (la clave pegada) | agente + yo |
| `ProtocolConfig` (`fajZdg1x…`) | authority `6Nqw…` · attester `9vCzvLF8…` · keeper `6Nqw…` | agente + yo |
| vaults / links / policies | **16 / 13 / 12** | agente + yo |
| lamports en vaults | **22,387 SOL**, de los que **22,361 en un solo vault ajeno** (`5xGB3psh…`, owner `3HsfgE6T…`, skim 2000 bps); los otros 14 ajenos solo tienen el rent (1.760.880 lamports) | agente + yo |
| bytes `_reserved` de los 16 vaults y 13 links | **todos a cero** | agente |
| crank `6Nqw…` | 3,27 SOL; última tx **9-sept 12:54 UTC** (196 txs el 8-sept, una `Custom(1)` a las 16:57) | yo |
| wallet del tercero `BQR6GYGw…` | 11,07 SOL; 234 firmas del 30-ago al 12-sept (media 17/día, pico 34, 8,5 % fallidas, ráfagas); **60 txs desde el 9-sept, última 13-sept 11:02 UTC**; link `E5fpiDZM…` nonce 8 | agente + yo |

**xStocks.** NVDAx, TSLAx, SPYx, AAPLx y GLDx son **Token-2022 de 8 decimales con `permanentDelegate`, `pausable` y
`freeze` en manos del emisor** — el emisor puede congelar o retirar; para un producto de pensión es un hecho a contar,
no a esconder. Liquidez: Jupiter cotiza las cinco a 0,02 / 0,2 / 0,5 SOL (≈ $2 / $20 / $51) con **impacto ≤ 0,002 %**, y
la ruta directa Raydium-CLMM-solo (la única que el programa puede hacer por CPI) también llena $20 y $50 en las cinco.
Peros: el pool fijado en catálogo para SPYx y AAPLx **ya no es el mejor** (`4pCZCVEi…`, `ApniVWuZ…`), y la mejor ruta
para NVDAx y TSLAx es hoy un Orca Whirlpool que el programa no puede usar.

**Por dónde operan de verdad los usuarios.** Las tres wallets activas enrutan **todas** por un mismo programa de nivel
superior, `FLASHX8DrLbgeR8FcfNV1F5krxYcYMUdBkrP1EPBtxB9`, cuyas instrucciones internas son PumpSwap / Raydium AMM /
Raydium CPMM / pump.fun. Su identidad es desconocida para ambos repos (una única fuente no verificada lo asocia a un
router de bots). Los program ids de GMGN y Axiom en Solana **no se han identificado** — e importa poco para medir,
porque el DEX aparece siempre en las instrucciones internas.

### 1.5 Deudas, por gravedad

| # | deuda | se arregla con… |
|---|---|---|
| **crítica** | una clave filtrada = upgrade + config + keeper + crank; 22,36 SOL ajenos debajo | rotar upgrade authority (sin código); despliegue nuevo para SIP |
| **crítica** | atestador filtrado sigue vivo (`set_attester` nunca ejecutado) | `set_attester` ahora (sin código, firma `6Nqw`) |
| **crítica** | `settle` ciego al significado: el 100× | código: modo en `Vault` + mensaje V2 |
| **crítica** | `init_config` es "el primero que llegue" y `ProtocolConfig` no transfiere autoridad | código, **antes** de `init_config` en el nuevo |
| alta | sin cobro parcial ni deuda en cadena | código (arrastre) |
| alta | la frontera no avanza sin beneficio → wallets perdedoras quedan `INCOMPLETE` | código (`settle` con cero) |
| alta | `convert/invest` no fijan el mint de entrada | código (una constraint) |
| alta | inversión muerta para vaults > crank o > 1 SOL; sin alerta en `FAILED` | keeper (trocear) + programa después |
| alta | sin tope por liquidación del lado wallet: un keeper comprometido vacía la wallet en un `settle` | código (`max_contribution`) |
| alta | lavado en modo beneficio: ganancias aparcadas en wSOL/USDC/tokens nunca se cobran; depósitos de tokens externos invisibles | keeper (medición) |
| alta | dos policies con floors de laboratorio | el dueño re-firma la policy |
| media | medición parcial silenciosa; `/health` siempre ok; heartbeat sin cablear; endpoint público en ruta del dinero | keeper |

---

## 2. La pregunta del owner: ¿es más fácil en Solana?

| aspecto | EVM (Robinhood 4663) | Solana | veredicto |
|---|---|---|---|
| identidad vault ↔ wallet | factory + cohort + beacon + executor | `["vault", owner]`, `["link", wallet]` | **más simple** |
| vincular una wallet | policy en Privy + registro | una tx con dos firmas | **más simple** |
| dónde vive el ahorro | vault upgradeable | lamports del PDA | **más simple** |
| observar un fill | eventos del venue + `tx.value` + residual por bloque, con tracer y archivo | `preBalances/postBalances` y `pre/postTokenBalances` en el meta de **cada** tx | **más simple** (pero no "delta neto de fee", §3) |
| coste de cobrar | ~445k gas | 10.000 lamports ≈ $0,001 | **1000× más barato** |
| **el cobro** | la wallet firma (asiento Privy) | **la wallet firma (asiento Privy)** | **igual** |
| sin firma de la wallet | 7702 no corre en salidas | PDA sin clave / `Assign` rompe swaps / delegado SPL no toca lamports | **igual: imposible sin quitarle la clave a GMGN/Axiom** |
| custodia del activo comprado | ERC-20 | Token-2022 con `permanentDelegate` del emisor | **peor, y hay que contarlo** |

Lo que Solana sí da, y EVM no, gracias al coste: **partir el cobro en un registro pagado por el keeper y un pago pagado
por la wallet** (§4.2), una política de custodia que puede **acotar importe y destino** si el transfer es una instrucción
de nivel superior, y **fees patrocinadas** para que una wallet vacía pueda liquidar deuda.

---

## 3. Dos modos, un programa, imposibles de confundir

### 3.1 Tres guardas independientes

1. **Dos campos de tasa con cotas disjuntas.** `skim_bps` (existe; BENEFICIO; `1..10.000`) y un nuevo `volume_bps`
   (VOLUMEN; `1..100`). Un 2000 **no puede almacenarse** como tasa de volumen; el peor cruce posible es aplicar ≤ 1 % a
   un beneficio (sub-cobro), nunca el 20 % del turnover.
2. **El modo se lee del `Vault` firmado por el dueño y se reconstruye dentro del mensaje.** `settle_v2` toma `mode` como
   argumento, exige `mode == vault.skim_mode` (`SkimModeMismatch`, con nombre) y reconstruye el mensaje V2 (dominio
   `NUVEM_SETTLE_V2` → toda firma V1 muere) con `mode`, la bps *de ese modo*, `policy_nonce` y un `valid_until_slot`.
   Una atestación firmada en otro modo, a otra tasa o bajo otra política es un desajuste de bytes antes de mover nada.
   Descartado con razón: codificar el modo solo en el dominio (el atestador elegiría el modo unilateralmente).
3. **`policy_nonce` en el `Vault`.** Cada `set_policy_v2` lo sube; una atestación no puede "cabalgar" un cambio de
   política en vuelo — exactamente la ventana que el EVM pagó en `SipVolumeExecutor`.

### 3.2 Layout sin migración

`Vault._reserved: [u8; 64]` (offset 61, todo a cero en los 16 vaults) →
`skim_mode: u8` · `volume_bps: u16` · `policy_nonce: u64` · `max_contribution_lamports: u64` ·
`wallet_reserve_lamports: u64` · `_reserved: [u8; 37]`. La cuenta sigue midiendo 125 bytes: el decoder de la web,
los filtros `dataSize` del keeper y el borsh de Anchor siguen funcionando, como cuando `ProtocolConfig.keeper` se talló
de los reservados. `0 = BENEFICIO` es lo que ya contienen todos los vaults existentes. Descartado: `realloc` (rompe
decoders y filtros), reutilizar `skim_bps` con un byte de modo (el 100× reformulado), un programa por modo (duplica
todo y el producto es por vault), despachar por `version` (es un número de layout, no de política).

**Defaults y cotas** (`create_vault_v2` / `set_policy_v2`, firmadas por el dueño): BENEFICIO 20 % (0,01–100 %),
VOLUMEN **0,20 %** (0,01–1,00 %), `max_contribution` 1 SOL, `wallet_reserve` 0,01 SOL, y un límite de un cambio de
modo cada ~2 días o mientras el keeper reporte un tramo abierto.

### 3.3 Qué mide cada modo

**BENEFICIO** = la fórmula existente (`cashΔ − depósitos + retiradas`, exclusividad), con dos vectores conocidos que el
keeper debe cerrar después: ganancias aparcadas en wSOL/USDC/tokens (hoy invisibles) y depósitos de tokens externos.

**VOLUMEN** — y aquí la lectura inicial *fue refutada*, con una tx real: **el delta de lamports de la wallet no es el
notional, es una suma.** Una compra real en pump.fun: wallet −5.032.005.000 = pool +4.950.000.000 + fee-taker
+49.625.000 (1,0025 %) + fee de bot +31.920.600 + tip +375.000 + fee de tx 84.400 — exacto al lamport. Una venta real:
wallet +10.602.544.310, pool −10.741.969.000, tres tomadores de fee se quedaron 0,139 SOL. **Las compras salen brutas
de fees del venue y del bot; las ventas, netas.** Además pump.fun paga recompensas a la wallet en txs que ella *no*
firmó. La regla segura para dinero:

1. Admitir una tx solo si **la wallet es firmante** *y* **un saldo de token con `owner == wallet` cambió**; si no,
   `NOT_A_TRADE` (cubre txs de terceros, creación de ATAs, wraps, staking, transfers, fallidas). Descartada la
   exclusividad del oráculo de beneficio: contaría un depósito en Kamino o un NFT como compra.
2. **Notional de compra** = transfers del System de la wallet al pool/curva (+ fees del venue, base bruta como manda
   `DESIGN.md`), *menos* tips a Jito, *menos* depósitos de rent (crear cuenta/ATA), *menos* `meta.fee` solo si la wallet
   es `keys[0]`, *más* cualquier débito del ATA de wSOL.
3. **Notional de venta** = incremento de lamports (o crédito del ATA de wSOL) *más* fees/tips que la wallet pagó en la
   misma tx, *menos* devoluciones de rent por `closeAccount`.
4. Pasear a `finalized` desde la frontera del link y **exigir alcanzar la frontera** (con `until`, §4.1); frontera por
   slot, `fills_root` en el mensaje para idempotencia.

Lo que un atacante puede hacer: inflar con auto-wash (cuesta fees del venue, como en EVM), esconder metiendo un transfer
entrante en la tx de trade (se rechaza toda tx con transfer entrante de una clave ajena, "later"), o mover volumen a
cotización USDC (contarla como segunda pata, "later").

---

## 4. Recomendación por subsistemas

### 4.1 Observación

**Demo (horas):** seguir con polling, `SWEEP_MS` 15–20 s para las wallets de demo, **endpoint con clave** (nunca el
público en la ruta del dinero); `runInvestTick` solo tras un `SETTLED` o cada N barridos (una wallet ociosa pasa de 6
llamadas a 1); **hacer explícita la frontera con `until`** en `getSignaturesForAddress` (la firma del último `settle`
que el read-model ya guarda; para un link nunca liquidado, la firma del `link_wallet`) — si el paseo agota páginas sin
tocar `until`, es `INCOMPLETE`, no "vacío". Fundir las cinco lecturas de invest en un `getMultipleAccounts`; sustituir
el paseo de 60 txs por lectura del `PoolState` + precio por `sqrt_price` o cotización de Jupiter (solo el precio; la
ruta sigue siendo la lista de cuentas de Raydium).

**Después:** memo por firma en el ledger (re-pasear cuesta cero RPC y el memo *es* la tabla de fills de Solana); **un
webhook raw de Helius** (hasta 100.000 direcciones, cabecera de auth) como disparador y el poll acotado por `until`
como reconciliador; LaserStream gRPC solo a partir de ~10k wallets. Descartados: WebSocket como fuente de verdad (sin
cursor ni replay: cada redeploy pierde el hueco), webhooks "enhanced" (no entregan fallidas, que el oráculo debe
pasear), escanear bloques (≈ 6,5M créditos/mes antes de tener una wallet).

**Estructura:** **un `@sip/worker`, dos adaptadores de cadena, dos procesos, una base de datos.** El keeper de Solana
ya reimplementó a mano el núcleo del worker de EVM (advisory lock, skip-while-running, heartbeat, redactor, failover) y
derivó (heartbeat sin cablear). `ChainAdapter { discoverWallets; observe(wallet, cursor) → {fills, exclusions, refusals,
cursor, incomplete}; attest; pull; invest }`, y el generador de DDL parametrizado por cadena (regex base58 para
pubkeys y firmas, `NUMERIC(78,0)` para lamports) emitiendo el esquema EVM byte-idéntico y un esquema hermano para
Solana. Descartado un solo proceso para ambas cadenas: un turno de invest en Solana puede pausar ~10 minutos y pararía
los cobros de EVM.

### 4.2 Cobro

**Demo (horas):** **mantener el asiento de Privy**; wallets de demo generadas por Privy (o importadas en servidor con
`policy_ids` + `additional_signers` en una llamada) bajo una clave de autorización **nueva** y una policy que lista solo
el program id nuevo. **Cadencia por umbral, no por fill ni por barrido:** cerrar ventana cuando lo debido ≥ 1.000.000
lamports (100× el coste del cobro) o cuando la ventana tenga ≥ 1 h y ≥ 100.000; backoff exponencial tras un `FAILED` en
vez de reintentar cada 60 s. Corregir dos afirmaciones caducas sobre Privy en el repo (las policies de Solana *sí*
gatean `signTransaction` y *sí* ven instrucciones del System/Token) antes de que guíen un diseño.

**Después (días):** **partir el cobro** — `record_owed(atestación)`: firma `config.keeper`, paga el crank, verifica el
Ed25519 previo, escribe `owed += atestado × bps / 10.000` en `TradingLink._reserved` (offset 97: `owed: u64`,
`collected: u64`), sube el nonce y **fija la frontera aunque `owed` sea 0** (cierra el bloqueo de las wallets
perdedoras); `pull(amount)`: firma la wallet, `amount ≤ min(owed − collected, max_contribution, saldo − reserva)`. Hacer
la contribución un **transfer del System de nivel superior** verificado por introspección, para que la **policy de
Privy pueda acotar importe y destino** por wallet; `settle_v2` con `requested = 0` **patrocinado** (`sponsor: true`)
cuando la wallet no cubre ni reserva + fee. Para usuarios que guardan la clave en Phantom/Backpack: **vales con durable
nonce** pre-firmados en el onboarding (semana+). Pata USDC por delegado SPL para quien opera en USDC (días).

Descartados con evidencia: PDA como trading wallet (sin clave para GMGN/Axiom; no puede pagar fees), `Assign` al
programa (rompe todo swap externo), Squads/1-de-2/session keys (mueven los fondos a otra dirección), delegado SPL en
wSOL como *el* cobro (los traders tienen SOL nativo; el ATA de wSOL nace y muere dentro del swap), la receta de fee
payer custom de Privy (`signMessage` no pasa por la policy de transacción → firmante ilimitado).

### 4.3 Inversión

**Demo (horas):** cesta de **1–2 legs**, `min_investment` **$1 por leg** (defaults de policy fijados *antes* de que el
dueño firme; una policy firmada no cambia después), umbral de cesta `legs × min` mostrado en la UI ("esta cesta compra a
$N"); **trocear** `wrap/convert` a `min(libre, crank − reserva, max(max_per_call, 1 SOL))` en rondas por barrido;
**fijar el mint de entrada** en `convert/invest` (`in_mint` tallado de los 32 bytes reservados de la policy, default
USDC); **cotización de Jupiter cruzada con el `sqrt_price` del pool** en lugar del paseo de 60 txs; refrescar el
catálogo de pools con el motivo de cada elección; **alertar en `FAILED`** y acotar el turno de invest a 90 s; cablear el
heartbeat existente.

**Después:** rebalanceo a pesos objetivo en vez de repartir el sobrante (auto-cura una cesta muerta a medias);
**multi-leg en una tx con v0 + Address Lookup Table** (medido: 2 legs = 1.340 B, 3 = 1.757 B contra el tope de 1.232;
con ALT, 8 legs = 1.150 B); **Jupiter como venue opcional sin cambio de programa** (`venue_program = JUP6…`,
`venue_data = swapInstruction.data`, `remaining_accounts` = su lista; el programa solo presta la firma del PDA) —
opción, no ruta de demo. Descartado tomar el pool de Jupiter para el leg de conversión (liquidez 2,8e11 vs 2,27e14 del
fijado): usar la cotización solo para el esperado.

### 4.4 Seguridad y despliegue

**Demo (horas), no negociable:** **program id nuevo** (`declare_id!` + `Anchor.toml` + keypair nuevo), **cuatro claves
distintas** que **yo nunca veo**: autoridad de upgrade (generada offline, guardada fuera de toda máquina y chat),
autoridad de config, atestador, keeper/crank; **`init_config` gateado a la autoridad de upgrade** (constraint sobre
`ProgramData.upgrade_authority_address`) para matar el "primero que llegue"; **`ProtocolConfig` v2** (203 B) con
`pending_authority` y transferencia en dos pasos, `paused` global y reservados — diseñado *antes* de que exista la
cuenta; clave de autorización de Privy nueva y policy solo para el id nuevo.

**Programa viejo, ahora, sin código (tú firmas):** `solana program set-upgrade-authority 7rtg… --new-upgrade-authority
<fría>`; `set_attester` a un atestador nuevo; `set-keeper 1111…` para desarmar el crank; **no cerrar** (mataría los PDAs
con 22,36 SOL ajenos). Cerrar y recuperar los 3,33 SOL solo cuando los vaults ajenos estén a cero.

**Antes de dinero de terceros:** autoridad de upgrade en **Squads v4** (`SQDS4ep6…`, vivo), 2-de-3 con timelock de 24 h,
upgrades vía `write-buffer` + propuesta; `close_vault` / `close_link` firmados por el dueño; **eventos** (`Settled`,
`Converted`, `Invested`) que hoy no existen y que el read-model reconstruye a mano.

### 4.5 Web

Selector BENEFICIO / VOLUMEN al crear el vault y en ajustes, cada uno con su campo de tasa y su copy (beneficio: "una
parte de lo que ganes"; volumen: "una parte de cada compra y venta"), tope por liquidación y reserva; builders V2 sobre
el mismo camino servidor-construye-navegador-firma; y el pin de decode restaurado. Los xStocks Token-2022 con
`permanentDelegate` se explican en la ficha del activo, no en la letra pequeña.

---

## 5. Cinco días

| día | qué | cuándo está "hecho" |
|---|---|---|
| **1** | programa: carve de `Vault`, `settle_v2` + mensaje V2, `create/set_policy_v2`, `init_config` gateado, `ProtocolConfig` v2, mint de entrada fijado; tests en localnet | `anchor test` verde; layouts 125/129 intactos |
| **2** | despliegue nuevo con tus cuatro claves; `init_config`; Privy: clave de autorización + policy nuevas; keeper: modo desde el vault, medidor de volumen, `until`, trocear wrap, alertas | un `settle_v2` real en mainnet en cada modo con wallets de prueba |
| **3** | web: selector de modo, V2 builders, copy; `solana-core` sobre el id nuevo; cesta 1–2 legs a $1 | crear vault → link → trade → cobro → invest, de punta a punta, en la UI |
| **4** | endurecer lo que el día 2 dejó a medias; refrescar catálogo; README con linaje declarado | segundo ciclo completo sin intervención manual |
| **5** | vídeo, entrega antes de las 21:00 Lisboa | — |

Si el día 1 se atasca, **la salida honesta es la demo en modo BENEFICIO** (cero cambios de programa) sobre el id
nuevo y las claves nuevas; el modo VOLUMEN queda "later" en el README. Lo que **no** se recorta bajo ningún plazo: id
nuevo, claves nuevas, `init_config` gateado.

---

## 6. Decisiones que necesito de ti

1. **Program id nuevo y cuatro claves nuevas, que generas tú** y de las que yo solo recibo las públicas. ¿Confirmas?
2. **Demo dual (upgrade pequeño, días 1–2) o demo solo BENEFICIO (sin cambio de programa)?** Mi recomendación: dual, con
   el plan de retirada del §5.
3. **El programa viejo:** ¿te preparo los tres comandos exactos (rotar upgrade authority, `set_attester`, desarmar) para
   que los firmes hoy? El tercero con 22,36 SOL no sabe que su dinero está bajo una clave pegada en un chat.
4. **Defaults:** BENEFICIO 20 %, VOLUMEN 0,20 %, tope 1 SOL por liquidación, reserva 0,01 SOL. ¿Vale?
5. **Proveedor RPC con clave** para el keeper (Helius Developer o equivalente); presupuesto.
6. **La narrativa del demo:** hasta identificar `FLASHX8D…`, ¿operamos en el vídeo con pump.fun/Jupiter directamente en
   vez de afirmar "GMGN/Axiom"?

---

## Anexo A — Inventario de reutilización

| pieza | veredicto | notas |
|---|---|---|
| `programs/nuvem-vault` | **adaptar** (fork con id nuevo) | + modo, V2, `init_config` gateado, config v2, mint fijado |
| `attestation.rs` + `scripts/attestation.ts` | adaptar | dominio V2, 152 → 155+ bytes |
| `keeper/src/measure-window.ts` | mantener (BENEFICIO) | + gemelo `measure-volume.ts` |
| `keeper/src/settle-tick.ts`, `privy-signer.ts` | adaptar | V2, cadencia por umbral, backoff |
| `keeper/src/invest-tick.ts`, `min-out.ts`, `live-route.ts` | adaptar | trocear, quote + `sqrt_price`, alertas |
| `keeper/src/discovery.ts`, `rpc-pool.ts`, `singleton.ts`, `alerts.ts` | **portar al `@sip/worker`** como adaptador | el núcleo ya existe en EVM |
| `solana-core` (lecturas, builders, pricing) | **mantener** | id nuevo, builders V2 |
| web `/solana` + rutas | adaptar a la UI de SIP | selector de modo |
| drills (`mainnet-drill`, `fork-e2e`, `raydium-swap`) | mantener como harness | fuente de verdad de rutas |
| `docs/RAILWAY.md §3`, `railway.json` del keeper | mantener | config por servicio ya resuelta |

## Anexo B — Lo que se tira

Program id `7rtg…` y todo lo atado a él (Privy policy vieja, clave de autorización vieja, catálogo de pools apuntando al
id viejo); `toy_venue`; el comentario "0,006 SOL"; las dos afirmaciones caducas sobre Privy; `set_attester(0) →
InvalidPolicy` (mensaje).

## Anexo C — Método y cobertura de verificación

- Lecturas: programa, keeper, superficie+drills, cadena, deudas. Diseños: dos modos, volumen, observación, cobro,
  inversión+seguridad. **96 afirmaciones y recomendaciones** generadas; refutación adversarial **capada a 36**; en la
  primera pasada 7 verificadas (4 refutadas, 3 sobrevivieron) y **29 verificadores cayeron por el límite mensual de
  gasto**; el run se reanudó — sus veredictos se anexan en D al llegar. **60 afirmaciones nunca pasaron por un
  verificador**: todo lo marcado "agente" sin "yo" en §1.4 y las recomendaciones "later" deben leerse como *bien
  fundadas, no adversarialmente verificadas*.
- Contrastes propios (RPC público, 2026-09-13): ProgramData (bytes, rent, autoridad), conteo de cuentas por
  discriminador y lamports por tipo, decode del `ProtocolConfig` (authority/keeper = `6Nqw…`, attester = `9vCz…`),
  actividad del crank (última tx 9-sept 12:54 UTC; 196 txs el 8-sept con un `Custom(1)` a las 16:57), firmas recientes
  de la wallet del tercero (60 desde el 9-sept, última 13-sept 11:02 UTC, saldo 11,07 SOL) y decode de su `TradingLink`
  (nonce 8, frontera = 4-sept 22:25 UTC, slot actual 446.708.995). Coinciden con los lectores en todo. Lo único que no
  pude repetir por límite de tasa del RPC público es el recorrido de las 55 firmas del config PDA que demuestra que
  `set_attester` nunca se ejecutó; el *estado* (atestador = clave filtrada) sí lo verifiqué, y es lo que importa.
- Tres correcciones que la refutación impuso y que este informe ya incorpora: (i) `policy_nonce` **no** existe en
  `Vault` (solo en `InvestmentPolicy`) — el diseño lo añade; (ii) el volumen **no** es "delta neto de fee" (§3.3);
  (iii) el modo BENEFICIO **no** necesita cambio de programa para la demo — el ajuste de `min_investment` es de policy y
  de keeper.

## Anexo D — Verificación adversarial

*Primera pasada (7 de 36):* 4 refutadas — cambio de programa para el modo (corregido: `Vault` sin `policy_nonce`, set
mínimo = `skim_mode` + dominio V2 + `mode/bps` en el mensaje); polling→push (corregido: solo "later" y aditivo; para la
demo, fundir lecturas y sustituir el paseo de 60 txs); notional de volumen (corregido: §3.3, con una tx real
descompuesta al lamport); demo BENEFICIO (corregido: la etiqueta "trocear el wrap" no es de demo). 3 sobrevivieron —
`may_crank` exige `signer == keeper` (`6Nqw`); el esquema de policies de Privy gatea `signTransaction` y ve System/Token;
el modo dual exige un upgrade pequeño, no una convención del keeper.

*Run reanudado:* **pendiente** — se anexa al llegar.
