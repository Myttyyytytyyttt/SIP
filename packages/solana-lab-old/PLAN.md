# Nuvem en Solana — el laboratorio

**Fecha:** 18 de agosto de 2026 · **Estado del repo:** tras `4985e44`
**Toolchain verificado en esta máquina:** cargo 1.94.1 · solana-cli 3.1.12 (Agave) · anchor-cli 0.32.1 · avm 1.0.0-rc.5

---

## ⚠️ Si estás leyendo esto sin contexto

Este documento existe para que **cualquier instancia futura de Claude (u otra
persona) pueda continuar esta construcción sin la conversación que la originó**.
Léelo entero antes de escribir código. Las decisiones de aquí no son
preferencias estéticas: cada una cierra una investigación que está documentada
en [`reports/SOLANA_2026-08-17.md`](../../reports/SOLANA_2026-08-17.md) — léelo
también; contiene las direcciones verificadas en mainnet, los números de
liquidez y las trampas de Token-2022.

**Qué es Nuvem:** en Robinhood Chain (Arbitrum Orbit L2, chainId 4663), Nuvem
aparta una parte del beneficio de trading *realizado* de un usuario hacia un
vault de ahorro personal del que solo él puede retirar, y el vault compra
acciones tokenizadas por sí solo. Los contratos viven en `packages/contracts`,
el servicio off-chain en `packages/keeper-old`, la medición de sesiones en
`packages/session-engine-old`, y el dashboard en `packages/web`.

**Qué es esto:** el mismo producto, en Solana. Este directorio es un
**laboratorio aislado**: nada de `packages/*` lo importa, está excluido del
workspace de pnpm (ver `pnpm-workspace.yaml`), y no toca ningún deploy.

---

## 1. Las restricciones del producto (fijadas por el dueño, no negociables aquí)

1. **Permissionless de base.** Sin KYC, sin allowlist. Cualquier wallet anónima
   crea su vault.
2. **El usuario opera DONDE QUIERA.** Crea la trading wallet en nuestra web
   (Privy embebida), **exporta la clave privada** y la usa en Axiom, Photon,
   BullX, bots de Telegram, lo que sea. Nuestro programa **nunca ve sus
   trades**. Esto mata cualquier diseño tipo "opera a través de nuestro swap"
   (se evaluó un `swap_and_skim` atómico y quedó **descartado** por esta
   restricción exacta).
3. **Los profits llegan solos al vault.** El usuario no ejecuta nada. Un keeper
   mide, un attester firma, la wallet empuja (firmada vía Privy).
4. La web de integración es **`packages/web`** (la de testing).
   `packages/website-oficial` NO se toca — es para cuando esté 100% funcional.

## 2. El modelo, decidido

Es el modelo de Robinhood Chain, portado. No una reinvención.

```
usuario crea vault (PDA) ──► enlaza trading wallet (Privy, exportable)
                                      │
                     usuario exporta la clave y tradea en Axiom/Photon/etc.
                                      │
        keeper observa la wallet ──► mide una SESIÓN cerrada (delta de SOL,
                                     neto de flujos externos)
                                      │
        attester firma la atestación (Ed25519)
                                      │
        keeper manda settle() FIRMADO COMO LA WALLET (Privy signer)
        → el programa verifica la firma y transfiere la parte al vault PDA
                                      │
        keeper (crank, keypair normal) llama invest()
        → el vault compra xStocks vía CPI con suelo por delta de saldo
```

### Decisiones cerradas y su porqué

