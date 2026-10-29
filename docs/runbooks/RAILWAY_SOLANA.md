# Railway: el vigilante de Solana

En Railway solo vive el **vigilante** (keeper), que cobra e invierte. **La web se aloja en Vercel**, por decisión del
15 de septiembre, y su guía es [VERCEL_WEB.md](VERCEL_WEB.md). Esta guía
dice qué variable va en el vigilante, cuál es secreta y en qué momento se añade. Los secretos los pegas **tú**,
directamente en Railway. Claude no tiene acceso a Railway.

**Nunca van a Railway:** tu wallet de administración (`~/sip-keys/admin.json`), la llave de administración de la
política de Privy (`~/sip-keys/privy-policy-admin.key`) ni ninguna variable `NUVEM_*`. El vigilante se niega a arrancar si
ve un nombre de variable retirado. Copia solo los nombres de esta guía.

## 0. Antes de empezar

1. **Supabase**: cambia la contraseña de la base de datos (la vieja estuvo en chats). Usa la cadena del **pooler de
   sesión, puerto 5432**. El vigilante rechaza el puerto 6543 (el pooler de transacciones), porque su candado para que
   solo actúe una copia vive en la sesión.
2. **Crea las tablas del historial** una sola vez, desde **Terminal.app**:

   ```bash
   cd ~/ProyectosCT/SIP/packages/solana-keeper && printf 'DATABASE_URL (puerto 5432): ' && read -rs DB && echo && DATABASE_URL="$DB" PATH="$HOME/.nvm/versions/node/v22.14.0/bin:$PATH" node_modules/.bin/tsx bin/setup-read-model.mts; unset DB
   ```

   Crea el esquema `sip_solana` si no existe. No imprime la URL.

## 1. El vigilante (`sip-solana-keeper`)

En Railway: **New → GitHub repo → SIP**. Desde el 28 de agosto de 2026, Railway ya no deja activar *config as code*
en servicios nuevos, así que no lee `packages/solana-keeper/railway.json`. En la raíz del repositorio hay un `Dockerfile`
idéntico al del vigilante, y Railway lo detecta solo: un servicio creado desde este repositorio compila el vigilante,
nunca la web. Configúralo a mano:

- **Variables → `RAILWAY_DOCKERFILE_PATH`** = `packages/solana-keeper/Dockerfile`. Es opcional, porque apunta a una copia
  idéntica. En **Settings → Build**, el builder tiene que decir *Dockerfile*; si dice *Railpack*, algo va mal.
- **Settings → Source → Root Directory**: vacío, porque el Dockerfile necesita la raíz del repositorio como contexto.
- **Settings → Build → Watch Paths**, una por línea: `/packages/solana-keeper/**`, `/packages/solana-log/**`,
  `/packages/solana-program/idl/**`, `/packages/solana-program/scripts/**`, `/packages/solana-program/package.json`,
  `/pnpm-lock.yaml`, `/pnpm-workspace.yaml`, `/package.json`, `/Dockerfile`.
- **Settings → Deploy**: *Healthcheck Path* `/health`; reinicio *On Failure*, con 10 intentos.
- **Settings → Scale**: 1 réplica. El candado que deja actuar a una sola copia vive en la base de datos; sin ella,
  dos réplicas actuarían dos veces.
- **Settings → Networking**: genera un dominio (puerto 8080) para ver `/health` y `/status`.

Para saber que el servicio es el vigilante y no la web:

- en *Build Logs* se construye con el Dockerfile y pasa el paso `--preflight`;
- en *Deploy Logs* sale `heartbeat listening`, nunca `Next.js`;
- `/health` responde `{"ok":true}` en JSON; solo da `503` cuando el barrido no AVANZA desde hace más de
  `max(3 × sweepMs, 10 min)`, la regla que explica la sección de la fase A.

### Fase A — en seco, ya hoy

Sin ninguna clave. Sirve para ver que la imagen arranca en Railway antes de que haya dinero en juego.

| variable | valor | secreta |
|---|---|---|
| `SIP_SOLANA_RPC_URLS` | la URL de Helius: `https://mainnet.helius-rpc.com/?api-key=…` | **sí** |
| `SIP_SOLANA_PROGRAM_ID` | `6kA9H9zQT6PW5xWkXoAFCS3NotxarzaYqj66mjMf9w4J` | no |
| `SIP_SOLANA_POOLS` | `XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W=6truu3rZuiB9rKQg4VYC3Dt3QwV7DgwGqXrYUcrvnDDE` | no |
| `DATABASE_URL` | la de Supabase, puerto 5432 (opcional en seco) | **sí** |
| `SIP_SOLANA_ALERT_WEBHOOK` | a dónde van las alertas: Telegram, Slack o Discord (ver §1.1) | **sí** |
| `SIP_SOLANA_ALERT_MIN_SEVERITY` | opcional, `critical` por defecto: qué severidad sale de la caja | no |

`SIP_SOLANA_POOLS` es SPYx y su pool de Raydium con USDC, comprobado en mainnet el 14 de septiembre. Si NVDAx entra en
la cesta, se añade separado por coma: `Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh=49iMatQtoyabsYAQc8GafVq6aeBFVDxSRH44oiatyyw6`.

**Todavía no pongas nada de Privy.** El vigilante exige las tres variables de Privy juntas (app id, app secret y
authorization key) o ninguna; con solo una se niega a arrancar.

Cuando despliegue, abre el dominio del servicio:

- `/health` responde `{"ok":true}`. Contesta `503` solo cuando el barrido no AVANZA
  desde hace más de `max(3 × sweepMs, 10 min)`, que con el barrido por defecto de 60 s son 10 minutos; el cuerpo dice
  cuánto lleva quieto. Avanza al empezar un barrido, al empezar el turno de cada wallet y con cada respuesta del RPC,
  así que un barrido LENTO —una wallet con mucho retraso puede tardar más que los diez minutos ella sola— sigue en
  `200`: reiniciarlo solo repetiría el mismo trabajo desde cero y perdería las pérdidas pendientes. Un vigilante recién
  arrancado o uno que no tiene nada que barrer sigue en `200` igual, y un fallo de RPC sale por `/status` y por las
  alertas, nunca reiniciando el contenedor. **Ojo: Railway solo llama a `/health` al desplegar** (ADR del dispatcher,
  §3.11): un `503` después NO reinicia nada. Para que un vigilante colgado se reinicie solo está `watchdog-exit` (§8).
- `/status` enseña `program` = `6kA9…`, `mode` = `dry-run` y `signing.secretsRead` = `false`. Hasta que se publique el
  programa, `programDeployed` es `false` y `config` es `null`: es lo esperado.

### 1.1 Adónde van las alertas (Telegram)

El vigilante distingue dos severidades. **`critical`** es lo que alguien tiene que arreglar —un `settle` que ha
fallado, la wallet de crank sin SOL para firmar, la base de datos caída, el asiento de Privy rechazando la firma—.
**`warn`** es una condición en reposo: una wallet saltada este barrido, un margen que se está estrechando. Por
defecto **solo salen los `critical`**; los avisos se escriben en el log y aparecen en `/status`, que es donde se
miran a propósito y no a las tres de la mañana. Para recibir también los avisos: `SIP_SOLANA_ALERT_MIN_SEVERITY=warn`.

Una alerta repetida se calla 30 minutos por condición, así que un fallo persistente no se convierte en cien mensajes.

**Telegram** es la mejor caja de las tres: llega al móvil como notificación push sin tener nada abierto, y es la única
que pinta botones. Tres pasos, cinco minutos:

1. En Telegram, habla con **@BotFather** → `/newbot` → le das un nombre. Te devuelve un token con la forma
   `7777777777:AAH…`. **Ese token es una credencial**: quien lo tenga puede escribir como el bot.
2. Escríbele algo a tu bot recién creado (un `hola` basta; un bot no puede iniciar la conversación), y abre
   `https://api.telegram.org/bot<TOKEN>/getUpdates`. En la respuesta, `message.chat.id` es tu **chat id** — un número,
   negativo si es un grupo. No es secreto: es como el nombre de un canal.
3. En Railway, `SIP_SOLANA_ALERT_WEBHOOK` =
   `https://api.telegram.org/bot<TOKEN>/sendMessage?chat_id=<CHAT_ID>`

El vigilante reconoce `api.telegram.org` por el host y cambia el formato del mensaje él solo. **Si la URL de Telegram
no lleva `chat_id`, se niega a arrancar**: sin chat, `sendMessage` contesta 400 a todas las alertas, para siempre, y
ese es un fallo que hay que ver en el despliegue y no la noche que haga falta.

Para Slack o Discord, la URL del webhook tal cual: el cuerpo genérico (`text` + campos) es el que ya leen.

**Los botones.** Cada alerta de Telegram llega con enlaces a lo que el operador abriría a continuación: el `/status`
del vigilante (aparece solo si Railway ha dado dominio público, cosa que hace en la variable `RAILWAY_PUBLIC_DOMAIN`),
y la wallet y la bóveda de la alerta en Solscan. Son enlaces, no mandos: **tocar un botón no ejecuta nada en el
vigilante**. Un botón que reintentara un `settle` o pausara el barrido necesita un endpoint de control autenticado —
hoy `/status` y `/health` son públicos y de solo lectura, y abrirle un mando a Internet sin autenticación es peor que
el problema que resuelve. Se puede hacer después, con un token en la URL del botón; no está hecho.

**Comprueba que la caja recibe**, antes de fiarte de ella:

```bash
curl -s "https://api.telegram.org/bot<TOKEN>/sendMessage" \
  -H 'content-type: application/json' \
  -d '{"chat_id":"<CHAT_ID>","text":"prueba del vigilante SIP"}'
```

Si no llega, la alerta tampoco llegará. El vigilante, por su parte, ya no se traga un webhook borrado o limitado: una
respuesta que no sea 2xx se registra como `alert webhook failed; the alert above was logged only`.

### 1.2 El tablero público (`/leaderboard`)

El vigilante sirve, en el mismo puerto que `/health` y `/status`, un tercer camino: `/leaderboard`. Es la clasificación
— «Ahorro» y «Volumen», por temporada semanal y por histórico — calculada a partir de `sip_solana.settlement_event`,
que es lo que este servicio ya escribía. Solo la calcula el de beneficio; el de volumen contesta que no la calcula. El
scheduler del despachador (sección 10) sirve el mismo `/leaderboard`, con el mismo cálculo (`src/scheduler-board.ts`),
y sigue ahí cuando los vigilantes de siempre se paran: **la web lee el del scheduler** (punto 3). La web no toca la base
de datos: lee esa URL y la cachea.

**El orden importa, y es de un solo sentido:**

1. **Primero la migración**, con la base a mano y **antes** de desplegar el código nuevo. Es exactamente la orden de
   la sección 0, desde **Terminal.app** — el fichero SQL es idempotente y volver a aplicarlo solo añade lo que falte:

   ```bash
   cd ~/ProyectosCT/SIP/packages/solana-keeper && printf 'DATABASE_URL (puerto 5432): ' && read -rs DB && echo && DATABASE_URL="$DB" PATH="$HOME/.nvm/versions/node/v22.14.0/bin:$PATH" node_modules/.bin/tsx bin/setup-read-model.mts; unset DB
   ```

   Añade `settlement_event.volume_raw` (un `ALTER … ADD COLUMN IF NOT EXISTS`). La URL se teclea y no se imprime.
   **`~/sip-keys/sip-hackathon.env` NO lleva `DATABASE_URL`** — lleva el RPC y lo de Privy —, así que sourcearlo para
   esto falla con «DATABASE_URL is not set».

2. **Después el despliegue.** Si se hace al revés, el `INSERT` del vigilante nombra una columna que no existe, Postgres
   rechaza la sentencia entera y **se pierde una fila de historial por cada cobro** — sin tumbar nada, porque escribir
   historial nunca puede frenar un cobro. Para que no pase en silencio, el arranque ahora comprueba las columnas y no
   solo las tablas: si falta, el log y `/status` dicen
   `BROKEN — sip_solana.settlement_event is missing volume_raw` y el comando que lo arregla.

3. **Y en Vercel**, `SIP_SOLANA_KEEPER_URL` con la URL pública del **scheduler**,
   `https://sip-solana-scheduler-production.up.railway.app` (el nombre de la variable no cambia; ver `VERCEL_WEB.md` y
   10.8, paso 2). La de este servicio solo vale mientras esté encendido, y deja de valer cuando se pare (10.8, paso 8).

**Comprobarlo** (el mismo `curl` contra `sip-solana-keeper-production` contesta igual mientras este siga encendido):

```bash
curl -s https://sip-solana-scheduler-production.up.railway.app/leaderboard | head -c 300
```

- **200** con `computedAt`, `rules`, `coverage` y `boards`: está calculado.
- **503** con `"detail"`: dice por qué — sin base de datos, sin calcular todavía, o el historial no se pudo leer. La web
  enseña ese mismo motivo. **Nunca sirve un tablero vacío en 200**: «nadie ha ahorrado» y «no se pudo mirar» son dos
  cosas distintas y solo una de ellas es verdad.

Se recalcula cada dos minutos y, además, justo después de cada cobro registrado — así quien acaba de ahorrar y va a
mirar no encuentra una clasificación que no sabe nada de él. Nunca se calcula dentro del barrido: una consulta lenta no
puede retrasar un cobro. El del scheduler, cada réplica el suyo: cada dos minutos y, tras el cobro de un worker, como
mucho una vez cada 15 s.

**Si al historial le faltan filas** — un parpadeo de la base, un despliegue adelantado a su migración, o un cobro cuya
firma no volvió — se reconstruye desde la cadena, que es la verdad:

En seco necesita solo un RPC, que ese fichero sí lleva. El `--write` pide además la base, tecleada como arriba:

```bash
# en seco: enseña fila por fila lo que escribiría
cd ~/ProyectosCT/SIP/packages/solana-keeper && bash -c '. ~/sip-keys/sip-hackathon.env; SIP_SOLANA_RPC_URLS="$SIP_SOLANA_RPC_URLS" PATH="$HOME/.nvm/versions/node/v22.14.0/bin:$PATH" node_modules/.bin/tsx bin/backfill-settlements.mts'

# ya de verdad
cd ~/ProyectosCT/SIP/packages/solana-keeper && printf 'DATABASE_URL (puerto 5432): ' && read -rs DB && echo && export DATABASE_URL="$DB" && bash -c '. ~/sip-keys/sip-hackathon.env; SIP_SOLANA_RPC_URLS="$SIP_SOLANA_RPC_URLS" PATH="$HOME/.nvm/versions/node/v22.14.0/bin:$PATH" node_modules/.bin/tsx bin/backfill-settlements.mts --write'; unset DB DATABASE_URL
```

En seco por defecto: enseña fila por fila lo que escribiría y no toca nada hasta `--write`. Repetirlo es seguro (la
escritura es un upsert por `(wallet_addr, nonce)`, y una fila escrita en su momento conserva su hora y su volumen
medido). Lo único que **no** se puede recuperar es `volume_raw`: el nocional sale de caminar las transacciones de la
ventana, y un RPC normal guarda dos o tres días — esas filas quedan a 0 y solo cuentan para el tablero de Ahorro.
Comprobado el 20-sep contra mainnet: de 12 firmas del programa reconstruye la única liquidación real (19-sep, base
0,183172913 SOL, cobrado 0,036634582 SOL, `2tE3BMTa…`).

### Fase B — el martes, después de publicar y configurar el programa

Añade los secretos. Sigue en seco: sin la fase C no envía nada.

| variable | valor | secreta |
|---|---|---|
| `SIP_SOLANA_SETTLE_KEY` | el contenido entero de `~/sip-keys/settle.json` (la lista de números) | **sí** |
| `SIP_SOLANA_PRIVY_APP_ID` | `cmtrt36tb00080dlbrda5aqam` | no |
| `SIP_SOLANA_PRIVY_APP_SECRET` | el app secret de Privy de SIP | **sí** |
| `SIP_SOLANA_PRIVY_AUTHORIZATION_KEY` | la clave privada `wallet-auth:…` de la llave `sip-solana-keeper-2` | **sí** |
| `SIP_SOLANA_PRIVY_SIGNER_ID` | `kyio853439oa78qfvmt853i4`, el id de esa misma llave | no |
| `SIP_SOLANA_PRIVY_POLICY_ID` | `jsuzcjv6njl0raqjjhzqe9fh` | no |

La llave y el signer id van **siempre juntos**: la llave privada tiene que ser la del key quorum que nombra el id, y
`/status` lo comprueba en `signing.authorizationKey` (tiene que decir `matches`). Desde el 18-sep son los de
`sip-solana-keeper-2` (`kyio853439oa78qfvmt853i4`). Los de antes, `sip-solana-keeper` (`cbx133itb717vxp3dqwhk808`),
están **retirados**: su llave privada se perdió. **No los pongas nunca.** La web lleva el mismo signer id
([VERCEL_WEB.md](VERCEL_WEB.md)); si se cambia, es en los dos sitios y en el orden de
[PRIVY_SOLANA.md](PRIVY_SOLANA.md), sección 7.

