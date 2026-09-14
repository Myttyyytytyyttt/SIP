/**
 * SERVER-ONLY environment reading, and the split between what the server may
 * know and what the browser may see. Ported from the Nuvem dashboard's
 * src/lib/addresses.ts + src/lib/config.ts (HEAD fd927b0), EVM only.
 *
 * Imported by the /wallets server component and by the route handlers under
 * src/app/api. Never import its RUNTIME values from a `'use client'` module —
 * `import type { PublicConfig }` is the only thing a client file may take from
 * here — because loadConfig reads an RPC URL that carries an API key.
 *
 * WHY THE SPLIT, AND WHY NOTHING IS `NEXT_PUBLIC_`:
 *
 * `NEXT_PUBLIC_*` values are string-inlined into the client bundle at
 * `next build` time. An image built in CI without them and then deployed to
 * Railway with the variables set in the dashboard would ship `undefined` as the
 * Privy app id — failing in the user's browser, not in the build. So the server
 * reads the environment at REQUEST time and hands the browser exactly what it
 * needs as props. One image, every environment, restart instead of rebuild.
 * (`NEXT_PUBLIC_`-prefixed names are still accepted as aliases so an existing
 * .env keeps working.)
 *
 * The second reason for the split is sharper: the RPC URL for this deployment
 * carries an Alchemy API key. `ServerConfig.rpcUrl` therefore NEVER crosses to
 * the browser — every contract read happens in a route handler. What the browser
 * gets is `PublicConfig.walletRpcUrl`, which is either an operator-supplied
 * key-free endpoint or this app's own same-origin `/api/rpc` relay, and which
 * exists only so a wallet can add chain 4663.
 *
 * ONE ENTRY POINT, DELIBERATELY: loadConfig() collects EVERY problem and returns
 * them, so the page can render a setup checklist instead of a stack trace. The
 * operator may not have a Privy app yet — that is an expected first-run state,
 * not a crash.
 *
 * NAMING. The NUVEM_* names are canonical because the container and Railway
 * configuration already use them; SIP_* is accepted as an alias of every one,
 * and the NEXT_PUBLIC_* / plain spellings of the old .env files still resolve.
 *
 * TWO CHAINS, ONE IMAGE (SIP_CHAIN). `evm`, which is also what an unset variable
 * means, is everything above, unchanged. `solana` swaps in a second configuration
 * (SolanaPublicConfig / SolanaServerConfig). Its loader lives in
 * src/lib/load-config.ts, not here, because it reaches @sip/solana-core/server,
 * and this file must stay importable from client modules (UINT128_MAX) and from
 * tsx scripts (check-abis, through vault.ts), where a `server-only` import throws.
 * The names PublicConfig and ServerConfig stay the EVM interfaces, so every EVM
 * component compiles untouched. Only the boundaries take the Any* unions and
 * narrow them: the pages, WalletsHost, Providers and the route handlers.
 */

import type { SolanaServerSettings } from "@sip/solana-core/server";
import { getAddress, isAddress, type Address } from "viem";

import { ROBINHOOD_CHAIN_ID } from "./chain";

/** uint128 max — the aggregate cap a vault is created with (WEB_WALLETS.md §0.6). */
export const UINT128_MAX = 2n ** 128n - 1n;

// ---------------------------------------------------------------------------
// NO DEPLOYMENT IS BUILT IN.
//
// This block used to carry the 2026-08-16 topology so the "your environment
// disagrees with the chain" check had something to compare against. SIP does not
// use that deployment — its vaults hold trading accounts whose savings rate means
// a PERCENTAGE OF PROFIT, and this product's rate is basis points of VOLUME — so
// comparing against it would vouch for the wrong chain state.
//
// The cross-check still works and is better for it: the factory's own
// protocolConfiguration() is the authority, and the optional expected* variables
// are what an operator sets when they want the mismatch reported loudly. Unset,
// there is simply nothing to disagree with.
// ---------------------------------------------------------------------------