| decisión | elección | por qué |
|---|---|---|
| Disparador | **beneficio de sesión atestado** (como RH), no skim en el swap | restricción 2: el usuario opera fuera; no vemos sus swaps |
| Unidad de medida | **SOL, en caja** — `cashEnd − cashStart − depósitos + retiradas` | es EXACTAMENTE lo que hace `SettlementExecutor.calculateRealizedProfit` en RH (ver `packages/contracts/src/settlement/SettlementExecutor.sol:93`). Sin coste base por token, **sin oráculo de precios en el camino del dinero**. El precio solo pinta dólares en la UI |
| Custodia de la trading wallet | **Privy** (wallet embebida Solana + signer nuestro + política) | verificado en docs: `useExportWallet` existe para Solana y el export da una COPIA — el signer de la app sobrevive. El default de Privy ya permite exportar |
| Política de Privy | `programId in [nuvem_vault, ComputeBudget, Ed25519]` | Privy en Solana NO puede fijar el discriminador de instrucción (solo programId), pero no lo necesita: el DESTINO de los fondos lo garantiza el programa (TradingLink → vault). La tx de settle es pequeña → **sin ALTs** → no aplica el fallo documentado de Privy con ALTs |
| Firmante de `invest` | **crank permissionless** — un keypair normal del keeper, SIN Privy ni Turnkey | el vault PDA firma sus propios movimientos con `invoke_signed`; la autoridad viene del estado que el owner firmó (política/topes), no del firmante de la tx. El crank solo elige el momento y pasa el minOut |
| Activo puente | **USDC** (no USDG) | USDC es el quote de todos los pools líquidos de xStocks; no existe pool USDG/stock en Solana (verificado: `NO_ROUTES_FOUND`). USDG en Solana además lleva permanentDelegate de Paxos |
| Venue de invest v1 | **CPI directo a Raydium CLMM** (Jupiter después) | toda la liquidez xStocks está en Raydium CLMM; Jupiter mete rutas opacas + ALTs. El minOut se hace cumplir midiendo el delta de saldo del token account antes/después del CPI |
| Anti-scam de mints | **registro de mints permitidos, resolución SIEMPRE por dirección** | existen impostores en pump.fun ("Apple (Ondo Tokenized)" con 10⁹ supply). El pinning de pools de RH aquí se reancla: de "este pool" a "este mint, este destino, este delta" |
| Bridge entre cadenas | **NINGUNO en el camino del dinero** | investigado (deBridge/Relay/Across soportan RH chain — pero $2,44 fijos en deBridge sobre skims pequeños, Relay barato pero intermitente, y puentear convierte exposición en la misma exposición). Como mucho: enlace manual en la UI a un bridge externo |
| UX multichain | **un vault conceptual, custodia por cadena** | vault RH y vault Solana separados por detrás; la web agrega y muestra un total en USD (el precio solo para MOSTRAR, nunca para mover) |

## 3. Los datos verificados que este código asume

Verificados contra mainnet el 17-18/08/2026 (detalle y método en
`reports/SOLANA_2026-08-17.md`). **Caducan — re-verificar antes de mainnet.**

### Mints xStocks (Token-2022, programa `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`)

| ticker | mint | liquidez (ago-2026) |
|---|---|---|
| NVDAx | `Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh` | $2,04M |
| SPYx | `XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W` | $2,04M |
| TSLAx | `XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB` | $0,84M |
| AAPLx | `XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp` | $0,33M |
| CRCLx | `XsueG8BtpquVJX9LVLLEGuViXUungE6WmK5YZ3p3bd1` | $2,91M |
| METAx | `Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu` | — |

Extensiones (idénticas en todos): `transferHook` presente pero `programId: null`
(NO se ejecuta), `defaultAccountState: initialized` (ATAs de PDA funcionan al
instante), `permanentDelegate: 5aMNNLQJwAEeoemTEMkv5NVjqKwvvefRYCQ5Z67HFvEq`
(**Backed puede confiscar de cualquier cuenta — riesgo asumido y comunicado en
la UI**), `freezeAuthority: JDq14BWvqCRFNu1krb12bcRpbGtJZ1FLEakMw6FdxJNs`,
sin transferFee.

### Otros

| qué | dirección |
|---|---|
| USDC (Solana) | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |
| Pool Raydium CLMM USDC/NVDAx (verificado con custodia) | `49iMatQtoyabsYAQc8GafVq6aeBFVDxSRH44oiatyyw6` |
| Programa Raydium CLMM | `CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK` |
| Token-2022 | `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb` |
| Ed25519 precompile | `Ed25519SigVerify111111111111111111111111111` |

### Límites de runtime que condicionan el diseño

- **64 cuentas por transacción** → la cesta multi-pata NO puede ser atómica; v2
  usará una `InvestmentIntent` PDA + una tx por pata. V1 es single-leg.
- 1,4M CU por tx; una ruta real de 2 saltos midió 209k CU → holgura 6×.
- Reasignar el owner de una cuenta exige que esté **a ceros** → la migración
  entre programas debe existir en el programa VIEJO antes de necesitarse. Por
  eso `version` + `_reserved` en cada cuenta desde el día 1.

