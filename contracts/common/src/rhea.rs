//! Rhea lending (v0.16.2) wire types and Parry's own health factor computation over its views.
//!
//! Rhea keeps balances in "inner" units: the token's decimals plus the asset's `extra_decimals`
//! (so every asset has at least 18 decimals inside the contract). Health is
//! Σ collateral value × volatility ratio / Σ borrowed value / volatility ratio, and an account is
//! liquidatable below 1 (10000 bps).

use near_sdk::json_types::U128;
use near_sdk::serde_json;
use near_sdk::{near, AccountId};

use crate::math::{mul_div, pow10, Rounding, BPS};
use crate::pyth::PythPrice;

/// The transfer message that repays debt with the transferred tokens, without pricing.
pub const MSG_ONLY_REPAY: &str = "\"OnlyRepay\"";
/// The transfer message that adds the transferred tokens as collateral, without pricing.
pub const MSG_ONLY_INCREASE_COLLATERAL: &str = "\"OnlyIncreaseCollateral\"";

/// `execute_with_pyth` arguments for borrowing `amount_inner` of `token` and withdrawing it.
pub fn borrow_and_withdraw_args(token: &AccountId, amount_inner: u128) -> Vec<u8> {
    format!(
        r#"{{"actions":[{{"Borrow":{{"token_id":"{token}","amount":"{amount_inner}"}}}},{{"Withdraw":{{"token_id":"{token}","max_amount":"{amount_inner}"}}}}]}}"#
    )
    .into_bytes()
}

