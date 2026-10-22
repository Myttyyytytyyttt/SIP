# Llevar la trading wallet a un terminal, y otras automatizaciones (2026-10-22)

**Qué es esto.** Es una investigación, sin código. La pregunta del dueño: *«¿Hay alguna forma de automatizar el export de las wallets creadas para las páginas de trading? Que con un botón el navegador abra directamente todo en un terminal como GMGN.»* También pidió más automatizaciones que mejoren la app. Nada está construido. Prototipar algo necesita antes su OK.

**Cómo se hizo**
- **Dos rondas de agentes con verificación adversarial.**
  - 1.ª ronda: 8 temas, cada uno con un verificador independiente, y un crítico final. Salieron 323 afirmaciones: 280 confirmadas, 39 parciales, 3 no verificables y 1 refutada.
  - 2.ª ronda, sobre los huecos que vio el crítico: 92 afirmaciones; 81 confirmadas, 9 parciales, 1 no verificable y 1 refutada.
  - En este informe se usa siempre la versión corregida por el verificador.
  - Después, tres revisores contrastaron este texto con las pruebas y el código.
- **Lo que vi yo en un navegador real, sin iniciar sesión en ningún sitio:**
  - el dominio saverfi.cash y la lista pública de dominios de Privy;
  - las páginas de GMGN, Axiom, Terminal (Padre), Photon, la web de Trojan, jup.ag, pump.fun y Solscan.
- **Fuentes y código.** Todas las fuentes se consultaron el **2026-10-22**. El código es el de `main` en `a0938f0`.
  - `origin/main` va 5 commits por delante: SEO, docs y «compartir» en Live.
  - De lo citado aquí solo cambia `landing-backdrop.tsx`: en `origin/main`, Photon está en la línea 200.
- **Lo que no se hizo:** crear cuentas, iniciar sesión, conectar wallets, pegar claves ni aceptar los términos de ningún sitio.
- **Rutas.**
  - Las que empiezan por `src/` son de `packages/website-oficial`.
  - Las que empiezan por `dist/` son del paquete instalado `@privy-io/react-auth` 3.36.0.
  - Las de `packages/` y `docs/` son desde la raíz del repo.
  - El informe del 2026-10-20 está sin versionar, en `/Users/walch/ProyectosCT/SIP/reports/ROADMAP_NEXT_RESEARCH_2026-10-20.md`.

**Etiquetas**
- **[doc]**: lo dice la documentación oficial.
- **[código]**: visto en el JS público o en el repo.
- **[navegador]**: lo vi yo en un navegador real.
- **[inferido]**: deducción, no comprobada.

---

## 0. Respuesta corta

1. **El botón que abre el terminal con la wallet ya dentro no existe y no se debe construir.**
   - **Dónde se comprobó.**
     - No hay forma de pasar una clave por enlace en GMGN, Axiom, Terminal (Padre) y BullX, por su código o sus docs.
     - Tampoco en los bots de Trojan, BONKbot y GMGN, según sus docs.
     - En la web de Trojan, sus docs listan los parámetros de URL (`token`, `pool`, `ref`) y ninguno lleva una clave. Su código no se pudo leer.
   - **Dónde solo «no se encontró».** En Photon, Banana Gun y Maestro no lo encontramos en sus docs, y el código de Photon no se pudo leer.
   - **Ninguna pantalla de importar tiene URL propia** en los que sí se pudieron revisar.
   - **Por qué no se debe construir.** Una clave en la ruta o en la query de una URL acaba en el historial y su sincronización, en los logs del servidor o de la CDN del terminal, en las extensiones y en las previsualizaciones de enlaces. Además, enseña al usuario el gesto exacto de un phishing.
2. **Lo más parecido, y lo que recomiendo: un panel «Usar en un terminal» en cada trading wallet.**
   - Un enlace fijo abre el terminal elegido en el punto más cercano a su pantalla de importar, con el dominio a la vista.
   - El botón «Copy key» de Privy, el que ya existe, copia la clave.
   - Una línea dice dónde pegarla.
   - Al lado, enlaces de solo lectura con la dirección: Jupiter la muestra sin cuenta.
   - Son tres clics (abrir el terminal, «Export key», «Copy key») y un pegado, más cerrar el diálogo y los clics que pida el terminal.
   - Esfuerzo **S**. No toca la CSP, ni el keeper, ni el programa.
   - **Condición:** Axiom y Terminal solo aceptan claves de 64 bytes, y no está verificado que Privy exporte 64. Lo resuelve una prueba de un minuto (T2, §8).
   - **Antes de abrirlo a usuarios:** las pruebas T1, T2 y T3 (§8).
3. **Sin exportar la clave encontramos dos caminos prototipables, los dos sin probar:**
   - hacer de wallet WalletConnect para **jup.ag**, que documenta la conexión por QR o enlace (y quizá pump.fun y Raydium, solo por su código). Esfuerzo **M**: cada trade se aprueba en una pestaña de SaverFi, y hay riesgo de firma ciega;
   - una extensión propia de SaverFi, que podría servir en GMGN «Trade with Wallet». Esfuerzo **L**.

   **Dónde no hay vía.**
   - No encontramos WalletConnect para Solana en GMGN, Axiom ni Terminal. La CSP de GMGN lo lista, pero el único JS archivado que nombra WalletConnect trae RainbowKit, de EVM.
   - En Axiom y Terminal, Phantom solo sirve para iniciar sesión, así que tampoco valdría una extensión.
   - En Photon no se pudo mirar.
   - Las wallets globales de Privy solo son EVM.

   **Sin evaluar:** una app móvil con navegador propio, y un signer por socio con un relay de SaverFi (§3.1).
