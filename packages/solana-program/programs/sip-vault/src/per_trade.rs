// The per-trade modes' arithmetic and checks, as pure functions.
//
// WHAT THE PROGRAM CAN AND CANNOT CHECK. It never sees a trade: the keeper
// counts them, prices each one and signs the total (attestation.rs, V3). What
// the program checks is what that total can be:
//  * FIXED: exactly trade_count × F.
//  * ROUND-UP: no trade saves a whole unit, so the total is at most
//    trade_count × ceil(unit × 1e9 / price_min). That bound catches a wrong
//    UNIT, not a wrong PRICE: a price too low raises the bound by the factor it
//    raises the amount. So round-up also checks the signed price against Pyth's
//    own SOL/USD account, one-sided, at half: a power-of-ten scale bug is
//    refused, an honest window is refused only if SOL more than doubled
//    between its oldest trade and the settle, and then the keeper retries.
//
// INTEGERS ONLY, AND EVERY FLOOR IN THE TRADER'S FAVOUR. Products go through
// u128: lamports × micro-dollars passes u64 for large trades.
//
// THE SAME NUMBERS IN RUST, PYTHON AND TYPESCRIPT. roundup_trade_lamports is
// the reference the keeper mirrors (scripts/per-trade.ts); the program itself
// never calls it. Both are held to tests/fixtures/per-trade-vectors.txt,
// which tests/fixtures/per-trade-vectors.py computed from the formulas alone.

use anchor_lang::prelude::*;

/// Micro-dollars in one cent.
pub const MICRO_USD_PER_CENT: u128 = 10_000;
pub const LAMPORTS_PER_SOL: u128 = 1_000_000_000;
pub const SECONDS_PER_DAY: i64 = 86_400;

/// One counted trade's round-up, in lamports: the trade is worth
/// X = floor(x × p / 1e9) micro-dollars; it saves r = min((u − X mod u) mod u, X)
/// with u = unit_cents × 1e4, so an exact multiple saves 0 and no trade saves
/// more than itself; r is paid as floor(r × 1e9 / p) lamports. None if the price
/// is zero.
pub fn roundup_trade_lamports(x_lamports: u64, price_usd_e6: u64, unit_cents: u16) -> Option<u64> {
    if price_usd_e6 == 0 {
        return None;
    }
    let p = u128::from(price_usd_e6);
    let u = u128::from(unit_cents) * MICRO_USD_PER_CENT;
    if u == 0 {
        return None;
    }
    let worth = u128::from(x_lamports) * p / LAMPORTS_PER_SOL;
    let round_up = ((u - worth % u) % u).min(worth);
    // round_up <= worth <= x × p / 1e9, so this is at most x: it fits a u64.
    u64::try_from(round_up * LAMPORTS_PER_SOL / p).ok()
}

/// The most a ROUND-UP window of `trade_count` trades can owe at `price_min`:
/// trade_count × ceil(unit × 1e9 / price_min). Each trade's round-up is below
/// one unit, and below one unit at its own price, which is at least price_min.
/// None if the price is zero.
pub fn roundup_bound_lamports(trade_count: u32, unit_cents: u16, price_min_usd_e6: u64) -> Option<u128> {
    if price_min_usd_e6 == 0 {
        return None;
    }
    let unit_lamports_at_min = (u128::from(unit_cents) * MICRO_USD_PER_CENT * LAMPORTS_PER_SOL)
        .div_ceil(u128::from(price_min_usd_e6));
    Some(u128::from(trade_count) * unit_lamports_at_min)
}

/// What a FIXED window owes: trade_count × F. u32 × u32 cannot overflow a u64.
pub fn fixed_amount_lamports(trade_count: u32, fixed_lamports: u32) -> u64 {
    u64::from(trade_count) * u64::from(fixed_lamports)
}

/// The Pyth receiver: the program that owns every PriceUpdateV2 account.
pub const PYTH_RECEIVER_PROGRAM_ID: Pubkey = pubkey!("rec2HHDDnjLfj4kE7VyEtFA1HPGQLK33259532cRyHp");

