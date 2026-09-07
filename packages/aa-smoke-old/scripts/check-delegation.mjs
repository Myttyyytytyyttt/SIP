// Reports whether an address is a plain EOA or an EIP-7702 delegated account,
// and to which implementation.
//
//   node scripts/check-delegation.mjs <rpcUrl> <address>
//
// Run it at three points in the GMGN canary and keep all three outputs:
//   1. before delegating          -> expect status "eoa"
//   2. after AA_SMOKE_ACTION=install -> expect "delegated", target = MAv2 impl
//   3. after importing into MetaMask and using GMGN
//        -> still "delegated" at the SAME target. A changed target means
//           something overwrote the delegation (MetaMask installing its own
//           smart account is the documented risk); "eoa" means it was revoked.
//
// EIP-7702 stores a 23-byte designator in the account's code slot:
//   0xef0100 || <20-byte implementation address>

const [rpcUrl, address] = process.argv.slice(2);

if (!rpcUrl || !address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
  console.error(
    "Usage: node scripts/check-delegation.mjs <rpcUrl> <address>\n" +
      "Example: node scripts/check-delegation.mjs https://rpc.testnet.chain.robinhood.com 0xabc...",
  );
  process.exit(1);
}

async function rpc(method, params) {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!response.ok) {
    throw new Error(`${method} failed: HTTP ${response.status}`);
  }
  const body = await response.json();
  if (body.error) {
    throw new Error(`${method} failed: ${body.error.message}`);
  }
  return body.result;
}

try {
  const [chainIdHex, code, balanceHex] = await Promise.all([
    rpc("eth_chainId", []),
    rpc("eth_getCode", [address, "latest"]),
    rpc("eth_getBalance", [address, "latest"]),
  ]);

  const normalized = (code ?? "0x").toLowerCase();
  const isDelegated = normalized.startsWith("0xef0100") && normalized.length === 48;

  const result = {
    chainId: Number(BigInt(chainIdHex)),
    address,
    balanceWei: BigInt(balanceHex).toString(),
    codeSize: (normalized.length - 2) / 2,
    status: isDelegated
      ? "delegated"
      : normalized === "0x"
        ? "eoa"
        : "contract-or-unexpected-code",
    delegatedTo: isDelegated ? `0x${normalized.slice(8)}` : null,
    // Only the 23-byte designator is worth showing in full; real contract code
    // is noise here.
    rawCode:
      normalized.length <= 66 ? normalized : `${normalized.slice(0, 66)}... (truncated)`,
  };

  console.log(JSON.stringify(result, null, 2));

  if (result.status === "contract-or-unexpected-code") {
    console.error(
      "\nThis is neither an empty EOA nor a 7702 designator. Do not proceed until you know what deployed here.",
    );
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`check-delegation failed: ${error.message}`);
  process.exitCode = 1;
}
