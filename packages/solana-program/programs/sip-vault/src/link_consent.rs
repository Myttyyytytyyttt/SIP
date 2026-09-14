// The link consent: what a trading wallet signs, off chain, to be linked.
//
// A TRANSACTION SIGNATURE IS NOT CONSENT ANY MORE. link_wallet used to take the
// wallet's consent as nothing more than its signature on the transaction. In
// production that key is also held by a Privy seat (the keeper's authorization
// key, registered on every trading wallet so it can settle), and Privy's policy
// can match a Solana instruction by its program id alone. A seat allowed to sign
// settle_v2 is therefore allowed to sign link_wallet, and could bind a freshly
// created wallet to a stranger's vault before its user ever linked it. What the
// seat's policy DOES deny is signMessage. So the wallet now also signs these
// bytes, off chain, and the transaction carries them in an Ed25519SigVerify
// instruction immediately before link_wallet.
//
// THE LEAD BYTE IS 0xFF, so these bytes can never be a transaction. A legacy
// message starts with its signer count, whose high bit a deserializer reads as
// the version prefix instead; a versioned one starts with 0x80 | version, and
// there is no version 127. Nothing a seat signs through signAndSendTransaction
// can verify here. It is the lead byte Solana's own off-chain message format
// uses, with a different tag after it.
//
// IT NAMES THE PROGRAM, THE WALLET, THE VAULT AND THE OWNER. A consent given for
// the owner's vault cannot link the wallet to anyone else's, and none crosses to
// another deployment. There is no nonce: replaying a consent can only re-link
// the wallet to the vault it already agreed to, and that still needs the owner's
// own signature on the transaction.
//
// FIXED CONCATENATION, like attestation.rs. The TypeScript mirror is
// scripts/link-consent.ts; both are pinned to the golden vector in the tests
// below, which was computed with Python, not by either mirror.

use anchor_lang::prelude::*;

/// 0xFF, then "SIP_LINK_V1".
pub const LINK_CONSENT_DOMAIN: &[u8; 12] = b"\xffSIP_LINK_V1";

/// domain 12 · program, wallet, vault, owner 32×4
pub const LINK_CONSENT_MESSAGE_LEN: usize = 12 + 32 * 4;

pub struct LinkConsentInputs {
    pub program_id: Pubkey,
    pub wallet: Pubkey,
    pub vault: Pubkey,
    pub owner: Pubkey,
}

pub fn link_consent_message(inputs: &LinkConsentInputs) -> [u8; LINK_CONSENT_MESSAGE_LEN] {
    let mut message = [0u8; LINK_CONSENT_MESSAGE_LEN];
    let mut cursor = 0usize;
    for part in [
        LINK_CONSENT_DOMAIN.as_ref(),
        inputs.program_id.as_ref(),
        inputs.wallet.as_ref(),
        inputs.vault.as_ref(),
        inputs.owner.as_ref(),
    ] {
        message[cursor..cursor + part.len()].copy_from_slice(part);
        cursor += part.len();
    }
    debug_assert_eq!(cursor, LINK_CONSENT_MESSAGE_LEN);
    message
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Computed with Python's bytes concatenation from the inputs below, not by this code.
    const GOLDEN_V1_HEX: &str = "ff5349505f4c494e4b5f56310101010101010101010101010101010101010101010101010101010101010101020202020202020202020202020202020202020202020202020202020202020203030303030303030303030303030303030303030303030303030303030303030404040404040404040404040404040404040404040404040404040404040404";

    fn unhex(s: &str) -> Vec<u8> {
        (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
    }

    #[test]
    fn v1_consent_matches_the_independently_computed_golden_vector() {
        let message = link_consent_message(&LinkConsentInputs {
            program_id: Pubkey::new_from_array([1; 32]),
            wallet: Pubkey::new_from_array([2; 32]),
            vault: Pubkey::new_from_array([3; 32]),
            owner: Pubkey::new_from_array([4; 32]),
        });
        assert_eq!(message.len(), 140);
        // The version-prefix bit is set and 0x7F is no message version, so no
        // deserializer reads these bytes as a transaction.
        assert_eq!(message[0], 0xFF);
        assert_eq!(message.to_vec(), unhex(GOLDEN_V1_HEX));
    }
}
