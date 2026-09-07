// Creates a PersonalVault through a deployed VaultFactory, and optionally
// invites a trading account to it.
//
//   node scripts/create-vault.mjs <rpcUrl> [--broadcast] [--invite <address>]
//
// Reads NUVEM_VAULT_ADMIN_PRIVATE_KEY. Dry-run by default: it predicts the
// CREATE2 address and prints the policy without sending anything.
//
// The policy deliberately sets investmentEnabled = false. AdapterRegistry is
// owned by the 7-day TimelockController, so no adapter can be registered yet
// and invest() would revert; disabling it makes that a stated configuration
// rather than a surprise. maxAggregateRolling30dWei must still be non-zero —
// PersonalVault._validateVaultPolicy requires it unconditionally.

import { createPublicClient, createWalletClient, http, encodeAbiParameters, parseEther, keccak256, toHex, zeroAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "node:fs";

// Relative to this file in packages/aa-smoke-old/scripts/, so two levels up.
const OUT = "../../contracts/out";
const abiOf = (file, name) =>
  JSON.parse(readFileSync(new URL(`${OUT}/${file}/${name}.json`, import.meta.url), "utf8")).abi;

const args = process.argv.slice(2);
const rpcUrl = args.find((a) => !a.startsWith("--") && a.startsWith("http"));
const broadcast = args.includes("--broadcast");
const inviteIdx = args.indexOf("--invite");
const inviteAccount = inviteIdx >= 0 ? args[inviteIdx + 1] : null;

const FACTORY = "0xDf411fdCc7C31e4F6bCa6F6BCaB40FE812Ab4A46";
const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const PAUSE = "0x2dbbc211dbfe0f15e88e5388c96530f2721baefc";
const ATTESTER_REG = "0x2a3309931a6db1e1b253224551912566d647f921";
const ADAPTER_REG = "0x11b83d80e88e77fa1157d06115d5c7fec2d78e1a";
const FEE_CTRL = "0x866573527217e541fa2b23416c1c77d90fd101e9";
const EXECUTOR = "0xCe676c73bd9fb76a73058EC135106b81A5ABd0f5";
const COHORT = 1;

if (!rpcUrl || !process.env.NUVEM_VAULT_ADMIN_PRIVATE_KEY) {
  console.error("Usage: node scripts/create-vault.mjs <rpcUrl> [--broadcast] [--invite <address>]");
  process.exit(1);
}

const admin = privateKeyToAccount(process.env.NUVEM_VAULT_ADMIN_PRIVATE_KEY);
const publicClient = createPublicClient({ transport: http(rpcUrl) });
const chainId = await publicClient.getChainId();
const chain = { id: chainId, name: `chain-${chainId}`, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } };
const walletClient = createWalletClient({ account: admin, chain, transport: http(rpcUrl) });
const factoryAbi = abiOf("VaultFactory.sol", "VaultFactory");
const vaultAbi = abiOf("PersonalVault.sol", "PersonalVault");

const policy = {
  targetAsset: zeroAddress,
  adapterId: "0x0000000000000000000000000000000000000000000000000000000000000000",
  minInvestmentWei: 0n,
  maxInvestmentPerCallWei: 0n,
  maxAggregateRolling30dWei: parseEther("1"),
  minOutputRateWad: 0n,
  investmentEnabled: false,
};

const POLICY_T = {
  type: "tuple",
  components: [
    { name: "targetAsset", type: "address" },
    { name: "adapterId", type: "bytes32" },
    { name: "minInvestmentWei", type: "uint128" },
    { name: "maxInvestmentPerCallWei", type: "uint128" },
    { name: "maxAggregateRolling30dWei", type: "uint128" },
    { name: "minOutputRateWad", type: "uint128" },
    { name: "investmentEnabled", type: "bool" },
  ],
};
const INIT_T = {
  type: "tuple",
  components: [
    { name: "weth", type: "address" },
    { name: "pauseController", type: "address" },
    { name: "attesterRegistry", type: "address" },
    { name: "adapterRegistry", type: "address" },
    { name: "feeController", type: "address" },
    { name: "settlementExecutor", type: "address" },
    { name: "policy", ...POLICY_T },
  ],
};

const initData = encodeAbiParameters(
  [INIT_T],
  [{ weth: WETH, pauseController: PAUSE, attesterRegistry: ATTESTER_REG, adapterRegistry: ADAPTER_REG, feeController: FEE_CTRL, settlementExecutor: EXECUTOR, policy }],
);
const userSalt = keccak256(toHex("NUVEM_MAINNET_CANARY_VAULT_1"));

const [vaultId, predicted] = await publicClient.readContract({
  address: FACTORY, abi: factoryAbi, functionName: "predictVault",
  args: [admin.address, userSalt, COHORT, initData],
});

console.log(JSON.stringify({
  mode: broadcast ? "broadcast" : "dry-run",
  chainId,
  vaultAdmin: admin.address,
  adminBalanceWei: (await publicClient.getBalance({ address: admin.address })).toString(),
  cohortId: COHORT,
  vaultId,
  predictedVault: predicted,
  investmentEnabled: policy.investmentEnabled,
  invite: inviteAccount ?? "(none)",
}, null, 2));

if (!broadcast) {
  console.log("\nDry run only. Re-run with --broadcast.");
  process.exit(0);
}

const { request } = await publicClient.simulateContract({
  address: FACTORY, abi: factoryAbi, functionName: "createVault",
  args: [userSalt, COHORT, initData], account: admin,
});
const hash = await walletClient.writeContract(request);
console.log(`\ncreateVault txHash: ${hash}`);
const receipt = await publicClient.waitForTransactionReceipt({ hash });
console.log(`status: ${receipt.status}  gasUsed: ${receipt.gasUsed}`);

const deployed = await publicClient.readContract({ address: FACTORY, abi: factoryAbi, functionName: "vaultById", args: [vaultId] });
console.log(`vault: ${deployed}  matchesPrediction: ${deployed.toLowerCase() === predicted.toLowerCase()}`);

if (inviteAccount) {
  // Per-account savings policy. 20% of realized profit, with a floor and gas
  // reserve the trading wallet must retain after settling.
  const tradingPolicy = {
    savingsBps: 2000,
    minContributionWei: 1000000000000n,      // 0.000001 ETH
    maxPerSettlementWei: parseEther("0.001"),
    maxRolling30dWei: parseEther("0.01"),
    tradingFloorWei: 100000000000000n,       // 0.0001 ETH
    gasReserveWei: 100000000000000n,         // 0.0001 ETH
  };
  const deadline = Math.floor(Date.now() / 1000) + 7 * 24 * 3600;
  const { request: inviteReq } = await publicClient.simulateContract({
    address: deployed, abi: vaultAbi, functionName: "inviteTradingAccount",
    args: [inviteAccount, keccak256(toHex("GMGN")), tradingPolicy, deadline],
    account: admin,
  });
  const ih = await walletClient.writeContract(inviteReq);
  console.log(`\ninviteTradingAccount txHash: ${ih}`);
  const ir = await publicClient.waitForTransactionReceipt({ hash: ih });
  console.log(`status: ${ir.status}  gasUsed: ${ir.gasUsed}`);
  console.log(`invited ${inviteAccount}, savingsBps 2000, deadline ${deadline}`);
  console.log("\nThe trading account must now call acceptTradingAccount() itself.");
}
