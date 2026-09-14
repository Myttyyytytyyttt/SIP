/**
 * The types for security-headers.mjs, which stays plain JavaScript so
 * next.config.mjs (which cannot import TypeScript) and src/proxy.ts read the
 * SAME policy object. A second spelling of it is how a CSP drifts from what
 * anything checks it against.
 */
export interface CspOptions {
  /**
   * Extra connect-src origins, each reduced to its origin. Default: the browser's
   * Solana WebSocket (SIP_SOLANA_PUBLIC_WS_URL when it passes the key-free rule,
   * otherwise the public default).
   */
  readonly extraOrigins?: readonly (string | null | undefined)[];
}

export declare function endpointOrigin(value: unknown): string | null;
export declare function buildCsp(options?: CspOptions): string;
export declare function securityHeaders(): readonly { readonly key: string; readonly value: string }[];
