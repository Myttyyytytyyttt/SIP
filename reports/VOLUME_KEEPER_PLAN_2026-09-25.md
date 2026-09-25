# Keeper de volumen: informe para decidir (2026-09-25)

**Estado: propuesta.** No se ha escrito código ni se ha tocado nada desplegado. Espera tu aprobación.

Parte de la auditoría `reports/VOLUME_MODE_AUDIT_2026-09-25.md`. Lo que uso de ella lo he vuelto a comprobar en el
código y en mainnet (solo lectura).

## En 30 segundos

- El programa ya sabe cobrar por volumen. Falta que el keeper **mida** el volumen, y la web está cerrada a propósito.
- Propuesta de "volumen": **el SOL que tu wallet de trading paga o recibe en cada compra o venta que ella misma
  firma**, sin la comisión de red y sin la renta de las cuentas de token. En tus 4 trades del 23-09 da **4,0583 SOL**.
- **Recomiendo un solo keeper, no dos.** Pero lo haríamos en tus dos pasos: primero pones en Railway un **keeper
  sombra** (el mismo código, en seco, sin ninguna clave de firma) que enseña lo que cobraría. Cuando lo veas bien, lo
  "interconectamos": pasa al keeper de siempre y borramos la sombra. Así no hay dos servicios con la misma llave cobrando.
- Antes del cierre de hoy (20:00Z, 21:00 Lisboa) lo realista es el keeper sombra. El cobro real por volumen, después.
- Al final hay **8 preguntas** para ti.

## 1. Qué cuenta como volumen

**Una transacción cuenta si cumple las cuatro cosas:**

1. La **firmó tu wallet de trading**. Si un desconocido te manda algo, no cuenta.
2. **Salió bien.** Una fallida solo paga comisión y no compra nada.
3. **No es un simple envío de SOL** ni uno de nuestros cobros.
4. **Tu SOL y otro token se movieron en sentido contrario**: una compra o una venta de verdad.

**Cuánto cuenta:** el SOL que salió o entró en tu wallet en esa transacción, contando también el SOL envuelto (wSOL).
Se le quitan dos cosas:
- la comisión de red (en tus trades de Axiom, 0,001005 SOL cada uno);
- la renta de abrir o cerrar tus cuentas de token (0,0015 SOL en tu primera compra).

**Una cosa que tienes que saber:** en una compra, las comisiones de la plataforma y las propinas que pagas quedan
dentro de la cifra; en una venta, lo que recibes ya viene sin ellas. En tus 4 trades la cifra queda un 0,12 % por
debajo de lo que movió el pool de pump.fun (4,0633 SOL). Separar las propinas exigiría una lista de direcciones de cada
plataforma, que habría que mantener.

**No cuenta en esta primera versión** (en todos estos casos se cobra de menos, nunca de más):
- envolver o desenvolver SOL;
- SOL enviado con una nota (Memo), staking o puentes, porque no hay token a cambio;
- swaps sin SOL (USDC → token, token → token). Opcional: sumar los pares en USDC/USDT con el precio de Pyth (unas 4 h más);
- comprar y vender el mismo token dentro de una sola transacción (bots de arbitraje).

**El vector de prueba**, con transacciones reales de mainnet:

| Transacción | Qué es | Volumen propuesto (lamports) | Lo que cuenta el keeper hoy para el ranking |
|---|---|---|---|
| `3MdiRSsR…` | compra (pump.fun vía Axiom, tx versión 1) | 1.010.000.000 | 1.011.513.840 (incluye la renta) |
| `vyBt8qeK…` | venta | 1.010.896.197 | 1.010.896.197 |
| `467pc3qe…` | compra | 959.647.432 | 959.647.432 |
| `2Wvokwf8…` | venta | 1.077.776.111 | 1.077.776.111 |
| `2tE3BMTa…` | nuestro cobro del 19-09 | 0 | 0 |
| **Total de los 4 trades** | | **4.058.319.740** | 4.059.833.580 |

