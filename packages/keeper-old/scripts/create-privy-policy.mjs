#!/usr/bin/env node
// Create the Privy policy that bounds what the keeper may do with a user's wallet.
//
// THIS FILE IS THE SECURITY BOUNDARY. With Privy signers there is no on-chain
// module enforcing the restriction — Privy's enclave evaluates this policy and
// refuses anything outside it. Everything the keeper is *not* allowed to do is
// defined here by omission, so read it as a whitelist and keep it narrow.
//
// WHAT IT ALLOWS, and it is now two things rather than one.
//
// 1. `settle` on ONE address, the SettlementExecutor. Not "the executor plus a
//    bit"; not "any contract"; one address and one function. The executor has no
//    arbitrary-recipient path and no administrative withdrawal
//    (SettlementExecutor.sol:19-20), so a call to it can only ever move the
//    account's own ETH into that account's own vault.
//
// 2. `invest` with value 0, on this chain. THE ADDRESS IS DELIBERATELY NOT
//    PINNED here, because a vault address is per user and one app-wide policy
//    cannot enumerate them. What makes that acceptable is the rest of the
//    constraint: with `value == 0` and a fixed selector, the only contract on
//    this chain that does anything for that selector is a PersonalVault, and a
//    vault authenticates `msg.sender` against its own trading-account mapping.
//    A call to a vault the user does not own reverts. The residual is burnt gas.
//
//    Note what `invest` cannot do even when it succeeds: the assets, the weights,
//    the price floors, the ceilings and the recipient all come from vault storage
//    the admin signed for with their own wallet. The keeper chooses the MOMENT,
//    inside those bounds. That is the whole of the authority this rule grants.
//
// FUNCTION NAMES ARE PART OF THE CONSTRAINT NOW. The settle rules previously
// pinned only `to`, which let any calldata through to the executor. Nothing
// exploitable followed — `settle` is its only state-changing entry point — but
// "no exploit today" is not the same as "bounded", and the invest rules could
// not be added safely without also tightening these.
//
// Run once per deployment:
//   PRIVY_APP_ID=… PRIVY_APP_SECRET=… NUVEM_SETTLEMENT_EXECUTOR=0x… \
//     node scripts/create-privy-policy.mjs
//
// It prints a policy id. Put it in the web app as NEXT_PUBLIC_PRIVY_POLICY_ID so
// `addSigners` attaches it when a trading wallet is linked.
//
// UPDATING AN EXISTING POLICY, WHICH IS USUALLY WHAT YOU WANT AFTER A
// REDEPLOYMENT:
//   … PRIVY_POLICY_ID=… node scripts/create-privy-policy.mjs
//
// The executor address is baked into the settle rule, so a policy written for a
// previous deployment DENIES every settlement against the new one. Privy reports
// that as `policy_violation` from signTransaction — which reads as "Privy is
// rejecting us" and sends you looking at credentials rather than at an address.
//
// UPDATE IN PLACE RATHER THAN CREATE A SECOND POLICY. The policy id is attached
// to each wallet's signer at the moment the wallet is created, by `addSigners`.
// A new id therefore reaches new wallets only: every wallet a user already made
// keeps pointing at the old policy and keeps being denied, and there is no
// screen in this app that re-attaches one. Updating the id already in use fixes
// them all at once, including wallets created before the redeployment.

import { PrivyClient } from "@privy-io/node";
import { toFunctionSelector } from "viem";
import { abis } from "@nuvem/contracts-artifacts";

function required(name) {
  const value = process.env[name];
  if (!value) {
    // Never echo the value; a missing app secret must not print a partial one.
    throw new Error(`${name} is not set.`);
  }
  return value;
}

const appId = required("PRIVY_APP_ID");
const appSecret = required("PRIVY_APP_SECRET");
const executor = required("NUVEM_SETTLEMENT_EXECUTOR");
const chainId = Number(process.env.NUVEM_CHAIN_ID ?? "4663");
/** Set to rewrite an existing policy in place; unset to create a new one. */
const existingPolicyId = process.env.PRIVY_POLICY_ID?.trim() || null;

