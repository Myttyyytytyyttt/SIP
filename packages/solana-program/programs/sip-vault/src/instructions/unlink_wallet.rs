use anchor_lang::prelude::*;

use crate::errors::NuvemError;
use crate::state::{TradingLink, Vault};

/// Removes a trading wallet's link, closing the account.
///
/// THE OWNER ALONE UNLINKS. This once accepted either signer, the owner cutting
/// a wallet loose or the wallet removing itself, so that neither was held
/// hostage by the other. But the wallet's key is also held by a Privy seat,
/// under a policy that can match nothing finer than this program's id. A seat
/// that could free its wallet could then co-sign a link to a vault of an
/// attacker's choosing: every later settlement paid there, and with the attester
/// key as well, the wallet's whole balance. The owner is the pension key no seat
/// ever holds. A user who wants a wallet to stop saving without that key removes
/// the seat in Privy, which stops the keeper settling it.
///
/// The account is CLOSED, not flagged inactive. Closing frees the ["link",
/// wallet] address so the wallet can link elsewhere — and destroys the nonce
/// and frontier with it, which is safe because `epoch` (the creation slot) is
/// part of every attestation: a re-created link cannot replay its past life's
/// attestations even though its counters restart. See state.rs.
#[derive(Accounts)]
pub struct UnlinkWallet<'info> {
    /// The vault's owner, and nobody else: not the linked wallet, whose key a
    /// Privy seat holds.
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
    require!(
        ctx.accounts.authority.key() == ctx.accounts.vault.owner,
        NuvemError::UnlinkUnauthorized
    );
    Ok(())
}
