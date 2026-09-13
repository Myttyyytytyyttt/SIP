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
    session_start_slot: u64,
    session_end_slot: u64,
    profit_lamports: u64,
) -> Result<()> {
    let vault = &ctx.accounts.vault;
    let link = &ctx.accounts.trading_link;

    require!(!vault.paused, NuvemError::VaultPaused);
    require!(!ctx.accounts.config.paused, NuvemError::ProtocolPaused);
    require!(profit_lamports > 0, NuvemError::ZeroAmount);

    // THE SESSION WINDOW MUST SIT ENTIRELY ABOVE THE FRONTIER. Overlapping
    // windows are how one profitable stretch gets settled twice; the watermark
    // plus strict ordering replaces the EVM's usedSessions set.
    require!(
        session_start_slot >= link.frontier_slot && session_end_slot > session_start_slot,
        NuvemError::InvalidSessionWindow
    );
    // A session that has not finished yet cannot have been measured.
    require!(
        session_end_slot <= Clock::get()?.slot,
        NuvemError::InvalidSessionWindow
    );

    // The expected message, from CHAIN STATE plus the args. A signature over
    // anything else — another wallet, another vault, a spent nonce, a previous
    // link epoch, a different profit — is a different byte string and fails
    // the comparison below.
    let expected = attestation_message(&AttestationInputs {
        program_id: crate::ID,
        wallet: ctx.accounts.wallet.key(),
        vault: vault.key(),
        link_epoch: link.epoch,
        settlement_nonce: link.settlement_nonce,
        session_start_slot,
        session_end_slot,
        profit_lamports,
    });

    verify_preceding_ed25519(
        &ctx.accounts.instructions_sysvar,
        &ctx.accounts.config.attester,
        &expected,
    )?;

    // The share, floored. u128 keeps profit * bps out of overflow territory.
    let contribution =
        u64::try_from(u128::from(profit_lamports) * u128::from(vault.skim_bps) / 10_000)
            .map_err(|_| NuvemError::ZeroAmount)?;
    require!(contribution > 0, NuvemError::ZeroAmount);

    // The wallet signed this transaction, so its signer privilege flows through
    // the CPI: the system program sees a transfer authorised by its owner.
    transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            Transfer {
                from: ctx.accounts.wallet.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
            },
        ),
        contribution,
    )?;

    let vault = &mut ctx.accounts.vault;
    let link = &mut ctx.accounts.trading_link;
    vault.lifetime_saved = vault
        .lifetime_saved
        .checked_add(contribution)
        .ok_or(NuvemError::ZeroAmount)?;
    link.settlement_nonce += 1;
    link.frontier_slot = session_end_slot;

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
