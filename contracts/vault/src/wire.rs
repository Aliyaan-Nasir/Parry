//! Cross-contract arguments the vault needs beyond `parry_common::wire`, written as JSON text for
//! the same reason: no `serde_json::Value` in the wasm.

/// Arguments of a call that takes none (`ft_price`, `deposit_and_stake`).
pub const NO_ARGS: &[u8] = b"{}";

/// wNEAR's `near_withdraw`.
pub fn near_withdraw(amount: u128) -> Vec<u8> {
    format!(r#"{{"amount":"{amount}"}}"#).into_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::serde_json::{self, Value};

    #[test]
    fn templates_are_valid_json() {
        let v: Value = serde_json::from_slice(&near_withdraw(7)).unwrap();
        assert_eq!(v["amount"], "7");
        let v: Value = serde_json::from_slice(NO_ARGS).unwrap();
        assert!(v.as_object().unwrap().is_empty());
    }
}
