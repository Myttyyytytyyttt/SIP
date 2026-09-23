// Where a Raydium CLMM PoolState keeps its pair and its two vaults.
//
// FOUR NUMBERS, ONE FILE, AND THAT IS THE WHOLE POINT. Counted off the account:
// 8 discriminator, 1 bump, 32 amm_config, 32 owner, then token_mint_0 at 73,
// token_mint_1 at 105, token_vault_0 at 137, token_vault_1 at 169. Mainnet
// serves 1544 bytes; these four addresses are all this file claims to locate.
//
// WHY IT IS ITS OWN MODULE AND NOT A CONSTANT IN THE FILE THAT READS THEM.
// On 2026-09-23 these offsets were written out as literals in seven files
// across three packages: the keeper's venue-depth.ts, solana-core's readers.ts
// (the web's reserve panel), clmm-price.ts (the web's floors, the two mints
// only), bin/check-legs.mts (the two vaults only) and test/chain-fixtures.ts
// (the fixture that WRITES the bytes readers.ts then reads), and this package's
// live-route.ts and rehearse-route.ts (mint0 only) — not counting the tests
// that write them as literals on purpose, as pins, three of which remain
// besides readers.test.ts's own.
// Seven copies of one fact about somebody
// else's account layout: if they ever disagreed, the one that was wrong would
// read 32 bytes of a neighbouring field and hand back a perfectly well-formed
// PublicKey that is not the vault.
//
// WHO READS IT NOW, AND WHO STILL DOES NOT. live-route.ts, readers.ts and
// chain-fixtures.ts import it, readers.test.ts asserts it against typed
// literals, and the keeper's copy went with its retired
// Raydium adapter. Three copies remain, on purpose for now: clmm-price.ts sits
// in solana-core's browser-safe client entry, whose only permitted package
// import is the IDL (test/client-entry.test.ts), and check-legs.mts and
// rehearse-route.ts are operator scripts. Each is a candidate for this import,
// not a second definition to keep in step by hand.
//
// AND THE TEST THAT WAS MEANT TO CATCH A DRIFT PINNED THE WRONG THING. It held
// two of the seven copies, solana-core's readers.ts against the keeper's, by
// READING BOTH SOURCES AS TEXT and pulling the numbers out with a regex: the
// third species in docs/TESTING_TRAPS.md, which prescribes exactly this fix,
// "move the constant to the package both sides already share".
// @sip/solana-program is that package; solana-core and solana-keeper both
// already depend on it.
//
// NOTHING IS IMPORTED HERE, DELIBERATELY: a file of plain numbers drags no
// import graph into whatever reaches it. ONE CAVEAT, because this package is
// CommonJS and this file is TypeScript. Every importer today is a .ts file that
// tsx, Next or vitest compiles, and each sees the named exports. Plain Node
// cannot load this file at all, and how a CommonJS package's names reach an
// ESM importer has differed between loaders here: under tsx 4.23 an
// untransformed `node --input-type=module` eval saw only `default` (measured
// 2026-09-23). That difference is why the keeper takes the rest of this
// package through program-scripts.ts's unwrap.

/** token_mint_0: the first mint of the pair. */
export const CLMM_TOKEN_MINT_0_AT = 73;
/** token_mint_1: the second mint of the pair. */
export const CLMM_TOKEN_MINT_1_AT = 105;
/** token_vault_0: where the pool keeps token_mint_0. */
export const CLMM_TOKEN_VAULT_0_AT = 137;
/** token_vault_1: where the pool keeps token_mint_1. */
export const CLMM_TOKEN_VAULT_1_AT = 169;

/**
 * The fewest bytes an account must have for all four reads above to land inside
 * it: 201.
 *
 * NOT A LENGTH ORACLE, AND CALLERS MUST NOT READ IT AS ONE. Mainnet's PoolState
 * is 1544 bytes, and this is 201 — the end of the last field read, not the end
 * of the account. A different account of a sufficient length decodes into four
 * valid-looking addresses, so length alone never establishes that these bytes
 * are a pool. Every caller checks something that does: the account's owner
 * program, its discriminator, or that the decoded pair is the pair the caller
 * came for.
 */
export const CLMM_POOL_PAIR_BYTES = CLMM_TOKEN_VAULT_1_AT + 32;
