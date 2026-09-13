use anchor_lang::prelude::*;

use crate::errors::NuvemError;
use crate::program::SipVault;
use crate::state::{ProtocolConfig, CURRENT_CONFIG_VERSION};

/// Creates the one ProtocolConfig, naming the attester.
///
/// ONLY THE PROGRAM'S UPGRADE AUTHORITY MAY CALL IT. In the old deployment this
/// was first-caller-wins: whoever reached the config PDA first owned the
/// protocol, and the only defence was calling it quickly after deploying. Here
/// the transaction must be signed by the key the loader records as this
/// program's upgrade authority, read from ProgramData, so a stranger watching
/// the deploy cannot take it -- they are refused, not merely raced.
///
/// The roles MAY coincide during the hackathon (one admin wallet). What makes
/// that safe to change later without a redeploy is `transfer_authority`.
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

    #[account(
        constraint = program.programdata_address()? == Some(program_data.key()) @ NuvemError::NotUpgradeAuthority,
    )]
    pub program: Program<'info, SipVault>,

    #[account(
        constraint = program_data.upgrade_authority_address == Some(authority.key()) @ NuvemError::NotUpgradeAuthority,
    )]
    pub program_data: Account<'info, ProgramData>,

    pub system_program: Program<'info, System>,
}

pub fn init_config_handler(ctx: Context<InitConfig>, attester: Pubkey) -> Result<()> {
    // Same rule as set_attester: a zero attester would leave settle
    // unverifiable forever, indistinguishable from a misconfiguration.
    require!(attester != Pubkey::default(), NuvemError::InvalidAuthority);

    let config = &mut ctx.accounts.config;
    config.authority = ctx.accounts.authority.key();
    config.attester = attester;
    config.bump = ctx.bumps.config;
    config.keeper = Pubkey::default();
    config.pending_authority = Pubkey::default();
    config.paused = false;
    config.version = CURRENT_CONFIG_VERSION;
    Ok(())
}
