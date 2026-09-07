# Railway — los servicios que corren de fondo

Railway lleva lo que **no puede ser serverless**: el supervisor, y opcionalmente la
base de datos. La web va en Vercel — ver [VERCEL.md](VERCEL.md).

## Por qué esta división, y no otra

No es preferencia. **El supervisor mantiene un advisory lock de Postgres sobre una
sesión persistente**, y ese lock es lo que impide que dos instancias liquiden para la
misma cuenta. Una función serverless no puede sostenerlo: la sesión se cierra entre
invocaciones, el lock se suelta, y la garantía desaparece sin que nada lo diga.

A eso se suma que un tick puede tardar minutos cuando el keeper viene atrasado, muy
por encima de lo que aguanta una función.

La web es lo contrario: cuatro rutas API que responden y terminan. Nada que sostener.

---

## 1. La base de datos

Puedes usar el Postgres de Railway o el Supabase que ya tienes. Al keeper le da igual:
solo quiere una `DATABASE_URL`.

**Con Supabase**, tiene que ser la del *session pooler*:

```
postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres
```

**Puerto 5432, nunca 6543.** El 6543 es el pooler en modo transacción, donde los
advisory locks no sobreviven: el lock parecería concedido sin sostener nada y dos
instancias correrían sobre la misma cuenta creyéndose solas. El keeper **se niega a
arrancar** si detecta el 6543, pero mejor no llegar.

Con el Postgres de Railway va por la red privada del proyecto y es más rápido.

La conexión va **cifrada siempre**, con la validación de cadena relajada porque Supabase
termina TLS en un proxy cuya cadena Node no lleva. La única forma de desactivarlo es
escribir `sslmode=disable` a mano en la URL, y existe para poder ejecutar los tests del
diario contra un Postgres local:

```bash
docker run -d --name nuvem-pg -e POSTGRES_PASSWORD=test -e POSTGRES_DB=nuvem -p 55433:5432 postgres:16-alpine
```

```bash
DATABASE_URL='postgresql://postgres:test@127.0.0.1:55433/nuvem?sslmode=disable' pnpm -C packages/keeper-old test
```

Sin eso, el advisory lock —lo único que impide que dos keepers liquiden por el mismo
usuario— solo se podría probar contra producción, que en la práctica significa que deja
de probarse. Ninguna URL de proveedor trae `sslmode=disable`, así que solo aparece donde
alguien la escribió.

---

## 2. El supervisor

Servicio desde `packages/keeper-old/Dockerfile`, con el **contexto en la raíz del repo** —
no en `packages/keeper-old`, porque el install necesita el workspace entero.

Hay un `railway.json` en la raíz que ya fija el builder, la ruta del Dockerfile y la
política de reinicio, así que Railway los coge solos. Deja el *Root Directory* del
servicio **vacío** (la raíz): apuntarlo a `packages/keeper-old` rompería el install.

El `startCommand` del fichero **no lleva `--broadcast`**, y es deliberado: el primer
despliegue tiene que ser en seco. Armarlo es un cambio explícito en el dashboard, no
algo que herede de un fichero que alguien copió.

### Sin cache mounts de BuildKit

Los `Dockerfile` **no llevan** `--mount=type=cache`. Railway exige que el id siga el
formato `s/<service id>-<ruta>` y prohíbe variables de entorno dentro del id, así que
mantenerlo obligaría a empotrar el UUID de un servicio concreto en el fichero.

Eso es una mina: recreas el servicio, o añades uno de staging, y el build falla con
`missing the cacheKey prefix`, que se lee como "Dockerfile roto" en vez de
"identificador viejo". Lo que el mount ahorraba era rellenar el store de pnpm cuando
cambia el lockfile; cuando no cambia, la caché de capas de Docker ya se salta el paso
entero. No compensa un build que solo funciona en un servicio de un proveedor.

### Variables

| Variable | Valor | Secreta |
|---|---|---|
| `NUVEM_KEEPER_ROLE` | `supervisor` | no |
| `NUVEM_RPC_URL` | tu endpoint con `debug_traceTransaction` | **sí** |
| `NUVEM_RPC_FALLBACK_URLS` | `https://rpc.mainnet.chain.robinhood.com` | no |
| `NUVEM_VAULT_FACTORY` | `0x2a6a5d51677aA52674DF1380a5743fBf601ca9b0` | no |
| `NUVEM_LOGS_FROM_BLOCK` | `29643300` | no |
| `NUVEM_CHAIN_ID` | `4663` | no |
| `DATABASE_URL` | ver arriba | **sí** |
| `PRIVY_APP_ID` | de tu dashboard | no |
| `PRIVY_APP_SECRET` | de tu dashboard | **sí** |
| `PRIVY_AUTHORIZATION_KEY` | la clave P-256 | **sí** |
| `PRIVY_SIGNER_ID` | el id del key quorum | no |
| `NUVEM_ATTESTER_PRIVATE_KEY` | la clave del attester | **sí** |
| `NUVEM_ALERT_WEBHOOK` | Slack/Discord (opcional) | **sí** |
| `NUVEM_KEEPER_ALLOW_BROADCAST` | `i-understand-this-moves-real-funds` | no |

