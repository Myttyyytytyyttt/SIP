// Solana server settings, parsed from an environment object the caller passes.
//
// NEVER THE PROCESS ENVIRONMENT HERE. The web hands its env to loadSolanaServerSettings at
// request time (src/lib/config.ts), and tests hand a literal. The rules are the
// keeper's (packages/solana-keeper/src/config.ts): SIP_SOLANA_* names, a
// problem names the variable and never echoes a value, nothing is appended to
// the endpoint list, and Nuvem's names are refused rather than aliased.
//
// WHAT IS NOT CHECKED HERE: anything EVM. NUVEM_RPC_URL, SIP_CHAIN_ID and the
// other retired EVM names are not read here, and what the web says about them is
// its own business (packages/website-oficial/src/lib/load-config.ts). Only
// NUVEM_SOLANA_* (copied from the deployment whose program key leaked), the old
// program id and the keeper's secret names are refusals.

import { OLD_NUVEM_PROGRAM_ID, SIP_PROGRAM_ID } from "../client/idl";
import { checkPublicWsUrl } from "../shared/public-ws-url.mjs";
import { RpcEndpoint, UrlRedactor } from "./redact";
import { MAX_RELAY_REQUEST_WEIGHT } from "./relay-policy";

/** The same shape as packages/website-oficial/src/lib/config.ts ConfigProblem. */
export interface ConfigProblem {
  readonly variable: string;
  readonly message: string;
  readonly howToFix: string;
}

export interface RelayLimits {
  /**
   * Weighted tokens per client (IPv4 address, IPv6 /64) per minute; bucket capacity = refill per minute. Each
   * IPv4 /24 and IPv6 /48 also shares one bucket of CLIENT_AGGREGATE_FACTOR × this (rate-limit.ts).
   */
  readonly perClientPerMin: number;
  /** Process-wide weighted budget for signing-path methods (Privy's co-sign, confirmation). */
  readonly signingGlobalPerMin: number;
  /** Process-wide weighted budget for account reads, so reads can never starve signing. */
  readonly readsGlobalPerMin: number;
}

export interface SendLimits {
  readonly perClientPerMin: number;
  readonly globalPerMin: number;
}

export interface SolanaServerSettings {
  /** Always SIP_PROGRAM_ID (the IDL's address); SIP_SOLANA_PROGRAM_ID is an assertion of it. */
  readonly programId: string;
  /** SIP_SOLANA_RPC_URLS in failover order. They carry API keys and never serialize. */
  readonly rpcEndpoints: readonly RpcEndpoint[];
  /** Key-free wss origin for the browser, validated (checkPublicWsUrl), default wss://api.mainnet-beta.solana.com. */
  readonly publicWsUrl: string;
  /** Lowercase header name whose value is the client IP (SIP_TRUSTED_CLIENT_IP_HEADER). Every other header is ignored. */
  readonly trustedClientIpHeader: string;
  readonly relay: RelayLimits;
  readonly send: SendLimits;
  /** Knows every endpoint URL and its parts; scrubs any string before it leaves. */
  readonly redactor: UrlRedactor;
}

export type SolanaSettingsLoad =
  | { readonly ok: true; readonly settings: SolanaServerSettings }
  | { readonly ok: false; readonly problems: readonly ConfigProblem[] };

export type Env = Readonly<Record<string, string | undefined>>;

/**
 * THE RATIO IS THE DEFENCE. A global budget ÷ its per-client limit is how many
 * client identities, each spending its whole allowance, empty that budget for
 * every visitor. At 600 ÷ 120, five addresses (or five /64s of one home /56)
 * stopped every wallet's co-sign. The defaults keep the ratio at 25 or more (30
 * for the relay, 25 for sends; a test pins it), and the network buckets make a
 * /48 or a /24 count as at most CLIENT_AGGREGATE_FACTOR clients. The build and
 * vault routes charge a client every upstream call its request makes, so they
 * keep readsGlobalPerMin ÷ perClientPerMin too (build-handler.ts).
 *
 * UPSTREAM SIZING. Three budgets reach the endpoints, each readsGlobalPerMin or
 * signingGlobalPerMin wide: the relay's signing budget, the relay's reads
 * budget, and the ONE reads budget /api/solana-build and /api/solana-vault share.
 * Size them together against the Helius plan: with the defaults, 5,400 weighted
 * tokens a minute is at most 90 upstream requests a second.
 * /api/solana-live charges that same shared reads budget, so the live dashboard's
 * polling does not widen the exposure on the Helius key the keeper shares.
 */