if (!/^0x[0-9a-fA-F]{40}$/.test(executor)) {
  throw new Error("NUVEM_SETTLEMENT_EXECUTOR must be a 20-byte address.");
}

const privy = new PrivyClient({ appId, appSecret });

// Privy requires an `abi` alongside a calldata condition, because it decodes
// before it compares, and it derives the function selector from that abi.
//
// TAKEN FROM THE COMPILED CONTRACT, NEVER TRANSCRIBED. A hand-written fragment
// is wrong the moment a struct gains a field, and it is wrong SILENTLY: the
// signature changes, the selector changes, `function_name` matches nothing, and
// every transaction falls through to the default DENY. Privy reports that as
// `policy_violation` from signTransaction, which reads as a credentials problem
// and sends you nowhere near this file.
//
// This is not hypothetical twice over. `invest` was written by hand with
// `components: []` and yielded 0x8c911cf8 instead of 0x0d209efb. `settle` was
// written the same way and yielded 0x106fb038 instead of 0xc8f2629d — its
// attestation tuple has TWENTY-SIX fields, which is precisely the kind of thing
// nobody transcribes correctly and everybody assumes they did.
//
// `internalType` is dropped because Privy's schema does not carry it; it is
// annotation and plays no part in the signature.
const stripInternalType = (node) =>
  Array.isArray(node)
    ? node.map(stripInternalType)
    : node && typeof node === "object"
      ? Object.fromEntries(
          Object.entries(node)
            .filter(([key]) => key !== "internalType")
            .map(([key, value]) => [key, stripInternalType(value)]),
        )
      : node;

const fragmentOf = (contract, fn) => {
  const found = abis[contract]?.find((entry) => entry.type === "function" && entry.name === fn);
  if (found === undefined) {
    throw new Error(`${contract}.${fn} is not in the compiled artifacts. Rebuild the contracts.`);
  }
  return [stripInternalType(found)];
};

const SETTLE_ABI = fragmentOf("SettlementExecutor", "settle");
const INVEST_ABI = fragmentOf("PersonalVault", "invest");

// Addressed to the executor AND calling `settle`. Both, not either.
const settleConditions = [
  {
    field_source: "ethereum_transaction",
    field: "to",
    operator: "eq",
    // Lowercased because policy comparison is on the literal value and a
    // checksummed address would silently never match.
    value: executor.toLowerCase(),
  },
  {
    field_source: "ethereum_calldata",
    field: "function_name",
    operator: "eq",
    value: "settle",
    abi: SETTLE_ABI,
  },
];

// `invest`, moving no ETH, on this chain. See the header for why `to` is not
// pinned and why that is bounded rather than merely convenient.
const investConditions = [
  {
    field_source: "ethereum_transaction",
    field: "value",
    operator: "eq",
    value: "0x0",
  },
  {
    field_source: "ethereum_transaction",
    field: "chain_id",
    operator: "eq",
    value: String(chainId),
  },
  {
    field_source: "ethereum_calldata",
    field: "function_name",
    operator: "eq",
    value: "invest",
    abi: INVEST_ABI,
  },
];

/**
 * Refuses to create a policy whose ABI does not describe the contract.
 *
 * A policy is written once and then silently governs every signature. If its ABI
 * drifts from the deployed contract the rules stop matching, and the symptom —
 * blanket denial — points at Privy rather than at this file. Checking here costs
 * one keccak and turns a production outage into a failed script run.
 */
function assertSelector(label, policyAbi, contractName, functionName) {
  const fromPolicy = toFunctionSelector(policyAbi[0]);
  const fragment = abis[contractName].find((e) => e.type === "function" && e.name === functionName);
  if (fragment === undefined) throw new Error(`${contractName} has no ${functionName}`);
  const fromContract = toFunctionSelector(fragment);
  if (fromPolicy !== fromContract) {
    throw new Error(
      `${label}: this policy's ABI yields selector ${fromPolicy}, but the compiled ` +
        `${contractName}.${functionName} is ${fromContract}. The rule would match nothing and every ` +
        "such transaction would be denied by default. Fix the ABI above, not this check.",
    );
  }
  console.log(`  ${label} selector ${fromContract} matches the compiled contract`);
}

