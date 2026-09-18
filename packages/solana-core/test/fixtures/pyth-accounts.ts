// The two Pyth price accounts SaverFi reads, as mainnet returned them.
//
// Captured with one getMultipleAccounts (encoding base64, commitment confirmed)
// against https://api.mainnet-beta.solana.com at the slot below. Everything here
// is what the RPC answered, copied: the base64, the owner, the space and the
// executable flag. clmm-price.test.ts pins a mainnet slot the same way.
//
// A FIXTURE AGES, SO NOTHING HERE IS FRESH. Both accounts carry the publish
// times they had when they were captured, which are already old and get older.
// pyth-price.test.ts asserts STRUCTURE and DERIVED VALUE over them and passes
// its own clock to every age; a test that asserted these were recent would start
// failing the next day, which is why the decoder takes a clock at all.

import { tryBase64Decode } from "../../src/client/base64";

/** The context slot getMultipleAccounts answered at. */
export const PYTH_FIXTURE_SLOT = 447_956_907;

/** Both accounts' owner as observed — the RECEIVER program, never the push program the addresses derive under. */
export const PYTH_FIXTURE_OWNER = "rec2HHDDnjLfj4kE7VyEtFA1HPGQLK33259532cRyHp";

/** Both accounts' `space`, and their `executable`. Anchor allocates the larger VerificationLevel variant, so Full leaves one trailing byte. */
export const PYTH_FIXTURE_SPACE = 134;
export const PYTH_FIXTURE_EXECUTABLE = false;

/** 7AviUf9nL62mcxNbQGKm4nKDQnPjswo6c5MX4D57HmyE — SOL/USD, shard 0. */
export const PYTH_SOL_USD_ACCOUNT_BASE64 =
  "IvEjY51+9M1bsRWwDdII6qyfKmvtWLaGyH3c9S5trfFYcCJDMhaezQHvDYtv2izrpB2hXUCV0do5Kg0vjtDGx7wPTPrIwoC1bT3RgGMCAAAANSAVAAAAAAD4////OqWsagAAAAA5paxqAAAAAKiftGACAAAABVkZAAAAAACdR7MaAAAAAAA=";

/** 6HAuqASbHEh4w4REJEUUUCginTLfj1kwCh215ZLtMkrT — USDC/USD, shard 0. */
export const PYTH_USDC_USD_ACCOUNT_BASE64 =
  "IvEjY51+9M1Obu8PnqBjv5eIEq7D76ieT8TUJqeUwLMkUfRhMcnEcAHqoCDGHMR5cSgTRhzhU4lKlqbACyHtDPwnmNH5qenJSmCu9QUAAAAAmFcBAAAAAAD4////OqWsagAAAAA5paxqAAAAAGCw9QUAAAAA0kQBAAAAAACdR7MaAAAAAAA=";

function fixtureBytes(base64: string, what: string): Uint8Array {
  const bytes = tryBase64Decode(base64);
  if (bytes === null || bytes.length !== PYTH_FIXTURE_SPACE) throw new Error(`the ${what} fixture is not ${PYTH_FIXTURE_SPACE} bytes of base64`);
  return bytes;
}

export const PYTH_SOL_USD_ACCOUNT: Uint8Array = fixtureBytes(PYTH_SOL_USD_ACCOUNT_BASE64, "SOL/USD");
export const PYTH_USDC_USD_ACCOUNT: Uint8Array = fixtureBytes(PYTH_USDC_USD_ACCOUNT_BASE64, "USDC/USD");

/**
 * What the two accounts held at PYTH_FIXTURE_SLOT, decoded by hand once so the
 * test compares the decoder against numbers it did not produce:
 *  * SOL/USD: price 10_259_321_149 at expo -8, so $102.59321149; conf 1_384_501
 *    (0.0135 % of price); publish_time 1_789_699_386; posted_slot 447_956_893.
 *  * USDC/USD: price 99_987_040 at expo -8, so $0.99987040; conf 87_960
 *    (0.0880 %); the same publish_time and posted_slot.
 * Both were VerificationLevel::Full, so their feed ids begin at byte 41.
 */
export const PYTH_FIXTURE_PUBLISH_TIME = 1_789_699_386n;
export const PYTH_FIXTURE_POSTED_SLOT = 447_956_893n;
