use anchor_lang::prelude::*;

use crate::state::ProtocolConfig;

/// Creates the one ProtocolConfig, naming the attester.
///
/// FIRST CALLER WINS, and that is a LAB trade-off stated out loud: whoever
/// initialises the config owns it. Fine on a validator you started yourself;
/// on any shared cluster the deploy runbook must call this in the same breath
/// as `anchor deploy`, exactly like the EVM side's bootstrap-then-transfer
/// ceremony exists to close the same window. Production replaces `authority`
/// with a Squads multisig before anything of value moves.
#[derive(Accounts)]
pub struct InitConfig<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = 8 + ProtocolConfig::INIT_SPACE,
        seeds = [b"config"],
        bump,
    )]
    pub config: Account<'info, ProtocolConfig>,

    pub system_program: Program<'info, System>,
}

pub fn init_config_handler(ctx: Context<InitConfig>, attester: Pubkey) -> Result<()> {
    let config = &mut ctx.accounts.config;
    config.authority = ctx.accounts.authority.key();
    config.attester = attester;
    config.bump = ctx.bumps.config;
    Ok(())
}
