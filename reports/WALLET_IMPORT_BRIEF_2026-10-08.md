# Design brief: import an existing wallet into SaverFi

Internal working document for a new session. Repo: `/Users/walch/ProyectosCT/SIP`, `main` at `bda8fdd`, 2026-10-08. The earlier EVM project is called "the previous project" throughout. Its name must not appear in public copy, commit messages or UI. Its code is at `/Users/walch/ProyectosCT/Nuvem`, which you can read but must not change.

Ground rules carried over from the research: no secret goes into chat, logs or commits. Claude never pastes a real private key into a production page. The owner does that step himself. Anything marked **not verified** has not been proven and must be proven before anyone relies on it.

---

## 1. What the owner asked for

The owner wants a user to bring a Solana wallet they already trade with (from Phantom, Axiom, GMGN or a Telegram bot) into SaverFi. That wallet would become one of their trading wallets, linked to their vault and saved from by the keeper, just like a wallet created inside the app. The README lists this under "Next": "**Import an existing trading wallet**, not only wallets created here" (`README.md:259`). He remembered that the previous project had this option and asked for it to be checked, then built in a new chat about only this topic. Back in August, for the previous project, he made two decisions that still apply: put a "Use your wallet" button under the create button, and say in the copy that SaverFi has no access to the wallet beyond a setting. He left the method (import, connect or private key) to the assistant.

## 2. What the previous project did, what was proven, what carries over

**The decision: import the private key, don't just connect the wallet.** Linking can be done with a signature alone. Saving cannot. Every settle must be signed by the trading wallet itself, because the wallet is the `Signer` and the contribution is a native SOL system transfer (`settle.rs`). Solana has no way to delegate native SOL. SPL `approve` covers tokens only, there is no equivalent of EIP-7702, and Squads spending limits give the user a new address. So a wallet that is only connected would link fine and then never save anything. In SaverFi's keeper that wallet would end up as `NOT_A_PRIVY_WALLET` → `NO_SIGNER` forever (`packages/solana-keeper/src/privy-signer.ts:333-402`, `src/settle-tick.ts:335-337`). The key has to live in Privy, where the keeper's seat can sign.

**What was built (previous project):**

| Commit | Date | What |
|---|---|---|
| `c80aa12` | 08-25 | Research report `reports/WALLET_IMPORT_2026-08-25.md` |
| `fa1148f` | 08-26 | EVM "bring your own wallet" in `InviteTradingWallet.tsx` |
| `a74523c` | 08-26 | Second review round; pure `judgePastedKey` plus a `check:import` script in prebuild |
| `247ee4b` | 08-27 | Solana import ("quiet door") in `SolanaPanels.tsx:707-753, 1305-1352`; retry with backoff for signer registration |
| `9585a37` | 08-27 | Production policy-id variable held the signer id; guards added |
| `e193a4a` | 08-29 | EVM import box in `WalletsPanel.tsx` |

SIP's own history also holds an EVM `wallets/ImportWalletDialog.tsx` and `lib/wallets/judge.ts`, added in `968e06c` (09-08) and deleted in `0841f6a` (09-14, Solana-only). There is an open finding on it at `reports/PENDING_REVIEW_FINDINGS_2026-09-07.md:41`: its preflight refused the session's admin but not other vaults' admins.

**Proven:**
- The EVM key judge, mutation-tested.
- Two contract reverts on a mainnet fork.
- The policy-id/signer-id mix-up, checked against the live Privy API.

**Never proven on either chain: a real import.** No commit, report or memory entry records an `imported_at`, or a settle from an imported wallet. The owner said on 08-25 that he would test with a real wallet, and the transcript ends before any result. The "first real onboarding run" (`247ee4b`, `33607b5`) used a *created* wallet.

