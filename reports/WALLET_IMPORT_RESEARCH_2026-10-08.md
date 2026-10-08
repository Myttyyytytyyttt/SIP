# Wallet import: the four research reports behind the brief (2026-10-08)

Read-only research. The brief is reports/WALLET_IMPORT_BRIEF_2026-10-08.md; these are its sources.

## 1. The previous project's code

# How Nuvem imported a user's existing wallet, and what carries over to SaverFi on Solana

The import was **built for both EVM and Solana** but **never shown working with a real key**. Nuvem used Privy's client-side `useImportWallet` and attached the keeper's policy-bound signer in the same call (`additionalSigners`). It needed no changes to the keeper or the contracts. Most of the Solana version carries over to SaverFi as it is.

## 1. Sources
- Research report: `/Users/walch/ProyectosCT/Nuvem/reports/WALLET_IMPORT_2026-08-25.md` (238 lines, plus an appendix dated 26 Aug).
- EVM code:
  - `packages/website-oficial/src/components/InviteTradingWallet.tsx`: the import branch in onboarding, with full guards.
  - `packages/website-oficial/src/components/WalletsPanel.tsx:73-110, 452-478`: a quieter import box in the wallets column.
- Solana code: `packages/website-oficial/src/components/SolanaPanels.tsx`
  - `importAndLinkTradingWallet` at :707-753
  - `SolanaImportBox` at :1305-1352, mounted at :1511 and in `SolanaOnboarding.tsx:144`
- Test script: `packages/website-oficial/scripts/check-import-judge.mts`. It runs as `check:import` in `prebuild` and `verify` (`package.json:8,16,18`).
- Keeper: `packages/solana-lab/program/keeper/src/privy-signer.ts:72-88, 112-160`. It has no import-specific code.

Commits (`git log -S importWallet` / `-S SolanaImportBox`):

| Commit | Date | What it did |
|---|---|---|
| `c80aa12` | 2026-08-25 | docs: the research report |
| `fa1148f` | 2026-08-26 | EVM "bring your own wallet" in InviteTradingWallet (+300 lines) |
| `a74523c` | 2026-08-26 | second review round; the judge becomes a pure exported function and the check script appears |
| `247ee4b` | 2026-08-27 | Solana import ("quiet door") and signer-registration retry with backoff |
| `9585a37` | 2026-08-27 | in production, the Solana policy-id variable held the signer id; guards added |
| `33607b5` | 2026-08-27 | the created wallet is "born with its seat", copying the import's atomic signers |
| `e193a4a` | 2026-08-29 | EVM import box added to WalletsPanel |

**Earlier SIP lineage:** SIP itself once had an EVM `wallets/ImportWalletDialog.tsx`. It was added in `968e06c` (2026-09-08) and deleted in `0841f6a` (2026-09-14, "SIP is Solana-only"). An open finding about it sits at `SIP/reports/PENDING_REVIEW_FINDINGS_2026-09-07.md:41`: its preflight checked `activeVaultOf` but not `vaultOfAdmin`.

## 2. Why Nuvem imported the key instead of connecting the wallet (report lines 22-39)
- **Linking did not need it.** EVM linking used an EIP-712 signature, and Solana's `link_wallet` was co-signed by owner and wallet.
- **Settling did need it.** The trading wallet itself must sign every `settle`. On Solana the wallet is a `Signer` and the contribution is a native SOL system transfer. A wallet that is only connected would link fine and then never save anything (commit `fa1148f`).
- **Signing without the key is impossible on Solana.** No mechanism skims native SOL from a keypair wallet without its key (appendix lines 191-238). The available alternatives:
  - SPL delegate / Subscriptions & Allowances: SPL tokens only.
  - Squads spending limits: give a new address.
  - No 7702-style delegation exists on Solana.
- **The keeper needed zero changes.** An imported wallet shows up in `privy.wallets().list({chain_type:"solana"})` like a generated one. SaverFi's keeper uses the same index pattern (`SIP/packages/solana-keeper/src/privy-signer.ts:256, 343`).

## 3. User flow, step by step

### EVM, full version (`InviteTradingWallet.tsx`)
1. The user opens "Use a wallet I already have" (:935).
2. The key goes into a password input with `autoComplete="new-password"`, `data-1p-ignore`, `data-bwignore` and `data-lpignore` (:950-953). These stop password managers from saving the key.
3. **Judge** (`judgePastedKey`, :87-115): a pure function that runs on every keystroke.
   - Spaces → "that looks like a seed phrase".
   - Base58 of 80-96 characters that cannot be hex → "that is a Solana key".
   - Anything else must be 64 hex characters.
   - `privateKeyToAccount` derives the address; a key outside the curve gets "do not form a valid key".
4. The derived address is shown before anything happens: "Check it is the address you expect" (around :965-972).
5. Preflights in `importRun` (:493), all before the key reaches Privy:
   - Signer id set but policy id missing → refuse (:500-509).
   - **One imported wallet per Privy user**: if a different address is already imported (ethereum only), refuse and name it (:512-535).
   - The key belongs to the admin/owner → refuse (:539).
   - The factory's `activeVaultOf(address)` says the wallet feeds a different vault → refuse (:562). If it already feeds this vault, report done.
   - The address already exists inside Privy → skip the import and only attach the seat and link.
6. `importWallet({ privateKey, additionalSigners:[{signerId, policyIds:[policyId]}] })` when both ids exist; otherwise a bare import followed by `authoriseKeeper` → `addSigners` (:597-631).
7. The key is cleared from state on every exit path. Errors are redacted with `/(0x)?[0-9a-fA-F]{41,}/` (:635-640).
8. The existing link flow runs unchanged (invite, then EIP-712 accept). Failed links get a retry button that needs no key.

### Solana (`SolanaPanels.tsx`)
1. A text link reads "…or import a wallet you already trade with". The input is a password field with placeholder "base58 private key" (:1305-1352).
2. On click, the key is cleared from state *before* the call (:1338-1340).
3. `requireGrantableSeat()` (:424): if a signer is configured but its policy is not usable, refuse before anything enters Privy.
4. `importWallet({ privateKey, additionalSigners:[{signerId: solanaSignerId, policyIds:[solanaPolicyId]}] })` from `@privy-io/react-auth/solana` (:715-731). Without both ids it does a bare import, then `registerSigner` (`addSigners` with backoff, :440-498).
5. `linkFreshWallet` (:546): waits for the wallet to appear in Privy's store, then builds a `link_wallet` transaction co-signed by owner and wallet, with the wallet signing through Privy's `useSignTransaction`.
6. Errors are redacted with `/[1-9A-HJ-NP-Za-km-z]{45,}/`. "already has an imported wallet" is rewritten into plain words (:737-750).

## 4. Privy calls, chain and signer mode
- **Client only, in both chains.** Nuvem made no server-side import call.
  - EVM: `useImportWallet` from `@privy-io/react-auth`.
  - Solana: `useImportWallet` from `@privy-io/react-auth/solana`.
  - Both use `useSigners().addSigners` as the fallback.
