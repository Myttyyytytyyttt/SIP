# Onboarding de SaverFi: traspaso (23-sep-2026)

Documento para el chat que trabaja el **onboarding** con el dueño. Lo escribió la sesión anterior (UI del dashboard).
No se commitea (vive en `reports/`, sin trackear). Todas las rutas de código son relativas a `packages/website-oficial/`
salvo que se diga otra cosa.

## 1. Cómo trabaja el dueño (obligatorio)

- **Habla en español.** Respóndele en español, claro y sin jerga.
- **Todo va a `main` y se empuja a `origin/main`** ("no lo hagas en una rama diferente"). Vercel despliega `main` solo.
  Si tu sesión arranca en un worktree o rama, tus commits tienen que acabar en `origin/main`
  (`git pull --rebase origin main` y `git push origin HEAD:main`, o la herramienta de sync de la app). No dejes trabajo
  en una rama aparte.
- **Paso a paso, elemento por elemento.** Propón un orden, y que él elija. Enséñale capturas antes y después.
- **Él no puede correr la web en local** (Privy). Lo comprueba en https://sip-website-oficial.vercel.app después de
  cada push. Por eso cada paso: verificar → commit → push.
- **Fecha límite: viernes 25-sep 21:00 (hora de Lisboa)**: entrega del hackathon. Prioriza lo que vería un jurado o
  alguien que entra por primera vez.

## 2. Reglas del repo que no se negocian

- Marca visible: **SaverFi**. Nunca "Nuvem" ni "SIP" en textos que vea el usuario (los nombres internos `SIP_*`,
  `@sip/*` se quedan).
- **Honestidad de datos:** una página Live nunca muestra números de ejemplo ni inventa operaciones; lo que no se sabe
  sale como "—", nunca como $0.00. La muestra (`/?mode=mock`) siempre va etiquetada como muestra.
- **Colores del feed** (decisión del dueño, hoy): verde = dinero que entra, azul = compras de la pensión, mostaza = SOLO
  cambios de ajustes (regla, política, link/unlink, vault), gris = el sistema funcionando (convert, wrap, upkeep,
  retiradas, liquidación sin ahorro), rojo = solo fallos, raro. Ver `src/components/activity-row.tsx`.
- **No commitear nunca** `.claude/settings.json` (tiene permisos de otra sesión sin decidir) ni nada de `reports/`.
- **No leer nunca `~/sip-keys/**`, no imprimir secretos** (keys de Helius, secretos de Privy, valores de env).
- **No borrar variables de Vercel** (el dueño lo decidió hoy: "imagínate que borramos y algo peta").
- Hay otras sesiones de Claude trabajando en el mismo repo: mira `git status` antes de commitear y añade solo tus
  archivos, por nombre.

## 3. Cómo verificar

- Tests y build: en `packages/website-oficial`, con Node 22:
  `export PATH="$HOME/.nvm/versions/node/v22.14.0/bin:$PATH" && pnpm run verify` (typecheck, ~1000 tests, `next build`).
  Con Node 20 fallan cosas que no son del código.
- Visual: build de producción en local (`npx next build && npx next start -p 3013`, usa **localhost**, no 127.0.0.1) y
  capturas con Playwright: `require("/Users/walch/ProyectosCT/SIP/tools/landing-shot/node_modules/playwright")`,
  `chromium.launch({ channel: "chrome" })`, espera `networkidle` + ~1500 ms (recharts se redimensiona tarde).
- Las páginas Live necesitan login de Privy. Para ver estados Live sin login, la sesión anterior montaba una página
  temporal `src/app/dev-preview/page.tsx` que renderiza los componentes con fixtures
  (`test/fixtures/live-dashboard.ts`, `toLiveDashboard`, `toDashboardMock`). **Bórrala antes de cada commit.**
- `/?mode=mock` (la muestra) funciona sin login, en local y en producción.

## 4. Mapa del onboarding en el código

- Landing: `src/components/landing.tsx` (hero ~546-612; vídeo de fondo ~60-71, clip de plantilla con la tarjeta de otra
  marca, en un CloudFront ajeno), imagen `public/landing/app-dark.png` (captura vieja del 14-sep).
