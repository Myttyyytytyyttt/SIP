/**
 * Pins the Content-Security-Policy for BOTH chains, and pins the EVM one to the
 * exact string it was before SIP_CHAIN existed. Ported from the Nuvem dashboard's
 * scripts/check-csp.mjs and extended for SIP_CHAIN.
 *
 * Run: pnpm run check:csp   (prebuild runs it, so the Docker build enforces it)
 *
 * WHY A GUARD RATHER THAN TRUST. A CSP fails in a way nothing else in this app
 * does: the server is healthy, the build is green, the page renders — and one
 * request the browser refused means the login modal has no wallet logos, or
 * the embedded wallet iframe never mounts, or (worst) nothing hydrates at all.
 * None of that reaches a log we keep. So the policy is checked here, from the
 * same module the server sends, before it can ship.
 *
 * WHY A GOLDEN STRING FOR EVM. "No solana.com origin" would still pass a refactor
 * that reordered or dropped an EVM directive. The strings below were captured
 * from security-headers.mjs at f2bd462 (before SIP_CHAIN) with NODE_ENV=production,
 * in an empty environment: buildCsp([]) and buildCsp(["https://rpc.example.org/v2/SAMPLEKEY"]).
 * If the EVM policy must change, change it on purpose and re-capture both.
 *
 * THE HOST LIST BELOW IS PRIVY'S OWN, from their CSP guidance page. Anything
 * beyond it is annotated in security-headers.mjs with the failure that put it
 * there.
 */

import { buildCsp, chainKind, securityHeaders } from "../security-headers.mjs";

const EVM_GOLDEN =
  "default-src 'self'; script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob: https://explorer-api.walletconnect.com; media-src 'self' https://d8j0ntlcm91z4.cloudfront.net; " +
  "font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; " +
  "child-src https://auth.privy.io https://verify.walletconnect.com https://verify.walletconnect.org; " +
  "frame-src https://auth.privy.io https://verify.walletconnect.com https://verify.walletconnect.org https://challenges.cloudflare.com; " +
  "connect-src 'self' https://auth.privy.io https://*.rpc.privy.systems https://explorer-api.walletconnect.com " +
  "wss://relay.walletconnect.com wss://relay.walletconnect.org wss://www.walletlink.org; worker-src 'self' blob:; manifest-src 'self'";

const EVM_GOLDEN_WITH_OVERRIDE =
  "default-src 'self'; script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob: https://explorer-api.walletconnect.com; media-src 'self' https://d8j0ntlcm91z4.cloudfront.net; " +
  "font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; " +
  "child-src https://auth.privy.io https://verify.walletconnect.com https://verify.walletconnect.org; " +
  "frame-src https://auth.privy.io https://verify.walletconnect.com https://verify.walletconnect.org https://challenges.cloudflare.com; " +
  "connect-src 'self' https://auth.privy.io https://*.rpc.privy.systems https://explorer-api.walletconnect.com " +
  "wss://relay.walletconnect.com wss://relay.walletconnect.org wss://www.walletlink.org https://rpc.example.org; " +
  "worker-src 'self' blob:; manifest-src 'self'";

const SOLANA_DEFAULT_WS = "wss://api.mainnet-beta.solana.com";
const SAMPLE_OVERRIDE = "https://rpc.example.org/v2/SAMPLEKEY";

// Production semantics ('unsafe-eval' is development-only), and a clean slate:
// nothing the calling shell exported may decide what gets checked. The values of
// the variables below are deleted unread, in this process only.
const env = process.env as Record<string, string | undefined>;
env["NODE_ENV"] = "production";
const VARIABLES = [
  "SIP_CHAIN",
  "SIP_SOLANA_PUBLIC_WS_URL",
  "SIP_SOLANA_RPC_URLS",
  "NUVEM_PUBLIC_RPC_URL",
  "SIP_PUBLIC_RPC_URL",
  "NEXT_PUBLIC_RPC_URL",
  "NEXT_PUBLIC_RPC_URL_4663",
] as const;
const clean = (): void => {
  for (const name of VARIABLES) delete env[name];
};
clean();

