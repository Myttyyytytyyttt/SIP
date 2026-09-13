// The venue sip-vault's invest() guards are tested against.
//
// A REAL PROGRAM MOVING REAL TOKENS, deliberately dumb, and able to MISBEHAVE
// ON DEMAND — which mainnet Raydium cannot. It models the real swap_v2 shape:
// it PULLS the input from the vault's account (whose authority, the vault PDA,
// invest() passed through as a CPI signer) and PUSHES the output from its own
// liquidity. Two dials, one per pool variant, drive the two ways a venue can
// cheat that invest()'s delta guards must catch:
//
//   * skim_bps  — deliver LESS than the honest fill  -> FillTooSmall
//   * overpull  — take MORE than amount_in from input -> Overspent
//
// The ABI invest() speaks is opaque to invest(): [amount_in u64, min_out u64]
// LE, no discriminator (the fallback handler). Honouring min_out is invest()'s
// job; a venue that could be trusted to honour it would make the guard
// untestable.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, TransferChecked};

declare_id!("8sa7DUWmKVerygiUKhaSxzE6f7cigiE4mb7Q7WEKeiq8");

pub const RATE_WAD: u128 = 1_000_000_000_000_000_000;

#[account]
#[derive(InitSpace)]
pub struct Pool {
    /// Target units delivered per in-asset unit, WAD.
    pub rate_wad: u128,
    /// Basis points SKIMMED off every fill (underdelivery dial).
    pub skim_bps: u16,
    /// Basis points OVER-PULLED from the input (overspend dial).
    pub overpull_bps: u16,
    /// Variant byte, so honest / skimming / overpulling pools coexist.
    pub variant: u8,
    pub bump: u8,
}

#[program]
pub mod toy_venue {
    use super::*;

    pub fn init_pool(
        ctx: Context<InitPool>,
        variant: u8,
        rate_wad: u128,
        skim_bps: u16,
        overpull_bps: u16,
    ) -> Result<()> {
        let pool = &mut ctx.accounts.pool;
        pool.rate_wad = rate_wad;
        pool.skim_bps = skim_bps;
        pool.overpull_bps = overpull_bps;
        pool.variant = variant;
        pool.bump = ctx.bumps.pool;
        Ok(())
    }

    /// The raw-ABI swap. Accounts, in the order invest() forwards them:
    ///   [0] pool          (this venue's state, readonly)
    ///   [1] vault_in      (source; authority = vault PDA, a CPI signer)
    ///   [2] venue_in      (this venue's account for the in-asset, mut)
    ///   [3] venue_out     (this venue's liquidity for the target, mut)
    ///   [4] vault_target  (destination, mut)
    ///   [5] vault_pda     (signer — authority for the input pull)
    ///   [6] in_mint
    ///   [7] target_mint
    ///   [8] in_token_program
    ///   [9] target_token_program
    pub fn fallback<'info>(
        _program_id: &Pubkey,
        accounts: &'info [AccountInfo<'info>],
        data: &[u8],
    ) -> Result<()> {
        require!(data.len() == 16, ErrorCode::BadData);
        let amount_in = u64::from_le_bytes(data[0..8].try_into().unwrap());

        let pool_info = &accounts[0];
        let vault_in = &accounts[1];
        let venue_in = &accounts[2];
        let venue_out = &accounts[3];
        let vault_target = &accounts[4];
        let vault_pda = &accounts[5];
        let in_mint = &accounts[6];
        let target_mint = &accounts[7];
        let in_token_program = &accounts[8];
        let target_token_program = &accounts[9];

        let pool = Pool::try_deserialize(&mut pool_info.data.borrow().as_ref())?;
        let decimals = |mint: &AccountInfo| mint.data.borrow()[44];

        // PULL the input. The vault PDA's signature rode in through invest()'s
        // invoke_signed, so a plain invoke suffices here. The overpull dial
        // takes more than amount_in — the case Overspent must catch.
        let pull = u64::try_from(
            u128::from(amount_in) + u128::from(amount_in) * u128::from(pool.overpull_bps) / 10_000,
        )
        .map_err(|_| ErrorCode::BadData)?;
        token_interface::transfer_checked(
            CpiContext::new(
                in_token_program.clone(),
                TransferChecked {
                    from: vault_in.clone(),
                    mint: in_mint.clone(),
                    to: venue_in.clone(),
                    authority: vault_pda.clone(),
                },
            ),
            pull,
            decimals(in_mint),
        )?;

        // PUSH the output, minus the skim. Signed by the pool PDA.
        let gross = u128::from(amount_in) * pool.rate_wad / RATE_WAD;
        let out = u64::try_from(gross - gross * u128::from(pool.skim_bps) / 10_000)
            .map_err(|_| ErrorCode::BadData)?;
        let seeds: &[&[u8]] = &[b"pool", &[pool.variant], &[pool.bump]];
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                target_token_program.clone(),
                TransferChecked {
                    from: venue_out.clone(),
                    mint: target_mint.clone(),
                    to: vault_target.clone(),
                    authority: pool_info.clone(),
                },
                &[seeds],
            ),
            out,
            decimals(target_mint),
        )?;
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(variant: u8)]
pub struct InitPool<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init,
        payer = payer,
        space = 8 + Pool::INIT_SPACE,
        seeds = [b"pool", core::slice::from_ref(&variant)],
        bump,
    )]
    pub pool: Account<'info, Pool>,
    pub system_program: Program<'info, System>,
}

#[error_code]
pub enum ErrorCode {
    #[msg("instruction data must be [amount_in u64, min_out u64]")]
    BadData,
}
