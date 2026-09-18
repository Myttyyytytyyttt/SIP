// The Privy signer's path, against a fetch that never leaves the process: where
// the wallet index and a settle's send go, how often a send is tried, what it
// carries and signs, what the SDK logs meanwhile, and what the signer will not
// send at all.
//
// No network and no credential: the fetch below records every request and
// answers it itself, the app secret is a throwaway string, the authorization key
// comes from the SDK's own generateP256KeyPair (local WebCrypto), and every
// Solana key is Keypair.generate(). The settle is built by settle-tick.ts's own
// builders (test/settle-transaction.ts).

import { createHash, createPublicKey, verify } from "node:crypto";
import { formatRequestForAuthorizationSignature, generateP256KeyPair } from "@privy-io/node";
import { Secret } from "@sip/solana-log";
import { ComputeBudgetProgram, Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { instructionDiscriminator } from "../src/idl.js";
import { COMPUTE_BUDGET_PROGRAM_ID, MEMO_PROGRAM_ID, type SignerSeat } from "../src/privy-policy.js";
import {
  PRIVY_API_URL,
  SOLANA_MAINNET_CAIP2,
  assertSettleShape,
  buildPrivySolanaIndex,
  createPrivySolanaSigner,
  unsignableNote,
  type PrivySolanaConfig,
  type SolanaWalletSubmitter,
} from "../src/privy-signer.js";
import { buildTestSettle, type TestSettle } from "./settle-transaction.js";

interface Sent {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: string | null;
}

interface Answer {
  readonly status: number;
  readonly body: unknown;
}

/** A fetch that answers every request as `answer` says, and remembers what was asked. */
function answering(answer: (request: Sent) => Answer): { readonly fetch: typeof globalThis.fetch; readonly sent: Sent[] } {
  const sent: Sent[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : null;
    const entry: Sent = {
      url: request?.url ?? String(input),
      method: init?.method ?? request?.method ?? "GET",
      headers: new Headers(init?.headers ?? request?.headers),
      body: typeof init?.body === "string" ? init.body : null,
    };
    sent.push(entry);
    const { status, body } = answer(entry);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  return { fetch, sent };
}

const APP_ID = "sipprivyapp0000000000000001";
const SIGNER_ID = "keeperQuorum000000000001";
const WALLET_ID = "privyWallet0000000000001";
/** The policy the web attaches as the keeper signer's override, and the only one that bounds it. */
const POLICY_ID = "keeperPolicy00000000001";
/** An idempotency key of the shape settle-tick.ts makes. */
const KEY = createHash("sha256").update("one settle attempt").digest("hex");

const configFor = (fetch: typeof globalThis.fetch, authorizationKey: string): PrivySolanaConfig => ({
  appId: APP_ID,
  appSecret: new Secret("privy-app-secret-NeverSent-0009", "privyAppSecret"),
  authorizationKey: new Secret(authorizationKey, "privyAuthorizationKey"),
  fetch,
});

/** A one-entry index: the wallet, seated as `seats` says. */
const indexOf = (address: string, seats: readonly SignerSeat[]): Map<string, { walletId: string; seats: readonly SignerSeat[] }> =>
  new Map([[address, { walletId: WALLET_ID, seats }]]);

/** The seat the web creates: the keeper's signer, bounded by exactly the keeper's policy. */
const bounded: readonly SignerSeat[] = [{ signerId: SIGNER_ID, overridePolicyIds: [POLICY_ID] }];

/** The signer for `settle`'s wallet, from a one-entry index: its only requests are its sends. */
async function signerFor(settle: TestSettle, fetch: typeof globalThis.fetch, authorizationKey: string): Promise<SolanaWalletSubmitter> {
  const index = indexOf(settle.wallet.toBase58(), bounded);
  // With the policy expected, so the send path below is the one a bounded seat takes.
  const resolution = await createPrivySolanaSigner(configFor(fetch, authorizationKey), settle.wallet, SIGNER_ID, index, POLICY_ID);
  if (resolution.outcome !== "SIGNER") throw new Error(`expected a signer, got ${resolution.outcome}`);
  return resolution.signer;
}

const hashAnswer = (): Answer => ({ status: 200, body: { method: "signAndSendTransaction", data: { hash: "settle-hash", caip2: SOLANA_MAINNET_CAIP2 } } });

let logged: MockInstance[] = [];

beforeEach(() => {
  // What the SDK would obey if a client were not pinned: another host for the
  // app secret, and request details in the log.
  vi.stubEnv("PRIVY_API_BASE_URL", "http://127.0.0.1:9/");
  vi.stubEnv("PRIVY_API_LOG", "debug");
  logged = [vi.spyOn(console, "debug").mockImplementation(() => undefined), vi.spyOn(console, "info").mockImplementation(() => undefined)];
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const expectNothingLogged = (): void => {
  for (const spy of logged) expect(spy).not.toHaveBeenCalled();
};

describe("buildPrivySolanaIndex", () => {
  it("reads every page from api.privy.io and logs no request details, whatever PRIVY_API_BASE_URL and PRIVY_API_LOG say", async () => {
    const first = Keypair.generate().publicKey.toBase58();
    const second = Keypair.generate().publicKey.toBase58();
    const { fetch, sent } = answering((request) =>
      new URL(request.url).searchParams.get("cursor") === null
        ? {
            status: 200,
            body: {
              data: [{ id: "wallet-1", address: first, chain_type: "solana", additional_signers: [{ signer_id: SIGNER_ID, override_policy_ids: [POLICY_ID] }] }],
              next_cursor: "page-2",
            },
          }
        : { status: 200, body: { data: [{ id: "wallet-2", address: second, chain_type: "solana", additional_signers: [] }], next_cursor: null } },
    );

    const index = await buildPrivySolanaIndex(configFor(fetch, "unused"));

    // WHAT BOUNDS EACH SEAT COMES OUT OF THIS SAME LISTING: override_policy_ids
    // is on the wallets Privy already sends, so no second request is needed to
    // tell a bounded seat from an unbounded one.
    expect([...index]).toEqual([
      [first, { walletId: "wallet-1", seats: [{ signerId: SIGNER_ID, overridePolicyIds: [POLICY_ID] }] }],
      [second, { walletId: "wallet-2", seats: [] }],
    ]);
    expect(sent.map((request) => [request.method, new URL(request.url).origin, new URL(request.url).pathname])).toEqual([
      ["GET", PRIVY_API_URL, "/v1/wallets"],
      ["GET", PRIVY_API_URL, "/v1/wallets"],
    ]);
    expectNothingLogged();
  });
});

describe("the seat's policy", () => {
  const wallet = Keypair.generate().publicKey;
  /**
   * Resolve `seats` for this wallet. `expectedPolicyId` is ALWAYS passed
   * explicitly — no default — because a default would swallow the `undefined`
   * that the "not configured" case exists to test.
   */
  const resolve = async (seats: readonly SignerSeat[], expectedPolicyId: string | undefined) => {
    const { fetch, sent } = answering(hashAnswer);
    const resolution = await createPrivySolanaSigner(
      configFor(fetch, "unused"),
      wallet,
      SIGNER_ID,
      indexOf(wallet.toBase58(), seats),
      expectedPolicyId,
    );
    return { outcome: resolution.outcome, requests: sent.length };
  };

  /** The cases `privy-policy verify` pins, asked of the keeper's own signer: one rule, two callers. */
  const unbounded: [string, readonly SignerSeat[]][] = [
    ["a seat with no override policy at all", [{ signerId: SIGNER_ID, overridePolicyIds: [] }]],
    ["a seat bounded by another policy", [{ signerId: SIGNER_ID, overridePolicyIds: ["anotherPolicy"] }]],
    ["a seat carrying two policies, one of them ours", [{ signerId: SIGNER_ID, overridePolicyIds: [POLICY_ID, "anotherPolicy"] }]],
    [
      "one bounded seat and one that is not",
      [
        { signerId: SIGNER_ID, overridePolicyIds: [POLICY_ID] },
        { signerId: SIGNER_ID, overridePolicyIds: [] },
      ],
    ],
  ];

  it("refuses to sign for a wallet whose seat this policy does not bound, and asks Privy nothing more", async () => {
    for (const [name, seats] of unbounded) {
      expect(await resolve(seats, POLICY_ID), name).toEqual({ outcome: "SEAT_NOT_BOUNDED", requests: 0 });
    }
    // Still told apart from the two conditions that are an unfinished onboarding.
    expect(await resolve([{ signerId: "someOtherSigner", overridePolicyIds: [POLICY_ID] }], POLICY_ID)).toEqual({
      outcome: "SIGNER_NOT_GRANTED",
      requests: 0,
    });
    expect(await resolve(bounded, POLICY_ID)).toEqual({ outcome: "SIGNER", requests: 0 });
  });

  it("reports what the seat actually carries, so the alert says what to repair", async () => {
    const { fetch } = answering(hashAnswer);
    const seats: readonly SignerSeat[] = [{ signerId: SIGNER_ID, overridePolicyIds: ["anotherPolicy"] }, { signerId: "someOtherSigner", overridePolicyIds: [] }];
    const resolution = await createPrivySolanaSigner(configFor(fetch, "unused"), wallet, SIGNER_ID, indexOf(wallet.toBase58(), seats), POLICY_ID);

    expect(resolution).toMatchObject({
      outcome: "SEAT_NOT_BOUNDED",
      granted: [SIGNER_ID, "someOtherSigner"],
      // Per seat, exactly as `privy-policy verify` prints it.
      overridePolicyIds: [["anotherPolicy"]],
    });
  });

  it("CANNOT REFUSE WITH NO POLICY CONFIGURED: the same wallets still resolve to a signer", async () => {
    // The rule is reached only through the argument the keeper passes when
    // SIP_SOLANA_PRIVY_POLICY_ID is set. Unset, the keeper passes nothing and
    // behaves exactly as it did before this check existed.
    for (const [name, seats] of unbounded) {
      expect(await resolve(seats, undefined), name).toEqual({ outcome: "SIGNER", requests: 0 });
    }
    // And with no signer id there is no seat to look for, so nothing is guessed at.
    const { fetch } = answering(hashAnswer);
    const resolution = await createPrivySolanaSigner(
      configFor(fetch, "unused"),
      wallet,
      undefined,
      indexOf(wallet.toBase58(), [{ signerId: SIGNER_ID, overridePolicyIds: [] }]),
      POLICY_ID,
    );
    expect(resolution.outcome).toBe("SIGNER");
  });
});

describe("a settle through the Privy signer", () => {
  it("is one POST to api.privy.io's rpc for its wallet, signed by the authorization key over the idempotency key it was given", async () => {
    const settle = await buildTestSettle();
    const pair = await generateP256KeyPair();
    const { fetch, sent } = answering(hashAnswer);
    const signer = await signerFor(settle, fetch, pair.privateKey);

    await expect(signer.submit(settle.transaction, { idempotencyKey: KEY })).resolves.toBe("settle-hash");

    expect(sent).toHaveLength(1);
    const request = sent[0]!;
    expect([request.method, request.url]).toEqual(["POST", `${PRIVY_API_URL}/v1/wallets/${WALLET_ID}/rpc`]);
    const body = JSON.parse(request.body ?? "null") as Record<string, unknown>;
    expect(body).toEqual({
      method: "signAndSendTransaction",
      chain_type: "solana",
      caip2: SOLANA_MAINNET_CAIP2,
      params: {
        transaction: settle.transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"),
        encoding: "base64",
      },
    });
    expect(request.headers.get("privy-idempotency-key")).toBe(KEY);

    // THE KEY IS INSIDE THE SIGNATURE, not only beside it: the authorization
    // signature verifies over this request with this key, and with no other.
    const signature = request.headers.get("privy-authorization-signature");
    expect(signature).toMatch(/^[A-Za-z0-9+/]+=*$/);
    const publicKey = createPublicKey({ key: Buffer.from(pair.publicKey, "base64"), format: "der", type: "spki" });
    const verifiesWith = (idempotencyKey: string): boolean =>
      verify(
        "sha256",
        formatRequestForAuthorizationSignature({
          version: 1,
          method: "POST",
          url: request.url,
          body,
          headers: { "privy-app-id": APP_ID, "privy-idempotency-key": idempotencyKey, "privy-request-expiry": request.headers.get("privy-request-expiry")! },
        }),
        { key: publicKey, dsaEncoding: "der" },
        Buffer.from(signature!, "base64"),
      );
    expect(verifiesWith(KEY)).toBe(true);
    expect(verifiesWith(createHash("sha256").update("another attempt").digest("hex"))).toBe(false);
    expectNothingLogged();
  });

  it("is tried once, even on a 504", async () => {
    const settle = await buildTestSettle();
    const { fetch, sent } = answering(() => ({ status: 504, body: { error: "gateway timeout" } }));
    const signer = await signerFor(settle, fetch, (await generateP256KeyPair()).privateKey);

    await expect(signer.submit(settle.transaction, { idempotencyKey: KEY })).rejects.toMatchObject({ status: 504 });
    expect(sent).toHaveLength(1);
    expectNothingLogged();
  });

  it("refuses anything but its own wallet's settle pair, before any request", async () => {
    const settle = await buildTestSettle();
    const { fetch, sent } = answering(hashAnswer);
    const signer = await signerFor(settle, fetch, (await generateP256KeyPair()).privateKey);
    const [verifyIx, settleIx] = settle.transaction.instructions as [TransactionInstruction, TransactionInstruction];
    const memo = new TransactionInstruction({ programId: new PublicKey(MEMO_PROGRAM_ID), keys: [], data: Buffer.from("sip") });
    const withMemo = new Transaction({ blockhash: settle.blockhash, lastValidBlockHeight: 1_000, feePayer: settle.wallet }).add(verifyIx, settleIx, memo);

    await expect(signer.submit(withMemo, { idempotencyKey: KEY })).rejects.toThrow(/not a settle: it has 3 instructions, not 2/);
    // A whole settle, but another wallet's: the signer holds it to the address it signs as.
    const another = await buildTestSettle();
    await expect(signer.submit(another.transaction, { idempotencyKey: KEY })).rejects.toThrow(
      new RegExp(`it is paid by ${another.wallet.toBase58()}, not the wallet ${settle.wallet.toBase58()}`),
    );
    expect(sent).toHaveLength(0);
  });
});

describe("assertSettleShape", () => {
  it("reads settle_v2's discriminator from the IDL, as Anchor derives it", () => {
    expect([...instructionDiscriminator("settle_v2")]).toEqual([5, 41, 238, 141, 219, 81, 39, 145]);
    expect(instructionDiscriminator("settle_v2").equals(createHash("sha256").update("global:settle_v2").digest().subarray(0, 8))).toBe(true);
  });

  it("passes the exact pair settle-tick.ts builds", async () => {
    const settle = await buildTestSettle();
    expect(settle.transaction.instructions).toHaveLength(2);
    expect(() => assertSettleShape(settle.transaction, settle.programId, settle.wallet)).not.toThrow();
  });

  it("refuses every other shape, naming what is wrong", async () => {
    const settle = await buildTestSettle();
    const [verifyIx, settleIx] = settle.transaction.instructions as [TransactionInstruction, TransactionInstruction];
    /** `instructions` under the settle's blockhash, paid by `feePayer` (null: no fee payer at all). */
    const tx = (instructions: TransactionInstruction[], feePayer: PublicKey | null = settle.wallet): Transaction =>
      new Transaction({ blockhash: settle.blockhash, lastValidBlockHeight: 1_000, ...(feePayer === null ? {} : { feePayer }) }).add(...instructions);
    const withData = (instruction: TransactionInstruction, data: Buffer): TransactionInstruction =>
      new TransactionInstruction({ programId: instruction.programId, keys: instruction.keys, data });
    const twoSignatures = Buffer.from(verifyIx.data);
    twoSignatures[0] = 2;
    const computeBudget = ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 });
    const memo = new TransactionInstruction({ programId: new PublicKey(MEMO_PROGRAM_ID), keys: [], data: Buffer.from("sip") });
    const sip = settle.programId.toBase58();

    const cases: [string, Transaction, RegExp][] = [
      ["the pair reversed", tx([settleIx, verifyIx]), new RegExp(`instruction 0 calls ${sip}, not Ed25519SigVerify`)],
      ["a ComputeBudget instruction added", tx([computeBudget, verifyIx, settleIx]), /it has 3 instructions, not 2/],
      ["a ComputeBudget instruction for the attestation", tx([computeBudget, settleIx]), new RegExp(`instruction 0 calls ${COMPUTE_BUDGET_PROGRAM_ID}, not Ed25519SigVerify`)],
      ["a Memo instruction added", tx([verifyIx, settleIx, memo]), /it has 3 instructions, not 2/],
      ["no Ed25519SigVerify", tx([settleIx]), /it has 1 instruction, not 2/],
      ["a second settle_v2", tx([verifyIx, settleIx, settleIx]), /it has 3 instructions, not 2/],
      ["link_wallet's discriminator", tx([verifyIx, withData(settleIx, Buffer.concat([instructionDiscriminator("link_wallet"), settleIx.data.subarray(8)]))]), /instruction 1 is not settle_v2/],
      [
        "settle_v2's bytes on another program",
        tx([verifyIx, new TransactionInstruction({ programId: Keypair.generate().publicKey, keys: settleIx.keys, data: settleIx.data })]),
        new RegExp(`instruction 1 calls \\w+, not sip-vault ${sip}`),
      ],
      [
        "an Ed25519SigVerify naming an account",
        tx([new TransactionInstruction({ programId: verifyIx.programId, keys: [{ pubkey: settle.wallet, isSigner: false, isWritable: false }], data: verifyIx.data }), settleIx]),
        /names 1 account, and it takes none/,
      ],
      ["an Ed25519SigVerify declaring two signatures", tx([withData(verifyIx, twoSignatures), settleIx]), /does not declare exactly one signature/],
      ["an Ed25519SigVerify with no header", tx([withData(verifyIx, Buffer.from([1])), settleIx]), /does not declare exactly one signature/],
      ["another fee payer", tx([verifyIx, settleIx], Keypair.generate().publicKey), new RegExp(`it is paid by \\w+, not the wallet ${settle.wallet.toBase58()}`)],
      ["no fee payer", tx([verifyIx, settleIx], null), /it is paid by no fee payer/],
    ];
    for (const [name, transaction, message] of cases) {
      expect(() => assertSettleShape(transaction, settle.programId, settle.wallet), name).toThrow(message);
    }
  });
});

describe("unsignableNote: the operator log's line for a wallet the keeper cannot sign for", () => {
  it("sends each case to the button on the web that fixes it, and never to an onboarding step", () => {
    // A wallet seated before a key rotation: it granted a signer, the keeper's OLD one.
    const rotated = unsignableNote({ outcome: "SIGNER_NOT_GRANTED", granted: ["oldKeeperSigner"] });
    expect(rotated).toContain("does not seat the keeper's current signer");
    expect(rotated).toContain("Re-seat keeper on the wallet's row at /wallets");
    const none = unsignableNote({ outcome: "SIGNER_NOT_GRANTED", granted: [] });
    expect(none).toContain("Grant keeper permission on the wallet's row at /wallets");
    const unbounded = unsignableNote({ outcome: "SEAT_NOT_BOUNDED", granted: ["keeper"], overridePolicyIds: [[]] });
    expect(unbounded).toContain("without the keeper's policy");
    expect(unbounded).toContain("Re-seat keeper on the wallet's row at /wallets");
    expect(unsignableNote({ outcome: "NOT_A_PRIVY_WALLET" })).toBe("wallet is not a Privy wallet in this app");
    for (const note of [rotated, none, unbounded]) expect(note).not.toMatch(/onboarding|step 3|re-run/i);
  });
});
