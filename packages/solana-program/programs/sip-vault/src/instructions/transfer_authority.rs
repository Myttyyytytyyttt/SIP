use anchor_lang::prelude::*;

use crate::errors::NuvemError;
use crate::state::ProtocolConfig;

/// Proposes a new config authority. Nothing changes until that key signs
/// `accept_authority`. Calling it again replaces the proposal; proposing the
/// current authority is how a mistaken proposal is withdrawn.
#[derive(Accounts)]
pub struct TransferAuthority<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [b"config"],
        bump = config.bump,
        has_one = authority,
    )]
    pub config: Account<'info, ProtocolConfig>,
}

pub fn transfer_authority_handler(ctx: Context<TransferAuthority>, new_authority: Pubkey) -> Result<()> {
    require!(new_authority != Pubkey::default(), NuvemError::InvalidAuthority);
    ctx.accounts.config.pending_authority = new_authority;
    Ok(())
}
