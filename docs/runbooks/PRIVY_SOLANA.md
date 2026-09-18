# La política de Privy del vigilante de Solana

El vigilante (el keeper) firma los cobros **como cada wallet de trading**, a través de Privy, con una sola llave: su
llave de autorización. Sin política, quien tenga esa llave puede hacer con la wallet lo que quiera: firmar cualquier
mensaje, mandar cualquier transacción, exportar la clave. Con esta política ya no puede exportar la clave ni firmar
mensajes, y solo puede mandar transacciones hechas **enteras** de instrucciones de dos programas: `sip-vault` y la
verificación de firmas Ed25519.

Eso no es "solo el cobro". Lo que la política deja abierto está en
[Lo que la política no impide](#lo-que-la-política-no-impide).

Esta guía la sigues tú. Ninguna de estas llaves hace falta que la vea Claude.

## Qué vas a tener al final

| cosa | qué es | dónde va |
|---|---|---|
| **app id** de Privy (SIP) | público | web y Railway |
| **app secret** de Privy (SIP) | secreto | gestor de contraseñas y Railway |
| **llave de autorización del vigilante** | secreto: firma como las wallets | gestor de contraseñas y Railway |
| **signer id** (el id de esa llave) | público | web y Railway: `SIP_SOLANA_PRIVY_SIGNER_ID` |
| **policy id** | público | web: `SIP_SOLANA_PRIVY_POLICY_ID` |
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

Tiene tres reglas:

- **ALLOW `signAndSendTransaction`** solo si **todas** las instrucciones son de estos dos programas: `sip-vault`
  (`6kA9H9zQT6PW5xWkXoAFCS3NotxarzaYqj66mjMf9w4J`) y `Ed25519SigVerify111…` (la atestación). `ComputeBudget` no está,
  a propósito: lo explica [Lo que la política no impide](#lo-que-la-política-no-impide).
- **DENY `exportPrivateKey`**: el vigilante no puede sacar la clave de ninguna wallet.
- **DENY `signMessage`**: el vigilante no puede firmar mensajes sueltos.

Cualquier otra cosa se deniega porque no tiene regla. El programa retirado (`7rtg…`) no está: el comando se niega a
construir una política que lo nombre.

Privy mira **de qué programa** es cada instrucción, no qué hace. Por eso la regla deja pasar más que el cobro: lo cuenta
[Lo que la política no impide](#lo-que-la-política-no-impide).

## 4. Crea la política

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

Si todo va bien imprime **una** línea con cuatro datos:

| campo | para qué |
|---|---|
| `policyId` | la web: `SIP_SOLANA_PRIVY_POLICY_ID` |
| `adminKeyQuorumId` | ninguna variable: apúntalo en el gestor, junto a la llave de administración |
| `programs` | los dos programas permitidos, para que los compares con el paso 3 |
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
  `SIP_SOLANA_PRIVY_AUTHORIZATION_KEY` (paso 2) y `SIP_SOLANA_PRIVY_SIGNER_ID`.
- **Solo tu ordenador y el gestor**: la llave de administración.

## 5. Comprueba la política guardada

```bash
cd ~/ProyectosCT/SIP
printf 'App secret de Privy (SIP): ' && read -rs SECRETO && echo
SIP_SOLANA_PRIVY_APP_ID=<app id> SIP_SOLANA_PRIVY_APP_SECRET="$SECRETO" SIP_SOLANA_PRIVY_SIGNER_ID=<signer id> \
  pnpm --silent --dir packages/solana-keeper privy-policy check --policy <policyId>
unset SECRETO
```

Lee la política de Privy y la compara con la del paso 3. Mira `verdict`:

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

Si sale con código 2, falta o sobra algo en las variables (también si hay puesta alguna `PRIVY_API_*`: mira
[Lo que nunca se hace](#lo-que-nunca-se-hace)), o `SIP_SOLANA_RPC_URLS` no es de mainnet. Lo dice nombrando la variable,
nunca su valor.

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
ninguna parte, y con **código 1** en los demás casos. Nunca imprime la llave privada.

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
   botón del paso 5 volvería a sentar el signer viejo, el que ya no sirve. La política (`SIP_SOLANA_PRIVY_POLICY_ID`) no
   cambia.
4. **Mira `/status` antes de tocar ninguna wallet.** `signing.authorizationKey` tiene que decir `matches`, con
   `signing.authorizationKeyAt` posterior al arranque, y `signing.privySignerId` tiene que ser el id nuevo. En este
   momento `signing.wallets` dirá `signable: 0`: es lo normal, porque todas las wallets siguen con el signer viejo, y
   cada una sale en `wallets` como `none (signer not granted)`. Si `authorizationKey` no dice `matches`, para aquí: la
   tabla de más arriba dice qué es cada valor. Pulsar botones no arregla una llave que no es la del quorum.
5. **El botón, en cada wallet de trading.** En la web, con tu sesión iniciada con Phantom, abre la pantalla de wallets
   (la web está en inglés; los nombres van tal cual salen en pantalla):
   - la wallet de trading sale con la etiqueta **Has a signer**: Privy solo sabe decir que tiene *un* signer, no cuál, así
     que el signer viejo se ve igual que uno bueno;
   - pulsa **Re-seat keeper**. Todavía no pasa nada: sale un aviso que dice que va a quitar **todos** los signers de esa
     wallet y enseña el signer y la política que pondrá después. **Mira que el signer sea el id nuevo.** Si enseña el
     viejo (en la rotación del 18-sep, `cbx133itb717vxp3dqwhk808`), la web no se ha redesplegado: pulsa **Cancel** y
     vuelve al paso 3;
   - pulsa **Remove every signer and re-seat**. Privy quita los signers, la web espera a que Privy lo refleje y pone el
     del vigilante con su política. Termina con un texto que empieza por **Done:** y la etiqueta vuelve a **Has a
     signer**.

   Hazlo primero con **una sola wallet** y mira `/status` (paso 6) antes de seguir con las demás. Si solo tienes una,
   esa es la prueba.

   **Si se queda a medias**, la wallet sale con la etiqueta **No seat** y un mensaje en rojo que empieza por *"Every
   signer is off this wallet now, but the keeper's seat was NOT added"*. Pulsa **Grant keeper permission** en esa misma
   wallet: pone el signer que falta. Mientras tanto la wallet está a salvo, porque solo tú puedes firmar con ella; lo
   único que pasa es que no se aparta nada de sus operaciones hasta que el asiento vuelva. Si recargas la página, sigue
   saliendo **No seat** con el mismo botón.

   **Si el botón sale gris** con *"Re-seat is not available for this wallet"*, no la toques desde la web y avisa: Privy
   solo sabe quitar los signers de una wallet cada vez cuando es una wallet TEE con su propio id, y en cualquier otra
   quitaría los de todas tus wallets a la vez.
6. **Confirma en `/status`.** `signing.authorizationKey` sigue en `matches`; `signing.wallets` dice `signable` igual
   que `of` (N de N); y cada wallet sale en `wallets` con `signing` = `privy`, no `none (signer not granted)`. El
   vigilante lo lee en su siguiente barrido, así que puede tardar un poco: recarga. Desde ahí el cobro de esa wallet deja
   de ser `NO_SIGNER`, y el beneficio que estaba pendiente se cobra en los barridos siguientes.
7. La **política no cambia**: el mismo `policy id` y la misma llave de administración. Va enganchada a cada asiento como
   override, así que el botón la vuelve a poner sola.
8. Cuando todas estén sentadas otra vez, borra la llave vieja en el dashboard y repite la **sección 6** de esta guía
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

## Por qué la política tiene una llave de administración aparte

Una política con dueño solo se puede cambiar o borrar con la firma de ese dueño. Sin dueño, basta la app secret.

Railway tiene la app secret y la llave del vigilante. Si alguien entrase en el servidor, con una política sin dueño, o
cuyo dueño fuese la propia llave del vigilante, podría ampliar la regla y hacer con las wallets lo que quisiera. Por eso
el dueño es una llave que **nunca sale de tu ordenador**: quien controle el vigilante no puede cambiar la regla.

Pero no poder cambiar la regla **no es lo mismo que no poder hacer daño**. Con la regla tal como está, quien controle la
llave del vigilante todavía puede hacer lo que cuenta el apartado siguiente.

Este comando no cambia políticas. Si algún día hay que cambiarla, se crea una nueva, la web pasa a usar el nuevo id, y
se vuelve a verificar.

## Lo que la política no impide

Privy solo mira **de qué programa** es cada instrucción. No mira qué dice la instrucción ni qué cuentas toca. Así que
quien tenga la llave del vigilante puede, sin cambiar la política:

- **Sacar SOL poco a poco** con transacciones que solo llevan la instrucción Ed25519: cada una cuesta la comisión base y
  una comisión por cada firma que declare.
- **Usar cualquier instrucción de `sip-vault` que firme la wallet**, no solo el cobro (`settle_v2`). Hoy también
  `link_wallet`, que además necesita la firma del dueño de un vault.

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
