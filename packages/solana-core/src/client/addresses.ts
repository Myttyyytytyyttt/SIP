// Well-known Solana addresses, as strings so the browser entry can use them.
//
// Program ids here are canonical mainnet constants, not configuration. The SIP
// program id is NOT here: it comes from the IDL (idl.ts SIP_PROGRAM_ID).

export const SYSTEM_PROGRAM = "11111111111111111111111111111111";
export const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";
export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
export const INSTRUCTIONS_SYSVAR = "Sysvar1nstructions1111111111111111111111111";
/** The native Ed25519 signature-verification precompile. link_wallet reads the wallet's consent back from it. */
export const ED25519_PROGRAM = "Ed25519SigVerify111111111111111111111111111";
/**
 * Lighthouse, the assertion program Phantom adds checks for when it signs on
 * mainnet. Immutable: its ProgramData has no upgrade authority. What SaverFi
 * relays of it is client/lighthouse.ts.
 */
export const LIGHTHOUSE_PROGRAM = "L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95";

/**
 * Raydium CLMM. IT IS NO LONGER A VENUE A POLICY MAY NAME — it is a PRICE
 * SOURCE. The build route reads a leg's min_out_rate_wad and the convert floor
 * from Raydium CLMM pools (server/readers.ts PRICED_POOLS), and that is all
 * this constant is for now. The keeper stopped routing through it when the
 * basket moved to Jupiter and refuses it outright
 * (solana-keeper/src/invest-decision.ts RETIRED_VENUES), so a policy naming it
 * as venue_program buys nothing, at any balance, for the life of the policy.
 */
export const RAYDIUM_CLMM = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";

/**
 * Jupiter v6: THE VENUE PROGRAM A POLICY SIGNED ON THIS BRANCH MUST NAME.
 *
 * It is the only key in the keeper's ROUTABLE_VENUES
 * (solana-keeper/src/invest-decision.ts), and the keeper's venue check is
 * all-or-nothing: a policy whose venue_program is anything else is refused
 * before the wrap, on every sweep, forever. The web must therefore be able to
 * BUILD this byte — build-handler.ts VENUE_PROGRAMS translates the name, and
 * website-oficial's VERIFIABLE_VENUES checks the built bytes against it.
 *
 * The same base58 lives in the keeper (JUPITER_V6_PROGRAM) and is asserted
 * against this one by test, because the browser may not import the keeper.
 */
export const JUPITER_V6 = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";

export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const WSOL_MINT = "So11111111111111111111111111111111111111112";

/**
 * SP500 xStock: Token-2022, 8 decimals. Read 2026-09-21 it carries NO
 * TransferFeeConfig extension, and a Token-2022 mint's extensions are fixed at
 * initialisation — so no authority anywhere can ever give it a transfer fee.
 * Its issuer does still hold freeze (JDq14BWv…), a permanent delegate
 * (5aMNNLQJ…), a Pausable and a default-account-state extension, under keys
 * separate from each other.
 */
export const SPYX_MINT = "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W";

/** Raydium CLMM wSOL/USDC (mint0 wSOL, mint1 USDC): the pool the keeper converts through, and the convert floor's price. */
export const SOL_USDC_POOL = "3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv";

/** Raydium CLMM SPYx/USDC (mint0 SPYx, mint1 USDC): the same pool as the keeper's SIP_SOLANA_POOLS, and the SPYx floor's price. */
export const SPYX_USDC_POOL = "6truu3rZuiB9rKQg4VYC3Dt3QwV7DgwGqXrYUcrvnDDE";

/** The two token programs a vault's holdings can live under. */
export const TOKEN_PROGRAMS = [TOKEN_PROGRAM, TOKEN_2022_PROGRAM] as const;

