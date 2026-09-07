# SIP — el backend heredado de Nuvem (Robinhood Chain) frente al skim por volumen

**Fecha:** 2026-09-07 · **Versión 2** — reescrita tras fijar el owner tres restricciones de producto:
la wallet de trading se usa *donde sea* (exportable a GMGN/Axiom; importable desde fuera), un vault por
usuario con **N** wallets de trading, y **el skim se captura aunque el trade se haga en un router ajeno**.
**Alcance:** solo EVM / Robinhood Chain 4663; Solana excluido. **Nada se ha modificado ni desplegado.**
**Método:** siete lectores por subsistema, tres arquitectos, y cinco verificadores adversariales sobre las
afirmaciones que sostienen la recomendación final (Anexo D). Todo en solo lectura.

---

## 0. Resumen ejecutivo

**Lo que las restricciones cambian.** Si el usuario opera con su clave en GMGN o Axiom, ningún contrato
nuestro está en el camino de esa transacción: el código delegado por EIP-7702 solo corre cuando la cuenta
es *llamada* (los cinco trades del canario fueron EOA→router directos), y una política de Privy
permite o deniega, no inserta llamadas. Por tanto el skim no puede *tomarse antes* del trade externo:
**hay que observarlo on-chain después del fill y cobrarlo de la wallet.** Eso reintroduce un proceso de
servidor — pero uno de *volumen*, no de *beneficio*, y esa diferencia es todo.

**Por qué volumen es otro animal.** El beneficio exigía sesiones planas-a-plana, base de coste FIFO,
guardas anti-airdrop, un tracer de llamadas internas, y un firmante en quien confiar sobre cuatro cifras
que el contrato no puede verificar. El volumen de una compra es `tx.value` de esa transacción; el de una
venta en GMGN lo emite el propio router en un evento indexado por wallet (dato = comisión del 1 %, es
decir, notional exacto). Cualquiera lo recomputa desde un RPC público. Y dispara en **cada** compra y
venta, no en el 0,246 × 39,4 % de sesiones rentables del modelo viejo.

**Recomendación: observar → atestar volumen → cobrar vía el asiento de firma de Privy → depositar en el
`PersonalVault` ya desplegado.** Dos fases:

- **Fase 0 (cero Solidity, beta con wallets del equipo):** el `SettlementExecutor` desplegado acepta
  una atestación de volumen tal cual — `cashStart = 0`, `cashEnd = Σnotional` — porque solo comprueba
  coherencia aritmética. Sirve para validar el observador en producción con dinero propio. No sirve para
  usuarios: su regla de «contribución exacta = saldo − floor − reserva», sus caps que *recortan* en vez de
  *diferir*, su frontera L2 estricta (un fill descubierto tarde es inskimeable para siempre) y su ventana
  de 15 minutos están pensados contra un atestador mentiroso y muerden a una wallet que opera fuera.
- **Fase 1 (`SipVolumeExecutor`, contrato pequeño):** cada admin lo apunta con `setSettlementExecutor`;
  lleva su propio esquema (raíz de fills, residuos por bloque, `owed`, `collected`), **cobro aditivo y
  best-effort** — toma `min(owed, saldo − reserva)` y arrastra el resto —, idempotencia por raíz de lote
  en su propio storage y progresión sintética hacia el vault (la frontera del vault pasa a ser un contador).
  El vault no cambia.

**Servidor residual:** un observador/atestador/cobrador sin estado relevante (cursor + libro de deuda),
cada 5 minutos: **~25–35 llamadas RPC por wallet activa y día, ~1 por wallet en reposo, ≈ 7–10 $/mes de RPC
por cada 1.000 wallets activas** — frente a decenas de miles de llamadas y 1.440 filas por usuario en
reposo hoy. Sin tracer, sin escaneo bloque a bloque, sin motor de sesiones, sin journal encadenado.
Requiere un endpoint Alchemy *Pay-As-You-Go* (rango de `eth_getLogs` ilimitado en Robinhood Mainnet;
el tier gratuito lo capa a 10 bloques) y confirmar acceso a estado histórico en 4663.