En la fase 2 añado casos trampa reales de mainnet: envolver, desenvolver, envío con Memo, swap fallido, crédito de un
desconocido, swap desde una cuenta wSOL que se queda abierta, y swap USDC → token. Cada uno con su cifra esperada.

**Lo que cobraría por esos 4 trades:**

| Modo | Debido | Pagado con el tope actual de 0,06 SOL |
|---|---|---|
| Beneficio al 25 % (lo que pasó de verdad) | 0,028373 SOL | 0,028373 SOL |
| Volumen al 0,5 % | 0,020292 SOL | 0,020292 SOL |
| Volumen al 1 % | 0,040583 SOL | 0,040583 SOL |
| Volumen al 2 % (el % por defecto de la web) | 0,081166 SOL | 0,06 si los 4 caen en un solo cobro; si se reparten en varios, como mucho falta 0,001 (ver punto 2) |

## 2. Tope y frecuencia de cobro

**Cómo funciona hoy el tope (el programa, sin cambios).** Cada cobro paga como mucho `max_contribution` (el tuyo:
0,06 SOL). Lo que pase de ahí **no se aparta**: se queda en la wallet de trading, no se pierde dinero. La web ya lo
dice: "above it is not carried over".

**Frecuencia (propuesta).** En volumen, el keeper cobra en cuanto lo debido llega a **0,001 SOL**, o cuando la
operación más antigua sin cobrar cumple **1 hora**, lo que llegue antes. Un cobro le cuesta a la wallet 0,00001 SOL
de comisión (medido en tu cobro del 19-09), así que en los cobros que salen por llegar a 0,001 SOL la comisión es como mucho el 1 %.
Los que salen por la hora pueden ser menores y la comisión pesa más (un 5 % en un cobro de 0,0002 SOL). El mínimo evita
cobros diminutos, pero un trader muy activo seguirá teniendo un cobro por minuto. Cada cobro espera su confirmación
dentro de la barrida, así que con muchos traders activos caben menos usuarios por barrida que los ~280 quietos medidos
el 23-09.

**Por qué cobrar pronto ayuda con el tope.** Tus 4 trades duraron 84 segundos. Con una barrida por minuto irían
normalmente en 2 o 3 cobros (en uno solo si se salta una barrida). Si se reparten en 2 o 3, al 2 % se recorta como mucho 0,001 SOL. Si caen en uno solo, se
recorta de 0,081 a 0,06.
Pero un trader que mueve 10 SOL en un minuto al 2 % debe 0,2 SOL, y con el tope de 0,06 aparta 0,06.

**Dos formas de tratar el tope. Decides tú:**
- **A (recomendada): dejarlo como está** y subir el tope por defecto para los vaults de volumen, por ejemplo a
  0,5 SOL. No cambia el programa ni lo que ya dice la web. La web puede enseñar cuándo un cobro se recortó, porque el
  evento del cobro guarda lo debido y lo pagado.
- **B: trocear.** El keeper corta la ventana donde se llega al tope y cobra el resto en el siguiente cobro, así que
  se aparta todo. Solo se recortaría un bloque que por sí solo pase del tope (al 2 % con 0,06 SOL, un trade de más de
  3 SOL). Son unas 3 h más de trabajo en el camino del dinero, y hay que cambiar el texto de la web.

**Si la wallet no tiene SOL para pagar**, el cobro espera, como hoy. Cuando la recargas se cobra lo pendiente, hasta el
tope. En volumen eso puede ser un cobro por trades de hace días; la web tiene que avisarlo.

## 3. Cambio de modo

**El problema.** `set_policy_v2` cambia el modo al momento y no toca el vínculo, así que todo lo pendiente se cobra en
el modo nuevo. El caso peligroso es **de beneficio a volumen**. En beneficio, una racha de pérdidas puede quedar
pendiente durante muchos trades (el keeper espera 100 transacciones firmadas por la wallet, sin contar nuestros cobros, antes de cerrarla a cero).
Al pasar a volumen, **todos esos trades se cobrarían como volumen**, aunque se hicieron bajo la regla de beneficio.

