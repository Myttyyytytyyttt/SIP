# SIP — ¿una wallet de ahorro? Investigación (2026-09-11)

**Pregunta del owner.** En vez de que el usuario venga a la web a crear o importar una wallet, hacer un
fork de una wallet open source conocida, añadirle el ahorro de SIP, y venderla no como "wallet cripto"
sino como "una wallet solo para tus ahorros".

**Método.** Cinco investigaciones en paralelo con acceso a GitHub (candidatas, arquitectura, seguridad,
producto, esfuerzo) y una pasada de refutación independiente sobre cada dato factual. 28 afirmaciones
comprobadas contra la fuente, 0 refutadas. Todo lo que sigue con licencia, fecha o número fue leído el
2026-09-11 del repositorio o API correspondiente, no de memoria.

---

## 0. Veredicto en cuatro frases

1. **La idea es buena y es viable. Hay una base clara para el fork: Rabby.**
2. **El "x10" no está donde parece.** La premisa era que la wallet es el punto de estrangulamiento
   universal por el que pasa toda firma y por tanto puede meter el ahorro *en la propia transacción*.
   Eso es verdad para Uniswap, 1inch y cualquier dapp con wallet inyectada — y **falso para GMGN y Axiom**,
   los dos terminales que nombraste: ambos operan desde **sus propias wallets**, y el swap nunca pasa por
   la extensión del usuario.
3. **Lo que la extensión sí cambia, y sin tocar un contrato, es la custodia:** la clave vive en la
   extensión, la extensión firma los `pull` ella misma, y **Privy desaparece del bucle** — ni crear en la
   web, ni importar, ni conceder asiento. Ese es el x10 real, y es de onboarding, no de captura.
4. **Antes de forkear nada: una semana midiendo dónde tradean de verdad tus usuarios.** Si la mayoría del
   volumen está en GMGN/Axiom, el fork no captura nada que el worker no capture ya, y habrías reconstruido
   la web como una extensión más difícil de publicar.

---

## 1. El hallazgo que cambia la premisa

| Venue | Desde dónde firma el swap | ¿Pasa por la extensión? |
|---|---|---|
| **GMGN** | Wallet por cadena generada por GMGN (deposita, exporta la clave; con login Phantom la exportación está prohibida). **Vivo en Robinhood Chain.** | **No** |
| **Axiom** | Wallet embebida Turnkey; el usuario puede exportar la seed | **No** |
| Uniswap, 1inch, Lighter, Rialto, Arcus, cualquier wagmi v2 / RainbowKit / Reown AppKit | La wallet inyectada del usuario (EIP-6963) | **Sí** |

Consecuencia: para el usuario de GMGN/Axiom, el fork **no añade captura en ruta** ni quita fricción
respecto a hoy — sigue teniendo que sacar la clave del terminal y meterla en algún sitio (la extensión o
Privy) para que el observe-and-pull funcione. Donde el fork brilla es en el mundo de wallet inyectada, que
es justo donde las guías de Robinhood Chain mandan a los principiantes (MetaMask/OKX + Uniswap) — y ahí
el competidor por la instalación es **Robinhood Wallet**, que soporta 4663 nativamente.

---

## 2. Lo que el protocolo permite, leído en los contratos

Hay **una sola puerta** para que entre valor al vault:

```
trading wallet ──► SipVolumeExecutor.pull(atestación, firma) ──► PersonalVault.acceptSettlement(record)
```

- `PersonalVault.receive()` **revierte** con `Unauthorized()` (`PersonalVault.sol:1351`). El vault rechaza ETH directo, de cualquiera.
- `acceptSettlement` exige `msg.sender == settlementExecutor` (`:945-947`).
- `pull` resuelve el vault desde `msg.sender` (la trading wallet) y verifica la firma EIP-712 del
  **attester** fijado por gobernanza sobre un rango de bloques **ya observados** (`startBlockL2..endBlockL2`).