**Lo que hay que aceptar, y decir en la UI:** (1) el cobro es *best-effort*: la clave exportada es un
segundo firmante sin política, así que si la wallet está llena de tokens y sin ETH no hay nada que
cobrar hasta que venda — la deuda se arrastra; (2) el titular de la clave puede poner su tasa a 0 o
revocarse: el contrato no ofrece participación solo-admin, y no debería — es *su* pensión;
(3) SIP afirma el volumen: misma forma de confianza que hoy, pero medida objetiva, recomputable por
cualquiera, acotada por caps y solo hacia el propio vault del usuario.

**Esfuerzo:** 10–13 semanas-ingeniero hasta producción, más tres confirmaciones externas (Privy: límite
de wallets importadas y modo TEE; Alchemy: archivo en 4663). Semana 0: rotar claves.

---

## 1. Lo que hay hoy

| Subsistema | Líneas | Qué hace | Dependencia crítica | Veredicto |
| --- | --- | --- | --- | --- |
| `contracts` núcleo (VaultFactory, PersonalVault, SettlementExecutor) | 5.451 (todo `src/`) | custodia por usuario, binding de N wallets, liquidación atestada | atestador de confianza | **factory + vault: conservar**; executor: Fase 0 y retirar |
| `contracts` periferia (AdapterRegistry, 5 adaptadores, PerpDesk, Fee*, Pause) | — | comprar el activo elegido vía Uniswap v4 / desk | keeper que dispara `invest()` | **conservar tal cual** |
| `session-engine` | 3.061 | reconstruir PnL de una sesión | `debug_traceTransaction`, archivo | **retirar**; conservar `rpc.ts`, `failover.ts`, `chain.ts`, `classify.ts` |
| `keeper` | 13.686 | supervisor 60 s: descubrir, escanear, atestar, liquidar, invertir | Postgres lock, Privy signer, tracer | **retirar la liquidación de beneficio**; conservar descubrimiento, firma Privy, envío, inversión, cotización |
| `aa-smoke` | 1.260 | pruebas EIP-7702 / 4337 | Alchemy MAv2 | **archivar** |
| web backend (HEAD `fd927b0`) | — | fan-out de 96 llamadas, checklist de 13 bloqueos, relay RPC, onboarding Privy | RPC con clave | **conservar onboarding, import/export y relay**; retirar diagnósticos y fan-out |

### 1.1 Cómo entra hoy el dinero en un vault

1. El keeper escanea los bloques L2 de la wallet (una `eth_getBlockByNumber` por bloque, ~21 bloques/s),
   detecta una sesión plana-a-plana, reconstruye caja con el tracer y decide si es atestable.
2. Firma una atestación EIP-712 de 26 campos válida 15 minutos.
3. La *propia wallet* envía `settle{value: contribución exacta}` — por eso el keeper tiene un asiento de
   firma (Privy additional signer) en cada wallet.
4. `SettlementExecutor` recalcula el beneficio, hace 13 lecturas previas, aplica los caps y llama
   `acceptSettlement`. 5. `invest()` lo dispara el mismo keeper sondeando cada vault cada 30–60 s.

### 1.2 Cifras que importan

- Reposo por usuario/día en el supervisor: decenas de miles de llamadas RPC (~56.000 por el recuento del
  código; ~780.000 extrapolando el tick medido de 271 RPC/30 s) y ~1.440 filas Postgres.
- Descubrimiento releyendo toda la fábrica cada 60 s: 218.880 `eth_getLogs`/día con cero usuarios.
- Censo de 77 wallets GMGN: 0,246 sesiones liquidables por compra; 39,4 % rentables.
- `block.number` es L1 en esta cadena Nitro; ~120 bloques L2 por L1; desfase no constante.
- Un proveedor agotó su cuota mensual y paró todo ahorro durante horas con la cadena sana.
- `PersonalVault`: 23.691 de 24.576 bytes; cada arreglo compite por 885 bytes.

### 1.3 Gobernanza y operaciones

- Primer despliegue (29-07) **congelado** (fábrica en bootstrap sellado; timelock nunca aceptó). El
  vault canario retiene 403.370.889.498.747 wei de WETH, retirables por su admin.
