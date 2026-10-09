// WHICH BUILD THIS TAB RUNS, AND WHICH ONE IS SERVED (diagnosis 10-09,
// inventory D5): a tab opened before a deploy kept its old bundle, and nothing
// said so. The rules of src/lib/build-version.ts, and the hook's wiring.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  BUNDLE_COMMIT,
  DEV_COMMIT,
  VERSION_CHECK_FLOOR_MS,
  VERSION_CHECK_MS,
  VERSION_PATH,
  commitOf,
  fetchServedCommit,
  newVersionServed,
  servedCommit,
  versionCheckDue,
} from "@/lib/build-version";

const OLD = "feb0a63";
const NEW = "4ab56ae";

describe("a commit id", () => {
  it("is 7 to 40 hex characters, lowercased; anything else is 'dev'", () => {
    expect(commitOf(" 4AB56AE ")).toBe("4ab56ae");
    expect(commitOf("4533733abcdef0123456789abcdef0123456789a")).toBe("4533733abcdef0123456789abcdef0123456789a");
    for (const raw of [undefined, null, 7, "", "abc123", "main", "4533733abcdef0123456789abcdef0123456789a0", "zzzzzzz"]) expect(commitOf(raw)).toBe(DEV_COMMIT);
  });

  it("is 'dev' for this bundle under test: nothing inlined it", () => {
    expect(BUNDLE_COMMIT).toBe(DEV_COMMIT);
  });

  it("the server names its deployment's commit at request time, or its own build's when the runtime has none", () => {
    expect(servedCommit({ VERCEL_GIT_COMMIT_SHA: NEW })).toBe(NEW);
    expect(servedCommit({})).toBe(BUNDLE_COMMIT);
  });
});

describe("whether an update is available", () => {
  it("is, when the server runs another commit than this tab", () => {
    expect(newVersionServed(OLD, NEW)).toBe(true);
    expect(newVersionServed(OLD, NEW.toUpperCase())).toBe(true);
  });

  it("is not, for the same commit however it is spelled", () => {
    expect(newVersionServed(NEW, NEW)).toBe(false);
    expect(newVersionServed(NEW, ` ${NEW.toUpperCase()} `)).toBe(false);
  });

  it("is never announced by 'dev' on either side, or by a server that could not be asked", () => {
    expect(newVersionServed(DEV_COMMIT, NEW)).toBe(false);
    expect(newVersionServed(OLD, DEV_COMMIT)).toBe(false);
    expect(newVersionServed(OLD, "garbage")).toBe(false);
    expect(newVersionServed(OLD, null)).toBe(false);
  });
});

describe("when a tab asks", () => {
  it("every five minutes while visible, and on being shown or focused at most once a minute", () => {
    expect(VERSION_CHECK_MS).toBe(5 * 60_000);
    expect(VERSION_CHECK_FLOOR_MS).toBe(60_000);
    expect(versionCheckDue({ lastCheckAt: null, now: 0 })).toBe(true);
    expect(versionCheckDue({ lastCheckAt: 1_000, now: 1_000 + VERSION_CHECK_FLOOR_MS - 1 })).toBe(false);
    expect(versionCheckDue({ lastCheckAt: 1_000, now: 1_000 + VERSION_CHECK_FLOOR_MS })).toBe(true);
  });
});

describe("asking the server", () => {
  it("asks /api/version with no cache and no cookies — a pinning cookie would route the question to the old build", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ commit: NEW }));
    expect(await fetchServedCommit(fetchImpl as unknown as typeof fetch)).toBe(NEW);
    expect(fetchImpl).toHaveBeenCalledWith(VERSION_PATH, { cache: "no-store", credentials: "omit" });
    expect(VERSION_PATH).toBe("/api/version");
  });

  it("answers null — never an update — when the server could not be asked or said nothing usable", async () => {
    const failing = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(await fetchServedCommit(failing as unknown as typeof fetch)).toBeNull();
    expect(await fetchServedCommit((async () => new Response("no", { status: 503 })) as unknown as typeof fetch)).toBeNull();
    expect(await fetchServedCommit((async () => new Response("not json")) as unknown as typeof fetch)).toBeNull();
    expect(await fetchServedCommit((async () => Response.json({ commit: 7 })) as unknown as typeof fetch)).toBeNull();
  });
});

describe("the hook (useNewVersion), read from its source — no DOM here", () => {
  const code = readFileSync(fileURLToPath(new URL("../hooks/use-new-version.ts", import.meta.url)), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join("\n");

  it("never asks from a 'dev' bundle, and stops once an update is known", () => {
    expect(code).toMatch(/if \(BUNDLE_COMMIT === DEV_COMMIT \|\| updateAvailable \|\| typeof document === "undefined"\) return undefined;/);
  });

  it("asks only while visible, under the floor, on being shown, on focus and every VERSION_CHECK_MS", () => {
    expect(code).toMatch(/if \(document\.visibilityState !== "visible"\) return;/);
    expect(code).toMatch(/if \(!versionCheckDue\(\{ lastCheckAt: lastCheckAt\.current, now \}\)\) return;/);
    expect(code).toMatch(/document\.addEventListener\("visibilitychange", check\);/);
    expect(code).toMatch(/window\.addEventListener\("focus", check\);/);
    expect(code).toMatch(/window\.setInterval\(check, VERSION_CHECK_MS\);/);
    expect(code).toMatch(/if \(alive && newVersionServed\(BUNDLE_COMMIT, served\)\) setUpdateAvailable\(true\);/);
  });
});
