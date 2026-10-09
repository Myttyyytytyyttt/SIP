// THE DASHBOARD'S VAULT SCREEN FOLLOWS ITS LIVE STORE (diagnosis 10-09,
// inventory D2): after a settle, a conversion or a buy, the Manage wallets
// modal opened on the vault as it was when the page mounted. What counts as a
// move and the floors are src/lib/vault-follow.ts's, tested there; this pins
// that the hook asks on a MOVE and on the modal's OPENING, and that the shell
// uses it. No DOM here, so the wiring is read from the source.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const code = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join("\n");

const hook = code(readFileSync(fileURLToPath(new URL("./use-vault-follow.ts", import.meta.url)), "utf8"));
const shell = code(readFileSync(fileURLToPath(new URL("../components/dashboard-shell.tsx", import.meta.url)), "utf8"));

describe("the vault screen follows the live store", () => {
  it("reads again when two committed live reads show the vault moved, under the follow floor", () => {
    expect(hook).toMatch(/const before = heldStamp\.current;\s*heldStamp\.current = input\.stamp;\s*if \(vaultMoved\(before, input\.stamp\)\) catchUp\?\.\(VAULT_FOLLOW_FLOOR_MS\);/);
    // Seeded with the stamp it mounts with: the screen's own mount read already covers it.
    expect(hook).toMatch(/const heldStamp = useRef<VaultStamp \| null>\(input\.stamp\);/);
  });

  it("reads again when the Manage wallets modal OPENS — the edge, not the state — under the manual floor", () => {
    expect(hook).toMatch(/const opened = input\.modalOpen && !wasOpen\.current;\s*wasOpen\.current = input\.modalOpen;\s*if \(opened\) catchUp\?\.\(VAULT_OPEN_FLOOR_MS\);/);
  });

  it("is what the dashboard shell does with its live store and its vault screen", () => {
    expect(shell).toMatch(/useVaultFollowsLive\(\{ screen: vaultScreen, stamp: live\.vaultStamp, modalOpen: walletsOpen \}\);/);
  });
});