- La topología que la web apunta es la del **16-08** (fábrica `0x783BDF02…`, executor `0xfA92ABF1…`,
  timelock 900 s, Safe 1-de-2), cuyo propio informe dice «no debe recibir dinero de nadie más que quien
  lo pagó». Nada verificado en explorador.
- Dieciséis secretos en cuatro ficheros; claves pegadas en chat (rotación pendiente).
- Bloqueadores documentados: cobertura contigua no forzada on-chain, sin finalidad ni reorgs, cap por
  período nunca escrito, `NativeTokenLimit` ignora `executeBatch`.

---

## 2. Por qué pesa tanto: el modelo de beneficio, en una frase

El contrato solo puede comprobar que las cuatro cifras de caja son aritméticamente coherentes; **no puede
saber si describen lo que la wallet hizo** (`THREAT_MODEL.md:23-57`). Todo lo demás es el intento de que
un proceso de confianza no mienta y no pague dos veces. Un skim de `bps × notional` **no elimina** la
confianza en quien mide — pero convierte la medida en un número que cualquiera recomputa desde un RPC
público y que dispara en cada trade.

---

## 3. Dónde puede vivir el skim si el usuario opera donde quiera

| Punto | Qué exige | Qué demuestra el repo | ¿Cubre trades externos? |
| --- | --- | --- | --- |
| Código en la cuenta (7702) | autorización firmada; trades como auto-llamada | el código delegado no corre en txs *salientes* de la EOA (canario GMGN); Privy-7702 en 4663 sin probar; el SDK de Alchemy envía la autorización sin firmar; MetaMask puede sobrescribir la delegación; recibir ETH cuesta 21.227 gas (remitentes con estipendio de 21.000 fallan) | **no** |
| Política de Privy | asiento de firma | permite/deniega por `to`/selector/valor/cadena; no inserta llamadas | **no** |
| Router de SIP | que el trade pase por él | patrón de `unlock` de dos saltos ya fork-testado | **no** |
| **Observar y cobrar** | descubrir fills en logs; una vía para mover ETH desde la wallet | logs de Transfer con la wallet indexada en todos los fills GMGN grabados (pool v3-style y v4); eventos propios del router GMGN con la wallet indexada; asiento Privy que firma *desde* la wallet (`msg.sender == wallet`, ETH nativo, sin allowance ni delegación) | **sí** |

La única palanca que cubre trades externos es la cuarta. El router de SIP queda como opción v2 para
trades hechos *dentro* de SIP (skim atómico en la misma tx; esos fills se marcan para que el observador
los excluya).

---

## 4. Recomendación: observar → atestar → cobrar → depositar

### 4.1 El observador (lo que la verificación obliga a que sea)

No es «una función por transacción de (logs, dos saldos)»; es **un reconciliador por bloque con vía de
rechazo**, y por venue cuando el venue lo permite:

- **Descubrimiento.** `eth_getLogs` de `Transfer` con el conjunto de wallets como array OR en `topic[1]`
  (ventas) y `topic[2]` (compras) — dos llamadas para todas las wallets — con: solo logs de 3 topics
  (los mints ERC-721/404 comparten el topic y rompen el decodificador), **WETH canónico excluido del
  conjunto de tokens** (wrap/unwrap se leería como venta/compra), chunking con comprobación de cobertura
  (`getBlock(toBlock)`) y conciliación con el delta de nonce de cada wallet (un proveedor capado devuelve
  lista vacía, no error). **Unión** con las transacciones enviadas por la wallet en cada bloque candidato
  (`eth_getBlockByNumber(N, true)` solo en esos bloques): ahí están el `approve` sin log que precede a
  toda venta GMGN, los envíos nativos y los propios cobros del vault. Todo esto ya existe en
  `keeper/src/discovery.ts` (arrays OR, chunking, cobertura, solapamiento de rescan).
- **Notional de compra:** `tx.value` del fill (exacto, sin leer saldos). Compras pagadas en WETH: por el
  log de Transfer de WETH (caja = nativo + WETH, como `chain.ts:157-169`).
