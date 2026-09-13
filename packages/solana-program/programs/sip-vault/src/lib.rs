// Nuvem on Solana — the vault program.
//
// WHAT THIS IS. The Robinhood Chain product, ported: a share of a user's
// attested trading-session profit lands in a personal vault only they can
// withdraw from, and the vault buys tokenised stocks by itself. The user
// creates a trading wallet in the web app, EXPORTS the key, and trades
// anywhere — Axiom, Photon, a Telegram bot. This program never sees those
// trades; an off-chain keeper measures sessions and settles.
//
// Read PLAN.md in the package root before changing anything here: every design
// decision in it closes an investigation, and reports/SOLANA_2026-08-17.md
// holds the on-chain facts this code assumes.
//
// MILESTONE 1: vault lifecycle only. settle (Ed25519 introspection) is M2,
// invest (Raydium CLMM CPI) is M3. See PLAN.md §7.

use anchor_lang::prelude::*;

pub mod attestation;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;

use instructions::*;
use state::InvestmentLeg;

declare_id!("6kA9H9zQT6PW5xWkXoAFCS3NotxarzaYqj66mjMf9w4J");

#[program]
pub mod sip_vault {
    use super::*;

    /// Only V2 entrypoints ship. A client built for the old instructions gets
    /// "instruction not found" instead of settling with a meaning-blind number.
    pub fn create_vault_v2(
        ctx: Context<CreateVault>,
        mode: u8,
        skim_bps: u16,
        volume_bps: u16,
        max_contribution: u64,
        wallet_reserve: u64,
    ) -> Result<()> {
        instructions::create_vault::create_vault_handler(ctx, mode, skim_bps, volume_bps, max_contribution, wallet_reserve)
    }

    pub fn link_wallet(ctx: Context<LinkWallet>) -> Result<()> {
        instructions::link_wallet::link_wallet_handler(ctx)
    }

    pub fn unlink_wallet(ctx: Context<UnlinkWallet>) -> Result<()> {
        instructions::unlink_wallet::unlink_wallet_handler(ctx)
    }

    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        instructions::withdraw::withdraw_handler(ctx, amount)
    }

    pub fn withdraw_token(ctx: Context<WithdrawToken>, amount: u64) -> Result<()> {
        instructions::withdraw_token::withdraw_token_handler(ctx, amount)
    }

    pub fn set_policy_v2(
        ctx: Context<SetPolicy>,
        mode: u8,
        skim_bps: u16,
        volume_bps: u16,
        paused: bool,
        max_contribution: u64,
        wallet_reserve: u64,
    ) -> Result<()> {
        instructions::set_policy::set_policy_handler(ctx, mode, skim_bps, volume_bps, paused, max_contribution, wallet_reserve)
    }

    pub fn init_config(ctx: Context<InitConfig>, attester: Pubkey) -> Result<()> {
        instructions::init_config::init_config_handler(ctx, attester)
    }

    /// Proposes a new config authority; see transfer_authority.rs.
    pub fn transfer_authority(ctx: Context<TransferAuthority>, new_authority: Pubkey) -> Result<()> {
        instructions::transfer_authority_handler(ctx, new_authority)
    }

    /// The proposed authority takes control by signing; see accept_authority.rs.
    pub fn accept_authority(ctx: Context<AcceptAuthority>) -> Result<()> {
        instructions::accept_authority_handler(ctx)
    }

    /// Protocol-wide pause of settle, wrap_sol, convert and invest. Never withdraw.
    pub fn set_protocol_paused(ctx: Context<SetProtocolPaused>, paused: bool) -> Result<()> {
        instructions::set_protocol_paused_handler(ctx, paused)
    }

    /// Replaces the attester `settle` verifies against. See set_attester.rs —
    /// it did not exist until the original attester key leaked, which is one
    /// day too late for every key it will ever protect.
    pub fn set_attester(ctx: Context<SetAttester>, attester: Pubkey) -> Result<()> {
        instructions::set_attester_handler(ctx, attester)
    }

    /// Names the account allowed to crank `wrap_sol` and `convert`. See
    /// set_keeper.rs — before it existed, both were open to any signer.
    pub fn set_keeper(ctx: Context<SetKeeper>, keeper: Pubkey) -> Result<()> {
        instructions::set_keeper_handler(ctx, keeper)
    }

    pub fn set_invest_policy(
        ctx: Context<SetInvestPolicy>,
        legs: Vec<InvestmentLeg>,
        venue_program: Pubkey,
        in_mint: Pubkey,
        min_convert_rate_wad: u128,
        min_investment: u64,
        max_per_call: u64,
        max_rolling_30d: u64,
        enabled: bool,
    ) -> Result<()> {
        instructions::set_invest_policy::set_invest_policy_handler(
            ctx, legs, venue_program, in_mint, min_convert_rate_wad, min_investment, max_per_call, max_rolling_30d, enabled,
        )
    }

    pub fn invest(
        ctx: Context<Invest>,
        leg_index: u8,
        amount_in: u64,
        min_out: u64,
        venue_data: Vec<u8>,
    ) -> Result<()> {
        instructions::invest::invest_handler(ctx, leg_index, amount_in, min_out, venue_data)
    }

    pub fn convert(
        ctx: Context<Convert>,
        amount_in: u64,
        min_out: u64,
        venue_data: Vec<u8>,
    ) -> Result<()> {
        instructions::convert::convert_handler(ctx, amount_in, min_out, venue_data)
    }

    pub fn wrap_sol(ctx: Context<WrapSol>, amount: u64) -> Result<()> {
        instructions::wrap_sol::wrap_sol_handler(ctx, amount)
    }

    pub fn settle_v2(
        ctx: Context<Settle>,
        mode: u8,
        session_start_slot: u64,
        session_end_slot: u64,
        base_lamports: u64,
        valid_until_slot: u64,
    ) -> Result<()> {
        instructions::settle::settle_handler(ctx, mode, session_start_slot, session_end_slot, base_lamports, valid_until_slot)
    }
}
