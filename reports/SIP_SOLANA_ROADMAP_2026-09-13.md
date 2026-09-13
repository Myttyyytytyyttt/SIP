# Rumbo a Stocklana

**Hoja de ruta · redactada el domingo 13 de septiembre de 2026, 17:15 Lisboa · revisado 18:00 (una wallet de administración)** · entrega **viernes 18-sept 21:00 Lisboa (16:00 ET)**
**Basada en** `reports/SIP_SOLANA_BACKEND_ASSESSMENT_2026-09-13.md`. Versión viva y marcable: (enlace al publicar)

En cinco días llevamos SIP a Solana y lo entregamos en Stocklana. La base es el sistema que ya funcionó en mainnet con Nuvem: lo copiamos a SIP con dirección nueva y una sola wallet de administración, le enseñamos a cobrar por beneficio o por volumen sin poder confundirlos, y conectamos la web actual a Solana. Hoy, antes de nada, se cierra la puerta del programa viejo, porque una llave pegada en un chat controla 22 SOL de otra persona. Tú haces lo que solo tú puedes hacer: crear tu wallet de administración, poner SOL, firmar, contratar servicios, operar en Axiom y grabar el vídeo. Yo escribo el programa, el vigilante, la web y los textos. El alcance completo eran unas 200 horas de código y no cabe: esto es el recorte, y lo que no entra está abajo, en Después. Cada día acaba con un control, y si el modo volumen no está listo el miércoles, la demo va solo por beneficio sin tocar nada de la seguridad.

## Lo que depende de ti

Hasta que esto esté hecho, Claude no puede avanzar en lo que bloquea.

| hora límite | qué | bloquea |
|---|---|---|
| hoy · 21:00 | Crear tu wallet de administración en Terminal.app y pasarme solo su dirección pública | quitar el mando del programa viejo y todo el despliegue |
| hoy · 22:00 | Pasar el mando del programa viejo a tu wallet de administración y rescatar sus 3,24 SOL | publicar cualquier cosa; protege los 22 SOL de otra persona |
| hoy · 22:00 | Revocar el token de Railway, la firma vieja de Privy y la clave de Helius de este Mac | guardar cualquier secreto nuevo |
| lun · 12:00 | Contratar Helius Developer y crear dos claves, sin pegarlas en el chat | que el vigilante y la web lean Solana |
| lun · 12:00 | Aprobar la cesta (S&P 500) y las tasas de la demo | la configuración por defecto de las bóvedas |
| lun · 13:00 | Inscribirte en Stocklana y preguntar si vale partir de Nuvem declarándolo | el README y el formulario |
| lun · 18:00 | En Privy: activar Solana y el modo TEE en la app de SIP | entrar con Phantom y crear wallets de trading |
| lun · 21:00 | Una compra y una venta en Axiom, GMGN y pump.fun con 0,3 SOL; pásame solo las 6 firmas | probar el medidor de volumen con operaciones reales |
| mar · 12:00 | Unos 5 SOL en la wallet de administración; crear la wallet de cobro con 0,5 SOL | publicar el programa y configurar el vigilante |
| mar · 18:00 | Crear la llave de firma y la regla de Privy; pegar tú las variables del keeper en Railway | el primer cobro |
| mié · 12:00 | Dos cuentas de Phantom de demo y ~2 SOL para operar | las bóvedas de la demo y las operaciones grabadas |

## Día a día

### Domingo 13

**Objetivo:** Cerrar la puerta del programa viejo y tener el esqueleto de SIP en Solana.

**Tú** · 2 h

- [ ] **Crear tu wallet de administración** (0.5 h · **imprescindible**) — Creas una única wallet nueva en Terminal.app; publica, actualiza y configura el programa durante el hackathon. Me pasas solo su dirección pública.
- [ ] **Quitar el mando del programa viejo** (0.5 h · **imprescindible**) — Firmas una transacción que pasa el control de actualización del programa viejo a tu wallet de administración nueva.
- [ ] **Sacar los 3,24 SOL de la llave filtrada** (0.25 h · **imprescindible**) — Mueves el SOL de la llave filtrada a tu wallet de administración, dejando 0,03 SOL para los dos pasos que faltan.
- [ ] **Apagar el keeper y el atestador viejos** (0.25 h · **imprescindible**) — Ejecutas el guion: el programa viejo se queda sin robot y deja de aceptar la firma filtrada.
- [ ] **Revocar los tokens pegados en chats** (0.5 h · **imprescindible**) — Revocas el token de Railway y la firma vieja de Privy de Nuvem, y rotas la clave de Helius guardada en este Mac.

**Claude** · 6.5 h

- [ ] **Candados para que ninguna clave pase por el chat** (1.5 h · **imprescindible**) — Bloqueo a Claude la carpeta donde guardarás tus llaves y dejo escritas las reglas, antes de que exista ninguna.
- [ ] **Guion para apagar el keeper y el atestador viejos** (1 h · **imprescindible**) — Escribo un único comando que apaga el robot del programa viejo y cambia su firma de cobros.
- [ ] **Copiar el programa de Nuvem a SIP** (4 h · **imprescindible**) — Traigo a SIP el programa que ya funcionó en Solana, con su nombre nuevo y sin arrastrar llaves viejas.

**Control del día:** La cadena muestra tu wallet de administración como autoridad del programa viejo, y el programa copiado compila en SIP.  
**Si no se cumple:** Si la rotación no está hecha, nada se publica y es lo primero del lunes. Si no compila, el lunes empieza por ahí y el vigilante espera.

### Lunes 14

**Objetivo:** Programa con los dos modos escrito y probado en local; cuentas contratadas; operaciones reales grabadas.

**Tú** · 3.25 h

- [ ] **Contratar Helius y crear dos claves** (0.5 h · **imprescindible**) — Contratas Helius Developer y creas una clave para el vigilante y otra para la web, sin pegarlas en el chat.
- [ ] **Preparar Privy para Solana** (0.5 h · **imprescindible**) — En el panel de Privy activas Solana y el modo TEE, y confirmas que es la app de SIP y no la de Nuvem.
- [ ] **Inscribirte y preguntar por el código previo** (0.75 h · **imprescindible**) — Te inscribes en Stocklana, miras el formulario sin enviarlo y preguntas si vale partir de Nuvem declarándolo.
- [ ] **Aprobar la cesta y las tasas de la demo** (0.5 h · juntos) — Decides que la demo compra el S&P 500 (SPYx) desde 1 $, con tasas de demo visibles en pantalla: volumen 1 % y beneficio 50 %.
- [ ] **Operar para grabar operaciones reales** (1 h) — Con una cartera nueva y 0,3 SOL haces una compra y una venta en Axiom, GMGN y pump.fun, y me pasas solo las firmas.

**Claude** · 31.5 h

- [ ] **Poner la dirección nueva del programa** (1 h · **imprescindible**) — Genero la dirección del programa nuevo y compruebo que nada apunta al programa viejo.
- [ ] **Solo tú configuras el programa** (5 h · **imprescindible**) — Solo tu wallet de administración puede configurar el programa la primera vez, el mando se traspasa en dos pasos y hay una pausa general.
- [ ] **La bóveda cobra por beneficio o por volumen, sin confusión** (7 h · **imprescindible**) — Cada bóveda guarda su modo y su tasa, y un cobro firmado para otro modo, otra tasa o una configuración anterior se rechaza.
- [ ] **La inversión solo acepta la moneda acordada** (2 h · **imprescindible**) — La compra de acciones solo puede usar la moneda que firmó el dueño.
- [ ] **Traer el vigilante a SIP** (7 h · **imprescindible**) — Traigo de Nuvem el proceso que cobra, como pieza propia de SIP, capaz de arrancar en seco sin ninguna clave secreta.
- [ ] **La web aprende a hablar con Solana** (8 h · **imprescindible**) — Traigo a la web la pieza que lee Solana, una puerta propia hacia el nodo y los permisos del navegador, sin exponer ninguna clave.
- [ ] **Escribir la regla del vigilante en Privy** (1.5 h · **imprescindible**) — Escribo el script que crea en Privy la regla que solo deja al vigilante firmar cobros de SIP.

**Control del día:** Pruebas en verde para modos, límites, configuración protegida y moneda fija; Helius y Privy listos; 6 firmas reales guardadas.  
**Si no se cumple:** El plan B se decide el martes a las 13:00 en vez del miércoles.