let failed = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${ok || !detail ? "" : `  ${detail}`}`);
  if (!ok) failed += 1;
};

/** The sources listed for one directive, or [] when it is absent. */
const sources = (policy: string, directive: string): string[] => {
  const found = policy
    .split(";")
    .map((part) => part.trim())
    .find((part) => part === directive || part.startsWith(`${directive} `));
  return found === undefined ? [] : found.split(/\s+/).slice(1);
};

const sentCsp = (): string | undefined =>
  securityHeaders().find((header) => header.key.toLowerCase() === "content-security-policy")?.value;

const REQUIRED: Readonly<Record<string, readonly string[]>> = {
  "child-src": ["https://auth.privy.io", "https://verify.walletconnect.com", "https://verify.walletconnect.org"],
  "frame-src": ["https://auth.privy.io", "https://verify.walletconnect.com", "https://verify.walletconnect.org"],
  "connect-src": [
    "https://auth.privy.io",
    "https://*.rpc.privy.systems",
    "https://explorer-api.walletconnect.com",
    "wss://relay.walletconnect.com",
    "wss://relay.walletconnect.org",
    "wss://www.walletlink.org",
  ],
};

/** Everything both chains must satisfy. */
function common(label: string, csp: string): void {
  const byKey = Object.fromEntries(securityHeaders().map((header) => [header.key.toLowerCase(), header.value]));
  check(`${label}: a Content-Security-Policy is sent`, typeof byKey["content-security-policy"] === "string");
  check(`${label}: X-Frame-Options is DENY`, byKey["x-frame-options"] === "DENY", byKey["x-frame-options"]);
  check(
    `${label}: …and frame-ancestors says the same thing`,
    JSON.stringify(sources(csp, "frame-ancestors")) === JSON.stringify(["'none'"]),
    JSON.stringify(sources(csp, "frame-ancestors")),
  );

  for (const [directive, hosts] of Object.entries(REQUIRED)) {
    const listed = sources(csp, directive);
    const missing = hosts.filter((host) => !listed.includes(host));
    check(`${label}: ${directive} carries every host Privy documents`, missing.length === 0, JSON.stringify(missing));
  }

  // MEASURED, NOT DOCUMENTED: the wallet chooser loads each wallet's logo from the explorer.
  check(
    `${label}: img-src lets the wallet chooser draw its logos`,
    sources(csp, "img-src").includes("https://explorer-api.walletconnect.com"),
  );
  check(`${label}: …and the app's own marks and QR canvases`, ["'self'", "data:", "blob:"].every((s) => sources(csp, "img-src").includes(s)));
  check(`${label}: connect-src carries this origin, where every /api call goes`, sources(csp, "connect-src").includes("'self'"));

  check(`${label}: nothing anywhere may eval`, !csp.includes("'unsafe-eval'"));
  check(`${label}: default-src is 'self', not a wildcard`, JSON.stringify(sources(csp, "default-src")) === JSON.stringify(["'self'"]));
  check(`${label}: object-src is none`, JSON.stringify(sources(csp, "object-src")) === JSON.stringify(["'none'"]));
  check(`${label}: base-uri is locked to this origin`, JSON.stringify(sources(csp, "base-uri")) === JSON.stringify(["'self'"]));

  const all = csp.split(";").flatMap((part) => part.trim().split(/\s+/).slice(1));
  check(`${label}: no directive is opened to a bare *`, !all.includes("*"), csp);

  // A path or query in a CSP source would put whatever it carries (an API key) into a response header.
  const withPath = all.filter((source) => {
    if (!/^(https?|wss?):\/\//.test(source)) return false;
    try {
      const url = new URL(source.replace("*.", "wildcard."));
      return (url.pathname !== "" && url.pathname !== "/") || url.search !== "" || url.username !== "";
    } catch {
      return true;
    }
  });
  check(`${label}: every origin is an origin, never a URL with a path or query`, withPath.length === 0, JSON.stringify(withPath));

  /**
   * script-src IS THE ONE THAT MATTERS AND THE ONE THAT IS LOOSE. 'unsafe-inline'
   * is required (the App Router streams its payload through inline scripts);
   * what must stay true is that NO external script origin joins it beyond
   * Privy's CAPTCHA host.
   */
  const allowed = new Set(["'self'", "'unsafe-inline'", "https://challenges.cloudflare.com"]);
  const strays = sources(csp, "script-src").filter((source) => !allowed.has(source));
  check(`${label}: script-src admits no origin beyond self and Privy's CAPTCHA`, strays.length === 0, JSON.stringify(strays));
}

// ---------------------------------------------------------------------------
// EVM (SIP_CHAIN unset or evm): byte-identical to the golden
// ---------------------------------------------------------------------------

