// Prints a session report as JSON. Read-only: it never signs and never sends.
//
//   MAINNET_RPC=... npx tsx scripts/session-report.mts --start <l2> --end <l2>
//                                                      [--wallet 0x..] [--replay-from <l2>]

import { buildSessionReport } from "../src/session.js";
import { httpRpcClient } from "../src/rpc.js";

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
};

const url = process.env.MAINNET_RPC;
const start = flag("start");
const end = flag("end");
if (!url || !start || !end) {
  console.error(
    "Usage: MAINNET_RPC=... npx tsx scripts/session-report.mts --start <l2Block> --end <l2Block> [--wallet 0x..] [--replay-from <l2Block>]",
  );
  process.exit(1);
}

const wallet = flag("wallet") ?? "0xc455bf7f16ebbc2b07cb26d1dd46194977974e7d";
const startBlockL2 = BigInt(start);

// Exit status must distinguish "I decided no" from "I could not decide".
//   0  ATTESTABLE
//   1  REFUSED    — a verdict, reached deliberately
//   2  ERROR      — no verdict; the engine failed and nothing may be inferred
//
// Without the split, a crash exits 1 with empty stdout and is byte-for-byte
// indistinguishable from a refusal to any caller reading the exit code. A
// pipeline would then treat "the engine broke" as "this window is unsound",
// which is the wrong lesson and hides the breakage.
const EXIT_ATTESTABLE = 0;
const EXIT_REFUSED = 1;
const EXIT_ERROR = 2;

try {
  const report = await buildSessionReport({
    rpc: httpRpcClient(url),
    wallet,
    startBlockL2,
    endBlockL2: BigInt(end),
    replayStartBlockL2: BigInt(flag("replay-from") ?? start),
  });

  // bigints are not JSON, and silently coercing them to Number would lose wei.
  console.log(
    JSON.stringify(
      report,
      (_key, value) => (typeof value === "bigint" ? value.toString() : value),
      2,
    ),
  );
  process.exitCode = report.verdict === "ATTESTABLE" ? EXIT_ATTESTABLE : EXIT_REFUSED;
} catch (error) {
  console.error(`session-report failed to reach a verdict: ${error instanceof Error ? error.message : error}`);
  console.error("This is NOT a refusal. Nothing about the window has been established.");
  process.exitCode = EXIT_ERROR;
}
