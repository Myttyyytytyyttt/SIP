# Modo volumen en SaverFi — auditoría verificada (2026-09-25)

Auditoría de solo lectura: cuatro lecturas en paralelo (programa, keeper, web, mainnet), una síntesis y un verificador adversarial. Las cuatro correcciones del verificador ya están incorporadas.

JSON completo, mientras exista la carpeta temporal: `/private/tmp/claude-501/-Users-walch-ProyectosCT-SIP/b07742ac-beba-4b7f-8527-da5301c202c6/tasks/wkrvapsls.output`. Scripts de verificación: `…/scratchpad/volume-audit/verify/`.

## Resumen

Hoy no se puede cobrar por volumen, aunque el programa en la cadena ya lo soporta sin cambios. Falta la medida de volumen del keeper y la capa de producto de la web.

## Programa `sip_vault` (6kA9H9zQT6PW5xWkXoAFCS3NotxarzaYqj66mjMf9w4J): listo

**Qué guarda el vault** (state.rs:32-64):
- `skim_mode` (0 = beneficio, 1 = volumen), `skim_bps` y `volume_bps`;
- `policy_nonce`, `max_contribution` y `wallet_reserve`.

**Rangos** (state.rs:74-77): beneficio 201..=10000 bps, volumen 1..=200 bps. `validate_policy` los comprueba al crear el vault y en cada cambio de política.

**Cómo cobra `settle_v2`:**
- Aplica `active_bps()` (state.rs:82-84, settle.rs:107).
- Calcula `owed = floor(base × bps / 10000)` y paga `paid = min(owed, max_contribution)` (settle.rs:130-136). El cálculo es idéntico en los dos modos. En volumen, `base_lamports` es el nocional.
- La atestación (SIP_SETTLE_V2, 171 bytes) incluye modo, bps y `policy_nonce`, reconstruidos desde la cadena (settle.rs:108-127). Si el modo no coincide, falla con `SkimModeMismatch` (settle.rs:86).

**Lo que pasa en casos límite:**
- **Recorte por el tope:** lo que supera `max_contribution` no se arrastra al siguiente cobro (settle.rs:133-136, events.rs:5-7). La frontera avanza igual (settle.rs:174): ese dinero se pierde para la cadena.
- **Reserva de la wallet:** si pagar dejaría la wallet por debajo de renta + `wallet_reserve`, el cobro se rechaza entero, sin recortarlo (settle.rs:142-148). La frontera no se mueve. Cuando la wallet vuelve a tener SOL, la ventana se cobra de una vez, y lo que exceda el tope en ese cobro único se pierde.
- **Sin límites de frecuencia:** no hay límite por día ni tiempo de espera entre cobros.

**Cambio de modo.** `set_policy_v2(mode, skim_bps, volume_bps, paused, max_contribution, wallet_reserve)`:
- Solo lo firma el dueño del vault. Reescribe los 6 campos y siempre sube `policy_nonce` (set_policy.rs:6-40).
- No toca el TradingLink: epoch, nonce y frontera continúan.
- Invalida las atestaciones firmadas antes del cambio.
- Toda la ventana pendiente se cobra en el modo nuevo.

**Tests que existen:**
- vector golden con modo 1 a 20 bps;
- límites de los rangos y rechazos por modo incorrecto;
- settles de volumen a 20 y 200 bps después de cambiar a volumen un vault ya vinculado (tests/settle.ts:405-450).

**Tests que faltan:**
- volumen recortado por el tope;
- base cero o redondeada a cero;
- la suite de revisión adversarial z-review-settle-link.ts en modo volumen (hoy crea todo en modo beneficio, :154).

## Keeper: no sabe cobrar volumen

**Por qué se para.** En producción el volumen lo decide `defaultVolumeBase = measured.successfulTradeCount === 0 ? 0n : null` (settle-decision.ts:261), y bin/keeper.mts:1391-1401 no le pasa otra fuente. Con `null`, la ventana queda en `UNSUPPORTED_MODE` (settle-decision.ts:602-610): no se firma nada y se queda así para siempre. La pieza real, "keeper-medir-volumen", no existe; solo aparece en comentarios.

**La medida que ya existe.** `tradedLamports` (measure-window.ts:282, 503-515) se calcula solo para la tabla de clasificación (keeper.mts:1475). El propio código la marca "MEASURED, NEVER ATTESTED" (measure-window.ts:271-275). Hoy cuenta el delta de SOL de cualquier transacción que salga bien y no sea una transferencia simple, sin la comisión de red. Si se usara para cobrar:
- **Cobraría de más:**
  - envolver y desenvolver SOL (10 SOL cuentan como ~20 SOL de volumen);
  - la renta de cuentas de token al abrirlas y otra vez al cerrarlas;
  - SOL enviado con Memo, NFT, puentes y staking.
- **Un desconocido puede inflarlo:** no mira quién firmó, así que un crédito de un tercero a través de un programa cuenta como volumen.
- **Cobraría de menos:**
  - los swaps sin tramo en SOL (pares USDC, token a token) y los hechos desde una cuenta WSOL persistente cuentan 0;
  - una compra y una venta en la misma transacción cuentan solo por la diferencia.
