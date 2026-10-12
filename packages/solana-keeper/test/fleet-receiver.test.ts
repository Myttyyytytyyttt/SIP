// The dispatcher's webhook receiver (src/fleet-receiver.ts), against the
// recorded deliveries the doorbell was built on.
//
// THE DELIVERIES ARE REAL: test/fixtures/helius-raw-2026-09-23.json, five
// mainnet transactions on the owner's own wallet and vault, as Helius's RAW
// webhook delivers them. Nothing here calls Helius or a database: the store is a
// fake that maps addresses to vaults the way RING_SQL does (keeper_link, wallet
// or vault, live links only), and test/fleet-pg.test.ts runs the real statement
// on Postgres 16 over the same deliveries.
//
// THE ROUTE IS THE LEGACY ONE'S. The receiver is handed to httpHandler
// (src/status.ts) as its `hooks`, so the 403, the 200-before-processing and the
// 413 are the same code the legacy keeper serves; what is tested here is what
// `accepted`, `rejected` and `lost` do with Postgres behind them.

import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { Secret } from "@sip/solana-log";
import { describe, expect, it } from "vitest";
import {
  BELL_DELAY_MS,
  FULL_PASS_RETRY_MS,
  FleetReceiver,
  MAX_BELL_ADDRESSES,
  REJECT_FULL_PASS_COALESCE_MS,
  readDelivery,
  readPayload,
  type BellBatch,
  type BellWrite,
  type FleetBellStore,
} from "../src/fleet-receiver.js";
import { authorizationMatcher, decideHealth, httpHandler, type LeaderboardReply } from "../src/status.js";

const fixtures = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/helius-raw-2026-09-23.json", import.meta.url)), "utf8"),
) as Record<string, unknown[]>;
const signatureOf = (name: string): string => (fixtures[name]![0] as { transaction: { signatures: string[] } }).transaction.signatures[0]!;
const body = (name: string): Buffer => Buffer.from(JSON.stringify(fixtures[name]));

/** The owner's trading wallet and vault, as watched on 2026-09-23 (test/doorbell.test.ts). */
const WALLET = "9QX53J3Kbs8ogQirZq5iN11rucZAvgF4EKWw98QAkUSe";
const VAULT = "EFXK995PV49Qz8xPSYMEUDBU5AKRR466JkgsfuGak5iU";
/**
 * Two links that tell a wallet match from a vault match: the owner's WALLET
 * linked to another vault, and another wallet linked to the owner's VAULT.
 * Their other halves are address-shaped strings no delivery carries.
 */
const VAULT_OF_WALLET = "VauLtOfTheOwnersWa11et1111111111111111111111";
const WALLET_OF_VAULT = "Wa11etLinkedToTheOwnersVau1t1111111111111111";
const LINKS = [
  { link: "L1", wallet: WALLET, vault: VAULT_OF_WALLET, gone: false },
  { link: "L2", wallet: WALLET_OF_VAULT, vault: VAULT, gone: false },
];

const SECRET = "fleet-doorbell-secret-0123456789abcdef";
const T0 = Date.parse("2026-09-23T12:00:00Z");

/**
 * How many calls a "failing" fake fails before it answers. A store that failed
 * forever would turn a receiver that retries in a loop into a HANG, not a
 * failure: the loop runs on microtasks and starves vitest's own timeout timer
 * (seen, 2026-10-12, reverting the retry guard). Capped, such a loop ends, and
 * the call counts the tests assert say how many attempts it made.
 */
const FAIL_CAP = 25;

/**
 * The store as RING_SQL behaves: an address rings the vault of every live link
 * whose wallet or vault it is; a signature is echoed once. It records every call
 * and can be told to fail (FAIL_CAP times at most), or to hold a write open.
 */
