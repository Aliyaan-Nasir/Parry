//! The Pyth price shape that NEAR's Pyth contract, Rhea lending and Parry's testnet oracle share.

use near_sdk::json_types::{I64, U64};
use near_sdk::{env, near};

/// `{ "price": "<i64>", "conf": "<u64>", "expo": <i32>, "publish_time": <i64> }`.
#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PythPrice {
    pub price: I64,
    pub conf: U64,
    pub expo: i32,
    pub publish_time: i64,
}

impl PythPrice {
    /// The price as an unsigned integer, refusing non-positive prices.
    pub fn price_u128(&self) -> u128 {
        if self.price.0 <= 0 {
            env::panic_str("oracle price must be positive");
        }
        self.price.0 as u128
    }

    /// The price scaled to 1e8 (Hyperliquid marks and Parry's reports use 1e8).
    pub fn price_e8(&self) -> u128 {
        let p = self.price_u128();
        let shift = self.expo + 8;
        if shift >= 0 {
            p * crate::math::pow10(shift as u32)
        } else {
            p / crate::math::pow10((-shift) as u32)
        }
    }

    /// True when the price was published at most `max_age` seconds before `now`.
    pub fn is_fresh(&self, now: u64, max_age: u64) -> bool {
        self.publish_time > 0 && now.saturating_sub(self.publish_time as u64) <= max_age
    }
}

/// Pyth's id for NEAR/USD.
pub const NEAR_USD: &str = "c415de8d2eba7db216527dff4b60e8f3a5311c740dadb233e13e12547e226750";
/// Pyth's id for USDC/USD.
pub const USDC_USD: &str = "eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scales_to_e8() {
        let p = PythPrice { price: I64(363_445_000), conf: U64(1), expo: -8, publish_time: 10 };
        assert_eq!(p.price_e8(), 363_445_000);
        let p = PythPrice { price: I64(3_634_450), conf: U64(1), expo: -6, publish_time: 10 };
        assert_eq!(p.price_e8(), 363_445_000);
        let p = PythPrice { price: I64(36_344_500_000), conf: U64(1), expo: -10, publish_time: 10 };
        assert_eq!(p.price_e8(), 363_445_000);
        assert!(p.is_fresh(70, 60));
        assert!(!p.is_fresh(71, 60));
    }

    #[test]
    fn json_shape() {
        let p = PythPrice { price: I64(5), conf: U64(1), expo: -8, publish_time: 7 };
        assert_eq!(
            near_sdk::serde_json::to_string(&p).unwrap(),
            r#"{"price":"5","conf":"1","expo":-8,"publish_time":7}"#
        );
    }
}
