// ONE WORKER JOB'S VIEW OF THE CHAIN: its own Connection over the process's
// pooled transport, with the floor every read must reach after a takeover, and
// the few reads the job makes itself (dispatcher ADR §3.6 step 4; §4.9 row 10;
// plan P3a Q3).
//
// minContextSlot ON EVERY READ OF A JOB THAT HAD A PLAN FLOOR. The pool fails
// over across endpoints (src/rpc-pool.ts), and an endpoint that lags could answer
// with a state from before an earlier fence's transaction — the balances, or the
// link nonce, it already moved. So once the job's plan floor has cleared, it sets
// the slot at which that wait cleared (requireSlot; src/worker-takeover.ts,
// readFromSlot, says how it is computed and why it is not the newest finalized
// slot), and from then on:
//   * every request whose method takes minContextSlot carries it (merged into
//     the method's own config object, or appended as one) — the node refuses,
//     -32016, rather than answer from behind it;
//   * every answer that reports its context slot and still comes back from
//     behind it — a method that takes no minContextSlot, getTokenAccountBalance
//     among them — is turned into that same refusal here, so the turn reading it
//     fails instead of planning from the past;
//   * A REFUSAL IS ASKED AGAIN, up to MIN_CONTEXT_RETRIES times
//     MIN_CONTEXT_RETRY_MS apart, through the pool: a load-balanced endpoint's
//     next answer usually comes from a node that has caught up, and the pool has
//     no failover of its own for an answer that is a JSON-RPC error. Without it,
//     one node a slot behind ended a settle turn THREW and cost the wallet a
//     60 s retry. Only after the last one does the refusal reach the turn. A
//     request carrying a sendTransaction is never repeated here.
// Before requireSlot is called, the transport is the process's, byte for byte.
//
// A CONNECTION PER JOB, NOT A SETTING ON THE PROCESS'S: two jobs run side by side
// in one worker, and one vault's floor must not slow, or loosen, another's.
// Anything a Connection caches per instance (settle-tick.ts's rent-exempt
// minimum, for one) is therefore read once per job instead of once per process.

import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey, type AccountInfo } from "@solana/web3.js";
import { configAddress, decodeProtocolConfig, decodeVault, type ProtocolConfigState, type VaultState } from "./accounts.js";
import { decodeTradingLink, type ManagedLink } from "./discovery.js";
import { accountDiscriminator, idl } from "./idl.js";
import type { SeenStatus, TakeoverChain } from "./worker-takeover.js";

/** The JSON-RPC methods that accept minContextSlot in their config object (Solana's RPC reference). */
export const MIN_CONTEXT_METHODS: ReadonlySet<string> = new Set([
  "getAccountInfo",
  "getBalance",
  "getBlockHeight",
  "getEpochInfo",
  "getFeeForMessage",
  "getLatestBlockhash",
  "getMultipleAccounts",
  "getProgramAccounts",
  "getSignaturesForAddress",
  "getSlot",
  "getTokenAccountsByDelegate",
  "getTokenAccountsByOwner",
  "isBlockhashValid",
  "sendTransaction",
  "simulateTransaction",
]);

/** The node's own code for "Minimum context slot has not been reached". */
export const MIN_CONTEXT_NOT_REACHED = -32016;
/** How many times a request refused at the job's floor is asked again (the header). */
export const MIN_CONTEXT_RETRIES = 3;
/** How long apart: a finalized slot comes every ~0.4 s, so a node a few slots behind has caught up. */
export const MIN_CONTEXT_RETRY_MS = 1_000;

type RpcRequest = { readonly method?: unknown; params?: unknown; readonly id?: unknown };

/** The request with minContextSlot merged into its config, for a method that takes one. */
function withMinContext(request: RpcRequest, slot: bigint): RpcRequest {
  if (typeof request.method !== "string" || !MIN_CONTEXT_METHODS.has(request.method)) return request;
  const params = Array.isArray(request.params) ? [...(request.params as unknown[])] : [];
  const last = params.at(-1);
  // THE CONFIG OBJECT IS ALWAYS LAST: a trailing plain object is it; anything else gets one appended.
  if (last !== null && typeof last === "object" && !Array.isArray(last)) {
    const config = last as Record<string, unknown>;
    const asked = typeof config["minContextSlot"] === "number" ? (config["minContextSlot"] as number) : -1;
    params[params.length - 1] = { ...config, minContextSlot: Math.max(asked, Number(slot)) };
  } else {
    // getBlockHeight / getSlot / getLatestBlockhash with no config take it as their only parameter.
    params.push({ minContextSlot: Number(slot) });
  }
  return { ...request, params };
}