4. **Socios.** En los terminales y bots revisados no encontramos ningún programa para importar wallets por API. Sí hay referidos, con los que SaverFi cobraría una parte de la comisión del terminal sin cobrar nada en la cadena:
   - GMGN, del 10 al 30 % de su comisión;
   - Axiom, el 30 %, el 3 % y el 2 % en tres niveles;
   - Terminal (Padre), «hasta el 40 %»;
   - el bot de Trojan, hasta el 35 % en cinco niveles;
   - BONKbot, un 5 % para integradores.
5. **Salió algo por el camino, ya resuelto por el dueño:** durante parte del día, `saverfi.cash` no estaba permitido en Privy y su iframe se bloqueaba (§1.1). Falta probar «Export key» allí (T1), y quedan dominios muertos por limpiar.

---

## 1. Lo que salió por el camino

### 1.1 `saverfi.cash` en Privy: bloqueado durante unas horas, ya resuelto

- **Contexto.** `https://saverfi.cash` sirve la web y es su URL canónica desde `bceefec`/`41f9fbc` (`origin/main`, 2026-10-22).
- **Lo que vi en la primera comprobación.**
  - La configuración pública de la app de Privy (`GET https://auth.privy.io/api/v1/apps/<app id>`) no incluía `saverfi.cash` en `allowed_domains`.
  - En `saverfi.cash`, la consola del navegador daba el error `Framing 'https://auth.privy.io/' violates … frame-ancestors … The request has been blocked.` [navegador].
  - En `sip-website-oficial.vercel.app` el error no salía.
- **Ya está resuelto.** A las 18:43Z la lista incluye `https://saverfi.cash` y `https://www.saverfi.cash`, también en el `frame-ancestors` del iframe. En una pestaña nueva de `saverfi.cash` el error ya no sale [navegador]. Otra sesión dejó anotado que lo añadió el dueño el 2026-10-22 y que el login se abrió allí.
- **Lo que falta: probar «Export key» en `saverfi.cash`** (T1).
- **Limpieza que queda (acción del dueño, en el dashboard de Privy):**
  - **El origen de Railway.** `sip-web-production.up.railway.app` responde con el 404 genérico de Railway (`x-railway-fallback: true`): ahí no se sirve ninguna web, pero Privy lo sigue permitiendo.
  - **Los `www.` de Railway y de Vercel**, que no tienen certificado válido.
  - **`localhost`**, que Privy desaconseja en producción. Ojo: el runbook lo usa para probar (`docs/runbooks/PRIVY_SOLANA.md:40`). Quitarlo rompe las pruebas en `localhost:3002` y `:3013`, salvo que antes se cree una app de Privy aparte para desarrollo.
  - **Por qué importa.** Un clon en otro origen no puede cargar el iframe de Privy de SaverFi una vez quitados los orígenes muertos. Con el de Railway todavía permitido no está claro, porque no sabemos si otra persona podría hacerse con ese nombre.
- **Una opción que abre el dominio propio.** Con un dominio verificado, Privy puede guardar el token en una cookie HttpOnly, fuera del alcance de un XSS. Privy no aprueba de forma automática dominios como `*.vercel.app` [doc: docs.privy.io/recipes/react/cookies]. Pero después el App ID solo funciona en ese dominio exacto: haría falta otro App ID para desarrollo, y `vercel.app` y `localhost` dejarían de servir con el actual. Es una decisión aparte.

### 1.2 Textos de la web que prometen más de lo verificado [código]

| Texto | Dónde | Lo que dicen las fuentes |
|---|---|---|
| «The key appears in a window from Privy» | `src/app/docs/_content/trading-wallets.tsx:60`; también el comentario de `src/hooks/use-export-trading-wallet.ts:12` | El diálogo de export **no muestra la clave en ningún momento**. Para Solana solo tiene un botón «Copy key» que la copia al portapapeles y pone «Copied» 2 s [código: chunk de export de auth.privy.io del 2026-10-22] |
| Importar una wallet «de … GMGN» | `src/app/docs/_content/import-a-wallet.tsx:34`, `src/lib/vault-copy.ts:883` | La página dedicada de GMGN dice que **no se puede exportar ninguna wallet**, tampoco las importadas [doc]. Su cofundador lo dijo de las generadas, según un medio de terceros. Otras dos páginas de su doc, al parecer antiguas, dicen lo contrario. Lo seguro es traer a SaverFi solo una wallet que el usuario importó a GMGN desde fuera y cuya clave conserva |
| «… or a trading bot» | los mismos dos sitios | Depende del bot. Trojan exporta la clave (formato no indicado). Banana Gun solo la enseña al crear la wallet. GMGN, según su página dedicada, no exporta. BONKbot documenta exportar la frase y la clave con 2FA, sin decir en qué formato [doc] |
| El logo de **Photon** en la landing, como terminal del que sale el ahorro | `src/components/landing-backdrop.tsx:213` en `a0938f0` (`:200` en `origin/main`); la idea la explica el comentario de `:206` | La web de Photon pide instalar Phantom para entrar [navegador]. Opera desde una wallet que genera Photon [doc: su GitBook, enlazada desde su web]. **Importar una clave no está documentado**: solo lo dice un tercero, sin pasos |
| «its key works in Axiom, GMGN or any Solana app» e «Import the key into Axiom, GMGN or any Solana app» | `src/app/docs/_content/what-is-saverfi.tsx:41`, `src/app/docs/_content/trading-wallets.tsx:63` | Axiom y Terminal solo aceptan base58 de **64 bytes**. No está verificado que Privy exporte 64 bytes (§3.2, prueba T2) |

### 1.3 Lighthouse: riesgo latente en el keeper, no materializado

