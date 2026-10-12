// The `explicit-send` cut (L1d, ADR §4.3; SAFETY §2.3; PLAN §3.2 P2): every
// crank transaction — the wrap, the convert, every leg — sent in an order the
// keeper owns, with a question asked between "signed" and "sent".
//
// THE GAP IT CLOSES. Today the three crank sends go through Anchor: the wrap's
// `.rpc()` and sendWithBudget's two `provider.sendAndConfirm` calls
// (invest-tick.ts). Anchor reads the blockhash, signs, sends and confirms in one
// call, so there is no point at which the keeper can ask "do I still hold the
// claim?" after the turn began (ADR §4.2 gap 5) — and `keysForTurn` asks it once
// per TURN (gap 1): a claim lost after the wrap still sends the convert and
// every leg. Here the order is spelled out:
//
//   blockhash (with its lastValidBlockHeight) → build → sign → ASK → send the
//   signed bytes → confirm by polling the signature's status over HTTP
//
// and "ask" is three questions, each a refusal that sends nothing:
//
//   * IS THIS PROCESS STILL LIVE? the keeper's own isLive() — the claim, the
//     verified chain, the arming — asked per SEND, not per turn (§4.3 item 2).
//     It closes gap 1 for a claim lost with an error event; a lock lost
//     silently (gap 3) is the dispatcher's fence, not this.
//   * IS THIS THE TAKEOVER QUIET PERIOD? For QUIET_AFTER_TAKEOVER_MS after this
//     process starts or takes the claim, no wrap, convert or invest goes out
//     (§4.3 item 3). The previous holder's last transaction stays valid for
//     about 150 blocks, and a turn that read balances before it landed would
//     plan from money that is about to move (gap 2). Settles do not pass
//     through here — settle_v2 is idempotent on chain (nonce + frontier) — so
//     they go as usual. What the owner sees: about one more sweep without buys
//     after each deploy.
//   * IS THE PROCESS DRAINING? After SIGTERM no new send starts; a send whose
//     bytes already left is confirmed for up to SIGTERM_DRAIN_MS, and only then
//     is the claim released (§4.3 item 4). It needs Railway's
//     RAILWAY_DEPLOYMENT_DRAINING_SECONDS ≥ 30; without it the quiet period
//     alone covers the gap.
//
// THE BYTES DO NOT CHANGE. The transaction is built exactly as Anchor builds
// it — the same instructions in the same order, the fee payer defaulted to the
// provider's wallet on a legacy message, the crank's partial signature and then
// the wallet's — so for the same blockhash the bytes are identical, which
// test/invest-transaction.test.ts pins for all three sends. Only who reads the
// blockhash, when the question is asked and how the landing is watched change.
//
// AND IT SENDS THROUGH THE POOL. Anchor confirms on a WebSocket web3.js opens
// beside the transport, outside the RPC pool's failover and outside every
// counter (rpc-usage.ts, countConfirmations). Polling getSignatureStatuses goes
// through the same transport as every other read.
//
// NOTHING HERE DECIDES WHAT TO BUY, and nothing here holds a key of its own: the
// crank is handed in per send, as it was handed to Anchor. Moving the Keypair
// itself behind this seam is the dispatcher's fenced sender (ADR §3.6, P3).

import {
  type Commitment,
  type Connection,
  type Keypair,
  type PublicKey,
  type SignatureStatus,
  type Transaction,
  type VersionedTransaction,
} from "@solana/web3.js";

/** About one blockhash lifetime (150 blocks) plus finality, at 0.37–0.40 s a slot: ≈ 55–60 s + 12–13 s (ADR §4.3, COMPUTED). */
export const QUIET_AFTER_TAKEOVER_MS = 75_000;

/** How long a send already on the wire is waited for after SIGTERM before the claim is released anyway (ADR §4.3 item 4). */
export const SIGTERM_DRAIN_MS = 20_000;

/** How often a sent transaction's status is asked for: settle-tick.ts's CONFIRM_POLL_MS. */
export const SEND_POLL_MS = 500;

/** Every how many polls the finalized block height is read, to know when "not landed" has become a fact. */
const HEIGHT_EVERY_POLLS = 4;