### Martes 15

**Objetivo:** Programa nuevo publicado en Solana y el vigilante funcionando en seco contra él.

**Tú** · 5.75 h

- [ ] **Decidir: dos modos o volumen bloqueado** (0.25 h · juntos) — A las 13:00 miramos las pruebas: si volumen no está en verde, el programa sale con volumen bloqueado.
- [ ] **Crear la wallet de cobro** (0.25 h · **imprescindible**) — Creas una segunda wallet que firmará los cobros y pagará las comisiones del vigilante, y le pones 0,5 SOL.
- [ ] **Poner el SOL para publicar el programa** (0.25 h · **imprescindible**) — Pones unos 5 SOL en tu wallet de administración para publicar el programa.
- [ ] **Publicar el programa en Solana** (3 h · **imprescindible** · juntos) — Publicas el programa con tu wallet de administración, lo configuras y compruebo que lo publicado es exactamente lo probado.
- [ ] **Crear la llave de firma y la regla en Privy** (1 h · **imprescindible**) — Creas en Privy la llave del vigilante, ejecutas el script de la regla y me pasas solo los dos ids.
- [ ] **Pegar las variables del vigilante en Railway** (1 h · **imprescindible**) — Creas el servicio del vigilante en Railway, cambias la contraseña de la base de datos y pegas tú las variables.

**Claude** · 18 h

- [ ] **Todas las pruebas en verde y revisión** (6 h · **imprescindible**) — Paso todas las pruebas del programa y una revisión de código antes de publicar nada.
- [ ] **El vigilante cobra con la regla de cada modo** (6 h · **imprescindible**) — El vigilante lee el modo y la tasa de cada bóveda, construye el cobro nuevo y no cobra si no vio todo el tramo.
- [ ] **Entrar con Phantom y crear wallets de trading** (6 h · **imprescindible**) — Entras con Phantom como llave de pensión y creas wallets de trading que nacen con el permiso del vigilante y se pueden exportar a Axiom.

**Control del día:** 13:00: pruebas del programa en verde, o plan B. Por la noche: el programa está en mainnet, coincide con lo probado y el vigilante arranca sin ninguna clave secreta.  
**Si no se cumple:** Si no se publica el martes, el miércoles se publica con volumen bloqueado y la web trabaja con esa versión.

### Miércoles 16

**Objetivo:** Primer cobro real en cada modo y la web creando bóvedas.

**Tú** · 5 h

- [ ] **Preparar las wallets de la demo** (0.75 h) — Creas dos cuentas de Phantom como llaves de pensión, una por modo, con 0,05 SOL cada una, y reservas ~2 SOL para operar.
- [ ] **Ensayo en seco contra mainnet** (1.5 h · juntos) — Con las bóvedas de demo creadas, el vigilante calcula lo que cobraría sin mover nada, y lo comparamos a mano.
- [ ] **Encender el cobro real, uno por modo** (2.5 h · juntos) — Armas el vigilante en Railway y operas desde las wallets de demo hasta ver un cobro real en cada modo y una compra de SPYx.
- [ ] **Decidir: ¿enseñamos volumen?** (0.25 h · juntos) — A las 14:00, si no hay un cobro real en modo volumen, la demo va solo por beneficio.

**Claude** · 23 h

- [ ] **Medir cuánto se compra y se vende** (9 h) — El vigilante calcula el volumen de cada operación real, contando el SOL envuelto y sin cobrar comisiones ni alquileres.
- [ ] **El vigilante funciona solo y avisa** (5 h) — Invierte en tramos que puede adelantar, avisa si algo falla, dice la verdad en /health y guarda su historial.
- [ ] **Crear la bóveda, vincular, elegir acción y retirar** (9 h · **imprescindible**) — Desde la web creas tu bóveda eligiendo beneficio o volumen, vinculas la wallet de trading, eliges la acción y puedes sacar el dinero.

**Control del día:** 14:00: existe un cobro real en modo volumen en mainnet, o plan B. Por la noche: desde la web se crea una bóveda, se vincula una wallet y se elige la acción.  
**Si no se cumple:** Plan B: la bóveda de demo va solo por beneficio y el jueves por la mañana se remata la web.

### Jueves 17

**Objetivo:** Recorrido completo en la web pública, ensayo general y vídeo grabado.

**Tú** · 12 h

- [ ] **Recorrido completo en la web pública** (3 h · juntos) — Hacemos el camino entero en la web pública: operar, apartar, cobrar y comprar, cronometrado.
- [ ] **Ensayo general y grabación** (5 h) — A las 15:00 hacemos el ensayo general y lo grabas; por la noche pones la voz.
- [ ] **Copia pública y limpia del código** (4 h · juntos) — Escaneo el historial en busca de secretos y publico una copia limpia sin informes internos.

**Claude** · 14.25 h

- [ ] **Tu pensión real en el panel** (5 h) — El modo Live enseña tu bóveda de Solana: lo apartado, los cobros, las acciones compradas y su precio real.
- [ ] **Portada de Solana y web pública** (4 h) — La portada habla de Solana y acciones, se quita el vídeo de otra marca y la web queda en una dirección pública.
- [ ] **README, linaje, avisos y guion** (5 h) — Escribo el README de una pantalla, de dónde viene cada pieza, los avisos honestos, el guion del vídeo y el texto del formulario.
- [ ] **Congelar el código** (0.25 h) — A las 23:00 no entra más código, salvo arreglos de una demo rota.

**Control del día:** Operación real, apartado y compra de SPYx visibles en la web pública con enlace a Solscan, y el vídeo grabado. Código congelado a las 23:00.  
**Si no se cumple:** Se graba solo lo que funcionó con transacciones reales y lo que falta se explica en los avisos. Nunca se enseña el ejemplo como si fuera real.

### Viernes 18

**Objetivo:** Revisar, enviar con margen y vigilar.

**Tú** · 2.5 h

- [ ] **Revisar el vídeo imagen a imagen** (1.5 h · juntos) — Revisamos cada cambio de escena buscando cualquier secreto en pantalla y lo subes como oculto.
- [ ] **Enviar la candidatura** (1 h) — Envías la candidatura con la web, el vídeo y, si salió limpio, el repo.

**Claude** · 1 h

- [ ] **Vigilar la demo tras el envío** (1 h) — Compruebo que la web y el vigilante siguen vivos después de enviar.

**Control del día:** Candidatura enviada antes de las 18:00 con la web, el vídeo y, si salió limpio, el repo.  
**Si no se cumple:** El cierre es a las 21:00. Si algo se rompe, se envía con la web y el vídeo, que ya bastan.

## Plan B: si vamos tarde

**Cuándo se activa:** El martes 15 a las 13:00 el programa no pasa las pruebas con volumen, o el miércoles 16 a las 14:00 no existe un cobro real en modo volumen en mainnet.

**Se aparca:** Medir cuánto se compra y se vende; Decidir: ¿enseñamos volumen?; La bóveda de demo en modo volumen; La segunda acción de la cesta; Copia pública y limpia del código

**No se toca nunca:** Quitar el mando del programa viejo; Crear tu wallet de administración; Poner la dirección nueva del programa; Solo tú configuras el programa; Candados para que ninguna clave pase por el chat; La wallet de administración nunca en un servidor ni en el chat; El tope por cobro y poder retirar siempre

> SIP en Solana funciona de punta a punta en mainnet por beneficio. El programa ya distingue los dos modos, y el de volumen está bloqueado a propósito hasta que su medidor pase las pruebas con operaciones reales de Axiom, GMGN y pump.fun.

## Dinero

**Total:** ≈ 8 SOL en mano · ≈ 3 SOL gastados

- Publicar el programa: 2,81 SOL de alquiler que quedan bloqueados mientras exista (binario de 552,200 bytes el 13-sep, ya con los dos modos y la moneda fija; se mide otra vez antes de publicar). Cada actualización pide otro tanto de forma temporal para el buffer, que vuelve al terminar. Ten unos 5,90 SOL en la wallet de administración el martes.
- Wallet de cobro (atestador y crank): 0,5 SOL para las comisiones de cobros e inversiones de la semana.
- Operaciones grabadas del lunes: 0,3 SOL en una cartera nueva; vuelve casi todo.
- Dos llaves de pensión de demo: 2 × 0,05 SOL.
- Wallets de trading de demo: ~2 SOL de capital recuperable y 0,05–0,15 SOL de comisiones de Axiom y GMGN.
- Lo apartado en las bóvedas de demo sigue siendo tuyo: se retira al final.
- El rescate de la llave filtrada aporta 3,24 SOL: casi toda la parte temporal del despliegue.

