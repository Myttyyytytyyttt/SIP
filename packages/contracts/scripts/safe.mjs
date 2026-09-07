#!/usr/bin/env node
// Deploy and DRIVE the corporate Safe.
//
// The driving half is the point. Nothing in this repository could call
// `execTransaction` before this file existed, while REDEPLOY_PLAN.md instructs
// the operator to schedule and execute "through the Safe" as though a UI were
// guaranteed to exist. If app.safe.global does not index this chain, every
// Safe-owned power in the deployment is unoperable on day one — the factory
// handover, the pause reversal, the attester rotation, all of it. That is the
// same shape of failure that froze the canary: a step nobody could perform.
//
// At threshold 1 there is no off-chain signature to collect, sort or
// concatenate. Safe accepts a "pre-validated" signature — a 65-byte word
// carrying the owner's address with v = 1 — which is valid precisely when
// msg.sender is that owner. So one owner, sending from their own wallet, can
// execute alone.
//
//   node scripts/safe.mjs deploy  --rpc <url> --owners <a,b> --threshold 1
//   node scripts/safe.mjs exec    --rpc <url> --safe <addr> --to <addr> --data 0x…
//   node scripts/safe.mjs info    --rpc <url> --safe <addr>
//
// The signing key comes from SAFE_OWNER_PRIVATE_KEY in the environment and is
// never accepted on the command line, where it would land in shell history and
// in the process table.

import { createPublicClient, createWalletClient, encodeFunctionData, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";

// Safe 1.4.1 canonical deployments. Verified present on Robinhood Chain 4663
// and 46630 before this script was written; `deploy` re-checks at runtime
// because a chain that lacks them fails in a confusing way otherwise.
const PROXY_FACTORY = "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67";
const SAFE_L2_SINGLETON = "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762";
const FALLBACK_HANDLER = "0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99";

const FACTORY_ABI = parseAbi([
  "function createProxyWithNonce(address singleton, bytes initializer, uint256 saltNonce) returns (address proxy)",
]);

const SAFE_ABI = parseAbi([
  "function setup(address[] owners, uint256 threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)",
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) returns (bool)",
  "function getThreshold() view returns (uint256)",
  "function getOwners() view returns (address[])",
  "function nonce() view returns (uint256)",
  "function isOwner(address owner) view returns (bool)",
]);

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1 || i === process.argv.length - 1) {
    if (fallback === undefined) throw new Error(`Missing --${name}`);
    return fallback;
  }
  return process.argv[i + 1];
}

function requireKey() {
  const key = process.env.SAFE_OWNER_PRIVATE_KEY;
  if (!key) {
    throw new Error(
      "SAFE_OWNER_PRIVATE_KEY is not set. Export it in the shell; it is deliberately not a flag, " +
        "because a key passed on the command line is readable in the process table and lands in shell history.",
    );
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    // The shape, never the value.
    throw new Error("SAFE_OWNER_PRIVATE_KEY is not a 0x-prefixed 32-byte hex key.");
  }
  return key;
}

function clients(rpc, account) {
  const transport = http(rpc);
  return {
    pub: createPublicClient({ transport }),
    wallet: account ? createWalletClient({ account, transport }) : null,
  };
}

/**
 * Safe's pre-validated signature form: 32 bytes of the owner address, 32 zero
 * bytes, then v = 1. Valid only while msg.sender is that owner, which is why
 * this needs no off-chain signing and cannot be replayed by anybody else.
 */
function preValidatedSignature(owner) {
  return `0x${owner.slice(2).toLowerCase().padStart(64, "0")}${"0".repeat(64)}01`;
}

async function cmdDeploy() {
  const rpc = arg("rpc");
  const owners = arg("owners").split(",").map((o) => o.trim());
  const threshold = BigInt(arg("threshold", "1"));
  const account = privateKeyToAccount(requireKey());
  const { pub, wallet } = clients(rpc, account);

  if (owners.length === 0) throw new Error("At least one owner is required.");
  if (threshold < 1n || threshold > BigInt(owners.length)) {
    throw new Error(`threshold ${threshold} is not in 1..${owners.length}`);
  }
  if (new Set(owners.map((o) => o.toLowerCase())).size !== owners.length) {
    throw new Error("Duplicate owner addresses.");
  }
  // A single owner means a single point of failure for ALL governance: no
  // unpause, no attester rotation, no cohort registration, ever again.
  if (owners.length === 1) {
    throw new Error(
      "Refusing a one-owner Safe. Use two owners with threshold 1: the second costs no friction " +
        "(either owner acts alone) and is the only recovery path if the first key is lost.",
    );
  }

  for (const [name, address] of Object.entries({ PROXY_FACTORY, SAFE_L2_SINGLETON, FALLBACK_HANDLER })) {
    const code = await pub.getCode({ address });
    if (!code || code === "0x") throw new Error(`${name} (${address}) has no code on this chain.`);
  }

  const initializer = encodeFunctionData({
    abi: SAFE_ABI,
    functionName: "setup",
    args: [
      owners,
      threshold,
      "0x0000000000000000000000000000000000000000",
      "0x",
      FALLBACK_HANDLER,
      "0x0000000000000000000000000000000000000000",
      0n,
      "0x0000000000000000000000000000000000000000",
    ],
  });

  const saltNonce = BigInt(arg("salt", String(await pub.getBlockNumber())));
  const hash = await wallet.writeContract({
    address: PROXY_FACTORY,
    abi: FACTORY_ABI,
    functionName: "createProxyWithNonce",
    args: [SAFE_L2_SINGLETON, initializer, saltNonce],
    chain: null,
  });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`Safe deployment reverted: ${hash}`);

  // ProxyCreation(address indexed proxy, address singleton)
  const topic = "0x4f51faf6c4561ff95f067657e43439f0f856d97c04d9ec9070a6199ad418e235";
  const log = receipt.logs.find((l) => l.topics[0] === topic);
  if (!log) throw new Error("No ProxyCreation event; cannot determine the Safe address.");
  const safe = `0x${log.topics[1].slice(26)}`;

  console.log(`safe:      ${safe}`);
  console.log(`tx:        ${hash}`);
  await printInfo(pub, safe);
  console.log(
    "\nSet NUVEM_CORPORATE_MULTISIG to the address above, and verify it with\n" +
      `  node scripts/safe.mjs info --rpc <url> --safe ${safe}`,
  );
}

