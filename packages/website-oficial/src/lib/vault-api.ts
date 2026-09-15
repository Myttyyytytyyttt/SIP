/**
 * THE VAULT SCREENS' SERVER, TYPED: build, state, send and one RPC call, each a
 * POST to this app's own routes, and every failure turned into words.
 *
 * The origin is injectable, so the local proof drives the same client against a
 * `next start` on localhost. Nothing here signs or holds a key; the answers are
 * advice the flows check before any wallet is asked (src/lib/tx-intent.ts).
 *
 * THE WORDS. A refusal names what happened in the person's terms: the send
 * route's verifier reasons, the program's own errors by code, and the token
 * programs' freeze and pause, read from the simulation's logs. The build route's
 * own refusals already carry words from this app's server, and are shown as sent.
 */

import { base64Encode, idlErrorByCode } from "@sip/solana-core/client";

import { FAILURE_COPY, LINK_COPY, VAULT_COPY } from "@/lib/vault-copy";

export type ReadStatus = "exists" | "missing" | "unreadable";

export interface BuiltTransactionJson {
  readonly instruction: string;
  readonly txBase64: string;
  readonly messageBase64: string;
  readonly signers: readonly string[];
  readonly feePayer: string;
  readonly recentBlockhash: string;
  readonly lastValidBlockHeight: number | null;
  readonly vault: string;
  readonly accounts: Readonly<Record<string, string>>;
  readonly computeBudget: { readonly unitLimit: number; readonly microLamports: string } | null;
  readonly costs?: { readonly rentLamports: string; readonly signatureFeeLamports: string; readonly priorityFeeLamports: string };
}

/** The floors an investPolicy build signs, with the rates they were read from. Bigints as decimal strings. */
export interface PolicyFloorsJson {
  readonly slot: number | null;
  readonly marginBps: { readonly convert: number; readonly leg: number };
  /** USDC raw per lamport × 1e18, read from the SOL/USDC pool. */
  readonly liveConvertWad: string;
  /** min_convert_rate_wad: liveConvertWad less the convert margin. */
  readonly convertWad: string;
  readonly usdcRawPerSol: string;
  readonly floorUsdcRawPerSol: string;
  readonly legs: readonly {
    readonly symbol: string;
    readonly mint: string;
    /** Leg raw per USDC raw × 1e18, read from the leg's pool. */
    readonly liveWad: string;
    /** min_out_rate_wad: liveWad less the leg margin. */
    readonly wad: string;
    readonly usdcRawPer1e8: string;
    readonly maxUsdcRawPer1e8: string;
  }[];
}

export interface InvestPolicyBuildJson extends BuiltTransactionJson {
  readonly policy: string;
  readonly policyExists: boolean;
  readonly floors: PolicyFloorsJson;
  /** Every vault token account the policy needs (wSOL, USDC, each leg), and whether this transaction creates it. */
  readonly vaultTokenAccounts: readonly { readonly mint: string; readonly address: string; readonly tokenProgram: string; readonly create: boolean }[];
  readonly costs: {
    readonly rentLamports: string;
    readonly signatureFeeLamports: string;
    readonly priorityFeeLamports: string;
    readonly policyRentLamports: string;
    readonly tokenAccountRentLamports: string;
  };
  readonly warnings: readonly string[];
}

export interface WithdrawBuildJson extends BuiltTransactionJson {
  readonly withdrawableLamports: string;
}

export interface WithdrawTokenBuildJson extends BuiltTransactionJson {
  readonly ownerTokenAccount: string;
  readonly vaultTokenAccount: string;
  readonly heldRaw: string;
  readonly ownerTokenAccountExists: boolean;
  /** 0 when the account exists or unwraps (wSOL); null when its size is not known. */
  readonly ownerTokenAccountRentLamports: string | null;
}

export interface LinkConsentJson {
  readonly instruction: "link_wallet";
  readonly programId: string;
  readonly owner: string;
  readonly wallet: string;
  readonly vault: string;
  readonly tradingLink: string;
  readonly consentMessageBase64: string;
}

export interface SendResponseJson {
  readonly signature: string;
  readonly slot: number | null;
  readonly unitsConsumed: number | null;
  readonly explorerUrl: string | null;
}

export interface VaultAccountJson {
  readonly owner: string;
  readonly paused: boolean;
  readonly skimMode: number;
  readonly skimBps: number;
  readonly volumeBps: number;
  readonly lifetimeSaved: string;
  readonly createdAt: string;
  readonly maxContribution: string;
  readonly walletReserve: string;
  readonly policyNonce: string;
}

export type WalletLinkStatus = "missing" | "this_vault" | "other_vault" | "unreadable";

