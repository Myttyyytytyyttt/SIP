/**
 * Types for next.config.mjs, so scripts/next-config.test.ts can import it under
 * `noImplicitAny`. The config itself stays plain JavaScript, because Next loads
 * it directly.
 */

/** The dev-only Privy stub alias, or {} when it must not apply. See next.config.mjs. */
export declare function privyStubAlias(env?: Record<string, string | undefined>): Record<string, string>;

declare const nextConfig: Record<string, unknown> & { turbopack?: { resolveAlias: Record<string, string> } };

export default nextConfig;