/**
 * THE KEY EVERY PRESTOCKS MINT BELOW ANSWERS TO.
 *
 * Read on mainnet 2026-09-21 (epoch 1039, slot 448993661): this one key is the
 * mint authority, the freeze authority, the permanent delegate AND the
 * transfer-fee config authority of ALL EIGHT PreStocks mints named in this
 * file, each of which also carries a Pausable extension and a transfer-hook
 * extension. It can mint, freeze, pause, move a holder's tokens without the
 * holder, and rewrite the transfer fee at any epoch boundary.
 *
 * IT IS ALSO WHAT IDENTIFIES THESE MINTS. A token search by symbol answers with
 * impostors — ANTHROPIC alone returns ten, several of them pump.fun mints — so
 * a PreStocks mint is recognised by this authority, never by its ticker.
 */
export const PRESTOCKS_ISSUER = "WV9PJN7XTmTLVwbutCLFxp8TyePee6Xq5mRq6Fti5Wc";

/**
 * PreStocks ANTHROPIC: Token-2022, 9 decimals, with a transfer fee whose
 * maximum is u64::MAX, so the fee is uncapped however large the trade. Read
 * 2026-09-21 (epoch 1039) that fee was 100 BPS — it was 50 until the issuer's
 * scheduled record took effect at that epoch. Read 2026-09-24 (epoch 1041) it
 * still charged 100 and 300 BPS was already written for epoch 1043, which is
 * exactly the keeper's MAX_LEG_FEE_BPS since the owner raised it that day.
 * Never take the number from this comment; read it from the mint. Everything at
 * PRESTOCKS_ISSUER is true of it, and its transfer_hook extension carries a
 * null program id.
 */
export const ANTHROPIC_MINT = "Pren1FvFX6J3E4kXhJuCiAD5aDmGEb7qJRncwA8Lkhw";

/** Raydium CLMM ANTHROPIC/USDC (mint0 ANTHROPIC, mint1 USDC), fee tier 0.25 %, tick spacing 60: the ANTHROPIC floor's price. */
export const ANTHROPIC_USDC_POOL = "47MsbowAJnPPt6jgSGLK4hdCtKqRRcKT5pTFHPV7WBPt";

/** PreStocks FIGUREAI: Token-2022, 9 decimals, the same uncapped fee — 100 bps in epoch 1039, 300 written for epoch 1043 (read 2026-09-24) — and the same single authority key as ANTHROPIC. */
export const FIGUREAI_MINT = "PreZad18qfPtbxNpMtMuAuX2zVpvkEU8DnJx56faCWd";

// ── The rest of the PreStocks shelf, pinned 2026-09-21 ──────────────────────
//
// Resolved by a Jupiter token search and then PROVED by reading each mint on
// mainnet: Token-2022, 9 decimals, and all four authorities equal to
// PRESTOCKS_ISSUER — the same key addresses.ts already pinned for ANTHROPIC and
// FIGUREAI. Each charged 100 bps from epoch 1039 when it was read.
//
// NONE OF THEM IS OFFERED, and being named here does not offer them: the
// catalogue in client/product.ts decides that by rule, and every one of these
// fails at least one. They are pinned so that the refusals have an address to
// be about and so the next measurement has somewhere to land. XAI is absent
// because that search answered with no PreStocks mint for it at all.

/** PreStocks OPENAI: trades on Manifest; no Raydium CLMM/USDC pool is pinned, so no floor can be signed for it. */
export const OPENAI_MINT = "PreweJYECqtQwBtpxHL171nL2K6umo692gTm7Q3rpgF";

/** PreStocks NEURALINK. */
export const NEURALINK_MINT = "PrekqLJvJ3qVdXmBGDiexvwUTF4rLFDa6HWS4HJbw9S";

/** PreStocks SPACEX: trades on a Meteora DLMM. */
export const SPACEX_MINT = "PreANxuXjsy2pvisWWMNB6YaJNzr7681wJJr2rHsfTh";

/** PreStocks POLYMARKET. */
export const POLYMARKET_MINT = "Pre8AREmFPtoJFT8mQSXQLh56cwJmM7CFDRuoGBZiUP";

