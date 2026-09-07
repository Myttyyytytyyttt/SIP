# Vercel — la web

La web es lo que ven los testers. Va en Vercel porque es Next.js y porque no tiene nada
que sostener: sus cuatro rutas API responden y terminan. El supervisor va en Railway por
la razón contraria — ver [RAILWAY.md](RAILWAY.md).

## Configuración del proyecto

Es un workspace de pnpm, así que Vercel necesita saber dónde mirar:

| Ajuste | Valor |
|---|---|
| Root Directory | `packages/web` (o `packages/website-oficial` para el producto) |
| Framework Preset | Next.js (se autodetecta) |
| Install Command | *por defecto* — Vercel instala desde la raíz del workspace |
| Build Command | *por defecto* (`pnpm build`) |

### Por qué hay un `vercel.json`

Solo fija una cosa: `"framework": "nextjs"`.

Crear el proyecto por API **se salta la detección de framework**, así que quedó
como `null`. Vercel entonces construyó una app de Next.js como si fuera un sitio
estático y falló buscando una carpeta `public/` que un build de Next nunca produce
(`STATIC_BUILD_NO_OUT_DIR`), sobre un árbol que compila perfectamente en local.

Va en el fichero y no en el dashboard para que quede versionado: un proyecto
recreado desde cero, o un segundo para staging, construye igual sin que nadie
tenga que acordarse de marcar una casilla.

Ojo: `vercel.json` **valida el esquema de forma estricta** y rechaza claves que no
conozca — incluidas las del truco de `"// comentario"`. Por eso la explicación
está aquí y no dentro del JSON.

---

`next.config.mjs` lleva `output: "standalone"`, que es para la imagen de Docker. Vercel
lo ignora sin quejarse, así que no hay que tocarlo — sirve a los dos destinos.

## Variables

| Variable | Valor | Secreta |
|---|---|---|
| `NUVEM_RPC_URL` | endpoint privilegiado, solo servidor | **sí** |
| `NUVEM_PUBLIC_RPC_URL` | `https://rpc.mainnet.chain.robinhood.com` | no |
| `NUVEM_VAULT_FACTORY` | `0x2a6a5d51677aA52674DF1380a5743fBf601ca9b0` | no |
| `NUVEM_CHAIN_ID` | `4663` | no |
| `NUVEM_LOGS_FROM_BLOCK` | `29643300` | no |
| `PRIVY_APP_ID` | de tu dashboard | no |
| `PRIVY_SIGNER_ID` | el id del key quorum | no |
| `PRIVY_POLICY_ID` | el id de la policy | no |

### Solana (la ruta `/solana`)

Sin estas, esa ruta responde **DISABLED diciendo por qué** y el resto de la app no
se entera. No son opcionales a medias: o están las dos primeras, o la ruta está
apagada.

| Variable | Valor | Secreta |
|---|---|---|
| `NUVEM_SOLANA_RPC_URL` | tu endpoint de Helius | **sí** |
| `NUVEM_SOLANA_PROGRAM_ID` | `7rtgXTu852M1NTx7PLoJd3bChaCb2hgsgv5o54aFv6Fy` | no |
| `NUVEM_SOLANA_SIGNER_ID` | el id del key quorum | no |
| `NUVEM_SOLANA_POLICY_ID` | el id de la policy | no |
| `NUVEM_SOLANA_STOCKS` | `SYMBOL:mint:Nombre,…` (vacío = NVDAx) | no |
| `NUVEM_SOLANA_POLICY_DEFAULTS` | `5,500,5000` (vacío = ese mismo) | no |

**`NUVEM_SOLANA_RPC_URL` lleva tu API key y nunca cruza al navegador**: al navegador
se le entrega `/api/solana-rpc`, el relé de esta misma app, igual que `/api/rpc` hace
en la cadena 4663.

Los dos *ids* de Privy no conceden nada por sí solos — nombran quién puede firmar.
`NUVEM_SOLANA_SIGNER_ID` es además lo que la web registra en cada trading wallet al
crearla; sin él la wallet se crea, el keeper la descubre y Privy le niega cada
liquidación en silencio, así que la interfaz lo dice en vez de fingir.

**La web NUNCA necesita `PRIVY_APP_SECRET`, ni la authorization key, ni la
`DATABASE_URL`.** Si te ves poniendo alguna ahí, algo va mal: el navegador solo necesita
ids, que nombran quién puede firmar sin conceder nada. Las credenciales viven en el
supervisor, que es donde se firma.

`NUVEM_PUBLIC_RPC_URL` es el que se le entrega a la wallet del usuario, así que no puede
llevar tu API key. `NUVEM_RPC_URL` sí la lleva y solo se usa en el servidor.

## Después del primer despliegue

**Añade el dominio de Vercel a Allowed origins en Privy.** Sin eso el SDK se niega a
cargar y la app parece rota sin decir por qué. Acuérdate de añadir también los dominios
de preview si vas a usarlos.

## Qué compartir

Manda `/start`, no la raíz. Esa página explica qué está probado y qué no, y pide
cantidades pequeñas. La raíz es la app y asume que ya sabes lo que estás haciendo.

## Verificación

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://<tu-dominio>/api/health   # 200
curl -s -o /dev/null -w "%{http_code}\n" https://<tu-dominio>/start        # 200

# Ningún secreto en el HTML servido
curl -s https://<tu-dominio>/start | grep -cE "privy_app_secret|wallet-auth:|alch_"   # 0
```

Esas tres comprobaciones se hicieron contra la imagen local antes de escribir esto y
dieron 200, 200 y 0.
