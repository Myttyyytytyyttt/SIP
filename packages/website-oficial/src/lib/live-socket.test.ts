// The one WebSocket a live dashboard keeps open (src/lib/live-socket.ts), driven
// through a fake socket and a fake clock: what it sends, what it hears, how it
// comes back after a close — for as long as the page lives — what it says of
// its state, and that it leaves nothing behind.

import { describe, expect, it } from "vitest";

import { LIVELY_MS, PING_MS, RECONNECT_MS, SLOW_RECONNECT_MS, STABLE_MS, watchAccounts, type SocketLike, type SocketState } from "@/lib/live-socket";

class FakeSocket implements SocketLike {
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  readonly sent: { id?: number; method: string; params?: unknown[] }[] = [];
  closed = false;

  constructor(readonly url: string) {}

  send(data: string): void {
    this.sent.push(JSON.parse(data) as { id?: number; method: string; params?: unknown[] });
  }
  close(): void {
    this.closed = true;
    this.readyState = 3;
  }
  // The server's side.
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  answer(id: number, result: unknown): void {
    this.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", id, result }) });
  }
  notify(subscription: number, slot: number): void {
    this.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", method: "accountNotification", params: { subscription, result: { context: { slot }, value: null } } }) });
  }
  /** PublicNode's reply to a ping: a result with no id. */
  pong(): void {
    this.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", result: null }) });
  }
  drop(): void {
    this.readyState = 3;
    this.onerror?.({});
    this.onclose?.({});
  }
  /** Confirms every subscribe sent so far with ids from `from` up, in order. */
  confirmAll(from = 100): Map<string, number> {
    const ids = new Map<string, number>();
    let next = from;
    for (const message of this.sent.filter((entry) => entry.method === "accountSubscribe")) {
      ids.set(message.params![0] as string, next);
      this.answer(message.id!, next);
      next += 1;
    }
    return ids;
  }
}

