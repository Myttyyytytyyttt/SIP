use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};

use crate::attestation::{attestation_v3_message, prices_hash_from_words, AttestationV3Inputs};
use crate::ed25519_introspection::{verify_preceding_ed25519, Ed25519Refusals};
use crate::errors::NuvemError;
use crate::events::{PerTradeSettled, Settled};
use crate::per_trade::{
    day_index_of, decode_sol_usd_price_update, fixed_amount_lamports, per_trade_paid, pyth_floor_holds, pyth_is_fresh,
    rolled_day, roundup_bound_lamports, PYTH_RECEIVER_PROGRAM_ID,
};
use crate::state::{is_per_trade_mode, PerTradePolicy, ProtocolConfig, TradingLink, Vault, MODE_FIXED};

/// settle_v2's names for each way the attestation check fails: a client that
/// already reads them reads settle_v3's the same way.
const ATTESTATION_REFUSALS: Ed25519Refusals = Ed25519Refusals {
    missing: NuvemError::AttestationMissing,
    malformed: NuvemError::AttestationMalformed,
    wrong_signer: NuvemError::WrongAttester,
    mismatch: NuvemError::AttestationMismatch,
};

/// The rate settle_v3 reports in `Settled`: the attested amount IS what is
/// owed, so it is "100 %" of its own base.
const PER_TRADE_SETTLED_BPS: u16 = 10_000;

/// Settles one attested window of a per-trade vault: ROUND-UP (2) or FIXED (3).
///
/// THE ACCOUNTS ARE settle_v2's, in settle_v2's order, then two more: the
/// vault's PerTradePolicy, which holds the unit or F, the minimum trade and the
/// daily counter, and Pyth's SOL/USD PriceUpdateV2 account, required in
/// round-up and refused in fixed (pass the program id for "none", Anchor's
/// encoding of an absent optional account).
///
/// THE WALLET PUSHES AND THE ATTESTER SIGNS, exactly as in settle_v2: the
/// instruction before this one is an Ed25519SigVerify of the SIP_SETTLE_V3
/// bytes, rebuilt here from chain state (attestation.rs).
#[derive(Accounts)]
pub struct SettleV3<'info> {
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

    #[account(
        mut,
        seeds = [b"per_trade", vault.key().as_ref()],
        bump = per_trade_policy.bump,
    )]
    pub per_trade_policy: Account<'info, PerTradePolicy>,

    /// CHECK: round-up only. Its owner (the Pyth receiver), discriminator,
    /// verification level (Full), feed id (SOL/USD) and age are checked in the
    /// handler before its price is read; see per_trade.rs.
    pub pyth_sol_usd: Option<UncheckedAccount<'info>>,
}