/** The InvestmentPolicy account, decoded; bigints as decimal strings. */
export interface InvestmentPolicyJson {
  readonly vault: string;
  readonly enabled: boolean;
  readonly venueProgram: string;
  readonly inMint: string;
  readonly legs: readonly { readonly mint: string; readonly weightBps: number; readonly minOutRateWad: string }[];
  readonly minConvertRateWad: string;
  readonly minInvestment: string;
  readonly maxPerCall: string;
  readonly maxRolling30d: string;
  /** 31 day-buckets: the day (unix seconds / 86400) each was last written, and what was invested that day. */
  readonly bucketDays: readonly number[];
  readonly bucketAmounts: readonly string[];
  readonly lifetimeInvested: string;
  readonly policyNonce: string;
}

/** One non-zero token balance the vault owns. */
export interface HoldingJson {
  readonly tokenAccount: string;
  readonly mint: string;
  /** What a transfer moves. */
  readonly amountRaw: string;
  readonly decimals: number;
  /** The RPC's display amount: shown as is, never computed from amountRaw (SPYx's scaled UI amount). */
  readonly uiAmount: string;
  readonly tokenProgram: string;
}

export interface VaultStateJson {
  readonly owner: string;
  readonly programId: string;
  readonly vault: {
    readonly status: ReadStatus;
    readonly address: string;
    readonly lamports?: string;
    readonly rentFloor?: string;
    readonly withdrawableLamports?: string;
    readonly state?: VaultAccountJson;
  };
  readonly policy: { readonly status: ReadStatus; readonly address: string; readonly lamports?: string; readonly state?: InvestmentPolicyJson };
  readonly config: { readonly address: string; readonly status: ReadStatus; readonly exists: boolean; readonly paused: boolean | null };
  readonly walletLinks: readonly { readonly wallet: string; readonly link: string; readonly status: WalletLinkStatus; readonly vault: string | null }[];
  readonly holdings: { readonly status: "exists" | "unreadable"; readonly items: readonly HoldingJson[] };
  /** The accounts an investment policy needs (wSOL, USDC, each leg), and whether each exists. */
  readonly vaultTokenAccounts: {
    readonly status: "exists" | "unreadable";
    readonly items: readonly { readonly mint: string; readonly address: string; readonly tokenProgram: string; readonly status: ReadStatus }[];
  };
  readonly rents: {
    readonly vault: string;
    readonly link: string;
    readonly policy: string;
    /** A classic token account (165 bytes). */
    readonly tokenAccount: string;
    /** Each offered leg's token account, by mint. */
    readonly legTokenAccounts: Readonly<Record<string, string>>;
  } | null;
  readonly prices: {
    readonly slot: number | null;
    readonly convertWad: string;
    readonly usdcRawPerSol: string;
    readonly legs: readonly { readonly symbol: string; readonly mint: string; readonly wad: string; readonly usdcRawPer1e8: string }[];
  } | null;
}

export interface ApiFailure {
  readonly ok: false;
  /** The HTTP status, or 0 when the request never got an answer. */
  readonly status: number;
  readonly code: string;
  /** The server's own message, or empty. */
  readonly message: string;
  readonly retryAfterSeconds: number | null;
  /** The error object as the server sent it: signature, err, logs, problems, vault… */
  readonly body: Readonly<Record<string, unknown>>;
}

export type ApiResult<T> = { readonly ok: true; readonly status: number; readonly body: T } | ApiFailure;

export class RpcCallError extends Error {
  override readonly name = "RpcCallError";
  constructor(
    message: string,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
  }
}

export interface VaultApi {
  build<T = BuiltTransactionJson>(body: Readonly<Record<string, unknown>>): Promise<ApiResult<T>>;
  state(input: { readonly owner: string; readonly wallets: readonly string[] }): Promise<ApiResult<VaultStateJson>>;
  send(signedTransaction: Uint8Array): Promise<ApiResult<SendResponseJson>>;
  /** One JSON-RPC call through /api/solana-rpc; resolves to its result, throws RpcCallError otherwise. */
  rpc<T = unknown>(method: string, params: readonly unknown[]): Promise<T>;
}

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

interface Answer {
  readonly status: number;
  readonly json: unknown;
  readonly retryAfterSeconds: number | null;
}