assertSelector("settle", SETTLE_ABI, "SettlementExecutor", "settle");
assertSelector("invest", INVEST_ABI, "PersonalVault", "invest");

const name = `Nuvem settle-and-invest (chain ${chainId})`;
const rules = [
    // BOTH signing methods, because the engine matches on the RPC method first:
    // a request whose method has no rule at all is denied regardless of where it
    // was going. The keeper calls `signTransaction` (-> eth_signTransaction) and
    // broadcasts the raw transaction itself, so a policy naming only
    // eth_sendTransaction would deny every settlement — a total outage that
    // would read as "Privy is rejecting us" rather than as a missing rule.
    //
    // Allowing both costs nothing: they are the same constraint on the same
    // single address, differing only in who broadcasts.
    {
      name: "Settle: executor only, signed by keeper",
      method: "eth_signTransaction",
      action: "ALLOW",
      conditions: settleConditions,
    },
    {
      name: "Settle: executor only, sent by Privy",
      method: "eth_sendTransaction",
      action: "ALLOW",
      conditions: settleConditions,
    },
    {
      name: "Invest: value 0, this chain, signed by keeper",
      method: "eth_signTransaction",
      action: "ALLOW",
      conditions: investConditions,
    },
    {
      name: "Invest: value 0, this chain, sent by Privy",
      method: "eth_sendTransaction",
      action: "ALLOW",
      conditions: investConditions,
    },

    // Redundant TODAY — an unnamed method is already denied — but a DENY beats
    // any ALLOW in the same policy, so these survive a future edit that widens
    // the policy with a `*` rule. Key exfiltration is the one outcome that no
    // convenience should ever be able to re-enable by accident.
    {
      name: "Never export the private key",
      method: "exportPrivateKey",
      action: "DENY",
      conditions: [],
    },
    {
      name: "Never export the seed phrase",
      method: "exportSeedPhrase",
      action: "DENY",
      conditions: [],
    },
];

// Only sent when a key is provided. A policy that HAS an owner cannot be
// modified without the owner's signature; one that does not is happy either way,
// so passing it when it exists costs nothing and saves a confusing 401.
const authorizationKey = process.env.PRIVY_AUTHORIZATION_PRIVATE_KEY?.trim() || null;
const authorization = authorizationKey
  ? { authorization_context: { authorization_private_keys: [authorizationKey] } }
  : {};

// `update` REPLACES the rule set, it does not merge into it — which is what
// makes rewriting the whole thing from this file the safe operation: the rules
// that land are exactly the ones above, with no residue from a previous
// deployment's executor still sitting in the policy as a second ALLOW.
const policy = existingPolicyId
  ? await privy.policies().update(existingPolicyId, { name, rules, ...authorization })
  : await privy.policies().create({ name, version: "1.0", chain_type: "ethereum", rules, ...authorization });

console.log("");
console.log(`${existingPolicyId ? "updated" : "created"} policy: ${policy.id}`);
console.log(`settle target:  ${executor.toLowerCase()}`);
console.log(`chain:          ${chainId}`);
console.log("");
if (existingPolicyId) {
  console.log("Every wallet already bound to this id picks the new rules up on its next");
  console.log("signature — no wallet needs to be recreated and nothing needs re-attaching.");
} else {
  console.log("Set this in packages/web/.env.local, and in the web host's environment:");
  console.log(`  NEXT_PUBLIC_PRIVY_POLICY_ID=${policy.id}`);
  console.log("");
  console.log("It is attached to a wallet's signer when the wallet is CREATED, so a wallet");
  console.log("made before this id existed will keep using whatever it was given then.");
}
console.log("");
console.log("Anything this policy does not name is refused by Privy, including a");
console.log("transfer of the user's own ETH anywhere else. Widen it deliberately.");
