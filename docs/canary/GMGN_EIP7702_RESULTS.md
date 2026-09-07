# GMGN / EIP-7702 canary results

**Date:** 2026-07-28
**Chain:** Robinhood Chain mainnet, chainId `4663`
**Verdict:** the gate **passes**. A 7702-delegated EOA trades on GMGN without
degradation. Phase 1 contract work may proceed.

This document records what was actually executed and observed. It is evidence,
not a claim of production readiness. Everything below was run with a funded test
wallet holding a deliberately capped balance.

## Scope

The question this canary answers is narrow and specific:

> Once an EOA is delegated under EIP-7702 so that `eth_getCode` no longer
> returns `0x`, does GMGN still accept it and trade normally?

It does **not** answer whether Alchemy session keys work (blocked, see below),
whether the settlement schema is sound, or whether any Nuvem contract behaves
correctly on this chain.

## Environment

| Item | Value |
| --- | --- |
| Trading account | `0xc455bF7f16ebbc2b07cb26D1Dd46194977974E7d` |
| Delegation target | `0x69007702764179f14F51cdce752f4f775d74E139` (Alchemy Modular Account v2) |
| Delegation code | `0xef010069007702764179f14f51cdce752f4f775d74e139` (23 bytes) |
| Delegation tx | `0x9396d142c5d97bd406ab6964adbf360df031d2f4c4a6642d495dd186cca34717` |
| GMGN router | `0x65050a9b7e5075a2ba5ced7b1b64ee66262c40dc` |
| Traded asset | THEHOOD `0xfd608e846681b1c0dba48d572c4fbb26a2d6a0d4` |
| Pool | `0x8366a39cc670b4001a1121b8f6a443a643e40951` |

The delegation was applied with a plain EIP-7702 type-4 transaction
(`packages/aa-smoke-old/scripts/delegate-7702.mjs`), **not** through ERC-4337,
because the Alchemy SDK path is currently broken (see *Blocked*). The resulting
account state is identical either way: what a venue observes is the delegation
designator in the code slot, and a session key is storage rather than code.

Cost of delegating: 36,850 gas.

## Results

| Matrix item | Result | Evidence |
| --- | --- | --- |
| Delegated wallet imports into MetaMask | pass | manual |
| MetaMask shows the same address and balances | pass | manual |
| MetaMask does not silently overwrite the delegation | pass | `delegatedTo` unchanged after the full session |
| GMGN connects the wallet, does not reject it as a contract wallet | pass | manual |
| Market buy | pass | nonce 55, 207,585 gas |
| ERC-20 approval | pass | nonce 56, 46,615 gas |
| Market sell (full) | pass | nonce 57, 201,481 gas |
| Native ETH receipt | pass | 0.00089778 ETH, internal call |
| Limit order (buy) created and executed | pass | nonce 58, 203,644 gas |
| Limit order (sell) created and executed | pass | nonce 59, 202,458 gas, proceeds 0.00094562 ETH |
| Permit2 | never invoked | no Permit2 logs in any receipt |
| ERC-1271 | not exercised by any GMGN flow | see *Findings* |

Round-trip 1 (market): 0.001 ETH in, 0.00089778 ETH out.
Round-trip 2 (limit): 0.001 ETH in, 0.00094562 ETH out.
Both sessions close flat with a negative realized result once gas is included,
which is a correct and useful negative case: the executor would compute a
non-positive PnL and contribute nothing.

## Findings that change the design

### 1. Sell proceeds are invisible without `debug_traceTransaction`

The GMGN router unwraps WETH and forwards **native ETH by internal call**. There
is no ERC-20 log and no top-level transaction recording it. On this chain:

```
trace_transaction                     NOT AVAILABLE on ROBINHOOD_MAINNET
alchemy_getAssetTransfers "internal"  NOT SUPPORTED on this network
debug_traceTransaction (callTracer)   works — detected 0.00089777827289936 ETH
```

The indexer must therefore be built on `debug_traceTransaction` with
`callTracer`. An indexer built on `trace_*` or on the asset-transfer `internal`
category will silently miss every sale's proceeds, which would make the
cash-delta PnL model produce confidently wrong numbers. This is a hard
constraint on Phase 2, not a preference.

### 2. GMGN limit orders are ordinary transactions

