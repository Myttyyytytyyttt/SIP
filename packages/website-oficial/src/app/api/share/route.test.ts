// /api/share as wired in this app (owner, 10-22: "Enlace con vista previa"):
// the secret first, then the Solana routes' own pipeline, then the card READ
// from a stub chain and signed — never a figure the request states — and the
// streak proven from transactions the route reads itself. No network.

import {
  SIP_ACCOUNT_SPACE,
  SIP_PROGRAM_ID,
  accountDiscriminator,
  base58Encode,
  base64Encode,
  encodeArgs,
  encodeStruct,
  eventDiscriminator,
} from "@sip/solana-core/client";
import { createWeightedLimiter, deriveConfigPda, deriveVaultPda } from "@sip/solana-core/server";
import { Keypair } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";

import { SHARE_BACKGROUNDS } from "@/lib/live-share";
import { SHARE_MAX_BODY_BYTES, shareRoute, type ShareLinkAnswer } from "@/lib/share-server";
import { SHARE_SECRET_ENV, openShareToken } from "@/lib/share-token";

const SECRET = "c".repeat(64);
const SOLANA_ENV = {
  SIP_SOLANA_RPC_URLS: "https://upstream.invalid/?api-key=SHAREROUTESECRET",
  SIP_SOLANA_PROGRAM_ID: SIP_PROGRAM_ID,
  SIP_TRUSTED_CLIENT_IP_HEADER: "x-envoy-external-address",
} as const;
const ENV = { ...SOLANA_ENV, [SHARE_SECRET_ENV]: SECRET };
const NOW = Date.UTC(2026, 9, 22, 15, 0, 0);
const DAY = 86_400_000;
const seconds = (ms: number): number => Math.floor(ms / 1_000);

let lastIp = 0;
const freshIp = (): string => `203.0.113.${(lastIp = (lastIp % 250) + 1)}`;
const someKey = (): string => Keypair.generate().publicKey.toBase58();
const someSignature = (): string => base58Encode(Keypair.generate().secretKey);

type AccountJson = { data: [string, "base64"]; lamports: number; owner: string; executable: boolean; rentEpoch: number; space: number };
type RpcCall = { readonly id?: unknown; readonly method?: string; readonly params?: readonly unknown[] };

function sipAccount(name: "Vault" | "ProtocolConfig", fields: Record<string, unknown>, lamports = 2_000_000): AccountJson {
  const bytes = new Uint8Array(SIP_ACCOUNT_SPACE[name]);
  bytes.set(accountDiscriminator(name), 0);
  bytes.set(encodeStruct(name, fields), 8);
  return { data: [base64Encode(bytes), "base64"], lamports, owner: SIP_PROGRAM_ID, executable: false, rentEpoch: 0, space: bytes.length };
}

const reserved = (length: number) => new Array(length).fill(0);

/** A vault of `owner` that has saved `saved` lamports since 40 days before NOW, at 20 % of its gains. */
function vaultOf(owner: string, saved: bigint): [string, AccountJson][] {
  return [
    [
      deriveVaultPda(owner).toBase58(),
      sipAccount(
        "Vault",
        { owner, bump: 255, version: 2, paused: false, skim_bps: 2_000, lifetime_saved: saved, created_at: BigInt(seconds(NOW - 40 * DAY)), skim_mode: 0, volume_bps: 200, policy_nonce: 0n, max_contribution: 60_000_000n, wallet_reserve: 50_000_000n, _reserved: reserved(37) },
        300_000_000,
      ),
    ],
    [deriveConfigPda().toBase58(), sipAccount("ProtocolConfig", { authority: someKey(), attester: someKey(), bump: 253, keeper: someKey(), pending_authority: "11111111111111111111111111111111", paused: false, version: 2, _reserved: reserved(64) })],
  ];
}