**`NUVEM_KEEPER_ROLE` es la que más importa.** Sin ella la imagen arranca el keeper de
UNA cuenta, que liquidaría para un usuario e ignoraría a todos los demás.

`NUVEM_LOGS_FROM_BLOCK` es el bloque donde se desplegó la factory. **No lo pongas a 0**:
escanear desde génesis no es lento, es un timeout que se lee como "este despliegue no
tiene usuarios".

### Armarlo

Sin `--broadcast` calcula todo y **no envía nada**. Ese es el modo del primer
despliegue: lo dejas correr, miras los logs, y solo entonces lo armas.

El `railway.json` **no define `startCommand` a propósito.** Railway documenta que
*"la configuración en código siempre pisa a la del dashboard"*, así que dejarlo ahí
significaría que cambiar el dashboard no haría nada — y armarlo sin efecto es
indistinguible de armarlo bien hasta que llega la primera sesión con ganancia y no
pasa nada. El dashboard es la única fuente para esto.

**Custom Start Command:**

```
/usr/bin/tini -g -- /app/keeper-start.sh --broadcast
```

El comando ENTERO, no solo el argumento. Railway **sustituye** el `ENTRYPOINT` de la
imagen en vez de añadirle el start command detrás, así que poner solo `--broadcast`
hace que intente ejecutarlo como si fuera un programa:
*"The executable `--broadcast` could not be found"*.

`tini` va delante porque es el `ENTRYPOINT` original de la imagen
(`["/usr/bin/tini","-g","--","/app/keeper-start.sh"]`) y es quien reenvía SIGTERM al
proceso: sin él, un redeploy no le da al keeper la oportunidad de terminar su tick en
curso y soltar sus locks limpiamente.

**Custom Build Command: déjalo VACÍO.** Son dos campos contiguos en la misma pantalla,
y poner lo mismo en los dos hace que Railway rechace el despliegue con *"buildCommand
and startCommand cannot be the same"*. El Dockerfile ya construye la imagen.

**Confírmalo en los logs, no en el dashboard.** El supervisor lo dice al arrancar:

```
mode: LIVE — settlements may be broadcast
```

Si sigue diciendo `dry run — nothing will be sent`, no está armado por mucho que el
dashboard diga otra cosa.

El centinela `NUVEM_KEEPER_ALLOW_BROADCAST` se compara byte a byte; un espacio de más
no arma nada. Hacen falta las dos cosas: el argumento y el centinela.

### Sin volumen

No montes ninguno. El diario vive en Postgres y el índice local se reconstruye al
arrancar — para eso se montó, para que un redeploy no pierda un `INTENT` sin resolver.
Un volumen además te ataría a una sola instancia.

### Escalar

Puedes subir réplicas sin configurar nada más. Cada una reclama las cuentas que puede
por advisory lock y se salta las que ya tiene otra. Si una muere, sus locks se sueltan
con el socket y otra las recoge en el barrido siguiente — medido en 0 segundos tras un
SIGKILL.

---

## 3. El supervisor de Solana

Servicio desde `packages/solana-lab-old/program/Dockerfile`, contexto en la raíz del repo.
Es el keeper del lab de Solana: descubre los TradingLink en la cadena, mide la
ganancia sin liquidar, atesta, liquida vía el session signer de Privy y compra lo que
la policy on-chain del owner permita. Sin base de datos: el estado vive en la cadena.

El `railway.json` de la raíz apunta al Dockerfile del keeper EVM, y la sección 2 ya
explica la regla que manda aquí: *la configuración en código siempre pisa a la del
dashboard*. Poner otra ruta en **Settings → Build** no serviría de nada — el fichero
de la raíz la pisaría y desplegarías el keeper EVM creyendo que es este.

La salida es darle a ESTE servicio su propio fichero de configuración: en
**Settings**, baja hasta la sección **Config-as-code** — es SU campo, no ninguno de
los de Build — y pon la ruta absoluta desde la raíz del repo:

```
/packages/solana-lab-old/program/railway.json
```

Al guardar, Railway muestra una vista previa del config parseado; si la ves, está en
el campo correcto.

