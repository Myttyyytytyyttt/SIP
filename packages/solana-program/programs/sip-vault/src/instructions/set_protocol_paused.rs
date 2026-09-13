use anchor_lang::prelude::*;

use crate::state::ProtocolConfig;

/// Stops, or restarts, settle, wrap_sol, convert and invest for every vault.
/// Withdrawals keep working either way.
#[derive(Accounts)]
pub struct SetProtocolPaused<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [b"config"],
        bump = config.bump,
        has_one = authority,
    )]
    pub config: Account<'info, ProtocolConfig>,
}

pub fn set_protocol_paused_handler(ctx: Context<SetProtocolPaused>, paused: bool) -> Result<()> {
    ctx.accounts.config.paused = paused;
    Ok(())
}