**Lessons that carry over, each learned from a real bug:**
1. Never send an empty `policyIds`. Privy treats an empty list as **full permission**. The previous project's Solana `registerSigner` still sent `policyIds: config.solanaPolicyId ? [...] : []` at `247ee4b`. Do not copy that line.
2. Clear the key from state on **every** exit path, including refusals and "Never mind". Three paths leaked it.
3. Browsers ignore `autoComplete="off"` on password inputs. Use `autoComplete="new-password"` with `data-1p-ignore`, `data-bwignore` and `data-lpignore`.
4. A failed link after import needs a "Retry linking" button that does not ask for the key again. The retry must target the imported address, kept in a dedicated staged state; one round-2 bug linked an abandoned wallet instead.
5. If seat authorization fails, stop. One bug linked anyway and showed the wallet as live while nothing would ever settle.
6. Redact key-shaped runs in error text. The previous project's regexes were inconsistent; for Solana use base58 `{43,}`.
7. The Solana path there had **none** of the EVM guards: no judge, no address preview, no owner-key refusal, no already-linked check. SaverFi must not inherit that gap.

**Carries over to SaverFi:**
- the Solana call `importWallet({ privateKey, additionalSigners })` from `@privy-io/react-auth/solana`;
- the refusal rules above;
- the judge idea, rewritten for base58;
- the preflights, translated to PDAs.

**Does not carry over:** hex keys and `privateKeyToAccount`, `activeVaultOf`, EIP-712 invite/accept, and the EIP-7702 research.

**New in SaverFi:** the `SIP_LINK_V1` off-chain consent, and the keeper's profit measurement, which is SOL-only (§3, §6).

## 3. How SaverFi wallets work today, and what an imported wallet must satisfy

**Creation** (`packages/website-oficial`):
- `createTradingWallet` calls `createWallet({ createAdditional: true, signers })` (`src/lib/trading-wallets.ts:166-172`).
- It throws `SeatNotConfigured` when `keeperSigners(config)` is null (`:167-168`).
- The seat is `[{ signerId: SIP_SOLANA_PRIVY_SIGNER_ID, policyIds: [SIP_SOLANA_PRIVY_POLICY_ID] }]` (`:77-82`). The signer is key quorum `kyio853…`. Privy stores the policy as `override_policy_ids` on the signer, so it does not bind the owner (`:16-23`).
- Login is by external wallet only, with `createOnLogin: "off"` (`src/app/providers.tsx:111-115`).
- One button press runs create → refresh → chain read → wait until signable → link (`src/lib/create-and-link.ts:184-211`).
- The cap is `MAX_TRADING_WALLETS = 10` (`trading-wallets.ts:48`).

**Seat policy** (`packages/solana-keeper/src/privy-policy.ts:141-175`):
- Allows `signAndSendTransaction` only for the sip-vault program and the Ed25519 verify program.
- Denies `exportPrivateKey` and `signMessage`.
- It allows **any** sip-vault instruction. Only the keeper's own code (`assertSettleShape`, `privy-signer.ts:219-239`) narrows that to `[Ed25519SigVerify, settle_v2]`.

**Seat repair** (`src/hooks/use-keeper-seat.ts`; `trading-wallets.ts:362-412, 601-711`):
- `grantKeeperSeat` uses `addSigners`. `reseatKeeperSeat` removes the signers, then grants again.
- Both are refused unless the record shows `walletClientType "privy"`, a server `id` and `recoveryMethod "privy-v2"` (`teeWalletId`, `:224-232`).
- The page can see only `delegated`, which shows that *some* signer exists, not necessarily the keeper's (`seatOf`, `:178-200`).