**Propuesta: el volumen se cobra solo desde el cambio.** El keeper busca en la cadena la transacción con la que el
dueño cambió el modo o el % de volumen, y solo cobra volumen de las operaciones posteriores. Lo anterior se perdona.
- Pausar y reanudar **no** perdona nada: no cambia ni el modo ni el %.
- **De volumen a beneficio** no hace falta nada nuevo: lo pendiente se mide como beneficio, como hoy. Y como el volumen
  se cobra pronto, lo pendiente es poco.
- Este cambio no toca el modo beneficio, que es el que hoy mueve tu dinero.
- Riesgo que se acepta: alguien que cambia de modo a propósito se ahorra lo pendiente de ese momento, que es poco
  gracias a la frecuencia del punto 2. Ya hoy quien controla la wallet puede quitarle el permiso al keeper y dejar de
  apartar del todo.

## 4. ¿Un keeper nuevo, o el mismo con volumen? (la arquitectura)

Pediste un keeper **separado**, solo de volumen, para ponerlo tú en Railway. Lo he comparado con meter la medida de
volumen en el keeper que ya existe. Estos hechos mandan:

- **La cadena acepta una sola llave de cobro.** La configuración del protocolo (`5Y1bpPuG…`) tiene un solo atestador,
  `8qsJxi8F…`, que es también el único crank; solo la autoridad `EE46Gm…` puede cambiarlo. Un segundo keeper tendría que llevar **la misma** `SIP_SOLANA_SETTLE_KEY`. Poner otra obligaría a
  cambiar la configuración, y eso dejaría fuera al keeper actual.
- **Privy.** Cada wallet tiene sentado un solo firmante del keeper, con la política que controla tu quórum de admin. El
  segundo keeper necesitaría **las mismas** claves de Privy, o que cada usuario vuelva a dar permiso.
- **El keeper de hoy ya toca los vaults de volumen.** Les puede mandar un cobro a cero para mover la frontera cuando
  la propia wallet ya firmó 100 transacciones sin ningún trade que saliera bien, o cuando lo pendiente pasa de 300
  firmas. Además, en cada vínculo que gira invierte los ahorros de su vault sin mirar el modo, también si es de volumen. Así que con dos keepers **también habría que cambiar
  el keeper vivo** (que deje de cobrar los vaults de volumen) y darle otro nombre al candado, porque hoy ese nombre es
  fijo en el código (`sip-solana-keeper`) y el segundo nunca llegaría a actuar mientras el primero lo tenga.
- El timbre de Helius lo gestiona el keeper que actúa (armado y con el candado), si tiene el secreto del timbre, una
  clave de Helius y una dirección pública; busca su webhook por esa dirección. Con dos, serían dos webhooks o
  habría que apagarlo en uno.

| | **Un keeper** (recomendado) | **Dos keepers vivos** |
|---|---|---|
| Llave de cobro y claves de Privy | en un servicio | copiadas en dos |
| ¿Cambia el keeper vivo? | sí: la medida nueva y una línea donde se usa | sí también: filtro por modo y otro candado |
| Un vault que cambia de modo | lo sigue llevando el mismo | se "muda" de servicio; en ese minuto un cobro falla y avisa (no cobra doble: el contador de cobros de la cadena lo impide) |
| Invertir | como hoy | solo el viejo; el nuevo no debe invertir |
| Timbre de Helius, alertas | como hoy | dos webhooks (o uno apagado) y dos fuentes de alertas en el mismo Telegram |
| Carga de RPC y Privy | como hoy | casi el doble: cada uno lee todos los vínculos y Privy en cada barrida |
| Si el código nuevo falla | un error queda en ese vínculo; un cuelgue pararía la barrida de todos | solo cae el de volumen |
| Trabajo extra | nada | unas 4 h de código, más tu configuración en Railway |

**Lo que sí tiene a favor el de dos:** si el código de volumen se colgara, no pararía el cobro de beneficio. Lo
cubrimos así: la medida de volumen trabaja solo sobre transacciones que el keeper ya leyó; si falla con un vault de
beneficio, da "sin dato" y el cobro de beneficio sigue igual (con un test que lo prueba).

