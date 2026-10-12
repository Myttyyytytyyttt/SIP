// The `privy-address` cut (src/privy-address-book.ts, and its two reads in
// src/privy-signer.ts): what it asks Privy, sweep after sweep, and that what it
// hands the signer resolves every wallet exactly as today's per-sweep index does.
//
// No network and no credential: the source is either injected (the book's own
// cases) or the real SDK over an in-process fetch (the two reads), as
// test/privy-signer.test.ts does.

import { Secret } from "@sip/solana-log";
import { Keypair, Transaction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import {
  PRIVY_SIGNABLE_RECHECK_MS,
  PRIVY_UNSIGNABLE_RECHECK_MS,
  PrivyAddressBook,
  confirmedSubmitter,
} from "../src/privy-address-book.js";
import type { SignerSeat } from "../src/privy-policy.js";
import {
  PRIVY_API_URL,
  SeatWithdrawnError,
  createPrivySolanaSigner,
  privyAddressSource,
  seatsSignable,
  type PrivyAddressSource,
  type PrivySolanaConfig,
  type PrivyWalletEntry,
  type SolanaWalletSubmitter,
} from "../src/privy-signer.js";

const SIGNER_ID = "keeperQuorum000000000001";
const POLICY_ID = "keeperPolicy00000000001";
const bounded: readonly SignerSeat[] = [{ signerId: SIGNER_ID, overridePolicyIds: [POLICY_ID] }];
const signable = (entry: PrivyWalletEntry): boolean => seatsSignable(entry.seats, SIGNER_ID, POLICY_ID);

const address = (): string => Keypair.generate().publicKey.toBase58();
const entry = (id: string, seats: readonly SignerSeat[] = bounded): PrivyWalletEntry => ({ walletId: id, seats });

/** An injected Privy: an app of `wallets`, counting every request the book makes. */
function fakePrivy(wallets: Map<string, PrivyWalletEntry>, pageSize = 100) {
  const asked = { listings: 0, pages: 0, lookups: [] as string[] };
  let failListing = false;
  let failLookup: ((address: string) => boolean) | null = null;
  const source: PrivyAddressSource = {
    async listAll(onPage) {
      asked.listings += 1;
      if (failListing) throw Object.assign(new Error("upstream"), { status: 503 });
      const all = [...wallets];
      for (let start = 0; start === 0 || start < all.length; start += pageSize) {
        asked.pages += 1;
        onPage();
      }
      return new Map(all);
    },
    async byAddress(wallet) {
      asked.lookups.push(wallet);
      if (failLookup?.(wallet)) throw Object.assign(new Error("rate limited"), { status: 429 });
      return wallets.get(wallet) ?? null;
    },
  };
  return {
    source,
    asked,
    failListing(on: boolean) {
      failListing = on;
    },
    failLookup(rule: ((address: string) => boolean) | null) {
      failLookup = rule;
    },
  };
}

describe("the book, sweep after sweep", () => {
  it("lists the app ONCE, then serves every wallet from the book: list pages stay put after warm-up", async () => {
    const linked = [address(), address(), address(), address()];
    const app = new Map(linked.map((wallet, i) => [wallet, entry(`w${i}`)] as const));
    for (let i = 0; i < 250; i += 1) app.set(address(), entry(`unlinked${i}`));
    const privy = fakePrivy(app);
    const book = new PrivyAddressBook(privy.source, { signable });

    const first = await book.prepare(linked, 0);
    expect(privy.asked).toMatchObject({ listings: 1, pages: 3, lookups: [] });
    expect([...first.index.keys()].sort()).toEqual([...linked].sort());

    // TODAY THIS WOULD BE 3 PAGES A SWEEP, FOREVER: 59 sweeps more, not one more page.
    for (let sweep = 1; sweep < 60; sweep += 1) await book.prepare(linked, sweep * 60_000);
    expect(privy.asked.listings).toBe(1);
    expect(book.status()).toMatchObject({ warm: true, listPages: 3 });
    // A FEW SIGNABLE RECORDS FELL DUE IN THE HOUR, each asked by address, each once or twice: never a listing.
    expect(privy.asked.lookups.length).toBeLessThanOrEqual(2 * linked.length);
  });

  it("asks an UNSIGNABLE record again every minute, so the owner's fix from the web is seen as fast as today", async () => {
    const wallet = address();
    const app = new Map([[wallet, entry("w", [])]]); // no signer seated yet
    const privy = fakePrivy(app);
    const book = new PrivyAddressBook(privy.source, { signable });
    await book.prepare([wallet], 0);
    expect(signable((await book.prepare([wallet], 30_000)).index.get(wallet)!)).toBe(false);
    expect(privy.asked.lookups).toHaveLength(0);

    // THE OWNER PRESSES "Grant keeper permission".
    app.set(wallet, entry("w", bounded));
    const after = await book.prepare([wallet], PRIVY_UNSIGNABLE_RECHECK_MS);
    expect(privy.asked.lookups).toEqual([wallet]);
    expect(signable(after.index.get(wallet)!)).toBe(true);
  });

  it("spreads a thousand signable records over the period: no sweep asks for more than its share", async () => {
    const linked = Array.from({ length: 1_000 }, () => address());
    const privy = fakePrivy(new Map(linked.map((wallet, i) => [wallet, entry(`w${i}`)] as const)));
    const book = new PrivyAddressBook(privy.source, { signable });
    await book.prepare(linked, 0);
    let worst = 0;
    for (let at = 60_000; at <= 2 * PRIVY_SIGNABLE_RECHECK_MS; at += 60_000) {
      const before = privy.asked.lookups.length;
      await book.prepare(linked, at);
      worst = Math.max(worst, privy.asked.lookups.length - before);
    }
    // ≈ N/30 a minute (33), with room for the hash's unevenness; NOT a thousand at boot + 30 min.
    expect(worst).toBeLessThanOrEqual(60);
    expect(privy.asked.listings).toBe(1);
  });

  it("asks by address, never by listing, while the warm-up fails — and lists again next sweep", async () => {
    const linked = [address(), address()];
    const privy = fakePrivy(new Map(linked.map((wallet, i) => [wallet, entry(`w${i}`)] as const)));
    const book = new PrivyAddressBook(privy.source, { signable });
    privy.failListing(true);
    const cold = await book.prepare(linked, 0);
    // TODAY: a failed index sends EACH wallet to a full listing of its own. Here: one lookup each.
    expect(privy.asked.listings).toBe(1);
    expect(privy.asked.lookups.sort()).toEqual([...linked].sort());
    expect(cold.index.size).toBe(2);
    expect(book.status()).toMatchObject({ warm: false, listFailures: 1 });

    privy.failListing(false);
    await book.prepare(linked, 60_000);
    expect(privy.asked.listings).toBe(2);
    expect(book.status().warm).toBe(true);
  });

  it("fails only the wallet it could not ask, and does not vouch for its old record", async () => {
    const [ok, unlucky] = [address(), address()];
    const privy = fakePrivy(new Map([[ok, entry("ok")], [unlucky, entry("unlucky")]]));
    const book = new PrivyAddressBook(privy.source, { signable, signableRecheckMs: 60_000 });
    await book.prepare([ok, unlucky], 0);
    privy.failLookup((wallet) => wallet === unlucky);

    const view = await book.prepare([ok, unlucky], 120_000);
    expect(view.failed.get(unlucky)).toBe("Error (HTTP 429)");
    expect(view.index.has(unlucky)).toBe(false);
    expect(view.index.has(ok)).toBe(true);

    privy.failLookup(null);
    const next = await book.prepare([ok, unlucky], 121_000);
    expect(next.failed.size).toBe(0);
    expect(next.index.has(unlucky)).toBe(true);
  });

  it("forgets a wallet whose send failed, so its next turn asks Privy again", async () => {
    const wallet = Keypair.generate().publicKey;
    const privy = fakePrivy(new Map([[wallet.toBase58(), entry("w")]]));
    const book = new PrivyAddressBook(privy.source, { signable });
    await book.prepare([wallet.toBase58()], 0);
    const refusing: SolanaWalletSubmitter = {
      address: wallet,
      submit: async () => {
        throw Object.assign(new Error("policy refused"), { status: 400 });
      },
    };
    const guarded = confirmedSubmitter(refusing, book);
    await expect(guarded.submit(new Transaction(), { idempotencyKey: "k" })).rejects.toThrow("policy refused");
    expect(book.status().forgotten).toBe(1);
    await book.prepare([wallet.toBase58()], 1_000);
    expect(privy.asked.lookups).toEqual([wallet.toBase58()]);

    const fine = confirmedSubmitter({ address: wallet, submit: async () => "sig" }, book);
    await expect(fine.submit(new Transaction(), { idempotencyKey: "k" })).resolves.toBe("sig");
    expect(book.status().forgotten).toBe(1);
  });
  it("keeps only the wallets the sweep discovered", async () => {
    const linked = address();
    const app = new Map([[linked, entry("l")]]);
    for (let i = 0; i < 10; i += 1) app.set(address(), entry(`u${i}`));
    const book = new PrivyAddressBook(fakePrivy(app).source, { signable });
    await book.prepare([linked], 0);
    expect(book.status().entries).toBe(11);
    book.prune(new Set([linked]));
    expect(book.status().entries).toBe(1);
  });
});

describe("the seat, asked again right before a send (confirmedSubmitter)", () => {
  /** A wallet the book warmed as bounded at 0, and a submitter that records whether it was ever reached. */
  async function warmed() {
    const wallet = Keypair.generate().publicKey;
    const app = new Map([[wallet.toBase58(), entry("w", bounded)]]);
    const privy = fakePrivy(app);
    const book = new PrivyAddressBook(privy.source, { signable });
    await book.prepare([wallet.toBase58()], 0);
    expect(privy.asked.lookups).toEqual([]);
    const reached: string[] = [];
    // WHAT PRIVY ANSWERS A SEND THROUGH A SEAT THAT IS GONE: refused, with no program error in it.
    const inner: SolanaWalletSubmitter = {
      address: wallet,
      submit: async () => {
        reached.push("submit");
        throw Object.assign(new Error("403 signer is not on this wallet"), { status: 403 });
      },
    };
    return { wallet, app, privy, book, reached, signer: confirmedSubmitter(inner, book, () => 10 * 60_000) };
  }

  it("lets the send go when the seat is still there, asking Privy once by address", async () => {
    const { wallet, privy, book, signer } = await warmed();
    await expect(signer.confirmSeat!()).resolves.toBeUndefined();
    expect(privy.asked.lookups).toEqual([wallet.toBase58()]);
    expect(privy.asked.listings).toBe(1);
    expect(book.status()).toMatchObject({ lookups: 1, withdrawnAtSend: 0 });
  });

  // THE MAJOR FINDING: the book served this record for 30 minutes after its owner pressed Remove SaverFi
  // permission, and the first notice was the send itself — FAILED, paged critical, latched.
  it("stops the send of a wallet whose owner removed the keeper's seat since the book last asked", async () => {
    const { wallet, app, book, reached, signer } = await warmed();
    app.set(wallet.toBase58(), entry("w", [])); // removeSigners, from the web
    const error = await signer.confirmSeat!().catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(SeatWithdrawnError);
    expect(error).toMatchObject({ wallet: wallet.toBase58(), found: "NOT_SIGNABLE" });
    expect(reached).toEqual([]);
    expect(book.status().withdrawnAtSend).toBe(1);
    // THE ANSWER IS KEPT: the next sweep resolves the wallet from it, unsignable, with no request of its own.
    const next = await book.prepare([wallet.toBase58()], 10 * 60_000 + 1_000);
    expect(signable(next.index.get(wallet.toBase58())!)).toBe(false);
  });

  it("stops the send of a wallet Privy no longer knows, as NOT_A_PRIVY_WALLET", async () => {
    const { wallet, app, reached, signer } = await warmed();
    app.delete(wallet.toBase58()); // archived: 404
    await expect(signer.confirmSeat!()).rejects.toMatchObject({ name: "SeatWithdrawnError", found: "NOT_A_PRIVY_WALLET" });
    expect(reached).toEqual([]);
  });

  // THE MINOR FINDING: a second keeper seat added WITHOUT the policy makes the wallet NOT_BOUNDED. Privy does not
  // refuse a send through it, so nothing used to make the book ask, and seat-unbounded paged up to 30 minutes late.
  it("stops the send through a seat that lost its bound, and the next sweep resolves SEAT_NOT_BOUNDED, which pages", async () => {
    const { wallet, app, book, reached, signer } = await warmed();
    app.set(wallet.toBase58(), entry("w", [...bounded, { signerId: SIGNER_ID, overridePolicyIds: [] }]));
    await expect(signer.confirmSeat!()).rejects.toBeInstanceOf(SeatWithdrawnError);
    expect(reached).toEqual([]);
    const config: PrivySolanaConfig = {
      appId: "app",
      appSecret: new Secret("privy-app-secret-NeverSent-0011", "privyAppSecret"),
      authorizationKey: new Secret("unused", "privyAuthorizationKey"),
      fetch: async () => {
        throw new Error("no request may leave a resolution handed an index");
      },
    };
    // ONE SWEEP LATER, long before the 30-minute recheck: the book serves what the send just read.
    const next = await book.prepare([wallet.toBase58()], 10 * 60_000 + 60_000);
    const resolution = await createPrivySolanaSigner(config, wallet, SIGNER_ID, next.index, POLICY_ID);
    expect(resolution.outcome).toBe("SEAT_NOT_BOUNDED"); // keeper.mts fires seat-unbounded:<wallet> on exactly this
  });

  it("lets the send go when Privy cannot be asked, and drops the record so the next sweep asks again", async () => {
    const { wallet, privy, book, signer } = await warmed();
    privy.failLookup(() => true);
    await expect(signer.confirmSeat!()).resolves.toBeUndefined();
    expect(book.status()).toMatchObject({ lookupFailures: 1, withdrawnAtSend: 0, entries: 0 });
    privy.failLookup(null);
    await book.prepare([wallet.toBase58()], 10 * 60_000 + 1_000);
    expect(privy.asked.lookups).toEqual([wallet.toBase58(), wallet.toBase58()]);
  });
});

describe("the same resolution as today's index", () => {
  const cases: [string, readonly SignerSeat[] | null][] = [
    ["a bounded seat", bounded],
    ["no signer", []],
    ["another signer", [{ signerId: "someoneElse", overridePolicyIds: [POLICY_ID] }]],
    ["an unbounded seat", [{ signerId: SIGNER_ID, overridePolicyIds: [] }]],
    ["another policy", [{ signerId: SIGNER_ID, overridePolicyIds: ["other"] }]],
    ["not a Privy wallet", null],
  ];

  it("gives createPrivySolanaSigner the outcome the full listing gives it, for every kind of seat", async () => {
    const config: PrivySolanaConfig = {
      appId: "app",
      appSecret: new Secret("privy-app-secret-NeverSent-0010", "privyAppSecret"),
      authorizationKey: new Secret("unused", "privyAuthorizationKey"),
      fetch: async () => {
        throw new Error("no request may leave a resolution handed an index");
      },
    };
    for (const [name, seats] of cases) {
      const wallet = Keypair.generate().publicKey;
      const app = new Map<string, PrivyWalletEntry>(seats === null ? [] : [[wallet.toBase58(), entry("w", seats)]]);
      const listing = new Map(app); // what buildPrivySolanaIndex would have built
      const view = await new PrivyAddressBook(fakePrivy(app).source, { signable }).prepare([wallet.toBase58()], 0);
      const today = await createPrivySolanaSigner(config, wallet, SIGNER_ID, listing, POLICY_ID);
      const withBook = await createPrivySolanaSigner(config, wallet, SIGNER_ID, view.index, POLICY_ID);
      expect(withBook.outcome, name).toBe(today.outcome);
      // seatsSignable IS the same rule, which is what makes the recheck period honest.
      expect(seats === null ? false : seatsSignable(seats, SIGNER_ID, POLICY_ID), name).toBe(today.outcome === "SIGNER");
    }
  });

  it("reads seatsSignable as the signer does with no ids configured: everything resolves", () => {
    expect(seatsSignable([], undefined, undefined)).toBe(true);
    expect(seatsSignable([{ signerId: SIGNER_ID, overridePolicyIds: [] }], SIGNER_ID, undefined)).toBe(true);
  });
});

describe("the two reads, over the real SDK", () => {
  interface Sent {
    readonly url: URL;
    readonly method: string;
    readonly body: string | null;
  }
  const answering = (answer: (request: Sent) => { status: number; body: unknown }) => {
    const sent: Sent[] = [];
    const fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const request = input instanceof Request ? input : null;
      const entry: Sent = {
        url: new URL(request?.url ?? String(input)),
        method: init?.method ?? request?.method ?? "GET",
        body: typeof init?.body === "string" ? init.body : null,
      };
      sent.push(entry);
      const { status, body } = answer(entry);
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    }) as typeof globalThis.fetch;
    const config: PrivySolanaConfig = {
      appId: "app",
      appSecret: new Secret("privy-app-secret-NeverSent-0011", "privyAppSecret"),
      authorizationKey: new Secret("unused", "privyAuthorizationKey"),
      fetch,
    };
    return { config, sent };
  };

  it("asks POST /v1/wallets/address with the address, and reads the seats and their policy from the answer", async () => {
    const wallet = address();
    const { config, sent } = answering(() => ({
      status: 200,
      body: { id: "wallet-1", address: wallet, chain_type: "solana", additional_signers: [{ signer_id: SIGNER_ID, override_policy_ids: [POLICY_ID] }] },
    }));
    await expect(privyAddressSource(config).byAddress(wallet)).resolves.toEqual({ walletId: "wallet-1", seats: bounded });
    expect(sent).toHaveLength(1);
    expect([sent[0]!.method, sent[0]!.url.origin, sent[0]!.url.pathname]).toEqual(["POST", PRIVY_API_URL, "/v1/wallets/address"]);
    expect(JSON.parse(sent[0]!.body ?? "{}")).toEqual({ address: wallet });
  });

  it("reads 404 as 'not a Privy wallet' and ONLY 404: anything else is a failed lookup, never an absent wallet", async () => {
    const notFound = answering(() => ({ status: 404, body: { error: "Wallet not found" } }));
    await expect(privyAddressSource(notFound.config).byAddress(address())).resolves.toBeNull();
    for (const status of [401, 429, 500]) {
      const failing = answering(() => ({ status, body: { error: "no" } }));
      await expect(privyAddressSource(failing.config).byAddress(address()), String(status)).rejects.toMatchObject({ status });
      // ONE ATTEMPT: the pinned client never re-sends (maxRetries 0).
      expect(failing.sent, String(status)).toHaveLength(1);
    }
  });

  it("treats an answer for another chain or another address as absent", async () => {
    const wallet = address();
    const evm = answering(() => ({ status: 200, body: { id: "w", address: wallet, chain_type: "ethereum", additional_signers: [] } }));
    await expect(privyAddressSource(evm.config).byAddress(wallet)).resolves.toBeNull();
    const other = answering(() => ({ status: 200, body: { id: "w", address: address(), chain_type: "solana", additional_signers: [] } }));
    await expect(privyAddressSource(other.config).byAddress(wallet)).resolves.toBeNull();
  });

  it("lists with chain_type solana and limit 100, page by page, telling the book of each page", async () => {
    const [first, second] = [address(), address()];
    const { config, sent } = answering((request) =>
      request.url.searchParams.get("cursor") === null
        ? { status: 200, body: { data: [{ id: "w1", address: first, chain_type: "solana", additional_signers: [] }], next_cursor: "page-2" } }
        : { status: 200, body: { data: [{ id: "w2", address: second, chain_type: "solana", additional_signers: [] }], next_cursor: null } },
    );
    let pages = 0;
    const listed = await privyAddressSource(config).listAll(() => {
      pages += 1;
    });
    expect([...listed.keys()]).toEqual([first, second]);
    expect(pages).toBe(2);
    expect(sent.map((request) => [request.method, request.url.pathname, request.url.searchParams.get("chain_type"), request.url.searchParams.get("limit")])).toEqual([
      ["GET", "/v1/wallets", "solana", "100"],
      ["GET", "/v1/wallets", "solana", "100"],
    ]);
  });
});
