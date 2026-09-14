# @sip/worker — design

**What it does.** Every few minutes, for every trading wallet bound to a SIP vault, the worker finds the
buys and sells that wallet made *anywhere* on Robinhood Chain 4663, works out each fill's gross cash
notional, closes a window of fills behind a finality margin, signs a volume attestation, and — through
the app signer seat the website attached to the wallet in Privy — has the wallet itself pay
`bps × Σnotional` (or whatever it can) into its `PersonalVault`. Phase 0 talks to the deployed
`SettlementExecutor` with no contract change; Phase 1 talks to `SipVolumeExecutor`. **Dry run by default.**

Read `reports/SIP_BACKEND_ASSESSMENT_2026-09-07.md` §4 and Anexo D first: they are the *why*; this file
is the *how*. The worker was quarried out of the forked project's keeper and session engine; those
packages have since been deleted, so every "came from" below is **attribution for code that now lives
here in full**, not an instruction to go and read something.

## 0. Non-negotiables

1. **Dry run is structural.** `loadConfig` reads `SIP_ATTESTER_PRIVATE_KEY` and the Privy secrets ONLY
   when `SIP_WORKER_ALLOW_BROADCAST` equals, byte for byte, `i-understand-this-moves-real-funds`. In dry
   run the process never holds a key that can sign a pull. `submitPull` checks the mode as its first
   statement and returns `{kind:"DRY_RUN"}` before touching any signer (test it by passing a signer that
   throws).
2. **The worker never holds a trading key.** Pulls are signed by Privy through the app's authorization
   key; the attester key signs attestations and holds no funds.
3. **Refuse rather than guess.** A (wallet, block) whose cash movement cannot be attributed to exactly
   one fill is a `BlockRefusal`, recorded and retried later — it is never attested. Fabricated volume
   is the one unforgivable output.
4. **Every wei is attributable.** A fill carries its tx hash, block, side, venue, source and notional;
   a window's `batchRoot` commits the sorted fill hashes; anyone with a public RPC can recompute it.
5. **Deterministic tests.** No network in tests. Unit tests build inputs from the recorded fixture
   (`test/fixtures/mainnet-4663.json`, a map `${method}|${JSON.stringify(params)}` → result; see
   `fixtureRpcClient`) or from hand-built objects. Discovery with OR-topic arrays is NOT in the fixture
   (it was recorded per wallet) — test it against a hand-built `RpcClient` mock.
6. **No secrets in logs.** `src/log.ts` carries the `Redactor` inherited from the old keeper: any
   64-hex string is redacted before it reaches a sink, whatever variable or message it arrived in.
7. **Own files only.** Each owner edits the files listed under their name and creates tests beside them
   (`test/<owner>.test.ts` or `src/**/x.test.ts`). `src/types.ts` is shared and frozen: if you need a
   change, put it under `needs` in your report and code around it. Never touch
   `packages/website-oficial` or `/Users/walch/ProyectosCT/Nuvem`.
8. **Style.** Match the repo: short "why" comments in its caps-led style, `bigint` for wei and blocks,
   no `any`, no non-null assertions, `noUncheckedIndexedAccess` on.
9. **Verify before reporting:**
   ```
   export PATH="$HOME/.nvm/versions/node/v22.14.0/bin:$PATH"
   cd /Users/walch/ProyectosCT/SIP/packages/worker && ./node_modules/.bin/tsc -p tsconfig.json --noEmit && ./node_modules/.bin/vitest run
   ```
   Ten owners edit in parallel; errors in files you do not own are transient — wait ~20 s and re-run.

## 1. Facts

- Chain 4663 (Arbitrum Nitro). `block.number` in Solidity is the **L1** height; RPC blocks and logs are
  L2; every L2 block carries `l1BlockNumber`. ~7 L2 blocks/s, ~120 L2 per L1. Cash = native ETH + WETH.
- Addresses that belong to the CHAIN rather than to a deployment, and are therefore pinned in
  `src/chain/constants.ts` (lowercase): canonical WETH `0x0bd7d308f8e1639fab988df18a8011f41eacad73`;
  GMGN router `0x65050a9b7e5075a2ba5ced7b1b64ee66262c40dc`; Uniswap v4 PoolManager
  `0x8366a39cc670b4001a1121b8f6a443a643e40951`. ABIs: `@nuvem/contracts-artifacts` (SettlementExecutor,
  PersonalVault, VaultFactory, AttesterRegistry, ProtocolPauseController).
