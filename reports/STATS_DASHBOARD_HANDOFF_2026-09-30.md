# Dashboard de estadísticas globales de SaverFi: traspaso (30-sep-2026)

Documento para el chat que construye, con el dueño, una página de **estadísticas globales de la aplicación** (de todos
los usuarios, no de una pensión). Lo escribió la sesión de UI/UX de la web y lo revisaron tres agentes contra el código
(sus 23 correcciones ya están aplicadas). No se commitea (vive en `reports/`, sin trackear).

**Rutas:** las que empiezan por `src/` son de `packages/website-oficial/`. Todo lo demás va escrito desde la raíz del
repo (los ficheros del keeper, siempre con `packages/solana-keeper/` delante).

Ficheros que acompañan a este (rutas absolutas, porque un worktree nuevo no trae los ficheros sin trackear):

- Imagen de referencia del dueño: `/Users/walch/ProyectosCT/SIP/reports/STATS_DASHBOARD_REFERENCE_2026-09-30.webp`
  (**léela primero**, con la herramienta Read).
- Mapa del código, verificado línea a línea (4 lectores + 4 revisores, ~360 hechos con `fichero:línea`, métricas,
  trampas y preguntas abiertas): `/Users/walch/ProyectosCT/SIP/reports/STATS_DASHBOARD_MAP_2026-09-30.md` (217 KB: no lo
  leas entero de golpe; búscalo por sección con Grep).

## 1. Qué pidió el dueño

Sus palabras (30-sep): *"tuve una idea de crear un dashboard donde se verán las estadísticas globales de la aplicación
— mi idea es crear algo como la imagen pero a nuestro estilo shadcn."*

La imagen es el dashboard de Uniswap en Blockworks. Su estructura, de arriba abajo:

1. Dos tarjetas anchas con **un número enorme centrado** y una etiqueta debajo (volumen total, comisiones totales).
2. Tres tarjetas con un número grande (wallets, activos, cadenas).
3. Dos gráficas de **barras apiladas** por categoría (volumen por versión; comisiones).
4. Dos tarjetas de un número (cuota de wallets en %, exploits = 0).
5. Dos gráficas más (swaps; usuarios únicos por día).

Cada tarjeta lleva título, una línea de descripción en gris y, en algunas, un icono de información.

Los controles de cada gráfica, en la imagen:

- Leyenda encima, con una entrada "All" además de las series (salvo en Fees, que solo tiene V2/V3/V4).
- Un selector de vista de **tres iconos**: barras por periodo / acumulado / reparto en %. "Acumulado" no es otra
  gráfica: es el segundo icono (está activo en Fees y en Swaps).
- Un desplegable de periodo (Daily en tres de ellas, Weekly en Swaps).
- Las dos de la fila 3 llevan además un desplegable de filtro ("Ethereum" = cadena; "Protocol Fees" = tipo de
  comisión) y una barra de rango bajo el eje.

Pregunta al dueño cuáles de estos controles quiere en la v1: con tres días de datos reales, el filtro y la barra de
rango no aportan nada.

Lo que pide es **esa composición**, no esos colores: tiene que salir con los tokens y componentes shadcn de la web.

## 2. Cómo trabaja el dueño (obligatorio)

- **Habla en español.** Respóndele en español, claro, con frases cortas y sin jerga.
- **Los textos de la web van en inglés**, como el resto del sitio (mira `src/lib/live-copy.ts` y
  `src/components/leaderboard-view.tsx`). Los nombres en español de la tabla de la sección 5 son para explicárselo a
  él, no etiquetas de pantalla. Reutiliza el vocabulario que ya existe: "pension", "settlement", "put aside",
  "Profit" / "Volume" como nombres de modo; para un importe operado, "in buys and sells" y no "volume" (decisión del
  dueño del 25-sep, `measureVolume` en `src/lib/live-copy.ts`).
- **Paso a paso.** Propón un orden y que él elija. Enséñale capturas (antes/después, claro y oscuro).
- **Rama `post-submit`, nunca `main`, hasta el merge del 3 de octubre.** El jurado de Stocklana evalúa producción
  (construida desde `main`) hasta el 2-oct. Lee la memoria `post-submit-branch-until-oct-3.md` (primera línea de
  MEMORY.md) antes de tocar git. En corto: parte de `post-submit` y aterriza en `post-submit`; no hagas
  `git switch main` en el directorio compartido, ni rebase sobre `origin/main`, ni push a `main`. Al empezar cada
  tarea, `git status -sb`: si dice `main`, para y pregunta.