/**
 * The exact length @privy-io/react-auth requires of an app id. Its check is
 * `typeof id !== "string" || id.length !== 25` and it throws rather than
 * degrading, so this must stay in step with the installed SDK.
 */
const PRIVY_APP_ID_LENGTH = 25;

const ALIASES = {
  privyAppId: ["PRIVY_APP_ID", "SIP_PRIVY_APP_ID", "NEXT_PUBLIC_PRIVY_APP_ID"],
  privyClientId: ["PRIVY_CLIENT_ID", "SIP_PRIVY_CLIENT_ID", "NEXT_PUBLIC_PRIVY_CLIENT_ID"],
  privySignerId: ["PRIVY_SIGNER_ID", "SIP_PRIVY_SIGNER_ID", "NEXT_PUBLIC_PRIVY_SIGNER_ID"],
  privyPolicyId: ["PRIVY_POLICY_ID", "SIP_PRIVY_POLICY_ID", "NEXT_PUBLIC_PRIVY_POLICY_ID"],
  rpcUrl: ["NUVEM_RPC_URL", "SIP_RPC_URL", "RPC_URL", "RPC_URL_4663"],
  walletRpcUrl: ["NUVEM_PUBLIC_RPC_URL", "SIP_PUBLIC_RPC_URL", "NEXT_PUBLIC_RPC_URL", "NEXT_PUBLIC_RPC_URL_4663"],
  explorerUrl: ["NUVEM_EXPLORER_URL", "SIP_EXPLORER_URL", "NEXT_PUBLIC_EXPLORER_URL", "EXPLORER_URL_4663"],
  chainId: ["NUVEM_CHAIN_ID", "SIP_CHAIN_ID", "NEXT_PUBLIC_CHAIN_ID", "CHAIN_ID"],
  factory: ["NUVEM_VAULT_FACTORY", "SIP_VAULT_FACTORY", "VAULT_FACTORY", "NEXT_PUBLIC_VAULT_FACTORY"],
  executor: ["NUVEM_SETTLEMENT_EXECUTOR", "SIP_SETTLEMENT_EXECUTOR", "NEXT_PUBLIC_SETTLEMENT_EXECUTOR", "EXECUTOR"],
  weth: ["NUVEM_WETH", "SIP_WETH", "NEXT_PUBLIC_WETH", "WETH"],
  pauseController: ["NUVEM_PAUSE_CONTROLLER", "SIP_PAUSE_CONTROLLER", "NEXT_PUBLIC_PAUSE_CONTROLLER", "PAUSE_CONTROLLER"],
  attesterRegistry: ["NUVEM_ATTESTER_REGISTRY", "SIP_ATTESTER_REGISTRY", "NEXT_PUBLIC_ATTESTER_REGISTRY", "ATTESTER_REGISTRY"],
  cohortId: ["NUVEM_COHORT_ID", "SIP_COHORT_ID", "COHORT_ID"],
  logsFromBlock: ["NUVEM_LOGS_FROM_BLOCK", "SIP_LOGS_FROM_BLOCK", "LOGS_FROM_BLOCK"],
  disableRpcProxy: ["NUVEM_DISABLE_RPC_PROXY", "SIP_DISABLE_RPC_PROXY"],
  databaseUrl: ["DATABASE_URL", "SIP_DATABASE_URL", "NUVEM_DATABASE_URL"],
} as const;

export type Setting = keyof typeof ALIASES;

/** What loadConfig reads. `process.env` in production; a plain object in tests. */
export type Env = Readonly<Record<string, string | undefined>>;

/** First non-blank alias wins. Returns the value and the name it came from. */
function read(env: Env, setting: Setting): { name: string; value: string } | null {
  for (const name of ALIASES[setting]) {
    const raw = env[name];
    if (typeof raw === "string" && raw.trim() !== "") return { name, value: raw.trim() };
  }
  return null;
}

const primary = (setting: Setting): string => ALIASES[setting][0];