- **A DEPLOYMENT IS CONFIGURATION, NEVER A FACT.** The factory and the executor come from
  `SIP_VAULT_FACTORY` and `SIP_SETTLEMENT_EXECUTOR`, and `loadConfig` refuses to start without them; the
  pause controller and the attester registry are read from the executor's own immutables in the snapshot
  pass, and the vault reports the executor it is bound to — §5 defers the window when that disagrees
  with the configured one. Nothing is pinned and nothing falls back, because SIP has no deployment yet
  and the forked project's is abandoned rather than inherited: its trading accounts carry a savings rate
  that meant a percentage of PROFIT — 1000 to 3000 bps, read from chain on 2026-09-08 — while this
  worker attests VOLUME and Phase 0 carries that volume in the attestation's cash fields, so aiming at
  one would skim about a hundred times what the user agreed to.
- Fixture wallet: `0xc455bf7f16ebbc2b07cb26d1dd46194977974e7d`. Recorded transactions (all in the fixture
  with full receipts; blocks are in the receipts):

  | tx | shape | truth |
  | --- | --- | --- |
  | `0x27259f99…` | GMGN buy, v3-style pool | notional 20,000,000,000,000,000 wei (= tx.value); fee 200,000,000,000,000 |
  | `0x5578486d…` | GMGN buy, v4 PoolManager | notional 1,000,000,000,000,000; fee 10,000,000,000,000 |
  | `0x0688bd57…` | GMGN sell, v3-style | gross 22,251,309,406,981,553; net 22,028,796,312,911,738; fee 222,513,094,069,815 |
  | `0x0e5cd4ab…` | GMGN sell, v4 | gross 906,846,740,302,383; net 897,778,272,899,360; fee 9,068,467,403,023 |
  | `0xc81c59bb…`, `0x9f4590a2…` | approve before each sell, **same block as the sell**, log-less (Approval only) | gas-only; not a fill |
  | `0x37ba3063…` | WETH.withdraw 2.5e15 | WETH_WRAP exclusion, not a fill |
  | `0x88d5bf23…` | airdrop (receipt.from ≠ wallet, 239 logs) | AIRDROP exclusion; no gas term |
  | `0xd342d117…` | the old settle() to executor `0xce676c73…` | NOT_A_TRADE |
  | `0xfdbaab69…` | plain inbound 0.027 ETH, no logs | NOT_A_TRADE (inbound) |
  | `0x79f102cb…` | plain outbound 0.0004 ETH | NOT_A_TRADE (outbound) |

- **GMGN router events (both indexed by wallet):**
  - FILL `0x8619026a40d38bedb4002fe511cea4bc4a9b336710efe8f21a61869a7ee0f02a`, topics
    `[sig, wallet, wallet, 0x0]`, data 16 words: `w00 = amountIn`, `w01 = amountOut` (**net of fee on
    sells**), `w05 = 1` (v3-style) or `2` (v4), `w06..w08` = path/pool addresses (v4 puts the PoolManager
    in `w13`), `w09 = 10000`, `w10 = 200`.
  - FEE `0x205442d60b70af1203d43cab62352c3b69b94f091be32fe683198057282b5c92`, topics
    `[sig, 0x0, wallet]`, data 2 words: `w00 = fee wei`, `w01 = unix timestamp`.
  - Buy: `notional = w00 = tx.value`. Sell: `notional gross = w01 + fee`. Direction: `tx.value > 0` ⇒ buy;
    else sell; cross-check with the ERC-20 Transfer direction (token to wallet ⇒ buy).
- ERC-20 `Transfer` topic `0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef`; a fill's
  token leg is a **3-topic** Transfer with the wallet in `topics[2]` (buy) or `topics[1]` (sell). 4-topic
  Transfers are ERC-721/404 mints: skip them. WETH `Transfer`s to/from `0x0` are wrap/unwrap.