- **Precisión en los trades reales del dueño:** error menor del 0,6 %. Es +0,58 % frente a los flujos netos del pool (4,036 SOL) y −0,08 % frente a los brutos (4,063 SOL).

**Otros huecos:**
- Ningún test pasa transacciones reales por `measureSince` para comprobar `tradedLamports`.
- No hay mínimo ni frecuencia fija de cobro en modo volumen: habría un cobro por cada ráfaga de trades.
- No hay equivalente de LossCarry para volumen. LossCarry existe solo en modo beneficio (settle-decision.ts:314-339).
- Nada gestiona un cambio de modo a mitad de ventana.
- Aviso del propio código (settle-decision.ts:153-158): nada en la cadena rechaza una cifra de BENEFICIO firmada para un vault de VOLUMEN. La única protección es que la fuente de volumen sea la única que produce la base en ese modo.

## Web: bloqueado

**Dónde está el bloqueo:**
- `VOLUME_MODE_OFFERED = false` (solana-core/src/client/product.ts:96).
- El servidor rechaza el modo 1 con `volume_not_offered` al crear el vault y al cambiar la política (build-handler.ts:506, :588). Ese rechazo también bloquearía pausar o cambiar límites de cualquier vault en modo volumen creado fuera de la web.

**Lo que ya está listo por debajo:**
- `rules.ts` refleja los rangos del programa.
- `builders.ts` pasa el modo y `volume_bps` a `create_vault_v2` y `set_policy_v2`.
- Los decoders, las filas de actividad, el panel en vivo y las estadísticas ya distinguen el modo 1.

**Lo que falta:**
- No hay dónde poner el % de volumen: `CreateRequest` y `createVaultFlow` no lo llevan (vault-flows.ts:324-341), y el onboarding solo ofrece beneficio (onboarding.ts:108-114).
- No hay control para cambiar el modo. VaultCard y LiveRulePanel reenvían el modo guardado; LiveRulePanel escribiría `volume_bps` en un vault de volumen, pero el servidor lo rechaza.
- Las marcas `volumeNotOffered` se calculan pero no se muestran (live-model.ts:120).

**Textos que prometen de más:** la portada dice "2% of its volume or 20% of its realized profit, yours to set" (landing.tsx:601) y el pie algo parecido (site-footer.tsx:93).

**Dos cifras de volumen distintas:** el "Volume" del panel suma las bases atestadas (live-model.ts:685); el "Traded" de la clasificación usa `tradedLamports`. Habrá que reconciliarlas.

## Mainnet

**Cuentas:** hay un solo Vault (EFXK995…, del dueño B6T4fT…) y un solo TradingLink (FksGnd…, wallet 9QX53J…; epoch 447945418, nonce 2, frontera 449756435).

**El vault del dueño:**
- Modo 0 al 2500 bps, con `volume_bps` 200 guardado.
- `policy_nonce` 1, `max_contribution` 0,06 SOL, `wallet_reserve` 0,05 SOL, `lifetime_saved` 65.007.341 lamports.

**Historial del programa:** 27 transacciones, ninguna fallida. Los 2 settles fueron en modo 0. Nunca ha habido un vault en volumen.

**Los 4 trades del dueño del 23-09** (Axiom/pump.fun, tx v1): `tradedLamports` = 4.059.833.580 lamports (≈ 4,06 SOL); beneficio neto 0,1135 SOL.

| Modo | Cobro |
|---|---|
| Beneficio al 25 % (real) | 0,028373 SOL |
| Volumen al 0,5 % | 0,0203 SOL |
| Volumen al 1 % | 0,0406 SOL |
| Volumen al 2 % | 0,0812 SOL debidos; con el tope de 0,06 SOL se pagan 0,06 y se pierden 0,0212 |

## Trabajo pendiente (casi todo toca el camino del dinero)

1. **Decisión del dueño, escrita como vector de test:** qué cuenta como volumen.
   - ¿Solo transacciones firmadas por la wallet? ¿Solo swaps?
   - ¿Solo el tramo en SOL, o también se ponen precio a los tramos en token (pool o Pyth)?
   - ¿Entran comisiones, propinas y renta? ¿Cuentan compra y venta?
2. **La medida real** ("keeper-medir-volumen") y su conexión al cobro (1–2 días).
3. **Tests** con transacciones reales guardadas y con casos trampa: wrap/unwrap, renta, Memo, swap fallido, crédito de un desconocido.
4. **Tope en modo volumen:** subirlo, cobrar más a menudo, o que el keeper guarde lo pendiente. Guardarlo en la cadena exigiría actualizar el programa.
5. **Mínimo o frecuencia de cobro.**
6. **Cambio de modo:** cobrar lo pendiente antes de cambiar.
7. **Web:** elegir el modo y el %; avisar de que se paga también los días en que se pierde; mostrar una estimación del cobro.
8. **Tests del programa en modo volumen:** recorte por el tope, base cero y la suite de revisión en volumen.
9. **Al final**, encender `VOLUME_MODE_OFFERED` y actualizar los 3 tests que lo fijan y los textos ("Coming soon", "would be put aside"). Solo cuando la medida esté en producción.
10. **Reconciliar** "Traded" de la clasificación con el volumen cobrado.