#[allow(clippy::too_many_arguments)]
pub fn settle_v3_handler(
    ctx: Context<SettleV3>,
    mode: u8,
    session_start_slot: u64,
    session_end_slot: u64,
    trade_count: u32,
    amount_lamports: u64,
    price_min_usd_e6: u64,
    prices_hash_0: u64,
    prices_hash_1: u64,
    prices_hash_2: u64,
    prices_hash_3: u64,
    valid_until_slot: u64,
) -> Result<()> {
    let vault = &ctx.accounts.vault;
    let link = &ctx.accounts.trading_link;
    let policy = &ctx.accounts.per_trade_policy;
    let wallet_key = ctx.accounts.wallet.key();

    // 1. Pauses, as settle_v2.
    require!(!vault.paused, NuvemError::VaultPaused);
    require!(!ctx.accounts.config.paused, NuvemError::ProtocolPaused);

    // 2. The vault's mode is per-trade, and the caller says which, by name
    // before the bytes do.
    require!(is_per_trade_mode(vault.skim_mode), NuvemError::ModeNeedsSettleV2);
    require!(mode == vault.skim_mode, NuvemError::SkimModeMismatch);

    // 3. Deadline and window, settle_v2's rules.
    let clock = Clock::get()?;
    let now = clock.slot;
    require!(now <= valid_until_slot, NuvemError::AttestationExpired);
    require!(
        session_start_slot >= link.frontier_slot && session_end_slot > session_start_slot,
        NuvemError::InvalidSessionWindow
    );
    require!(session_end_slot <= now, NuvemError::InvalidSessionWindow);

    // 4. The signature, over bytes rebuilt from chain state: the mode, the
    // policy nonce, the unit or F and the minimum trade come from the vault and
    // its PerTradePolicy, never from the caller.
    let prices_hash = prices_hash_from_words([prices_hash_0, prices_hash_1, prices_hash_2, prices_hash_3]);
    let mode_param = policy.mode_param(vault.skim_mode);
    let min_trade = policy.min_trade(vault.skim_mode);
    let expected = attestation_v3_message(&AttestationV3Inputs {
        program_id: crate::ID,
        wallet: wallet_key,
        vault: vault.key(),
        link_epoch: link.epoch,
        settlement_nonce: link.settlement_nonce,
        session_start_slot,
        session_end_slot,
        amount_lamports,
        mode: vault.skim_mode,
        policy_nonce: vault.policy_nonce,
        valid_until_slot,
        trade_count,
        price_min_usd_e6,
        mode_param,
        min_trade,
        prices_hash,
    });
    verify_preceding_ed25519(
        &ctx.accounts.instructions_sysvar,
        &ctx.accounts.config.attester,
        &expected,
        &ATTESTATION_REFUSALS,
    )?;

    // 5. What the signed numbers can be.
    if vault.skim_mode == MODE_FIXED {
        require!(
            price_min_usd_e6 == 0 && prices_hash == [0u8; 32] && ctx.accounts.pyth_sol_usd.is_none(),
            NuvemError::PriceNotAllowed
        );
        require!(
            amount_lamports == fixed_amount_lamports(trade_count, policy.fixed_lamports),
            NuvemError::PerTradeAmountMismatch
        );
    } else {
        require!(price_min_usd_e6 > 0, NuvemError::PriceRequired);
        require!(trade_count > 0 || amount_lamports == 0, NuvemError::PerTradeAmountMismatch);
        let bound = roundup_bound_lamports(trade_count, policy.roundup_unit_cents, price_min_usd_e6)
            .ok_or(NuvemError::PriceRequired)?;
        require!(u128::from(amount_lamports) <= bound, NuvemError::PerTradeAmountAboveBound);
        require_pyth_floor(ctx.accounts.pyth_sol_usd.as_ref(), price_min_usd_e6, clock.unix_timestamp)?;
    }

    // 6. Caps: the per-settle cap and what is left of the UTC day's cap. Both
    // clip; the excess is forgiven, never carried.
    let today = day_index_of(clock.unix_timestamp).ok_or(NuvemError::InvalidPolicy)?;
    let (day_index, day_saved_before) = rolled_day(policy.day_index, policy.day_saved_lamports, today);
    let paid = per_trade_paid(amount_lamports, vault.max_contribution, policy.daily_cap_lamports, day_saved_before);

    // 7. The reserve refuses and the wallet pays, exactly as in settle_v2. A
    // zero payment still advances the frontier below.
    if paid > 0 {
        let wallet_floor = Rent::get()?.minimum_balance(0).saturating_add(vault.wallet_reserve);
        let left = ctx.accounts.wallet.lamports().checked_sub(paid);
        require!(left.is_some_and(|left| left >= wallet_floor), NuvemError::WalletBelowReserve);

        transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.wallet.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                },
            ),
            paid,
        )?;
    }

    // 8. Writes.
    let nonce = link.settlement_nonce;
    let link_epoch = link.epoch;
    let active_mode = vault.skim_mode;
    let policy_nonce = vault.policy_nonce;
    let vault_key = vault.key();
    let day_saved = day_saved_before.checked_add(paid).ok_or(NuvemError::InvalidPolicy)?;

    let vault = &mut ctx.accounts.vault;
    vault.lifetime_saved = vault.lifetime_saved.checked_add(paid).ok_or(NuvemError::InvalidPolicy)?;
    let policy = &mut ctx.accounts.per_trade_policy;
    policy.day_index = day_index;
    policy.day_saved_lamports = day_saved;
    let link = &mut ctx.accounts.trading_link;
    link.settlement_nonce = nonce.checked_add(1).ok_or(NuvemError::InvalidPolicy)?;
    link.frontier_slot = session_end_slot;

    // 9. Events: the unchanged Settled every reader counts, then what is new.
    emit!(Settled {
        vault: vault_key,
        wallet: wallet_key,
        mode: active_mode,
        base_lamports: amount_lamports,
        bps: PER_TRADE_SETTLED_BPS,
        owed: amount_lamports,
        paid,
        settlement_nonce: nonce,
        session_end_slot,
        link_epoch,
        session_start_slot,
        policy_nonce,
    });
    emit!(PerTradeSettled {
        vault: vault_key,
        wallet: wallet_key,
        link_epoch,
        settlement_nonce: nonce,
        mode: active_mode,
        trade_count,
        price_min_usd_e6,
        prices_hash,
        mode_param,
        min_trade,
        day_index,
        day_saved_lamports: day_saved,
    });
    Ok(())
}

/// Round-up's independent price check: the signed price_min is at least half
/// of Pyth's SOL/USD price, read from an account the Pyth receiver owns, fully
/// verified, for the SOL/USD feed, published within the last 24 hours.
fn require_pyth_floor(account: Option<&UncheckedAccount>, price_min_usd_e6: u64, now_unix: i64) -> Result<()> {
    let account = account.ok_or(NuvemError::OracleAccountInvalid)?;
    require!(account.owner == &PYTH_RECEIVER_PROGRAM_ID, NuvemError::OracleAccountInvalid);
    let data = account.try_borrow_data()?;
    let price = decode_sol_usd_price_update(&data).map_err(|_| NuvemError::OracleAccountInvalid)?;
    require!(pyth_is_fresh(price.publish_time, now_unix), NuvemError::OracleStale);
    require!(pyth_floor_holds(price_min_usd_e6, price.price, price.expo), NuvemError::PriceBelowOracleFloor);
    Ok(())
}
