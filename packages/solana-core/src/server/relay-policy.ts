// What /api/solana-rpc will relay, as a pure function over parsed JSON.
//
// THE SURFACE IS PRIVY'S SIGNING UI PLUS THE PAGES' LIVE NEEDS, and nothing else.
// Privy's embedded-wallet co-sign asks for a blockhash, a fee and a simulation;
// its wallet list asks for the genesis hash; the pages confirm what
// /api/solana-tx sent and read a handful of accounts. History and link listing
// (getSignaturesForAddress, getTransaction, getProgramAccounts) are NOT relayed:
// they are read server-side through readers.ts, so an anonymous page cannot page
// archival history or scan the program through the operator's key.
//
// EVERY PARAMETER IS CONSTRAINED AND THE CALL IS REBUILT. A call is forwarded as
// JSON.stringify of what this module validated — only jsonrpc, id, method and the
// params it re-assembled from allowed keys — never the caller's text. JSON.parse
// keeps the LAST duplicate key; a gateway may take the first. Re-serialising
// makes that difference unexploitable.
//
// EVERY ANSWER IS CAPPED BY WHAT ITS METHOD CAN LEGITIMATELY RETURN. The relay is
// the only web process, and an open relay holds its answer in memory while it is
// read, so a blockhash may not come back as 2 MiB. A body's cap is the sum of its
// calls' caps, never more than RELAY_MAX_RESPONSE_BYTES.

import { isBase58OfLength, isPubkey, isSignature } from "../client/base58";
import { tryBase64Decode } from "../client/base64";
import { RELAY_MAX_RESPONSE_BYTES } from "./rpc-pool";

export const MAX_RELAY_BODY_BYTES = 64 * 1024;
export const MAX_RELAY_BATCH = 10;
/** Solana's packet limit for a serialized transaction. */
export const MAX_TX_BYTES = 1232;
/** base64 of MAX_TX_BYTES. */
export const MAX_TX_BASE64_CHARS = 1644;
export const MAX_DATA_SLICE_LENGTH = 4096;
export const MAX_ID_LENGTH = 128;

/** A number, a hash, a fee or a short status list. */
export const RELAY_SMALL_ANSWER_BYTES = 64 * 1024;
/** One account (SIP's largest is 970 B; mints, metadata and CLMM pools are a few KB), one simulation's logs, one owner's accounts for one mint. */
export const RELAY_ACCOUNT_ANSWER_BYTES = 256 * 1024;
/** Up to ten full accounts, or fifty 4 KiB slices. */
export const RELAY_MULTI_ACCOUNT_ANSWER_BYTES = 512 * 1024;

export type RelayBudgetPool = "signing" | "reads";

type Checked = { readonly ok: true; readonly params: unknown[] } | { readonly ok: false; readonly message: string };

export interface RelayMethod {
  readonly weight: number;
  /** Which process-wide budget the call draws on. */
  readonly pool: RelayBudgetPool;
  /** The most upstream bytes this method's answer may take; a longer answer is a 502, not relayed. */
  readonly maxResponseBytes: number;
  readonly check: (params: readonly unknown[]) => Checked;
}

const ok = (params: unknown[]): Checked => ({ ok: true, params });
const no = (message: string): Checked => ({ ok: false, message });

const COMMITMENTS = new Set(["processed", "confirmed", "finalized"]);
const isPlain = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

type FieldRule = (value: unknown) => string | null;

const commitment: FieldRule = (value) => (typeof value === "string" && COMMITMENTS.has(value) ? null : "commitment must be processed, confirmed or finalized");
const minContextSlot: FieldRule = (value) => (Number.isSafeInteger(value) && (value as number) >= 0 ? null : "minContextSlot must be a non-negative integer");
const boolean =
  (name: string): FieldRule =>
  (value) =>
    typeof value === "boolean" ? null : `${name} must be a boolean`;
const oneOf =
  (name: string, allowed: readonly string[]): FieldRule =>
  (value) =>
    typeof value === "string" && allowed.includes(value) ? null : `${name} must be one of ${allowed.join(", ")}`;
