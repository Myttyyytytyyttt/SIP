/**
 * THE SITE'S OWN ADDRESS: what every canonical link, the sitemap, robots.txt,
 * llms.txt, the social cards and the structured data are written against
 * (owner, 10-22: "quita el noindex para que salga en Google").
 *
 * FROM CONFIGURATION, NEVER HARD-CODED, because the address will change: today
 * the only production host is the Vercel project's own *.vercel.app, and the
 * owner may attach a custom domain later. In order:
 *
 *   1. SIP_SITE_URL — the custom domain, once there is one. An https origin
 *      ("https://example.com"; a bare "example.com" is read as https). Anything
 *      else — http, a path, a query, credentials — is ignored with one warning,
 *      never trusted: a canonical link pointing at the wrong place quietly moves
 *      the site out of the index.
 *   2. VERCEL_PROJECT_PRODUCTION_URL — set by Vercel on every build and at
 *      runtime, previews included, to the project's shortest production domain,
 *      without a scheme. So a preview's canonical links point at production,
 *      which is right. With an apex AND a www custom domain Vercel picks the
 *      apex even when it is the one that redirects — which is why (1) exists.
 *   3. http://localhost:3002 — `next dev`'s port (package.json), for local runs
 *      and the tests.
 *
 * READ WHEN A PAGE IS BUILT. The static outputs — the docs, the sitemap,
 * robots.txt, llms.txt and the social cards — are rendered at build time, so a
 * new value reaches them only with a new deployment. On Vercel any change to a
 * variable needs one anyway.
 */

/** The custom domain's variable (.env.example). */
export const SITE_URL_ENV = "SIP_SITE_URL";

/** Where `next dev` serves this package (package.json's dev script). */
export const DEV_SITE_URL = "http://localhost:3002";

export type SiteUrlSource = typeof SITE_URL_ENV | "VERCEL_PROJECT_PRODUCTION_URL" | "localhost";

export type SiteUrl = {
  /** An origin only: scheme, host and port, and `href` ends in "/". */
  readonly url: URL;
  readonly source: SiteUrlSource;
  /** Why a variable that was set was not used. Names the variable, never repeats its value. */
  readonly problems: readonly string[];
};

type Env = Readonly<Record<string, string | undefined>>;

/**
 * An https origin, or null. A value with no scheme is read as https, because
 * that is how a domain is usually pasted and how Vercel writes its own.
 */
export function httpsOrigin(raw: string | undefined): URL | null {
  const value = raw?.trim() ?? "";
  if (value === "") return null;
  let url: URL;
  try {
    url = new URL(value.includes("://") ? value : `https://${value}`);
  } catch {
    return null;
  }
  const originOnly = url.pathname === "/" && url.search === "" && url.hash === "" && url.username === "" && url.password === "";
  // A host with no dot ("https://saverfi") parses, but no public site lives there: it is a typo.
  if (url.protocol !== "https:" || !originOnly || !url.hostname.includes(".")) return null;
  return new URL(url.origin);
}

/** Every rule above, as a pure function of the environment, so each step can be tested. */
export function resolveSiteUrl(env: Env = process.env): SiteUrl {
  const problems: string[] = [];

  const explicit = env[SITE_URL_ENV];
  if (explicit !== undefined && explicit.trim() !== "") {
    const url = httpsOrigin(explicit);
    if (url !== null) return { url, source: SITE_URL_ENV, problems };
    problems.push(`${SITE_URL_ENV} is set but is not an https origin such as https://example.com, so it is ignored.`);
  }

  const vercel = env["VERCEL_PROJECT_PRODUCTION_URL"];
  if (vercel !== undefined && vercel.trim() !== "") {
    const url = httpsOrigin(vercel);
    if (url !== null) return { url, source: "VERCEL_PROJECT_PRODUCTION_URL", problems };
    problems.push("VERCEL_PROJECT_PRODUCTION_URL is set but is not a host name, so it is ignored.");
  }

  return { url: new URL(DEV_SITE_URL), source: "localhost", problems };
}

let warned = false;

/**
 * The site's origin, for this process's environment. A variable that had to be
 * ignored is said once per process, in the build log or the server's, by name.
 */
export function siteUrl(env: Env = process.env): URL {
  const resolved = resolveSiteUrl(env);
  if (resolved.problems.length > 0 && !warned) {
    warned = true;
    for (const problem of resolved.problems) console.warn(`[site-url] ${problem} Using ${resolved.url.origin}.`);
  }
  return resolved.url;
}

/** A path on this site as an absolute URL: what the sitemap, llms.txt and the structured data need. */
export function absoluteUrl(path: string, site: URL = siteUrl()): string {
  return new URL(path, site).href;
}
