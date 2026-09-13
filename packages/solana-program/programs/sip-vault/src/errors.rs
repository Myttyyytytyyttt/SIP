use anchor_lang::prelude::*;

#[error_code]
pub enum NuvemError {
    /// skim_bps of 0 is the "reachable trap": a vault that is enabled, funded
    /// and saving nothing, with every log line healthy. Refused at the door.
    #[msg("skim_bps (profit rate) must be between 101 and 10000")]
    InvalidSkimBps,

    #[msg("only the vault owner may do this")]
    NotOwner,

    /// Unlink accepts either party: the owner cutting a wallet loose, or the
    /// wallet removing itself. Neither may be forced to keep the other.
    #[msg("neither the vault owner nor the linked wallet signed")]
    UnlinkUnauthorized,

    #[msg("this trading link does not belong to this vault")]
    LinkVaultMismatch,

    /// The withdraw floor: the vault account must stay rent-exempt or the
    /// runtime garbage-collects it, taking the link history's meaning with it.
    #[msg("amount would leave the vault below its rent-exempt minimum")]
    InsufficientVaultBalance,

    /// The token twin of the above. It needs its OWN message: a saver asking
    /// for a stock they do not hold was being told their vault would drop
    /// below "its rent-exempt minimum", which is about lamports and explains
    /// nothing about a token balance.
    #[msg("the vault does not hold that much of this token")]
    InsufficientTokenBalance,

    #[msg("amount must be greater than zero")]
    ZeroAmount,

    #[msg("settle and invest are paused for this vault; withdraw is not")]
    VaultPaused,

    /// The instruction before settle must be an Ed25519SigVerify. Its absence
    /// means the attestation was never checked by anyone.
    #[msg("no Ed25519 verification instruction precedes settle")]
    AttestationMissing,

    /// The offset table is hostile input; anything out of shape is refused
    /// before a single byte is compared.
    #[msg("the Ed25519 instruction is not in the expected single-signature shape")]
    AttestationMalformed,

    #[msg("the attestation is signed by a key that is not the configured attester")]
    WrongAttester,

    /// The verified message differs from the one reconstructed from chain
    /// state: wrong wallet, vault, epoch, nonce, window or profit.
    #[msg("the attested message does not match this settlement")]
    AttestationMismatch,

    #[msg("the session window overlaps settled history or has not closed yet")]
    InvalidSessionWindow,

    #[msg("the investment policy is malformed or does not match these accounts")]
    InvalidPolicy,

    #[msg("investing is not enabled for this vault")]
    InvestingDisabled,

    /// The venue program is pinned in the policy; anything else is a forgery.
    #[msg("this is not the venue program the policy pins")]
    WrongVenue,

    #[msg("amount is below the policy's minimum investment")]
    BelowMinimum,

    #[msg("amount is above the policy's per-call maximum")]
    AboveMaximum,

    #[msg("the rolling 30-day investment cap has no room for this amount")]
    RollingCapExhausted,

    /// The crank's min_out may be tighter than the user's floor, never looser.
    #[msg("min_out is below the policy's own floor for this leg")]
    FloorTooLow,

    /// The measured delta is the only truth about what the venue delivered.
    #[msg("the venue delivered less than min_out")]
    FillTooSmall,

    /// The venue pulled more from the input account than amount_in allowed.
    #[msg("the venue spent more than amount_in")]
    Overspent,

    /// `wrap_sol` and `convert` move the VAULT's money. They were once open to
    /// any signer, which let a stranger wrap a vault's SOL and sell it through
    /// a pool they controlled, bounded only by an owner-signed floor.
    #[msg("only the vault's owner or the configured keeper may crank this vault")]
    UnauthorizedCrank,

    #[msg("the protocol is paused: settle and invest are stopped for every vault; withdraw is not")]
    ProtocolPaused,

    /// init_config is not first-caller-wins any more: the signer must be the
    /// key the loader records as this program's upgrade authority.
    #[msg("only this program's upgrade authority may create the protocol config")]
    NotUpgradeAuthority,

    #[msg("this signer is not the proposed new authority")]
    NotPendingAuthority,

    #[msg("the default public key cannot hold this role")]
    InvalidAuthority,

    /// Compared by name before the bytes are, so the refusal says what is wrong.
    #[msg("the attestation is for a different skim mode than this vault uses")]
    SkimModeMismatch,

    #[msg("the attestation's deadline has passed; the window must be measured again")]
    AttestationExpired,

    #[msg("mode must be 0 (profit) or 1 (volume)")]
    InvalidMode,

    #[msg("volume_bps must be between 1 and 100")]
    InvalidVolumeBps,

    #[msg("max_contribution must be greater than zero")]
    InvalidContributionCap,

    #[msg("paying this settlement would leave the trading wallet below its reserve")]
    WalletBelowReserve,

    #[msg("this token account is not in the mint the owner invests from")]
    WrongInMint,
}