Both limit orders executed through the **same router selector `0x4d819a2a`** as
the market swaps, sent from the trading account itself with sequential nonces.
They are not offchain-signed orders. Consequently the signature-compatibility
risk that motivated this canary — Permit2 selecting ERC-1271 once the account
has code, or undocumented offchain order signatures — **does not arise in
GMGN's Robinhood Chain implementation**. This removes the largest architectural
risk identified in planning.

### 3. Receiving ETH costs more than 21,000 gas

A delegated account executes the implementation's fallback on receipt, measured
at **21,227 gas** versus 21,000 for a plain EOA. Any counterparty that sends
with a hard-coded 21,000 gas stipend will fail against a delegated trading
account. Relevant to any payout or refund path Nuvem builds.

### 4. ERC-1271 currently reverts

`isValidSignature(bytes32,bytes)` reverts on the delegated account. This is
consistent with no signature-validation entity being installed — the session key
definition sets `isSignatureValidation: false`, and installing anything is
blocked. It was not reachable by any GMGN flow, so it does not affect this
verdict, but any future feature that depends on contract-signature verification
must install a validation entity first and re-test.

## The delegation must be applied before the SDK is used

`@alchemy/smart-accounts@5.0.9` transmits the EIP-7702 authorization **unsigned**
when the account is not yet delegated: `eip7702Auth` carries the gas-estimation
stub `r`/`s` on the real `eth_sendUserOperation`, and the bundler rejects it with
`EIP-7702 sender/recovered authority mismatch`. Reproduced on testnet `46630` and
mainnet `4663`, on viem 2.55.8 and 2.55.10. Recovering the authority from the
stub tuple reproduces the bundler's reported address byte-for-byte, which is how
the cause was identified.

This is a limitation of the **low-level path** (`toModularAccountV2({ mode: "7702" })`
plus `createBundlerClient` from `@alchemy/aa-infra`). Alchemy's documented route
for applying a 7702 delegation is `@alchemy/wallet-apis`
(`createWalletClient` / `prepareCalls` / `sendPreparedCalls`), which returns the
authorization as an explicit signature request for the application to sign. That
package is not a dependency of this workspace.

**The delegation step is the only thing affected.** Once the account is delegated
— by any means — the SDK needs no authorization and the low-level path works
normally. Verified: after applying the delegation with a plain type-4
transaction, `AA_SMOKE_ACTION=install` succeeded on testnet at 450,585 gas
(userOp `0xd94ef17e…`, tx `0xc2b2ff64…`), installing the restricted session key
with its allowlist, native-limit, and paymaster-guard hooks.

The working sequence is therefore:

1. apply the delegation with `delegate-7702.mjs` (a type-4 transaction, no
   ERC-4337 involved), then
2. use the Alchemy SDK normally for session keys and every subsequent
   UserOperation.

This matches the two-signature onboarding the product design already anticipated:
one signature authorizing the EIP-7702 delegation, one for the operation that
installs permissions.

Still worth reporting upstream: the low-level path fails **silently** — it ships a
stub signature rather than signing the authorization or raising a clear error.

## Not proven

- Partial sell, failed-transaction refund, rapid consecutive trades, and a trade
  concurrent with a settlement.
- Session key **negative** cases: wrong target, wrong selector, value above the
  native cap, wrong paymaster, `executeBatch`, module installation, and
  revocation. Installation itself now succeeds, but the restrictions have not
  been exercised. Doing so requires a real `SettlementExecutor` deployed on the
  target chain; the install above used a placeholder allowlist target.
- Undelegation. `delegate-7702.mjs --revoke` exists but has not been exercised.
- Anything about Nuvem's own contracts on this chain. None are deployed.
- Long-run stability: this is a single session on a single token.

## Reproducing

```powershell
node packages/aa-smoke-old/scripts/check-delegation.mjs <rpc> <address>
node packages/aa-smoke-old/scripts/delegate-7702.mjs <rpc>              # dry run
node packages/aa-smoke-old/scripts/delegate-7702.mjs <rpc> --broadcast
node packages/aa-smoke-old/scripts/delegate-7702.mjs <rpc> --revoke --broadcast
```

The delegation script refuses to broadcast if the recovered authority does not
match the account, or if the implementation address has no code on the target
chain. Both guards matter: the implementation address is not guaranteed to be
identical across chains.
