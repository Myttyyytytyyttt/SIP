// Deploys a Safe with a fixed owner set and threshold, for use as
// NUVEM_CORPORATE_MULTISIG.
//
//   node scripts/deploy-safe.mjs <rpcUrl> [--broadcast]
//
// Reads DEPLOYER_PRIVATE_KEY and SAFE_OWNER_1..5_PRIVATE_KEY from the
// environment. Dry-run by default: it prints the owner set, the predicted
// address and the exact initializer, and sends nothing.
//
// DeployNuvem checks only getThreshold() == 3 and getOwners().length == 5
// (script/DeployNuvem.s.sol:235-254). It authenticates neither the bytecode nor
// the owners, so a stub would pass — and would permanently freeze every
// timelock-governed surface, because the TimelockController is constructed with
// admin == address(0) and a single immutable proposer. This script therefore
// deploys a genuine Safe from the canonical 1.4.1 factory.

import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  zeroAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

// Canonical Safe 1.4.1 deployments. Verified present on Robinhood Chain 4663.
const PROXY_FACTORY = "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67";
const SAFE_L2_SINGLETON = "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762";
const FALLBACK_HANDLER = "0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99";
const THRESHOLD = 3n;

const args = process.argv.slice(2);
const rpcUrl = args.find((a) => !a.startsWith("--"));
const broadcast = args.includes("--broadcast");

if (!rpcUrl || !process.env.DEPLOYER_PRIVATE_KEY) {
  console.error(
    "Usage: node scripts/deploy-safe.mjs <rpcUrl> [--broadcast]\n" +
      "Requires DEPLOYER_PRIVATE_KEY and SAFE_OWNER_1..5_PRIVATE_KEY.",
  );
  process.exit(1);
}

const owners = [];
for (let i = 1; i <= 5; i++) {
  const key = process.env[`SAFE_OWNER_${i}_PRIVATE_KEY`];
  if (!key) {
    console.error(`SAFE_OWNER_${i}_PRIVATE_KEY is missing.`);
    process.exit(1);
  }
  owners.push(privateKeyToAccount(key).address);
}
if (new Set(owners.map((o) => o.toLowerCase())).size !== 5) {
  console.error("Owner addresses must be distinct — Safe rejects duplicates.");
  process.exit(1);
}

const deployer = privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY);
const publicClient = createPublicClient({ transport: http(rpcUrl) });
const chainId = await publicClient.getChainId();
const chain = {
  id: chainId,
  name: `chain-${chainId}`,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
};

for (const [label, address] of [
  ["proxy factory", PROXY_FACTORY],
  ["SafeL2 singleton", SAFE_L2_SINGLETON],
  ["fallback handler", FALLBACK_HANDLER],
]) {
  const code = await publicClient.getCode({ address });
  if (!code || code === "0x") {
    console.error(`Refusing to proceed: no ${label} at ${address} on chain ${chainId}.`);
    process.exit(1);
  }
}

const setupAbi = [
  {
    type: "function",
    name: "setup",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_owners", type: "address[]" },
      { name: "_threshold", type: "uint256" },
      { name: "to", type: "address" },
      { name: "data", type: "bytes" },
      { name: "fallbackHandler", type: "address" },
      { name: "paymentToken", type: "address" },
      { name: "payment", type: "uint256" },
      { name: "paymentReceiver", type: "address" },
    ],
    outputs: [],
  },
];
const factoryAbi = [
  {
    type: "function",
    name: "createProxyWithNonce",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_singleton", type: "address" },
      { name: "initializer", type: "bytes" },
      { name: "saltNonce", type: "uint256" },
    ],
    outputs: [{ name: "proxy", type: "address" }],
  },
];

const initializer = encodeFunctionData({
  abi: setupAbi,
  functionName: "setup",
  args: [owners, THRESHOLD, zeroAddress, "0x", FALLBACK_HANDLER, zeroAddress, 0n, zeroAddress],
});

// Deterministic salt so a re-run does not silently create a second Safe.
const saltNonce = BigInt(chainId);

console.log(
  JSON.stringify(
    {
      mode: broadcast ? "broadcast" : "dry-run",
      chainId,
      deployer: deployer.address,
      deployerBalanceWei: (await publicClient.getBalance({ address: deployer.address })).toString(),
      singleton: SAFE_L2_SINGLETON,
      threshold: Number(THRESHOLD),
      owners,
      saltNonce: saltNonce.toString(),
    },
    null,
    2,
  ),
);

const simulated = await publicClient.simulateContract({
  address: PROXY_FACTORY,
  abi: factoryAbi,
  functionName: "createProxyWithNonce",
  args: [SAFE_L2_SINGLETON, initializer, saltNonce],
  account: deployer,
});
console.log(`\npredicted Safe address: ${simulated.result}`);

if (!broadcast) {
  console.log("\nDry run only. Re-run with --broadcast to deploy.");
  process.exit(0);
}

const walletClient = createWalletClient({ account: deployer, chain, transport: http(rpcUrl) });
const hash = await walletClient.writeContract(simulated.request);
console.log(`\ntxHash: ${hash}`);
const receipt = await publicClient.waitForTransactionReceipt({ hash });

// Re-read the shape DeployNuvem will check, from the deployed Safe itself.
const shapeAbi = [
  { type: "function", name: "getThreshold", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "getOwners", stateMutability: "view", inputs: [], outputs: [{ type: "address[]" }] },
];
const safe = simulated.result;
const [threshold, deployedOwners] = await Promise.all([
  publicClient.readContract({ address: safe, abi: shapeAbi, functionName: "getThreshold" }),
  publicClient.readContract({ address: safe, abi: shapeAbi, functionName: "getOwners" }),
]);

console.log(
  JSON.stringify(
    {
      status: receipt.status,
      gasUsed: receipt.gasUsed.toString(),
      safe,
      getThreshold: Number(threshold),
      getOwnersLength: deployedOwners.length,
      satisfiesDeployNuvem: Number(threshold) === 3 && deployedOwners.length === 5,
    },
    null,
    2,
  ),
);
