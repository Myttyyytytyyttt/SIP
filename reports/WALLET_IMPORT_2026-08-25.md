# Importar la wallet existente del usuario — la investigación

**Fecha:** 25 de agosto de 2026 · **Método:** 4 investigadores (repo, Privy,
competencia/rutas externas, mecánica Solana) + verificación adversarial de cada
afirmación contra la fuente primaria. Los datos de cadena se leyeron en vivo
(arbOSVersion de la 4663, docs re-descargados ese día).

---

## La respuesta corta

**Sí, en ambas cadenas — y el mecanismo es el import de Privy: la flecha
inversa exacta del botón de exportar que ya está en la web.** El usuario pega
la clave privada de su wallet existente (MetaMask, Phantom, la de su bot), el
SDK la cifra **en el navegador** con HPKE directo al TEE de Privy (nuestro
servidor nunca la ve), y la wallet pasa a ser una wallet Privy **en la misma
dirección**: se le añade el firmante del keeper con la política de solo-settle
y el flujo de enlace existente funciona sin tocar nada. El usuario **conserva
su copia** y sigue operando en Axiom/Photon/BullX — mismo trust model que el
export, invertido.

## Por qué hace falta el import (leído del código, no supuesto)

- **Enlazar NO lo necesita.** `acceptTradingAccountBySig` es EIP-712 vía
  SignatureChecker (PersonalVault.sol:448) — un MetaMask conectado puede
  completar el enlace HOY con una firma gratuita. En Solana, `link_wallet` es
  co-firma estándar owner+wallet. Nada del enlace exige Privy.
- **Liquidar SÍ.** `settle()` exige `attestation.account == msg.sender`
  (SettlementExecutor.sol:249) y la contribución viaja como **ETH nativo en
  msg.value** (línea 105 → `acceptSettlement{value}`; el vault envuelve a WETH
  él mismo). En Solana igual: la wallet es `Signer` del settle y la
  contribución es **SOL nativo** por system transfer (settle.rs:36, 118-127).
  La wallet misma tiene que firmar cada liquidación ⇒ la clave tiene que estar
  donde el keeper pueda pedir firmas bajo política ⇒ Privy.
- **El keeper, con import, necesita CERO cambios.** Una wallet enlazada que
  Privy no conoce se salta en silencio como `foreign`
  (keeper-supervisor.mts:386-392; el join address→walletId es
  privy-wallets.ts:38). Una importada aparece en `wallets().list()` como
  cualquier generada, y todo el pipeline funciona.

## Privy import — estado verificado a 2026-08-25

- React: `useImportWallet` en `@privy-io/react-auth` (EVM, clave hex) y
  `@privy-io/react-auth/solana` (base58 — exactamente lo que exporta Phantom).
  Presente en la 3.36.0 instalada. Server: REST `/v1/wallets/import/init+submit`
  (+Node/Rust/Go), que acepta `owner`, `policy_ids` y `additional_signers`
  **atómicamente** — el hook de React NO (addSigners va después, misma
  no-atomicidad que el create actual; el componente ya lo trata como retriable).
- HPKE DHKEM_P256/HKDF_SHA256/CHACHA20_POLY1305, cifrado en cliente al TEE.
- "Imported wallets function the same way as Privy-generated wallets"
  (verbatim). Firmantes y políticas idénticos; los signers no pueden exportar
  la clave ni editar políticas. Solo difiere `imported_at`.