class FakeStore implements FleetBellStore {
  readonly links = LINKS.map((link) => ({ ...link }));
  readonly rings: BellBatch[] = [];
  readonly rungVaults: string[][] = [];
  readonly requests: string[] = [];
  readonly echoed = new Set<string>();
  readonly intents = new Set<string>();
  ringFails = false;
  requestFails = false;
  ringCalls = 0;
  requestCalls = 0;
  /** When set, ring() waits for it: a write held in flight. */
  gate: Promise<void> | null = null;

  async ring(batch: BellBatch): Promise<BellWrite> {
    this.ringCalls += 1;
    if (this.gate !== null) await this.gate;
    if (this.ringFails && this.ringCalls <= FAIL_CAP) throw new Error("connect ECONNREFUSED 127.0.0.1:5432");
    this.rings.push(batch);
    const addresses = new Set(batch.addresses);
    const vaults = [...new Set(this.links.filter((l) => !l.gone && (addresses.has(l.wallet) || addresses.has(l.vault))).map((l) => l.vault))].sort();
    this.rungVaults.push(vaults);
    let echoes = 0;
    for (const signature of batch.signatures) {
      if (this.intents.has(signature) && !this.echoed.has(signature)) {
        this.echoed.add(signature);
        echoes += 1;
      }
    }
    return { vaults: vaults.length, echoes };
  }

  async requestFullPass(reason: string): Promise<void> {
    this.requestCalls += 1;
    if (this.requestFails && this.requestCalls <= FAIL_CAP) throw new Error("connect ECONNREFUSED 127.0.0.1:5432");
    this.requests.push(reason);
  }
}

function setup(store = new FakeStore()) {
  let now = T0;
  const scheduled: { run: () => void; ms: number }[] = [];
  const logs: { level: string; message: string }[] = [];
  const receiver = new FleetReceiver({
    store,
    authorized: authorizationMatcher(new Secret(SECRET, "doorbellSecret")),
    log: (level, message) => logs.push({ level, message }),
    now: () => now,
    schedule: (run, ms) => scheduled.push({ run, ms }),
  });
  return {
    store,
    receiver,
    scheduled,
    logs,
    at: (ms: number) => {
      now = ms;
    },
  };
}

// ── the fake HTTP pair, as test/status.test.ts drives httpHandler ────────────