- **Notional de venta, por capas:** (1) *decodificador de venue* — el router GMGN emite `0x8619026a`
  (importe del fill) y `0x205442d6` (comisión = 1 % del fill), ambos indexados por wallet: notional
  exacto y bruto; (2) *residuo por bloque* — `saldo(N) − saldo(N−1) + Σgas(txs enviadas por la wallet en
  N) − Σvalor_salida ± ΔWETH`, válido **solo** cuando el bloque contiene exactamente una transacción con
  forma de venta y ninguna entrada nativa sin explicar; (3) en cualquier otro caso el bloque **se
  rechaza y se difiere**, nunca se atesta — la disciplina «un UNKNOWN rechaza la ventana» del motor
  viejo, aplicada al volumen.
- **Fuera de alcance en v1, por política escrita:** swaps token-por-token (sin pata de caja), varias
  fills en una tx (solo el neto), wallets con código (una EOA delegada por 7702 rompe el razonamiento
  de saldos: comprobar `eth_getCode` y usar solo decodificadores), y usuarios directos del fork del
  UniversalRouter liquidando por claims ERC-6909 (no se puede afirmar desde el repo; spike).
- **Retención de estado:** las lecturas de saldo a `N−1` son «archivo» pasados 128 bloques (~18 s).
  O se fija un endpoint con archivo verificado en 4663 en el arranque (como `failover.ts` sondea el
  tracer), o el observador no puede quedarse más de ~20 minutos atrás (la RPC pública poda a 10k
  bloques). Ventanas cerradas tras un margen de finalidad (64 bloques L2) más el retraso del observador.
- **Proveedor:** Alchemy **Pay-As-You-Go** (rango `eth_getLogs` ilimitado para Robinhood Mainnet; el
  Free capa a 10 bloques → 420 llamadas por barrido). Sin Debug/Trace en 4663 desde Alchemy: la capa
  (2) es el sustituto del tracer y la (3) su límite honesto. Limitador de tasa propio: un 429 no debe
  disparar failover entre proveedores a mitad de barrido.

### 4.2 La atestación de volumen

Compromete la **lista de fills** (raíz de hashes de tx), los **residuos por bloque** usados, `Σnotional`
bruto, `owed = bps × Σnotional`, y el rango L2 cerrado — de modo que un tercero recompute todo desde un
RPC público. La firma la da la clave del atestador registrada en `AttesterRegistry` (**se reutiliza tal
cual**, con su rotación por guardián/timelock).

### 4.3 El cobro (asiento de Privy)

- **Creación:** wallet embebida «born seated» — `createWallet({signers: [{signerId, policyIds}]})`
  (`InviteTradingWallet.tsx:245-249`). **Importación:** `importWallet({privateKey, additionalSigners})`
  — solo en **modo TEE** (`react-auth 3.36.0`, JSDoc): en modo on-device el asiento no se adjunta en
  silencio. La app debe comprobar en runtime que ejecuta en TEE. **Exportación:** `useExportWallet`
  (diálogo de Privy). No hay regla documentada de revocación-al-exportar: el asiento sigue válido — pero
  **la clave exportada es un segundo firmante sin política** (el usuario o un bot co-tenedor puede mover
  fondos antes que nosotros).
- **Política** (una por firmante, a nivel de app): `to == SipVolumeExecutor` (ABI y selector fijados —
  hoy la regla apunta a `settle`; una regla nueva sin ABI cae en DENY), `chain_id == 4663`,
  `function_name == pull`, `value lte tope por transacción`. Un tope rodante exige agregaciones con
  estado (máximo 10 por app, compartidas): evitarlo; el tope rodante vive en el vault.
- **Antes de cada firma:** releer el flag `delegated` de la wallet (el usuario puede quitar todos los
  firmantes vía API sin UI nuestra); una firma ya emitida pero no difundida sobrevive a la revocación.
- **Best-effort con arrastre:** el cobro toma `min(owed, saldo nativo − reserva)`; el resto queda como
  deuda en el executor y se cobra en el siguiente ciclo. Una wallet llena de tokens tras una compra no
  tiene nada que cobrar hasta que venda: **se acepta y se muestra** («apartado 5,00 $ · cobrado 0 ·
  pendiente 5,00 $»).
