# Runbook: deploying the post-investment-removal protocol to mainnet 4663

The plan for replacing the superseded canary deployment. Written to be followed in
order, with a verification after every step that can fail silently.

Read [DEPLOYMENT.md](DEPLOYMENT.md) for the general gate and
[THREAT_MODEL.md](../security/THREAT_MODEL.md) for what this system does and does
not protect. This document covers only this deployment.

---

## What you are about to create, and what cannot be undone

Four things are permanent from the moment the deploy transaction confirms:

1. **`configureProtocol` is one-shot.** It pins WETH, the pause controller, the
   attester registry and the settlement executor into the factory forever
   (`VaultFactory.sol:116-126`). A wrong address here is not fixable. The factory
   is dead and you deploy again.
2. **The executor holds its factory immutably.** So the pair is welded together;
   replacing either means replacing both.
3. **Cohort registration is append-only.** Cohort 1 is the vault implementation
   forever; a new implementation is a new cohort or a beacon upgrade.
4. **Existing vaults cannot migrate to it.** The canary vault
   `0xF7309dC8e1914A5c3848250cec54Ebe7A20D8255` runs the old implementation whose
   `acceptSettlement` takes a record with no `startBlockL2`/`endBlockL2`. There is
   no path from it to this deployment.

Estimated cost, measured by dry run: **15,686,995 gas, ~0.000642 ETH.**

---

## Step 0 — the thing that went wrong last time

**The canary factory is frozen, and not by accident.** Read its state today:

```bash
cast call 0xDf411fdCc7C31e4F6bCa6F6BCaB40FE812Ab4A46 "owner()(address)"        --rpc-url $RPC
cast call 0xDf411fdCc7C31e4F6bCa6F6BCaB40FE812Ab4A46 "pendingOwner()(address)" --rpc-url $RPC
```

`owner()` is `0x571ffb5e…`, the `VaultFactoryBootstrap` contract — which has only
immutable getters and no administrative function whatsoever. `pendingOwner()` is
the timelock, which never called `acceptOwnership`.

So the factory is owned by something that cannot act, waiting on a handover nobody
completed. No cohort can ever be registered on it and no beacon upgraded. The
product still works — `createVault` is permissionless — but the deployment can
never be changed.

`acceptOwnership` has **zero test coverage**: it appears in `script/DeployLocal.s.sol`
and `script/DeployNuvem.s.sol` and nowhere under `test/`. The step that froze the
last deployment is the step nobody has ever exercised.

**Rehearse it locally before doing this on mainnet.** You chose to skip the full
anvil rehearsal and that is reasonable — the contracts are covered by 126 tests.
This one step is not, it has already failed once in production, and its feedback
loop is seven days long. Rehearsing only the ceremony costs minutes:

```bash
anvil &
forge script script/DeployLocal.s.sol --rpc-url http://localhost:8545 --broadcast
# then schedule, warp past the delay, and execute acceptOwnership through the
# timelock, and assert factory.owner() == timelock
```

Do not proceed to Step 3 on mainnet until you have watched `owner()` change on a
local chain.

---

## Step 1 — preconditions

### 1.1 Empty the canary vault

It holds **403370889498747 wei** of WETH. The vault admin can still withdraw after
the new deployment exists, but doing it first avoids operating two live vaults
that look alike.

```bash
cast send 0xF7309dC8e1914A5c3848250cec54Ebe7A20D8255 \
  "withdrawToken(address,address,uint256)" \
  0x0bd7d308f8e1639fab988df18a8011f41eacad73 <your-address> 403370889498747 \
  --private-key $NUVEM_VAULT_ADMIN_PRIVATE_KEY --rpc-url $RPC
```

Verify: `cast call <WETH> "balanceOf(address)(uint256)" <vault>` returns `0`.

### 1.2 Generate the deployer key

`NUVEM_DEPLOYER_PRIVATE_KEY` **does not exist yet**, and the script refuses to run
without it specifically so you do not reuse the trading, admin, attester, guardian
or Safe-owner keys (`deploy-mainnet.ps1:45-50`).

```bash
node packages/aa-smoke-old/scripts/new-canary-wallet.mjs NUVEM_DEPLOYER_PRIVATE_KEY .env.mainnet
```

It prints only the address. Fund it with **0.002 ETH** — three times the estimate,
because a failed deploy from an underfunded account still burns gas and you would
rather not diagnose that mid-flight.

### 1.3 Confirm governance is real

Already verified on chain, but re-check on the day, because everything downstream
assumes it:

```bash
cast call 0x5364D009FFEe533AD8657Fe92973095453aB8205 "getThreshold()(uint256)" --rpc-url $RPC   # 3
cast call 0x5364D009FFEe533AD8657Fe92973095453aB8205 "getOwners()(address[])"  --rpc-url $RPC   # 5 distinct
```

The Safe is the timelock's **only proposer**. If it is wrong, the new factory is
frozen from birth exactly like the last one.

### 1.4 Re-run the suite on the exact commit you will deploy

```bash
cd packages/contracts && forge test          # 126 passed
forge build --sizes | grep PersonalVault      # 18,641 — under both the 24,000 bound and the 20,000 ratchet
```

---

## Step 2 — deploy

Dry run first. It is the default; `-Broadcast` is what makes it real.

```bash
pwsh packages/contracts/scripts/deploy-mainnet.ps1
```

Read the banner. It should say `investing: not in this deployment` and
`protocol fee: none reachable`. If it still prints a target asset, you are on an
old commit.

Then, for real:

```bash
pwsh packages/contracts/scripts/deploy-mainnet.ps1 -Broadcast
```