const dataSlice: FieldRule = (value) => {
  if (!isPlain(value) || Object.keys(value).some((key) => key !== "offset" && key !== "length")) return "dataSlice must be {offset, length}";
  if (!Number.isSafeInteger(value.offset) || (value.offset as number) < 0) return "dataSlice.offset must be a non-negative integer";
  if (!Number.isSafeInteger(value.length) || (value.length as number) < 0 || (value.length as number) > MAX_DATA_SLICE_LENGTH) {
    return `dataSlice.length must be an integer from 0 to ${MAX_DATA_SLICE_LENGTH}`;
  }
  return null;
};

/**
 * A config object with only `rules` keys, rebuilt key by key. `required` keys
 * must be present. Returns the rebuilt object or a message.
 */
function config(
  value: unknown,
  rules: Readonly<Record<string, FieldRule>>,
  required: readonly string[] = [],
  refusedKeys: Readonly<Record<string, string>> = {},
): { ok: true; value: Record<string, unknown> } | { ok: false; message: string } {
  if (!isPlain(value)) return { ok: false, message: "the config must be an object" };
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    const refused = refusedKeys[key];
    if (refused !== undefined) return { ok: false, message: refused };
    const rule = rules[key];
    if (rule === undefined) return { ok: false, message: `config key ${key} is not relayed (allowed: ${Object.keys(rules).join(", ") || "none"})` };
    const problem = rule(inner);
    if (problem !== null) return { ok: false, message: problem };
    out[key] = isPlain(inner) ? { ...inner } : inner;
  }
  for (const key of required) if (!(key in out)) return { ok: false, message: `config.${key} is required` };
  return { ok: true, value: out };
}

function arity(params: readonly unknown[], min: number, max: number): string | null {
  return params.length < min || params.length > max
    ? `expects ${min === max ? min : `${min} to ${max}`} parameter${max === 1 ? "" : "s"}, got ${params.length}`
    : null;
}

function base64Wire(value: unknown, what: string): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_TX_BASE64_CHARS) {
    return `${what} must be a base64 string of at most ${MAX_TX_BASE64_CHARS} characters`;
  }
  const bytes = tryBase64Decode(value);
  if (bytes === null || bytes.length === 0 || bytes.length > MAX_TX_BYTES) return `${what} must be base64 of 1 to ${MAX_TX_BYTES} bytes`;
  return null;
}

const CONTEXT_RULES = { commitment, minContextSlot };
const ENCODINGS = ["base64", "jsonParsed"] as const;

/** An optional trailing config; `rules` keys only. */
function optionalConfig(params: readonly unknown[], index: number, rules: Readonly<Record<string, FieldRule>>): Checked | null {
  if (params.length <= index) return null;
  const built = config(params[index], rules);
  return built.ok ? null : no(built.message);
}

function accountConfig(value: unknown, extra: Readonly<Record<string, FieldRule>> = {}): { ok: true; value: Record<string, unknown> } | { ok: false; message: string } {
  const built = config(value, { encoding: oneOf("encoding", ENCODINGS), dataSlice, ...CONTEXT_RULES, ...extra }, ["encoding"]);
  if (built.ok && "dataSlice" in built.value && built.value.encoding !== "base64") {
    return { ok: false, message: "dataSlice is only relayed with encoding base64" };
  }
  return built;
}

const rebuild = (params: readonly unknown[]): unknown[] => params.map((param) => (isPlain(param) ? { ...param } : Array.isArray(param) ? [...param] : param));