/// The SOL/USD feed id, ef0d8b6f…b56d.
pub const PYTH_SOL_USD_FEED_ID: [u8; 32] = [
    0xef, 0x0d, 0x8b, 0x6f, 0xda, 0x2c, 0xeb, 0xa4, 0x1d, 0xa1, 0x5d, 0x40, 0x95, 0xd1, 0xda, 0x39, 0x2a, 0x0d, 0x2f,
    0x8e, 0xd0, 0xc6, 0xc7, 0xbc, 0x0f, 0x4c, 0xfa, 0xc8, 0xc2, 0x80, 0xb5, 0x6d,
];

/// sha256("account:PriceUpdateV2")[..8].
pub const PYTH_PRICE_UPDATE_DISCRIMINATOR: [u8; 8] = [0x22, 0xf1, 0x23, 0x63, 0x9d, 0x7e, 0xf4, 0xcd];

/// What the receiver allocates for a PriceUpdateV2 (the larger variant's size).
pub const PYTH_PRICE_UPDATE_LEN: usize = 134;

/// VerificationLevel's Borsh variants: Partial { num_signatures: u8 } is two
/// bytes wide, Full one, so the body's offset depends on which.
pub const PYTH_VERIFICATION_PARTIAL: u8 = 0;
pub const PYTH_VERIFICATION_FULL: u8 = 1;
const PYTH_VERIFICATION_AT: usize = 8 + 32;

