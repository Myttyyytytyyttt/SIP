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

1. Entra en el dashboard de Privy y **comprueba arriba que la app es la de SIP**, no la de Nuvem. Todo lo que sigue
   se hace en la app de SIP.
2. Para el vigilante **no hay que buscar ningún interruptor de Solana**. Firma desde el servidor con `@privy-io/node`, y
   eso funciona en cualquier app con TEE (punto 3). La web crea y usa las wallets de Solana desde su propio código
   (`PrivyProvider`). Lo único de Solana que la documentación de Privy pone en el dashboard es entrar con una wallet
   (Sign in with Solana, SIWS), en **Login methods**. **La web de SIP entra con Phantom, así que actívalo**: el 14-sep
   estaba apagado. El vigilante no lo necesita.
3. Ve a **Wallets → Advanced**. Tiene que decir **"TEE enabled"**. Si dice "On-device", pulsa **"Request access to
   migrate to TEE"** y sigue las instrucciones. Sin TEE no hay signers ni políticas.
4. En los **dominios permitidos** (Allowed origins) añade `http://localhost:3002` y `http://localhost:3013` para probar
   en local, y el dominio final de la web cuando exista. El 14-sep la lista estaba vacía.

## 2. Crea la llave de autorización del vigilante

1. Ve a **Wallets → Authorization keys** y pulsa **New key**. Ponle de nombre `sip-solana-keeper`.
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

Cualquier otra cosa se deniega porque no tiene regla. El programa viejo de Nuvem (`7rtg…`) no está: el comando se niega a
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

Una línea `old program` explica por qué el programa viejo de Nuvem no se prueba. Queda fuera porque no está en la lista
(el paso 5 lo comprueba). No se puede probar porque Privy simula antes de mirar la política, así que la prueba tendría
que ser una llamada que funcione de verdad contra un programa cuya llave se filtró. Eso no se hace.

Si sale con código 2, falta o sobra algo en las variables (también si hay puesta alguna `PRIVY_API_*`: mira
[Lo que nunca se hace](#lo-que-nunca-se-hace)), o `SIP_SOLANA_RPC_URLS` no es de mainnet. Lo dice nombrando la variable,
nunca su valor.

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
- Usar la app de Privy de Nuvem, sus variables `NUVEM_*` o su programa viejo. El comando se niega.
- Dar por buena una verificación `INCONCLUSIVE`.
- Dejar puestas `PRIVY_API_BASE_URL`, `PRIVY_API_LOG` o `PRIVY_API_CUSTOM_HEADERS`. Son ajustes del propio SDK de Privy:
  mandan las peticiones que llevan la app secret a otro sitio, las apuntan en el log o les añaden cabeceras. El comando
  y el vigilante se niegan a arrancar con ellas.
- Correr estos comandos en el panel de terminal de la app de Claude.

Si un secreto se expone, se rota como dice [SECRETS.md](SECRETS.md): primero lo que controla, luego se revoca lo viejo,
luego se anota.
