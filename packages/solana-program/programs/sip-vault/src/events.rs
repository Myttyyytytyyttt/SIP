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
}
