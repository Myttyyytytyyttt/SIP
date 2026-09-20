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

- `/health` responde `{"ok":true}`. Contesta `503` —y entonces Railway reinicia— solo cuando el barrido no AVANZA
  desde hace más de `max(3 × sweepMs, 10 min)`, que con el barrido por defecto de 60 s son 10 minutos; el cuerpo dice
  cuánto lleva quieto. Avanza al empezar un barrido, al empezar el turno de cada wallet y con cada respuesta del RPC,
  así que un barrido LENTO —una wallet con mucho retraso puede tardar más que los diez minutos ella sola— sigue en
  `200`: reiniciarlo solo repetiría el mismo trabajo desde cero y perdería las pérdidas pendientes. Un vigilante recién
  arrancado o uno que no tiene nada que barrer sigue en `200` igual, y un fallo de RPC sale por `/status` y por las
  alertas, nunca reiniciando el contenedor.
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
que es lo que este servicio ya escribía. La web no toca la base de datos: lee esta URL y la cachea.

**El orden importa, y es de un solo sentido:**

1. **Primero la migración**, con la base a mano y **antes** de desplegar el código nuevo:

   ```bash
   bash -c '. ~/sip-keys/sip-hackathon.env; pnpm --dir packages/solana-keeper setup-read-model'
   ```

   Añade `settlement_event.volume_raw` (un `ALTER … ADD COLUMN IF NOT EXISTS`, idempotente: se puede repetir). El
   `DATABASE_URL` nunca se imprime.

2. **Después el despliegue.** Si se hace al revés, el `INSERT` del vigilante nombra una columna que no existe, Postgres
   rechaza la sentencia entera y **se pierde una fila de historial por cada cobro** — sin tumbar nada, porque escribir
   historial nunca puede frenar un cobro. Para que no pase en silencio, el arranque ahora comprueba las columnas y no
   solo las tablas: si falta, el log y `/status` dicen
   `BROKEN — sip_solana.settlement_event is missing volume_raw` y el comando que lo arregla.

3. **Y en Vercel**, `SIP_SOLANA_KEEPER_URL` con la URL pública de este servicio (ver `VERCEL_WEB.md`).

**Comprobarlo:**

```bash
curl -s https://sip-solana-keeper-production.up.railway.app/leaderboard | head -c 300
```

- **200** con `computedAt`, `rules`, `coverage` y `boards`: está calculado.
- **503** con `"detail"`: dice por qué — sin base de datos, sin calcular todavía, o el historial no se pudo leer. La web
  enseña ese mismo motivo. **Nunca sirve un tablero vacío en 200**: «nadie ha ahorrado» y «no se pudo mirar» son dos
  cosas distintas y solo una de ellas es verdad.

Se recalcula cada dos minutos y, además, justo después de cada cobro registrado — así quien acaba de ahorrar y va a
mirar no encuentra una clasificación que no sabe nada de él. Nunca se calcula dentro del barrido: una consulta lenta no
puede retrasar un cobro.

**Si al historial le faltan filas** — un parpadeo de la base, un despliegue adelantado a su migración, o un cobro cuya
firma no volvió — se reconstruye desde la cadena, que es la verdad:

```bash
bash -c '. ~/sip-keys/sip-hackathon.env; pnpm --dir packages/solana-keeper backfill-settlements'            # en seco
bash -c '. ~/sip-keys/sip-hackathon.env; pnpm --dir packages/solana-keeper backfill-settlements --write'    # ya de verdad
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

## Si algo falla

- **El vigilante termina de desplegar y se reinicia en bucle**: abre los logs de `sip-solana-keeper` y busca
  `configuration refused`. La línea nombra la variable que falta o sobra, nunca su valor.
- **El vigilante dice que el atestador no coincide**: `SIP_SOLANA_SETTLE_KEY` no es la wallet de cobro que se configuró
  en el programa. No lo arregles cambiando el programa: revisa qué archivo pegaste.
- **Un secreto se pega en el sitio equivocado** (en la web, en un chat, en un log): se rota, como dice
  [SECRETS.md](SECRETS.md).
