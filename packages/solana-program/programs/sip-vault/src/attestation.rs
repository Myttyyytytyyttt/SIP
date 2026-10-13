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

// ── V3: the per-trade modes (ROUND-UP = 2, FIXED = 3), settle_v3 ────────────
//
// V3 SIGNS WHAT A PER-TRADE AMOUNT MEANS. A round-up amount is a number of
// counted trades rounded at a price, so the count, the lowest price used and a
// hash of every (signature, price) pair are in the bytes, with the unit (or F)
// and the minimum trade the vault's PerTradePolicy holds. Rebuilt from chain
// state, never taken from the caller: program, wallet, vault, link epoch and
// nonce, mode, policy nonce, mode_param and min_trade. A NEW DOMAIN, so no V2
// signature can ever verify as V3 or the other way round.
//
// The same discipline as V2: fixed concatenation, integers little-endian, and
// a golden vector computed with Python's struct.pack, not by either mirror.

pub const ATTESTATION_V3_DOMAIN: &[u8; 16] = b"SIP_SETTLE_V3\0\0\0";

/// domain 16 · program, wallet, vault 32×3 · epoch, nonce, start, end, amount 8×5
/// · mode 1 · policy_nonce 8 · valid_until_slot 8 · trade_count 4
/// · price_min_usd_e6 8 · mode_param 8 · min_trade 8 · prices_hash 32
pub const ATTESTATION_V3_MESSAGE_LEN: usize = 16 + 32 * 3 + 8 * 5 + 1 + 8 + 8 + 4 + 8 + 8 + 8 + 32;

pub struct AttestationV3Inputs {
    pub program_id: Pubkey,
    pub wallet: Pubkey,
    pub vault: Pubkey,
    pub link_epoch: u64,
    pub settlement_nonce: u64,
    pub session_start_slot: u64,
    pub session_end_slot: u64,
    /// What the window owes, lamports, BEFORE any cap: Σ per-trade round-ups,
    /// or trade_count × F.
    pub amount_lamports: u64,
    pub mode: u8,
    pub policy_nonce: u64,
    pub valid_until_slot: u64,
    pub trade_count: u32,
    /// ROUND-UP: the lowest SOL/USD price used for any trade in the window,
    /// micro-dollars per SOL. FIXED: 0.
    pub price_min_usd_e6: u64,
    /// ROUND-UP: roundup_unit_cents. FIXED: fixed_lamports. Widened to u64.
    pub mode_param: u64,
    /// ROUND-UP: min_trade_cents. FIXED: min_trade_lamports. Widened to u64.
    pub min_trade: u64,
    /// ROUND-UP: sha256 over (signature 64 ‖ price_usd_e6 u64 LE) of every
    /// counted trade in ascending (slot, signature bytes) order. FIXED: zeros.
    pub prices_hash: [u8; 32],
}

fn put_v3(message: &mut [u8; ATTESTATION_V3_MESSAGE_LEN], cursor: &mut usize, bytes: &[u8]) {
    message[*cursor..*cursor + bytes.len()].copy_from_slice(bytes);
    *cursor += bytes.len();
}

pub fn attestation_v3_message(inputs: &AttestationV3Inputs) -> [u8; ATTESTATION_V3_MESSAGE_LEN] {
    let mut message = [0u8; ATTESTATION_V3_MESSAGE_LEN];
    let mut cursor = 0usize;
    put_v3(&mut message, &mut cursor, ATTESTATION_V3_DOMAIN);
    put_v3(&mut message, &mut cursor, inputs.program_id.as_ref());
    put_v3(&mut message, &mut cursor, inputs.wallet.as_ref());
    put_v3(&mut message, &mut cursor, inputs.vault.as_ref());
    put_v3(&mut message, &mut cursor, &inputs.link_epoch.to_le_bytes());
    put_v3(&mut message, &mut cursor, &inputs.settlement_nonce.to_le_bytes());
    put_v3(&mut message, &mut cursor, &inputs.session_start_slot.to_le_bytes());
    put_v3(&mut message, &mut cursor, &inputs.session_end_slot.to_le_bytes());
    put_v3(&mut message, &mut cursor, &inputs.amount_lamports.to_le_bytes());
    put_v3(&mut message, &mut cursor, &[inputs.mode]);
    put_v3(&mut message, &mut cursor, &inputs.policy_nonce.to_le_bytes());
    put_v3(&mut message, &mut cursor, &inputs.valid_until_slot.to_le_bytes());
    put_v3(&mut message, &mut cursor, &inputs.trade_count.to_le_bytes());
    put_v3(&mut message, &mut cursor, &inputs.price_min_usd_e6.to_le_bytes());
    put_v3(&mut message, &mut cursor, &inputs.mode_param.to_le_bytes());
    put_v3(&mut message, &mut cursor, &inputs.min_trade.to_le_bytes());
    put_v3(&mut message, &mut cursor, &inputs.prices_hash);
    debug_assert_eq!(cursor, ATTESTATION_V3_MESSAGE_LEN);
    message
}

