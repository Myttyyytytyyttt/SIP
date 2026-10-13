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

/// The per-trade modes. They live in the same `skim_mode` byte, so discovery
/// can still filter on it, but only set_policy_v3 writes them and only
/// settle_v3 settles them; validate_policy below still refuses both, so
/// create_vault_v2 and set_policy_v2 mean exactly what they always meant.
pub const MODE_ROUNDUP: u8 = 2;
pub const MODE_FIXED: u8 = 3;

pub fn is_per_trade_mode(mode: u8) -> bool {
    mode == MODE_ROUNDUP || mode == MODE_FIXED
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

/// The parameters of a vault's per-trade modes, and its daily counter.
///
/// A SEPARATE ACCOUNT, for InvestmentPolicy's reason: every instruction that
/// loads a Vault, withdraw included, deserialises that type, so the upgrade
/// that brings these modes changes no existing layout. Created by the owner's
/// set_policy_v3 (init_if_needed) and left behind, inert, when the vault goes
/// back to mode 0 or 1.
///
/// Seeds: ["per_trade", vault]. 96 bytes after the discriminator, 104 in all.
///
/// BOTH MODES' PARAMETERS ARE ALWAYS STORED AND ALWAYS BOUNDED, whatever the
/// mode, as both rates are on the Vault: switching between round-up and fixed
/// is a policy write, never a chance to slip an unchecked value in.
#[account]
#[derive(InitSpace)]
pub struct PerTradePolicy {
    pub vault: Pubkey,
    pub bump: u8,
    pub version: u8,
    /// ROUND-UP unit u, in cents: whole dollars, 100..=10_000 in steps of 100.
    pub roundup_unit_cents: u16,
    /// FIXED amount F saved per counted trade, lamports, 100_000..=100_000_000.
    pub fixed_lamports: u32,
    /// ROUND-UP's minimum counted trade, cents, 0..=10_000. A keeper rule the
    /// program cannot see trades to apply; it is signed into every attestation.
    pub min_trade_cents: u16,
    /// FIXED's minimum counted trade (the SOL leg), lamports, 0..=1_000_000_000.
    pub min_trade_lamports: u32,
    /// The most settle_v3 moves into this vault per UTC day. It clips; the
    /// excess is forgiven, never carried.
    pub daily_cap_lamports: u64,
    /// unix_timestamp / 86_400 of the last settle_v3 that paid or rolled the day.
    pub day_index: u32,
    /// Paid into the vault by settle_v3 on `day_index`. Written by settle_v3
    /// only; set_policy_v3 never resets it.
    pub day_saved_lamports: u64,
    pub _reserved: [u8; 30],
}

pub const CURRENT_PER_TRADE_POLICY_VERSION: u8 = 1;

pub const ROUNDUP_UNIT_CENTS_MIN: u16 = 100;
pub const ROUNDUP_UNIT_CENTS_MAX: u16 = 10_000;
pub const ROUNDUP_UNIT_CENTS_STEP: u16 = 100;
pub const FIXED_LAMPORTS_MIN: u32 = 100_000;
pub const FIXED_LAMPORTS_MAX: u32 = 100_000_000;
pub const MIN_TRADE_CENTS_MAX: u16 = 10_000;
pub const MIN_TRADE_LAMPORTS_MAX: u32 = 1_000_000_000;

/// set_policy_v3's validation. validate_policy is NOT widened: it still says
/// what set_policy_v2 and create_vault_v2 accept, byte for byte.
pub fn validate_per_trade_policy(
    mode: u8,
    roundup_unit_cents: u16,
    fixed_lamports: u32,
    min_trade_cents: u16,
    min_trade_lamports: u32,
    daily_cap_lamports: u64,
    max_contribution: u64,
) -> Result<()> {
    use crate::errors::NuvemError;
    require!(is_per_trade_mode(mode), NuvemError::InvalidPerTradeMode);
    require!(
        (ROUNDUP_UNIT_CENTS_MIN..=ROUNDUP_UNIT_CENTS_MAX).contains(&roundup_unit_cents)
            && roundup_unit_cents % ROUNDUP_UNIT_CENTS_STEP == 0,
        NuvemError::InvalidRoundUpUnit
    );
    require!((FIXED_LAMPORTS_MIN..=FIXED_LAMPORTS_MAX).contains(&fixed_lamports), NuvemError::InvalidFixedAmount);
    require!(
        min_trade_cents <= MIN_TRADE_CENTS_MAX && min_trade_lamports <= MIN_TRADE_LAMPORTS_MAX,
        NuvemError::InvalidMinTrade
    );
    require!(daily_cap_lamports > 0, NuvemError::InvalidDailyCap);
    require!(max_contribution > 0, NuvemError::InvalidContributionCap);
    Ok(())
}

impl PerTradePolicy {
    /// What the attestation signs as `mode_param`: the unit in cents for
    /// round-up, F for fixed, widened to u64.
    pub fn mode_param(&self, mode: u8) -> u64 {
        if mode == MODE_ROUNDUP { u64::from(self.roundup_unit_cents) } else { u64::from(self.fixed_lamports) }
    }

    /// What the attestation signs as `min_trade`: the active mode's minimum.
    pub fn min_trade(&self, mode: u8) -> u64 {
        if mode == MODE_ROUNDUP { u64::from(self.min_trade_cents) } else { u64::from(self.min_trade_lamports) }
    }
}

// THE UPGRADE CHANGES NO EXISTING LAYOUT. These hold the sizes the deployed
// binary allocates; a field added to any of them stops the build.
const _: () = assert!(8 + Vault::INIT_SPACE == 125);
const _: () = assert!(8 + TradingLink::INIT_SPACE == 129);
const _: () = assert!(8 + ProtocolConfig::INIT_SPACE == 203);
const _: () = assert!(8 + PerTradePolicy::INIT_SPACE == 104);

#[cfg(test)]
mod tests {
    use super::*;
    use crate::errors::NuvemError;

    fn refusal(result: Result<()>) -> Option<u32> {
        match result {
            Ok(()) => None,
            Err(anchor_lang::error::Error::AnchorError(error)) => Some(error.error_code_number),
            Err(other) => panic!("not an AnchorError: {other:?}"),
        }
    }

    #[derive(Clone, Copy)]
    struct P {
        mode: u8,
        unit: u16,
        fixed: u32,
        min_cents: u16,
        min_lamports: u32,
        daily_cap: u64,
        max_contribution: u64,
    }

    const OK: P = P {
        mode: MODE_ROUNDUP,
        unit: 100,
        fixed: 1_000_000,
        min_cents: 100,
        min_lamports: 10_000_000,
        daily_cap: 300_000_000,
        max_contribution: 60_000_000,
    };

    fn check(p: P) -> Option<u32> {
        refusal(validate_per_trade_policy(
            p.mode,
            p.unit,
            p.fixed,
            p.min_cents,
            p.min_lamports,
            p.daily_cap,
            p.max_contribution,
        ))
    }

    #[test]
    fn validate_per_trade_policy_as_a_table() {
        let unit = Some(u32::from(NuvemError::InvalidRoundUpUnit));
        let fixed = Some(u32::from(NuvemError::InvalidFixedAmount));
        let min = Some(u32::from(NuvemError::InvalidMinTrade));
        let mode = Some(u32::from(NuvemError::InvalidPerTradeMode));
        let table: Vec<(P, Option<u32>)> = vec![
            (OK, None),
            (P { mode: MODE_FIXED, ..OK }, None),
            (P { mode: MODE_PROFIT, ..OK }, mode),
            (P { mode: MODE_VOLUME, ..OK }, mode),
            (P { mode: 4, ..OK }, mode),
            (P { mode: 255, ..OK }, mode),
            // whole dollars, $1..=$100
            (P { unit: 100, ..OK }, None),
            (P { unit: 200, ..OK }, None),
            (P { unit: 10_000, ..OK }, None),
            (P { unit: 0, ..OK }, unit),
            (P { unit: 99, ..OK }, unit),
            (P { unit: 150, ..OK }, unit),
            (P { unit: 101, ..OK }, unit),
            (P { unit: 10_100, ..OK }, unit),
            (P { unit: u16::MAX, ..OK }, unit),
            // stored and bounded whatever the mode: a fixed vault still needs a valid unit
            (P { mode: MODE_FIXED, unit: 0, ..OK }, unit),
            (P { fixed: 100_000, ..OK }, None),
            (P { fixed: 100_000_000, ..OK }, None),
            (P { fixed: 99_999, ..OK }, fixed),
            (P { fixed: 100_000_001, ..OK }, fixed),
            (P { fixed: 0, ..OK }, fixed),
            (P { mode: MODE_ROUNDUP, fixed: 0, ..OK }, fixed),
            (P { min_cents: 0, min_lamports: 0, ..OK }, None),
            (P { min_cents: 10_000, ..OK }, None),
            (P { min_cents: 10_001, ..OK }, min),
            (P { min_lamports: 1_000_000_000, ..OK }, None),
            (P { min_lamports: 1_000_000_001, ..OK }, min),
            (P { mode: MODE_ROUNDUP, min_lamports: u32::MAX, ..OK }, min),
            (P { daily_cap: 1, ..OK }, None),
            (P { daily_cap: 0, ..OK }, Some(u32::from(NuvemError::InvalidDailyCap))),
            (P { max_contribution: 1, ..OK }, None),
            (P { max_contribution: 0, ..OK }, Some(u32::from(NuvemError::InvalidContributionCap))),
        ];
        for (index, (params, expected)) in table.into_iter().enumerate() {
            assert_eq!(check(params), expected, "row {index}");
        }
    }

    #[test]
    fn validate_policy_still_refuses_the_per_trade_modes() {
        // set_policy_v2 and create_vault_v2 never reach modes 2 and 3.
        for mode in [MODE_ROUNDUP, MODE_FIXED] {
            assert_eq!(
                refusal(validate_policy(mode, 2_000, 200, 1)),
                Some(u32::from(NuvemError::InvalidMode))
            );
        }
    }

    #[test]
    fn active_bps_still_gives_skim_bps_to_a_per_trade_vault() {
        // Trap 1, documented: why settle_v2 needs its guard, and why that
        // guard, not active_bps, is what changed.
        let vault = Vault {
            owner: Pubkey::default(),
            bump: 0,
            version: 1,
            paused: false,
            skim_bps: 2_000,
            lifetime_saved: 0,
            created_at: 0,
            skim_mode: MODE_ROUNDUP,
            volume_bps: 200,
            policy_nonce: 0,
            max_contribution: 1,
            wallet_reserve: 0,
            _reserved: [0; 37],
        };
        assert_eq!(vault.active_bps(), 2_000);
    }

    #[test]
    fn the_signed_mode_param_and_min_trade_follow_the_mode() {
        let policy = PerTradePolicy {
            vault: Pubkey::default(),
            bump: 0,
            version: 1,
            roundup_unit_cents: 500,
            fixed_lamports: 1_000_000,
            min_trade_cents: 100,
            min_trade_lamports: 10_000_000,
            daily_cap_lamports: 1,
            day_index: 0,
            day_saved_lamports: 0,
            _reserved: [0; 30],
        };
        assert_eq!(policy.mode_param(MODE_ROUNDUP), 500);
        assert_eq!(policy.min_trade(MODE_ROUNDUP), 100);
        assert_eq!(policy.mode_param(MODE_FIXED), 1_000_000);
        assert_eq!(policy.min_trade(MODE_FIXED), 10_000_000);
    }
}