- RPC facts, learned the hard way and still true: a provider may answer a capped `eth_getLogs` range
  with an EMPTY list and no error, which is why every chunk is coverage-checked instead of trusted;
  `eth_getBalance` at a block older than 128 is archive data, so the reconciler needs an archive
  endpoint; and Alchemy's free tier caps `eth_getLogs` at a 10-BLOCK range, which makes discovery
  impossible. Alchemy Pay-As-You-Go on 4663 is archive (confirmed) and is the requirement, not a
  preference.

## 2. Module contracts (owner → files)

### rpc → `src/rpc/client.ts`, `src/rpc/failover.ts`
`httpRpcClient` (5 attempts / 250 ms doubling backoff on HTTP 429/502/503/504 and bodies matching
`/rate|limit|throttl|capacity|busy/`; `RpcError`; the recording and fixture clients; `rpcKey`) and the
failover (ordered preference, "cannot answer" distinguished from "answered no", the primary re-probed
after 60 s, events that carry no URLs) came from the old session engine. Tests: retry on 429 then
success; fixture client throws `UnrecordedRequestError` with a helpful message; failover switches on
fault and recovers.

### chain → `src/chain/constants.ts`, `src/chain/reads.ts`
Typed reads decoding hex → bigint; `getLogs` chunked at `maxSpan` with a `getBlock(toBlock)` coverage
check before each chunk (the chunk-and-check shape is the old keeper's), returning logs sorted by
(blockNumber, logIndex). `l1BlockOf` reads the block's `l1BlockNumber` field, as the old session engine
did. Tests: decoding; chunking boundaries (a 25,000-block range at maxSpan 10,000 → three calls with
exact bounds); coverage failure surfaces as an error, not an empty list.

### discover → `src/observe/discover.ts`
`discover(rpc, wallets, range, {maxLogSpan})`: (1) one `getLogs` for `[TRANSFER, walletSet, null]` and one
for `[TRANSFER, null, walletSet]` (OR arrays), keep 3-topic logs whose `address` ≠ WETH; (2) for every
distinct (wallet, block) candidate block, `blockTransactions(block)` and add every tx with `from ∈
wallets` or `to ∈ wallets` (this is where the log-less approve, native sends and vault pulls come from);
(3) per wallet, `nonceAt(toBlock) − nonceAt(fromBlock − 1)` must equal the number of *sent* txs found in
the range; a mismatch puts the wallet in `incompleteWallets` (the range must not close for it).
Output candidates deduplicated by (wallet, block, txHash). `discoverLinkedWallets` carries over the old
keeper's factory-log discovery (TradingAccountLinked/Unlinked, then `activeVaultOf` as the authority).
Tests with a mock RpcClient: OR arrays sent as documented; 4-topic logs skipped; WETH excluded; nonce
mismatch flags the wallet; block txs merged.

### venues → `src/observe/venues/gmgn.ts`, `src/observe/venues/index.ts`
Implement the GMGN decoder per §1; return `null` for anything without both a FILL and a FEE log from the
router addressed to the wallet. Tests from the fixture: the four fills decode to the exact truths in the
table (gross notional, fee, side, tokens); a receipt without router logs returns null; a FILL without FEE
returns null.

### reconcile → `src/observe/reconcile.ts`, `src/observe/context.ts`
`buildBlockContext`: the wallet's txs in the block (from/to == wallet) with receipts, native and WETH
balances at `N−1` and `N`, `hasCode`. `reconcileBlock(context, venues)` applies §3. Tests: every fixture
block — build the `BlockContext` by hand from the fixture's receipts and balances (the fixture holds
`eth_getBalance` at the needed heights; if a height is missing, construct the context directly) — must
produce exactly the truths of §1; plus synthetic cases for each refusal and exclusion reason.

### attest → `src/attest/root.ts`, `src/attest/snapshot.ts`, `src/attest/phase0.ts`
ATTESTATION_TYPES, DOMAIN_NAME/VERSION, `readVaultSnapshot`, the `hashAttestation` cross-check and
`encodeSettleCalldata` came from the old keeper's onchain module; the preflight order and the validity
window from its attest module. See §5 for the field mapping. Tests: root is order-independent and
domain-separated; the preflight refuses before signing (a signer that throws proves it); the built
attestation round-trips through `hashTypedData` to the same digest the contract fragment would produce
(compare against a vector you compute once with viem and pin).

