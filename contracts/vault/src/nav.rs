//! The vault's money math, as pure functions on u128 with explicit rounding.
//!
//! Units: NEAR and LiNEAR amounts have 24 decimals, the LiNEAR rate `r` is NEAR per LiNEAR
//! scaled 1e24, the NEAR/USD price `P` is scaled 1e8, and USD values are scaled 1e6. Every
//! function names its rounding, and the vault always takes the side that cannot overpay: shares
//! minted and amounts paid round down, the NAV a deposit is priced against rounds up.

use parry_common::math::{checked_mul_div, mul_div, Rounding};

/// 1e24: one NEAR or one LiNEAR in base units, and the scale of the LiNEAR rate.
pub const E24: u128 = 1_000_000_000_000_000_000_000_000;
/// 1e8: the scale of prices and Hyperliquid sizes.
pub const E8: u128 = 100_000_000;
/// yoctoNEAR × price_e8 / 1e26 = USD e6 (24 + 8 − 6 decimals).
pub const YOCTO_PRICE_TO_USD_E6: u128 = 100_000_000_000_000_000_000_000_000;
/// Share units per USD e6 when the vault has no shares yet: one share (1e24 units) is one USD
/// (1e6), so 1e18 units per micro-USD.
pub const FIRST_SHARES_PER_USD_E6: u128 = 1_000_000_000_000_000_000;
/// USD e6 per share before the first deposit.
pub const INITIAL_SHARE_PRICE_E6: u128 = 1_000_000;

/// NEAR (yocto) that `linear` LiNEAR is worth at `rate`.
pub fn linear_to_near(linear: u128, rate_e24: u128, rounding: Rounding) -> u128 {
    mul_div(linear, rate_e24, E24, rounding)
}

/// LiNEAR that `near` yoctoNEAR buys at `rate`, rounded down (the vault never credits LiNEAR
/// it may not hold).
pub fn near_to_linear(near: u128, rate_e24: u128) -> u128 {
    mul_div(near, E24, rate_e24, Rounding::Down)
}

/// USD e6 that `near` yoctoNEAR is worth at `price_e8`.
pub fn near_to_usd_e6(near: u128, price_e8: u128, rounding: Rounding) -> u128 {
    mul_div(near, price_e8, YOCTO_PRICE_TO_USD_E6, rounding)
}

/// yoctoNEAR worth `usd_e6` at `price_e8`, rounded down.
pub fn usd_e6_to_near(usd_e6: u128, price_e8: u128) -> u128 {
    mul_div(usd_e6, YOCTO_PRICE_TO_USD_E6, price_e8, Rounding::Down)
}

/// `a + b` for a signed `b`, floored at 0 and saturating at the top.
pub fn add_signed(a: u128, b: i128) -> u128 {
    if b >= 0 {
        a.saturating_add(b as u128)
    } else {
        a.saturating_sub(b.unsigned_abs())
    }
}

/// u128 to i128, saturating: report values are far below 2^127, and saturating keeps a
/// malformed one from wrapping into a negative number.
pub fn to_i128(v: u128) -> i128 {
    i128::try_from(v).unwrap_or(i128::MAX)
}

/// Net asset value in USD e6: the staked LiNEAR at `rate` and `price`, plus the depositors'
/// hedge equity (signed), floored at 0.
pub fn nav_e6(linear: u128, rate_e24: u128, price_e8: u128, equity_e6: i128, rounding: Rounding) -> u128 {
    let near = linear_to_near(linear, rate_e24, rounding);
    add_signed(near_to_usd_e6(near, price_e8, rounding), equity_e6)
}

/// USD e6 per share (1e24 units).
pub fn share_price_e6(nav_e6: u128, supply: u128) -> u128 {
    if supply == 0 {
        INITIAL_SHARE_PRICE_E6
    } else {
        mul_div(nav_e6, E24, supply, Rounding::Down)
    }
}

/// Shares minted for a deposit worth `value_e6`, rounded down. `nav_e6` must be the NAV rounded
/// up, so rounding never hands the depositor a sliver of the other holders' value.
///
/// None when shares exist but the NAV is 0 (every existing share would be worthless, and any
/// number of new shares would hand part of the new deposit to the old holders), or when the
/// result does not fit in u128. Checked rather than panicking: it runs in a callback that already
/// holds the depositor's NEAR, which must then be refunded.
pub fn shares_for(value_e6: u128, supply: u128, nav_e6: u128) -> Option<u128> {
    if supply == 0 {
        value_e6.checked_mul(FIRST_SHARES_PER_USD_E6)
    } else if nav_e6 == 0 {
        None
    } else {
        checked_mul_div(value_e6, supply, nav_e6, Rounding::Down)
    }
}

/// What one withdrawal pays and how it settles.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct Payout {
    /// LiNEAR sent to the leaver.
    pub linear: u128,
    /// LiNEAR of the leaver's pro rata share that is kept to back a negative hedge share (moved
    /// to the loss backing, out of NAV).
    pub retained: u128,
    /// The leaver's share of the depositors' hedge equity (USD e6, signed). Positive: paid in
    /// USDC from the settlement buffer. Negative: borne by paying less LiNEAR.
    pub pnl_e6: i128,
}

/// The payout for `shares` out of `supply`, given the depositors' LiNEAR, the hedge equity and
/// the prices. The fraction is f = shares / supply.
///
/// - Equity ≥ 0: LiNEAR f × L (down) and USDC f × E (down).
/// - Equity < 0: the leaver's loss is f × E rounded away from zero (the remaining holders never
///   carry part of it), and the leaver receives LiNEAR worth f × NAV (down), never more than the
///   pro rata f × L. The rest of the pro rata is retained.
pub fn payout(
    shares: u128,
    supply: u128,
    linear_total: u128,
    rate_e24: u128,
    price_e8: u128,
    equity_e6: i128,
) -> Payout {
    if shares == 0 || supply == 0 {
        return Payout::default();
    }
    let shares = shares.min(supply);
    let pro_rata = mul_div(linear_total, shares, supply, Rounding::Down);
    if equity_e6 >= 0 {
        let pnl = mul_div(equity_e6 as u128, shares, supply, Rounding::Down);
        return Payout { linear: pro_rata, retained: 0, pnl_e6: to_i128(pnl) };
    }
    let loss = mul_div(equity_e6.unsigned_abs(), shares, supply, Rounding::Up);
    let nav = nav_e6(linear_total, rate_e24, price_e8, equity_e6, Rounding::Down);
    let value = mul_div(nav, shares, supply, Rounding::Down);
    let linear =
        if value == 0 { 0 } else { near_to_linear(usd_e6_to_near(value, price_e8), rate_e24).min(pro_rata) };
    Payout { linear, retained: pro_rata - linear, pnl_e6: -to_i128(loss) }
}
