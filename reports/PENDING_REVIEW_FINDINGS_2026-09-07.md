# Hallazgos de la revisión — estado

**Actualizado 2026-09-07, tras la segunda ola.** De los 35 confirmados, **quedan 3 abiertos** (abajo, al
final). Todo lo demás está aplicado y verificado: worker 511/511, contratos 425/425, web tsc + build + ABI,
y un tick de dry-run que completa contra mainnet.

La revisión adversarial del 2026-09-07 (5 lentes, 40 hallazgos, 35 confirmados tras refutación)
se quedó sin presupuesto en la fase de arreglos. **Se aplicaron a mano los cuatro de severidad alta
y sus regresiones** (ver abajo). El resto queda aquí, con fichero y línea, listo para retomar.

## Aplicado y verificado

| Fichero | Qué | Verificación |
| --- | --- | --- |
| `worker/src/ledger/pg.ts`, `src/types.ts`, tests | `windowsByStatus` implementado en ambos ledgers y en los dobles de test (regresión que introduje al declararlo) | tsc limpio |
| `worker/src/tick.ts` | **Volumen varado**: una ventana persistida cuyo cobro fue DRY_RUN, SKIPPED o murió en el envío no se volvía a mirar nunca. Ahora cada pasada retoma OPEN/SIGNED/SUBMITTED antes de abrir nada nuevo; **la frontera del vault decide si el cobro entró** (Fase 0 la avanza al liquidar) y solo entonces se acredita `collected`; `PullBroadcastError` se captura por tipo y marca SUBMITTED en vez de re-atestar el mismo nonce; el cierre ya no depende de que haya bloques nuevos | 4 tests nuevos, 483/483 |
| `contracts/src/settlement/SipVolumeExecutor.sol` | **Migración Fase 0 → Fase 1 muerta**: el contador sintético arrancaba en 0 y el vault rechazaba el primer cobro de cualquier cuenta que ya hubiera liquidado. Ahora se siembra leyendo la frontera real del vault por `extsload` (mismo slot que `VaultLens.settlementFrontier`) | 21/21, 417/417 en toda la suite; el test que fijaba el fallo como política reescrito + pin del slot |
| `website-oficial/security-headers.mjs`, `src/proxy.ts` | **CSP horneada en build**: un endpoint puesto al reiniciar quedaba bloqueado sin rastro en el servidor. Los overrides se leen por llamada y la política la envía un `proxy` por petición (convención de Next 16) | comprobado en vivo: `NUVEM_PUBLIC_RPC_URL` puesto al arrancar aparece en `connect-src` sin reconstruir |

## Pendiente

### worker
- `src/tick.ts` — `runLoop` se traga `LedgerConnectionLostError` y sigue tickeando contra un ledger muerto cuyo advisory lock ya no existe. **Debe salir del proceso.** (medio)
- `src/tick.ts` — el `catch` del reconciliador convierte cualquier excepción en un refusal `STATE_UNAVAILABLE`; `StateUnavailableError` no se compara por tipo, así que un bug del reconciliador se reintenta en silencio para siempre. (medio)
- `src/tick.ts` — los fills anteriores al `activationBlock` de la cuenta no se descartan, así que un pause/unpause del admin (o un re-link) atasca esa wallet permanentemente. (medio)
- `src/tick.ts` — la retención de refusals se mide por antigüedad del bloque, no por cuándo se vio el refusal; tras un catch-up de más de un día los bloques refusados se saltan sin reintento. (medio)
- `src/observe/reconcile.ts` — un sell por residuo absorbe cualquier entrada de ETH por llamada interna de otra tx de la misma wallet en el mismo bloque: **volumen fabricado que la identidad §3.4 no ve**. (medio)
- `src/observe/reconcile.ts` — cualquier tercero puede bloquear una wallet emitiendo un log `Transfer` que la nombre: el cursor se queda ~1 día por log de spam y los fills reales de ese bloque se anulan. (medio)
- `src/attest/phase0.ts` — `endL2 = head − 64` cae en el bloque L1 actual ~75 % de las veces, así que la mayoría de las pasadas difieren con `L1_NOT_ADVANCED`. (medio)
- `bin/worker.mts` — `openPgLedger` sin opciones: el pin de identidad no corre y un worker vivo etiqueta su lock como `dry-run`. `ConfigError` sin capturar: traza y exit 1 en vez de la lista de problemas y exit 2. Los eventos de failover se registran todos como `warn`. (medio/bajo)
- `src/attest/phase0.ts` — `config.chainId` no llega a la atestación (usa la constante). `src/pull/submit.ts` — `encodeSettleCalldata` duplicado. `src/pull/privy.ts` — `PRIVY_SIGNER_ID` no se lee, así que cualquier firmante adicional cuenta como nuestro asiento. (bajo)
- `test/reconcile.test.ts` — las cuatro verdades de la fixture nunca pasan juntas por decodificador + reconciliador + ledger reales. (bajo)

