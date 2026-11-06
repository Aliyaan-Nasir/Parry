//! Hedge sizing and the Hyperliquid order the vault signs, as pure functions.
//!
//! Hyperliquid refuses an order whose price or size has more precision than the asset allows,
//! so the vault formats both itself instead of trusting a keeper to send valid strings:
//!
//! - Size: a multiple of the asset's lot, 10^-szDecimals, rounded down (never more than the
//!   difference the vault wants to trade).
//! - Price (perps): at most 5 significant figures and at most 6 − szDecimals decimals; an
//!   integer price is always accepted. The limit sits `band_bps` away from the mark and is
//!   rounded toward the mark, so the price never leaves the band.
//! - Both are plain decimal strings without trailing zeros ("3.5619", "120", "0.5").

use parry_common::hyperliquid::HlOrder;
use parry_common::math::{apply_bps, checked_mul_div, mul_div, pow10, Rounding, BPS};

use crate::nav::{linear_to_near, E8};
use crate::HedgeConfig;

/// Hyperliquid's decimal budget for perp prices: `6 − szDecimals`.
pub const PERP_MAX_DECIMALS: u32 = 6;
/// Significant figures Hyperliquid keeps in a non-integer price.
pub const PRICE_SIG_FIGS: u32 = 5;
/// The hedge trades only when it is off target by at least this share of the target...
pub const REBALANCE_THRESHOLD_BPS: u128 = 200;
/// ...and by at least one NEAR, so dust never costs a signature and an order.
pub const REBALANCE_MIN_E8: u128 = E8;
/// 1e16: yoctoNEAR per Hyperliquid size unit (1e24 / 1e8).
const YOCTO_PER_E8: u128 = 10_000_000_000_000_000;

/// The short (NEAR, 1e8) that hedges the active shares: ratio × X × active / supply, where X is
/// the NEAR the staked LiNEAR is worth. Shares escrowed in the withdrawal queue are left out, so
/// the keeper unwinds their hedge before they are paid.
pub fn target_short_e8(linear: u128, rate_e24: u128, active: u128, supply: u128, ratio_bps: u32) -> u128 {
    if supply == 0 || active == 0 {
        return 0;
    }
    let exposure = linear_to_near(linear, rate_e24, Rounding::Down);
    let active_exposure = mul_div(exposure, active.min(supply), supply, Rounding::Down);
    apply_bps(active_exposure, ratio_bps as u128, Rounding::Down) / YOCTO_PER_E8
}

/// The largest short (1e8) whose notional at `mark_e8` stays within `max_leverage_x100` of the
/// hedge account's value: size × mark / 1e10 is the notional in USD e6, and notional × 100 /
/// account value is the leverage ×100.
pub fn leverage_cap_e8(account_value_e6: u128, max_leverage_x100: u32, mark_e8: u128) -> u128 {
    if mark_e8 == 0 {
        return 0;
    }
    let budget = account_value_e6.saturating_mul(max_leverage_x100 as u128);
    checked_mul_div(budget, E8, mark_e8, Rounding::Down).unwrap_or(u128::MAX)
}

/// Leverage ×100 of a position of `size_e8` at `mark_e8` on `account_value_e6`, rounded up (a
/// risk figure should never look better than it is). u32::MAX when the account is empty.
pub fn leverage_x100(size_e8: u128, mark_e8: u128, account_value_e6: u128) -> u32 {
    if size_e8 == 0 || mark_e8 == 0 {
        return 0;
    }
    if account_value_e6 == 0 {
        return u32::MAX;
    }
    let denominator = account_value_e6.saturating_mul(E8);
    checked_mul_div(size_e8, mark_e8, denominator, Rounding::Up).unwrap_or(u128::MAX).min(u32::MAX as u128)
        as u32
}

/// Number of decimal digits of `v` (1 for 0).
fn digits(mut v: u128) -> u32 {
    let mut n = 1;
    while v >= 10 {
        v /= 10;
        n += 1;
    }
    n
}

/// Decimals Hyperliquid accepts for a perp price of `price_e8`: enough for 5 significant figures
/// (none for prices of 10000 and above), capped at 6 − szDecimals.
pub fn price_decimals(price_e8: u128, sz_decimals: u8) -> u32 {
    // The leading digit of price_e8 sits at 10^(digits - 1 - 8); keeping 5 significant figures
    // keeps decimals down to 10^(digits - 8 - 5).
    let for_sig_figs = (8 + PRICE_SIG_FIGS).saturating_sub(digits(price_e8));
    for_sig_figs.min(PERP_MAX_DECIMALS.saturating_sub(sz_decimals as u32)).min(8)
}

/// Rounds `price_e8` to a price Hyperliquid accepts, up or down.
pub fn round_price_e8(price_e8: u128, sz_decimals: u8, up: bool) -> u128 {
    let step = pow10(8 - price_decimals(price_e8, sz_decimals));
    let down = price_e8 - price_e8 % step;
    if up && down != price_e8 {
        down + step
    } else {
        down
    }
}

/// Rounds `size_e8` down to the asset's lot (10^-szDecimals).
pub fn round_size_e8(size_e8: u128, sz_decimals: u8) -> u128 {
    let step = pow10(8u32.saturating_sub(sz_decimals as u32));
    size_e8 - size_e8 % step
}

/// `v` (scaled 1e8) as a decimal string without trailing zeros: 356190000 → "3.5619",
/// 12000000000 → "120", 50000000 → "0.5".
pub fn format_e8(v: u128) -> String {
    let whole = v / E8;
    let frac = v % E8;
    if frac == 0 {
        return whole.to_string();
    }
    let mut f = format!("{frac:08}");
    while f.ends_with('0') {
        f.pop();
    }
    format!("{whole}.{f}")
}

/// The IOC order that moves the short from `current_e8` (positive is short) to `target_e8`, or
/// None while the difference is inside the band (below max(2% of the target, 1 NEAR)) or rounds
/// to nothing.
///
/// Growing the short sells at mark × (1 − band); shrinking it buys, reduce-only, at
/// mark × (1 + band), so a buy can only close part of the short and never open a long.
pub fn order_for(cfg: &HedgeConfig, target_e8: u128, current_e8: i128, mark_e8: u128) -> Option<HlOrder> {
    let diff = crate::nav::to_i128(target_e8) - current_e8;
    let gap = diff.unsigned_abs();
    let threshold = apply_bps(target_e8, REBALANCE_THRESHOLD_BPS, Rounding::Down).max(REBALANCE_MIN_E8);
    if gap < threshold {
        return None;
    }
    let size = round_size_e8(gap, cfg.sz_decimals);
    let sell = diff > 0;
    let band = cfg.band_bps as u128;
    let raw = if sell {
        apply_bps(mark_e8, BPS - band, Rounding::Up)
    } else {
        apply_bps(mark_e8, BPS + band, Rounding::Down)
    };
    // Toward the mark: up for a sell limit, down for a buy limit.
    let price = round_price_e8(raw, cfg.sz_decimals, sell);
    if size == 0 || price == 0 {
        return None;
    }
    Some(HlOrder {
        asset_index: cfg.asset_index,
        is_buy: !sell,
        price: format_e8(price),
        size: format_e8(size),
        reduce_only: !sell,
        tif: "Ioc".to_string(),
    })
}