**No lo pongas en *Root Directory*.** Son campos vecinos y el error ya ocurrió una
vez: Root Directory espera un DIRECTORIO (es la raíz del contexto de build), y darle
la ruta del fichero rompe el build con
`fsutil.NewFS(...railway.json): not a directory` — que se lee como "builder roto" en
vez de "ruta en el campo equivocado". *Root Directory* se queda **vacío**, como
siempre — el contexto sigue siendo la raíz del repo.

Ese `railway.json` (commiteado) fija el builder, la ruta de este Dockerfile, la
política de reinicio y el `healthcheckPath`.

El lab está fuera del workspace pnpm a propósito, con su propio `package-lock.json`,
así que la imagen construye con `npm ci` a secas. El build ejecuta
`supervisor.mts --preflight` — carga el grafo de módulos y el IDL commiteado sin red
ni claves — de modo que una imagen rota falla al construir, no de madrugada.

### Variables

| Variable | Valor | Secreta |
|---|---|---|
| `NUVEM_SOLANA_MAINNET_RPC` | tu endpoint de Helius | **sí** |
| `NUVEM_SOLANA_ATTESTER_KEY` | el array JSON de `scripts/.local/attester.json` | **sí** |
| `NUVEM_SOLANA_CRANK_KEY` | el array JSON del crank (paga las fees de invest) | **sí** |
| `PRIVY_APP_ID` | de tu dashboard | no |
| `PRIVY_APP_SECRET` | de tu dashboard | **sí** |
| `PRIVY_AUTHORIZATION_KEY` | la clave del key quorum (`wallet-auth:…` va bien tal cual) | **sí** |
| `NUVEM_SOLANA_SIGNER_ID` | el id del key quorum | no |
| `NUVEM_SOLANA_POOLS` | `mint=pool` separados por comas (el registro de stocks comprables) | no |
| `NUVEM_SOLANA_SWEEP_MS` | `60000` | no |
| `NUVEM_SOLANA_ALERT_WEBHOOK` | Slack/Discord (opcional) | **sí** |
| `NUVEM_SOLANA_BROADCAST` | `1` — **solo al armar** | no |
| `NUVEM_SOLANA_ALLOW_BROADCAST` | `i-understand-this-moves-real-funds` — **solo al armar** | no |

Las dos claves van como el CONTENIDO del fichero (`[12,34,…]`), no como ruta: en un
contenedor no hay `~/.config/solana` ni `scripts/.local`, y esta imagen lo sabe.