`SIP_SOLANA_PRIVY_POLICY_ID` es **opcional: el vigilante arranca sin ella**, y es la misma política que la web pone como
*override* del signer en cada wallet de trading. Puesta, el vigilante se niega a firmar por una wallet cuyo asiento no la
lleve exactamente: esa wallet sale en `/status` como `none (seat not bounded by the keeper's policy)` y salta una alerta
crítica, porque un signer sin su política podría firmar cualquier mensaje, enviar cualquier transacción y exportar la
clave de esa wallet. Sin ella el vigilante firma como siempre y lo dice una vez al arrancar, en una línea del log.

**Al revés no vale.** Con `SIP_SOLANA_PRIVY_POLICY_ID` puesta y `SIP_SOLANA_PRIVY_SIGNER_ID` vacía no hay asiento que
buscar: no se mira ni la concesión ni la política, y el vigilante firmaría por CUALQUIER wallet de Solana de la app.
Arranca igual —la sanidad de Railway no depende de estas variables—, pero lo dice como error al arrancar y lanza una
alerta crítica, porque un `/status` con `privyPolicyId` puesto se lee justo al revés de lo que está pasando. Lo que el
vigilante hace de verdad sale en `/status` como `signing.seatCheck`: `policy-enforced` (las dos puestas), `seat-only`
(solo el signer) o `unchecked` (sin signer).

Ponla **después** de comprobar con `privy-policy verify --wallet <id de wallet> --policy jsuzcjv6njl0raqjjhzqe9fh` que
una wallet real ya está bien asentada. Si el id no fuera el que la web puso, ninguna wallet se podría liquidar, y eso no
se ve: sin firmante, la liquidación descansa en `NO_SIGNER`.

En `/status` tiene que salir el `config` del programa, con el atestador y el keeper iguales a la dirección de tu
wallet de cobro. Si no coinciden, el vigilante se niega a arrancar y lo dice.

### Fase C — el miércoles, para el primer cobro real

Solo cuando el ensayo en seco cuadre:

| variable | valor |
|---|---|
| `SIP_SOLANA_BROADCAST` | `1` |
| `SIP_SOLANA_ALLOW_BROADCAST` | `i-understand-this-moves-real-funds` (exacto, sin espacios) |

`/status` pasa a `mode` = `live`. Si no, dice qué condición falta. Para volver a seco, borra `SIP_SOLANA_BROADCAST`.

## 2. La web no va en Railway

Desde el 15 de septiembre la web se aloja en Vercel: [VERCEL_WEB.md](VERCEL_WEB.md). Si llegaste a crear un servicio
`sip-web` en Railway, bórralo junto con sus variables (Settings → Danger). Quita también su dominio `*.up.railway.app`
de los dominios permitidos de Privy. Si su clave de Helius es la misma que vas a usar en Vercel, rótala después del
concurso. En la raíz del repositorio ya no hay un `railway.json`: cada servicio de Railway se configura a mano, como el
vigilante de la sección 1.

## 3. El mismo vigilante en tu Mac, en seco (para depurar)

Es **el mismo programa** que corre en Railway, arrancado con la misma orden que usa la imagen
(`node_modules/.bin/tsx bin/keeper.mts`, la última línea del `Dockerfile`). Cambia una sola cosa: en tu Mac va **en
seco**. Lee la cadena de bloques y te cuenta lo que haría, pero no firma nada y no envía nada.

Sirve para ver en tu pantalla, en segundos, lo que en Railway solo se ve en los logs. Así encontramos el fallo del
18 de septiembre.

### Las dos reglas que lo hacen seguro

1. **No pongas nunca `SIP_SOLANA_BROADCAST` ni `SIP_SOLANA_ALLOW_BROADCAST`.** Esas dos juntas, y solo esas dos, son
   lo que arma al vigilante. Hacen falta las **dos**, y la segunda tiene que ser la frase exacta. Sin ellas es en seco,
   y en seco **ni siquiera lee una clave**: las órdenes de abajo no tocan nada de `~/sip-keys`.
2. **No pongas `DATABASE_URL`.** Sin ella no abre ninguna conexión con Supabase: no escribe historial y no puede
   disputarle nada al de Railway.

### Por qué esto NO tumba al de Railway

El candado que deja actuar a una sola copia (el de la sección 1, *Scale: 1 réplica*) **solo lo pide un vigilante
armado**. Un vigilante en seco no lo pide nunca:

- en `src/singleton.ts`, `ensure()` se sale en su primera línea si no está armado, y esa es la única función que
  llega a pedir el candado a Postgres;
- y en `bin/keeper.mts` las dos llamadas a `ensure()` están dentro de un `if (config.armed)`, así que ni se intentan.

Con la regla 2 encima, sin `DATABASE_URL` no hay ni conexión donde pedirlo. **Puedes arrancarlo ahora mismo, con el de
Railway cobrando, sin tocarlo.**

### Una vez: instalar

Desde **Terminal.app**:

```bash
cd ~/ProyectosCT/SIP && PATH="$HOME/.nvm/versions/node/v22.14.0/bin:$PATH" CI=true corepack pnpm install --frozen-lockfile --filter "@sip/solana-keeper..."
```

`--frozen-lockfile` es la misma orden que usa la imagen de Railway (`Dockerfile`, línea 49). Además de instalar lo
mismo, **no puede modificar ningún fichero del repositorio**: sin esa palabra, la instalación resuelve las versiones de
nuevo y puede reescribir `pnpm-lock.yaml`, que está en el repositorio y además es uno de los *Watch Paths* del servicio
(sección 1) — te dejaría el árbol sucio y un `git add -A` posterior dispararía una reconstrucción del vigilante que tú
no pediste.

### Cada vez: arrancarlo

Primero la **revisión previa**, que es el mismo paso que Railway hace al construir la imagen. No necesita ninguna
variable y tarda menos de un segundo:

```bash
cd ~/ProyectosCT/SIP/packages/solana-keeper && PATH="$HOME/.nvm/versions/node/v22.14.0/bin:$PATH" node_modules/.bin/tsx bin/keeper.mts --preflight
```

Tiene que decir `"preflight":"ok"` y `"invariants":17`. Si dice `preflight failed`, **no despliegues**: la línea
nombra lo que falla. Desde el 18 de septiembre esas 17 comprobaciones incluyen construir de verdad las cuatro órdenes
que mueven dinero (`settle_v2`, `wrap_sol`, `convert`, `invest`), que es justo lo que aquel día se rompió — y de
`settle_v2` y `convert` las construye tres veces, también con un cero y con un número enorme, que son los dos casos en
los que un fallo así no se vería con números normales.

Y ahora el vigilante:

```bash
cd ~/ProyectosCT/SIP/packages/solana-keeper && env -u DATABASE_URL -u SIP_SOLANA_BROADCAST -u SIP_SOLANA_ALLOW_BROADCAST PATH="$HOME/.nvm/versions/node/v22.14.0/bin:$PATH" SIP_SOLANA_RPC_URLS="https://api.mainnet-beta.solana.com" SIP_SOLANA_PROGRAM_ID="6kA9H9zQT6PW5xWkXoAFCS3NotxarzaYqj66mjMf9w4J" SIP_SOLANA_SWEEP_MS=60000 PORT=8099 node_modules/.bin/tsx bin/keeper.mts
```

Se queda abierto y barre cada minuto. Para pararlo, **Ctrl-C** en esa misma ventana.

Solo necesita esas dos variables con valor: la **URL del RPC** (la pública de Solana vale de sobra para leer) y el
**id del programa**. `PORT` es opcional y solo sirve para poder mirar `/status` desde otra ventana; `SIP_SOLANA_SWEEP_MS`
es cada cuánto barre.

### Cómo se ve cuando va bien

**La primera línea de las dos órdenes (la revisión previa y el vigilante) es siempre este aviso, y no pasa nada:**

```
"level":"warn" "event":"console" "text":"bigint: Failed to load bindings, pure JS will be used (try npm run rebuild?)"
```

Es una pieza opcional escrita en C que no está compilada en tu Mac, así que se usa la versión en JavaScript. Railway
imprime exactamente lo mismo. **Lo único que significa «para»** es `preflight failed` en la revisión previa, o una
línea con `"level":"error"` en el vigilante.

Después del aviso, la primera línea larga tiene que decir esto (el orden puede cambiar):

```
"programDeployed":true
"mode":"dry run — nothing will be sent"
"settleKey":null
"signing":"not resolved — a dry run reads no signing secret"
"history":"off — no DATABASE_URL, so nothing is recorded"
```

Y unos segundos después, una línea por cada wallet enlazada. Con ganancia pendiente se lee así:

```
"event":"settle settled" … "detail":"DRY RUN — would settle 36634582 lamports (36634582 owed at 2000 bps) from
183172913 lamports of measured profit over slots 447945418..447947792"
```

`DRY RUN — would settle …` es la frase que buscas: significa **«esto es exactamente lo que el de Railway va a
cobrar»**, sin haber enviado nada.

Si una wallet falla, en la **ventana** no verás `"settle":"THREW"` — eso no se escribe nunca en el terminal. Lo que
sale es una línea roja de error así, y la causa va en `"detail"`:

```
"level":"error" "event":"wallet turn threw" "wallet":"9QX5…" "detail":"TypeError: anchor.BN is not a constructor"
```

`"settle":"THREW"` es como se ve ese mismo fallo en `curl -s http://localhost:8099/status` (abajo), no en el terminal.
Es el mismo fallo que verías en Railway, en los dos sitios.

Desde otra ventana de Terminal.app:

```bash
curl -s http://localhost:8099/status
```

### Cómo distinguir el tuyo del de Railway

Los dos contestan lo mismo en `/status`, así que mira estos campos. **Si el tuyo no dice todo lo de la columna de la
izquierda, párralo con Ctrl-C:**

| campo | el tuyo, en tu Mac | el de Railway |
|---|---|---|
| `mode` | `dry-run` | `live` |
| `armed` | `false` | `true` |
| `signing.settleKey` | `null` | una dirección |
| `signing.secretsRead` | `false` | `true` |
| `history` | `off — no DATABASE_URL…` | escribiendo |
| `sweeps` | empieza en 1 y sube despacio | va por miles |
| dirección | `http://localhost:8099` | tu dominio `*.up.railway.app` |

También sale, en el tuyo, la razón de que esté en seco:
`"missingLiveCondition":"not armed: SIP_SOLANA_BROADCAST=1 and the exact SIP_SOLANA_ALLOW_BROADCAST sentence are both
required"`.

### Después, para actualizar el de Railway

Cuando lo de tu Mac se vea bien: sube la rama, únela a `main`, y Railway vuelve a construir sola con esos mismos
cambios. La construcción pasa otra vez por `--preflight`, así que un fallo de los que se ven aquí **no llega a
desplegarse**.

## 4. ¿Cuántos usuarios caben?

El vigilante barre todas las wallets enlazadas **una detrás de otra** cada `SIP_SOLANA_SWEEP_MS` (60 s). Si una barrida
tarda más que eso, la siguiente se salta y nadie en ella se cobra (`/status` → `skipped`). Cuántos caben se mide sin
usuarios reales ni RPC ajeno con:

```bash
pnpm --dir packages/solana-keeper bench:ceiling                       # la rejilla por defecto
pnpm --dir packages/solana-keeper bench:ceiling -- --plan-rps 50      # con el límite del plan de Helius, como 429
```

Arranca el vigilante de verdad contra una cadena falsa en el loopback. **Las cifras de `c6e38d8` (~99 / ~266 / ~698)
eran demasiado altas** y se corrigieron el 23-sep. Estas son las que valen, todas **"como mucho"**, porque el camino de
escritura (Privy, confirmación, recibo) se cobra como suelo y no se ejecuta. Son de un Mac, no de Railway:

| latencia RPC (p50/p90) | 2 % activos | 20 % activos | peticiones/s que necesita | tras una caída |
|---|---|---|---|---|
| 86/122 ms (endpoint público) | 97 | 54 | ~10,5 | **2** usuarios con 300 tx llenan la barrida |
| 30/45 ms | 253 | 125 | ~27 | 6 |
| 10/14 ms | 659 | 257 | ~71–80 | 14 |

- **El plan manda antes que la latencia.** El vigilante no se frena ante un 429: `rpc-pool.ts` lo toma como un fallo
  y el usuario se queda sin cobrar. Medido: a 10/14 ms con un plan de 50 req/s, desde 50 wallets hay unos 30 × 429 y
  unos 30 usuarios sin servir por barrida. A 30/45 ms con 25 req/s, desde 50 wallets. Si el plan da menos peticiones
  por segundo que la columna de arriba, la fila no vale.
- **La proporción de activos lo cambia todo.** El 2 % supone que 98 de cada 100 no operaron en el último minuto.
- **Una liquidación que no confirma se come 60 s** (`CONFIRM_TIMEOUT_MS`): una por barrida basta para perderla entera.
- **Jupiter sin clave** da 30 peticiones/min y una compra gasta unas 12, así que caben unas 2,5 compras por minuto.
  Con un 2 % de activos que compren todos, eso es 126 wallets; con un 20 %, 13.

**Lo que hay que leer en Railway** para saber el número de verdad: en `/status`, `sweepMsP50`, `sweepMsP90`,
`lastSweepPhaseMs` (`triageMs` es el precio de los usuarios quietos y `expensiveMs` el de los activos), `skipped` y
`linksTriaged`. Y el límite de peticiones por segundo del plan de Helius, que solo tú puedes mirar.

### 4.1 Lo que cada vigilante gasta (Helius, Privy, Jupiter)

Cada vigilante cuenta en `/status` lo que pide a sus proveedores. Nada de esto cambia lo que hace: solo lo cuenta.

- **`rpc`**: llamadas por método en la última barrida (`byMethodLastSweep`) y en las últimas 24 h (`byMethodPerDay`,
  `callsPerDay`), los créditos de Helius que eso cuesta (`creditsPerDayEstimate`, y a la vez con el archivo a 1 y a 10:
  `creditsPerDayEstimateP1` y `…P2`), los 429 y qué endpoint contestó. `observedMs` dice cuánto del día ha visto: tras
  un despliegue empieza de cero, y la estimación sale `null` los primeros 10 minutos.
- **`privy`**: peticiones a Privy por tipo, páginas del listado de wallets por barrida, y firmas por modo (`profit`,
  `volume`) frente a las 50.000 gratis al mes.
- **`jupiter`**: llamadas en el último minuto y el minuto más cargado del día, frente a las 30/min sin clave.
- **`turnTimes`**: lo que tarda de verdad una liquidación en vivo, su envío y su confirmación, una compra, y el listado
  de Privy (también en `lastSweepPhaseMs.privyIndexMs`).

**Para saber si alguien más usa tu clave de Helius:** con `observedMs` cerca de 24 h, compara `rpc.callsPerDay` de cada
vigilante con las peticiones de **su** clave en el panel de Helius (si `rpc.byEndpointPerDay` enseña que contestó otro
endpoint, lo de ese endpoint no va a esa clave). Si la clave pasa del 115 % de lo que dice su vigilante, hay otro
consumidor en esa clave.

**Dos variables, las dos opcionales** (en el servicio de cada vigilante; un valor mal escrito **no arranca**, y Railway
deja corriendo el despliegue anterior):

- `SIP_SOLANA_ARCHIVAL_CREDITS` = `1` o `10`: lo que cuesta una llamada de archivo en Helius. Sin ponerla vale `1`, lo
  que dice su página de facturación. Cuando la llamada a la Admin API diga cuánto es de verdad, pon ese número.
  Mientras no la pongas, `credit-burn` compara tu presupuesto con la cuenta **más cara** (archivo a 10), para no quedarse
  callada si el precio real es 10; `/status` sigue mostrando la cuenta a 1 y las dos lecturas al lado.
- `SIP_SOLANA_CREDIT_BUDGET_DAY` = los créditos al día que le das a **ese** servicio. Sin ponerla no hay alerta. Con
  ella, `credit-burn` se queda en el log como aviso (warn) desde el 80 % y te llega a Telegram como crítica desde el
  100 %, y nunca antes de una hora de datos.

**Si salta `credit-burn`**, en este orden:

1. Mira si el timbre está sordo: `/status` → `doorbell.trusted` y `doorbell.webhook.failingSince`. Un timbre sordo
   convierte cada barrida en una pasada completa.
2. Estira la barrida de ese servicio: `SIP_SOLANA_SWEEP_MS` entre `120000` y `300000` baja el gasto 2–5×. A cambio,
   cobros y compras empiezan hasta ese tiempo más tarde. Vuelve a `60000` cuando se arregle la causa.
3. Si tienes el autoescalado de Helius con tope, mira que no esté a punto de tocarlo.

El presupuesto es solo de ese servicio: los 10M del plan también los gastan el otro vigilante y la web, y eso solo lo
ve la llamada semanal a la Admin API.

## 5. El timbre (Helius avisa quién se movió)

