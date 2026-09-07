# Configurar Privy para el keeper de Solana

El keeper firma `settle` **como la trading wallet del usuario**, sin tener nunca
su clave privada. Para que eso funcione hacen falta tres cosas en el dashboard
de Privy, y una en tu `.env`. Esta guía es exactamente eso, en orden.

**Qué estás autorizando, en una frase:** que tu servidor pueda pedirle a Privy
que firme transacciones desde las wallets de tus usuarios, limitado por una
política que solo permite tocar el programa de Nuvem.

> Verificado contra los docs de Privy (`/wallets/using-wallets/signers/configure-signers`
> y `/controls/policies/example-policies/solana`) el 22 de agosto de 2026.

---

## 1. Crear la authorization key (el "signer")

Dashboard → **Wallet infrastructure → Authorization keys** → **Create new key**.

El modal te enseña **dos valores** y es la única vez que verás el segundo:

| valor | dónde va | qué es |
|---|---|---|
| **key quorum ID** | `PRIVY_SIGNER_ID` | público; identifica al signer |
| **private key** (P-256) | `PRIVY_AUTHORIZATION_KEY` | **secreto**; con él tu servidor autoriza cada petición |

⚠️ **Privy nunca ve esa clave privada y no puede recuperarla.** Si la pierdes,
creas otra key quorum y vuelves a registrar el signer en cada wallet. Guárdala
como guardas la clave del attester: fuera del repo, fuera del chat.

---

## 2. Crear la política (lo que el signer puede hacer)

Dashboard → **Wallet infrastructure → Policies** → nueva política.

Esta es la que limita el daño si tu servidor se ve comprometido. Copia tal cual:

```json
{
  "version": "1.0",
  "name": "Nuvem Solana — settle only",
  "chain_type": "solana",
  "rules": [
    {
      "name": "Only the Nuvem vault program, Ed25519 and ComputeBudget",
      "method": "signAndSendTransaction",
      "conditions": [
        {
          "field_source": "solana_program_instruction",
          "field": "programId",
          "operator": "in",
          "value": [
            "7rtgXTu852M1NTx7PLoJd3bChaCb2hgsgv5o54aFv6Fy",
            "Ed25519SigVerify111111111111111111111111111",
            "ComputeBudget111111111111111111111111111111"
          ]
        }
      ],
      "action": "ALLOW"
    }
  ]
}
```

Guarda el **policy ID** que te devuelve → va a `PRIVY_POLICY_ID`.

**Los tres programas y por qué cada uno:**

- `7rtgXTu8…` — el programa nuvem_vault en mainnet. Es el que ejecuta `settle`.
- `Ed25519SigVerify…` — el precompilado que verifica la firma del attester. La
  transacción de settle lleva esa instrucción justo antes; sin permitirla, la
  política rechaza la transacción entera.
- `ComputeBudget…` — la instrucción de presupuesto de cómputo. Inofensiva, pero
  si no está permitida, cualquier transacción que la lleve muere.

**Por qué `signAndSendTransaction` y no `signTransaction`.** Las políticas de
Solana en Privy solo saben filtrar cuatro métodos: `*`, `exportPrivateKey`,
`signAndSendTransaction` y `signMessage`. **`signTransaction` no está**, así que
un keeper construido sobre él correría con un signer que la política NO podría
acotar — una credencial ilimitada disfrazada de acotada. Por eso el keeper usa
`signAndSendTransaction`: Privy firma y difunde, y el allowlist de programas
queda en vigor.

**Y por qué no `*` con condiciones.** El editor visual del dashboard solo ofrece
los campos `solana_program_instruction` cuando el método es concreto; con `*` la
única fuente disponible es `System`. Método concreto y condición real es la
combinación que funciona.

**Lo que esta política NO puede hacer, y hay que saberlo.** Privy en Solana solo
puede filtrar por `programId` — no puede fijar qué instrucción concreta del
programa se llama ni sus argumentos. Es más ancho que la política de Robinhood
Chain, que sí fija el selector.