/// settle_v3 takes prices_hash as four u64 arguments, because the keeper's
/// Privy policy accepts primitive arguments only. Word i is bytes 8i..8i+8 of
/// the hash, little-endian.
pub fn prices_hash_from_words(words: [u64; 4]) -> [u8; 32] {
    let mut hash = [0u8; 32];
    for (index, word) in words.iter().enumerate() {
        hash[index * 8..index * 8 + 8].copy_from_slice(&word.to_le_bytes());
    }
    hash
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

    /// Computed with Python's struct.pack, not by this code: a ROUND-UP window
    /// of one $1.60 trade at $150 (2_666_666 lamports), unit $1, minimum $1,
    /// prices_hash = sha256([0x11; 64] ‖ 150_000_000 u64 LE).
    const GOLDEN_V3_ROUNDUP_HEX: &str = "5349505f534554544c455f5633000000010101010101010101010101010101010101010101010101010101010101010102020202020202020202020202020202020202020202020202020202020202020303030303030303030303030303030303030303030303030303030303030303080706050403020109000000000000006400000000000000c800000000000000aab02800000000000203000000000000002c010000000000000100000080d1f0080000000064000000000000006400000000000000e90d52c052eaaf5aa44d9c0126c3c197e300064f4840256b1a3e13cce8182383";

    /// Computed the same way: a FIXED window of 7 trades at F = 1_000_000,
    /// minimum 0.01 SOL, no price, a zero hash.
    const GOLDEN_V3_FIXED_HEX: &str = "5349505f534554544c455f5633000000010101010101010101010101010101010101010101010101010101010101010102020202020202020202020202020202020202020202020202020202020202020303030303030303030303030303030303030303030303030303030303030303080706050403020109000000000000006400000000000000c800000000000000c0cf6a00000000000303000000000000002c0100000000000007000000000000000000000040420f000000000080969800000000000000000000000000000000000000000000000000000000000000000000000000";

    const PRICES_HASH_ONE_HEX: &str = "e90d52c052eaaf5aa44d9c0126c3c197e300064f4840256b1a3e13cce8182383";

    fn v3_inputs() -> AttestationV3Inputs {
        AttestationV3Inputs {
            program_id: Pubkey::new_from_array([1; 32]),
            wallet: Pubkey::new_from_array([2; 32]),
            vault: Pubkey::new_from_array([3; 32]),
            link_epoch: 0x0102_0304_0506_0708,
            settlement_nonce: 9,
            session_start_slot: 100,
            session_end_slot: 200,
            amount_lamports: 2_666_666,
            mode: 2,
            policy_nonce: 3,
            valid_until_slot: 300,
            trade_count: 1,
            price_min_usd_e6: 150_000_000,
            mode_param: 100,
            min_trade: 100,
            prices_hash: unhex(PRICES_HASH_ONE_HEX).try_into().unwrap(),
        }
    }

    #[test]
    fn v3_roundup_message_matches_the_independently_computed_golden_vector() {
        let message = attestation_v3_message(&v3_inputs());
        assert_eq!(message.len(), 229);
        assert_eq!(ATTESTATION_V3_MESSAGE_LEN, 229);
        assert_eq!(message.to_vec(), unhex(GOLDEN_V3_ROUNDUP_HEX));
    }

    #[test]
    fn v3_fixed_message_matches_the_independently_computed_golden_vector() {
        let message = attestation_v3_message(&AttestationV3Inputs {
            amount_lamports: 7_000_000,
            mode: 3,
            trade_count: 7,
            price_min_usd_e6: 0,
            mode_param: 1_000_000,
            min_trade: 10_000_000,
            prices_hash: [0; 32],
            ..v3_inputs()
        });
        assert_eq!(message.to_vec(), unhex(GOLDEN_V3_FIXED_HEX));
    }

    #[test]
    fn v3_and_v2_never_share_a_prefix_a_signature_could_ride() {
        assert_ne!(ATTESTATION_DOMAIN, ATTESTATION_V3_DOMAIN);
        assert_ne!(ATTESTATION_MESSAGE_LEN, ATTESTATION_V3_MESSAGE_LEN);
    }

    #[test]
    fn prices_hash_words_are_little_endian_eighths_of_the_hash() {
        let hash: [u8; 32] = unhex(PRICES_HASH_ONE_HEX).try_into().unwrap();
        let words = [0, 1, 2, 3].map(|i| u64::from_le_bytes(hash[i * 8..i * 8 + 8].try_into().unwrap()));
        assert_eq!(words[0], 0x5aaf_ea52_c052_0de9);
        assert_eq!(prices_hash_from_words(words), hash);
    }
}