**Servicios al mes:** Helius Developer 49 $ al mes. Railway y Supabase en tu plan actual; Privy sin coste nuevo. Referencia: SOL ≈ 100 $ el 13-sept; las cantidades se revisan el miércoles.

## Riesgos

| riesgo | prob. | impacto | qué hacemos | señal temprana |
|---|---|---|---|---|
| La wallet de administración se expone | baja | alto | Solo en tu ordenador: nunca en el chat, en Railway ni en capturas. El traspaso en dos pasos permite moverla a multifirma sin redesplegar. | Cualquier transacción de esa wallet que no hayas firmado tú. |
| El programa no queda en verde a tiempo | media | alto | Plan B: el mismo programa con volumen bloqueado, sin tocar la seguridad. | El lunes por la noche las pruebas de dos modos siguen en rojo. |
| Privy no deja firmar el cobro con la regla nueva | media | alto | Probar la regla el martes con los tres rechazos y un cobro en seco antes de armar. | Error de política en signAndSendTransaction durante el ensayo en seco. |
| Phantom avisa o se niega a firmar el vínculo con un programa nuevo | media | medio | Ensayarlo el miércoles por la mañana; alternativa: vincular desde un guion firmado por las dos llaves. | Aviso de transacción sospechosa en Phantom. |
| El medidor de volumen cobra de más o de menos | media | alto | Fixtures de operaciones reales, rechazos fuera de la base y tasa de demo visible en pantalla. | Una de las 6 operaciones grabadas no cuadra al lamport. |
| El despliegue falla a mitad | baja | medio | Buffer con archivo propio para reanudar con el mismo comando y margen de SOL. | Error de escritura o de saldo durante solana program deploy. |
| Un secreto aparece en el vídeo, el repo o un log | baja | alto | Llaves creadas fuera del alcance de Claude, escaneo de secretos y revisión del vídeo fotograma a fotograma. | El escáner o la revisión encuentran cualquier cadena de clave. |
| Publicar algo antes de cerrar el programa viejo | baja | alto | Nada es público hasta que la cadena muestre la llave fría como autoridad del programa viejo. | El jueves la comprobación del programa viejo no está en verde. |
| Helius se queda sin créditos | baja | medio | Barrido de 60 s e inversión solo después de un cobro. | El panel de Helius supera el 30 % de créditos a mitad de semana. |

## Después del viernes

- [ ] **Guardar la deuda para cobrarla después** (Claude, 12 h) — Si una wallet está vacía al cobrar, lo pendiente queda anotado en la cadena y se cobra más tarde.
- [ ] **Multifirma para actualizar el programa** (Juntos, 6 h) — El mando del programa pasa de tu wallet de administración a una multifirma con retraso de 24 horas.
- [ ] **Separar comisiones por plataforma** (Claude, 8 h) — El medidor separa la comisión del venue y los tips en cada plataforma.
- [ ] **Unir el vigilante de Solana y el worker de Ethereum** (Claude, 16 h) — Un solo paquete con dos adaptadores de cadena, dos procesos y una base de datos.
- [ ] **Enterarse de las operaciones al momento** (Claude, 8 h) — El vigilante recibe cada operación en cuanto ocurre en lugar de preguntar cada minuto.
- [ ] **Importar tu propia clave con el permiso del vigilante** (Claude, 4 h) — Importas una clave que ya usabas y queda cobrable desde el primer segundo.
- [ ] **Avisar al dueño de los 22 SOL y cerrar el programa viejo** (Juntos, 2 h) — Se avisa al dueño de esa bóveda para que retire, y cuando esté vacía se cierra el programa y vuelven 3,33 SOL.
- [ ] **Precio de compra sin recorrer 60 transacciones** (Claude, 4 h) — El precio de compra sale del propio pool contrastado con Jupiter, en segundos.
- [ ] **Rotar las credenciales de servicio tras el concurso** (Tú, 1.5 h) — Cambias las claves de Helius, Privy y Railway usadas durante la semana, y las de Ethereum que se pegaron en chats.
- [ ] **Mantener la demo viva hasta el 2 de octubre** (Juntos, 1.5 h) — La web y el vigilante siguen funcionando mientras los jueces evalúan.

## Supuestos

- Durante el hackathon una sola wallet de administración publica, actualiza y configura el programa; la de cobro va aparte porque vive en Railway. Separar más papeles y la multifirma quedan para después.
- Ethereum queda en pausa: su código sigue en el repo, sin servicio desplegado.
- El trabajo de Claude suma unas 93 horas: solo cabe trabajando en paralelo en programa, vigilante y web, y recortando todo lo que está en Después.
- Tú tienes unas 3 o 4 horas al día para lo tuyo, más el jueves por la tarde para el ensayo y el vídeo.
- La app de Privy es la de SIP, no la de Nuvem, y admite el modo TEE.
- La web y el vigilante se sirven desde Railway, junto a la base de Supabase en eu-west-1.
- Stocklana admite partir de código anterior si se declara; se confirma el lunes.

## Glosario

- **Programa** — El código que vive en Solana y guarda las reglas del ahorro; nadie puede saltárselas.
- **Bóveda** — La cuenta donde se acumula tu ahorro; solo tu llave de pensión puede sacar dinero.
- **Llave de pensión** — Tu wallet principal (Phantom). Es la dueña de la bóveda.
- **Wallet de trading** — La wallet con la que operas en Axiom o GMGN; de ahí sale lo apartado.
- **Wallet de cobro** — La segunda wallet: firma los cobros y paga las comisiones del vigilante desde Railway.
- **Vigilante (keeper)** — El proceso que mira tus operaciones, calcula lo que toca apartar y lo cobra.
- **Atestador** — La llave que firma cuánto operó una wallet; el programa solo acepta cobros con esa firma.
- **Asiento de Privy** — El permiso limitado que deja al vigilante firmar solo cobros de SIP con tu wallet de trading.
- **Autoridad de actualización** — La llave que puede cambiar el programa. En el hackathon es tu wallet de administración, y nunca va a un servidor.
- **Modo beneficio y modo volumen** — Apartar un porcentaje de lo que ganas, o de cada compra y venta.
- **xStocks** — Acciones tokenizadas; SPYx sigue al S&P 500. Su emisor puede congelarlas, y se dice.
- **Mainnet** — La red real de Solana, con dinero real.
- **En seco** — El vigilante calcula lo que haría sin mover dinero.

---

## Anexo — Todas las tareas, con el detalle técnico

### Domingo 13

#### `candados-secretos` — Candados para que ninguna clave pase por el chat