/** Whether one answer is the node's own -32016. */
function notReached(answer: unknown): boolean {
  if (answer === null || typeof answer !== "object") return false;
  return (answer as { readonly error?: { readonly code?: unknown } }).error?.code === MIN_CONTEXT_NOT_REACHED;
}

/** An answer that reports a context slot below the floor, or null when it reports none or is at or above it. */
function behind(answer: unknown, slot: bigint): number | null {
  if (answer === null || typeof answer !== "object") return null;
  const context = ((answer as { readonly result?: unknown }).result as { readonly context?: { readonly slot?: unknown } } | undefined)?.context;
  const seen = context?.slot;
  return typeof seen === "number" && BigInt(seen) < slot ? seen : null;
}

/**
 * The job's transport: `base` (the process's poolFetch), with the floor applied
 * once `requiredSlot()` names one. Batches are handled element by element; a
 * refusal at the floor is asked again (the header). `options` are the tests'.
 */
export function minContextFetch(
  base: typeof fetch,
  requiredSlot: () => bigint | null,
  options: { readonly retries?: number; readonly retryMs?: number; readonly sleep?: (ms: number) => Promise<void> } = {},
): typeof fetch {
  const retries = options.retries ?? MIN_CONTEXT_RETRIES;
  const retryMs = options.retryMs ?? MIN_CONTEXT_RETRY_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  return (async (input: unknown, init?: RequestInit): Promise<Response> => {
    const slot = requiredSlot();
    if (slot === null || typeof init?.body !== "string") return base(input as Parameters<typeof fetch>[0], init);
    let body: unknown;
    try {
      body = JSON.parse(init.body);
    } catch {
      return base(input as Parameters<typeof fetch>[0], init);
    }
    const requests: RpcRequest[] = Array.isArray(body) ? (body as RpcRequest[]) : [body as RpcRequest];
    const rewritten = requests.map((request) => withMinContext(request, slot));
    const sent = JSON.stringify(Array.isArray(body) ? rewritten : rewritten[0]);
    // A SEND IS NEVER REPEATED HERE: the sender owns what happens to signed bytes.
    const mayRepeat = rewritten.every((request) => request.method !== "sendTransaction");
    for (let attempt = 0; ; attempt += 1) {
      const response = await base(input as Parameters<typeof fetch>[0], { ...init, body: sent });
      if (!response.ok) return response;
      const text = await response.text();
      let answer: unknown;
      try {
        answer = JSON.parse(text);
      } catch {
        return new Response(text, { status: response.status, headers: response.headers });
      }
      const answers: unknown[] = Array.isArray(answer) ? answer : [answer];
      let refused = false;
      let short = false;
      const checked = answers.map((one) => {
        if (notReached(one)) {
          short = true;
          return one;
        }
        const seen = behind(one, slot);
        if (seen === null) return one;
        refused = true;
        short = true;
        return {
          jsonrpc: "2.0",
          id: (one as { readonly id?: unknown }).id ?? null,
          error: {
            code: MIN_CONTEXT_NOT_REACHED,
            message: `Minimum context slot has not been reached: this answer is from slot ${seen}, and this job reads from slot ${slot} on (where its plan floor cleared)`,
          },
        };
      });
      if (short && mayRepeat && attempt < retries) {
        await sleep(retryMs);
        continue;
      }
      const out = refused ? JSON.stringify(Array.isArray(answer) ? checked : checked[0]) : text;
      return new Response(out, { status: response.status, headers: { "content-type": "application/json" } });
    }
  }) as typeof fetch;
}

/** What one job reads of its vault, fresh, in one request. */
export interface VaultRead {
  /** Null when the chain has no account at the vault's address. */
  readonly vault: VaultState | null;
  /** The links that still exist, are owned by the program, decode, and name THIS vault — in link-address order. */
  readonly links: readonly ManagedLink[];
  /** The protocol config, null when the PDA does not exist. */
  readonly config: ProtocolConfigState | null;
  /** The crank's lamports — config.keeper's — or null when it could not be read. */
  readonly crankLamports: bigint | null;
}

/** Everything a job asks of the chain itself; the settle and invest turns use `connection` and `program`. */
export interface JobChain extends TakeoverChain {
  readonly connection: Connection;
  readonly program: anchor.Program;
  /** From now on every read of this job must come from at least this slot (never lowered). */
  requireSlot(slot: bigint): void;
  readonly requiredSlot: bigint | null;
  latestBlockhash(): Promise<{ readonly blockhash: string; readonly lastValidBlockHeight: number }>;
  readVault(vault: PublicKey, links: readonly PublicKey[]): Promise<VaultRead>;
}