One transaction sequence deploys, in order: the timelock, the pause controller,
the attester registry, the fee collector and controller (deployed but **not**
pinned — no vault can reach them), the vault implementation, and then
`VaultFactoryBootstrap`, which atomically creates the factory, creates the
executor against it, calls `configureProtocol`, registers cohort 1, and starts the
ownership transfer to the timelock.

**Record every address it prints.** They go into `.env` and `packages/web/.env.local`
in Step 4.

---

## Step 3 — verify before trusting it

Do all of these. Each catches a different silent failure.

```bash
# The four pinned addresses are what you intended. This is the one-shot state.
cast call <FACTORY> "protocolConfiguration()(address,address,address,address)" --rpc-url $RPC

# The executor points back at this factory, not the old one.
cast call <EXECUTOR> "factory()(address)" --rpc-url $RPC

# Cohort 1 exists and its beacon holds the new implementation.
cast call <FACTORY> "cohorts(uint32)" 1 --rpc-url $RPC

# The attester the registry will accept is the key the keeper holds.
cast call <ATTESTER_REGISTRY> "attester()(address)" --rpc-url $RPC   # 0x864743540b6D6E0a38f535e1200c0373e0D7AAde

# Nothing is paused.
cast call <PAUSE_CONTROLLER> "paused()(bool)" --rpc-url $RPC          # false

# The settle selector matches what the off-chain stack expects.
cast sig "settle((address,address,address,uint256,uint64,uint64,uint64,uint64,uint64,uint64,bytes32,bytes32,bytes32,uint64,uint64,uint64,uint64,uint256,uint256,uint256,uint256,int256,uint256,uint32,uint48,uint48),bytes)"
# 0xc8f2629d — and it must equal SETTLE_SELECTOR in packages/session-engine-old/src/chain.ts
```

**Then, and only then, complete the handover.**

### The ownership ceremony

The deploy printed the exact `schedule` parameters. Through the Safe:

1. **Schedule** `acceptOwnership()` on the factory, via the timelock, with the
   printed target, value, predecessor, salt and calldata.
2. **Wait seven days.** `GOVERNANCE_DELAY = 7 days` and it is not negotiable.
3. **Execute** the same operation.
4. **Assert it worked:**
   ```bash
   cast call <FACTORY> "owner()(address)"        --rpc-url $RPC   # the TIMELOCK
   cast call <FACTORY> "pendingOwner()(address)" --rpc-url $RPC   # the zero address
   ```

If `owner()` is still the bootstrap contract after this, you have reproduced the
canary's fate and the deployment can never be upgraded. **Do not onboard anyone
until those two calls return the values above.**

During the seven-day window the factory is functional but ungovernable: vaults can
be created, settlements work, and no cohort can be registered. That is an
acceptable state to be in briefly and a bad one to forget you are in.

---

## Step 4 — repoint everything off-chain

```
.env                     SETTLEMENT_EXECUTOR_ADDRESS
.env.docker              NUVEM_VAULT_FACTORY, NUVEM_SETTLEMENT_EXECUTOR,
                         NUVEM_PAUSE_CONTROLLER, NUVEM_ATTESTER_REGISTRY
packages/web/.env.local  NEXT_PUBLIC_VAULT_FACTORY and the rest of the block
packages/keeper-old/.env     whatever ATTESTER.md lists
```

Then reseal the credential bundle, because those files just changed:

```bash
./scripts/secrets-bundle.sh seal && git add secrets.enc
```

The check that proves it landed:

```bash
cd packages/web && RPC_URL=<mainnet> NUVEM_VAULT_FACTORY=<new factory> pnpm run verify
```

`check:chainguard` is **red today and expected to be** — this build speaks the
four-field `ProtocolConfiguration` and the live factory still answers with six.
It going green is the signal that the dashboard and the chain agree. A skip is not
a pass: without `RPC_URL` that stage silently skips itself.

---

## Step 5 — the first settlement

Do not automate into an empty deployment.

1. Create your vault through the dashboard, or `packages/aa-smoke-old/scripts/create-vault.mjs`.
2. Invite and accept the trading account `0xc455bF7f16ebbc2b07cb26D1Dd46194977974E7d`.
3. Trade a real round trip on GMGN.
4. Run the keeper in **dry run** and read what it says it would send. It is dry
   run by default; broadcasting needs both `--broadcast` and the environment
   sentinel.
5. Only when the dry run reports the numbers you expect, settle once.
6. Confirm `settlementNonce` incremented and the vault's WETH balance rose by the
   contribution.

Then back up the keeper's SQLite store before letting it run unattended. The
scenario that closed the last defect in it was a restore from mismatched backup
snapshots.

---

## Known gaps you are accepting by deploying today

None of these blocks the deployment. All of them are true after it.

- **No finality or reorg handling anywhere.** No confirmation depth is named in
  the contracts or the keeper. A reorg that unwinds a settled window leaves the
  keeper's frontier ahead of the chain and the account's next genuine session is
  refused as a replay. Nothing detects it.
- **Contiguous ledger coverage is not enforced onchain.** L2 progression proves
  each window starts after the last one ended, not that the gap between was ever
  examined.
- **The keeper holds the trading wallet's own key.** Total custody of that wallet.
  Fine for your own; it is why this cannot serve anyone else yet.
- **`setSettlementExecutor` and the cohort-upgrade path remain lightly tested**,
  and a cross-layout beacon promotion makes a vault read its old `adapterRegistry`
  slot as its settlement executor (`UpgradeContinuity.t.sol::testNewImplementationMisreadsALegacyStorageLayout`).
  `PrepareCohortUpgrade.s.sol` does not check layout.
- **No source is verified on any explorer**, so nobody can read what they are
  trusting.
- **No monitoring.** Nothing alerts on a pause, an attester rotation, a failed
  settlement, or the keeper going silent.
