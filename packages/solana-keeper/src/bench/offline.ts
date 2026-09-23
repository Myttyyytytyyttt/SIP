// THE BENCH REACHES NOBODY BUT ITS OWN STUB, and this is what proves it rather
// than asserting it in a comment.
//
// NOTHING HERE RUNS IN PRODUCTION. src/bench/ exists for
// scripts/ceiling-bench.mts and its tests. This file is loaded into the BENCH'S
// keeper child process with `tsx --import`, before bin/keeper.mts, and into
// nothing else.
//
// WHY A GUARD AND NOT A PROMISE. The bench drives the keeper's real sweep, and
// the real sweep has paths that call out: Jupiter for a quote and a route build,
// the alert webhook, Privy's API. The bench's fleet is shaped so none of them is
// reached — the vaults hold no free lamports and no balance above the policy
// minimum, so every invest turn rests before the venue — but "shaped so" is an
// argument, and the thing being avoided is a load test against somebody else's
// endpoint. One wrapper around fetch turns the argument into a refusal: a
// request to any host but the loopback throws, the keeper's own error handling
// contains it, and the bench's summary reports that it happened.
//
// IT CANNOT MAKE THE KEEPER SEND ANYTHING EITHER. The child runs dry — no
// SIP_SOLANA_BROADCAST, so config.ts reads no signing secret — and the stub
// refuses sendTransaction on top of that. This is the third lock on the same
// door, and the only one that also covers HTTP that has nothing to do with the
// chain.

/** The hosts a bench process may talk to: its own machine, by every spelling. */
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]", "0.0.0.0"]);

/**
 * Whether a request target is this machine.
 *
 * A TARGET THAT WILL NOT PARSE IS NOT LOCAL. Refusing what cannot be read is
 * the only safe reading: the whole point is that nothing unexpected leaves.
 */
export function isLoopbackTarget(target: string): boolean {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return false;
  }
  return LOOPBACK.has(url.hostname);
}

/** What a blocked request throws, so a reader of the keeper's log knows who stopped it. */
export const OFFLINE_REFUSAL = "the ceiling bench runs offline: this process may reach its own stubbed chain on the loopback and nothing else";

/**
 * Replace this process's `fetch` with one that answers only the loopback.
 *
 * Returns the count of blocked attempts, read by the bench at the end of a run
 * so a fleet that quietly started reaching a venue is reported and not averaged
 * into a latency.
 */
export function installOfflineGuard(): { readonly blocked: readonly string[] } {
  const blocked: string[] = [];
  const inner = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: unknown): Promise<Response> => {
    const target =
      typeof input === "string" ? input : input instanceof URL ? input.href : typeof (input as Request)?.url === "string" ? (input as Request).url : "";
    if (!isLoopbackTarget(target)) {
      // THE HOST, NEVER THE WHOLE URL: an endpoint's path and query can carry an
      // API key, and this line goes to a log the bench prints.
      let host = "unparseable";
      try {
        host = new URL(target).host;
      } catch {
        // left as unparseable
      }
      blocked.push(host);
      throw new Error(`${OFFLINE_REFUSAL} (refused a request to ${host})`);
    }
    return (inner as (input: unknown, init?: unknown) => Promise<Response>)(input, init);
  }) as typeof fetch;
  return { blocked };
}
