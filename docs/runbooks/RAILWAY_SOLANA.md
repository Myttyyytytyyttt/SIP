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
| `SIP_SOLANA_ALERT_WEBHOOK` | opcional: un webhook de Slack o Discord para las alertas | **sí** |

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

### Fase B — el martes, después de publicar y configurar el programa

Añade los secretos. Sigue en seco: sin la fase C no envía nada.

| variable | valor | secreta |
|---|---|---|
| `SIP_SOLANA_SETTLE_KEY` | el contenido entero de `~/sip-keys/settle.json` (la lista de números) | **sí** |
| `SIP_SOLANA_PRIVY_APP_ID` | `cmtrt36tb00080dlbrda5aqam` | no |
| `SIP_SOLANA_PRIVY_APP_SECRET` | el app secret de Privy de SIP | **sí** |
| `SIP_SOLANA_PRIVY_AUTHORIZATION_KEY` | la clave privada `wallet-auth:…` de la llave `sip-solana-keeper` | **sí** |
| `SIP_SOLANA_PRIVY_SIGNER_ID` | `cbx133itb717vxp3dqwhk808` | no |
| `SIP_SOLANA_PRIVY_POLICY_ID` | `jsuzcjv6njl0raqjjhzqe9fh` | no |

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

La primera línea larga tiene que decir esto (el orden puede cambiar):

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
