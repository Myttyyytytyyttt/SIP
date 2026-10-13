use anchor_lang::prelude::*;

/// One settlement, as it happened. `owed` is what the attested base and the
/// vault's rate come to; `paid` is what actually moved, after the owner's
/// per-settlement cap. When they differ, the difference is visible here and
/// nowhere else on chain: carrying it forward as debt is later work, and until
/// then the keeper's ledger records it as pending.
#[event]
pub struct Settled {
    pub vault: Pubkey,
    pub wallet: Pubkey,
    pub mode: u8,
    pub base_lamports: u64,
    pub bps: u16,
    pub owed: u64,
    pub paid: u64,
    pub settlement_nonce: u64,
    pub session_end_slot: u64,
    /// APPENDED, SO EVERY FIELD ABOVE KEEPS ITS OFFSET. `settlement_nonce`
    /// restarts at zero whenever a link is re-created, so (wallet, nonce)
    /// repeats across a wallet's link lives and (wallet, link_epoch, nonce) does
    /// not. With the window's start and the policy nonce the attestation signed,
    /// the event describes the settlement without another account read.
    pub link_epoch: u64,
    pub session_start_slot: u64,
    pub policy_nonce: u64,
}

/// What a per-trade settlement (settle_v3, mode 2 or 3) counted and signed,
/// emitted right AFTER its `Settled`.
///
/// A SECOND EVENT, NOT A LONGER `Settled`. The deployed readers decode
/// `Settled` with its exact length and refuse trailing bytes, so settle_v3
/// emits an unchanged `Settled` (mode 2 or 3, base = owed = the attested
/// amount, bps = 10_000, paid) that every reader already counts, and puts
/// what is new here, under a discriminator old readers skip.
///
/// `mode_param` is the round-up unit in cents (mode 2) or the fixed lamports
/// per trade (mode 3); `min_trade` is min_trade_cents (mode 2) or
/// min_trade_lamports (mode 3): the same two values the attestation signs.
/// `day_saved_lamports` is the vault's UTC-day total AFTER this payment.
#[event]
pub struct PerTradeSettled {
    pub vault: Pubkey,
    pub wallet: Pubkey,
    pub link_epoch: u64,
    pub settlement_nonce: u64,
    pub mode: u8,
    pub trade_count: u32,
    pub price_min_usd_e6: u64,
    pub prices_hash: [u8; 32],
    pub mode_param: u64,
    pub min_trade: u64,
    pub day_index: u32,
    pub day_saved_lamports: u64,
}
