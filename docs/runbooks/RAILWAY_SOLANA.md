# Railway: el vigilante y la web en Solana

Dos servicios salen del mismo repositorio: el **vigilante** (keeper), que cobra e invierte, y la **web**. Esta guía dice
qué variable va en cada uno, cuál es secreta y en qué momento se añade. Los secretos los pegas **tú**, directamente en
Railway. Claude no tiene acceso a Railway.

**Nunca van a Railway:** tu wallet de administración (`~/sip-keys/admin.json`), la llave de administración de la
política de Privy (`~/sip-keys/privy-policy-admin.key`) ni ninguna variable `NUVEM_*`. Los dos servicios se niegan a
arrancar si ven una variable de Nuvem: no copies variables de un servicio viejo.

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

En Railway: **New → GitHub repo → SIP**. En **Settings**:

- **Root Directory**: vacío.
- **Config as code**: `packages/solana-keeper/railway.json`. Ya fija el Dockerfile, una sola réplica y el chequeo
  `/health`.

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

## 2. La web (`sip-web`)

En Railway: **New → GitHub repo → SIP**. En **Settings**:

- **Root Directory**: vacío.
- **Config as code**: `railway.json` (el de la raíz). Fija el Dockerfile de la web, una réplica y el chequeo
  `/api/health`.

| variable | valor | secreta |
|---|---|---|
| `SIP_SOLANA_RPC_URLS` | la URL de Helius (mejor otra clave distinta de la del vigilante, si la creas) | **sí** |
| `SIP_SOLANA_PROGRAM_ID` | `6kA9H9zQT6PW5xWkXoAFCS3NotxarzaYqj66mjMf9w4J` | no |
| `SIP_TRUSTED_CLIENT_IP_HEADER` | `x-envoy-external-address` | no |
| `PRIVY_APP_ID` | `cmtrt36tb00080dlbrda5aqam` | no |
| `SIP_SOLANA_PRIVY_SIGNER_ID` | `cbx133itb717vxp3dqwhk808` | no |
| `SIP_SOLANA_PRIVY_POLICY_ID` | `jsuzcjv6njl0raqjjhzqe9fh` | no |

Si el servicio ya tiene `SIP_CHAIN=solana` (lo pedía una versión anterior de esta guía), la web la acepta y puedes borrarla.

**Nunca en la web:** `SIP_SOLANA_SETTLE_KEY`, `SIP_SOLANA_PRIVY_APP_SECRET`, `SIP_SOLANA_PRIVY_AUTHORIZATION_KEY`,
`PRIVY_APP_SECRET` ni `PRIVY_AUTHORIZATION_PRIVATE_KEY`. La web no firma nada y las rechaza por el nombre, aunque estén
vacías. Con cualquiera de ellas, o con `SIP_CHAIN` en un valor que no sea `solana`, Connect y `/wallets` enseñan la lista
de configuración, y `/api/solana-rpc` y `/api/solana-tx` responden 503. `/api/health` sigue respondiendo 200.

`SIP_TRUSTED_CLIENT_IP_HEADER` es la cabecera con la que la web limita peticiones por visitante. En Railway debería ser
`x-envoy-external-address`; tras el primer despliegue lo comprobamos juntos.

Después del despliegue:

1. Railway te da un dominio (`https://….up.railway.app`, o el tuyo propio). Añádelo en Privy a los **dominios
   permitidos**, junto a los de `localhost`.
2. Abre `/api/health`: tiene que responder 200.
3. Abre la web: el botón **Connect** tiene que abrir el modal de Privy.

Las correcciones del programa y la vinculación de wallets (el consentimiento firmado por la wallet de trading, en el
programa y en el núcleo) ya están en `main`, y la web se puede desplegar: el login funciona. Las pantallas para crear la
bóveda y vincular wallets desde la web llegan después, y Railway redespliega solo cuando lleguen a `main`.

## Si algo falla

- **El despliegue termina y el servicio se reinicia en bucle**: abre los logs y busca `configuration refused`. La línea
  nombra la variable que falta o sobra, nunca su valor.
- **La web abre, pero Connect enseña una lista de variables**: cada línea nombra una variable que falta o sobra en
  `sip-web`, nunca su valor. Corrígelas en Railway y vuelve a desplegar.
- **El vigilante dice que el atestador no coincide**: `SIP_SOLANA_SETTLE_KEY` no es la wallet de cobro que se configuró
  en el programa. No lo arregles cambiando el programa: revisa qué archivo pegaste.
- **Un secreto se pega en el sitio equivocado** (en la web, en un chat, en un log): se rota, como dice
  [SECRETS.md](SECRETS.md).