/** A link, in link-address order (ADR §3.2 step 3). */
export const byLinkAddress = (a: ManagedLink, b: ManagedLink): number => {
  const left = a.linkAddress.toBase58();
  const right = b.linkAddress.toBase58();
  return left < right ? -1 : left > right ? 1 : 0;
};

/** The provider wallet a job's program is built with: the crank when live, a refusing stand-in otherwise. */
export type JobWallet = ConstructorParameters<typeof anchor.AnchorProvider>[1];

/**
 * A job's chain over `transport` (the process's poolFetch). `rpcUrl` is only the
 * URL web3.js threads through; the transport ignores it, as bin/keeper.mts's does.
 * `crankHint` is the keeper the last job's config named: read in the same
 * request when it still is the keeper, and asked for on its own when not.
 */
export function createJobChain(options: {
  readonly transport: typeof fetch;
  readonly rpcUrl: string;
  readonly wallet: JobWallet;
  readonly crankHint?: () => PublicKey | null;
  readonly onCrank?: (keeper: PublicKey) => void;
}): JobChain {
  let required: bigint | null = null;
  const connection = new Connection(options.rpcUrl, {
    commitment: "confirmed",
    fetch: minContextFetch(options.transport, () => required),
  });
  const program = new anchor.Program(idl, new anchor.AnchorProvider(connection, options.wallet, { commitment: "confirmed" }));
  const linkDiscriminator = accountDiscriminator("TradingLink");
  return {
    connection,
    program,
    requireSlot(slot) {
      required = required === null || slot > required ? slot : required;
    },
    get requiredSlot() {
      return required;
    },
    finalizedHeight: async () => BigInt(await connection.getBlockHeight("finalized")),
    confirmedHeight: async () => BigInt(await connection.getBlockHeight("confirmed")),
    async finalizedPoint() {
      // ONE ANSWER, ONE BANK: the height and the slot of the same finalized block.
      const info = await connection.getEpochInfo("finalized");
      if (typeof info.blockHeight !== "number") throw new Error("getEpochInfo answered no blockHeight: the plan floor cannot be placed");
      return { height: BigInt(info.blockHeight), slot: BigInt(info.absoluteSlot) };
    },
    statuses: async (signatures) => {
      const { value } = await connection.getSignatureStatuses([...signatures], { searchTransactionHistory: true });
      return value.map((status): SeenStatus | null =>
        status === null
          ? null
          : {
              err: status.err,
              // A node that omits confirmationStatus reports a rooted transaction as confirmations: null.
              confirmationStatus: status.confirmationStatus ?? (status.confirmations === null ? "finalized" : "processed"),
            },
      );
    },
    latestBlockhash: () => connection.getLatestBlockhash("confirmed"),
    async readVault(vault, links) {
      const config = configAddress(program.programId);
      const hint = options.crankHint?.() ?? null;
      const keys = [vault, config, ...(hint === null ? [] : [hint]), ...links];
      const infos = await connection.getMultipleAccountsInfo(keys, "confirmed");
      if (infos.length !== keys.length) throw new Error(`asked for ${keys.length} accounts and got ${infos.length}: the job's read no longer lines up`);
      const at = (index: number): AccountInfo<Buffer> | null => infos[index] ?? null;
      const vaultInfo = at(0);
      const configInfo = at(1);
      const decodedConfig = configInfo === null ? null : decodeProtocolConfig(program, config, configInfo.data);
      const linkStart = hint === null ? 2 : 3;
      const found: ManagedLink[] = [];
      links.forEach((address, index) => {
        const info = at(linkStart + index);
        if (info === null || !info.owner.equals(program.programId)) return;
        const link = decodeTradingLink(address, info.data, linkDiscriminator);
        // A LINK THE LISTING TIED TO THIS VAULT AND THE CHAIN NOW TIES TO ANOTHER IS NOT THIS JOB'S.
        if (link !== null && link.vault.equals(vault)) found.push(link);
      });
      let crankLamports: bigint | null = null;
      const keeper = decodedConfig?.keeper ?? null;
      if (keeper !== null && !keeper.equals(PublicKey.default)) {
        options.onCrank?.(keeper);
        if (hint !== null && hint.equals(keeper)) crankLamports = BigInt(at(2)?.lamports ?? 0);
        else crankLamports = await connection.getBalance(keeper, "confirmed").then((lamports) => BigInt(lamports), () => null);
      }
      return {
        vault: vaultInfo === null ? null : decodeVault(program, vaultInfo.data),
        links: found.sort(byLinkAddress),
        config: decodedConfig,
        crankLamports,
      };
    },
  };
}
