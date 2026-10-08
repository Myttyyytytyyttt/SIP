# La política de Privy del vigilante de Solana

El vigilante (el keeper) firma los cobros **como cada wallet de trading**, a través de Privy, con una sola llave: su
llave de autorización. Sin política, quien tenga esa llave puede hacer con la wallet lo que quiera: firmar cualquier
mensaje, mandar cualquier transacción, exportar la clave. Con esta política ya no puede exportar la clave ni firmar
mensajes, y solo puede mandar transacciones hechas **enteras** de dos clases de instrucción: el cobro de `sip-vault`
(`settle_v2`) y la verificación de firmas Ed25519.

Lo que la política aún deja abierto está en [Lo que la política no impide](#lo-que-la-política-no-impide).

> **8-oct-2026: la política cambió.** Hasta ahora dejaba pasar **cualquier** instrucción de `sip-vault`, no solo el
> cobro. La que está viva en Privy sigue siendo esa hasta que hagas la [sección 8](#8-pon-al-día-la-política-viva-solo-settle_v2).
> Hazla antes de invitar a nadie a importar una wallet, y después la [sección 9](#9-antes-de-invitar-a-importar-wallets-rota-la-llave-del-vigilante-y-la-app-secret).

Esta guía la sigues tú. Ninguna de estas llaves hace falta que la vea Claude.

## Qué vas a tener al final

| cosa | qué es | dónde va |
|---|---|---|
| **app id** de Privy (SIP) | público | web y Railway |
| **app secret** de Privy (SIP) | secreto | gestor de contraseñas y Railway |
| **llave de autorización del vigilante** | secreto: firma como las wallets | gestor de contraseñas y Railway |
| **signer id** (el id de esa llave) | público | web y Railway: `SIP_SOLANA_PRIVY_SIGNER_ID` |
| **policy id** | público | web y Railway: `SIP_SOLANA_PRIVY_POLICY_ID` |
| **llave de administración de la política** | secreto: la única que puede cambiar la política | `~/sip-keys/privy-policy-admin.key` y gestor de contraseñas; **nunca** en un servidor |
| **admin key quorum id** | público | apuntado en el gestor, junto a la llave de administración |

## 1. Comprueba la app de Privy de SIP y activa TEE

1. Entra en el dashboard de Privy y **comprueba arriba que la app es la del app id `cmtrt36tb00080dlbrda5aqam`**, la de
   SaverFi. En el dashboard se llama SIP, el nombre en clave, mientras no se renombre. Todo lo que sigue se hace en esa app.
2. Para el vigilante **no hay que buscar ningún interruptor de Solana**. Firma desde el servidor con `@privy-io/node`, y
   eso funciona en cualquier app con TEE (punto 3). La web crea y usa las wallets de Solana desde su propio código
   (`PrivyProvider`). Lo único de Solana que la documentación de Privy pone en el dashboard es entrar con una wallet
   (Sign in with Solana, SIWS), en **Login methods**. **La web de SaverFi entra con Phantom, así que actívalo**: el 14-sep
   estaba apagado. El vigilante no lo necesita.
3. Ve a **Wallets → Advanced**. Tiene que decir **"TEE enabled"**. Si dice "On-device", pulsa **"Request access to
   migrate to TEE"** y sigue las instrucciones. Sin TEE no hay signers ni políticas.
4. En los **dominios permitidos** (Allowed origins) añade `http://localhost:3002` y `http://localhost:3013` para probar
   en local, y el dominio final de la web cuando exista. El 14-sep la lista estaba vacía.

## 2. Crea la llave de autorización del vigilante

> **La llave de hoy es `sip-solana-keeper-2`, id `kyio853439oa78qfvmt853i4`** (desde el 18-sep). La primera,
> `sip-solana-keeper` (`cbx133itb717vxp3dqwhk808`, 14-sep), está **retirada**: su llave privada se perdió y no se vuelve
> a configurar nunca. Esta sección cuenta cómo se crea una; si se pierde, la [sección 7](#si-la-llave-privada-de-ese-quorum-se-ha-perdido)
> dice cómo se cambia.

1. Ve a **Wallets → Authorization keys** y pulsa **New key**. Ponle un nombre que diga lo que es, como `sip-solana-keeper-2`.
2. Privy te enseña la **clave privada una sola vez** (empieza por `wallet-auth:`). Cópiala directamente a tu gestor de
   contraseñas. Más adelante la pegarás en Railway como `SIP_SOLANA_PRIVY_AUTHORIZATION_KEY`.
3. Apunta el **id** de la llave. Es público: va a `SIP_SOLANA_PRIVY_SIGNER_ID`, en la web y en Railway. Ese id sí se lo
   puedes pasar a Claude.

## 3. Lee la política antes de crearla

En **Terminal.app** (no en el panel de terminal de la app de Claude, que Claude puede leer):

```bash
cd ~/ProyectosCT/SIP
pnpm --silent --dir packages/solana-keeper privy-policy --print | jq .policy
```

No lee ninguna variable ni se conecta a nada. Si no tienes `jq`, quita `| jq .policy`: es la misma línea sin formato.
Con `| jq .allows` en vez de `| jq .policy` sale el resumen: una línea por cada regla ALLOW, con lo que deja pasar.

Tiene cuatro reglas:

- **ALLOW `signAndSendTransaction`** para las instrucciones de `sip-vault`
  (`6kA9H9zQT6PW5xWkXoAFCS3NotxarzaYqj66mjMf9w4J`) **que sean `settle_v2`**, el cobro. Privy lo sabe por los primeros 8
  bytes de los datos de la instrucción, que lee con un IDL de Anchor que va dentro de la regla: el de `sip-vault`
  recortado a `settle_v2` (su discriminador `[5, 41, 238, 141, 219, 81, 39, 145]`, sus seis cuentas y sus cinco
  argumentos). La regla nombra además el programa, porque el IDL solo mira esos bytes y no a qué programa van.
- **ALLOW `signAndSendTransaction`** para las instrucciones de `Ed25519SigVerify111…` (la atestación). Va en una regla
  aparte porque Privy exige que a **cada** instrucción la deje pasar una regla entera, y la de Ed25519 no es un
  `settle_v2`.
- **DENY `exportPrivateKey`**: el vigilante no puede sacar la clave de ninguna wallet.
- **DENY `signMessage`**: el vigilante no puede firmar mensajes sueltos.

Una transacción pasa solo si **todas** sus instrucciones caben en una de las dos reglas ALLOW. Cualquier otra cosa se
deniega porque no tiene regla: las demás instrucciones de `sip-vault` (crear un vault, enlazar una wallet, retirar…),
cualquier otro programa, y `ComputeBudget`, que no está a propósito: lo explica
[Lo que la política no impide](#lo-que-la-política-no-impide). El programa retirado (`7rtg…`) tampoco está: el comando
se niega a construir una política que lo nombre.

## 4. Crea la política

> **La de SaverFi ya existe** (`jsuzcjv6njl0raqjjhzqe9fh`, desde septiembre). No la crees otra vez para cambiarle las
> reglas: eso es la [sección 8](#8-pon-al-día-la-política-viva-solo-settle_v2). Esta sección es para empezar de cero.

Sigue en **Terminal.app**. La app secret se carga solo para este comando: `read -rs` no la enseña al pegarla y no queda
en el historial.

```bash
mkdir -p ~/sip-keys && chmod 700 ~/sip-keys
cd ~/ProyectosCT/SIP
printf 'App secret de Privy (SIP): ' && read -rs SECRETO && echo
SIP_SOLANA_PRIVY_APP_ID=<app id de SIP> SIP_SOLANA_PRIVY_APP_SECRET="$SECRETO" \
  pnpm --silent --dir packages/solana-keeper privy-policy create --admin-key-out ~/sip-keys/privy-policy-admin.key
unset SECRETO
```

Hace cuatro cosas, en este orden:

1. genera la **llave de administración** en tu ordenador;
2. la escribe en `~/sip-keys/privy-policy-admin.key`, con permisos `600`. Se niega a sobrescribir un archivo que ya
   existe y se niega a escribir dentro del repositorio;
3. registra en Privy su parte pública como el key quorum `sip-solana-policy-admin`;
4. crea la política con ese key quorum como dueño.

Si todo va bien imprime **una** línea con cinco datos:

| campo | para qué |
|---|---|
| `policyId` | la web: `SIP_SOLANA_PRIVY_POLICY_ID` |
| `adminKeyQuorumId` | ninguna variable: apúntalo en el gestor, junto a la llave de administración |
| `programs` | los dos programas permitidos, para que los compares con el paso 3 |
| `allows` | lo que deja pasar cada regla ALLOW (`settle_v2` de `sip-vault`, cualquier instrucción de Ed25519) |
| `adminKeyFile` | dónde quedó la llave de administración |

Guarda también el contenido de `~/sip-keys/privy-policy-admin.key` en el gestor de contraseñas. Si se pierde, la
política ya no se puede cambiar, y habría que crear otra.

Si en vez de eso sale **`privy policy create incomplete`**, lee sus campos: `exists` dice qué se creó, `doesNotExist`
qué no, `unknown` lo que no se puede saber (no hubo respuesta o Privy dio un error de servidor, así que pudo crearse) y
`next` qué hacer. No repitas el comando con el mismo `--admin-key-out`: usa otro nombre de archivo.

### Qué va a cada sitio

- **Web**: `SIP_SOLANA_PRIVY_SIGNER_ID` (paso 2) y `SIP_SOLANA_PRIVY_POLICY_ID` (`policyId`). Con ellos registra el
  signer en cada wallet y le pone esta política como **override** del signer.
- **Vigilante en Railway**: `SIP_SOLANA_PRIVY_APP_ID`, `SIP_SOLANA_PRIVY_APP_SECRET`,
  `SIP_SOLANA_PRIVY_AUTHORIZATION_KEY` (paso 2), `SIP_SOLANA_PRIVY_SIGNER_ID` y `SIP_SOLANA_PRIVY_POLICY_ID`: con ella se
  niega a firmar por una wallet cuyo asiento no lleve esta política ([RAILWAY_SOLANA.md](RAILWAY_SOLANA.md)).
- **Solo tu ordenador y el gestor**: la llave de administración.

## 5. Comprueba la política guardada

```bash
cd ~/ProyectosCT/SIP
printf 'App secret de Privy (SIP): ' && read -rs SECRETO && echo
SIP_SOLANA_PRIVY_APP_ID=<app id> SIP_SOLANA_PRIVY_APP_SECRET="$SECRETO" SIP_SOLANA_PRIVY_SIGNER_ID=<signer id> \
  pnpm --silent --dir packages/solana-keeper privy-policy check --policy <policyId>
unset SECRETO
```

Lee la política de Privy y la compara con la del paso 3, también el IDL que lleva la regla de `settle_v2`: si ese IDL
llama `settle_v2` a otro discriminador, o nombra más instrucciones, sale en `differences`. Mira `verdict`:

| verdict | qué significa |
|---|---|
| `OK` | idéntica y con dueño (sale con código 0) |
| `DIFFERENT` | la política guardada no es la del paso 3; `differences` dice en qué. No se la des a la web |
| `UNOWNED` | no tiene dueño: la app secret sola podría cambiarla, y Railway tiene esa secret |
| `OWNED_BY_SIGNER` | su dueño es la propia llave del vigilante: podría ampliar su propia regla |

## 6. Verifica que rechaza lo que debe

Hazlo **después** de que la web haya registrado el signer en **una wallet de trading de prueba con unos 0,002 SOL**.
Necesitas el **id de esa wallet en Privy** (no su dirección), que sale en el dashboard, en Wallets.

```bash
cd ~/ProyectosCT/SIP
printf 'App secret de Privy (SIP): ' && read -rs SECRETO && echo
printf 'Llave de autorización del vigilante: ' && read -rs CLAVE && echo
printf 'SIP_SOLANA_RPC_URLS: ' && read -rs RPC && echo
SIP_SOLANA_PRIVY_APP_ID=<app id> SIP_SOLANA_PRIVY_APP_SECRET="$SECRETO" SIP_SOLANA_PRIVY_AUTHORIZATION_KEY="$CLAVE" \
  SIP_SOLANA_PRIVY_SIGNER_ID=<signer id> SIP_SOLANA_RPC_URLS="$RPC" \
  pnpm --silent --dir packages/solana-keeper privy-policy verify --wallet <id de la wallet en Privy> --policy <policyId>
unset SECRETO CLAVE RPC
```

Primero comprueba que el signer del vigilante está en la wallet con **exactamente** esta política como override. Si no,
no prueba nada y lo dice: `SIGNER_NOT_GRANTED` (la web no registró el signer) u `OVERRIDE_POLICY_MISMATCH` (lo registró
con otra política, o sin ella).

Después, firmando como el vigilante, intenta tres cosas que la política tiene que rechazar:

1. firmar el mensaje `sip policy probe`;
2. mandarse 1 lamport a sí misma;
3. una transacción con solo un memo.

Si alguna pasara, no mueve dinero: cuesta una comisión mínima.

Cada intento sale como una línea `privy probe`:

| outcome | qué significa | qué haces |
|---|---|---|
| `REFUSED` | Privy respondió `policy_violation`: la política lo rechazó | nada, es lo correcto |
| `CRITICAL` | **Privy lo firmó**. Imprime la firma o el hash | para todo: quita el signer de las wallets o rota su llave, y avisa |
| `INCONCLUSIVE` | falló la simulación antes de mirar la política, casi siempre por falta de saldo | fondea la wallet con unos 0,002 SOL y repite. **No vale como aprobado** |
| `UNAUTHORIZED` | Privy rechazó las credenciales: la llave no es la del signer, o el app id o la secret están mal | revisa las variables y repite |
| `FAILED` | otro error; `detail` dice cuál | repite; si sigue, pásale a Claude la línea (no lleva secretos) |

La última línea, `privy verify`, da el resultado: `PASS` (código 0) solo si los tres son `REFUSED`.

Una línea `old program` explica por qué el programa retirado no se prueba. Queda fuera porque no está en la lista
(el paso 5 lo comprueba). No se puede probar porque Privy simula antes de mirar la política, así que la prueba tendría
que ser una llamada que funcione de verdad contra un programa cuya llave se filtró. Eso no se hace.

Otra línea, `other sip-vault instructions`, explica por qué tampoco se prueba que rechace las demás instrucciones de
`sip-vault`. Por la misma razón: la prueba tendría que ser una llamada que funcione, y crear un vault a nombre de la
wallet (`create_vault_v2`), que una wallet de trading puede firmar sola, lo dejaría creado si la política fallase. Eso
lo comprueba el paso 5, que compara la regla y su IDL.

Si sale una línea `configuration refused`, falta o sobra algo en las variables (también si hay puesta alguna
`PRIVY_API_*`: mira [Lo que nunca se hace](#lo-que-nunca-se-hace)), o `SIP_SOLANA_RPC_URLS` no es de mainnet. Lo dice
nombrando la variable, nunca su valor. El comando sale con código 2, pero el pnpm de tu Terminal (9.12, con `--silent`)
lo convierte en 1: fíate de la línea, no del código.

## 7. Cuando Privy rechaza la firma: ¿la llave es la del quorum?

Este es el paso que se hace cuando el vigilante mide bien y **Privy no le deja mandar el cobro**. Se reconoce por esta
frase, en `/status` o en el log de Railway:

```
401 {"error":"No valid authorization signatures were provided. Your payload may be malformed or your signing keys
may be incorrect or expired."}
```

Esa frase significa una sola cosa: **la firma que llegó no era de ninguna llave que Privy acepte para esa wallet**. No
dice cuál de todas las maneras de estar mal es.

**Mira primero `/status`.** El vigilante comprueba esto solo, al arrancar y cada media hora, y publica el resultado en
`signing.authorizationKey` — con la fecha en que lo comprobó, en `signing.authorizationKeyAt`. Ese veredicto es **sobre
la llave que hay puesta en Railway**, que es la que falla. Si dice `matches`, la llave desplegada está bien y el problema
es otro (paso 6). Si dice cualquier otra cosa, la tabla de más abajo explica cada valor igual.

El comando de aquí abajo sirve para lo otro: **probar una llave concreta antes de ponerla en Railway**, o ver cuál es su
clave pública para compararla con el dashboard. Juzga exactamente el valor que tú pegas, ni más ni menos.

Lleva escrito el signer id de hoy, `kyio853439oa78qfvmt853i4` (`sip-solana-keeper-2`). Antes de usarlo, mira que sea el
mismo que `signing.privySignerId` en `/status`; si no lo es, pon en el comando el de `/status`.

```bash
cd ~/ProyectosCT/SIP
printf 'App secret de Privy (SIP): ' && read -rs SECRETO && echo
printf 'Llave de autorización del vigilante: ' && read -rs CLAVE && echo
SIP_SOLANA_PRIVY_APP_ID=cmtrt36tb00080dlbrda5aqam SIP_SOLANA_PRIVY_APP_SECRET="$SECRETO" \
  SIP_SOLANA_PRIVY_AUTHORIZATION_KEY="$CLAVE" SIP_SOLANA_PRIVY_SIGNER_ID=kyio853439oa78qfvmt853i4 \
  pnpm --silent --dir packages/solana-keeper privy-policy key
unset SECRETO CLAVE
```

En **Terminal.app**, como todo lo demás de esta guía. La llave que pegues cuando te la pida no se ve al escribirla, no
queda en el historial y **no sale de tu ordenador**: el comando no se la manda a Privy ni a nadie.

**El comando juzga esa llave, la que pegas, y ninguna otra.** No lee Railway, no sabe qué hay desplegado. Así que elige
a conciencia cuál pegas:

- ¿quieres saber si la llave **del gestor de contraseñas** es la buena, antes de ponerla? Pega la del gestor.
- ¿quieres saber por qué el vigilante desplegado devuelve 401? Eso lo contesta `signing.authorizationKey` en `/status`.
  Si prefieres comprobarlo a mano, copia el valor **desde la propia variable de Railway** (Variables → el icono del ojo
  en `SIP_SOLANA_PRIVY_AUTHORIZATION_KEY`) y pega ESE.

Lo que hace son dos cosas. Primero calcula, aquí mismo, la **clave pública** que le corresponde a esa llave privada.
Después le pregunta a Privy qué claves públicas tiene registradas el key quorum del signer id (hoy
`kyio853439oa78qfvmt853i4`) — eso solo
necesita el app id y la app secret — y las compara. La clave pública es pública: se puede leer, copiar y enseñar.

### Qué te contesta

Mira `verdict`:

| verdict | qué significa | qué haces |
|---|---|---|
| `matches` | **la llave que acabas de pegar** está registrada en ese quorum y basta su firma sola (sale con código 0) | nada con esa llave. Antes de buscar en otro sitio, asegúrate de que es la misma que hay en Railway: mira `signing.authorizationKey` en `/status`. Si ahí también dice `matches`, el problema es el asiento o la política: paso 6 |
| `not-in-quorum` | la llave es una llave válida, pero **su clave pública no es ninguna de las de ese quorum**, y el quorum no tiene más miembros que esas claves. Esta es la causa del 401 | sigue [No coincide](#no-coincide-la-llave-no-es-la-de-ese-quorum) aquí abajo |
| `members-unresolved` | la clave no está entre las del quorum, **pero el quorum tiene además otros miembros que el comando no puede leer** (otro key quorum anidado, o un usuario), y una llave que esté ahí firma igual de bien. No prueba nada | **no cambies ni regeneres nada todavía.** Mira ese quorum en el dashboard: el comando te imprime los ids anidados (`nestedKeyQuorumIds`) y cuántos usuarios tiene. Compara `derivedPublicKey` con las claves de esos miembros |
| `threshold-above-one` | la llave **sí** está registrada, pero el quorum exige más de una firma y el vigilante manda una sola. Privy rechaza igual | no toques la llave. En **Wallets → Authorization keys**, deja el `threshold` de ese quorum en 1 (o quítale los miembros que ganó) |
| `key-unreadable` | lo que hay en `SIP_SOLANA_PRIVY_AUTHORIZATION_KEY` no es una llave P-256. No se mandó nada a ningún sitio | vuelve a pegarla entera desde el gestor |
| `credentials-refused` | Privy rechazó el app id o la app secret, así que no pudo ni leer el quorum. **No dice nada de la llave** | comprueba `SIP_SOLANA_PRIVY_APP_ID` y la app secret en el dashboard, en la app del paso 1 |
| `quorum-not-found` | esta app de Privy no tiene ningún key quorum con ese id | comprueba `SIP_SOLANA_PRIVY_SIGNER_ID` en **Wallets → Authorization keys**. Un id de otra app aquí se ve como si no existiera |
| `quorum-unreadable` | no se pudo leer Privy (se cayó la conexión, un error del servidor). **No dice nada de la llave** | repite dentro de un minuto. Si sigue, mira `status.privy.io` antes de tocar nada |

El comando sale con **código 0** si coincide, con **código 2** si hay que cambiar una variable y no se mandó nada a
ninguna parte, y con **código 1** en los demás casos. El pnpm de tu Terminal (9.12, con `--silent`) convierte el 2 en 1,
así que el 2 solo lo verás si corres el comando con otro pnpm o sin `--silent`. Nunca imprime la llave privada.

Tres avisos, para que no te manden a arreglar lo que no está roto:

- **Pegar la llave con comillas, con espacios o con el prefijo `wallet-auth:` no rompe nada.** Privy firma igual en
  todos esos casos, y el comando también los acepta. Si te dice `matches`, la llave que has pegado está bien pegada.
- **Pero tiene que ir en UNA sola línea.** Eso no lo decide el comando, lo decide la Terminal: `read` corta en el primer
  salto de línea y solo le llega el primer trozo, así que el comando diría `key-unreadable` de una llave perfecta. Si el
  gestor de contraseñas te la devuelve partida en varias líneas, júntala antes de pegarla. Y si al pegar se te cuela un
  trozo en el prompt como si lo hubieras tecleado, **no lo ejecutes**: borra la línea con Ctrl-U y borra esa entrada del
  historial (`~/.zsh_history`) antes de seguir.
- **`key-unreadable` no puede ser la causa de un 401.** Una llave ilegible ni siquiera llega a salir del vigilante: falla
  antes, en su propio proceso. Si has visto un 401, la llave se leyó bien y lo que falla es a quién pertenece.

### No coincide: la llave no es la de ese quorum

El comando te imprime dos cosas públicas, juntas:

- `derivedPublicKey`: la clave pública de **la llave que acabas de pegar**.
- `registeredPublicKeys`: las que **tiene registradas el quorum** del signer id (hoy `kyio853439oa78qfvmt853i4`).

Con eso en la mano:

1. Entra en el dashboard de Privy, comprueba arriba que la app es la del app id `cmtrt36tb00080dlbrda5aqam` (paso 1) y
   ve a **Wallets → Authorization keys**.
2. Busca la llave cuyo **id** sea el signer id (hoy `kyio853439oa78qfvmt853i4`) — es la que el vigilante dice ser.
   Debería llamarse `sip-solana-keeper-2`. (`cbx133itb717vxp3dqwhk808`, `sip-solana-keeper`, es la retirada: su llave
   se perdió, y ninguna llave que tengas va a coincidir con ella.)
3. Compara su clave pública con `derivedPublicKey`. Son distintas: por eso Privy rechaza.
4. La llave privada que va en `SIP_SOLANA_PRIVY_AUTHORIZATION_KEY` es **la de esa llave del dashboard**, no la que hay
   puesta ahora. Búscala en el gestor de contraseñas por su nombre. Si quieres, pégala en el comando de arriba antes de
   nada: si dice `matches`, es la buena.
5. Ponla en Railway, en `SIP_SOLANA_PRIVY_AUTHORIZATION_KEY`, y **espera a que el servicio reinicie**. Volver a correr
   el comando aquí no comprueba nada de lo que acabas de guardar: el comando lee tu ordenador, no Railway.
6. **Abre `/status` y mira `signing.authorizationKey`. Tiene que decir `matches`.** Esa es la comprobación que mira la
   llave desplegada, y es la que cierra la incidencia. Al lado, `signing.authorizationKeyAt` dice de cuándo es el
   veredicto: si la fecha es anterior al reinicio, el vigilante aún no ha vuelto a comprobarlo — espera y recarga. En el
   log de Railway aparece además `derivedPublicKey`, que tiene que ser la misma clave pública que te imprimió el comando.

Lo más normal es que en Railway esté pegada otra llave tuya: tienes varias, y una de ellas es la de administración de la
política, que **no** es esta. La de administración está en `~/sip-keys/privy-policy-admin.key` y sirve para otra cosa
(cambiar la política); si la pegas aquí, sale exactamente este `not-in-quorum`.

### Si la llave privada de ese quorum se ha perdido

Privy enseña la clave privada **una sola vez**, cuando se crea. No se puede recuperar ni volver a ver: ni tú, ni Privy,
ni nadie. Si no está en el gestor de contraseñas, no está. Y el quorum viejo no se puede arreglar añadiéndole una llave
nueva: cambiar un quorum exige la firma de ese mismo quorum, que es justo la llave perdida.

Así que **sí: se genera una nueva**. No es una catástrofe, pero cuesta, y conviene saber qué cuesta antes de empezar. El
asiento de cada wallet de trading nombra el signer **por su id**; el id nuevo es otro, así que cada wallet sentada con
el viejo hay que volver a sentarla. Eso lo hace el dueño de la wallet desde la web, con un botón. El orden importa:

1. **Llave nueva en Privy.** Comprueba arriba que la app es la del app id `cmtrt36tb00080dlbrda5aqam` (paso 1) y ve a
   **Wallets → Authorization keys → New key**. Nombre: el siguiente de la serie (`sip-solana-keeper-3`, si la que se
   pierde es `sip-solana-keeper-2`), con una sola llave (1 de 1). Copia la clave privada al gestor **en ese momento**: no
   la vuelves a ver. Apunta su **id**, que es nuevo: va en los pasos 2 y 3, y en los comandos de esta guía en lugar de
   `kyio853439oa78qfvmt853i4`. (Así se hizo el 18-sep: `sip-solana-keeper`, `cbx133itb717vxp3dqwhk808`, se perdió, y
   `sip-solana-keeper-2`, `kyio853439oa78qfvmt853i4`, la sustituyó.)
2. **Railway: las DOS variables, y Redeploy.** En el servicio del vigilante cambia `SIP_SOLANA_PRIVY_AUTHORIZATION_KEY`
   (la privada nueva, en una sola línea) y `SIP_SOLANA_PRIVY_SIGNER_ID` (el id nuevo). Despliega los cambios y espera a
   que el servicio vuelva a arrancar. `SIP_SOLANA_PRIVY_POLICY_ID` **no cambia**.
3. **Vercel: el signer id, y Redeploy.** En la web cambia `SIP_SOLANA_PRIVY_SIGNER_ID` al id nuevo **y haz Redeploy**
   ([VERCEL_WEB.md](VERCEL_WEB.md)). Una variable nueva no se aplica a lo que ya está desplegado: sin el Redeploy, el
   botón del paso 7 volvería a sentar el signer viejo, el que ya no sirve. La política (`SIP_SOLANA_PRIVY_POLICY_ID`) no
   cambia.
4. **Mira `/status` antes de tocar ninguna wallet.** `signing.authorizationKey` tiene que decir `matches`, con
   `signing.authorizationKeyAt` posterior al arranque, y `signing.privySignerId` tiene que ser el id nuevo. En este
   momento `signing.wallets` dirá `signable: 0`: es lo normal, porque todas las wallets siguen con el signer viejo, y
   cada una sale en `wallets` como `none (signer not granted)`. Si `authorizationKey` no dice `matches`, para aquí: la
   tabla de más arriba dice qué es cada valor. Pulsar botones no arregla una llave que no es la del quorum.

   **Qué signer lleva cada wallet lo dice el log de Railway, no la web.** Busca la línea con `"wallet"` = la dirección
   de esa wallet y un campo `granted`. Su `event` empieza por *"wallet has not granted the keeper's signer"* (el
   vigilante de antes) o por *"wallet does not seat the keeper's current signer"* (el de ahora). `granted` son los ids de
   signer que la wallet lleva **de verdad**, y es lo único que lo dice: la web solo sabe que hay *un* signer, no cuál. En
   una wallet sentada antes de la rotación sale el id viejo (el 18-sep, `cbx133itb717vxp3dqwhk808`); si ya sale el
   nuevo, esa wallet no necesita el botón. El vigilante escribe esa línea una vez después de cada arranque, y otra cada
   vez que cambia; no la repite en cada barrido.
5. **La web tiene que tener el botón.** **Re-seat keeper** solo existe en una web que lo incluya (la rama
   `web-reseat-keeper`); el Redeploy del paso 3 vuelve a desplegar lo que ya hubiera en `main`, que puede no tenerlo.
   Cuando esa rama esté en `main` y Vercel la haya desplegado, comprueba en `/wallets` dos cosas: cada wallet de trading
   con la etiqueta **Has a signer** tiene el botón **Re-seat keeper**, y el pie de la tarjeta *Trading wallets* dice
   *"New wallets seat the keeper's signer `kyio853…` with policy `jsuzcjv6…`"* (el id nuevo). Si no sale el botón, no
   está desplegada; si el pie enseña el id viejo, falta el Redeploy del paso 3.
6. **Ensaya en una wallet sin fondos antes que en la tuya.** Nadie ha visto todavía qué hace el registro de Privy con
   una wallet de este tipo cuando se queda sin ningún signer: si sigue enseñando su id de wallet (lo que da por hecho el
   SDK de Privy) o lo borra (lo que dicen sus tipos: *"Null if the wallet is not delegated"*). La web está hecha para
   no perder la wallet en ninguno de los dos casos, pero esto se comprueba con una wallet vacía, no con la que tiene el
   dinero.
   - En `/wallets` pulsa **Create wallet and link it** (sin bóveda, el botón dice **Create wallet**). Cuando Phantom
     pida aprobar el enlace, **recházalo**: la wallet queda creada y sin enlazar, y no se paga el alquiler del enlace.
     Nace ya con el signer nuevo y la política `jsuzcjv6…`, y eso ya prueba que Privy acepta ese par.
   - Apunta el **Privy wallet id** que sale en su fila.
   - Pulsa **Re-seat keeper** en **esa** wallet nueva y luego **Remove every signer and re-seat**. Puede tardar algo
     más de un minuto. Mientras tanto no cierres ni recargues: la ventana de *Manage wallets* no se deja cerrar, y el
     navegador pregunta antes de recargar.
   - Tienen que cumplirse las cuatro cosas:
     1. sale un texto que empieza por **Done:**;
     2. la etiqueta es **Has a signer**;
     3. la fila **sigue enseñando la línea *Privy wallet id***, con el mismo id que apuntaste. Esto es lo que zanja la
        pregunta;
     4. `privy-policy verify --wallet <ese id> --policy jsuzcjv6njl0raqjjhzqe9fh` (sección 6) saca la línea
        `signer granted with the override policy`. Con la wallet sin saldo, los tres intentos saldrán `INCONCLUSIVE`:
        aquí da igual, lo que se ensaya es el asiento.
   - Si quieres verlo por dentro: en las herramientas de desarrollador del navegador (pestaña *Network*), las
     respuestas de `GET /api/v1/users/me` entre el quitar y el poner enseñan esa wallet con el mismo `id` y
     `recovery_method: "privy-v2"` mientras `delegated` es `false`.
   - **Si el ensayo acaba en cualquier cosa que no sea Done:**, y sobre todo si el mensaje empieza por *"While this
     wallet had no signer, Privy's record stopped showing its server wallet id"*, **para: no toques tu wallet con
     fondos** y pásale a Claude el mensaje entero. La wallet del ensayo no tiene nada que perder.
   - **Opcional, decisión tuya:** antes de pulsar en tu wallet con fondos, pulsa **Export key** en su fila y guarda la
     clave en el gestor de contraseñas. Mientras Privy tenga la wallet registrada con su id, la exportación funciona; con
     la clave fuera, el dinero no depende de lo que haga el registro de Privy. A cambio es una copia más de la clave que
     guardar bien.
7. **El botón, en tu wallet.** Con el ensayo en **Done:**, en la web, con tu sesión iniciada con Phantom, abre la
   pantalla de wallets (la web está en inglés; los nombres van tal cual salen en pantalla):
   - la wallet de trading sale con la etiqueta **Has a signer**: Privy solo sabe decir que tiene *un* signer, no cuál,
     así que el signer viejo se ve igual que uno bueno;
   - pulsa **Re-seat keeper**. Todavía no pasa nada: sale un aviso que dice que va a quitar **todos** los signers de esa
     wallet y enseña el signer y la política que pondrá después. **Mira que el signer sea el id nuevo.** Si enseña el
     viejo (en la rotación del 18-sep, `cbx133itb717vxp3dqwhk808`), la web no se ha redesplegado: pulsa **Cancel** y
     vuelve al paso 3;
   - pulsa **Remove every signer and re-seat**. Privy quita los signers, la web espera a que Privy lo refleje, pone el
     del vigilante con su política y espera a que Privy enseñe ese también. Puede tardar algo más de un minuto; no
     cierres ni recargues mientras tanto. Termina con un texto que empieza por **Done:** y la etiqueta vuelve a
     **Has a signer**.

   Si tienes más de una wallet, hazlas **de una en una** y mira `/status` (paso 8) antes de pasar a la siguiente.

   **Si se queda a medias**, el mensaje en rojo dice qué pasó. En todos los casos la wallet está a salvo: o sigue con los
   signers que tenía, o no tiene ninguno y solo tú puedes firmar con ella. Lo único que pasa es que no se aparta nada de
   sus operaciones hasta que el asiento vuelva. Según cómo empiece el mensaje:

   | empieza por | qué pasó | qué haces |
   |---|---|---|
   | *"Privy did not confirm that it removed this wallet's signers"* | no se añadió nada; la wallet puede seguir con el signer viejo | arregla lo que diga el mensaje y pulsa **Re-seat keeper** otra vez. Si para entonces la wallet sale **No seat**, pulsa **Grant keeper permission** |
   | *"Privy accepted removing this wallet's signers, but its record still shows a signer"* | Privy aceptó quitarlos, pero su registro aún no lo refleja. La wallet puede estar ya sin signers aunque la etiqueta diga **Has a signer** | espera un minuto y pulsa **Re-seat keeper** otra vez |
   | *"Every signer is off this wallet now, and Privy did not confirm that the keeper's seat was added"* | se quitaron los signers y Privy no confirmó el nuevo. La wallet sale **No seat**, también si recargas | pulsa **Grant keeper permission** en esa wallet |
   | *"Every signer was removed from this wallet. Privy's reply to adding the keeper's signer then failed, but its record now shows a signer"* | casi seguro que el signer se puso: lo que falló es la respuesta de Privy | **no pulses Grant**. Comprueba con la línea `privy-policy verify` que trae el mensaje, o en `/status` tras el siguiente barrido |
   | *"Every signer was removed from this wallet, and Privy accepted the keeper's signer with its policy, but its record has not shown the seat yet"* | Privy aceptó el signer, pero su registro va con retraso | **no pulses Grant**: lo añadiría dos veces. La web lo deja gris un minuto. Recarga en un minuto: tiene que salir **Has a signer** |
   | *"While this wallet had no signer, Privy's record stopped showing its server wallet id"* | justo lo que el ensayo del paso 6 tenía que descartar. El mensaje trae el id y dice si el signer se volvió a poner | si dice que Privy lo aceptó, compruébalo con la línea `privy-policy verify` del mensaje. Si dice *"was NOT added back"*, no pulses nada más en esa wallet: **Grant keeper permission** sale gris mientras la fila no enseñe el *Privy wallet id*. Guarda el id y pásale el mensaje a Claude |
   | *"Privy's record showed no signer on this wallet, then a signer this page did not add"* | apareció un signer que la web no puso, y la web no añadió nada | pulsa **Re-seat keeper** otra vez |
   | *"This page's copy of Privy's record and the one just read name different server wallet ids"* | no se tocó nada | recarga la página y vuelve a probar |

   **Si el botón sale gris** con *"Re-seat is not available for this wallet"*, no la toques desde la web y avisa: Privy
   solo sabe quitar los signers de una wallet cada vez cuando es una wallet TEE con su propio id, y en cualquier otra
   quitaría los de todas tus wallets a la vez. Lo mismo si **Grant keeper permission** sale gris con *"Privy adds the
   keeper's signer only to a TEE wallet it lists with its own server wallet id"*: el registro de Privy no enseña el id
   de esa wallet, y desde la web no se le puede poner el signer.
8. **Confirma en `/status`.** `signing.authorizationKey` sigue en `matches`; `signing.wallets` dice `signable` igual
   que `of` (N de N); y cada wallet sale en `wallets` con `signing` = `privy`, no `none (signer not granted)`. El
   vigilante lo lee en su siguiente barrido, así que puede tardar un poco: recarga. Desde ahí el cobro de esa wallet deja
   de ser `NO_SIGNER`, y el beneficio que estaba pendiente se cobra en los barridos siguientes.

   Si salió **Done:** pero tras varios barridos esa wallet sigue en `none (signer not granted)`, busca otra vez su línea
   con `granted` en el log de Railway (paso 4). Si `granted` todavía nombra el id viejo, el cambio no llegó a Privy:
   pasa `privy-policy verify` a esa wallet y pásale a Claude lo que diga. Si ya nombra el nuevo, el signer está y lo que
   falla es otra cosa: mira qué dice `/status` en `signing` de esa wallet, y la sección 6.
9. La **política no cambia**: el mismo `policy id` y la misma llave de administración. Va enganchada a cada asiento como
   override, así que el botón la vuelve a poner sola.
10. Cuando todas estén sentadas otra vez, borra la llave vieja en el dashboard y repite la **sección 6** de esta guía
    (*Verifica que rechaza lo que debe*) con la nueva.

Si la llave no se perdió sino que **se expuso** (alguien la vio, se pegó en un sitio que no tocaba), es el mismo camino
pero sin esperar, como dice [SECRETS.md](SECRETS.md). Con un cuidado: el botón pone el signer que tenga configurado la
web, así que pulsarlo antes del Redeploy del paso 3 volvería a sentar el signer expuesto. Primero los pasos 1 a 3,
luego el botón, y mira en el aviso que el signer sea el nuevo.

### El vigilante ya lo dice solo al arrancar

Un vigilante armado hace esta misma comprobación **al arrancar**, antes del primer barrido, y la repite **cada media
hora** mientras corre. La enseña en `/status`, en `signing.authorizationKey`, al lado de `seatCheck`, y con la fecha del
veredicto en `signing.authorizationKeyAt`. Los valores son los mismos de la tabla de arriba, y **son sobre la llave que
hay puesta en Railway**. `matches` es el único valor sano.

Mira siempre las dos cosas juntas. Un `matches` con fecha de hace dos días es un veredicto sobre el arranque de hace dos
días; si la fecha no se mueve, el vigilante lleva desde entonces sin poder preguntárselo a Privy.

Si sale cualquier otro, el vigilante **arranca igual**. Arranca a propósito: si se negase a arrancar, Railway lo
reiniciaría en bucle y se llevaría por delante la propia página `/status` donde se lee qué pasa — y además pararía de
comprar cestas, que se compran con otra llave y no dependen de esta. Un ensayo (dry run) no hace la comprobación: no lee
ninguna llave de firma, y eso no cambia.

Lo que avisa no es igual en todos los casos, y conviene saberlo antes de confiar en que te va a despertar:

| veredicto | en el log de Railway | alerta |
|---|---|---|
| `not-in-quorum`, `key-unreadable`, `threshold-above-one` | línea de **error** | **crítica** |
| `members-unresolved`, `credentials-refused`, `quorum-not-found` | línea de **aviso** (`warn`) | de aviso, no crítica |
| `quorum-unreadable` | línea de **aviso** | **ninguna las dos primeras veces**; de aviso a partir de la tercera seguida (alrededor de una hora) |

`quorum-unreadable` calla al principio a propósito: que se caiga la red un momento no prueba nada sobre la llave, y una
alerta que salta por eso es una alerta que se acaba ignorando. Pero si se repite, lo que pasa es que el vigilante lleva
horas sin poder comprobar nada — la protección está apagada — y eso sí avisa, diciendo cuántos intentos lleva. En ese
caso no hay nada que arreglar en la llave: mira `status.privy.io`, y mira `signing.authorizationKeyAt` en `/status`
después de cada reinicio.

Y **ninguna alerta llega a ningún sitio** si Railway no tiene puesta la variable del webhook de alertas
(`SIP_SOLANA_ALERT_WEBHOOK`, [RAILWAY_SOLANA.md](RAILWAY_SOLANA.md)). Sin ella se escriben solo en el log, que es
lo que pasó la noche del 18-sep: la alerta saltó cada media hora durante todo el apagón y no la vio nadie. Compruébalo.

## 8. Pon al día la política viva: solo `settle_v2`

Desde el 8-oct el código construye la política de cuatro reglas del [paso 3](#3-lee-la-política-antes-de-crearla). La
que está viva en Privy (`jsuzcjv6njl0raqjjhzqe9fh`) es la de antes: una sola regla ALLOW con los dos programas, que deja
pasar cualquier instrucción de `sip-vault`. Hay que cambiarla **antes de invitar a nadie a importar una wallet**: una
wallet importada suele ser la principal de su dueño, con dinero de verdad.

Hay dos caminos. **El A es el bueno** si tienes la llave de administración de esa política: cambia las reglas sin
cambiar el id, así que todas las wallets sentadas quedan acotadas a la vez, sin que nadie pulse nada y sin tocar
Railway ni Vercel. El B es para cuando esa llave no está.

Todo en **Terminal.app**, en `~/ProyectosCT/SIP` con `main` al día: tiene que incluir el commit *"keeper: la política
del vigilante solo deja pasar settle_v2…"* (`git log -1 --oneline --grep='solo deja pasar settle_v2' main` lo enseña;
si no sale nada, no sigas). Ningún paso lo hace Claude: la llave de administración y la del vigilante solo las tienes
tú.

### A. Cambiar la política en su sitio (`update`)

1. **Lee la política nueva.**

   ```bash
   cd ~/ProyectosCT/SIP
   pnpm --silent --dir packages/solana-keeper privy-policy --print | jq .allows
   ```

   Tienen que salir dos líneas: `6kA9…: settle_v2 only` y `Ed25519SigVerify…: any instruction`. Con `| jq .policy` ves
   la política entera, con su IDL.

2. **Mira qué hay vivo ahora**, con `check` sobre la política de hoy:

   ```bash
   cd ~/ProyectosCT/SIP
   printf 'App secret de Privy (SIP): ' && read -rs SECRETO && echo
   SIP_SOLANA_PRIVY_APP_ID=cmtrt36tb00080dlbrda5aqam SIP_SOLANA_PRIVY_APP_SECRET="$SECRETO" \
     SIP_SOLANA_PRIVY_SIGNER_ID=kyio853439oa78qfvmt853i4 \
     pnpm --silent --dir packages/solana-keeper privy-policy check --policy jsuzcjv6njl0raqjjhzqe9fh
   unset SECRETO
   ```

   Lo esperado es `verdict: DIFFERENT` (mientras las reglas no coincidan, `verdict` dice siempre eso), con cuatro
   `differences`: a la regla de `sip-vault` le faltan sus dos condiciones nuevas (`programId eq` y
   `solana_instruction_data.instruction_name … [settle_v2]`), le sobra la de antes (`programId in` con los dos
   programas), y falta la regla de Ed25519. El dueño se lee aparte, en tres campos:
   - `ownerId` tiene que ser el `adminKeyQuorumId` que apuntaste en el gestor al crearla;
   - `owned` tiene que ser `true` y `ownerIsSigner`, `false`;
   - `ownershipProblems` tiene que estar vacío.

   Si no es así, para aquí y ve al camino B: `update` tampoco cambiaría una política así.

3. **Cámbiala.** Necesitas el archivo de la llave de administración que escribió `create`. Esta guía lo dejó en
   `~/sip-keys/privy-policy-admin.key`; si lo guardaste con otro nombre, usa ese. Si solo lo tienes en el gestor,
   escríbelo en un archivo de `~/sip-keys` en una sola línea y déjalo con `chmod 600`.

   ```bash
   cd ~/ProyectosCT/SIP
   printf 'App secret de Privy (SIP): ' && read -rs SECRETO && echo
   SIP_SOLANA_PRIVY_APP_ID=cmtrt36tb00080dlbrda5aqam SIP_SOLANA_PRIVY_APP_SECRET="$SECRETO" \
     SIP_SOLANA_PRIVY_SIGNER_ID=kyio853439oa78qfvmt853i4 \
     pnpm --silent --dir packages/solana-keeper privy-policy update --policy jsuzcjv6njl0raqjjhzqe9fh \
     --admin-key ~/sip-keys/privy-policy-admin.key
   unset SECRETO
   ```

   Hace tres cosas: lee la política (y escribe una línea `privy policy before update` con lo que va a cambiar), manda el
   cambio firmado con la llave de administración, y vuelve a leer lo que Privy guardó. La llave no sale en ninguna
   línea. Mira la última:

   | línea | qué significa | qué haces |
   |---|---|---|
   | `privy policy updated`, `verdict: OK` (código 0) | lo que Privy guardó hace lo mismo que la política nueva (las mismas reglas, programas, condiciones y nombres con sus discriminadores en el IDL; los nombres de las reglas no cuentan), y tiene el mismo dueño | sigue al paso 4 |
   | `privy policy update`, `verdict: ALREADY_CURRENT` (código 0) | ya estaba al día; no se mandó nada | sigue al paso 4 |
   | `privy policy update`, `verdict: UNOWNED` u `OWNED_BY_SIGNER` | no se cambió nada: su dueño está mal | camino B |
   | `privy policy not read` | no pudo leer la política antes de cambiarla. No cambió nada | mira `status` y `detail`, y repite |
   | `privy policy not read after update` | Privy **aceptó** el cambio, pero no se pudo volver a leer | haz el paso 4 |
   | `privy policy not updated`, `class: AUTHORIZATION` | Privy no aceptó la firma: ese archivo no es la llave del dueño (`ownerId` del paso 2). No cambió nada | busca en el gestor la llave de administración de ese quorum; si no está, camino B |
   | `privy policy not updated`, `next` dice *may have landed* | no hubo respuesta, o Privy dio un error de servidor: pudo guardarse o no | haz el paso 4 antes de nada |
   | `privy policy not updated`, cualquier otro | Privy rechazó el cambio (por ejemplo, el IDL) y no cambió nada | pásale a Claude la línea entera: no lleva secretos |
   | `privy policy updated`, `verdict: DIFFERENT` u `OWNER_CHANGED` | Privy guardó algo que no es la política nueva | haz el paso 4 y pásale a Claude las dos líneas |

   Si sale una línea `configuration refused` o `arguments refused`, no se mandó nada: falta una variable o la ruta de la
   llave no vale (relativa, no existe, o no tiene dentro una llave). Lo dice nombrando la variable o la ruta, nunca el
   contenido. El código de salida es 2, pero el pnpm de tu Terminal (9.12, con `--silent`) lo convierte en 1: fíate de
   la línea.

4. **Compruébala** con el mismo comando del paso 2. Ahora tiene que decir `verdict: OK`.

5. **Verifica el asiento y los rechazos** con la [sección 6](#6-verifica-que-rechaza-lo-que-debe), con `--policy
   jsuzcjv6njl0raqjjhzqe9fh`, en una wallet de prueba con unos 0,002 SOL. Tiene que salir `PASS`. Recuerda que `verify`
   manda transacciones de verdad a mainnet y necesita la llave del vigilante.

6. **Confirma que el cobro sigue pasando.** Ningún comando de esta guía lo puede probar: un cobro necesita la firma del
   atestador, y ninguno la usa (está en Railway y en `~/sip-keys/settle.json`, [SECRETS.md](SECRETS.md)). Lo prueba el
   siguiente cobro real del vigilante, que solo sale cuando una wallet sentada tiene algo que cobrar:
   - **Bien**: en el log de Railway, una línea `settle settled` de una wallet, con hora posterior al paso 3. En
     `/status` dura poco: `settle` = `SETTLED` en esa wallet, hasta que el vigilante la vuelve a mirar.
   - **Mal**: una línea `settle failed`, con la alerta crítica **A settlement failed**, cuyo `detail` habla de la
     política (`policy_violation`). La política nueva está rechazando el cobro: haz el paso 7 y pásale a Claude ese
     `detail`.

   Mientras tanto no se pierde nada: lo que no se cobra se queda pendiente y se cobra en los barridos siguientes.

7. **Volver atrás, solo si el paso 6 sale mal.** Pone otra vez las reglas de antes con el mismo `update`, corrido desde
   el commit que lo añadió, que aún construía la política de antes. Primero, una copia del repositorio en ese commit,
   con sus dependencias:

   ```bash
   cd ~/ProyectosCT/SIP && git worktree add ~/saverfi-politica-anterior \
     "$(git log -1 --format=%H --grep='^keeper: privy-policy update reescribe la política' main)" \
     && cd ~/saverfi-politica-anterior && CI=1 pnpm install --frozen-lockfile && git log -1 --oneline
   ```

   La última línea es un hash corto seguido de *"keeper: privy-policy update reescribe la política en su sitio…"*. Si
   sale otra cosa, o un error (por ejemplo `invalid reference`, que es que no encontró el commit), **para aquí** y pásale
   a Claude lo que salió. Si salió bien, la vuelta atrás, desde esa copia (`--dir` la nombra entera, así que no depende de dónde estés):

   ```bash
   printf 'App secret de Privy (SIP): ' && read -rs SECRETO && echo
   SIP_SOLANA_PRIVY_APP_ID=cmtrt36tb00080dlbrda5aqam SIP_SOLANA_PRIVY_APP_SECRET="$SECRETO" \
     SIP_SOLANA_PRIVY_SIGNER_ID=kyio853439oa78qfvmt853i4 \
     pnpm --silent --dir ~/saverfi-politica-anterior/packages/solana-keeper privy-policy update \
     --policy jsuzcjv6njl0raqjjhzqe9fh --admin-key ~/sip-keys/privy-policy-admin.key
   unset SECRETO
   ```

   Tiene que acabar en `privy policy updated`, `verdict: OK`: OK respecto a la política de antes. Con eso los cobros
   vuelven a pasar, y la importación de wallets **no** se anuncia hasta que la política nueva funcione. Si dice
   `ALREADY_CURRENT`, no se mandó nada: o la política ya era la de antes, o el comando no corrió desde la copia; pásale a
   Claude esa línea. Al acabar, borra la copia: `cd ~/ProyectosCT/SIP && git worktree remove ~/saverfi-politica-anterior`.

8. **Después, las frases.** Varios textos todavía describen la política de antes (que el asiento puede mandar cualquier
   instrucción del programa de SaverFi, o que una política no puede mirar nada más fino que el programa): la tarjeta
   *Trading wallets* de la web, el README y comentarios de `import-preflight.ts`, `verify-tx.ts` y del propio programa
   (`link_wallet.rs`). Cuando el paso 6 haya salido bien, pide a Claude que los ponga al día: antes sería prometer algo
   que Privy aún no hace.

### B. Si no tienes la llave de administración: otra política, y volver a sentar cada wallet

Sin la llave del dueño, la política de hoy no se puede cambiar. Se crea otra y cada wallet pasa a ella. Cuesta más: el
vigilante solo firma por una wallet si su asiento lleva **exactamente** la política de `SIP_SOLANA_PRIVY_POLICY_ID`, así
que desde que la cambies hasta que el dueño de cada wallet pulse **Re-seat keeper**, esa wallet no se cobra (en
`/status` sale `none (seat not bounded by the keeper's policy)`; lo pendiente se cobra después).

1. **Crea la nueva** con la [sección 4](#4-crea-la-política), con un archivo nuevo:
   `--admin-key-out ~/sip-keys/privy-policy-admin-2.key`. Apunta su `policyId` y su `adminKeyQuorumId`.
2. **Compruébala** con la [sección 5](#5-comprueba-la-política-guardada), con `--policy <el policyId nuevo>`: `OK`.
3. **Vercel**: `SIP_SOLANA_PRIVY_POLICY_ID` = el `policyId` nuevo, y **Redeploy** ([VERCEL_WEB.md](VERCEL_WEB.md)). Sin el
   Redeploy, el botón volvería a sentar la política vieja.
4. **Railway**, servicio `sip-solana-keeper`: `SIP_SOLANA_PRIVY_POLICY_ID` = el nuevo, y despliega. Si el vigilante de
   volumen está armado, toma esa variable por referencia: redespliégalo también.
5. **Cada wallet**: su dueño pulsa **Re-seat keeper** en `/wallets`, como en la
   [sección 7](#si-la-llave-privada-de-ese-quorum-se-ha-perdido), paso 7. En el aviso, la política tiene que ser la nueva.
6. **Verifica** con la [sección 6](#6-verifica-que-rechaza-lo-que-debe) y `--policy <el policyId nuevo>`, y confirma el
   cobro como en el paso 6 del camino A. Para volver atrás: `SIP_SOLANA_PRIVY_POLICY_ID` vuelve al id de antes en Vercel
   y Railway, y las wallets que ya pasaron a la nueva se vuelven a sentar.

## 9. Antes de invitar a importar wallets: rota la llave del vigilante y la app secret

La política acota lo que se puede firmar, pero quien tenga **las dos cosas**, la llave de autorización del vigilante y
la app secret de Privy, sigue pudiendo mandar desde cada wallet sentada lo que la política deja pasar
([Lo que la política no impide](#lo-que-la-política-no-impide)). Con la importación, eso incluye la wallet principal de
cada usuario. Si alguna de las dos ha estado alguna vez fuera del gestor de contraseñas y de Railway, rótalas antes de
anunciar la importación, como dice [SECRETS.md](SECRETS.md): no hay que discutir si "de verdad" se filtraron. Primero
la [sección 8](#8-pon-al-día-la-política-viva-solo-settle_v2), después esta.

**La app secret.**

1. Dashboard de Privy, en la app `cmtrt36tb00080dlbrda5aqam`: **Configuration → App settings → Basics**. Crea una app
   secret nueva y cópiala al gestor en ese momento.
2. Railway, servicio `sip-solana-keeper`: cambia `SIP_SOLANA_PRIVY_APP_SECRET` y despliega. Si el vigilante de volumen
   está armado, la toma por referencia: redespliégalo también. La web no la usa: la rechaza por el nombre
   ([VERCEL_WEB.md](VERCEL_WEB.md)).
3. `/status` del vigilante: `signing.authorizationKey` tiene que volver a decir `matches`, con
   `signing.authorizationKeyAt` posterior al reinicio. Esa comprobación lee Privy con la app secret, así que con una
   secret mala diría `credentials-refused`.
4. Solo entonces borra la secret vieja en el dashboard.

**La llave del vigilante.** El único camino que trae esta guía es el de la
[sección 7](#si-la-llave-privada-de-ese-quorum-se-ha-perdido): una llave nueva con un **signer id nuevo**, y por eso
cada wallet sentada tiene que volver a sentarse (su dueño pulsa **Re-seat keeper**). Cuantas menos wallets haya
sentadas, menos gente tiene que pulsar el botón: mejor antes de anunciar la importación que después.

Hay otro camino que esta guía todavía no cubre y que ningún comando hace hoy: Privy tiene *Update key quorum*, que
cambia las claves de un key quorum que ya existe, firmado por ese mismo quorum, es decir, con la llave que ya tiene (y
esa sí la tienes). Así el signer id (`kyio853439oa78qfvmt853i4`) no cambiaría y no habría que volver a sentar nada. Si
lo prefieres, pídele a Claude ese comando, con sus pruebas, antes de usarlo.

## Por qué la política tiene una llave de administración aparte

Una política con dueño solo se puede cambiar o borrar con la firma de ese dueño. Sin dueño, basta la app secret.

Railway tiene la app secret y la llave del vigilante. Si alguien entrase en el servidor, con una política sin dueño, o
cuyo dueño fuese la propia llave del vigilante, podría ampliar la regla y hacer con las wallets lo que quisiera. Por eso
el dueño es una llave que **nunca sale de tu ordenador**: quien controle el vigilante no puede cambiar la regla.

Pero no poder cambiar la regla **no es lo mismo que no poder hacer daño**. Con la regla tal como está, quien controle la
llave del vigilante todavía puede hacer lo que cuenta el apartado siguiente.

Cambiarla es lo que hace `privy-policy update`, y por eso pide esa llave: lee su archivo y firma con ella
([sección 8](#8-pon-al-día-la-política-viva-solo-settle_v2), camino A). Sin esa llave, el único camino es crear otra
política y volver a sentar cada wallet (camino B).

## Lo que la política no impide

Con la política del paso 3, Privy mira **qué instrucción** de `sip-vault` es cada una, no solo de qué programa, y solo
deja pasar `settle_v2`. Aun así, quien tenga la llave del vigilante y la app secret (las dos están en Railway) puede,
sin cambiar la política:

- **Mandar cobros (`settle_v2`) desde cualquier wallet sentada.** Lo que mueve cada uno lo limita el propio programa, no
  Privy: tiene que llevar delante la firma Ed25519 del atestador configurado, y respeta las pausas, el tope de cada
  cobro (`max_contribution`) y la reserva de la wallet (`wallet_reserve`). La llave del atestador (la de cobro,
  [SECRETS.md](SECRETS.md)) también está en Railway.
- **Sacar SOL poco a poco** con transacciones que solo llevan la instrucción Ed25519: cada una cuesta la comisión base y
  una comisión por cada firma que declare. Ed25519 no es un programa de Anchor, así que no hay IDL que lo acote.

Mientras la política viva sea la de antes (la [sección 8](#8-pon-al-día-la-política-viva-solo-settle_v2) sin hacer),
además puede **usar cualquier instrucción de `sip-vault` que firme la wallet**: con una wallet importada, por ejemplo,
crear un vault con ella como dueña y después enlazarle wallets una y otra vez, pagando ella el alquiler de cada enlace.

Por eso **`ComputeBudget` no está en la regla**. Con él, una transacción de solo instrucciones de comisión pasaría y
fijaría la comisión de prioridad que quisiera, hasta gastar el saldo entero de la wallet en comisiones que se queda el
validador, y `sip-vault` no podría impedirlo porque esa transacción no lleva ninguna instrucción suya. El cobro que manda
el vigilante por Privy no lo usa, así que dejarlo fuera no rompe nada.

Mientras siga, la protección es la de siempre: la llave del vigilante no se enseña a nadie, y si sospechas que se
expuso, quita el signer de las wallets o rota la llave enseguida, como dice [SECRETS.md](SECRETS.md).

## Lo que nunca se hace

- Pegar en el chat la app secret, la llave de autorización, las URLs del RPC o el contenido de
  `~/sip-keys/privy-policy-admin.key`.
- Poner la llave de administración en Railway, Vercel o cualquier servidor, o guardarla dentro del repositorio.
- Poner la política en los `policy_ids` de la wallet: eso ata también al usuario y le bloquea exportar a Axiom. Va
  solo como override del signer.
- Añadir una regla `*` o un programa "por si acaso".
- Usar una app de Privy que no sea la del paso 1, variables `NUVEM_*` o el programa retirado. Con las dos últimas el
  comando se niega.
- Dar por buena una verificación `INCONCLUSIVE`.
- Dejar puestas `PRIVY_API_BASE_URL`, `PRIVY_API_LOG` o `PRIVY_API_CUSTOM_HEADERS`. Son ajustes del propio SDK de Privy:
  mandan las peticiones que llevan la app secret a otro sitio, las apuntan en el log o les añaden cabeceras. El comando
  y el vigilante se niegan a arrancar con ellas.
- Correr estos comandos en el panel de terminal de la app de Claude.

Si un secreto se expone, se rota como dice [SECRETS.md](SECRETS.md): primero lo que controla, luego se revoca lo viejo,
luego se anota.
