# Mainnet deployment and first settlement

**Date:** 2026-07-29
**Chain:** Robinhood Chain mainnet, chainId `4663`
**Result:** the full loop closed. A GMGN round trip on an EIP-7702-delegated EOA
produced a measured profit, and 20% of it landed in the trader's PersonalVault
as canonical WETH.

This is a single-wallet canary with a deliberately capped balance. It is not a
launch, and none of the production gate in [the deployment runbook](../runbooks/DEPLOYMENT.md)
is thereby satisfied.

## Deployed addresses

| Contract | Address |
| --- | --- |
| VaultFactory | `0xDf411fdCc7C31e4F6bCa6F6BCaB40FE812Ab4A46` |
| SettlementExecutor | `0xCe676c73bd9fb76a73058EC135106b81A5ABd0f5` |
| PersonalVault implementation | `0x22f5811b53b42746de5f1a861240471a3f88ce7a` |
| Cohort 1 beacon | `0x3c69b3f23C9e3a3AE1673e7CeD38CFee68f6C752` |
| TimelockController (7 days) | `0x48d3f86ee83d155df5db685e3da30258fb1f3be4` |
| ProtocolPauseController | `0x2dbbc211dbfe0f15e88e5388c96530f2721baefc` |
| AttesterRegistry | `0x2a3309931a6db1e1b253224551912566d647f921` |
| AdapterRegistry | `0x11b83d80e88e77fa1157d06115d5c7fec2d78e1a` |
| FeeController | `0x866573527217e541fa2b23416c1c77d90fd101e9` |
| FeeCollector | `0x17c603b3f1d15f2789c689c5613865d6ca48532c` |
| VaultFactoryBootstrap (sealed) | `0x571ffb5ee90f97810fd4522b81276700cf1b5cd6` |
| Corporate Safe (3-of-5) | `0x5364D009FFEe533AD8657Fe92973095453aB8205` |
| Canary PersonalVault | `0xF7309dC8e1914A5c3848250cec54Ebe7A20D8255` |

Canonical WETH pinned permanently by `configureProtocol`:
`0x0bd7d308f8e1639fab988df18a8011f41eacad73`. Confirmed before pinning: name and
symbol `WETH`, 18 decimals, and the GMGN pool used during the trading canary
holds 978.54 of this exact token. The testnet WETH has no code on 4663.

Deployment cost 13,895,644 gas across 8 transactions against an 18,064,333
estimate.

## Governance state

| Surface | Owner | Notes |
| --- | --- | --- |
| VaultFactory | sealed bootstrap; **pendingOwner = timelock** | handoff not executed |
| AdapterRegistry, AttesterRegistry, ProtocolPauseController | timelock outright | `GuardianOwnable` uses one-step `Ownable`, so these transferred at block one |
| FeeController, FeeCollector | corporate Safe | fee changes are immediate, no delay |

Two consequences follow immediately. `invest()` is unreachable until an adapter
is registered, which requires a Safe proposal and the full seven-day delay — so
the canary vault was created with `investmentEnabled: false` deliberately.
And until the Safe schedules and executes the exact `acceptOwnership` operation
printed by the deploy script, factory governance is frozen: no new cohorts, no
upgrade path.

## The settlement

Trading account `0xc455bF7f16ebbc2b07cb26D1Dd46194977974E7d`, savings 20%,
`bindingEpoch` 1.

```
GMGN round trip   0.02 ETH -> 14,253,100.77 WAN -> back   (flat at both ends)
cashStart         0.031229961908171659 ETH   (native + WETH, L2 block 22080592)
cashEnd           0.033246816355665397 ETH   (L2 block 22080850)
realizedProfit    0.002016854447493738 ETH   (net of gas)
contribution      0.000403370889498747 ETH   (20%, no clamp binding)
settle tx         0xd342d117634464f9c6c5b9b463dd8c0be1e638fdf623ea78334a097ad1cad186
                  success, 516,254 gas
```

Post-state, read back from chain: vault WETH balance and `lifetimeContribution`
both `0.000403370889498747`; `settlementNonce` 0 → 1; account rolling cap
0.0004 of 0.01 consumed, aggregate 0.0004 of 1. Events emitted: `Transfer`
(the WETH wrap), `RollingCapConsumed`, `ContributionReceived`, `SettlementExecuted`.