## 4. Trampas conocidas (cada una costó una corrección en la investigación)

1. **`scaledUiAmount` en xStocks:** saldo bruto ≠ derecho. Y el multiplicador
   efectivo es `newMultiplier` cuando su timestamp ya pasó — leer `multiplier` a
   secas está silenciosamente mal (el primer informe cayó exactamente ahí con
   SPYx). Los topes deben denominarse conscientes de esto.
2. **ATAs de Token-2022** se derivan con el program id de Token-2022, no el de
   SPL Token. Usar siempre `transfer_checked`.
3. **`paused: true` en el mint** = parada dura para invest **y** para withdraw
   de ese token (el SOL del vault sigue retirable — por eso withdraw de SOL
   nunca pasa por un swap).
4. **`getSignaturesForAddress` NO indexa las ATAs del wallet** — un depósito de
   token externo es invisible por RPC estándar. El session-engine necesita
   Helius `getTransactionsForAddress` (con `tokenAccounts`) + un segundo camino
   (Yellowstone/Geyser persistido) que NO sea el mismo proveedor.
5. **Retención:** un nodo estándar guarda ~2-3 días. El ledger completo >400TB.
6. **Privy Solana + ALTs:** la evaluación de política FALLA si la tx usa
   Address Lookup Tables (literal de sus docs). La tx de settle no las necesita.
   La de invest no pasa por Privy (crank), así que tampoco importa.
7. **Resolución por símbolo = scam.** Siempre por mint address.
8. **Rent refunds al cerrar ATAs** aparecen como SOL entrante en la wallet del
   trader — el session-engine debe clasificarlos como devolución, no beneficio.

## 5. El programa: `nuvem_vault`

### Cuentas (PDAs)

```rust
// seeds = ["vault", owner]
pub struct Vault {
    pub owner: Pubkey,
    pub bump: u8,
    pub version: u8,            // ver §3: la migración exige versionar desde el día 1
    pub paused: bool,
    pub skim_bps: u16,          // parte del beneficio de sesión que se ahorra
    pub lifetime_saved: u64,    // lamports, monotónico — el equivalente de
                                // aggregateLifetimeContributions y el ancla del
                                // anti-doble-liquidación del keeper
    pub created_at: i64,
    pub _reserved: [u8; 64],
}

// seeds = ["link", wallet]  ← POR WALLET: la unicidad global "una wallet, un
// vault" que en RH cuesta tres mappings en la factory, aquí ES la derivación.
pub struct TradingLink {
    pub wallet: Pubkey,
    pub vault: Pubkey,
    pub epoch: u64,             // slot de creación. El equivalente de
                                // bindingEpoch en RH: la atestación lo firma,
                                // así que un link cerrado y recreado invalida
                                // toda atestación anterior aunque el nonce
                                // vuelva a cero.
    pub settlement_nonce: u64,  // monotónico; sustituye a usedSessions
    pub frontier_slot: u64,     // watermark: sesiones que terminan ≤ aquí ya liquidadas
    pub bump: u8,
    pub _reserved: [u8; 32],
}
```

El ahorro en SOL vive **en los lamports del propio Vault PDA** (un programa
puede debitar lamports de cuentas que posee). Las posiciones en stocks viven en
ATAs de Token-2022 cuyo owner es el Vault PDA.

### Instrucciones

| instrucción | firmantes | qué hace |
|---|---|---|
| `create_vault(skim_bps)` | owner | init del Vault PDA |
| `link_wallet` | **owner Y wallet, en la misma tx** | init del TradingLink. El baile invite/accept EIP-712 de RH colapsa a una transacción con dos firmantes |
| `unlink_wallet` | owner o wallet | **cierra** la cuenta (rent al owner). Re-enlazar crea epoch nuevo → atestaciones viejas muertas |
| `settle(attestation)` | la trading wallet (vía Privy) | verifica por **introspección** que la instrucción Ed25519 anterior en la misma tx validó la firma del attester sobre `(wallet, vault, epoch, nonce, session_start_slot, session_end_slot, profit_lamports)`; comprueba nonce y frontera; CPI System transfer wallet→vault de `profit × skim_bps / 10_000`; avanza nonce y frontera |
| `invest(amount, min_out)` | crank (cualquiera) | v1 single-leg: CPI a Raydium CLMM USDC→stock. El minOut se hace cumplir midiendo el saldo de la ATA destino antes/después. Topes per-call y rolling 30d como en RH |
| `withdraw(amount)` | owner | debita lamports del vault al owner. **NUNCA pasa por un swap** (riesgo del transfer hook: si Backed lo activa mañana, el SOL sigue saliendo) |
| `withdraw_token(mint, amount)` | owner | transfer_checked de la ATA del vault a la del owner |
| `set_policy(...)` | owner | skim_bps, pausa, política de inversión |

