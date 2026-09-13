use anchor_lang::prelude::*;

use crate::errors::NuvemError;
use crate::state::{validate_policy, Vault};

#[derive(Accounts)]
pub struct SetPolicy<'info> {
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [b"vault", owner.key().as_ref()],
        bump = vault.bump,
        constraint = vault.owner == owner.key() @ NuvemError::NotOwner,
    )]
    pub vault: Account<'info, Vault>,
}

/// Same bounds as creation, and the policy nonce moves on every call -- even one
/// that changes nothing -- so no attestation signed before it can settle after.
pub fn set_policy_handler(
    ctx: Context<SetPolicy>,
    mode: u8,
    skim_bps: u16,
    volume_bps: u16,
    paused: bool,
    max_contribution: u64,
    wallet_reserve: u64,
) -> Result<()> {
    validate_policy(mode, skim_bps, volume_bps, max_contribution)?;

    let vault = &mut ctx.accounts.vault;
    vault.skim_mode = mode;
    vault.skim_bps = skim_bps;
    vault.volume_bps = volume_bps;
    vault.paused = paused;
    vault.max_contribution = max_contribution;
    vault.wallet_reserve = wallet_reserve;
    vault.policy_nonce = vault.policy_nonce.checked_add(1).ok_or(NuvemError::InvalidPolicy)?;
    Ok(())
}