Por tanto: **el skim "en la misma transacción que el swap" no existe hoy**, y no por descuido — la
atestación existe para acotar lo que el servicio puede cobrar, y en el momento de firmar el swap el fill
aún no ha ocurrido. Cualquier vía que mueva ETH al vault fuera de `pull` **no se contabiliza** en
`owed/collected`, y el worker seguiría cobrando el mismo fill: **doble skim**.

---

## 3. Qué puede hacer la extensión, en dos fases

### Fase 1 — cero cambios de contrato (el MVP)

La extensión **es el firmante del `pull`**. El worker sigue observando, reconstruyendo y atestando
exactamente como hoy; la extensión pide la atestación por HTTP y manda `pull` con `msg.value` firmado
con la clave local.

- **Privy fuera del bucle** para estos usuarios: `createWallet/importWallet/addSigners/policy`, el flag
  delegado, el límite TEE del import y los secretos `PRIVY_*` de web y worker dejan de ser necesarios.
  El "baile de dos firmas" de la invitación colapsa a un clic, porque las dos claves pueden vivir en la
  extensión.
- La extensión **sabe al instante que acaba de firmar un trade**, así que puede pedir el `pull` segundos
  después del fill en vez de esperar al tick.
- **Lo que pierde respecto al asiento de Privy:** el `pull` solo ocurre con el navegador abierto y la wallet
  desbloqueada. MV3 mata el service worker a los ~30 s de inactividad; con Chrome cerrado no corre nada.
  Un `pull` pendiente espera al siguiente desbloqueo. Es *best-effort con arrastre* — el modelo ya aceptado.
- Del worker se queda igual **todo el tramo observar→atestar** (rpc, chain, discover, context, reconcile,
  decoder GMGN, batch root, snapshot, ledger, tick, config, log). Solo `pull/` gana una segunda fuente de
  firmante y una superficie HTTP pequeña. Las rutas de la web (`/api/vault`, `/api/skims`,
  `/api/create-vault`, `/api/rpc`) son el backend de la extensión en cuanto tengan cabeceras CORS —
  hoy ninguna las tiene.

### Fase 2 — skim en ruta (cambio de protocolo)

Dos opciones, y no son equivalentes:

- **Atestación bajo demanda** (cero Solidity, recomendada): el worker expone un endpoint que atesta el
  fill recién confirmado, y la extensión manda `pull` como segunda transacción (nonce+1) justo tras el
  swap. Latencia de segundos; usa el protocolo tal cual.
- **`selfContribute` sin atestación** en un `SipVolumeExecutor` v2: acredita `collected[account]` antes
  de la atestación y el worker salta los fills que el evento cubra. Es seguro en principio — la
  atestación acota lo que *el servicio* cobra, no lo que *el usuario* mete en su propio vault — pero es un
  contrato nuevo, con su auditoría.

**Sobre EIP-7702.** Está vivo en Robinhood Chain (ArbOS 61); un agente simuló la compra GMGN de 0,02 ETH
registrada con código 7702 en la wallet y el router la ejecutó idéntica, así que *swap + skim atómico* es
técnicamente posible. Pero (a) Rabby **rechaza** transacciones 7702 de dapps ("not support 7702") y no
implementa `wallet_sendCalls` (EIP-5792), así que es trabajo que el fork añade, no hereda; (b) el
decodificador GMGN del worker exige `tx.to == router` y el reconciliador rechaza ventas residuales de una
wallet con código, así que una wallet delegada pierde el fallback para venues no decodificados; y (c) la
lectura de seguridad argumenta **en contra**: un delegado en la EOA del usuario es una superficie de
contrato nueva con la forma exacta de Rabby-Swap-2022. Recomendación: **segunda transacción plana, no
batch 7702**, al menos hasta que haya volumen que lo justifique.

**Economía del gas.** Un `pull` mide **445k gas** (dominado por `acceptSettlement`). Con base fee de
0,123 gwei son ~0,000055 ETH; con el suelo 2× del worker, un skim por trade solo compensa por encima de
**~0,055 ETH de notional al 0,2%**. Los traders pequeños se cobran en lotes — la extensión lleva un
acumulador local de deuda igual que el worker lleva ventanas.