**Por qué aun así es suficiente:** el destino del dinero lo garantiza el
programa, no la política. `settle` solo puede mover fondos de la wallet al vault
que su `TradingLink` nombra. Un keeper comprometido podría, como mucho,
disparar un settle que la cadena habría aceptado igual — nunca redirigir fondos
a otro sitio.

---

## 3. Registrar el signer en cada wallet — ya está automatizado

Esto **no lo haces en el dashboard**: lo hace la web sola. Cuando el usuario
crea su trading wallet en la tarjeta de onboarding, la app llama a `addSigners`
con tu `PRIVY_SIGNER_ID` y tu `PRIVY_POLICY_ID`.

Lo verás en el log de la tarjeta:

```
✓ trading wallet 4T52Jiz2…
✓ keeper signer registered — settle will run automatically
```

Si en su lugar sale `⚠ PRIVY_SIGNER_ID not set`, es que falta la variable en la
web: el keeper descubrirá la wallet pero Privy se negará a firmar por ella.

---

## 4. Las variables

**En la web** (`packages/web/.env.local`, y en Vercel cuando toque):

```bash
PRIVY_APP_ID=...                  # ya lo tienes
NUVEM_SOLANA_SIGNER_ID=...        # el key quorum ID del paso 1
NUVEM_SOLANA_POLICY_ID=...        # el policy ID del paso 2
```

⚠️ **Son variables PROPIAS de Solana, no reutilices `PRIVY_SIGNER_ID`.** Esas
dos ya apuntan al signer y la política de Robinhood Chain, que el flujo EVM usa
en `InviteTradingWallet`. Una política EVM está acotada a su cadena y no puede
gobernar una wallet de Solana: compartir la variable registraría el signer
equivocado en todas las wallets.

**En el keeper** (donde corra el supervisor):

```bash
PRIVY_APP_ID=...
PRIVY_APP_SECRET=...              # dashboard → App settings
PRIVY_AUTHORIZATION_KEY=...       # la clave privada del paso 1
NUVEM_SOLANA_MAINNET_RPC=...      # Helius
NUVEM_SOLANA_POOLS=Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh=49iMatQtoyabsYAQc8GafVq6aeBFVDxSRH44oiatyyw6
```

**Cómo saber que Privy quedó bien conectado:** al arrancar, el supervisor dice
en qué modo firma. Quieres ver esto:

```json
{"msg":"supervisor starting", "signing":"Privy (no local wallet keys)", ...}
```

Si dice `"local keypairs (.local/signers)"`, falta alguna de las tres variables
de Privy y el keeper no podrá liquidar wallets de testers.

---

## 5. El orden para probar en Axiom

1. Pasos 1 y 2 de arriba (dashboard), y las variables del paso 4.
2. Reinicia la web. Onboarding: crear vault → crear trading wallet (mira que
   salga `keeper signer registered`) → exportar la clave.
3. Importa esa clave en Axiom. Fondéala. Opera de verdad.
4. Arranca el supervisor **primero en dry-run** — sin `--broadcast` no envía
   nada y te enseña lo que mediría:
   ```bash
   cd packages/solana-lab-old/program && npx tsx keeper/bin/supervisor.mts
   ```
   Busca en el log tu wallet y la línea `settle`. Si dice `no_profit` tras una
   sesión ganadora, algo hay que mirar **antes** de mover dinero.
5. Cuando el dry-run mida lo que esperas, en vivo:
   ```bash
   NUVEM_SOLANA_ALLOW_BROADCAST="i-understand-this-moves-real-funds" \
     npx tsx keeper/bin/supervisor.mts --broadcast
   ```

---

## Lo que sigue sin estar resuelto

Dos cosas que no arregla ninguna configuración, y que conviene tener presentes
antes de meter a nadie más:

- **El programa no está auditado**, y su upgrade authority es un solo keypair
  tuyo. Quien pueda usar esa clave puede cambiar la lógica del vault.
- **Las xStocks son confiscables por el emisor**: Backed tiene `permanentDelegate`
  sobre esos mints y puede mover o quemar tokens desde cualquier cuenta,
  incluido el vault. Está documentado en `reports/SOLANA_2026-08-17.md` §2.

Para un test cerrado con gente que sepa esto y cantidades pequeñas, vale. Para
abrirlo a desconocidos, no.
