# Vercel: la web de SIP

La web (`packages/website-oficial`) se aloja en **Vercel**, en el equipo `mytytys-projects`. En Railway solo queda el
vigilante: [RAILWAY_SOLANA.md](RAILWAY_SOLANA.md). Esta guía dice cómo crear el proyecto, qué variable va y en qué
entorno, y cómo comprobar que funciona. Los secretos los pegas **tú**, directamente en Vercel. Claude solo lee.

**Nunca en la web:** `SIP_SOLANA_SETTLE_KEY`, `SIP_SOLANA_PRIVY_APP_SECRET`, `SIP_SOLANA_PRIVY_AUTHORIZATION_KEY`,
`PRIVY_APP_SECRET`, `PRIVY_AUTHORIZATION_PRIVATE_KEY` ni ninguna `NUVEM_SOLANA_*`. La web no firma nada y las rechaza
por el nombre, aunque estén vacías: con cualquiera de ellas se queda sin Solana. Los demás nombres viejos de Nuvem
(`NUVEM_RPC_URL`, `NUVEM_CHAIN_ID`…) no se rechazan: si tienen valor, los logs los nombran una vez en una línea
`web.config.retired_names`. Tampoco sirven para nada, así que no pongas ninguna variable `NUVEM_*`.

## 0. Antes de empezar

- Si creaste un servicio `sip-web` en Railway, bórralo junto con sus variables (Settings → Danger). Su relé respondía
  con tu clave de Helius. Si añadiste su dominio `*.up.railway.app` a Privy, quítalo.
- **La clave de Helius de la web**: mejor una propia, distinta de la del vigilante. El relé de la web podría gastar el
  cupo que el vigilante necesita para cobrar. Si usas la misma, vigila los límites de Helius.

## 1. Crear el proyecto

En Vercel: **Add New → Project** e importa `Myttyyytytyyttt/SIP`. Si el repositorio no aparece, da acceso a la app de
Vercel en GitHub.

- **Framework Preset**: Next.js. Ya lo fija `packages/website-oficial/vercel.json`.
- **Root Directory**: `packages/website-oficial`.
- **Build Command, Install Command y Output Directory**: sin tocar. El build de la web ejecuta `check:csp` y `check:idl`
  antes de `next build`, y un comando propio se los salta.
- Añade las variables del paso 2 **antes** de pulsar **Deploy**.

Después, en **Settings**:

- **Build and Deployment**: *Node.js Version* `22.x`; el repo también la fija en `packages/website-oficial/package.json`.
  *Include source files outside of the Root Directory* activado, porque la web usa `packages/solana-core` y el IDL del
  programa.
- **Deployment Protection**: *Standard Protection*. Producción queda pública; las previews, detrás del login de Vercel.
- **Vercel Toolbar**: desactivada. La política de seguridad de la web no admite su script.
- Opcional: **Functions → Function Region** `cdg1` (París), la más cercana a Lisboa.

En Vercel, una variable o un ajuste nuevo solo se aplica a los despliegues siguientes: después de cambiar algo, **Redeploy**.

## 2. Variables

Van a nivel de **proyecto**, nunca de equipo. El equipo aloja también `nuvem-web`, y una variable `NUVEM_SOLANA_*` de
equipo dejaría la web sin Solana.

| variable | valor | secreta | entornos |
|---|---|---|---|
| `SIP_SOLANA_RPC_URLS` | la URL de Helius de la web: `https://mainnet.helius-rpc.com/?api-key=…` | **sí**, tipo *Sensitive* | solo Production |
| `SIP_SOLANA_PROGRAM_ID` | `6kA9H9zQT6PW5xWkXoAFCS3NotxarzaYqj66mjMf9w4J` | no | Production |
| `SIP_TRUSTED_CLIENT_IP_HEADER` | `x-real-ip` | no | Production |
| `PRIVY_APP_ID` | `cmtrt36tb00080dlbrda5aqam` | no | Production |
| `SIP_SOLANA_PRIVY_SIGNER_ID` | `cbx133itb717vxp3dqwhk808` | no | Production |
| `SIP_SOLANA_PRIVY_POLICY_ID` | `jsuzcjv6njl0raqjjhzqe9fh` | no | Production |
| `ENABLE_EXPERIMENTAL_COREPACK` | `1` | no | Production y Preview |