export const DEFAULT_RELAY_LIMITS: RelayLimits = { perClientPerMin: 60, signingGlobalPerMin: 1_800, readsGlobalPerMin: 1_800 };
/** Only a transaction that verified spends the global send budget (handlers.ts), so junk cannot empty it. */
export const DEFAULT_SEND_LIMITS: SendLimits = { perClientPerMin: 6, globalPerMin: 150 };
const MAX_LIMIT = 1_000_000;

/** Every NUVEM_SOLANA_* name known to have been read, and what SIP reads instead (null: no counterpart). */
const NUVEM_SOLANA_REPLACEMENTS: Readonly<Record<string, string | null>> = {
  NUVEM_SOLANA_RPC_URL: "SIP_SOLANA_RPC_URLS",
  NUVEM_SOLANA_RPC_URL2: "SIP_SOLANA_RPC_URLS",
  NUVEM_SOLANA_MAINNET_RPC: "SIP_SOLANA_RPC_URLS",
  NUVEM_SOLANA_MAINNET_RPC2: "SIP_SOLANA_RPC_URLS",
  NUVEM_SOLANA_PROGRAM_ID: "SIP_SOLANA_PROGRAM_ID",
  NUVEM_SOLANA_PUBLIC_WS_URL: "SIP_SOLANA_PUBLIC_WS_URL",
  NUVEM_SOLANA_PUBLIC_RPC_URL: null,
  NUVEM_SOLANA_POOLS: "SIP_SOLANA_POOLS",
  NUVEM_SOLANA_SIGNER_ID: "SIP_SOLANA_PRIVY_SIGNER_ID",
  NUVEM_SOLANA_POLICY_ID: "SIP_SOLANA_PRIVY_POLICY_ID",
};

/** The keeper's signing secrets. Their NAMES are checked; their values are never read. */
const KEEPER_SECRET_NAMES = ["SIP_SOLANA_SETTLE_KEY", "SIP_SOLANA_PRIVY_APP_SECRET", "SIP_SOLANA_PRIVY_AUTHORIZATION_KEY"] as const;

/** Headers a client can write itself: never a client identity. */
const SPOOFABLE_HEADERS = new Set(["x-forwarded-for", "forwarded", "x-forwarded", "x-client-ip"]);

const trimmed = (value: string | undefined): string | undefined => {
  const out = value?.trim();
  return out === undefined || out === "" ? undefined : out;
};

/** Length and character class, never the value (the keeper's `shape`). */
function shape(value: string): string {
  const kind = /^[+-]?[0-9]+$/.test(value) ? "decimal-integer" : /^[1-9A-HJ-NP-Za-km-z]+$/.test(value) ? "base58-alphabet" : "free-form";
  return `a ${value.length}-character ${kind} value`;
}

function limit(env: Env, variable: string, fallback: number, min: number, problems: ConfigProblem[]): number {
  const raw = trimmed(env[variable]);
  if (raw === undefined) return fallback;
  const parsed = /^[0-9]+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > MAX_LIMIT) {
    problems.push({
      variable,
      message: `${variable} must be an integer from ${min} to ${MAX_LIMIT}; it holds ${shape(raw)}.`,
      howToFix: `Set ${variable} to a whole number of weighted tokens per minute, or unset it for the default ${fallback}.`,
    });
    return fallback;
  }
  return parsed;
}

