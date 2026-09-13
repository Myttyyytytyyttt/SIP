use anchor_lang::prelude::*;

use crate::errors::NuvemError;
use crate::state::{Vault, CURRENT_VAULT_VERSION};

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

pub fn create_vault_handler(ctx: Context<CreateVault>, skim_bps: u16) -> Result<()> {
    // Zero is the "reachable trap" (a vault saving nothing, all logs healthy);
    // above 10_000 is arithmetic nonsense. Both die here, not in settle.
    require!(skim_bps >= 1 && skim_bps <= 10_000, NuvemError::InvalidSkimBps);

    let vault = &mut ctx.accounts.vault;
    vault.owner = ctx.accounts.owner.key();
    vault.bump = ctx.bumps.vault;
    vault.version = CURRENT_VAULT_VERSION;
    vault.paused = false;
    vault.skim_bps = skim_bps;
    vault.lifetime_saved = 0;
    vault.created_at = Clock::get()?.unix_timestamp;

    Ok(())
}