async function printInfo(pub, safe) {
  const [threshold, owners, nonce] = await Promise.all([
    pub.readContract({ address: safe, abi: SAFE_ABI, functionName: "getThreshold" }),
    pub.readContract({ address: safe, abi: SAFE_ABI, functionName: "getOwners" }),
    pub.readContract({ address: safe, abi: SAFE_ABI, functionName: "nonce" }),
  ]);
  console.log(`threshold: ${threshold} of ${owners.length}`);
  console.log(`nonce:     ${nonce}`);
  for (const owner of owners) console.log(`owner:     ${owner}`);
  if (threshold > 1n) {
    console.log(
      `\nNOTE: threshold is ${threshold}, so \`exec\` cannot act alone — it only produces one\n` +
        "approval. Collecting the rest is outside this script.",
    );
  }
}

async function cmdInfo() {
  const { pub } = clients(arg("rpc"), null);
  await printInfo(pub, arg("safe"));
}

async function cmdExec() {
  const rpc = arg("rpc");
  const safe = arg("safe");
  const to = arg("to");
  const data = arg("data");
  const value = BigInt(arg("value", "0"));
  const account = privateKeyToAccount(requireKey());
  const { pub, wallet } = clients(rpc, account);

  const [threshold, isOwner] = await Promise.all([
    pub.readContract({ address: safe, abi: SAFE_ABI, functionName: "getThreshold" }),
    pub.readContract({ address: safe, abi: SAFE_ABI, functionName: "isOwner", args: [account.address] }),
  ]);
  if (!isOwner) throw new Error(`${account.address} is not an owner of ${safe}.`);
  if (threshold !== 1n) {
    throw new Error(
      `This Safe needs ${threshold} signatures. The pre-validated path used here proves exactly one ` +
        "(the sender), so it cannot satisfy this Safe on its own.",
    );
  }

  const args = [
    to,
    value,
    data,
    0, // CALL, never DELEGATECALL: a delegatecall from the Safe can rewrite the Safe itself.
    0n,
    0n,
    0n,
    "0x0000000000000000000000000000000000000000",
    "0x0000000000000000000000000000000000000000",
    preValidatedSignature(account.address),
  ];

  // Simulate first. A reverting governance action that is only discovered after
  // it is mined is indistinguishable, in the logs, from one that was never sent.
  await pub.simulateContract({
    address: safe,
    abi: SAFE_ABI,
    functionName: "execTransaction",
    args,
    account,
  });

  const hash = await wallet.writeContract({
    address: safe,
    abi: SAFE_ABI,
    functionName: "execTransaction",
    args,
    chain: null,
  });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  console.log(`tx:     ${hash}`);
  console.log(`status: ${receipt.status}`);
  if (receipt.status !== "success") throw new Error("execTransaction reverted.");

  // ExecutionFailure(bytes32 txHash, uint256 payment) — the Safe reports an
  // inner failure by EVENT while the outer transaction still succeeds. Reading
  // only the receipt status here would report a failed governance action as done.
  // keccak256("ExecutionFailure(bytes32,uint256)")
  const failure = "0x23428b18acfb3ea64b08dc0c1d296ea9c09702c09083ca5272e64d115b687d23";
  if (receipt.logs.some((l) => l.topics[0] === failure)) {
    throw new Error("The Safe executed but the INNER call failed (ExecutionFailure).");
  }
}

const commands = { deploy: cmdDeploy, exec: cmdExec, info: cmdInfo };
const command = commands[process.argv[2]];
if (!command) {
  console.error("Usage: safe.mjs {deploy|exec|info} --rpc <url> [...]");
  process.exit(2);
}
command().catch((error) => {
  console.error(String(error.message ?? error));
  process.exit(1);
});
