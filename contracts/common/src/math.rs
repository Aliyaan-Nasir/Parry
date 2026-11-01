//! Fixed-point helpers on u128 with explicit rounding.
//!
//! Every product that could overflow u128 goes through a 256-bit intermediate, so `a * b / c`
//! is exact before the final rounding. Callers pick the rounding direction on purpose: amounts a
//! contract pays out round down, amounts it charges or requires round up.

use near_sdk::env;

/// Basis points in one whole.
pub const BPS: u128 = 10_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Rounding {
    Down,
    Up,
}

/// 256-bit product of two u128 values as (high, low).
fn mul_wide(a: u128, b: u128) -> (u128, u128) {
    let mask = u64::MAX as u128;
    let (a_hi, a_lo) = (a >> 64, a & mask);
    let (b_hi, b_lo) = (b >> 64, b & mask);
    let lo_lo = a_lo * b_lo;
    let hi_lo = a_hi * b_lo;
    let lo_hi = a_lo * b_hi;
    let hi_hi = a_hi * b_hi;
    let cross = (lo_lo >> 64) + (hi_lo & mask) + (lo_hi & mask);
    let low = (cross << 64) | (lo_lo & mask);
    let high = hi_hi + (hi_lo >> 64) + (lo_hi >> 64) + (cross >> 64);
    (high, low)
}

/// Divides the 256-bit value (high, low) by `d`, returning (quotient, remainder), or None when the
/// quotient does not fit in u128.
fn div_wide(high: u128, low: u128, d: u128) -> Option<(u128, u128)> {
    if d == 0 || high >= d {
        return None;
    }
    // Shift-subtract long division, one bit at a time: 128 iterations, exact and branch-simple.
    let mut rem = high;
    let mut quo: u128 = 0;
    for i in (0..128).rev() {
        let carry = rem >> 127;
        rem = (rem << 1) | ((low >> i) & 1);
        quo <<= 1;
        if carry == 1 || rem >= d {
            rem = rem.wrapping_sub(d);
            quo |= 1;
        }
    }
    Some((quo, rem))
}

/// `a * b / c` with the chosen rounding, or None on division by zero or overflow.
pub fn checked_mul_div(a: u128, b: u128, c: u128, rounding: Rounding) -> Option<u128> {
    let (high, low) = mul_wide(a, b);
    let (q, r) = div_wide(high, low, c)?;
    match rounding {
        Rounding::Down => Some(q),
        Rounding::Up if r > 0 => q.checked_add(1),
        Rounding::Up => Some(q),
    }
}

/// `a * b / c`, panicking with a clear message on overflow or a zero divisor.
pub fn mul_div(a: u128, b: u128, c: u128, rounding: Rounding) -> u128 {
    checked_mul_div(a, b, c, rounding).unwrap_or_else(|| env::panic_str("math overflow in mul_div"))
}

/// `amount * bps / 10_000`.
pub fn apply_bps(amount: u128, bps: u128, rounding: Rounding) -> u128 {
    mul_div(amount, bps, BPS, rounding)
}

/// `10^exp` for small exponents, panicking past u128.
pub fn pow10(exp: u32) -> u128 {
    10u128.checked_pow(exp).unwrap_or_else(|| env::panic_str("pow10 overflow"))
}

/// Absolute difference of `a` and `b` in basis points of `reference` (rounded up, so a deviation
/// check never lets an amount slip through by rounding).
pub fn deviation_bps(a: u128, b: u128, reference: u128) -> u128 {
    let diff = a.abs_diff(b);
    mul_div(diff, BPS, reference.max(1), Rounding::Up)
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    #[test]
    fn exact_cases() {
        assert_eq!(mul_div(10, 3, 4, Rounding::Down), 7);
        assert_eq!(mul_div(10, 3, 4, Rounding::Up), 8);
        assert_eq!(mul_div(12, 3, 4, Rounding::Up), 9);
        assert_eq!(mul_div(u128::MAX, u128::MAX, u128::MAX, Rounding::Down), u128::MAX);
        assert_eq!(mul_div(u128::MAX, 2, 4, Rounding::Down), u128::MAX / 2);
        assert_eq!(checked_mul_div(u128::MAX, 2, 1, Rounding::Down), None);
        assert_eq!(checked_mul_div(1, 1, 0, Rounding::Down), None);
        assert_eq!(apply_bps(1_000_000, 9_000, Rounding::Down), 900_000);
        assert_eq!(deviation_bps(102, 100, 100), 200);
        assert_eq!(deviation_bps(98, 100, 100), 200);
    }

    proptest! {
        #[test]
        fn matches_wide_reference(a in any::<u64>(), b in any::<u64>(), c in 1u64..) {
            let (a, b, c) = (a as u128, b as u128, c as u128);
            let exact = a * b; // fits: u64 * u64 < 2^128
            prop_assert_eq!(mul_div(a, b, c, Rounding::Down), exact / c);
            prop_assert_eq!(mul_div(a, b, c, Rounding::Up), exact.div_ceil(c));
        }

        #[test]
        fn up_is_down_or_one_more(a in any::<u128>(), b in any::<u128>(), c in 1u128..) {
            if let (Some(d), Some(u)) = (checked_mul_div(a, b, c, Rounding::Down), checked_mul_div(a, b, c, Rounding::Up)) {
                prop_assert!(u == d || u == d + 1);
            }
        }

        #[test]
        fn division_identity(q in any::<u64>(), d in 1u128.., r_seed in any::<u128>()) {
            // (q * d + r) / d == q for r < d, through the wide path.
            let r = r_seed % d;
            if let Some(n) = (q as u128).checked_mul(d).and_then(|x| x.checked_add(r)) {
                prop_assert_eq!(mul_div(n, 1, d, Rounding::Down), q as u128);
            }
        }
    }
}
