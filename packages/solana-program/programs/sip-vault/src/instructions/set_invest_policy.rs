use anchor_lang::prelude::*;
use std::collections::BTreeSet;

use crate::errors::NuvemError;
use crate::state::{InvestmentLeg, InvestmentPolicy, Vault, MAX_LEGS};

/// Sets the investment policy — the functional port of RH's setInvestmentPolicy
/// plus _validateBasket, checks kept in the same spirit line for line: weights
/// sum to exactly 10_000, at most MAX_LEGS legs, no duplicate mints, no
/// zero floor (a zero floor is "accept any price", which is not a policy), and
/// min ≤ perCall ≤ rolling so the caps cannot contradict each other. Added for
/// Solana: the in-asset every floor and cap is written in must be named, and
/// cannot also be a mint the basket buys.
#[derive(Accounts)]
pub struct SetInvestPolicy<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        seeds = [b"vault", owner.key().as_ref()],
        bump = vault.bump,
        constraint = vault.owner == owner.key() @ NuvemError::NotOwner,
    )]
    pub vault: Account<'info, Vault>,

    #[account(
        init_if_needed,
        payer = owner,
        space = 8 + InvestmentPolicy::INIT_SPACE,
        seeds = [b"invest", vault.key().as_ref()],
        bump,
    )]
    pub policy: Account<'info, InvestmentPolicy>,

    pub system_program: Program<'info, System>,
}

#[allow(clippy::too_many_arguments)]
pub fn set_invest_policy_handler(
    ctx: Context<SetInvestPolicy>,
    legs: Vec<InvestmentLeg>,
    venue_program: Pubkey,
    in_mint: Pubkey,
    min_convert_rate_wad: u128,
    min_investment: u64,
    max_per_call: u64,
    max_rolling_30d: u64,
    enabled: bool,
) -> Result<()> {
    require!(!legs.is_empty() && legs.len() <= MAX_LEGS, NuvemError::InvalidPolicy);

    let mut weights: u32 = 0;
    let mut mints = BTreeSet::new();
    for leg in &legs {
        require!(leg.weight_bps > 0, NuvemError::InvalidPolicy);
        require!(leg.min_out_rate_wad > 0, NuvemError::InvalidPolicy);
        require!(mints.insert(leg.mint), NuvemError::InvalidPolicy);
        weights += u32::from(leg.weight_bps);
    }
    require!(weights == 10_000, NuvemError::InvalidPolicy);
    require!(in_mint != Pubkey::default() && !mints.contains(&in_mint), NuvemError::InvalidPolicy);

    require!(
        min_investment > 0 && min_investment <= max_per_call && max_per_call <= max_rolling_30d,
        NuvemError::InvalidPolicy
    );
    require!(enabled == false || venue_program != Pubkey::default(), NuvemError::InvalidPolicy);

    let policy = &mut ctx.accounts.policy;
    policy.vault = ctx.accounts.vault.key();
    policy.enabled = enabled;
    policy.venue_program = venue_program;
    policy.in_mint = in_mint;
    policy.legs = legs;
    policy.min_convert_rate_wad = min_convert_rate_wad;
    policy.min_investment = min_investment;
    policy.max_per_call = max_per_call;
    policy.max_rolling_30d = max_rolling_30d;
    // Buckets survive a policy change ON PURPOSE, exactly as RH's do: replacing
    // the basket must not refill this month's spending allowance.
    policy.policy_nonce += 1;
    policy.bump = ctx.bumps.policy;

    Ok(())
}