/**
 * The configured upstream RPC URL, or "" if none is set.
 *
 * Exists so error redaction can scrub the endpoint without every read having to
 * thread a ServerConfig down to its catch block. It resolves from the
 * environment on each call rather than caching, so it cannot go stale relative
 * to the config a caller actually built.
 */
export function configuredRpcUrl(env: Env = process.env): string {
  return read(env, "rpcUrl")?.value ?? "";
}

/**
 * One setting, resolved through the alias table above — for the modules that
 * need a single variable and cannot use loadConfig, which returns a whole
 * ServerConfig and refuses when anything unrelated is missing. It exists so
 * those modules cannot drift onto their own shorter list of names: a deployment
 * that sets SIP_DATABASE_URL must not have a database here and no database
 * there.
 */
export function settingFrom(env: Env, setting: Setting): string | null {
  return read(env, setting)?.value ?? null;
}

// ---------------------------------------------------------------------------
// Which chain (SIP_CHAIN)
// ---------------------------------------------------------------------------

export type ChainKind = "evm" | "solana";

export type ChainRead =
  | { readonly ok: true; readonly chain: ChainKind }
  | { readonly ok: false; readonly problem: ConfigProblem };

/**
 * SIP_CHAIN, read at request time like everything else here. Unset or blank is
 * "evm", so a deployment that has never heard of the variable keeps running
 * exactly as it did. It is a NEW name on purpose: SIP_CHAIN_ID is still the EVM
 * 4663 assertion, and one variable must not mean both.
 */
export function chainFrom(env: Env = process.env): ChainRead {
  const raw = env["SIP_CHAIN"];
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (value === "") return { ok: true, chain: "evm" };
  if (value === "evm" || value === "solana") return { ok: true, chain: value };
  return {
    ok: false,
    problem: {
      variable: "SIP_CHAIN",
      message: `SIP_CHAIN must be "evm" or "solana", but it is ${JSON.stringify(value.slice(0, 32))}.`,
      howToFix:
        "Set SIP_CHAIN=solana for the Solana site, or unset it for the Robinhood Chain site. It is read per request, " +
        "so a restart applies it; no rebuild is needed.",
    },
  };
}

export type EvmRouteGate =
  | { readonly kind: "evm" }
  | { readonly kind: "solana" }
  | { readonly kind: "invalid"; readonly problem: ConfigProblem };

/**
 * The first thing every EVM route handler asks. Under SIP_CHAIN=solana those
 * routes do not exist on this deployment and answer 404 before anything else is
 * read, whatever the rest of the environment holds. An unreadable SIP_CHAIN is a
 * configuration problem like any other (503). The EVM code stays compiled either
 * way; only the answer changes.
 */
export function evmRouteGate(env: Env = process.env): EvmRouteGate {
  const chain = chainFrom(env);
  if (!chain.ok) return { kind: "invalid", problem: chain.problem };
  return chain.chain === "solana" ? { kind: "solana" } : { kind: "evm" };
}

/** What an EVM route says when it answers 404 under SIP_CHAIN=solana. */
export const EVM_ROUTE_OFF_MESSAGE = "This is a Robinhood Chain (EVM) route, and this deployment runs SIP_CHAIN=solana.";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Everything the browser is allowed to know. It crosses from the /wallets
 * server component to <Providers> as a prop, so it must survive React's
 * server-component serialisation — which carries `bigint` (React 19 Flight
 * encodes it natively), but never a function, a class instance or a Map.
 */
export interface PublicConfig {
  /** Which configuration this is: PublicConfig is the EVM one, SolanaPublicConfig the other. */
  readonly chain: "evm";

  /** Privy app id. Public by design; the dashboard origin list is the control. */
  readonly privyAppId: string;
  readonly privyClientId: string | null;
  /**
   * The app's authorization key, added as a SIGNER on each trading wallet at
   * creation so the worker can pull without ever holding the wallet's key.
   * Null means seats are not configured — the UI says so rather than
   * pretending, and NEVER creates a wallet with an empty policy list, which
   * Privy reads as full permission.
   */
  readonly privySignerId: string | null;
  /** The policy that bounds that signer to `pull` on the executor. */
  readonly privyPolicyId: string | null;