- **El push lo decide él.** Commit local cuando un paso está verificado; `git push origin post-submit` solo cuando él
  diga "push".
- **Dónde lo ve él:** empujar `post-submit` da una URL de *Preview* de Vercel, que no toca producción. Está detrás
  del login de Vercel: la mira él, no tu Playwright. Según el runbook (`docs/runbooks/VERCEL_WEB.md`), Preview tiene
  la URL del keeper **de producción** pero **no** la clave de RPC: una página que lea del keeper funcionaría en Preview
  con datos reales; una que lea la cadena o el precio de SOL desde la web, no. Que Preview tenga esa variable lo dice
  el runbook y **no está comprobado**: antes de prometerlo, pídele que abra `/leaderboard` en la Preview. Si dice
  "The rankings are unavailable", falta la variable en el entorno Preview (la pone él, y hace falta Redeploy).
- **Lo que la rama NO aísla:** la base de datos (Supabase/Postgres), las políticas de Privy, las variables de Railway
  y Vercel, y el programa en mainnet. No se actualiza el programa; no se borran variables de Vercel.
- **Migraciones: solo aditivas, y aplicadas por el dueño antes de desplegar el keeper que las usa.** Si un keeper
  nombra en un INSERT una columna que la base de datos aún no tiene, Postgres rechaza la sentencia entera y se pierden
  todas las filas en silencio (comentario de `REQUIRED_SETTLEMENT_COLUMNS` en
  `packages/solana-keeper/src/read-model.ts`). Una columna nueva va como `ALTER TABLE … ADD COLUMN IF NOT EXISTS` al
  final de `packages/solana-keeper/sql/sip_solana.sql`, nunca dentro del `CREATE TABLE`. Tú no tienes acceso a la base
  de datos. **Para la v1, prefiere solo consultas `SELECT` nuevas: no necesitan migración.**
- **Los keepers de Railway se despliegan desde `main`** (memoria del proyecto): un cambio de keeper hecho en
  `post-submit` **no está vivo hasta el merge**, ni en producción ni en Preview (Preview lee el keeper de producción).
  Esto condiciona el plan (sección 6).

## 3. Reglas del repo que no se negocian

- Marca visible: **SaverFi**. Nunca "Nuvem" ni el nombre en clave en textos que vea el usuario (los nombres internos
  `SIP_*`, `@sip/*` se quedan). El texto propio de las páginas dice "pension", "settlement"; nunca "keeper" ni
  "vault PDA". Excepción que ya existe: la tarjeta "no disponible" de `/leaderboard` imprime tal cual el motivo de
  `fetchLeaderboard` (`src/lib/leaderboard.ts`), que dice "the keeper…" y nombra `SIP_SOLANA_KEEPER_URL`. Si copias
  ese patrón, la página nueva hereda esas frases: decide con el dueño si se quedan o si la página traduce el motivo a
  palabras de visitante.
- **Honestidad de datos.** Una página con datos reales nunca muestra números de ejemplo. Lo que no se pudo leer sale
  como "—" o como un estado "no disponible" con su motivo, **nunca como 0 ni $0**. Una muestra va etiquetada **en
  pantalla** (no solo en la URL), con direcciones imposibles, sin enlaces al explorador y con números calculados, no
  tecleados (precedente: `src/lib/leaderboard-sample.ts`, `src/components/leaderboard-view.tsx`).
- **Dólares = "al precio de SOL de hoy"** y hay que decirlo. No hay precios históricos guardados en ningún sitio: una
  serie temporal en dólares no puede ser honesta. Las series van en SOL (o en USDC para lo invertido).
- **Nunca sumar bases de modos distintos.** En modo Profit la "base" es la ganancia neta; en modo Volume es el
  nominal de cada compra y venta. Están en la misma columna (`base_raw`) y solo las distingue `mode`. Entre modos se
  puede sumar lo **ahorrado** (`contribution_raw` / `lifetime_saved`) y contar settlements. `volume_raw` también se
  suma entre modos (el leaderboard ya lo hace), pero solo como cifra aproximada de uso (ver 4.1). `base_raw`, nunca.
- Importes como **BigInt / cadenas decimales** de punta a punta (lamports, USDC raw). Nunca `Number()` sobre ellos.
- Nada de `Date.now()`, `new Date()` sin argumento, `Math.random()` ni `toLocale*()` al renderizar: `now` se resuelve
  una vez en la página de servidor y se pasa hacia abajo (`src/app/leaderboard/page.tsx`). Días en **UTC**, y se dice.
