use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};

use crate::attestation::{attestation_message, AttestationInputs};
use crate::ed25519_introspection::{verify_preceding_ed25519, Ed25519Refusals};
use crate::errors::NuvemError;
use crate::events::Settled;
use crate::state::{ProtocolConfig, TradingLink, Vault};

/// settle's name for each way the attestation check can fail. They are the
/// names settle always gave, and clients match on them: moving the reader into
/// a module link_wallet shares must not rename a single refusal.
const ATTESTATION_REFUSALS: Ed25519Refusals = Ed25519Refusals {
    missing: NuvemError::AttestationMissing,
    malformed: NuvemError::AttestationMalformed,
    wrong_signer: NuvemError::WrongAttester,
    mismatch: NuvemError::AttestationMismatch,
};

/// Settles one attested trading session: moves the vault's share of the
/// session's profit from the trading wallet into the vault.
///
/// THE WALLET PUSHES. `wallet` signs this transaction (via Privy in
/// production, via a keypair in the drill), exactly like the EVM side where
/// settle()'s msg.sender IS the trading account. The program never holds a
/// delegation over the wallet; its authority to move the contribution is the
/// wallet's own signature on this very transaction.
///
/// THE SIGNATURE IS VERIFIED BY THE ED25519 PROGRAM, NOT HERE. Precompiles are
/// not callable via CPI, so the transaction carries an Ed25519SigVerify
/// instruction IMMEDIATELY BEFORE this one, and this handler proves — through
/// the instructions sysvar — that the instruction exists, verified exactly one
/// signature, by the configured attester, over exactly the message this
/// handler reconstructs from chain state. If any of that fails the runtime
/// already rejected the transaction (a bad signature never reaches us) or this
/// handler rejects the mismatch. The reader lives in ed25519_introspection.rs.
#[derive(Accounts)]
pub struct Settle<'info> {
    /// The trading wallet: signer AND payer of the contribution.
    #[account(mut)]
    pub wallet: Signer<'info>,

    #[account(
        mut,
        seeds = [b"vault", vault.owner.as_ref()],
        bump = vault.bump,
        constraint = trading_link.vault == vault.key() @ NuvemError::LinkVaultMismatch,
    )]
    pub vault: Account<'info, Vault>,

    #[account(
        mut,
        seeds = [b"link", wallet.key().as_ref()],
        bump = trading_link.bump,
    )]
    pub trading_link: Account<'info, TradingLink>,

    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, ProtocolConfig>,

    /// CHECK: pinned to the instructions sysvar by address; read-only
    /// introspection of this very transaction.
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions_sysvar: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn settle_handler(
    ctx: Context<Settle>,
    mode: u8,
    session_start_slot: u64,
    session_end_slot: u64,
    base_lamports: u64,
    valid_until_slot: u64,
) -> Result<()> {
    let vault = &ctx.accounts.vault;
    let link = &ctx.accounts.trading_link;
    let wallet_key = ctx.accounts.wallet.key();

    require!(!vault.paused, NuvemError::VaultPaused);
    require!(!ctx.accounts.config.paused, NuvemError::ProtocolPaused);

    // BY NAME BEFORE BY BYTES. The byte comparison below refuses a mismatched
    // mode anyway; this makes the refusal say what is actually wrong.
    require!(mode == vault.skim_mode, NuvemError::SkimModeMismatch);

    let now = Clock::get()?.slot;
    // An attestation is a statement about a moment. One left unsubmitted past
    // its deadline is measured again, not replayed.
    require!(now <= valid_until_slot, NuvemError::AttestationExpired);

    // THE SESSION WINDOW MUST SIT ENTIRELY ABOVE THE FRONTIER, and must have
    // closed: overlapping windows are how one stretch gets settled twice.
    require!(
        session_start_slot >= link.frontier_slot && session_end_slot > session_start_slot,
        NuvemError::InvalidSessionWindow
    );
    require!(session_end_slot <= now, NuvemError::InvalidSessionWindow);

    // THE MEANING OF THE NUMBER IS IN THE SIGNED BYTES. The old settle
    // multiplied whatever u64 it was handed by whatever bps the vault held, so
    // a volume figure could be charged at a profit rate: 100x. Here the mode,
    // the rate of that mode and the policy nonce are read from the owner-signed
    // vault and rebuilt into the message, so an attestation made for another
    // mode, another rate or an older policy is a different byte string.
    let bps = vault.active_bps();
    let expected = attestation_message(&AttestationInputs {
        program_id: crate::ID,
        wallet: wallet_key,
        vault: vault.key(),
        link_epoch: link.epoch,
        settlement_nonce: link.settlement_nonce,
        session_start_slot,
        session_end_slot,
        base_lamports,
        mode: vault.skim_mode,
        bps,
        policy_nonce: vault.policy_nonce,
        valid_until_slot,
    });
    verify_preceding_ed25519(
        &ctx.accounts.instructions_sysvar,
        &ctx.accounts.config.attester,
        &expected,
        &ATTESTATION_REFUSALS,
    )?;

    // What the window owes, floored. bps <= 10_000, so it never exceeds base.
    let owed = u64::try_from(u128::from(base_lamports) * u128::from(bps) / 10_000)
        .map_err(|_| NuvemError::InvalidPolicy)?;

    // THE CAP CLIPS. It is the owner's ceiling on one pull, so an owed amount
    // above it is paid up to it and the difference shows in `Settled`; it is
    // not carried on chain yet.
    let paid = owed.min(vault.max_contribution);

    // A ZERO SETTLEMENT STILL COUNTS. A zero base, or one that floors to zero,
    // moves nothing and still advances the frontier below, so a quiet or losing
    // wallet can never wedge its link the way the old program's did.
    if paid > 0 {
        // THE RESERVE REFUSES. It is the trader's fee money, so a payment that
        // would dip into it -- or into the wallet's own rent floor -- is not
        // trimmed but refused: the frontier stays put, and the keeper settles a
        // longer window once the wallet is funded again.
        let wallet_floor = Rent::get()?.minimum_balance(0).saturating_add(vault.wallet_reserve);
        let left = ctx.accounts.wallet.lamports().checked_sub(paid);
        require!(left.is_some_and(|left| left >= wallet_floor), NuvemError::WalletBelowReserve);

        // The wallet signed this transaction, so its signer privilege flows
        // through the CPI: the system program sees a transfer by its owner.
        transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.wallet.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                },
            ),
            paid,
        )?;
    }

    let nonce = link.settlement_nonce;
    let link_epoch = link.epoch;
    let active_mode = vault.skim_mode;
    let policy_nonce = vault.policy_nonce;
    let vault_key = vault.key();

    let vault = &mut ctx.accounts.vault;
    vault.lifetime_saved = vault.lifetime_saved.checked_add(paid).ok_or(NuvemError::InvalidPolicy)?;
    let link = &mut ctx.accounts.trading_link;
    link.settlement_nonce = nonce.checked_add(1).ok_or(NuvemError::InvalidPolicy)?;
    link.frontier_slot = session_end_slot;

    emit!(Settled {
        vault: vault_key,
        wallet: wallet_key,
        mode: active_mode,
        base_lamports,
        bps,
        owed,
        paid,
        settlement_nonce: nonce,
        session_end_slot,
        link_epoch,
        session_start_slot,
        policy_nonce,
    });
    Ok(())
}
