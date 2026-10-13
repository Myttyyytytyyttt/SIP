// The scheduler's reads of the chain (src/scheduler.ts, SchedulerChain), over the
// keeper's own modules: the same snapshot, listing, re-read, batch and dry invest
// decision the legacy sweep runs, so the scheduler measures what the keeper
// measures. Every call goes through the Connection the entry point built on the
// process's budgeted pool (bin/scheduler.mts: RpcBudget, lane `sched`).
//
// IT READS, AND NOTHING ELSE. The program it is handed has a wallet that
// refuses to sign; the invest decision runs DRY (live false, no crank key), on a
// snapshot, and stops — by runInvestTick's own rule — before its first live
// act; it never reaches Jupiter.

import type * as anchor from "@coral-xyz/anchor";
import { NATIVE_MINT, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey, type Connection } from "@solana/web3.js";
import { summarizeUpstreamError } from "@sip/solana-log";
import { readChainSnapshot } from "./chain-state.js";
import { MULTIPLE_ACCOUNTS_CHUNK, discoverLinksPreferringV2, discoverLinksWithContext, rereadLinks } from "./discovery.js";
import { investRests } from "./doorbell.js";
import { PYTH_SOL_USD_FEED } from "./pyth.js";
import { readSweepState, tokenAmountOf } from "./invest-snapshot.js";
import { runInvestTick } from "./invest-tick.js";
import type { InvestRestVerdict, SchedulerChain } from "./scheduler.js";

export interface SchedulerChainOptions {
  readonly connection: Connection;
  readonly program: anchor.Program;
  readonly discriminator: Buffer;
  /** The `gpa-v2` token: V2 first, V1 as the fallback, both asked with their context. */
  readonly gpaV2: boolean;
  /** The pool's fetch, for V2's hand-built JSON-RPC (the same transport the Connection uses). */
  readonly rpc: typeof fetch;
  /**
   * SIP_SOLANA_PRICE_TAPE: the snapshot's first request also reads Pyth's SOL/USD
   * account — one getMultipleAccounts where the program account was one
   * getAccountInfo, so the tape costs no extra call. Absent or false: the snapshot
   * is read exactly as before.
   */
  readonly priceTape?: boolean;
}

/** The scheduler's chain, on the process's own Connection. */
export function createSchedulerChain(options: SchedulerChainOptions): SchedulerChain {
  const { connection, program, discriminator } = options;
  const programId = program.programId;
  return {
    snapshot: () => (options.priceTape === true ? readChainSnapshot(connection, program, { alsoRead: PYTH_SOL_USD_FEED }) : readChainSnapshot(connection, program)),
    list: async () => {
      if (options.gpaV2) return discoverLinksPreferringV2(connection, programId, discriminator, options.rpc, { withContext: true });
      const listed = await discoverLinksWithContext(connection, programId, discriminator);
      return { links: listed.links, method: "v1", requests: 1, contextSlot: listed.contextSlot };
    },
    reread: (addresses) => rereadLinks(connection, addresses.map((a) => new PublicKey(a)), programId, discriminator),
    fingerprints: async (wallets) => {
      const keys = wallets.flatMap((wallet) => {
        const owner = new PublicKey(wallet);
        return [owner, getAssociatedTokenAddressSync(NATIVE_MINT, owner, true, TOKEN_PROGRAM_ID)];
      });
      const byWallet = new Map<string, { lamports: bigint; wsol: bigint }>();
      let slot = Number.POSITIVE_INFINITY;
      for (let start = 0; start < keys.length; start += MULTIPLE_ACCOUNTS_CHUNK) {
        const chunk = keys.slice(start, start + MULTIPLE_ACCOUNTS_CHUNK);
        const answer = await connection.getMultipleAccountsInfoAndContext(chunk, "confirmed");
        if (answer.value.length !== chunk.length) throw new Error(`asked for ${chunk.length} accounts and got ${answer.value.length} answers`);
        // THE LOWEST CONTEXT OF THE BATCH: a fingerprint is only as new as its oldest part.
        slot = Math.min(slot, answer.context.slot);
        for (let i = 0; i < chunk.length; i += 2) {
          const wallet = chunk[i]!.toBase58();
          byWallet.set(wallet, { lamports: BigInt(answer.value[i]?.lamports ?? 0), wsol: tokenAmountOf(answer.value[i + 1]) });
        }
      }
      return { slot: Number.isFinite(slot) ? slot : 0, byWallet };
    },
    investAtRest: async (vaults, input) => {
      const verdicts = new Map<string, InvestRestVerdict>();
      const state = await readSweepState(connection, program, vaults.map((v) => new PublicKey(v)));
      for (const vault of vaults) {
        const snapshot = state.invest.get(vault);
        if (snapshot === undefined) {
          verdicts.set(vault, { rests: false, outcome: "UNREAD", detail: "the batch did not read this vault" });
          continue;
        }
        try {
          const result = await runInvestTick({
            connection,
            program,
            vault: new PublicKey(vault),
            crank: null,
            crankLamports: input.crankLamports,
            live: false,
            protocolPaused: input.protocolPaused,
            snapshot,
          });
          // RESTS ONLY ON THE SNAPSHOT'S OWN WORD: an answer the turn had to read
          // fresh for is one the snapshot could not give, and a wrap the crank
          // cannot front keeps the vault busy (turnRests's wrapShort rule).
          const rests = result.reads === "snapshot" && investRests(result.outcome) && result.wrap?.short !== true;
          verdicts.set(vault, { rests, outcome: result.outcome, detail: result.detail });
        } catch (error) {
          verdicts.set(vault, { rests: false, outcome: "THREW", detail: summarizeUpstreamError(error) });
        }
      }
      return verdicts;
    },
    finalizedHeight: async () => BigInt(await connection.getBlockHeight("finalized")),
    signatureStatuses: async (signatures) => {
      const out: ({ err: unknown } | null)[] = [];
      for (let start = 0; start < signatures.length; start += 256) {
        const chunk = signatures.slice(start, start + 256);
        const answer = await connection.getSignatureStatuses([...chunk], { searchTransactionHistory: true });
        for (const status of answer.value) out.push(status === null ? null : { err: status.err ?? null });
      }
      return out;
    },
  };
}
