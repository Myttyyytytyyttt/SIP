use anchor_lang::prelude::*;

use crate::errors::NuvemError;
use crate::state::Vault;

/// Owner withdraws SOL from the vault.
///
/// DELIBERATELY IGNORES `paused`. Pause gates settle and invest — the paths
/// where money moves on someone else's signature. The user taking their own
/// savings out must survive every failure mode this system has, including the
/// stock issuer freezing the token leg (xStocks carry a live freeze authority
/// and a permanent delegate; see PLAN.md §4). A withdraw that could be blocked
/// by anything would make "only you can withdraw" a half-truth.
///
/// No swap in this path, ever, for the same reason.
#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [b"vault", owner.key().as_ref()],
        bump = vault.bump,
        constraint = vault.owner == owner.key() @ NuvemError::NotOwner,
    )]
    pub vault: Account<'info, Vault>,
}

pub fn withdraw_handler(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
    require!(amount > 0, NuvemError::ZeroAmount);

    let vault_info = ctx.accounts.vault.to_account_info();

    // The savings live in the vault account's own lamports, on top of its
    // rent-exempt minimum. The floor stays: dropping below it would let the
    // runtime garbage-collect the account, and the vault's identity with it.
    let rent_floor = Rent::get()?.minimum_balance(vault_info.data_len());
    let withdrawable = vault_info
        .lamports()
        .saturating_sub(rent_floor);
    require!(amount <= withdrawable, NuvemError::InsufficientVaultBalance);

    // A program may debit lamports from accounts it owns; no CPI needed.
    **vault_info.try_borrow_mut_lamports()? -= amount;
    **ctx.accounts.owner.to_account_info().try_borrow_mut_lamports()? += amount;

    Ok(())
}