/** The allowlist. Anything not here answers 403. */
export const RELAY_METHODS: Readonly<Record<string, RelayMethod>> = {
  getLatestBlockhash: {
    weight: 1,
    pool: "signing",
    maxResponseBytes: RELAY_SMALL_ANSWER_BYTES,
    check: (params) => arity(params, 0, 1) === null ? (optionalConfig(params, 0, CONTEXT_RULES) ?? ok(rebuild(params))) : no(arity(params, 0, 1)!),
  },
  getFeeForMessage: {
    weight: 1,
    pool: "signing",
    maxResponseBytes: RELAY_SMALL_ANSWER_BYTES,
    check: (params) => {
      const bad = arity(params, 1, 2) ?? base64Wire(params[0], "the message");
      return bad !== null ? no(bad) : (optionalConfig(params, 1, CONTEXT_RULES) ?? ok(rebuild(params)));
    },
  },
  simulateTransaction: {
    weight: 3,
    pool: "signing",
    maxResponseBytes: RELAY_ACCOUNT_ANSWER_BYTES,
    check: (params) => {
      const bad = arity(params, 2, 2) ?? base64Wire(params[0], "the transaction");
      if (bad !== null) return no(bad);
      const built = config(
        params[1],
        {
          encoding: oneOf("encoding", ["base64"]),
          sigVerify: boolean("sigVerify"),
          replaceRecentBlockhash: boolean("replaceRecentBlockhash"),
          innerInstructions: boolean("innerInstructions"),
          ...CONTEXT_RULES,
        },
        ["encoding"],
        { accounts: "simulateTransaction with an accounts config is not relayed: it returns arbitrary account state" },
      );
      if (!built.ok) return no(built.message);
      if (built.value.sigVerify === true && built.value.replaceRecentBlockhash === true) {
        return no("sigVerify and replaceRecentBlockhash cannot both be true");
      }
      return ok([params[0], built.value]);
    },
  },
  getTokenAccountsByOwner: {
    weight: 3,
    pool: "reads",
    maxResponseBytes: RELAY_ACCOUNT_ANSWER_BYTES,
    check: (params) => {
      const bad = arity(params, 3, 3) ?? (isPubkey(params[0]) ? null : "the owner must be a base58 32-byte key");
      if (bad !== null) return no(bad);
      const filter = params[1];
      if (!isPlain(filter) || Object.keys(filter).length !== 1 || !("mint" in filter)) {
        return no("only the {mint} filter is relayed; a vault's holdings are read server-side");
      }
      if (!isPubkey(filter.mint)) return no("filter.mint must be a base58 32-byte key");
      const built = accountConfig(params[2]);
      return built.ok ? ok([params[0], { mint: filter.mint }, built.value]) : no(built.message);
    },
  },
  getGenesisHash: {
    weight: 1,
    pool: "signing",
    maxResponseBytes: RELAY_SMALL_ANSWER_BYTES,
    check: (params) => (params.length === 0 ? ok([]) : no(arity(params, 0, 0)!)),
  },
  getBalance: {
    weight: 1,
    pool: "signing",
    maxResponseBytes: RELAY_SMALL_ANSWER_BYTES,
    check: (params) => {
      const bad = arity(params, 1, 2) ?? (isPubkey(params[0]) ? null : "the address must be a base58 32-byte key");
      return bad !== null ? no(bad) : (optionalConfig(params, 1, CONTEXT_RULES) ?? ok(rebuild(params)));
    },
  },
  getAccountInfo: {
    weight: 1,
    pool: "reads",
    maxResponseBytes: RELAY_ACCOUNT_ANSWER_BYTES,
    check: (params) => {
      const bad = arity(params, 2, 2) ?? (isPubkey(params[0]) ? null : "the address must be a base58 32-byte key");
      if (bad !== null) return no(bad);
      const built = accountConfig(params[1]);
      return built.ok ? ok([params[0], built.value]) : no(built.message);
    },
  },
  getMultipleAccounts: {
    weight: 2,
    pool: "reads",
    maxResponseBytes: RELAY_MULTI_ACCOUNT_ANSWER_BYTES,
    check: (params) => {
      const bad = arity(params, 2, 2);
      if (bad !== null) return no(bad);
      const built = accountConfig(params[1]);
      if (!built.ok) return no(built.message);
      const keys = params[0];
      // Ten full accounts, or fifty when each is cut to a 4 KiB slice: an
      // account can be 10 MiB, and the relay is one process.
      const max = "dataSlice" in built.value ? 50 : 10;
      if (!Array.isArray(keys) || keys.length === 0 || keys.length > max) {
        return no(`expects 1 to ${max} addresses${max === 10 ? " (up to 50 with a base64 dataSlice)" : ""}`);
      }
      if (!keys.every(isPubkey)) return no("every address must be a base58 32-byte key");
      return ok([[...keys], built.value]);
    },
  },
  getMinimumBalanceForRentExemption: {
    weight: 1,
    pool: "reads",
    maxResponseBytes: RELAY_SMALL_ANSWER_BYTES,
    check: (params) => {
      const bad =
        arity(params, 1, 2) ??
        (Number.isSafeInteger(params[0]) && (params[0] as number) >= 0 && (params[0] as number) <= 10_240 ? null : "the data length must be an integer from 0 to 10240");
      return bad !== null ? no(bad) : (optionalConfig(params, 1, { commitment }) ?? ok(rebuild(params)));
    },
  },
  getTokenAccountBalance: {
    weight: 1,
    pool: "reads",
    maxResponseBytes: RELAY_SMALL_ANSWER_BYTES,
    check: (params) => {
      const bad = arity(params, 1, 2) ?? (isPubkey(params[0]) ? null : "the token account must be a base58 32-byte key");
      return bad !== null ? no(bad) : (optionalConfig(params, 1, { commitment }) ?? ok(rebuild(params)));
    },
  },
  getSignatureStatuses: {
    weight: 1,
    pool: "signing",
    maxResponseBytes: RELAY_SMALL_ANSWER_BYTES,
    check: (params) => {
      const bad = arity(params, 1, 2);
      if (bad !== null) return no(bad);
      const signatures = params[0];
      if (!Array.isArray(signatures) || signatures.length === 0 || signatures.length > 10 || !signatures.every(isSignature)) {
        return no("expects 1 to 10 base58 64-byte signatures");
      }
      if (params.length === 2) {
        const built = config(params[1], {
          searchTransactionHistory: (value) => (value === false ? null : "searchTransactionHistory: true is an archival lookup and is not relayed"),
        });
        if (!built.ok) return no(built.message);
        return ok([[...signatures], built.value]);
      }
      return ok([[...signatures]]);
    },
  },
  getSlot: {
    weight: 1,
    pool: "reads",
    maxResponseBytes: RELAY_SMALL_ANSWER_BYTES,
    check: (params) => arity(params, 0, 1) === null ? (optionalConfig(params, 0, CONTEXT_RULES) ?? ok(rebuild(params))) : no(arity(params, 0, 1)!),
  },
  getBlockHeight: {
    weight: 1,
    pool: "signing",
    maxResponseBytes: RELAY_SMALL_ANSWER_BYTES,
    check: (params) => arity(params, 0, 1) === null ? (optionalConfig(params, 0, CONTEXT_RULES) ?? ok(rebuild(params))) : no(arity(params, 0, 1)!),
  },
  isBlockhashValid: {
    weight: 1,
    pool: "signing",
    maxResponseBytes: RELAY_SMALL_ANSWER_BYTES,
    check: (params) => {
      const bad = arity(params, 1, 2) ?? (isBase58OfLength(params[0], 32) ? null : "the blockhash must be base58 of 32 bytes");
      return bad !== null ? no(bad) : (optionalConfig(params, 1, CONTEXT_RULES) ?? ok(rebuild(params)));
    },
  },
};

