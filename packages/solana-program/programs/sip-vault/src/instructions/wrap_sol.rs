use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};
use anchor_spl::token_interface::{self, SyncNative, TokenAccount, TokenInterface};

use crate::errors::NuvemError;
use crate::state::{ProtocolConfig, Vault};

/// The missing link between settle and invest: the vault's savings arrive as
/// native SOL (settle credits the PDA's lamports), but every liquid xStocks
/// pool quotes against a TOKEN. Wrapping turns vault lamports into wSOL in the
/// vault's own token account, from where invest() routes wSOL -> USDC -> stock.
///
/// OWNER OR KEEPER ONLY. This was permissionless, on the reasoning that it
/// grants nothing — the SOL ends up as wSOL under the same owner and the rent
/// floor stays untouchable. True in isolation, and irrelevant in company: it is
/// the step that turns a vault's idle SOL into the one asset `convert` can
/// sell, so open wrapping plus open converting was a two-instruction drain
/// needing no permission at all.
///
/// WHY THE CRANK FRONTS THE LAMPORTS. The vault PDA is a data account, so
/// `system_program::transfer` cannot move lamports FROM it (System transfers
/// require a System-owned source). Poking the wSOL account's lamports by hand
/// and then calling `sync_native` in the same instruction trips the runtime's
/// balance accounting. So the crank transfers `amount` into the wSOL account
/// with a proper System CPI — which `sync_native` is happy to fold — and the
/// vault reimburses the crank the same `amount` by direct debit, which a
/// program may always do to an account it owns. Net: vault -amount, crank 0,
/// wSOL +amount. The crank is a keeper the vault trusts to pick the moment; it
/// is never out of pocket.
#[derive(Accounts)]
pub struct WrapSol<'info> {
    /// NOT ANY SIGNER — see `config`. Wrapping is what turns a vault's spendable
    /// SOL into something `convert` can sell, so leaving it open was half of a
    /// two-instruction drain that needed no permission at all.
    #[account(mut)]
    pub crank: Signer<'info>,

    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, ProtocolConfig>,

    #[account(
        mut,
        seeds = [b"vault", vault.owner.as_ref()],
        bump = vault.bump,
    )]
    pub vault: Box<Account<'info, Vault>>,

    /// The vault's wSOL account (native mint, authority = the vault PDA).
    #[account(
        mut,
        constraint = vault_wsol.owner == vault.key() @ NuvemError::InvalidPolicy,
        constraint = vault_wsol.mint == anchor_spl::token::spl_token::native_mint::ID @ NuvemError::InvalidPolicy,
    )]
    pub vault_wsol: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

pub fn wrap_sol_handler(ctx: Context<WrapSol>, amount: u64) -> Result<()> {
    // BEFORE ANY MONEY MOVES. Wrapping is not harmless: it converts the
    // vault's spendable SOL into the exact asset `convert` is able to sell.
    require!(
        ctx.accounts
            .config
            .may_crank(&ctx.accounts.vault.owner, &ctx.accounts.crank.key()),
        NuvemError::UnauthorizedCrank
    );
    require!(!ctx.accounts.config.paused, NuvemError::ProtocolPaused);
    require!(amount > 0, NuvemError::ZeroAmount);

    // The vault must be able to cover the reimbursement without dipping below
    // rent exemption — the same floor withdraw enforces.
    let vault_info = ctx.accounts.vault.to_account_info();
    let rent_floor = Rent::get()?.minimum_balance(vault_info.data_len());
    let free = vault_info.lamports().saturating_sub(rent_floor);
    require!(amount <= free, NuvemError::InsufficientVaultBalance);

    // 1. crank -> wSOL account, a proper System transfer.
    transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            Transfer {
                from: ctx.accounts.crank.to_account_info(),
                to: ctx.accounts.vault_wsol.to_account_info(),
            },
        ),
        amount,
    )?;

    // 2. fold the new lamports into the wSOL token balance.
    token_interface::sync_native(CpiContext::new(
        ctx.accounts.token_program.to_account_info(),
        SyncNative {
            account: ctx.accounts.vault_wsol.to_account_info(),
        },
    ))?;

    // 3. vault reimburses the crank — a direct debit of an account it owns.
    **vault_info.try_borrow_mut_lamports()? -= amount;
    **ctx.accounts.crank.to_account_info().try_borrow_mut_lamports()? += amount;

    Ok(())
}
