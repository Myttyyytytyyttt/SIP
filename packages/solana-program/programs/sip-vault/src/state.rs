// The two accounts this program owns. Layout discipline matters more here than
// it did in Solidity: reassigning a Solana account's owner requires the account
// to be ZEROED, so a migration between programs must be written into the OLD
// program before it is needed. `version` and `_reserved` exist so that day is
// an upgrade, not a dead end. See PLAN.md §3.

use anchor_lang::prelude::*;

/// One user's savings vault.
///
/// The SOL savings live in this account's own lamports — a program may debit
/// lamports from accounts it owns, so no separate token account is needed for
/// the native leg. Stock positions live in Token-2022 ATAs owned by this PDA.
///
/// Seeds: ["vault", owner]. The address is a pure function of the owner, which
/// deletes the entire factory/registry surface the EVM version needs
/// (vaultById, vaultOfAdmin, creationNonces — see VaultFactory.sol).
#[account]
#[derive(InitSpace)]
pub struct Vault {
    pub owner: Pubkey,
    pub bump: u8,
    /// Layout version. Bumped on any change to this struct; the instruction
    /// dispatch may branch on it, which is how SOME vaults can run new logic
    /// while others do not — the closest Solana gets to the beacon-per-cohort
    /// model.
    pub version: u8,
    /// Gates settle, wrap_sol, convert and invest. NEVER gates withdraw: an
    /// issuer freezing the stock leg, or this program pausing itself, must not
    /// trap the user's SOL.
    pub paused: bool,
    /// PROFIT rate: share of attested session profit saved, basis points,
    /// 201..=10_000 (2.01%..100%). The floor is 201, one above the volume
    /// ceiling, so this range never overlaps `volume_bps` (1..=200): a profit
    /// rate can never be stored where a volume rate belongs, and the worst
    /// cross-application is under-saving, never 20% of turnover. The owner's
    /// product rate is 2_000 (20%).
    pub skim_bps: u16,
    /// Lamports ever settled into this vault, monotonic. The keeper's
    /// anti-double-settlement anchor: it compares this against what it read
    /// before a broadcast whose receipt was lost, exactly like
    /// aggregateLifetimeInvested on the EVM side.
    pub lifetime_saved: u64,
    pub created_at: i64,
    /// Which rate settle applies: MODE_PROFIT (0) or MODE_VOLUME (1). Chosen by
    /// the owner. It is read from here and signed into every attestation, never
    /// taken from the caller -- see settle.rs.
    pub skim_mode: u8,
    /// VOLUME rate: share of the notional of every buy and sell, basis points,
    /// 1..=200 (0.01%..2%). 200 (2%) is the owner's product rate, decided
    /// 2026-09-14, so the rate the product charges sits on the range's own
    /// edge; the profit floor moved up to 201 with it, so the two ranges stay
    /// disjoint (see `skim_bps`).
    pub volume_bps: u16,
    /// Bumped on EVERY set_policy_v2, even one that changes nothing, and signed
    /// into every attestation: no attestation can ride across a policy write.
    pub policy_nonce: u64,
    /// The most one settlement may move out of a trading wallet, lamports.
    /// Owed amounts above it are clipped, and the clip is visible in `Settled`.
    pub max_contribution: u64,
    /// Lamports a settlement always leaves in the trading wallet, on top of its
    /// own rent floor, so saving never strands a trader without fees. A payment
    /// that would dip below it is refused, not trimmed.
    pub wallet_reserve: u64,
    /// The 64 reserved bytes minus the 27 taken above: the account stays 125 B.
    pub _reserved: [u8; 37],
}

pub const CURRENT_VAULT_VERSION: u8 = 1;

pub const MODE_PROFIT: u8 = 0;
pub const MODE_VOLUME: u8 = 1;
// Disjoint on purpose: VOLUME_BPS_MAX + 1 == PROFIT_BPS_MIN. See `skim_bps`.
pub const PROFIT_BPS_MIN: u16 = 201;
pub const PROFIT_BPS_MAX: u16 = 10_000;
pub const VOLUME_BPS_MIN: u16 = 1;
pub const VOLUME_BPS_MAX: u16 = 200;

impl Vault {
    /// The rate of the vault's active mode: the only rate settle ever applies,
    /// and the one signed into the attestation.
    pub fn active_bps(&self) -> u16 {
        if self.skim_mode == MODE_VOLUME { self.volume_bps } else { self.skim_bps }
    }
}