function harness(addresses: readonly string[] = ["WalletA", "Vault"]) {
  const sockets: FakeSocket[] = [];
  const timers: { run: () => void; ms: number; cleared: boolean }[] = [];
  const changes: [string, number][] = [];
  const clock = { now: 1_000_000 };
  let resyncs = 0;
  const states: SocketState[] = [];
  const watch = watchAccounts({
    url: "wss://api.mainnet-beta.solana.com",
    addresses,
    onChange: (address, slot) => changes.push([address, slot]),
    onResync: () => (resyncs += 1),
    onState: (state) => states.push(state),
    now: () => clock.now,
    open: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    setTimer: (run, ms) => {
      const timer = { run, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      (timer as { cleared: boolean }).cleared = true;
    },
  });
  /** Runs the first timer still armed — of `ms` when named. */
  const fire = (ms?: number): number => {
    const timer = timers.find((entry) => !entry.cleared && (ms === undefined || entry.ms === ms));
    if (timer === undefined) throw new Error("no timer armed");
    timer.cleared = true;
    timer.run();
    return timer.ms;
  };
  const armed = (): number[] => timers.filter((entry) => !entry.cleared).map((entry) => entry.ms);
  return { watch, sockets, timers, armed, clock, changes, fire, resyncs: () => resyncs, states, last: () => sockets[sockets.length - 1]! };
}

describe("subscribing", () => {
  it("opens one socket to the key-free endpoint and subscribes each address at confirmed, in base64, once open", () => {
    const h = harness();
    expect(h.sockets).toHaveLength(1);
    expect(h.last().url).toBe("wss://api.mainnet-beta.solana.com");
    expect(h.last().sent).toEqual([]);
    h.last().open();
    expect(h.last().sent.map((message) => [message.method, message.params])).toEqual([
      ["accountSubscribe", ["WalletA", { commitment: "confirmed", encoding: "base64" }]],
      ["accountSubscribe", ["Vault", { commitment: "confirmed", encoding: "base64" }]],
    ]);
  });

  it("names the account and the slot of each notification, and ignores what it did not subscribe to", () => {
    const h = harness();
    h.last().open();
    const ids = h.last().confirmAll();
    h.last().notify(ids.get("Vault")!, 4_321);
    h.last().notify(ids.get("WalletA")!, 4_322);
    h.last().notify(999, 4_323);
    h.last().onmessage?.({ data: "not json" });
    h.last().onmessage?.({ data: JSON.stringify({ method: "accountNotification", params: { subscription: ids.get("Vault"), result: { context: { slot: "x" } } } }) });
    expect(h.changes).toEqual([
      ["Vault", 4_321],
      ["WalletA", 4_322],
    ]);
  });
});

describe("a changed set of addresses", () => {
  it("subscribes what is new, unsubscribes what is gone, and does nothing for the same set", () => {
    const h = harness();
    h.last().open();
    const ids = h.last().confirmAll();
    const before = h.last().sent.length;
    h.watch.setAddresses(["Vault", "WalletA"]);
    expect(h.last().sent).toHaveLength(before);

    h.watch.setAddresses(["Vault", "WalletB"]);
    expect(h.last().sent.slice(before).map((message) => [message.method, message.params![0]])).toEqual([
      ["accountUnsubscribe", ids.get("WalletA")],
      ["accountSubscribe", "WalletB"],
    ]);
    // The old subscription's notifications no longer name anything.
    h.last().notify(ids.get("WalletA")!, 10);
    expect(h.changes).toEqual([]);
  });

  it("lets go of a subscription confirmed for an address dropped while it was being asked for", () => {
    const h = harness(["WalletA"]);
    h.last().open();
    h.watch.setAddresses([]);
    h.last().answer(h.last().sent[0]!.id!, 77);
    expect(h.last().sent.at(-1)).toMatchObject({ method: "accountUnsubscribe", params: [77] });
    h.last().notify(77, 5);
    expect(h.changes).toEqual([]);
  });
});

describe("reconnecting", () => {
  it("comes back after a close with backoff, resubscribes the current set, and owes one read for the gap", () => {
    const h = harness();
    h.last().open();
    h.last().confirmAll();
    expect(h.resyncs()).toBe(0);
    h.last().drop();
    expect(h.fire()).toBe(RECONNECT_MS[0]);
    expect(h.sockets).toHaveLength(2);
    h.watch.setAddresses(["Vault"]);
    h.last().open();
    expect(h.last().sent.map((message) => message.params![0])).toEqual(["Vault"]);
    h.last().confirmAll(200);
    expect(h.resyncs()).toBe(1);
  });

  it("waits longer after each socket that confirmed nothing, and one that WORKED for STABLE_MS starts the count again", () => {
    expect(STABLE_MS).toBe(2 * PING_MS);
    const h = harness();
    const waits: number[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      h.last().drop();
      waits.push(h.fire());
    }
    expect(waits).toEqual(RECONNECT_MS.slice(0, 3));
    h.last().open();
    const ids = h.last().confirmAll();
    // A ping answered, then a notification STABLE_MS after the confirmation: it worked.
    h.clock.now += PING_MS;
    h.last().pong();
    h.clock.now += STABLE_MS - PING_MS;
    h.last().notify(ids.get("Vault")!, 77);
    h.clock.now += 5 * 60_000;
    h.last().drop();
    expect(h.fire()).toBe(RECONNECT_MS[0]);
  });

  it("time alone is no proof: a socket that confirmed and then said nothing until it closed does not start the count again", () => {
    // Diagnosis 10-09 (D5): the old rule counted wall time from the first confirmation, so a socket silent for five minutes "had stayed up".
    const h = harness();
    h.last().drop();
    expect(h.fire()).toBe(RECONNECT_MS[0]);
    h.last().open();
    h.last().confirmAll();
    h.clock.now += 10 * STABLE_MS;
    h.last().drop();
    expect(h.fire()).toBe(RECONNECT_MS[1]);
  });

  it("an error frame is no sign of life", () => {
    const h = harness();
    h.last().drop();
    h.fire();
    h.last().open();
    h.last().confirmAll();
    h.clock.now += STABLE_MS;
    h.last().onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", error: { code: 429, message: "slow down" } }) });
    h.last().drop();
    expect(h.fire()).toBe(RECONNECT_MS[1]);
  });

  it("a server that confirms and then drops cannot hold it in a one-second loop: a brief socket does not reset the count", () => {
    // Review 2026-10-09: 20 confirm→drop cycles all waited 1 s, resynced 20 times and never gave up.
    const h = harness();
    const waits: number[] = [];
    for (let cycle = 0; cycle < RECONNECT_MS.length; cycle += 1) {
      h.last().open();
      h.last().confirmAll(100 + cycle * 10);
      h.clock.now += STABLE_MS - 1;
      h.last().pong();
      h.last().drop();
      waits.push(h.fire(RECONNECT_MS[cycle]));
    }
    expect(waits).toEqual([...RECONNECT_MS]);
    h.last().open();
    h.last().confirmAll(900);
    h.last().drop();
    // Past the list it slows to one attempt a minute, and keeps coming back.
    expect(h.armed()).toEqual([SLOW_RECONNECT_MS]);
  });

  it("never gives up: past RECONNECT_MS it tries every SLOW_RECONNECT_MS, for as long as the page lives", () => {
    // Diagnosis 10-09: six refused handshakes in about 53 s ended the push for the life of the tab, silently.
    expect(SLOW_RECONNECT_MS).toBe(60_000);
    const h = harness();
    const waits: number[] = [];
    for (let attempt = 0; attempt < RECONNECT_MS.length + 20; attempt += 1) {
      h.last().drop();
      waits.push(h.fire());
    }
    expect(waits.slice(0, RECONNECT_MS.length)).toEqual([...RECONNECT_MS]);
    expect(new Set(waits.slice(RECONNECT_MS.length))).toEqual(new Set([SLOW_RECONNECT_MS]));
    expect(h.sockets).toHaveLength(RECONNECT_MS.length + 21);
    // And the last socket works like the first.
    h.last().open();
    h.last().confirmAll();
    expect(h.states.at(-1)).toBe("live");
    expect(RECONNECT_MS).toEqual([1_000, 2_000, 5_000, 15_000, 30_000]);
  });

  it("treats a socket that cannot even be opened as a failure, not a crash", () => {
    let calls = 0;
    const timers: (() => void)[] = [];
    const states: SocketState[] = [];
    watchAccounts({
      url: "wss://x",
      addresses: ["A"],
      onChange: () => undefined,
      onState: (state) => states.push(state),
      open: () => {
        calls += 1;
        throw new Error("blocked by CSP");
      },
      setTimer: (run) => timers.push(run),
      clearTimer: () => undefined,
    });
    expect(calls).toBe(1);
    expect(timers).toHaveLength(1);
    expect(states).toEqual(["connecting", "off"]);
  });
});

/**
 * WHAT THE PAGE CAN SAY (owner, 10-09: "necesito que la página sea live"):
 * connecting, live once a subscription is confirmed, off while it waits for
 * the next attempt — once per change, and nothing after close().
 */
describe("its state", () => {
  it("is connecting, then live at the first confirmed subscription, then off while it waits, then connecting again", () => {
    const h = harness();
    expect(h.states).toEqual(["connecting"]);
    h.last().open();
    expect(h.states).toEqual(["connecting"]);
    h.last().confirmAll();
    expect(h.states).toEqual(["connecting", "live"]);
    h.last().drop();
    expect(h.states).toEqual(["connecting", "live", "off"]);
    h.fire();
    h.last().open();
    h.last().confirmAll(200);
    expect(h.states).toEqual(["connecting", "live", "off", "connecting", "live"]);
  });

  it("says each state once, however many subscriptions confirm or notifications arrive", () => {
    const h = harness(["A", "B", "C"]);
    h.last().open();
    const ids = h.last().confirmAll();
    h.last().notify(ids.get("A")!, 1);
    h.last().pong();
    expect(h.states).toEqual(["connecting", "live"]);
  });

  it("says nothing once closed: the caller that closed it is gone", () => {
    const h = harness();
    h.last().open();
    h.last().confirmAll();
    h.watch.close();
    h.last().onclose?.({});
    h.watch.reconnect();
    expect(h.states).toEqual(["connecting", "live"]);
  });
});

/**
 * THE PAGE'S WAY BACK (diagnosis 10-09, D2/D5): returning to the tab, focus
 * and `online` try NOW, with the count started again, instead of waiting out
 * a slow timer — and never tear down a socket that is working.
 */
describe("reconnect()", () => {
  it("connects at once when a socket is waiting to retry, with the count started again", () => {
    const h = harness();
    for (let attempt = 0; attempt < RECONNECT_MS.length + 2; attempt += 1) {
      h.last().drop();
      h.fire();
    }
    h.last().drop();
    expect(h.armed()).toEqual([SLOW_RECONNECT_MS]);
    const before = h.sockets.length;
    h.watch.reconnect();
    expect(h.sockets).toHaveLength(before + 1);
    // The slow timer is gone, not left to open a second socket.
    expect(h.armed()).toEqual([]);
    expect(h.states.at(-1)).toBe("connecting");
    // Started again: the next close waits the first wait.
    h.last().drop();
    expect(h.armed()).toEqual([RECONNECT_MS[0]]);
  });

  it("leaves a working socket alone — no new socket, no resync read — however often the window takes focus", () => {
    const h = harness();
    h.last().open();
    h.last().confirmAll();
    h.clock.now += PING_MS;
    h.last().pong();
    for (let focus = 0; focus < 5; focus += 1) h.watch.reconnect();
    expect(h.sockets).toHaveLength(1);
    expect(h.resyncs()).toBe(0);
  });

  it("leaves a socket that is still opening to finish", () => {
    const h = harness();
    h.watch.reconnect();
    expect(h.sockets).toHaveLength(1);
  });

  it("replaces an open socket shown dead: its endpoint answers pings and it has said nothing for LIVELY_MS", () => {
    expect(LIVELY_MS).toBe(3 * PING_MS);
    const h = harness();
    h.last().open();
    h.last().confirmAll();
    h.last().pong();
    const dead = h.last();
    h.clock.now += LIVELY_MS + 1;
    h.watch.reconnect();
    expect(h.sockets).toHaveLength(2);
    expect(dead.closed).toBe(true);
    // The dead one's late close moves nothing on.
    dead.onclose?.({});
    expect(h.armed()).toEqual([]);
    // The new one owes the read for the gap.
    h.last().open();
    h.last().confirmAll(300);
    expect(h.resyncs()).toBe(1);
  });

  it("does not judge a socket by its silence when its endpoint never answered a ping", () => {
    const h = harness();
    h.last().open();
    h.last().confirmAll();
    h.clock.now += 10 * LIVELY_MS;
    h.watch.reconnect();
    expect(h.sockets).toHaveLength(1);
  });

  it("does nothing after close()", () => {
    const h = harness();
    h.last().drop();
    h.watch.close();
    h.watch.reconnect();
    expect(h.sockets).toHaveLength(1);
    expect(h.armed()).toEqual([]);
  });
});

describe("closing", () => {
  it("unsubscribes, closes, and never reconnects", () => {
    const h = harness();
    h.last().open();
    const ids = h.last().confirmAll();
    const before = h.last().sent.length;
    h.watch.close();
    expect(h.last().sent.slice(before).map((message) => [message.method, message.params![0]])).toEqual([
      ["accountUnsubscribe", ids.get("WalletA")],
      ["accountUnsubscribe", ids.get("Vault")],
    ]);
    expect(h.last().closed).toBe(true);
    // A close event after our own close re-arms nothing, and a notification names nothing.
    h.last().onclose?.({});
    h.last().notify(ids.get("Vault")!, 1);
    // The only timer ever armed was the keepalive, and it is cleared.
    expect(h.timers.map((timer) => timer.ms)).toEqual([PING_MS]);
    expect(h.armed()).toEqual([]);
    expect(h.changes).toEqual([]);
    expect(h.sockets).toHaveLength(1);
  });

  it("cancels a reconnect that was waiting, and opens nothing after", () => {
    const h = harness();
    h.last().drop();
    expect(h.timers.filter((timer) => !timer.cleared)).toHaveLength(1);
    h.watch.close();
    expect(h.timers.filter((timer) => !timer.cleared)).toHaveLength(0);
    expect(h.sockets).toHaveLength(1);
  });

  it("closes a socket that never opened without sending into it", () => {
    const h = harness();
    h.watch.close();
    expect(h.last().sent).toEqual([]);
    expect(h.last().closed).toBe(true);
  });
});

/**
 * THE PUBLIC ENDPOINT CLOSES A SILENT SOCKET (review 2026-10-09, measured on
 * wss://api.mainnet-beta.solana.com): an idle socket, subscribed or not, was
 * closed with 1006 at about 60 s; one sending {"jsonrpc":"2.0","method":"ping"}
 * every 30 s stayed open for the whole 150 s probe. So the socket pings.
 */
describe("keeping a quiet socket open", () => {
  it("sends a text ping every PING_MS while open, from the moment it opens", () => {
    expect(PING_MS).toBe(30_000);
    const h = harness();
    expect(h.armed()).toEqual([]);
    h.last().open();
    h.last().confirmAll();
    const before = h.last().sent.length;
    for (let beat = 0; beat < 4; beat += 1) h.fire(PING_MS);
    expect(h.last().sent.slice(before)).toEqual(Array.from({ length: 4 }, () => ({ jsonrpc: "2.0", method: "ping" })));
    expect(h.armed()).toEqual([PING_MS]);
    // Pinging is no change and no resync.
    expect(h.changes).toEqual([]);
    expect(h.resyncs()).toBe(0);
  });

  it("pings an open socket that has nothing subscribed yet, too: the endpoint closes that one as well", () => {
    const h = harness([]);
    h.last().open();
    h.fire(PING_MS);
    expect(h.last().sent).toEqual([{ jsonrpc: "2.0", method: "ping" }]);
  });

  it("stops pinging when the socket drops, and pings the next one", () => {
    const h = harness();
    h.last().open();
    h.last().drop();
    expect(h.armed()).toEqual([RECONNECT_MS[0]]);
    h.fire();
    h.last().open();
    expect(h.armed()).toEqual([PING_MS]);
  });

  it("stops pinging on close", () => {
    const h = harness();
    h.last().open();
    h.watch.close();
    expect(h.armed()).toEqual([]);
  });
});
