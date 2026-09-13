use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::token_interface::TokenAccount;

use crate::errors::NuvemError;
use crate::state::{InvestmentPolicy, ProtocolConfig, Vault};

/// Converts the vault's wSOL into its in-asset (USDC) — the first hop of
/// wSOL -> USDC -> stock, split from invest() because on Solana each hop is
/// its own venue CPI with its own ~17-account route.
///
/// SAME GUARD SHAPE AS INVEST, DIFFERENT ENVELOPE. The venue program is the
/// SAME pinned one from the policy; both deltas are measured (spend bounded by
/// amount_in, fill floored by min_out); and min_out must clear the OWNER'S
/// `min_convert_rate_wad` — USDC-raw per lamport, signed into the policy the
/// same way each leg's floor is. What it does NOT touch: the investment
/// buckets. Conversion is not spend — the USDC stays in the vault, and the
/// subsequent invest() records the spend against the caps. Counting both
/// would charge the month's allowance twice for one purchase.
///
/// A zero `min_convert_rate_wad` means the owner never enabled conversion,
/// and it is refused loudly — "accept any price" is not a policy here either.
#[derive(Accounts)]
pub struct Convert<'info> {
    /// NOT ANY SIGNER. This was a bare `Signer` with no constraint, which let a
    /// stranger wrap a vault's SOL and sell it through a pool of their own —
    /// the floor below was the only limit, and it was a constant. `config`
    /// below is what makes this account mean something.
    pub crank: Signer<'info>,

    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, ProtocolConfig>,

    #[account(
        mut,
        seeds = [b"vault", vault.owner.as_ref()],
        bump = vault.bump,
    )]
    pub vault: Box<Account<'info, Vault>>,

    #[account(
        seeds = [b"invest", vault.key().as_ref()],
        bump = policy.bump,
        constraint = policy.vault == vault.key() @ NuvemError::InvalidPolicy,
    )]
    pub policy: Box<Account<'info, InvestmentPolicy>>,

    /// The vault's wSOL account — the conversion's source.
    #[account(
        mut,
        constraint = vault_wsol.owner == vault.key() @ NuvemError::InvalidPolicy,
        constraint = vault_wsol.mint == anchor_spl::token::spl_token::native_mint::ID @ NuvemError::InvalidPolicy,
    )]
    pub vault_wsol: Box<InterfaceAccount<'info, TokenAccount>>,

    /// The vault's in-asset account — where the fill lands and is measured. Its
    /// mint is pinned: the owner's floor is a price in that mint, and a fill in
    /// any other one, such as a token the caller minted, clears it for free.
    #[account(
        mut,
        constraint = vault_in.owner == vault.key() @ NuvemError::InvalidPolicy,
        constraint = vault_in.mint == policy.in_mint @ NuvemError::WrongInMint,
    )]
    pub vault_in: Box<InterfaceAccount<'info, TokenAccount>>,

    /// CHECK: pinned against policy.venue_program below.
    pub venue_program: UncheckedAccount<'info>,
}

pub fn convert_handler(
    ctx: Context<Convert>,
    amount_in: u64,
    min_out: u64,
    venue_data: Vec<u8>,
) -> Result<()> {
    let vault = &ctx.accounts.vault;
    let policy = &ctx.accounts.policy;

    require!(!vault.paused, NuvemError::VaultPaused);
    require!(!ctx.accounts.config.paused, NuvemError::ProtocolPaused);
    require!(policy.enabled, NuvemError::InvestingDisabled);
    require!(
        ctx.accounts.venue_program.key() == policy.venue_program,
        NuvemError::WrongVenue
    );
    // BEFORE ANY MONEY MOVES, and before the pause/policy checks so the
    // rejection an unauthorised caller sees is the one that is actually true
    // of them.
    require!(
        ctx.accounts
            .config
            .may_crank(&ctx.accounts.vault.owner, &ctx.accounts.crank.key()),
        NuvemError::UnauthorizedCrank
    );
    require!(policy.min_convert_rate_wad > 0, NuvemError::FloorTooLow);
    require!(amount_in > 0, NuvemError::ZeroAmount);
    // The per-call ceiling bounds conversion exposure too; lamports and USDC
    // differ in scale, but a single knob for "how much may move per call" is
    // the coarser, safer reading of the owner's intent.
    require!(amount_in <= policy.max_per_call.max(1_000_000_000), NuvemError::AboveMaximum);

    let floor = u64::try_from(
        u128::from(amount_in).saturating_mul(policy.min_convert_rate_wad)
            / 1_000_000_000_000_000_000u128,
    )
    .map_err(|_| NuvemError::InvalidPolicy)?;
    require!(min_out >= floor && min_out > 0, NuvemError::FloorTooLow);

    let wsol_before = ctx.accounts.vault_wsol.amount;
    let in_before = ctx.accounts.vault_in.amount;

    let vault_key = vault.key();
    let metas: Vec<AccountMeta> = ctx
        .remaining_accounts
        .iter()
        .map(|account| AccountMeta {
            pubkey: account.key(),
            is_signer: account.key() == vault_key,
            is_writable: account.is_writable,
        })
        .collect();
    let owner_key = vault.owner;
    let seeds: &[&[u8]] = &[b"vault", owner_key.as_ref(), &[vault.bump]];
    invoke_signed(
        &Instruction {
            program_id: ctx.accounts.venue_program.key(),
            accounts: metas,
            data: venue_data,
        },
        ctx.remaining_accounts,
        &[seeds],
    )?;

    ctx.accounts.vault_wsol.reload()?;
    ctx.accounts.vault_in.reload()?;
    let spent = wsol_before.saturating_sub(ctx.accounts.vault_wsol.amount);
    require!(spent <= amount_in, NuvemError::Overspent);
    let received = ctx
        .accounts
        .vault_in
        .amount
        .checked_sub(in_before)
        .ok_or(NuvemError::FillTooSmall)?;
    require!(received >= min_out, NuvemError::FillTooSmall);

    Ok(())
}
