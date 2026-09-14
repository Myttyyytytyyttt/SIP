/**
 * The types for security-headers.mjs, which stays plain JavaScript so
 * next.config.mjs (which cannot import TypeScript) and the middleware read the
 * SAME policy object. A second spelling of it is how a CSP drifts from what
 * anything checks it against.
 */
export type ChainKind = "evm" | "solana";

export interface CspOptions {
  /** Default: SIP_CHAIN at call time (chainKind()). */
  readonly chain?: ChainKind;
  /** Extra connect-src origins. Default: the chain's own list (EVM wallet-RPC overrides, or the Solana WebSocket). */
  readonly extraOrigins?: readonly (string | null | undefined)[];
}

export declare function chainKind(): ChainKind;
export declare function endpointOrigin(value: unknown): string | null;
/** An array is the pre-SIP_CHAIN signature: the EVM policy with those overrides. */
export declare function buildCsp(options?: CspOptions | readonly (string | null | undefined)[]): string;
export declare function securityHeaders(): readonly { readonly key: string; readonly value: string }[];