- **Límites de Privy a confirmar por escrito:** *una wallet importada por usuario* (solo en el JSDoc del
  SDK; alcance por tipo de cadena sin verificar) — hasta entonces «N wallets» = N creadas + 1 importada;
  N creadas sin tope documentado (`createAdditional`); la app en TEE.

### 4.4 El depósito: Fase 0 y Fase 1

**Fase 0 — `SettlementExecutor` desplegado, cero Solidity.** Atestación con `cashStart = 0`,
`externalDeposits = externalWithdrawals = 0`, `cashEnd = Σnotional` → `realizedProfit = volumen` →
`contribución = min(bps × volumen, maxPerSettlement, cap 30 d de la cuenta, cap 30 d agregado,
saldo − floor − reserva)`, que debe coincidir *al wei* con `msg.value` (`SettlementExecutor.sol:100-107,
352-369`). Funciona mecánicamente y es la forma más barata de validar el observador con las wallets del
equipo. Lo que muerde a usuarios reales: la contribución es una cantidad viva (releer saldo y caps al
firmar, enviar en minutos y antes del siguiente trade, reintentar en `InvalidContribution`); los caps
**recortan y consumen la ventana** — el déficit se pierde, no se difiere; la frontera L2 estricta hace
inskimeable cualquier fill por debajo de un `endBlockL2` ya liquidado (cerrar ventanas tras margen);
ventana de 15 minutos; un nonce en vuelo por cuenta (el keeper de beneficio debe estar apagado para esas
cuentas); y todo consumidor de `SettlementExecuted` mostrará volumen como «realizedProfit». Antes de la
primera atestación: reescribir `savingsBps` de cada cuenta activa (de % de beneficio a bps de notional)
y los tres caps a `UINT128_MAX`. Gas ≈ 516k por cobro (~1,1e13 wei ≈ 11× `minContributionWei`): a 20 bps
un lote necesita ≥ ~0,006 ETH de notional para cubrir su propio gas → cobros por lotes diarios o al
superar un umbral de deuda.

**Fase 1 — `SipVolumeExecutor` (~200–300 líneas).** Se apunta con `setSettlementExecutor`; el vault no
cambia. Diferencias que resuelven los cuatro problemas de la Fase 0: campos propios (raíz de fills,
`owed`, `collected`), **cobro aditivo** (`msg.value = min(owed, saldo − reserva)`, sin regla de máximo
exacto), **deuda arrastrada** en storage del executor, **idempotencia por raíz de lote** en su propio
storage, y **progresión sintética** hacia `acceptSettlement` (`startBlockL2 = prev+1`,
`endBlockL2 = prev+2`, `sessionId = keccak(cuenta, nonce, "sip.volume.v1")`, `ledgerRoot` = raíz de
fills) para que la frontera del vault sea un contador y un fill tardío nunca quede fuera. Los caps del
vault siguen actuando como techo (el executor pide `min(owed, techo)` y arrastra el resto). Gas **medido** (Foundry): 445k por cobro en una cuenta ya establecida y 614k en el
primero — la mitad del vault domina, no los 150–250k que estimé antes de escribirlo. Tests: unitarios, fork contra un vault vivo re-apuntado, invariante «executor sin
saldo entre transacciones», lote duplicado rechazado, fill tardío cobrado.

### 4.5 El vault, con N wallets

- N cuentas por vault es gratis en el contrato: mapping sin tope, contador `uint64`, liquidación O(1);
  invitar + aceptar ≈ 312k gas por wallet extra (207k + 105k medidos). La lista de wallets **solo se
  reconstruye desde eventos** — la web mantiene su registro.
- **Admin ≠ wallet de trading**, siempre (`VaultFactory.sol:242-245`): el usuario tiene una *pension
  key* dedicada que nunca opera. Es la clave que retira; que no sea la caliente es una virtud.
- **Cap agregado de 30 días compartido y por orden de llegada:** la wallet A lo consume, la B queda
  recortada (test `SettlementExecutor.t.sol:346-360`). Para volumen: `UINT128_MAX`, o N × cap por wallet.