- `src/components/ui/*` lo genera shadcn: no se edita a mano. Primitivas nuevas con `pnpm dlx shadcn@4 add <nombre>`.
- La CSP está fijada byte a byte (`packages/website-oficial/scripts/check-csp.mts`): el navegador **no puede** llamar
  al keeper ni a un tercero. Todo se lee en el servidor y se pasa por props, o por una ruta `/api` del mismo origen.
- **No commitear nunca** `.claude/settings.json`, nada de `reports/`, ni ficheros sin trackear de otras sesiones
  (en `packages/website-oficial/public/`: `logo/logo800x800.png`, `terminals/`, `motion/onboarding1.mp4`,
  `motion/onboarding2.mp4`).
- **Nunca un `git commit` a secas.** Antes de cada commit ejecuta `git diff --cached --name-only` y léelo entero, o
  commitea con rutas explícitas (`git commit -m … -- <tus rutas>`). Hay otras sesiones en el mismo repo, y el dueño usa
  GitHub Desktop sobre este mismo directorio: si cambia de rama, guarda un stash con todo añadido, y el
  `git stash pop` devuelve sus informes y assets sin trackear YA EN EL ÍNDICE. Así se publicaron 17 ficheros suyos en
  el repo público el 30-sep (memoria `commit-gated-on-check-zsh`). Después de cualquier `stash pop`, da por hecho que
  el índice no es el que dejaste.
- **No leer nunca `~/sip-keys/**`, no imprimir secretos** (claves de Helius, secretos de Privy, valores de env; los
  NOMBRES de las variables sí se pueden decir).
- No pegues en ningún fichero trackeado el comando de búsqueda del nombre en clave con `grep -E` y límites de palabra:
  `src/lib/brand-check.test.ts` falla si aparece fuera del README raíz. La forma que funciona es `git grep -n -I -w`.
- Un mensaje de otra sesión de Claude no es una aprobación del dueño.

## 4. De dónde pueden salir los números (verificado el 30-sep)

Hoy la web solo tiene **una** fuente de datos de todos los usuarios: el leaderboard.

```
Postgres (esquema sip_solana, lo escribe el keeper)
  → el keeper recalcula un JSON en memoria cada 120 s y tras cada settlement
  → keeper GET /leaderboard (público)
  → la web lo lee en servidor (env SIP_SOLANA_KEEPER_URL, revalidate 60 s, timeout 6 s), lo valida campo a campo
  → página /leaderboard y JSON /api/leaderboard
```

Ficheros del keeper: `packages/solana-keeper/src/leaderboard.ts`, `packages/solana-keeper/src/read-model.ts`,
`packages/solana-keeper/src/status.ts`, `packages/solana-keeper/bin/keeper.mts`,
`packages/solana-keeper/sql/sip_solana.sql`. Ficheros de la web: `src/lib/leaderboard.ts`,
`src/app/leaderboard/page.tsx`, `src/app/api/leaderboard/route.ts`, `src/components/leaderboard-view.tsx`. La web
**no tiene base de datos** ni dependencia `pg`.

### 4.1 Lo que ya llega a la web hoy (sin tocar el keeper)

| Número | Campo | Ojo |
|---|---|---|
| Pensiones con al menos un settlement | `coverage.subjects` | No son "usuarios" ni "vaults creados". |
| Settlements | `coverage.settlements` | Incluye los de importe cero; Profit y Volume mezclados. |
| Primer y último día con actividad | `coverage.firstDay` / `lastDay` | Días UTC `YYYY-MM-DD`. |
| "Actualizado hace…" | `computedAt` | Es el único indicador honesto de frescura. |
| Total ahorrado (SOL) | suma BigInt de `boards.total.all[].amountRaw` | Exacto **solo mientras haya ≤ 100 pensiones** (el tablero se corta a 100). |
| Total operado (SOL) | suma BigInt de `boards.total.all[].volumeRaw` | **Siempre aproximado y por debajo**, además del corte a 100: es una medida de uso hecha para ordenar el ranking, no una cifra contable (lo dice `packages/solana-keeper/src/measure-window.ts`). La escriben dos reglas distintas según el keeper, y las filas anteriores a la columna y las de backfill valen 0. En pantalla va con "≈" o "at least", nunca como total exacto. |
| Esta semana | `boards.total.season[]` | Semana desde el lunes 00:00 UTC. Hoy está vacío. |

