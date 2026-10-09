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
 * the slow retry and a resubscribe on a changed set would all have to be
 * built around it anyway, and a test would have to fake its transport
 * instead of a WebSocket. What this needs of the protocol is four messages
 * (subscribe, its answer, the notification, unsubscribe), so the socket
 * itself is the smaller thing to own, and it takes a fake in a test.
 *
 * ENCODING "base64": the page reads only the notification's slot, never the
 * data, so the encoding that costs least to produce and to carry is the one
 * that does no parsing (jsonParsed) and no extra work (base58, which the node
 * also refuses past 128 bytes; zstd, which pays a frame on 165 bytes).
 *
 * IT PINGS. A public endpoint may close a silent socket: measured 2026-10-09
 * FROM NODE on wss://api.mainnet-beta.solana.com, an idle socket — subscribed
 * to a quiet account or to nothing — was closed with 1006 at about 60 s, and
 * the server sent no ping frame of its own; one that sent the text frame
 * {"jsonrpc":"2.0","method":"ping"} every 30 s stayed open for the whole probe.
 * So an open socket sends that every PING_MS, as web3.js and @solana/kit's own
 * autoping do. PublicNode, the default since, answers each ping with result
 * null and no id (onMessage counts it as a sign of life and drops it).
 *
 * THAT NODE MEASUREMENT COULD NOT SEE WHAT BROKE IT. Node sends no Origin
 * header; every browser does, and api.mainnet-beta answered the site's Origin
 * — and every other one tried outside solana.com — with 403 (measured the same
 * day, with curl and from a real Chromium pane on the production origin). So
 * the push never opened in a browser: this socket used up its waits in about
 * 53 s and gave up silently, and every user was left on the poll. The default
 * moved to PublicNode (solana-core public-ws-url.mjs), and a candidate endpoint
 * can be proven WITH an Origin before it ships (scripts/check-public-ws.mts).
 *
 * IT NEVER GIVES UP (owner, 2026-10-09: "todo lo que pase se muestre
 * rápidamente"). A socket that closes reconnects after RECONNECT_MS (1 s, 2 s,
 * 5 s, 15 s, 30 s), and past the last wait every SLOW_RECONNECT_MS for as long
 * as the page lives: a network down for a minute — a lid closed, a Wi-Fi
 * switch, a VPN — used to cost the push for the life of the tab. The count
 * starts again only after a socket PROVED it worked: STABLE_MS between its
 * first confirmed subscription and the last good frame it delivered, so a
 * server that confirms and then drops cannot hold the page in a one-second
 * loop, and one closed after a long healthy stretch is not punished for it.
 * reconnect() is the page's way back: on returning to the tab, on focus, on
 * `online`, it connects NOW with the count reset — unless the open socket is
 * demonstrably alive. A reconnect that confirms a subscription calls onResync:
 * whatever changed while it was down rang nobody, so one read is owed. Every
 * change of state reaches onState, so the page can say whether it is live.
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

/** Waits before each reconnect, in order; past the last, SLOW_RECONNECT_MS for as long as the page lives. */
export const RECONNECT_MS: readonly number[] = [1_000, 2_000, 5_000, 15_000, 30_000];

/**
 * The wait between attempts once RECONNECT_MS is used up: one handshake a
 * minute against an endpoint that keeps refusing, which costs the keyed RPC
 * nothing, and a page that comes back by itself when the network does. The
 * page's own events (reconnect()) do not wait for it.
 */
export const SLOW_RECONNECT_MS = 60_000;

/** The keepalive's beat: half the ~60 s after which the public endpoint closed a silent socket. */
export const PING_MS = 30_000;

/** The text keepalive: a JSON-RPC notification the endpoint takes, and answers or not. */
const PING = JSON.stringify({ jsonrpc: "2.0", method: "ping" });

/**
 * HOW MUCH WORKING A SOCKET MUST HAVE SHOWN before the reconnect count starts
 * again: the time from its first confirmed subscription to the LAST GOOD FRAME
 * it delivered (an answer, a notification, a ping's reply) — two beats of the
 * keepalive. Measured to the last frame rather than to the close, because a
 * server that confirms and goes quiet until it drops has shown nothing; and no
 * longer one five-minute stretch, which a hidden tab — its pings possibly
 * throttled to one a minute — might never complete, so that every close there
 * counted as a failure (diagnosis 10-09, D5, inferred rather than measured).
 */
export const STABLE_MS = 2 * PING_MS;

/**
 * An open socket whose endpoint has answered a ping, and that has delivered
 * nothing for this long, is taken as dead when the page asks to reconnect: a
 * half-open connection, after a lid was closed, can go minutes without a close
 * event. Three beats, because a long-hidden tab's timers can be aligned to the
 * minute and its pings go out late. An endpoint that never answers pings is
 * never judged this way: its silence proves nothing.
 */
export const LIVELY_MS = 3 * PING_MS;

/**
 * What the page can say about the push: "connecting" (a socket is being opened,
 * or it is open with nothing confirmed yet), "live" (at least one subscription
 * confirmed on the open socket), "off" (closed, waiting for the next attempt).
 */
export type SocketState = "connecting" | "live" | "off";