/** The client, against `origin` (default: this page's own). */
export function createVaultApi(options: { readonly origin?: string; readonly fetch?: typeof fetch } = {}): VaultApi {
  const origin = (options.origin ?? "").replace(/\/+$/, "");
  // Looked up at call time, and never detached from its global: a bare reference throws "Illegal invocation" in browsers.
  const send = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));

  async function post(path: string, body: unknown): Promise<Answer | null> {
    try {
      const response = await send(`${origin}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), cache: "no-store" });
      const text = await response.text();
      let json: unknown = null;
      try {
        json = JSON.parse(text) as unknown;
      } catch {
        json = null;
      }
      const retry = Number(response.headers.get("retry-after") ?? "");
      return { status: response.status, json, retryAfterSeconds: Number.isFinite(retry) && retry > 0 ? retry : null };
    } catch {
      return null;
    }
  }

  function result<T>(answer: Answer | null): ApiResult<T> {
    if (answer === null) return { ok: false, status: 0, code: "network", message: "", retryAfterSeconds: null, body: {} };
    if (answer.status >= 200 && answer.status < 300 && isObject(answer.json)) return { ok: true, status: answer.status, body: answer.json as T };
    const error = isObject(answer.json) && isObject(answer.json.error) ? answer.json.error : {};
    const seconds = answer.retryAfterSeconds ?? (typeof error.retryAfterSeconds === "number" ? error.retryAfterSeconds : null);
    return {
      ok: false,
      status: answer.status,
      code: typeof error.code === "string" ? error.code : `http_${answer.status}`,
      message: typeof error.message === "string" ? error.message : "",
      retryAfterSeconds: seconds,
      body: error,
    };
  }

  return {
    build: async <T>(body: Readonly<Record<string, unknown>>) => result<T>(await post("/api/solana-build", body)),
    state: async ({ owner, wallets }) => result<VaultStateJson>(await post("/api/solana-vault", { action: "state", owner, wallets })),
    send: async (signedTransaction) => result<SendResponseJson>(await post("/api/solana-tx", { action: "send", signedTxBase64: base64Encode(signedTransaction) })),
    rpc: async <T>(method: string, params: readonly unknown[]): Promise<T> => {
      const answer = await post("/api/solana-rpc", { jsonrpc: "2.0", id: 1, method, params });
      if (answer === null) throw new RpcCallError(FAILURE_COPY.network);
      const json = answer.json;
      if (isObject(json) && "result" in json && (json.error === undefined || json.error === null)) return json.result as T;
      const message = isObject(json) && isObject(json.error) && typeof json.error.message === "string" ? json.error.message : `HTTP ${answer.status}`;
      throw new RpcCallError(message, answer.retryAfterSeconds);
    },
  };
}

// ── words ────────────────────────────────────────────────────────────────────

/** The send route's verifier reasons (@sip/solana-core verify-tx.ts VERIFY_REFUSALS), each in words. */
const VERIFIER_WORDS: Readonly<Record<string, string>> = {
  too_large: "The transaction is larger than Solana allows. Nothing was sent.",
  undecodable: "The signed transaction could not be read. Nothing was sent.",
  non_canonical: "The signed transaction is not in Solana's standard form. Nothing was sent.",
  lookup_tables: "Your wallet added address lookup tables, which SIP does not relay. Nothing was sent.",
  signature_count: "The transaction does not ask for the signatures this action needs. Nothing was sent.",
  missing_signature: "A signature this action needs is missing. Nothing was sent.",
  bad_signature: "A signature does not match the transaction. Nothing was sent.",
  old_program: "The transaction names a program SIP never talks to. Nothing was sent.",
  program_not_allowed: "Your wallet added an instruction for a program SIP does not relay. Nothing was sent.",
  instruction_count: "The transaction does not hold exactly the instructions this action needs. Nothing was sent.",
  unknown_discriminator: "The transaction's SIP instruction is not one the program has. Nothing was sent.",
  instruction_not_allowed: "The transaction is not an action your pension key signs. Nothing was sent.",
  compute_budget_invalid: "Your wallet set a fee or compute limit SIP does not relay. Nothing was sent.",
  account_binding: "The transaction's accounts are not the ones this action names. Nothing was sent.",
  wallet_is_owner: LINK_COPY.walletIsPension,
  link_consent_missing: "The link is missing your trading wallet's consent. Nothing was sent.",
  ed25519_misplaced: "Your trading wallet's consent is not where the program reads it. Nothing was sent.",
  ed25519_signature_count: "The consent check does not hold exactly one signature. Nothing was sent.",
  ed25519_malformed: "The consent check is malformed. Nothing was sent.",
  ed25519_offsets: "The consent check reads outside itself. Nothing was sent.",
  link_consent_wrong_signer: "The consent was signed by a key that is not this trading wallet. Nothing was sent.",
  link_consent_mismatch: "The consent names another program, wallet, vault or owner. Nothing was sent.",
  link_consent_bad_signature: "The consent signature does not verify. Nothing was sent.",
  vault_account_invalid: "The transaction creates a token account that is not your vault's own for this policy. Nothing was sent.",
};

/** The program's errors, by code, where the IDL's own message is not the person's words. */
const PROGRAM_WORDS: Readonly<Record<number, string>> = {
  6001: "This vault belongs to another pension key.",
  6004: "That would leave the vault below its rent reserve.",
  6005: "The vault holds less of this token than that.",
  6006: "The amount must be more than zero.",
  6013: "The program refused this rule: it is malformed or does not match these accounts.",
  6023: "SIP is paused for settling and investing. Withdrawals are not affected.",
  6035: LINK_COPY.walletIsPension,
  6036: "The trading wallet's consent is missing from this link. Nothing was linked.",
  6037: "The link's consent was signed by a key that is not this trading wallet. Nothing was linked.",
  6038: "The link's consent names another program, wallet, vault or owner. Nothing was linked.",
};

/** The build route's refusals: its message is already in words. */
const BUILD_REFUSALS = new Set([
  "volume_not_offered",
  "vault_exists",
  "vault_missing",
  "config_missing",
  "protocol_paused",
  "wallet_already_linked",
  "link_consent_invalid",
  "zero_amount",
  "above_withdrawable",
  "not_held",
  "above_holding",
  "price_unavailable",
  "mint_unexpected",
  "bad_request",
]);

/** A program's own error in words, by its custom code. */
export function programErrorWords(code: number): string {
  const words = PROGRAM_WORDS[code];
  if (words !== undefined) return words;
  const idl = idlErrorByCode(code)?.msg;
  if (idl !== null && idl !== undefined && idl !== "") return `${idl.charAt(0).toUpperCase()}${idl.slice(1)}.`;
  return `The transaction failed with error ${code}. Nothing moved.`;
}

function customCode(err: unknown): number | null {
  const failure = (err as { InstructionError?: unknown } | null)?.InstructionError;
  if (!Array.isArray(failure)) return null;
  const custom = (failure[1] as { Custom?: unknown } | null)?.Custom;
  return typeof custom === "number" ? custom : null;
}

/** A failed transaction's error and logs, in words: a blockhash, an account that exists, SIP's own errors, then the token issuers'. */
export function transactionErrorWords(err: unknown, logs: unknown): string {
  const lines = Array.isArray(logs) ? logs.filter((line): line is string => typeof line === "string") : [];
  if (err === "BlockhashNotFound") return FAILURE_COPY.blockhashExpired;
  if (lines.some((line) => /already in use/i.test(line))) return FAILURE_COPY.alreadyExists;
  const custom = customCode(err);
  // SIP's own errors first: its ProtocolPaused log says "paused" too.
  if (custom !== null && custom >= 6_000) return programErrorWords(custom);
  const tokenFrozen = custom === 0x11 && lines.some((line) => /TokenzQd|Tokenkeg/.test(line));
  if (tokenFrozen || lines.some((line) => /frozen/i.test(line))) return FAILURE_COPY.frozen;
  if (lines.some((line) => /paused/i.test(line))) return FAILURE_COPY.issuerPaused;
  if (custom !== null) return programErrorWords(custom);
  return FAILURE_COPY.simulationRefused;
}

/** Any failure from the server, in words. */
export function vaultFailureWords(failure: Pick<ApiFailure, "status" | "code" | "message" | "retryAfterSeconds" | "body">): string {
  if (failure.status === 429 || failure.code === "rate_limited") return FAILURE_COPY.rateLimited(failure.retryAfterSeconds);
  if (failure.code === "network") return FAILURE_COPY.network;
  if (failure.code === "simulation_failed") return transactionErrorWords(failure.body.err, failure.body.logs);
  const verifier = VERIFIER_WORDS[failure.code];
  if (verifier !== undefined) return verifier;
  if (failure.code === "unreadable") return VAULT_COPY.unreadable;
  if (failure.code === "upstream_unavailable") return FAILURE_COPY.upstream;
  if (failure.code === "unavailable") return FAILURE_COPY.unavailable;
  if (failure.code === "invalid_policy") {
    const problems = Array.isArray(failure.body.problems) ? failure.body.problems.filter((problem): problem is string => typeof problem === "string") : [];
    return [failure.message || "The program would refuse this rule.", ...problems.map((problem) => `${problem.charAt(0).toUpperCase()}${problem.slice(1)}.`)].join(" ");
  }
  if (BUILD_REFUSALS.has(failure.code) && failure.message !== "") return failure.message;
  return failure.message !== "" ? failure.message : FAILURE_COPY.unknown;
}