  /**
   * The RPC URL handed to the WALLET, embedded in the chain object that
   * MetaMask receives via wallet_addEthereumChain. It is NOT used for any
   * server read — those all happen through ServerConfig.rpcUrl. By default it
   * is the same-origin relay `/api/rpc`, relative because no request origin is
   * known here; chain.ts resolves it against the page origin in the browser.
   */
  readonly walletRpcUrl: string;
  readonly explorerUrl: string | null;

  /**
   * VaultFactory. The browser needs it for exactly one thing: the `address`
   * argument of the createVault write it asks the pension key to sign.
   */
  readonly factory: Address;

  /** Cohort a new vault joins. Validated onchain before anything is signed. */
  readonly cohortId: bigint;

  /** This build targets one chain; the literal type says so to every caller. */
  readonly chainId: typeof ROBINHOOD_CHAIN_ID;
}

/** Server-side superset. Never serialise this into a page or a response. */
export interface ServerConfig extends PublicConfig {
  /**
   * Privileged upstream RPC. Assume it carries an API key. Used only inside
   * route handlers and never returned in a response body.
   */
  readonly rpcUrl: string;

  /** L2 block to start trading-account log discovery from. */
  readonly logsFromBlock: bigint;

  /** When true, /api/rpc refuses to relay (NUVEM_DISABLE_RPC_PROXY). */
  readonly rpcProxyDisabled: boolean;

  /**
   * True when `walletRpcUrl` is this app's own /api/rpc relay, i.e. no explicit
   * key-free endpoint was configured. When false the relay is switched off,
   * because nothing needs it and an open relay to a metered endpoint is a
   * liability nobody asked for.
   */
  readonly rpcRelayInUse: boolean;

  /** The worker's Postgres, for /api/skims. Null means "status unavailable". */
  readonly databaseUrl: string | null;

  /**
   * Optional expectations for cross-checking what the factory reports. The
   * factory is always preferred; disagreement is surfaced, never silently
   * resolved in the environment's favour.
   */
  readonly expected: {
    readonly executor: Address | null;
    readonly weth: Address | null;
    readonly pauseController: Address | null;
    readonly attesterRegistry: Address | null;
  };
}

/**
 * THE BROWSER'S SHARE UNDER SIP_CHAIN=solana. Exactly what Privy and the Solana
 * surfaces need, and nothing that reaches an endpoint key: the HTTP RPC is always
 * this app's own relay, and the WebSocket passed the key-free rule in
 * @sip/solana-core (no path, no query, no credentials, not an RPC host).
 */
export interface SolanaPublicConfig {
  readonly chain: "solana";
  readonly privyAppId: string;
  readonly privyClientId: string | null;
  /** SIP_SOLANA_PRIVY_SIGNER_ID: the solana-keeper's Privy signer, seated on trading wallets. An id, not a key. */
  readonly privySignerId: string | null;
  /** SIP_SOLANA_PRIVY_POLICY_ID: the Solana policy that bounds that signer. Both or neither. */
  readonly privyPolicyId: string | null;
  /** Always the same-origin /api/solana-rpc; absolute when the loader was given the origin. */
  readonly solanaRpcUrl: string;
  /** Key-free wss:// origin for Privy's rpcSubscriptions (SIP_SOLANA_PUBLIC_WS_URL or the public default). */
  readonly solanaWsUrl: string;
  /** The sip_vault IDL's address, which SIP_SOLANA_PROGRAM_ID must equal. Public. */
  readonly programId: string;
  readonly explorer: "solscan";
}

/** Server-side superset under SIP_CHAIN=solana. Never serialise it into a page or a response. */
export interface SolanaServerConfig extends SolanaPublicConfig {
  /** Endpoints (keyed, non-serialising), limits and the trusted client-IP header. */
  readonly solana: SolanaServerSettings;
  readonly databaseUrl: string | null;
}