/// One validation for creation and every policy change, so an existing vault
/// cannot be steered anywhere a new one could not start.
pub fn validate_policy(mode: u8, skim_bps: u16, volume_bps: u16, max_contribution: u64) -> Result<()> {
    require!(mode == MODE_PROFIT || mode == MODE_VOLUME, crate::errors::NuvemError::InvalidMode);
    require!((PROFIT_BPS_MIN..=PROFIT_BPS_MAX).contains(&skim_bps), crate::errors::NuvemError::InvalidSkimBps);
    require!((VOLUME_BPS_MIN..=VOLUME_BPS_MAX).contains(&volume_bps), crate::errors::NuvemError::InvalidVolumeBps);
    // A zero cap would forgive every settlement while every log line looks fine.
    require!(max_contribution > 0, crate::errors::NuvemError::InvalidContributionCap);
    Ok(())
}

/// Layout version of ProtocolConfig. 2 is the first SIP layout: the first 105
/// bytes are Nuvem's, byte for byte, and everything after `keeper` is new.
pub const CURRENT_CONFIG_VERSION: u8 = 2;

/// A trading wallet linked to a vault.
///
/// Seeds: ["link", wallet] — keyed by WALLET, not by vault, on purpose. Only
/// one account can ever exist at that address, so "one wallet, one vault" is
/// enforced by derivation itself. The same global-uniqueness guarantee costs
/// the EVM version three mappings in the factory (activeVaultOf and friends).
#[account]
#[derive(InitSpace)]
pub struct TradingLink {
    pub wallet: Pubkey,
    pub vault: Pubkey,
    /// Slot at link creation. The attestation signs it, so a link that is
    /// closed and re-created invalidates every earlier attestation even though
    /// `settlement_nonce` restarts at zero. This is bindingEpoch from the EVM
    /// design, carried by the account's own birth instead of a counter.
    pub epoch: u64,
    /// Monotonic per link. Replaces the EVM `usedSessions` set: strictly
    /// ordered sessions need no set, only a cursor.
    pub settlement_nonce: u64,
    /// Sessions ending at or below this slot are settled. The watermark the
    /// keeper resumes from, mirroring the EVM SettlementFrontier.
    pub frontier_slot: u64,
    pub bump: u8,
    pub _reserved: [u8; 32],
}

/// Protocol-level configuration: who the attester is.
///
/// Seeds: ["config"] — one per deployment, created once. The lab keeps rotation
/// out of scope on purpose (PLAN.md §5: one fixed attester, like the EVM
/// deployment today); `authority` exists so a later `set_attester` has someone
/// to answer to, and production replaces that key with a Squads multisig.
#[account]
#[derive(InitSpace)]
pub struct ProtocolConfig {
    pub authority: Pubkey,
    /// The Ed25519 public key settle_v2() demands attestations from.
    pub attester: Pubkey,
    pub bump: u8,
    /// The one account, besides a vault's own owner, allowed to crank that
    /// vault's funds through `wrap_sol` and `convert`.
    ///
    /// TAKEN FROM THE RESERVED BYTES, which is why it sits after `bump` and is
    /// exactly 32 wide: the layout is byte-identical to the `_reserved: [u8;32]`
    /// it replaces, so the config account already live on mainnet deserialises
    /// unchanged — with `keeper` reading as the default (all-zero) pubkey.
    ///
    /// A DEFAULT KEEPER MEANS NOBODY, NOT ANYBODY. That is the whole point of
    /// the field: before it existed both instructions took a bare `crank:
    /// Signer` with no check at all, so any stranger could wrap a vault's SOL
    /// and route it through a pool of their own choosing. An unset keeper must
    /// therefore fail closed to owner-only, never open back to the world.
    pub keeper: Pubkey,
    /// TWO-STEP AUTHORITY TRANSFER. The old deployment had no way to move its
    /// authority at all, so the day its key leaked the config was lost for good.
    /// `transfer_authority` only proposes; the new key must sign
    /// `accept_authority` itself, so a typo can never hand the protocol to an
    /// address nobody controls. Default means no transfer is pending.
    pub pending_authority: Pubkey,
    /// PROTOCOL-WIDE PAUSE, set by the authority. Gates settle, link_wallet,
    /// wrap_sol, convert and invest for every vault at once. It NEVER gates
    /// withdraw, withdraw_token or an owner's unlink: stopping the machine must
    /// not trap anyone's savings, nor keep a wallet linked against its owner.
    pub paused: bool,
    pub version: u8,
    pub _reserved: [u8; 64],
}

