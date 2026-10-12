// That each cut is wired in bin/keeper.mts ONLY behind its token, and L3 only
// behind its limit — the rules live in src/ and their own tests; this file pins
// the switch.
//
// WHY THE SOURCE IS READ, as in test/sweep-cost-wiring.test.ts: the sweep is a
// closure inside a top-level script that connects to a chain, a database and
// Privy before it defines one. And the regression that matters here is
// structural — a cut that runs without its token, or a fallback that stops
// being one — which reads back from the text.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const keeper = readFileSync(fileURLToPath(new URL("../bin/keeper.mts", import.meta.url)), "utf8");

/** The sweep's body, from its declaration to the next top-level function. */
const sweepBody = ((): string => {
  const start = keeper.indexOf("async function sweep(): Promise<void> {");
  expect(start).toBeGreaterThan(-1);
  return keeper.slice(start, keeper.indexOf("\n}\n", start));
})();

describe("gpa-v2", () => {
  it("lists through V2 only when the token is set, over the Connection's own transport", () => {
    expect(sweepBody).toMatch(
      /config\.cuts\.has\("gpa-v2"\)\n\s+\? discoverLinksPreferringV2\(connection, programId, TRADING_LINK_DISC, trackedFetch\)\n\s+: discoverLinks\(connection, programId, TRADING_LINK_DISC\)/,
    );
    // ONE CALL SITE for each: nothing lists around the switch.
    expect(keeper.match(/discoverLinksPreferringV2\(/g)).toHaveLength(1);
    expect(keeper.match(/discoverLinks\(connection/g)).toHaveLength(1);
  });

  it("says which call listed the links, once per change, only when the cut is on", () => {
    expect(sweepBody).toMatch(/if \(config\.cuts\.has\("gpa-v2"\)\) \{\n\s+changes\.change\(\n\s+"discovery-method",/);
  });
});

describe("L3, the last-known-good list", () => {
  it("is built from SIP_SOLANA_DISCOVERY_LKG_MS and re-reads every remembered link fresh", () => {
    expect(keeper).toContain("const linkDiscovery = new LastKnownGoodDiscovery(config.discoveryLkgMs);");
    expect(sweepBody).toContain("(addresses) => rereadLinks(connection, addresses, programId, TRADING_LINK_DISC),");
  });

  it("warns, then pages, on a remembered sweep — and clears on the next listing", () => {
    const lkg = sweepBody.indexOf('if (found.source === "lkg") {');
    const fresh = sweepBody.indexOf("alerter.clear(DISCOVERY_STALE_ALERT_KEY);");
    expect(lkg).toBeGreaterThan(-1);
    expect(sweepBody.slice(lkg, fresh)).toContain("alerter.fire(discoveryStaleAlert(found.consecutiveFailures, found.lkgAgeMs ?? 0, detail));");
    expect(fresh).toBeGreaterThan(lkg);
  });
});

describe("privy-address", () => {
  it("exists only with the token AND a Privy signer to resolve", () => {
    expect(keeper).toMatch(/const privyBook: PrivyAddressBook \| null =\n\s+privyConfig !== null && config\.cuts\.has\("privy-address"\)/);
  });

  it("replaces the per-sweep listing — never runs beside it — and is asked only about wallets a turn resolves", () => {
    const site = sweepBody.slice(sweepBody.indexOf("if (privyBook !== null) {"), sweepBody.indexOf("// THE CRANK PAYS FOR EVERY MOVE"));
    const [book, today] = site.split("} else {");
    expect(book).toContain("await privyBook.prepare(resolving, Date.now());");
    expect(book).not.toContain("buildPrivySolanaIndex");
    expect(today).toContain("privyIndex = await buildPrivySolanaIndex(privyConfig);");
    // THE TURN LOOP'S OWN CONDITION, so the book asks about nobody the sweep would not have.
    expect(book).toContain("vaults === null || resolvesSignerFor(profile, vaults.get(link.vault)?.skimMode)");
    expect(sweepBody).toContain("const settlesThisVault = vaults === null || resolvesSignerFor(profile, vaults.get(vaultAddr)?.skimMode);");
  });

  it("fails a wallet it could not ask as today's failed lookup does, and asks about the seat again before every send", () => {
    expect(sweepBody).toMatch(/if \(privyConfig !== null && lookupFailed !== undefined\) \{[\s\S]{0,200}if \(walletSigner === null\) route = "none \(privy lookup failed\)";/);
    // WITHOUT THE CUT, THE SIGNER AS IT ALWAYS WAS: no confirmSeat, so settle-tick sends with no read before it.
    expect(sweepBody).toContain("walletSigner = privyBook === null ? resolution.signer : confirmedSubmitter(resolution.signer, privyBook);");
    expect(sweepBody).toContain("privyBook?.prune(discoveredWallets);");
  });
});

describe("/status", () => {
  it("serves the discovery block and the cuts block on every render", () => {
    expect(keeper).toContain("doorbell: doorbellStatus(), ...cutsStatusBlocks() }");
    expect(keeper).toMatch(/discovery: linkDiscovery\.status\(Date\.now\(\)\),\n\s+cuts: \{ on: \[\.\.\.config\.cuts\], privyAddressBook: privyBook\?\.status\(\) \?\? null, board: boardRefresh\?\.status\(\) \?\? null \},/);
  });
});