- Login Privy: `src/app/providers.tsx` (solo wallets: Phantom/Backpack/Solflare; cabecera "Connect your pension key").
- Qué pantalla toca: `src/lib/dashboard-mode.ts`, `src/components/dashboard-shell.tsx`.
- Etapas del usuario nuevo: `stageOf()` en `src/lib/live-model.ts` (~692-701): no_vault → no_trading_wallet →
  not_linked → waiting_first_settlement → active. Tarjetas: `src/components/live/LiveNextStep.tsx`.
  Página: `src/components/live/LiveBody.tsx`. Estados de carga/error: `src/components/live/LiveStates.tsx`.
- Textos: `src/lib/live-copy.ts` (LIVE_COPY, ACTIVITY_COPY, MODE_COPY) y `src/lib/vault-copy.ts` (CREATE_LINK_COPY…).
- Modal "Manage wallets" (5 tarjetas: Pension key, Vault, Trading wallets, Investing, Withdraw):
  `src/components/wallets/WalletsScreen.tsx`, `VaultCard.tsx`, `TradingWalletsCard.tsx`, `TradingWalletRow.tsx`,
  `InvestingCard.tsx`; lo abre `src/components/wallets-host.tsx` (`openWallets()` no acepta sección).
- Qué ofrece el producto de verdad: `packages/solana-core/src/client/product.ts` (`VOLUME_MODE_OFFERED = false`: solo
  modo profit; estantería real: SPYx + PreStocks como ANTHROPIC, SPACEX, OPENAI…).
- La tarjeta de la regla firma de verdad (`src/components/live/LiveRulePanel.tsx`, `use-vault-actions.ts`): probado en
  mainnet hoy (20 → 25 %).
- Signer de Privy del keeper: key quorum `kyio853439oa78qfvmt853i4`. El viejo `cbx133…` está retirado: nunca lo uses.

## 5. Lo que encontró la auditoría (verificado)

Auditoría de UI/UX del 23-sep: 4 enfoques, y cada hallazgo lo revisó un segundo agente contra el código y las capturas.
El enfoque del recorrido de un usuario nuevo tuvo 17 hallazgos y **el revisor confirmó los 17**. El detalle completo
(problema, evidencia file:line, arreglo propuesto, revisión) está en:
`/Users/walch/.claude/projects/-Users-walch-ProyectosCT-SIP/e26254a8-fef7-48f4-a1a1-c0f9c58350b6/tool-results/buqomj5ed.txt`
El diario completo de la auditoría (los 4 enfoques, se completa cuando termine):
`/Users/walch/.claude/projects/-Users-walch-ProyectosCT-SIP/e26254a8-fef7-48f4-a1a1-c0f9c58350b6/subagents/workflows/wf_1e7ec96d-bc0/journal.jsonl`
(una línea `{"type":"result",...}` por agente).

### Alto impacto

1. **Moverse por la muestra la rompe** (alta, S). En `/?mode=mock`, pulsar "Activity" enseña la tarjeta "Connect your
   pension key" y "Pension" devuelve a la landing: los enlaces no llevan `?mode`. `site-header.tsx:61-66`,
   `site-footer.tsx` (LINKS), `dashboard-mode.ts:157-159`, `open-pension.tsx:18`. Arreglo: pasar el modo a los enlaces
   internos mientras se ve la muestra (y/o recordarlo en sessionStorage). Otros dos enfoques lo marcaron como crítico.
   Relacionado: en la muestra, "Activity" enseña la misma página de pensión.
2. **La muestra y la landing venden otro producto** (alta, M). La muestra usa modo volumen 2 %, cesta INDEX/SPYx/GLDx
   y operaciones "Sold HOODx". La landing promete "2 % de volumen o 20 % de beneficio". Pero crear un vault solo permite
   Profit (Volume sale "Coming soon") y la cesta real es SPYx + PreStocks. `src/mocks/data.ts:59-69`,
   `landing.tsx:601-603`, `product.ts:94`, `VaultCard.tsx:168-185`. **Decisión del dueño**: re-sembrar la muestra en
   profit 20 % con la cesta real, reescribir el texto de la landing y volver a hacer la captura.
3. **El último paso, la primera inversión, no tiene botón** (alta, M). `stageOf()` pasa a "active" con la primera
   liquidación aunque no haya política de inversión. Entonces no aparece ninguna tarjeta de siguiente paso. La regla
   enseña "Invests in" vacío y el umbral deshabilitado con una línea de ayuda. `LIVE_COPY.setUpInvesting` existe pero
   nadie lo usa. Arreglo: etapa `no_investing` con tarjeta "Choose what your savings buy", y un botón en la regla que
   abra el modal en la tarjeta Investing.
