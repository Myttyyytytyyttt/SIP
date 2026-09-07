// Builds, signs and submits a SettlementAttestation for a finished trading
// session, and sends the resulting contribution into the PersonalVault.
//
//   node scripts/settle.mjs <rpcUrl> --start <l2Block> --end <l2Block> [--broadcast]
//
// Reads TRADING_OWNER_PRIVATE_KEY (the account, which must be msg.sender) and
// NUVEM_ATTESTER_PRIVATE_KEY (which signs the attestation).
//
// EVERY NUMBER COMES FROM @nuvem/session-engine, which reconstructs the session
// from chain state: it discovers the movements, reconciles them against the
// balance change to the wei, classifies external flows, and refuses windows it
// cannot vouch for. This script no longer decides anything about PnL — earlier
// versions hardcoded externalDeposits/externalWithdrawals to zero and performed
// no soundness check at all, which is exactly how a hand-picked window turns
// into a settled number nobody can defend.
//
// A REFUSED window stops here. There is no override flag, deliberately.

import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "node:fs";
import { buildSessionReport } from "@nuvem/session-engine";

const OUT = "../../contracts/out";
const abiOf = (f, n) => JSON.parse(readFileSync(new URL(`${OUT}/${f}/${n}.json`, import.meta.url), "utf8")).abi;

const args = process.argv.slice(2);
const rpcUrl = args.find((a) => a.startsWith("http"));
const broadcast = args.includes("--broadcast");
const startBlock = BigInt(args[args.indexOf("--start") + 1]);
const endBlock = BigInt(args[args.indexOf("--end") + 1]);
const replayFromIdx = args.indexOf("--replay-from");
const replayStartBlockL2 = replayFromIdx >= 0 ? BigInt(args[replayFromIdx + 1]) : startBlock;

// SUPERSEDED BY THE REDEPLOY, AND NOT YET REPLACED.
//
// VaultFactory.configureProtocol is one-shot, so the contract changes that
// promoted startBlockL2/endBlockL2 into the attestation could not amend the live
// deployment: they require a new factory, which forces a new executor, which
// forces a new vault. The two addresses below are the OLD canary and they run the
// OLD settle() — a different selector (0xf38ac34f, now 0xc8f2629d) and a struct
// with two fewer fields.
//
// Pointing this script at them now fails LOUDLY rather than quietly: the ABI is
// read from packages/contracts/out, which describes the new shape, so
// previewContribution/deriveSessionId are called with argument lists the old code
// does not have and the calls revert. That is the right failure. Replace both
// addresses after the deployment is authorised and made.
const VAULT = "0xF7309dC8e1914A5c3848250cec54Ebe7A20D8255";
const EXECUTOR = "0xCe676c73bd9fb76a73058EC135106b81A5ABd0f5";
const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const PAUSE = "0x2dbbc211dbfe0f15e88e5388c96530f2721baefc";
const ATTESTER_REG = "0x2a3309931a6db1e1b253224551912566d647f921";

if (!rpcUrl || !process.env.TRADING_OWNER_PRIVATE_KEY || !process.env.NUVEM_ATTESTER_PRIVATE_KEY) {
  console.error("Usage: node scripts/settle.mjs <rpcUrl> --start <l2Block> --end <l2Block> [--broadcast]");
  process.exit(1);
}

const account = privateKeyToAccount(process.env.TRADING_OWNER_PRIVATE_KEY);
const attester = privateKeyToAccount(process.env.NUVEM_ATTESTER_PRIVATE_KEY);
const pc = createPublicClient({ transport: http(rpcUrl) });
const chainId = await pc.getChainId();
const chain = { id: chainId, name: `chain-${chainId}`, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } };
const wc = createWalletClient({ account, chain, transport: http(rpcUrl) });

const vaultAbi = abiOf("PersonalVault.sol", "PersonalVault");
const execAbi = abiOf("SettlementExecutor.sol", "SettlementExecutor");