**Forma de la tx de settle** (sin ALTs, a propósito):

```
[ ComputeBudget | Ed25519SigVerify(attestation, attester_pubkey) | nuvem_vault::settle ]
```

La verificación Ed25519 la hace el precompile; `settle` solo comprueba, vía el
sysvar `Instructions`, que la instrucción anterior es del programa Ed25519 y
verifica exactamente los bytes de esta atestación con la pubkey del attester
configurada. Es el patrón estándar de Solana para firmas off-chain (el
precompile no es llamable por CPI).

### Lo que NO está en v1, a propósito

- Cesta multi-pata (límite de 64 cuentas → `InvestmentIntent` PDA en v2)
- Gobernanza/cohortes (la upgrade authority del lab es un keypair; Squads +
  timelock cuando sea producto)
- Jupiter (v2, cuando el single-leg contra Raydium esté probado)
- Atestador rotativo (uno fijo, como en RH hoy)

## 6. Estructura de carpetas

```
packages/solana-lab-old/
  PLAN.md                       ← este documento
  program/                      ← workspace de Anchor
    Anchor.toml
    programs/nuvem-vault/
      src/
        lib.rs                  declaración del programa
        state.rs                Vault, TradingLink
        errors.rs
        instructions/           una por fichero
    tests/                      TS (mocha) contra validador local
  harness/                      ← scripts TS independientes
    clone-fixtures.sh           qué clonar de mainnet para el validador local
    session-spike/              ← milestone 4: el experimento de medición
```

**El equivalente de los fork tests de RH:** `solana-test-validator --clone`
trae los mints de xStocks, el pool CLMM y el programa de Raydium a un validador
local — swap real contra estado real, gratis. Lo único inclonable es Jupiter
(rutas dinámicas de API), otra razón por la que v1 va contra Raydium directo.

## 7. Milestones y estado

- [x] **M1 — andamio:** `create_vault` + `link_wallet` + `unlink` + `withdraw`
      + `set_policy`. **Hecho 2026-08-18: 11 tests pasando contra validador
      local** (`cd program && anchor test`). Nota: el runner es
      `mocha --import=tsx` porque ts-mocha está roto bajo node 20; y los
      handlers llevan nombre propio (`create_vault_handler`…) porque el macro
      `#[program]` exige glob re-exports en `instructions/mod.rs` y cinco
      `handler` colisionarían.
- [x] **M2 — settle:** HECHO 2026-08-18. Atestación de 168 bytes
      (`attestation.rs` + espejo TS en `scripts/attestation.ts`, fijados entre
      sí por los tests e2e), verificación Ed25519 por introspección con la
      tabla de offsets tratada como entrada hostil, ventana de sesión sobre la
      frontera, y el CPI del transfer con la firma de la wallet atravesándolo.
      **10 tests, todos los rechazos mueren por su error exacto**, incluido el
      de la resurrección por epoch (link cerrado y recreado rechaza las
      atestaciones de su vida anterior). El mensaje se reconstruye DESDE EL
      ESTADO DE LA CADENA — el caller solo aporta ventana y profit — así que
      replay, cross-wallet y epoch viejo colapsan en una comparación.
      **El drill (`npx tsx scripts/drill.ts`) juega el flow entero** contra el
      validador local: config → vault → link → sesión simulada → atestar →
      settle, idempotente y repetible; imprime las direcciones para la tarjeta
      del DevPanel, que ahora también lee el TradingLink (nonce y frontera — el
      cursor visible).
