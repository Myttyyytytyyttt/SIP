/**
 * The types for security-headers.mjs, which stays plain JavaScript so
 * next.config.mjs (which cannot import TypeScript) and the middleware read the
 * SAME policy object. A second spelling of it is how a CSP drifts from what
 * anything checks it against.
 */
export declare function endpointOrigin(value: unknown): string | null;
export declare function buildCsp(extraOrigins?: readonly (string | undefined)[]): string;
export declare function securityHeaders(): readonly { readonly key: string; readonly value: string }[];