impl ProtocolConfig {
    /// Whether `signer` may push this vault's own funds around.
    ///
    /// The owner always may — a keeper that is misconfigured, unfunded or dead
    /// must never be able to lock someone out of their own vault, and that
    /// escape hatch is the reason this is not simply `signer == keeper`.
    pub fn may_crank(&self, vault_owner: &Pubkey, signer: &Pubkey) -> bool {
        signer == vault_owner || (self.keeper != Pubkey::default() && signer == &self.keeper)
    }
}

/// One basket leg: what to buy and the user's own price floor for it.
#[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy)]
pub struct InvestmentLeg {
    pub mint: Pubkey,
    /// Share of each investment, basis points. The keeper splits amounts by
    /// these; the program enforces them per-leg via the caps, not atomically —
    /// an 8-leg basket cannot be one transaction under the 64-account cap.
    pub weight_bps: u16,
    /// USER-SIGNED floor: minimum acceptable out per unit in, WAD (1e18).
    /// The keeper's per-call min_out may be TIGHTER, never looser.
    pub min_out_rate_wad: u128,
}

pub const MAX_LEGS: usize = 8;

/// The investment policy — RH's setInvestmentPolicy surface, one PDA per vault.
///
/// A SEPARATE ACCOUNT, not fields on Vault, so the Vault layout (and the web's
/// pinned decoder fixtures) survive this feature untouched — and because a
/// policy is optional: a vault with no policy account simply cannot invest.
///
/// Seeds: ["invest", vault].
#[account]
#[derive(InitSpace)]
pub struct InvestmentPolicy {
    pub vault: Pubkey,
    pub enabled: bool,
    /// The ONLY program invest() will CPI as a venue. The re-anchored pinning:
    /// RH pins (pool, fee, tickSpacing) because its chain carries 99.9%-fee
    /// scam pools; Solana's equivalent hazard is a forged venue, so the venue
    /// program is pinned here and everything else is measured by delta.
    pub venue_program: Pubkey,
    /// The ONLY mint convert() may fill into and invest() may spend from: the
    /// owner's choice, USDC by default. Every floor and cap in this policy is a
    /// price or an amount in this mint. Unpinned, they metered whatever the
    /// keeper passed: convert could fill the vault's wSOL into a junk token the
    /// keeper mints, clearing any floor, and invest could spend one leg's shares
    /// to buy another at a floor written for dollars.
    pub in_mint: Pubkey,
    #[max_len(MAX_LEGS)]
    pub legs: Vec<InvestmentLeg>,
    /// USER-SIGNED floor for the SOL->USDC conversion leg: minimum in-asset
    /// (USDC raw) per lamport of wSOL, WAD. Zero means conversion is off.
    pub min_convert_rate_wad: u128,
    pub min_investment: u64,
    pub max_per_call: u64,
    pub max_rolling_30d: u64,
    /// 31 day-buckets, RH's exact mechanism: index = day % 31, a bucket whose
    /// recorded day is stale is overwritten rather than summed.
    pub bucket_days: [u32; 31],
    pub bucket_amounts: [u64; 31],
    pub lifetime_invested: u64,
    pub policy_nonce: u64,
    pub bump: u8,
    pub _reserved: [u8; 32],
}

impl InvestmentPolicy {
    /// Lamports (of the in-asset) invested in the trailing 31 days.
    pub fn rolling_total(&self, today: u32) -> u64 {
        let mut total = 0u64;
        for i in 0..31 {
            // A bucket older than 31 days is history, not headroom.
            if self.bucket_days[i] + 31 > today {
                total = total.saturating_add(self.bucket_amounts[i]);
            }
        }
        total
    }

    pub fn record(&mut self, today: u32, amount: u64) {
        let index = (today % 31) as usize;
        if self.bucket_days[index] == today {
            self.bucket_amounts[index] = self.bucket_amounts[index].saturating_add(amount);
        } else {
            self.bucket_days[index] = today;
            self.bucket_amounts[index] = amount;
        }
    }
}