- Revocar + reinvitar conserva el consumo rodante y el nonce; mover una wallet entre vaults del mismo
  usuario no existe (un vault por admin).
- El titular de la clave puede `setMySavingsBps(0)` y `revokeMyTradingAccount` sin el admin. **No hay
  participación solo-admin y no conviene inventarla**: es su pensión. La UI lo muestra.

### 4.6 Inversión

Sin cambios respecto a la v1 del informe: umbral y cesta on-chain (`minInvestmentWei`, cesta hasheada,
caps), `invest()` los impone; disparo (1) con el usuario presente desde la web, (2) crank del keeper en
modo `invest` por cursor de `ContributionReceived` cada 5 minutos, con el asiento Privy *invest-only*.
El observador y el crank son el mismo proceso.

### 4.7 Servidor residual

| | Hoy | Propuesta |
| --- | --- | --- |
| Procesos | web + supervisor siempre encendido (lock Postgres) + Postgres | web sin estado + **un** worker cada 5 min (observar, atestar, cobrar, invertir) + Postgres pequeño (cursor, deuda, read model desde logs) |
| RPC | archivo + tracer | Alchemy PAYG; archivo confirmado en 4663 o retraso máximo ~20 min; sin tracer |
| Reposo por wallet/día | decenas de miles de llamadas, 1.440 filas | ~1 llamada, 0 filas |
| Wallet activa (5 trades/día) | — | ~25–35 llamadas, 1 cobro (~4 llamadas + gas) |
| 1.000 wallets activas | — | ≈ 25–35k llamadas/día ≈ 16–22M CU/mes ≈ **7–10 $/mes** |
| Secretos | atestador, Privy secret + clave de autorización, Supabase, RPC | los mismos, **menos uno**: la clave del atestador sigue (firma volumen); rotación intacta |

### 4.8 Seguridad, honesta

- **Sigue habiendo un medidor de confianza.** La forma del modelo de amenazas no cambia: quien atesta
  puede afirmar volumen falso hasta los caps, hacia el propio vault del usuario. Lo que cambia: la
  medida es objetiva y recomputable por cualquiera (raíz de fills + residuos por bloque), el daño es
  «ahorrado de más a ti mismo» y el admin lo retira sin comisión ni pausa, y la frecuencia deja de ser
  «una sesión rentable cada cuatro compras».
- El asiento de Privy es una pretensión sobre la *ruta de firma*, nunca sobre los fondos: no puede
  impedir que la clave exportada mueva ETH antes; por eso el cobro es best-effort y no una promesa.
- Ninguna clave de servidor puede sacar dinero de un vault; el crank solo puede `invest()` a tu cesta.
- Persisten: la deny-list y pausas de los tokens de acción, USDG congelable (el executor nunca lo retiene),
  y la gobernanza del 16-08 (timelock 900 s, Safe 1-de-2) hasta el redeploy de 7 días.

### 4.9 Riesgos y mitigaciones

- **Cobertura de venues** (producto): GMGN y v4-vía-GMGN quedan cubiertos con decodificador; otros
  routers solo por residuo con rechazo; usuarios directos del fork del UniversalRouter con claims
  ERC-6909: **spike de una semana** antes de prometer nada.
- **Deuda incobrable:** wallet vaciada desde fuera → la deuda queda; mostrarla; no perseguirla.
- **Proveedor:** Free capa a 10 bloques; PAYG «ilimitado» sin límite documentado del array de topics
  (1.000 wallets ≈ 66 KB por llamada, sin filtro de dirección) — probar el fan-in; truncado silencioso
  = «menos trades», nunca error → conciliar con nonces.
- **Semántica heredada** (Fase 0): `realizedProfit` mostrará volumen en cualquier consumidor.
- **Privy:** modo TEE obligatorio; límite de importadas sin documentar; una política por firmante.
- **Gas frente a skims pequeños:** lotes por wallet diarios o por umbral de deuda; medir el gas de la
  Fase 1 en fork antes de fijar cadencia.

### 4.10 Migración

1. **Semana 0:** rotar cada credencial pegada. Pedir por escrito a Privy (importadas por usuario, TEE) y
   a Alchemy (PAYG + archivo en 4663). Spike de una semana: fork del UniversalRouter con claims.
