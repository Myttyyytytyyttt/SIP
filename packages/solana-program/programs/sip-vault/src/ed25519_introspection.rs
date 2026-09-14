// Reading back, from inside the program, the Ed25519 signature check that runs
// just before an instruction.
//
// PRECOMPILES ARE NOT CALLABLE VIA CPI. So a transaction carries an
// Ed25519SigVerify instruction IMMEDIATELY BEFORE the instruction that relies
// on it, the runtime verifies the signature before anything executes, and the
// instruction proves through the instructions sysvar that the check it needed
// is the one that ran. settle_v2 relies on it for the attester's signature over
// a measured session; link_wallet for the wallet's own consent to be linked.
//
// ONE READER, SO ITS HARDENING CANNOT DRIFT BETWEEN THEM. Each caller names its
// own refusals: settle's error names predate this module and are part of the
// interface, and a consent problem should not report itself as an attestation.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar::instructions::{
    load_current_index_checked, load_instruction_at_checked,
};

use crate::errors::NuvemError;

/// Ed25519SigVerify111111111111111111111111111 — the native precompile's id,
/// declared here because this anchor version does not re-export the module.
pub const ED25519_PROGRAM_ID: Pubkey = pubkey!("Ed25519SigVerify111111111111111111111111111");

/// The error each way of failing is reported as, chosen by the caller.
pub struct Ed25519Refusals {
    /// No Ed25519SigVerify instruction immediately precedes this one.
    pub missing: NuvemError,
    /// One does, but not in the single-signature, self-contained shape.
    pub malformed: NuvemError,
    /// It verified a signature by another key.
    pub wrong_signer: NuvemError,
    /// It verified other bytes.
    pub mismatch: NuvemError,
}

/// Proves the instruction immediately before this one is an Ed25519SigVerify
/// of exactly `expected_message` by exactly `expected_signer`.
///
/// THE OFFSET FIELDS ARE HOSTILE INPUT. The Ed25519 program verifies whatever
/// the offsets point at — including bytes in ANOTHER instruction — and a
/// forged offset table was a real, responsibly-disclosed bypass elsewhere. So
/// every offset is required to point into the Ed25519 instruction's own data,
/// at exactly the widths expected, before any byte is compared.
pub fn verify_preceding_ed25519(
    instructions_sysvar: &AccountInfo,
    expected_signer: &Pubkey,
    expected_message: &[u8],
    refusals: &Ed25519Refusals,
) -> Result<()> {
    let current_index = load_current_index_checked(instructions_sysvar)?;
    require!(current_index > 0, refusals.missing);
    let ed25519_index = usize::from(current_index - 1);
    let instruction = load_instruction_at_checked(ed25519_index, instructions_sysvar)?;

    require!(instruction.program_id == ED25519_PROGRAM_ID, refusals.missing);

    let data = instruction.data;
    // Header: count (u8), padding (u8), then one 14-byte offsets struct.
    require!(data.len() >= 16, refusals.malformed);
    require!(data[0] == 1, refusals.malformed);

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
    let this_ix = u16::try_from(ed25519_index).map_err(|_| refusals.malformed)?;
    for ix_ref in [signature_ix_index, public_key_ix_index, message_ix_index] {
        require!(ix_ref == u16::MAX || ix_ref == this_ix, refusals.malformed);
    }

    require!(
        public_key_offset + 32 <= data.len()
            && signature_offset + 64 <= data.len()
            && message_offset + message_size <= data.len(),
        refusals.malformed
    );

    let public_key = &data[public_key_offset..public_key_offset + 32];
    require!(public_key == expected_signer.as_ref(), refusals.wrong_signer);

    let message = &data[message_offset..message_offset + message_size];
    require!(message == expected_message, refusals.mismatch);

    Ok(())
}
