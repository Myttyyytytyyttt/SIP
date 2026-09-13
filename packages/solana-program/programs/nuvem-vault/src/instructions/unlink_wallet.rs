use anchor_lang::prelude::*;

use crate::errors::NuvemError;
use crate::state::{TradingLink, Vault};

/// Removes a trading wallet's link, closing the account.
///
/// ONE `authority` SIGNER, TWO PEOPLE IT MAY BE: the vault owner cutting a
/// wallet loose, or the wallet removing itself. Neither is held hostage by the
/// other. Both identities are already stored on chain (vault.owner and
/// trading_link.wallet), so the instruction needs one signature checked against
/// either — not two optional signers, which Anchor clients cannot express.
///
/// The account is CLOSED, not flagged inactive. Closing frees the ["link",
/// wallet] address so the wallet can link elsewhere — and destroys the nonce
/// and frontier with it, which is safe because `epoch` (the creation slot) is
/// part of every attestation: a re-created link cannot replay its past life's
/// attestations even though its counters restart. See state.rs.
#[derive(Accounts)]
pub struct UnlinkWallet<'info> {
    pub authority: Signer<'info>,

    /// CHECK: only a lamport destination — the rent goes back to whoever paid
    /// for the link account, which was the vault owner at link time. Pinned to
    /// vault.owner by the address constraint; no data is read or written.
    #[account(mut, address = vault.owner @ NuvemError::NotOwner)]
    pub owner: UncheckedAccount<'info>,

    #[account(
        seeds = [b"vault", vault.owner.as_ref()],
        bump = vault.bump,
        constraint = trading_link.vault == vault.key() @ NuvemError::LinkVaultMismatch,
    )]
    pub vault: Account<'info, Vault>,

    // The seeds come from the link's own stored wallet, so the caller cannot
    // point this at a link account forged under different seeds.
    #[account(
        mut,
        close = owner,
        seeds = [b"link", trading_link.wallet.as_ref()],
        bump = trading_link.bump,
    )]
    pub trading_link: Account<'info, TradingLink>,
}

pub fn unlink_wallet_handler(ctx: Context<UnlinkWallet>) -> Result<()> {
    let who = ctx.accounts.authority.key();
    require!(
        who == ctx.accounts.vault.owner || who == ctx.accounts.trading_link.wallet,
        NuvemError::UnlinkUnauthorized
    );
    Ok(())
}