// ---------------------------------------------------------------------------
// Reconstruct the session. This is the only source of PnL in this script.
// ---------------------------------------------------------------------------
const session = await buildSessionReport({
  rpc: { call: (method, params = []) => pc.request({ method, params }) },
  wallet: account.address,
  startBlockL2: startBlock,
  endBlockL2: endBlock,
  replayStartBlockL2,
});

const asJson = (value) => JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);
console.log(
  asJson({
    verdict: session.verdict,
    reasons: session.reasons,
    window: { l2: [session.startBlockL2, session.endBlockL2], l1: [session.startBlockL1, session.endBlockL1] },
    cashStart: session.cashStart,
    cashEnd: session.cashEnd,
    externalDeposits: session.externalDeposits,
    externalWithdrawals: session.externalWithdrawals,
    realizedProfit: session.realizedProfit,
    naiveDelta: session.naiveDelta,
    residualWei: session.reconciliation.residualWei,
    zeroBasisRealized: session.zeroBasisRealized,
    positionsRoot: session.positionsRoot,
    ledgerRootV2: session.ledgerRootV2,
    transactions: session.transactions.map((tx) => `${tx.kind} ${tx.hash.slice(0, 12)}…`),
  }),
);

if (session.verdict !== "ATTESTABLE") {
  console.error(`\nRefusing to attest: ${session.reasons.join(", ")}.`);
  console.error("Pick a window the engine can vouch for; do not work around this.");
  process.exit(1);
}

// The v2 encoding commits the position state, the zero-basis figure, the verdict
// and the replay coverage. SettlementExecutor treats ledgerRoot as opaque, so
// this ships without any contract change — it makes the attester's soundness
// claim auditable, it does not make it enforced.
const ledgerRoot = session.ledgerRootV2;

// ---------------------------------------------------------------------------
// Bind to current onchain state. Anything that changes after this invalidates
// the signature, which is the intended behaviour.
// ---------------------------------------------------------------------------
const [ta, adminEpoch, localPauseEpoch, globalPauseEpoch, attesterEpoch, policyHash] = await Promise.all([
  pc.readContract({ address: VAULT, abi: vaultAbi, functionName: "getTradingAccount", args: [account.address] }),
  pc.readContract({ address: VAULT, abi: vaultAbi, functionName: "adminEpoch" }),
  pc.readContract({ address: VAULT, abi: vaultAbi, functionName: "localPauseEpoch" }),
  pc.readContract({ address: PAUSE, abi: [{ type: "function", name: "pauseEpoch", stateMutability: "view", inputs: [], outputs: [{ type: "uint64" }] }], functionName: "pauseEpoch" }),
  pc.readContract({ address: ATTESTER_REG, abi: [{ type: "function", name: "attesterEpoch", stateMutability: "view", inputs: [], outputs: [{ type: "uint32" }] }], functionName: "attesterEpoch" }),
  pc.readContract({ address: VAULT, abi: vaultAbi, functionName: "policyHash", args: [account.address] }),
]);

// BOTH RANGES ARE ATTESTED, and they do different jobs.
//
//   L1 (startBlock/endBlock)         what the contract compares against
//                                    block.number — freshness and the activation
//                                    floor. On Arbitrum Nitro, Solidity's
//                                    block.number IS the L1 number.
//   L2 (startBlockL2/endBlockL2)     what the vault progresses on. A trading
//                                    session is an event in L2 time, and ~120 L2
//                                    blocks fit inside one L1 block, so a trader
//                                    who re-enters within ~12s of closing has a
//                                    session whose L1 start equals the previous
//                                    L1 end. Progressing on L1 refused that
//                                    permanently.
//
// Both are folded into deriveSessionId (9 args now, was 7), which is what keeps
// the replay key distinct when two sessions genuinely share one L1 range —
// without it, usedSessions refuses the second and the bug returns one layer down.
const sessionId = await pc.readContract({
  address: EXECUTOR, abi: execAbi, functionName: "deriveSessionId",
  args: [
    BigInt(chainId), VAULT, account.address, ta.bindingEpoch,
    session.startBlockL1, session.endBlockL1,
    session.startBlockL2, session.endBlockL2,
    ledgerRoot,
  ],
});