export function loadSolanaServerSettings(env: Env): SolanaSettingsLoad {
  const problems: ConfigProblem[] = [];
  const names = Object.keys(env);

  // --- copied Nuvem configuration, by name ------------------------------------
  for (const name of names.filter((candidate) => candidate.startsWith("NUVEM_SOLANA_")).sort()) {
    const replacement = NUVEM_SOLANA_REPLACEMENTS[name];
    // Of these names only the program id names a program, so the leaked upgrade key is
    // said where it has a referent. An RPC URL, a WebSocket URL, a pool list or a signer
    // id point at no program: those get the reason that holds for every name here.
    const reason =
      name === "NUVEM_SOLANA_PROGRAM_ID"
        ? "the program that name points at has a leaked upgrade key, so an environment carrying it is refused rather than half-applied."
        : "every NUVEM_SOLANA_* name is refused by name, so a copied environment is never half-applied.";
    problems.push({
      variable: name,
      message: `${name} is not a SaverFi setting. Its value was not read: ${reason}`,
      howToFix:
        replacement === undefined || replacement === null
          ? `Remove ${name}; SaverFi has no counterpart (the browser's Solana RPC is always the same-origin /api/solana-rpc).`
          : `Remove ${name} and set ${replacement} instead, re-checking the value.`,
    });
  }

  // --- keeper secrets must not be in the web at all ---------------------------
  for (const name of KEEPER_SECRET_NAMES) {
    if (names.includes(name)) {
      problems.push({
        variable: name,
        message: `${name} is a signing secret of packages/solana-keeper. The web never signs and must not hold it; its value was not read.`,
        howToFix: `Remove ${name} from the web service's environment and rotate it if this environment was shared.`,
      });
    }
  }

  // --- endpoints: required, http(s), nothing appended -------------------------
  const redactor = new UrlRedactor();
  const endpoints: RpcEndpoint[] = [];
  const rpcStrings: string[] = [];
  const entries = (env["SIP_SOLANA_RPC_URLS"] ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  if (entries.length === 0) {
    problems.push({
      variable: "SIP_SOLANA_RPC_URLS",
      message: "SIP_SOLANA_RPC_URLS is required.",
      howToFix:
        "Set it to the web's Helius JSON-RPC URL (comma-separate a second provider if you have one). Nothing is " +
        "appended implicitly; list a public endpoint yourself if you want it last.",
    });
  }
  const seen = new Set<string>();
  entries.forEach((entry, index) => {
    redactor.register(entry);
    let parsed: URL | null = null;
    try {
      parsed = new URL(entry);
    } catch {
      parsed = null;
    }
    if (parsed === null || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) {
      problems.push({
        variable: "SIP_SOLANA_RPC_URLS",
        message: `SIP_SOLANA_RPC_URLS entry #${index + 1} is not an http(s) URL; it holds ${shape(entry)}.`,
        howToFix: "Use full https:// JSON-RPC URLs, comma-separated.",
      });
      return;
    }
    if (seen.has(parsed.href)) return;
    seen.add(parsed.href);
    rpcStrings.push(entry);
    endpoints.push(new RpcEndpoint(entry, `rpcUrl:${endpoints.length}`));
  });

  // --- the program -------------------------------------------------------------
  const program = trimmed(env["SIP_SOLANA_PROGRAM_ID"]);
  if (program === undefined) {
    problems.push({
      variable: "SIP_SOLANA_PROGRAM_ID",
      message: "SIP_SOLANA_PROGRAM_ID is required.",
      howToFix: `Set it to ${SIP_PROGRAM_ID}, the sip_vault IDL's address.`,
    });
  } else if (program === OLD_NUVEM_PROGRAM_ID) {
    problems.push({
      variable: "SIP_SOLANA_PROGRAM_ID",
      message:
        "SIP_SOLANA_PROGRAM_ID names a program SaverFi does not use. Its upgrade authority key leaked, so whoever holds it can " +
        "rewrite that program: SaverFi never talks to it.",
      howToFix: `Set SIP_SOLANA_PROGRAM_ID to ${SIP_PROGRAM_ID}.`,
    });
  } else if (program !== SIP_PROGRAM_ID) {
    problems.push({
      variable: "SIP_SOLANA_PROGRAM_ID",
      message: `SIP_SOLANA_PROGRAM_ID does not match the sip_vault IDL's address; it holds ${shape(program)}.`,
      howToFix: `Set it to ${SIP_PROGRAM_ID}. The web decodes and verifies with that IDL, so no other id can be right.`,
    });
  }

  // --- the browser's WebSocket -------------------------------------------------
  let publicWsUrl = "";
  const ws = checkPublicWsUrl(env["SIP_SOLANA_PUBLIC_WS_URL"], rpcStrings);
  if (ws.ok) {
    publicWsUrl = ws.url;
  } else {
    problems.push({
      variable: "SIP_SOLANA_PUBLIC_WS_URL",
      message: `SIP_SOLANA_PUBLIC_WS_URL ${ws.reason}. This URL is sent to every browser, so a keyed endpoint must never be in it.`,
      howToFix: "Set a key-free wss:// origin with no path, query or credentials, or unset it for wss://api.mainnet-beta.solana.com.",
    });
  }

  // --- the client identity header ----------------------------------------------
  let trustedClientIpHeader = "";
  const header = trimmed(env["SIP_TRUSTED_CLIENT_IP_HEADER"])?.toLowerCase();
  if (header === undefined) {
    problems.push({
      variable: "SIP_TRUSTED_CLIENT_IP_HEADER",
      message:
        "SIP_TRUSTED_CLIENT_IP_HEADER is required: the per-client limits key on the ONE header " +
        "the edge in front of this process writes from the socket. Every other header is ignored.",
      howToFix:
        "Set it to the one header your host writes from the connection. On Vercel that is x-real-ip. " +
        "Requests without a parseable value share one bucket.",
    });
  } else if (!/^[a-z0-9-]{1,64}$/.test(header) || SPOOFABLE_HEADERS.has(header)) {
    problems.push({
      variable: "SIP_TRUSTED_CLIENT_IP_HEADER",
      message: SPOOFABLE_HEADERS.has(header)
        ? `SIP_TRUSTED_CLIENT_IP_HEADER names ${header}, which the client itself can write, so every request could claim a fresh bucket.`
        : "SIP_TRUSTED_CLIENT_IP_HEADER is not a header name.",
      howToFix: "Name the single header your host writes from the connection (on Vercel, x-real-ip).",
    });
  } else {
    trustedClientIpHeader = header;
  }

  // --- limits ----------------------------------------------------------------------
  if (names.includes("SIP_SOLANA_RELAY_GLOBAL_PER_MIN")) {
    problems.push({
      variable: "SIP_SOLANA_RELAY_GLOBAL_PER_MIN",
      message: "SIP_SOLANA_RELAY_GLOBAL_PER_MIN was split in two so account reads can never starve wallet signing.",
      howToFix: "Remove it and set SIP_SOLANA_RELAY_SIGNING_GLOBAL_PER_MIN and/or SIP_SOLANA_RELAY_READS_GLOBAL_PER_MIN (or rely on the defaults).",
    });
  }
  const relay: RelayLimits = {
    perClientPerMin: limit(env, "SIP_SOLANA_RELAY_PER_MIN", DEFAULT_RELAY_LIMITS.perClientPerMin, MAX_RELAY_REQUEST_WEIGHT, problems),
    signingGlobalPerMin: limit(env, "SIP_SOLANA_RELAY_SIGNING_GLOBAL_PER_MIN", DEFAULT_RELAY_LIMITS.signingGlobalPerMin, MAX_RELAY_REQUEST_WEIGHT, problems),
    readsGlobalPerMin: limit(env, "SIP_SOLANA_RELAY_READS_GLOBAL_PER_MIN", DEFAULT_RELAY_LIMITS.readsGlobalPerMin, MAX_RELAY_REQUEST_WEIGHT, problems),
  };
  const send: SendLimits = {
    perClientPerMin: limit(env, "SIP_SOLANA_SEND_PER_MIN", DEFAULT_SEND_LIMITS.perClientPerMin, 1, problems),
    globalPerMin: limit(env, "SIP_SOLANA_SEND_GLOBAL_PER_MIN", DEFAULT_SEND_LIMITS.globalPerMin, 1, problems),
  };

  if (problems.length > 0) {
    return { ok: false, problems: problems.map((problem) => ({ ...problem, message: redactor.scrub(problem.message) })) };
  }

  const settings: SolanaServerSettings = {
    programId: SIP_PROGRAM_ID,
    rpcEndpoints: Object.freeze(endpoints),
    publicWsUrl,
    trustedClientIpHeader,
    relay: Object.freeze(relay),
    send: Object.freeze(send),
    redactor,
  };
  const describe = (): Record<string, unknown> => ({
    programId: settings.programId,
    rpcEndpoints: endpoints.length,
    publicWsUrl,
    trustedClientIpHeader,
    relay,
    send,
  });
  Object.defineProperty(settings, "toJSON", { value: describe, enumerable: false });
  Object.defineProperty(settings, Symbol.for("nodejs.util.inspect.custom"), { value: describe, enumerable: false });
  return { ok: true, settings: Object.freeze(settings) };
}