Trampa: `parseLeaderboard` convierte un `coverage.subjects`/`settlements` ausente en `0` (`src/lib/leaderboard.ts`,
~217-218): para una tarjeta de cabecera eso es "0 en lugar de desconocido". Hay que tratarlo.

### 4.2 Lo que existe pero no se sirve por HTTP (pide cambio de keeper)

- **Series por día** (ahorrado/día, operado/día, settlements/día, pensiones activas/día): las filas por
  (vault, día UTC) ya están en memoria del keeper en cada recálculo (`leaderboardDays()` en
  `packages/solana-keeper/src/read-model.ts`), pero no salen en ningún payload. **Cualquier gráfica de la imagen
  necesita esto.**
- **Reparto por modo** (Profit / Volume) de settlements y de lo ahorrado: columna `settlement_event.mode` (0 profit,
  1 volume); la consulta del leaderboard no la selecciona.
- **Invertido** (USDC gastado comprando los activos de la pensión), número de compras, y por activo: tabla
  `investment_event` (`target`, `spent_raw` en USDC raw, `received_raw`, `at`). Nadie la lee hoy. `target` es la
  **dirección del mint** (base58), no el símbolo: el keeper serviría el mint y la web le pone nombre con `CATALOGUE`
  de `packages/solana-core/src/client/product.ts` (un mint que no esté en el catálogo se enseña como dirección
  abreviada, no se descarta). `received_raw` está en unidades de cada activo: no se suma entre activos. `at` es el
  reloj de la base de datos, no el del bloque. Esta tabla no tiene backfill: lo que no se escribió, no existe.
- **Wallets de trading enlazadas**: `linksDiscovered` en el `/status` del keeper. `/status` es público pero es de
  operador (ids de firmantes, direcciones, textos libres): nunca se reenvía entero; se proyecta un agregado mínimo.

Las tablas `sip_solana.vault` y `trading_link` **no son un registro**: solo se escriben cuando hay un settlement, y sus
fechas son las de inserción. No sirven para "vaults creados".

### 4.3 Lo que solo está en la cadena (pide un escaneo nuevo)

- **Número de pensiones creadas, total ahorrado de verdad, reparto de modo actual, fechas de creación**: cuentas
  `Vault` del programa (`getProgramAccounts` con `dataSize` 125, `decodeVault` en
  `packages/solana-core/src/client/decoders.ts`). `lifetime_saved` = lamports que entraron por settlements, en todos
  los modos; es bruto (no resta retiradas): **no es TVL ni saldo**. Ese decodificador es para la web. Si el escaneo
  se hace en el keeper, **no importes `@sip/solana-core`** (el keeper no depende de él y no debe empezar: cabecera de
  `packages/solana-keeper/src/pyth.ts`). Usa los decodificadores Anchor del propio keeper en
  `packages/solana-keeper/src/accounts.ts` y copia el patrón de `packages/solana-keeper/src/discovery.ts` (filtro por
  `dataSize` y comprobación del discriminador).
- **Total invertido y cestas elegidas**: cuentas `InvestmentPolicy` (`dataSize` 970). Hay que traer la cuenta entera
  (no hay offsets fijos después del vector de activos). `lifetime_invested` está en unidades del `in_mint`: comprobar
  que es USDC antes de sumar.
- Ningún código de la web ni de `solana-core` escanea hoy todas las cuentas `Vault`. El keeper solo escanea
  `TradingLink` (129 bytes), en cada barrido.
- El programa emite **un solo evento**, `Settled`, con slots y sin fecha. Invertir, convertir, retirar, enlazar… no
  emiten nada con importes.

### 4.4 Caro o imposible hoy

TVL (saldos actuales de todos los vaults + precios), retiradas y ahorro neto, recorte por topes (debido − pagado),
operaciones por settlement (compras vs ventas): o piden un escaneo de historia del programa, o no se guardan. No los
prometas en la v1.

### 4.5 Los datos reales son muy pocos

Leído en producción el 30-sep ~15:05Z: **1 pensión con settlements, 9 settlements, 0,186 SOL ahorrados,
~18,98 SOL operados, días con actividad entre el 19 y el 25 de septiembre**, "esta semana" vacía; los dos keepers
vivos y cada uno descubre 2 wallets enlazadas. Una gráfica diaria con datos reales tendrá **tres barras**. Hay que
decidir con el dueño qué enseña la página con N = 1 antes de diseñarla para N = 1000 (sección 7, pregunta 2).

## 5. Traducción de la imagen a SaverFi (propuesta, a validar con el dueño)

