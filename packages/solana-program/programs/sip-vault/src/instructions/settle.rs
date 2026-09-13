use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar::instructions::{
    load_current_index_checked, load_instruction_at_checked,
};
use anchor_lang::system_program::{transfer, Transfer};

use crate::attestation::{attestation_message, AttestationInputs, ATTESTATION_MESSAGE_LEN};

/// Ed25519SigVerify111111111111111111111111111 — the native precompile's id,
/// declared here because this anchor version does not re-export the module.
const ED25519_PROGRAM_ID: Pubkey = pubkey!("Ed25519SigVerify111111111111111111111111111");
use crate::errors::NuvemError;
use crate::events::Settled;
use crate::state::{ProtocolConfig, TradingLink, Vault};

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
/// handler rejects the mismatch.
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
    let active_mode = vault.skim_mode;
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
    });
    Ok(())
}

/// Proves the instruction immediately before this one is an Ed25519SigVerify
/// of exactly `expected_message` by exactly `expected_signer`.
///
/// THE OFFSET FIELDS ARE HOSTILE INPUT. The Ed25519 program verifies whatever
/// the offsets point at — including bytes in ANOTHER instruction — and a
/// forged offset table was a real, responsibly-disclosed bypass elsewhere. So
/// every offset is required to point into the Ed25519 instruction's own data,
/// at exactly the widths expected, before any byte is compared.
fn verify_preceding_ed25519(
    instructions_sysvar: &UncheckedAccount,
    expected_signer: &Pubkey,
    expected_message: &[u8; ATTESTATION_MESSAGE_LEN],
) -> Result<()> {
    let current_index = load_current_index_checked(instructions_sysvar)?;
    require!(current_index > 0, NuvemError::AttestationMissing);
    let ed25519_index = usize::from(current_index - 1);
    let instruction = load_instruction_at_checked(ed25519_index, instructions_sysvar)?;

    require!(
        instruction.program_id == ED25519_PROGRAM_ID,
        NuvemError::AttestationMissing
    );

    let data = instruction.data;
    // Header: count (u8), padding (u8), then one 14-byte offsets struct.
    require!(data.len() >= 16, NuvemError::AttestationMalformed);
    require!(data[0] == 1, NuvemError::AttestationMalformed);

    let u16_at = |offset: usize| -> u16 {
        u16::from_le_bytes([data[offset], data[offset + 1]])
    };
    let signature_offset = usize::from(u16_at(2));
    let signature_ix_index = u16_at(4);
    let public_key_offset = usize::from(u16_at(6));
    let public_key_ix_index = u16_at(8);
    let message_offset = usize::from(u16_at(10));
    let message_size = usize::from(u16_at(12));
    let message_ix_index = u16_at(14);

    // Every reference must be to THIS instruction — u16::MAX is the runtime's
    // "current instruction" sentinel, and the explicit index is also accepted.
    let this_ix = u16::try_from(ed25519_index).map_err(|_| NuvemError::AttestationMalformed)?;
    for ix_ref in [signature_ix_index, public_key_ix_index, message_ix_index] {
        require!(
            ix_ref == u16::MAX || ix_ref == this_ix,
            NuvemError::AttestationMalformed
        );
    }

    require!(
        public_key_offset + 32 <= data.len()
            && signature_offset + 64 <= data.len()
            && message_offset + message_size <= data.len(),
        NuvemError::AttestationMalformed
    );

    let public_key = &data[public_key_offset..public_key_offset + 32];
    require!(
        public_key == expected_signer.as_ref(),
        NuvemError::WrongAttester
    );

    let message = &data[message_offset..message_offset + message_size];
    require!(
        message == expected_message.as_ref(),
        NuvemError::AttestationMismatch
    );

    Ok(())
}