/** PreStocks KALSHI. */
export const KALSHI_MINT = "PreLWGkkeqG1s4HEfFZSy9moCrJ7btsHuUtfcCeoRua";

/** PreStocks ANDURIL. */
export const ANDURIL_MINT = "PresTj4Yc2bAR197Er7wz4UUKSfqt6FryBEdAriBoQB";

/** Raydium CLMM FIGUREAI/USDC (mint0 FIGUREAI, mint1 USDC), fee tier 1 %, tick spacing 120: the FIGUREAI floor's price. */
export const FIGUREAI_USDC_POOL = "HvpDt29EdGcKkFMLkUgvAJDP5oDFLaYG4jnVZnRsHduM";

// ── Pyth: two programs, and the confusion that must not be made ──────────────
//
// A Pyth pull-oracle price account on mainnet is OWNED by one program and
// ADDRESSED under another, and BOTH facts are true at once:
//  * an ownership gate uses PYTH_RECEIVER_PROGRAM — getAccountInfo(feed).owner
//    is the receiver, never the push program;
//  * an address derivation uses PYTH_PUSH_PROGRAM — the feed account is a PDA
//    under the push program, seeds [shard as u16 LE, feed_id as 32 bytes].
// Swapped, both fail: a derivation under the receiver yields an address nothing
// lives at, and an owner check against the push program rejects every real feed.

/** Pyth's push-oracle RECEIVER: what OWNS a feed account. Never derive with this. */
export const PYTH_RECEIVER_PROGRAM = "rec2HHDDnjLfj4kE7VyEtFA1HPGQLK33259532cRyHp";

/** Pyth's PUSH program: what a feed account's address is DERIVED under, seeds [u16 LE shard, feed_id]. Never gate ownership with this. */
export const PYTH_PUSH_PROGRAM = "pyt2F414BA6dPttK6RddPZUdHfapoBN24GL5wbrPCou";

/** The SOL/USD price account (shard 0): 134 bytes, owned by the receiver. */
export const PYTH_SOL_USD_FEED = "7AviUf9nL62mcxNbQGKm4nKDQnPjswo6c5MX4D57HmyE";

/** The USDC/USD price account (shard 0): 134 bytes, owned by the receiver. */
export const PYTH_USDC_USD_FEED = "6HAuqASbHEh4w4REJEUUUCginTLfj1kwCh215ZLtMkrT";

/** SOL/USD's 32-byte feed id, hex: the derivation seed, and what the account carries after its verification level. */
export const PYTH_SOL_USD_FEED_ID_HEX = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";

/** USDC/USD's 32-byte feed id, hex. */
export const PYTH_USDC_USD_FEED_ID_HEX = "eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a";

/**
 * The Crypto.SPYX/USD price account (shard 0): 134 bytes, owned by the receiver.
 *
 * READ ON MAINNET 2026-09-25 and pinned by BOTH facts this section demands:
 * getMultipleAccounts returned owner rec2HHDD… (the receiver) and 134 bytes, and
 * findProgramAddress([u16 LE 0, the feed id below], PYTH_PUSH_PROGRAM) is this
 * address, so the id in the bytes is the id the address commits to.
 *
 * IT IS NOT A KEEPER INPUT. Nothing in the money path reads it: the keeper's
 * oracle gate is the SOL hop's (solana-keeper/src/invest-decision.ts), and this
 * feed exists for the public /prices page, which shows an xStock's pool mid
 * against it and the AGE of each. An equity push account is refreshed by a third
 * party on its own schedule and is regularly hours old, which is exactly why the
 * page that reads it never shows the price without the age.
 */
export const PYTH_SPYX_USD_FEED = "27Tv3HxU34AKxZ8MgfFAA1gCbWa96msMG5BvSWAHkBfj";

/** Crypto.SPYX/USD's 32-byte feed id, hex: the derivation seed above, and what the account carries after its verification level. */
export const PYTH_SPYX_USD_FEED_ID_HEX = "2817b78438c769357182c04346fddaad1178c82f4048828fe0997c3c64624e14";
