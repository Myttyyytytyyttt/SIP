/**
 * Types for next.config.mjs, so scripts/next-config.test.ts can import it under
 * `noImplicitAny`. The config itself stays plain JavaScript, because Next loads
 * it directly.
 */

/** The dev-only Privy stub alias, or {} when it must not apply. See next.config.mjs. */
export declare function privyStubAlias(env?: Record<string, string | undefined>): Record<string, string>;

/** The commit this build is from — VERCEL_GIT_COMMIT_SHA when it is one, "dev" otherwise. See next.config.mjs. */
export declare function buildCommitOf(env?: Record<string, string | undefined>): string;

declare const nextConfig: Record<string, unknown> & { turbopack?: { resolveAlias: Record<string, string> }; env: { SIP_BUILD_COMMIT: string } };

export default nextConfig;