- **SDK signature** (installed 3.36.0, also SaverFi's version):
  - `importWallet({ privateKey: string; additionalSigners?: SessionSignerInput }) => Promise<Wallet>`
  - The Solana docstring says additional signers are "Only supported for TEE wallets" (`node_modules/@privy-io/react-auth/dist/dts/solana.d.ts:19-34`).
- **The React hook takes no `owner` or `policy_ids`.** The server route, REST `/v1/wallets/import/init` + `/submit` (HPKE DHKEM_P256 / HKDF_SHA256 / CHACHA20_POLY1305), accepts `owner`, `policy_ids` and `additional_signers` atomically. Note the docs typo "additional_singers". Source: https://docs.privy.io/wallets/wallets/import-a-wallet/private-key.
- **The key never reaches the app's server.** The SDK encrypts it in the browser straight to Privy's enclave.
- **How the keeper's seat was attached:** `additionalSigners` at import time, which needs TEE mode. Nuvem never sent an empty `policyIds` array, because Privy reads an empty array as **full permission**. Fixed in `fa1148f` (EVM) and `9585a37` (Solana).
- **SaverFi's Privy app is already in TEE mode**, recorded 14 Sep in `SIP/reports/SIP_SOLANA_ROADMAP_2026-09-13.md:350`.
- **Imported wallets are documented as identical to generated ones:** "Imported wallets function the same way as Privy-generated wallets" (same docs page). The only difference is `imported_at`.

## 5. What "import judge" means
`judgePastedKey` is a pure function that classifies the pasted text *before* anything is done with it. It turns each likely mistake (seed phrase, wrong-chain key, wrong length, out-of-curve key) into a specific message, and returns the derived address on success.

`check-import-judge.mts` drives the real exported function with about 16 vectors and runs in prebuild. The adversarial cases:
- A 64-character string valid in both alphabets must resolve as **hex**.
- 88 hex characters must **not** be called a Solana key. This was a real misdiagnosis caught in `a74523c`.
- The zero key and a key above the curve order are refused in words.

**The judge exists only on EVM.** The Solana path has no judge and no address preview.

## 6. Proven live versus only built
**Proven:**
- The judge script; it is mutation-tested according to `a74523c`.
- Two contract facts on a mainnet fork: re-inviting an active account reverts, and inviting the admin reverts (`a74523c`).
- The policy-id/signer-id mix-up, confirmed against the live Privy API (`9585a37`).

**Only built, never proven:** the import itself.
- `fa1148f` says the panel's walk-through "is the owner's ten seconds, not provable from here".
- I found no evidence of a real import on either chain: no commit, report or memory entry records an imported wallet, an `imported_at` value, or a settle from an imported wallet.
- The "first real onboarding run" in `247ee4b` and `33607b5` used a **created** wallet.
- SaverFi's roadmap item `despues-importar` (`SIP_SOLANA_ROADMAP_2026-09-13.md:683-688`) lists done as "an imported key receives a real settle". That has not happened.

## 7. Known limits and bugs
1. **One imported wallet per Privy user.** The EVM docstring says the hook "will error if the user already has an imported wallet" (`dts/index.d.ts`, EVM `UseImportWalletInterface`). The Solana docstring in 3.36.0 does **not** say this; Nuvem's Solana code assumed it anyway. Whether it applies on Solana is not verified, and it is a key product limit for traders with several wallets.
2. **The Solana path skipped every guard the EVM path learned:**
   - no judge and no derived-address preview;
   - no check that the key is not the owner/pension key;
   - no check that the wallet is not already linked to another vault before the key enters Privy;
   - no one-imported-wallet preflight.
3. **Password-manager regression.** `SolanaPanels.tsx:1329` and `WalletsPanel.tsx:90` use `autoComplete="off"` on a password input. `fa1148f` found that browsers ignore this and fixed it only in InviteTradingWallet.
4. **Inconsistent redaction:**
   - WalletsPanel redacts 48+ hex characters, while InviteTradingWallet moved to 41+ so a key clipped by message truncation still redacts.
   - The Solana comment says "40+" but the regex is `{45,}`.
5. **WalletsPanel closes the box even when the import failed** (`onImport(...).then(() => setOpen(false))`; errors are caught internally).
6. **Only one key format is handled.** Base58 is assumed. A `solana-keygen` JSON byte array (`[12,34,…]`) is not converted. Phantom exports 88-character base58, which matches.
7. **Not everyone kept their key.** The report notes that Photon shows the key only once and does not allow re-export (lines 118-119).
8. **Others may hold the key too.** A key from a Telegram bot is also held by the bot operator. The report recommends a strong warning (line 112); it was not implemented.
9. **Nothing is atomic without the signers.** Without `additionalSigners` (non-TEE apps), import and seat are two calls with a gap. That is the race documented in `247ee4b` and `33607b5`: "not associated with current user".
10. **There is no revoke button.** The report asks for a visible `removeSigners` control (line 111); I did not find one in the import commits. Not verified elsewhere.

## 8. Carry-over to SaverFi on Solana
**Carries over almost directly:**
- The Solana import call:
  ```ts
  importWallet({ privateKey, additionalSigners: [{ signerId: SIP_SOLANA_SIGNER_ID, policyIds: [SIP_SOLANA_POLICY_ID] }] })
  ```
  It goes through SaverFi's existing `keeperSigners(config)` / `SeatNotConfigured` gate in `SIP/packages/website-oficial/src/lib/trading-wallets.ts:146-173`.
- The refusal rules:
  - refuse before import when the seat is not grantable;
  - never send an empty `policyIds`;
  - clear the key from state before the call;
  - redact base58 runs in error messages.
- The keeper needs no change: it uses the same `wallets().list` index.
- The wallet list already handles imported wallets:
  - `tradingWalletsOf` sorts imported ones last (`trading-wallets.ts:116-135`);
  - the row reads "Imported wallet" (`components/wallets/TradingWalletRow.tsx:156`);
  - the fixture includes `IMPORTED` (`test/fixtures/privy-user.ts:97-108`).
  - All of this is tested only with fixtures; no real imported wallet has gone through it.
- The judge's idea, rewritten for Solana:
  - base58-decode to 64 bytes;
  - derive the public key with `Keypair.fromSecretKey` and show it;
  - accept a JSON byte array;
  - recognise seed phrases;
  - recognise a 0x-hex EVM key as "wrong chain".
- The EVM preflights, translated:
  - refuse when the derived address equals the pension key (SaverFi's `linkWalletFlow` already refuses this, `vault-flows.ts:851`);
  - read the wallet's TradingLink PDA (`deriveLinkAddress`) to refuse a wallet already linked to another vault *before* the import;
  - when the address is already in Privy, skip the import and go straight to seat and link.

**What differs in SaverFi:** linking needs the **SIP_LINK_V1 off-chain consent**. The trading wallet must sign the 140-byte message through the user's Privy `signMessage`, then pension key and wallet co-sign the transaction (`vault-flows.ts:23-32, 846-887`). Nuvem's Solana link was only a co-signed transaction.

An imported wallet should be able to sign that message as its owner, like a created one, since the keeper policy's ban on `signMessage` applies to the keeper's signer, not the user. This is not verified for imported wallets.

**EVM-only, does not carry over:**
- hex/`privateKeyToAccount` judging;
- `activeVaultOf` on the factory;
- the EIP-712 invite/accept and `acceptTradingAccountBySig`;
- the ethereum-only filter on the one-imported-wallet check;
- the whole EIP-7702 / ERC-7715 / MetaMask delegation research (appendix).

**Open questions for the new chat:**
1. Does Privy enforce one imported wallet per user on Solana in 3.36.0 (or newer)? Check the docs or Privy support.
2. Does import with `additionalSigners` succeed against SaverFi's TEE app and its policy, and does the keeper then find the wallet with `SIGNER` granted? This needs one real import with a throwaway key; done means one real settle from it.
3. What key formats do Axiom and GMGN export?
4. Copy and warnings: shared keys from Telegram bots, and "you keep your copy".
5. A visible revoke control (`removeSigners`).

## 2. The owner's conversation in the previous project

# Wallet import in the old EVM project: what the owner's import session decided, found, built and left open

**Source:** transcript `/Users/walch/.claude/projects/-Users-walch-ProyectosCT-Nuvem/7cb530fb-6e04-4572-80f9-2ae7d2e70fe6.jsonl`, 1,908 lines, 2026-08-16 to 2026-08-25. Only the last part (line L1402 onward, 2026-08-25 01:25Z to 23:06Z) is about wallet import. Everything before it covers the keeper, deploys and Railway on the EVM chain, and is irrelevant here.

**Also read, read-only:** the full results of the three workflows that session ran. Their output was cut short inside the transcript, so I took them from their `journal.jsonl` files:
- research: `.../67ef6f95-.../subagents/workflows/wf_d3aa42f9-ab8/journal.jsonl`
- review round 1: `.../7cb530fb-.../wf_906e3595-5f6/journal.jsonl`
- review round 2: `.../7cb530fb-.../wf_b8139fb6-0d8/journal.jsonl`

I also read the committed report and code in the old repo (`/Users/walch/ProyectosCT/Nuvem`), and the installed Privy SDK type definitions in SaverFi. The old project's name must not appear in anything public.

## 1. What the owner asked for and decided

| When (UTC) | Owner, verbatim (Spanish) | Meaning |
|---|---|---|
| 08-25 01:25 (L1402) | "puede un user "importar" su wallet a nuestro website … que se linke a su vault?" … "la competencia more.ski tiene esa opcion" … "especialmente solana tambien" | Asked for deep research: can a user bring an existing wallet and link it to their vault, on EVM and especially Solana, as the competitor more.ski seems to do. |
| 08-25 22:19 (L1464) | "pondremos un boton en el onboarding debajo del generate que sera Use Your Wallet" … "explique nosotros no tenemos acceso a la wallet y es solo una configuracion" … "por import o algo asi que funcione o por connect o por PK no? miralo tu" | **Product decision:** put a "Use your wallet" button under Generate in onboarding (`website-oficial`). The copy must say "we have no access to your wallet, it is only a setting". He left import vs connect vs private key to the assistant. |
| 08-25 22:31 (L1669) | "dime lo que encontró la review y commitea" | Approved the commit. |
| 08-25 22:42 (L1767) | "voy a probar el import con una wallet real … busca a ver que no tenga ningun bug critico" | Said he would test with a real wallet. **The transcript ends before he reports any result.** Whether a real import was ever done: not verified. |

A related observation from earlier (L807, 08-17): "al generar una trading wallet … me genero la misma trading wallet que tenia ya antes". The assistant traced this to `createWallet` being called without `{createAdditional: true}` while `useWallets()` had not loaded yet, so Privy returned the existing wallet.

## 2. The design decision: import the private key; connecting is not enough

The assistant's conclusion (L1665), which the owner accepted: "es por clave privada, no por connect, y no es preferencia". It is the private key, not connect, and that is not a preference:
- **Linking does not need Privy.** On EVM it is an EIP-712 signature through `acceptTradingAccountBySig` (PersonalVault.sol:448). On Solana, `link_wallet` is co-signed by the owner and the wallet (link_wallet.rs).
- **Settlement does need the wallet's own signature, every time.** On EVM, `settle()` requires `attestation.account == msg.sender` (SettlementExecutor.sol:249) and pays in native ETH through `msg.value` (:105). On Solana, the wallet is the `Signer` of settle and the contribution is native SOL moved by a system transfer (settle.rs:36, 118-127).
- So a wallet that is only connected would link fine and then never save anything. The key has to be inside Privy, where the keeper can request signatures under the policy.
- **The keeper needs no changes for an imported wallet.** It appears in `wallets().list()` like a generated one. A linked wallet that Privy does not know is skipped silently as "foreign", with no alert (keeper-supervisor.mts:386-392; the address-to-walletId join is in privy-wallets.ts:38).
- **SaverFi difference:** SaverFi uses a pull model with a Privy seat, not wallet-pushed settles. The rule that a wallet Privy does not know gets nothing still applies, because the keeper signs as the trading wallet through the seat. Whether SaverFi's keeper discovers imported wallets the same way: not verified.

## 3. Facts found about Privy import (research of 08-25, adversarially verified)

**Surfaces**
- React: `useImportWallet` from `@privy-io/react-auth` takes a hex key (EVM). The same hook from `@privy-io/react-auth/solana` takes a base58 key, which is exactly what Phantom exports.
- Server: Node `privy.wallets().import()`, REST `/v1/wallets/import/init` then `/submit`, plus Rust and Go SDKs.
- Seed-phrase (HD) import exists only on the server, REST and Go surfaces, not in the React hook.
- Docs: https://docs.privy.io/wallets/wallets/import-a-wallet/private-key, .../hd-wallets

**Encryption and the TEE**
- `init` returns a temporary TEE public key. The client encrypts the key with HPKE (DHKEM_P256_HKDF_SHA256, HKDF_SHA256, CHACHA20_POLY1305, mode BASE). It is decrypted only inside the TEE, and the temporary keypair is destroyed.
- So the app's server never sees the key. This is Privy's design claim. Docs: .../import-a-wallet/architecture

**First-class wallets**
- Docs, verbatim: "Imported wallets function the same way as Privy-generated wallets". The only difference in the wallet object is an `imported_at` timestamp.
- Signers "cannot export the wallet's private key" and cannot change owners, signers or policies (docs.privy.io/controls/authorization-keys/owners/overview#signers). The keeper's seat is therefore no stronger for an imported wallet than for a generated one.

**Attaching the keeper's signer in the same call**
- REST `submit` accepts `owner`, `policy_ids` and `additional_signers`.
- One verifier said the React hook takes only `privateKey`. That was **wrong for the installed SDK**: `importWallet({ privateKey, additionalSigners })` exists in 3.36.0. I confirmed it in SaverFi's `packages/website-oficial/node_modules/@privy-io/react-auth/dist/dts/solana.d.ts:19-34`, with the note "Only supported for TEE wallets".
- SaverFi pins `@privy-io/react-auth` 3.36.0 (packages/website-oficial/package.json:23).

**One imported wallet per user**
- The EVM hook's docstring says: "This method will error if the user already has an imported wallet" (index.d.ts:3250 in 3.36.0).
- **The Solana hook's docstring does NOT say this.** It only says it errors "if the user exits in the middle of the flow" (solana.d.ts:21-22).
- Whether the limit is per account, per chain type, or exists at all on Solana TEE wallets: **not verified.** The round-2 reviewer flagged it explicitly: "Verify which semantics Privy enforces before Solana ships."

**One policy per wallet**
- The API reference says "Currently, only one policy is supported per wallet", and each additional signer's `override_policy_ids` takes up to one policy. That fits a single seat policy.

**Pricing and plan**
- No import-specific gate in the docs or on privy.io/pricing. "Delegated access to wallets" is listed on both the Developer and Enterprise plans.
- Policies appear as an Enterprise feature or add-on, which the app already runs.
- The research said twice: "confirm with Privy … absence of a documented gate is not proof". **Never confirmed.**

**Solana policy granularity**
- For a custom program, a policy can only match `programId`, not which instruction or its arguments.
- The two verifiers disagree on whether `signTransaction` is in the Solana policy method list: one says it is listed, the other says it is absent. Not verified.

**Edge cases the docs do not answer** (flagged, never tested)
- Importing an address that is already linked to a user as an external wallet.
- Two users importing the same key.
- The same address imported into another Privy app.

**Trust delta to state in the UI**
- Import is a COPY. The user's original key keeps working in Axiom, GMGN, Phantom, and for Telegram bots the bot operator also holds it.
- Policies constrain only signatures made through the TEE.

**Bot coverage caveat**
- One verifier found the claim that "every bot lets you export" false.
- Photon shows the key once at wallet creation and cannot re-export it, so pasting does not work for a user who never saved it. Per-bot export ability should be confirmed bot by bot.

## 4. Alternatives the research rejected (relevant to Solana)

- **Native SOL cannot be delegated.** Only the account's owner program can debit lamports, and wallets are owned by the System Program. SPL `approve` covers tokens only. It has one delegate slot per token account (another dapp's approve evicts ours), and bots close token accounts to reclaim rent.
- **There is no EIP-7702 equivalent on Solana.** The 08-26 appendix in the report adds that the SIMD repo was searched and nothing matches. `Assign` would make the address unusable as a fee payer.
- **Squads v4 spending limits** require a new smart-account address, so the user could no longer trade from it in keypair tools.
- **Subscriptions & Allowances program** (`De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44`) covers SPL and Token-2022 only. It was earmarked as phase 2 for skims paid in USDC or wSOL.
- **Verdict** (report line 237): skimming native SOL from a wallet whose key you do not hold is impossible.
- **more.ski:** runs on Turnkey and skims 1-3% of volume. Its public pages never claim signing authority over the user's existing wallet; they create a new savings wallet instead.
- **Fallback custody providers:** Turnkey, Dynamic and Web3Auth MPC Core Kit.

## 5. What was built (old repo, EVM, `packages/website-oficial`)

**Commits**
- `c80aa12` — research report `reports/WALLET_IMPORT_2026-08-25.md`
- `fa1148f` — "bring your own wallet" feature
- `a74523c` — fixes after the second review round
- In each case only the assistant's own files were committed.

**Files:** `src/components/InviteTradingWallet.tsx`, plus a pure validator extracted for drills (`check:import`, wired into prebuild and mutation-tested). Line references below are from a74523c.

**Paste validation:** `judgePastedKey` (:85) tells apart a seed phrase, a base58 Solana key and bad hex. Pure 88-character hex used to be misread as Solana; a drill found this and it was fixed.

**Checks before anything irreversible, all done client-side:**
- The address is derived and shown as a preview.
- The admin's own key is refused, because owner = trading is refused on chain.
- `activeVaultOf(address)` (:447) refuses a wallet that already feeds a different vault. If it already feeds this vault, the half-finished attempt is completed instead.
- A previous import on the account is detected through `linkedAccounts`, filtered by `imported === true` and `chainType === "ethereum"` (:408-415).

**The import call:** when both ids are configured, the keeper's signer is attached in the same call: `importWallet({ privateKey, additionalSigners: [{ signerId, policyIds: [policyId] }] })` (:475-492).

**Key hygiene:**
- `type=password` with `autoComplete="new-password"`, plus `data-1p-ignore`, `data-bwignore` and `data-lpignore` (:801).
- The key is removed from state immediately after the import and on every exit path.
- Error text has key-shaped strings redacted (:526).
- A purpose-written message for the one-imported-wallet error (:528-529).

**Recovery:** a "Retry linking" button (:757) and a keeper-authorization retry, neither of which asks for the key again.

**UI copy** (~:788):
> "Your key never reaches our servers: it leaves this page already encrypted, straight into the same signing enclave … the keeper can settle, never withdraw."

It was changed from "we never see your key", which is not literally true because the page's JavaScript holds the key while it is typed.

**Drills on a mainnet fork:** re-inviting an ACTIVE account reverts, and inviting the admin reverts.

## 6. What failed and why (bugs the reviews caught)

1. **Empty `policyIds` gives full permission at Privy.** This bug existed before the import work: `authoriseKeeper` sent `policyIds: []` when the policy id was missing, despite its own comment "Refuse to send that". For an imported wallet, which arrives funded, the keeper would have had unlimited use of real money. Fixed for both create and import.
   - **Still present in a later Solana commit `247ee4b`:** `registerSigner` sends `policyIds: config.solanaPolicyId ? [...] : []` (`SolanaPanels.tsx:295` at that commit). Do not copy that line into SaverFi.
2. **The pasted key outlived three exit paths:** the admin refusal, the other-vault refusal, and closing the panel with "Never mind".
3. **Browsers ignore `autoComplete="off"`** on password inputs, so the browser could offer to save and sync the trading key.
4. **A failed link after import left no way out.** The key was already cleared, and the only button created another wallet. Fixed with "Retry linking".
5. **Round 2, real bug:** the Retry button could link the wrong wallet, an abandoned generated one, under an import refusal. Fixed with a dedicated `staged` state.
6. **Round 2, real bug:** a keeper authorization that failed was still reported as success. If `addSigners` failed, for example on a network blip, the flow linked anyway and onboarding said the wallet was live, but nothing would ever settle. Now the flow stops before linking, the warning stays on screen, and there is a retry.
7. **Minor:** the `.mini` CSS rule did not exist, and stale `signerFailure` messages survived between attempts.

**Refuted** as non-bugs:
- that `importWallet` → `createAdditional` breaks when there is no HD index-0 wallet (an imported wallet's `walletIndex` is 0 per index.d.ts:476);
- that a controlled input is a real risk;
- that the missing `pendingLink` timeout was introduced by this change (it already existed in the shared code).

## 7. Open questions the session left

1. **Whether a real-wallet import was ever done.** The owner said he would test it and the transcript ends. Not verified.
2. **Plan gating** of import: never confirmed with Privy.
3. **Scope of the one-imported-wallet limit:** per account or per chain type, and whether it applies on Solana at all, given the Solana typedoc does not state it.
4. **Whether an imported Solana wallet appears in `useWallets` / `wallets().list()` like a generated one.** For EVM, a reviewer confirmed the SDK routes imported wallets in with `walletClientType 'privy'`. For Solana: not verified.
5. **Duplicate imports:** the same key across users or apps, and an address already linked as an external wallet.
6. **A visible "revoke" button** (`removeSigners`) was recommended and not built in these commits.
7. **A strong warning for keys taken from a Telegram bot,** whose operator also holds the key: recommended, not built.
8. **Photon users who never saved their key** cannot import at all.

## 8. Pointers outside this transcript

The old repo continued the work in later commits that are not in this session:
- `247ee4b` (08-27): "import gets its quiet door on Solana". A text link under Create, `useImportWallet` from `/solana` with the signer attached in the same call (`SolanaPanels.tsx:22, 131, 422-463`), base58 redaction, the same link helper, and a backoff retry for Privy's "address to add signers to is not associated with current user" race.
- `e193a4a` (08-29): an EVM "import path" that stops at the import and lets the existing Link and seat-repair buttons finish.

Those are the closest code to what SaverFi needs. For SaverFi specifically:
- The SIP_LINK_V1 consent can be signed by the imported Privy wallet itself.
- The seat policy allows only the SaverFi program and Ed25519 verify, and denies export and signMessage. **Whether signing that consent needs `signMessage`, which the seat denies, depends on who signs it (the user's own session, or the seat): not verified.**

**Files**
- /Users/walch/ProyectosCT/Nuvem/reports/WALLET_IMPORT_2026-08-25.md
- /Users/walch/.claude/projects/-Users-walch-ProyectosCT-Nuvem/67ef6f95-57d9-4828-a218-e11163206db2/subagents/workflows/wf_d3aa42f9-ab8/journal.jsonl
- /Users/walch/.claude/projects/-Users-walch-ProyectosCT-Nuvem/7cb530fb-6e04-4572-80f9-2ae7d2e70fe6/subagents/workflows/wf_906e3595-5f6/journal.jsonl
- /Users/walch/.claude/projects/-Users-walch-ProyectosCT-Nuvem/7cb530fb-6e04-4572-80f9-2ae7d2e70fe6/subagents/workflows/wf_b8139fb6-0d8/journal.jsonl
- /Users/walch/ProyectosCT/SIP/packages/website-oficial/node_modules/@privy-io/react-auth/dist/dts/solana.d.ts
- /private/tmp/claude-501/-Users-walch-ProyectosCT-SIP/6852202f-ddec-4f4a-8504-1eaff070d4b2/scratchpad/nuvem_msgs.txt (all transcript text messages)
- /private/tmp/claude-501/-Users-walch-ProyectosCT-SIP/6852202f-ddec-4f4a-8504-1eaff070d4b2/scratchpad/research_journal.txt (research results, readable)

That transcript also contains secrets the owner pasted in August (Privy app secret, authorization key, attester key, database password, RPC key). None are repeated here. They are listed as needing rotation, and their current status is not verified.

## 3. SaverFi today

# Importing an existing wallet into SaverFi: how trading wallets work today, and what import changes

Everything below was read from `/Users/walch/ProyectosCT/SIP` at `main` `bda8fdd`, from the installed `@privy-io/react-auth@3.36.0` and from the Privy docs. Nothing was edited, committed, signed or sent to Privy, and no secret was printed.

## Summary

- **Import fits the current design.** The Privy SDK this app already uses has `useImportWallet` in its Solana entry, and it accepts `additionalSigners`. An imported wallet can therefore get the keeper's seat at the moment it is imported, the same way a created wallet does today.
- **The link step, the keeper and the program do not care where a wallet came from.** Linking needs a vault and the wallet's own signature on the SIP_LINK_V1 consent. The keeper only needs the wallet to appear in Privy's wallet list with its seat and policy.
- **A version of this feature already existed in SIP's own history, for EVM.** It was `ImportWalletDialog.tsx` and `lib/wallets/judge.ts` at commit `968e06c`, removed in `0841f6a` when SIP became Solana-only. It can be ported.
- **Two new hazards come with import:**
  1. **Overcharging.** The keeper measures profit in SOL only. If an imported wallet already holds tokens, USDC or wSOL when it is linked, any later sale of those into SOL is charged as profit.
  2. **The pension key itself.** If someone imports a key that owns a vault and it gets the keeper's seat, the seat could sign that vault's owner-only instructions. The import must refuse any key that owns a vault.

## 1. How a trading wallet is born today

### Creation, in the browser
- The hook is `useCreateWallet` from `@privy-io/react-auth/solana`, not from the root package, which would create an EVM wallet (`src/hooks/use-create-and-link.ts:4-5,34`).
- `createTradingWallet` calls `createWallet({ createAdditional: true, signers })` (`src/lib/trading-wallets.ts:166-172`).
  - `createAdditional: true` is always passed; passing `walletIndex` instead throws in TEE mode (`:158-160`).
  - It refuses before calling Privy if the seat is not configured (`:167-168`).
- The result is a Privy embedded Solana wallet: `walletClientType` is `privy` or `privy-v2` (`src/lib/pension-key.ts:16`). Its key is held in Privy's TEE, and the app runs in TEE mode (`trading-wallets.ts:24-26`; `reports/SIP_SOLANA_ROADMAP_2026-09-13.md:350`).
- No wallet is created at login: `createOnLogin: "off"` and login is by external wallet only (`src/app/providers.tsx:111-115`).
- The whole sequence is one press, under the screen's write lock: create → refresh the Privy user → read the chain → wait until this session can sign (`READY_BACKOFF_MS`) → link (`src/lib/create-and-link.ts:184-211`; `src/hooks/use-vault-actions.ts:200-210`).
- Each account is capped at `MAX_TRADING_WALLETS = 10` (`trading-wallets.ts:48`).

### Seating the keeper
- **The seat is a signer added with its policy.** It is `[{ signerId: SIP_SOLANA_PRIVY_SIGNER_ID, policyIds: [SIP_SOLANA_PRIVY_POLICY_ID] }]` (`trading-wallets.ts:77-82`).
  - It is never a signer without the policy: Privy reads an empty policy list as full permission (`:16-19`).
  - The signer id is the key quorum (kyio853…).
- **The policy goes on the signer, never on the wallet.** Privy stores it as `override_policy_ids`, so its "deny export" does not stop the owner from exporting (`:20-23`).
- **The policy itself** (`packages/solana-keeper/src/privy-policy.ts:141-175`):
  - It allows `signAndSendTransaction` only for the sip-vault program and the Ed25519 verify program.
  - It denies `exportPrivateKey` and `signMessage`.
- **Repairs live in `use-keeper-seat.ts`** (`src/hooks/use-keeper-seat.ts:51-108`):
  - `grantKeeperSeat` uses `useSigners().addSigners` (`trading-wallets.ts:362-412`).
  - `reseatKeeperSeat` removes every signer, then grants again (`:601-711`).
  - Both are refused unless Privy's record shows the wallet with `walletClientType "privy"`, a server `id` and `recoveryMethod "privy-v2"` (`teeWalletId`, `:224-232`; `grantRefusal`/`reseatRefusal`, `:317-320,550-553`).
- **What the page can see of a seat:** only the `delegated` flag. It proves some signer exists, not that it is the keeper's (`seatOf`, `:178-200`).

### Export
- `useExportWallet` from the Solana entry → `exportTradingWallet` (`src/hooks/use-export-trading-wallet.ts:18-38`; `trading-wallets.ts:730-745`).
- It works only for an address listed by `tradingWalletsOf`, and the address is always passed. Privy shows the key in its own iframe; this page never holds it.

### The link_wallet consent, and who signs it
- **The message:** 140 bytes, `0xFF "SIP_LINK_V1"` followed by program, wallet, vault and owner (`solana-program/.../link_consent.rs:34-60`).
- **On chain:** `link_wallet` checks the Ed25519 verify instruction just before it, signed by the wallet (`instructions/link_wallet.rs:97-108`).
- **The keeper's seat cannot sign it**, because its policy denies `signMessage`.
- **The user's own Privy session signs it**, as the wallet's owner. The deny is an override on the signer only and does not bind the owner.
  - The call is `useSignMessage().signMessage({ message, wallet, uiOptions:{showWalletUIs:false} })` (`src/lib/signing-wallets.ts:112-117`).
  - The wallet must be the `useWallets` entry with `standardWallet.isPrivyWallet === true` (`:40-41,102-103`).
- **Order in `linkWalletFlow`** (`src/lib/vault-flows.ts:847-936`):
  1. Get the server's consent bytes, rebuild them in the page and compare.
  2. The trading wallet signs the consent (`signMessage`).
  3. The server builds the transaction.
  4. Phantom signs first.
  5. The trading wallet co-signs, headless.
  6. Send.
- The owner pays the link rent (`link_wallet.rs:65-70`). One link per wallet, because the link account is derived from `["link", wallet]` (`:46-48`).
- The server routes (`app/api/solana-build`, `solana-tx`) do not check whether the wallet is a Privy wallet.

### What the keeper needs before it settles
- **One index per sweep:** `buildPrivySolanaIndex` lists `privy.wallets().list({chain_type:"solana"})` and keys it by address, recording `additional_signers` and `override_policy_ids` (`packages/solana-keeper/src/privy-signer.ts:251-271`; called at `bin/keeper.mts:1265`).
- **`createPrivySolanaSigner`** (`privy-signer.ts:333-402`, called at `bin/keeper.mts:1370-1377`) returns one of four outcomes:
  - `NOT_A_PRIVY_WALLET`: the address is not in the index.
  - `SIGNER_NOT_GRANTED`: the keeper's signer id is not on the wallet.
  - `SEAT_NOT_BOUNDED`: the signer is there but without exactly the keeper's policy. This fires a critical alert (`bin/keeper.mts:1385-1398`).
  - `SIGNER`: the keeper can sign.
- **`seatCheck`** (`src/seat-check.ts:48-51`): `"policy-enforced"` when both ids are set, `"seat-only"` with the signer id alone, `"unchecked"` with no signer id.
- **No signer → `NO_SIGNER`** (`src/settle-tick.ts:335-337`; `settle-decision.ts:235-240`).
- **The submitter sends only one shape:** `[Ed25519SigVerify, settle_v2]`, paid by the wallet (`assertSettleShape`, `privy-signer.ts:219-239`), through `signAndSendTransaction`.
- **An externally held wallet linked on chain would never settle.** The program would accept the link (it does not check for Privy), but the keeper would report `NOT_A_PRIVY_WALLET` → `NO_SIGNER` forever. This is why import has to mean importing the key into Privy, as the archived EVM dialog's header also argued.

## 2. What Privy offers for import (SDK 3.36.0)

- **Solana `useImportWallet`** (`dist/dts/solana.d.ts:20-40`):
  `importWallet({ privateKey: string /* base58 */, additionalSigners?: SessionSignerInput }) => Promise<Wallet>`.
  Docs: https://docs.privy.io/wallets/wallets/import-a-wallet/private-key#solana
- **The implementation** (`dist/esm/usePrivy-DxYlI9y9.mjs`):
  - Execution mode is `tee` only when `embeddedWallets.mode === "user-controlled-server-wallets-only"`.
  - `additionalSigners` in on-device mode throws "Specifying additionalSigners is only supported for TEE execution".
  - It calls the wallet proxy's `importWallet({ privateKey, accessToken, chainType:"solana", mode, additionalSigners })`, refreshes the user, finds the address and returns the wallet.
- **The raw key passes through this page's JavaScript.** It is a string argument that goes to Privy's proxy iframe, which encrypts it (HPKE) for the TEE (https://docs.privy.io/wallets/wallets/import-a-wallet/architecture). This is unlike export, where the key never reaches the page: the input field, clearing it from state and redacting it from errors are SaverFi's job.
- **Seed phrases:** the docs describe `useImportSeedPhrase` (`/wallets/wallets/import-a-wallet/hd-wallets`), but it is **not exported** by 3.36.0, neither from the Solana entry nor the root list. Seed-phrase import would need an SDK upgrade (not verified in a newer version).
- **"One imported wallet per account":** the archived EVM dialog assumed this limit (`968e06c` `ImportWalletDialog.tsx:56-57`, matched on the error text `/already has an imported wallet/`). That string is not in the 3.36.0 client. **Not verified** for the current Privy server.
- **What Privy records for an imported wallet:** the app reads `account.imported` and expects `walletIndex: null` (`trading-wallets.ts:116-118,135-136`). Whether an imported TEE wallet also carries `recoveryMethod "privy-v2"` and a server `id`, which Grant and Re-seat require, is **not verified**. If it does not, the only way to seat it is at import, and the "Grant SaverFi permission" repair would be refused (`GRANT_COPY.noServerId`).
- **Whether the keeper's `wallets().list` includes imported user wallets** is **not verified**. It is likely, since created TEE user wallets appear in it. This is the first thing to prove on mainnet.

## 3. Places that assume "trading wallets are created here"

| Where | Assumption | What import needs |
|---|---|---|
| `src/components/wallets/TradingWalletsCard.tsx:73,124-131` | The card's only action is `useCreateAndLink` | A second action, "Import a wallet", with its own flow (import → seat read-back → link) |
| `TradingWalletsCard.tsx:76-79` | The placeholder row shown before Privy lists the wallet is `imported:false, walletIndex:null` | Its own placeholder for an import |
| `TradingWalletsCard.tsx:83,144-148`; `trading-wallets.ts:43-48` | `full = rows >= MAX_TRADING_WALLETS` counts imported rows; the copy says "This page creates at most 10" | Decide whether imports count toward the cap; reword |
| `src/components/wallets/VaultScreen.tsx:46-53` | Chain reads take `tradingWalletsOf(...).slice(0, 10)`, with imported wallets sorted last (`trading-wallets.ts:139-143`) | With 10 created wallets plus 1 imported, **the imported one is silently left out of every chain read** |
| `src/lib/create-and-link.ts` (whole module), `hooks/use-create-and-link.ts` | The flow starts with `createTradingWallet` | An `importAndLinkFlow` that reuses `linkGate`, `signableSoon` and `linkWalletFlow`; per the archived EVM header, perhaps import only and let the row's Link finish |
| `src/components/wallets/TradingWalletRow.tsx:151-159` | The label is "Trading wallet N", "Imported wallet" or "New trading wallet" | Already handles imported wallets; keep |
| `src/lib/trading-wallets.ts:28-32,353-361` + `GRANT_COPY`/`RESEAT_COPY` | Repairs assume a TEE wallet with an `id` and `privy-v2` recovery | Confirm imported wallets have these, or change the copy for imported rows |
| `src/lib/signing-wallets.ts:40-41` | Trading signer = `isPrivyWallet === true` | Likely holds for imported wallets (not verified) |
| `src/lib/pension-key.ts:24-34`; `trading-wallets.ts:121-125` | The pension key is never embedded | If a user imports their **Phantom pension key** into Privy, both lists contain the same address. It must be refused (see §5) |
| Copy: `src/lib/live-copy.ts:241,248-250,521`; `src/lib/vault-copy.ts:745-757` (`CREATE_LINK_COPY`), `:1596` ("Trading wallets are created here…"); `TradingWalletsCard.tsx:61-65` | "Create" is the only path | Add import wording; the brand check applies (SaverFi, never the old name) |
| `src/components/live/LiveNextStep.tsx:52,86,107-113` | The next step offers only Create | Offer Import as well |
| `src/lib/privy-failure.ts` | No redaction of key-shaped strings (nothing redact- or base58-related found) | Add base58 run redaction for import errors (the EVM `describeError` redacted hex keys, `968e06c` `judge.ts`) |
| `packages/solana-keeper/src/privy-signer.ts:267-268` | The index is keyed by address, and the last entry wins | If the same key is imported into two Privy users (or a SaverFi wallet's exported key is re-imported elsewhere), the keeper may read the wrong wallet's seats. Whether Privy refuses duplicates is **not verified** |

Unchanged by import: `dashboard-shell.tsx:281` and `leaderboard-account.tsx:40` use `tradingWalletsOf`, which already includes imported wallets. Keeper discovery reads links from the chain, not from Privy.

## 4. Would an imported wallet's past balance or history be overcharged?

**How measurement works today:**
- **Where it starts:** `measurementStart` = the link's `epoch` (the slot it was created in) when `frontier_slot == 0`, otherwise the frontier (`settle-decision.ts:132-143`). The program writes `epoch = Clock.slot` and `frontier_slot = 0` (`link_wallet.rs:116-118`).
- **The walk:** it goes back to the first finalized signature at or below that slot, and that transaction's balance after it seeds the balance chain (`measure-window.ts:371-447,481-490`).
- **The formula:** profit = `cashΔ − deposits + withdrawals`, in **SOL lamports only** (`:15-17,592-603`).
- **Deposits and withdrawals:** a transaction counts as one only when every program it touches is System, ComputeBudget or Ed25519 (plus SaverFi's own settle). Everything else counts as trading (`:23-46,537-551`).

**What is safe:**
- The SOL balance at link time is not charged: it is the starting balance.
- Trading history before the link is never walked, so a busy imported wallet does not cause a walk-limit deadlock.
- Plain SOL top-ups and payouts are deposits and withdrawals.

**What would be mis-charged (inferred from the code, not observed on chain):**
1. **Holdings brought in at link time.** Tokens, memecoins, USDC or wSOL that were bought or received before the link and sold into SOL after it count as pure profit, because their cost was paid before the start slot. Example: an imported wallet holding 1,000 USDC swaps it to SOL after linking, and 20% of those proceeds is skimmed in profit mode. A created wallet starts empty, so this is specific to imported wallets in practice.
2. **Orders placed before the link** (limit orders, DCA) that fill after it: the proceeds count, the cost does not.
3. **Closing old token accounts.** It refunds about 0.002 SOL of rent each through the Token program, which counts as trading profit. Imported wallets usually have many such accounts.
4. **Volume mode:** selling held positions counts as volume, which is by design, not a mis-charge.
5. **A side note on all wallets, not just imported ones:** the Memo program is not in the non-trading list, so a SOL deposit that carries a memo (some exchange withdrawals) would count as trading. Not verified how common this is.

**Options for the new design:**
- At import or link time, read the wallet's token accounts. Warn, or require the person to convert to SOL (or move holdings out) before linking.
- Or record a snapshot of holdings at link time that the keeper credits as cost basis. That is a keeper and attestation change.
- At minimum, tell the person in the import copy.

## 5. Rules an import must enforce

1. **Refuse the pension key, and any vault owner's key.** Refuse if the address equals the session's pension key, and also if the vault account `["vault", address]` exists on chain. Otherwise the keeper's seat on that key could sign `set_policy_v2`, `withdraw` or invest-policy changes for that vault: its policy allows any sip-vault instruction, and only the keeper's own code restricts it to settles (`privy-policy.ts:158-170` vs `privy-signer.ts:193-201`). The program's `WalletIsOwner` check only stops linking a wallet to its own vault. The EVM dialog refused the admin key, and a review found it missed other vaults' admins (`reports/PENDING_REVIEW_FINDINGS_2026-09-07.md:41`).
2. **Refuse or flag a wallet already linked elsewhere** (`["link", wallet]` exists). Only that vault's owner can unlink it (`unlink_wallet.rs:8-27`). The row already has a "Linked elsewhere" label (`trading-wallets.ts:274`).
3. **Seat it at import** with `additionalSigners: keeperSigners(config)` and refuse when that is null. Then read the seat back from Privy's record; the EVM dialog did this (`968e06c` `ImportWalletDialog.tsx:197-215`).
4. **Handle the key carefully:** a password field with `autoComplete="new-password"`, cleared on every exit; validate the base58 64-byte secret and show the derived address before importing; never log it; redact errors.
5. **CSP:** `frame-src` already allows `https://auth.privy.io` (`security-headers.mjs:21,136-137`). No change expected (not verified for import specifically).

## 6. Still to prove before building

- Whether imported Solana wallets in this Privy app appear in the keeper's `wallets().list` with `additional_signers` and `override_policy_ids` set by `additionalSigners`. Check with `privy-policy verify --wallet <id> --policy <id>` (`trading-wallets.ts:185-187`).
- Whether the user record gives an imported wallet `recoveryMethod "privy-v2"`, an `id` and `imported: true`, so Grant and Re-seat work.
- Whether Privy still limits imports to one per account, and whether it rejects an address already imported.
- Whether the imported wallet shows up in `useWallets` with `isPrivyWallet === true`, so the consent can be signed.

## Files

- `/Users/walch/ProyectosCT/SIP/packages/website-oficial/src/lib/trading-wallets.ts`
- `/Users/walch/ProyectosCT/SIP/packages/website-oficial/src/lib/create-and-link.ts`
- `/Users/walch/ProyectosCT/SIP/packages/website-oficial/src/lib/signing-wallets.ts`
- `/Users/walch/ProyectosCT/SIP/packages/website-oficial/src/lib/vault-flows.ts`
- `/Users/walch/ProyectosCT/SIP/packages/website-oficial/src/hooks/use-keeper-seat.ts`
- `/Users/walch/ProyectosCT/SIP/packages/website-oficial/src/hooks/use-export-trading-wallet.ts`
- `/Users/walch/ProyectosCT/SIP/packages/website-oficial/src/components/wallets/TradingWalletsCard.tsx`
- `/Users/walch/ProyectosCT/SIP/packages/website-oficial/src/components/wallets/VaultScreen.tsx`
- `/Users/walch/ProyectosCT/SIP/packages/solana-keeper/src/privy-signer.ts`
- `/Users/walch/ProyectosCT/SIP/packages/solana-keeper/src/seat-check.ts`
- `/Users/walch/ProyectosCT/SIP/packages/solana-keeper/src/measure-window.ts`
- `/Users/walch/ProyectosCT/SIP/packages/solana-keeper/src/settle-decision.ts`
- `/Users/walch/ProyectosCT/SIP/packages/solana-keeper/bin/keeper.mts`
- `/Users/walch/ProyectosCT/SIP/packages/solana-program/programs/sip-vault/src/instructions/link_wallet.rs`
- Scratch copy of the archived EVM import dialog: `/private/tmp/claude-501/-Users-walch-ProyectosCT-SIP/6852202f-ddec-4f4a-8504-1eaff070d4b2/scratchpad/iwd.tsx`

## 4. Privy documentation

# Report: importing an existing Solana wallet into SaverFi's Privy wallets (Privy docs plus the installed SDKs)

Read-only. Nothing was edited, signed or sent to Privy, and no secret was printed. Docs were read with the privy-docs MCP filesystem on 2026-10-08. A doc at `/x/y.mdx` is served at `https://docs.privy.io/x/y`.

## 0. Installed versions
| Package | Pinned | Installed |
|---|---|---|
| `@privy-io/react-auth` | `3.36.0` (`packages/website-oficial/package.json:23`) | 3.36.0 |
| `@privy-io/node` | `^0.28.0` (`packages/solana-keeper/package.json:22`) | 0.28.0 |
| `@privy-io/js-sdk-core` (transitive) | n/a | 0.68.5 |

## 1. Can a user import an existing Solana private key? Yes, from the browser or from a server.

**Browser, React SDK.** Docs: https://docs.privy.io/wallets/wallets/import-a-wallet/private-key, "Solana" tab.
> "import {useImportWallet} from '@privy-io/react-auth/solana'" … "privateKey: The base58-encoded private key of the solana wallet to import."

The installed typings match and also accept signers:
- `node_modules/@privy-io/react-auth/dist/dts/solana.d.ts:19-40`:
  ```ts
  importWallet: (input: { privateKey: string; additionalSigners?: SessionSignerInput }) => Promise<Wallet>;
  // "@param o.additionalSigners Optional additional signers for the wallet. Only supported for TEE wallets."
  ```
- `SessionSignerInput` is `{ signerId: string; policyIds?: string[] }[]` (`dts/types-B7309xc8.d.ts:2646-2649`). This is the same shape SaverFi already passes to `createWallet({ createAdditional: true, signers })` at `packages/website-oficial/src/lib/trading-wallets.ts:169`.

**Server, Node SDK.** Docs: same page, NodeJS → Solana tab.
```ts
privy.wallets().import({ wallet: { entropy_type: 'private-key', chain_type: 'solana', address, private_key /* base58 or Uint8Array */ } })
```
- Implementation: `node_modules/@privy-io/node/src/public-api/services/wallets.ts:216-255`. It calls `_initImport`, encrypts the key in-process with HPKE, then calls `_submitImport`.
- A Solana string key is decoded with `base58.decode` (`src/lib/wallet-entropy.ts:33-39`). There is no length check in the SDK.

**REST.** `POST /v1/wallets/import/init` then `POST /v1/wallets/import/submit`, authenticated with Basic app credentials.
- https://docs.privy.io/api-reference/wallets/import/init
- https://docs.privy.io/api-reference/wallets/import/submit
- Import `chain_type` accepts only: ethereum, solana, stellar, tron, sui, aptos, xrpl.

**Seed phrases.**
- Docs describe `useImportSeedPhrase` and say "Seed phrase imports require TEE execution" (https://docs.privy.io/wallets/wallets/import-a-wallet/hd-wallets).
- That hook is **not in react-auth 3.36.0**: grep finds 0 matches in `dts/index.d.ts` and `dts/solana.d.ts`. Using it needs an SDK upgrade.
- Seed-phrase import is available server-side today (`entropy_type: 'hd'` plus an `index`).

**Key format (to check).**
- The docs' Solana example key is 88 base58 characters, which is the 64-byte secret key Phantom exports.
- **Not verified:** whether Privy also accepts a 32-byte seed, or a `solana-keygen` JSON array. The app would have to convert a JSON array to base58 itself.

## 2. Does the key ever reach SaverFi's server?

**React path: no, but it does pass through SaverFi's page.**
- `node_modules/@privy-io/react-auth/dist/esm/index-B2_w5Cud.mjs` sends `importWallet: r=>Bi("privy:wallets:import", r, e, t.origin)`. That is a postMessage to Privy's iframe carrying `{privateKey, accessToken, chainType, mode, additionalSigners}` (request type at `dts/index.d.ts:293-298`).
- So the key never goes to SaverFi's backend. It is still a string in SaverFi's page JavaScript while the user types or pastes it, so any XSS or third-party script on the page could read it. This is a design point; the CSP matters here.

**Server path: yes.** The Node SDK takes the plaintext key in the keeper or web server process and HPKE-encrypts it there.

**Middle option (doc-supported, not verified in practice).**
- Architecture doc (https://docs.privy.io/wallets/wallets/import-a-wallet/architecture): "import a wallet from your client, server, or TEE without exposing your wallet entropy to any intermediary services … can only be decrypted within the TEE."
- The browser could fetch `encryption_public_key` through a server relay, run HPKE itself (DHKEM_P256_HKDF_SHA256 / HKDF_SHA256 / CHACHA20_POLY1305 / BASE), and send only `ciphertext` and `encapsulated_key` to SaverFi's server, which calls `submit`.
- The relay is needed because init and submit require the app secret.

## 3. Signers (key quorum seat), policies, and TEE

**Server import accepts the same settings as wallet creation.** Submit body (https://docs.privy.io/api-reference/wallets/import/submit):
- `owner` (`{user_id}` or `{public_key}`) or `owner_id` (key quorum)
- `policy_ids`: "Currently, only one policy is supported per wallet."
- `additional_signers[]`: `{signer_id, override_policy_ids}`, "up to one policy ID"
- `display_name`, `external_id`

**Client import accepts signers only on TEE apps.**
- The SDK decides the mode with `"user-controlled-server-wallets-only" === appConfig.embeddedWallets.mode ? "tee" : "on-device"`.
- On an on-device app it throws: "Specifying additionalSigners is only supported for TEE execution and this app uses on-device execution" (`dist/esm/usePrivy-DxYlI9y9.mjs`, function `se`).
- Docs, https://docs.privy.io/recipes/tee-wallet-migration-guide: "Your app must enable TEE execution in order to access … Policy engine … Server-side access to wallets, using signers."

**Is SaverFi's app on TEE? Inferred yes, not checked in the dashboard.**
- The keeper seat is live in production, which requires TEE.
- Test fixtures model `walletClientType: "privy-v2"` (`test/fixtures/privy-user.ts:106`).
- `providers.tsx:112-115` does not set the mode; it comes from the dashboard (Wallet > Advanced shows "On-device" if not TEE, per https://docs.privy.io/security/wallet-infrastructure/advanced/user-device).

**Adding a signer later.**
- Docs: "Signers can be added to wallets owned by users, authorization keys, or key quorums" (https://docs.privy.io/wallets/using-wallets/signers/overview).
- So `useSigners().addSigners({address, signers})`, which SaverFi already calls at `trading-wallets.ts:387`, should apply to an imported wallet too.
- **Not verified:** whether anything differs for imported wallets.

**Docs' general claim:** "Imported wallets function the same way as Privy-generated wallets" (private-key page, "Using imported wallets").

**One documented exception:** "Imported wallets and wallets previously exported from Privy cannot receive automation attachments" (https://docs.privy.io/wallets/automations/overview). SaverFi does not use Privy automations.

**SaverFi-specific security point (my reasoning, not from the docs).** The original key still exists outside Privy (Phantom, Axiom and so on). The Privy policy limits only the keeper's seat. The prior key holder can still sign anything on-chain from that address. This affects what "pull only" means for an imported trading wallet.

## 4. Limits, chains, plan

**Imported wallets per user: not confirmed for Solana.**
- The EVM `useImportWallet` comment says it "will error if the user already has an imported wallet" (`dts/index.d.ts:3247-3252`).
- The Solana docstring (`solana.d.ts:19-28`) leaves that sentence out.
- The client code in `se` has no such check, so any limit would be enforced in the iframe or server, which was not observed.
- Docs state no per-user limit.

**Chain types.** Solana is supported. Import covers "a narrower set of chains than export" (https://docs.privy.io/wallets/overview/chains); the REST enum is listed in section 1.

**Plan requirements: none found.** No pricing or plan note mentions import. Not verified.

**Authentication.** The React import throws "User must be authenticated before linking an account" (`se`). The user must be logged in, which SaverFi users are, through the pension key.

## 5. Can the user still export an imported wallet?

**Implied yes, not stated explicitly.**
- Docs, https://docs.privy.io/wallets/wallets/export: "Key export is available for all wallets on every supported tier." Wallets created client-side can be exported only through React `exportWallet`; server-created ones only through server SDK or REST.
- https://docs.privy.io/recipes/hd-wallets says: "If no `address` is passed to `exportWallet`, Privy will default to exporting the non-imported wallet at `walletIndex: 0`". This implies imported wallets are exported by passing their `address`.
- SaverFi's export hook (`src/hooks/use-export-trading-wallet.ts:20`) should therefore always pass `address`.
- **Unknown:** whether a wallet imported server-side under `owner: {user_id}` can be exported with the React hook.

**Also from the export docs:** a user-owned wallet can be exported by the user directly with their access token, unless the owner is a 2-of-2 key quorum.

## 6. How an imported wallet shows up in the app

**`user.linkedAccounts` (`Wallet` type, `dts/types-B7309xc8.d.ts:861-896`).**
- `imported: boolean`: "Only applies to embedded wallets (walletClientType === 'privy' or 'privy-v2')".
- `walletIndex: number | null`
- `delegated`, `recoveryMethod`, and `id` ("Null if the wallet is not delegated").
- The React import resolves by re-reading the user and finding the account with the imported address (`se` → `find(e=>e.address===m)`).

**SaverFi already handles this.**
- `tradingWalletsOf` keeps `imported` and `walletIndex: null`, and sorts imported wallets last (`src/lib/trading-wallets.ts:116-146`).
- The fixture `RECORD` includes `embedded(IMPORTED, null, false, { imported: true })` (`test/fixtures/privy-user.ts:105`).
- `TradingWalletRow.tsx:151` labels a wallet "Trading wallet N" only when `walletIndex !== null`, so imported rows need their own label.

**`useWallets()` from `@privy-io/react-auth/solana`.**
- Returns `ConnectedStandardSolanaWallet[]` (`solana.d.ts:156-166`).
- That class has no `imported` field: it exposes `address`, `standardWallet` and the sign methods (`js-sdk-core@0.68.5 dist/dts/index.d.ts:3048ff`).
- Use `user.linkedAccounts` to tell whether a wallet was imported.
- (The EVM `BaseConnectedWallet` does have `imported`, at `types-B7309xc8.d.ts:942`.)

**Server `Wallet` object.** Has `imported_at` (ms) and `exported_at` (submit response schema).

## 7. Open items for the build chat (not verified)
1. Is SaverFi's Privy app on TEE? Confirm in the dashboard (Wallet > Advanced).
2. How many imported Solana wallets can one user have?
3. Does a 32-byte or JSON-array Solana key work?
4. Does React `exportWallet({address})` work on an imported wallet?
5. Does `addSigners` behave identically on an imported wallet?
6. Is `useImportSeedPhrase` available on react-auth versions after 3.36.0?
7. The on-chain `SIP_LINK_V1` consent must be signed by the imported key. That could happen through Privy after import, or from the user's original wallet; both are design choices, and the program side was not checked here.
8. The README roadmap item is at `/Users/walch/ProyectosCT/SIP/README.md:259`.
