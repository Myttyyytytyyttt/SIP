// Who is allowed to act, and when it becomes allowed.
//
// ITS OWN MODULE BECAUSE ITS BUG WAS INVISIBLE INLINE. Written into
// supervisor.mts as a startup `await` and a `const live`, the logic read
// correctly and was wrong in the one scenario it existed for: Railway boots the
// new container while the old one still holds the lock, so the newcomer LOSES
// that race as a matter of course — and then, with the claim never retried and
// `live` frozen, sat in dry run forever. Every ordinary deploy produced a keeper
// that settled nothing while /health stayed green.
//
// Pulled out here, the whole lifecycle is a handful of transitions that a test
// can drive: claim, lose, retry, lose, the holder lets go, retry, take over.
// That test is the one that would have caught it.

/**
 * Attempts the claim. Returns whether it was granted, and — when it was — the
 * handle whose release gives it up. Postgres advisory locks are SESSION scoped,
 * so holding the claim means holding that handle open.
 */
export type ClaimAttempt = () => Promise<{ held: boolean; release?: () => void }>;

export interface SupervisorClaimOptions {
  /** False when the supervisor is not armed; nothing is claimed and nothing acts. */
  readonly armed: boolean;
  readonly attempt: ClaimAttempt;
  /**
   * True when there is no lock to take at all (no database configured). The
   * supervisor then acts WITHOUT exclusivity, which is a fact for the operator
   * to know rather than one to hide.
   */
  readonly unenforced?: boolean;
  readonly onTakeover?: () => void;
}

export class SupervisorClaim {
  #held: boolean;
  #release: (() => void) | undefined;
  readonly #armed: boolean;
  readonly #attempt: ClaimAttempt;
  readonly #onTakeover: (() => void) | undefined;

  constructor(options: SupervisorClaimOptions) {
    this.#armed = options.armed;
    this.#attempt = options.attempt;
    this.#onTakeover = options.onTakeover;
    // With no lock to take, the claim is vacuously held: an unarmed or
    // database-less supervisor is not competing with anyone through this
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

  /**
   * Tries to take the claim, and keeps being callable.
   *
   * IDEMPOTENT AND CHEAP once held, so the sweep can call it every cycle
   * without thinking. That repetition is the entire fix: the outgoing container
   * releases on SIGTERM and the incoming one takes over on its next sweep,
   * rather than waiting for a human to notice a keeper that was never going to
   * act.
   */
  async ensure(): Promise<boolean> {
    if (!this.#armed || this.#held) return this.#held;
    const result = await this.#attempt();
    if (!result.held) return false;
    this.#held = true;
    this.#release = result.release;
    this.#onTakeover?.();
    return true;
  }

  /**
   * Gives up the claim so the next instance can have it.
   *
   * Called on SIGTERM: the lock lives on the held session, so without this a
   * redeployed container keeps it until its connection eventually dies, and the
   * instance meant to be acting stays dry for as long as that takes.
   */
  release(): void {
    this.#release?.();
    this.#release = undefined;
    this.#held = false;
  }
}
