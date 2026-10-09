/**
 * ONE WEBSOCKET THAT SAYS WHEN AN ACCOUNT CHANGED — and nothing else.
 *
 * Solana JSON-RPC `accountSubscribe`, at "confirmed", on the key-free public
 * endpoint the browser already uses for Privy (config.solanaWsUrl, in the CSP's
 * connect-src). The Helius key never reaches the browser, and a subscription
 * costs it nothing: what a notification buys is decided by live-push.ts, and
 * every figure is still read through /api/solana-live.
 *
 * HAND-WRITTEN, NOT @solana/kit's rpcSubscriptions, although kit is already a
 * dependency. Kit's channel is async iterators over an AbortSignal per
 * subscription, with no reconnection of its own: the reconnect, the backoff,
 * the "give up quietly" and a resubscribe on a changed set would all have to
 * be built around it anyway, and a test would have to fake its transport
 * instead of a WebSocket. What this needs of the protocol is four messages
 * (subscribe, its answer, the notification, unsubscribe), so the socket
 * itself is the smaller thing to own, and it takes a fake in a test.
 *
 * ENCODING "base64": the page reads only the notification's slot, never the
 * data, so the encoding that costs least to produce and to carry is the one
 * that does no parsing (jsonParsed) and no extra work (base58, which the node
 * also refuses past 128 bytes; zstd, which pays a frame on 165 bytes).
 *
 * IT FAILS QUIETLY. The poll goes on whatever happens here. A socket that
 * closes reconnects after RECONNECT_MS (1 s, 2 s, 5 s, 15 s, 30 s); one that
 * fails that many times running without a single subscription confirmed is
 * given up for the life of the page, and onGiveUp says so. A reconnect that
 * does confirm a subscription calls onResync: whatever changed while it was
 * down rang nobody, so one read is owed.
 */

/** The subset of the browser's WebSocket this uses, so a test can hand in a fake. */
export interface SocketLike {
  readonly readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}

export type SocketFactory = (url: string) => SocketLike;

/** The browser's own WebSocket behind SocketLike: its handlers forward to whatever watchAccounts sets. */
export function browserSocket(url: string): SocketLike {
  const socket = new WebSocket(url);
  const like: SocketLike = {
    get readyState() {
      return socket.readyState;
    },
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    send: (data) => socket.send(data),
    close: () => socket.close(),
  };
  socket.onopen = (event) => like.onopen?.(event);
  socket.onmessage = (event) => like.onmessage?.(event);
  socket.onclose = (event) => like.onclose?.(event);
  socket.onerror = (event) => like.onerror?.(event);
  return like;
}

/** WebSocket.OPEN. */
const OPEN = 1;

/** Waits before each reconnect; past the last, the socket is given up. */
export const RECONNECT_MS: readonly number[] = [1_000, 2_000, 5_000, 15_000, 30_000];

export interface ChainWatch {
  /** The accounts to watch from now on; the same set is a no-op, a different one subscribes and unsubscribes the difference. */
  setAddresses(addresses: readonly string[]): void;
  /** Unsubscribe, close, and never reconnect. */
  close(): void;
}

export interface WatchOptions {
  readonly url: string;
  readonly addresses: readonly string[];
  /** An account changed at `slot`. */
  readonly onChange: (address: string, slot: number) => void;
  /** Reconnected after a gap: what changed meanwhile was not heard. */
  readonly onResync?: () => void;
  /** Reconnecting stopped for good; the poll is all there is. */
  readonly onGiveUp?: () => void;
  readonly open: SocketFactory;
  readonly setTimer?: (run: () => void, ms: number) => unknown;
  readonly clearTimer?: (timer: unknown) => void;
}

interface Pending {
  readonly address: string;
  readonly kind: "subscribe" | "unsubscribe";
}

