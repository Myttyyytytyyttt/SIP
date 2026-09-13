use anchor_lang::prelude::*;

use crate::state::ProtocolConfig;

/// Names the one account, besides each vault's own owner, allowed to crank
/// `wrap_sol` and `convert`.
///
/// WHY THIS INSTRUCTION EXISTS. Both of those moved the VAULT's money on the
/// say-so of a bare `Signer` with no check, so any stranger could wrap a
/// vault's SOL and route it out through a pool they controlled — bounded only
/// by an owner-signed floor that, in practice, was set to a $30/SOL constant.
/// Constraining the crank is the fix; this is how the operator installs the
/// keeper that constraint points at.
///
/// SETTING IT BACK TO THE DEFAULT PUBKEY IS A VALID, MEANINGFUL ACT: it
/// disables the keeper entirely and leaves every vault owner-cranked. That is
/// the correct panic switch if a keeper key is ever suspected, and it is why
/// `may_crank` treats the default as "nobody" rather than as "unset, so allow".
#[derive(Accounts)]
pub struct SetKeeper<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [b"config"],
        bump = config.bump,
        has_one = authority,
    )]
    pub config: Account<'info, ProtocolConfig>,
}

pub fn set_keeper_handler(ctx: Context<SetKeeper>, keeper: Pubkey) -> Result<()> {
    ctx.accounts.config.keeper = keeper;
    Ok(())
}
