// Loaded into the ceiling bench's keeper child with `tsx --import`, before
// bin/keeper.mts, and into nothing else. See src/bench/offline.ts for why.
import { installOfflineGuard } from "../src/bench/offline.js";

const guard = installOfflineGuard();
// Reported on the way out, so a run that tried to leave the loopback says so in
// the child's own output rather than only in a latency that looks wrong.
process.on("exit", () => {
  if (guard.blocked.length > 0) process.stderr.write(`ceiling-bench: blocked ${guard.blocked.length} non-loopback request(s): ${[...new Set(guard.blocked)].join(", ")}\n`);
});
