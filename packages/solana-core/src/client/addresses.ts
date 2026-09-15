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
