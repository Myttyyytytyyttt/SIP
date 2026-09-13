// The settlement attestation: what the attester signs, byte for byte.
//
// THE MESSAGE IS RECONSTRUCTED FROM CHAIN STATE, NOT TRUSTED FROM ARGS. The
// caller supplies the window, the measured base and a deadline; the wallet,
// vault, link epoch, nonce, MODE, RATE and POLICY NONCE come from the accounts
// settle_v2() is looking at. A signature therefore only verifies for this wallet,
// this vault, the link's current epoch and nonce, and the vault's current mode,
// rate and policy -- replay, cross-wallet reuse, stale-epoch reuse, a
// profit-for-volume swap and a policy change in flight all collapse into one
// byte comparison failing.
//
// V2 EXISTS BECAUSE V1 SIGNED A NUMBER WITH NO MEANING. V1 carried the measured
// amount but not what it measured, so a volume figure could be charged at a
// profit rate. The domain tag changed too, so no V1 signature can verify here.
//
// FIXED CONCATENATION, NOT BORSH, integers little-endian. The keeper builds the
// same bytes in TypeScript; both are pinned to the golden vector in the tests
// below, which was computed independently of this file.

use anchor_lang::prelude::*;

pub const ATTESTATION_DOMAIN: &[u8; 16] = b"SIP_SETTLE_V2\0\0\0";

/// domain 16 · program, wallet, vault 32×3 · epoch, nonce, start, end, base 8×5
/// · mode 1 · bps 2 · policy_nonce 8 · valid_until_slot 8
pub const ATTESTATION_MESSAGE_LEN: usize = 16 + 32 * 3 + 8 * 5 + 1 + 2 + 8 + 8;

pub struct AttestationInputs {
    pub program_id: Pubkey,
    pub wallet: Pubkey,
    pub vault: Pubkey,
    pub link_epoch: u64,
    pub settlement_nonce: u64,
    pub session_start_slot: u64,
    pub session_end_slot: u64,
    /// Profit in PROFIT mode, notional in VOLUME mode; `mode` says which.
    pub base_lamports: u64,
    pub mode: u8,
    /// The rate of `mode`, as the vault holds it.
    pub bps: u16,
    pub policy_nonce: u64,
    pub valid_until_slot: u64,
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
    put(&mut message, &mut cursor, &inputs.base_lamports.to_le_bytes());
    put(&mut message, &mut cursor, &[inputs.mode]);
    put(&mut message, &mut cursor, &inputs.bps.to_le_bytes());
    put(&mut message, &mut cursor, &inputs.policy_nonce.to_le_bytes());
    put(&mut message, &mut cursor, &inputs.valid_until_slot.to_le_bytes());
    debug_assert_eq!(cursor, ATTESTATION_MESSAGE_LEN);
    message
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Computed with Python's struct.pack from the inputs below, not by this code.
    const GOLDEN_V2_HEX: &str = "5349505f534554544c455f5632000000010101010101010101010101010101010101010101010101010101010101010102020202020202020202020202020202020202020202020202020202020202020303030303030303030303030303030303030303030303030303030303030303080706050403020109000000000000006400000000000000c80000000000000000ca9a3b0000000001140003000000000000002c01000000000000";

    fn unhex(s: &str) -> Vec<u8> {
        (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
    }

    #[test]
    fn v2_message_matches_the_independently_computed_golden_vector() {
        let message = attestation_message(&AttestationInputs {
            program_id: Pubkey::new_from_array([1; 32]),
            wallet: Pubkey::new_from_array([2; 32]),
            vault: Pubkey::new_from_array([3; 32]),
            link_epoch: 0x0102_0304_0506_0708,
            settlement_nonce: 9,
            session_start_slot: 100,
            session_end_slot: 200,
            base_lamports: 1_000_000_000,
            mode: 1,
            bps: 20,
            policy_nonce: 3,
            valid_until_slot: 300,
        });
        assert_eq!(message.len(), 171);
        assert_eq!(message.to_vec(), unhex(GOLDEN_V2_HEX));
    }
}
