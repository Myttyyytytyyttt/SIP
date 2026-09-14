/**
 * THE CONFIGURATION'S SHAPES, and the split between what the server may know and
 * what the browser may see. SIP is Solana-only: there is one configuration,
 * SolanaServerConfig on the server and SolanaPublicConfig in the browser.
 *
 * The loader lives in src/lib/load-config.ts, not here, because it reaches
 * @sip/solana-core/server (the keyed RPC endpoints) and is server-only. This file
 * holds the types and the small readers the loader uses, so a `'use client'`
 * module may `import type { SolanaPublicConfig, ConfigProblem }` from it. A client
 * module never takes a runtime value from load-config.ts.
 *
 * WHY THE SPLIT, AND WHY NOTHING IS `NEXT_PUBLIC_`:
 *
 * `NEXT_PUBLIC_*` values are string-inlined into the client bundle at
 * `next build` time. An image built in CI without them and then deployed to
 * Railway with the variables set in the dashboard would ship `undefined` as the
 * Privy app id — failing in the user's browser, not in the build. So the server
 * reads the environment at REQUEST time and hands the browser exactly what it
 * needs as props. One image, every environment, restart instead of rebuild.
 * (`NEXT_PUBLIC_`-prefixed Privy names are still read by name, at request time,
 * as aliases, so an existing .env keeps working.)
 *
 * The second reason for the split is sharper: SIP_SOLANA_RPC_URLS carries a
 * Helius key. `SolanaServerConfig.solana` therefore NEVER crosses to the browser.
 * What the browser gets is this app's own same-origin /api/solana-rpc relay and a
 * key-free WebSocket that passed @sip/solana-core's rule.
 *
 * ONE ENTRY POINT, DELIBERATELY: loadConfig() collects EVERY problem and returns
 * them, so the page can render a setup checklist instead of a stack trace. The
 * operator may not have a Privy app yet — that is an expected first-run state,
 * not a crash.
 */

import type { SolanaServerSettings } from "@sip/solana-core/server";

/**
 * The exact length @privy-io/react-auth requires of an app id. Its check is
 * `typeof id !== "string" || id.length !== 25` and it throws rather than
 * degrading, so this must stay in step with the installed SDK.
 */
const PRIVY_APP_ID_LENGTH = 25;

const ALIASES = {
  privyAppId: ["PRIVY_APP_ID", "SIP_PRIVY_APP_ID", "NEXT_PUBLIC_PRIVY_APP_ID"],
  privyClientId: ["PRIVY_CLIENT_ID", "SIP_PRIVY_CLIENT_ID", "NEXT_PUBLIC_PRIVY_CLIENT_ID"],
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
 * One setting, resolved through the alias table above, so no caller drifts onto
 * its own shorter list of names.
 */
export function settingFrom(env: Env, setting: Setting): string | null {
  return read(env, setting)?.value ?? null;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * THE BROWSER'S SHARE. Exactly what Privy and the Solana surfaces need, and
 * nothing that reaches an endpoint key: the HTTP RPC is always this app's own
 * relay, and the WebSocket passed the key-free rule in @sip/solana-core (no path,
 * no query, no credentials, not an RPC host). It crosses from a server component
 * to <Providers> as a prop, so it holds only plain serialisable values.
 */
export interface SolanaPublicConfig {
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

/** Server-side superset. Never serialise it into a page or a response. */
export interface SolanaServerConfig extends SolanaPublicConfig {
  /** Endpoints (keyed, non-serialising), limits and the trusted client-IP header. */
  readonly solana: SolanaServerSettings;
}

/** A configuration problem, phrased so a non-author can fix it. It names a variable and never repeats a secret value. */
export interface ConfigProblem {
  readonly variable: string;
  readonly message: string;
  readonly howToFix: string;
}

export type SolanaConfigLoad =
  | { readonly ok: true; readonly config: SolanaServerConfig }
  | { readonly ok: false; readonly problems: readonly ConfigProblem[] };

export interface LoadOptions {
  /**
   * The absolute origin the request arrived on (scheme + host), when the caller
   * has one. With it the browser gets an absolute relay URL from the start;
   * without it the relay is the relative /api/solana-rpc, which providers.tsx
   * resolves against the page in the browser.
   */
  readonly origin?: string | null;
  /**
   * Whether the browser-facing Privy settings are required. TRUE for the pages,
   * which cannot render a Connect button without an app id. FALSE for callers
   * that only need the server settings: refusing to answer because a login
   * credential is absent would be coupling for its own sake.
   */
  readonly needPrivyAppId?: boolean;
}

/** Field by field, so `solana` (the keyed endpoints) can never ride along. */
export function toSolanaPublicConfig(config: SolanaServerConfig): SolanaPublicConfig {
  return {
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

// ---------------------------------------------------------------------------
// Readers that push a problem instead of throwing
// ---------------------------------------------------------------------------

/** The Privy app id, with its two refusals (not set, wrong length) pushed onto `problems`. The rule is Privy's. */
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