/** The boundary unions. Only the pages, WalletsHost, Providers and the route handlers take these. */
export type AnyPublicConfig = PublicConfig | SolanaPublicConfig;
export type AnyServerConfig = ServerConfig | SolanaServerConfig;

/** A configuration problem, phrased so a non-author can fix it. */
export interface ConfigProblem {
  readonly variable: string;
  readonly message: string;
  readonly howToFix: string;
}

export type ConfigLoad =
  | { readonly ok: true; readonly config: ServerConfig }
  | { readonly ok: false; readonly problems: readonly ConfigProblem[] };

export type SolanaConfigLoad =
  | { readonly ok: true; readonly config: SolanaServerConfig }
  | { readonly ok: false; readonly problems: readonly ConfigProblem[] };

export type AnyConfigLoad =
  | { readonly ok: true; readonly config: AnyServerConfig }
  | { readonly ok: false; readonly problems: readonly ConfigProblem[] };

export interface LoadOptions {
  /**
   * The absolute origin the request arrived on (scheme + host), when the
   * caller has one. A server component can read it from `headers()` and pass
   * it so the wallet gets an absolute relay URL from the start; without it the
   * relay is the relative `/api/rpc`, which chain.ts makes absolute in the
   * browser. Ignored when NUVEM_PUBLIC_RPC_URL is set.
   */
  readonly origin?: string | null;
  /**
   * Whether the browser-facing Privy settings are required. TRUE for the page,
   * which cannot render a Connect button without an app id. FALSE for the route
   * handlers: they only read the chain, and refusing to answer because a login
   * credential is absent would be coupling for its own sake.
   */
  readonly needPrivyAppId?: boolean;
}

export function toPublicConfig(config: ServerConfig): PublicConfig {
  return {
    chain: config.chain,
    privyAppId: config.privyAppId,
    privyClientId: config.privyClientId,
    privySignerId: config.privySignerId,
    privyPolicyId: config.privyPolicyId,
    walletRpcUrl: config.walletRpcUrl,
    explorerUrl: config.explorerUrl,
    factory: config.factory,
    cohortId: config.cohortId,
    chainId: config.chainId,
  };
}

/** Field by field, so `solana` (the keyed endpoints) and `databaseUrl` can never ride along. */
export function toSolanaPublicConfig(config: SolanaServerConfig): SolanaPublicConfig {
  return {
    chain: config.chain,
    privyAppId: config.privyAppId,
    privyClientId: config.privyClientId,
    privySignerId: config.privySignerId,
    privyPolicyId: config.privyPolicyId,
    solanaRpcUrl: config.solanaRpcUrl,
    solanaWsUrl: config.solanaWsUrl,
    programId: config.programId,
    explorer: config.explorer,
  };
}

export function toAnyPublicConfig(config: AnyServerConfig): AnyPublicConfig {
  return config.chain === "solana" ? toSolanaPublicConfig(config) : toPublicConfig(config);
}

// ---------------------------------------------------------------------------
// Readers that push a problem instead of throwing
// ---------------------------------------------------------------------------

function address(env: Env, setting: Setting, fallback: string | null, problems: ConfigProblem[]): Address | null {
  const found = read(env, setting);
  const raw = found?.value ?? fallback;
  if (raw === null) return null;
  if (!isAddress(raw)) {
    problems.push({
      variable: found?.name ?? primary(setting),
      message: `Not a valid EVM address: "${raw}".`,
      howToFix: `Set ${primary(setting)} to a 0x-prefixed 20-byte address, or unset it to use the built-in mainnet default.`,
    });
    return null;
  }
  return getAddress(raw);
}

function nonNegativeBigint(env: Env, setting: Setting, fallback: bigint, problems: ConfigProblem[]): bigint {
  const found = read(env, setting);
  if (found === null) return fallback;
  try {
    const parsed = BigInt(found.value);
    if (parsed < 0n) throw new Error("negative");
    return parsed;
  } catch {
    problems.push({
      variable: found.name,
      message: `Not a non-negative integer: "${found.value}".`,
      howToFix: `Set ${primary(setting)} to a decimal integer (no units, no decimal point), or unset it for the default ${fallback}.`,
    });
    return fallback;
  }
}