const now = Math.floor(Date.now() / 1000);
const base = {
  account: account.address, vault: VAULT, executor: EXECUTOR, chainId: BigInt(chainId),
  bindingEpoch: ta.bindingEpoch, policyNonce: ta.policyNonce, adminEpoch, localPauseEpoch,
  globalPauseEpoch, settlementNonce: ta.settlementNonce, policyHash, sessionId, ledgerRoot,
  startBlock: session.startBlockL1, endBlock: session.endBlockL1,
  startBlockL2: session.startBlockL2, endBlockL2: session.endBlockL2,
  cashStart: session.cashStart, cashEnd: session.cashEnd,
  externalDeposits: session.externalDeposits, externalWithdrawals: session.externalWithdrawals,
  realizedProfit: session.realizedProfit,
  contribution: 0n, attesterEpoch, validAfter: now - 60, deadline: now + 600,
};

// Ask the executor what it will accept rather than reimplementing its five clamps.
let contribution = 0n;
try {
  contribution = await pc.readContract({ address: EXECUTOR, abi: execAbi, functionName: "previewContribution", args: [base] });
} catch (error) {
  console.error("previewContribution reverted:", (error.shortMessage ?? error.message).slice(0, 200));
}
console.log(`\ncontribution: ${Number(contribution) / 1e18} ETH (min ${ta.policy.minContributionWei})`);

if (session.realizedProfit <= 0n) {
  console.log("\nNon-positive realized profit: the executor returns 0 and settle() reverts");
  console.log("ContributionBelowMinimum. That is correct behaviour, not a failure.");
  process.exit(0);
}
if (contribution < ta.policy.minContributionWei) {
  console.log(`\nContribution is below minContributionWei; settle() would revert.`);
  process.exit(0);
}

const attestation = { ...base, contribution };

// The EIP-712 type list, DERIVED FROM THE COMPILED ABI rather than transcribed.
//
// This used to be a hand-written copy of the struct, and a hand-written copy of a
// struct is a copy that drifts. EIP-712 hashes the type string, so one missing or
// reordered field produces a signature the contract rejects as
// InvalidAttesterSignature — a message that points at the key, not at the schema.
// It is not a hypothetical: startBlockL2/endBlockL2 were inserted after endBlock
// in the middle of this list, which is exactly the edit a transcription loses.
//
// The ABI is already loaded a few lines above and is generated by `forge build`,
// so it cannot disagree with the deployed contract. The digest cross-check below
// remains as the second line of defence.
const attestationParam = execAbi.find((e) => e.type === "function" && e.name === "settle").inputs[0];
const types = {
  SettlementAttestation: attestationParam.components.map(({ name, type }) => ({ name, type })),
};
console.log(`EIP-712 fields: ${types.SettlementAttestation.map((f) => f.name).join(", ")}`);
const domain = { name: "Nuvem Settlement Executor", version: "1", chainId, verifyingContract: EXECUTOR };
const signature = await attester.signTypedData({ domain, types, primaryType: "SettlementAttestation", message: attestation });

// Cross-check the local digest against the contract's before spending gas.
const onchainDigest = await pc.readContract({ address: EXECUTOR, abi: execAbi, functionName: "hashAttestation", args: [attestation] });
console.log(`attester      : ${attester.address}`);
console.log(`onchain digest: ${onchainDigest}`);
console.log(`ledgerRoot v2 : ${ledgerRoot}`);

if (!broadcast) {
  console.log("\nDry run only. Re-run with --broadcast to settle.");
  process.exit(0);
}

const { request } = await pc.simulateContract({
  address: EXECUTOR, abi: execAbi, functionName: "settle",
  args: [attestation, signature], value: contribution, account,
});
const hash = await wc.writeContract(request);
console.log(`\nsettle txHash: ${hash}`);
const receipt = await pc.waitForTransactionReceipt({ hash });
console.log(`status: ${receipt.status}  gasUsed: ${receipt.gasUsed}`);

const erc20 = [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }];
const vaultWeth = await pc.readContract({ address: WETH, abi: erc20, functionName: "balanceOf", args: [VAULT] });
console.log(`\nvault WETH balance: ${Number(vaultWeth) / 1e18} WETH`);
