// Which vault accounts a venue route may list.
//
// THE MEASURED ACCOUNTS WERE NOT THE SPENT ONES. invest and convert lend the
// vault PDA's signature to the pinned venue, then measure two NAMED token
// accounts: what left the input, what reached the output. The venue never sees
// those names. It takes its input from whatever account the caller placed in
// its input slot of `remaining_accounts`, and with the vault's signature riding
// on the CPI, every token account the vault owns is one it may debit. So a
// keeper could create a Raydium pool pairing any other token the vault holds
// (the wSOL wrap_sol just made, a stock bought last month) with the mint the
// instruction measures, list the vault's account of that token as the swap's
// input, name the usual accounts, and have its pool pull the whole balance for
// a dust fill. The named input never moved, so the spend guard read zero; the
// dust cleared a min_out sized to a tiny amount_in. Everything the vault had
// accumulated was drainable for cents.
//
// EVERY VAULT ACCOUNT THE VENUE CAN SPEND MUST BE ONE THAT IS MEASURED. Before
// the CPI, any remaining account owned by the SPL Token or Token-2022 program
// whose token-account owner is the vault PDA must be one of the instruction's
// two named accounts, or the call is refused. The deltas then bound every vault
// token the route can touch. Accounts the vault does not own (the pool's
// vaults, the mints, the tick arrays) pass through untouched.
//
// THE BASE LAYOUT IS ENOUGH. Both token programs begin an account with its mint
// (bytes 0..32) and its owner (32..64), and Token-2022 only ever appends
// extensions after the 165-byte base, so reading the owner needs no extension
// parsing. Anything shorter than that base, a mint for instance, is not an
// account either program will debit.

use anchor_lang::prelude::*;

use crate::errors::NuvemError;

/// Bytes in a token account's base layout: all of an SPL Token account, and
/// the prefix of every Token-2022 account.
const TOKEN_ACCOUNT_BASE_LEN: usize = 165;

/// Where a token account records its owner, in both programs.
const TOKEN_ACCOUNT_OWNER: core::ops::Range<usize> = 32..64;

/// Refuses a venue route that lists a vault-owned token account other than the
/// two `measured` ones. Call it BEFORE the CPI, over the same accounts the CPI
/// is handed.
pub fn refuse_unmeasured_vault_accounts(
    remaining_accounts: &[AccountInfo],
    vault: &Pubkey,
    measured: [&Pubkey; 2],
) -> Result<()> {
    for account in remaining_accounts {
        let token_program =
            account.owner == &anchor_spl::token::ID || account.owner == &anchor_spl::token_2022::ID;
        if !token_program {
            continue;
        }
        let data = account.try_borrow_data()?;
        let owned_by_vault =
            data.len() >= TOKEN_ACCOUNT_BASE_LEN && &data[TOKEN_ACCOUNT_OWNER] == vault.as_ref();
        require!(
            !owned_by_vault || measured.iter().any(|key| *key == account.key),
            NuvemError::DisallowedVaultAccount
        );
    }
    Ok(())
}