function post(headers: Record<string, string>): IncomingMessage & { send(chunks: readonly (string | Buffer)[]): void } {
  const request = new EventEmitter() as IncomingMessage & { send(chunks: readonly (string | Buffer)[]): void };
  Object.assign(request, { method: "POST", url: "/hooks/helius", headers });
  request.resume = function () {
    return this;
  };
  request.send = (chunks) => {
    for (const chunk of chunks) request.emit("data", Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    request.emit("end");
  };
  return request;
}

function answer(): ServerResponse & { body: string } {
  const response = {
    statusCode: 200,
    body: "",
    headersSent: false,
    setHeader() {
      return this;
    },
    end(chunk?: string) {
      this.body = chunk ?? "";
      this.headersSent = true;
    },
  };
  return response as unknown as ServerResponse & { body: string };
}

const healthy = () => decideHealth({ now: 0, startedAt: 0, lastProgressAt: 0, sweepMs: 60_000 });
const noBoard = (): LeaderboardReply => ({ unavailable: "not on a dispatcher replica" });
const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("reading a recorded delivery", () => {
  it("finds the wallet and the vault each one touched, by shape — the deposit names the vault only as a token balance's owner", () => {
    const cases: [string, string[]][] = [
      ["usdcDepositToVault", [VAULT]],
      ["axiomTradeV1", [WALLET]],
      ["keeperSettle", [WALLET, VAULT]],
      ["solDepositToVault", [VAULT]],
      ["keeperConvertV0", [VAULT]],
    ];
    for (const [name, touched] of cases) {
      const delivery = readDelivery(body(name).toString("utf8"));
      expect(delivery.lost, name).toBeNull();
      expect(delivery.transactions, name).toBe(1);
      expect(delivery.signatures, name).toEqual([signatureOf(name)]);
      for (const address of touched) expect(delivery.addresses, `${name} names ${address}`).toContain(address);
      const untouched = [WALLET, VAULT].filter((address) => !touched.includes(address));
      for (const address of untouched) expect(delivery.addresses, `${name} does not name ${address}`).not.toContain(address);
      // DISTINCT: the convert names the vault five times and is one address.
      expect(new Set(delivery.addresses).size, name).toBe(delivery.addresses.length);
      // A SIGNATURE IS NOT ADDRESS-SHAPED: 64 bytes never pass for a 32-byte key.
      expect(delivery.addresses, name).not.toContain(signatureOf(name));
    }
  });

  it("counts only what looks like a transaction, and a body that is not JSON is lost, not thrown", () => {
    expect(readPayload([{}]).transactions).toBe(0);
    expect(readPayload([{ transaction: { signatures: ["s"] } }]).transactions).toBe(0);
    expect(readPayload([{ slot: 1, signature: "enhanced" }]).signatures).toEqual(["enhanced"]);
    const garbage = readDelivery("{not json");
    expect(garbage.lost).toBe("a delivery that is not JSON was not read");
    expect(garbage.addresses).toEqual([]);
  });

  it("refuses to ring piecemeal past the address bound: the delivery is lost and owes a full pass", () => {
    const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    const address = (i: number): string => {
      let s = "";
      for (let n = i, k = 0; k < 8; k += 1, n = Math.floor(n / 58)) s += ALPHABET[n % 58];
      return `${"1".repeat(32)}${s}`;
    };
    const many = Array.from({ length: MAX_BELL_ADDRESSES + 1 }, (_, i) => address(i));
    const delivery = readPayload([{ slot: 1, signature: "s", accounts: many }]);
    expect(delivery.lost).toContain(`more than ${MAX_BELL_ADDRESSES} distinct addresses`);
    expect(delivery.addresses.length).toBe(MAX_BELL_ADDRESSES);
  });
});

describe("the receiver behind the legacy route", () => {
  it("answers 200 before it writes, then rings exactly the vaults of the links each recorded delivery touched", async () => {
    const cases: [string, string[]][] = [
      ["usdcDepositToVault", [VAULT]],
      ["axiomTradeV1", [VAULT_OF_WALLET]],
      ["keeperSettle", [VAULT, VAULT_OF_WALLET]],
      ["solDepositToVault", [VAULT]],
      ["keeperConvertV0", [VAULT]],
    ];
    for (const [name, vaults] of cases) {
      const { store, receiver } = setup();
      const handler = httpHandler(() => "{}", healthy, noBoard, receiver.route());
      const request = post({ authorization: SECRET });
      const response = answer();
      handler(request, response);
      request.send([body(name)]);
      expect(response.statusCode, name).toBe(200);
      expect(response.body, name).toBe("{}");
      expect(store.ringCalls, `${name}: nothing written before the reply`).toBe(0);
      await tick();
      await receiver.idle();
      expect(store.rungVaults, name).toEqual([[...vaults].sort()]);
      expect(store.rings[0]!.bellDelayMs, name).toBe(BELL_DELAY_MS);
      expect(store.requests, `${name}: a delivery read whole owes no full pass`).toEqual([]);
      expect(receiver.status().authConfirmed, name).toBe(true);
    }
  });

  it("rings nothing for a link that is gone, and marks the keeper's own settle echoed once", async () => {
    const { store, receiver } = setup();
    store.links[0]!.gone = true; // WALLET's link closed: the Axiom trade rings nobody
    store.intents.add(signatureOf("keeperSettle"));
    receiver.accept(body("axiomTradeV1"));
    await receiver.idle();
    expect(store.rungVaults).toEqual([[]]);
    receiver.accept(body("keeperSettle"));
    await receiver.idle();
    receiver.accept(body("keeperSettle")); // Helius never duplicated one (2026-09-23), but a replay must not count twice
    await receiver.idle();
    expect(receiver.status().echoesMarked).toBe(1);
    expect(store.echoed.has(signatureOf("keeperSettle"))).toBe(true);
  });

  it("refuses a wrong header 403 and, before the webhook was ever heard, asks for a full pass", async () => {
    const { store, receiver } = setup();
    const handler = httpHandler(() => "{}", healthy, noBoard, receiver.route());
    const response = answer();
    const request = post({ authorization: "an old secret" });
    handler(request, response);
    expect(response.statusCode).toBe(403);
    await receiver.idle();
    expect(store.requests).toEqual(["a delivery was refused 403 before this replica knew the webhook sends this secret; Helius does not resend it"]);
    expect(store.ringCalls).toBe(0);
  });

  it("takes a 403 after an authenticated transaction for a stranger: no full pass", async () => {
    const { store, receiver } = setup();
    receiver.accept(body("solDepositToVault"));
    await receiver.idle();
    receiver.reject();
    await receiver.idle();
    expect(store.requests).toEqual([]);
    expect(receiver.status().rejected).toBe(1);
  });

  it("is not confirmed by an authenticated body that names no transaction", async () => {
    const { store, receiver } = setup();
    receiver.accept(Buffer.from("[{}]"));
    await receiver.idle();
    receiver.reject();
    await receiver.idle();
    expect(store.requests).toHaveLength(1);
    expect(receiver.status().authConfirmed).toBe(false);
  });

  it("counts for the webhook sync as the legacy doorbell does: transactions accepted, 403s, and 403s since the last accepted one", async () => {
    const { receiver } = setup();
    receiver.reject();
    receiver.reject();
    expect(receiver.deliveryCounts()).toEqual({ accepted: 0, rejected: 2, rejectedSinceAccepted: 2 });
    receiver.accept(body("solDepositToVault"));
    receiver.accept(Buffer.from("[{}]"));
    expect(receiver.deliveryCounts()).toEqual({ accepted: 1, rejected: 2, rejectedSinceAccepted: 0 });
    receiver.reject();
    expect(receiver.deliveryCounts()).toEqual({ accepted: 1, rejected: 3, rejectedSinceAccepted: 1 });
    await receiver.idle();
  });

  it("is confirmed by the webhook sync's word, as the legacy doorbell is", async () => {
    const { store, receiver } = setup();
    receiver.confirmAuthorization();
    receiver.reject();
    await receiver.idle();
    expect(store.requests).toEqual([]);
  });

  it("asks once for Helius's four answers to one delivery (one 403 and three retries a second apart), and again after the window", async () => {
    const { store, receiver, at } = setup();
    for (const ms of [0, 1_000, 2_000, 3_000]) {
      at(T0 + ms);
      receiver.reject();
    }
    await receiver.idle();
    expect(store.requests).toHaveLength(1);
    expect(receiver.status().rejectedCoalesced).toBe(3);
    at(T0 + REJECT_FULL_PASS_COALESCE_MS);
    receiver.reject();
    await receiver.idle();
    expect(store.requests).toHaveLength(2);
  });

  it("asks for a full pass for a delivery it could not read: not JSON, or refused 413", async () => {
    const { store, receiver } = setup();
    receiver.accept(Buffer.from("{not json"));
    await receiver.idle();
    expect(store.requests).toEqual(["a delivery that is not JSON was not read"]);
    receiver.lose("a delivery over 4194304 bytes was refused");
    await receiver.idle();
    expect(store.requests[1]).toBe("a delivery over 4194304 bytes was refused");
    expect(receiver.status().lost).toBe(2);
  });
});

describe("when Postgres does not take the bell", () => {
  it("turns a failed bell write into a full-pass request: the scheduler must not read the silence as nothing", async () => {
    const { store, receiver } = setup();
    store.ringFails = true;
    receiver.accept(body("axiomTradeV1"));
    await receiver.idle();
    expect(store.requests).toHaveLength(1);
    expect(store.requests[0]).toMatch(/^a bell write failed \(Error: connect ECONNREFUSED/);
    const status = receiver.status();
    expect(status.writeFailures).toBe(1);
    expect(status.fullPassRequests).toBe(1);
    expect(status.fullPassOwed).toBeNull();
  });

  it("keeps the request when that fails too, retries it on a timer — once, not in a loop — and writes it when Postgres is back", async () => {
    const { store, receiver, scheduled } = setup();
    store.ringFails = true;
    store.requestFails = true;
    receiver.accept(body("axiomTradeV1"));
    await receiver.idle();
    // ONE ATTEMPT EACH, AND THEN QUIET: a tight retry would be a loop against a
    // database that is down, and idle() above would never have returned.
    expect(store.ringCalls).toBe(1);
    expect(store.requestCalls).toBe(1);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]!.ms).toBe(FULL_PASS_RETRY_MS);
    expect(receiver.status().fullPassOwed).toMatch(/^a bell write failed/);

    store.ringFails = false;
    store.requestFails = false;
    scheduled[0]!.run();
    await receiver.idle();
    expect(store.requests).toHaveLength(1);
    expect(store.requests[0]).toMatch(/^a bell write failed/);
    expect(receiver.status().fullPassOwed).toBeNull();
    expect(scheduled).toHaveLength(1);
  });

  it("carries an owed request with the next delivery, before the timer", async () => {
    const { store, receiver, scheduled } = setup();
    store.requestFails = true;
    receiver.lose("oversize");
    await receiver.idle();
    expect(scheduled).toHaveLength(1);
    store.requestFails = false;
    receiver.accept(body("solDepositToVault"));
    await receiver.idle();
    expect(store.rungVaults).toEqual([[VAULT]]);
    expect(store.requests).toEqual(["oversize"]);
  });
});