**Link consent** (`src/lib/vault-flows.ts:847-936`):
- The message is 140 bytes: `0xFF "SIP_LINK_V1"` followed by program, wallet, vault and owner (`solana-program/.../link_consent.rs:34-60`).
- On chain, `link_wallet` checks that the instruction just before it is an Ed25519 verify signed by the wallet (`instructions/link_wallet.rs:97-108`).
- The **user's own Privy session** signs the consent through `useSignMessage` (`src/lib/signing-wallets.ts:112-117`). That needs the `useWallets` entry to have `standardWallet.isPrivyWallet === true` (`:40-41, 102-103`). The seat cannot sign it, because its policy denies `signMessage`.
- Phantom (the pension key) signs the transaction first, then the trading wallet co-signs headless.
- The owner pays the link rent. Only one link can exist per wallet: the PDA is `["link", wallet]` (`link_wallet.rs:46-48`).

**Keeper** (`privy-signer.ts:251-271, 333-402`; `bin/keeper.mts:1265, 1370-1398`):
- Each sweep builds an index from `privy.wallets().list({chain_type:"solana"})`, keyed by address. The last entry wins (`:267-268`).
- Possible outcomes: `NOT_A_PRIVY_WALLET`, `SIGNER_NOT_GRANTED`, `SEAT_NOT_BOUNDED` (critical alert), or `SIGNER`.
- The keeper finds vaults through on-chain links, not through Privy.