**Recomendación: un solo keeper, probado primero como sombra.**
1. **Keeper sombra en Railway (tu "keeper nuevo").** Es el mismo código, desde mi rama, **en seco**: sin
   `SIP_SOLANA_BROADCAST`, sin claves, sin `DATABASE_URL`, sin timbre y sin alertas. Un keeper en seco no pide el
   candado ni lee claves de firma, así que no puede cobrar ni quitarle el candado al de verdad (está en el manual,
   `docs/runbooks/RAILWAY_SOLANA.md` §3). Sí hace las mismas lecturas de la cadena, así que debe ir con **su propia
   clave de Helius** (o la RPC pública) para no gastar la del keeper vivo. En `/status` enseña, para cada wallet, lo que cobraría en volumen, y para los
   vaults de beneficio sus mismas decisiones de siempre. Así comparamos con el keeper vivo que no cambió nada en
   beneficio.
2. **Prueba real (después del cierre).** Abrimos el volumen en la web **solo para tu vault de prueba** y pasas un vault
   a volumen. La sombra enseña "cobraría X"; lo comparamos a mano.
3. **Interconectar.** Cuando digas "push", el código entra en main y el keeper de siempre cobra también volumen.
   Borras la sombra.
4. **Fase 3.** La web ofrece volumen a todos.

Si aun así prefieres dos keepers vivos, está diseñado en el anexo A.

**Qué NO cambia en ningún caso:** el programa (no hay que actualizarlo) y la política de Privy. Esta política permite
por programa, no por modo (`src/privy-policy.ts`), así que un cobro de volumen pasa igual que uno de beneficio. Tampoco
cambia la configuración del protocolo.

## 5. Lo que necesita la web (fase 3, cuando el cobro por volumen funcione en producción)

- **Elegir modo y %** al crear el vault y al editarlo. Volumen: de 0,01 % a 2 %. Beneficio: de 2,01 % a 100 %. Hoy la
  web solo ofrece beneficio y el servidor rechaza el modo volumen.
- **Aviso claro:** "En volumen apartas un % de cada compra y venta, **ganes o pierdas**. Si operas 10 SOL y pierdes
  1 SOL, al 1 % apartas 0,1 SOL igual." Y también: "Al cambiar de modo, lo que aún no se cobró se perdona."
- **Vista previa del cobro:** "En los últimos 7 días operaste X SOL; al 1 % habrías apartado Y (en beneficio, Z)."
  Sale de lo que el keeper ya midió, así que el número es el mismo que se cobra. Para quien no tiene historial, una
  calculadora.
- **Reconciliar "Traded" y "Volume":** el keeper guarda la medida nueva en el historial de cada cobro, en los dos
  modos, así que "Traded" del ranking pasa a ser la misma cifra que se cobra. Las filas antiguas conservan la medida
  vieja (en tus 4 trades la diferencia es solo la renta, 0,0015 SOL).
- **Arreglar un bloqueo:** hoy el servidor no dejaría **pausar** un vault que esté en volumen, ni cambiar su tope o
  su reserva, sin sacarlo antes del modo volumen (pausar la inversión sí funciona). Hoy no existe ningún vault en
  volumen, pero hay que abrirlo antes de la prueba real.
- **Portada y pie:** ya ofrecen el cobro por volumen ("2 % de su volumen" en la portada). Se quedan como decidiste
  hoy; con la fase 3 pasan a ser verdad.
- Al final, encender `VOLUME_MODE_OFFERED` y actualizar los tests que lo fijan.

## 6. Lista de trabajo

💰 = toca el camino del dinero. Las horas son mías, con tests (cada regla con un test que falla si se quita la regla).

**Keeper (fase 2):**