/** The most weight one request can carry: a full batch of the heaviest method. Limits below it could never pass. */
export const MAX_RELAY_REQUEST_WEIGHT = MAX_RELAY_BATCH * Math.max(...Object.values(RELAY_METHODS).map((method) => method.weight));

const NOT_RELAYED_REASONS: Readonly<Record<string, string>> = {
  sendTransaction: "broadcasts go through /api/solana-tx, which verifies what it sends",
  getProgramAccounts: "program scans are read server-side",
  getSignaturesForAddress: "history is read server-side",
  getTransaction: "history is read server-side",
};

export type JsonRpcId = string | number | null;

export interface RelayCall {
  readonly jsonrpc: "2.0";
  readonly id: string | number;
  readonly method: string;
  readonly params: unknown[];
}

export type RelayCallCheck =
  | { readonly ok: true; readonly call: RelayCall; readonly weight: number; readonly pool: RelayBudgetPool; readonly maxResponseBytes: number }
  | { readonly ok: false; readonly status: 400 | 403; readonly code: -32600 | -32601 | -32602; readonly message: string; readonly id: JsonRpcId };

const safeId = (value: unknown): value is string | number =>
  (typeof value === "string" && value.length <= MAX_ID_LENGTH) || Number.isSafeInteger(value);

export function checkRelayCall(call: unknown): RelayCallCheck {
  const idOf = (value: unknown): JsonRpcId => (isPlain(value) && safeId(value.id) ? value.id : null);
  const refuse = (status: 400 | 403, code: -32600 | -32601 | -32602, message: string): RelayCallCheck => ({ ok: false, status, code, message, id: idOf(call) });
  if (!isPlain(call)) return refuse(400, -32600, "Invalid request: every entry must be a JSON-RPC object.");
  const extra = Object.keys(call).filter((key) => key !== "jsonrpc" && key !== "id" && key !== "method" && key !== "params");
  if (extra.length > 0) return refuse(400, -32600, `Invalid request: unexpected member ${extra[0]}.`);
  if (call.jsonrpc !== "2.0") return refuse(400, -32600, 'Invalid request: jsonrpc must be "2.0".');
  if (!safeId(call.id)) return refuse(400, -32600, `Invalid request: id must be a string of at most ${MAX_ID_LENGTH} characters or a safe integer.`);
  if (typeof call.method !== "string") return refuse(400, -32600, "Invalid request: method must be a string.");
  const method = RELAY_METHODS[call.method];
  if (method === undefined || !Object.prototype.hasOwnProperty.call(RELAY_METHODS, call.method)) {
    const why = NOT_RELAYED_REASONS[call.method];
    const name = call.method.slice(0, 64);
    return refuse(403, -32601, `Method ${name} is not relayed by this endpoint${why === undefined ? "" : `: ${why}`}.`);
  }
  const params = call.params === undefined ? [] : call.params;
  if (!Array.isArray(params)) return refuse(400, -32602, `Invalid params for ${call.method}: params must be an array.`);
  const checked = method.check(params);
  if (!checked.ok) return refuse(400, -32602, `Invalid params for ${call.method}: ${checked.message}.`);
  return {
    ok: true,
    call: { jsonrpc: "2.0", id: call.id, method: call.method, params: checked.params },
    weight: method.weight,
    pool: method.pool,
    maxResponseBytes: method.maxResponseBytes,
  };
}

