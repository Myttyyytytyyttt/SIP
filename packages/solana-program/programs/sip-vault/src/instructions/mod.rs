pub mod convert;
pub mod create_vault;
pub mod init_config;
pub mod invest;
pub mod link_wallet;
pub mod set_attester;
pub mod set_invest_policy;
pub mod set_keeper;
pub mod set_policy;
pub mod settle;
pub mod unlink_wallet;
pub mod withdraw;
pub mod withdraw_token;
pub mod wrap_sol;

// Glob re-exports are REQUIRED here: the #[program] macro references the
// hidden __client_accounts_* modules each instruction file generates, and it
// finds them only through these. Each handler carries its own name (not five
// functions all called `handler`) so the globs never collide.
pub use convert::*;
pub use create_vault::*;
pub use init_config::*;
pub use invest::*;
pub use link_wallet::*;
pub use set_attester::*;
pub use set_invest_policy::*;
pub use set_keeper::*;
pub use set_policy::*;
pub use settle::*;
pub use unlink_wallet::*;
pub use withdraw::*;
pub use withdraw_token::*;
pub use wrap_sol::*;