console.log("[web] the security headers, EVM (SIP_CHAIN unset)");
{
  check("evm: SIP_CHAIN unset is the EVM policy", chainKind() === "evm");
  const evm = buildCsp({ chain: "evm", extraOrigins: [] });
  check("evm: no overrides → byte-identical to the pre-SIP_CHAIN policy", evm === EVM_GOLDEN, evm);
  check("evm: the array signature is unchanged", buildCsp([]) === EVM_GOLDEN);
  check("evm: an unset override adds nothing", buildCsp([undefined, "", null]) === EVM_GOLDEN);
  check("evm: with no chain given and nothing set, the policy is the golden", buildCsp() === EVM_GOLDEN);
  check("evm: securityHeaders() sends exactly the golden", sentCsp() === EVM_GOLDEN);
  check(
    "evm: an operator's RPC override → byte-identical to the golden with that origin",
    buildCsp([SAMPLE_OVERRIDE]) === EVM_GOLDEN_WITH_OVERRIDE,
  );

  env["NUVEM_PUBLIC_RPC_URL"] = SAMPLE_OVERRIDE;
  check("evm: …read from NUVEM_PUBLIC_RPC_URL at call time, as an origin only", buildCsp() === EVM_GOLDEN_WITH_OVERRIDE);
  env["SIP_CHAIN"] = "evm";
  check("evm: SIP_CHAIN=evm is the same policy", sentCsp() === EVM_GOLDEN_WITH_OVERRIDE);
  env["SIP_CHAIN"] = "sol";
  check("evm: an unrecognised SIP_CHAIN falls back to the EVM policy (config.ts reports it)", chainKind() === "evm" && buildCsp() === EVM_GOLDEN_WITH_OVERRIDE);
  clean();

  check("evm: no Solana origin", !evm.includes("solana"));
  common("evm", evm);
}

// ---------------------------------------------------------------------------
// Solana (SIP_CHAIN=solana): the EVM policy plus one WebSocket origin
// ---------------------------------------------------------------------------

console.log("[web] the security headers, Solana (SIP_CHAIN=solana)");
{
  env["SIP_CHAIN"] = "solana";
  check("solana: SIP_CHAIN=solana is recognised", chainKind() === "solana");
  env["SIP_CHAIN"] = "  Solana ";
  check("solana: …trimmed and in any case", chainKind() === "solana");
  env["SIP_CHAIN"] = "solana";

  const solana = buildCsp();
  check("solana: securityHeaders() sends the Solana policy", sentCsp() === solana);
  check("solana: connect-src carries the default public Solana WebSocket", sources(solana, "connect-src").includes(SOLANA_DEFAULT_WS));
  check(
    "solana: the policy is the EVM golden plus that one origin, and nothing else",
    solana === EVM_GOLDEN.replace("wss://www.walletlink.org;", `wss://www.walletlink.org ${SOLANA_DEFAULT_WS};`),
    solana,
  );
  check("solana: no Solana HTTPS origin (the HTTP RPC is the same-origin relay)", !/https:\/\/[^ ;]*solana/.test(solana));
  check("solana: no Helius origin, ever", !/helius/i.test(solana));

  env["NUVEM_PUBLIC_RPC_URL"] = SAMPLE_OVERRIDE;
  check("solana: the EVM wallet-RPC overrides are ignored", !buildCsp().includes("rpc.example.org"));
  delete env["NUVEM_PUBLIC_RPC_URL"];

  env["SIP_SOLANA_PUBLIC_WS_URL"] = "wss://ws.example.org";
  const custom = buildCsp();
  check(
    "solana: a key-free SIP_SOLANA_PUBLIC_WS_URL replaces the default",
    sources(custom, "connect-src").includes("wss://ws.example.org") && !custom.includes(SOLANA_DEFAULT_WS),
  );

  env["SIP_SOLANA_PUBLIC_WS_URL"] = "wss://ws.example.org/PATHTOKEN123";
  const withPath = buildCsp();
  check(
    "solana: a WebSocket URL with a path is refused, and the default goes in instead",
    sources(withPath, "connect-src").includes(SOLANA_DEFAULT_WS) && !withPath.includes("PATHTOKEN123") && !withPath.includes("ws.example.org"),
  );

  env["SIP_SOLANA_PUBLIC_WS_URL"] = "wss://ws.example.org/?api-key=QUERYKEY456";
  const withQuery = buildCsp();
  check(
    "solana: a WebSocket URL with a query is refused, and the default goes in instead",
    sources(withQuery, "connect-src").includes(SOLANA_DEFAULT_WS) && !withQuery.includes("QUERYKEY456"),
  );

  env["SIP_SOLANA_RPC_URLS"] = "https://mainnet.helius-rpc.example/?api-key=HELIUSKEY789";
  env["SIP_SOLANA_PUBLIC_WS_URL"] = "wss://mainnet.helius-rpc.example";
  const onRpcHost = buildCsp();
  check(
    "solana: a WebSocket on the keyed RPC's host is refused, and the default goes in instead",
    sources(onRpcHost, "connect-src").includes(SOLANA_DEFAULT_WS) && !/helius/i.test(onRpcHost) && !onRpcHost.includes("HELIUSKEY789"),
  );
  delete env["SIP_SOLANA_PUBLIC_WS_URL"];
  delete env["SIP_SOLANA_RPC_URLS"];

  check("solana: an explicit chain overrides SIP_CHAIN", buildCsp({ chain: "evm", extraOrigins: [] }) === EVM_GOLDEN);
  common("solana", solana);
  clean();
}

console.log(failed === 0 ? "[web] CSP check passed for both chains\n" : `[web] CSP check: ${failed} FAILED\n`);
process.exit(failed === 0 ? 0 : 1);
