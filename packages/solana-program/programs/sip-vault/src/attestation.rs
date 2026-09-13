// The settlement attestation: what the attester signs, byte for byte.
//
// THE MESSAGE IS RECONSTRUCTED FROM CHAIN STATE, NOT TRUSTED FROM ARGS. The
// caller supplies only the session window and the profit; the wallet, vault,
// epoch and nonce come from the accounts settle() is looking at. So a signature
// only verifies if the attester signed for THIS wallet, THIS vault, the link's
// CURRENT epoch and its CURRENT nonce — replay, cross-wallet reuse and
// stale-epoch reuse all collapse into one comparison failing.
//
// FIXED CONCATENATION, NOT BORSH. Serialization frameworks change defaults;
// a signed message's layout must never depend on one. Sixteen bytes of domain
// tag, then fields in a fixed order, integers little-endian.
//
// The TypeScript mirror lives in scripts/attestation.ts (the drill and the
// tests build messages with it); the e2e tests are what pin the two together.

use anchor_lang::prelude::*;

/// Domain separator. Versioned so a future layout change cannot make old
/// signatures ambiguous — V2 messages simply never verify against V1 parsers.
pub const ATTESTATION_DOMAIN: &[u8; 16] = b"NUVEM_SETTLE_V1\0";

pub const ATTESTATION_MESSAGE_LEN: usize = 16 + 32 + 32 + 32 + 8 * 5;

pub struct AttestationInputs {
    pub program_id: Pubkey,
    pub wallet: Pubkey,
    pub vault: Pubkey,
    pub link_epoch: u64,
    pub settlement_nonce: u64,
    pub session_start_slot: u64,
    pub session_end_slot: u64,
    pub profit_lamports: u64,
}

fn put(message: &mut [u8; ATTESTATION_MESSAGE_LEN], cursor: &mut usize, bytes: &[u8]) {
    message[*cursor..*cursor + bytes.len()].copy_from_slice(bytes);
    *cursor += bytes.len();
}

pub fn attestation_message(inputs: &AttestationInputs) -> [u8; ATTESTATION_MESSAGE_LEN] {
    let mut message = [0u8; ATTESTATION_MESSAGE_LEN];
    let mut cursor = 0usize;
    put(&mut message, &mut cursor, ATTESTATION_DOMAIN);
    put(&mut message, &mut cursor, inputs.program_id.as_ref());
    put(&mut message, &mut cursor, inputs.wallet.as_ref());
    put(&mut message, &mut cursor, inputs.vault.as_ref());
    put(&mut message, &mut cursor, &inputs.link_epoch.to_le_bytes());
    put(&mut message, &mut cursor, &inputs.settlement_nonce.to_le_bytes());
    put(&mut message, &mut cursor, &inputs.session_start_slot.to_le_bytes());
    put(&mut message, &mut cursor, &inputs.session_end_slot.to_le_bytes());
    put(&mut message, &mut cursor, &inputs.profit_lamports.to_le_bytes());
    debug_assert_eq!(cursor, ATTESTATION_MESSAGE_LEN);
    message
}