- **Sin gate de plan documentado** (confirmar con Privy igualmente; "solo una
  política por wallet / por signer" — encaja con nuestro diseño actual).
- Comprobar antes de enviar: que la importada aparece en `useWallets` con
  `walletClientType 'privy'` (el filtro del componente lo asume).

## more.ski — lo que hace de verdad (citas verificadas verbatim)

"MORE — auto-savings for traders", sobre **Turnkey**. "Link the wallets and
accounts you already trade with"; crea una wallet de AHORRO nueva no-custodial
en un sub-org Turnkey del usuario; desvía "1-3% of your volume" (¡por
**volumen**, no por beneficio atestado!); cadenas: Ethereum, BNB, Base, Solana,
Arbitrum One **y Robinhood Chain**, cobrando en USDG. **Sus páginas públicas
nunca dicen que obtengan autoridad de firma sobre la wallet existente** y el
mecanismo real de débito no está documentado ("account-by-account rollout").
No asumir que la paridad exige importar claves. Nuestro skim por beneficio
atestado es un producto más fuerte que su skim por volumen.

## EIP-7702 — el sueño sin pegar clave, y su estado real

- **Robinhood Chain LO SOPORTA**: docs.robinhood.com/chain/account-abstraction
  lo dice explícito, y arbOSVersion() en vivo = 116 ⇒ ArbOS 61 > ArbOS 40
  "Callisto" (Pectra). Privy también: useSign7702Authorization, txs tipo 4, y
  política que pinnea el contrato delegado (`ethereum_7702_authorization`).
- **Pero con wallets externas es callejón sin salida hoy**: MetaMask solo
  delega a SU Delegator (0x63c0c19a…), ninguna wallet mainstream expone
  signAuthorization a dapps, viem no lo soporta para cuentas JSON-RPC.
  7702 sirve para wallets DENTRO de Privy (creadas o importadas), no para
  evitar el paste. Prior art en el repo: aa-smoke/scripts/delegate-7702.mjs.
- **Revisitar pronto**: MetaMask Advanced Permissions (ERC-7715,
  `wallet_requestExecutionPermissions`, v13.23+, ya sin marca experimental).

## La vía no-custodial (para quien con razón no pega su clave de MetaMask)

- **EVM (rediseño, tier posterior):** executor v2 con `settleFrom()` — atar a
  `attestation.account` en vez de msg.sender y tirar de WETH con UN approve
  con tope; unwrap → acceptSettlement. El keeper envía y paga gas.
- **Solana: el delegate SPL NO cubre el producto** — SOL nativo no es
  delegable, el runtime prohíbe debitar lamports de una system account sin la
  clave, no existe equivalente de 7702 (Assign brickea la wallet como fee
  payer), un approve posterior de otra dapp desaloja al delegado, y los bots
  cierran ATAs por el rent. Para skims en SPL (USDC/wSOL) existe el programa
  nativo **Subscriptions & Allowances** (Solana Foundation + Moonsong,
  auditado Cantina/Spearbit, en mainnet): pulls recurrentes con tope, sin
  custodia. Precedentes que confirman la taxonomía: Jupiter DCA = depósito en
  escrow; Drift = delegado en estado del programa (opera, no retira); bots =
  custodial. **Nadie skimea SOL nativo sin clave.**

## El plan

**Fase 1 — enviar ya, ambas cadenas, cero cambios de contrato/keeper.**
`ImportTradingWallet` como rama hermana del create:
1. El usuario pega la clave; derivar la dirección EN CLIENTE
   (privateKeyToAccount) para previsualizar qué se enlaza y comprobar que no
   está ya enlazada; cero logs; borrar del estado tras la llamada.
2. `importWallet({privateKey})` → mismo `addSigners` de hoy. **En Solana usar
   el par NUVEM_SOLANA_SIGNER_ID / NUVEM_SOLANA_POLICY_ID — PRIVY_SETUP.md
   avisa explícitamente que el par EVM no gobierna wallets Solana.**
3. Flujo de enlace existente sin tocar (invite → EIP-712 accept → acceptBySig
   / link_wallet co-firmado).
4. Botón visible de REVOCAR (removeSigners). Aviso fuerte si la clave viene de
   bot de Telegram (el operador también la tiene; ofrecer sweep a wallet
   nueva). Copy honesto: "tomamos un asiento de firma limitado por política;
   tu clave sigue en tus otras apps; solo podemos liquidar hacia TU vault".
- Construirlo contra `packages/web` **y** `packages/website-oficial` (la
  oficial divergió y es la que se está tocando).
- Cautela real: **Photon muestra la clave UNA vez al crear y no permite
  re-exportar** — el paste no cubre a quien no la guardó.

**Fase 2 —** la vía no-custodial: `settleFrom` en EVM; Subscriptions program
en Solana para skims SPL. **No construir** sobre 7702-para-wallets-externas.

---

# Apéndice (26 ago 2026) — EIP-7702 a fondo, y el equivalente en Solana

Investigación adicional con verificación adversarial contra fuentes primarias
(eips.ethereum.org, repos ethereum/EIPs y ethereum/ERCs, repo SIMD clonado,
código de Agave, docs de MetaMask).

## EIP-7223 no existe

404 en `eips.ethereum.org/EIPS/eip-7223` **y** en `ercs.ethereum.org/ERCS/erc-7223`;
no hay fichero en ninguno de los dos repos. El 7223 de ese repo es un **número
de pull request** — PR #7223, "Update EIP-7201: Improve wording", mergeado el
23-jun-2023. Como los EIP heredan el número de su PR de apertura, un PR
consumido por una edición ajena deja ese número **permanentemente vacante**.
Por eso "7223" aparece en búsquedas sin designar nada. (EIP-223 sí existe: es
un estándar de tokens de 2017, nada que ver. RIP-7212 tampoco es un EIP: es un
Rollup Improvement Proposal, el precompile de secp256r1.)

El estándar es **EIP-7702 "Set Code for EOAs"** — Final, categoría Core,
creado 2024-05-07, enviado en Pectra.

## Cómo funciona 7702 de verdad

- Transacción **tipo 4** (`SET_CODE_TX_TYPE = 0x04`). Destino nulo NO es válido
  (no puede desplegar) y `authorization_list` vacía la invalida.
- Cada autorización es `[chain_id, address, nonce, y_parity, r, s]` sobre
  `keccak(MAGIC || rlp([chain_id, address, nonce]))` con `MAGIC = 0x05`.
  **Quien firma la autorización no tiene por qué ser quien envía la tx** — de
  ahí la delegación patrocinada.
- La cuenta **no recibe el bytecode**: recibe un designador de 23 bytes,
  `0xef0100 || address`. `CODESIZE` devuelve 23, no el tamaño real del
  delegado — lo cual **rompe el clásico `extcodesize == 0 ⇒ es una EOA`**.
- **Revocar** = firmar una autorización nueva apuntando a la dirección cero.
- **`chain_id = 0` vale en CUALQUIER cadena con 7702**. Si Nuvem lo usara,
  una autorización firmada para la 4663 sería replicable en mainnet y en toda
  cadena donde exista la misma dirección de delegado. **Fijar siempre 4663.**

## El muro para dapps, y la puerta que sí está abierta en la 4663

**No existe RPC estándar** para que una dapp pida a una wallet externa firmar
una autorización 7702 hacia el contrato que la dapp elija. ethereum.org lo dice
literal: *"There is no standardized method for dApps to request EIP-7702
authorization signatures directly"* y *"dApps should not expect to directly
request EIP-7702 authorizations"*; remite a **ERC-5792** y a **ERC-6900**
(esta última es la que nombra session keys). MetaMask solo delega a su propio
Delegator.

**Pero** — y esto lo encontró la verificación, no la investigación inicial —
las tablas de redes soportadas de MetaMask dan un resultado asimétrico para
chainId 4663:

| | Robinhood Chain |
|---|---|
| **MetaMask Smart Accounts** (delegation framework) | ✅ **desde Smart Accounts Kit v2.0.0** |
| **ERC-7715 Advanced Permissions** | ❌ ausente de las tablas mainnet y testnet, en toda versión hasta v2.0.0 |

Y el Smart Accounts Kit incluye un **Function Call delegation scope**:
`createDelegation({ scope: { type: ScopeType.FunctionCall, targets, selectors,
allowedCalldata | exactCalldata } })`, sobre los caveat enforcers
`allowedTargets`, `allowedMethods`, `valueLte`, `allowedCalldata`. Eso es
**exactamente la forma de `settle()`**: acotado, revocable, con la dirección
del usuario intacta. Es el camino EVM sin pegar clave que merece un spike.
(ERC-7715 sigue Draft y sus siete tipos de permiso son todos de movimiento de
valor — no hay permiso de llamada arbitraria; irrelevante aquí porque además
no está en la 4663.)

## Solana: no hay equivalente, y no tiene nombre

Repo SIMD clonado: **123 propuestas mergeadas + 21 PRs abiertos**, buscando
"account abstraction", "smart wallet", "session keys", "programmable accounts",
"EOA", "delegation", "passkey", "authorization". **Cero** propuestas darían a
una dirección de keypair existente la capacidad de ejecutar lógica de programa
o delegar en uno. La hoja de ruta 2026 de Anza tampoco lo menciona.
*(SIMD-0048 y SIMD-0075, los precompiles de secp256r1, mencionan account
abstraction como objetivo derivado — pero no proponen mecanismo alguno.)*

**Quien te dé un número de SIMD para esto se lo está inventando.**

Dos razones de runtime, confirmadas en el código de Agave:
1. Solo el programa propietario de una cuenta puede debitar sus lamports —
   `set_lamports` devuelve `InstructionError::ExternalAccountLamportSpend` en
   caso contrario (instruction_accounts.rs L120-124). Toda wallet de keypair
   pertenece al System Program.
2. El **pagador de fees debe ser propiedad del System Program** con datos
   vacíos: `validate_fee_payer` → `get_system_account_kind` → `None` →
   `TransactionError::InvalidAccountForFee` (L386). Codificado en
   **SIMD-0290 "Relax Fee-Payer Constraint"**, estado *Accepted*.

Y una cuenta de Solana tiene **cinco campos** —lamports, data, owner,
executable, rent_epoch— sin análogo al designador `0xef0100||address`.

**Corrección a lo que dije antes:** afirmé que `Assign` "brickea" la wallet de
forma permanente. No es estrictamente irreversible — `system_processor::assign`
exige que la cuenta firme, y un programa propietario puede reasignarla al
System Program si los datos están a cero. La conclusión no cambia: mientras
esté asignada fuera **no puede pagar comisiones**, así que sigue siendo
callejón sin salida para una wallet viva.

### Lo que Solana sí tiene, con sus nombres reales

| mecanismo | ¿SOL nativo? | ¿la dirección del usuario? |
|---|---|---|
| **Squads V4 Spending Limits** (cap/periodo/destinos) | **sí** | **no** — vault PDA, dirección nueva |
| **Subscriptions and Allowances** (Solana Foundation + Moonsong; `De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44`, mainnet, auditado Cantina; antes "multi-delegator") | no — **SPL y Token-2022 solamente** | sí |
| **SPL `approve`/`approveChecked`** | no | sí |
| **Token-2022 `permanentDelegate`** | no | a nivel de MINT, irrevocable por el holder — solo si emites tú el token |
| **delegado en estado de programa** (Drift/Velocity `update_user_delegate`) | dentro del protocolo | cuenta del protocolo |
| **session keys** (Gum archivado 2023; fork mantenido `magicblock-labs/session-keys`) | no | firmantes secundarios que tu programa debe soportar |

Matiz Token-2022: **el delegado puede auto-revocarse** (en el Token Program
original solo el propietario revoca).

**Veredicto para el skim de SOL nativo desde una wallet cuya clave no tenemos:
imposible.** No por falta de propuestas, sino por diseño del runtime.