4. **Justo después de crear el wallet, el modal enseña cosas de operador** (alta, S): ids de wallet de Privy, un comando
   `privy-policy verify …`, un aviso de "re-seat", ids de signer y de política. `TradingWalletRow.tsx:65-70, :97,
   :117-128, :159-170`, `TradingWalletsCard.tsx:98-102, :171-178`. Arreglo: un estado simple por fila ("Ready: SaverFi
   can save from this wallet" / "Needs permission") y todo lo técnico dentro de un `<details>` "Advanced".

### Medio

5. **"Waiting for the first settlement" solo dice que esperes** (S). No dice "manda SOL a tu wallet de trading" ni
   "exporta la key y opera desde Axiom/GMGN". `LiveNextStep.tsx:128-143`, `live-copy.ts:261-266`. Arreglo: dos
   acciones numeradas (fondear con dirección + copiar; exportar la key). (Corrección del revisor: la etapa anterior sí lo
   menciona, y la barra lateral enseña la dirección; la tarjeta de espera no.)
6. **La landing no dice en qué se invierte ni qué necesitas** (S). Nunca dice "acciones tokenizadas / SPYx", ni que
   hace falta Phantom/Backpack/Solflare, ni los 3 pasos. Y "Trade wherever you already trade" sugiere que vale tu
   wallet de siempre, cuando hay que operar desde el wallet de trading que crea SaverFi. `landing.tsx:546-612`.
7. **La lista de pasos desaparece después del paso 1** (M). Solo `no_vault` enseña "What is left to set up" (4 pasos).
   Después, cada tarjeta va sola y debajo aparece un dashboard lleno de $0.00. Son unas 7 firmas desde cero hasta la
   primera inversión. Arreglo: un `<SetupStepper>` de 5 pasos en todas las etapas previas a active, marcados según
   datos reales, y ocultar el dashboard (o plegarlo) hasta active. `LiveNextStep.tsx:86-94`, `LiveBody.tsx:147-148`.
8. **Los botones de siguiente paso abren el modal arriba del todo** (S), y la etiqueta no coincide con el botón de
   dentro ("Create and link a trading wallet" vs "Create wallet and link it"). "Open the wallets page" lleva a /wallets,
   que tiene otra cabecera sin navegación. Arreglo: `openWallets({ section })` que haga scroll a esa tarjeta; una sola
   etiqueta; quitar el botón a /wallets.
9. **La columna de actividad sin estado de carga** (S): dice "No activity yet" mientras carga. Añadir
   `activityLoading` en `use-live-dashboard.ts` y esqueletos en `LiveBody.tsx:132`.
10. **Jerga en los textos del primer uso** (S): "pension key", el interruptor "Live | Mock", "keeper", "seat",
    "stretch", "co-signs". Arreglo propuesto: el interruptor como "My pension | Example", "Connect your Solana wallet",
    "SaverFi" en vez de "keeper", y los prompts de Phantom numerados. `live-copy.ts:24-25, :49-56, :244-246, :263-265`,
    `vault-copy.ts:618-624`, `providers.tsx:119`.
11. **La tarjeta Investing es un muro de texto legal** (M): unos 10 párrafos antes del botón de firmar, con "per
    100,000,000 raw units". Arreglo: resumen de 3 líneas y el resto en `<details>`. Ojo: las PreStocks tienen 9
    decimales y SPYx 8, así que un precio "por acción" tiene que escalar. `InvestingCard.tsx:1160-1207`,
    `vault-copy.ts:692`.
12. **Enlaces muertos** (S): Docs, Privacy, Terms, Email, X y GitHub son `#`. Decidir con el dueño a dónde apuntan,
    o quitarlos.
13. **Leaderboard abre en "This week" vacío** y usa la palabra "charged" (S). Poner "All time" por defecto si la semana
    está vacía, y botón "Start saving" para quien no tiene pensión. `leaderboard-view.tsx:201, :251-252`.

### Bajo

14. Un fallo pasajero al leer la config bloquea el link con "not configured" y sin Retry (`live-model.ts:755`).
15. Las cuentas atrás de "Try again in N s" no avanzan (nada re-renderiza).
16. En el móvil no hay navegación en la cabecera (`site-header.tsx:100`, `hidden md:flex`).
17. El vídeo de la landing es el clip de la plantilla, con la tarjeta de otra marca y alojado fuera (`landing.tsx:60-71`).

### Otros enfoques que tocan el onboarding (títulos; mira el diario para el detalle)

- Verificados: al pulsar Retry no pasa nada visible; cancelar en Phantom sale como "Refused" en rojo; "No investments
  yet" al lado de acciones que sí se tienen; el esqueleto de carga no coincide con el dashboard (salto de ~100 px);
  la tarjeta de la regla queda muerta si falla una lectura del vault.
- Sin verificar todavía (la auditoría seguía corriendo): la landing acaba su zoom en una captura vieja; no hay imagen
  al compartir el enlace (sin og:image); el 404 es el de Next; el diálogo de Privy sale blanco en modo oscuro; la misma
  cosa tiene tres nombres (Mock / Sample data / Example).

### Lo que ya funciona y no hay que tocar

- Estados vacíos honestos: una página Live nunca cae en números de ejemplo, y un fallo al leer el vault nunca se ofrece
  como "crea un vault".
- Los costes se enseñan antes del botón (alquiler del vault, del link, orden de los prompts de Phantom).
- La lista de 4 pasos del no_vault, marcada con datos reales, es el patrón bueno: solo hay que mantenerla visible.
- La landing funciona antes de que cargue el JS; "See the app" es un enlace real; la muestra siempre va etiquetada; si
  Privy se atasca hay una salida a la muestra.

## 6. Decisiones que tiene que tomar el dueño antes de tocar nada

1. ¿Re-sembrar la muestra en modo profit 20 % con la cesta real (SPYx / ANTHROPIC / …)? Cambia los números y textos
   de `/?mode=mock` y obliga a rehacer la captura de la landing.
2. ¿Renombrar "Live | Mock" (por ejemplo "My pension | Example") y "pension key" (por ejemplo "Solana wallet")?
3. ¿A dónde apuntan Docs, GitHub, X y Email? ¿El repo es público? ¿Quitar Privacy/Terms o poner páginas mínimas?
4. ¿Reescribir el texto de la landing (acciones tokenizadas, qué wallet necesitas, 3 pasos) y quitar la promesa de
   volumen, que aún no se ofrece?
5. ¿Hay un clip propio de SaverFi para la landing, o se aloja el actual en `public/`?

## 7. Hecho hoy (no lo propongas otra vez)

La página Live ES la muestra alimentada con datos reales (`src/lib/live-mock.ts`); la regla firma de verdad; logo en el
navbar; calendario semanal en la cabecera de SAVED SO FAR; dashboard sin scroll desde xl (hay scroll en 1366×768 y
1280×720); colores y fondos de los iconos del feed; loader entre pestañas y entradas suaves; footer con Explore en 2
columnas y "How it works" en 3 viñetas; la web tiene su propia RPC en Vercel (historial en ~0.45 s).

## 8. Plan final de la auditoría completa (añadido al terminar)

La auditoría terminó: 4 enfoques, 78 hallazgos, ninguno descartado por los revisores. El plan priorizado completo (qué
hacer, por qué, arreglo con file:line y esfuerzo) está en `/Users/walch/ProyectosCT/SIP/reports/UI_UX_AUDIT_2026-09-23.json`
(campo `result.plan`; los hallazgos en `result.kept`).

**Imprescindible antes de la demo** (~8-9 h sin re-sembrar la muestra, ~12-14 h con eso):
1. Las pestañas sacan de la muestra: pasar `?mode` en los enlaces de cabecera, footer y leaderboard (S, ~1 h).
2. En la muestra, la pestaña Activity enseña la misma página de pensión: hace falta un feed a ancho completo (M, 3-4 h).
3. La landing y la muestra anuncian otro producto: el texto de la landing (S), rehacer la captura
   `public/landing/app-dark.png`, que aún dice "Live data arrives with the Solana vault screens" (S, al final, desde
   producción) y, si el dueño quiere, re-sembrar la muestra en profit (M).
4. Enlaces muertos (Docs y el footer) y el leaderboard que abre vacío en "This week" (S). El repo en GitHub da 404
   sin login: no enlazarlo salvo que se haga público.
5. Cada carga Live dice "No activity yet" ~0.5 s: publicar snapshot e historial juntos, y "Load older" solo si hay
   cursor (S, ~1.5 h).
6. El modal enseña herramientas de operador a un usuario nuevo (S, ~1-1.5 h).

Orden sugerido: 1 → 2 → 4 → 5 → 6 → 3, y la captura de la landing la última.
**Ojo al reparto:** la sesión del dashboard puede estar haciendo parte de esto. Antes de empezar un punto, pregunta al
dueño qué chat lo hace, para no pisaros.