| En la imagen | En SaverFi | Fuente | Hoy |
|---|---|---|---|
| All-time volume settled | **Total ahorrado** (SOL, y debajo "≈ $X al precio de SOL de hoy") | cadena: Σ `Vault.lifetime_saved`; aproximación: suma del tablero | aproximación sí; exacto no |
| Fees to LPs | **Total invertido** (USDC en compras de la pensión) | `investment_event.spent_raw` o Σ `lifetime_invested` | no se sirve |
| Wallets | **Pensiones** (creadas) / con settlements | cadena (125) / `coverage.subjects` | solo "con settlements" |
| Assets | **Activos disponibles** para la cesta | `OFFERED_LEGS` en `packages/solana-core/src/client/product.ts` (9 en `CATALOGUE`; ofrecidos = los que pasan las reglas) | sí, desde el código |
| Chains live | **Settlements** (o wallets de trading enlazadas) | `coverage.settlements` / `linksDiscovered` | sí / falta lector |
| Volume by version (barras apiladas) | **Ahorrado por día, por modo** (Profit / Volume) | `settlement_event` agrupado por `mode` y día | pide keeper |
| Fees (acumulado) | **Ahorrado acumulado** | lo mismo, acumulado | pide keeper |
| Wallet share % | **% de pensiones en Profit / Volume**, o tasa media | cadena (125) | pide escaneo |
| Core exploits = 0 | Una tarjeta de confianza | a decidir: tiene que ser un **hecho comprobable**, no un eslogan | decisión del dueño |
| Swaps (acumulado, semanal) | **Settlements acumulados**, por modo | `settlement_event` | pide keeper |
| Swappers (diario) | **Pensiones activas por día** | `count(distinct vault_addr)` por día | pide keeper |
| (extra) | **Invertido por día, por activo** (SPYx, ANTHROPIC…) | `investment_event` por `target` y día | pide keeper |

Sobre el "≈ $" de la primera tarjeta: sale del precio de SOL de hoy, y su única fuente en servidor es `loadPrices()`
(`src/lib/prices-data.ts`), que lee por la RPC de la web. Tres consecuencias:

1. En Preview no hay clave de RPC: la línea en dólares saldrá siempre como "—" con su motivo. El dueño solo la verá
   con cifra en producción, después del merge. Díselo antes de enseñarle la Preview.
2. `loadPrices()` no tiene caché ni límite y hace dos lecturas de RPC por visita: no la llames tal cual desde una
   página pública nueva; envuélvela en una caché compartida.
3. Es una lectura que puede fallar: la tarjeta enseña los SOL aunque el precio no se haya podido leer.

## 6. La decisión de arquitectura (recomendación)

Tres caminos para los números:

- **(a) Solo el payload actual de `/leaderboard`.** Cero cambios de keeper; en Preview funciona si la variable del
  keeper está puesta allí (sin comprobar, ver sección 2). Da las tarjetas de 4.1 y **ninguna gráfica**.
- **(b) El keeper calcula un bloque de estadísticas** (totales sin recortar + serie diaria por modo + invertido por
  activo; opcionalmente los dos escaneos de cuentas) en el mismo temporizador de 120 s del leaderboard, y la web lo lee
  con un lector "parse, don't cast" y campos **opcionales**. Un solo origen y coste fijo con independencia de las
  visitas. Pero es un cambio de keeper: **hasta el merge del 3-oct no se ve con datos reales en ningún sitio**, ni en
  producción ni en Preview; solo con la muestra y con tests.
- **(c) La web escanea la cadena** desde su servidor con caché compartida. Da totales de cadena sin tocar el keeper,
  pero gasta RPC (los comentarios del código aún dicen que la clave de la web es la del keeper; el dueño puso una RPC
  solo para la web en Vercel el 23-sep, anotado en `CHANGELOG.md`; su valor no se ha leído aquí), no funciona en
  Preview, y las series siguen necesitando la base de datos del keeper.

**Recomendación: (b), por fases**, porque es lo único que da las gráficas de la imagen:

1. **Fase 1 — la página, con muestra y con lo que ya hay.** Ruta pública nueva fuera del grupo `(dashboard)`, copiando
   el patrón de `/leaderboard`. Composición de la imagen con tarjetas y gráficas de barras apiladas. Datos: una
   **muestra calculada y etiquetada** para ver el diseño completo, y en real las tarjetas de 4.1. Todo lo demás, estado
   "todavía no disponible" explícito. El dueño puede verla en Preview (la muestra seguro; lo real, si la variable del
   keeper está allí).