/// No price feed's exponent is this far from zero; it also bounds 10^k below.
pub const PYTH_MAX_EXPO: i32 = 18;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PythPrice {
    pub price: i64,
    pub expo: i32,
    pub publish_time: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PythRefusal {
    /// Wrong size, discriminator, variant or feed.
    Invalid,
    /// A Partial update: fewer guardian signatures than Full checked.
    NotFullyVerified,
}

fn i64_at(data: &[u8], at: usize) -> i64 {
    i64::from_le_bytes(data[at..at + 8].try_into().expect("8 bytes"))
}

fn i32_at(data: &[u8], at: usize) -> i32 {
    i32::from_le_bytes(data[at..at + 4].try_into().expect("4 bytes"))
}

/// The SOL/USD price in a PriceUpdateV2 account's data, as the keeper's
/// src/pyth.ts reads it: both verification variants are decoded at their own
/// offsets, and only Full is accepted, which is the Pyth SDK's own default for
/// get_price_no_older_than and what every mainnet sample of the sponsored feed
/// carries. The account's OWNER is the caller's to check: bytes cannot say who
/// wrote them.
pub fn decode_sol_usd_price_update(data: &[u8]) -> core::result::Result<PythPrice, PythRefusal> {
    if data.len() != PYTH_PRICE_UPDATE_LEN || data[..8] != PYTH_PRICE_UPDATE_DISCRIMINATOR {
        return Err(PythRefusal::Invalid);
    }
    let body = match data[PYTH_VERIFICATION_AT] {
        PYTH_VERIFICATION_FULL => PYTH_VERIFICATION_AT + 1,
        PYTH_VERIFICATION_PARTIAL => PYTH_VERIFICATION_AT + 2,
        _ => return Err(PythRefusal::Invalid),
    };
    // feed id 32 · price i64 · conf u64 · expo i32 · publish_time i64 · …, 92 bytes in all.
    if body + 92 > data.len() || data[body..body + 32] != PYTH_SOL_USD_FEED_ID {
        return Err(PythRefusal::Invalid);
    }
    if data[PYTH_VERIFICATION_AT] != PYTH_VERIFICATION_FULL {
        return Err(PythRefusal::NotFullyVerified);
    }
    Ok(PythPrice {
        price: i64_at(data, body + 32),
        expo: i32_at(data, body + 48),
        publish_time: i64_at(data, body + 52),
    })
}

/// Whether the signed price is at least half of Pyth's, exactly:
/// 2 × price_min × 1e-6 ≥ price × 10^expo, compared as integers with no
/// rounding. A non-positive Pyth price, an exponent beyond ±18, or a Pyth price
/// too large for u128 at its exponent all fail.
pub fn pyth_floor_holds(price_min_usd_e6: u64, pyth_price: i64, pyth_expo: i32) -> bool {
    if pyth_price <= 0 || !(-PYTH_MAX_EXPO..=PYTH_MAX_EXPO).contains(&pyth_expo) {
        return false;
    }
    let price = pyth_price as u128;
    let twice_min = 2 * u128::from(price_min_usd_e6);
    // price_min is in 1e-6 dollars, Pyth's price in 10^expo dollars.
    let shift = -6 - pyth_expo;
    if shift >= 0 {
        // ≤ 2 × u64::MAX × 10^12 < u128::MAX.
        twice_min * 10u128.pow(shift as u32) >= price
    } else {
        match price.checked_mul(10u128.pow((-shift) as u32)) {
            Some(scaled) => twice_min >= scaled,
            None => false,
        }
    }
}

/// Whether a publish is recent enough for the floor: at most a day old. A
/// publish ahead of the clock is not stale; only a day-long outage refuses,
/// and that refusal is a retry, never a loss.
pub fn pyth_is_fresh(publish_time: i64, now_unix: i64) -> bool {
    publish_time >= now_unix.saturating_sub(SECONDS_PER_DAY)
}

/// The UTC day a unix time falls in, as invest() counts days.
pub fn day_index_of(now_unix: i64) -> Option<u32> {
    u32::try_from(now_unix.div_euclid(SECONDS_PER_DAY)).ok()
}

/// The counter as settle_v3 sees it on `today`: a new day starts at zero.
pub fn rolled_day(day_index: u32, day_saved_lamports: u64, today: u32) -> (u32, u64) {
    if day_index == today { (day_index, day_saved_lamports) } else { (today, 0) }
}

/// What settle_v3 moves: the attested amount, clipped by the per-settle cap
/// and by what is left of the daily cap. Clipped lamports are forgiven.
pub fn per_trade_paid(amount_lamports: u64, max_contribution: u64, daily_cap_lamports: u64, day_saved_lamports: u64) -> u64 {
    amount_lamports.min(max_contribution).min(daily_cap_lamports.saturating_sub(day_saved_lamports))
}

#[cfg(test)]
mod tests {
    use super::*;

    const VECTORS: &str = include_str!("../../../tests/fixtures/per-trade-vectors.txt");

    fn rows(kind: &str) -> Vec<Vec<&'static str>> {
        VECTORS
            .lines()
            .filter(|line| !line.starts_with('#'))
            .map(|line| line.split_whitespace().collect::<Vec<_>>())
            .filter(|fields| fields.first() == Some(&kind))
            .map(|fields| fields[1..].to_vec())
            .collect()
    }

    #[test]
    fn roundup_matches_the_shared_vectors() {
        let vectors = rows("roundup");
        assert!(vectors.len() >= 10, "the vector file lost its round-up rows");
        for row in vectors {
            let x: u64 = row[0].parse().unwrap();
            let p: u64 = row[1].parse().unwrap();
            let unit: u16 = row[2].parse().unwrap();
            let lamports: u64 = row[5].parse().unwrap();
            assert_eq!(roundup_trade_lamports(x, p, unit), Some(lamports), "x {x} p {p} unit {unit}");
            assert!(lamports <= x, "a trade never saves more than itself");
        }
    }

    #[test]
    fn the_owners_example_saves_forty_cents() {
        // $1.60 at $150 with a $1 unit: $0.40, 2_666_666 lamports.
        assert_eq!(roundup_trade_lamports(10_666_667, 150_000_000, 100), Some(2_666_666));
        assert_eq!(roundup_bound_lamports(1, 100, 150_000_000), Some(6_666_667));
    }

    #[test]
    fn a_price_wrong_by_a_hundred_charges_the_whole_trade_and_passes_the_bound() {
        // Why the bound is not enough (ADR RT-1): the same $1.60 trade priced at
        // $1.50 charges all of it, and the bound grows with it.
        let charged = roundup_trade_lamports(10_666_667, 1_500_000, 100).unwrap();
        assert_eq!(charged, 10_666_666);
        assert!(u128::from(charged) <= roundup_bound_lamports(1, 100, 1_500_000).unwrap());
        // The floor is what refuses it, against a $150 Pyth price.
        assert!(!pyth_floor_holds(1_500_000, 15_000_000_000, -8));
        assert!(pyth_floor_holds(150_000_000, 15_000_000_000, -8));
    }

    #[test]
    fn bound_matches_the_shared_vectors() {
        let vectors = rows("bound");
        assert!(vectors.len() >= 5);
        for row in vectors {
            let count: u32 = row[0].parse().unwrap();
            let unit: u16 = row[1].parse().unwrap();
            let price_min: u64 = row[2].parse().unwrap();
            let bound: u128 = row[3].parse().unwrap();
            assert_eq!(roundup_bound_lamports(count, unit, price_min), Some(bound), "count {count} unit {unit} price {price_min}");
        }
        assert_eq!(roundup_bound_lamports(1, 100, 0), None);
    }

    #[test]
    fn floor_matches_the_shared_vectors() {
        let vectors = rows("floor");
        assert!(vectors.len() >= 10);
        for row in vectors {
            let price_min: u64 = row[0].parse().unwrap();
            let price: i64 = row[1].parse().unwrap();
            let expo: i32 = row[2].parse().unwrap();
            let ok = row[3] == "1";
            assert_eq!(pyth_floor_holds(price_min, price, expo), ok, "price_min {price_min} pyth {price}e{expo}");
        }
    }

    #[test]
    fn the_floor_is_exactly_half() {
        // ½ passes, ½ − ε is refused, at the -8 exponent both feeds use.
        assert!(pyth_floor_holds(75_000_000, 15_000_000_000, -8));
        assert!(!pyth_floor_holds(74_999_999, 15_000_000_000, -8));
        // An exponent beyond ±18 is not a price feed's.
        assert!(!pyth_floor_holds(u64::MAX, 1, -19));
        assert!(!pyth_floor_holds(u64::MAX, 1, 19));
        assert!(pyth_floor_holds(1, 1, -18));
    }

    #[test]
    fn fixed_is_count_times_f() {
        assert_eq!(fixed_amount_lamports(7, 1_000_000), 7_000_000);
        assert_eq!(fixed_amount_lamports(0, 1_000_000), 0);
        assert_eq!(fixed_amount_lamports(u32::MAX, 100_000_000), 429_496_729_500_000_000);
    }

    /// 7AviUf9n… as mainnet returned it at slot 447_956_907: the committed
    /// fixture packages/solana-core/test/fixtures/pyth-accounts.ts decodes by
    /// hand to price 10_259_321_149 at expo -8 ($102.59321149), published at
    /// 1_789_699_386, Full.
    const MAINNET_SOL_USD_BASE64: &str = "IvEjY51+9M1bsRWwDdII6qyfKmvtWLaGyH3c9S5trfFYcCJDMhaezQHvDYtv2izrpB2hXUCV0do5Kg0vjtDGx7wPTPrIwoC1bT3RgGMCAAAANSAVAAAAAAD4////OqWsagAAAAA5paxqAAAAAKiftGACAAAABVkZAAAAAACdR7MaAAAAAAA=";

    fn base64_decode(text: &str) -> Vec<u8> {
        let alphabet = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = Vec::new();
        let mut buffer = 0u32;
        let mut bits = 0;
        for byte in text.bytes().filter(|byte| *byte != b'=') {
            buffer = (buffer << 6) | alphabet.iter().position(|a| *a == byte).unwrap() as u32;
            bits += 6;
            if bits >= 8 {
                bits -= 8;
                out.push((buffer >> bits) as u8);
            }
        }
        out
    }

    #[test]
    fn decodes_the_mainnet_sol_usd_account() {
        let data = base64_decode(MAINNET_SOL_USD_BASE64);
        assert_eq!(data.len(), PYTH_PRICE_UPDATE_LEN);
        let price = decode_sol_usd_price_update(&data).unwrap();
        assert_eq!(price, PythPrice { price: 10_259_321_149, expo: -8, publish_time: 1_789_699_386 });
        // Half of $102.59321149 is $51.296605745: 51_296_606 µ$ passes, one less does not.
        assert!(pyth_floor_holds(51_296_606, price.price, price.expo));
        assert!(!pyth_floor_holds(51_296_605, price.price, price.expo));
    }

    /// The same body behind a Partial verification level: every field one byte later.
    fn as_partial(full: &[u8]) -> Vec<u8> {
        let mut partial = full[..PYTH_VERIFICATION_AT].to_vec();
        partial.push(PYTH_VERIFICATION_PARTIAL);
        partial.push(5);
        partial.extend_from_slice(&full[PYTH_VERIFICATION_AT + 1..full.len() - 1]);
        partial
    }

    #[test]
    fn refuses_what_is_not_a_full_sol_usd_price_update() {
        let full = base64_decode(MAINNET_SOL_USD_BASE64);
        let partial = as_partial(&full);
        assert_eq!(partial.len(), PYTH_PRICE_UPDATE_LEN);
        // Partial decodes at its own offsets (the feed id is found) and is then refused.
        assert_eq!(decode_sol_usd_price_update(&partial), Err(PythRefusal::NotFullyVerified));

        let mut wrong_discriminator = full.clone();
        wrong_discriminator[0] ^= 1;
        assert_eq!(decode_sol_usd_price_update(&wrong_discriminator), Err(PythRefusal::Invalid));

        let mut wrong_feed = full.clone();
        wrong_feed[PYTH_VERIFICATION_AT + 1] ^= 1;
        assert_eq!(decode_sol_usd_price_update(&wrong_feed), Err(PythRefusal::Invalid));

        let mut unknown_variant = full.clone();
        unknown_variant[PYTH_VERIFICATION_AT] = 2;
        assert_eq!(decode_sol_usd_price_update(&unknown_variant), Err(PythRefusal::Invalid));

        assert_eq!(decode_sol_usd_price_update(&full[..133]), Err(PythRefusal::Invalid));
        let mut longer = full.clone();
        longer.push(0);
        assert_eq!(decode_sol_usd_price_update(&longer), Err(PythRefusal::Invalid));
    }

    #[test]
    fn a_day_old_publish_is_the_last_fresh_one() {
        let now = 1_800_000_000;
        assert!(pyth_is_fresh(now, now));
        assert!(pyth_is_fresh(now + 600, now));
        assert!(pyth_is_fresh(now - SECONDS_PER_DAY, now));
        assert!(!pyth_is_fresh(now - SECONDS_PER_DAY - 1, now));
        assert!(!pyth_is_fresh(0, now));
    }

    #[test]
    fn the_day_rolls_at_utc_midnight_and_starts_from_zero() {
        let midnight = 20_000 * SECONDS_PER_DAY;
        assert_eq!(day_index_of(midnight - 1), Some(19_999));
        assert_eq!(day_index_of(midnight), Some(20_000));
        assert_eq!(day_index_of(-1), None);
        assert_eq!(rolled_day(19_999, 250, 19_999), (19_999, 250));
        assert_eq!(rolled_day(19_999, 250, 20_000), (20_000, 0));
        // A fresh policy (day 0, nothing saved) rolls to today on its first settle.
        assert_eq!(rolled_day(0, 0, 20_000), (20_000, 0));
    }

    #[test]
    fn paid_is_clipped_by_both_caps_and_never_negative() {
        // amount, max_contribution, daily_cap, day_saved -> paid
        assert_eq!(per_trade_paid(2_666_666, 60_000_000, 300_000_000, 0), 2_666_666);
        assert_eq!(per_trade_paid(70_000_000, 60_000_000, 300_000_000, 0), 60_000_000);
        assert_eq!(per_trade_paid(50_000_000, 60_000_000, 300_000_000, 280_000_000), 20_000_000);
        assert_eq!(per_trade_paid(50_000_000, 60_000_000, 300_000_000, 300_000_000), 0);
        // A cap lowered below what the day already saved leaves no headroom, not a wrap.
        assert_eq!(per_trade_paid(50_000_000, 60_000_000, 100_000_000, 300_000_000), 0);
    }
}