| # | Tarea | 💰 | Horas | Para la sombra de hoy |
|---|---|---|---|---|
| K1 | La medida de volumen: la regla de 4 puntos, como función sin red | 💰 | 2 | sí |
| K2 | El vector: tus 4 trades y el cobro reales, y las trampas reales de mainnet | | 2 | sí |
| K3 | Conectarla a la medición y al cobro, sin cambiar ni una cifra del modo beneficio (un test lo fija) | 💰 | 1,5 | sí |
| K4 | Vista previa en `/status` para cada wallet, y un interruptor para que la sombra no invierta | | 1,5 | sí |
| K5 | Imagen de Railway: comprobar la lista COPY del Dockerfile y el preflight | | 1 | sí |
| K6 | Frecuencia: 0,001 SOL o 1 hora | 💰 | 1,5 | no |
| K7 | Cambio de modo: volumen solo desde el cambio | 💰 | 3 | no |
| K8 | "Traded" del ranking con la medida nueva | | 0,5 | no |
| K9 | Tests del programa que faltan: tope en volumen, base cero, la suite de revisión en volumen. El programa no cambia | | 2 | no |
| K10 | (solo si eliges trocear) cortar la ventana en el tope | 💰 | 3 | no |

Sombra: K1–K5, unas **8 h**. Cobro real: K6–K9, unas **7 h** más.

**Web (fase 3):**

| # | Tarea | 💰 | Horas |
|---|---|---|---|
| W1 | Lista blanca: volumen solo para tu vault de prueba | 💰 | 1 |
| W2 | Dejar pausar y cambiar límites a un vault en volumen | 💰 | 1 |
| W3 | Elegir modo y % al crear y al editar | 💰 | 4 |
| W4 | Aviso "ganes o pierdas", vista previa y calculadora | | 2 |
| W5 | "Traded" y "Volume" con la misma cifra | | 1 |
| W6 | Encender `VOLUME_MODE_OFFERED`, textos y sus tests | | 1 |

W1 y W2 son necesarias para la prueba real, antes que el resto de la fase 3.

## 7. Calendario

- **Hoy, antes de las 20:00Z:** si apruebas pronto, K1–K5 y tu keeper sombra en Railway enseñando lo que cobraría.
  Para la entrega vale como "volumen medido en vivo sobre wallets reales, sin mover dinero".
- **Después del cierre:** K6–K9, W1–W2, la prueba real con tu vault, y "push" cuando lo veas.
- **Después:** el resto de la fase 3.

Nada va a main ni cambia nada desplegado sin tu "push". El keeper vivo sigue cobrando tu vault de beneficio
(`EFXK995…`) como hoy.

## 8. Tus decisiones

1. **Arquitectura:** ¿un solo keeper, probado primero como sombra en Railway (recomendado), o dos keepers vivos
   (anexo A)?
2. **Definición:** ¿vale "el SOL que tu wallet paga o recibe en compras y ventas que ella firma, sin comisión de red ni
   renta", sin pares en USDC por ahora?
3. **Tope:** ¿A) lo dejamos como está ("lo que pase del tope no se aparta") y subimos el tope por defecto de los vaults
   de volumen a 0,5 SOL (recomendado), o B) troceamos para apartarlo todo en varios cobros?
4. **Frecuencia:** ¿cobrar cuando lo debido llegue a 0,001 SOL o pase 1 hora?
5. **Cambio de modo:** ¿cobrar volumen solo desde el cambio y perdonar lo anterior (recomendado)?
6. **Prueba real:** ¿pasamos tu vault actual (`EFXK995…`) a volumen, o creas otro con otra wallet? En los dos casos
   abro el volumen en la web solo para ese vault.
7. **Subir mi rama a GitHub** (no main) para que Railway construya la sombra: ¿sí? Vercel hará una vista previa de esa
   rama; la web de producción no cambia.
8. **Calendario:** ¿de acuerdo con sombra hoy y cobro real después del cierre?

---

## Anexo A: si eliges dos keepers vivos

- **El mismo código y la misma imagen.** Una variable nueva, `SIP_SOLANA_ROLE`:
  - `all`: lo de hoy, y el valor por defecto;
  - `profit`: cobra solo vaults en beneficio, invierte todos y gestiona el timbre. Candado `sip-solana-keeper`;
  - `volume`: cobra solo vaults en volumen, no invierte y va con el timbre apagado. Candado `sip-solana-keeper-volume`.