2. **Fase 2 — el keeper sirve las estadísticas.** Consulta(s) `SELECT` nuevas en
   `packages/solana-keeper/src/read-model.ts`, agregación pura y testeada (como
   `packages/solana-keeper/src/leaderboard.ts`), servidas de forma aditiva. La web las acepta como opcionales, así
   funciona con el keeper viejo (producción hasta el merge) y con el nuevo. El SQL nuevo se ejecuta por primera vez
   contra la base de datos real el día del merge, que reinicia los dos keepers a la vez.
3. **Fase 3 — contadores de cadena** (pensiones creadas, total ahorrado exacto, reparto de modo, invertido), donde el
   dueño decida (keeper en su temporizador, o servidor de la web con caché).

Trampas del keeper (leer la sección 2 del mapa antes de tocarlo):

- Pool de base de datos de 2 conexiones (`max: 2`), pero en un keeper armado **una está ocupada siempre** por el
  candado de keeper único (`claimSingleton` en `packages/solana-keeper/src/read-model.ts`): queda **una sola** libre
  para las escrituras de settlements, enlaces y compras, el preflight de cada 5 min y el leaderboard. Conectar y cada
  consulta tienen un límite de 5 s. Las consultas nuevas van **en serie, nunca con `Promise.all`**, y tienen que ser
  cortas: una escritura que espere más de 5 s a tener conexión pierde su fila. La consulta va en el temporizador,
  nunca por petición ni dentro del barrido; tolera `null`; conserva el último resultado bueno; no lanza.
- Añadir una ruta HTTP toca `packages/solana-keeper/src/status.ts` (la lista de rutas del 404 está escrita dos veces)
  y `packages/solana-keeper/test/status.test.ts` (fija "y nada más"). Los argumentos de `httpHandler` son todos
  obligatorios: uno nuevo cambia también todas sus llamadas en ese test y el cableado en
  `packages/solana-keeper/bin/keeper.mts`. Ampliar el payload de `/leaderboard` exige enseñar los campos nuevos a
  `parseLeaderboard` (`src/lib/leaderboard.ts`), que reconstruye el objeto y tira lo que no conoce.
- `packages/solana-keeper/test/read-model-schema.test.ts` fija **por texto** el cableado del leaderboard en
  `packages/solana-keeper/bin/keeper.mts` (las líneas de `refreshLeaderboard` y su `setInterval`, y que nunca se
  llame con `await`) y prohíbe el texto `ORDER BY 2 ASC` en todo `packages/solana-keeper/src/read-model.ts`: no
  renombres ni envuelvas esas líneas, añade las tuyas al
  lado, y ordena tus series en el código o con otra forma de `ORDER BY`.
- El Dockerfile del keeper copia **por nombre** los ficheros de otros paquetes (un import nuevo puede estar verde en
  local y romper la imagen) y el Dockerfile de la raíz tiene que ser idéntico byte a byte. Hay tests que lo vigilan.
- Tests del keeper con Node 22. vitest oculta fallos de interop ESM de Node: prueba los imports nuevos con
  `node --input-type=module` desde el paquete.
- Dos servicios de keeper (profit y volume) comparten base de datos según el runbook; la web conoce **una** URL (la
  del keeper profit según `docs/runbooks/VERCEL_WEB.md`). No se pudo comprobar el despliegue real desde el repo.
- No hay acceso a la base de datos desde estas sesiones (el conector de Supabase no está autorizado y los `.env` no se
  leen): el SQL nuevo se prueba con tests, no contra producción.
- **Después del merge, comprueba que el keeper nuevo está vivo.** Si la imagen de Railway no construye (un COPY que
  falta, un test rojo dentro de la imagen), Railway deja activo el despliegue anterior sin avisar, y como la web acepta
  los campos nuevos como opcionales, la página solo dirá "todavía no disponible". La señal está en `/status` de los
  dos keepers: `startedAt` tiene que ser posterior al merge. Si sigue siendo antiguo, el cambio no ha entrado (el log
  de build de Railway lo ve el dueño). Docker no corre en este Mac, así que nada lo detecta antes.

## 7. Preguntas para el dueño antes de escribir código

Hazlas con AskUserQuestion, de una en una o en un bloque corto, cada una con una recomendación:

1. **Qué números y en qué orden** (enséñale la tabla de la sección 5 en palabras sencillas).
2. **Muestra.** Con datos reales la página se ve casi vacía (1 pensión, 3 días). Hay dos precedentes y no coinciden:
   el dashboard de pensión enseña su muestra con `?mode=mock`; `/leaderboard` sigue enseñando datos **reales** con
   `?mode=mock` (ahí `?mode` solo sirve para que los enlaces conserven el modo) y solo enseña la muestra con `?demo=1`,
   que ningún enlace pone y que las pestañas no conservan. Pregúntale cuál quiere: (A) `?demo=1`, igual que el
   leaderboard, que es la página gemela; o (B) que `?mode=mock` enseñe la muestra, como el dashboard (quien navega por
   la app de muestra vería estadísticas de muestra, pero distinto del leaderboard). En los dos casos: etiqueta en
   pantalla y datos reales en la página normal.
3. **Alcance del keeper.** ¿Entra ya la Fase 2 o primero solo la página? Que sepa esto antes de elegir: hasta el merge
   del 3-oct la Fase 2 no se ve con datos reales en ningún sitio, ni en producción ni en Preview.
4. **Unidades.** ¿SOL con "≈ $ al precio de hoy" debajo en las tarjetas de cabecera? (Las series, siempre en SOL/USDC.)
5. **Colores de las series.** La regla actual de la web es un solo acento (esmeralda = dinero ahorrado) y los tokens
   `--chart-1..5` son cinco grises iguales en claro y oscuro, sin usar. Unas barras apiladas necesitan una paleta:
   es decisión suya (ver la skill `dataviz` antes de proponer). En el feed ya existe un código: verde = dinero que
   entra, azul = compras de la pensión.
6. **Nombre y sitio.** ¿Pestaña nueva en la barra (y enlace en el pie, que es la única puerta en móvil) o solo enlace
   desde el leaderboard? "Stats" ya es el título de la sección de la página de pensión: elige otro nombre visible o
   asume el choque.
7. **La tarjeta de confianza** (el "0 exploits" de la imagen): qué hecho comprobable quiere ahí, o si se quita.

## 8. Convenciones de la web para que la página salga nativa

- Pila: Next 16.2.12, React 19.2.8, Tailwind 4, shadcn estilo "radix-nova" (base neutral, lucide), recharts 3.8.0.
  Tema claro/oscuro/sistema: **el oscuro no está forzado**, hay que comprobar los dos.
- **Plantilla de página pública:** `src/app/leaderboard/page.tsx` (fuera de `(dashboard)`, `force-dynamic`, `now`
  resuelto una vez, lee `?mode` y lo pasa a `SiteHeader` y `SiteFooter`, no monta Privy para un visitante, fallo del
  origen = tarjeta "no disponible" con el motivo). Su gemela JSON: `src/app/api/leaderboard/route.ts` (503 + `no-store`
  en fallo, `s-maxage=60, stale-while-revalidate=300` en éxito; nunca se cachea un fallo). No copies el patrón de
  `/prices` para lecturas pesadas: no tiene caché ni límite.
- No metas la página dentro de `(dashboard)`: ese layout monta el proveedor de Privy (~2 MB) para todo visitante.
- **Gráficas:** solo existe una, `src/components/pension-chart.tsx` (AreaChart dentro de `ChartContainer` de
  `src/components/ui/chart.tsx`, `ChartConfig`, tooltip con `formatter` propio, `Tabs` para el rango). No hay ningún
  `BarChart`, `stackId` ni `ChartLegend` en uso: serán los primeros. `ChartContainer` es 16:9 por defecto: pásale
  `aspect-auto w-full` y una altura. El tooltip por defecto usa `toLocaleString()` (prohibido): pasa siempre
  `formatter`, que se llama una vez por serie. Una serie vacía no pinta nada: dibuja un estado vacío explícito.
- **Tarjetas de número:** `src/components/pension-stats.tsx` (alineadas a la izquierda, rejilla con *container
  queries*: sin un ancestro `@container` se queda en 2 columnas). No hay precedente exacto de número grande centrado;
  los más cercanos: `src/components/activity-main.tsx`, `src/components/prices-view.tsx`, el héroe de
  `src/components/pension-panel.tsx`. Números en `font-mono tabular-nums`; clases compartidas en `src/lib/classes.ts`.
- **Formato:** todo por `src/lib/format.ts` (UTC, en-US, `null` → raya). Ojo: `pct()` recibe **puntos básicos**. Ya
  existen `usdCompact` ("$1.2K", para ejes y tarjetas) y `count()` ("1,234"); falta un compacto sin dólar (para SOL o
  contadores) y un ayudante de semana: si los necesitas, añádelos en `format.ts` con el patrón de `usdCompact`. Hay dos
  `formatSol` distintos (`src/lib/leaderboard.ts`, para cadenas de lamports, y `src/lib/amounts.ts`, para bigint).