- **`x-real-ip`** es la cabecera que Vercel escribe con la IP real de la conexión, y con ella la web limita peticiones por
  visitante. **En Vercel es el único valor seguro.** Cualquier otra cabecera, como `x-envoy-external-address` (la de
  Railway), la escribe el propio visitante. Quien no la mande comparte un único cupo con todos los demás, y quien la
  mande con una IP inventada estrena cupo en cada petición: los límites por visitante dejan de servir.
  `x-forwarded-for` la rechaza la web y deja las rutas de Solana en 503.
- **`ENABLE_EXPERIMENTAL_COREPACK=1`** hace que Vercel use exactamente el pnpm del repositorio (10.18.1).
- **Preview no lleva la clave de Helius.** Sus URLs cambian en cada despliegue y no están en Privy. Una preview enseña la
  lista de configuración y sus rutas de Solana responden 503, que es lo seguro.
- No pongas `NODE_ENV`, `SIP_CHAIN`, `SIP_SOLANA_PUBLIC_WS_URL` ni ninguna `SIP_SOLANA_*_PER_MIN`.

Para copiar la URL de Helius sin que se vea en pantalla, desde **Terminal.app**:

```bash
bash -c '. ~/sip-keys/sip-hackathon.env; printf %s "$SIP_SOLANA_RPC_URLS"' | pbcopy
```

## 3. Después del primer despliegue

1. En **Settings → Domains**, copia el dominio de producción (`https://….vercel.app`, o el tuyo propio).
2. En **Privy**, añade a los dominios permitidos exactamente ese origen, sin comodines y sin URLs de preview.
3. Pásale a Claude la URL de producción, nunca la clave. Claude comprueba:
   - que `/api/health` responde 200. Solo dice que la web está viva; la configuración se ve en `/wallets`;
   - la política de seguridad y las cabeceras;
   - que `/wallets` no enseña la lista de configuración;
   - que el relé responde y no deja pasar métodos no permitidos;
   - que un visitante no puede hacerse pasar por otra IP.
4. Abre la web en un navegador normal: **Connect** tiene que abrir el modal de Privy.

## 4. Antes de la demo

- Cada push a `main` despliega producción. Desde el ensayo final, no fusiones nada en `main`.
- Si un despliegue sale mal, **Instant Rollback** en el panel vuelve al anterior.

## Si algo falla

- **La web abre, pero Connect enseña una lista de variables**: `/wallets` enseña la misma lista, y cada línea nombra una
  variable que falta o sobra en el proyecto de Vercel, nunca su valor. En **Logs**, desde la primera visita, hay una línea
  `web.config.problems` que nombra esas variables. Corrígelas y haz **Redeploy**. `/api/health` sigue respondiendo 200 aunque
  la configuración esté mal.
- **Connect falla con `invalid_origin`**: el dominio de producción no está en Privy, o no coincide exactamente.
- **Las rutas de Solana responden 429 a todo el mundo, o nadie ve nunca un 429**: comprueba que
  `SIP_TRUSTED_CLIENT_IP_HEADER` sea exactamente `x-real-ip`. Con cualquier otro valor los límites por visitante no
  protegen, aunque todo parezca funcionar.
- **El build falla en `check:csp` o `check:idl`**: no lo saltes con un Build Command propio. Pásale el log a Claude.
- **Un secreto se pega en el sitio equivocado** (en un chat, en un log, en Preview): se rota, como dice
  [SECRETS.md](SECRETS.md).
