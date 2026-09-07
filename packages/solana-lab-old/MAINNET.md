# Mainnet — el runbook

**Todo se conduce desde `program/scripts/mainnet.sh`**, que se auto-documenta.
Este fichero es el contexto que un comando no puede llevar.

## La economía, medida (no estimada)

| concepto | coste | ¿vuelve? |
|---|---|---|
| Rent del deploy (~392 KB) | **~2,79 SOL (~$210)** | **SÍ, al céntimo** — verificado con `solana program close` en local: "2.79171864 SOL reclaimed" |
| Capital + "profit" del drill | ~0,22 SOL | es dinero tuyo moviéndose entre tus bolsillos; acaba como NVDAx **retirable** en tu vault |
| Quema real | fees de tx + 2 fees de pool | céntimos |

**La regla de oro:** para iterar en mainnet se **actualiza** (`anchor upgrade`),
nunca se cierra y redespliega. Un program id cerrado muere para siempre
(verificado: *"has been closed, use a new Program Id"*) y con él mueren todos
los PDAs — vaults, links, políticas — que derivan de él. `close` es solo para
el final del experimento, tras retirar todo del vault.

## La secuencia

```bash
cd packages/solana-lab-old/program

./scripts/mainnet.sh preflight   # te dice la dirección a fondear y qué haría
# fondea esa dirección con ~3.2 SOL
./scripts/mainnet.sh deploy      # deploy + init_config EN EL MISMO ALIENTO
./scripts/mainnet.sh drill       # la cadena entera con dinero pequeño
./scripts/mainnet.sh status      # lo que citarías en un reporte
```

El drill: sesión jugada → profit **medido del historial real** → atestado →
settle → wrap → convert (ruta viva del pool wSOL/USDC) → invest (ruta viva del
pool NVDAx). Imprime las direcciones del vault y el link para pegarlas en la
tarjeta "Solana lab" de la web (con `NUVEM_SOLANA_RPC_URL` apuntando a mainnet
y el mismo `NUVEM_SOLANA_PROGRAM_ID`).

## Antes de correrlo, sabe esto

- **`init_config` es first-caller-wins.** Por eso `deploy` lo llama en la misma
  ejecución. Si aun así alguien ganara la carrera (el error lo dice), el
  remedio es cerrar y redesplegar con id nuevo, más rápido.
- **El RPC público estrangula.** El drill camina historial de transacciones;
  con `api.mainnet-beta.solana.com` esperarás. Una key gratis de Helius en
  `NUVEM_SOLANA_MAINNET_RPC` lo vuelve fluido.
- **Los suelos del drill son laxos a propósito** (convert ≈ $30/SOL, invest un
  floor simbólico). Protegen contra catástrofe, no contra slippage fino — eso
  es trabajo del keeper real que cotiza, que aún no existe. Cantidades
  pequeñas, siempre.
- **La upgrade authority es tu keypair de operador.** Suficiente para el
  experimento; un multisig (Squads) antes de que entre dinero ajeno.
- **El programa no tiene auditoría.** Decenas de dólares, no más.
- Las claves del attester y de la trading wallet persisten en
  `program/scripts/.local/` (gitignored). Perderlas no pierde fondos (el vault
  es del operador), pero el attester perdido = no más settles hasta redeploy.

## Qué es éxito

Ver en la tarjeta de la web, contra mainnet: `lifetime saved` > 0, el nonce del
link avanzado, y NVDAx real en el vault — comprado por el programa, desde
profit medido, sin que ninguna clave tuya saliera de tu máquina.