/// `execute` arguments that move supplied tokens into collateral (no pricing needed).
pub fn increase_collateral_args(token: &AccountId, amount_inner: Option<u128>) -> Vec<u8> {
    let amount = amount_inner.map_or("null".to_string(), |a| format!("\"{a}\""));
    format!(r#"{{"actions":[{{"IncreaseCollateral":{{"token_id":"{token}","amount":{amount}}}}}]}}"#)
        .into_bytes()
}

/// `simple_withdraw` arguments: withdraws from supply first, then from collateral (priced by
/// Rhea itself), and resolves to `true` only once the tokens reached the account.
pub fn simple_withdraw_args(token: &AccountId, amount_inner: u128) -> Vec<u8> {
    format!(r#"{{"token_id":"{token}","amount_with_inner_decimal":"{amount_inner}","recipient_id":null}}"#)
        .into_bytes()
}

/// One asset line of `get_account`.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct AssetLine {
    pub token_id: AccountId,
    /// Inner units.
    pub balance: U128,
}

/// The part of `get_account`'s view that health needs.
#[derive(Clone, Debug, Default)]
pub struct AccountLines {
    pub collateral: Vec<AssetLine>,
    pub borrowed: Vec<AssetLine>,
    pub supplied: Vec<AssetLine>,
}

/// The part of `get_account`'s JSON health needs; other fields are ignored.
#[near(serializers = [json])]
struct AccountView {
    #[serde(default)]
    collateral: Vec<AssetLine>,
    #[serde(default)]
    borrowed: Vec<AssetLine>,
    #[serde(default)]
    supplied: Vec<AssetLine>,
}

impl AccountLines {
    /// Parses `get_account`'s JSON (`null` for an unknown account).
    pub fn parse(bytes: &[u8]) -> Option<Self> {
        let v: Option<AccountView> = serde_json::from_slice(bytes).ok()?;
        Some(v.map_or_else(Self::default, |v| Self {
            collateral: v.collateral,
            borrowed: v.borrowed,
            supplied: v.supplied,
        }))
    }

    pub fn collateral_of(&self, token: &AccountId) -> u128 {
        self.collateral.iter().filter(|l| &l.token_id == token).map(|l| l.balance.0).sum()
    }

    pub fn borrowed_of(&self, token: &AccountId) -> u128 {
        self.borrowed.iter().filter(|l| &l.token_id == token).map(|l| l.balance.0).sum()
    }
}

/// What the health computation needs to know about one asset.
#[derive(Clone, Debug)]
pub struct PricedAsset {
    pub token_id: AccountId,
    /// Token decimals plus Rhea's extra decimals.
    pub inner_decimals: u8,
    pub volatility_ratio_bps: u32,
    pub price: PythPrice,
    /// NEAR per staked token scaled by 1e24 (LiNEAR's `ft_price`), when the asset needs it.
    pub rate_e24: Option<u128>,
}

/// USD value of `balance_inner` scaled by 1e18.
/// The part of `get_asset`'s JSON health needs.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct AssetView {
    pub config: AssetConfigView,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct AssetConfigView {
    pub volatility_ratio: u32,
}

pub fn value_e18(balance_inner: u128, asset: &PricedAsset) -> u128 {
    // value = balance / 10^inner * price * 10^expo, kept at 18 decimals.
    let price = asset.price.price_u128();
    let expo = asset.price.expo;
    // 18 + expo can be negative for very small exponents; the oracle uses -8 to -12.
    let scale = 18i32 + expo;
    let num_scale = if scale >= 0 { pow10(scale as u32) } else { 1 };
    let den_scale = pow10(asset.inner_decimals as u32) * if scale < 0 { pow10((-scale) as u32) } else { 1 };
    let mut v = mul_div(balance_inner, price * num_scale, den_scale, Rounding::Down);
    if let Some(rate) = asset.rate_e24 {
        v = mul_div(v, rate, pow10(24), Rounding::Down);
    }
    v
}

/// Health factor in bps (10000 = 1.0), or None when the account has no debt. Collateral of an
/// asset missing from `assets` counts as zero; debt of a missing asset makes health unknown.
pub fn health_bps(lines: &AccountLines, assets: &[PricedAsset]) -> Result<Option<u128>, AccountId> {
    let find = |t: &AccountId| assets.iter().find(|a| &a.token_id == t);
    let mut adjusted_collateral: u128 = 0;
    for l in &lines.collateral {
        if let Some(a) = find(&l.token_id) {
            adjusted_collateral +=
                mul_div(value_e18(l.balance.0, a), a.volatility_ratio_bps as u128, BPS, Rounding::Down);
        }
    }
    let mut adjusted_debt: u128 = 0;
    for l in &lines.borrowed {
        let a = find(&l.token_id).ok_or_else(|| l.token_id.clone())?;
        adjusted_debt +=
            mul_div(value_e18(l.balance.0, a), BPS, (a.volatility_ratio_bps as u128).max(1), Rounding::Up);
    }
    if adjusted_debt == 0 {
        return Ok(None);
    }
    Ok(Some(mul_div(adjusted_collateral, BPS, adjusted_debt, Rounding::Down)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::json_types::{I64, U64};

    fn near_asset(price_e8: i64) -> PricedAsset {
        PricedAsset {
            token_id: "wrap.testnet".parse().unwrap(),
            inner_decimals: 24,
            volatility_ratio_bps: 6000,
            price: PythPrice { price: I64(price_e8), conf: U64(0), expo: -8, publish_time: 0 },
            rate_e24: None,
        }
    }

    fn usdc_asset() -> PricedAsset {
        PricedAsset {
            token_id: "usdc.parry.testnet".parse().unwrap(),
            inner_decimals: 18,
            volatility_ratio_bps: 9500,
            price: PythPrice { price: I64(100_000_000), conf: U64(0), expo: -8, publish_time: 0 },
            rate_e24: None,
        }
    }

    #[test]
    fn values_in_usd() {
        // 10 NEAR at $3.50 = $35.
        assert_eq!(value_e18(10 * pow10(24), &near_asset(350_000_000)), 35 * pow10(18));
        // 12.5 USDC in inner (18) units = $12.5.
        assert_eq!(value_e18(125 * pow10(17), &usdc_asset()), 125 * pow10(17));
    }

    #[test]
    fn health_matches_hand_computation() {
        // 100 NEAR at $3.00 collateral (ratio 0.6) = 180 adjusted; 150 USDC debt (ratio 0.95)
        // = 157.894... adjusted; health = 1.14 (11400 bps).
        let lines = AccountLines {
            collateral: vec![AssetLine {
                token_id: "wrap.testnet".parse().unwrap(),
                balance: U128(100 * pow10(24)),
            }],
            borrowed: vec![AssetLine {
                token_id: "usdc.parry.testnet".parse().unwrap(),
                balance: U128(150 * pow10(18)),
            }],
            supplied: vec![],
        };
        let h = health_bps(&lines, &[near_asset(300_000_000), usdc_asset()]).unwrap().unwrap();
        assert_eq!(h, 11_399);
    }

    #[test]
    fn unknown_debt_is_reported() {
        let lines = AccountLines {
            collateral: vec![],
            borrowed: vec![AssetLine { token_id: "other.testnet".parse().unwrap(), balance: U128(1) }],
            supplied: vec![],
        };
        assert_eq!(health_bps(&lines, &[usdc_asset()]).unwrap_err().as_str(), "other.testnet");
    }

    #[test]
    fn parses_the_view() {
        let raw = br#"{"account_id":"a.testnet","supplied":[],"collateral":[{"token_id":"wrap.testnet","balance":"5","shares":"5","apr":"0"}],"borrowed":[],"farms":[],"has_non_farmed_assets":false}"#;
        let l = AccountLines::parse(raw).unwrap();
        assert_eq!(l.collateral_of(&"wrap.testnet".parse().unwrap()), 5);
        assert!(AccountLines::parse(b"null").unwrap().collateral.is_empty());
    }
}
