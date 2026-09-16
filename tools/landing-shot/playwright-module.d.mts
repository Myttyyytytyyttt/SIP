/**
 * Types for playwright-module.mjs, so the web package's
 * scripts/landing-shot-playwright.test.ts can import it under `noImplicitAny`.
 * The module itself stays plain JavaScript, because these tools are run by node
 * directly and are deliberately outside the workspace.
 */

/** Only what this tool uses: enough to tell Playwright from something that is not it. */
export interface PlaywrightModule {
  readonly chromium: { launch(options?: Record<string, unknown>): Promise<unknown> };
}

/** The folders to resolve "playwright" from, or null for Node's own resolution. */
export declare function playwrightSearchPaths(env?: Record<string, string | undefined>): string[] | null;

/** The Playwright module, or an error carrying the install recipe. See playwright-module.mjs. */
export declare function loadPlaywright(env?: Record<string, string | undefined>): PlaywrightModule;
