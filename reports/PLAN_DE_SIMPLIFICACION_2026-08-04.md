# Nuvem — Plan de simplificación

**Fecha:** 4 de agosto de 2026  
**Método:** cuatro análisis independientes (gobernanza, fricción de usuario, operativa del keeper, superficie de código), cada uno sometido a revisión adversarial, y síntesis final. Todo con evidencia `file:line`.

---

## Resumen

Seal the beacon, shrink governance to one 1-of-2 Safe with a timelock left on the single power that still bites, and finish the user journey in the browser. The structural insight is that exactly one function in this protocol can take money that is already in a vault — UpgradeableBeacon.upgradeTo on the cohort-1 beacon — and you are currently spending eleven keys, a 3-of-5 Safe and a 7-day delay defending it, with nothing monitoring and no verified source. Seal that beacon at deployment and every remaining governance action becomes incapable of theft; the fee stack (8% of deploy gas, and the Safe's only direct-ownership job) and the adapter stack come off with it, and src/ drops from 29 files to 14. Keep the timelock on the factory anyway, because registerCohort still grants full custody over new cohorts and can permanently squat vaultOfAdmin[victim] through transferVaultAdmin — that is the one place the critics' pushback is load-bearing. On the product side the finding is starker: the app has no withdraw button, no invite UI, and no ABI entry for withdrawToken at all, so the journey it advertises cannot be completed in a browser. Three of the four biggest user wins need no contract change and are already written in the contracts — acceptTradingAccountBySig, settlementFrontier and withdrawToken are all shipped, all uncalled. Do the permanent deployment decisions first, the browser journey second, and the keeper's ~4,000 lines of workaround-for-a-getter-that-exists third.

---

## La decisión que desbloquea todo: la forma del multisig

**Recomendación:** Deploy a 1-of-2 Safe (threshold 1, two owners) and relax the deploy script's shape check to accept it. Do NOT keep 3-of-5, do NOT derive five owners from one seed, and do NOT switch to a bare EOA.

Why 1-of-2 and not 1-of-1: threshold 1 means one signature per action, which is exactly the 'one wallet does almost everything' you asked for. The second owner costs zero friction (either owner acts alone) and is your only insurance against key loss. Key loss matters here: the Safe is the sole timelock proposer and the factory's ultimate owner, so a lost single key means you can never register a cohort, never unpause, never rotate the attester again — permanently, with no recovery path. Keep the second owner key on paper or steel, never on a connected device.

Why a Safe and not a bare EOA: three concrete things. (1) You can rotate the signing key with swapOwner without migrating a single on-chain ownership — the governance address stays stable across a key compromise. (2) You can go to 2-of-3 later, when a second person exists, with one Safe transaction and no protocol change. (3) It keeps _requireContract at DeployNuvem.s.sol:201 alive, and that probe — not the numbers 3 and 5 — is what actually catches the pasted-wrong-address failure that froze the canary. A wrong address almost never answers getThreshold() and getOwners(); it reverts into UnsupportedCorporateMultisig. Going bare EOA deletes that guard and leaves only a non-zero check on the single most dangerous address in the deployment.

Why not 3-of-5 from one seed: five keys derived from one seed on one laptop pass _requireThreeOfFiveMultisig at DeployNuvem.s.sol:240-242 and would be recorded in THREAT_MODEL.md:87 as 'exactly 3-of-5 shape checked at deployment'. That sentence would be literally true and materially false as a control. Manufacturing a documented-looking control out of a single point of failure is worse than an honest 1-of-2, because it makes you and any future reader misprice the risk.

There is also a launch blocker you must clear regardless of shape: this repo contains no Safe execution tooling at all. Grepping the whole tree for execTransaction, @safe-global, protocol-kit and safe.global returns nothing outside node_modules, while REDEPLOY_PLAN.md:184-194 instructs you to schedule and execute 'through the Safe' as though a UI exists. packages/aa-smoke-old/scripts/deploy-safe.mjs can create a Safe but nothing can drive one. If app.safe.global does not index chain 4663, every Safe-owned power in this deployment is unoperable on day one. At threshold 1 the fix is small: the owner calls execTransaction directly from their own wallet using Safe's pre-approved-hash signature form, so there is no off-chain signature to collect, sort or concatenate.

### Pasos concretos hoy

- 1. Confirm whether app.safe.global indexes chain 4663. If it does not, treat the signing script in step 5 as a hard launch blocker, not a convenience. This is the single check that decides whether the redeploy can be governed on day one.
- 2. Edit script/DeployNuvem.s.sol:224-243. Keep the try/catch probe on getThreshold() and getOwners() exactly as it is (that probe is the real typo guard). Replace only the assertion at :240-242 with `threshold >= 1 && threshold <= owners.length && owners.length >= 1`, reverting InvalidCorporateMultisigShape otherwise. Rename the function to _requireMultisigInterface. Do NOT add NUVEM_MULTISIG_THRESHOLD / NUVEM_MULTISIG_OWNERS env vars — vm.envUint reverts when unset, and you are deleting env vars elsewhere in this plan, not adding them.
- 3. Keep _requireContract("CORPORATE_MULTISIG", ...) at DeployNuvem.s.sol:201 untouched.
- 4. Update test/unit/script/DeploymentScripts.t.sol:68-83: drop the two exact-3-of-5 shape tests, and keep/extend the case that passes address(weth) as the multisig so it still asserts UnsupportedCorporateMultisig — that test is now the primary evidence the typo guard works.
- 5. Copy packages/aa-smoke-old/scripts/deploy-safe.mjs to a new packages/contracts/scripts/safe.mjs pair: one command to deploy the Safe with THRESHOLD = 1n and two distinct owners, and one command `safe-exec <to> <value> <calldata>` that calls execTransaction from the owner's own wallet with signatures = abi.encodePacked(uint256(uint160(owner)), bytes32(0), uint8(1)) — Safe's approved-hash form, valid when msg.sender is an owner. That is roughly 40 lines of viem and it removes the entire off-chain signature-sorting problem. Verify it on the public testnet (chain 46630) against a throwaway Safe before mainnet.
- 6. Generate the two owner keys on separate devices. Owner 1 is your hardware wallet and does everything. Owner 2 is written down offline and never touched. Set NUVEM_CORPORATE_MULTISIG to the deployed Safe address and delete the SAFE_OWNER_3/4/5 variables from your environment.
- 7. Update docs/security/THREAT_MODEL.md:87 to say '1-of-2 Safe; a single signer is the whole of governance; the second owner exists for key-loss recovery only'. Write it before you deploy, not after. The point of choosing 1-of-2 explicitly is that the document stays true.

### El trade-off

You are trading multi-party review for operability. One stolen signing key is instantly all of governance, with no second signer to notice or refuse, and the offline backup owner doubles the number of keys that can each act alone. What that key can and cannot do is bounded, and the bound is the reason this is acceptable: with the beacon sealed (see the redeploy section) no governance key can rewrite the code holding your savings, and withdrawToken/withdrawNative are onlyVaultAdmin with no pause gate, no fee and no registry read (PersonalVault.sol:598-611), so every user can always exit with their own key. What a stolen governance key CAN still do is real and you should not wave at it: it can pause the protocol, disable or rotate the attester, and — via registerCohort — deploy a malicious cohort whose vaults have full custody of anything created in that cohort and which can permanently squat vaultOfAdmin[victim] through transferVaultAdmin (VaultFactory.sol:259-280), locking arbitrary addresses out of ever owning a Nuvem vault. That is why the factory stays behind the timelock in this plan. At 3-of-5-from-one-seed you would carry the same real risk while telling yourself you had five signers; at 1-of-2 the risk is the same size and honestly labelled.

---

## ANTES del redespliegue (son permanentes)

### 1. Seal cohort 1's beacon at deployment

**Esfuerzo:** 1-2 days including docs and deleting the upgrade tooling

**Qué:** Add a two-line `contract SealedUpgradeAuthority {}` to script/DeployNuvem.s.sol, deploy an instance inside VaultFactoryBootstrap's constructor, and change registerCohort at :55 from `(vaultImplementation, timelock)` to `(vaultImplementation, address(sealedAuthority))`. It must be a separately deployed contract — you cannot pass address(this), because the bootstrap's own code.length is 0 during its constructor and registerCohort reverts NotAContract at VaultFactory.sol:158-160. Seal at deployment, NOT by a post-ceremony renounceOwnership: that variant leaves a live upgradeable window and depends on completing a 7-day timelock operation, which is precisely the step that froze the canary. Same change: delete script/PrepareCohortUpgrade.s.sol (its BeaconNotOwnedByTimelock check at :75-82 makes it permanently unusable once sealed) and test/unit/script/CohortUpgradeScript.t.sol; update DeploymentScripts.t.sol:130; add two tests (beacon.owner() cannot upgrade; a cohort-2 implementation cannot reach a cohort-1 vault). Rewrite THREAT_MODEL.md:119-135 and :208-209, CONTRACTS.md, DEPLOYMENT.md, REDEPLOY_PLAN.md:22-23.

**Por qué:** UpgradeableBeacon.upgradeTo on the cohort-1 beacon is the ONLY governance power in this system that can take money already in a vault. Everything else is at worst denial of service: configureProtocol is one-shot and already consumed inside the bootstrap constructor, registerCohort cannot reach an existing vault, and the attester cannot settle without the trading key because SettlementExecutor.sol:86 resolves the vault from msg.sender. Removing that one power turns the depositor's trust statement from 'a Safe plus a 7-day delay plus monitoring you do not have' into 'the bytecode is fixed and you can always withdraw' — verifiable with one cast call. It also deletes the storage-layout hazard that test/unit/UpgradeContinuity.t.sol::testNewImplementationMisreadsALegacyStorageLayout proves is live and untooled.

**Riesgo aceptado:** The one genuinely irreversible item here: no bug can ever be fixed in a live cohort-1 vault. Defensible in this specific system because a settlement-path bug means 'savings stop accruing' while withdrawToken/withdrawNative keep working with no external dependency, and because you are the only user — recovery is 'withdraw, register cohort 2, recreate', an afternoon for one person. The unfixable cases are a bug in withdrawal itself or in the ERC-7201 layout. Do NOT infer that the timelock becomes unnecessary: registerCohort remains full custody over every vault created in a new cohort plus a permanent vaultOfAdmin squat via transferVaultAdmin.

### 2. Move ProtocolPauseController and AttesterRegistry ownership to the Safe

**Esfuerzo:** hours for the code, plus the threat-model rewrite

**Qué:** In script/DeployNuvem.s.sol:128-130, construct both with `config.corporateMultisig` as initialOwner instead of `address(deployment.timelock)`. Nothing else changes — both are GuardianOwnable is Ownable2Step, so a timelock can accept ownership later without a redeploy. Ship it with the rewrite of THREAT_MODEL.md rows :86 and :88 and invariant :208 ('Guardian actions are restrictive only; delayed governance performs reversal'), all three of which become false. Keep the guardian as a distinct key.

**Por qué:** Today every restrictive power is instant and every reversal takes 7 days: pause is onlyOwnerOrGuardian (ProtocolPauseController.sol:22) but unpause is onlyOwner (:29); disableAttester is onlyOwnerOrGuardian (AttesterRegistry.sol:44) but rotateAttester is onlyOwner (:31); setGuardian is onlyOwner (GuardianOwnable.sol:44). A leaked guardian key wins every race forever — it re-pauses instantly after each unpause and cannot be evicted for another week. One low-value key can deny the product indefinitely. After: a mis-fire or a suspected attester problem is same-day recovery instead of the product doing nothing for a week. Do this now, not later: after deployment it becomes a 7-day timelock operation.

**Riesgo aceptado:** Low and bounded. The Safe can now instantly pause, disable and rotate the attester. None of those move a wei: settle takes msg.value from the caller and pays into factory.activeVaultOf(msg.sender), so a forged attestation only makes the trading EOA overpay into its own vault, clamped by savingsBps and the caps. Caveat for the keeper: acceptSettlement and settle bind globalPauseEpoch and attesterEpoch (SettlementExecutor.sol:330-331), so an instant pause or rotation invalidates every in-flight attestation — already true of the guardian, so not new.

### 3. Stop deploying FeeController and FeeCollector; delete the treasury role and three env vars

**Esfuerzo:** days, mostly the Docker guards and the dist regeneration

**Qué:** Remove the two `new` calls at script/DeployNuvem.s.sol:142-144 and the DeployLocal.s.sol equivalents at :67/:73/:76, plus DeploymentConfig.treasury and .initialFeeBps (:76, :79), their validation (:199, :205-207), the env reads (:279-280, :285-288) and logging (:255-256). Delete NUVEM_INITIAL_FEE_BPS, NUVEM_TREASURY and NUVEM_TREASURY_PRIVATE_KEY from .env.example and scripts/deploy-mainnet.ps1, and the already-dead NUVEM_TARGET_ASSET_ADDRESS (.env.example:59). Do NOT delete src/fees/* — RELOCATE the two contracts and their interfaces into the test tree, because PersonalVaultLifecycle.t.sol:344-425 instantiates a live FeeController at 10,000 bps to prove withdrawals still return the full amount across four pause modes. Required edits both source plans missed: packages/keeper-old/Dockerfile:96-104 and packages/web/Dockerfile:74-82 hardcode the artifact name loop and assert `if(n<8){throw}` — I verified both; the Railway images fail to build otherwise. Also artifacts.test.mjs:26-34, DeploymentScripts.t.sol:101 and :127-129, and ProtocolComponents.t.sol:67-69/:76-78 inside the renounce test (edit it, do not delete it — it still covers pauseController and attesterRegistry). dist/ is committed and Railway builds from git, so regenerate it on a forge-equipped host in the same commit.

**Por qué:** Measured from broadcast/DeployNuvem.s.sol/31337/run-latest.json: 973,320 gas removed (8.07% of a 12,066,885-gas deployment), 2 of 10 deployed contracts, 3,366 bytes of runtime bytecode that would otherwise sit inside the audit boundary forever, three deploy-day env vars and one private key. It is provably unreachable, not merely unused: VaultFactory.ProtocolConfiguration has exactly four fields and none is a fee. And it is the shortest honest path to your stated goal — FeeController and FeeCollector are the only two contracts the Safe owns directly, so deleting them collapses the Safe to a single job by removing a power rather than granting one. Permanent once deployed.

**Riesgo aceptado:** Very low. Neither verified drill touches them — DeployDevnetDrill.s.sol and DeployPublicTestnetDrill.s.sol import no fee contract, so both end-to-end drills survive. You give up plumbing that connects to nothing: re-adding fees needs a PersonalVault change and a cohort registration regardless, since configureProtocol is one-shot with no fee field. Note in THREAT_MODEL.md:358-384 that the superseded canary still has a live Safe-owned FeeController and FeeCollector on mainnet — say 'out of this repo', not 'gone'.

### 4. Stop the web app defaulting to the frozen canary deployment

**Esfuerzo:** hours

**Qué:** Remove ALL FIVE MAINNET defaults at packages/web/src/lib/addresses.ts:39-45, not just the factory — I verified all five (vaultFactory, settlementExecutor, weth, pauseController, attesterRegistry) are canary addresses. Removing only the factory leaves four pinned, so every correctly configured deployment would show a permanent 'your environment disagrees with the factory' warning against addresses the operator never set; crossCheckExpectations (diagnostics.ts:1093-1094) filters rows whose expected is null, so nulling all five is silent and correct. Make the factory required with no fallback so an unconfigured deployment fails at boot through the existing ConfigProblem path. Update docs/runbooks/DEPLOYMENT_WEB.md:260-263 in the same commit. Separately and immediately: delete TradingAccounts.tsx:87-91, which tells users to export their vault-admin private key into a shell and run packages/aa-smoke-old/scripts/create-vault.mjs — a script that cannot work (its --invite path only runs after createVault in the same process at :115-127, so anyone who already has a vault hits VaultAdminAlreadyRegistered first, and its INIT_T at :62-90 encodes fields that no longer exist in NuvemTypes.VaultInitialization).

**Por qué:** A user following the documented two-variable docker run gets a dashboard silently bound to a VaultFactory whose owner is a sealed bootstrap and whose acceptOwnership was never executed — and the dashboard's own 'Protocol pinned: yes' row (VaultPanel.tsx:244-256) confirms it looks healthy, because configureProtocol WAS called on the canary. Failing at boot with a named variable beats onboarding someone onto a bricked deployment. The aa-smoke instruction is independently harmful today: it asks for a raw private key to run a script that cannot succeed.

**Riesgo aceptado:** The two-variable docker run stops working; every deployment must set NUVEM_VAULT_FACTORY explicitly. One required variable in exchange for making it impossible to point a user at a dead protocol.

### 5. Delete the adapter/investment stack and move devnet/mocks out of src/

**Esfuerzo:** 1 day for both, combined

**Qué:** Delete six files, 374 LOC: src/mocks/MaliciousInvestmentAdapter.sol (zero consumers repo-wide — grep returns only its own declaration), src/devnet/PublicTestnetFixedRateAdapter.sol (deployed by nothing; only consumer is its own test at PublicTestnetDrillScripts.t.sol:199-241), src/registry/AdapterRegistry.sol + IAdapterRegistry.sol (DeployNuvem.s.sol:137-141 already argues in prose it should not be deployed), IInvestmentAdapter.sol and MockInvestmentAdapter.sol. Keep MockTargetToken.sol — it is the non-WETH token for the withdrawToken path. Then RELOCATE the devnet trio plus MockWETH and MockTargetToken into script/fixtures/ — put the mocks there too, not under test/support/, because DeployLocal.s.sol:10-11, SettleDevnetDrill.s.sol:8 and VerifyDevnetTradingDrill.s.sol:9 import them and the test/support split would leave four scripts reaching into test/. Same three omitted AdapterRegistry consumers as the fee item: keeper/Dockerfile:97, web/Dockerfile:75, artifacts.test.mjs:27. Land in the SAME commit as the fee deletion so dist/ regenerates once and the n<8 guard is adjusted to the final count in one edit.

**Por qué:** After both deletions and the move, src/ goes from 29 files / 2,808 LOC to 14 files / 1,961 LOC. What remains is exactly the protocol. An auditor handed src/ today reads an AdapterRegistry with code-hash pinning, an IInvestmentAdapter interface and a purpose-built malicious adapter, and must prove for themselves that none of it is deployed — billable hours proving a negative that a delete proves for free. The devnet fixtures are load-bearing for both verified drills, which is why they move rather than die.

**Riesgo aceptado:** Zero deploy gas and no protocol bytecode change — the protocol contracts' import graphs do not touch devnet/ or mocks/. State plainly that moving a .sol file changes its path in the Solidity metadata JSON and therefore the trailing CBOR hash of the FIXTURE bytecode, so drill fixtures are no longer byte-identical to what the recorded runs deployed: re-run the devnet drill on local anvil as an acceptance gate, and record in docs/ that the public-testnet artifacts predate the move. You give up the head start on reintroducing an investment path; git history is where that belongs.

---

## DESPUÉS del redespliegue (por prioridad)

### 1. Ship the withdraw button — the product currently has no way for the user to touch their savings

**Esfuerzo:** hours

**Qué:** Add withdrawToken to packages/web/src/lib/abi.ts (it is not merely uncalled, it is absent from the ABI file entirely, so it is unreachable from the client) and make it pass packages/web/scripts/check-abis.mts. Add a 'Withdraw everything' action to VaultPanel.tsx calling withdrawToken(core.value.weth, admin, vault.wethBalance) using the balance the panel already reads at :71-82 — zero typed values. Add a second button that calls WETH.withdraw(balance) from the admin's own wallet to unwrap. Two buttons, two transactions, zero typed values, and the user ends up holding ETH.

**Por qué:** The landing page promises 'a savings vault only you can withdraw from' (page.tsx:53-54) and there is zero implementation on the client. Today the user must hand-craft a call on a block explorer with the WETH address and a wei amount, then unwrap separately. This is the single largest gap between what the product claims and what it does, and it is hours of work.

**Riesgo aceptado:** Essentially none. Explicitly do NOT add a withdrawAllAsEth() helper to the contract to save one transaction: receive() reverts Unauthorized at PersonalVault.sol:788-790, so IWETH.withdraw refunding the vault would revert, and relaxing receive() widens the vault's inbound surface — the vault currently guarantees the only way value enters is acceptSettlement — and silently resurrects the dead withdrawNative path. One extra button is cheaper than that.

### 2. Wire acceptTradingAccountBySig and put invite in the web app

**Esfuerzo:** days

**Qué:** PersonalVault.sol:282-297 already implements a permissionless, gasless accept path with a digest getter at :299-302, and grep finds it called only from test/unit/PersonalVaultLifecycle.t.sol:133,146. Build an AcceptInvite page: the trading wallet opens a shareable link, connects, and signs ONE EIP-712 message; the admin's already-connected session submits acceptTradingAccountBySig. Reconstruct the typed data client-side — domain {name: 'Nuvem Personal Vault', version: '1', chainId: 4663, verifyingContract: vault}, AcceptTradingAccount{bytes32 vaultId, address vault, address tradingWallet, uint64 inviteNonce, uint64 adminEpoch, uint48 deadline} — and use acceptTradingAccountDigest(account) only as an equality assertion before prompting. You cannot sign the digest directly: it is a finished 32-byte hash and eth_sign is blocked in modern wallets. Note the 3rd field is named tradingWallet while the contract parameter is account, and the 5th must be populated from tradingAccount.inviteAdminEpoch. Read the deadline from chain — PersonalVault.sol:288 requires exact equality with tradingAccount.inviteDeadline. Ship it together with a web invite button (inviteTradingAccount is also missing from abi.ts) or the aa-smoke instruction cannot be removed.

**Por qué:** Today the invite handshake costs the second wallet a funded ETH balance on chain 4663, a chain-add, a chain-switch and a transaction it has no interface for. After: one signature, no gas, no transaction. This is the step that currently sends users to a terminal with a raw private key.

**Riesgo aceptado:** Do not claim '0 chain switches' — the vault's EIP-712 domain carries chainId 4663 and MetaMask rejects eth_signTypedData_v4 whose domain chainId differs from the active chain, so the signer still needs the add/switch prompt. What you actually remove is gas, a funded balance and a transaction. Bound the admin's option value with short invite deadlines (hours, not the 7 days create-vault.mjs uses) and display the deadline in the signing UI: landing the signature sets factory.activeVaultOf[trader], which globally bars that address from creating its own vault, and the trader's only unilateral escape is revokeMyTradingAccount() — a funded transaction on 4663.

### 3. One question instead of six numbers, with the clamp fixed

**Esfuerzo:** hours

**Qué:** Add packages/web/src/lib/policy-defaults.ts with three presets keyed on savings share only (10/20/30%), and ask exactly one question at invite time. Derive: minContributionWei = 1e12, gasReserveWei = 5e14, a NON-ZERO tradingFloorWei, and — this is the correction that matters — set maxPerSettlementWei = maxRolling30dWei rather than a fixed 0.05 ETH. _validateTradingPolicy only requires min <= maxPerSettlement <= maxRolling30d, so this satisfies it by construction and lets the 30-day cap be the single brake. Keep an 'Advanced' disclosure showing all six real values, and show the user the effective clamp next to the percentage they picked. Add setMySavingsBps / setTradingAccountSavingsBps to abi.ts and give them a UI before claiming the choice is adjustable later.

**Por qué:** Six coupled wei-denominated numbers whose worst failure is silent — diagnostics.ts:357-388 documents that a 0-bps invite 'activates, links, reads ACTIVE, and can never save a wei'. An entire diagnostics module is scar tissue from exposing these to a human.

**Riesgo aceptado:** The naive preset numbers are worse than the form they replace. maxPerSettlementWei is a hard CLAMP, not a rejection — SettlementExecutor.sol:362 does contribution = min(contribution, maxPerSettlementWei) — so a 0.05 ETH cap on the '30%' preset turns a 1 ETH profit into 0.05 saved instead of 0.3, an 83% shortfall delivered with every diagnostic green. tradingFloorWei = 0 is the same mistake on the other side: available = balance - (floor + gasReserve), so a zero floor skims the trading wallet down to 0.0005 ETH on the same wallet the keeper pays gas from. Keep diagnostics checks 7 and 13 at BLOCKING severity: they evaluate accounts that exist on chain, including ones created by an older build or re-policied later, and 'no supported path produces them' is not 'no path produces them'.

### 4. Zero-config vault creation

**Esfuerzo:** hours

**Qué:** Delete both fields on the create form: the 'Vault label' input (CreateVaultCard.tsx:268-281) and the 30-day ceiling (:283-305), plus the capWei parser at :70-77. Server-side in api/create-vault/route.ts:149, derive the salt as keccak256(abi.encode(owner, creationNonces[owner])) — I verified the nonce advances on successful createVault (VaultFactory.sol:186) and on transferVaultAdmin (:395-396) and rolls back with a reverted transaction, so preview and submit stay in step. Default the aggregate cap to the preset's per-account maxRolling30dWei or a small multiple, NOT type(uint128).max.

**Por qué:** The label is provably decorative — VaultFactory.sol:318-321 allows exactly one vault per admin, so a second label can never produce a second vault, yet the UI warns 'same label, same address, forever' about a choice with one possible outcome. The cap field exists only because PersonalVault.sol:724-726 rejects zero. After: connect, press one button, nothing to get wrong.

**Riesgo aceptado:** A salt derived purely from the owner address is a permanent lockout after an admin handover: transferVaultAdmin deletes vaultOfAdmin[previousAdmin] so the old admin passes that check on a retry, but vaultById[vaultId] is still populated and createVault reverts VaultAlreadyExists forever. The nonce-derived salt is what avoids this. type(uint128).max on the aggregate cap silently and permanently removes the only vault-scope brake, undoable only through setVaultPolicy which has no UI.

### 5. Read the settled frontier off the vault, as a monotone floor

**Esfuerzo:** days

**Qué:** Add readSettledFrontier(account) to ChainAccess in packages/keeper-old/src/onchain.ts calling PersonalVault.settlementFrontier(account, e) for e = 0..bindingEpoch, taking the max. Use it as settledFrontierL2 = max(local frontier, chain frontier) where the chain read may only RAISE the value — a ratchet, not a replacement. Cache frontiers for every epoch below the current one; they are immutable once bindingEpoch moves past them, so the loop is O(1) per tick after the first. That deletes reconcile.ts Phase B (enumerateChainSettlements :181-213, the adoption loop :550-693, recoverL2Window and searchL2ByL1 :277-392, unaccountedNonces :418-437), the cold-start gate at keeper.ts:473-509, the l2_precision state machine and COVERAGE_UNRESOLVED. Keep enumerateChainSettlements as an on-demand `keeper recover` command rather than deleting it — UNDECODABLE_SETTLEMENT (reconcile.ts:658-666) is the only detector for a settlement that happened by a route this code does not model. Fix the four now-false comments: onchain.ts:322-327, ledger.ts:78-79, reconcile.ts:5-7 and the README.

**Por qué:** The keeper's largest subsystems exist to reconstruct a number the vault publishes. settlementFrontier(account, bindingEpoch) is at PersonalVault.sol:199-206, is in the shipped ABI, and packages/web/src/lib/vault.ts:735-746 ALREADY reads it — so this is proven in-repo, not speculative. The L1->L2 binary search, the eight partial unique indexes and the three triggers all exist because four comments assert a getter does not exist. This removes roughly 1,400 lines and makes 'I lost the state volume' a contract read instead of a recovery ceremony.

**Riesgo aceptado:** Use the floor form, not the replacement form. The contract's own double-spend guards are epoch-keyed (frontier[account][epoch] and usedSessions, PersonalVault.sol:532,554), so a stale, wrong or zero read across a bindingEpoch bump is unguarded ON CHAIN and would cause a genuine double payment. The ratchet is what a lying or lagging RPC cannot defeat. Also start the epoch loop at 0 and note bindingEpoch increments on first activation (:627), which the original enumeration missed. You give up per-session attribution as a precondition to settling; the logs still have it when you want it.

### 6. Fold session-engine into keeper

**Esfuerzo:** days

**Qué:** Move packages/session-engine-old/src/* into packages/keeper-old/src/engine/*.ts with plain relative imports. That deletes 83 of the 118 lines of packages/keeper-old/src/engine.ts (a single comment block defending ../node_modules specifiers) and both Dockerfile guards — [engine-contract] at keeper/Dockerfile:150-178 which fails the build if session-engine's package.json ever grows a 'files' field, and [engine-graph] at :309-354 which parses engine.ts and resolves each specifier in the pruned tree. HARD CONDITION: carry `tsx scripts/check-settle-selector.mts &&` into packages/keeper-old's test script and move the script with the rest. Also update packages/web/Dockerfile:95 and the keeper Dockerfile manifest COPY block plus their 'ALL FIVE manifests' comments, and regenerate pnpm-lock. Sequence this BEFORE the aa-smoke retirement, or make that item responsible for repointing packages/aa-smoke-old/scripts/settle.mjs:22.

**Por qué:** 213 lines exist solely to defend a package boundary against a one-word edit in a package the keeper does not own, and the failure it guards has already killed the container at boot once (engine.ts:9-14 records it). Both packages are on vitest 3.2.4 so the 54 cases port without rewriting. This is the component that moves the user's money; removing a startup failure class beats guarding it.

**Riesgo aceptado:** The trap is deleting session-engine/package.json without noticing its test script is the ONLY guard on the hardcoded SETTLE_SELECTOR and the startBlockL2/endBlockL2 field presence in src/chain.ts. classify.ts matches settlements with startsWith(SETTLE_SELECTOR), so a stale constant silently reclassifies the protocol's own contribution as an opaque cash outflow and understates realized profit on every window containing a settlement — wrong numbers, not an error. You also give up the claim that the profit engine is independently reusable, which nothing currently exercises.

### 7. Retire aa-smoke's ERC-4337 half and correct its live/dead split

**Esfuerzo:** days

**Qué:** Delete 1,260 LOC (not 1,060): src/config.ts, permissions.ts, runtime.ts, settlement.ts, robinhood-testnet.ts, config.test.ts, encoding.test.ts, logging.test.ts. Nothing imports @nuvem/aa-smoke, and it is the only reason @alchemy/aa-infra, @alchemy/common and @alchemy/smart-accounts are in the lockfile (5.2 MB). Delete 11 entries from .env.example:64-81 and the AA_SMOKE_RUNBOOK. RETIRE scripts/settle.mjs rather than relocating it — its own header at :35 says 'SUPERSEDED BY THE REDEPLOY, AND NOT YET REPLACED' and it hardcodes old canary addresses; keeper/src/attest.ts:3 identifies itself as its faithful port. Repoint the six doc/web citations at packages/keeper-old/src/attest.ts. Relocate the genuinely live scripts (new-canary-wallet.mjs, delegate-7702.mjs, check-delegation.mjs, deploy-safe.mjs plus your new safe-exec) into packages/contracts/scripts/. Also update packages/keeper-old/Dockerfile:119 and packages/web/Dockerfile:96, which COPY packages/aa-smoke-old/package.json for --frozen-lockfile.

**Por qué:** Eleven fewer env vars out of roughly forty in the file you copy to .env, three npm dependencies gone, one workspace package gone, and an Alchemy API key off the list of credentials the project appears to require. Combined with the session-engine fold, the workspace goes from six packages to four, all of which ship something someone touches.

**Riesgo aceptado:** This is the only item that deletes a real future capability rather than a corpse: when you build session keys — the thing that would stop the keeper holding the trading wallet's full private key — you rewrite this installer. GMGN_EIP7702_RESULTS.md:110-146 preserves the hard-won finding, so the knowledge survives and only the code goes. Defer this entirely if session keys are on the near roadmap. Safety is also conditional on the previous item preserving check-settle-selector.mts: src/encoding.test.ts:156-228 is a settlement-ABI block that pins selector 0xc8f2629d, and deleting both in one release removes every copy of that guard at once.

### 8. Delete the daemon-only breakers — but keep the two that are not about attendance

**Esfuerzo:** days

**Qué:** Delete the revert classification table, per-window attempt counter, exponential backoff and latching REVERT_BREAKER (keeper.ts:135-264, 626-695, 1011-1075), health.ts, the heartbeat/wedged-loop machinery, and maxSettlementsPerDay. KEEP CATCHUP_TOO_WIDE (watch.ts:57-99, config.ts:483) and the per-tick RPC budget (bin/keeper.mts:205-218) — remove both from the deletion list. Rewrite the reorg rationale: the correct argument for dropping the reorg detector is that a re-read frontier self-heals a vanished settlement, NOT the 64-block finality margin, which at roughly 7 L2 blocks/s is about nine seconds and nowhere near a reorg horizon on a Nitro chain.

**Por qué:** Roughly 600 lines and twelve of the eighteen TickOutcome values exist because nobody is watching. A human looking at 'reverted: NonProgressiveBlockRange' does not click 2,880 times a day, which is the exact failure keeper.ts:136-143 was built for.

**Riesgo aceptado:** Gate the deletions on the settlement path actually being human-approved; deleting the revert breaker while an unattended daemon still sends removes the only thing stopping thousands of gas-burning retries. CATCHUP_TOO_WIDE is what makes the scan TERMINATE — window.ts:120 issues one RPC call per block, so without a ceiling the scan span is all that stands between a quiet fortnight and a multi-million-call pass. The RPC budget is a cost control on a metered key that also sits behind an unauthenticated same-origin relay whose own header admits 'nothing here rate-limits by IP'. A human at a keyboard bounds neither.

### 9. Show the four numbers the attester cannot prove

**Esfuerzo:** hours

**Qué:** Surface cashStart, cashEnd, externalDeposits and externalWithdrawals, plus the ledgerRootV2 preimage (positionsRoot, zeroBasisRealized, replayStartBlockL2, the classified tx list), in the UI next to the settle action and in the settle receipt. Do NOT rotate AttesterRegistry.attester to a user-controlled key.

**Por qué:** SettlementExecutor.sol:93-98 and :164-181 recompute realizedProfit itself, so those four figures are the ENTIRE unverifiable surface. Showing them is the honest version of the trust story at near-zero cost — the user can check them against their own GMGN history.

**Riesgo aceptado:** Rotating the attester is the trap and it must be dropped: AttesterRegistry holds a SINGLE, PROTOCOL-GLOBAL attester and SettlementExecutor.sol:109-114 reads it with no per-vault scoping, so making it a user key makes that one user the attester for every vault in the protocol — a protocol-level change dressed as a per-user setting, and a 7-day operation to make plus another 7 to undo. It also buys nothing once the user's own wallet is the sender.

### 10. Move settlement to a button, backed by a stateless attest endpoint

**Esfuerzo:** a month-plus, not weeks

**Qué:** A Next.js route at api/attest holding ONLY the attester key: POST {startBlockL2, endBlockL2} runs buildSessionReport, the attest.ts:146-338 preflight unchanged, the frontier read, previewContribution, and returns the signed attestation. The browser calls writeContract({address: executor, functionName: 'settle', ...}) from the TRADING wallet. Keep a minimal server-side scanner that owns a durable anchor and a bounded per-pass scan span — it holds no spending key, so the custody win is preserved — and have the button read pre-scanned candidates. Budget the trading-wallet session as NEW UI work with its own connect flow and copy, not an edit to VaultPanel.tsx. Surface the attestation deadline as 'expires in N minutes, including confirmation time', and pin or floor the gas parameters in the writeContract call.

**Por qué:** The server stops holding TRADING_OWNER_PRIVATE_KEY, which THREAT_MODEL.md:83 itself calls total custody of the trading wallet. That is the single biggest risk reduction available, and it deletes the deployment target entirely: no long-running container, no volume, no healthcheck.

**Riesgo aceptado:** Two claims that sound easy and are not. 'A route lists candidates by scanning frontier to head' is not implementable as an HTTP request: scanWindow issues one sequential eth_getBlockByNumber per block, and the frontier only moves when something settles, so a quiet week is millions of blocks — the keeper is viable only because it keeps an anchor that advances every tick regardless of settlement, capped at 2,000 blocks. And 'the connected wallet IS the trading EOA' is false for the current app: PersonalVault.sol:249 forbids one address being both, and the entire web app is built around the admin session. Also, settle computes the contribution from msg.sender.balance AFTER the full gas prepay, and attest.ts assumes 800k of headroom that a browser wallet's user-editable gas can exceed, producing InvalidContribution. Nothing settles while you sleep; the 30-day rolling cap means a backlog settles in pieces.

### 11. Demote the SQLite store from authority to log

**Esfuerzo:** days

**Qué:** Delete probeStoreFile and the SQLITE_MAGIC/page-count forensics with their HOW_TO_RECOVER prose (ledger.ts:979-1151), the per-row digest hash chain and #assertIntegrity, the DEGRADED latch and the --acknowledge-degraded ceremony (:1366-1377), and demote STORE_INTEGRITY from a settle gate to a reported warning. That is roughly 500-700 lines, not 1,000. KEEP the settlement table as the monotone frontier ratchet, KEEP the CHECKPOINT/anchor rows, and KEEP the lock file for as long as any server process writes the store.

**Por qué:** Once the frontier is a chain read and the sender is the user's wallet, the damage forensics guard a file that no longer gates money. 'Restore the volume from backup' stops being a thing a user can be told.

**Riesgo aceptado:** 'The store proves nothing the chain does not' is false in two places. The scan anchor has no on-chain counterpart — it advances past windows scanned and found empty, which the frontier cannot express. And the local settlement table is the ratchet that stops a lagging frontier read from lowering the boundary across an epoch bump, which is the one path to an actual double payment. Deleting the lock file while a scanner still writes reintroduces two-writer corruption on the anchor. Sequence this strictly after the frontier and button items have landed and been observed; its entire safety argument is inherited from them.

### 12. Retire the dry-run/live gate — LAST, and only mechanically

**Esfuerzo:** hours

**Qué:** Delete BROADCAST_ACK and the byte-exact acknowledgement check (config.ts:50, 396-420), the mode-gated trading-key handover (:524-562), the DRY_RUN branch in submit.ts:199-219, describePlan's print-calldata option and the KeeperMode type. Keep planSettlement (submit.ts:148-182) as a pure /api/preview that never signs.

**Por qué:** Once no server process holds a spending key, the sentinel guards nothing and the wallet's own confirmation screen is a strictly better dry run because the user cannot skip reading it. This is currently the single most-explained concept in the package.

**Riesgo aceptado:** This is the cheapest item on the list, which makes it the one most likely to be done first — and doing it first is the worst mistake available. config.ts:546 is the single line keeping tradingKey null outside live mode, and submit.ts:198-219 is the gate stopping a plain `keeper tick` from broadcasting. Deleting either while the daemon still holds TRADING_OWNER_PRIVATE_KEY removes the only structural barrier between a typo and a live transfer of real funds. Encode the precondition mechanically: the settlement path must no longer be able to construct a signer at all, and the surviving scanner must run as a separate image with no code path that reads a trading key.

---

## NO simplificar (y por qué)

- The two-wallet rule (vault admin cannot be a trading account), enforced at PersonalVault.sol:249, VaultFactory.sol:231-234 and :322-325. Merging them is the single largest friction removal available and it deletes the product's only remaining security property, totally. The keeper holds the trading key in a Docker container — 'TOTAL CUSTODY' per ATTESTER.md section 1 — so a merged role means that hot key can call withdrawToken and empty the savings, and page.tsx:53-54 becomes a false statement. It is also not a 'weeks' change post-deploy: VaultFactory is NOT upgradeable (constructed with `new VaultFactory(address(this))`, no proxy), SettlementExecutor holds the factory as immutable, and configureProtocol is one-shot — so changing it means a new factory, a new executor, a new pinned configuration and a user migration.

- The timelock on the factory. Sealing the beacon removes the theft path against money already deposited; it does NOT make the factory safe to hand to a single key. registerCohort gives a new cohort's implementation full custody of every vault created in it, and — unconditionally — any registered vault can call transferVaultAdmin (VaultFactory.sol:259-280) to write vaultOfAdmin[victim] permanently, locking arbitrary addresses out of ever owning a Nuvem vault with no reset. Keep 7 days. Do not raise it to 30 either: PrepareCohortUpgrade.s.sol:30 declares its own GOVERNANCE_DELAY constant, so raising only DeployNuvem.s.sol:70 produces payloads that revert TimelockInsufficientDelay, TimelockController has one global _minDelay so it creates no tiers, and a longer delay nobody is monitoring is a delay on the attacker's calendar.

- A distinct guardian key. It can only pause and disableAttester and nothing else — that is exactly why it is the one credential safe to keep hot. Merging it into the cold governance wallet means the emergency stop now requires unlocking a hardware wallet, which is more friction in the only scenario measured in minutes. Once pause/attester ownership moves to the Safe, the guardian's one real downside (the instant-restrict / week-to-reverse ratchet) is already gone and the key becomes strictly cheap.

- CATCHUP_TOO_WIDE and the per-tick RPC budget. The first is what makes the block scan terminate — window.ts:120 is one RPC call per block. The second is a cost control on a metered key that also sits behind an unauthenticated same-origin relay. Neither is bounded by a human being present.

- The scan anchor (anchorBlockL2/anchorBlockHash) and the lock file, for as long as any server process writes the store. The anchor advances past windows scanned and found empty, which the frontier cannot express; the lock is what stops two writers corrupting it.

- check-settle-selector.mts. It is the only guard on the hardcoded SETTLE_SELECTOR and the L2 block field presence. Its failure mode is not an error, it is wrong numbers: classify.ts matches settlements by selector prefix, so drift silently reclassifies the protocol's own contribution as an opaque cash outflow and understates realized profit on every window containing a settlement. Carry it into keeper's test script.

- _requireContract on the governance address (DeployNuvem.s.sol:201) and the getThreshold()/getOwners() probe. The numbers 3 and 5 were never the control; the interface probe is. A pasted-wrong address almost never answers both calls, and that is the exact failure that froze the canary.

- maxContributionWei (attest.ts:294-300). Four lines, and the only breaker that protects against a mis-set policy rather than against an absent operator.

- PersonalVault's reverting receive() (:788-790). It is what guarantees the only way value enters a vault is acceptSettlement. Relaxing it to save one transaction on withdrawal also silently resurrects the dead withdrawNative path.

- initialize(). Do not fold the first invite into it. It saves exactly one transaction and bakes a wall-clock deadline into initData, which feeds the BeaconProxy initcode that determines the CREATE2 address — so the vault address would depend on a timestamp, and a stale tab turns 'your invite expired' into the whole createVault reverting from inside a proxy constructor. It also risks running the invite body before $.adminEpoch = 1 is assigned, producing a vault that deploys clean with an invite nobody can ever accept.

- Diagnostics checks 7 (savings-bps) and 13 (policy coherence) at blocking severity. They evaluate accounts that exist on chain, including ones created by an older build or re-policied later via setTradingAccountPolicy. Presets make the bad state unlikely, not impossible.

- AttesterRegistry.attester as a protocol-global role. Do not rotate it to a user key: SettlementExecutor.sol:109-114 reads it with no per-vault scoping, so one user's key would become the attester for every vault in the protocol.

- The two fee contracts as TEST fixtures. Stop deploying them, but keep the source in the test tree: PersonalVaultLifecycle.t.sol:344-425 instantiates a live FeeController at 10,000 bps across four pause modes, and that is the only adversarial evidence for the fee-free-withdrawal invariant. 'The contract does not exist' is a weaker proof than 'a hostile fee contract exists and the vault ignores it'.

- Privy embedded wallets as the vault ADMIN. It puts the withdrawal key for the entire savings balance behind an email-recoverable custody model with a one-hop drain path and nothing at the contract layer gating it. The stated escape hatch does not rescue it either: acceptVaultAdmin must be sent BY the hardware wallet, so that wallet needs gas on 4663 anyway, and it force-pauses settlement and bumps adminEpoch, killing every pending invite.