- [x] **M3 — invest, la superficie de guardas:** HECHO 2026-08-18. El port
      funcional de RH: `set_invest_policy` con la validación de _validateBasket
      (pesos = 10000, ≤8 patas, sin duplicados, suelos no-cero, min ≤ perCall ≤
      rolling), topes de 31 cubos rodantes con el mecanismo exacto de RH,
      contador vitalicio, y `invest` como **crank permissionless** — sin Privy
      ni Turnkey: la política firmada por el owner es la autoridad, el caller
      solo elige el momento. El suelo reanclado: venue pinneado por programa +
      **delta medido** en la ATA destino (reload tras el CPI), y el suelo del
      crank nunca puede ser más laxo que el `min_out_rate_wad` del usuario.
      12 tests, target en **Token-2022 de 8 decimales** (la forma de xStocks).
      El venue de test es `programs/toy-venue`: un AMM real de juguete que
      puede rellenar corto A DEMANDA — la prueba del delta guard que Raydium
      honesto nunca daría. Nota de stack: las cuentas de Invest van en `Box`
      (el struct reventaba el frame de 4KB).
      ACTUALIZADO 2026-08-22 (punto 1): `invest` se rehízo VENUE-AGNÓSTICO —
      recibe `venue_data` + `remaining_accounts`, presta solo la firma del
      vault PDA, y MIDE dos deltas (gasto ≤ amount_in y fill ≥ min_out). Se
      añadió `wrap_sol` (SOL→wSOL, la pata que faltaba antes de USDC). El toy
      venue ahora tira del input y empuja el output como el swap_v2 real, con
      diales de mala conducta para probar AMBOS guards (FillTooSmall +
      Overspent). 35 tests.
      **COMPRA REAL PROBADA EN LOCAL, SIN GASTAR:** `scripts/fork.sh` clona el
      pool NVDAx/USDC de mainnet + Raydium CLMM en un validador local, fabrica
      una ATA de USDC pre-fondeada para el vault (un clon no tiene mint
      authority), y `invest` compró **0,0232 NVDAx con 5 USDC** vía el swap_v2
      REAL (`scripts/raydium-swap.ts`, cada byte leído de un swap capturado de
      mainnet). Reproducible.
      **CADENA COMPLETA CERRADA 2026-08-22** (`scripts/fork-e2e.ts`, fase 5 de
      `fork.sh`): sesión simulada → **profit MEDIDO del historial** (no
      declarado: `scripts/measure-session.ts`, el M4 hecho módulo) → atestado →
      settle → wrap SOL→wSOL → **convert wSOL→USDC** (instrucción `convert`
      nueva, mismo guard-shape que invest, floor propio `min_convert_rate_wad`
      firmado por el owner; NO toca los buckets — convertir no es gastar) →
      invest USDC→NVDAx. Ambos saltos por pools REALES clonados de mainnet.
      Medido: 0,8 SOL de profit → 0,16 al vault → 15,05 USDC → 0,0698 NVDAx.
      Lección de layout: los slots [8]/[9] de swap_v2 son POSICIONALES (SPL
      Token y Token-2022 siempre), no "el programa de cada mint".
      **RENT VERIFICADA EMPÍRICAMENTE:** `solana program close` devolvió
      2,79171864 SOL al céntimo. PERO el program id cerrado **no se puede
      reutilizar** ("has been closed, use a new Program Id") — cerrar y
      redesplegar exige id nuevo.
      **KIT DE MAINNET LISTO 2026-08-22** (`scripts/mainnet.sh`, runbook en
      `../MAINNET.md`): preflight/deploy/status/drill/close. El deploy llama
      init_config en el mismo aliento (first-caller-wins); el drill corre la
      cadena entera contra mainnet vivo con RUTAS EN VIVO
      (`scripts/live-route.ts`: lee el swap_v2 más reciente del pool — los
      fixtures capturados no valen en mainnet porque el precio movió los tick
      arrays). Verificado contra mainnet real: ambas rutas se obtienen, el
      preflight corre. Lecciones: los datos de instrucciones INTERNAS van en
      base58 (no base64), y los índices de cuenta se resuelven con
      MessageAccountKeys.get() — un concat manual ordena mal con ALTs.
      Falta solo del keeper real: cotizar con scaledUiAmount y suelos finos.
