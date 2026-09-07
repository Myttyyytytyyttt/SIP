# Ensayo desechable en mainnet — la ruta de inversión

**Fecha:** 16 de agosto de 2026
**Cadena:** Robinhood Chain mainnet, chainId **4663**
**Coste:** 0,00042 ETH

Este despliegue existe para probar que un vault compra acciones solo. **No es el
despliegue de producción** y no debe recibir dinero de nadie más que quien lo
pagó — su timelock tiene 15 minutos de retraso en vez de 7 días, así que una sola
llave de proposer puede actualizar el beacon de cualquier vault de la cohorte
dentro de esa ventana. Eso no se arregla ajustando nada: se arregla desplegando
otra vez con `NUVEM_GOVERNANCE_DELAY` por defecto.

El despliegue anterior, `reports/MAINNET_2026-08-04.md`, sigue en pie y sin tocar.

---

## Direcciones

| Contrato | Dirección |
| --- | --- |
| VaultFactory | `0x783BDF0281090f21928398cC3Da19cFb64Fed15E` |
| SettlementExecutor | `0xfA92ABF15dFAf470Cc8833Cb01464bD6CA139e16` |
| TimelockController (**15 min**) | `0x68f9FacACc35642F9c0862b2c9B45DA81ff1de34` |
| AdapterRegistry | `0x9822E46dd34d9bE579b61D26708a45Bf81B64E49` |
| PersonalVault (implementación) | `0x3b6e6C7bC55503a85A569fB9CdB0cE4c34eb88F6` |
| Beacon de la cohorte 1 | `0x44E3E3258ae1685Af4e0ED69D9DcfF2a7eA98659` |
| ProtocolPauseController | `0x418B3406BC483eB66ca5570b6fF91cE9d090E8a7` |
| AttesterRegistry | `0x1a96be4a757e065fb8928a2e5ab2Ab24790Ec7de` |
| VaultFactoryBootstrap (sellado) | `0x2c2C446C7e42F2C13F8371Dac47438D272ad25B9` |
| **NuvemStockAdapter** | `0x883e8530e3DAE691e9B9e7139C895f9AE8972C7A` |

`adapterId` = `0x5748e02be6563f13ab73852ecf2cfc86b84caebdfb1c242e3a4d26c7c67739d3`

Safe corporativo, guardián y attester son los mismos que el despliegue de agosto.

---

## Verificado en cadena tras desplegar

No contra el log del script — contra la cadena, que es lo único que cuenta:

- `protocolConfiguration()` apunta a los cuatro componentes de arriba y
  `protocolConfigured()` es `true`
- el executor apunta de vuelta a **esta** factory
- el beacon corre la implementación nueva y lo posee el timelock
- **`implementation.ADAPTER_REGISTRY()` devuelve la registry** — el immutable
  llegó, que es la razón entera de este rediseño
- la ceremonia se completó: `owner()` es el timelock y `pendingOwner()` es cero
- `isAdapterActive` es `true`, `resolveActiveAdapter` devuelve el adaptador y
  `adapterStatusEpoch` es **1**
- el codehash fijado en la registry coincide con el runtime real del adaptador,
  así que la registry ancla el BYTECODE y no solo la dirección
- Safe es proposer, el guardián puede cancelar, la ejecución es abierta

---

## Las doce acciones

Elegidas midiendo lo que cuesta comprar $500 a través de cada pool, no leyendo
su `liquidity` — que es √(x·y) en las unidades de cada pool y no se puede
comparar entre pools con precios y decimales distintos. QQQ tenía cuarenta veces
el umbral que usé al principio y cuesta 824 bps en una compra de $100.

| Símbolo | Dirección | fee | tickSpacing | coste $500 |
| --- | --- | --- | --- | --- |
| SPY | `0x117cc2133c37B721F49dE2A7a74833232B3B4C0C` | 500 | 5 | 5,0 bps |
| NVDA | `0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC` | 3000 | 60 | 30,3 |
| SGOV | `0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5` | 2500 | 25 | 30,7 |
| AAPL | `0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9` | 3000 | 60 | 31,2 |
| GOOGL | `0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3` | 3000 | 60 | 32,7 |
| MSFT | `0xe93237C50D904957Cf27E7B1133b510C669c2e74` | 3000 | 60 | 33,5 |
| TSLA | `0x322F0929c4625eD5bAd873c95208D54E1c003b2d` | 3000 | 60 | 36,4 |
| CRCL | `0xdF0992E440dD0be65BD8439b609d6D4366bf1CB5` | 3000 | 30 | 40,4 |
| META | `0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35` | 3000 | 60 | 42,0 |
| DJT | `0x1D11f0496982706C5e14A514D4E79F2e6BdE4516` | 4762 | 48 | 49,7 |
| TTWO | `0x5e81213613b6B86EaB4c6c50d718d34359459786` | 8000 | 80 | 82,9 |
| USO | `0xa30FA36Db767ad9eD3f7a60fC79526fB4d56D344` | 2500 | 25 | 91,1 |

El primer salto es WETH→USDG a `fee 200, tickSpacing 4`, que es el pool más
profundo **y** el más barato: 3,5× la profundidad del 500/10 y 252 pips de
comisión efectiva frente a 625.

**Las direcciones vienen de la lista curada de Uniswap Labs, no de Robinhood.**
Robinhood no publica lista legible por máquina y su registry no enumera. La
cadena confirma que cada una es un proxy de acción con la registry y el codehash
correctos; **no** confirma que el símbolo sea la empresa que dice. Un clon pasa
todos esos checks. Contrastar los doce contra
`docs.robinhood.com/chain/contracts` es un paso humano que ninguna herramienta
de este repositorio sustituye.

---

## Lo que falta para que un vault compre

1. Crear un vault en la web apuntando a esta factory
2. Invitar una wallet de trading y aceptarla
3. Operar y liquidar, para que entre WETH al vault
4. Configurar la cesta (`setInvestmentPolicy`) con el `adapterId` de arriba
5. `npx tsx bin/invest.mts plan` — cotiza y ejecuta por `estimateGas` sin gastar

La firma de Privy en modo `live` es lo único que no se ha ejercitado en ningún
sitio. El fork llegó hasta el borde: estimación real contra el vault, cotización
a 0,013 bps del fill, y los dos cerrojos disparando.

---

## Lo que sigue pendiente

- **El attester sigue siendo la clave de pruebas que pasó por un chat**, igual
  que el app secret de Privy, la key de autorización y la contraseña de Supabase.
- **La clave del deployer y del Safe se pegaron en un chat.** Para un ensayo
  desechable es una decisión defendible; para el despliegue real no lo es, y ese
  Safe es el proposer de la gobernanza.
- **Nadie vigila este timelock.** Con 15 minutos de ventana, el monitor importa
  más aquí que en el de siete días, no menos.
