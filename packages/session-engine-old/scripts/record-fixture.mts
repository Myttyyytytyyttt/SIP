// Records every RPC response the test suite needs, once, into a committed JSON
// fixture. Run by hand; never in CI.
//
//   MAINNET_RPC=... npx tsx scripts/record-fixture.mts
//
// The windows below are chosen to cover every classification the engine must get
// right, all drawn from real history on this wallet:
//   the WAN round trip, the airdrops, the settlement outflow, the WETH unwrap,
//   the vault-admin funding, and the inbound deposit.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSessionReport } from "../src/session.js";
import { httpRpcClient, recordingRpcClient } from "../src/rpc.js";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(here, "../test/fixtures/mainnet-4663.json");
const WALLET = "0xc455bf7f16ebbc2b07cb26d1dd46194977974e7d";

const url = process.env.MAINNET_RPC;
if (!url) {
  console.error("MAINNET_RPC is required.");
  process.exit(1);
}

export const WINDOWS: { name: string; start: bigint; end: bigint }[] = [
  { name: "wan-round-trip", start: 22080592n, end: 22080850n },
  { name: "settlement-outflow", start: 22086130n, end: 22086150n },
  { name: "airdrop", start: 21799700n, end: 21799720n },
  { name: "weth-unwrap", start: 21774620n, end: 21774630n },
  { name: "vault-admin-funding", start: 21844340n, end: 21844345n },
  { name: "external-deposit", start: 22078500n, end: 22078510n },
  { name: "thehood-round-trip-1", start: 21787560n, end: 21787640n },
];

const recorder = recordingRpcClient(httpRpcClient(url));

for (const window of WINDOWS) {
  process.stdout.write(`recording ${window.name} (${window.start} -> ${window.end}) ... `);
  const report = await buildSessionReport({
    rpc: recorder,
    wallet: WALLET,
    startBlockL2: window.start,
    endBlockL2: window.end,
    replayStartBlockL2: window.start,
  });
  console.log(`${report.verdict} [${report.reasons.join(",") || "-"}]`);
}

// Block responses dominate the fixture, and nearly all of that weight is other
// people's transactions. The block scan's contract is "find transactions
// involving this wallet", so dropping the rest is faithful to what the query
// asks for — but it IS a reduction, so it happens here, visibly, rather than
// silently inside the recorder.
let dropped = 0;
let kept = 0;
for (const [key, value] of Object.entries(recorder.recording)) {
  if (!key.startsWith("eth_getBlockByNumber|")) continue;
  const block = value as { transactions?: unknown[] } | null;
  if (!Array.isArray(block?.transactions)) continue;
  const before = block.transactions.length;
  block.transactions = block.transactions.filter((entry) => {
    const tx = entry as { from?: string; to?: string | null };
    return tx.from?.toLowerCase() === WALLET || tx.to?.toLowerCase() === WALLET;
  });
  kept += block.transactions.length;
  dropped += before - block.transactions.length;
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(recorder.recording, null, 0)}\n`);
const entries = Object.keys(recorder.recording).length;
console.log(`\nwrote ${entries} recorded calls to ${OUT}`);
console.log(`pruned ${dropped} unrelated transactions from recorded blocks; kept ${kept}`);
