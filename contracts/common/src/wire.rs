//! Cross-contract call arguments as JSON text, without building a `serde_json::Value` (which
//! would add tens of kilobytes to every contract that uses it).
//!
//! Every value interpolated into these templates is an account id, a decimal number, a hex
//! string or a bool, none of which needs escaping; free text goes through `quote`.

use near_sdk::{serde_json, AccountId};

/// A JSON string literal for `s`.
pub fn quote(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| near_sdk::env::panic_str("unencodable string"))
}

pub fn ft_transfer(receiver: &AccountId, amount: u128) -> Vec<u8> {
    format!(r#"{{"receiver_id":"{receiver}","amount":"{amount}"}}"#).into_bytes()
}

pub fn ft_transfer_call(receiver: &AccountId, amount: u128, msg: &str) -> Vec<u8> {
    format!(r#"{{"receiver_id":"{receiver}","amount":"{amount}","msg":{}}}"#, quote(msg)).into_bytes()
}

pub fn storage_deposit(account: &AccountId, registration_only: bool) -> Vec<u8> {
    format!(r#"{{"account_id":"{account}","registration_only":{registration_only}}}"#).into_bytes()
}

pub fn register_tokens<'a>(tokens: impl Iterator<Item = &'a AccountId>) -> Vec<u8> {
    let list: Vec<String> = tokens.map(|t| format!("\"{t}\"")).collect();
    format!(r#"{{"token_ids":[{}]}}"#, list.join(",")).into_bytes()
}

pub fn account_id(account: &AccountId) -> Vec<u8> {
    format!(r#"{{"account_id":"{account}"}}"#).into_bytes()
}

pub fn token_id(token: &AccountId) -> Vec<u8> {
    format!(r#"{{"token_id":"{token}"}}"#).into_bytes()
}

pub fn asset(asset: &str) -> Vec<u8> {
    format!(r#"{{"asset":{}}}"#, quote(asset)).into_bytes()
}

/// Chain Signatures `sign` for a 32-byte secp256k1 payload (domain 0).
pub fn mpc_sign(path: &str, payload_hex: &str) -> Vec<u8> {
    format!(
        r#"{{"request":{{"path":{},"payload_v2":{{"Ecdsa":"{payload_hex}"}},"domain_id":0}}}}"#,
        quote(path)
    )
    .into_bytes()
}

pub fn price_no_older_than(price_id: &str, age: u64) -> Vec<u8> {
    format!(r#"{{"price_id":"{price_id}","age":{age}}}"#).into_bytes()
}

/// One-hop exchange swap from the caller's exchange deposit.
pub fn dex_swap(
    pool_id: u64,
    token_in: &AccountId,
    amount_in: u128,
    token_out: &AccountId,
    min_out: u128,
) -> Vec<u8> {
    format!(
        r#"{{"actions":[{{"pool_id":{pool_id},"token_in":"{token_in}","amount_in":"{amount_in}","token_out":"{token_out}","min_amount_out":"{min_out}"}}],"referral_id":null}}"#
    )
    .into_bytes()
}

/// Exchange withdrawal that keeps wNEAR wrapped.
pub fn dex_withdraw(token: &AccountId, amount: u128) -> Vec<u8> {
    format!(r#"{{"token_id":"{token}","amount":"{amount}","unregister":false,"skip_unwrap_near":true}}"#)
        .into_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::serde_json::Value;

    fn parse(b: Vec<u8>) -> Value {
        serde_json::from_slice(&b).unwrap()
    }

    #[test]
    fn templates_are_valid_json() {
        let a: AccountId = "usdc.parry.testnet".parse().unwrap();
        let v = parse(ft_transfer_call(&a, 5, "\"OnlyRepay\""));
        assert_eq!(v["msg"], "\"OnlyRepay\"");
        assert_eq!(v["amount"], "5");
        assert_eq!(parse(register_tokens([&a, &a].into_iter()))["token_ids"][1], "usdc.parry.testnet");
        assert_eq!(parse(mpc_sign("parry-evm", "ab"))["request"]["payload_v2"]["Ecdsa"], "ab");
        assert_eq!(parse(dex_swap(7, &a, 1, &a, 2))["actions"][0]["pool_id"], 7);
        assert_eq!(parse(dex_withdraw(&a, 3))["skip_unwrap_near"], true);
        assert_eq!(parse(asset("NE\"AR"))["asset"], "NE\"AR");
        assert_eq!(parse(storage_deposit(&a, true))["registration_only"], true);
    }
}