export interface ChainWatch {
  /** The accounts to watch from now on; the same set is a no-op, a different one subscribes and unsubscribes the difference. */
  setAddresses(addresses: readonly string[]): void;
  /**
   * Try NOW, with the reconnect count started again: the tab is looked at, the
   * window took focus, the network came back. A socket that is opening is left
   * to finish, and an open one is left alone unless it is demonstrably dead
   * (LIVELY_MS). Nothing after close().
   */
  reconnect(): void;
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
  /** Each change of SocketState, once per change; never after close(). */
  readonly onState?: (state: SocketState) => void;
  readonly open: SocketFactory;
  readonly setTimer?: (run: () => void, ms: number) => unknown;
  readonly clearTimer?: (timer: unknown) => void;
  /** This browser's clock, for STABLE_MS and LIVELY_MS. */
  readonly now?: () => number;
}

interface Pending {
  readonly address: string;
  readonly kind: "subscribe" | "unsubscribe";
}

export function watchAccounts(options: WatchOptions): ChainWatch {
  const setTimer = options.setTimer ?? ((run: () => void, ms: number) => setTimeout(run, ms));
  const clearTimer = options.clearTimer ?? ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const now = options.now ?? Date.now;

  let wanted = new Set(options.addresses);
  let socket: SocketLike | null = null;
  let closed = false;
  let failures = 0;
  let timer: unknown = null;
  let pingTimer: unknown = null;
  /** Whether this socket has ever confirmed a subscription: a reconnect after one owes a read. */
  let everConfirmed = false;
  /** When this socket confirmed its first subscription; null before it has. */
  let confirmedAt: number | null = null;
  /** When this socket last delivered a good frame (anything parsed that carried no error); null before it has. */
  let lastFrameAt: number | null = null;
  /** Whether this socket's endpoint has answered a ping: only then does its silence say anything (LIVELY_MS). */
  let answersPings = false;
  let state: SocketState | null = null;
  let nextId = 1;
  const pending = new Map<number, Pending>();
  /** address → subscription id, for this socket only. */
  const subscribed = new Map<string, number>();
  const bySubscription = new Map<number, string>();

  // Once per change, and never after close(): the caller that closed is gone.
  const setState = (next: SocketState): void => {
    if (closed || state === next) return;
    state = next;
    options.onState?.(next);
  };

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
    const body = message as { id?: unknown; result?: unknown; method?: unknown; params?: unknown; error?: unknown };
    // A frame that carried no error is the server showing it is there, whatever it says.
    if (body.error === undefined) lastFrameAt = now();

    if (body.method === "accountNotification") {
      const params = body.params as { subscription?: unknown; result?: { context?: { slot?: unknown } } } | undefined;
      const id = params?.subscription;
      const slot = params?.result?.context?.slot;
      if (typeof id !== "number" || typeof slot !== "number" || !Number.isSafeInteger(slot)) return;
      const address = bySubscription.get(id);
      if (address !== undefined) options.onChange(address, slot);
      return;
    }

    // A result with no id (absent or null) and no method: the ping's reply, PublicNode's shape. Dropped, but noted.
    if ((body.id === undefined || body.id === null) && body.method === undefined && "result" in body) {
      answersPings = true;
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
    if (confirmedAt === null) {
      confirmedAt = now();
      setState("live");
      if (everConfirmed) options.onResync?.();
      everConfirmed = true;
    }
  };

  const stopPing = (): void => {
    if (pingTimer !== null) clearTimer(pingTimer);
    pingTimer = null;
  };

  const ping = (of: SocketLike): void => {
    pingTimer = setTimer(() => {
      pingTimer = null;
      if (socket !== of || of.readyState !== OPEN) return;
      try {
        of.send(PING);
      } catch {
        // A socket that cannot take a ping is about to close; close moves on.
      }
      ping(of);
    }, PING_MS);
  };

  /** Lets go of a socket without its close moving anything on: its handlers are taken off first. */
  const detach = (last: SocketLike): void => {
    last.onopen = null;
    last.onmessage = null;
    last.onclose = null;
    last.onerror = null;
    try {
      last.close();
    } catch {
      // Closing a socket that is already closing has nothing left to do.
    }
  };

  const connect = (): void => {
    if (closed) return;
    confirmedAt = null;
    lastFrameAt = null;
    answersPings = false;
    stopPing();
    pending.clear();
    subscribed.clear();
    bySubscription.clear();
    setState("connecting");
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
      stopPing();
      ping(next);
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
      stopPing();
      // Only a socket that proved it worked starts the count again (STABLE_MS).
      if (confirmedAt !== null && lastFrameAt !== null && lastFrameAt - confirmedAt >= STABLE_MS) failures = 0;
      retry();
    };
  };

  const retry = (): void => {
    if (closed) return;
    // Every close counts; onclose has already started the count again after a socket that proved itself.
    const wait = RECONNECT_MS[failures] ?? SLOW_RECONNECT_MS;
    failures = Math.min(failures + 1, RECONNECT_MS.length);
    setState("off");
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
    reconnect() {
      if (closed) return;
      failures = 0;
      if (socket !== null) {
        // Opening, or open and not shown dead: left alone — tearing a healthy
        // socket down on every focus would buy a resync read each time.
        const dead = socket.readyState === OPEN && answersPings && lastFrameAt !== null && now() - lastFrameAt > LIVELY_MS;
        if (!dead) return;
        const last = socket;
        socket = null;
        stopPing();
        detach(last);
      }
      if (timer !== null) clearTimer(timer);
      timer = null;
      connect();
    },
    close() {
      if (closed && socket === null) return;
      closed = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
      stopPing();
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
      detach(last);
    },
  };
}
