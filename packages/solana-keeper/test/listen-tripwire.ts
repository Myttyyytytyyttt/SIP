// A PRELOAD FOR A CHILD PROCESS, never imported by a test:
// test/worker-health-boot.test.ts starts bin/worker.mts, and bin/keeper.mts, as
// `node --import tsx --import test/listen-tripwire.ts bin/worker.mts`.
//
// EVERY listen() THE PROCESS CALLS IS WRITTEN DOWN BEFORE IT RUNS, synchronously,
// one JSON line per call, to the file KEEPER_TEST_LISTEN_LOG names. A process that
// listens and exits in the same tick — before a probe from outside could connect,
// before its own "listening" line could reach a pipe — still leaves its line. So
// "it never listened" is read from a file, not inferred from a probe that happened
// to miss it. Without the variable it installs nothing.

import { appendFileSync } from "node:fs";
import { Server } from "node:net";

const file = process.env["KEEPER_TEST_LISTEN_LOG"];
if (file !== undefined && file !== "") {
  const listen = Server.prototype.listen as (this: Server, ...args: unknown[]) => Server;
  // net.Server's own listen, which http.Server inherits: every server in the process goes through it.
  Server.prototype.listen = function (this: Server, ...args: unknown[]): Server {
    appendFileSync(file, `${JSON.stringify(args.filter((arg) => typeof arg !== "function"))}\n`);
    return listen.apply(this, args);
  } as unknown as Server["listen"];
}