/**
 * The longest a send is watched whatever the chain says: a node that never
 * answers a status and never advances a height must not hold the sweep forever.
 * Twice Anchor's own 60 s.
 */
export const SEND_WATCH_CEILING_MS = 120_000;

/** Why a send was not made. Every one of them is BEFORE the bytes leave: nothing was sent. */
export type SendRefusalReason = "not-live" | "quiet" | "draining";

/**
 * A crank send this process refused to make. Thrown AFTER the transaction was
 * signed and BEFORE it was sent — the signed bytes are dropped here and never
 * logged, because they stay valid until their last valid block height.
 *
 * A plain Error to the turn: the invest turn's own catch ends it FAILED with
 * whatever purchases had already confirmed, which is how a basket broken half
 * way has always been reported.
 */
export class CrankSendRefused extends Error {
  constructor(
    readonly reason: SendRefusalReason,
    detail: string,
  ) {
    super(detail);
    this.name = "CrankSendRefused";
  }
}

/** What the sender has done since boot, for /status (`cuts.explicitSend`). */
export interface CrankSenderStatus {
  readonly sent: number;
  readonly landed: number;
  readonly reverted: number;
  readonly expired: number;
  readonly refused: { readonly notLive: number; readonly quiet: number; readonly draining: number };
  readonly inFlight: number;
  /** While the takeover quiet period runs: until when. */
  readonly quietUntil: string | null;
  readonly draining: boolean;
  /** The SIGTERM drain, once one started: what was on the wire, and whether it all landed before the claim was let go. */
  readonly drain: { readonly startedAt: string; readonly inFlightAtStart: number; readonly waitedMs: number | null; readonly completed: boolean | null } | null;
}

/** The wallet Anchor's provider signs with: the second signature on every crank transaction, as Anchor adds it. */
export interface SigningWallet {
  readonly publicKey: PublicKey;
  signTransaction<T extends Transaction | VersionedTransaction>(transaction: T): Promise<T>;
}

export interface CrankSenderOptions {
  readonly connection: Connection;
  readonly wallet: SigningWallet;
  /** The keeper's isLive(): asked before every send, never cached. */
  readonly isLive: () => boolean;
  /** Told each landed send's confirmation time: /status's investConfirmMs. Its throw is swallowed. */
  readonly onConfirmed?: (ms: number) => void;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly quietMs?: number;
}

/**
 * The crank's sends, in the explicit order, with the per-send question, the
 * takeover quiet period and the SIGTERM drain. One per process, built only
 * under the `explicit-send` token (bin/keeper.mts).
 */
export class CrankSender {
  readonly #connection: Connection;
  readonly #wallet: SigningWallet;
  readonly #isLive: () => boolean;
  readonly #onConfirmed: ((ms: number) => void) | undefined;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #quietMs: number;
  /** A NEW PROCESS IS A NEW HOLDER: the quiet period starts at construction, as at every takeover. */
  #quietUntil: number;
  #draining = false;
  #inFlight = 0;
  #idleWaiters: (() => void)[] = [];
  #counts = { sent: 0, landed: 0, reverted: 0, expired: 0 };
  #refused = { notLive: 0, quiet: 0, draining: 0 };
  #drain: { startedAt: number; inFlightAtStart: number; waitedMs: number | null; completed: boolean | null } | null = null;

  constructor(options: CrankSenderOptions) {
    this.#connection = options.connection;
    this.#wallet = options.wallet;
    this.#isLive = options.isLive;
    this.#onConfirmed = options.onConfirmed;
    this.#now = options.now ?? (() => Date.now());
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#quietMs = options.quietMs ?? QUIET_AFTER_TAKEOVER_MS;
    this.#quietUntil = this.#now() + this.#quietMs;
  }

  /** Called from the claim's onTakeover: this process just became the holder, so the quiet period starts again. */
  noteTakeover(): void {
    this.#quietUntil = Math.max(this.#quietUntil, this.#now() + this.#quietMs);
  }

  get draining(): boolean {
    return this.#draining;
  }

