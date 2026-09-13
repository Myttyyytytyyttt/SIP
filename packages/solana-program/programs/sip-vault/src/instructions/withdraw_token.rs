use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{
    self, CloseAccount, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::errors::NuvemError;
use crate::state::Vault;

/// Owner withdraws an SPL / Token-2022 balance from the vault — the token twin
/// of `withdraw`, and the instruction PLAN.md §5 named but M1 never shipped.
///
/// WHY IT IS NEEDED AT ALL. `withdraw` moves native lamports only, but the
/// invest pipeline parks the user's savings in TOKEN accounts owned by the
/// vault PDA: wrap_sol -> wSOL, convert -> USDC, invest -> the stock mint. With
/// no token exit, the moment the keeper converts a settlement it is one-way —
/// "a vault only you can withdraw from" becomes a half-truth for everything
/// past the SOL leg. This closes that.
///
/// SAME UNCONDITIONAL STANCE AS `withdraw`. It ignores `paused` deliberately:
/// pause gates settle and invest, the paths that move money on the keeper's
/// signature. The owner taking their OWN savings out must survive every failure
/// this system has — a paused protocol, a frozen token leg, a keeper that is
/// gone. Anything that could block it would make the exit conditional, which is
/// the one thing it must never be.
///
/// The destination is the OWNER'S OWN associated token account, created here if
/// absent (the owner signs and pays). Pinning the destination to the owner is
/// what keeps "only you" true: the vault PDA signs the transfer, so the
/// constraints are the whole guard — the source must be vault-owned, the
/// destination must be owner-owned, and both must be the same mint.
#[derive(Accounts)]
pub struct WithdrawToken<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        seeds = [b"vault", owner.key().as_ref()],
        bump = vault.bump,
        constraint = vault.owner == owner.key() @ NuvemError::NotOwner,
    )]
    pub vault: Box<Account<'info, Vault>>,

    pub token_mint: Box<InterfaceAccount<'info, Mint>>,

    /// The vault's token account for this mint — the source. Its authority MUST
    /// be the vault PDA, or this would be a transfer out of someone else's
    /// account that the vault happens to be able to name.
    #[account(
        mut,
        constraint = vault_token.owner == vault.key() @ NuvemError::NotOwner,
        constraint = vault_token.mint == token_mint.key() @ NuvemError::InvalidPolicy,
    )]
    pub vault_token: Box<InterfaceAccount<'info, TokenAccount>>,

    /// The owner's associated token account — the destination, created if it
    /// does not exist yet. `associated_token::authority = owner` is the pin
    /// that keeps the exit "only you": savings can only land in the owner's
    /// own account, never an arbitrary one.
    #[account(
        init_if_needed,
        payer = owner,
        associated_token::mint = token_mint,
        associated_token::authority = owner,
        associated_token::token_program = token_program,
    )]
    pub owner_token: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn withdraw_token_handler(ctx: Context<WithdrawToken>, amount: u64) -> Result<()> {
    require!(amount > 0, NuvemError::ZeroAmount);
    require!(
        amount <= ctx.accounts.vault_token.amount,
        NuvemError::InsufficientTokenBalance
    );

    // The vault PDA signs its own transfer. transfer_checked (not transfer)
    // because Token-2022 requires the decimals be re-stated and checked, and it
    // is the safe default for SPL too. NVDAx and USDC carry a transfer_hook
    // extension with a null program id (PLAN.md §4), so no hook program is
    // invoked and the plain checked transfer is correct; a mint that pinned a
    // real hook program would need transfer_checked_with_transfer_hook, which
    // is a deliberate future change, not a silent one.
    let owner_key = ctx.accounts.vault.owner;
    let seeds: &[&[u8]] = &[b"vault", owner_key.as_ref(), &[ctx.accounts.vault.bump]];
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.vault_token.to_account_info(),
                mint: ctx.accounts.token_mint.to_account_info(),
                to: ctx.accounts.owner_token.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            &[seeds],
        ),
        amount,
        ctx.accounts.token_mint.decimals,
    )?;

    // WRAPPED SOL IS NOT A WITHDRAWAL UNTIL IT IS UNWRAPPED.
    //
    // The invest pipeline turns the vault's savings into wSOL before it can
    // reach a pool, so wSOL is an INTERNAL step of this system, never an asset
    // a saver chose to hold. Transferring it to the owner's wSOL account and
    // stopping there would leave their spendable balance unchanged while every
    // screen reported success — the money would be in an account no Nuvem
    // surface lists and, without this, no instruction here could ever open.
    //
    // So for the native mint the account is CLOSED, which is exactly how SPL
    // unwraps: the wrapped lamports (and the account's own rent) land as
    // spendable SOL on the owner, who signs this transaction and is the
    // account's authority. If the owner happened to hold other wSOL, it
    // unwraps too — the same direction they asked for, and wSOL sitting in a
    // personal wallet is nearly always an accident of some earlier swap.
    if ctx.accounts.token_mint.key() == anchor_spl::token::spl_token::native_mint::ID {
        token_interface::close_account(CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            CloseAccount {
                account: ctx.accounts.owner_token.to_account_info(),
                destination: ctx.accounts.owner.to_account_info(),
                authority: ctx.accounts.owner.to_account_info(),
            },
        ))?;
    }

    Ok(())
}