Sin timbre, cada barrida pregunta a **todas** las wallets si hicieron algo, aunque casi ninguna haya hecho nada: unos
210 ms por usuario quieto, y a partir de unos 280 usuarios las barridas ya no caben en 60 s. Con el timbre, Helius le
avisa al vigilante (en 1–3 s) de qué wallets y vaults se movieron, y la barrida gira esas, las que tienen algo
pendiente, las nuevas y una tanda de seguridad que rota (al menos 50 por barrida; todas en 30 minutos). **Con 50
usuarios o menos se siguen girando todos en cada barrida**: hoy no cambia nada salvo lo que enseña `/status`.

Si el timbre no oye nada, o deja de oír las transacciones que el propio vigilante envía, vuelve solo a girar a todos
en cada barrida (lo de siempre). No puede dejar a nadie sin cobrar; como mucho, deja de ahorrar trabajo.

### Activarlo (una vez)

1. En **Terminal.app** (no en un chat), genera el secreto y déjalo copiado sin que salga en pantalla:

   ```bash
   openssl rand -hex 32 | tr -d '\n' | pbcopy
   ```

2. En Railway → `sip-solana-keeper` → **Variables** → nueva variable `SIP_SOLANA_DOORBELL_SECRET`, pega (Cmd+V) y guarda.
   **Nunca lo pegues en un chat**: quien lo tenga puede tocar el timbre.
3. `SIP_SOLANA_HELIUS_API_KEY` **solo si** `SIP_SOLANA_RPC_URLS` no es de Helius. Si ya usas
   `https://mainnet.helius-rpc.com/?api-key=…`, el vigilante saca la clave de ahí y no hace falta repetirla.
4. No hace falta nada más: el vigilante usa el dominio público de Railway (`https://<tu-dominio>/hooks/helius`) y **crea
   él mismo el webhook en Helius** (raw, todas las transacciones), con las wallets y vaults que descubre. Si el
   servicio no tiene dominio público: Settings → Networking → Generate Domain. Si antes hiciste un webhook de prueba a
   otra dirección (por ejemplo webhook.site), bórralo en el panel de Helius: cobra créditos por cada evento.

### Qué debe enseñar `/status` → `doorbell`

- Nada más desplegar: `enabled: true`, `trusted: false`, y `untrustedReason` diciendo que aún no ha llegado ningún
  evento. Es normal: mientras tanto gira a todos.
- En cuanto haya una operación o un cobro: `trusted: true`, `eventsReceived` subiendo, `lastEventLagMs` de unos
  1000–3000, `webhook.managed: true`, `webhook.active: true`, y `webhook.addresses` = wallets + vaults enlazadas.
- `lanes` dice a quién giró la última barrida y por qué (`bell` sonó, `busy` tenía algo pendiente, `new` es nueva o
  aún no está en el webhook, `safety` es la ronda de seguridad).
- `possibleMisses` cuenta las veces que la ronda de seguridad encontró trabajo que el timbre no había anunciado. Con
  50 usuarios o menos puede subir de vez en cuando sin que Helius falle: la ronda gira a todos cada minuto y a veces
  ve una operación en los 1–3 s antes de que llegue su aviso. Solo es mala señal si sube a menudo mientras
  `eventsReceived` se queda quieto: entonces avísame con la hora.
- `eventsRejected` cuenta llamadas con un secreto equivocado. Nunca aparece ni el secreto ni la clave de Helius.
- `webhook.lastDiff` dice qué vio el vigilante la última vez que miró el webhook en Helius y por qué lo dio por bueno
  o no: `addresses` (cuántas direcciones enseña la lista, cuáles faltan o sobran, y el veredicto: `same`,
  `written-unlisted` si la lista no las enseña pero las escribió este proceso — sin el campo, o vacía; vacía solo
  cuenta si la respuesta de Helius a esa edición las tenía todas o llegó una entrega aceptada después, y si la lista
  ya las había enseñado, solo una mirada seguida —, `list-capped` si la lista se corta en 100, `extra-only`, `emptied`
  si la lista las enseñó y luego ninguna dos miradas seguidas (Helius la vació: se reescribe una vez por proceso y la
  barrida siguiente gira a todos; las demás veces es un fallo), o `differs`; en producción no se sabe aún si la lista
  deja fuera el campo o lo da vacío), `auth` (solo `absent`/`same`/`different` y pistas sí/no: si parece enmascarada,
  si coinciden principio y final, si contiene la nuestra… **nunca** el valor ni un trozo; `written-by-us` también
  cubre un texto fijo que la lista enseñe en lugar de la cabecera, como `REDACTED`, una vez que una entrega aceptada
  lo prueba), y `shape` (raw · ANY · all tal como los enseña Helius). `differs: []` es que está al día.
  `webhook.lastEditEcho` es lo mismo para la respuesta del último PUT o creación. Si me avisas de un fallo del timbre,
  pégame estos dos bloques: no llevan nada secreto (un texto de Helius que lleve un trozo del secreto sale como
  `(withheld)`).
- `auth.verdict` = `refused` quiere decir que la lista no enseña la cabecera, o la enseña de una forma que no se puede
  comparar con la nuestra (`auth.hint` dice cuál: dentro de `Bearer …`, otra caja, enmascarada…), y que desde la última
  edición se rechazaron (403) al menos 3 entregas seguidas sin ninguna aceptada después. Pueden ser de Helius o de
  cualquiera que haga POST a `/hooks/helius`: el vigilante reescribe la cabecera como mucho una vez por proceso; las
  demás veces lo da como fallo en vez de pagar otro PUT, y `doorbell-sync` lo avisa en el log pero **nunca** pasa a
  crítica por eso (si de verdad son las de Helius, no suena nada: la ronda de seguridad sigue girando a todos en 30
  minutos como mucho, y el primer cobro del vigilante cuyo eco no vuelva deja el timbre sordo, que gira a todos en cada
  barrida y, si ya había oído algo, avisa con `doorbell-deaf`). Una entrega aceptada lo deshace.
- `webhook.failingSince` es desde cuándo fallan las sincronizaciones seguidas; `null` mientras van bien.

Dos alertas nuevas: `doorbell-deaf` (dejó de oír y vuelve a girar a todos), de aviso, y `doorbell-sync` (no consigue
poner al día el webhook), que avisa al tercer fallo seguido y pasa a **crítica** cuando lleva una hora fallando (salvo
si lo único que falla son entregas rechazadas: eso se queda en aviso): esa sí llega a Telegram aunque no cambies nada.
Los avisos solo llegan si `SIP_SOLANA_ALERT_MIN_SEVERITY=warn`. Un webhook atascado se mira cada 10 minutos, no en cada
barrida.

### Cambiar el secreto

Si crees que el secreto se ha visto (por ejemplo, se pegó en un chat), genera uno nuevo igual que en el paso 1 y
reemplaza el valor de `SIP_SOLANA_DOORBELL_SECRET` en Railway. No hay que tocar nada en Helius: al redesplegar, el
vigilante que queda al mando actualiza el webhook con el secreto nuevo. Mientras tanto Helius sigue llamando con el
viejo, esas llamadas se rechazan y Helius no las repite; por eso, hasta que el webhook tiene el secreto nuevo, cada
rechazo hace que la siguiente barrida gire a todos, y así no se pierde a nadie. Es normal ver `eventsRejected` subir un
poco justo después del cambio y, en `/status`, alguna barrida de más con `lanes.full` igual al total.

### Apagarlo

Borra `SIP_SOLANA_DOORBELL_SECRET` en Railway. Tras el redespliegue el vigilante vuelve a girar a todos en cada barrida,
como antes. Después borra el webhook en el panel de Helius, para que deje de gastar créditos.

## 6. El vigilante de volumen (`sip-solana-volume-keeper`)

Es **otro servicio**, con el mismo código y la misma imagen que el de la sección 1. Una variable decide qué hace:
`SIP_SOLANA_ROLE=volume`.

- **Cobra solo los vaults en modo volumen.** El vigilante de siempre (sin esa variable) cobra solo los de beneficio. Así
  cada vínculo tiene exactamente un servicio que lo cobra.
- **Nunca invierte.** El vigilante de siempre sigue invirtiendo los ahorros de todos los vaults, sean del modo que sean.
- **Tiene su propio candado** (`sip-solana-volume-keeper`): nunca espera al de siempre ni le quita el suyo.
- **No usa el timbre de Helius**: gira todos los vínculos en cada barrida. Con `SIP_SOLANA_DOORBELL_SECRET` puesto **no
  arranca**: ese secreto solo lo tiene el vigilante de siempre, así que un `SIP_SOLANA_ROLE=volume` puesto en ese servicio
  por error falla el despliegue y Railway deja funcionando el anterior.
- **Sus alertas empiezan por `[volume]`** en el mismo Telegram.
- En los vaults de beneficio no cobra nada. **En seco**, su fila de `/status` enseña cuánto volumen lleva el tramo sin
  cobrar y lo que costaría en modo volumen, y lo mismo del **último tramo ya cobrado** (ese no se vacía cuando el
  vigilante de siempre cobra un trade ganador al minuto). Armado ya no lo calcula, para no gastar lecturas de Helius en
  vaults que cobra el otro.

Qué cuenta como volumen, la frecuencia de cobro y el cambio de modo: `reports/VOLUME_KEEPER_PLAN_2026-09-25.md`.

### Fase A — en seco (no cobra nada, no lleva ninguna clave)

1. **New → GitHub repo → SIP**, en el mismo proyecto que `sip-solana-keeper`. Llámalo `sip-solana-volume-keeper`.
2. **Settings → Source**: *Branch* = `volume-keeper` mientras el código no esté en `main`. *Root Directory* vacío.
3. **Settings → Build**: el builder tiene que decir *Dockerfile* (lo detecta en la raíz). *Watch Paths*: las mismas que
   el de la sección 1.
4. **Settings → Deploy**: *Healthcheck Path* `/health`, reinicio *On Failure* con 10 intentos. **Settings → Scale**: 1
   réplica. **Settings → Networking**: genera un dominio.
5. **Variables**, solo estas tres:
   - `SIP_SOLANA_ROLE` = `volume`
   - `SIP_SOLANA_PROGRAM_ID` = el mismo valor que en `sip-solana-keeper` (es público)
   - `SIP_SOLANA_RPC_URLS` = una URL de Helius con **una clave de API nueva**, creada en el panel de Helius para este
     servicio, para no gastar las peticiones por segundo del vigilante que cobra. Pégala solo en Railway.
6. **No pongas** `SIP_SOLANA_BROADCAST`, `SIP_SOLANA_ALLOW_BROADCAST`, `SIP_SOLANA_SETTLE_KEY`, las de Privy,
   `DATABASE_URL`, `SIP_SOLANA_DOORBELL_SECRET` ni `SIP_SOLANA_ALERT_WEBHOOK`. En seco no pide candado, no lee claves de
   firma y no escribe historial (sección 3).
7. Comprueba:
   - `https://<dominio>/health` responde `{"ok":true}`;
   - `https://<dominio>/status` dice `"role":"volume"`, `"mode":"dry-run"`, `"armed":false`;
   - tu wallet tiene `"invest":"none (volume keeper)"`, y en `detail` la vista previa del volumen;
   - en *Deploy Logs*, `keeper starting` dice `role: volume keeper — settles VOLUME vaults only, never invests`.

### Fase B — cobrar de verdad (después, y en este orden)

1. **Primero el vigilante de siempre con el código nuevo** (`main`), para que deje de tocar los vaults de volumen.
2. **Después, un vault en modo volumen** para la prueba real. Hace falta abrir el volumen en la web solo para ese vault.
3. **Por último, armar este servicio.** Añade como *referencia* a `sip-solana-keeper`, sin pegar valores (Railway:
   *Add Variable → Reference*): `DATABASE_URL`, `SIP_SOLANA_BROADCAST`, `SIP_SOLANA_ALLOW_BROADCAST`,
   `SIP_SOLANA_SETTLE_KEY`, `SIP_SOLANA_PRIVY_APP_ID`, `SIP_SOLANA_PRIVY_APP_SECRET`,
   `SIP_SOLANA_PRIVY_AUTHORIZATION_KEY`, `SIP_SOLANA_PRIVY_SIGNER_ID`, `SIP_SOLANA_PRIVY_POLICY_ID` y
   `SIP_SOLANA_ALERT_WEBHOOK`. La cadena solo acepta esa llave de cobro, y cada wallet tiene sentado un solo firmante de
   Privy: por eso son las mismas.
4. Comprueba en `/status`: `"mode":"live"`, `missingLiveCondition` null. La primera barrida puede decir otra cosa
   mientras toma su candado.

**Si falta `SIP_SOLANA_ROLE`**, este servicio arranca como un segundo vigilante de beneficio. En seco no hace nada.
Armado, compite por el candado del de siempre y solo uno de los dos actúa, pero sería el servicio equivocado.
Un valor que no sea `volume` ni `profit` impide arrancar.

## 7. Los recortes de coste (`SIP_SOLANA_CUTS`) y la lista de respaldo (`SIP_SOLANA_DISCOVERY_LKG_MS`)

Las dos variables están **apagadas si no existen**: sin ellas el vigilante hace exactamente lo de siempre, petición por
petición. Los tres primeros nombres de la tabla no tocan el dinero (qué se cobra, a quién, cuánto, qué se compra). **Los
cuatro siguientes sí** (deciden si una compra empieza, cuándo se busca un cobro o cómo sale una transacción): se encienden
**de uno en uno y en este orden** —`jupiter-key`, `rest-skip`, `invest-batch`, `explicit-send`—, cada uno con su propio
periodo de prueba antes del siguiente. Diseño: ADR del dispatcher, §2.3 y §6.

`SIP_SOLANA_CUTS` es una lista separada por comas. Un nombre que no esté en esta tabla, o uno repetido, **impide
arrancar** (Railway deja funcionando el despliegue anterior). **Volver atrás = quitar el nombre** y redesplegar.

| nombre | qué cambia | qué mirar en `/status` |
|---|---|---|
| `gpa-v2` | Buscar los vínculos con `getProgramAccountsV2` de Helius (1 crédito por página en vez de 10). Si el endpoint no lo entiende, en la misma barrida vuelve a la llamada de siempre | `discovery.method` = `"v2"`; si dice `"v1-fallback"`, `discovery.fallbackReason` dice por qué. `linksDiscovered` igual que antes |
| `privy-address` | Leer el registro de Privy de cada wallet **por su dirección** y guardarlo, en vez de listar todas las wallets de la app en cada barrida. Una wallet que aún no se puede firmar se vuelve a mirar cada minuto (lo que arregla el dueño desde la web se ve igual de rápido); una que sí, cada 30 min, o enseguida si Privy rechaza un envío. **Justo antes de cada cobro se vuelve a preguntar**: si el dueño quitó el permiso en ese rato, el turno dice `NO_SIGNER` (aviso) y no se envía nada, en vez de un cobro fallido que llega a Telegram como crítico | `cuts.privyAddressBook.listPages` no sube después de la primera barrida; `signing.wallets.signable` igual que antes; `cuts.privyAddressBook.withdrawnAtSend` cuenta los cobros parados así |
| `board-timer` | El ranking se recalcula como mucho cada 15 s después de un cobro, uno a la vez, en vez de una vez por cobro | `cuts.board.refreshes`; un cobro nuevo sale en `/leaderboard` en ≤ 15 s |
| `jupiter-key` (dinero, 1.º) | Con `SIP_SOLANA_JUPITER_API_KEY` puesta, cada llamada a Jupiter va a `api.jup.ag` con la clave; sin ella, al host de siempre. Un turno que compra **reserva todas sus llamadas** (6 por pierna y por la conversión) antes de la primera: si no caben en el minuto se aplaza (`DEFERRED`) **sin cotizar, envolver ni enviar nada**, y vuelve a intentarlo en la barrida siguiente. Tras un 429 espera (1 min, doblando hasta 10). `SIP_SOLANA_JUPITER_CALLS_PER_MINUTE` cambia el límite (60 con clave, 30 sin ella). Una clave mal pegada **impide arrancar** | `cuts.jupiter.host`, `.keyed` (nunca la clave), `.deferred`, `.http429` (debe quedarse en 0), `.lastDeferral` |
| `rest-skip` (dinero, 2.º) | Un vínculo que descansa sobre su propio cobro, y cuya última firma no ha cambiado, devuelve el mismo `IDLE` sin volver a recorrer su ventana (1 llamada en vez de 3). No envía nada: como mucho retrasa la búsqueda de un cobro | `cuts.restSkip.skips` sube, `.recorded` casi quieto; `.invalidated` = vínculos que se movieron y se recorrieron |
| `invest-batch` (dinero, 3.º) | Las lecturas en reposo de cada turno de inversión (política, saldos de wSOL y USDC, reloj, Pyth) van en el mismo lote que los vaults: el censo del vigilante de beneficio baja de 19 a 7 llamadas por barrida. **La foto solo decide turnos que no envían nada**; un turno que compraría se repite con lecturas frescas | `cuts.investBatch.decidedFromSnapshot`, `.rereadFresh`, `.investedAfterReread` (> 0 = una compra real por el camino nuevo), `.batchFailed` |
| `explicit-send` (dinero, 4.º) | El wrap, la conversión y cada pierna se envían en el orden del vigilante —blockhash, construir, firmar, **preguntar si sigue siendo el que actúa**, enviar, confirmar por sondeo—; **75 s sin compras** tras tomar el candado, y con SIGTERM deja de empezar envíos y espera hasta 20 s a los que ya salieron antes de soltar el candado | `cuts.explicitSend.sent`, `.landed`, `.reverted`, `.expired`, `.refused`, `.quietUntil`, `.drain` |

