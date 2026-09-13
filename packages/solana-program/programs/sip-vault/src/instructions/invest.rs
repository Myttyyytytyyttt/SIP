use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::token_interface::{Mint, TokenAccount};

use crate::errors::NuvemError;
use crate::state::{InvestmentPolicy, ProtocolConfig, Vault};

/// Invests one leg: the vault buys `leg`'s mint through the policy's pinned
/// venue, behind RH's full guard surface.
///
/// PERMISSIONLESS CRANK, OPAQUE ROUTE, MEASURED EVERYTHING. The caller brings
/// the venue's instruction data and account list (a real Raydium CLMM swap_v2
/// needs 18 accounts including tick arrays that move with the price — no
/// program should pin those); the program brings the guarantees:
///
///   * the venue PROGRAM is pinned in the owner-signed policy — the route is
///     opaque, the counterparty is not;
///   * the vault PDA signs the CPI, so the venue can spend from the vault's
///     input account — and the SPEND IS MEASURED: input-account delta must not
///     exceed amount_in, or the whole call unwinds;
///   * the FILL IS MEASURED: target-account delta must reach min_out, which
///     itself must clear the user's own min_out_rate_wad floor;
///   * RH's envelope: threshold, per-call ceiling, rolling 31-bucket window,
///     lifetime counter — recorded from the MEASURED spend, not the claimed one.
///
/// This is PLAN.md §5.6's re-anchoring executed literally: from "this pool"
/// to "this mint, this destination, this delta".
#[derive(Accounts)]
pub struct Invest<'info> {
    /// The vault's owner, or the keeper the config names. NOT anyone.
    ///
    /// THIS SAID "Anyone" AND MEANT IT, and that was wrong for the same reason
    /// it was wrong on convert and wrap_sol: the route lives in
    /// `remaining_accounts`, so a caller who is also the liquidity provider on
    /// that route sets both sides of the trade. The owner-signed floor bounds
    /// the loss per call but does not prevent it — a stranger could spend the
    /// vault's staged USDC at the floor, pocket the spread in their own pool,
    /// and burn the vault's 30-day allowance doing it, which stops the real
    /// keeper from investing at all. Constraining convert and wrap_sol while
    /// leaving this open also made the keeper panic switch a half-measure: a
    /// suspected keeper key, disarmed in the config, could still call this.
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
        mut,
        seeds = [b"invest", vault.key().as_ref()],
        bump = policy.bump,
        constraint = policy.vault == vault.key() @ NuvemError::InvalidPolicy,
    )]
    pub policy: Box<Account<'info, InvestmentPolicy>>,

    /// The vault's in-asset account. The venue pulls from it under the vault
    /// PDA's CPI signature; the measured delta bounds how much. Its mint is
    /// pinned, or the caps and floors, written in the in-asset, would meter
    /// whatever else the vault holds, another leg's shares included.
    #[account(
        mut,
        constraint = vault_in.owner == vault.key() @ NuvemError::InvalidPolicy,
        constraint = vault_in.mint == policy.in_mint @ NuvemError::WrongInMint,
    )]
    pub vault_in: Box<InterfaceAccount<'info, TokenAccount>>,

    /// The vault's token account for the TARGET mint — where the fill lands
    /// and is measured. Its authority must be the vault, or the "purchase"
    /// lands somewhere the vault cannot withdraw from.
    #[account(
        mut,
        constraint = vault_target.owner == vault.key() @ NuvemError::InvalidPolicy,
        constraint = vault_target.mint == target_mint.key() @ NuvemError::InvalidPolicy,
    )]
    pub vault_target: Box<InterfaceAccount<'info, TokenAccount>>,

    pub target_mint: Box<InterfaceAccount<'info, Mint>>,

    /// CHECK: pinned byte-for-byte against policy.venue_program below.
    pub venue_program: UncheckedAccount<'info>,
    // remaining_accounts: the venue's account list, in the venue's order. The
    // vault PDA may appear anywhere in it and is the only key this program
    // will mark as a CPI signer.
}

pub fn invest_handler(
    ctx: Context<Invest>,
    leg_index: u8,
    amount_in: u64,
    min_out: u64,
    venue_data: Vec<u8>,
) -> Result<()> {
    let vault = &ctx.accounts.vault;
    let policy = &ctx.accounts.policy;

    // BEFORE ANY MONEY MOVES, and the same check convert and wrap_sol make.
    require!(
        ctx.accounts
            .config
            .may_crank(&vault.owner, &ctx.accounts.crank.key()),
        NuvemError::UnauthorizedCrank
    );
    require!(!vault.paused, NuvemError::VaultPaused);
    require!(!ctx.accounts.config.paused, NuvemError::ProtocolPaused);
    require!(policy.enabled, NuvemError::InvestingDisabled);
    require!(
        ctx.accounts.venue_program.key() == policy.venue_program,
        NuvemError::WrongVenue
    );

    let leg = policy
        .legs
        .get(usize::from(leg_index))
        .ok_or(NuvemError::InvalidPolicy)?;
    require!(
        ctx.accounts.vault_target.mint == leg.mint,
        NuvemError::InvalidPolicy
    );

    // RH's exact envelope, checked against the CLAIMED amount (the upper
    // bound); the buckets below record the MEASURED spend.
    require!(amount_in >= policy.min_investment, NuvemError::BelowMinimum);
    require!(amount_in <= policy.max_per_call, NuvemError::AboveMaximum);
    let today = u32::try_from(Clock::get()?.unix_timestamp / 86_400)
        .map_err(|_| NuvemError::InvalidPolicy)?;
    require!(
        policy.rolling_total(today).saturating_add(amount_in) <= policy.max_rolling_30d,
        NuvemError::RollingCapExhausted
    );

    // The user's own floor: the crank's min_out may be tighter, never looser.
    let floor = u64::try_from(
        u128::from(amount_in).saturating_mul(leg.min_out_rate_wad) / 1_000_000_000_000_000_000u128,
    )
    .map_err(|_| NuvemError::InvalidPolicy)?;
    require!(min_out >= floor && min_out > 0, NuvemError::FloorTooLow);

    let in_before = ctx.accounts.vault_in.amount;
    let target_before = ctx.accounts.vault_target.amount;

    // The CPI. Metas mirror the caller's remaining accounts exactly —
    // writability included — except that ONLY the vault PDA is ever marked as
    // a signer, which is the entire authority this program lends the route.
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

    // THE DELTAS ARE THE ONLY TRUTH. Both accounts reload; a venue that
    // overdrew or underfilled unwinds everything, spend included.
    ctx.accounts.vault_in.reload()?;
    ctx.accounts.vault_target.reload()?;
    let spent = in_before.saturating_sub(ctx.accounts.vault_in.amount);
    require!(spent <= amount_in, NuvemError::Overspent);
    let received = ctx
        .accounts
        .vault_target
        .amount
        .checked_sub(target_before)
        .ok_or(NuvemError::FillTooSmall)?;
    require!(received >= min_out, NuvemError::FillTooSmall);

    let policy = &mut ctx.accounts.policy;
    policy.record(today, spent);
    policy.lifetime_invested = policy
        .lifetime_invested
        .checked_add(spent)
        .ok_or(NuvemError::InvalidPolicy)?;

    Ok(())
}