- **El riesgo.**
  - El keeper trata un ingreso de SOL como depósito solo si **todos** sus programas son System, ComputeBudget, Ed25519 o Memo (`packages/solana-keeper/src/measure-window.ts:42-49, 63-68`).
  - Lighthouse es un programa que Phantom puede añadir a las transacciones que firma para las dapps (no siempre lo hace), y no está en esa lista.
  - Por eso, un depósito con Lighthouse se mediría como trade, y en modo profit su SOL contaría como beneficio.
- **Lo que hay en la cadena (lectura de solo lectura).** Revisé el historial completo de las 4 trading wallets enlazadas, que son todas las que ha habido en `sip_vault` (`6kA9H9zQ…`): el programa registra 4 `link_wallet` y ningún `unlink_wallet`.
  - Los 4 ingresos que llegaron por transferencia desde otras direcciones (uno de ellos del propio owner) son `[ComputeBudget, ComputeBudget, System.transfer]`, **sin Lighthouse**.
  - Los 5 `settle_v2` en modo profit cuadran al lamport con la fórmula del keeper, con el depósito excluido. El del 2026-09-19 (`2tE3BMTa…`) contiene el único depósito que cayó dentro de una ventana liquidada en modo profit.
  - Dos ingresos del 2026-10-08 a `eRau…` entraron en la ventana de un settle de volumen. Su base (0,988 SOL) indica que no se contaron como volumen [inferido].
- **Por qué importa para «financiar con un clic»** (§7, n.º 5).
  - Las 19 transacciones que los owners firmaron contra el programa de SaverFi llevan Lighthouse, las 19. Pero ninguna es una transferencia System, y en las transacciones de dapps del mismo owner Lighthouse no aparece siempre.
  - Un depósito construido por SaverFi y firmado en Phantom **probablemente** lo llevaría [inferido, confianza baja]. Hay que comprobarlo con una transacción real antes de construirlo.
  - Si lo lleva, el keeper tiene que aceptar antes las comprobaciones de Lighthouse de tipo 6 y 10, y nunca los tipos que mueven lamports (`packages/solana-core/src/client/lighthouse.ts:42-43`).

### 1.4 Otras dos cosas

- **`useGetWalletPrivateKey`.** El SDK 3.36.0 instalado exporta este hook experimental. Usa un iframe oculto en modo `client-export` y entregaría la clave **descifrable por la propia página de SaverFi** [código: `dist/dts/index.d.ts:4086-4107`; `dist/esm/index-B2_w5Cud.mjs:180`]. Privy dice que hay que pedir a soporte que active esa función [doc: programmatic-export]. No debe usarse, y conviene un test de guarda que impida importarlo.
- **Envenenamiento de direcciones.** El 2026-10-08, la trading wallet `eRau…` recibió 1.000 lamports de una dirección casi igual a la que, un minuto antes, le había enviado 1 SOL [inferido: patrón de envenenamiento]. Si un usuario copia una dirección de su historial, puede copiar la falsa.

---

## 2. Terminal por terminal

| | Quién guarda la clave al importar | Importar: dónde y en qué formato | URL a «importar» | Clave por URL | Operar con wallet externa | Solo lectura por dirección | Referidos | En un iframe |
|---|---|---|---|---|---|---|---|---|
| **GMGN** | GMGN; según su página dedicada, no deja volver a exportarla [doc] | Web: Wallet Manager → Import wallet, con la clave de una wallet de SOL (10 importadas + 10 creadas). Bot: pegarla en el chat. Formato no documentado [doc] | No [doc: se revisaron sus 64 páginas] | No [doc] | «Trade with Wallet» con Phantom, firmando cada trade, sin Anti-MEV ni automatizaciones [doc] | `gmgn.ai/sol/address/<dir>`: pide iniciar sesión en GMGN [navegador]; con sesión no se comprobó qué muestra | 10–30 % de su comisión del 1 % [doc] | No (XFO SAMEORIGIN) |
| **Axiom** | Turnkey [doc]; la clave en claro vive en la memoria JS de la página de Axiom [código] | Modal «Import Wallet», no documentado: base58 de **64 bytes** exactos o hex EVM, una por línea. Tope cliente de wallets Solana activas: 50 por defecto, 500 con el flag de cuenta `elevatedWallets` y 1000 con el ajuste experimental del usuario (`/exp`) [código] | No; botón «Import» en Wallets o en `/portfolio` [código] | No [código] | No: Phantom solo sirve para iniciar sesión [código] | `/portfolio?wallet=<dir>` existe en el código, pero sin sesión da «Failed to load portfolio data» [navegador] | El 30 %, el 3 % y el 2 % de su comisión neta en tres niveles, solo si el usuario se registra con el enlace [doc]; el enlace es `axiom.trade/@código` [código] | No (XFO SAMEORIGIN) |
| **Terminal (Padre)**, hoy de Pump.fun | Turnkey, con una sub-organización por usuario [código] | Iframe de Turnkey: base58 de 64 bytes (según el código abierto del frame de Turnkey; confianza media). Tope cliente de 500 wallets [código] | No. Lo más cercano es `trade.padre.gg/wallets`, que redirige a `/sign-in?backToUrl=/wallets` [navegador]; tras el login debería volver a `/wallets` [código] | No [código] | No: Phantom solo para el login [código] | Ninguna en Terminal. `pump.fun/profile/<dir>` existe, detrás de un aviso de términos que no acepté [navegador] | `/rk/CÓDIGO`, «hasta 40 %» [código]; sus docs están caídas | No (`frame-ancestors 'self'`) |
| **Photon** | Wallet que genera Photon; la clave se enseña una vez [doc] | **No documentado** (solo lo dice un tercero) | No encontrada | No encontrado (su código no se pudo leer) | Phantom para login y depósito [doc]; su web pide instalar Phantom para entrar [navegador] | No encontrada | Solo fuentes de terceros | Solo se vio la página de desafío |
| **BullX** | — | — | — | — | — | — | — | **Trading desactivado** (lo dice el banner de su propio bundle); según la prensa, desde el 2026-06-01. Retirar fondos sigue funcionando. Descartado |
| **Trojan web** | No documentado (su FAQ dice que es no custodio) | Wallet → Import Wallet (10 activas); formato no indicado [doc] | No documentada; `/terminal` lleva a `/login/required` [navegador] | No documentado | Swaps básicos con la wallet de login; Limit y DCA piden importar [doc: FAQ] | Su Analyzer existe; no documenta URL por dirección [doc] | Honors, del 27,5 al 47,5 % [doc] | No se pudo ver (página de desafío) |
| **Bot Trojan** | Trojan [doc] | Settings → Wallets → Import, pegando en el chat base58 o array JSON; 10 wallets [doc] | No; solo `start=r-{ref}-{CA}` [doc] | No [doc] | No | No (remite a Solscan) | Hasta el 35 %, en 5 niveles [doc] | — |
| **BONKbot / Telemetry** | Su propio firmante, en TEE/KMS [doc] | No documentado [doc + código] | No | No [doc] | Phantom solo para login [código] | No | Bot: el 30 % el primer mes, el 20 % el segundo y el 10 % de por vida. Telemetry: 30 % fijo en tres niveles. Integradores: 5 % con su deep link [doc] | — |
| **jup.ag** (agregador, con un modo Trench para memecoins) | — | — | — | — | **WalletConnect por QR o enlace**; el swap Ultra pide `signTransaction` [doc + código] | **`jup.ag/portfolio/<dir>`, pública y sin cuenta («Watch-only»)** [navegador] | Para integradores de su API o Plugin [doc] | — |