2. Observador + atestación de volumen + cobrador sobre las piezas del keeper (`discovery.ts`,
   `privy-signer.ts`, `submit.ts`, `read-model.ts`, `rpc/failover`), con fixtures grabadas de mainnet
   como hace `session-engine` (`recordingRpcClient`).
3. **Fase 0** con las wallets del equipo sobre la topología 16-08: re-política de cuentas (bps de
   notional, caps a `UINT128_MAX`), keeper de beneficio apagado para ellas, cobros diarios, comparación
   de lo atestado con un recálculo independiente.
4. `SipVolumeExecutor`: escribir, fork-testear, desplegar en 4663, **verificar código**, re-apuntar vaults
   (`setSettlementExecutor` + `setLocalPause(false)`), política de Privy con la nueva ABI.
5. Web: onboarding con pension key + N wallets (crear/importar/exportar), vista «apartado / cobrado /
   pendiente» por wallet, checklist de armado, inversión con usuario presente.
6. Retirar `session-engine` (salvo primitivas), la liquidación de beneficio del keeper, `aa-smoke` 4337,
   `diagnostics.ts`; archivar `ATTESTER.md`, `SETTLEMENT_SCHEMA_FINDINGS.md`; reescribir `THREAT_MODEL.md`.
7. Canario público, luego redeploy con timelock de 7 días, luego apertura.

**Esfuerzo:** observador/atestador/cobrador 3–4 semanas; Fase 0 y validación 1; `SipVolumeExecutor` +
tests + fork + despliegue 2–3; web 3; migración, runbooks, modelo de amenazas, canario 1–2. **10–13
semanas-ingeniero** más las confirmaciones externas.

---

## 5. Decisiones que necesito de ti

1. **Best-effort con arrastre.** ¿Aceptas que «por fill» signifique «apartado por fill, cobrado cuando
   la wallet tenga ETH» y que la deuda se muestre y arrastre?
2. **Formas sin notional en v1:** swaps token-por-token y multi-fill excluidos; ¿o preferimos precio de
   pool como aproximación (menos objetivo)?
3. **Venues de v1:** GMGN (decodificado) + residuo con rechazo para el resto; usuarios directos de v4
   tras el spike.
4. **Cadencia de cobro:** diaria por wallet o al superar X $ de deuda; el gas lo paga la wallet.
5. **Autonomía del usuario:** puede poner su tasa a 0 o revocarse; lo mostramos y no lo impedimos.
6. **Fase 0 sí/no:** validar con wallets del equipo sobre el executor actual antes de escribir Solidity.
7. **Router de SIP en v2** para trades dentro de la app (skim atómico) — ¿lo quieres en el roadmap?
8. **Topología:** beta en 16-08; redeploy de 7 días antes de abrir.

---

## Anexo A — Inventario de reutilización

**Contratos, tal cual:** `VaultFactory.sol` (creación relayada EIP-712/ERC-1271, `activeVaultOf`,
cohortes); `PersonalVault.sol` (custodia, binding de N cuentas, `savingsBps`, caps, ruta de inversión
`:546-778`, `setSettlementExecutor :851-862`, `acceptSettlement :945-1047`); `AttesterRegistry.sol`
(rotación por guardián/timelock — **se reutiliza para la clave que atesta volumen**); `AdapterRegistry.sol`;
los cuatro adaptadores desplegados y el desk; `ProtocolPauseController`, `GuardianOwnable`.

**Keeper, extraído o en modo reducido:** `discovery.ts` (arrays OR, chunking, cobertura, rescan),
`privy-signer.ts`/`privy-wallets.ts`/`create-privy-policy.mjs` (asiento y política con ABI fijada),
`submit.ts` (reserva de nonce → firma → journal → envío), `investment*.ts` + `quote.ts`, `read-model.ts`,
`alerts.ts`/`cycle.ts`, `config.ts` (centinela de broadcast, `Redactor`).