export type RelayBodyCheck =
  | {
      readonly ok: true;
      readonly calls: readonly RelayCall[];
      readonly batch: boolean;
      /** Total weight, and per budget pool. */
      readonly weight: number;
      readonly poolWeights: Readonly<Record<RelayBudgetPool, number>>;
      /** What goes upstream: the validated calls, re-serialised. */
      readonly forwardBody: string;
      readonly methods: readonly string[];
      /** The most upstream bytes this body's answer may take: its calls' caps summed, never above RELAY_MAX_RESPONSE_BYTES. */
      readonly maxResponseBytes: number;
    }
  | { readonly ok: false; readonly status: 400 | 403 | 413; readonly code: -32600 | -32601 | -32602; readonly message: string; readonly id: JsonRpcId; readonly method: string | null };

/** A whole parsed body: one call or a batch of 1..MAX_RELAY_BATCH. The first refusal wins. */
export function checkRelayBody(parsed: unknown): RelayBodyCheck {
  const batch = Array.isArray(parsed);
  const entries: readonly unknown[] = batch ? (parsed as unknown[]) : [parsed];
  if (entries.length === 0) return { ok: false, status: 400, code: -32600, message: "Empty batch.", id: null, method: null };
  if (entries.length > MAX_RELAY_BATCH) {
    return { ok: false, status: 413, code: -32600, message: `Batch of ${entries.length} exceeds the limit of ${MAX_RELAY_BATCH}.`, id: null, method: null };
  }
  const calls: RelayCall[] = [];
  const poolWeights: Record<RelayBudgetPool, number> = { signing: 0, reads: 0 };
  let weight = 0;
  let maxResponseBytes = 0;
  for (const entry of entries) {
    const checked = checkRelayCall(entry);
    if (!checked.ok) {
      const method = isPlain(entry) && typeof entry.method === "string" ? entry.method.slice(0, 64) : null;
      return { ...checked, method };
    }
    calls.push(checked.call);
    weight += checked.weight;
    poolWeights[checked.pool] += checked.weight;
    maxResponseBytes += checked.maxResponseBytes;
  }
  return {
    ok: true,
    calls,
    batch,
    weight,
    poolWeights,
    forwardBody: JSON.stringify(batch ? calls : calls[0]),
    methods: calls.map((call) => call.method),
    maxResponseBytes: Math.min(maxResponseBytes, RELAY_MAX_RESPONSE_BYTES),
  };
}
