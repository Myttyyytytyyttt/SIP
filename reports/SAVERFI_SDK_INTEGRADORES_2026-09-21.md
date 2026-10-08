# SaverFi como SDK para otros proyectos — estudio (2026-09-21)

Pregunta del dueño: ¿se puede crear un SDK para que otros proyectos, por ejemplo Axiom, integren
SaverFi con un widget o unas pocas líneas, pasando por nuestros sistemas? ¿Y tiene sentido como negocio?

## 1. Respuesta corta

**Sí es posible, y la forma buena es más simple que lo que tenemos hoy.** Pero no es "el mismo
sistema con un widget encima": para un tercero el ahorro tiene que ir **dentro de la propia
transacción del trade**, no cobrado después por nuestro vigilante.

**Como negocio tiene sentido, con un matiz:** Axiom no será el primer cliente. Un terminal grande no
integra un programa sin auditar, actualizable por una sola llave. El camino realista es SDK primero,
socios pequeños después, y los grandes cuando haya auditoría y multifirma.

## 2. Por qué el sistema actual no se puede "prestar" tal cual

Hoy SaverFi cobra así: el vigilante observa la wallet, mide el beneficio y firma un cobro **con la
wallet de trading del usuario**, usando un permiso que esa wallet nos dio dentro de Privy.

- Las wallets de Axiom viven en **Turnkey**, no en Privy. Nuestro permiso no existe allí.
- Para cobrar en una wallet de Axiom, Axiom tendría que darnos poder de firma sobre las wallets de
  sus usuarios. Ningún terminal serio hará eso con un tercero.
- Conclusión: el modelo "observar y cobrar después" solo funciona con wallets creadas en SaverFi.
  No es integrable por otros.

## 3. Cómo sí funciona: el ahorro dentro del trade

Un terminal **construye él mismo cada transacción de swap** de sus usuarios. Por eso puede añadirle
una instrucción más: "envía el X % de esta operación a la bóveda del usuario". El usuario firma una
sola vez, como siempre, y el ahorro ocurre en la misma transacción, o no ocurre.

Es exactamente el patrón que Jupiter ya ofrece a sus integradores: un parámetro de comisión en
puntos básicos que el integrador añade al swap. La diferencia es el destino: en vez de ir a la
plataforma, va a la bóveda del propio usuario.

Comprobado en nuestro código y en la cadena:

- **La dirección de la bóveda se calcula solo con la llave del usuario** (semillas `vault` + dueño).
  Un tercero la deriva sin llamarnos.
- **Un envío normal de SOL a la bóveda ya entra en la cadena de inversión.** El programa envuelve,
  convierte y compra con el saldo libre de la bóveda, venga de donde venga. Ya pasó en mainnet: la
  primera compra de SPYx incluyó SOL enviado a mano.
- **No hace falta Privy, ni atestación, ni medir nada después.** Quien construye el trade conoce el
  importe exacto. Esto además resuelve nuestro problema del "modo volumen sin medidor": dentro del
  trade, el volumen no se mide, se sabe.
- **Un detalle bonito para vender:** el dueño de la bóveda puede ser una wallet fría del usuario.
  El dinero solo entra desde la wallet caliente de trading y solo sale con la llave fría.

Límites honestos:

- **Solo sirve para el modo volumen.** El beneficio no se conoce dentro de una sola transacción, así
  que el modo beneficio seguirá siendo exclusivo de las wallets creadas en SaverFi.
- En las ventas, el SOL recibido solo se sabe al final del swap. La primera versión usaría el importe
  cotizado, que es aproximado. La versión exacta necesita una instrucción nueva en el programa.

## 4. Los tres niveles de integración

| Nivel | Qué pone el socio | Qué ponemos nosotros | Esfuerzo nuestro |
|---|---|---|---|
| **1. Enlace** | Un botón "Ahorra con SaverFi" con su código de referido | Nuestra web actual | Casi cero |
| **2. SDK dentro del trade** | 3-5 líneas: añadir nuestra instrucción a cada swap | Paquete `@saverfi/sdk`, API para crear bóveda y política, vigilante que invierte | 1-2 semanas |
| **3. Widget** | Un componente en su web que enseña la pensión y el interruptor de ahorro | El componente, conectado al SDK | +1 semana |

"Pasando por nuestros sistemas" se cumple en los niveles 2 y 3: la bóveda es de nuestro programa,
la política de inversión la construye nuestra API con precios en vivo, y nuestro vigilante es quien
convierte y compra las acciones.

## 5. Qué existe ya y qué falta

