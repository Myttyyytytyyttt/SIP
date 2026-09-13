# Llaves y secretos durante el hackathon

La causa de todo lo que salió mal en el programa viejo fue una sola cosa: una clave privada pegada en un chat.
Estas reglas existen para que no vuelva a pasar.

## Las dos wallets

| wallet | archivo | qué hace | dónde vive su secreto |
|---|---|---|---|
| **Administración** | `~/sip-keys/admin.json` | publica, actualiza y configura el programa | solo en tu ordenador; nunca en un servidor |
| **Cobro** | `~/sip-keys/settle.json` | atestador y crank del vigilante: firma cobros y paga comisiones | en Railway, pegada por ti |

La de administración puede **reemplazar el programa entero**. Por eso no va nunca a Railway: quien entrase en el
servidor podría cambiar el código que guarda el dinero. La de cobro solo puede firmar cobros, y cada cobro tiene un
tope en el propio programa.

La dirección del programa la genera `anchor` en `packages/solana-program/target/deploy/sip_vault-keypair.json`,
ignorado por git. No es una wallet: no guarda dinero y no firma nada después del despliegue.

## Cómo crear una llave

1. Abre **Terminal.app**. No uses el panel de terminal de la app de Claude: Claude puede leerlo.
2. Crea la llave:

   ```bash
   mkdir -p ~/sip-keys && chmod 700 ~/sip-keys
   solana-keygen new -o ~/sip-keys/admin.json
   ```

   Te enseña una frase de 12 palabras. Escríbela en papel o en tu gestor de contraseñas, y cierra la ventana.

3. Pasa a Claude **solo** la dirección pública:

   ```bash
   solana-keygen pubkey ~/sip-keys/admin.json
   ```

## Lo que nunca se hace

- Pegar en el chat una clave privada, una frase de recuperación, un token de API o una contraseña.
- Copiar `~/sip-keys` dentro de un repositorio, un Dockerfile o una variable `NEXT_PUBLIC_*`.
- Poner la wallet de administración en Railway, Vercel o cualquier servidor.
- Enseñar un gestor de contraseñas, un panel de Railway o esa carpeta en el vídeo.

## Lo que hace Claude

`.claude/settings.json` bloquea a las herramientas de lectura y edición de Claude `~/sip-keys`, las claves del
programa viejo, la configuración de la CLI de Solana y cualquier `*-keypair.json`. Ese candado cubre las
herramientas, no un comando de shell. La garantía real es otra: Claude no toca esas rutas, y las llaves se crean en
una ventana que Claude no puede ver.

## Si un secreto se expone

No hay que discutir si "de verdad" se ha filtrado. Se rota, en este orden:

1. Mover lo que controla (fondos, autoridad del programa) a una llave nueva.
2. Revocar la vieja donde se pueda.
3. Anotar en el roadmap qué se rotó y cuándo.