/** A settle_v2 into `vault` that paid `paid`, at `blockTime` — the shape getTransaction answers (core's handlers-live.test.ts). */
function settleTransaction(vault: string, paid: bigint, blockTime: number): unknown {
  const wallet = someKey();
  const body = encodeStruct("Settled", {
    vault,
    wallet,
    mode: 0,
    base_lamports: 500_000_000n,
    bps: 2_000,
    owed: paid,
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
    blockTime,
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

interface Chain {
  readonly accounts: Map<string, AccountJson>;
  readonly transactions?: Map<string, unknown>;
  readonly down?: boolean;
}

function upstream(chain: Chain) {
  const methods: string[] = [];
  const one = (call: RpcCall): Record<string, unknown> => {
    const params = call.params ?? [];
    methods.push(String(call.method));
    switch (call.method) {
      case "getMultipleAccounts":
        return { jsonrpc: "2.0", id: call.id ?? null, result: { context: { slot: 9 }, value: (params[0] as string[]).map((address) => chain.accounts.get(address) ?? null) } };
      case "getMinimumBalanceForRentExemption":
        return { jsonrpc: "2.0", id: call.id ?? null, result: ((params[0] as number) + 128) * 5_080 };
      case "getTransaction":
        return { jsonrpc: "2.0", id: call.id ?? null, result: chain.transactions?.get(params[0] as string) ?? null };
      default:
        return { jsonrpc: "2.0", id: call.id ?? null, error: { code: -32601, message: "not stubbed" } };
    }
  };
  const fetch = vi.fn(async (_input: unknown, init?: RequestInit): Promise<Response> => {
    if (chain.down === true) throw new Error("socket hang up https://upstream.invalid/?api-key=SHAREROUTESECRET");
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "null") as RpcCall | RpcCall[];
    return new Response(JSON.stringify(Array.isArray(body) ? body.map(one) : one(body)), { status: 200, headers: { "content-type": "application/json" } });
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls: fetch, methods };
}

function request(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://saverfi.example/api/share", {
    method: "POST",
    headers: { "content-type": "application/json", "x-envoy-external-address": freshIp(), ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function setup(chain: Chain, options: Partial<Parameters<typeof shareRoute>[0]> = {}) {
  const net = upstream(chain);
  const route = shareRoute({ env: ENV, fetch: net.fetch, now: () => NOW, onRefusal: () => undefined, shareBudget: createWeightedLimiter({ capacity: 1_000 }), ...options });
  const post = async (body: unknown, headers?: Record<string, string>) => {
    const response = await route.POST(request(body, headers));
    const text = await response.text();
    return { status: response.status, text, json: JSON.parse(text) as Record<string, any> };
  };
  return { net, route, post };
}

describe("/api/share without its secret", () => {
  it("is 404 share_links_off, and reads nothing", async () => {
    const owner = someKey();
    const { net, post } = setup({ accounts: new Map(vaultOf(owner, 60_000_000n)) }, { env: SOLANA_ENV });
    const answer = await post({ action: "link", owner, streak: [] });
    expect([answer.status, answer.json.error?.code]).toEqual([404, "share_links_off"]);
    expect(net.calls).not.toHaveBeenCalled();
  });
});

describe("/api/share", () => {
  it("reads the card from the chain and signs a link per background and unit — nothing of anyone's in them", async () => {
    const owner = someKey();
    const vault = deriveVaultPda(owner).toBase58();
    const { net, post } = setup({ accounts: new Map(vaultOf(owner, 11_420_734_512n)) });
    const answer = await post({ action: "link", owner, streak: [] });
    expect(answer.status).toBe(200);
    const body = answer.json as unknown as ShareLinkAnswer;
    // No pools in this stub, so no price: the card is in SOL, to two places, read from the vault's own counter.
    expect(body.card).toMatchObject({ state: "saved", solText: "11.42", usdText: null, rate: "20%", mode: "profit", since: "Sep 2026", streakDays: null, example: false, day: "2026-10-22" });
    expect(body.streak).toEqual({ claimed: 0, proven: null });
    for (const background of SHARE_BACKGROUNDS) {
      expect(Object.keys(body.links[background])).toEqual(["sol"]);
      const opened = openShareToken(body.links[background].sol!.slice(3), ENV);
      expect(opened).toMatchObject({ background, unit: "sol", card: { solText: "11.42", rate: "20%", day: "2026-10-22" } });
    }
    expect(answer.text).not.toContain(owner);
    expect(answer.text).not.toContain(vault);
    expect(answer.text).not.toContain("11420734512");
    // One batch: the snapshot, and nothing else.
    expect(net.calls).toHaveBeenCalledTimes(1);
  });

  it("a figure in the request is not a field: the card is never what a client says", async () => {
    const owner = someKey();
    const { post } = setup({ accounts: new Map(vaultOf(owner, 60_000_000n)) });
    const answer = await post({ action: "link", owner, streak: [], usdText: "$1,000,000.00" });
    expect([answer.status, answer.json.error?.code]).toEqual([400, "bad_request"]);
  });

  it("an honest streak comes back proven, from the transactions it names; it is on the card", async () => {
    const owner = someKey();
    const vault = deriveVaultPda(owner).toBase58();
    const signatures = [0, 1, 2].map(() => someSignature());
    const transactions = new Map(signatures.map((signature, ago) => [signature, settleTransaction(vault, 1_000_000n, seconds(NOW - ago * DAY - 3_600_000))]));
    const { net, post } = setup({ accounts: new Map(vaultOf(owner, 60_000_000n)), transactions });
    const answer = await post({ action: "link", owner, streak: signatures });
    expect(answer.status).toBe(200);
    expect(answer.json.streak).toEqual({ claimed: 3, proven: 3 });
    expect(answer.json.card.streakDays).toBe(3);
    expect(net.methods.filter((method) => method === "getTransaction")).toHaveLength(3);
    expect(openShareToken((answer.json as unknown as ShareLinkAnswer).links.grid.sol!.slice(3), ENV)?.card.streakDays).toBe(3);
  });

  it("an inflated one is not stated at all — somebody else's settlement proves nothing, and no smaller number is printed", async () => {
    const owner = someKey();
    const vault = deriveVaultPda(owner).toBase58();
    const signatures = [0, 1, 2].map(() => someSignature());
    const transactions = new Map(
      signatures.map((signature, ago) => [signature, settleTransaction(ago === 1 ? deriveVaultPda(someKey()).toBase58() : vault, 1_000_000n, seconds(NOW - ago * DAY - 3_600_000))]),
    );
    const { post } = setup({ accounts: new Map(vaultOf(owner, 60_000_000n)), transactions });
    const answer = await post({ action: "link", owner, streak: signatures });
    expect(answer.json.streak).toEqual({ claimed: 3, proven: 1 });
    expect(answer.json.card.streakDays).toBeNull();
  });

  it("a second ask within the minute reads nothing again; a proven day is not read twice", async () => {
    const owner = someKey();
    const vault = deriveVaultPda(owner).toBase58();
    const signatures = [0, 1].map(() => someSignature());
    const transactions = new Map(signatures.map((signature, ago) => [signature, settleTransaction(vault, 1_000_000n, seconds(NOW - ago * DAY - 3_600_000))]));
    const { net, post } = setup({ accounts: new Map(vaultOf(owner, 60_000_000n)), transactions });
    expect((await post({ action: "link", owner, streak: signatures })).status).toBe(200);
    const calls = net.calls.mock.calls.length;
    const again = await post({ action: "link", owner, streak: signatures });
    expect([again.status, again.json.card.streakDays]).toEqual([200, 2]);
    expect(net.calls.mock.calls.length).toBe(calls);
  });

  it("no vault is 404 vault_missing; a chain that cannot be read is 502, never a card of nothing", async () => {
    const empty = setup({ accounts: new Map() });
    const missing = await empty.post({ action: "link", owner: someKey(), streak: [] });
    expect([missing.status, missing.json.error?.code]).toEqual([404, "vault_missing"]);
    const down = setup({ accounts: new Map(), down: true });
    const unreadable = await down.post({ action: "link", owner: someKey(), streak: [] });
    expect([unreadable.status, unreadable.json.error?.code]).toEqual([502, "unreadable"]);
    expect(unreadable.text).not.toContain("SHAREROUTESECRET");
  });

  it("refuses before any read: a bad owner, a streak that is not signatures, too many, repeated; an unknown action; a body over its cap; cross-site", async () => {
    const owner = someKey();
    const { net, post } = setup({ accounts: new Map(vaultOf(owner, 60_000_000n)) });
    const sig = someSignature();
    for (const body of [
      { action: "link", owner: "nope", streak: [] },
      { action: "link", owner, streak: "x" },
      { action: "link", owner, streak: ["nope"] },
      { action: "link", owner, streak: [sig, sig] },
      { action: "link", owner, streak: Array.from({ length: 46 }, () => someSignature()) },
      { action: "link", owner },
      { action: "snapshot", owner, streak: [] },
    ]) {
      const answer = await post(body);
      expect([answer.status, answer.json.error?.code], JSON.stringify(body).slice(0, 60)).toEqual([400, "bad_request"]);
    }
    expect((await post({ action: "link", owner, streak: [], pad: "x".repeat(SHARE_MAX_BODY_BYTES) })).status).toBe(413);
    expect((await post({ action: "link", owner, streak: [] }, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect(net.calls).not.toHaveBeenCalled();
    // 45 is the cap, not one over it.
    const most = await post({ action: "link", owner, streak: Array.from({ length: 45 }, () => someSignature()) });
    expect(most.status).toBe(200);
  });

  it("is rate-limited per client, before its body is read and before any read", async () => {
    const owner = someKey();
    const { net, route } = setup({ accounts: new Map(vaultOf(owner, 60_000_000n)) }, { limiter: createWeightedLimiter({ capacity: 6 }) });
    const ip = { "x-envoy-external-address": "198.51.100.77" };
    expect((await route.POST(request({ action: "link", owner, streak: [] }, ip))).status).toBe(200);
    const refused = await route.POST(request({ action: "link", owner: someKey(), streak: [] }, ip));
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).not.toBeNull();
    expect(net.calls).toHaveBeenCalledTimes(1);
  });

  it("and by a budget of its own across everyone, so shares can never starve Live", async () => {
    const owner = someKey();
    const { net, post } = setup({ accounts: new Map(vaultOf(owner, 60_000_000n)) }, { shareBudget: createWeightedLimiter({ capacity: 4 }) });
    expect((await post({ action: "link", owner, streak: [] })).status).toBe(200);
    const refused = await post({ action: "link", owner: someKey(), streak: [] });
    expect([refused.status, refused.json.error?.code]).toEqual([429, "rate_limited"]);
    expect(net.calls).toHaveBeenCalledTimes(1);
  });

  it("GET is 405", () => {
    expect(setup({ accounts: new Map() }).route.GET().status).toBe(405);
  });
});
