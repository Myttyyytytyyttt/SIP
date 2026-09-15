// Railway builds the Dockerfile at the repository root when a service names no
// other, and a Railpack build of the root is the web. The root copy exists so the
// keeper service can never quietly turn into the web again; this keeps the copy
// identical to the keeper's own Dockerfile. vitest runs from packages/solana-keeper.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("the repository root Dockerfile", () => {
  it("is byte-identical to the keeper's, so Railway's own detection builds the keeper", () => {
    const keeper = readFileSync(join(process.cwd(), "Dockerfile"), "utf8");
    const root = readFileSync(join(process.cwd(), "..", "..", "Dockerfile"), "utf8");
    expect(root).toBe(keeper);
  });
});