---

## 4. Candidatas para el fork

| Wallet | Licencia | MV3 | Stack | Actividad | HW wallets | 4663 | Móvil | Veredicto |
|---|---|---|---|---|---|---|---|---|
| **Rabby** `RabbyHub/Rabby` | **MIT** + cláusula: no usar nombre ni logo | ✅ | TS, React 18.3, antd, ethers 5 + viem 2 | **v0.94.7 el 2026-09-04**, semanal, 38 releases en 2026, push hoy, 1.891★ | Ledger, Trezor, Keystone, OneKey, GridPlus, BitBox02, imKey + Safe/WC/Coinbase | **Nativo** (`hood`, 4663) | Repo público y activo pero **sin LICENSE** → no forkeable | **Elegida** |
| Enkrypt `enkryptcom/enKrypt` | MIT limpia | ✅ | Vue 3.5, Vite | v2.19.0 2026-09-01, trimestral, 437★ | Ledger, Trezor | Por RPC | Ninguno | Subcampeona: ruta de firma más pequeña y legible; Vue, y arrastra BTC/Polkadot/Solana |
| Rainbow ext `rainbow-me/browser-extension` | GPL-3 (viral) | ✅ | React 18.2, viem | v1.6.11 2026-06-08, **4 commits/90 d**, 193★ | Ledger, Trezor | Por RPC | **Móvil GPL-3, 4.389★, activo** — el único par ext+móvil con licencia | Solo si móvil con licencia es imprescindible; precio: GPL en todo, y depende del backend de Rainbow |
| Taho `tahowallet/extension` | GPL-3 + términos adicionales | ✅ | React 18, Redux | Último release 2026-01-19, 3.205★ | Solo Ledger | Por RPC | — | Descartada: esporádica, términos raros |
| Ambire `AmbireTech/extension` | GPL-3 la ext; **el núcleo de firma (submódulo `ambire-common`) no tiene licencia** | ✅ | Expo/RN | Casi diaria, 68★ | Ledger, Trezor, GridPlus | — | En el mismo repo | Legalmente inforkeable hoy, pese a un `AccountOp.calls[]` ideal para batching |
| MetaMask | Propietaria: derivados solo no comerciales, **tope 10.000 MAU** | ✅ | — | 13.208★ | — | Nativo | — | Fuera por licencia; irónicamente tiene los hooks más limpios (`beforeSign/beforePublish/publish`) |
| Block Wallet | No comercial | **MV2** | — | Muerta desde 2024-11 | — | — | — | Fuera. Chrome purgó todo MV2 de la Store el 2026-08-31 |
| Uniswap ext (`Uniswap/interface`) | **Sin LICENSE** en `apps/extension` ni `packages/wallet` | ✅ | React 19, WXT | Push 2026-08-17 | Ninguna | Nativo | — | Fuera: sin HW, sin cadenas custom, monorepo de 10k ficheros atado a su backend |
| Zerion / Wigwam | GPL-3 / MPL-2.0 | ✅ | React | 86★ cada una | Ledger | Por RPC | — | Viables pero minúsculas |
| OneKey, Backpack, Frame | No forkeable / estancadas | | | | | | | Fuera |

**Por qué Rabby.** Es la única que a la vez: es MIT (con la única condición de renombrar, que ya querías),
es MV3, se publica semanalmente, **ya lista Robinhood Chain** en su propia API de cadenas (sin ruta de red
custom: pre-ejecución y saldos funcionan de serie), tiene la cobertura de hardware más amplia — y **seis
auditorías públicas en el repo** (SlowMist 2022/2023/dic-2024/ago-2025, Least Authority dic-2024/sep-2025)
sobre una pila de keyring heredada de MetaMask. Es decir: el código que no quieres re-auditar es
exactamente el que dejarías intacto.