/** A browser-facing URL must be absolute http(s); anything else is a problem. */
function httpUrl(env: Env, setting: Setting, problems: ConfigProblem[], what: string): string | null {
  const found = read(env, setting);
  if (found === null) return null;
  let parsed: URL;
  try {
    parsed = new URL(found.value);
  } catch {
    problems.push({
      variable: found.name,
      message: `Not an absolute URL: "${found.value}".`,
      howToFix: `Set ${primary(setting)} to a full https:// URL (${what}), or unset it.`,
    });
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    problems.push({
      variable: found.name,
      message: `Not an http(s) URL: "${found.value}".`,
      howToFix: `Set ${primary(setting)} to a full https:// URL (${what}), or unset it.`,
    });
    return null;
  }
  return found.value;
}

// ---------------------------------------------------------------------------
// loadConfig
// ---------------------------------------------------------------------------

/**
 * The Privy app id, with its two refusals (not set, wrong length) pushed onto
 * `problems`. Shared by both chains' loaders: the rule is Privy's, not the chain's.
 */
export function readPrivyAppId(
  env: Env,
  needPrivyAppId: boolean,
  problems: ConfigProblem[],
): { readonly name: string; readonly value: string } | null {
  const privy = read(env, "privyAppId");
  if (privy === null && needPrivyAppId) {
    problems.push({
      variable: primary("privyAppId"),
      message: "Not set. Without a Privy app there is no way to connect a pension key.",
      howToFix:
        "Create an app at https://dashboard.privy.io, copy the App ID, enable the Wallet login method, and add " +
        "http://localhost:3002 (with the port) to Allowed origins. Then set PRIVY_APP_ID. It is public by design.",
    });
  } else if (privy !== null && needPrivyAppId && privy.value.length !== PRIVY_APP_ID_LENGTH) {
    // @privy-io/react-auth validates the app id as EXACTLY 25 characters and
    // THROWS from inside PrivyProvider's constructor if it is not. That throw
    // happens during server rendering, so an id of the wrong length turns every
    // page into a 500 while GET /api/health keeps returning 200 -- i.e. Railway
    // and compose both report the deployment healthy while the site is dead.
    // Catching it here routes it into the same setup checklist as a missing id.
    // The length is the whole of Privy's rule; do not tighten it to a character
    // set, or a future id format would be rejected by us and accepted by them.
    const looksLikeSecret = /^privy_/i.test(privy.value) || privy.value.length > 60;
    problems.push({
      variable: privy.name,
      message:
        `Wrong length: ${privy.value.length} characters, but a Privy app id is exactly ` +
        `${PRIVY_APP_ID_LENGTH}. Privy rejects this value and would otherwise 500 every page.` +
        (looksLikeSecret ? " This looks like the app SECRET, not the app id." : ""),
      howToFix: looksLikeSecret
        ? "Use the App ID, not the app secret. The App ID is on the Privy dashboard's app page and is public by " +
          "design; the secret must never be set with a NEXT_PUBLIC_ prefix. Copy the " +
          `${PRIVY_APP_ID_LENGTH}-character App ID into ${primary("privyAppId")}.`
        : `Copy the App ID exactly as https://dashboard.privy.io shows it into ${primary("privyAppId")} -- ` +
          "no quotes, no surrounding whitespace, not truncated. It is a 25-character opaque string.",
    });
  }
  return privy;
}

// ---------------------------------------------------------------------------
// loadEvmConfig
// ---------------------------------------------------------------------------

/**
 * The EVM configuration (SIP_CHAIN unset or evm), reporting every problem at
 * once. It does not read SIP_CHAIN: callers that do not already know the chain
 * use loadConfig from src/lib/load-config.ts, and the EVM route handlers ask
 * evmRouteGate first.
 */
