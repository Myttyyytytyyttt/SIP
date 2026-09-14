/**
 * Pins the Content-Security-Policy to the exact string the server sent before SIP
 * became Solana-only. Ported from the Nuvem dashboard's scripts/check-csp.mjs.
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
 * WHY A GOLDEN STRING. "Carries the Solana WebSocket" would still pass a refactor
 * that reordered or dropped a directive. SOLANA_GOLDEN was captured from
 * security-headers.mjs at 1f4b8bc, before the EVM branch and SIP_CHAIN were
 * removed, with NODE_ENV=production and SIP_CHAIN=solana in an otherwise empty
 * environment: buildCsp(). Removing them did not change the policy by a byte. If
 * the policy must change, change it on purpose and re-capture.
 *
 * THE HOST LIST BELOW IS PRIVY'S OWN, from their CSP guidance page. Anything
 * beyond it is annotated in security-headers.mjs with the failure that put it
 * there.
 */

import { buildCsp, securityHeaders } from "../security-headers.mjs";

const SOLANA_GOLDEN =
  "default-src 'self'; script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob: https://explorer-api.walletconnect.com; media-src 'self' https://d8j0ntlcm91z4.cloudfront.net; " +
  "font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; " +
  "child-src https://auth.privy.io https://verify.walletconnect.com https://verify.walletconnect.org; " +
  "frame-src https://auth.privy.io https://verify.walletconnect.com https://verify.walletconnect.org https://challenges.cloudflare.com; " +
  "connect-src 'self' https://auth.privy.io https://*.rpc.privy.systems https://explorer-api.walletconnect.com " +
  "wss://relay.walletconnect.com wss://relay.walletconnect.org wss://www.walletlink.org wss://api.mainnet-beta.solana.com; " +
  "worker-src 'self' blob:; manifest-src 'self'";

const SOLANA_DEFAULT_WS = "wss://api.mainnet-beta.solana.com";
const SAMPLE_OVERRIDE = "https://rpc.example.org/v2/SAMPLEKEY";

/** The EVM wallet-RPC overrides the policy used to read. A leftover must add nothing. */
const RETIRED_OVERRIDES = ["NUVEM_PUBLIC_RPC_URL", "SIP_PUBLIC_RPC_URL", "NEXT_PUBLIC_RPC_URL", "NEXT_PUBLIC_RPC_URL_4663"] as const;

// Production semantics ('unsafe-eval' is development-only), and a clean slate:
// nothing the calling shell exported may decide what gets checked. The values of
// the variables below are deleted unread, in this process only.
const env = process.env as Record<string, string | undefined>;
env["NODE_ENV"] = "production";
const VARIABLES = ["SIP_CHAIN", "SIP_SOLANA_PUBLIC_WS_URL", "SIP_SOLANA_RPC_URLS", ...RETIRED_OVERRIDES] as const;
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

/** The rules behind the golden, so a deliberate re-capture cannot drop one unnoticed. */
function common(csp: string): void {
  const byKey = Object.fromEntries(securityHeaders().map((header) => [header.key.toLowerCase(), header.value]));
  check("a Content-Security-Policy is sent", typeof byKey["content-security-policy"] === "string");
  check("X-Frame-Options is DENY", byKey["x-frame-options"] === "DENY", byKey["x-frame-options"]);
  check(
    "…and frame-ancestors says the same thing",
    JSON.stringify(sources(csp, "frame-ancestors")) === JSON.stringify(["'none'"]),
    JSON.stringify(sources(csp, "frame-ancestors")),
  );

  for (const [directive, hosts] of Object.entries(REQUIRED)) {
    const listed = sources(csp, directive);
    const missing = hosts.filter((host) => !listed.includes(host));
    check(`${directive} carries every host Privy documents`, missing.length === 0, JSON.stringify(missing));
  }

  // MEASURED, NOT DOCUMENTED: the wallet chooser loads each wallet's logo from the explorer.
  check("img-src lets the wallet chooser draw its logos", sources(csp, "img-src").includes("https://explorer-api.walletconnect.com"));
  check("…and the app's own marks and QR canvases", ["'self'", "data:", "blob:"].every((s) => sources(csp, "img-src").includes(s)));
  check("connect-src carries this origin, where every /api call goes", sources(csp, "connect-src").includes("'self'"));

  check("nothing anywhere may eval", !csp.includes("'unsafe-eval'"));
  check("default-src is 'self', not a wildcard", JSON.stringify(sources(csp, "default-src")) === JSON.stringify(["'self'"]));
  check("object-src is none", JSON.stringify(sources(csp, "object-src")) === JSON.stringify(["'none'"]));
  check("base-uri is locked to this origin", JSON.stringify(sources(csp, "base-uri")) === JSON.stringify(["'self'"]));

  const all = csp.split(";").flatMap((part) => part.trim().split(/\s+/).slice(1));
  check("no directive is opened to a bare *", !all.includes("*"), csp);

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
  check("every origin is an origin, never a URL with a path or query", withPath.length === 0, JSON.stringify(withPath));

  /**
   * script-src IS THE ONE THAT MATTERS AND THE ONE THAT IS LOOSE. 'unsafe-inline'
   * is required (the App Router streams its payload through inline scripts);
   * what must stay true is that NO external script origin joins it beyond
   * Privy's CAPTCHA host.
   */
  const allowed = new Set(["'self'", "'unsafe-inline'", "https://challenges.cloudflare.com"]);
  const strays = sources(csp, "script-src").filter((source) => !allowed.has(source));
  check("script-src admits no origin beyond self and Privy's CAPTCHA", strays.length === 0, JSON.stringify(strays));
}

