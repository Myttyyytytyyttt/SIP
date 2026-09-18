// /api/solana-live through its handler, over a stub chain: what it refuses, what
// it charges, and that it never reports an unreadable read as a missing one.

import { describe, expect, it } from "vitest";

import { PYTH_PUSH_PROGRAM, PYTH_SOL_USD_FEED, PYTH_USDC_USD_FEED, SPYX_MINT } from "../src/client/addresses";
import { base58Encode } from "../src/client/base58";
import { base64Encode } from "../src/client/base64";
import { encodeArgs, encodeStruct } from "../src/client/borsh";
import { SIP_ACCOUNT_SPACE } from "../src/client/decoders";
import { SIP_PROGRAM_ID, eventDiscriminator } from "../src/client/idl";
import {
  BUILD_READS_WEIGHT,
  BUILD_REQUEST_WEIGHT,
  LIVE_READS_WEIGHT,
  MAX_BUILD_REQUEST_BYTES,
  MAX_LIVE_ACTIVITY_PAGE,
  createSolanaLiveHandler,
  createSolanaVaultHandler,
  type SolanaVaultHandlerOptions,
} from "../src/server/build-handler";
import { loadSolanaServerSettings } from "../src/server/config";
import type { SolanaGate } from "../src/server/handlers";
import { deriveConfigPda, deriveInvestPda, deriveLinkPda, deriveVaultPda } from "../src/server/pda";
import { createWeightedLimiter, type WeightedLimiter } from "../src/server/rate-limit";
import { LEG_POOLS, configAccount, linkAccount, localRent, policyAccount, pricedPoolEntries, vaultAccount } from "./chain-fixtures";
import {
  PYTH_FIXTURE_OWNER,
  PYTH_FIXTURE_POSTED_SLOT,
  PYTH_FIXTURE_PUBLISH_TIME,
  PYTH_SOL_USD_ACCOUNT,
  PYTH_USDC_USD_ACCOUNT,
} from "./fixtures/pyth-accounts";
import { SECRET_QUERY, UPSTREAM_1, accountInfo, fakeFetch, keypair, type UpstreamCall } from "./helpers";

const load = loadSolanaServerSettings({ SIP_SOLANA_RPC_URLS: UPSTREAM_1, SIP_SOLANA_PROGRAM_ID: SIP_PROGRAM_ID, SIP_TRUSTED_CLIENT_IP_HEADER: "x-envoy-external-address" });
if (!load.ok) throw new Error("test settings must load");
const OK_GATE: SolanaGate = { kind: "ok", settings: load.settings };

const key = (): string => keypair().publicKey.toBase58();
const sipOwned = (data: Uint8Array, lamports = 2_000_000) => accountInfo(SIP_PROGRAM_ID, data, lamports);
const SIGNATURE_A = base58Encode(Uint8Array.from({ length: 64 }, (_, i) => i + 1));
const SIGNATURE_B = base58Encode(Uint8Array.from({ length: 64 }, (_, i) => i + 2));
const SIGNATURE_C = base58Encode(Uint8Array.from({ length: 64 }, (_, i) => i + 3));

let lastIp = 0;
const freshIp = (): string => `198.51.100.${(lastIp = (lastIp % 250) + 1)}`;