describe("one write in flight per replica", () => {
  it("merges the deliveries that arrive during a write into the next one", async () => {
    const { store, receiver } = setup();
    let release!: () => void;
    store.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    receiver.accept(body("axiomTradeV1"));
    await tick();
    receiver.accept(body("usdcDepositToVault"));
    receiver.accept(body("solDepositToVault"));
    receiver.accept(body("keeperConvertV0"));
    expect(store.ringCalls).toBe(1);
    expect(receiver.status().pending.signatures).toBe(3);
    store.gate = null;
    release();
    await receiver.idle();
    expect(store.ringCalls).toBe(2);
    expect(store.rings[1]!.signatures).toHaveLength(3);
    expect(store.rungVaults).toEqual([[VAULT_OF_WALLET], [VAULT]]);
  });

  it("drops a merged batch past the bound for a full pass instead of ringing part of it", async () => {
    const { store, receiver } = setup();
    let release!: () => void;
    store.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    receiver.accept(body("axiomTradeV1"));
    await tick();
    const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    const half = (offset: number) =>
      Array.from({ length: MAX_BELL_ADDRESSES / 2 + 1 }, (_, i) => {
        let s = "";
        for (let n = i + offset, k = 0; k < 8; k += 1, n = Math.floor(n / 58)) s += ALPHABET[n % 58];
        return `${"2".repeat(32)}${s}`;
      });
    receiver.accept(Buffer.from(JSON.stringify([{ slot: 1, signature: "a", accounts: half(0) }])));
    receiver.accept(Buffer.from(JSON.stringify([{ slot: 1, signature: "b", accounts: half(MAX_BELL_ADDRESSES) }])));
    expect(receiver.status().pending.addresses).toBe(0);
    store.gate = null;
    release();
    await receiver.idle();
    expect(store.ringCalls).toBe(1);
    expect(store.requests).toHaveLength(1);
    expect(store.requests[0]).toContain("more deliveries arrived during one bell write than one write carries");
  });
});