- **Quién:** Claude · **horas:** 1.5 · **nivel:** Imprescindible · **depende de:** —
- **Qué:** Bloqueo a Claude la carpeta donde guardarás tus llaves y dejo escritas las reglas, antes de que exista ninguna.
- **Por qué:** Todo el problema del programa viejo empezó con una llave pegada en un chat.
- **Listo cuando:** La guía está en el repo y un intento de Claude de leer tu carpeta de llaves es denegado.
- **Técnico:** permissions.deny en .claude/settings.json para ~/sip-keys/** (herramientas Read y Edit). Guía: crear llaves en Terminal.app, nunca en el panel de terminal de la app de Claude, que Claude puede leer. Compartir solo la salida de solana-keygen pubkey. El candado cubre las herramientas de lectura; la garantía real es que Claude nunca toca esa carpeta.

#### `llaves-nuevas` — Crear tu wallet de administración

- **Quién:** Tú · **horas:** 0.5 · **nivel:** Imprescindible · **depende de:** `candados-secretos`
- **Qué:** Creas una única wallet nueva en Terminal.app; publica, actualiza y configura el programa durante el hackathon. Me pasas solo su dirección pública.
- **Por qué:** El programa nuevo no puede nacer con ninguna llave que haya pasado por un chat.
- **Listo cuando:** Tengo la dirección pública y la clave privada no ha salido de tu ordenador.
- **Técnico:** ~/sip-keys/admin.json = deployer + autoridad de upgrade + autoridad de config. La dirección del programa la genera anchor en target/deploy/sip_vault-keypair.json, ignorado por git: no es una wallet, no guarda dinero y no firma nada después del despliegue. La wallet de cobro va aparte y se crea el martes.

#### `viejo-rotar-upgrade` — Quitar el mando del programa viejo

- **Quién:** Tú · **horas:** 0.5 · **nivel:** Imprescindible · **depende de:** `llaves-nuevas`
- **Qué:** Firmas una transacción que pasa el control de actualización del programa viejo a tu wallet de administración nueva.
- **Por qué:** Con la llave filtrada, cualquiera puede cambiar el programa y llevarse los 22 SOL de otra persona. Esto lo impide para siempre.
- **Listo cuando:** solana program show muestra tu wallet de administración como Authority.
- **Técnico:** solana program set-upgrade-authority 7rtgXTu852M1NTx7PLoJd3bChaCb2hgsgv5o54aFv6Fy --new-upgrade-authority ~/sip-keys/admin.json -k <keypair de 6Nqw> -u m. La nueva autoridad firma porque se pasa como archivo. Impide reemplazar el programa; 6Nqw sigue siendo autoridad de config porque no existe traspaso.

#### `viejo-rescatar-sol` — Sacar los 3,24 SOL de la llave filtrada

- **Quién:** Tú · **horas:** 0.25 · **nivel:** Imprescindible · **depende de:** `viejo-rotar-upgrade`
- **Qué:** Mueves el SOL de la llave filtrada a tu wallet de administración, dejando 0,03 SOL para los dos pasos que faltan.
- **Por qué:** Es tu dinero en una llave que ya no es secreta, y cubre buena parte del despliegue.
- **Listo cuando:** La llave 6Nqw queda con unos 0,02 SOL.
- **Técnico:** solana transfer <pubkey admin> 3.24 -k <keypair de 6Nqw> -u m --allow-unfunded-recipient. Saldo leído el 13-sept: 3,27 SOL.

#### `viejo-guion` — Guion para apagar el keeper y el atestador viejos

- **Quién:** Claude · **horas:** 1 · **nivel:** Imprescindible · **depende de:** —
- **Qué:** Escribo un único comando que apaga el robot del programa viejo y cambia su firma de cobros.
- **Por qué:** No existe script para cambiar el atestador, y hacerlo a mano en mainnet invita a errores.
- **Listo cuando:** El guion existe y su simulación contra mainnet pasa sin enviar nada.
- **Técnico:** Nuvem scripts/mainnet-set-attester.ts: una transacción con setKeeper(11111111111111111111111111111111) y setAttester(<pubkey sin secreto>), firmada por 6Nqw, con lectura de comprobación del config fajZdg1x.

#### `viejo-apagar` — Apagar el keeper y el atestador viejos

- **Quién:** Tú · **horas:** 0.25 · **nivel:** Imprescindible · **depende de:** `viejo-guion`, `viejo-rotar-upgrade`
- **Qué:** Ejecutas el guion: el programa viejo se queda sin robot y deja de aceptar la firma filtrada.
- **Por qué:** Higiene: sin esto el keeper viejo podría volver a mover dinero de ese vault.
- **Listo cuando:** La cadena muestra keeper = 1111… y un atestador distinto de 9vCz….
- **Técnico:** Reversible por quien tenga 6Nqw, porque la autoridad de config no se puede traspasar. El robo ya lo cerró el paso anterior; esto evita el ruido.

#### `revocar-tokens` — Revocar los tokens pegados en chats

- **Quién:** Tú · **horas:** 0.5 · **nivel:** Imprescindible · **depende de:** —
- **Qué:** Revocas el token de Railway y la firma vieja de Privy de Nuvem, y rotas la clave de Helius guardada en este Mac.
- **Por qué:** Antes de guardar secretos nuevos, los viejos expuestos tienen que dejar de funcionar.
- **Listo cuando:** Los tres tokens viejos dan error al usarse.
- **Técnico:** Railway → Account → Tokens (86b3da4d…). Privy de Nuvem: borrar la authorization key del quorum z7o077ltns7039j5g0br4y57. Helius: rotar la key c18b6b94… y quitarla de ~/.config/solana/cli/config.yml.

#### `programa-copia` — Copiar el programa de Nuvem a SIP

- **Quién:** Claude · **horas:** 4 · **nivel:** Imprescindible · **depende de:** —
- **Qué:** Traigo a SIP el programa que ya funcionó en Solana, con su nombre nuevo y sin arrastrar llaves viejas.
- **Por qué:** Partimos de código probado en mainnet en vez de empezar de cero.
- **Listo cuando:** anchor build compila en SIP y el commit de renombrado no cambia ninguna lógica.
- **Técnico:** packages/solana-program, crate sip-vault, módulo sip_vault. Commit de renombrado puro como base de revisión. Sin toy_venue en el despliegue. Cargo.lock copiado. Wallet de localnet generada por Claude en .localnet/ (ignorada por git).

### Lunes 14

#### `programa-direccion` — Poner la dirección nueva del programa

- **Quién:** Claude · **horas:** 1 · **nivel:** Imprescindible · **depende de:** `programa-copia`
- **Qué:** Genero la dirección del programa nuevo y compruebo que nada apunta al programa viejo.
- **Por qué:** Un programa con la dirección vieja heredaría la llave filtrada.
- **Listo cuando:** Ninguna referencia a 7rtg… en el programa y las pruebas corren con la dirección nueva.
- **Técnico:** Dirección del programa: 6kA9H9zQT6PW5xWkXoAFCS3NotxarzaYqj66mjMf9w4J, generada por anchor en target/deploy (ignorado por git; solo se lee su clave pública). declare_id!, Anchor.toml e IDL sincronizados; ningún archivo fuera de target/ nombra 7rtgXTu8.

#### `programa-mando-seguro` — Solo tú configuras el programa

- **Quién:** Claude · **horas:** 5 · **nivel:** Imprescindible · **depende de:** `programa-direccion`
- **Qué:** Solo tu wallet de administración puede configurar el programa la primera vez, el mando se traspasa en dos pasos y hay una pausa general.
- **Por qué:** El programa viejo lo configuraba el primero que llegara y su mando no se podía traspasar.
- **Listo cuando:** Pruebas: otra wallet no puede configurarlo, el traspaso exige aceptar, y en pausa no se cobra pero sí se retira.
- **Técnico:** init_config gateado por ProgramData.upgrade_authority_address. ProtocolConfig v2: primeros 105 bytes idénticos + pending_authority, paused, version y 64 reservados = 203 B. transfer_authority y accept_authority. En el hackathon los papeles pueden coincidir; el traspaso en dos pasos permite separarlos después sin redesplegar.

#### `programa-dos-modos` — La bóveda cobra por beneficio o por volumen, sin confusión

- **Quién:** Claude · **horas:** 7 · **nivel:** Imprescindible · **depende de:** `programa-direccion`
- **Qué:** Cada bóveda guarda su modo y su tasa, y un cobro firmado para otro modo, otra tasa o una configuración anterior se rechaza.
- **Por qué:** Es el error que casi cobró 100 veces de más en la versión de Ethereum.
- **Listo cuando:** Pruebas en verde: modo cruzado, tasa cruzada, configuración vieja y fecha vencida rechazados; el tope recorta y un cobro de cero avanza.
- **Técnico:** Vault sigue en 125 B tallando _reserved: skim_mode u8, volume_bps u16 (1..100), policy_nonce u64, max_contribution u64, wallet_reserve u64. PROFIT con mínimo 101 bps para que las cotas no se solapen. Solo instrucciones V2: create_vault_v2, set_policy_v2 (el nonce sube siempre), settle_v2 con mensaje SIP_SETTLE_V2 (modo, bps, nonce, valid_until_slot, base) reconstruido desde la bóveda. Tope recorta, reserva rechaza, base = 0 avanza la frontera. Deuda arrastrada queda para después.

#### `programa-moneda-fija` — La inversión solo acepta la moneda acordada

- **Quién:** Claude · **horas:** 2 · **nivel:** Imprescindible · **depende de:** `programa-direccion`
- **Qué:** La compra de acciones solo puede usar la moneda que firmó el dueño.
- **Por qué:** Hoy un keeper comprometido podría meter el dinero de la bóveda por un pool basura.
- **Listo cuando:** Prueba: invertir desde otra moneda o convertir hacia otra falla con WrongInMint.
- **Técnico:** InvestmentPolicy pasa a 970 B con in_mint (USDC por defecto); constraint vault_in.mint == policy.in_mint en convert.rs e invest.rs. Defaults: 1 $ por acción, 50 $ por llamada, 500 $ cada 30 días.

#### `helius` — Contratar Helius y crear dos claves

- **Quién:** Tú · **horas:** 0.5 · **nivel:** Imprescindible · **depende de:** `revocar-tokens`
- **Qué:** Contratas Helius Developer y creas una clave para el vigilante y otra para la web, sin pegarlas en el chat.
- **Por qué:** El vigilante necesita un nodo con todo el historial y sin límites bajos.
- **Listo cuando:** Me dices Helius listo; las claves solo existen en tu gestor y en Railway.
- **Técnico:** Plan Developer, 49 $/mes, 10 M créditos, 50 rps, historial completo. Claves sip-keeper y sip-web, las dos solo de servidor: el navegador pasa por /api/solana-rpc.

#### `privy-solana` — Preparar Privy para Solana

- **Quién:** Tú · **horas:** 0.5 · **nivel:** Imprescindible · **depende de:** —
- **Qué:** En el panel de Privy activas Solana y el modo TEE, y confirmas que es la app de SIP y no la de Nuvem.
- **Por qué:** Sin esto no se pueden crear wallets de trading de Solana con el permiso del vigilante.
- **Listo cuando:** Me pasas el App ID (es público) y confirmas el modo TEE.
- **Técnico:** Login methods y Embedded wallets con Solana; TEE mode (lo exige importWallet con additionalSigners); comprobar que no hay un DENY de exportación a nivel de wallet, porque impediría llevar la clave a Axiom.

#### `stocklana-reglas` — Inscribirte y preguntar por el código previo

- **Quién:** Tú · **horas:** 0.75 · **nivel:** Imprescindible · **depende de:** —
- **Qué:** Te inscribes en Stocklana, miras el formulario sin enviarlo y preguntas si vale partir de Nuvem declarándolo.
- **Por qué:** Si no se permite, cambia lo que se puede presentar.
- **Listo cuando:** Tengo capturas de los campos del formulario y la pregunta enviada.
- **Técnico:** La página pública pide trabajo original y permite componentes open source declarados; confirmar fecha oficial de inicio y si la candidatura se puede editar tras enviarla.

#### `cesta-y-tasas` — Aprobar la cesta y las tasas de la demo

- **Quién:** Juntos · **horas:** 0.5 · **nivel:** Para la demo · **depende de:** —
- **Qué:** Decides que la demo compra el S&P 500 (SPYx) desde 1 $, con tasas de demo visibles en pantalla: volumen 1 % y beneficio 50 %.
- **Por qué:** Con las tasas normales (0,20 % y 20 %) la demo necesitaría cientos de dólares de operaciones para llegar a 1 $.
- **Listo cuando:** Confirmación tuya por escrito.
- **Técnico:** SPYx en el pool Raydium CLMM 6truu3rZ; NVDAx (49iMat) como segunda acción solo si su pool pasa ese día; SOL a USDC por 3ucNos4N. Las tasas del producto siguen siendo 20 % y 0,20 %.

#### `fills-reales` — Operar para grabar operaciones reales

- **Quién:** Tú · **horas:** 1 · **nivel:** Para la demo · **depende de:** —
- **Qué:** Con una cartera nueva y 0,3 SOL haces una compra y una venta en Axiom, GMGN y pump.fun, y me pasas solo las firmas.
- **Por qué:** El medidor de volumen se prueba con operaciones reales de cada plataforma, y hoy no hay ninguna grabada.
- **Listo cuando:** Tengo 6 firmas de transacciones confirmadas.
- **Técnico:** Cartera distinta de las de demo. Claude extrae los fixtures con getTransaction y fija el volumen esperado al lamport.

#### `keeper-traer` — Traer el vigilante a SIP

- **Quién:** Claude · **horas:** 7 · **nivel:** Imprescindible · **depende de:** `programa-copia`
- **Qué:** Traigo de Nuvem el proceso que cobra, como pieza propia de SIP, capaz de arrancar en seco sin ninguna clave secreta.
- **Por qué:** El de Nuvem exige los secretos incluso para probar, y así no se puede ensayar sin exponerlos.
- **Listo cuando:** Arranca en seco contra mainnet sin atestador ni crank, y /status responde.
- **Técnico:** packages/solana-keeper (~3.140 líneas portadas, no un adaptador del worker EVM). Secretos solo tras BROADCAST y el centinela. Reutiliza el Redactor del worker. Candado de Postgres sip-solana-keeper. Variables SIP_SOLANA_* sin alias NUVEM_. Rechaza el program id viejo.

#### `web-solana-base` — La web aprende a hablar con Solana

- **Quién:** Claude · **horas:** 8 · **nivel:** Imprescindible · **depende de:** —
- **Qué:** Traigo a la web la pieza que lee Solana, una puerta propia hacia el nodo y los permisos del navegador, sin exponer ninguna clave.
- **Por qué:** La web de SIP hoy solo sabe de Ethereum.
- **Listo cuando:** Build de producción en verde con Solana activo y la consola sin errores de permisos.
- **Técnico:** packages/solana-core como @sip/solana-core. SIP_CHAIN=solana con configuración por cadena (el código EVM sigue compilado). /api/solana-rpc de solo lectura con lista de métodos y límite por IP; /api/solana-tx send verifica firmas y programa. CSP para Privy y el WSS público.

#### `privy-politica-script` — Escribir la regla del vigilante en Privy

- **Quién:** Claude · **horas:** 1.5 · **nivel:** Imprescindible · **depende de:** `candados-secretos`
- **Qué:** Escribo el script que crea en Privy la regla que solo deja al vigilante firmar cobros de SIP.
- **Por qué:** La regla de Solana de Nuvem nunca se escribió en el repo y nadie sabe qué permitía.
- **Listo cuando:** El script está en el repo, revisado, y no imprime ningún secreto.
- **Técnico:** ALLOW signAndSendTransaction con programId en {SIP, Ed25519SigVerify, ComputeBudget}; DENY exportPrivateKey y signMessage; owner = key quorum. La regla va en el firmante, nunca en la wallet: en la wallet impediría exportarla a Axiom. Ids a stdout, secretos a un archivo 0600. Dueña de la política: una key quorum de administración distinta de la del vigilante (Privy exige la firma del dueño para cambiarla). Pruebas de rechazo con transacciones que simularían bien (1 lamport a sí misma, Memo): Privy simula antes de evaluar la política.

### Martes 15

#### `programa-pruebas` — Todas las pruebas en verde y revisión

- **Quién:** Claude · **horas:** 6 · **nivel:** Imprescindible · **depende de:** `programa-dos-modos`, `programa-mando-seguro`, `programa-moneda-fija`
- **Qué:** Paso todas las pruebas del programa y una revisión de código antes de publicar nada.
- **Por qué:** Una vez publicado, cada error cuesta una actualización con dinero real delante.
- **Listo cuando:** A las 13:00: pruebas en verde y ningún hallazgo grave abierto en la revisión.
- **Técnico:** anchor test completo; /code-review high sobre el diff desde el commit de renombrado; IDL y vector dorado del mensaje V2 para el vigilante y la web.

#### `decision-programa` — Decidir: dos modos o volumen bloqueado

- **Quién:** Juntos · **horas:** 0.25 · **nivel:** Para la demo · **depende de:** `programa-pruebas`
- **Qué:** A las 13:00 miramos las pruebas: si volumen no está en verde, el programa sale con volumen bloqueado.
- **Por qué:** Decidir tarde es lo que hace fallar las entregas.
- **Listo cuando:** Decisión escrita a las 13:00.
- **Técnico:** Plan B = el mismo programa V2 con create_vault_v2 y set_policy_v2 rechazando mode=1. Tope, reserva, configuración protegida y moneda fija se quedan: son lo que hace seguro incluso el modo beneficio.

#### `wallet-cobro` — Crear la wallet de cobro

- **Quién:** Tú · **horas:** 0.25 · **nivel:** Imprescindible · **depende de:** `candados-secretos`
- **Qué:** Creas una segunda wallet que firmará los cobros y pagará las comisiones del vigilante, y le pones 0,5 SOL.
- **Por qué:** Su clave tiene que vivir en Railway; si fuera la de administración, quien entrara en el servidor podría cambiar el programa.
- **Listo cuando:** Tengo su dirección pública y su saldo se ve en Solscan.
- **Técnico:** ~/sip-keys/settle.json = atestador y crank. En el programa, config.attester y config.keeper apuntan a ella. Su secreto se pega solo en Railway.

#### `fondos-despliegue` — Poner el SOL para publicar el programa

- **Quién:** Tú · **horas:** 0.25 · **nivel:** Imprescindible · **depende de:** `viejo-rescatar-sol`
- **Qué:** Pones unos 5 SOL en tu wallet de administración para publicar el programa.
- **Por qué:** Publicar bloquea unos 2,4 SOL de alquiler y necesita otro tanto temporal que luego vuelve.
- **Listo cuando:** Los saldos se ven en Solscan.
- **Técnico:** solana rent 468056 (tamaño real de sip_vault.so) da 2,378 SOL permanentes; el buffer de escritura necesita otros ~2,4 SOL que se devuelven; ~0,1 SOL de comisiones. Unos 3,24 SOL salen del rescate de hoy.

#### `programa-publicar` — Publicar el programa en Solana

- **Quién:** Juntos · **horas:** 3 · **nivel:** Imprescindible · **depende de:** `programa-pruebas`, `fondos-despliegue`, `decision-programa`, `wallet-cobro`
- **Qué:** Publicas el programa con tu wallet de administración, lo configuras y compruebo que lo publicado es exactamente lo probado.
- **Por qué:** Es el paso que convierte el código en algo que funciona con dinero real.
- **Listo cuando:** El hash en cadena coincide con el probado, la autoridad es tu wallet de administración y el atestador y el keeper son la wallet de cobro.
- **Técnico:** deploy.sh: solana program deploy target/deploy/sip_vault.so --program-id target/deploy/sip_vault-keypair.json --buffer <archivo> (reanudable) --use-rpc -u <Helius> -k ~/sip-keys/admin.json. Nunca anchor deploy. init_config(attester = wallet de cobro) y set_keeper(wallet de cobro) firmados por admin. status: solana program dump comparado por sha256 con target/deploy/sip_vault.so.

#### `privy-llave-regla` — Crear la llave de firma y la regla en Privy

- **Quién:** Tú · **horas:** 1 · **nivel:** Imprescindible · **depende de:** `privy-solana`, `privy-politica-script`
- **Qué:** Creas en Privy la llave del vigilante, ejecutas el script de la regla y me pasas solo los dos ids.
- **Por qué:** Sin esta regla el vigilante no puede cobrar, o podría firmar cualquier cosa.
- **Listo cuando:** Tengo el key quorum id y el policy id, y las tres pruebas de rechazo fallan como deben.
- **Técnico:** La privada de la authorization key se muestra una vez y va a tu gestor. Cargar secretos con read -s. Rechazos esperados: transferencia de SOL de nivel superior, signMessage y una instrucción al programa viejo.

#### `keeper-cobro-v2` — El vigilante cobra con la regla de cada modo

- **Quién:** Claude · **horas:** 6 · **nivel:** Imprescindible · **depende de:** `keeper-traer`, `programa-pruebas`
- **Qué:** El vigilante lee el modo y la tasa de cada bóveda, construye el cobro nuevo y no cobra si no vio todo el tramo.
- **Por qué:** Un cobro con el mensaje viejo, o sin ver todas las operaciones, sería dinero mal cobrado.
- **Listo cuando:** En local, un cobro por modo aterriza con el vector dorado del programa.
- **Técnico:** Atestación V2 del vector dorado; fetchMultiple de bóvedas con el IDL; frontera alcanzada = vio una firma con slot menor o igual que la frontera, en finalized (no se usa until con la firma del último cobro: saltaría operaciones). PENDING_FINALITY sin alerta; base cero avanza. Fijar o rechazar PRIVY_API_BASE_URL para que el app secret no pueda ir a otro host; pre-comprobar la reserva de la wallet antes de atestar.

#### `keeper-variables` — Pegar las variables del vigilante en Railway

- **Quién:** Tú · **horas:** 1 · **nivel:** Imprescindible · **depende de:** `keeper-traer`, `helius`, `programa-publicar`, `wallet-cobro`
- **Qué:** Creas el servicio del vigilante en Railway, cambias la contraseña de la base de datos y pegas tú las variables.
- **Por qué:** Los secretos solo pueden vivir en Railway y en tu gestor, nunca en el chat.
- **Listo cuando:** El servicio arranca en seco y /status muestra el programa nuevo.
- **Técnico:** Config-as-code packages/solana-keeper/railway.json, Root Directory vacío. SIP_SOLANA_RPC_URLS, SIP_SOLANA_PROGRAM_ID, el secreto de la wallet de cobro (atestador y crank), SIP_SOLANA_PRIVY_*, DATABASE_URL de Supabase por el pooler de sesión 5432 con la contraseña nueva. La wallet de administración nunca va a Railway.

#### `web-login-wallets` — Entrar con Phantom y crear wallets de trading

- **Quién:** Claude · **horas:** 6 · **nivel:** Imprescindible · **depende de:** `web-solana-base`, `privy-solana`
- **Qué:** Entras con Phantom como llave de pensión y creas wallets de trading que nacen con el permiso del vigilante y se pueden exportar a Axiom.
- **Por qué:** Es la puerta del producto: sin llave de pensión ni wallet de trading no hay nada que ahorrar.
- **Listo cuando:** En local contra mainnet: entrar con Phantom, crear una wallet de trading con el permiso visible y exportarla.
- **Técnico:** Privy solo Solana (walletChainType solana, conectores externos; la pensión nunca es una embedded). createWallet con signers para que nazca con asiento; export con el diálogo de Privy; lectura del asiento desde el usuario.

### Miércoles 16

#### `keeper-medir-volumen` — Medir cuánto se compra y se vende

- **Quién:** Claude · **horas:** 9 · **nivel:** Para la demo · **depende de:** `keeper-cobro-v2`, `fills-reales`
- **Qué:** El vigilante calcula el volumen de cada operación real, contando el SOL envuelto y sin cobrar comisiones ni alquileres.
- **Por qué:** Medido de forma ingenua, 4 de cada 6 operaciones reales se cobrarían a cero o de más.
- **Listo cuando:** Las 6 operaciones grabadas el lunes dan el volumen esperado al lamport.
- **Técnico:** Solo transacciones exitosas firmadas por la wallet con cambio de un token propio. Base = valor absoluto de Δ lamports nativos + Δ wSOL propio. La fee solo si la wallet es la cuenta 0. Tips y alquiler fuera. Fills de terceros, token a token y ambiguos: rechazados y registrados, fuera de la base. USDC y USDT se anotan pero no se atestan. Es la primera tarea que cae en el plan B.

#### `keeper-listo` — El vigilante funciona solo y avisa

- **Quién:** Claude · **horas:** 5 · **nivel:** Para la demo · **depende de:** `keeper-cobro-v2`
- **Qué:** Invierte en tramos que puede adelantar, avisa si algo falla, dice la verdad en /health y guarda su historial.
- **Por qué:** El vigilante viejo se paró cinco días sin que nadie se enterara.
- **Listo cuando:** En seco contra mainnet: /health responde, /status muestra el último barrido y llega una alerta de prueba.
- **Técnico:** Envolver min(libre, saldo del crank − 0,02 SOL); convertir min(wSOL, max(max_per_call, 1 SOL)). Alerta en invest FAILED. /health 503 si el último barrido empezado supera max(3 × SWEEP, 10 min). Dos bucles, cobro e inversión. Esquema sip_solana en Supabase. Barrido de 60 s hasta limitar la inversión a después de un cobro. De la revisión del port: comprobar el tope de 30 días antes de empezar una cesta; la clave de settlement_event debe incluir la época del link (hoy un re-vínculo pierde filas); .dockerignore para id.json y .local dentro del paquete; validar la forma de SIP_SOLANA_PRIVY_APP_ID y SIGNER_ID antes de servirlos en /status.

#### `pension-demo` — Preparar las wallets de la demo

- **Quién:** Tú · **horas:** 0.75 · **nivel:** Para la demo · **depende de:** —
- **Qué:** Creas dos cuentas de Phantom como llaves de pensión, una por modo, con 0,05 SOL cada una, y reservas ~2 SOL para operar.
- **Por qué:** Cada bóveda pertenece a una llave, y la demo enseña los dos modos.
- **Listo cuando:** Me pasas las dos direcciones públicas y los saldos se ven en Solscan.
- **Técnico:** A para VOLUMEN y B para BENEFICIO. Las wallets de trading se crean desde la web. El capital de operar es recuperable.

#### `web-boveda` — Crear la bóveda, vincular, elegir acción y retirar

- **Quién:** Claude · **horas:** 9 · **nivel:** Imprescindible · **depende de:** `web-login-wallets`, `programa-publicar`
- **Qué:** Desde la web creas tu bóveda eligiendo beneficio o volumen, vinculas la wallet de trading, eliges la acción y puedes sacar el dinero.
- **Por qué:** Es el recorrido que los jueces tienen que ver funcionar, y retirar demuestra que el dinero es tuyo.
- **Listo cuando:** En mainnet desde la web: bóveda creada, wallet vinculada, política firmada y un retiro de prueba, cada uno con enlace a Solscan.
- **Técnico:** create_vault_v2 con texto honesto por modo. Vincular en una transacción: Phantom paga y firma primero, la embedded co-firma después; rechaza wallet igual a dueño. set_invest_policy con SPYx a 1 $ y creación de cuentas pagada por el dueño. withdraw. Comprobación de bytes contra fixtures del programa. Aviso: el emisor de xStocks puede congelar. Primera política de inversión: in_mint USDC, mínimo 1 $, 50 $ por llamada, 500 $ cada 30 días.

#### `ensayo-seco` — Ensayo en seco contra mainnet

- **Quién:** Juntos · **horas:** 1.5 · **nivel:** Para la demo · **depende de:** `keeper-variables`, `keeper-listo`, `web-boveda`, `privy-llave-regla`
- **Qué:** Con las bóvedas de demo creadas, el vigilante calcula lo que cobraría sin mover nada, y lo comparamos a mano.
- **Por qué:** Es la última comprobación antes de mover dinero real.
- **Listo cuando:** Lo calculado coincide con el cálculo a mano de cada tramo.
- **Técnico:** Modo seco; beneficio = cashΔ − depósitos + retiradas del tramo; volumen con la regla del medidor; revisar /status.

#### `primer-cobro-real` — Encender el cobro real, uno por modo

- **Quién:** Juntos · **horas:** 2.5 · **nivel:** Para la demo · **depende de:** `ensayo-seco`, `pension-demo`
- **Qué:** Armas el vigilante en Railway y operas desde las wallets de demo hasta ver un cobro real en cada modo y una compra de SPYx.
- **Por qué:** Es la prueba de que el sistema entero funciona con dinero real.
- **Listo cuando:** Hay un settle_v2 por modo y una compra de SPYx, enlazables en Solscan.
- **Técnico:** Tú activas BROADCAST y el centinela en Railway. Transacción [Ed25519, SIP] por modo con el delta de la bóveda igual a /status, y un INVESTED.

#### `decision-volumen` — Decidir: ¿enseñamos volumen?

- **Quién:** Juntos · **horas:** 0.25 · **nivel:** Para la demo · **depende de:** `primer-cobro-real`
- **Qué:** A las 14:00, si no hay un cobro real en modo volumen, la demo va solo por beneficio.
- **Por qué:** Grabar algo que no ha funcionado sería engañar a los jueces.
- **Listo cuando:** Decisión escrita a las 14:00.
- **Técnico:** Un único hecho decide: un settle_v2 con mode = 1 confirmado en mainnet.

### Jueves 17

#### `web-panel-live` — Tu pensión real en el panel

- **Quién:** Claude · **horas:** 5 · **nivel:** Para la demo · **depende de:** `web-boveda`, `keeper-listo`
- **Qué:** El modo Live enseña tu bóveda de Solana: lo apartado, los cobros, las acciones compradas y su precio real.
- **Por qué:** Sin esto la web solo enseñaría el ejemplo.
- **Listo cuando:** En la web pública, Live con la bóveda de demo enseña los cobros reales y la compra de SPYx.
- **Técnico:** Cargador de Solana para Live: bóveda, links y política desde la cadena más el historial de sip_solana. Precio de SPYx del mismo pool que compra. Campos de modo, tope y reserva opcionales para que Mock no cambie. Cada movimiento enlaza a Solscan.

#### `web-portada-publicar` — Portada de Solana y web pública

- **Quién:** Claude · **horas:** 4 · **nivel:** Para la demo · **depende de:** `web-solana-base`
- **Qué:** La portada habla de Solana y acciones, se quita el vídeo de otra marca y la web queda en una dirección pública.
- **Por qué:** Los jueces necesitan un enlace que funcione.
- **Listo cuando:** La dirección pública carga la portada nueva y deja entrar con Phantom.
- **Técnico:** Textos en landing.tsx, layout.tsx y site-footer.tsx. Quitar el vídeo, videoRef y el scrub. Servicio web en Railway con SIP_CHAIN=solana. Dominio exacto añadido a los orígenes de Privy.

#### `recorrido-completo` — Recorrido completo en la web pública

- **Quién:** Juntos · **horas:** 3 · **nivel:** Para la demo · **depende de:** `web-panel-live`, `web-portada-publicar`, `primer-cobro-real`
- **Qué:** Hacemos el camino entero en la web pública: operar, apartar, cobrar y comprar, cronometrado.
- **Por qué:** El vídeo solo puede enseñar lo que ha funcionado de verdad.
- **Listo cuando:** Operación, cobro y compra de SPYx visibles en Live en menos de 10 minutos.
- **Técnico:** Antes del ensayo la hucha queda en torno al 90 % del mínimo, para que la operación en cámara lo supere.

#### `textos-entrega` — README, linaje, avisos y guion

- **Quién:** Claude · **horas:** 5 · **nivel:** Para la demo · **depende de:** `stocklana-reglas`, `decision-volumen`
- **Qué:** Escribo el README de una pantalla, de dónde viene cada pieza, los avisos honestos, el guion del vídeo y el texto del formulario.
- **Por qué:** Los jueces premian lo real, y las reglas exigen declarar el código previo.
- **Listo cuando:** README, guion y texto del formulario revisados por ti.
- **Técnico:** Tag stocklana-start y enlace compare. Avisos: xStocks congelables por su emisor; SIP usa programa y llaves nuevos sin relación con el despliegue anterior; tasas de demo. Guion de 3 minutos mapeado a los criterios de los jueces.

#### `ensayo-video` — Ensayo general y grabación

- **Quién:** Tú · **horas:** 5 · **nivel:** Para la demo · **depende de:** `recorrido-completo`, `textos-entrega`
- **Qué:** A las 15:00 hacemos el ensayo general y lo grabas; por la noche pones la voz.
- **Por qué:** Grabar durante el ensayo captura la operación real sin tener que repetirla.
- **Listo cuando:** Vídeo local de 3 minutos como máximo con la operación real.
- **Técnico:** Grabación de pantalla durante el ensayo; voz y edición por la noche. En pantalla nunca: claves, paneles de Railway ni gestores de contraseñas.

#### `repo-publico` — Copia pública y limpia del código

- **Quién:** Juntos · **horas:** 4 · **nivel:** Para la demo · **depende de:** `viejo-apagar`, `textos-entrega`
- **Qué:** Escaneo el historial en busca de secretos y publico una copia limpia sin informes internos.
- **Por qué:** El repo actual es privado y sus informes nombran la llave filtrada y la bóveda de otra persona.
- **Listo cuando:** El escaneo sale limpio y el repo público instala y compila desde cero.
- **Técnico:** gitleaks y trufflehog con reglas para arrays de 64 bytes y base58 de 87-88 caracteres. Repo nuevo sin reports/ ni .mcp.json. Solo si el mando del programa viejo está confirmado en cadena. Opcional: la web y el vídeo ya bastan.

#### `congelar-codigo` — Congelar el código

- **Quién:** Claude · **horas:** 0.25 · **nivel:** Para la demo · **depende de:** `recorrido-completo`
- **Qué:** A las 23:00 no entra más código, salvo arreglos de una demo rota.
- **Por qué:** Cambiar código la víspera es la forma más habitual de romper una demo.
- **Listo cuando:** Tag demo-freeze creado y despliegue automático desactivado.
- **Técnico:** Tag demo-freeze; Railway sin autodeploy desde main hasta después del envío.

### Viernes 18

#### `revisar-video` — Revisar el vídeo imagen a imagen

- **Quién:** Juntos · **horas:** 1.5 · **nivel:** Para la demo · **depende de:** `ensayo-video`
- **Qué:** Revisamos cada cambio de escena buscando cualquier secreto en pantalla y lo subes como oculto.
- **Por qué:** Un vídeo publicado no se puede despublicar del todo.
- **Listo cuando:** Enlace oculto de YouTube y revisión sin hallazgos.
- **Técnico:** ffmpeg con selección por cambio de escena más un fotograma por segundo; subida oculta a las 10:30.

#### `enviar` — Enviar la candidatura

- **Quién:** Tú · **horas:** 1 · **nivel:** Para la demo · **depende de:** `revisar-video`, `web-portada-publicar`, `textos-entrega`
- **Qué:** Envías la candidatura con la web, el vídeo y, si salió limpio, el repo.
- **Por qué:** Es la entrega.
- **Listo cuando:** Confirmación de envío recibida.
- **Técnico:** Objetivo 16:00 Lisboa, límite propio 18:00; el cierre es a las 21:00 Lisboa (16:00 ET).

#### `vigilar-envio` — Vigilar la demo tras el envío

- **Quién:** Claude · **horas:** 1 · **nivel:** Para la demo · **depende de:** `enviar`
- **Qué:** Compruebo que la web y el vigilante siguen vivos después de enviar.
- **Por qué:** Los jueces pueden abrir el enlace en cualquier momento hasta el 2 de octubre.
- **Listo cuando:** Parte de estado enviado a las 21:00.
- **Técnico:** /health, /status, créditos de Helius y saldo del crank.

### Después

#### `despues-deuda` — Guardar la deuda para cobrarla después

- **Quién:** Claude · **horas:** 12 · **nivel:** Después · **depende de:** —
- **Qué:** Si una wallet está vacía al cobrar, lo pendiente queda anotado en la cadena y se cobra más tarde.
- **Por qué:** Hoy lo que supera el tope se perdona; el modelo acordado es cobrar después.
- **Listo cuando:** Pruebas de cobro parcial y deuda pendiente en verde.
- **Técnico:** owed y collected tallados en TradingLink._reserved; record_owed pagado por el keeper y pull pagado por la wallet.

#### `despues-multifirma` — Multifirma para actualizar el programa

- **Quién:** Juntos · **horas:** 6 · **nivel:** Después · **depende de:** —
- **Qué:** El mando del programa pasa de tu wallet de administración a una multifirma con retraso de 24 horas.
- **Por qué:** Antes de dinero de terceros, ninguna llave sola debería poder cambiar el programa.
- **Listo cuando:** La autoridad de upgrade es una bóveda de Squads 2 de 3.
- **Técnico:** Squads v4, SetTimelock 86400 s, upgrades con write-buffer y propuesta; close_vault y close_link firmados por el dueño.

#### `despues-medidor-venue` — Separar comisiones por plataforma

- **Quién:** Claude · **horas:** 8 · **nivel:** Después · **depende de:** —
- **Qué:** El medidor separa la comisión del venue y los tips en cada plataforma.
- **Por qué:** Sin esto una compra puede medirse hasta un 12 % por encima.
- **Listo cuando:** Fixtures por venue con el volumen neto exacto.
- **Técnico:** Decodificadores de pump.fun, PumpSwap, Raydium y Jupiter; los ids de Axiom y GMGN como etiquetas, nunca como lista blanca.

#### `despues-unir-workers` — Unir el vigilante de Solana y el worker de Ethereum

- **Quién:** Claude · **horas:** 16 · **nivel:** Después · **depende de:** —
- **Qué:** Un solo paquete con dos adaptadores de cadena, dos procesos y una base de datos.
- **Por qué:** Hoy son dos copias del mismo núcleo que ya empiezan a divergir.
- **Listo cuando:** @sip/worker con src/chains/{evm,solana} y ambas suites en verde.
- **Técnico:** Núcleo común: Redactor, advisory lock, bucle y latido, alertas, salud; ChainAdapter; DDL parametrizado por cadena.

#### `despues-al-momento` — Enterarse de las operaciones al momento

- **Quién:** Claude · **horas:** 8 · **nivel:** Después · **depende de:** —
- **Qué:** El vigilante recibe cada operación en cuanto ocurre en lugar de preguntar cada minuto.
- **Por qué:** Baja el coste de consultas y el tiempo hasta el cobro.
- **Listo cuando:** Webhook activo y el sondeo solo reconcilia.
- **Técnico:** Un webhook raw de Helius con todas las wallets vinculadas y memo por firma en el ledger; el sondeo acotado queda como reconciliador.

#### `despues-importar` — Importar tu propia clave con el permiso del vigilante

- **Quién:** Claude · **horas:** 4 · **nivel:** Después · **depende de:** —
- **Qué:** Importas una clave que ya usabas y queda cobrable desde el primer segundo.
- **Por qué:** La promesa del producto es operar con tu wallet de siempre.
- **Listo cuando:** Una clave importada recibe un cobro real.
- **Técnico:** importWallet({privateKey, additionalSigners}) en modo TEE; comprobar si Axiom permite importar claves externas.

#### `despues-programa-viejo` — Avisar al dueño de los 22 SOL y cerrar el programa viejo

- **Quién:** Juntos · **horas:** 2 · **nivel:** Después · **depende de:** `viejo-apagar`
- **Qué:** Se avisa al dueño de esa bóveda para que retire, y cuando esté vacía se cierra el programa y vuelven 3,33 SOL.
- **Por qué:** Cerrar antes le congelaría el dinero para siempre.
- **Listo cuando:** Bóveda ajena a cero y programa cerrado.
- **Técnico:** Vault 5xGB3psh, dueño 3HsfgE6T. solana program close 7rtg… solo con todas las bóvedas ajenas vacías.

#### `despues-precio` — Precio de compra sin recorrer 60 transacciones

- **Quién:** Claude · **horas:** 4 · **nivel:** Después · **depende de:** —
- **Qué:** El precio de compra sale del propio pool contrastado con Jupiter, en segundos.
- **Por qué:** Hoy cada compra tarda hasta 72 segundos por acción.
- **Listo cuando:** Un turno de inversión tarda menos de 10 segundos.
- **Técnico:** Esperado desde sqrt_price del pool fijado, Jupiter como árbitro con tolerancia de 50 bps.

#### `despues-rotar` — Rotar las credenciales de servicio tras el concurso

- **Quién:** Tú · **horas:** 1.5 · **nivel:** Después · **depende de:** —
- **Qué:** Cambias las claves de Helius, Privy y Railway usadas durante la semana, y las de Ethereum que se pegaron en chats.
- **Por qué:** Una semana de prisas deja rastro; se limpia antes de usuarios reales.
- **Listo cuando:** Claves nuevas en Railway y las viejas revocadas.
- **Técnico:** Alchemy, secret de Privy EVM, claves de Helius sip-keeper y sip-web, authorization key del vigilante.

#### `despues-demo-viva` — Mantener la demo viva hasta el 2 de octubre

- **Quién:** Juntos · **horas:** 1.5 · **nivel:** Después · **depende de:** —
- **Qué:** La web y el vigilante siguen funcionando mientras los jueces evalúan.
- **Por qué:** Un enlace caído durante la evaluación cuenta como demo rota.
- **Listo cuando:** Monitor sin caídas hasta el 2 de octubre.
- **Técnico:** Monitor externo sobre /health; saldo del crank y créditos de Helius revisados cada dos días.

## Anexo — Cómo se hizo este plan

- Siete frentes (llaves, programa, vigilante, web, inversión, infraestructura y entrega) desglosados en tareas, y cada lista verificada contra el código por un agente independiente: 14 agentes.
- Unas 150 tareas propuestas se fusionaron en 55, aplicando las correcciones de la verificación: estimaciones, tareas erróneas y tareas que faltaban.
- El agente que ordenaba el calendario se detuvo tras 54 minutos sin avanzar; el calendario, la fusión y el recorte los hizo Claude a mano con esos 14 resultados. Los cuatro críticos finales (completitud, factibilidad, seguridad y claridad) no llegaron a correr.
- Base: reports/SIP_SOLANA_BACKEND_ASSESSMENT_2026-09-13.md y lecturas de cadena del 13-sept.
- Cambio del owner el 13-sept por la tarde: una sola wallet de administración durante el hackathon en vez de cinco llaves; la wallet de cobro va aparte porque su secreto vive en Railway.