### pull → `src/pull/privy.ts`, `src/pull/submit.ts`
The Privy signer (authorization key, `wallets.list` join, the `delegated` flag read fresh per call —
`walletIdOf` returns null when the seat is gone) and the submit ordering (reserve nonce → estimate →
sign → record INTENT → `eth_sendRawTransaction`; the tx hash is `keccak256(rawTx)` before sending) both
came from the old keeper. Gas floor: skip with `BELOW_GAS_FLOOR` when `contributionWei` would not
cover ~2× the estimated gas cost. Tests: dry run never touches the signer;
seat revoked ⇒ `SKIPPED`; intent recorded before send (ledger mock records order).

### ledger → `src/ledger/pg.ts`, `src/ledger/schema.ts`
Tables: `sip_wallet(address pk, vault, cursor_l2, owed_total_wei, collected_total_wei)`,
`sip_fill(wallet, tx_hash, block_l2, tx_index, side, venue, token_in, token_out, notional_wei, fee_wei,
source, window_id null, pk(wallet, tx_hash))`, `sip_exclusion`, `sip_refusal(wallet, block_l2, reason,
detail, pk(wallet, block_l2))`, `sip_window(id serial, wallet, vault, start_l2, end_l2, batch_root, sum_notional_wei,
owed_wei, status, detail jsonb)`, `sip_pull(window_id, tx_hash, nonce, contribution_wei, outcome, detail)`.
Numeric columns as `numeric(78,0)`; addresses/hashes as text lowercase. One advisory lock per worker
instance — that lock, and the `application_name` that says who is holding it, came from the old keeper.
`memoryLedger()` implements the same interface for tests and dry runs. Tests: the memory ledger end to end; SQL strings are valid (pin them; no DB in CI).

### config → `src/config.ts`, `src/log.ts`
§0.1 exactly; `pollMs` default 300 000; `finalityMarginL2` 64; `maxLogSpan` 10 000; RPC URL list split on
commas; addresses lowercased and validated; `databaseUrl` null ⇒ memory ledger. Logger: JSON lines when
not a TTY; `Redactor` masks 64-hex strings. Tests: sentinel variants (`true`, `1`, trailing space) stay
dry run; live mode requires all secrets; redaction.

### loop → `src/tick.ts`, `bin/worker.mts`
§6. `tick` runs once and prints the `TickSummary` as JSON; `run` loops with a heartbeat line per pass and
never overlaps ticks (skip while running). Tests: a tick against `memoryLedger` + a mock rpc that serves
one fixture-shaped block produces one fill, one open window after the margin, one DRY_RUN pull.

### solidity → `packages/contracts/src/settlement/SipVolumeExecutor.sol`, `packages/contracts/test/unit/SipVolumeExecutor.t.sol`
See §7. Read `SettlementExecutor.sol`, `PersonalVault.sol:945-1047` and `test/unit/SettlementExecutor.t.sol`'s
harness first and reuse its mocks. Build with `forge build`, test with `forge test --match-contract SipVolumeExecutor`.

## 3. The reconciler (per wallet, per block)

Inputs: the wallet's txs in the block in index order, each with its receipt; balances at `N−1` and `N`.
Definitions: `sent` = txs with `from == wallet`; `gasPaid = Σ sent gasUsed × effectiveGasPrice`;
`valueOut = Σ sent value`; `nativeIn = Σ value of txs with to == wallet and from ≠ wallet`;
`cashDelta = (nativeAfter − nativeBefore) + (wethAfter − wethBefore)`.

1. If `hasCode`: only venue decoders may produce fills; any sell-shaped tx without a decoder ⇒
   refusal `WALLET_HAS_CODE`.
2. For each tx, in order — classify:
   - `receipt.status == reverted` ⇒ `REVERTED` exclusion.
   - a venue decoder returns a fill ⇒ fill with `source: "venue"`.
   - `from ≠ wallet` and a 3-topic non-WETH Transfer to the wallet ⇒ `AIRDROP` (no gas term ever).
   - `from ≠ wallet` and value > 0 and no logs ⇒ plain inbound: `NOT_A_TRADE` (and it counts as `nativeIn`).
   - `from == wallet`, only a WETH Transfer to/from `0x0` ⇒ `WETH_WRAP`.
   - `from == wallet`, `to == wallet` ⇒ `SELF_TRANSFER`.
   - `from == wallet`, value > 0, a 3-topic non-WETH Transfer **to** the wallet ⇒ **buy**,
     `notionalWei = value` (+ any WETH Transfer *from* the wallet in the same tx), `source: "value"`.
   - `from == wallet`, value == 0, a 3-topic non-WETH Transfer **from** the wallet and none **to** it ⇒
     **sell-shaped**, notional pending (step 3).
   - `from == wallet`, non-WETH Transfers both from and to the wallet, value == 0 ⇒ `TOKEN_FOR_TOKEN`.
   - `from == wallet`, no Transfer logs, value == 0 ⇒ gas-only (approve) — not a fill, contributes gas.
   - `from == wallet`, value > 0, no Transfer to the wallet ⇒ `NOT_A_TRADE` (outbound send or the vault pull).
