use anchor_lang::prelude::*;

use crate::errors::NuvemError;
use crate::state::Vault;

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

pub fn set_policy_handler(ctx: Context<SetPolicy>, skim_bps: u16, paused: bool) -> Result<()> {
    // Same bounds as creation. An existing vault cannot be steered into the
    // zero-skim trap any more than a new one can.
    require!(skim_bps >= 1 && skim_bps <= 10_000, NuvemError::InvalidSkimBps);

    let vault = &mut ctx.accounts.vault;
    vault.skim_bps = skim_bps;
    vault.paused = paused;

    Ok(())
}