### contracts
- `test/unit/SipVolumeExecutor.t.sol` — seis rutas de revert con nombre sin aserción; `InvalidPolicyHash` (la única guarda contra un `setVaultPolicy`) sin cobertura. (medio)
- `SipVolumeExecutor.sol` — la deuda arrastrada se indexa solo por cuenta y sigue cobrable tras poner la tasa a 0 o mudarse de vault; `VolumePulled` omite la ventana L2 atestada y el `settlementNonce`; `owed` sub-cuenta cuando la wallet no llega al mínimo en ese momento. (bajo)

### web
- `api/vault/route.ts` y `api/create-vault/route.ts` — sin autenticar ni limitar, y cada petición dispara varias llamadas al RPC medido. (medio)
- `api/rpc/route.ts` — el límite por IP se apoya en el primer `x-forwarded-for`, falsificable por el cliente; además lee el cuerpo entero antes de aplicar `MAX_BODY_BYTES`, y mide caracteres, no bytes. (medio/bajo)
- `wallets/ImportWalletDialog.tsx` — el preflight mira `activeVaultOf` pero no `vaultOfAdmin`: la pension key de otro vault se importa, se invita y revierte al aceptar, quedando PENDING 24 h. (medio)
- `wallets/RateControl.tsx` — el cambio de tasa y el revoke se firman desde la trading wallet siempre que Privy la tenga, pero una wallet recién creada **no tiene gas**; el revoke no tiene alternativa por admin. (medio)
- `wallets/LinkWalletDialog.tsx` — las escrituras del navegador no se simulan antes, así que un revert cuesta gas y su nombre depende del wallet. (medio)
- `lib/config.ts` — `NUVEM_DISABLE_RPC_PROXY` sin RPC público mata en silencio todas las lecturas del navegador. `lib/skims.ts` — lee `DATABASE_URL` y el explorer con alias distintos a `config.ts`. `wallets/TradingWalletRow.tsx` — el diálogo de vinculación se desmonta al terminar, su estado final es inalcanzable. (bajo)

## Hallazgo nuevo, medido en cadena (2026-09-07, tras activar PAYG)

**La misma venta vale distinto según qué camino la valore: el venue reporta BRUTO y el residuo NETO.**

Medido sobre la wallet real `0xaa881cc596a7e56f89b8e2c37e4e0625396d46d6`, vinculada a un vault de la
factory actual, con 23 fills en 29 bloques y 0 rechazos:

- Las ventas que el decodificador de GMGN entiende devuelven `notional = amountOut + fee` (**bruto**,
  como manda DESIGN §3).
- Las que no entiende caen al residuo del bloque, que es lo que el saldo de la wallet realmente ganó:
  **neto de la comisión del router (~1 %)**. Recalculado a mano contra la cadena, el residuo **coincide
  al wei** — la aritmética es correcta; lo que difiere es la *base*.