**El punto de enganche en Rabby.** Toda transacción, venga de una dapp o de las pantallas propias de
Rabby, entra por la cadena de middlewares `PromiseFlow` de `src/background/controller/provider/rpcFlow.ts`
y acaba en `providerController.ethSendTransaction` (`controller.ts`, ~l.649), que llama a
`keyringService.signTransaction` (~966/977) y difunde por `eth_sendRawTransaction` (~1215/1317/1403). Los
envíos internos (send, swap) usan la misma ruta vía `wallet.ts sendRequest` (l.534) — el swap de Rabby ya
encadena approve+swap así. Adjuntar una segunda `eth_sendTransaction` de origen interno justo tras la
difusión es un cambio acotado. Y la pre-ejecución de DeBank devuelve el **cambio de saldo simulado** en el
momento de firmar — el notional que hoy el worker reconstruye de los logs.

**Dependencias de las que no te libras.** Rabby llama a `api.rabby.io` (lista de cadenas, saldos,
historial, pre-ejecución, motor de seguridad, pushTx) bajo términos que nadie ha publicado. Si ese acceso
se corta, 4663 degrada a la ruta custom sin precios, historial ni pre-firma. Y **Rabby Mobile no tiene
licencia**: móvil es o negociar con su equipo, o una build aparte sobre Rainbow (GPL).

---

## 5. Seguridad: qué significa publicar una wallet

Publicar un fork **no** es custodiar claves, pero sí es asumir los dos sitios donde de verdad se ha
perdido dinero en extensiones-wallet:

- **La capa que el vendedor atornilla sobre un keyring heredado.** Slope filtró seeds por su propio logging
  de Sentry (2022). El Swap de Rabby perdió ~200k$ un mes después de lanzarse (2022) pese a auditoría de
  PeckShield. **Un módulo de ahorro de SIP es exactamente esa capa.**
- **La cadena de publicación.** Trust Wallet v2.68 (dic-2025): con una clave de API de la Chrome Web Store
  filtrada, un atacante subió una build que **pasó la revisión de Google** y vació ~8,5M$ de 2.520
  direcciones. **Este es el riesgo dominante, no los bugs de keyring.**

**Diseño de responsabilidad mínima:**

1. **Byte-idéntico a upstream:** todo `src/background/service/keyring`, los paquetes keyring y passworder,
   los flujos de unlock/auto-lock/contraseña, la UI de importar y revelar seed, y la inyección del
   provider por content script.
2. **La capa de ahorro es:** un servicio de background nuevo + una línea en la pantalla de aprobación + una
   página de ajustes. Su único privilegio: pedir a la ruta de firma existente que firme **una transacción
   adicional, plana y totalmente mostrada** (nonce+1) tras el swap aprobado. Ni batch 7702, ni append
   silencioso.
3. **El bps se lee del `TradingAccountPolicy` on-chain**, con el mismo `mulDiv(notional, savingsBps, 10_000)`
   que recalcula el executor (`SipVolumeExecutor.sol:175`) — **nunca** de un servidor, un fichero de
   config o el calldata de la dapp — y con un **techo cableado** (rechazar cualquier skim > 100 bps o
   > `maxPerSettlementWei`), para que la confusión %-de-beneficio vs %-de-volumen que ya casi nos muerde
   (100× sobre notional) sea **estructuralmente imposible**, no solo testeada. Un bps on-chain de 0 para
   *las dos* rutas.
4. **Upstream:** remote `upstream` limpio, serie de parches corta (un directorio nuevo + < ~15 ficheros
   tocados) rebasada sobre **cada tag** de Rabby en días. Rebase no limpio = bloqueo de release. Rabby
   commitea a diario; si el parche toca keyring/approval/provider, en meses deja de rebasear y los parches
   de seguridad dejan de fluir — el fork se vuelve, en silencio, una wallet sin mantener.
5. **Pipeline:** subidas verificadas con clave en hardware, cuenta de la Store con 2FA y sin claves de API
   de CWS en CI. Sentry **apagado** (Rabby trae `sendDefaultPii: true`) hasta re-auditar cada ruta de scrub.
   Congelar dependencias (134 runtime + 74 dev, sin LavaMoat); el compromiso de chalk/debug de sep-2025
   estuvo vivo ~2 h y apuntaba a wallets en navegador.
