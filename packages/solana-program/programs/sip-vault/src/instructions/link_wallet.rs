use anchor_lang::prelude::*;

use crate::state::{TradingLink, Vault};

/// Links a trading wallet to a vault.
///
/// BOTH PARTIES SIGN THE SAME TRANSACTION. On the EVM side this is a dance —
/// inviteTradingAccount, an EIP-712 AcceptTradingAccount signature, then
/// acceptTradingAccountBySig — because one transaction has one sender. A Solana
/// transaction carries any number of signers, so the invite/accept pair
/// collapses into a single instruction that simply requires both.
///
/// "One wallet, one vault" needs no check at all: the link account's address is
/// derived from the wallet alone, so a second link for the same wallet fails at
/// `init` because the account already exists.
#[derive(Accounts)]
pub struct LinkWallet<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    /// The trading wallet consents by signing; nobody can be linked to a vault
    /// against their will, and no vault owner can claim a wallet they don't
    /// control.
    pub wallet: Signer<'info>,

    #[account(
        seeds = [b"vault", owner.key().as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, Vault>,

    #[account(
        init,
        payer = owner,
        space = 8 + TradingLink::INIT_SPACE,
        seeds = [b"link", wallet.key().as_ref()],
        bump,
    )]
    pub trading_link: Account<'info, TradingLink>,

    pub system_program: Program<'info, System>,
}

pub fn link_wallet_handler(ctx: Context<LinkWallet>) -> Result<()> {
    let link = &mut ctx.accounts.trading_link;
    link.wallet = ctx.accounts.wallet.key();
    link.vault = ctx.accounts.vault.key();
    // The slot of birth. Attestations sign it, so a link that is closed and
    // re-created — same wallet, same vault, nonce back at zero — still rejects
    // every attestation from its previous life.
    link.epoch = Clock::get()?.slot;
    link.settlement_nonce = 0;
    link.frontier_slot = 0;
    link.bump = ctx.bumps.trading_link;

    Ok(())
}
