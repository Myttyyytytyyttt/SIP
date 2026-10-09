// The one WebSocket a live dashboard keeps open (src/lib/live-socket.ts), driven
// through a fake socket and a fake clock: what it sends, what it hears, how it
// comes back after a close, when it gives up, and that it leaves nothing behind.

import { describe, expect, it } from "vitest";

import { RECONNECT_MS, watchAccounts, type SocketLike } from "@/lib/live-socket";

class FakeSocket implements SocketLike {
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  readonly sent: { id: number; method: string; params: unknown[] }[] = [];
  closed = false;

  constructor(readonly url: string) {}

  send(data: string): void {
    this.sent.push(JSON.parse(data) as { id: number; method: string; params: unknown[] });
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
      ids.set(message.params[0] as string, next);
      this.answer(message.id, next);
      next += 1;
    }
    return ids;
  }
}

function harness(addresses: readonly string[] = ["WalletA", "Vault"]) {
  const sockets: FakeSocket[] = [];
  const timers: { run: () => void; ms: number; cleared: boolean }[] = [];
  const changes: [string, number][] = [];
  let resyncs = 0;
  let gaveUp = 0;
  const watch = watchAccounts({
    url: "wss://api.mainnet-beta.solana.com",
    addresses,
    onChange: (address, slot) => changes.push([address, slot]),
    onResync: () => (resyncs += 1),
    onGiveUp: () => (gaveUp += 1),
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
  const fire = (): number => {
    const timer = timers.find((entry) => !entry.cleared);
    if (timer === undefined) throw new Error("no timer armed");
    timer.cleared = true;
    timer.run();
    return timer.ms;
  };
  return { watch, sockets, timers, changes, fire, resyncs: () => resyncs, gaveUp: () => gaveUp, last: () => sockets[sockets.length - 1]! };
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
    expect(h.last().sent.slice(before).map((message) => [message.method, message.params[0]])).toEqual([
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
    h.last().answer(h.last().sent[0]!.id, 77);
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
    expect(h.last().sent.map((message) => message.params[0])).toEqual(["Vault"]);
    h.last().confirmAll(200);
    expect(h.resyncs()).toBe(1);
  });

  it("waits longer after each socket that confirmed nothing, and a confirmed one starts the count again", () => {
    const h = harness();
    const waits: number[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      h.last().drop();
      waits.push(h.fire());
    }
    expect(waits).toEqual(RECONNECT_MS.slice(0, 3));
    h.last().open();
    h.last().confirmAll();
    h.last().drop();
    expect(h.fire()).toBe(RECONNECT_MS[0]);
  });

  it("gives up quietly after RECONNECT_MS runs out, and opens nothing more", () => {
    const h = harness();
    for (const wait of RECONNECT_MS) {
      h.last().drop();
      expect(h.fire()).toBe(wait);
    }
    h.last().drop();
    expect(h.gaveUp()).toBe(1);
    expect(h.timers.filter((timer) => !timer.cleared)).toHaveLength(0);
    expect(h.sockets).toHaveLength(RECONNECT_MS.length + 1);
    expect(RECONNECT_MS).toEqual([1_000, 2_000, 5_000, 15_000, 30_000]);
  });

  it("treats a socket that cannot even be opened as a failure, not a crash", () => {
    let calls = 0;
    const timers: (() => void)[] = [];
    watchAccounts({
      url: "wss://x",
      addresses: ["A"],
      onChange: () => undefined,
      open: () => {
        calls += 1;
        throw new Error("blocked by CSP");
      },
      setTimer: (run) => timers.push(run),
      clearTimer: () => undefined,
    });
    expect(calls).toBe(1);
    expect(timers).toHaveLength(1);
  });
});

describe("closing", () => {
  it("unsubscribes, closes, and never reconnects", () => {
    const h = harness();
    h.last().open();
    const ids = h.last().confirmAll();
    const before = h.last().sent.length;
    h.watch.close();
    expect(h.last().sent.slice(before).map((message) => [message.method, message.params[0]])).toEqual([
      ["accountUnsubscribe", ids.get("WalletA")],
      ["accountUnsubscribe", ids.get("Vault")],
    ]);
    expect(h.last().closed).toBe(true);
    // A close event after our own close re-arms nothing, and a notification names nothing.
    h.last().onclose?.({});
    h.last().notify(ids.get("Vault")!, 1);
    expect(h.timers).toHaveLength(0);
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