- [x] **M4 — spike del session-engine:** CERRADO 2026-08-22 con dos wallets reales
      (`harness/session-spike/measure.ts`). Contra una wallet real de mainnet
      (trader de Jupiter descubierto en vivo, 50 tx): **la cadena de saldos
      pre/post aguantó con 0 roturas** — el oráculo de completitud que
      sustituye a quiet.ts funciona con RPC público, sin indexador. Fórmula de
      RH aplicada (cashΔ − dep + wd), sesiones por huecos de 30 min,
      clasificación por programa (Jupiter/pump.fun/Raydium/Orca/Meteora,
      transfers, token-ops, "other" contado honesto).
      SEGUNDA WALLET (real, del dueño del producto): 80 tx de ENERO a AGOSTO
      2026, oráculo con 0 roturas a través de 7 meses, 0 sin clasificar, 27
      sesiones. La división depósito/retirada demostrada en vivo: sesiones con
      cashΔ negativo y retirada externa igual dieron profit 0 — mover SOL
      fuera no es perder, y la fórmula lo sabe. Suma de sesiones positivas
      ≈25,8 SOL: con skim del 20% el vault habría ahorrado ≈5,2 SOL.
      **El criterio de parada se levanta: el producto es medible.**
      Deuda restante (para el keeper real, no para el spike): depósitos de
      TOKEN externos (inflan profit al venderse — necesita historia
      token-aware de Helius), y ventanas de 200+ tx contra rate limits.
- [ ] **M5 — Privy real:** wallet Solana + signer + política de programId +
      export, y un settle firmado end-to-end. La única afirmación de este plan
      que viene de docs y no de código corrido.
- [ ] **M6 — mainnet:** $30-50, ciclo entero: sesión real → settle real →
      invest real → NVDAx en el PDA.
- [~] **M7 — web:** EMPEZADO ANTES DE TIEMPO A PROPÓSITO (2026-08-18), como
      rendija de observación: `packages/web` ya tiene `src/lib/solana.ts`
      (lector sin dependencias, fijado contra bytes reales por
      `scripts/check-solana-decode.mts`, cableado en prebuild), la ruta
      `/api/solana`, y una tarjeta "Solana lab" en el DevPanel que lee un vault
      por dirección. Config por `NUVEM_SOLANA_RPC_URL` +
      `NUVEM_SOLANA_PROGRAM_ID`, apagada por ausencia, INVALID ruidoso.
      **Pendiente de M7 de verdad:** identidad (Privy multi-chain), vista
      agregada "un vault", y regenerar fixtures tras cada cambio de state.rs.
      La derivación de PDA desde el owner quedó fuera adrede (necesita sha256 +
      on-curve check); la entrada es la dirección del vault.

## 8. Integración con `packages/web` (M7, diseño)

- Nuevo `src/lib/solana.ts` espejo de `vault.ts`: lee el Vault PDA y el
  TradingLink por RPC (server-side, como todo en esa app).
- Env nuevas: `NUVEM_SOLANA_RPC_URL`, `NUVEM_SOLANA_PROGRAM_ID`,
  `NUVEM_SOLANA_USDC`, `NUVEM_SOLANA_STOCK_MINTS` (mismo formato que
  `NUVEM_STOCK_TOKENS`).
- La tarjeta del vault muestra **un total** en USD con desglose RH/Solana y
  retirada por cadena. El precio SOLO para mostrar.
- El flujo "crear trading wallet + exportar" reusa `InviteTradingWallet.tsx`
  como referencia de UX, con Privy Solana (`@privy-io/react-auth/solana`).

## 9. Cómo continuar si esta sesión murió

1. Lee este documento y `reports/SOLANA_2026-08-17.md`.
2. `cd packages/solana-lab-old/program && anchor build && anchor test` te dice en
   qué estado quedó M1.
3. El checklist de §7 dice qué milestone toca. Cada uno tiene su incógnita
   escrita — el código es el medio, la incógnita es el objetivo.
4. Reglas del lab: nada de `packages/*` importa de aquí; `packages/web` no se
   toca hasta M7; `website-oficial` no se toca nunca desde este lab; ninguna
   clave privada se escribe en ningún fichero de este repo.
5. Re-verifica contra mainnet cualquier dato de §3 antes de usarlo en M6 — las
   cifras de liquidez caducan en semanas.
