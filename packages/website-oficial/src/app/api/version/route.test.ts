// GET /api/version answers the commit this deployment runs — and only that —
// uncached, so a tab on an older bundle can tell (diagnosis 10-09, D5).

import { afterEach, describe, expect, it, vi } from "vitest";

import { GET, dynamic } from "./route";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /api/version", () => {
  it("answers the deployment's commit, lowercased, never cached", async () => {
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "4533733ABCDEF0123456789abcdef0123456789a");
    const response = GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ commit: "4533733abcdef0123456789abcdef0123456789a" });
    expect(dynamic).toBe("force-dynamic");
  });

  it("says 'dev' where no commit is known — a local server, the Docker rehearsal — and nothing else", async () => {
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "");
    expect(await GET().json()).toEqual({ commit: "dev" });
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "not a commit; rm -rf /");
    expect(await GET().json()).toEqual({ commit: "dev" });
  });
});