**Camino inverso.** Es traer a SaverFi la wallet que el usuario ya usa en un terminal, pegando la clave una vez. Ventaja: no hay que mover fondos. No se ha probado con ningún terminal.

| Terminal | ¿Funcionaría? |
|---|---|
| Axiom | Debería: exporta base58 de 64 bytes [código] |
| Terminal (Padre) | Debería: exporta por Turnkey [código, confianza media] |
| Trojan | Solo si su export es base58 de 64 bytes o un array JSON, cosa que no está documentada |
| Photon | Solo si el usuario guardó la clave que se enseña una vez |
| GMGN | No, según su página dedicada y su cofundador |

El importador de SaverFi acepta 64 bytes en base58 o como lista JSON de 64 números, y rechaza frases semilla y claves de 32 bytes (`src/lib/import-key.ts:19-21, 60`).

**Deep links de Telegram.**
- El parámetro `start` admite 64 caracteres de `[A-Za-z0-9_-]` [doc: core.telegram.org/bots/features].
- Una clave base58 de 64 bytes (87-88 caracteres) no cabe, **pero el límite no protege**: la semilla de 32 bytes en base64url ocupa 43 y sí cabría.
- La razón para no hacerlo es otra: el valor llega como mensaje de un chat de nube y queda guardado en Telegram.

---

## 3. Privy

### 3.1 ¿Puede otra app usar la wallet sin exportarla?

- **Wallets globales (cross-app): no para Solana.**
  - Las páginas de global wallets no nombran Solana.
  - `useCrossAppAccounts` solo firma mensajes, EIP-712 y transacciones EVM. Pasa igual en 3.36.0 y en la última versión, **3.51.0 (2026-10-21)** [código].
  - Además, ser proveedor es una función Enterprise, el terminal tendría que integrarse como «requester» y cada firma abre una ventana de confirmación [doc].
- **wallet-standard: no cruza orígenes.**
  - Privy no registra su wallet en `window`.
  - Su receta la registra en la ventana de la propia app.
  - El estándar es un par de eventos dentro de una misma página. Para aparecer en gmgn.ai hay que ejecutar código allí, como hace una extensión o el navegador interno de una app móvil [código + doc].
- **Signers para terceros.**
  - Existen, pero toda llamada REST exige el app secret de SaverFi [doc].
  - Haría falta un relay propio [inferido].
  - Sería una integración por socio, no algo que un terminal active.
- **Export cifrado (HPKE).**
  - Existe por API: cifra la clave para una clave pública que elige quien llama. Solo lo puede pedir el dueño de la wallet, y entrega la clave entera [doc].
  - Usarlo con la clave de un socio es posible en teoría [inferido], pero es un export, no una delegación.
- **Actualizar Privy no cambia nada de esto.** Entre 3.36.0 y 3.51.0 no hay cambios en cross-app, global wallets ni export [doc: changelog].

### 3.2 Qué hace el export actual

- **Qué ve el usuario.**
  - `exportWallet({address})` abre el diálogo «Export wallet», que se pinta en la página de SaverFi.
  - Dentro va un iframe de `auth.privy.io` de 44 px con un único botón «**Copy key**», que escribe la clave en el portapapeles [código].
  - El diálogo no la muestra en ningún momento: solo la copia. Por eso no se puede seguir el consejo de GMGN de copiar una parte y teclear el resto [doc: GMGN Q&A]. El portapapeles es el único canal.
  - El iframe se sirve desde `auth.privy.io` y puede cambiar sin que cambie el SDK.
