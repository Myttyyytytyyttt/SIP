use anchor_lang::prelude::*;

use crate::ed25519_introspection::{verify_preceding_ed25519, Ed25519Refusals};
use crate::errors::NuvemError;
use crate::link_consent::{link_consent_message, LinkConsentInputs};
use crate::state::{ProtocolConfig, TradingLink, Vault};

/// link_wallet's name for each way the consent check can fail. The shape
/// refusal is about the Ed25519 instruction itself, not about what it carries,
/// so it is the one settle already uses.
const LINK_CONSENT_REFUSALS: Ed25519Refusals = Ed25519Refusals {
    missing: NuvemError::LinkConsentMissing,
    malformed: NuvemError::AttestationMalformed,
    wrong_signer: NuvemError::LinkConsentWrongSigner,
    mismatch: NuvemError::LinkConsentMismatch,
};

/// Links a trading wallet to a vault.
///
/// BOTH PARTIES SIGN THE SAME TRANSACTION. On the EVM side this is a dance —
/// inviteTradingAccount, an EIP-712 AcceptTradingAccount signature, then
/// acceptTradingAccountBySig — because one transaction has one sender. A Solana
/// transaction carries any number of signers, so the invite/accept pair
/// collapses into a single instruction that simply requires both.
///
/// AND THE WALLET SIGNS ITS CONSENT OFF CHAIN, TOO. Its signature on the
/// transaction proves only that something holding its key signed, and in
/// production a Privy seat holds that key under a policy that can name nothing
/// finer than a program id: whatever lets the seat sign settle_v2 lets it sign
/// this. A seat could then co-sign a stranger's link_wallet for a freshly
/// created wallet before its user linked it, and every later settlement would
/// pay the stranger's vault. So the instruction IMMEDIATELY BEFORE this one must
/// be an Ed25519SigVerify, by the wallet, of the SIP_LINK_V1 message naming this
/// program, this wallet, this vault and this owner (link_consent.rs). The user's
/// own session produces it with signMessage, which the seat's policy denies.
///
/// A WALLET NEVER OWNS THE VAULT IT SAVES INTO. The owner is the pension key a
/// seat never holds; a wallet that were both would let its seat create the
/// vault, link it with no other signature, and then set that vault's policy and
/// crank its funds.
///
/// A PAUSE FREEZES THE LINK GRAPH. Links made while the protocol is paused would
/// otherwise outlive the unpause, a keeper rotation and an attester rotation,
/// and an honest keeper would go on settling into them.
///
/// "One wallet, one vault" needs no check at all: the link account's address is
/// derived from the wallet alone, so a second link for the same wallet fails at
/// `init` because the account already exists.
#[derive(Accounts)]
pub struct LinkWallet<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    /// The trading wallet signs the transaction AND, off chain, its consent,
    /// which the Ed25519 instruction before this one verified. The signature
    /// alone is something a Privy seat can give; the consent is not.
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

    /// Read for its pause switch: nothing links while the protocol is paused.
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, ProtocolConfig>,

    /// CHECK: pinned to the instructions sysvar by address; read-only
    /// introspection of this very transaction.
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions_sysvar: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn link_wallet_handler(ctx: Context<LinkWallet>) -> Result<()> {
    let owner = ctx.accounts.owner.key();
    let wallet = ctx.accounts.wallet.key();
    let vault = ctx.accounts.vault.key();

    require!(owner != wallet, NuvemError::WalletIsOwner);
    require!(!ctx.accounts.config.paused, NuvemError::ProtocolPaused);

    // The consent is rebuilt from the accounts this instruction is looking at,
    // never taken from the caller: a consent for any other vault or owner is a
    // different byte string.
    let expected = link_consent_message(&LinkConsentInputs {
        program_id: crate::ID,
        wallet,
        vault,
        owner,
    });
    verify_preceding_ed25519(
        &ctx.accounts.instructions_sysvar,
        &wallet,
        &expected,
        &LINK_CONSENT_REFUSALS,
    )?;

    let link = &mut ctx.accounts.trading_link;
    link.wallet = wallet;
    link.vault = vault;
    // The slot of birth. Attestations sign it, so a link that is closed and
    // re-created — same wallet, same vault, nonce back at zero — still rejects
    // every attestation from its previous life.
    link.epoch = Clock::get()?.slot;
    link.settlement_nonce = 0;
    link.frontier_slot = 0;
    link.bump = ctx.bumps.trading_link;

    Ok(())
}