- **Orden de encendido:** primero se despliega el viejo como `profit`, y después se arma el nuevo como `volume`.
  Encenderlos al revés dejaría un rato a los dos cobrando los vaults de volumen: no cobraría doble, pero saltarían
  avisos.
- **Railway, servicio nuevo `sip-solana-keeper-volume`:** New → GitHub Repo, el mismo repo, rama main. Railway detecta
  el `Dockerfile` de la raíz, que es el del keeper. Healthcheck `/health`, 1 réplica, reinicio si falla, y generar
  dominio para `/status`.
- **Variables:** las mismas que el keeper actual, puestas como **referencia** al otro servicio (sin pegar valores), más
  `SIP_SOLANA_ROLE=volume`. Mejor con su propia clave de Helius en `SIP_SOLANA_RPC_URLS`. Sin `SIP_SOLANA_DOORBELL_SECRET`. `DATABASE_URL` es **obligatoria**: sin ella el candado no
  se aplica.
- **Alertas:** mismo Telegram, con "[volumen]" delante del título.
- **Trabajo extra frente a la recomendación:** unas 4 h (rol, candado por rol, marca en alertas y sus tests), dos
  despliegues del keeper vivo, y el doble de carga de RPC y de Privy.

## Anexo B: referencias (para la siguiente sesión)

- El hueco del volumen: `packages/solana-keeper/src/settle-decision.ts:261` (`defaultVolumeBase`). `bin/keeper.mts`
  llama a `runSettleTick` sin `volumeBase`.
- El keeper vivo puede mandar cobros a cero a vaults de volumen: `baseDecision`, `settle-decision.ts:591-592` y
  `:630-646` (nunca ha pasado: no hay ningún vault en volumen en mainnet).
- La medida de hoy: `tradedLamports`, `measure-window.ts:503-515`. Suma la renta y no mira quién firma.
- Firma por wallet: `isSignedByWallet`, `measure-window.ts:561`. Ya se usa para la cadencia de cobros a cero.
- Tope: `settle.rs:136`, `paid = owed.min(max_contribution)`. El evento `Settled` guarda `mode`, `bps`, `owed`, `paid` y
  `policy_nonce` (`events.rs`).
- `set_policy_v2` reescribe `mode`, `skim_bps`, `volume_bps`, `paused`, `max_contribution` y `wallet_reserve`, y
  siempre sube `policy_nonce` (`set_policy.rs`).
- Candado: `KEEPER_LOCK_NAME = "sip-solana-keeper"` (`src/singleton.ts:21`); solo lo pide un keeper armado.
- Web: `VOLUME_MODE_OFFERED = false` (`solana-core/src/client/product.ts:96`). `DEFAULT_RATES.volumeBps = 200`,
  `maxContribution` por defecto 60.000.000 lamports. "above it is not carried over" en `website-oficial/src/lib/live-copy.ts:204`.
- Transacciones del vector: `3MdiRSsRCuhs4ZcGPBsb7Sp1Xy8qm9SH73xkATaQsmknc45XW3UY5Zn76eJJuv4QsitYZ1KesQNDXipZvNmVMUr1`,
  `vyBt8qeKAGxRP9XDX6vqSyfCJ1EKDALEWLruHSqemyaqLc6hn76v4dJFN9rBDbju34LwznE1ToZcTqAXduwoDUg`,
  `467pc3qew4gPgsDUM1Z7qX9f9g7fAmAFJbPjhR4nQz9NEP3xgZ1x5cjkM5gKGs68xULWKcWjoG5Sfgm1ghQJAbkb`,
  `2Wvokwf8tC8kiuczg4w298qTvXXBxN4VmwTHXbxzoroitK3GBygwqDXDNvPgcaxPoRkZ184P8xg5wd3yMNDTkfxY` y el cobro
  `2tE3BMTa6BPUmxaWvxDPEaK4piZ3KKL7pXGpmRHcUy6fHD2AK66rF6XnAKbNADKaarjSNGxTHqxqJpGFZ79vzvpy`.