export function loadEvmConfig(env: Env = process.env, options: LoadOptions = {}): ConfigLoad {
  const origin = options.origin ?? null;
  const needPrivyAppId = options.needPrivyAppId ?? true;
  const problems: ConfigProblem[] = [];

  const privy = readPrivyAppId(env, needPrivyAppId, problems);

  // THE SIGNER ID IS NOT THE POLICY ID, and at Privy both are 25-character
  // lowercase ids, so pasting one into the other's variable yields a config that
  // reads correct everywhere except at Privy — which answers "Invalid policy ID"
  // from inside a browser call whose text nobody sees. That is not hypothetical:
  // the Solana pilot ran with the policy variable holding the SIGNER id, and
  // every attempt to grant the seat failed with that one opaque line.
  //
  // Half a pair is refused too. A signer without a policy is the one thing the
  // wallets page must never act on: an empty policy list is FULL permission at
  // Privy, so "seat configured, policy missing" cannot be allowed to degrade
  // into an unconstrained signer. Both absent means seats are simply off.
  const signer = read(env, "privySignerId");
  const policy = read(env, "privyPolicyId");
  if (needPrivyAppId) {
    if ((signer === null) !== (policy === null)) {
      const present = signer ?? policy;
      const missing = signer === null ? primary("privySignerId") : primary("privyPolicyId");
      problems.push({
        variable: present?.name ?? primary("privySignerId"),
        message: `${present?.name ?? ""} is set but ${missing} is not — a seat needs both.`,
        howToFix:
          `Set ${primary("privySignerId")} to the app's authorization-key signer id AND ${primary("privyPolicyId")} ` +
          "to the policy that bounds it, or unset both to run without seats.",
      });
    } else if (signer !== null && policy !== null && signer.value === policy.value) {
      problems.push({
        variable: policy.name,
        message: `${policy.name} holds the same value as ${signer.name}. No id is both a signer and a policy.`,
        howToFix:
          `Copy the POLICY id from the Privy dashboard (Policies) into ${primary("privyPolicyId")}; the signer id ` +
          "stays in PRIVY_SIGNER_ID.",
      });
    }
  }

  const rpc = read(env, "rpcUrl");
  if (rpc === null) {
    problems.push({
      variable: primary("rpcUrl"),
      message: "Not set. Every contract read happens server-side through this endpoint.",
      howToFix:
        "Set NUVEM_RPC_URL to an HTTPS JSON-RPC endpoint for Robinhood Chain (chainId 4663). It stays server-side, " +
        "so it may safely carry an API key.",
    });
  }

  // THE FACTORY IS REQUIRED RATHER THAN DEFAULTED, and it is the only address
  // here that is. Every other one is cross-checked against the factory's own
  // `protocolConfiguration()` and a disagreement is surfaced; the factory cannot
  // be, because it IS the question. So a stale default here is invisible from
  // both ends: the site quietly creates vaults on a superseded deployment while
  // a worker pinned to the current one reports no wallets and looks idle rather
  // than wrong. That constant went stale twice. It no longer gets the chance.
  const factoryRead = read(env, "factory");
  const factory = factoryRead === null ? null : address(env, "factory", null, problems);
  if (factoryRead === null) {
    problems.push({
      variable: primary("factory"),
      message: "Not set. It decides which deployment every vault created here belongs to.",
      howToFix:
        `Set ${primary("factory")} to the VaultFactory of the deployment you mean. No deployment ` +
        "ships as a default and none is inherited: a vault created against the wrong factory cannot " +
        "be moved, and a worker watching a different one reports no users rather than an error. " +
        "See docs/runbooks/DEPLOYMENT.md.",
    });
  }

  const chainId = read(env, "chainId");
  if (chainId !== null && Number(chainId.value) !== ROBINHOOD_CHAIN_ID) {
    problems.push({
      variable: chainId.name,
      message: `This build targets chain ${ROBINHOOD_CHAIN_ID} only, but ${chainId.name} is "${chainId.value}".`,
      howToFix: `Unset it, or set it to ${ROBINHOOD_CHAIN_ID}.`,
    });
  }

  // uint32 on chain; kept as a bigint here because every other chain integer
  // in this package is one and a mixed diet of number and bigint is how a
  // comparison silently goes wrong.
  let cohortId = 1n;
  const cohort = read(env, "cohortId");
  if (cohort !== null) {
    let parsed: bigint | null = null;
    try {
      parsed = BigInt(cohort.value);
    } catch {
      parsed = null;
    }
    if (parsed === null || parsed < 0n || parsed > 0xffffffffn) {
      problems.push({
        variable: cohort.name,
        message: `Not a uint32: "${cohort.value}".`,
        howToFix: "Set it to the upgrade cohort a new vault should join (mainnet uses 1), or unset it.",
      });
    } else {
      cohortId = parsed;
    }
  }

  const logsFromBlock = nonNegativeBigint(env, "logsFromBlock", 0n, problems);

  // The wallet-facing RPC URL. Prefer an operator-supplied, key-free endpoint;
  // otherwise this app's own same-origin relay, which keeps the upstream key on
  // the server. See src/app/api/rpc/route.ts.
  const explicitWalletRpc = httpUrl(env, "walletRpcUrl", problems, "a key-free, CORS-enabled endpoint for chain 4663");
  const walletRpcUrl = explicitWalletRpc ?? (origin === null ? "/api/rpc" : `${origin.replace(/\/+$/, "")}/api/rpc`);

  const explorerUrl = httpUrl(env, "explorerUrl", problems, "a block explorer base URL, no trailing path");

  const expected = {
    executor: address(env, "executor", null, problems),
    weth: address(env, "weth", null, problems),
    pauseController: address(env, "pauseController", null, problems),
    attesterRegistry: address(env, "attesterRegistry", null, problems),
  } as const;

  const disable = read(env, "disableRpcProxy");
  const rpcProxyDisabled = disable !== null && !["0", "false", "no", "off"].includes(disable.value.toLowerCase());

  // TURNING THE RELAY OFF WITHOUT PUTTING ANYTHING IN ITS PLACE IS A SETUP
  // ERROR, not a supported mode. `walletRpcUrl` falls back to /api/rpc, so the
  // browser's own reads — the rate control, the receipts, every waitFor — go to
  // an endpoint that now answers 404. Nothing crashes and nothing says why: the
  // wallets page simply stops being able to read anything. Said here, it lands
  // in the setup checklist the operator is already looking at.
  if (rpcProxyDisabled && explicitWalletRpc === null) {
    problems.push({
      variable: disable?.name ?? primary("disableRpcProxy"),
      message:
        "The RPC relay is switched off, but no browser-facing endpoint is configured to replace it. The browser " +
        "would be left pointing at /api/rpc, which then answers 404 to every read the wallets page makes.",
      howToFix:
        `Set ${primary("walletRpcUrl")} to a key-free, CORS-enabled endpoint for chain ${ROBINHOOD_CHAIN_ID} — that ` +
        `switches the relay off by itself — or unset ${primary("disableRpcProxy")}.`,
    });
  }

  if (problems.length > 0 || (privy === null && needPrivyAppId) || rpc === null || factory === null) {
    return { ok: false, problems };
  }

  const config: ServerConfig = {
    chain: "evm",
    // Empty only for callers that declared they do not need it. PrivyProvider is
    // never constructed from such a config — the page always requires it.
    privyAppId: privy?.value ?? "",
    privyClientId: read(env, "privyClientId")?.value ?? null,
    privySignerId: signer?.value ?? null,
    privyPolicyId: policy?.value ?? null,
    walletRpcUrl,
    explorerUrl,
    factory,
    cohortId,
    chainId: ROBINHOOD_CHAIN_ID,
    rpcUrl: rpc.value,
    logsFromBlock,
    rpcProxyDisabled,
    rpcRelayInUse: explicitWalletRpc === null,
    databaseUrl: read(env, "databaseUrl")?.value ?? null,
    expected,
  };
  return { ok: true, config };
}
