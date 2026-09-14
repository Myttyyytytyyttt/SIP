// Shared test fixtures. Every key is generated per run (Keypair.generate); the
// endpoint URLs are .invalid hosts with obviously fake keys. No network.

import { createPrivateKey, sign } from "node:crypto";
import { Keypair, Transaction, TransactionInstruction, VersionedTransaction, type PublicKey } from "@solana/web3.js";

import { base58Encode } from "../src/client/base58";
import { base64Encode, tryBase64Decode } from "../src/client/base64";
import { buildLinkWallet, prepareLinkWalletConsent } from "../src/server/builders";

/** A fixed, valid-looking blockhash so transaction bytes are deterministic per key set. */
export const BLOCKHASH = base58Encode(Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 1) & 0xff));

export const SECRET_QUERY = "SECRETKEY123";
export const UPSTREAM_1 = `https://upstream.invalid/?api-key=${SECRET_QUERY}`;
export const UPSTREAM_2 = "https://second.invalid/v2/PATHTOKEN456";

export const keypair = (): Keypair => Keypair.generate();

export const b64 = (bytes: Uint8Array): string => base64Encode(bytes);

export function fromB64(text: string): Uint8Array {
  const bytes = tryBase64Decode(text);
  if (bytes === null) throw new Error("not base64");
  return bytes;
}

/** Signs an unsigned wire transaction with each keypair in turn, over the same message. */
export function signWire(unsignedBase64: string, ...signers: Keypair[]): Uint8Array {
  const tx = VersionedTransaction.deserialize(fromB64(unsignedBase64));
  for (const signer of signers) tx.sign([signer]);
  return Uint8Array.from(tx.serialize());
}

/** `signer`'s ed25519 signature over `message`, with node:crypto: what a wallet's signMessage returns. */
export function signBytes(signer: Keypair, message: Uint8Array): Uint8Array {
  const privateKey = createPrivateKey({
    key: {
      kty: "OKP",
      crv: "Ed25519",
      d: Buffer.from(signer.secretKey.subarray(0, 32)).toString("base64url"),
      x: Buffer.from(signer.publicKey.toBytes()).toString("base64url"),
    },
    format: "jwk",
  });
  return Uint8Array.from(sign(null, message, privateKey));
}

/** The whole link flow with throwaway keys: prepare, the wallet signs the consent, build, both sign the transaction. */
export function signedLinkWallet(owner: Keypair, wallet: Keypair, blockhash = BLOCKHASH): Uint8Array {
  const consent = prepareLinkWalletConsent({ owner: owner.publicKey, wallet: wallet.publicKey });
  const built = buildLinkWallet({ owner: owner.publicKey, wallet: wallet.publicKey, consentSignature: signBytes(wallet, fromB64(consent.consentMessageBase64)), blockhash });
  return signWire(built.txBase64, owner, wallet);
}

/** A legacy transaction from instructions, partially signed by `signers`. */
export function legacyTx(feePayer: PublicKey, instructions: TransactionInstruction[], signers: Keypair[]): Uint8Array {
  const tx = new Transaction({ feePayer, recentBlockhash: BLOCKHASH }).add(...instructions);
  if (signers.length > 0) tx.partialSign(...signers);
  return Uint8Array.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
}

export interface UpstreamCall {
  readonly url: string;
  readonly body: unknown;
  readonly text: string;
}

/** A fetch that records calls and answers from `respond`. */
export function fakeFetch(respond: (call: UpstreamCall, index: number) => Response | Promise<Response>): { fetch: typeof fetch; calls: UpstreamCall[] } {
  const calls: UpstreamCall[] = [];
  const impl = (async (input: unknown, init?: RequestInit): Promise<Response> => {
    const text = typeof init?.body === "string" ? init.body : "";
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    const call = { url: String(input), body, text };
    calls.push(call);
    return respond(call, calls.length - 1);
  }) as typeof fetch;
  return { fetch: impl, calls };
}

export const jsonResponse = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

/** A JSON-RPC success for a single call body. */
export const rpcResult = (call: UpstreamCall, result: unknown): Response =>
  jsonResponse({ jsonrpc: "2.0", id: (call.body as { id?: unknown })?.id ?? 1, result });

export function accountInfo(owner: string, data: Uint8Array, lamports = 2_000_000): { data: [string, string]; lamports: number; owner: string; executable: boolean; rentEpoch: number; space: number } {
  return { data: [base64Encode(data), "base64"], lamports, owner, executable: false, rentEpoch: 0, space: data.length };
}