An external deposit of 0.027 ETH landed at L2 block 22078504, before the buy.
The window was started deliberately after it so the deposit would not read as
profit. A production indexer must classify such flows into `externalDeposits`
rather than rely on window placement.

## Finding: `block.number` is the L1 block number on this chain

**This is the most important result in this document.** The first `settle`
attempt reverted `InvalidBlockRange`, and the cause generalises to the whole
Phase 2 design.

Robinhood Chain is Arbitrum Nitro. In Solidity, `block.number` returns the **L1**
block number. `eth_blockNumber`, every receipt, and every log carry the **L2**
number. Measured the same second:

```
eth_blockNumber (L2)   22,084,284
block.number    (L1)   25,635,411
difference              3,551,127
```

The contracts are internally consistent — `PersonalVault` stores
`activationBlock` from `block.number` and `SettlementExecutor` validates the
attested range against `block.number`, both in L1 space. What breaks is the
integration: an indexer populating `startBlock`/`endBlock` with the L2 numbers
it observes produces attestations that revert, and would do so for every
settlement.

There is a second, subtler edge. The L1 range is far coarser: this canary's
258-L2-block window collapsed into **three L1 blocks** (25635381 → 25635384).
Because `acceptSettlement` requires `record.startBlock > lastEndBlock[account][bindingEpoch]`,
two genuinely distinct sessions that fall inside the same L1 block cannot both
settle. For an active trader on a fast L2 that is a liveness failure, not a
theoretical one.

Consequences for the indexer, which are requirements rather than suggestions:

- Attestation `startBlock`/`endBlock` must be **L1** numbers, obtained from
  `l1BlockNumber` on the L2 block.
- Session identity must not rest on the L1 range alone. `scripts/settle.mjs`
  puts the L2 heights into `ledgerRoot`, which is what keeps `sessionId` unique
  when L1 numbers collide.
- Balance and ledger reads must use **L2** heights.
- Any future chain must be re-checked: the mapping is chain-specific, and the
  script fails closed if `l1BlockNumber` is absent.

## Fixed in response to this work

- `proposeVaultAdmin(address(0))` now cancels an outstanding offer. Previously
  an offer never expired and could only be retracted by overwriting it with
  another live one, which merely moved the exercisable right elsewhere.
- `renounceOwnership()` is disabled on `GuardianOwnable` (so
  AdapterRegistry, AttesterRegistry, ProtocolPauseController), `VaultFactory`,
  `FeeController` and `FeeCollector`. It was inherited and unoverridden: a
  one-step irreversible path that could have frozen a 100% fee, a guardian
  pause, an attester disable, or factory governance permanently.
- A regression test pins the session-key selector list to `execute` alone. See
  below for why that single line is load-bearing.

## Finding: the session-key native cap rests on one line

`NativeTokenLimitModule` 1.0.0 does not decode `executeBatch`. Verified live on
46630 against the deployed module: `execute(dEaD, 2.7e14, …)` reverts
`ExceededNativeTokenLimit` (`0x94c58c94`), while `executeBatch` carrying the same
2.7e14 as three legs of 9e13 returns success.

The installed configuration contains this — a UserOperation from the session key
calling `executeBatch` is rejected at validation with `AA23 reverted`, because
`permissions.ts` installs the validation for the `execute` selector only. But the
containment is exactly one line, and widening that list for any reason would
silently remove the value cap. `encoding.test.ts` now asserts it.

This is a defect in Alchemy's module, not in this repository's contracts.

## Not proven

- The flat-to-flat window was chosen **by hand** after reading the wallet's
  transfers. No indexer exists, and the attester was a locally held key.
  The threat model's position that the settlement schema does not enforce
  flat-to-flat is unchanged and remains a production blocker.
- `invest()`, the fee path, and the adapter — unreachable until an adapter is
  registered through the seven-day timelock.
- Session-key negative cases against the real executor on mainnet. No session
  key is installed on the mainnet account; `settle` was called directly by the
  trading account, which is what the executor requires (`msg.sender ==
  attestation.account`).
- The factory ownership handoff, and therefore the whole delayed-governance
  ceremony, has never been rehearsed.
- One session, one token, one wallet.
