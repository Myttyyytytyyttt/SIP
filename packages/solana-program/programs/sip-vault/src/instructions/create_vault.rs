use anchor_lang::prelude::*;

use crate::state::{validate_policy, Vault, CURRENT_VAULT_VERSION};

#[derive(Accounts)]
pub struct CreateVault<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    // init (not init_if_needed): creating twice must FAIL, not silently reset
    // the policy of a vault that already holds savings.
    #[account(
        init,
        payer = owner,
        space = 8 + Vault::INIT_SPACE,
        seeds = [b"vault", owner.key().as_ref()],
        bump,
    )]
    pub vault: Account<'info, Vault>,

    pub system_program: Program<'info, System>,
}

/// Both rates are always stored, and both are always bounded: switching mode
/// later is a policy change, not a chance to smuggle an out-of-range rate in.
pub fn create_vault_handler(
    ctx: Context<CreateVault>,
    mode: u8,
    skim_bps: u16,
    volume_bps: u16,
    max_contribution: u64,
    wallet_reserve: u64,
) -> Result<()> {
    validate_policy(mode, skim_bps, volume_bps, max_contribution)?;

    let vault = &mut ctx.accounts.vault;
    vault.owner = ctx.accounts.owner.key();
    vault.bump = ctx.bumps.vault;
    vault.version = CURRENT_VAULT_VERSION;
    vault.paused = false;
    vault.skim_bps = skim_bps;
    vault.lifetime_saved = 0;
    vault.created_at = Clock::get()?.unix_timestamp;
    vault.skim_mode = mode;
    vault.volume_bps = volume_bps;
    vault.policy_nonce = 0;
    vault.max_contribution = max_contribution;
    vault.wallet_reserve = wallet_reserve;
    Ok(())
}