- **Formato y longitud.** Privy lo documenta como base58 [doc]. Que sean 64 bytes (87-88 caracteres, el formato de Phantom) es posible, pero no está verificado:
  - **A favor:** la ruta antigua del iframe codifica una secret key de 64 bytes, y el iframe de import de Privy exige 64.
  - **En contra:** el SDK de servidor importa claves de Solana sin comprobar la longitud, y para Stellar, otra cadena Ed25519, el servidor trabaja con semillas de 32 bytes.
  - Para las wallets TEE, el texto sale del servidor sin cambios y no se ha visto. **Lo resuelve la prueba T2.**
- **Cuándo resuelve la promesa.**
  - Resuelve al cerrar el diálogo, **se haya copiado o no**.
  - Si se cierra antes, en la pantalla de conexión, la promesa se rechaza [código].
  - SaverFi no puede saber si se copió.

---

## 4. Las cuatro vías, evaluadas

| Vía | ¿Sin exportar? | Dónde serviría | Esfuerzo | Veredicto |
|---|---|---|---|---|
| **(a) Flujo guiado**: abrir el terminal y copiar con Privy | No | Axiom y Terminal, si T2 da 87-88 caracteres. GMGN y Trojan web, sin formato documentado | **S** | **Recomendada** |
| **(a′) Pasarela**: importar la clave una vez en el Phantom, Backpack o Solflare del usuario | No (la copia queda en su dispositivo [inferido]) | GMGN «Trade with Wallet» (sin Anti-MEV ni automatizaciones), jup.ag, swaps básicos de Trojan web y pump.fun [inferido] | **S** (solo guía) | Como un destino más del panel |
| **(b) Solo lectura** con la dirección | Sí | Jupiter (pública, sin cuenta), Solscan (pública), GMGN (pide sesión de GMGN) | **S** | **Recomendada** |
| **(c1) SaverFi como wallet WalletConnect** | Sí | jup.ag [doc + código]. pump.fun y Raydium, solo por su código. No encontrado en GMGN; no en Axiom ni Terminal [código]; Photon no se pudo leer | **M** | Prototipo más adelante, si se quiere |
| **(c2) Extensión propia de SaverFi** | Sí | Donde firme una wallet de extensión (GMGN «Trade with Wallet», si no filtra por nombre). No en Axiom ni Terminal; en Photon, sin comprobar | **L** | No ahora: el riesgo principal es la cadena de publicación (caso Trust Wallet v2.68, 2025-12-24, unos 8,5 M$ [doc]) |
| **(c3) Wallets globales de Privy** | Sí | Ninguno (solo EVM) | — | No existe |
| **(d) Socios** | — | Referidos; datos de cartera por la API de GMGN | S–L (comercial) | Referidos sí, si el dueño quiere |

**Detalles de (c1), WalletConnect, para cuando se decida:**
- **Cómo sería.** El usuario empareja jup.ag con SaverFi pegando la URI. Cada `solana_signTransaction` llega a una pestaña de SaverFi abierta, que firma con `useSignTransaction` de Privy **mostrando confirmación**.
- **Lo que no se puede reutilizar.** `signWithTrading` firma sin pantalla (`src/lib/signing-wallets.ts:118-120`). Hoy está bien, porque los bytes los construye SaverFi; aquí los mandaría cualquier dapp emparejada.
- **Lo mínimo:**
  - mostrar el origen que da la Verify API y bloquear `isScam`;
  - simular y enseñar los cambios de SOL y tokens;
  - rechazar Approve, SetAuthority, Assign y cualquier instrucción al programa de SaverFi;
  - **rechazar todo mensaje que empiece por el consentimiento `0xFF"SIP_LINK_V1"`** (`packages/solana-program/programs/sip-vault/src/link_consent.rs:33-37`). Sin eso, una dapp podría pedir esa firma y enlazar la wallet a su propia bóveda tras un unlink.
- **CSP.**
  - Haría falta al menos `https://verify.walletconnect.org` (y `.com`) en `connect-src`.
  - También `https://pulse.walletconnect.org`, salvo que se desactive la telemetría (`telemetryEnabled:false`).
  - Y volver a capturar el golden. Los relays ya están.
  - No se ha probado en un navegador.
- **Sin probar de principio a fin:**
  - si Privy firma órdenes Ultra cuyo fee paga Jupiter;
  - si las peticiones llegan a tiempo a una pestaña en segundo plano;
  - si la confirmación cabe en la vida del blockhash. Un Retry de Privy recompila con otro (`src/lib/signing-wallets.ts:118`) y cambia los bytes, y jup.ag rechaza una transacción con bytes distintos.
- **Órdenes límite y DCA de jup.ag.** Pasan por un vault, y sus fills no los firma la trading wallet. El modo volumen no los contaría, y en modo profit el ingreso en el vault podría medirse como pérdida [inferido].

---

## 5. Seguridad de la vía recomendada