  /**
   * Why a BUYING TURN must not start now, in words for its detail — or null.
   *
   * ASKED ONCE, BEFORE THE TURN QUOTES ANYTHING (invest-tick.ts), so a quiet or
   * draining keeper spends no Jupiter budget on a basket it will not send. The
   * per-send question in #ask still runs on every send: this is the cheap early
   * answer, that one is the guarantee.
   */
  buyingBlocked(): string | null {
    if (this.#draining) return "the keeper is draining after SIGTERM and starts no new send; nothing was quoted, wrapped or sent";
    const now = this.#now();
    if (now < this.#quietUntil) {
      return (
        `the takeover quiet period: this keeper took the claim and sends no wrap, convert or invest until ` +
        `${new Date(this.#quietUntil).toISOString()} (${Math.ceil((this.#quietUntil - now) / 1_000)} s), so a transaction the ` +
        "previous holder sent can land before this one plans; settles go as usual, and nothing was quoted, wrapped or sent"
      );
    }
    return null;
  }

  /** SIGTERM: no new send starts from now on. Sends already on the wire are still confirmed. */
  beginDrain(): void {
    if (this.#draining) return;
    this.#draining = true;
    this.#drain = { startedAt: this.#now(), inFlightAtStart: this.#inFlight, waitedMs: null, completed: null };
  }

  /**
   * Resolves true once no send is in flight, false once `timeoutMs` has passed
   * with one still on the wire. Either way the caller then releases the claim
   * and exits: twenty seconds is what Railway's drain window can grant.
   */
  async idle(timeoutMs: number = SIGTERM_DRAIN_MS): Promise<boolean> {
    const started = this.#now();
    const settled =
      this.#inFlight === 0
        ? true
        : await Promise.race([
            new Promise<boolean>((resolve) => this.#idleWaiters.push(() => resolve(true))),
            this.#sleep(timeoutMs).then(() => false),
          ]);
    if (this.#drain !== null && this.#drain.waitedMs === null) {
      this.#drain.waitedMs = this.#now() - started;
      this.#drain.completed = settled;
    }
    return settled;
  }

  /**
   * A LEGACY crank transaction — the wrap's, or a budgeted one with no lookup
   * tables — as AnchorProvider.sendAndConfirm sends it: fee payer defaulted to
   * the wallet, the blockhash read now, each signer's partial signature, then
   * the wallet's.
   */
  async sendLegacy(transaction: Transaction, signers: readonly Keypair[]): Promise<string> {
    const { blockhash, lastValidBlockHeight } = await this.#connection.getLatestBlockhash("confirmed");
    transaction.feePayer = transaction.feePayer ?? this.#wallet.publicKey;
    transaction.recentBlockhash = blockhash;
    for (const signer of signers) transaction.partialSign(signer);
    const signed = await this.#wallet.signTransaction(transaction);
    return this.#sendSigned(signed.serialize(), lastValidBlockHeight);
  }

  /**
   * A VERSIONED crank transaction, built by the caller around the blockhash
   * read here — sendWithBudget's v0 branch, whose message compiles against
   * the route's lookup tables — then signed as Anchor signs one: the signers,
   * then the wallet.
   */
  async sendVersioned(build: (recentBlockhash: string) => VersionedTransaction, signers: readonly Keypair[]): Promise<string> {
    const { blockhash, lastValidBlockHeight } = await this.#connection.getLatestBlockhash("confirmed");
    const transaction = build(blockhash);
    transaction.sign([...signers]);
    const signed = await this.#wallet.signTransaction(transaction);
    return this.#sendSigned(signed.serialize(), lastValidBlockHeight);
  }

  /** The question between "signed" and "sent". A refusal throws here, and the bytes go nowhere. */
  #ask(): void {
    if (this.#draining) {
      this.#refused.draining += 1;
      throw new CrankSendRefused("draining", "the keeper is draining after SIGTERM: this crank transaction was signed and not sent");
    }
    if (!this.#isLive()) {
      this.#refused.notLive += 1;
      throw new CrankSendRefused(
        "not-live",
        "this keeper no longer holds the claim (or is no longer live): this crank transaction was signed and not sent, and nothing after it in this turn will be",
      );
    }
    if (this.#now() < this.#quietUntil) {
      this.#refused.quiet += 1;
      throw new CrankSendRefused("quiet", "the takeover quiet period is running: this crank transaction was signed and not sent");
    }
  }

  async #sendSigned(raw: Buffer | Uint8Array, lastValidBlockHeight: number): Promise<string> {
    this.#ask();
    this.#inFlight += 1;
    try {
      // ANCHOR'S OWN SEND OPTIONS, so the request is the one it made: preflight
      // at the provider's commitment, no skip, no retry override.
      const signature = await this.#connection.sendRawTransaction(raw, { preflightCommitment: "confirmed" });
      this.#counts.sent += 1;
      const sentAt = this.#now();
      const status = await this.#watch(signature, lastValidBlockHeight);
      if (status.err !== null) {
        this.#counts.reverted += 1;
        // ANCHOR'S WORDING, so a FAILED detail reads the same either way.
        throw new Error(`Raw transaction ${signature} failed (${JSON.stringify({ err: status.err })})`);
      }
      this.#counts.landed += 1;
      try {
        this.#onConfirmed?.(this.#now() - sentAt);
      } catch {
        // A lost timing is a gap on /status, never a failed send.
      }
      return signature;
    } finally {
      this.#inFlight -= 1;
      if (this.#inFlight === 0) for (const wake of this.#idleWaiters.splice(0)) wake();
    }
  }

  /**
   * Polls the signature until it is confirmed (or finalized), or until the
   * chain's FINALIZED height has passed its last valid block height — the
   * moment "not landed" stops being likely and becomes a fact (SAFETY §2.2
   * amendment 3) — or until SEND_WATCH_CEILING_MS.
   *
   * CONFIRMED FOR SUCCESS AND FOR FAILURE ALIKE, as confirmTransaction's
   * "confirmed" was: an error seen at processed can belong to a dropped fork.
   * Inside the window the status is asked without history (standard credit);
   * once past it, once WITH history, before "expired" is said.
   */
  async #watch(signature: string, lastValidBlockHeight: number): Promise<{ readonly err: SignatureStatus["err"] }> {
    const deadline = this.#now() + SEND_WATCH_CEILING_MS;
    for (let poll = 1; ; poll++) {
      const seen = await this.#status(signature, false);
      if (seen !== null) return seen;
      if (poll % HEIGHT_EVERY_POLLS === 0) {
        const height = await this.#height("finalized");
        if (height !== null && height > lastValidBlockHeight) {
          const last = await this.#status(signature, true);
          if (last !== null) return last;
          this.#counts.expired += 1;
          throw new Error(
            `crank transaction ${signature} did not land: the finalized block height ${height} has passed its last valid ` +
              `block height ${lastValidBlockHeight}, so it never will`,
          );
        }
      }
      if (this.#now() >= deadline) {
        this.#counts.expired += 1;
        throw new Error(`crank transaction ${signature} was not confirmed within ${SEND_WATCH_CEILING_MS / 1_000} s`);
      }
      await this.#sleep(SEND_POLL_MS);
    }
  }

  async #status(signature: string, history: boolean): Promise<{ readonly err: SignatureStatus["err"] } | null> {
    try {
      const { value } = await this.#connection.getSignatureStatuses([signature], history ? { searchTransactionHistory: true } : undefined);
      const status = value[0];
      // A node that omits confirmationStatus reports a rooted transaction as confirmations: null.
      const level = status?.confirmationStatus ?? (status?.confirmations === null ? "finalized" : "processed");
      if (status && (level === "confirmed" || level === "finalized")) return { err: status.err };
    } catch {
      // Asked again on the next poll: the pool has set the failing endpoint aside.
    }
    return null;
  }

  async #height(commitment: Commitment): Promise<number | null> {
    try {
      return await this.#connection.getBlockHeight(commitment);
    } catch {
      return null;
    }
  }

  status(): CrankSenderStatus {
    const now = this.#now();
    return {
      ...this.#counts,
      refused: { ...this.#refused },
      inFlight: this.#inFlight,
      quietUntil: now < this.#quietUntil ? new Date(this.#quietUntil).toISOString() : null,
      draining: this.#draining,
      drain:
        this.#drain === null
          ? null
          : {
              startedAt: new Date(this.#drain.startedAt).toISOString(),
              inFlightAtStart: this.#drain.inFlightAtStart,
              waitedMs: this.#drain.waitedMs,
              completed: this.#drain.completed,
            },
    };
  }
}