export function watchAccounts(options: WatchOptions): ChainWatch {
  const setTimer = options.setTimer ?? ((run: () => void, ms: number) => setTimeout(run, ms));
  const clearTimer = options.clearTimer ?? ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>));

  let wanted = new Set(options.addresses);
  let socket: SocketLike | null = null;
  let closed = false;
  let failures = 0;
  let timer: unknown = null;
  /** Whether this socket has ever confirmed a subscription: a reconnect after one owes a read. */
  let everConfirmed = false;
  let confirmedThisSocket = false;
  let nextId = 1;
  const pending = new Map<number, Pending>();
  /** address → subscription id, for this socket only. */
  const subscribed = new Map<string, number>();
  const bySubscription = new Map<number, string>();

  const send = (method: string, params: unknown[], entry: Pending): void => {
    if (socket === null || socket.readyState !== OPEN) return;
    const id = nextId++;
    pending.set(id, entry);
    try {
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    } catch {
      pending.delete(id);
    }
  };

  const subscribe = (address: string): void =>
    send("accountSubscribe", [address, { commitment: "confirmed", encoding: "base64" }], { address, kind: "subscribe" });

  const unsubscribe = (address: string): void => {
    const id = subscribed.get(address);
    if (id === undefined) return;
    subscribed.delete(address);
    bySubscription.delete(id);
    send("accountUnsubscribe", [id], { address, kind: "unsubscribe" });
  };

  const onMessage = (raw: unknown): void => {
    if (typeof raw !== "string") return;
    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (message === null || typeof message !== "object") return;
    const body = message as { id?: unknown; result?: unknown; method?: unknown; params?: unknown };

    if (body.method === "accountNotification") {
      const params = body.params as { subscription?: unknown; result?: { context?: { slot?: unknown } } } | undefined;
      const id = params?.subscription;
      const slot = params?.result?.context?.slot;
      if (typeof id !== "number" || typeof slot !== "number" || !Number.isSafeInteger(slot)) return;
      const address = bySubscription.get(id);
      if (address !== undefined) options.onChange(address, slot);
      return;
    }

    if (typeof body.id !== "number") return;
    const entry = pending.get(body.id);
    if (entry === undefined) return;
    pending.delete(body.id);
    if (entry.kind !== "subscribe" || typeof body.result !== "number") return;
    // Answered for an address no longer wanted: let it go at once.
    if (!wanted.has(entry.address) || subscribed.has(entry.address)) {
      send("accountUnsubscribe", [body.result], { address: entry.address, kind: "unsubscribe" });
      return;
    }
    subscribed.set(entry.address, body.result);
    bySubscription.set(body.result, entry.address);
    if (!confirmedThisSocket) {
      confirmedThisSocket = true;
      failures = 0;
      if (everConfirmed) options.onResync?.();
      everConfirmed = true;
    }
  };

  const connect = (): void => {
    if (closed) return;
    confirmedThisSocket = false;
    pending.clear();
    subscribed.clear();
    bySubscription.clear();
    let next: SocketLike;
    try {
      next = options.open(options.url);
    } catch {
      retry();
      return;
    }
    socket = next;
    next.onopen = () => {
      if (socket !== next) return;
      for (const address of wanted) subscribe(address);
    };
    next.onmessage = (event) => {
      if (socket === next) onMessage(event.data);
    };
    // A failed socket fires error and then close; only close moves on.
    next.onerror = () => undefined;
    next.onclose = () => {
      if (socket !== next) return;
      socket = null;
      retry();
    };
  };

  const retry = (): void => {
    if (closed) return;
    // A socket that confirmed nothing counts as a failure; one that did starts the count again.
    const wait = RECONNECT_MS[failures];
    failures += 1;
    if (wait === undefined) {
      closed = true;
      options.onGiveUp?.();
      return;
    }
    timer = setTimer(() => {
      timer = null;
      connect();
    }, wait);
  };

  connect();

  return {
    setAddresses(addresses) {
      const next = new Set(addresses);
      const same = next.size === wanted.size && [...next].every((address) => wanted.has(address));
      if (same) return;
      const before = wanted;
      wanted = next;
      if (closed) return;
      for (const address of before) if (!next.has(address)) unsubscribe(address);
      for (const address of next) if (!before.has(address)) subscribe(address);
    },
    close() {
      if (closed && socket === null) return;
      closed = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
      const last = socket;
      socket = null;
      if (last === null) return;
      if (last.readyState === OPEN) {
        for (const id of subscribed.values()) {
          try {
            last.send(JSON.stringify({ jsonrpc: "2.0", id: nextId++, method: "accountUnsubscribe", params: [id] }));
          } catch {
            break;
          }
        }
      }
      subscribed.clear();
      bySubscription.clear();
      pending.clear();
      last.onopen = null;
      last.onmessage = null;
      last.onclose = null;
      last.onerror = null;
      try {
        last.close();
      } catch {
        // Closing a socket that is already closing has nothing left to do.
      }
    },
  };
}
