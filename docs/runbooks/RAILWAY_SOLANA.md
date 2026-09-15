# Railway: el vigilante de Solana

En Railway solo vive el **vigilante** (keeper), que cobra e invierte. **La web se aloja en Vercel**, por decisión del
15 de septiembre, y su guía es [VERCEL_WEB.md](VERCEL_WEB.md). Esta guía
dice qué variable va en el vigilante, cuál es secreta y en qué momento se añade. Los secretos los pegas **tú**,
directamente en Railway. Claude no tiene acceso a Railway.

**Nunca van a Railway:** tu wallet de administración (`~/sip-keys/admin.json`), la llave de administración de la
política de Privy (`~/sip-keys/privy-policy-admin.key`) ni ninguna variable `NUVEM_*`. El vigilante se niega a arrancar si
ve una variable de Nuvem. No copies variables de un servicio viejo.

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
en servicios nuevos, así que no lee `packages/solana-keeper/railway.json`. Sin los ajustes de abajo, Railpack compila
el `package.json` de la raíz, que es el de la web. Configúralo a mano:

- **Variables → `RAILWAY_DOCKERFILE_PATH`** = `packages/solana-keeper/Dockerfile`. En **Settings → Build**, el builder
  pasa a *Dockerfile*.
- **Settings → Source → Root Directory**: vacío, porque el Dockerfile necesita la raíz del repositorio como contexto.
- **Settings → Build → Watch Paths**, una por línea: `/packages/solana-keeper/**`, `/packages/solana-log/**`,
  `/packages/solana-program/idl/**`, `/packages/solana-program/scripts/**`, `/packages/solana-program/package.json`,
  `/pnpm-lock.yaml`, `/pnpm-workspace.yaml`, `/package.json`.
- **Settings → Deploy**: *Healthcheck Path* `/health`; reinicio *On Failure*, con 10 intentos.
- **Settings → Scale**: 1 réplica. El candado que deja actuar a una sola copia vive en la base de datos; sin ella,
  dos réplicas actuarían dos veces.
- **Settings → Networking**: genera un dominio (puerto 8080) para ver `/health` y `/status`.

Para saber que el servicio es el vigilante y no la web:

- en *Build Logs* se construye con el Dockerfile y pasa el paso `--preflight`;
- en *Deploy Logs* sale `heartbeat listening`, nunca `Next.js`;
- `/health` responde `{"ok":true}` en JSON.

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

- `/health` responde `{"ok":true}`.
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

## Si algo falla

- **El vigilante termina de desplegar y se reinicia en bucle**: abre los logs de `sip-solana-keeper` y busca
  `configuration refused`. La línea nombra la variable que falta o sobra, nunca su valor.
- **El vigilante dice que el atestador no coincide**: `SIP_SOLANA_SETTLE_KEY` no es la wallet de cobro que se configuró
  en el programa. No lo arregles cambiando el programa: revisa qué archivo pegaste.
- **Un secreto se pega en el sitio equivocado** (en la web, en un chat, en un log): se rota, como dice
  [SECRETS.md](SECRETS.md).
