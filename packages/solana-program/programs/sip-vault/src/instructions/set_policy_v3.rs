use anchor_lang::prelude::*;

use crate::errors::NuvemError;
use crate::state::{validate_per_trade_policy, PerTradePolicy, Vault, CURRENT_PER_TRADE_POLICY_VERSION};

/// Puts a vault in a per-trade mode: ROUND-UP (2) or FIXED (3).
///
/// THE ONLY DOOR INTO MODES 2 AND 3. validate_policy still refuses them, so
/// create_vault_v2 and set_policy_v2 cannot write them, and a new round-up
/// saver signs create_vault_v2(mode 0, …) and this in one transaction. The way
/// back is set_policy_v2 with mode 0 or 1, unchanged; the PerTradePolicy it
/// leaves behind is inert.
///
/// THE OWNER'S, LIKE set_policy_v2: the vault is derived from the signer, so
/// no other key can steer it. The owner also pays the PDA's rent, once.
#[derive(Accounts)]
pub struct SetPolicyV3<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [b"vault", owner.key().as_ref()],
        bump = vault.bump,
        constraint = vault.owner == owner.key() @ NuvemError::NotOwner,
    )]
    pub vault: Account<'info, Vault>,

    #[account(
        init_if_needed,
        payer = owner,
        space = 8 + PerTradePolicy::INIT_SPACE,
        seeds = [b"per_trade", vault.key().as_ref()],
        bump,
    )]
    pub per_trade_policy: Account<'info, PerTradePolicy>,

    pub system_program: Program<'info, System>,
}

/// Writes the vault's mode, caps and pause, and the PDA's parameters; bumps the
/// policy nonce, as set_policy_v2 does, so no attestation in flight survives
/// it. The daily counter is NOT reset: a policy write must not buy a second
/// day's cap. Both rates on the Vault stay as their last v2 write left them.
#[allow(clippy::too_many_arguments)]
pub fn set_policy_v3_handler(
    ctx: Context<SetPolicyV3>,
    mode: u8,
    roundup_unit_cents: u16,
    fixed_lamports: u32,
    min_trade_cents: u16,
    min_trade_lamports: u32,
    daily_cap_lamports: u64,
    max_contribution: u64,
    wallet_reserve: u64,
    paused: bool,
) -> Result<()> {
    validate_per_trade_policy(
        mode,
        roundup_unit_cents,
        fixed_lamports,
        min_trade_cents,
        min_trade_lamports,
        daily_cap_lamports,
        max_contribution,
    )?;

    let vault = &mut ctx.accounts.vault;
    vault.skim_mode = mode;
    vault.paused = paused;
    vault.max_contribution = max_contribution;
    vault.wallet_reserve = wallet_reserve;
    vault.policy_nonce = vault.policy_nonce.checked_add(1).ok_or(NuvemError::InvalidPolicy)?;
    let vault_key = vault.key();

    let policy = &mut ctx.accounts.per_trade_policy;
    policy.vault = vault_key;
    policy.bump = ctx.bumps.per_trade_policy;
    policy.version = CURRENT_PER_TRADE_POLICY_VERSION;
    policy.roundup_unit_cents = roundup_unit_cents;
    policy.fixed_lamports = fixed_lamports;
    policy.min_trade_cents = min_trade_cents;
    policy.min_trade_lamports = min_trade_lamports;
    policy.daily_cap_lamports = daily_cap_lamports;
    Ok(())
}
