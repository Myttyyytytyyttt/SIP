// The one @coral-xyz/anchor export Node's ESM loader does not hand over.
//
// WHAT BROKE. @coral-xyz/anchor is a CommonJS package (no `exports` field, main
// ./dist/cjs/index.js). When an ES module imports a CommonJS one, Node builds
// the named exports with cjs-module-lexer, a static scanner: it finds the 31
// names anchor assigns directly (Program, AnchorProvider, Wallet, utils, web3,
// the coders…) and MISSES `BN`, which anchor re-exports from bn.js. So under
// Node — which is how the keeper runs, `tsx bin/keeper.mts`, this package being
// "type": "module" — `anchor.BN` is undefined and `new anchor.BN(x)` throws
// "TypeError: anchor.BN is not a constructor". Measured 2026-09-18, anchor
// 0.32.1 / Node 22.14.0: the namespace has 32 keys, the default export 31, and
// the ONLY name on `default` that the namespace lacks is BN.
//
// That threw on the settle path the first time a linked wallet had a settleable
// span — mainnet, wallet 9QX53J3K…, settle THREW / invest THREW — and it would
// have thrown again on all five of the invest path's BN sites.
//
// WHY THE TESTS SAW NOTHING. Vitest transforms the same import with its own
// interop, which merges the default export's properties onto the namespace:
// under vitest `typeof anchor.BN === "function"` AND `anchor.BN ===
// anchor.default.BN`, so both spellings work and neither can fail. The keeper's
// settle path is densely covered — and every one of those tests passed while
// production threw, because they ran in a module system production never uses.
//
// WHY NOT `anchor.default.BN`. Because it is not portable and would plant the
// same bug in the other direction. The deciding factor is the CONTAINING
// package's module system, not the runner: the same tsx binary, given the same
// probe, reports `BN undefined / default.BN function` inside this package
// ("type": "module") and `BN function / default undefined` inside
// packages/solana-program (no "type", therefore CommonJS). `unwrap()` is right
// in both, which is why it is the shape program-scripts.ts already uses for
// @sip/solana-program — the same asymmetry, solved there on 2026-09-13 and
// never extended to anchor's own namespace. This file is that extension.
//
// WHY NOT `import BN from "bn.js"`. Two reasons, both measured. bn.js is not a
// declared dependency of this package and does not resolve from it
// (`require.resolve("bn.js")` → MODULE_NOT_FOUND), so an import of it would be
// a boot-time failure in the image — one broken wallet traded for a keeper that
// will not start. And class identity would break anyway: a BN from any other
// copy is not `instanceof` anchor's, while `unwrap(anchor).BN` IS the class
// anchor's own coder produces and accepts (anchor.BN === anchor's internal
// require("bn.js") is true; the preflight proves the round-trip in bytes).

import * as anchorModule from "@coral-xyz/anchor";

/** `.default` when the loader gave us a CommonJS namespace, the namespace itself when it did not. */
function unwrap<T extends object>(namespace: T): T {
  const inner = (namespace as { readonly default?: unknown }).default;
  return (inner !== null && typeof inner === "object" ? inner : namespace) as T;
}

const anchor = unwrap(anchorModule);

/**
 * Anchor's own BN, resolved so that it is a constructor under Node ESM as well
 * as under vitest and CommonJS. EVERY runtime BN in this keeper comes from here
 * — a `new anchor.BN(...)` anywhere else is the bug coming back.
 */
export const BN = anchor.BN;
export type BN = InstanceType<typeof anchor.BN>;

// LOUD AT IMPORT, not at the first settle. This is the same discipline as
// program-scripts.ts:50-60, and for the same reason: `tsx bin/keeper.mts
// --preflight` runs at image BUILD time (Dockerfile), so a graph that no longer
// loads the way this file assumes fails the build instead of the first real
// settle. A lazy `new anchor.BN(...)` inside a function body is invisible to
// that gate, which is exactly how today's outage reached production.
//
// The namespace entries are checked on the NAMESPACE deliberately: config.ts
// reads `anchor.utils`, and bin/keeper.mts and bin/ready.mts read
// `anchor.Program`, `anchor.AnchorProvider` and `anchor.Wallet` straight off
// their own `import * as anchor`. Those four are the keeper's only other
// runtime reads of anchor, they all resolve today, and this line is what says
// so the day anchor changes which names the lexer can see.
for (const [name, value] of Object.entries({
  "BN (unwrapped)": BN,
  "Program (namespace)": anchorModule.Program,
  "AnchorProvider (namespace)": anchorModule.AnchorProvider,
  "Wallet (namespace)": anchorModule.Wallet,
  "utils (namespace)": anchorModule.utils,
})) {
  if (value === undefined || value === null) {
    throw new Error(
      `@coral-xyz/anchor did not provide ${name}: the CommonJS/ESM unwrap in anchor-interop.ts no longer matches how anchor loads`,
    );
  }
}
if (typeof BN !== "function" || new BN("1").toString() !== "1") {
  throw new Error("@coral-xyz/anchor's BN is not a working constructor: the unwrap in anchor-interop.ts no longer matches how anchor loads");
}