`NUVEM_SOLANA_SIGNER_ID` no firma nada — existe para que un wallet que nunca concedió
el signer se reporte como ese hecho exacto ("wallet has not granted the keeper's
signer") en vez de como un intento de firma fallido cada barrido.

### Armarlo

El primer despliegue va **en seco**: sin `NUVEM_SOLANA_BROADCAST` calcula todo y no
envía nada. Miras los logs, ves `settle settled … DRY RUN — would settle from N
lamports`, y solo entonces lo armas.

A diferencia del keeper EVM, aquí **no se toca el start command**: la imagen lee
`NUVEM_SOLANA_BROADCAST=1` del entorno. Armar es añadir DOS variables — esa y el
centinela — y redesplegar. El centinela se compara byte a byte.

La pareja es asimétrica, y conviene saberlo: `NUVEM_SOLANA_BROADCAST=1` **sin** el
centinela rehúsa arrancar y explica qué le falta; el centinela **sin** la otra no
rehúsa nada — sigue en seco, y lo dice en un log al arrancar
(`…is set but broadcast is OFF — still a dry run`). Busca esa línea si crees que lo
armaste y los logs siguen diciendo `dry run`.

**Confírmalo en los logs, no en el dashboard:**

```
mode: LIVE — settlements and purchases will be broadcast
```

### Alertas

Sin webhook las alertas siguen yendo al log, así que un despliegue sin
configurar está más callado pero no ciego. Las condiciones que despiertan a
alguien son **ausencias**, porque es la forma que han tenido todos los fallos
reales de este sistema: una liquidación que falla, una wallet que lleva rato
sin poder medirse (INCOMPLETE no se resuelve solo: el frontier no avanza), una
wallet linkada que nunca concedió el firmante, el crank quedándose sin SOL, y
el barrido entero fallando.

Cada condición **suena una vez** y se calla hasta que se resuelve — una alerta
que se repite cada 60 segundos es una alerta que se silencia.

### El heartbeat

La imagen sirve `/health` (vivo o no) y `/status` (JSON: modo, barridos, último
barrido, último error) en `$PORT` — Railway inyecta el suyo, y la imagen trae 8080
horneado para que el servidor exista siempre, también en un `docker run` local.

Tres verdades distintas, para no confundirlas:

- **Railway NO ejecuta el `HEALTHCHECK` del Dockerfile.** Ese existe solo para
  docker local (`docker ps` te dirá *unhealthy* si el loop se cuelga).
- Lo que Railway sí usa es el `healthcheckPath: /health` del `railway.json` de este
  paquete — y solo **al desplegar**, como puerta de "arrancó bien".
- La vigilancia CONTINUA no la hace nadie automáticamente: es `/status` — genera un
  dominio en **Settings → Networking** y mira `lastSweepAt`. Si se queda viejo con el
  proceso vivo, está colgado, no parado.

La regla heredada del keeper EVM se mantiene: la sonda no hace llamadas RPC —
reiniciar un keeper jamás ha arreglado un upstream caído, y un keeper parado tiene
que seguir en pie para explicarse.

### Un solo supervisor a la vez

Railway solapa el contenedor viejo y el nuevo en cada despliegue, así que **dos
supervisores corren a la vez de forma rutinaria**. El frontier on-chain ya impide
liquidar dos veces, pero no impedía que ambos envolvieran, convirtieran e
invirtieran el mismo vault — dos compras donde el dueño pidió una, más las fees
del crank quemadas en la transacción que pierde la carrera.

Ahora el que arranca armado **reclama un advisory lock de Postgres** (el mismo
mecanismo que el keeper EVM). El que no lo consigue **baja a dry-run** en vez de
salir: sigue barriendo, sigue respondiendo `/status` y sigue diciendo qué habría
hecho, así que un despliegue que debe tomar el relevo puede hacerlo y una
configuración rara se ve en vez de quedarse muda. Al recibir SIGTERM suelta el
lock, de modo que el relevo tarda segundos y no minutos.

**Sin `DATABASE_URL` no hay lock que tomar**, y el supervisor lo dice al
arrancar. Si corres dos instancias armadas sin base de datos, ambas invertirán:
el aviso está para que eso sea una decisión y no una sorpresa.

### Sin volumen

No montes ninguno. No hay diario local: el estado de liquidación es la cadena misma
(el frontier del link avanza en cada settle), así que un redeploy no pierde nada.

---

## 4. Qué mirar en los logs

**Lo primero que hay que mirar es `held`.** Es el número de cuentas que ESTA instancia
está liquidando. Con `held: 0` no está haciendo nada, por muy sanas que se vean las
demás líneas.

Tres estados que **no significan lo mismo** y por eso van separados:

- `heldByOtherInstances` — normal con varias réplicas. Otra liquida por ese usuario.
- `awaitingSignerGrant` — el usuario vinculó su wallet pero no concedió el signer. Es
  permanente: reintentar no lo arregla, tiene que actuar él.
- `misconfigured` — necesita un humano. Salta alerta crítica.

Y si ves `journal is LOCAL ONLY`, falta la `DATABASE_URL`: funciona, pero el diario se
perderá en el próximo redeploy.

### `held: 0` con `heldByOtherInstances: 1`

Esconde dos situaciones opuestas, así que el log dice **quién** tiene el lock:

```
"heldByOtherInstances": 1,
"heldBy": ["nuvem-keeper dry-run d:a1b2c3d4"]
```

Cada keeper se identifica en `pg_stat_activity` con su modo y su despliegue, y el que no
consigue el lock pregunta quién lo tiene y desde cuándo. Con eso:

- `heldBy: ["nuvem-keeper live ..."]` — otra réplica armada está liquidando. Normal.
- `heldBy: ["nuvem-keeper dry-run ..."]` — **un despliegue viejo sin armar tiene la
  cuenta.** Nadie está liquidando: el que calcula no envía y el que enviaría no tiene
  cuentas. Salta alerta crítica y hay que parar el despliegue antiguo.
- Sin `heldBy` — Postgres no quiso decirlo. El lock sigue respetado; solo falta el nombre.

La causa habitual del segundo caso es que un deploy nuevo se estrelló al arrancar: Railway
**mantiene vivo el anterior** cuando el nuevo falla, y ese anterior puede ser de dry-run.
Mira la pestaña *Deployments* y comprueba que solo hay uno en Active.

Un segundo de solapamiento al redesplegar es normal — el contenedor viejo aún no ha
soltado su lock. Si el `sweep` siguiente (60 s) no pasa a `held: 1`, ya no es eso.

---

## 5. Orden

1. **Base de datos**, para tener la `DATABASE_URL`.
2. **Supervisor en dry-run.** Los logs deben decir `journal is durable` con el nombre
   del esquema, y luego `sweep` con las cuentas encontradas.
3. **Web en Vercel** ([VERCEL.md](VERCEL.md)).
4. **Armar el supervisor** cuando los logs se vean sanos.