**session-engine, primitivas:** `rpc.ts` (backoff, harness record/replay), `failover.ts`, `chain.ts`
(caja = nativo + WETH, mapeo L1/L2), `classify.ts` (formas TRADE_BUY/TRADE_SELL/AIRDROP_IN) como base del
reconciliador, `window.ts` (decodificación de recibos con filtro de 3 topics; oráculo de nonce).

**Web (HEAD `fd927b0`):** `providers.tsx`, `InviteTradingWallet.tsx` (born seated, import con
`additionalSigners`, `judgePastedKey`, backoff de `addSigners`, lectura del flag `delegated`),
`Onboarding.tsx` (`useExportWallet`), `create-vault/route.ts`, `rpc/route.ts` (+ límite en el edge),
`addresses.ts`/`config.ts`, `serialize.ts`.

## Anexo B — Lo que se tira

`SettlementExecutor` tras la Fase 0; `session-engine` salvo primitivas (detector, window denso, quiet,
profit, inventory como enforcement, ledger-root v2); keeper: `watch.ts`, `attest.ts` (beneficio),
`reconcile.ts` fases A/B/C, `ledger*.ts` y journal encadenado, latches DEGRADED, supervisor de 60 s;
`aa-smoke`: `settlement.ts`, `permissions.ts` como ámbito de `settle`, `runtime.ts` 4337; web:
`diagnostics.ts` y sus 23 escenarios, fan-out de lecturas, rutas `saving-days`/`wallet-stats` como están;
fixtures de drills de liquidación; `SETTLEMENT_SCHEMA_FINDINGS.md`, `ATTESTER.md` (a archivo).

## Anexo C — Método

Diez agentes de solo lectura (siete lectores, tres arquitectos) y cinco verificadores adversariales, cada
uno con una afirmación que intentar refutar con el código, los tests, las fixtures grabadas de mainnet y
la documentación de Privy/Alchemy. El backend web anterior se leyó desde `git show HEAD:…`; el checkout
de Nuvem no se tocó.

## Anexo D — Verificación adversarial de la recomendación (5 afirmaciones)

| Afirmación | Veredicto | Lo que cambió en el diseño |
| --- | --- | --- |
| El volumen se mide con RPC estándar, sin tracer, por transacción | **parcial** | descubrimiento por logs ✔ (todos los fills GMGN grabados, ambos pools); compra = `tx.value` ✔; venta: fórmula por tx contaminada por el `approve` sin log del mismo bloque (+58,5 ppm), wrap/unwrap de WETH leído como trade, airdrops (gas ajeno), varios fills = neto → **reconciliador por bloque con rechazo + decodificador de eventos GMGN** (`0x8619026a`, `0x205442d6`) |
| El asiento de Privy sobrevive a la exportación y funciona en importadas | **parcial** | sin regla de revocación-al-exportar ✔; import con asiento solo en **TEE**; la clave exportada es un firmante paralelo sin política → **cobro best-effort con arrastre**; una política por firmante, tope por tx (`value lte`), ABI del executor nuevo obligatoria; releer `delegated` antes de firmar; «una importada por usuario» solo en el JSDoc del SDK |
| El executor desplegado acepta volumen sin Solidity | **parcial** | acepta `(0, Σnotional, 0, 0)` ✔ (misma «brecha» que documenta el threat model); muerden: contribución exacta viva, caps que recortan sin diferir, frontera L2 estricta (fill tardío inskimeable), 15 min, un nonce por cuenta, `realizedProfit` = volumen en todo consumidor → **Fase 0 solo para beta interna; Fase 1 aditiva** |
| Un vault admite N wallets con política propia | **parcial** | N sin tope, O(1), ≈312k gas por wallet ✔; cap agregado compartido por orden de llegada; admin nunca puede operar; lista solo desde eventos; el titular puede poner bps = 0 o revocarse → caps a `UINT128_MAX`, pension key dedicada, autonomía aceptada |
| Un observador por logs cuesta O(1) por barrido | **parcial** | cierto en Alchemy **PAYG** (rango ilimitado en Robinhood Mainnet); Free = 10 bloques (420 llamadas/barrido); sin Debug/Trace en 4663; saldo a `N−1` es archivo pasados 128 bloques; ≈ 25–35k llamadas/día y 7–10 $/mes por 1.000 wallets activas |