- Por qué no las entiende: la carga del evento FILL es ABI dinámica. En la forma corta (16 palabras)
  `w05` es el tipo de pool (1 = v3, 2 = v4) y `w06/w07` el camino; en la forma larga (17 palabras,
  bloque 55474167) `w05` vale 27 y el camino está desplazado. El decodificador lee índices fijos y
  **rechaza en vez de adivinar, que es lo correcto** — pero el coste es que la venta se valora en otra
  base.

**Arreglo propuesto** (no aplicado; toca `observe/venues/gmgn.ts` y el consumidor en `reconcile.ts`):
cuando exista un log FEE de GMGN indexado por la wallet pero el FILL no se pueda parsear, sumar esa
comisión al residuo para devolver bruto. La comisión es fiable aunque el camino no lo sea. Alternativa:
redefinir el notional como neto en ambos lados — decisión de producto, porque cambia lo que se cobra.

**Además:** parsear el FILL por offsets ABI reales en vez de índices fijos eliminaría la mayoría de las
caídas al residuo. Hoy, sobre datos reales, **9 de 23 fills** se valoraron por residuo.

---

## Cerrado en la segunda ola (2026-09-07)

**worker** — el residuo ahora se *prueba* en vez de asumirse: si otra tx enviada por la wallet en el mismo
bloque movió ETH nativo, el bloque se rechaza en vez de valorarse (era volumen fabricado atestable); y un
log de un tercero en un bloque donde la wallet no envió nada y no movió caja pasa a ser exclusión, no
rechazo, así que ya no puede aparcar el cursor un día. `runLoop` muere ante un ledger perdido en vez de
seguir sin lock; `StateUnavailableError` se distingue por tipo; los fills bajo `activationBlock` se
descartan (y una ventana ya persistida bajo el suelo se marca FAILED en vez de atascar la wallet); la
retención de rechazos se mide desde que se vio, no por antigüedad del bloque. `bin/worker.mts` fija la
identidad del lock, imprime la lista de problemas y sale con 2, y separa ALL_FAILED de SWITCHED por nivel.
La ventana L1 se elige por debajo de la cabeza viva, así que ya no se difiere el 75 % de las pasadas.
`PRIVY_SIGNER_ID` se comprueba: solo cuenta *nuestro* asiento.

**web** — `/api/dashboard` conecta el panel a datos reales (con caída limpia al mock y aviso visible);
`/api/vault` y `/api/create-vault` con límite de tasa; el relay mide bytes y usa la IP de confianza;
importar comprueba también `vaultOfAdmin`; el cambio de tasa detecta que una wallet recién creada no tiene
gas y ofrece la vía del admin; las escrituras se simulan antes de pedir firma.

**contratos** — 8 tests nuevos: las seis rutas de revert sin cubrir, incluida `InvalidPolicyHash` accionada
por un `setTradingAccountPolicy` real entre la firma y el cobro. 425/425.

**RPC** — el cliente conserva el mensaje del proveedor (un `HTTP 400` mudo escondía «eth_getLogs con hasta
10 bloques», que era la causa entera de un escaneo muerto), con la clave siempre depurada.

## Sigue abierto

1. **Bruto vs neto** (arriba, «Hallazgo nuevo»): la misma venta vale distinto según qué camino la valore.
   Sobre datos reales, 11 de 35 fills se valoraron por residuo, es decir en neto. Decisión de producto
   antes que de código.
2. **Policy de Privy sin dueño**: `authorization_context` no se acepta en `create` con @privy-io/node 0.28,
   así que hoy se puede modificar con solo las credenciales de la app.
3. **Exposición residual acotada a propósito**: un log de spam en un bloque donde la wallet *sí* transaccionó
   todavía rechaza ese bloque. Ampliarlo exige una decisión conjunta del reconciliador y el tick.