function post(route: "live" | "vault", body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`https://sip.example/api/solana-${route}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-envoy-external-address": freshIp(), ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

type Answer = { status: number; json: Record<string, any>; text: string; headers: Headers };

async function read(response: Response): Promise<Answer> {
  const text = await response.text();
  return { status: response.status, json: JSON.parse(text) as never, text, headers: response.headers };
}

// ── a chain the live route can be asked about ────────────────────────────────

interface LiveChain {
  readonly accounts: Map<string, ReturnType<typeof accountInfo> | null>;
  readonly signatures?: readonly { signature: string; slot: number; blockTime: number | null; err: unknown }[];
  readonly transactions?: Map<string, unknown>;
  readonly programAccounts?: readonly { pubkey: string; account: ReturnType<typeof accountInfo> }[];
  down?: boolean;
}

type RpcRequest = { readonly id?: unknown; readonly method?: string; readonly params?: readonly unknown[] };

function answerLive(chain: LiveChain): (call: UpstreamCall) => Response {
  const one = (request: RpcRequest): Record<string, unknown> => {
    const id = request.id ?? 1;
    const params = request.params ?? [];
    switch (request.method) {
      case "getMultipleAccounts":
        return { jsonrpc: "2.0", id, result: { context: { slot: 4_242 }, value: (params[0] as string[]).map((address) => chain.accounts.get(address) ?? null) } };
      case "getMinimumBalanceForRentExemption":
        return { jsonrpc: "2.0", id, result: localRent(params[0] as number) };
      case "getProgramAccounts":
        return { jsonrpc: "2.0", id, result: chain.programAccounts ?? [] };
      case "getSignaturesForAddress": {
        const options = (params[1] ?? {}) as { limit?: number };
        return { jsonrpc: "2.0", id, result: (chain.signatures ?? []).slice(0, options.limit ?? 25) };
      }
      case "getTransaction":
        return { jsonrpc: "2.0", id, result: chain.transactions?.get(params[0] as string) ?? null };
      default:
        return { jsonrpc: "2.0", id, error: { code: -32601, message: `the stub has no ${String(request.method)}` } };
    }
  };
  return (call) => {
    if (chain.down === true) throw new Error(`socket hang up ${UPSTREAM_1}`);
    const body = call.body as RpcRequest | RpcRequest[];
    return new Response(JSON.stringify(Array.isArray(body) ? body.map(one) : one(body)), { status: 200, headers: { "content-type": "application/json" } });
  };
}

/** A settle_v2 transaction of `vault`, with its Settled event and the vault's SOL gain. */
function settleTransaction(vault: string, wallet: string, paid: bigint): unknown {
  const body = encodeStruct("Settled", {
    vault,
    wallet,
    mode: 0,
    base_lamports: 500_000_000n,
    bps: 2_000,
    owed: 100_000_000n,
    paid,
    settlement_nonce: 0n,
    session_end_slot: 220n,
    link_epoch: 200n,
    session_start_slot: 200n,
    policy_nonce: 0n,
  });
  const event = new Uint8Array(8 + body.length);
  event.set(eventDiscriminator("Settled"), 0);
  event.set(body, 8);
  const data = encodeArgs("settle_v2", { mode: 0, session_start_slot: 200n, session_end_slot: 220n, base_lamports: 500_000_000n, valid_until_slot: 520n });
  return {
    slot: 4_200,
    blockTime: 1_789_500_000,
    meta: {
      err: null,
      fee: 5_000,
      preBalances: [1_000_000_000, 1_000_000, 1],
      postBalances: [1_000_000_000 - Number(paid), 1_000_000 + Number(paid), 1],
      preTokenBalances: [],
      postTokenBalances: [],
      logMessages: [`Program ${SIP_PROGRAM_ID} invoke [1]`, `Program data: ${base64Encode(event)}`, `Program ${SIP_PROGRAM_ID} success`],
      loadedAddresses: { writable: [], readonly: [] },
    },
    transaction: { message: { accountKeys: [wallet, vault, SIP_PROGRAM_ID], instructions: [{ programIdIndex: 2, accounts: [0, 1], data: base58Encode(data) }] } },
  };
}

function setup(chain: LiveChain = { accounts: new Map() }, extra: Omit<SolanaVaultHandlerOptions, "gate"> = {}, gate: SolanaGate = OK_GATE) {
  const upstream = fakeFetch(answerLive(chain));
  const options: SolanaVaultHandlerOptions = { gate: () => gate, fetch: upstream.fetch, now: () => 1_789_500_000_000, onRefusal: () => undefined, ...extra };
  const live = createSolanaLiveHandler(options);
  return {
    upstream,
    handler: live,
    live: async (body: unknown, headers?: Record<string, string>) => read(await live.POST(post("live", body, headers))),
  };
}

const methodsOf = (calls: readonly UpstreamCall[]): string[] =>
  calls.flatMap((call) => (Array.isArray(call.body) ? (call.body as RpcRequest[]).map((entry) => String(entry.method)) : [String((call.body as RpcRequest).method)]));

/** A limiter that records what it took, so a charge can be asserted exactly. */
function counting(capacity: number): { limiter: WeightedLimiter; spent: () => number } {
  const inner = createWeightedLimiter({ capacity });
  let spent = 0;
  return {
    limiter: {
      take: (bucket, cost, at) => {
        const wait = inner.take(bucket, cost, at);
        if (wait === 0) spent += cost;
        return wait;
      },
      get size() {
        return inner.size;
      },
    },
    spent: () => spent,
  };
}

// ── the oracle, and a clock that is deliberately not this host's ─────────────
//
// setup()'s `now` is 1_789_500_000_000 ms, which is 199_386 seconds BEFORE the
// captured publish time. So if an age is ever taken from the host's clock it
// comes out NEGATIVE and enormous, and the assertions below say plainly which
// clock answered. The chain's is 30 seconds after the publish.
const CHAIN_NOW = PYTH_FIXTURE_PUBLISH_TIME + 30n;
const HOST_AGE_SECONDS = 1_789_500_000n - PYTH_FIXTURE_PUBLISH_TIME;
const SYSVAR_CLOCK = "SysvarC1ock11111111111111111111111111111111";

function clockAccount(unixSeconds = CHAIN_NOW): ReturnType<typeof accountInfo> {
  const data = new Uint8Array(40);
  let left = BigInt.asUintN(64, unixSeconds);
  // unix_timestamp is an i64 at byte 32, after slot, epoch_start_timestamp, epoch and leader_schedule_epoch.
  for (let i = 0; i < 8; i++) {
    data[32 + i] = Number(left & 0xffn);
    left >>= 8n;
  }
  return accountInfo("Sysvar1111111111111111111111111111111111111", data, 1_169_280);
}

const feedAccount = (data: Uint8Array, owner = PYTH_FIXTURE_OWNER) => accountInfo(owner, data, 5_117_760);

/** The clock and both feeds, healthy, as the tail of the snapshot's one getMultipleAccounts. */
const pythAccounts = (): [string, ReturnType<typeof accountInfo> | null][] => [
  [SYSVAR_CLOCK, clockAccount()],
  [PYTH_SOL_USD_FEED, feedAccount(PYTH_SOL_USD_ACCOUNT)],
  [PYTH_USDC_USD_FEED, feedAccount(PYTH_USDC_USD_ACCOUNT)],
];

/** A chain where `owner` has a vault, a policy, the config, EVERY priced pool, the oracle and one linked wallet. */
function fullChain(owner: string, wallet: string): LiveChain {
  const vault = deriveVaultPda(owner).toBase58();
  return {
    accounts: new Map<string, ReturnType<typeof accountInfo> | null>([
      [vault, sipOwned(vaultAccount(owner, { lifetime_saved: 9_007_199_254_740_993n }), 250_000_000)],
      [deriveInvestPda(vault).toBase58(), sipOwned(policyAccount(vault))],
      [deriveConfigPda().toBase58(), sipOwned(configAccount(false))],
      // Every pool PRICED_POOLS names, so a snapshot that quotes a price quotes it
      // because all four decoded, not because a missing one was never asked about.
      ...pricedPoolEntries(),
      ...pythAccounts(),
      [deriveLinkPda(wallet).toBase58(), sipOwned(linkAccount(wallet, vault))],
      [wallet, accountInfo("11111111111111111111111111111111", new Uint8Array(0), 420_000_000)],
    ]),
  };
}

describe("the order of refusals", () => {
  it("an invalid gate is 503 with no detail; cross-site 403; text/plain 415; over the cap 413; GET 405", async () => {
    const off = setup(undefined, {}, { kind: "invalid" });
    const unavailable = await off.live({ action: "snapshot", owner: key(), wallets: [], discover: false });
    expect([unavailable.status, unavailable.json.error?.code]).toEqual([503, "unavailable"]);
    expect(unavailable.text).not.toMatch(/SIP_|PRIVY_|variable/);

    const { live, handler, upstream } = setup();
    expect((await live({ action: "snapshot", owner: key(), wallets: [], discover: false }, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await live({ action: "snapshot" }, { "content-type": "text/plain" })).status).toBe(415);
    const large = await live({ action: "snapshot", owner: key(), wallets: [], discover: false, pad: "x".repeat(MAX_BUILD_REQUEST_BYTES) });
    expect([large.status, large.json.error?.code]).toEqual([413, "payload_too_large"]);
    expect(handler.GET().status).toBe(405);
    expect(upstream.calls).toHaveLength(0);
  });

  it.each([
    ["an unknown action", { action: "state", owner: key() }],
    ["no action", { owner: key() }],
    ["an extra field", { action: "snapshot", owner: key(), wallets: [], discover: false, vault: key() }],
    ["an owner that is not a key", { action: "snapshot", owner: "nope", wallets: [], discover: false }],
    ["eleven wallets", { action: "snapshot", owner: key(), wallets: Array.from({ length: 11 }, key), discover: false }],
    ["a repeated wallet", { action: "snapshot", owner: key(), wallets: [SPYX_MINT, SPYX_MINT], discover: false }],
    ["a wallet that is not a key", { action: "snapshot", owner: key(), wallets: ["nope"], discover: false }],
    ["discover missing", { action: "snapshot", owner: key(), wallets: [] }],
    ["discover as text", { action: "snapshot", owner: key(), wallets: [], discover: "yes" }],
    ["limit 0", { action: "activity", owner: key(), limit: 0 }],
    ["limit 16", { action: "activity", owner: key(), limit: MAX_LIVE_ACTIVITY_PAGE + 1 }],
    ["a fractional limit", { action: "activity", owner: key(), limit: 2.5 }],
    ["before with until", { action: "activity", owner: key(), before: SIGNATURE_A, until: SIGNATURE_B }],
    ["a cursor that is not a signature", { action: "activity", owner: key(), before: "nope" }],
    ["an until that is not a signature", { action: "activity", owner: key(), until: SPYX_MINT }],
  ])("%s is 400 bad_request with no chain read", async (_, body) => {
    const { live, upstream } = setup();
    const answer = await live(body);
    expect([answer.status, answer.json.error?.code]).toEqual([400, "bad_request"]);
    expect(upstream.calls).toHaveLength(0);
  });

  it("the pension key among its own trading wallets is refused before any read", async () => {
    const owner = key();
    const { live, upstream } = setup();
    const answer = await live({ action: "snapshot", owner, wallets: [owner], discover: false });
    expect([answer.status, answer.json.error?.code]).toEqual([400, "bad_request"]);
    expect(answer.json.error?.message).toContain("cannot be your pension key");
    expect(upstream.calls).toHaveLength(0);
  });
});

describe("snapshot", () => {
  it("answers the whole dashboard in ONE upstream request, with every bigint as a string", async () => {
    const owner = key();
    const wallet = key();
    const vault = deriveVaultPda(owner).toBase58();
    const { live, upstream } = setup(fullChain(owner, wallet));
    const answer = await live({ action: "snapshot", owner, wallets: [wallet], discover: false });

    expect(answer.status).toBe(200);
    expect(upstream.calls).toHaveLength(1);
    expect(methodsOf(upstream.calls)).toEqual(["getMultipleAccounts", "getMultipleAccounts", "getMinimumBalanceForRentExemption", "getMinimumBalanceForRentExemption"]);

    const body = answer.json;
    expect([body.owner, body.programId, body.slot, body.readAtMs]).toEqual([owner, SIP_PROGRAM_ID, 4_242, 1_789_500_000_000]);
    expect(body.vault).toMatchObject({ status: "exists", address: vault, lamports: "250000000", rentFloor: String(localRent(125)) });
    // Past 2^53: a number would have lost the last digit.
    expect(body.vault.state.lifetimeSaved).toBe("9007199254740993");
    expect(body.policy).toMatchObject({ status: "exists", address: deriveInvestPda(vault).toBase58() });
    expect(body.config).toMatchObject({ status: "exists", exists: true, paused: false });
    expect(body.rents).toEqual({ vault: String(localRent(125)), walletFloor: String(localRent(0)) });
    // Every leg's rate is quoted, as a string, in the catalogue's order — the whole
    // dashboard means the whole basket, not just the SOL rate that used to stand for it.
    expect(body.prices).toMatchObject({ usdcRawPerSol: "100038711" });
    expect(body.prices.legs).toEqual(
      LEG_POOLS.map((leg) => ({ symbol: leg.symbol, mint: leg.mint, wad: String(leg.legWad), usdcRawPer1e8: String(leg.usdcRawPer1e8) })),
    );

    // ── the oracle, a SIBLING of prices and never a field inside it ────────────
    expect(body.prices.pyth).toBeUndefined();
    expect(body.pyth).toEqual({
      // The same unit prices.convertWad is in, so the two can be compared.
      wad: "102606509293604451",
      ageSeconds: "30",
      chainUnixSeconds: String(CHAIN_NOW),
      // expo is a NUMBER: a decimal exponent, not a bigint like every value beside it.
      sol: { price: "10259321149", conf: "1384501", expo: -8, publishTime: String(PYTH_FIXTURE_PUBLISH_TIME), postedSlot: String(PYTH_FIXTURE_POSTED_SLOT) },
      usdc: { price: "99987040", conf: "87960", expo: -8, publishTime: String(PYTH_FIXTURE_PUBLISH_TIME), postedSlot: String(PYTH_FIXTURE_POSTED_SLOT) },
    });
    // WHICH CLOCK ANSWERED. This host's would have made the price 199_386 seconds
    // YOUNGER than its own publish, because setup()'s now() is before it; the age
    // reported is the chain's 30, so no wall clock entered the subtraction.
    expect(HOST_AGE_SECONDS < 0n).toBe(true);
    expect(body.pyth.ageSeconds).not.toBe(String(HOST_AGE_SECONDS));

    // The feeds rode in a member that was already being sent — the four methods
    // above are unchanged — at the very END of its addresses, where the pools'
    // fixed slice and the wallets' offsets cannot reach them.
    const asked = ((upstream.calls[0]!.body as RpcRequest[])[0]!.params![0] as string[]).slice(-3);
    expect(asked).toEqual([SYSVAR_CLOCK, PYTH_SOL_USD_FEED, PYTH_USDC_USD_FEED]);
    expect(body.wallets).toEqual([
      { wallet, lamports: "420000000", link: { address: deriveLinkPda(wallet).toBase58(), status: "this_vault", vault, epoch: "7", settlementNonce: "0", frontierSlot: "0" } },
    ]);
    expect(body.links).toBeNull();
  });

  it("discover lists the vault's links and makes it a batch of five", async () => {
    const owner = key();
    const wallet = key();
    const vault = deriveVaultPda(owner).toBase58();
    const chain = fullChain(owner, wallet);
    const { live, upstream } = setup({ ...chain, programAccounts: [{ pubkey: deriveLinkPda(wallet).toBase58(), account: sipOwned(linkAccount(wallet, vault)) }] });
    const answer = await live({ action: "snapshot", owner, wallets: [], discover: true });

    expect(upstream.calls).toHaveLength(1);
    expect(methodsOf(upstream.calls)).toContain("getProgramAccounts");
    expect(answer.json.links).toEqual({ status: "exists", items: [{ wallet, address: deriveLinkPda(wallet).toBase58(), epoch: "7", settlementNonce: "0", frontierSlot: "0" }] });
  });

  it("an unreadable chain is unreadable everywhere, NEVER missing, and the endpoint never appears", async () => {
    const owner = key();
    const wallet = key();
    const { live } = setup({ accounts: new Map(), down: true });
    const answer = await live({ action: "snapshot", owner, wallets: [wallet], discover: true });

    expect(answer.status).toBe(200);
    expect([answer.json.vault.status, answer.json.policy.status, answer.json.config.status]).toEqual(["unreadable", "unreadable", "unreadable"]);
    expect(answer.json.vault.status).not.toBe("missing");
    expect(answer.json.prices).toBeNull();
    // A price nobody could read is not reported as a price, oracle included.
    expect(answer.json.pyth).toBeNull();
    expect(answer.json.rents).toEqual({ vault: null, walletFloor: null });
    // A balance nobody could read is null, not "0": "it holds nothing" would be a claim.
    expect(answer.json.wallets).toEqual([{ wallet, lamports: null, link: { address: deriveLinkPda(wallet).toBase58(), status: "unreadable", vault: null, epoch: null, settlementNonce: null, frontierSlot: null } }]);
    expect(answer.json.links).toEqual({ status: "unreadable", items: [] });
    expect(answer.text).not.toContain(SECRET_QUERY);
    expect(answer.text).not.toContain("upstream.invalid");
  });


  it.each([
    // The address DERIVES under the push program, which does not own it: the one
    // confusion that makes a spoofed feed look right everywhere but the owner check.
    ["a feed owned by the push program its address derives under", () => feedAccount(PYTH_SOL_USD_ACCOUNT, PYTH_PUSH_PROGRAM)],
    ["a feed owned by a stranger", () => feedAccount(PYTH_SOL_USD_ACCOUNT, deriveVaultPda(key()).toBase58())],
    ["a feed missing entirely", () => null],
    ["a feed holding somebody else's bytes", () => feedAccount(new Uint8Array(134))],
  ])("%s answers pyth null, and the prices payload stays byte-identical", async (_, spoil) => {
    const owner = key();
    const wallet = key();
    const healthy = await setup(fullChain(owner, wallet)).live({ action: "snapshot", owner, wallets: [wallet], discover: false });

    const chain = fullChain(owner, wallet);
    chain.accounts.set(PYTH_SOL_USD_FEED, spoil());
    const { live, upstream } = setup(chain);
    const answer = await live({ action: "snapshot", owner, wallets: [wallet], discover: false });

    expect(answer.status).toBe(200);
    // "Pyth unavailable", which is an answer. A thrown read would have been a 502
    // for the whole dashboard, and a reported price would have been a lie.
    expect(answer.json.pyth).toBeNull();
    // Byte for byte, not merely equivalent: a dead feed costs the dashboard its
    // own panel and not one character of the prices beside it.
    expect(JSON.stringify(answer.json.prices)).toBe(JSON.stringify(healthy.json.prices));
    expect(answer.json.prices.usdcRawPerSol).toBe("100038711");
    expect(answer.json.vault.status).toBe("exists");
    // And it still cost the dashboard exactly one request of four members.
    expect(upstream.calls).toHaveLength(1);
    expect(methodsOf(upstream.calls)).toEqual(["getMultipleAccounts", "getMultipleAccounts", "getMinimumBalanceForRentExemption", "getMinimumBalanceForRentExemption"]);
  });

  it("a clock that cannot be read leaves no oracle, because an age nobody can compute is not published beside a price", async () => {
    const owner = key();
    const wallet = key();
    const chain = fullChain(owner, wallet);
    chain.accounts.set(SYSVAR_CLOCK, null);
    const answer = await setup(chain).live({ action: "snapshot", owner, wallets: [wallet], discover: false });
    expect(answer.json.pyth).toBeNull();
    expect(answer.json.prices.usdcRawPerSol).toBe("100038711");
  });

  it("no vault is missing, which is a different answer from unreadable", async () => {
    const owner = key();
    const { live } = setup();
    const answer = await live({ action: "snapshot", owner, wallets: [], discover: false });
    expect([answer.json.vault.status, answer.json.policy.status, answer.json.config.status]).toEqual(["missing", "missing", "missing"]);
    expect(answer.json.rents.vault).toBe(String(localRent(125)));
  });
});

describe("activity", () => {
  const owner = key();
  const wallet = key();
  const vault = deriveVaultPda(owner).toBase58();

  const withHistory = (signatures: readonly string[]): LiveChain => ({
    accounts: new Map(),
    signatures: signatures.map((signature, index) => ({ signature, slot: 4_200 - index, blockTime: 1_789_500_000, err: null })),
    transactions: new Map(signatures.map((signature) => [signature, settleTransaction(vault, wallet, 60_000_000n)])),
  });

  it("classifies each transaction, with bigints as strings, in two upstream requests", async () => {
    const { live, upstream } = setup(withHistory([SIGNATURE_A]));
    const answer = await live({ action: "activity", owner, limit: 1 });

    expect(answer.status).toBe(200);
    expect(methodsOf(upstream.calls)).toEqual(["getSignaturesForAddress", "getTransaction"]);
    expect(answer.json).toMatchObject({ vault, status: "exists", nextBefore: SIGNATURE_A, gap: false });
    const [entry] = answer.json.entries;
    expect(entry).toMatchObject({ signature: SIGNATURE_A, ok: true, fee: "5000" });
    expect(entry.events).toEqual([
      {
        kind: "settled",
        wallet,
        mode: 0,
        baseLamports: "500000000",
        bps: 2_000,
        owed: "100000000",
        paid: "60000000",
        capped: true,
        settlementNonce: "0",
        linkEpoch: "200",
        sessionStartSlot: "200",
        sessionEndSlot: "220",
      },
    ]);
  });

  it("a full page against `until` reports a gap, so the client reloads its head instead of stitching a hole", async () => {
    const { live } = setup(withHistory([SIGNATURE_A, SIGNATURE_B]));
    const full = await live({ action: "activity", owner, limit: 2, until: SIGNATURE_C });
    expect(full.json.gap).toBe(true);
    const short = await live({ action: "activity", owner, limit: 3, until: SIGNATURE_C });
    expect(short.json.gap).toBe(false);
    // Without `until` a full page is simply a page: `before` pages through it.
    const paged = await live({ action: "activity", owner, limit: 2 });
    expect([paged.json.gap, paged.json.nextBefore]).toEqual([false, SIGNATURE_B]);
  });

  it("a history that could not be read is unreadable, never an empty history", async () => {
    const { live } = setup({ accounts: new Map(), down: true });
    const answer = await live({ action: "activity", owner });
    expect(answer.status).toBe(200);
    expect(answer.json).toMatchObject({ status: "unreadable", entries: [], nextBefore: null });
    expect(answer.text).not.toContain(SECRET_QUERY);
  });

  it("no history at all is an empty page, and reads no transaction", async () => {
    const { live, upstream } = setup({ accounts: new Map(), signatures: [] });
    const answer = await live({ action: "activity", owner });
    expect(answer.json).toMatchObject({ status: "exists", entries: [], nextBefore: null });
    expect(methodsOf(upstream.calls)).toEqual(["getSignaturesForAddress"]);
  });
});

describe("what a request costs", () => {
  const client = { "x-envoy-external-address": "203.0.113.77" };

  it(`a snapshot takes exactly ${LIVE_READS_WEIGHT.snapshot} client tokens and ${LIVE_READS_WEIGHT.snapshot} reads, ${LIVE_READS_WEIGHT.snapshotDiscover} with discover`, async () => {
    for (const [discover, weight] of [
      [false, LIVE_READS_WEIGHT.snapshot],
      [true, LIVE_READS_WEIGHT.snapshotDiscover],
    ] as const) {
      const clientBucket = counting(60);
      const reads = counting(1_800);
      const { live } = setup(fullChain(key(), key()), { limiter: clientBucket.limiter, readsBudget: reads.limiter });
      expect((await live({ action: "snapshot", owner: key(), wallets: [], discover }, client)).status).toBe(200);
      expect([discover, clientBucket.spent(), reads.spent()]).toEqual([discover, weight, weight]);
    }
  });

  it(`activity takes ${BUILD_REQUEST_WEIGHT} on entry and then one per transaction, charged BEFORE the batch`, async () => {
    const owner = key();
    const vault = deriveVaultPda(owner).toBase58();
    const signatures = [SIGNATURE_A, SIGNATURE_B, SIGNATURE_C];
    const clientBucket = counting(60);
    const reads = counting(1_800);
    const { live } = setup(
      {
        accounts: new Map(),
        signatures: signatures.map((signature) => ({ signature, slot: 1, blockTime: 1, err: null })),
        transactions: new Map(signatures.map((signature) => [signature, settleTransaction(vault, key(), 1n)])),
      },
      { limiter: clientBucket.limiter, readsBudget: reads.limiter },
    );
    expect((await live({ action: "activity", owner, limit: 3 }, client)).status).toBe(200);
    // 3 on entry + 3 transactions; the signatures call is covered by the entry charge.
    expect(clientBucket.spent()).toBe(BUILD_REQUEST_WEIGHT + signatures.length);
    expect(reads.spent()).toBe(LIVE_READS_WEIGHT.signatures + signatures.length);
  });

  it("a client without a token per transaction is refused with retry-after, and NOT ONE getTransaction is made", async () => {
    const owner = key();
    const vault = deriveVaultPda(owner).toBase58();
    const signatures = [SIGNATURE_A, SIGNATURE_B, SIGNATURE_C];
    const { live, upstream } = setup(
      {
        accounts: new Map(),
        signatures: signatures.map((signature) => ({ signature, slot: 1, blockTime: 1, err: null })),
        transactions: new Map(signatures.map((signature) => [signature, settleTransaction(vault, key(), 1n)])),
      },
      // Enough for the entry charge, not for three transactions.
      { limiter: createWeightedLimiter({ capacity: BUILD_REQUEST_WEIGHT + 2 }) },
    );
    const answer = await live({ action: "activity", owner, limit: 3 }, client);
    expect([answer.status, answer.json.error?.code]).toEqual([429, "rate_limited"]);
    expect(answer.headers.get("retry-after")).not.toBeNull();
    expect(answer.json.error?.retryAfterSeconds).toBeGreaterThan(0);
    expect(methodsOf(upstream.calls)).toEqual(["getSignaturesForAddress"]);
    expect(methodsOf(upstream.calls)).not.toContain("getTransaction");
  });
});

describe("its buckets are its own, and its reads are everyone's", () => {
  it("a client that emptied /api/solana-vault's bucket still gets live answers", async () => {
    const owner = key();
    const chain = fullChain(owner, key());
    const upstream = fakeFetch(answerLive(chain));
    const options: SolanaVaultHandlerOptions = { gate: () => OK_GATE, fetch: upstream.fetch, now: () => 0, onRefusal: () => undefined };
    // Each handler builds its own per-client limiters (createRoute), as the two routes do in the app.
    const vaultRoute = createSolanaVaultHandler(options);
    const liveRoute = createSolanaLiveHandler(options);
    const client = { "x-envoy-external-address": "203.0.113.88" };

    let refused = 0;
    for (let attempt = 0; attempt < 12; attempt++) {
      const answer = await vaultRoute.POST(post("vault", { action: "state", owner, wallets: [] }, client));
      if (answer.status === 429) refused += 1;
    }
    expect(refused).toBeGreaterThan(0);

    const live = await read(await liveRoute.POST(post("live", { action: "snapshot", owner, wallets: [], discover: false }, client)));
    expect(live.status).toBe(200);
  });

  it("live and vault spend the SAME reads budget, so the Helius exposure does not grow", async () => {
    const owner = key();
    const chain = fullChain(owner, key());
    const upstream = fakeFetch(answerLive(chain));
    const reads = counting(1_800);
    const options: SolanaVaultHandlerOptions = { gate: () => OK_GATE, fetch: upstream.fetch, now: () => 0, onRefusal: () => undefined, readsBudget: reads.limiter };
    const vaultRoute = createSolanaVaultHandler(options);
    const liveRoute = createSolanaLiveHandler(options);

    expect((await vaultRoute.POST(post("vault", { action: "state", owner, wallets: [] }))).status).toBe(200);
    expect(reads.spent()).toBe(BUILD_READS_WEIGHT.state);
    expect((await liveRoute.POST(post("live", { action: "snapshot", owner, wallets: [], discover: false }))).status).toBe(200);
    expect(reads.spent()).toBe(BUILD_READS_WEIGHT.state + LIVE_READS_WEIGHT.snapshot);
  });

  it("the process-wide reads budget refuses a well-formed snapshot before any read", async () => {
    const { live, upstream } = setup(fullChain(key(), key()), { readsBudget: createWeightedLimiter({ capacity: LIVE_READS_WEIGHT.snapshot }) });
    expect((await live({ action: "snapshot", owner: key(), wallets: [], discover: false })).status).toBe(200);
    const calls = upstream.calls.length;
    const refused = await live({ action: "snapshot", owner: key(), wallets: [], discover: false });
    expect([refused.status, refused.json.error?.code]).toEqual([429, "rate_limited"]);
    expect(upstream.calls).toHaveLength(calls);
  });
});