3. Sell-shaped txs without a decoder: allowed **only if** exactly one such tx exists in the block and
   `nativeIn == 0`; then `notionalWei = cashDelta + gasPaid + valueOut` (this is the block residual, i.e.
   what the venue paid the wallet), `source: "residual"`; must be > 0 else refusal `UNDECODED_SELL`.
   Two or more ⇒ refusal `MULTI_FILL_BLOCK`; `nativeIn > 0` ⇒ refusal `UNEXPLAINED_INFLOW`.
4. **Consistency check** when every tx was explained: `cashDelta` must equal
   `Σ(buy notional) × (−1) + Σ(venue/residual sell gross − fee) − gasPaid − (valueOut of NOT_A_TRADE sends) + nativeIn`
   within 0 wei; a mismatch ⇒ refusal `UNEXPLAINED_INFLOW` with the difference in `detail`. (For the
   fixture sells this is where the same-block approve's gas is absorbed correctly.)
5. A refusal voids every fill of that (wallet, block); the block is retried on later ticks (state reads
   may succeed later) and, if it persists past the retention window, stays refused — never attested.

Notional is **gross** on both sides (buy = ETH in before GMGN's fee; sell = ETH out before the fee), so a
round trip is measured on one basis.

## 4. Windows and margins

Per wallet: fills with `blockL2 ≤ head − finalityMarginL2` and `blockL2 > cursor` that have no window,
provided no refusal exists for a block in `(cursor, closeAt]` and the wallet is not `incomplete` — then
`closeAt = head − finalityMarginL2`, the window is `(cursor, closeAt]`, `sumNotionalWei = Σ`,
`owedWei = sumNotionalWei × savingsBps / 10_000`, `batchRoot` per `attest/root.ts`, cursor advances to
`closeAt`. If any refusal sits inside the range, close only up to the block before the first refused
block (fills after it wait). Minimum window: `owedWei ≥ minContributionWei` and ≥ the pull's gas floor;
otherwise keep it OPEN and let it grow (the owed amount accumulates in the ledger, never lost).

## 5. Phase 0 attestation (deployed `SettlementExecutor`)

| field | value |
| --- | --- |
| chainId / vault / account / executor | from config + snapshot |
| bindingEpoch, policyNonce, settlementNonce, adminEpoch, localPauseEpoch, globalPauseEpoch, attesterEpoch, policyHash | snapshot, read in the same pass |
| startBlock / endBlock (L1) | `l1BlockOf(startL2)` / `l1BlockOf(endL2)`; require `startBlock ≥ activationBlockL1` and `endBlock < current L1 head` (else `L1_NOT_ADVANCED`, retry next tick) |
| startBlockL2 / endBlockL2 | `window.startL2` (= cursor + 1, must be > frontierEndL2) / `window.endL2` (> startL2) |
| sessionId | `SettlementExecutor.deriveSessionId(...)` view with these fields |
| ledgerRoot | `window.batchRoot` |
| cashStart, externalDeposits, externalWithdrawals | 0 |
| cashEnd, realizedProfit | `sumNotionalWei` |
| contribution | `previewContribution(attestation)` — the exact-maximum rule: `min(owed, maxPerSettlement, both rolling remainders, nativeBalance − floor − reserve)`; `0` or `< minContributionWei` ⇒ `DEFERRED NOTHING_COLLECTABLE / BELOW_MINIMUM` |
| validAfter / deadline | `now − 60` / `now + 600` seconds |

Preflight, in this order, each a `DEFERRED` before any signing: protocol or vault paused; account not
ACTIVE; `snapshot.executor ≠ config.executor`; attester ≠ signer address (`ATTESTER_MISMATCH`); L1 not
advanced; contribution zero/below minimum. Then sign EIP-712 (domain from `src/attest/phase0.ts`), compute the
local digest with `hashTypedData`, and compare with the contract's `hashAttestation` view; a mismatch is
`DIGEST_MISMATCH`. `collected = contribution`; `owed − collected` carries forward in the ledger (Phase 0
cannot carry it on-chain; Phase 1 does).

## 6. The tick

```
head = blockNumber(); closeAt = head − finalityMarginL2
wallets = discoverLinkedWallets(factory, logsFromBlock..head) ∪ ledger.walletStates()   // ledger.upsertWallets
for each wallet: range = (cursor, head]  (cap the span; if behind, chunk and loop within the tick)
  d = discover(rpc, wallets, range)                            // once for all wallets
  for each (wallet, block) in d.candidates: ctx = buildBlockContext; out = reconcileBlock(ctx, VENUES)
      ledger.recordFills/Exclusions/Refusals
  for each wallet not incomplete: try to close a window per §4 → ledger.openWindow; ledger.addOwed
  for each OPEN/SIGNED window: snapshot = readVaultSnapshot; a = attestPhase0(...)
      DEFERRED → markWindow(id, "OPEN", reason)   SIGNED → submitPull(...) → recordPull; on SENT markWindow "SUBMITTED"; addCollected
  (confirmation of SUBMITTED pulls by receipt is the next owner's job; leave a TODO in tick.ts)
return TickSummary
```
Dry run performs everything except signing and sending, and logs the would-be pull with amounts.

## 7. `SipVolumeExecutor.sol` (Phase 1)

Immutable, ownerless. Constructor pins `factory`, `attesterRegistry`, `pauseController`. Struct
`VolumeAttestation { chainId, vault, account, executor, bindingEpoch, policyNonce, settlementNonce,
adminEpoch, localPauseEpoch, globalPauseEpoch, attesterEpoch, policyHash, batchRoot, startBlockL2,
endBlockL2, sumNotionalWei, owedWei, validAfter, deadline }` (EIP-712, domain `SipVolumeExecutor`/`1`).
`pull(VolumeAttestation calldata a, bytes calldata sig) external payable nonReentrant`:
`msg.sender == a.account`; vault = `factory.activeVaultOf(msg.sender)` must equal `a.vault`; chain,
executor, epochs, nonce, policyHash bound to live state like the old executor; attester signature
current; `!usedBatch[a.batchRoot]` (then set); `msg.value > 0 && msg.value ≤ a.owedWei` and
`≤ maxPerSettlementWei`, `≤` both rolling remainders, `≥ minContributionWei`; **no balance clamp and no
exact-maximum rule** — the caller decides `msg.value`; `owed[account] += a.owedWei`,
`collected[account] += msg.value`; build the vault's `SettlementRecord` with a per-account synthetic L2
counter (`startBlockL2 = c + 1`, `endBlockL2 = c + 2`, `c += 2`), `startBlock = endBlock = block.number − 1`
(revert `ActivationTooRecent` if below `activationBlock`), `sessionId = keccak256(chainid, vault, account,
bindingEpoch, batchRoot)`, `ledgerRoot = batchRoot`, `contribution = uint128(msg.value)`; call
`vault.acceptSettlement{value: msg.value}(record)`; emit `VolumePulled(account, vault, batchRoot,
sumNotionalWei, owedWei, msg.value, debtAfter)`. Views: `debtOf(account)`, `syntheticFrontier(account)`,
`hashAttestation(a)`. MEASURED gas (Foundry, 2026-09-07): 445k per pull on an
established account, 614k on the first — the vault's `acceptSettlement` half dominates, so the
worker's gas floor must be sized against 445k, not the 150–250k this section first estimated.
Tests mirror `SettlementExecutor.t.sol`: happy path, partial pull twice with carried
debt, batch replay reverts, stale nonce reverts, over-cap reverts, wrong attester reverts, first pull in
the activation L1 block reverts with the named error.

## 8. Report format
`filesWritten`, `typecheckPassed`, `testsPassed` (count), `deviations` (from this document, with why),
`needs` (anything outside your files), `summary` (one line).