| Pieza | Estado |
|---|---|
| Programa con bóvedas, política de inversión y compra de acciones | **Vivo en mainnet** |
| Constructores de transacciones: crear bóveda, política, retirar, vincular | **Existen** en `solana-core`, 7 en total. Son la semilla del SDK |
| Verificador de transacciones y API que las construye | **Existe** |
| Instrucción de ahorro dentro del trade | **Falta**, pero la versión simple es una transferencia normal: horas, no días |
| El vigilante invierte bóvedas sin wallet vinculada | **Falta.** Hoy solo descubre bóvedas a través de sus vínculos. Cambio pequeño, fuera de la cadena |
| Paquete público, documentación, ejemplos | **Falta** |
| Comisión de protocolo y reparto con el socio | **No existe nada.** Requiere actualizar el programa |
| Registro en cadena de quién trajo cada ahorro | **Falta.** Primera versión con un memo; la buena, con instrucción propia |
| Auditoría, multifirma y retardo en las actualizaciones | **Falta.** Es lo que pedirá cualquier socio serio |

## 6. Visión de negocio

**Por qué un terminal querría integrarlo**

- Diferenciación y retención: "aquí tu trading te construye una pensión" es un mensaje que ningún
  terminal tiene, y un usuario con una pensión acumulada no se cambia de plataforma fácilmente.
- Ingreso extra si compartimos comisión con el socio, como hace Jupiter con sus integradores.
- Imagen: un contrapeso creíble a la fama de casino de estos productos.

**Por qué podría decir que no**

- Cada euro ahorrado sale del saldo de trading, y su negocio vive del volumen. Con tasas del 0,2 al
  2 % del volumen el efecto es pequeño, pero lo preguntarán.
- Riesgo técnico: programa sin auditar y actualizable por una sola llave.
- Riesgo legal: las acciones tokenizadas xStocks están vetadas a residentes de EE. UU., Reino Unido
  y Canadá, entre otros. Y la palabra "pensión" está regulada en muchos países. Un socio multiplica
  esa exposición, y querrá que el bloqueo geográfico y los términos sean claros.

**De dónde sale el dinero.** Hoy SaverFi no cobra nada: no existe comisión en el programa. Las
opciones razonables son un pequeño porcentaje sobre lo invertido, o sobre lo ahorrado, repartido con
el socio que trajo al usuario. Cualquiera de las dos exige una actualización del programa.

**Quién primero.** No Axiom. El orden realista:

1. Nuestra propia web como primer integrador del SDK, para demostrar que funciona.
2. Bots de Telegram, terminales pequeños y wallets, que integran rápido y sin comité de riesgos.
3. Terminales grandes, cuando haya auditoría, multifirma y un historial de meses sin incidentes.

## 7. Riesgos principales

- **Responsabilidad ampliada.** Un fallo nuestro pasa a afectar a los usuarios de otros. Antes de
  abrir el SDK a terceros: auditoría y multifirma con retardo.
- **Seguridad del destino.** El SDK debe impedir que un socio, o un atacante que lo suplante, cambie
  la dirección de destino. La bóveda siempre se deriva de la llave del usuario, nunca se acepta como
  parámetro libre.
- **Dependencia de la operación.** Si nuestro vigilante se para, el ahorro de los socios se acumula
  sin invertirse. No se pierde dinero, el usuario siempre puede retirar, pero el producto se ve roto.
  Necesita monitorización real antes de tener socios.

## 8. Recomendación

1. **Esta semana, nada de esto.** La entrega del hackathon es el viernes. Como mucho, una línea en la
   candidatura: la arquitectura permite que cualquier terminal añada el ahorro dentro del trade.
2. **Después del hackathon, en este orden:** vigilante que invierte bóvedas sin vínculo, paquete
   `@saverfi/sdk` con la instrucción de ahorro y los constructores que ya existen, y nuestra web
   usando ese mismo SDK. Son 1-2 semanas y no tocan el programa.
3. **Solo con un primer socio interesado:** comisión y reparto en el programa, instrucción exacta
   para ventas, auditoría y multifirma.

La idea es buena precisamente porque convierte a SaverFi de una aplicación en una pieza que otros
montan, y porque la versión integrable resulta ser más simple y más exacta que la que tenemos.

## Fuentes

- Código: `packages/solana-program/programs/sip-vault/src/instructions/` (create_vault, link_wallet,
  wrap_sol), `packages/solana-keeper/src/discovery.ts`, `packages/solana-core`.
- Axiom y Turnkey: https://www.turnkey.com/customers/axiom-global-defi-trading-platform
- Comisiones de integrador en Jupiter: https://dev.jup.ag/docs/swap-api/add-fees-to-swap
- API de socios de Acorns: https://developer.acorns.com/
- Restricciones de xStocks: https://blockeden.xyz/blog/2025/09/03/xstocks-on-solana-a-developer-s-field-guide-to-tokenized-equities/
