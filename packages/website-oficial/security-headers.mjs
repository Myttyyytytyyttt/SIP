/**
 * THE BROWSER-FACING ALLOWLIST, as one policy. Restored from the Nuvem
 * dashboard's security-headers.mjs (HEAD fd927b0) for the wallets wave, minus
 * the Solana entries.
 *
 * Privy's production checklist asks for two things — a CSP around the embedded
 * wallet iframe, and X-Frame-Options — and both are headers this app has to
 * send. Ticking their boxes without sending them is only a promise.
 *
 * EVERY ENTRY IS HERE BECAUSE SOMETHING BREAKS WITHOUT IT, and the note says
 * what. A CSP assembled by copying a snippet is a CSP nobody can safely edit
 * later: the first time a directive has to change, there is no way to tell
 * which lines are load-bearing.
 */
const PRIVY_IFRAME = "https://auth.privy.io";
const WALLETCONNECT_IFRAMES = ["https://verify.walletconnect.com", "https://verify.walletconnect.org"];
const TURNSTILE = "https://challenges.cloudflare.com";

/**
 * THE LANDING'S BACKGROUND FOOTAGE. Without it media-src falls back to
 * default-src 'self' and the <video> is refused with nothing on the page to say
 * so — just an empty background. This host is the reference template's CDN and
 * serves a PLACEHOLDER clip (another brand's credit card): remove this entry
 * when the footage is replaced with SIP's own, self-hosted under /public. See
 * BACKGROUND_VIDEO in src/components/landing.tsx.
 */
const LANDING_VIDEO_HOST = "https://d8j0ntlcm91z4.cloudfront.net";

/**
 * Operator overrides that move a browser-facing endpoint off this origin. The
 * wallet RPC defaults to this app's own /api/rpc relay, so nothing is listed
 * unless someone set one of these — in which case its origin has to be in
 * connect-src or the wallet's every call is blocked silently.
 */
/**
 * READ AT CALL TIME, NOT AT MODULE LOAD. `next.config.mjs` compiles `headers()`
 * into the route manifest at BUILD time, so a policy built from a module-level
 * snapshot of these variables cannot see an endpoint the platform sets at
 * RESTART time — and the browser's only symptom is a blocked request with no
 * server-side trace. `middleware.ts` calls securityHeaders() per request, which
 * is what makes a restart enough.
 */
function overrides() {
  return [
  process.env.NUVEM_PUBLIC_RPC_URL,
  process.env.SIP_PUBLIC_RPC_URL,
  process.env.NEXT_PUBLIC_RPC_URL,
  process.env.NEXT_PUBLIC_RPC_URL_4663,
  ];
}

/** An override's origin, or null when it is unset, relative, or unparseable. */
export function endpointOrigin(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export function buildCsp(extraOrigins = overrides()) {
  const extra = [...new Set(extraOrigins.map(endpointOrigin).filter((origin) => origin !== null))];

  const directives = {
    // The floor. Anything not named below falls here, so a directive nobody
    // thought about fails closed instead of inheriting '*'.
    "default-src": ["'self'"],

    /**
     * 'unsafe-inline' IS HERE FOR ONE REASON AND IT IS NOT A SHRUG.
     *
     * The App Router streams its RSC payload through inline
     * <script>self.__next_f.push(...)</script> tags on every page. Under
     * script-src 'self' with no nonce the browser blocks them, and the result
     * is not a visible error — the server HTML paints and nothing ever
     * hydrates, so the page looks fine and no button works.
     *
     * The documented alternative is a per-request nonce from middleware, which
     * opts every route into dynamic rendering. So: inline scripts are allowed,
     * no external script origin is except Turnstile (Privy's bot check), and
     * the XSS surface that remains is bounded by everything else in this
     * policy — nothing can be fetched, framed or exfiltrated to an origin not
     * named here.
     *
     * 'unsafe-eval' IN DEVELOPMENT ONLY: React's dev build evals to rebuild
     * call stacks for its debugging overlay and logs a warning without it.
     * Production bundles never eval, so production never grants it.
     */
    "script-src": ["'self'", "'unsafe-inline'", TURNSTILE, ...(process.env.NODE_ENV === "production" ? [] : ["'unsafe-eval'"])],

    // Next injects <style> for next/font's preload rules; inline styles are
    // not an XSS vector the way inline scripts are.
    "style-src": ["'self'", "'unsafe-inline'"],

    /**
     * Ticker and brand marks are local files under /public; data: and blob:
     * cover the canvas and object URLs the wallet SDKs render QR codes with.
     *
     * THE WALLETCONNECT EXPLORER IS HERE BECAUSE THE MODAL BREAKS WITHOUT IT,
     * and Privy's published baseline does not mention it: that host is listed
     * there under connect-src only, but the wallet chooser also loads every
     * wallet's LOGO from it. Measured — with img-src at Privy's values the
     * console fills with "Loading the image
     * 'https://explorer-api.walletconnect.com/v3/logo/sm/…' violates" and the
     * list renders with holes where the wallets should be.
     */
    "img-src": ["'self'", "data:", "blob:", "https://explorer-api.walletconnect.com"],

    // The landing's scrubbed background video (see LANDING_VIDEO_HOST).
    "media-src": ["'self'", LANDING_VIDEO_HOST],

    // next/font/google self-hosts at build time, so the faces are same-origin.
    "font-src": ["'self'"],

    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],

    // Nothing may frame this app. The X-Frame-Options header below says the
    // same thing for browsers that predate this directive.
    "frame-ancestors": ["'none'"],

    // Privy's embedded-wallet iframe, WalletConnect's verify frames, and the
    // Turnstile challenge. child-src is the fallback older engines read for
    // frames; naming both keeps the answer identical everywhere.
    "child-src": [PRIVY_IFRAME, ...WALLETCONNECT_IFRAMES],
    "frame-src": [PRIVY_IFRAME, ...WALLETCONNECT_IFRAMES, TURNSTILE],

    "connect-src": [
      // The whole page: /api/vault, /api/create-vault, /api/rpc, /api/skims —
      // all same-origin by design.
      "'self'",
      // Privy's auth API and its embedded-wallet RPC fan-out.
      PRIVY_IFRAME,
      "https://*.rpc.privy.systems",
      // The wallet chooser's registry, and the relays external wallets use.
      "https://explorer-api.walletconnect.com",
      "wss://relay.walletconnect.com",
      "wss://relay.walletconnect.org",
      "wss://www.walletlink.org",
      ...extra,
    ],

    "worker-src": ["'self'", "blob:"],
    "manifest-src": ["'self'"],
  };

  return Object.entries(directives)
    .map(([name, values]) => `${name} ${values.join(" ")}`)
    .join("; ");
}

/** The two Privy asks, plus the headers that would be odd to omit beside them. */
export function securityHeaders() {
  return [
    { key: "Content-Security-Policy", value: buildCsp() },
    // Superseded by frame-ancestors in modern browsers; Privy's checklist asks
    // for it by name, and it costs one line to also answer the old ones.
    { key: "X-Frame-Options", value: "DENY" },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    // This app asks for none of these; saying so keeps an embedded iframe from
    // inheriting them through us.
    { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  ];
}