**Profit measurement** (`settle-decision.ts:132-143`; `measure-window.ts:15-46, 371-490, 537-603`):
- It starts at the link's `epoch` slot.
- profit = cashΔ − deposits + withdrawals, **in SOL lamports only**.
- A transaction counts as a deposit or withdrawal only when it touches nothing but System, ComputeBudget or Ed25519 (plus SaverFi's own settle).

**An imported wallet must satisfy all of these:**
1. It is a Privy TEE wallet of this user, present in `wallets().list` with the keeper's signer id and exactly the keeper's policy as `override_policy_ids`. Keeper outcome: `SIGNER`. **Not verified for imported wallets.**
2. It appears in `useWallets()` (Solana) with `isPrivyWallet === true`, so the user's session can sign `SIP_LINK_V1`. **Not verified for imported wallets.**
3. It is not the pension key, and it owns no vault: the PDA `["vault", address]` must not exist (seeds confirmed in `withdraw.rs:23`, `set_policy.rs:12`).
   - Reason: the seat policy allows any sip-vault instruction, so a seat on a vault owner's key could sign `set_policy`, `withdraw` or `set_invest_policy` for that vault. Only the keeper's code prevents that.
4. It is not linked anywhere else: the PDA `["link", address]` must not exist, unless it is already linked to *this* vault, in which case skip the link.
5. It fits inside the 10-wallet window. `VaultScreen.tsx:46-53` drops the pension key, then takes `.slice(0, MAX_TRADING_WALLETS)`, with imported wallets sorted last (`trading-wallets.ts:139-143`). With 10 created wallets plus 1 imported, **the imported one silently disappears from every chain read** (checked at `bda8fdd`).

**The program needs no upgrade.** `link_wallet`, `settle_v2` and the consent do not care where a wallet came from, and none of the reports found an on-chain blocker. The holdings problem in §6 could later justify a keeper or attestation change, but not a program change, as far as the research shows.

## 4. What Privy allows on Solana today

Installed versions: `@privy-io/react-auth` 3.36.0 (pinned, `packages/website-oficial/package.json:23`), `@privy-io/node` 0.28.0 (keeper), `@privy-io/js-sdk-core` 0.68.5.

| Fact | Status | Source |
|---|---|---|
| Browser import of a Solana key: `useImportWallet` from `@privy-io/react-auth/solana`; `importWallet({ privateKey /* base58 */, additionalSigners?: {signerId, policyIds?}[] }) => Promise<Wallet>` | Documented, and present in installed types | https://docs.privy.io/wallets/wallets/import-a-wallet/private-key (Solana tab); `node_modules/@privy-io/react-auth/dist/dts/solana.d.ts:19-40`; `SessionSignerInput` at `dts/types-B7309xc8.d.ts:2646-2649` |
| `additionalSigners` "Only supported for TEE wallets"; on an on-device app the SDK throws | Installed code | `solana.d.ts`; `dist/esm/usePrivy-DxYlI9y9.mjs` (fn `se`) |
| The key is sent by postMessage to Privy's iframe, which HPKE-encrypts it for the TEE. **It never reaches SaverFi's servers, but it is a plain string in SaverFi's page JS while typed** | Installed code + docs | `dist/esm/index-B2_w5Cud.mjs` (`privy:wallets:import`); https://docs.privy.io/wallets/wallets/import-a-wallet/architecture |
| Server and REST import (`/v1/wallets/import/init` + `/submit`) accept `owner`, `policy_ids` (one only) and `additional_signers` (one override policy each) | Documented | https://docs.privy.io/api-reference/wallets/import/init, …/submit |
| "Imported wallets function the same way as Privy-generated wallets"; the only difference is `imported_at` | Documented claim | private-key page, "Using imported wallets" |
| Imported wallets cannot receive *automation* attachments (SaverFi does not use automations) | Documented | https://docs.privy.io/wallets/automations/overview |
| Signers can be added to user-owned wallets (`addSigners`) | Documented, in general | https://docs.privy.io/wallets/using-wallets/signers/overview |
| Key export works on all wallets and tiers; `exportWallet` needs `address` for a non-index-0 or imported wallet | Implied | https://docs.privy.io/wallets/wallets/export; https://docs.privy.io/recipes/hd-wallets |
| Seed-phrase import (`useImportSeedPhrase`) | **Documented but not in 3.36.0** (0 grep matches); server-side only today | https://docs.privy.io/wallets/wallets/import-a-wallet/hd-wallets |
| The user must be authenticated before importing | Installed code | `se` |
| **TEE mode for SaverFi's app** | Recorded in `reports/SIP_SOLANA_ROADMAP_2026-09-13.md:350`, and inferred from the live seat. **Not checked in the dashboard** (Wallet > Advanced) | |
| **One imported wallet per user** | The EVM docstring says so (`dts/index.d.ts:3250`); the Solana docstring does not; no client check. **Not verified** for Solana | |
| **Imported wallet appears in keeper `wallets().list` with `additional_signers`/`override_policy_ids`** | **Not verified** (likely) | |
| **Imported wallet has `recoveryMethod "privy-v2"` and a server `id`** (needed by Grant/Re-seat repair) | **Not verified** | |
| **Imported wallet in `useWallets()` with `isPrivyWallet === true`** | **Not verified** (likely) | |
| Accepted formats beyond 88-character base58: 32-byte seed, `solana-keygen` JSON array | **Not verified**. The Node SDK base58-decodes with no length check (`@privy-io/node/src/lib/wallet-entropy.ts:33-39`) | |
| Same key imported by two users, or an address already linked as an external wallet | **Not documented, not tested** | |
| Plan gating for import | Nothing found in docs or pricing. **Not confirmed with Privy** | |

## 5. Recommended design

### Principles
- Use the **client SDK** (`useImportWallet` from `/solana`) and seat the wallet **in the same call** with `additionalSigners: keeperSigners(config)`. Refuse before import when that returns null.
- No server-side import, because the Node path puts the plaintext key in our process. The relay-plus-browser-HPKE option is documented but unneeded.
- Import and link run as one guided flow, with a resumable link step. Reuse `linkGate`, `signableSoon` and `linkWalletFlow`. Do not fork them.

### Screens

**Entry points.** "Import a wallet I already use" as a secondary action:
- under Create in `TradingWalletsCard.tsx`;
- in `LiveNextStep.tsx` (`:52, 86, 107-113`), when the next step is to add a wallet.

**Screen 1: "Before you paste".** Plain warnings, each needing no scrolling:
- "This is a copy. Your key keeps working in Phantom, Axiom or GMGN, and anyone else who has it keeps it."
- "If the key came from a Telegram bot, the bot's operator holds it too."
- "SaverFi only saves from SOL that is in this wallet when it settles."
- A holdings note (see screen 3).

**Screen 2: "Paste your key".**
- Field: `type=password`, `autoComplete="new-password"`, `data-1p-ignore`, `data-bwignore`, `data-lpignore`, `spellCheck=false`. Paste is allowed.
- On every change, a pure judge (`lib/import-key.ts`) classifies the input:
  - 12 or 24 words → "That's a recovery phrase. Export the private key from your wallet instead." Seed import is not available in our SDK version.
  - `0x` or 64-character hex → "That's an EVM key, not Solana."
  - JSON byte array of 64 numbers → accept, and convert to base58 in memory.
  - base58 that decodes to 64 bytes → accept.
  - 32 bytes → refuse until verified ("Paste the full 64-byte key your wallet exports").
  - Anything else → explain the length expected.
- The public key is derived from the first 32 bytes, and the result must equal bytes 32 to 63. Otherwise: "This key is damaged." Web3.js `Keypair.fromSecretKey` validates this by default; which Solana library `website-oficial` ships is **not verified**.
- Show the derived address: "Check this is the wallet you expect."

**Screen 3: Preflight.** Read-only checks; the key stays only in a ref. Refuse in plain words when:
- the address equals the session's pension key;
- `["vault", address]` exists ("This key owns a SaverFi vault; it can't be a trading wallet");
- `["link", address]` exists and points to another vault ("Linked to another vault; only that vault's owner can unlink it").
  - If it points to this vault, go straight to "already done".
- the address is already in this user's Privy record as embedded: skip the import and go to the seat check and link.
- the address is in the record as an external wallet: refuse until the behaviour is verified.
- the account is at the cap.
- the seat is not grantable (`keeperSigners` is null).

Also read the wallet's SOL balance and its token accounts (Token and Token-2022). If it holds non-SOL tokens, show them, with the warning from §6, and require an explicit acknowledgement checkbox.

**Screen 4: Import.**
- Clear the input and state **before** awaiting.
- Call `importWallet({ privateKey, additionalSigners: keeperSigners(config) })`.
- Drop every reference afterwards, in `finally`.
- Errors go through a redactor (base58 `{43,}` and hex `{41,}`). Rewrite "already has an imported wallet" into plain words.

**Screen 5: Seat check.**
- Refresh the Privy user and find the address with `imported: true`.
- Require `delegated === true`.
- If it is not delegated, stop. Offer "Grant SaverFi permission" if `teeWalletId` allows it. Otherwise show an honest dead end ("Contact support"), and log this case as a verification target.

**Screen 6: Link.**
- Wait with `signableSoon` until the wallet is in `useWallets` with `isPrivyWallet`.
- Then run the existing `linkWalletFlow`: consent bytes → the user's session signs `SIP_LINK_V1` → server builds the transaction → Phantom signs → the wallet co-signs headless → send.
- If this fails, the row shows "Link" and "Retry". The retry never asks for the key again; the flow's state holds the address, not the key.

**Screen 7: Done.** "Imported wallet" row (`TradingWalletRow.tsx:151-159` already labels it). Copy reminds the user that saving starts from now: nothing before the link counts.

### Where the private key travels
1. Keyboard or clipboard.
2. SaverFi page JS: the input element and one function scope.
3. postMessage to Privy's iframe (`auth.privy.io`).
4. HPKE inside the iframe.
5. Privy's TEE.

It never touches SaverFi's API routes, logs, analytics, Sentry or state stores. The copy must say "never reaches our servers", **not** "we never see it", because the page does hold it briefly. Keep it out of React state that DevTools or error boundaries could serialize; prefer an uncontrolled input read once into a local variable.

### Seating
Seat at import time only, through `additionalSigners`. Never send a bare signer: `keeperSigners` already guarantees the policy. Existing repairs apply only if imported wallets carry `id` and `privy-v2`, which is **not verified**.

### Keeper
No change is needed for the normal case, if the import is verified to land in `wallets().list` with the seat. Recommended small hardening, which can be a separate step: when building the index, detect duplicate addresses and alert instead of letting the last entry win (`privy-signer.ts:267-268`).

### Existing balance and history
- The SOL balance at link time is the starting point and is never charged.
- Trading before the link is never walked.
- Non-SOL holdings later sold into SOL are counted as profit. This is a known mis-charge (§6), handled by warning and acknowledgement in v1.

## 6. Risks, honest limits, security review points

1. **The user keeps full control outside SaverFi.**
   - The original key can trade, drain or close the wallet at any time, with no seat involved. SaverFi saves only what it finds when it settles.
   - This is **the same trust model as a created wallet whose key the user has exported** to Axiom or GMGN (`use-export-trading-wallet.ts`). The real new risk is third parties: a bot operator, or a leaked key, also hold it.
   - Product implication: savings from an imported wallet are best-effort, and so are those from an exported created wallet.
2. **Overcharging from pre-link holdings** (read from the code, not observed on chain):
   - Tokens, USDC or wSOL bought before the link and sold into SOL after it count as pure profit. Example: 1,000 USDC swapped to SOL after linking, with 20 % of the proceeds skimmed in profit mode.
   - Orders placed before the link (limit, DCA) that fill after it count the same way.
   - Closing old token accounts refunds ~0.002 SOL of rent each, through the Token program, which counts as trading profit.
   - v1: warning plus acknowledgement. Later options: a holdings snapshot as cost basis (a keeper and attestation change), or requiring SOL-only before linking.
   - Unrelated to import, and true for every wallet: a SOL deposit carrying a Memo instruction counts as trading.
3. **The pension key, or any vault owner's key, imported and seated** would let the seat sign owner instructions. Only the keeper's code prevents this. A hard refusal in preflight is required. Residual risk: the user creates a vault *later* with that same key, from Phantom, after import. Mitigations:
   - keeper: refuse to settle when the trading wallet owns a vault;
   - web: show it in the row;
   - longer term, narrow the Privy policy by instruction, which the policy engine cannot do for custom programs (it matches `programId` only).
4. **The key passes through page JS.** XSS or any third-party script could read it. Review points:
   - CSP `script-src` (`security-headers.mjs`);
   - no analytics or session-replay on this route, including input capture;
   - no error-reporting payloads that include input values;
   - `frame-src` already allows `https://auth.privy.io` (`security-headers.mjs:21, 136-137`).
5. **Duplicate addresses across Privy users or apps.** Their behaviour is unknown, and the keeper index is last-wins.
6. **A one-import-per-user limit, if Privy enforces it on Solana**, would make import a single slot. Traders with several wallets would hit it.
7. **Repairs may not work on imported wallets** (`id` or `recoveryMethod` unverified). A seat lost after import could be unrecoverable from the UI.
8. **Not every user can import.** Some bots show the key only once (Photon, per the previous research). A seed phrase needs an SDK upgrade, unverified.
9. **The cap window bug** (`VaultScreen.tsx:46-53`) must be fixed with import, or an imported wallet can vanish from chain reads.
10. **Copy honesty.** Do not write "SaverFi can only settle" as an absolute. The policy allows any sip-vault instruction, and the keeper's code is what limits it to settles. Say: "The permission you grant lets SaverFi's keeper sign SaverFi transactions only; it can't export your key or sign messages, and the program never lets a trading wallet's seat withdraw from your vault." Have this sentence reviewed against the program before shipping.
11. **Brand.** User-facing copy says SaverFi. The previous project is never named.

## 7. Open questions for the owner (recommended default in bold)

1. **Where is the button?** **Secondary action under Create in the wallets card and in the live next-step, not on the landing page.** This follows his 08-25 decision ("Use Your Wallet" under Generate).
2. **Wallets holding non-SOL tokens?** Block, warn, or snapshot. **Warn with the list and require a checkbox in v1; consider snapshot cost basis later.**
3. **Do imports count toward the 10-wallet cap?** **Yes: 10 trading wallets total, of any origin.** Fix the `VaultScreen` window accordingly.
4. **If Privy allows only one import per account?** **Ship anyway and say so plainly in the UI.** Ask Privy support whether it can be raised.
5. **Key formats?** **88-character base58 and a JSON 64-byte array in v1. Refuse seed phrases and 32-byte seeds with an explanation.** Do not upgrade the SDK for seed import in v1.
6. **Telegram-bot keys?** **Allow, with a strong warning that the bot operator holds the key too.**
7. **A visible "Remove SaverFi permission" control** (`removeSigners`) for imported wallets? **Yes, in v1**, because it is the user's only way to cut the seat without unlinking. It must be clear that removing it stops saving.
8. **Who runs the mainnet test?** **The owner pastes the throwaway key himself.** Claude prepares everything else and reads the results.
9. **Keeper hardening (duplicate addresses, trading wallet that owns a vault)?** **Yes, as a separate small step after the import ships.**

## 8. Build plan (small, verifiable steps)

**Step 0: Settle the unknowns (owner plus read-only checks; no code).**
- Owner confirms TEE mode in the Privy dashboard (Wallet > Advanced).
- Owner confirms localhost is an allowed origin, if the test will run on `localhost:3002` against the production app id (not verified).
- Ask Privy support about the per-user import limit on Solana, duplicates across users, and plan gating.
- Done: answers written in a report.

**Step 1: Pure key judge.** New `src/lib/import-key.ts` with `judgePastedKey(text) → {kind, address?, message}`.
- Cases: base58 of 64 bytes, JSON array, seed phrase, EVM hex, 32 bytes, corrupt pubkey half, and a 64-character string valid in both alphabets.
- Plus `redactKeys(text)`.
- Tests in `test/import-key.test.ts`, including adversarial vectors. Use generated keys only; never commit a real one.
- Done: tests green, plus a mutation check by hand. Port ideas from `968e06c:lib/wallets/judge.ts`.

**Step 2: Redaction in errors.** `src/lib/privy-failure.ts` gains base58 and hex redaction. Test: an error message containing an 88-character key comes out redacted.

**Step 3: Preflight reads.** `src/lib/import-preflight.ts`, a pure decision function over the inputs:
- pension key, vault PDA exists, link PDA and its vault, Privy record entry (embedded, external or none), count, seat config;
- plus a reader for SOL and token holdings (both token programs).
- Done: a table-driven test of every refusal, and "already linked here → done".

**Step 4: Import call.**
- `importTradingWallet(importWallet, config, key)` in `trading-wallets.ts`, next to `createTradingWallet`: throws `SeatNotConfigured` when `keeperSigners` is null and never passes `[]`.
- New `src/hooks/use-import-and-link.ts`.
- New `importAndLinkFlow` in `src/lib/create-and-link.ts`: import → refresh → require `delegated` → `signableSoon` → `linkWalletFlow`. It stores the address, never the key, and is resumable.
- Done: unit tests with a fake `importWallet` covering seat refused, import error (redacted), delegated false (stops before link), link fails (Retry available, no key needed).

**Step 5: UI.**
- New `src/components/wallets/ImportWalletDialog.tsx` (screens 1 to 7).
- Changes to `TradingWalletsCard.tsx`: second action, import placeholder row, cap copy at `:144-148`.
- Changes to `LiveNextStep.tsx`, plus copy in `vault-copy.ts` (`CREATE_LINK_COPY` area `:745-757`, `:1596`) and `live-copy.ts:241-250, 521`.
- Done: the brand check passes, and an E2E with the Privy stub (see the onboarding-modal E2E pattern) walks every refusal and the happy path.

**Step 6: Cap window fix.** `VaultScreen.tsx:46-53` (and any other `.slice(0, MAX_TRADING_WALLETS)`): count all trading wallets toward the cap, and never silently drop an imported one. Done: a test with 10 created plus 1 imported shows either all 11 read or the import refused at the cap.

**Step 7: Remove-permission control** (if the owner says yes to question 7). Uses `useSigners().removeSigners` on the imported row. Done: an E2E with the stub.

**Step 8: Mainnet proof with a throwaway wallet.** The owner performs every key-handling step.
1. The owner generates a fresh keypair in a scratch location, for example with `solana-keygen new --no-bip39-passphrase -o <scratch>/import-test.json`, and funds it with about **0.05 SOL**. The key never goes in chat.
2. On a deploy of the branch (preview) or local dev, the owner imports it into his own account and links it to his vault.
3. Claude verifies, read-only:
   - the Privy record shows `imported: true`, `delegated: true`, and records `id` and `recoveryMethod`;
   - `privy-policy verify --wallet <id> --policy <id>` passes (confirm this command is read-only before running it);
   - the keeper log shows outcome `SIGNER` for that address on the next sweep;
   - the `["link", address]` PDA exists, with this vault.
4. A settle: with the original key outside SaverFi, the owner makes a small round trip that ends with more SOL. Alternatively, he moves the vault to VOLUME 1 % for the test window, as on 09-25, and moves it back afterwards.
5. **Done means one finalized settle transaction signed by the imported wallet's seat.** This matches roadmap item `despues-importar` (`reports/SIP_SOLANA_ROADMAP_2026-09-13.md:683-688`).
6. Also record:
   - whether export of the imported wallet works;
   - whether a second import on the same account is refused (answers the limit question);
   - whether Grant/Re-seat are accepted for the imported row.
7. Afterwards: unlink and drain the throwaway wallet, and say which keys are now retired.

**Step 9 (optional): Keeper hardening.** In `packages/solana-keeper/src/privy-signer.ts`, alert on duplicate addresses in the index. In `settle-decision.ts`, refuse a trading wallet whose `["vault", wallet]` exists. Done: unit tests, and Node 22 for keeper tests.

**Step 10: Docs.** README roadmap line `:259` and the changelog. The commit follows the owner's push gate.

**Files that change:**
- New: `src/lib/import-key.ts`, `src/lib/import-preflight.ts`, `src/hooks/use-import-and-link.ts`, `src/components/wallets/ImportWalletDialog.tsx`, plus tests.
- Changed: `src/lib/trading-wallets.ts`, `src/lib/create-and-link.ts`, `src/lib/privy-failure.ts`, `src/components/wallets/TradingWalletsCard.tsx`, `src/components/wallets/VaultScreen.tsx`, `src/components/live/LiveNextStep.tsx`, `src/lib/vault-copy.ts`, `src/lib/live-copy.ts`.
- Optional: `packages/solana-keeper/src/privy-signer.ts`, `settle-decision.ts`.
- **Program: no change.**

**Sources to open first:**
- `/Users/walch/ProyectosCT/Nuvem/packages/website-oficial/src/components/SolanaPanels.tsx` (`:424`, `:707-753`, `:1305-1352`)
- `…/InviteTradingWallet.tsx` (`:87-115`, `:493-640`)
- `/Users/walch/ProyectosCT/Nuvem/reports/WALLET_IMPORT_2026-08-25.md`
- SIP `git show 968e06c:packages/website-oficial/src/components/wallets/ImportWalletDialog.tsx` (scratch copy: `/private/tmp/claude-501/-Users-walch-ProyectosCT-SIP/6852202f-ddec-4f4a-8504-1eaff070d4b2/scratchpad/iwd.tsx`)
- `/Users/walch/ProyectosCT/SIP/packages/website-oficial/node_modules/@privy-io/react-auth/dist/dts/solana.d.ts`
