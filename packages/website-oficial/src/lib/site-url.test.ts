// The site's own address (owner, 10-22): the custom domain when one is set, then
// Vercel's production domain, then next dev's localhost — and a variable that
// is not an https origin is never trusted, because every canonical link, the
// sitemap and the structured data are written against it.

import { afterEach, describe, expect, it, vi } from "vitest";

import { DEV_SITE_URL, absoluteUrl, httpsOrigin, resolveSiteUrl, siteUrl } from "@/lib/site-url";

const VERCEL = { VERCEL_PROJECT_PRODUCTION_URL: "sip-website-oficial.vercel.app" };

describe("the site's address", () => {
  afterEach(() => vi.restoreAllMocks());

  it("is next dev's localhost when nothing is configured: the tests and a local build", () => {
    expect(resolveSiteUrl({})).toEqual({ url: new URL(DEV_SITE_URL), source: "localhost", problems: [] });
    expect(DEV_SITE_URL).toBe("http://localhost:3002");
  });

  it("is Vercel's production domain, which Vercel sets without a scheme, on every Vercel build", () => {
    const { url, source } = resolveSiteUrl(VERCEL);
    expect(url.href).toBe("https://sip-website-oficial.vercel.app/");
    expect(source).toBe("VERCEL_PROJECT_PRODUCTION_URL");
  });

  it("is SIP_SITE_URL above everything else, once the owner sets a custom domain", () => {
    for (const value of ["https://saverfi.example", "https://saverfi.example/", "saverfi.example", "  https://saverfi.example  ", "https://www.saverfi.example"]) {
      const { url, source, problems } = resolveSiteUrl({ ...VERCEL, SIP_SITE_URL: value });
      expect(url.origin, value).toBe(value.includes("www.") ? "https://www.saverfi.example" : "https://saverfi.example");
      expect(url.href.endsWith("/"), value).toBe(true);
      expect(source).toBe("SIP_SITE_URL");
      expect(problems).toEqual([]);
    }
  });

  it("ignores a SIP_SITE_URL that is not an https origin, says so by name, and never repeats the value", () => {
    for (const value of [
      "http://saverfi.example",
      "https://saverfi.example/docs",
      "https://saverfi.example/?ref=x",
      "https://saverfi.example/#top",
      "https://user:secret@saverfi.example",
      "https://saverfi",
      "ftp://saverfi.example",
      "not a url",
    ]) {
      const { url, source, problems } = resolveSiteUrl({ ...VERCEL, SIP_SITE_URL: value });
      expect(url.href, value).toBe("https://sip-website-oficial.vercel.app/");
      expect(source).toBe("VERCEL_PROJECT_PRODUCTION_URL");
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain("SIP_SITE_URL");
      expect(problems[0]).not.toContain(value);
    }
  });

  it("treats a blank variable as unset, with nothing to say", () => {
    expect(resolveSiteUrl({ SIP_SITE_URL: "  ", VERCEL_PROJECT_PRODUCTION_URL: "" })).toEqual({ url: new URL(DEV_SITE_URL), source: "localhost", problems: [] });
  });

  it("falls back to localhost, saying why, when Vercel's variable is not a host", () => {
    const { url, problems } = resolveSiteUrl({ VERCEL_PROJECT_PRODUCTION_URL: "http://x.example/path" });
    expect(url.href).toBe("http://localhost:3002/");
    expect(problems).toEqual(["VERCEL_PROJECT_PRODUCTION_URL is set but is not a host name, so it is ignored."]);
  });

  it("reads an origin and nothing else", () => {
    expect(httpsOrigin(undefined)).toBeNull();
    expect(httpsOrigin("")).toBeNull();
    expect(httpsOrigin("saverfi.example:8443")?.href).toBe("https://saverfi.example:8443/");
    expect(httpsOrigin("HTTPS://SaverFi.Example")?.href).toBe("https://saverfi.example/");
  });

  it("says an ignored variable once per process, in the build or server log", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const env = { ...VERCEL, SIP_SITE_URL: "http://saverfi.example" };
    expect(siteUrl(env).href).toBe("https://sip-website-oficial.vercel.app/");
    expect(siteUrl(env).href).toBe("https://sip-website-oficial.vercel.app/");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(/^\[site-url\] SIP_SITE_URL .* Using https:\/\/sip-website-oficial\.vercel\.app\.$/);
  });

  it("makes a path absolute on it", () => {
    const site = new URL("https://saverfi.example");
    expect(absoluteUrl("/", site)).toBe("https://saverfi.example/");
    expect(absoluteUrl("/docs/fees", site)).toBe("https://saverfi.example/docs/fees");
    expect(absoluteUrl("/sitemap.xml", site)).toBe("https://saverfi.example/sitemap.xml");
  });
});
