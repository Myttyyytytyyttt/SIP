/**
 * WHICH BUILD THIS TAB RUNS, AND WHICH ONE IS SERVED NOW (diagnosis 10-09,
 * inventory D5).
 *
 * A tab opened before a deploy keeps running the bundle it loaded, for as long
 * as it stays open. A tab opened before the push's deploy (4ab56ae, 01:45Z on
 * 10-09) ran feb0a63, which has no push at all, and nothing on the page could
 * say that what it showed was not what had shipped. So the page
 * can now ask: GET /api/version answers the commit the server runs, and this
 * bundle carries the commit it was built from; when they differ, an update is
 * available (src/hooks/use-new-version.ts). What the page does with that is
 * the page's.
 *
 * THE BUNDLE'S COMMIT IS BAKED IN AT BUILD TIME, ON PURPOSE. Everything else
 * this app knows of its deployment is read at request time (lib/config.ts:
 * nothing is NEXT_PUBLIC_), because a value inlined into the bundle is frozen
 * there. That freezing is exactly what this one needs: it is the bundle's own
 * identity. next.config.mjs puts VERCEL_GIT_COMMIT_SHA — a public git commit
 * id, no secret — into SIP_BUILD_COMMIT, and Next inlines it.
 *
 * Off the Vercel build (a local `next dev`, the Docker rehearsal) both sides
 * say "dev", and "dev" never announces an update.
 */

/** What a build or a server with no commit says. Never compared: it announces nothing. */
export const DEV_COMMIT = "dev";

/** A git commit id: 7 to 40 hex characters. Anything else is DEV_COMMIT. */
const COMMIT = /^[0-9a-f]{7,40}$/i;

/** A commit id as both sides spell it (lowercase), or DEV_COMMIT for anything that is not one. */
export function commitOf(raw: unknown): string {
  if (typeof raw !== "string") return DEV_COMMIT;
  const text = raw.trim();
  return COMMIT.test(text) ? text.toLowerCase() : DEV_COMMIT;
}

/** The commit this bundle was built from (next.config.mjs `env`); DEV_COMMIT off a Vercel build, and in tests. */
export const BUNDLE_COMMIT: string = commitOf(process.env.SIP_BUILD_COMMIT);

/**
 * THE COMMIT THE SERVER RUNS, for GET /api/version: the deployment's own
 * VERCEL_GIT_COMMIT_SHA at request time, or — where the runtime does not
 * expose it — the commit this server's build inlined, which on Vercel is the
 * same deployment's.
 */
export function servedCommit(env: Readonly<Record<string, string | undefined>>): string {
  const runtime = commitOf(env.VERCEL_GIT_COMMIT_SHA);
  return runtime !== DEV_COMMIT ? runtime : BUNDLE_COMMIT;
}

/** Whether the server runs a different build than this tab: both sides must name a real commit. */
export function newVersionServed(running: string, served: string | null): boolean {
  if (served === null) return false;
  const ours = commitOf(running);
  const theirs = commitOf(served);
  return ours !== DEV_COMMIT && theirs !== DEV_COMMIT && ours !== theirs;
}

/** How often a visible tab asks while it stays visible. */
export const VERSION_CHECK_MS = 5 * 60_000;

/** The least time between two checks, however often the tab is shown or focused. */
export const VERSION_CHECK_FLOOR_MS = 60_000;

/** Whether a check is due: the last one was VERSION_CHECK_FLOOR_MS ago or more. */
export function versionCheckDue(input: { readonly lastCheckAt: number | null; readonly now: number }): boolean {
  return input.lastCheckAt === null || input.now - input.lastCheckAt >= VERSION_CHECK_FLOOR_MS;
}

/** The path the check asks. */
export const VERSION_PATH = "/api/version";

/**
 * The commit the server says it runs, or null when it could not be asked.
 *
 * NO STORE AND NO COOKIES. A cached answer would be the old build's; and
 * should a deployment-pinning cookie be set (Vercel's skew protection can pin
 * a tab's requests to the deployment it loaded), it would route the question
 * to the very build it is meant to compare against. The route needs neither.
 */
export async function fetchServedCommit(fetchImpl: typeof fetch = fetch): Promise<string | null> {
  try {
    const response = await fetchImpl(VERSION_PATH, { cache: "no-store", credentials: "omit" });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    const commit = body !== null && typeof body === "object" ? (body as { commit?: unknown }).commit : undefined;
    return typeof commit === "string" ? commit : null;
  } catch {
    return null;
  }
}
