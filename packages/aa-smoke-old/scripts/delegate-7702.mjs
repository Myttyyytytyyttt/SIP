// Delegates an EOA to a smart-account implementation with a plain EIP-7702
// type-4 transaction, bypassing ERC-4337 entirely.
//
// This exists because the GMGN compatibility question only asks: "does the
// venue still work once eth_getCode(wallet) stops being empty?" That state is
// produced by the delegation itself, not by the bundler, not by the session
// key (which is storage, not code). So a direct type-4 transaction reaches the
// exact state we need to test, and is immune to bundler/SDK defects.
//
//   node scripts/delegate-7702.mjs <rpcUrl> [--broadcast] [--revoke]
//
// Reads TRADING_OWNER_PRIVATE_KEY from the environment. Dry-run by default:
// it prints the plan and the signed authority without sending anything.
// Pass --broadcast to actually send. Pass --revoke to delegate to the zero
// address, which clears the delegation and returns the account to a plain EOA.

import { createWalletClient, createPublicClient, http, zeroAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { recoverAuthorizationAddress } from "viem/utils";

// Alchemy Modular Account v2, 7702 implementation.
const MODULAR_ACCOUNT_V2_IMPL = "0x69007702764179f14F51cdce752f4f775d74E139";

const args = process.argv.slice(2);
const rpcUrl = args.find((a) => !a.startsWith("--"));
const broadcast = args.includes("--broadcast");
const revoke = args.includes("--revoke");

if (!rpcUrl || !process.env.TRADING_OWNER_PRIVATE_KEY) {
  console.error(
    "Usage: node scripts/delegate-7702.mjs <rpcUrl> [--broadcast] [--revoke]\n" +
      "Requires TRADING_OWNER_PRIVATE_KEY in the environment (use --env-file).",
  );
  process.exit(1);
}

const target = revoke ? zeroAddress : MODULAR_ACCOUNT_V2_IMPL;
const owner = privateKeyToAccount(process.env.TRADING_OWNER_PRIVATE_KEY);
const publicClient = createPublicClient({ transport: http(rpcUrl) });
const chainId = await publicClient.getChainId();
const chain = { id: chainId, name: `chain-${chainId}`, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } };
const walletClient = createWalletClient({ account: owner, chain, transport: http(rpcUrl) });

const nonce = await publicClient.getTransactionCount({ address: owner.address });
const balance = await publicClient.getBalance({ address: owner.address });
const codeBefore = await publicClient.getCode({ address: owner.address });

// The account sponsors its own delegation, so the transaction consumes `nonce`
// and the authorization takes effect at `nonce + 1`.
const authorization = await owner.signAuthorization({
  address: target,
  chainId,
  nonce: nonce + 1,
});
const recovered = await recoverAuthorizationAddress({ authorization });

console.log(
  JSON.stringify(
    {
      mode: broadcast ? "broadcast" : "dry-run",
      intent: revoke ? "revoke delegation" : "delegate",
      chainId,
      account: owner.address,
      balanceWei: balance.toString(),
      accountNonce: nonce,
      authorizationNonce: nonce + 1,
      delegateTo: target,
      codeBefore: codeBefore ?? "0x",
      authoritySignedBy: recovered,
      authorityMatchesAccount: recovered.toLowerCase() === owner.address.toLowerCase(),
    },
    null,
    2,
  ),
);

if (recovered.toLowerCase() !== owner.address.toLowerCase()) {
  console.error("\nAuthorization does not recover to the account. Refusing to broadcast.");
  process.exit(1);
}

// Delegating to an address with no code points the account at nothing: every
// call into it would execute empty code and silently succeed. Recoverable with
// --revoke, but it would invalidate a canary run and confuse a venue. The
// implementation address is not guaranteed to be identical across chains, so
// this must be checked on whichever chain is being targeted.
if (!revoke) {
  const implCode = await publicClient.getCode({ address: target });
  if (!implCode || implCode === "0x") {
    console.error(
      `\nRefusing to broadcast: ${target} has no code on chain ${chainId}.\n` +
        "Confirm the Modular Account v2 implementation address for this chain first.",
    );
    process.exit(1);
  }
  console.log(`\nimplementation code size on chain ${chainId}: ${(implCode.length - 2) / 2} bytes`);
}

if (!broadcast) {
  console.log("\nDry run only. Re-run with --broadcast to send the type-4 transaction.");
  process.exit(0);
}

// A type-4 transaction still needs a `to`; sending to self with no calldata is
// the cheapest carrier for the authorization list.
//
// The gas limit is set explicitly because eth_estimateGas does not account for
// the authorization list: a type-4 transaction costs 21000 base plus 25000 per
// authorization (PER_EMPTY_ACCOUNT_COST), so estimation comes back below the
// intrinsic floor and the node rejects it with "intrinsic gas too low".
// Unused gas is refunded, so the margin is free.
const hash = await walletClient.sendTransaction({
  authorizationList: [authorization],
  to: owner.address,
  value: 0n,
  data: "0x",
  gas: 150_000n,
});
console.log(`\ntxHash: ${hash}`);

const receipt = await publicClient.waitForTransactionReceipt({ hash });
const codeAfter = await publicClient.getCode({ address: owner.address });
const normalized = (codeAfter ?? "0x").toLowerCase();

console.log(
  JSON.stringify(
    {
      status: receipt.status,
      gasUsed: receipt.gasUsed.toString(),
      codeAfter: normalized,
      delegatedTo:
        normalized.startsWith("0xef0100") && normalized.length === 48
          ? `0x${normalized.slice(8)}`
          : null,
    },
    null,
    2,
  ),
);
