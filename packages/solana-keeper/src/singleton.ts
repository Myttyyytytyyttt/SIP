// Who is allowed to act, and when it becomes allowed.
//
// Ported from Nuvem's solana-lab keeper (keeper/src/singleton.ts). The claim
// lifecycle is unchanged; the lock key is new, and it is the worker's.
//
// ITS OWN MODULE BECAUSE ITS BUG WAS INVISIBLE INLINE. Written into the
// supervisor as a startup `await` and a `const live`, the logic read correctly
// and was wrong in the one scenario it existed for: Railway boots the new
// container while the old one still holds the lock, so the newcomer LOSES that
// race as a matter of course — and then, with the claim never retried and
// `live` frozen, sat in dry run forever. Every ordinary deploy produced a keeper
// that settled nothing while /health stayed green.
//
// Pulled out here, the whole lifecycle is a handful of transitions that a test
// can drive: claim, lose, retry, lose, the holder lets go, retry, take over.
// That test is the one that would have caught it.

import { createHash } from "node:crypto";
import { ROLE_PROFILES, type KeeperRole } from "./role-registry.js";

/**
 * The advisory locks' NAMES. Their keys are derived, never typed as a number.
 * They live in the role registry now, beside everything else that differs
 * between the keepers, and are re-exported here where every reader already
 * imports them; test/role-registry.test.ts pins both, and their keys, to the
 * bytes they held before they moved.
 */
export { KEEPER_LOCK_NAME, VOLUME_KEEPER_LOCK_NAME } from "./role-registry.js";

/**
 * The lock a keeper of this role claims: its profile's (src/role-registry.ts).
 * It used to be "volume, else profit" here, which is the line that would have
 * handed a third role the profit keeper's lock.
 */
export function lockNameFor(role: KeeperRole): string {
  return ROLE_PROFILES[role].lockName;
}

/**
 * A 64-bit key for pg_try_advisory_lock, derived from a name.
 *
 * THE WORKER'S DERIVATION, REIMPLEMENTED RATHER THAN IMPORTED. The EVM worker,
 * now archived under archive/evm, derived its ledger lock the same way; the
 * keeper never imported that file, because it dragged the worker's whole ledger
 * graph (viem, its types, its Postgres ledger) into a process that needs four
 * lines of it. Nuvem's keeper used a hand-typed hex literal instead; a derived
 * key means two services on one database can only collide if they choose the
 * same NAME, which is a thing a human can see. The test pins the value by
 * recomputing sha256 itself, so a drift from this rule fails there.
 */
export function advisoryKeyFor(name: string): bigint {
  const digest = createHash("sha256").update(name).digest();
  // Signed 64-bit, which is what pg_advisory_lock takes.
  return BigInt.asIntN(64, digest.readBigUInt64BE(0));
}

/**
 * Attempts the claim. Returns whether it was granted, and — when it was — the
 * handle whose release gives it up. Postgres advisory locks are SESSION scoped,
 * so holding the claim means holding that handle open.
 *
 * `check`, with a granted claim: asks the held session whether it is still
 * there — true, or why it is not (and then the attempt's own loss path has
 * already run). `failure`, with a refused one: the attempt could not be asked
 * at all — the database did not answer — which is not "another keeper holds it".
 */
export type ClaimAttempt = () => Promise<{ held: boolean; release?: () => void; check?: () => Promise<true | string>; failure?: string }>;

export interface KeeperClaimOptions {
  /** False when the keeper is not armed; nothing is claimed and nothing acts. */
  readonly armed: boolean;
  readonly attempt: ClaimAttempt;
  /**
   * True when there is no lock to take at all (no database configured). The
   * keeper then acts WITHOUT exclusivity, which is a fact for the operator
   * to know rather than one to hide.
   */
  readonly unenforced?: boolean;
  readonly onTakeover?: () => void;
}

export class KeeperClaim {
  #held: boolean;
  #release: (() => void) | undefined;
  #check: (() => Promise<true | string>) | undefined;
  #failure: string | null = null;
  readonly #armed: boolean;
  readonly #attempt: ClaimAttempt;
  readonly #onTakeover: (() => void) | undefined;

  constructor(options: KeeperClaimOptions) {
    this.#armed = options.armed;
    this.#attempt = options.attempt;
    this.#onTakeover = options.onTakeover;
    // With no lock to take, the claim is vacuously held: an unarmed or
    // database-less keeper is not competing with anyone through this
    // mechanism, and pretending otherwise would disable it for no benefit.
    this.#held = options.unenforced === true || !options.armed;
  }

  /** Armed AND holding the claim. Never cached by a caller — always asked. */
  get live(): boolean {
    return this.#armed && this.#held;
  }

  /** True once the claim is held, whether it was granted now or earlier. */
  get held(): boolean {
    return this.#held;
  }

  /** Why the last attempt could not even be asked (the database did not answer); null when it was asked, or is held. */
  get failure(): string | null {
    return this.#failure;
  }

  /**
   * Tries to take the claim, and keeps being callable.
   *
   * IDEMPOTENT AND CHEAP once held, so the sweep can call it every cycle
   * without thinking. That repetition is the entire fix: the outgoing container
   * releases on SIGTERM and the incoming one takes over on its next sweep,
   * rather than waiting for a human to notice a keeper that was never going to
   * act.
   *
   * THE HOLDER ASKS ITS SESSION EVERY SWEEP (the attempt's `check`: one SELECT 1
   * on the held connection). A session the server dropped without the socket
   * saying so — a partition, a pooler that let it go — is a lock this keeper no
   * longer holds and another may already have; before this, a holder never
   * looked again and kept acting on it. A failed check gives the claim up, and
   * the next sweep asks for it afresh.
   */
  async ensure(): Promise<boolean> {
    if (!this.#armed) return this.#held;
    if (this.#held) {
      const answered = this.#check === undefined ? true : await this.#check();
      if (answered !== true) {
        this.lose(answered);
        return false;
      }
      return this.#held;
    }
    const result = await this.#attempt();
    this.#failure = result.held ? null : (result.failure ?? null);
    if (!result.held) return false;
    this.#held = true;
    this.#release = result.release;
    this.#check = result.check;
    this.#onTakeover?.();
    return true;
  }

  /**
   * Gives up the claim so the next instance can have it.
   *
   * Called on SIGTERM: the lock lives on the held session, so without this a
   * redeployed container keeps it until its connection eventually dies, and the
   * instance meant to be acting stays dry for as long as that takes. Also called
   * when the held session is lost, so a keeper whose lock evaporated under it
   * stops acting and asks again on its next sweep.
   */
  release(): void {
    this.#release?.();
    this.#release = undefined;
    this.#check = undefined;
    this.#held = false;
  }

  /**
   * The held session went away — its socket errored, or it did not answer the
   * check: the claim is given up, and `failure` says why, so /status and the
   * not-acting alert name the database rather than "another keeper". The next
   * attempt that gets an answer clears it.
   */
  lose(reason: string): void {
    this.release();
    this.#failure = reason;
  }
}