6. **Marca:** te clonarán en ambas stores con reseñas falsas y te adelantarán durante tu propia ventana
   de revisión (le pasó a Rabby en feb-2024). Registrar el nombre en las stores el día uno.

Revisión inicial de la Chrome Web Store: el manifest de Rabby pide `<all_urls>` y `webRequest`, ambos
alargan revisión — **2–4 semanas** para el primer listado.

---

## 6. Producto y distribución

**La fricción no desaparece, se mueve:** de *"visita una web y pega una clave en Privy"* a *"instala y
confía en una extensión desconocida que guarda tus claves"*. Es una petición de confianza **más alta**,
en la categoría donde el listado-wallet-falso es la estafa base.

**Descubrimiento es el problema no resuelto, no el onboarding.** Una vez instalada, EIP-6963 hace que
un fork renombrado aparezca en "Installed/Detected" de cualquier dapp sin registro. Pero nada lleva a un
desconocido a un listado nuevo: cada enlace "install a wallet" de cada dapp apunta a MetaMask/Rabby/
Coinbase; **Rabby tiene ~900k usuarios en la CWS tras años**; Taho (3,2k★, con VC, aún con commits en
ago-2026) ocupa el puesto ~#4.143 de la Store. Y en Robinhood Chain el competidor por la instalación es
Robinhood Wallet.

**Móvil no tiene ruta que importe.** Kiwi murió en ene-2025; extensiones en Firefox Android y Safari iOS
son nicho. En Robinhood Chain, móvil es Robinhood Wallet, la app de GMGN o Telegram — todos con sus propias
claves. **Móvil se queda en observe-and-pull con clave pegada, igual que hoy.**

**Precedente.** Los productos de ahorro sobrevivieron cuando **poseen o tienen mandato sobre el raíl**
(Acorns observa vía Plaid y cobra por mandato ACH; Cash App posee la tarjeta) y murieron cuando se sientan
fuera de él (RoundlyX, "Acorns para cripto", cesó) o cuando "savings" atrae al regulador (Linus se
desmanteló tras una acción de la SEC; Donut murió con Genesis; Dharma pivotó tres veces y se vendió a
OpenSea). Incluso Robinhood mató sus propios Round-ups en ruta el **8-dic-2025**. Argent Vault no recibió
features y renació en 2025 como Ready, *"an onchain alternative to your bank"*.

**Regulación (no soy abogado; esto es dónde mirar).** MiCA, considerando 83: el software de wallet
no-custodial queda fuera de alcance. Pero la definición de custodia cubre *"controlar… los medios de
acceso"* — **el asiento de Privy que SIP sostiene hoy está más cerca de esa línea que una extensión
autocustodiada**. Curiosamente, la extensión *reduce* ese riesgo. Lo que lo *aumenta* es el marketing:
vender "pensión"/"ahorro" acerca el producto a las normas de promoción financiera de la UE. Nombrar el
producto con cuidado es una decisión de producto con consecuencias legales.

**Tres cosas que hacen o rompen la adopción:**
1. Que la wallet sea **la de siempre**, no una más: si el usuario ya usa Rabby, un fork de Rabby que hace
   lo mismo *más ahorro* es un reemplazo, no una adición.
2. Un flujo de **un solo pantallazo** para el usuario de GMGN/Axiom que tiene que traer su clave, porque
   sin él el "nunca visitas la web" es falso para la mitad de los usuarios.
3. Distribución **propia**: la extensión no se descubre sola; hace falta una razón para instalarla que no
   sea "es una wallet".

---

## 7. Esfuerzo y secuencia

**Semana 1, antes de forkear: medir.** ¿Qué fracción del volumen de tus usuarios objetivo pasa por una
wallet inyectada (Uniswap/1inch/…) vs por GMGN/Axiom? Si es mayoritariamente app-custodiado, la única
capacidad única del fork (skim al firmar) nunca se dispara. Esto se puede responder leyendo la cadena: los
fills de las trading wallets ya vinculadas dicen desde qué `from` y hacia qué router.