- **Navegación:** pestañas en `src/components/site-header.tsx` (unión `current` y array `nav`; van con `tab()` para
  llevar `?mode`; se ocultan por debajo de `md`), enlaces del pie en `src/components/site-footer.tsx` (`LINKS`, 6
  entradas en rejilla de 3 filas: una séptima la descuadra). Enlaces internos con `AppLink` y `turnTo`. `SiteHeader`
  exige `account` y `activitySheet`. Tests que fijan los enlaces: `src/components/site-header.test.ts`,
  `src/components/dashboard-shell.test.ts`.
- **Textos:** "Stats" y `STATS_COPY` ya son de la página de pensión. Pon el texto de la página nueva en su propio
  objeto con otro nombre y añádele un test de marca (los escaneos existentes solo cubren los objetos listados en
  `src/lib/live-copy.test.ts`).
- **Muestra vs real:** si un componente nuevo se usa con datos reales, añádelo a la lista `SHARED` de
  `src/components/live/no-mock-import.test.ts` e importa solo tipos desde `@/mocks/types`.
- **Animación y carga:** `.rise-in` y `.app-loader` en `src/app/globals.css`, `src/components/route-loader.tsx`.
- **Tests:** vitest en entorno node (sin DOM), solo `*.test.ts` (sin JSX: `createElement` + `renderToStaticMarkup`).
  Lo que importe recharts se mockea con `vi.mock` (ver `src/components/pension-panel.test.ts`). Pon el agrupado por
  día/semana y los acumulados en **funciones puras exportadas** y testea eso (precedente:
  `src/components/pension-chart.test.ts`).

## 9. Cómo verificar

- **Antes de cualquier comando pnpm** (incluido `pnpm dlx shadcn@4 add`), prepara Node 22 y el pnpm del repo
  (10.18.1). El directorio de nvm no trae pnpm y el del sistema es el 9.12.3, con el que un install se queda esperando
  una pregunta sin decir nada (memoria `sip-web-toolchain-and-preview`):
  1. `export PATH="$HOME/.nvm/versions/node/v22.14.0/bin:$PATH"`
  2. `mkdir -p <tu scratchpad>/bin && corepack enable --install-directory <tu scratchpad>/bin pnpm`
  3. pon `<tu scratchpad>/bin` delante en el PATH y comprueba `[ "$(pnpm -v)" = 10.18.1 ]`
  4. si trabajas en un worktree nuevo, no trae `node_modules`: `CI=true pnpm install --frozen-lockfile </dev/null`
- Después, en `packages/website-oficial`: `pnpm run verify` (CSP, IDL, typecheck, tests y `next build`; lento). El
  bucle rápido es typecheck + test. No hay CI: `verify` es la única puerta.
- Visual: build de producción en local y `next start` en un puerto libre (**el 3013 lo usa otra sesión**; usa otro, y
  para solo servidores cuyo directorio sea el tuyo). Siempre **localhost**, no 127.0.0.1. Capturas con Playwright:
  `require("/Users/walch/ProyectosCT/SIP/tools/landing-shot/node_modules/playwright")`,
  `chromium.launch({ channel: "chrome" })`, espera `networkidle` + ~1500 ms (recharts se redimensiona tarde). Claro y
  oscuro, escritorio y 375 px.
- La página nueva no pide sesión de la app. En local, sin `SIP_SOLANA_KEEPER_URL`, sale "no disponible" (correcto) y
  la muestra. Para ver datos reales en local, arranca el servidor con la URL pública del keeper como variable de
  entorno en la misma línea de comando: está escrita en `docs/runbooks/VERCEL_WEB.md` (no es un secreto).
- Mi prosa tiende a afirmar de más (memoria `sip-prose-overclaims-review`): antes de decirle algo al dueño o de
  escribirlo en un commit, comprueba el hecho en el código.

## 10. Otras sesiones abiertas

- "General": lleva el README, el changelog y la entrega; avisó de la regla de `post-submit`.
- Keeper de volumen: dueña del keeper de volumen y de `reports/VOLUME_MODE_AUDIT_2026-09-25.md`. Si tocas el keeper,
  avísale antes con SendMessage (usa ListAgents para el nombre) y reserva los ficheros por mensaje.
- UI/UX de la web (la que escribió esto): dueña del dashboard de pensión, el engranaje de ajustes, la actividad.
- Onboarding y "Product launch page design": landing, modal de bienvenida, vídeos.
