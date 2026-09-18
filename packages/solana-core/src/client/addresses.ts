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

/** Raydium CLMM: the venue program SIP's invest policy pins. */
export const RAYDIUM_CLMM = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";

export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const WSOL_MINT = "So11111111111111111111111111111111111111112";

/** SP500 xStock: Token-2022, 8 decimals. Its issuer holds freeze, pause and a permanent delegate. */
export const SPYX_MINT = "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W";

/** Raydium CLMM wSOL/USDC (mint0 wSOL, mint1 USDC): the pool the keeper converts through, and the convert floor's price. */
export const SOL_USDC_POOL = "3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv";

/** Raydium CLMM SPYx/USDC (mint0 SPYx, mint1 USDC): the same pool as the keeper's SIP_SOLANA_POOLS, and the SPYx floor's price. */
export const SPYX_USDC_POOL = "6truu3rZuiB9rKQg4VYC3Dt3QwV7DgwGqXrYUcrvnDDE";

/** The two token programs a vault's holdings can live under. */
export const TOKEN_PROGRAMS = [TOKEN_PROGRAM, TOKEN_2022_PROGRAM] as const;

/**
 * PreStocks ANTHROPIC: Token-2022, 9 decimals, with a 50 bps transfer fee whose
 * maximum is u64::MAX, so the fee is uncapped however large the trade. One key
 * (WV9PJN7XTmTLVwbutCLFxp8TyePee6Xq5mRq6Fti5Wc) holds its mint, freeze, fee,
 * transfer-hook, pause AND permanent-delegate authority; the same key holds
 * FIGUREAI's. Its transfer_hook extension carries a null program id.
 */
export const ANTHROPIC_MINT = "Pren1FvFX6J3E4kXhJuCiAD5aDmGEb7qJRncwA8Lkhw";

/** Raydium CLMM ANTHROPIC/USDC (mint0 ANTHROPIC, mint1 USDC), fee tier 0.25 %, tick spacing 60: the ANTHROPIC floor's price. */
export const ANTHROPIC_USDC_POOL = "47MsbowAJnPPt6jgSGLK4hdCtKqRRcKT5pTFHPV7WBPt";

/** PreStocks FIGUREAI: Token-2022, 9 decimals, the same 50 bps uncapped fee and the same single authority key as ANTHROPIC. */
export const FIGUREAI_MINT = "PreZad18qfPtbxNpMtMuAuX2zVpvkEU8DnJx56faCWd";

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
