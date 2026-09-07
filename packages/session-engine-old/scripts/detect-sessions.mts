// Walks a wallet's history, finds session boundaries, and asks the verifier
// whether each one can actually be attested.
//
//   MAINNET_RPC=... npx tsx scripts/detect-sessions.mts --from <l2> --to <l2> [--wallet 0x..] [--verify]
//
// Detection and verification are deliberately separate. The detector proposes a
// boundary from position flatness; buildSessionReport re-derives everything from
// chain state and is the only thing allowed to say ATTESTABLE. A session the
// detector closed on dust will be refused here, visibly, rather than settled.

import { classifyWindow } from "../src/classify.js";
import { detectSessions, openSessionStatus } from "../src/detector.js";
import { httpRpcClient } from "../src/rpc.js";
import { buildSessionReport } from "../src/session.js";
import { scanWindow } from "../src/window.js";

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const url = process.env.MAINNET_RPC;
const from = flag("from");
const to = flag("to");
if (!url || !from || !to) {
  console.error("Usage: MAINNET_RPC=... npx tsx scripts/detect-sessions.mts --from <l2> --to <l2> [--wallet 0x..] [--verify]");
  process.exit(2);
}

const wallet = flag("wallet") ?? "0xc455bf7f16ebbc2b07cb26d1dd46194977974e7d";
const rpc = httpRpcClient(url);
const fromBlock = BigInt(from);
const toBlock = BigInt(to);

const scan = await scanWindow(rpc, wallet, fromBlock, toBlock);
const classified = classifyWindow(scan.txs, wallet);
const sessions = detectSessions(classified);
const open = openSessionStatus(classified);

const big = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);

console.log(`scanned ${classified.length} transactions in (${fromBlock}, ${toBlock}]`);
console.log(`detected ${sessions.length} closed session(s)\n`);

for (const [index, session] of sessions.entries()) {
  console.log(`── session ${index + 1} ──`);
  console.log(
    JSON.stringify(
      {
        window: `(${session.startBlockL2}, ${session.endBlockL2}]`,
        spanBlocks: session.spanBlocks,
        tokens: session.tokens.length,
        buys: session.buys,
        sells: session.sells,
        peakConcurrentPositions: session.peakConcurrentPositions,
        dust: session.dust,
        airdropsInside: session.airdropsInside,
      },
      big,
      2,
    ),
  );

  if (argv.includes("--verify")) {
    const report = await buildSessionReport({
      rpc,
      wallet,
      startBlockL2: session.startBlockL2,
      endBlockL2: session.endBlockL2,
      replayStartBlockL2: session.startBlockL2,
    });
    console.log(
      `  verdict ${report.verdict}${report.reasons.length ? ` [${report.reasons.join(", ")}]` : ""}` +
        `  realizedProfit ${report.realizedProfit}  residual ${report.reconciliation.residualWei}`,
    );
  }
  console.log();
}

// The standby state the whole design exists to express: something was bought
// and not yet fully sold, so no boundary exists and nothing may settle.
console.log("── current state ──");
console.log(JSON.stringify(open, big, 2));
