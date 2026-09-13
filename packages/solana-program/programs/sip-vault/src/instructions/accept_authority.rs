use anchor_lang::prelude::*;

use crate::errors::NuvemError;
use crate::state::ProtocolConfig;

/// Completes a transfer: the proposed key signs, becomes the authority, and the
/// proposal is cleared. Only a key that can actually sign can ever end up in
/// control, which is the whole point of doing this in two steps.
#[derive(Accounts)]
pub struct AcceptAuthority<'info> {
    pub pending_authority: Signer<'info>,

    #[account(
        mut,
        seeds = [b"config"],
        bump = config.bump,
        constraint = config.pending_authority != Pubkey::default()
            && config.pending_authority == pending_authority.key() @ NuvemError::NotPendingAuthority,
    )]
    pub config: Account<'info, ProtocolConfig>,
}

pub fn accept_authority_handler(ctx: Context<AcceptAuthority>) -> Result<()> {
    let config = &mut ctx.accounts.config;
    config.authority = ctx.accounts.pending_authority.key();
    config.pending_authority = Pubkey::default();
    Ok(())
}