| Riesgo | Mitigación |
|---|---|
| **La clave en el portapapeles.** Puede acabar en el historial de Windows (25 entradas) y su sincronización en la nube, en el portapapeles universal de Apple o en el historial de Spotlight si está activado. Hay malware «clipper» que lo lee cada ~500 ms [doc: Microsoft, 2026-06-17]. La web no puede marcar el contenido como sensible (w3c/clipboard-apis#154, abierta) | Abrir el terminal **antes** de copiar y pegar enseguida. Avisar de desactivar el historial y la sincronización. Un botón opcional «Vaciar portapapeles» que explique lo que no borra. Nada de temporizador: sin foco, la escritura falla (y el usuario estará en la pestaña del terminal); en Firefox y Safari, además, hace falta un clic [doc: W3C §9.2.1, §11.2] |
| **Abrir el terminal sin clic, o tras cancelar.** Un `window.open` después de `await exportWallet` probablemente no se bloquearía en Chrome y Firefox, porque el clic en la X del diálogo da unos 5 s de activación [inferido, no probado]. Fallaría si se cierra con Esc más de ~5 s después del último clic, y en Safari no se sabe. Además, abriría el terminal aunque el usuario cierre el diálogo sin copiar | Un enlace `<a target="_blank" rel="noopener noreferrer">` aparte, con su propio clic. No abrir nada al resolverse `exportWallet` |
| **Phishing.** Un sitio que copie el botón, dominios parecidos al del terminal, redirecciones abiertas | Orígenes exactos fijos en el código y el dominio a la vista en el botón. Ningún destino que llegue por parámetro ni rutas tipo `/go?to=` (hoy no existe ninguna). Validar la dirección con `isPubkey`, como `solscanAccount`. Quitar los orígenes muertos de Privy (§1.1) |
| **Una clave exportada no se puede revocar** | Decirlo: si hay duda, crear otra trading wallet y mover los fondos. El permiso del keeper no cambia, porque la política va en el signer y no en la wallet (`src/lib/trading-wallets.ts:20-23`) |
| **Custodia en el destino** | Decirlo por terminal: GMGN, según su página dedicada, no la devuelve; Axiom la tiene en la memoria de su página; Terminal, en Turnkey. La bóveda no se ve afectada |
| **Qué sabe el terminal** | Con `Referrer-Policy: strict-origin-when-cross-origin`, el terminal solo ve el origen de SaverFi; con `rel="noreferrer"`, nada. El enlace de solo lectura une la IP y la cuenta del terminal con la dirección. La relación con SaverFi ya es pública en la cadena, porque la PDA del enlace sale de la wallet |
| **Tentación de automatizar más** con `useGetWalletPrivateKey` | Test de guarda (§1.4) |

**CSP.** Las vías (a) y (b) **no la tocan, ni tocan el test `check:csp`**:
- Ninguna directiva rige la navegación a otro origen: `navigate-to` se retiró del borrador CSP3 en la PR #564 (2022-09-16).
- `form-action` solo afecta a formularios.

Tres cosas sí la tocarían:
- incrustar un terminal. Las cabeceras de GMGN, Axiom y Terminal lo impiden. BullX lo permitiría, pero tiene el trading desactivado, y en Trojan y Photon no se pudo ver;
- el Plugin de Jupiter por etiqueta script, que `packages/website-oficial/scripts/check-csp.mts:134-136` rechaza a propósito;
- la vía WalletConnect (§4).

---

## 6. La recomendación, en concreto (sin construir)

Un panel **«Use in a terminal»** en cada fila de trading wallet (`TradingWalletRow`), junto a «Export key»:

1. **Destino**, de una lista fija en el código. Cada uno con su URL de partida y la ruta del menú:

   | Destino | URL de partida | Dónde pegar |
   |---|---|---|
   | GMGN | `https://gmgn.ai/?chain=sol` | Wallet Manager → Import wallet (pide sesión de GMGN) |
   | Axiom | `https://axiom.trade/portfolio` | Import (pide sesión) |
   | Terminal | `https://trade.padre.gg/wallets` | Import. Pide sesión; el login debería volver a `/wallets` |
   | Trojan | `https://trojan.com/terminal` | Wallet → Import Wallet (pide sesión) |
   | Phantom, Backpack o Solflare | Sin URL | En Phantom: Settings → Manage Accounts → Add/Connect Account → Import Private Key (guía de 2023). En Backpack y Solflare, su opción de importar una clave privada. Así la clave queda en la extensión del usuario, para GMGN «Trade with Wallet», jup.ag y los swaps básicos de Trojan |

   Se quedan fuera de la v1 los bots de Telegram (la clave quedaría en un chat de nube), Photon (sin importación verificada) y BullX (trading desactivado).
2. **Paso 1:** botón-enlace «Open gmgn.ai ↗», como `<a>` fijo con `rel="noopener noreferrer"`.
3. **Paso 2:** «Copy key», el diálogo de Privy que ya existe.
4. **Paso 3:** una línea: «Paste it only on gmgn.ai → Wallet Manager → Import wallet. SaverFi never asks for this wallet's key: its only key field is Import, for wallets from elsewhere.»
5. **Debajo:**
   - «View in Jupiter» (`https://jup.ag/portfolio/<dir>`, sin cuenta);
   - «Solscan» (ya existe);
   - «GMGN» (pide la sesión de GMGN del usuario).

**Qué se toca:** el componente de la fila, una lista de destinos, textos en `src/lib/vault-copy.ts`, tests y la página `/docs/trading-wallets`. Nada de CSP, keeper ni programa.

**Antes de abrirlo a usuarios:** las pruebas T1, T2 y T3 (§8).

**Referidos:** son opcionales. Exigen que el dueño cree cuenta en cada terminal para tener su código, y que la web lo diga con transparencia.

---

## 7. Automatizaciones

Están ordenadas por impacto y, a igual impacto, por menor esfuerzo. Las que dependen de otra van detrás de ella. Ninguna necesita actualizar el programa.

| # | Automatización | Problema real | Impacto | Esfuerzo | Dependencias |
|---|---|---|---|---|---|
| 1 | **La web muestra el estado del keeper para cada wallet** | El keeper ya publica por wallet el resultado del settle (`BELOW_RESERVE`, `NO_SIGNER`…) en el JSON de `/status` (`packages/solana-keeper/src/status.ts:27-33`), pero la web no lo usa. Su aviso de reserva solo comprueba `lamports > suelo + reserva`, sin la comisión ni lo que se va a pagar (`src/lib/live-model.ts:451-456`). Un `BELOW_RESERVE` no dispara ninguna alerta (`packages/solana-keeper/src/settle-decision.ts:791-793`). Tras rotar la llave del keeper, todas las filas seguirían diciendo «Linked» | Alto. Puede haber un ahorro esperando sin que el usuario lo sepa, cuando la web cree que la wallet puede liquidar y el programa no. Hoy ninguna wallet está en ese caso | **S** con el resultado que ya existe; **M** con «faltan X SOL» (hoy ese importe va como texto) | `SIP_SOLANA_KEEPER_URL` (ya existe) y la URL del keeper de volumen (no existe en la web). 0 créditos de Helius. `/status` es público y lista todas las wallets |
| 2 | **Panel «Usar en un terminal» + enlaces de solo lectura** (§6) | La pregunta del dueño | Alto para el uso diario | **S** | Las pruebas T1, T2 y T3. Referidos, opcionales |
| 3 | **Monitor externo de `/health` y de la entrega de alertas** | Según los docs de Railway, el healthcheck solo se mira al desplegar; el comentario de `packages/solana-keeper/src/status.ts:311-312` dice lo contrario. Un `REFUSED` de inversión tiene severidad `warn`, y por defecto solo salen las `critical` (`packages/solana-keeper/src/config.ts:742`), así que no llega a Telegram | Alto para la operación | **S** | Una cuenta de monitorización (la crea el dueño) |
| 4 | **Avisos por Telegram al usuario**: cada ahorro, cada compra, «faltan X SOL», «vuelve a dar permiso» | El ahorro pasa en silencio. `packages/solana-keeper/src/alerts.ts` sirve solo al chat del operador | Alto para la retención | **M** | Un bot nuevo (lo crea el dueño en BotFather). Un servicio nuevo, el notifier, en Railway: lee `settlement_event` e `investment_event` del Postgres del keeper, sin lecturas de Helius. Para «faltan X SOL» y «vuelve a dar permiso», la n.º 1 o `/status`, porque esas tablas no guardan el estado. Una tabla de suscripciones `owner ↔ chat_id` en ese Postgres, escrita por un endpoint del notifier: la web no tiene base de datos. El vínculo, con `t.me/<bot>?start=<nonce>`, porque los bots no pueden escribir primero [doc], más una firma de la pension key o un servidor que verifique el token de acceso de Privy |
| 5 | **Financiar la trading wallet con un clic desde la pension key** | La web no construye ninguna transferencia de fondeo: el usuario copia la dirección a mano (`src/app/docs/_content/trading-wallets.tsx:50-52`) | Alto | **M** | **Antes**, comprobar con una transacción real si lleva Lighthouse (§1.3). Si lo lleva, que el keeper acepte las comprobaciones 6 y 10: copiar el comprobador al keeper y nombrarlo en el `COPY` del Dockerfile, porque el keeper no puede importar `@sip/solana-core` (`packages/solana-keeper/Dockerfile:89-104`). Un intent de fondeo en `src/lib/tx-intent.ts` y una regla nueva en el relay, porque `packages/solana-core/src/server/verify-tx.ts` solo acepta instrucciones de SaverFi del owner. El importe propuesto sale de la n.º 1 |
| 6 | **CI + comprobación de los dominios de Privy** | No existe `.github`. Vercel no ejecuta vitest. Nadie comprueba que el dominio canónico esté permitido en Privy: el 2026-10-22 faltó durante unas horas (§1.1) | Medio-alto | **S** | El dueño activa «Wait for CI» en Railway. Un script lee `allowed_domains` de la configuración pública de Privy y exige el origen canónico que resuelve `src/lib/site-url.ts` (en `origin/main`: `SIP_SITE_URL` y, si falta, `VERCEL_PROJECT_PRODUCTION_URL`) |
| 7 | **Guarda y alerta de export** | `useGetWalletPrivateKey` existe en el SDK (§1.4) | Medio (seguridad) | **S–M** | Un test que prohíba importarlo. Opcional: el webhook `wallet.private_key_export` de Privy, que distingue `display` de `client` [doc], con un endpoint que verifique la firma y su configuración en el dashboard |
| 8 | **Aviso de volver a firmar** | Hay dos casos. Si salta el suelo del 50 % de la conversión de SOL (`packages/solana-core/src/client/product.ts:174`), el turno sigue (IDLE o INVESTED) y solo deja una nota. Si salta el suelo de una acción en una política firmada antes del 2026-10-08, el turno sale REFUSED con un `warn`, que con el umbral `critical` tampoco llega a Telegram. La web ya ofrece «Sign again at today's price», pero solo si el usuario entra | Bajo-medio | **S** | La n.º 4, para avisar a quien no entra, y un campo nuevo en `/status` con la parada por suelo (trabajo del keeper). Firmar no se puede automatizar: lo hace la pension key |
| 9 | **Resumen semanal**: lo ahorrado, las compras, la racha | No hay ningún resumen. El login es solo con wallet, así que no hay email | Bajo hoy (3 bóvedas); medio con usuarios | **S** tras la n.º 4 | La n.º 4. Las filas son de mejor esfuerzo: decir «según el historial de SaverFi» |

Correcciones a la idea 4 del informe del 2026-10-20 (`ROADMAP_NEXT_RESEARCH_2026-10-20.md`):
- Los avisos de Telegram **no** suman lecturas por settle si salen de Postgres.
- La sesión iniciada sirve para vincular el chat solo si un servidor verifica el token de acceso de Privy con su clave pública [doc], porque la web no tiene sesión propia en el servidor. La alternativa es una firma de la pension key.
- La tarjeta de la idea 5 ya está en `origin/main` (`5587e15`, `0638a2e`), pero solo como imagen. La página `/v/[vault]` y el código de referido siguen pendientes, y dependen de los referidos (§9, n.º 4).

---

## 8. Pruebas que solo puede hacer el dueño (con una wallet desechable y vacía)

- **T1. `saverfi.cash`.** Iniciar sesión y pulsar «Export key» en `saverfi.cash`, con la consola abierta, para confirmar que ya no sale el error de frame-ancestors.
- **T2. Longitud de la clave, sin verla.** Pulsar «Copy key» y, en el Terminal de macOS, contar los caracteres:
  ```bash
  pbpaste | tr -d '\n' | wc -c
  ```
  - 87-88 caracteres son 64 bytes: valen para Axiom y Terminal.
  - 43-44 son 32 bytes: no valen.

  Después, vaciar el portapapeles:
  ```bash
  pbcopy < /dev/null
  ```
- **T3. Cada destino.**
  - Abrir la URL de partida de §6, con sesión y sin ella.
  - Contar los clics hasta «Import».
  - Ver si `?ref`, `?rk` o `@código` sobreviven al login.
- **T4. En el móvil**, en iPhone y en Android: el diálogo de Privy, el pegado y la apertura de cada terminal.
- **T5. GMGN «Trade with Wallet»**, con Backpack o Solflare instalados: ver qué wallets ofrece.
- **T6. jup.ag**, si interesa la vía WalletConnect: comprobar que el QR tiene «Copy link». Sin emparejar nada.

---

## 9. Preguntas para el dueño

1. ¿Quitas de Privy los dominios muertos de §1.1: el de Railway y los `www.` sin certificado? ¿Y también `localhost`, creando antes una app de Privy para desarrollo?
2. ¿Construyo el panel «Usar en un terminal» (§6) en mi worktree, con los destinos GMGN, Axiom, Terminal, Trojan y Phantom/Backpack/Solflare?
3. ¿Corrijo los textos de §1.2? Son cinco: Photon en la landing, «de GMGN», «a trading bot», «the key appears» y «its key works in Axiom, GMGN or any Solana app».
4. ¿Quieres usar códigos de referido de los terminales en esos enlaces?
5. ¿Qué automatizaciones van primero? Mi orden es el de §7.
6. ¿La vía WalletConnect para jup.ag (§4) se queda para más adelante?

---

## Fuentes principales (todas consultadas el 2026-10-22)

- **GMGN:**
  - docs.gmgn.ai/index: llms.txt y las páginas «TG Wallet Import & Export Private Key», «Multi-Wallet System», «Referral Link», «Agent API» y «Fees»;
  - github.com/GMGNAI/gmgn-skills.
- **Axiom:**
  - docs.axiom.trade: faqs, signup, referral-program y fees;
  - turnkey.com/customers/axiom-global-defi-trading-platform;
  - JS público de axiom.trade (ImportWalletModalSol, boot-app).
- **Terminal / Padre:**
  - JS público de trade.padre.gg y de terminal.pump.fun;
  - cointelegraph.com, sobre la compra por Pump.fun (2025-10-24).
- **Photon:** pies-organization.gitbook.io/photon-trading, enlazada desde photon-sol.tinyastro.io.
- **BullX:**
  - el bundle de neo.bullx.io (banner de cierre);
  - Phemex (2026-06-01).
- **Trojan:**
  - docs.trojanonsolana.com;
  - docs.trojan.com: faqs, wallet-management y referral-system.
- **BONKbot:** docs.bonkbot.io: deep-links, referrals y signer.
- **Telegram:**
  - core.telegram.org/bots/features;
  - core.telegram.org/api/links;
  - telegram.org/faq.
- **Jupiter:**
  - docs.jup.ag/user-docs/manage/connect-wallet;
  - developers.jup.ag/docs: swap, plugin y referral-program.
- **Privy:**
  - docs.privy.io: global-wallets, wallets/export, programmatic-export, recipes/solana/standard-wallets, recipes/react/cookies, recipes/dashboard/allowed-domains y changelogs/react-auth;
  - el paquete instalado @privy-io/react-auth 3.36.0, y la 3.51.0 en jsdelivr;
  - el chunk de export de auth.privy.io.
- **WalletConnect:** docs.walletconnect.com/wallets: web/usage, chains/solana y web/verify.
- **wallet-standard:**
  - github.com/wallet-standard/wallet-standard (register.ts);
  - github.com/anza-xyz/wallet-standard (WALLET.md).
- **Phantom y Solflare:**
  - docs.phantom.com: deeplinks, lighthouse y solana-actions-and-blinks;
  - phantom.com/learn/blog/import-and-manage-multiple-wallets-with-phantom (2023);
  - docs.solflare.com: deeplinks e import-any-solana-wallet.
- **Seguridad web:**
  - html.spec.whatwg.org: enlaces y activación de usuario;
  - w3c.github.io/clipboard-apis;
  - github.com/w3c/webappsec-csp/pull/564;
  - developer.mozilla.org: Clipboard API, window.open, postMessage y form-action.
- **Portapapeles:**
  - support.microsoft.com (portapapeles de Windows);
  - support.apple.com (Universal Clipboard, Spotlight);
  - microsoft.com/en-us/security/blog (clipper, 2026-06-17).
- **Chrome Web Store:**
  - developer.chrome.com/docs/webstore: review-process y update;
  - trustwallet.com/blog (incidente v2.68).
- **Railway:** docs.railway.com: healthchecks y restart-policy.
- **Cadena:** JSON-RPC de solo lectura a api.mainnet-beta.solana.com (programa `6kA9H9zQ…`, las 4 trading wallets enlazadas y sus settles), y el `/status` público de los dos keepers.
