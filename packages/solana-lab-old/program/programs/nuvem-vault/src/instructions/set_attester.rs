use anchor_lang::prelude::*;

use crate::state::ProtocolConfig;

/// Replaces the Ed25519 key `settle` demands attestations from.
///
/// WHY IT EXISTS: BECAUSE IT DID NOT. `init_config` fixed the attester once and
/// nothing could ever change it, so the day that key leaked — and it did, on
/// 2026-08-27, pasted into a chat window — the only remedies were to abandon
/// the program id or to keep signing with a key the world could sign with too.
/// A signing identity with no rotation path is not a security control, it is a
/// countdown. Every long-lived key needs this instruction on the day it is
/// created, not on the day it is lost.
///
/// WHAT ROTATION DOES AND DOES NOT INVALIDATE. Settlements already recorded are
/// untouched: `settle` verifies against whatever the config holds AT THE TIME,
/// and each link's `frontier_slot` and `settlement_nonce` have already advanced.
/// What stops working is any attestation signed by the old key and not yet
/// submitted — which is the point.
///
/// A ZERO ATTESTER IS REFUSED. `Pubkey::default()` is not a valid Ed25519
/// public key, so accepting it would leave `settle` permanently unverifiable
/// with no way to tell that from a misconfiguration. Unlike `set_keeper`, where
/// the default usefully means "nobody", here it would only mean "broken".
#[derive(Accounts)]
pub struct SetAttester<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [b"config"],
        bump = config.bump,
        has_one = authority,
    )]
    pub config: Account<'info, ProtocolConfig>,
}

pub fn set_attester_handler(ctx: Context<SetAttester>, attester: Pubkey) -> Result<()> {
    require!(attester != Pubkey::default(), crate::errors::NuvemError::InvalidPolicy);
    ctx.accounts.config.attester = attester;
    Ok(())
}
