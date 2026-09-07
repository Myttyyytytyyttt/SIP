#!/usr/bin/env node
// Watch the timelock and shout when something is queued against it.
//
// The guardian holds CANCELLER_ROLE so a queued malicious upgrade can be stopped
// inside the delay. That defence is worth exactly nothing if nobody notices the
// queue. `CallScheduled` is emitted the moment an operation is proposed and
// carries the full delay as `delay`; from that instant there is a known,
// finite window and a known action. This turns the window into an alert.
//
// It is deliberately dumb and dependency-free: no database, no state, no
// notification service. It prints, and it exits non-zero the moment anything is
// pending, so a supervisor, a cron, or a human watching a terminal all work.
//
//   node scripts/watch-governance.mjs --rpc <url> --timelock <addr> [--beacon <addr>]
//   node scripts/watch-governance.mjs --rpc <url> --timelock <addr> --once
//
// --once checks the current pending set and exits: that is the cron shape.
// Without it the script polls and keeps printing new events as they land.

import { createPublicClient, http, parseAbi } from "viem";

const TIMELOCK_ABI = parseAbi([
  "event CallScheduled(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data, bytes32 predecessor, uint256 delay)",
  "event CallExecuted(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data)",
  "event Cancelled(bytes32 indexed id)",
  "function isOperationPending(bytes32 id) view returns (bool)",
  "function isOperationReady(bytes32 id) view returns (bool)",
  "function getTimestamp(bytes32 id) view returns (uint256)",
  "function getMinDelay() view returns (uint256)",
]);

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1 || i === process.argv.length - 1) {
    if (fallback === undefined) throw new Error(`Missing --${name}`);
    return fallback;
  }
  return process.argv[i + 1];
}
const flag = (name) => process.argv.includes(`--${name}`);

const rpc = arg("rpc");
const timelock = arg("timelock");
const beacon = arg("beacon", "").toLowerCase();
const lookback = BigInt(arg("lookback", "50000"));
const pollMs = Number(arg("poll", "30000"));

const client = createPublicClient({ transport: http(rpc) });

/**
 * The only classification that matters operationally: does this operation
 * change the CODE that holds user savings, or does it not? Everything else the
 * timelock governs is, at worst, denial of service.
 */
function classify(target) {
  if (beacon && target.toLowerCase() === beacon) {
    return { level: "CRITICAL", why: "beacon upgrade — this replaces the code holding every user's savings" };
  }
  return { level: "REVIEW", why: "timelocked governance action" };
}

function describe(log, now, minDelay) {
  const { id, target, value, data, delay } = log.args;
  const { level, why } = classify(target);
  return [
    `[${level}] operation ${id}`,
    `  target   ${target}`,
    `  value    ${value} wei`,
    `  selector ${String(data).slice(0, 10)}`,
    `  delay    ${delay}s${delay < minDelay ? "  <-- BELOW THE MINIMUM DELAY" : ""}`,
    `  why      ${why}`,
    `  block    ${log.blockNumber}  tx ${log.transactionHash}`,
  ].join("\n");
}

async function scan(fromBlock, minDelay) {
  const head = await client.getBlockNumber();
  const scheduled = await client.getLogs({
    address: timelock,
    event: TIMELOCK_ABI.find((e) => e.type === "event" && e.name === "CallScheduled"),
    fromBlock,
    toBlock: head,
  });

  const pending = [];
  for (const log of scheduled) {
    const isPending = await client.readContract({
      address: timelock,
      abi: TIMELOCK_ABI,
      functionName: "isOperationPending",
      args: [log.args.id],
    });
    if (isPending) pending.push(log);
  }
  return { head, scheduled, pending };
}

async function main() {
  const minDelay = await client.readContract({
    address: timelock,
    abi: TIMELOCK_ABI,
    functionName: "getMinDelay",
  });
  const head = await client.getBlockNumber();
  const from = head > lookback ? head - lookback : 0n;

  console.log(`timelock  ${timelock}`);
  console.log(`minDelay  ${minDelay}s (${Number(minDelay) / 86400} days)`);
  if (beacon) console.log(`beacon    ${beacon}  (upgrades to this are CRITICAL)`);
  else console.log("beacon    not supplied — pass --beacon to classify upgrades as CRITICAL");
  console.log(`scanning  blocks ${from}..${head}\n`);

  const { pending } = await scan(from, minDelay);

  if (pending.length === 0) {
    console.log("nothing pending.");
  } else {
    for (const log of pending) {
      const readyAt = await client.readContract({
        address: timelock,
        abi: TIMELOCK_ABI,
        functionName: "getTimestamp",
        args: [log.args.id],
      });
      const now = BigInt(Math.floor(Date.now() / 1000));
      const remaining = readyAt > now ? readyAt - now : 0n;
      console.log(describe(log, now, minDelay));
      console.log(
        remaining > 0n
          ? `  ACT WITHIN ${remaining}s (~${(Number(remaining) / 3600).toFixed(1)}h) — the guardian can still cancel\n`
          : "  READY TO EXECUTE NOW — the window has already closed\n",
      );
    }
    console.log(
      `${pending.length} operation(s) pending. To stop one:\n` +
        `  cast send ${timelock} 'cancel(bytes32)' <id> --private-key $GUARDIAN_PRIVATE_KEY --rpc-url ${rpc}\n`,
    );
  }

  if (flag("once")) process.exit(pending.length === 0 ? 0 : 1);

  let cursor = head + 1n;
  for (;;) {
    await new Promise((r) => setTimeout(r, pollMs));
    let latest;
    try {
      latest = await client.getBlockNumber();
    } catch (error) {
      // A transient RPC failure must not end the watch; that would be a silent
      // stop, which is the one failure mode this script exists to prevent.
      console.error(`rpc error, retrying: ${error.message ?? error}`);
      continue;
    }
    if (latest < cursor) continue;
    const { scheduled } = await scan(cursor, minDelay);
    for (const log of scheduled) {
      console.log(describe(log, BigInt(Math.floor(Date.now() / 1000)), minDelay));
      console.log("");
    }
    cursor = latest + 1n;
  }
}

main().catch((error) => {
  console.error(String(error.message ?? error));
  process.exit(2);
});