**Si el chokepoint existe — MVP: 3–6 semanas** (asumiendo que *recortas* las 97 vistas de Rabby en vez
de reescribirlas y dejas swap/firma/seguridad intactos):
- Fork de Rabby renombrado (nuevo nombre, icono, rdns EIP-6963).
- Onboarding **dentro del popup** que crea el vault y vincula la trading account — la lógica de
  `LinkWalletDialog`/`useCreateVault` con `lib/wallets/{policy,judge,abi,vault}.ts` reutilizados tal cual.
- Panel "apartado" — `savings-rule-panel` + `pension-panel` portados; Rabby ya es React 18 + Tailwind 4 y
  tus versiones de Radix y recharts aceptan React 18.
- La wallet firma los `pull` del worker en vez del asiento de Privy.
- Lo que prueba: **la apuesta de custodia** — clave en la extensión, pulls locales, Privy fuera.

**Fase 2 — skim en ruta: 2–4 semanas**, enganchado al predicado `APPROVAL` de `ethSendTransaction`
(el popup se salta cuando devuelve true) y a la ruta interna `sendRequest`, con suelo de gas. Necesita el
endpoint de atestación bajo demanda en el worker — y ojo: el worker hoy solo tiene el constructor de
atestaciones de **Fase 0**, no el de `SipVolumeExecutor`.

**"Un fork que corre": días** (Rabby compila con Node 22 y yarn; el predicado de skim son < 100 líneas).
**"Un fork al que dejarías meter dinero a un desconocido": mucho más.** El tiempo se va en: la revisión de
la Store (2–4 semanas), el pipeline de publicación endurecido, el rebase continuo sobre upstream, y la
custodia de la clave de pensión — la web la deja como EOA externa; una extensión única o la guarda como
segunda cuenta caliente, o integra hardware (Rabby lo tiene), lo que reintroduce fricción.

---

## 8. Riesgos, ordenados

1. **Cobertura del chokepoint puede ser pequeña** (GMGN/Axiom no pasan por la extensión). *Medir antes.*
2. **Compromiso del pipeline de publicación** (Trust Wallet, dic-2025). *Clave en hardware, sin API keys en CI.*
3. **Bug aritmético que cobra 100×.** *bps on-chain + techo cableado; nunca de servidor.*
4. **Doble skim** si la extensión mueve ETH fuera de `pull`. *Toda cobranza pasa por el executor.*
5. **Deriva del fork:** parches que tocan el núcleo dejan de rebasear en meses. *< 15 ficheros, rebase por tag.*
6. **Dependencia de `api.rabby.io`** bajo términos desconocidos. *Preguntar; tener plan B con red custom.*
7. **Inversión de confianza** y clones de marca. *Registrar nombre día uno; postura "beta" honesta.*
8. **Móvil sin licencia** (Rabby Mobile). *Móvil = observe-and-pull, como hoy.*
9. **Marketing "pensión/ahorro"** y promoción financiera en la UE. *Nombrar con cuidado; consultar.*

---

## 9. Decisión recomendada

- **Sí al fork, sobre Rabby, como Fase 1 con cero cambios de contrato** — es la forma más barata de quitar
  Privy del camino de tus usuarios y de tener la clave donde el usuario la espera.
- **No prometer "ahorro en cada trade, donde sea".** Prometer *"tus trades desde esta wallet ahorran solos;
  los demás, cuando la abras"*. Es lo que el protocolo garantiza.
- **Primero medir** (semana 1). El resultado decide si esto es un x10 o un x1,3.

*Fuentes: repositorios y APIs de GitHub leídos el 2026-09-11 (URLs en el registro del workflow
`wf_30e8732a-2df`); `packages/contracts/src/vault/PersonalVault.sol`,
`packages/contracts/src/settlement/SipVolumeExecutor.sol`, `packages/worker/DESIGN.md`.*