`SIP_SOLANA_DISCOVERY_LKG_MS` (0 = apagado; el valor previsto es `600000`, 10 minutos; como mucho `3600000`): si la
búsqueda de vínculos falla, la barrida **no se cae**: usa la última lista buena si tiene menos de ese tiempo, y vuelve a
leer **cada vínculo de la cadena en ese momento** (el nonce y la frontera que firma el atestador nunca salen de memoria).

- `/status` → `discovery.source` = `"lkg"` y `discovery.lkgUses` > 0 quieren decir que pasó. Un vínculo creado durante
  el fallo no se ve hasta que la búsqueda vuelva a funcionar.
- Alerta `discovery-stale`: aviso en el registro mientras la lista guardada tenga 10 minutos o menos; **Telegram si
  tiene más**. Con el valor previsto (`600000`) eso no llega a pasar: pasado el límite de edad la lista ya no se usa y
  la barrida falla como siempre (`sweep-failed`, que sí llega a Telegram).
- Al arrancar siempre hace falta una búsqueda buena: no hay lista guardada entre reinicios.
- Volver atrás: `0` o borrar la variable.

## 8. Lo que falta de L1a: vigilancia y alertas (`SIP_SOLANA_CUTS`, apagado si no se nombra)

Van en la misma variable que los recortes de §7, con las mismas reglas: un nombre desconocido o repetido **impide
arrancar**, y **volver atrás = quitar el nombre** y redesplegar. Ninguno toca el dinero: cambian a quién se despierta
y, uno de ellos, si el proceso sigue vivo. Diseño: ADR del dispatcher, §3.11, §4.10 y §6.3. Sin ninguno, `/status` no
tiene bloque `ops` y el vigilante hace lo de siempre.

| nombre | qué hace | qué mirar en `/status` |
|---|---|---|
| `watchdog-exit` | Si el barrido no AVANZA en `max(3 × sweepMs, 10 min)` —la misma regla que `/health`—, el vigilante manda una crítica (`watchdog-exit`), suelta el candado y **sale con código 3**; Railway lo arranca de nuevo (`ON_FAILURE`). Un barrido lento que avanza, un vigilante sin nada que hacer o uno arrancando no salen nunca | `ops.progress.lastProgressAt`, `ops.progress.exitAfterMs` |
| `dep-down` | Una crítica **por dependencia caída** —`dep-down:rpc`, `:privy`, `:jupiter`, `:database`— en vez de un `sweep-failed` genérico y una alerta por wallet. Caída = 3 peticiones seguidas fallando durante al menos 1 minuto (sin respuesta, 5xx, 408 o 429; para Jupiter el 429 es cosa de `jupiter-budget`), o un barrido que muere porque **todos** los endpoints RPC rechazan. Mientras dura, las alertas de wallet que explica se **retienen** (no salen) y se cuentan. Un `settle` RECHAZADO (FAILED) nunca se retiene | `ops.deps.<dep>.down`, `.downSince`, `.lastFailure`, `.held` (la base de datos se llama `database`, nunca `postgres`: `postgres` es el usuario por defecto de `DATABASE_URL` y el redactor lo borraría de `/status` y de la alerta) |
| `warn-digest` | **Un mensaje al día a las 08:00 UTC** con los avisos que no salieron de la caja, por tipo (`no-signer`, `invest-refused`…), cuántas veces y cuándo el último; también los días sin avisos, como prueba de que las alertas llegan. Sale por su propio canal con umbral `warn`, al mismo chat | `ops.digest.nextAt`, `.kinds`, `.raised` |
| `claim-flap` | Cuenta las tomas del candado de este proceso, sus pérdidas y sus **recuperaciones**; una recuperación (segunda toma del mismo proceso) es crítica. La primera toma de cada contenedor es un despliegue y no avisa | `ops.claim.takeovers`, `.regains`, `.losses`, `.lastLoss` |
| `privy-burn` | Aviso al 60 % y crítica al 85 % de las 50.000 firmas gratis de Privy al mes, al ritmo observado (hasta las últimas 24 h; nada antes de 1 h). Es la cuenta de **este** servicio: los dos vigilantes firman con la misma app, así que el total es la suma de sus dos `/status` | `privy.signaturesMonthEstimate` |
| `jupiter-budget` | Aviso cuando el último minuto gasta el 80 % del límite por minuto de Jupiter (30 sin clave); **crítica si Jupiter contesta 429 a una compra real** (en seco, aviso). No se da por resuelta hasta 30 minutos sin otro 429, así que un episodio avisa una vez | `jupiter.callsLastMinute`, `ops.jupiterAnswers.http429` |
| `rpc-fallback` | Crítica cuando un endpoint de respaldo lleva **10 minutos** contestando solo (el 1, el de Helius, sigue apartado: una clave sin créditos contesta 429 "max usage") | `rpcEndpointInUse`, `rpc.endpointSinceMs`, `rpc.byEndpointPerDay` |
| `privy-index` | Aviso al primer barrido en que falla el listado de wallets de Privy; crítica al tercero seguido (cada wallet pasa a buscarse sola, listando la app entera por wallet) | `privy.consecutiveIndexFailures`, `privy.fallbackLookups` |

- **Si salta `watchdog-exit`**: el log de antes de la salida dice dónde se quedó. Railway reintenta `ON_FAILURE` hasta
  10 veces seguidas (`restartPolicyMaxRetries`); un vigilante que se cuelga en cada arranque deja de reiniciarse
  después. Lo que no ve: un bucle síncrono que nunca suelta el proceso (el reloj que lo comprueba es del mismo proceso).
- **Si salta `dep-down:<dep>`**: llega una vez por caída y se borra sola con la primera respuesta. Las alertas
  retenidas que sigan siendo verdad vuelven a salir en el barrido siguiente a la recuperación.
- Con `dep-down` o `jupiter-budget`, el vigilante observa las peticiones a Jupiter desde el `fetch` global (su constructor de rutas no
  acepta otro): solo mira el host `jup.ag`; el resto pasa sin tocarse y sin guardar la URL.

## 9. Las pérdidas arrastradas, en Postgres (`SIP_SOLANA_CARRY_STORE`, apagado si no existe)

Cuando un tramo con pérdida se cobra a cero, la pérdida pasa al tramo siguiente y rebaja lo que se cobra al próximo
trade ganador. Hoy esa pérdida vive **en memoria**: un reinicio (y cada despliegue lo es) la olvida, y el siguiente trade
ganador se cobra entero. Esta variable la guarda en la tabla `sip_solana.loss_carry`. Diseño: ADR del dispatcher, §4.6.

| valor | quién decide | qué pasa si Postgres falla |
|---|---|---|
| sin poner, u `off` | la memoria, como siempre | — |
| `dual` | la memoria; también escribe en Postgres y compara cada lectura | aviso `carry-store` en el registro; **el cobro sale igual**, como con `off` |
| `on` | Postgres, leído en cada turno | el cobro de ese turno **espera** (RETRY, no se envía nada) hasta que Postgres conteste |

- **Solo en `sip-solana-keeper`** (el de beneficio). El de volumen **no arranca** con `dual` u `on` (no arrastra
  pérdidas), y ninguno arranca con `dual` u `on` sin `DATABASE_URL`. Un valor distinto de `off`, `dual` u `on` impide
  arrancar.
- **En este orden, y no en otro:**
  1. **Primero crea la tabla**: el mismo comando de la sección 0 (`setup-read-model`; es idempotente). Sin la tabla,
     con `on` el vigilante **no actúa en absoluto**: ni cobros ni compras (si todo lo demás está en orden, `/status` →
     `missingLiveCondition` dice `SIP_SOLANA_CARRY_STORE is on and the loss-carry store is not ready: …`).
  2. Pon `dual` y despliega. En `/status`: `carryStore.notReady` = `null` y `carryStore.dbOnlyAtBoot` un número.
  3. Pasa a `on` solo después de **14 días con `carryStore.mismatches` = 0 y `carryStore.seenInBoth` ≥ 1**, o del
     simulacro que acepta el ADR. Una alerta `carry-mismatch` hay que entenderla antes de seguir.
- **Si en `on` Postgres no contesta, o falta la tabla**: cada wallet afectada dice `RETRY` en su fila de `/status`
  ("the loss-carry store could not be read/written") y **ninguna wallet manda alerta propia**. Llega **una** alerta,
  `carry-store`: aviso al primer fallo y **crítica** si pasan 2 minutos sin una sola respuesta. Se resuelve sola con la
  primera respuesta. Con `dep-down` en `SIP_SOLANA_CUTS`, sus peticiones cuentan para `dep-down:database`, y mientras
  esa alerta está activa `carry-store` se retiene (una caída, un mensaje). Crear la tabla mientras el vigilante corre
  basta: la vuelve a buscar en cada barrida, sin reiniciar.
- **Qué mirar en `/status` → `carryStore`**: `mode`, `notReady`, `lastProblem` (qué falló y cuándo), `readFailures`,
  `writeFailures`, `written`, `mismatches`, `lastMismatch`, `seenInBoth`, `refusedAtGate` (cobros que la puerta paró
  porque otro intento desde el mismo estado del vínculo podía seguir en vuelo, o el vínculo ya se había movido),
  `dbOnlyAtBoot`, `decidedWithDbRow` (pérdidas que un reinicio habría olvidado).
- **Volver atrás**: de `on` a `dual` (al arrancar, `dual` carga en memoria lo que `on` escribió; si Postgres no contesta
  en ese momento lo reintenta en cada barrida, y `carryStore.dbOnlyAtBoot` sigue en `null` hasta que lo consigue), o
  quitar la variable (vuelve a la memoria: una pérdida pendiente se olvida en ese despliegue,
  como hoy). **Nunca borres la tabla**: `loss_carry` no se puede reconstruir desde la cadena.
- **Conexiones a Supabase**: el almacén abre **su propia conexión**, además de las 2 del historial. Un
  `sip-solana-keeper` con `dual` u `on` usa hasta **3**, y **6 durante un despliegue** (el contenedor viejo y el nuevo a
  la vez); el de volumen, 2 y 4. Antes de encenderlo, comprueba que la suma de los dos servicios durante un despliegue
  (6 + 4 = 10) más todo lo demás que use esa base queda al menos 5 por debajo del límite del pooler de sesión de Supabase.

## 10. El despachador (`scheduler` y `worker`) y el traspaso de vaults

> **Está en producción.** El código está en `main` desde el 24-oct (f0a2ea1). En Railway corren `sip-solana-scheduler`
> (2 réplicas) y `sip-solana-worker` (1 réplica con 2 huecos), con `SIP_SOLANA_DISPATCH=on` y la base de producción. El
> vault del dueño, `EFXK995P…`, está en la cola desde el 27-oct: el primer cobro de un worker salió a las 06:03Z y la
> primera compra a las 06:23Z, después de poner una clave gratuita de Jupiter (en el worker `SIP_SOLANA_CUTS=jupiter-key`,
> `SIP_SOLANA_JUPITER_API_KEY` y `SIP_SOLANA_JUPITER_CALLS_PER_MINUTE=50`; en el scheduler, solo los 50). Los demás
> vaults siguen con los vigilantes de siempre hasta que hagas **10.8**, el paso a paso para llevarlo todo al sistema
> nuevo; lo que puede avisar después, y qué hacer, está en **10.9**. La herramienta para mirar y mover la flota es
> `flota-prod` (10.4). El `CMD` del Dockerfile sigue siendo `bin/keeper.mts`: los dos servicios nuevos arrancan por su
> comando de arranque (abajo), y con `SIP_SOLANA_DISPATCH` sin poner (u `off`) cualquiera de los dos lo dice y sale con
> 0 sin abrir una conexión (un worker con la puerta de `/health`, no: 10.1). El ciclo entero en sombra (los dos
> servicios, el traspaso, un worker muerto a mitad de trabajo y otro que lo releva) lo prueba
> `test/dispatcher-e2e.test.ts` contra el stub de cadena del bench y un Postgres desechable. Diseño: ADR del
> dispatcher, §2.4, §3.8–§3.12 y §6.

### 10.1 Los dos servicios nuevos

| servicio | réplicas | público | lleva | no lleva |
|---|---|---|---|---|
| `sip-solana-scheduler` | 2 (una tiene el candado `sip-solana-scheduler`, la otra espera; su `/status` dice cuál contestó en `scheduler.role`: `acting` o `standby`) | sí: `/hooks/helius`, `/status`, `/leaderboard`, `/health` | `DATABASE_URL`, las URL de RPC, la clave de Helius, el secreto del timbre (hoy no: 10.3), el Telegram | la llave de cobro, nada de Privy |
| `sip-solana-worker` | hoy 1 × 2 huecos | no | `DATABASE_URL`, las URL de RPC, la llave de cobro, la app, la authorization key, **`SIP_SOLANA_PRIVY_SIGNER_ID` y `SIP_SOLANA_PRIVY_POLICY_ID`** de Privy (en `on` sin estas dos **no arranca**), la clave de Jupiter, el Telegram | el secreto del timbre (no recibe a Helius) |

**Las variables del worker son referencias de Railway a las de `sip-solana-keeper`**: por eso ese servicio **nunca se
borra**, ni siquiera cuando se pare (10.8, paso 8).

- **Cada servicio se configura a mano**, como los de las secciones 1 y 6: el Dockerfile de la raíz construye la imagen
  del vigilante (que copia `packages/solana-keeper` entero, así que los archivos nuevos van dentro), *Restart On
  Failure*, y **`RAILWAY_DEPLOYMENT_DRAINING_SECONDS=30` en todos** (decisión 6: sin eso Railway mata el contenedor al
  instante de avisarle y cada despliegue es una toma de control con espera, ADR §3.11).
- **El comando de arranque** (*Settings → Deploy → Custom Start Command*; la imagen arranca en
  `packages/solana-keeper`): `node_modules/.bin/tsx bin/scheduler.mts` en `sip-solana-scheduler` y
  `node_modules/.bin/tsx bin/worker.mts` en `sip-solana-worker`. Sin él, la imagen arranca el vigilante de siempre. Si
  el servicio tiene `SIP_SOLANA_WORKER_HEALTH` (aunque sea `off`), ese vigilante se niega a arrancar (`configuration
  refused`): su propio `/health` contesta `200` en cuanto escucha, y pasaría el healthcheck del worker (abajo).