console.log("[web] the security headers");
{
  const policy = buildCsp();
  check("with nothing set, byte-identical to the policy captured before the Solana-only refactor", policy === SOLANA_GOLDEN, policy);
  check("securityHeaders() sends exactly the golden", sentCsp() === SOLANA_GOLDEN);
  check("connect-src carries the default public Solana WebSocket", sources(policy, "connect-src").includes(SOLANA_DEFAULT_WS));
  check("no Solana HTTPS origin (the HTTP RPC is the same-origin relay)", !/https:\/\/[^ ;]*solana/.test(policy));
  check("no Helius origin, ever", !/helius/i.test(policy));

  for (const value of ["solana", "  Solana ", "evm", ""]) {
    env["SIP_CHAIN"] = value;
    check(`a leftover SIP_CHAIN=${JSON.stringify(value)} changes nothing`, buildCsp() === SOLANA_GOLDEN && sentCsp() === SOLANA_GOLDEN);
  }
  delete env["SIP_CHAIN"];

  for (const name of RETIRED_OVERRIDES) {
    env[name] = SAMPLE_OVERRIDE;
    check(`a leftover ${name} adds nothing`, buildCsp() === SOLANA_GOLDEN);
    delete env[name];
  }

  const explicit = buildCsp({ extraOrigins: [SAMPLE_OVERRIDE, undefined, "", null] });
  check(
    "explicit extra origins go in as origins only, and unset ones add nothing",
    sources(explicit, "connect-src").includes("https://rpc.example.org") && !explicit.includes("SAMPLEKEY") && !explicit.includes(SOLANA_DEFAULT_WS),
    explicit,
  );

  env["SIP_SOLANA_PUBLIC_WS_URL"] = "wss://ws.example.org";
  const custom = buildCsp();
  check(
    "a key-free SIP_SOLANA_PUBLIC_WS_URL replaces the default",
    sources(custom, "connect-src").includes("wss://ws.example.org") && !custom.includes(SOLANA_DEFAULT_WS),
  );

  env["SIP_SOLANA_PUBLIC_WS_URL"] = "wss://ws.example.org/PATHTOKEN123";
  const withPath = buildCsp();
  check(
    "a WebSocket URL with a path is refused, and the default goes in instead",
    sources(withPath, "connect-src").includes(SOLANA_DEFAULT_WS) && !withPath.includes("PATHTOKEN123") && !withPath.includes("ws.example.org"),
  );

  env["SIP_SOLANA_PUBLIC_WS_URL"] = "wss://ws.example.org/?api-key=QUERYKEY456";
  const withQuery = buildCsp();
  check(
    "a WebSocket URL with a query is refused, and the default goes in instead",
    sources(withQuery, "connect-src").includes(SOLANA_DEFAULT_WS) && !withQuery.includes("QUERYKEY456"),
  );

  env["SIP_SOLANA_RPC_URLS"] = "https://mainnet.helius-rpc.example/?api-key=HELIUSKEY789";
  env["SIP_SOLANA_PUBLIC_WS_URL"] = "wss://mainnet.helius-rpc.example";
  const onRpcHost = buildCsp();
  check(
    "a WebSocket on the keyed RPC's host is refused, and the default goes in instead",
    sources(onRpcHost, "connect-src").includes(SOLANA_DEFAULT_WS) && !/helius/i.test(onRpcHost) && !onRpcHost.includes("HELIUSKEY789"),
  );
  clean();

  common(policy);
}

console.log(failed === 0 ? "[web] CSP check passed\n" : `[web] CSP check: ${failed} FAILED\n`);
process.exit(failed === 0 ? 0 : 1);