- **`sip-solana-worker` contesta `/health` y nada más, si se lo pides** (`SIP_SOLANA_WORKER_HEALTH=on`): es su puerta
  de `/health`, para que un despliegue que no arranca no sustituya al que funciona. Sin *Healthcheck Path*, Railway da
  por bueno un despliegue en cuanto arranca su contenedor y quita el anterior
  ([despliegues](https://docs.railway.com/reference/deployments)), así que una configuración que el worker rechaza al
  arrancar (sale con 2, o con 0 sin `SIP_SOLANA_DISPATCH`) deja la cola sin nadie. **Sin la variable no abre ningún
  puerto**, como hasta ahora, aunque tenga `PORT` (lo tienen todos). Con ella abre `/health` en `PORT` **solo después
  de todas sus comprobaciones de arranque**: contesta `503` mientras arranca, `200` en cuanto se ha apuntado en la base
  y su primera reclamación a la cola ha contestado, y `503` otra vez desde que Railway le manda parar (SIGTERM). Una
  configuración que rechaza no contesta nunca, y con *Healthcheck Path* Railway solo cambia al nuevo cuando contesta
  `200`: si no lo hace a tiempo, lo marca *Failed* y **el anterior sigue trabajando**
  ([healthchecks](https://docs.railway.com/reference/healthchecks),
  [despliegue malo](https://docs.railway.com/guides/roll-back-bad-deploy)). Si no puede abrir el puerto, sale con 1
  (`worker: health server failed`). **La variable y el *Healthcheck Path* van juntos, y se quitan juntos**: la variable
  sola puede ser peor que nada, porque con ella el worker se niega a arrancar con los tres ajustes de Jupiter y
  alertas de abajo, que sin ella solo avisan o ni eso, y sin *Healthcheck Path* Railway quita igual el anterior: la
  cola se queda sin worker. El *Healthcheck Path* sin la variable hace que cada despliegue acabe *Failed* (el worker no
  escucha). Railway solo lo mira al desplegar: si el worker se para después, lo dicen `fleet.workers` y `queue-lag`
  (10.9), no `/health`. **Solo protege de lo que el worker rechaza al arrancar** (una variable que falta, sobra o no
  tiene forma) y de una base que no contesta: una URL o una llave bien escrita pero equivocada arranca, sustituye al
  anterior y lo dicen después sus alertas (`settle-key-mismatch`, la authorization key, `job-failing:<vault>`…: 10.9).

  **Para activarlo, en este orden:**
  1. **El push** que trae este código. No cambia lo que hace: sin la variable el worker no abre ningún puerto. Míralo
     igual: en *Deployments* de `sip-solana-worker` el activo es ese commit, y en sus *Deploy Logs* la línea
     `worker starting` dice `"health":"off"`, en `jupiter` `"keyed":true` y en `alerts` `"kind":"telegram"`. Si dice
     otra cosa, avísame antes del paso 2: con la puerta, un worker en `on` con `jupiter-key` y sin la clave de Jupiter,
     o sin el webhook de alertas, no arranca (los tres ajustes de abajo).
  2. **Antes de tocar nada**, en `sip-solana-worker`:
     - *Variables*: ninguna `SIP_SOLANA_WORKER_…` aparte de `SIP_SOLANA_WORKER_SLOTS` (`SIP_SOLANA_WORKERS_MAX`, con
       S, es otra y se queda). Si hay otra, avísame antes de seguir: el worker no la lee, solo deja un aviso en su log.
     - *Settings → Build → Watch Paths*: las mismas que en `sip-solana-scheduler`, o ninguna en los dos, para que un
       push despliegue los dos o ninguno.

     **Luego, un solo cambio**, sin pulsar Deploy entre medias:
     - *Variables*: **`PORT` = `8080`**, **`SIP_SOLANA_WORKER_HEALTH` = `on`** y **`RAILWAY_HEALTHCHECK_TIMEOUT_SEC` =
       `120`** (Railway espera hasta 2 min a que conteste `200`, en vez de 5);
     - *Settings → Deploy*: **Healthcheck Path** = `/health`.

     Sin `PORT` el worker escucharía en el 8080 de la imagen (`ENV PORT=8080` del Dockerfile), o en el `PORT` que le
     ponga Railway: su guía dice que inyecta `PORT` y que el healthcheck llama a ese puerto, pero no qué hace en un
     servicio sin dominio público, como este. Puesta a mano no hay duda: el worker escucha en el 8080 y el healthcheck
     llama al 8080.
  3. **Deploy**, una vez: aplica los cuatro cambios y vuelve a desplegar el mismo código, ya con la puerta.
     - **Comprobar**: el despliegue nuevo pasa a *Active* en unos segundos. En sus *Build Logs* Railway escribe
       `Starting Healthcheck`, algún intento fallido mientras el worker arranca (es normal: `failed with service
       unavailable` si aún no escucha, `failed with status 503` si ya escucha y aún no ha reclamado) y luego que lo
       pasó. En sus *Deploy Logs*: `worker: listening for /health`; `worker starting`, que ahora dice
       `"health":{"on":true,"port":8080}`, en `jupiter` `"keyed":true` y en `alerts` `"kind":"telegram"` (si dice
       otra cosa, avísame); y `worker ready`. El anterior se para, y al rato `flota` dice «Trabajadores: 1 vivo».
     - **Deshacer**: si acaba *Failed* aunque sus *Deploy Logs* digan `worker ready`, el healthcheck de Railway no llega
       a `/health` (puede que no llegue a un servicio sin dominio público). Quita los cuatro cambios del paso 2, Deploy,
       y avísame: el worker queda como antes del paso 2. Si acaba *Failed* sin `worker ready`, el worker no arrancó y
       el anterior sigue trabajando: qué buscar está en 10.9.

  **Con la puerta de `/health` puesta:**
  - **Cada despliegue del worker** se queda en *Deploying* hasta que el nuevo contesta `200` (unos segundos, tras
    `worker ready`), ya trabajando al lado del anterior. Solo entonces Railway para el anterior, que termina lo que
    tenga entre manos (con los 30 s de `RAILWAY_DEPLOYMENT_DRAINING_SECONDS`) y desde ese momento ya no cuenta en el
    reparto de cuotas del scheduler. Si la configuración nueva no arranca, el despliegue acaba *Failed* en unos 2 min
    y **el anterior sigue sirviendo la cola tal cual**, y por Telegram no llega nada: un worker que se niega a arrancar
    sale antes de poder avisar. Así acaban quitar `SIP_SOLANA_DISPATCH`, dejar `on` sin armar o pasar a `shadow`
    todavía armado. Por eso, **tras cualquier cambio de variables, mira en *Deployments* que el nuevo queda
    *Active***; si acaba *Failed*, qué buscar está en 10.9. Arréglalo y vuelve a desplegar.
  - **Para pararlo sin que un push lo vuelva a arrancar**: `SIP_SOLANA_DISPATCH` = `off` → Deploy. El nuevo no abre
    base ni RPC ni reclama nada, contesta `200` (en sus *Deploy Logs*, `it answers /health 200 (off)`) y Railway retira
    el anterior; un push lo vuelve a desplegar igual de parado. Mientras tanto nadie cobra ni compra los vaults de la
    cola: `flota` dice «Trabajadores: 0 vivos», y en cuanto un vault espere más de dos ticks el scheduler avisa
    `queue-lag`. Para volver: `on` → Deploy. **Con `SIP_SOLANA_DISPATCH` vacía o borrada no arranca** (acaba *Failed*
    y sigue el anterior): una variable que se pierde en una edición no pasa por una parada.
  - **Para quitarlo del todo**: *Deployments* → el activo → **Remove**, y *Settings → Source* → **Disconnect** (como en
    10.8, paso 8.2). Solo *Remove* no basta: el siguiente push lo vuelve a desplegar. En la cola pasa lo mismo que con
    `off`: `flota` dice «Trabajadores: 0 vivos» y, en cuanto un vault espere más de dos ticks, llega `queue-lag`. Para
    volver: en *Settings → Source*, vuelve a conectar el mismo repositorio (rama `main`) y **Deploy**.
  - **Un despliegue durante una caída de la base acaba *Failed*** y se queda el anterior: vuelve a desplegarlo cuando
    pase. Un push puede acabar igual, con el worker en el código de antes, así que **un push no ha terminado hasta que
    el worker corre el commit nuevo**: en *Deployments* de `sip-solana-worker`, el *Active* es el del push (y en el
    `/status` del scheduler, la `version` de su fila en `fleet.workers` empieza por ese commit).
  - **Para volver con *Rollback* a un despliegue sin la puerta** (de antes de este push, o de antes del paso 2), primero
    quita el *Healthcheck Path* y aplica ese cambio sin redesplegar: **Deploy** pulsado con la tecla **Alt** (10.9,
    «Rotar un secreto»). Mira en *Settings → Deploy* que ya no lo tiene, y solo entonces haz el *Rollback*. Con el
    *Healthcheck Path* aún puesto, ese worker no escucharía: el *Rollback* puede acabar *Failed* o, si Railway no lo
    comprueba, dejar *Failed* cada push siguiente. Un *Rollback* devuelve también las variables de aquel despliegue:
    después, revisa las del servicio (en uno de antes del paso 2 ya no están `SIP_SOLANA_WORKER_HEALTH=on` ni
    `RAILWAY_HEALTHCHECK_TIMEOUT_SEC`). Para volver a la puerta, repite los pasos 2 y 3; si el *Rollback* fue a un
    código de antes de este push, antes tiene que volver este código (lo trae el siguiente push: paso 1).
  - **Tampoco arranca con tres ajustes que sin la puerta solo avisan, o ni eso**: en `on`, con `jupiter-key` en
    `SIP_SOLANA_CUTS` y sin `SIP_SOLANA_JUPITER_API_KEY` (sin la puerta compraría sin clave por `lite-api.jup.ag`, sin
    decirlo); con `SIP_SOLANA_JUPITER_API_KEY` o `SIP_SOLANA_JUPITER_CALLS_PER_MINUTE` y sin `jupiter-key`; y en `on`
    sin `SIP_SOLANA_ALERT_WEBHOOK`. Así que, con la puerta, quitar `jupiter-key` del worker es quitar también esas dos
    variables, en el mismo despliegue. Con puerta o sin ella, su línea `worker starting` dice si Jupiter va con clave
    (`jupiter`: `keyed`, las llamadas por minuto y el host) y adónde van las alertas (`alerts`: `telegram`, `webhook` o
    `none`).
- **Su estado lo enseña el `/status` de la flota**, que sirve el scheduler desde Postgres (`fleet.workers`, y cada vault
  con su último trabajo en `fleet.vaults`). **Manda sus propias alertas** (desde 34816a1) al mismo
  `SIP_SOLANA_ALERT_WEBHOOK` que los vigilantes, con «[worker] » delante: la misma escalera por wallet y por vault que
  el vigilante de siempre (cobro fallido, reintentos, sin firmante, compra fallida o rechazada, wrap corto, comisión de
  una pata), `settle-key-mismatch` si la llave de cobro no es la que nombra la cadena, `seat-unbounded`, la
  authorization key de Privy (al arrancar y cada 30 min), el almacén de pérdidas y `job-failing:<vault>` para un vault
  cuyos trabajos revientan o pasan el techo una y otra vez. Las de la flota (lease, fence, cola, Postgres, vaults sin
  servir) siguen siendo del scheduler, «[scheduler] » delante; `scheduler-stale` la mandan los dos (10.9).
- **Sus variables**, además de las compartidas (`DATABASE_URL`, `SIP_SOLANA_RPC_URLS`, `SIP_SOLANA_PROGRAM_ID` y, en el
  scheduler, el Telegram). Todas estrictas: un valor que no sea exactamente uno de los aceptados **no arranca**.

  | variable | dónde | valor | sin ponerla |
  |---|---|---|---|
  | `SIP_SOLANA_DISPATCH` | los dos | `off`, `shadow` u `on` | `off`: sale con 0. Un worker con `SIP_SOLANA_WORKER_HEALTH=on` **no arranca** sin ella, y con `off` escrita se queda encendido sin hacer nada (arriba) |
  | `SIP_SOLANA_SWEEP_MS` | scheduler | el tick, en ms (≥ 5000) | 60000 |
  | `SIP_SOLANA_PLAN_RPS` | los dos, **el mismo valor** | peticiones por segundo del plan de Helius (1–10000) | 50 (Developer) |
  | `SIP_SOLANA_WORKERS_MAX` | los dos, **el mismo valor** | cuántas réplicas de worker puede haber como mucho (1–64) | 2 |
  | `SIP_SOLANA_WORKER_SLOTS` | worker | trabajos a la vez por réplica (1–8) | 2 |
  | `SIP_SOLANA_WORKER_HEALTH` | worker | `on` u `off`: con `on`, la puerta de `/health` (arriba) | `off`: no abre ningún puerto |
  | `PORT` | worker con `SIP_SOLANA_WORKER_HEALTH=on` | `8080`: donde contesta `/health` | el que ponga Railway, o el 8080 de la imagen |
  | `RAILWAY_HEALTHCHECK_TIMEOUT_SEC` | worker con `SIP_SOLANA_WORKER_HEALTH=on` (la lee Railway, no el worker) | `120`: los segundos que Railway espera el `200` | 300 |
  | `SIP_SOLANA_PLAN_CREDITS_MONTH` | scheduler | créditos del plan al mes | 10 000 000 |
  | `SIP_SOLANA_ARCHIVAL_CREDITS` | scheduler | `1` o `10`: lo que cuesta una llamada de archivo (4.1) | `1` |
  | `SIP_SOLANA_JUPITER_CALLS_PER_MINUTE` | scheduler, y el worker con `jupiter-key` | las llamadas a Jupiter por minuto de la organización, que el scheduler reparte | 30 (sin clave) |
  | `SIP_SOLANA_CUTS` | los dos | los que actúan en el scheduler: `gpa-v2`, `lamports-filter`; en el worker: `rest-skip`, `invest-batch`, `jupiter-key` | ninguno |
  | `SIP_SOLANA_PRICE_TAPE` | scheduler | `off` u `on`: apunta el precio SOL/USD de Pyth una vez por tick en `sol_price_tape` (10.7) | `off` |
  | `SIP_SOLANA_AUTO_ARM` | scheduler | `off` u `on`: con `on`, y solo con `SIP_SOLANA_DISPATCH=on`, la réplica con el candado pasa a la cola los vaults nuevos que ella misma apuntó como `draining` (10.5, «Vaults nuevos»); lo que hace sale en `scheduler.autoArm` de su `/status` | `off` |
  | `SIP_SOLANA_LEGACY_ROLES` | scheduler | `profit`, `volume`, los dos separados por coma, o `none`: de qué vigilantes de siempre exige el auto-arm un recibo «acting». `none` es «están parados» (10.8, paso 8). Con `SIP_SOLANA_DISPATCH=on` el aviso `legacy-orphaned` (10.9) lee la lista entera, con o sin auto-arm: vigila solo los roles nombrados (sin la variable, los dos), así que un vigilante que no está en la lista no avisa si se para | los dos |
  | `SIP_SOLANA_EXTRA_MODES` | worker | `roundup`, `fixed` o los dos: los modos por operación que cobra (10.7) | ninguno |
  | `SIP_SOLANA_EXTRA_MODES_VAULTS` | worker, **obligatoria** con la anterior | las direcciones de vault, separadas por comas, o `*` | — |
  | `SIP_SOLANA_EXTRA_MODES_LIVE` | worker | `0` o `1`: con `0` esos vaults se miden en seco aunque el worker esté en `on` | `0` |
  | `SIP_SOLANA_EXTRA_MODES_FROM_SLOT` | worker, **obligatoria** con `LIVE=1` | el slot desde el que se cobra: lo anterior se perdona | ninguno |

  **El scheduler no arranca** si tiene `SIP_SOLANA_BROADCAST`, `SIP_SOLANA_ALLOW_BROADCAST`, cualquier secreto de firma,
  `SIP_SOLANA_JUPITER_API_KEY` o `SIP_SOLANA_ROLE`: es la réplica pública y no lleva ninguna llave. **Un worker en
  `shadow` no arranca armado**, y **uno en `on` no arranca sin armar** (`SIP_SOLANA_BROADCAST=1` y la frase exacta de
  `SIP_SOLANA_ALLOW_BROADCAST`).
- **`/health` solo lo mira Railway al desplegar.** Un scheduler colgado se reinicia porque **sale solo** con código de
  error (ADR §3.11), no porque Railway lo vigile. El worker no tiene ese reloj: su `/health`, si lo tiene
  (`SIP_SOLANA_WORKER_HEALTH=on`), solo sirve para desplegar (arriba).
- **`SIP_SOLANA_DISPATCH`** (`off`, `shadow` u `on`; un valor distinto **no arranca**): en `shadow` los workers pasan por
  la puerta de envío igual que en `on` pero **no envían nada** y no llevan ninguna clave.
- **El ensayo en sombra va con su PROPIA base de datos**, nunca con la `DATABASE_URL` de producción. En la sombra todos
  los vaults tienen que estar en la cola para que los workers trabajen; en la base de producción, un vault marcado `queue`
  lo soltarían los vigilantes de siempre en cuanto llevaran `SIP_SOLANA_DISPATCH` (10.3), **sin traspaso**. En la base de
  la sombra los vaults llegan a la cola con `dispatch-handover arm --all --roles=none --allow-dry` (10.4), porque ningún
  vigilante de siempre la usa. Por eso las conexiones a Supabase de 10.2 no las mide la sombra: se cuentan aparte.

### 10.2 Conexiones a Supabase (cuéntalas antes de crear nada)

La cuenta exacta la hace `dispatchConnections` (`src/dispatch-store.ts`): el scheduler usa 3 (la réplica con el candado
2, la otra 1), cada worker 2, cada vigilante de siempre 2, y el de beneficio 1 más si tiene `SIP_SOLANA_CARRY_STORE`
`dual` u `on`. **Un push lo duplica todo** mientras arrancan los contenedores nuevos.

| workers (`r`) | sin los vigilantes de siempre | con los dos (y el almacén de pérdidas) | durante un push, con los dos |
|---|---|---|---|
| 1 | 5 | 10 | 20 |
| 2 | 7 | 12 | 24 |
| 3 | 9 | 14 | 28 |

Sin los vigilantes de siempre, un push con 1, 2 o 3 workers llega a 10, 14 o 18. **El *Pool Size* del pooler de sesión
de Supabase está en 30 desde el 28-oct** (el 25-oct se leyó 15). Con el margen de 5 que pide la sección 9 (hasta 25 de
30) cabe toda la tabla menos un caso: un push con 3 workers y los dos vigilantes de siempre encendidos llega a 28. **Con
3 workers, los vigilantes de siempre tienen que estar parados** (10.8, paso 8). Cada comando que abre la base por su
cuenta suma 1 mientras corre: el del traspaso (10.4), `flota-prod` y `setup-read-model`.

### 10.3 Los vigilantes de siempre durante la migración (`SIP_SOLANA_DISPATCH` en ellos)

Para que un vault pase a la cola, **los dos** vigilantes de siempre (`sip-solana-keeper` y `sip-solana-volume-keeper`)
tienen que dejarlo en paz: el de beneficio **invierte todos los vaults, sean del modo que sean**, así que excluirlo solo
en el de volumen dejaría una compra doble (RT-4).

- **Sin la variable (u `off`) no cambia nada**: ni siquiera consultan la tabla.
- **Con `shadow` u `on`** (en un vigilante de siempre las dos significan lo mismo): en cada barrida leen
  `sip_solana.vault_work` y **no cobran ni invierten** ningún vault cuyo `system` no sea `legacy`. Quién actúa lo decide
  esa columna, **nunca el modo del vault**: si el dueño cambia de beneficio a volumen, el vault no cambia de manos.
- **Exige `DATABASE_URL`** (sin ella no arranca) y la tabla creada: corre antes `setup-read-model` (sección 0; es
  idempotente). No abre conexiones nuevas: usa las 2 del historial.
- **Si la lectura falla, esa barrida no cobra ni invierte nada** (es un retraso, nunca un vault con dos dueños). Alerta
  `legacy-select`: aviso al primer fallo, **Telegram a la tercera barrida seguida**; se resuelve sola con la primera
  lectura buena.
- **En `/status`**: el bloque `dispatch` (`consecutiveFailures`, `lastReadAt`, `notLegacy` con cuántos vaults están
  `draining` y `queue`, `leftAlone` con las wallets que la última barrida dejó en paz y por qué, y `carryOnlyInMemory`);
  y cada wallet dejada en paz dice `"settle":"LEFT_ALONE","invest":"LEFT_ALONE"` con el motivo en `detail`.
- **El timbre de Helius se queda en el vigilante de beneficio** mientras corra: su webhook (el que acaba en `7eecdd`)
  vigila también las direcciones de los vaults de la cola. Pasarlo al scheduler se ha dejado para más adelante: con 50
  enlaces o menos no ahorra nada, porque la ronda de seguridad gira al menos 50 en cada tick (`SAFETY_MIN_PER_SWEEP`,
  `src/scheduler-select.ts`). Sin secreto del timbre, el scheduler hace una pasada completa en cada tick. Cuando pares
  este vigilante (10.8, paso 8) ese webhook se borra a mano en Helius.
- **Nunca quites `SIP_SOLANA_DISPATCH` de un vigilante de siempre mientras algún vault no sea `legacy`**
  (`dispatch-handover status` lo dice): volvería a cobrar e invertir vaults de la cola. Primero devuélvelos todos (10.5).

### 10.4 El traspaso en dos pasos: de los vigilantes de siempre a la cola

**Reglas:** un vault cada vez; **ningún push mientras un traspaso esté abierto** (un push reinicia los servicios, y cada
contenedor nuevo es un proceso más que el traspaso tiene que ver); para un vault de **beneficio**, el vigilante de
beneficio tiene que llevar antes `SIP_SOLANA_CARRY_STORE=dual` u `on` (sección 9): una pérdida que solo está en su
memoria no la vería la cola y cobraría de más el siguiente trade ganador, y el comando se niega a armar ese vault (con
`dual`, también mientras una escritura de esa pérdida en Postgres haya fallado: el aviso `carry-store`). Para volver
atrás un vault de beneficio hará falta `on` (10.5), y por eso `flota-prod` pide directamente `on` antes de traspasar uno.

**Desde qué carpeta.** Las dos herramientas de abajo corren desde un checkout en `origin/main` con `node_modules`: hoy
`~/ProyectosCT/SIP-dispatch`. **No las corras desde `~/ProyectosCT/SIP`**: puede estar en un commit viejo (el 27-oct
estaba en a0938f0, que no tiene `bin/dispatch-handover.mts`). `flota-prod` llega a `main` con el push que trae esta
sección: después de ese push, pon `~/ProyectosCT/SIP-dispatch` en `origin/main`.

**Usa `flota-prod`.** Hace estos mismos pasos con palabras (`flota`, `traspasar`, `traspasar-todos`, `volver`,
`nuevos-a-la-cola`, `nuevos-a-los-de-siempre`, `marcar-ido`, `marcar-idos-viejos`, `desaparcar`), un vault cada vez, y
antes de tocar nada se niega, diciendo por qué, a lo que se quedaría atascado. Desde **Terminal.app** (es SQL de
producción: lo corres tú):

```bash
F=~/ProyectosCT/SIP-dispatch/packages/solana-keeper/test-local/shadow/flota-prod.sh
"$F" flota
```

Cada vez pide la `DATABASE_URL` de `sip-solana-keeper` (Railway → Variables) sin enseñarla y no la guarda; solo acepta
una de Supabase en el puerto 5432. Para esperar los bloques lee la altura en el RPC público de Solana, y lee las tres
páginas `/status`; no envía nada a la cadena. `flota` no toca nada: enseña cada vault y quién lo sirve (sistema nuevo,
keepers de siempre, pasando o aparcado), adónde van los vaults nuevos, los recibos de los vigilantes de siempre con su
id, la salud del scheduler y del worker, y una lista «Siguiente:» con lo que toca hacer. Un `<vault>` es su dirección
o sus primeras letras, como las enseña `flota`.

**A mano, con `H`** (lo mismo, sin las comprobaciones previas de `flota-prod`). Pide la `DATABASE_URL` y una URL de RPC
sin enseñarlas; la de RPC solo se usa para **leer** la altura de bloque, no envía nada:

```bash
cd ~/ProyectosCT/SIP-dispatch/packages/solana-keeper && printf 'DATABASE_URL (puerto 5432): ' && read -rs DB && echo && printf 'URL de RPC: ' && read -rs RPC && echo
H() { DATABASE_URL="$DB" SIP_SOLANA_RPC_URLS="$RPC" PATH="$HOME/.nvm/versions/node/v22.14.0/bin:$PATH" node_modules/.bin/tsx bin/dispatch-handover.mts "$@"; }
```

Después, con `H` y la dirección del vault (`V=EFXK995P…`, la entera):

1. **`H status`** — tiene que haber al menos una fila `profit` y una `volume` con `live: true` y lectura reciente. Si
   falta un rol, ese servicio no tiene `SIP_SOLANA_DISPATCH` o no está corriendo.
2. **`H drain $V`** — el vault pasa a `draining`. En su siguiente barrida (≈ 1 min) los dos vigilantes lo dejan en paz.
3. **`H arm $V`** — mira que **cada** proceso apuntado haya leído el vault como ajeno. Si dice que un proceso no lo ha
   leído: espera una barrida. Si sigue, mira en Railway (*Deployments* del servicio) si ese `deployment` ya no existe;
   solo entonces márcalo: `H gone <process_id>` (o `H gone --stale` para todos los que llevan más de 15 min sin leer).
   Cuando nada falla, **apunta la altura de bloque** y dice hasta qué altura esperar.
4. **Espera ≥ 150 bloques** (≈ 1–1,5 min: lo que tarda en caducar cualquier transacción que un vigilante pudiera haber
   firmado antes) y repite **`H arm $V`** hasta que diga `moved: true` y `system: queue`. Si mientras tanto aparece un
   proceso que no lo ha leído como ajeno, `arm` lo nombra y la espera vuelve a empezar sola.
5. **Ya está en la cola**: el worker lo toma cuando le toca (el scheduler lo marca). No hay nada que armar por vault:
   el worker ya está armado y toma cualquier vault de la cola que no esté aparcado.

Si ningún vigilante está armado (un ensayo), `arm` necesita `--allow-dry`. `--roles=profit` (o `none`) solo si ese
servicio **no existe**: con `none` el comando no comprueba que cada rol haya leído el vault, y solo vale para una base de
datos que no usa ningún vigilante de siempre (el ensayo en sombra).

### 10.5 Volver atrás: de la cola a los vigilantes de siempre

Con `flota-prod` es una palabra: **`"$F" volver <vault>`** hace los dos pasos de abajo y espera (hasta 15 min) a que
el vault vuelva a ser de los vigilantes de siempre. Se niega antes de tocar nada si alguno de los dos vigilantes no ha
leído la base, encendido y actuando, en los últimos 2 min y medio, o si su `/status` no contesta o no dice que actúa
(`live`, armado, con `SIP_SOLANA_DISPATCH`): devuelto, nadie lo serviría. Un vigilante parado hace 5 min aún tiene un
recibo `vivo`, y nada lo marca al pararse. A mano:

1. **`H rollback $V`** — `queue` → `draining`: ningún worker lo vuelve a coger; el que lo tenga termina su trabajo.
2. **`H release $V`** — se niega mientras un worker lo tenga (como mucho 6 minutos desde que lo cogió) o mientras una
   transacción de un worker para ese vault pueda aún aterrizar (espera a que la altura finalizada pase la última). Repite
   hasta `moved: true` y `system: legacy`: los vigilantes de siempre lo cogen en su siguiente barrida.
   - **Y mientras un worker haya dejado una pérdida arrastrada en un enlace del vault** (`sip_solana.loss_carry` escrita
     dentro de su gate) y el vigilante de beneficio no la vaya a leer: con `SIP_SOLANA_CARRY_STORE=off` no lee esa tabla
     nunca, y con `dual` solo al arrancar, así que cobraría entero el siguiente trade ganador. `release` nombra cada
     proceso `profit` que no lleva `on` y se niega hasta que **todos** lleven `on` y uno haya leído en los últimos 15 min.
     Qué hacer: pon `SIP_SOLANA_CARRY_STORE=on` en `sip-solana-keeper` (es un redeploy: un contenedor nuevo), espera
     su siguiente barrida, marca el contenedor viejo con `H gone <process_id>` cuando ya no exista en Railway, y repite
     `H release $V`. Un vault de volumen no arrastra pérdidas y no le afecta.

Para apagar el despachador del todo: devuelve así **todos** los vaults (`H status` sin vault no debe listar ninguno), y
solo después quita `SIP_SOLANA_DISPATCH` de los dos vigilantes de siempre. **Deja `SIP_SOLANA_CARRY_STORE=on` en el de
beneficio**: las pérdidas que arrastraron los workers solo están en Postgres, y un vigilante que vuelva a `off` las
olvida. Antes de parar el scheduler, la web tiene que volver a leer el `/leaderboard` del vigilante de beneficio
(10.8, paso 9).

**Vaults nuevos.** `H new-vaults queue` (paso P3d) hace que un vault descubierto a partir de entonces sea de la cola: los
vigilantes de siempre lo dejan en paz desde su siguiente lectura y el scheduler lo dará de alta en `draining`
(`ENSURE_VAULTS_SQL`, `src/scheduler-pg.ts`), de modo que también llega a la cola por `arm`: el de `H arm --all`, o el
del propio scheduler con `SIP_SOLANA_AUTO_ARM=on` en `sip-solana-scheduler` (`src/auto-arm.ts`), que arma solo las filas
que él dio de alta y nadie ha tocado (un vault que drenaste, devolviste o soltaste a mano lo terminas tú), con los mismos
recibos y 150 bloques; lo que hace está en `scheduler.autoArm` de su `/status`, y un vault nuevo sin servir 15 min avisa
(`auto-arm-stalled`, 60 min despierta). `SIP_SOLANA_LEGACY_ROLES` dice qué vigilantes deben tener un recibo «acting»
(sin poner, los dos); con los vigilantes de siempre parados es `none`, y aun así toda fila suya no marcada `gone` tiene
que haber leído el vault, así que márcalas cuando hayas comprobado en Railway que sus contenedores ya no existen
(`H gone --stale`, pasados 15 min sin leer). `H new-vaults legacy` lo deshace para los vaults que aún no tengan fila.
Si queda un vault `legacy` con un enlace vivo, o `fleet.new_vault_system` sigue en `legacy`, mientras los vigilantes de
siempre están retirados (`SIP_SOLANA_LEGACY_ROLES=none`) o uno de los que espera (los dos, sin la variable) lleva 15 min
sin leer actuando, el scheduler avisa al momento y a los 30 min despierta (`legacy-orphaned`; lo que ve está en
`fleet.legacy` de su `/status`, también por rol): sin el de beneficio nadie compra ni liquida los vaults de beneficio, y
sin el de volumen nadie liquida los de volumen. Termina el traspaso con `flota-prod traspasar-todos` y
`flota-prod nuevos-a-la-cola`, o vuelve a arrancar los vigilantes (y quita `none`). Con `flota-prod`, `new-vaults` es
`nuevos-a-la-cola` (se niega si el scheduler no se arma solo) y `nuevos-a-los-de-siempre` (se niega si los dos
vigilantes de siempre no están leyendo).

**Ver y desaparcar.** `H status --all` lista todas las filas de `vault_work`, también las `legacy`, con su último
resultado, `parked_reason` y `webhookOwner`. Un vault que el scheduler aparcó (`vault-parked`: 5 reclamaciones seguidas
sin terminar) no lo toma ningún worker hasta `H unpark <vault>`, y el aviso se repite cada 30 min mientras siga aparcado:
`unpark` borra `parked_reason`, pone `attempts` a 0 y lo deja vencido ya. Solo actúa si está aparcado; úsalo después de arreglar la causa. Con `flota-prod`: `flota` y
`desaparcar <vault>`.

### 10.6 Si salta `credit-burn` con el despachador

Primero lo de 4.1 (el timbre sordo es la causa conocida de las pasadas completas). Además, con la cola:

- **El gobernador de créditos del scheduler** (`src/credit-governor.ts`) suma `rpc_usage` de toda la flota. Si el mes
  proyectado pasa del **90 %** del plan, alarga la rotación de seguridad 30 → 60 → 120 minutos (un paso por hora como
  mucho) y deja un aviso en el registro; por encima del **100 %** te manda una crítica (`credit-governor`). Vuelve atrás por debajo del 85 %.
  **Nunca frena un envío, un timbre ni un vault con trabajo**: solo mira menos a menudo a los que están quietos.
- **El presupuesto de peticiones**: la flota usa el 80 % de las peticiones por segundo del plan (40 de las 50 de
  Developer); el scheduler se queda 8 y el resto se reparte entre los workers vivos.
- **Lo que tú puedes mover**: los recortes (en los workers `rest-skip` e `invest-batch`; en el scheduler `lamports-filter`),
  **de uno en uno**;
  el precio real de la llamada de archivo cuando lo diga la Admin API (decisión O8); y el tope del autoescalado de Helius.
  En el scheduler son `SIP_SOLANA_PLAN_RPS`, `SIP_SOLANA_PLAN_CREDITS_MONTH` y `SIP_SOLANA_ARCHIVAL_CREDITS` (10.1).

### 10.7 Los modos por operación (redondeo y fijo) — **NO SE PUEDEN USAR HASTA ACTUALIZAR EL PROGRAMA**

Solo el programa nuevo (`set_policy_v3`, `settle_v3`) tiene vaults en modo 2 (redondeo) o 3 (fijo). Mientras no se
actualice, ninguno existe, y los vigilantes de siempre los dejarían en reposo (`UNSUPPORTED_MODE`) sin gastar una llamada.

- **Primero la cinta de precios**, en el scheduler: `SIP_SOLANA_PRICE_TAPE=on`. Lee la cuenta SOL/USD de Pyth en la misma
  petición del tick (cero llamadas de más) y guarda una fila por publicación (35 días). El `/status` del scheduler lo
  enseña en `priceTape`. Necesita la tabla `sol_price_tape`: aplica `sql/sip_solana.sql` con `setup-read-model` antes.
- **Luego, el worker**: `SIP_SOLANA_EXTRA_MODES=roundup,fixed` y `SIP_SOLANA_EXTRA_MODES_VAULTS=<el vault de prueba>`,
  con `SIP_SOLANA_EXTRA_MODES_LIVE=0`: el worker mide y anota cada operación (en la línea "job done", `perTrade`) y no
  envía nada (M4). Para cobrar de verdad (M5): `SIP_SOLANA_EXTRA_MODES_FROM_SLOT=<el slot de ahora>` y `LIVE=1`.
- **Antes de actualizar el programa**, deja ya el worker con esos modos en seco (`SIP_SOLANA_EXTRA_MODES_LIVE=0`) y el
  vault de prueba, como arriba. Desde que la actualización se despliega, cualquier dueño de un vault puede firmar el
  paso a esos modos (`set_policy_v3` solo pide su firma), y un vault que no esté en `SIP_SOLANA_EXTRA_MODES_VAULTS` se
  queda en reposo: no se le cobra nada, en `flota` su cobro dice «un modo que aún no se cobra» y a Telegram no llega
  nada.
- **El vault tiene que estar en la cola** (`vault_work.system = queue`, 10.4): la lista de vaults solo dice qué modos
  puede cobrar el worker que ya lo tiene.
- **Si Pyth se queda parado**: una operación de redondeo sin muestra de la cinta a ±120 s se valora con la lectura de
  Pyth del trabajo solo si esa lectura cumple las reglas de la cinta (60 s, 50 bps). Si no, el enlace queda en `RETRY`
  ("no fresh price for N trade(s)") hasta que Pyth vuelva; nada se cobra a un precio viejo. Las operaciones que la cinta
  sí tiene se cobran igual.
- **Volver atrás**: poner `SIP_SOLANA_EXTRA_MODES_LIVE=0` (el worker deja de cobrar esos modos y los sigue midiendo en
  seco), o quitar **todas** las que tenga de las cuatro (`SIP_SOLANA_EXTRA_MODES`, `SIP_SOLANA_EXTRA_MODES_VAULTS`,
  `SIP_SOLANA_EXTRA_MODES_LIVE` y `SIP_SOLANA_EXTRA_MODES_FROM_SLOT`) antes de pulsar Deploy, en un solo despliegue: el
  vault queda en reposo. En los dos casos nada se pierde. **Quitar solo `SIP_SOLANA_EXTRA_MODES` no vale**:
  `SIP_SOLANA_EXTRA_MODES_VAULTS` se queda sola y el worker no arranca (`configuration refused`). Con la puerta de
  `/health` (10.1) ese despliegue acaba en *Failed* y sigue el worker anterior, con los modos todavía puestos; sin ella,
  la cola se queda sin worker.

### 10.8 Todo al sistema nuevo

El orden para llevarlo todo al despachador: la web, los vaults que quedan, los vaults nuevos, una prueba, un día de
rodaje, y al final parar (no borrar) los dos vigilantes de siempre. **Un paso cada vez, en este orden**; cada uno dice cómo comprobarlo y cómo
deshacerlo, y el paso 9 dice cómo volver desde cualquier punto. `"$F"` es `flota-prod`, desde
`~/ProyectosCT/SIP-dispatch` (10.4). **Ningún push mientras un vault esté «pasando»** (10.4).

1. **Después del push: mira la flota y marca los contenedores que ya no existen.** Un push que toca
   `packages/solana-keeper` redespliega los servicios del vigilante (sus *Watch Paths*, sección 1), y cada contenedor
   nuevo de un vigilante de siempre escribe su propio recibo. El del contenedor viejo deja de leer, y un traspaso
   esperaría por él.
   - `"$F" flota`. En «Keepers de siempre» cada recibo dice `vivo` o `viejo` y su id; en «Sus páginas», los dos
     vigilantes contestan y están «actuando».
   - Pasados 15 min desde el despliegue, mira en Railway (cada vigilante → *Deployments*) que solo quede activo el
     nuevo, y `"$F" marcar-idos-viejos`: te enseña los recibos que llevan más de 15 min sin leer, te pregunta si lo has
     comprobado y marca esos (no uno que haya dejado de leer mientras contestabas, ni uno que haya vuelto a leer). Uno solo: `"$F" marcar-ido <id>` (no marca uno que haya leído hace menos de 2 min y medio).
   - **Comprobar**: `flota` ya no enseña ningún recibo `viejo`, y su lista «Siguiente:» no pide `marcar-idos-viejos`.
   - **Deshacer**: no hace falta: un recibo marcado como ido que vuelve a leer se desmarca solo.

2. **La web lee el `/leaderboard` del scheduler.** En Vercel, `SIP_SOLANA_KEEPER_URL` =
   `https://sip-solana-scheduler-production.up.railway.app` (sin barra final), en **Production y Preview**, y
   **Redeploy** ([VERCEL_WEB.md](VERCEL_WEB.md)). El nombre de la variable no cambia.
   - **Comprobar**: `curl -s https://sip-solana-scheduler-production.up.railway.app/leaderboard | head -c 300` da 200
     con `boards` (1.2); en la web, `/leaderboard` enseña la clasificación y `/dashboard` sus cifras, sin
     *«The rankings are unavailable»*.
   - **Deshacer**: el valor de antes, `https://sip-solana-keeper-production.up.railway.app`, y Redeploy. Solo sirve
     mientras `sip-solana-keeper` esté encendido; el de volumen no calcula la clasificación.

3. **`SIP_SOLANA_CARRY_STORE=on` en `sip-solana-keeper`.** Los dos vaults que quedan son de beneficio. Hoy este
   vigilante corre sin la variable (`off`: su `/status` no tiene bloque `carryStore`), así que una pérdida arrastrada
   vive solo en su memoria, y `arm` se niega a pasar un vault mientras tenga una así (10.4). En la cola, los workers
   guardan cada pérdida en `sip_solana.loss_carry`, y solo `on` la lee en cada turno: sin `on`, `volver` no devuelve un
   vault de beneficio en el que un worker guardó una pérdida (10.5). Por eso se va directo a `on`, sin los 14 días de
   `dual` de la sección 9: tras el paso 4 los vaults de beneficio los cobran los workers, y `on` es lo que pide la vuelta
   atrás. La tabla ya está en la base de producción.
   - **Antes**: en su `/status`, `pendingCarries` es lo que un redespliegue olvida (sección 9), como cualquier
     despliegue; el 27-oct a las 08:17Z estaba vacío.
   - Railway → `sip-solana-keeper` → Variables → `SIP_SOLANA_CARRY_STORE` = `on`. Es un redespliegue, y suma una conexión
     a Supabase (10.2).
   - **Comprobar**: su `/status` → `carryStore.mode` = `on`, `carryStore.notReady` = `null`, y sigue `mode` = `live`
     con `missingLiveCondition` = `null`. En `flota`, su recibo nuevo dice «pérdidas en la base: on». Marca el del
     contenedor que sustituyó cuando Railway ya no lo enseñe: `"$F" marcar-ido <id>` (o, pasados 15 min,
     `marcar-idos-viejos`). `flota` lo nombra así («Siguiente:» y la línea de ese recibo), y hasta que lo marques
     `traspasar` se niega por él: no vuelvas a poner la variable, que ya está.
   - **Deshacer**: antes del paso 4, quitar la variable (otro redespliegue). Después, no: **nunca vuelvas a `off`** con
     vaults de beneficio en la cola o recién devueltos (10.5).

4. **Los vaults que quedan, a la cola: `"$F" traspasar-todos`.** El 27-oct eran dos, de beneficio: `D5J5o2gS…` y
   `4J3En7ug…`. Antes de tocar cada vault, la herramienta comprueba que los dos vigilantes han leído hace menos de 2 min
   y medio, encendidos y actuando, que ningún recibo sin marcar ha dejado de leer sin soltar ese vault, que ninguno guarda
   solo en su memoria una pérdida de ese vault, que el de beneficio lleva `on` (paso 3) y que ningún otro vault está
   «pasando»; si no, se niega y dice qué hacer. Luego los pasa uno detrás de otro, cada uno entero antes del siguiente (2–4 min cada uno: los recibos de
   los dos vigilantes y 150 bloques), y para en el primero que no pueda. Mientras un vault está «pasando», nadie lo
   cobra ni compra; los que aún no ha tocado siguen servidos por los vigilantes de siempre.
   - **Comprobar**: termina con «LISTO: todos los vaults están en el sistema nuevo.»; en `flota` todos dicen «sistema
     nuevo» y, al rato, su último trabajo; en el `/status` del scheduler, `fleet.queue.bySystem` ya no tiene `legacy`.
   - **Si para a medias**: el vault que se quedó «pasando» no lo sirve nadie. Termínalo con `"$F" traspasar <vault>` o
     devuélvelo con `"$F" volver <vault>`; `traspasar-todos` lo nombra en vez de saltárselo. Si lo cortas con Ctrl-C
     (también mientras drena), antes de salir te dice que mires `flota`: no sabe si el último paso llegó a la base, y
     `flota` sí. Si mientras espera te pide `marcar-ido`, hazlo en otra ventana: esa sigue esperando.
   - **Deshacer**: `"$F" volver <vault>`, de uno en uno (10.5).

5. **Los vaults nuevos, también a la cola.**
   1. Railway → `sip-solana-scheduler` → Variables → `SIP_SOLANA_AUTO_ARM` = `on` (exactamente `on`: otro valor no
      arranca). Es un redespliegue de las dos réplicas. Sola no mueve nada: el scheduler solo arma los vaults que él
      mismo apuntó como «pasando», y mientras los vaults nuevos vayan a los vigilantes de siempre los apunta para ellos.
   2. Abre `https://sip-solana-scheduler-production.up.railway.app/status` varias veces, hasta haber visto las dos
      réplicas (`scheduler.role` = `acting` y `standby`): las dos con `scheduler.autoArm.enabled` = `true`.
   3. `"$F" nuevos-a-la-cola`. Lee esa página tres veces y se niega si alguna respuesta no dice que se arma solo, si la
      réplica con el candado no ha dado una vuelta en 3 min, si un vigilante de los que el scheduler espera
      (`scheduler.autoArm.legacyRoles`: hoy los dos) no ha leído en 15 min, o si queda algún recibo `viejo` (entonces
      `marcar-idos-viejos` primero).
   - **Comprobar**: `flota` dice «Vaults nuevos: van al sistema nuevo (entran «pasando» y el scheduler los pasa solo).»
   - **Deshacer**: `"$F" nuevos-a-los-de-siempre` (se niega si los dos vigilantes de siempre no han leído en los
     últimos 2 min y medio o su `/status` no dice que actúan) y, si
     quieres, quita después `SIP_SOLANA_AUTO_ARM`. En ese orden: con los nuevos yendo a la cola y el auto-arm apagado, un
     vault nuevo se queda «pasando» sin que nadie lo sirva. Si `nuevos-a-los-de-siempre` nombra un vault que sigue
     «pasando», termínalo con `traspasar` o `volver`; con el auto-arm ya quitado, `traspasar-todos` y `flota` también lo
     nombran (sin auto-arm nadie lo pasa solo).

6. **Pruébalo con un vault nuevo de verdad, desde OTRA cuenta.** Cada wallet de login tiene exactamente un vault (su
   dirección sale de `["vault", dueño]`), así que con la tuya no se puede crear otro. Entra en la web con otra wallet de
   login, crea el vault y enlaza una cartera de trading, como un usuario nuevo: el scheduler apunta un vault cuando
   descubre su enlace.
   - **Comprobar**: en `flota`, el vault nuevo sale primero «pasando», con «el scheduler lo pasa solo», y después
     «sistema nuevo» con su primer trabajo. En el `/status` de la réplica `acting`, `scheduler.autoArm.lastResults` lo
     lista con `moved: true`. Lo normal son unos minutos: una barrida de cada vigilante de siempre (≈ 1 min), 150
     bloques (≈ 1 min) y uno o dos ticks. A los 15 min sin pasar avisa `auto-arm-stalled`, y a los 60 despierta; el
     `vault-unserved:<vault>` de ese vault se queda en aviso, para que un solo atasco no despierte una vez por vault (10.9).
   - **Deshacer**: no hace falta: es un vault como cualquier otro, ya en la cola. Si no pasa: 10.9, y
     `nuevos-a-los-de-siempre` hasta entender por qué.

7. **Rodaje: al menos 24 h con los vigilantes de siempre encendidos.** Ya no sirven ningún vault, pero sus recibos son
   los que dejan armar los vaults nuevos (el scheduler los espera mientras `SIP_SOLANA_LEGACY_ROLES` no sea `none`), y
   son la vuelta atrás. Mira `flota` por la mañana y por la noche: todos los vaults en «sistema nuevo» y sin «OJO»,
   «Trabajadores: 1 vivo», y ninguna crítica «[scheduler]» o «[worker]» en Telegram sin explicar. Mientras tanto,
   «Siguiente:» dice que el scheduler aún espera sus recibos: es lo que arregla el paso 8.
   - **Deshacer**: paso 9.

8. **Parar los vigilantes de siempre, sin borrarlos.**
   1. Railway → `sip-solana-scheduler` → Variables → `SIP_SOLANA_LEGACY_ROLES` = `none` (un redespliegue). Primero
      esto, con los vigilantes aún encendidos, como pide `flota`: no les cambia nada, porque cada recibo suyo sin
      marcar como ido sigue teniendo que leer un vault nuevo antes de que se arme, y lo leen en su siguiente barrida.
      **Comprobar**: en las dos réplicas, `scheduler.autoArm.legacyRoles` = `[]`; `flota` dice «se arma solo: sí», con
      «espera recibos de: nadie», y en «Siguiente:» que ya puedes parar los vigilantes. **Deshacer**: quitar la variable.
   2. Railway → `sip-solana-volume-keeper`: *Deployments* → el despliegue activo → **Remove**; y *Settings → Source* →
      **Disconnect**, para que un push no lo vuelva a desplegar. **No borres el servicio ni sus variables**: son las que
      necesita para volver (paso 9).
   3. Lo mismo con `sip-solana-keeper`. **Nunca lo borres**: las variables del worker son referencias a las suyas, y
      `flota-prod` pide su `DATABASE_URL`. Deja también sus variables (`SIP_SOLANA_DISPATCH`,
      `SIP_SOLANA_CARRY_STORE=on`).
      **Comprobar** (2 y 3): sus `/status` dejan de contestar; en `flota`, «Sus páginas» dice de cada uno «no contesta
      … — ¿parado en Railway?»; la web sigue enseñando `/leaderboard` (paso 2).
   4. `"$F" marcar-idos-viejos` cuando sus recibos lleven 15 min sin leer (o `"$F" marcar-ido <id>` de cada uno en
      cuanto lleve 2 min y medio). Hasta entonces un vault nuevo espera: su `arm` necesita que cada recibo sin marcar lo
      haya leído. **Comprobar**: `flota` → «ninguno sin marcar como ido».
   5. En el panel de Helius, borra a mano el webhook cuyo id acaba en `7eecdd`: lo creó `sip-solana-keeper` (su
      `/status` lo enseñaba en `doorbell.webhook.idSuffix`), ya nadie lo atiende y cada evento gasta créditos
      (sección 5, «Apagarlo»).
   - **Comprobar todo**: `flota` → «Siguiente: Todo va al sistema nuevo.», sin `legacy-orphaned` ni `auto-arm-stalled`.
   - **Deshacer**: paso 9.

9. **Volver atrás, desde cualquier paso.**
   - **Lo que tiene que estar antes**: `volver` y `nuevos-a-los-de-siempre` se niegan si los dos vigilantes de siempre
     no han leído la base, encendidos y actuando, en los últimos 2 min y medio, o si su `/status` no contesta o no dice
     que actúa (los dos «actuando» en `flota`); y sin `SIP_SOLANA_DISPATCH` no la leen (10.3).
     Y un vault de beneficio solo vuelve con `sip-solana-keeper` en `SIP_SOLANA_CARRY_STORE=on` (10.5): `volver` se
     niega antes de sacarlo de la cola mientras algún recibo de beneficio sin marcar no lleve `on` (el de un contenedor
     que ya no existe: `marcar-ido`). Del paso 3 al 8, los dos están así.
   - **Si hiciste el paso 8.1, primero quita `SIP_SOLANA_LEGACY_ROLES` del scheduler**, con los vigilantes encendidos o
     parados: con `none`, en cuanto los vaults nuevos o uno de los de ahora vuelvan a ellos salta `legacy-orphaned`, y a
     los 30 min despierta aunque los vigilantes estén leyendo.
   - **Si ya los paraste (paso 8)**: vuelve a encenderlos. En cada uno, comprueba en Variables que siguen
     `SIP_SOLANA_DISPATCH=on` y, en el de beneficio, `SIP_SOLANA_CARRY_STORE=on`; vuelve a conectar su fuente (el mismo
     repositorio) y despliega. En `flota`, los dos contestan «actuando» y sus recibos nuevos están `vivo`. Si ya borraste
     el webhook de Helius, el de beneficio lo vuelve a crear él solo si lleva `SIP_SOLANA_DOORBELL_SECRET` (sección 5).
   - **Luego, en este orden**: `"$F" nuevos-a-los-de-siempre`; `"$F" volver <vault>` de cada vault, uno a uno; y, si
     quieres, quita `SIP_SOLANA_AUTO_ARM`.
   - **La web**: `SIP_SOLANA_KEEPER_URL` otra vez a `https://sip-solana-keeper-production.up.railway.app` y Redeploy,
     con `sip-solana-keeper` encendido (paso 2). **Antes de parar el scheduler, la web tiene que apuntar de nuevo al
     vigilante de beneficio**: hasta entonces es el scheduler el que le sirve `/leaderboard` y `/dashboard`.
   - **Apagar el despachador del todo** (10.5): con `flota` sin ningún vault en «sistema nuevo» ni «pasando», los nuevos
     yendo a los vigilantes de siempre y la web en el de beneficio, para primero `sip-solana-worker` y después
     `sip-solana-scheduler` (con el scheduler parado, un worker avisa `scheduler-stale` a los 10 min), cada uno como
     en el paso 8.2, con *Remove* y *Disconnect*: quitarle `SIP_SOLANA_DISPATCH` no para un servicio con
     *Healthcheck Path* (no arranca y sigue el anterior). Al worker con la puerta de `/health` (10.1) también lo para
     `SIP_SOLANA_DISPATCH=off` → Deploy, y así sigue aunque haya pushes. Deja `SIP_SOLANA_DISPATCH` en los vigilantes
     mientras quede alguna fila que no sea `legacy` (10.3), y `SIP_SOLANA_CARRY_STORE=on` siempre (10.5).

### 10.9 Si algo falla con el sistema nuevo

Llegan al mismo Telegram que los vigilantes, con «[scheduler] » o «[worker] » delante. Las críticas salen siempre; los
avisos solo si ese servicio lleva `SIP_SOLANA_ALERT_MIN_SEVERITY=warn` (1.1), y si no, se quedan en su log. Una alerta
repetida se calla 30 min. **Lo primero, casi siempre, es `"$F" flota`**: cada vault con quién lo sirve, su último
trabajo y, si algo va mal, su «detalle»; la salud del scheduler y del worker; y «Siguiente:». El `/status` del scheduler
lo tiene en crudo: `fleet.vaults`, `fleet.unserved`, `fleet.legacy`, `fleet.workers` y `scheduler.autoArm`.

- **`queue-lag`** («[scheduler]», crítica): un vault al que ya le toca trabajar lleva más de dos ticks (2 min con el
  tick por defecto) sin que ningún worker lo tome; sus cobros y compras van con retraso. **Primero**: en `flota`,
  «Trabajadores». Si dice 0 vivos, Railway → `sip-solana-worker`: ¿está corriendo? Mira sus *Deploy Logs* y
  redespliégalo. Se apaga cuando la espera baja de un tick.
- **`scheduler-stale`** («[scheduler]» y también «[worker]», crítica): la réplica con el candado lleva más de 10 min sin
  dar una vuelta. Nadie descubre enlaces ni marca vaults para trabajar: el worker termina lo que tenía y se queda
  quieto. Una réplica colgada sale sola y la otra coge el candado; si el aviso sigue, no lo hizo. Si solo llega la de
  «[worker]», ninguna réplica lo está diciendo: lo normal es que el servicio entero esté caído. **Primero**: Railway →
  `sip-solana-scheduler` → *Deployments* y *Deploy Logs*; si no corre, redespliégalo.
- **`vault-parked:<vault>`** («[scheduler]», crítica, cada 30 min mientras siga aparcado): el scheduler aparcó el vault
  porque su trabajo se cortó 5 veces seguidas sin terminar. Ningún worker lo toma hasta que lo desaparques. **Primero**: `flota` (su línea dice por qué);
  pásame el aviso y el detalle, y cuando la causa esté arreglada, `"$F" desaparcar <vault>`. Si se vuelve a aparcar,
  dímelo.
- **`vault-unserved:<vault>`** («[scheduler]», aviso a los 15 min, crítica a los 60): el vault lleva ese tiempo
  «pasando»; los vigilantes de siempre lo dejan en paz y ningún worker lo toma, así que nadie lo cobra ni compra.
  **Primero**: `flota`. Si es un vault nuevo que el scheduler pasa solo (con `SIP_SOLANA_AUTO_ARM=on`), este se queda en
  aviso y la crítica es `auto-arm-stalled`, aquí debajo. Si no, termínalo con `"$F" traspasar <vault>` o devuélvelo con
  `"$F" volver <vault>` (que se niega si los vigilantes de siempre no están leyendo: devuelto, no lo serviría nadie).
- **`auto-arm-stalled`** («[scheduler]», aviso a los 15 min, crítica a los 60): un vault nuevo que el scheduler apuntó
  sigue sin llegar a la cola, o el paso que los arma lleva ese tiempo fallando. **Primero**: `flota`, y en el `/status`
  de la réplica `acting`, `scheduler.autoArm.lastError` y el primer obstáculo de cada vault en
  `scheduler.autoArm.lastResults`. Lo habitual: un recibo de un vigilante cuyo contenedor ya no existe (`"$F"
  marcar-ido <id>` o `marcar-idos-viejos`), los vigilantes parados sin `SIP_SOLANA_LEGACY_ROLES=none` (paso 8), o la
  cadena sin contestar (lo dice `lastError`).
- **`legacy-orphaned`** («[scheduler]», aviso al momento, crítica a los 30 min): queda algún vault de los vigilantes de
  siempre con un enlace vivo, o los vaults nuevos siguen yendo a ellos, y esos vigilantes están retirados
  (`SIP_SOLANA_LEGACY_ROLES=none`) o uno de ellos lleva 15 min sin leer la base actuando. Los 30 min cuentan desde la
  última lectura de ese vigilante, actuando o no («its last read was N min ago»), o desde que este scheduler lo vio si
  fue antes; mientras un contenedor suyo siga leyendo sin actuar, solo desde que este scheduler lo vio, así que un
  reinicio del scheduler vuelve a empezar en aviso. El aviso dice cuál, y qué deja de hacerse: sin el de beneficio
  (`sip-solana-keeper`) nadie compra para esos usuarios ni liquida sus vaults de beneficio, aunque el de volumen siga
  leyendo; sin el de volumen, nadie liquida sus vaults de volumen. Si los dos están parados, nadie cobra ni compra para
  ellos. Con `none` y los dos todavía leyendo, aún los sirven: el aviso es de lo que pasará cuando paren. Lo que ve está
  en `fleet.legacy`. **Primero**: `flota`. Si los paraste a propósito, termina el traspaso: `"$F" nuevos-a-la-cola` y
  `"$F" traspasar-todos`; `traspasar` necesita a los dos vigilantes encendidos, así que enciéndelos para eso (paso 9) y
  vuelve a pararlos después (paso 8). Si no querías pararlos, o estás volviendo atrás, quita `SIP_SOLANA_LEGACY_ROLES`
  del scheduler y, si alguno está parado o falla, vuelve a arrancar `sip-solana-keeper` o `sip-solana-volume-keeper`
  (sus *Deploy Logs* dicen por qué no lee).
- **`job-failing:<vault>`** («[worker]», aviso el primero, crítica al tercero seguido): los trabajos del worker en ese
  vault revientan antes de terminar o pasan su techo de 6 min; mientras dure, nadie cobra ni compra para ese vault. Se
  apaga con el primer trabajo que termine. **Primero**: la línea del vault en `flota` y los *Deploy Logs* de
  `sip-solana-worker` a esa hora; pásame el vault y la hora.
- **`invest-refused:<vault>`** («[worker]», aviso la primera y la segunda vez, crítica a la tercera compra rechazada
  seguida): la cesta de ese vault no se puede comprar y no se compra nada. Puede ser un mercado sin liquidez, una
  cesta que no cabe en la cuota de Jupiter del worker, o Jupiter rechazando las llamadas. Sin timbre en el scheduler,
  la tercera llega unos 2 min después de la primera; mientras siga, se repite cada 30 min. Se apaga con un turno que
  compre o que falle. Si el detalle empieza por «the venues this basket would trade against could not be measured»
  (Jupiter o el RPC no contestaron o tardaron tanto que la ruta caducó —`route-age`—, o Jupiter contestó 429, 401/403,
  404/410, 408 o 5xx), se queda en aviso: es la causa de todos los vaults a la vez, y despierta una sola vez como
  `invest-refused-upstream`. Si empieza por «the route this basket would trade along was refused» (Jupiter rechaza el
  par de ese vault —un 400 u otro 4xx— o el vigilante rechaza la forma de la ruta que dio), es de ese vault y sí llega
  a crítica. **Primero**: lee el detalle (en el aviso y en `flota`). Si lleva `Jupiter answered HTTP …`, mira la
  entrada de Jupiter; si no, pásamelo con la hora.
- **`invest-refused-upstream`** («[worker]», crítica): las cestas de uno o más vaults llevan tres turnos o más
  rechazadas porque no se pudieron medir sus mercados (Jupiter o el RPC sin contestar o tan lentos que la ruta caducó, o
  Jupiter contestando 429, 401/403, 404/410, 408 o 5xx). Un solo aviso para todos, con cuántos vaults, cuáles (con el
  botón del vault si es uno solo) y el último detalle; se repite cada 30 min y se apaga cuando esos vaults vuelven a
  comprar (o se olvidan tras 2 h sin noticias suyas). **Primero**: el detalle; si lleva `Jupiter answered HTTP …`, la
  entrada de Jupiter.
- **Jupiter, con su código HTTP**: el detalle de una compra que Jupiter rechazó lleva `Jupiter answered HTTP <código>`
  (en el aviso, en `flota` y en `fleet.vaults` del `/status` del scheduler). **429**: demasiadas llamadas; **401**:
  Jupiter no acepta la clave; **400**: rechaza ese par; **5xx**: Jupiter está caído. Con `jupiter-key`, tras un 429 el
  worker no llama a Jupiter durante 1 min, y si se repite, 2, 4… hasta 10; vuelve a 1 min cuando un turno entero,
  empezado después del último 429, termina sin ninguno. **Primero**, con 429 o 401: Railway →
  `sip-solana-worker` → Variables: `SIP_SOLANA_CUTS` incluye `jupiter-key`, `SIP_SOLANA_JUPITER_API_KEY` es la clave y
  `SIP_SOLANA_JUPITER_CALLS_PER_MINUTE=50`; en `sip-solana-scheduler`, también `SIP_SOLANA_JUPITER_CALLS_PER_MINUTE=50`
  (el scheduler reparte el minuto: lo que le da al worker sale en `fleet.workers[].jupQuota`). La clave gratuita da 60
  por minuto; 50 deja margen. Con 5xx, esperar; con 400, pásamelo.
- **`settle-key-mismatch`** («[worker]», crítica; aviso si solo no la puede comprobar): la llave de cobro del worker no
  es la que nombra la cadena, y no se cobra ni se compra nada en ningún vault de la cola hasta arreglarlo.
  **Primero**: Railway → `sip-solana-worker` → Variables → `SIP_SOLANA_SETTLE_KEY` tiene que ser la de
  `sip-solana-keeper` (es una referencia a ella). No lo arregles cambiando el programa.
- **`seat-unbounded:<wallet>`** («[worker]», crítica): esa cartera de trading tiene sentado el firmante del vigilante
  sin la política que lo limita, y el worker no firma nada por ella. **Primero**: que se vuelva a sentar desde la web
  (**Re-seat keeper** en su fila de carteras) y comprobarlo con `privy-policy verify`
  ([PRIVY_SOLANA.md](PRIVY_SOLANA.md), sección 6).
- **`crank-low`** («[scheduler]», aviso por debajo de 0,02 SOL, crítica por debajo de 0,005): la wallet de crank (el
  `keeper` de la configuración del programa, que es tu wallet de cobro: sección 1, fase B) se queda sin SOL, y cuando
  se vacía se paran los wraps, conversiones y compras de los workers. **Primero**: mándale SOL.
- **`credit-burn`**: la manda solo un vigilante de siempre (`bin/keeper.mts`), y solo con `SIP_SOLANA_CREDIT_BUDGET_DAY`
  puesta: aviso al 80 % de su presupuesto diario de Helius, crítica al 100 %. Con los vigilantes parados ya no llega;
  la del despachador es `credit-governor`, del scheduler: aviso si el mes va por encima del 90 % del plan, crítica por
  encima del 100 %. **Primero**, con cualquiera de las dos: 10.6.
- **Cualquier otra** (por ejemplo `lease-expired`, `fence-reject`, `pg-saturated`, `scheduler-tick-failed`,
  `discovery-stale` o `watchdog-exit` del scheduler; del worker, la escalera por wallet y por vault del vigilante de
  siempre, `carry-store` o la authorization key de Privy): `flota`, y pásame el aviso entero con la hora.
- **Un despliegue de `sip-solana-worker` acaba en *Failed*** (pasa con *Healthcheck Path*: 10.1). Ningún aviso de
  Telegram lo dice, y el worker anterior sigue trabajando, con el código y las variables de antes. En los *Deploy Logs*
  del fallido busca:
  - `configuration refused`: la línea nombra cada variable que falta, sobra o no tiene forma, nunca su valor. Sale
    también por `SIP_SOLANA_WORKER_HEALTH` con un valor que no es `on` ni `off`; y, con `SIP_SOLANA_WORKER_HEALTH=on`,
    por un `PORT` que falta o no es un número de 1 a 65535, por `SIP_SOLANA_DISPATCH` sin poner o vacía y por los tres
    ajustes de Jupiter y alertas de 10.1. Si dice `runs the legacy keeper (bin/keeper.mts, the image's CMD)`, lo que
    arrancó es el vigilante de siempre: el servicio ha perdido su comando de arranque. Vuelve a ponerlo en *Settings →
    Deploy → Custom Start Command* (`node_modules/.bin/tsx bin/worker.mts`) y despliega.
  - `the price tape's table is not in this database` (10.7).
  - `could not be asked at boot` o `uncaught exception`: casi siempre, la base no contesta. Vuelve a desplegar cuando
    conteste.
  - `worker: health server failed`: no pudo abrir `PORT`.
  - Repetida, `the claim failed` (en sus *Build Logs*, los intentos siguen en `status 503` hasta el final): escucha,
    pero no puede leer la cola.
  - `"health":"off"` en la línea `worker starting`, o `SIP_SOLANA_DISPATCH is off (unset is off)`: a ese despliegue le
    falta `SIP_SOLANA_WORKER_HEALTH=on`; con *Healthcheck Path* y sin ella no pasa ninguno (10.1). En el segundo caso,
    además, `SIP_SOLANA_DISPATCH` está sin poner, vacía o en `off`: para que sirva, ponla en `on` (con
    `SIP_SOLANA_WORKER_HEALTH=on`); si querías dejarlo parado a propósito, ponla (o déjala) en `off` y basta con añadir
    `SIP_SOLANA_WORKER_HEALTH=on`: contesta `200` «off» (10.1).

  Si en cambio dice `worker ready`, el healthcheck de Railway no llega a `/health`: revisa en *Variables* `PORT` =
  `8080` y el *Healthcheck Path* `/health` (10.1). Sus *Build Logs* lo confirman: los intentos dicen `service
  unavailable` (no llega a su puerto) o `status 404` (llama a otra ruta). Arreglado, vuelve a desplegar.
- **Rotar un secreto** (la llave de cobro, la app secret de Privy, la clave de Jupiter, la URL de Telegram, la de la
  base…). **La authorization key de Privy no se rota así**: hoy es una llave nueva en Privy con un signer id nuevo, que
  cambia también `SIP_SOLANA_PRIVY_SIGNER_ID` en Railway y en Vercel, y cada wallet se vuelve a sentar
  ([PRIVY_SOLANA.md](PRIVY_SOLANA.md), sección 9, «La llave del vigilante»); cambiar solo la variable deja al worker sin
  firmar por ninguna wallet de Privy. Cada servicio coge el valor nuevo **solo cuando se despliega**; el que ya corre
  sigue con el viejo.
  1. Cámbialo donde vive: en *Variables* de `sip-solana-keeper` si el worker lo toma de allí por referencia (10.1), en
     una variable compartida del proyecto, o en el propio servicio. **Si `sip-solana-keeper` está parado** (10.8, paso
     8), **no lo despliegues**: podría volver a arrancar el vigilante de siempre, armado. Railway deja el cambio
     pendiente hasta que pulsas *Deploy*, y pulsado con la tecla **Alt** (⌥ en el Mac) lo aplica sin redesplegar nada
     ([cambios pendientes](https://docs.railway.com/guides/staged-changes)).
  2. Despliega, de uno en uno, cada servicio encendido que lo use: `sip-solana-worker` y, si también es suyo (la base,
     el RPC, el Telegram), `sip-solana-scheduler`. En los *Deploy Logs* del worker tiene que salir `worker starting` (y
     `worker ready`, con la puerta de `/health`) y, si cambiaste algo de Privy, `privy authorization key belongs to the
     signer quorum`.
  3. **La llave de cobro**, en este orden: primero la cadena (`set_attester` y `set_keeper` con la wallet nueva, que
     firma la de administración: pídeme el paso) y enseguida la variable y el despliegue del worker. Mientras no
     coincidan, cada trabajo acaba `RETRY` sin cobrar ni comprar nada y el worker avisa `settle-key-mismatch` (arriba);
     en cuanto coinciden, el siguiente trabajo sigue solo. La wallet nueva paga las comisiones: mándale SOL antes
     (`crank-low`, arriba).

  Luego, lo que diga [SECRETS.md](SECRETS.md) para la vieja: revocarla donde se pueda. Hasta entonces una app secret o
  una clave de Jupiter viejas siguen valiendo, y las líneas del paso 2 salen igual con cualquiera de las dos: revocada
  la vieja, vuelve a desplegar cada servicio del paso 2 y míralas otra vez. Un servicio que se quedó con la vieja lo
  dice ahí (Privy: la línea `privy authorization key` con `credentials-refused`) o en su siguiente compra (Jupiter:
  `Jupiter answered HTTP 401`, en `flota`). **Deshacer**, mientras no hayas revocado la vieja: vuelve a poner el valor
  viejo donde vive y despliega; la llave de cobro, antes otra vez en la cadena (paso 3: pídeme el paso).

## Si algo falla

- **El vigilante termina de desplegar y se reinicia en bucle**: abre los logs de `sip-solana-keeper` y busca
  `configuration refused`. La línea nombra la variable que falta o sobra, nunca su valor.
- **Un despliegue de `sip-solana-worker` acaba en *Failed***: el worker anterior sigue trabajando; qué buscar en sus
  *Deploy Logs* está en 10.9.
- **El vigilante dice que el atestador no coincide**: `SIP_SOLANA_SETTLE_KEY` no es la wallet de cobro que se configuró
  en el programa. No lo arregles cambiando el programa: revisa qué archivo pegaste.
- **Un secreto se pega en el sitio equivocado** (en la web, en un chat, en un log): se rota, como dice
  [SECRETS.md](SECRETS.md).
- **Un aviso «[scheduler]» o «[worker]»**: es del despachador; está en 10.9.
