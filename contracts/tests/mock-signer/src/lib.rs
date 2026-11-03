//! Sandbox test helper standing in for the MPC contract. It answers `sign` with a response of the
//! real shape, derived from the payload, and records every request so tests can check what a
//! contract asked to have signed. The real network signs on testnet.

use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::{env, near, require, NearToken};

#[derive(Serialize, Deserialize, Clone)]
#[serde(crate = "near_sdk::serde")]
pub struct Payload {
    #[serde(rename = "Ecdsa")]
    pub ecdsa: String,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(crate = "near_sdk::serde")]
pub struct SignRequest {
    pub path: String,
    pub payload_v2: Payload,
    pub domain_id: u32,
}

#[near(contract_state)]
#[derive(Default)]
pub struct MockSigner {
    requests: Vec<(String, String, String)>,
}

#[near]
impl MockSigner {
    #[payable]
    pub fn sign(&mut self, request: SignRequest) -> near_sdk::serde_json::Value {
        require!(env::attached_deposit() >= NearToken::from_yoctonear(1), "attach a deposit");
        self.requests.push((
            env::predecessor_account_id().to_string(),
            request.path,
            request.payload_v2.ecdsa.clone(),
        ));
        let r = hex::encode(env::sha256_array(format!("r{}", request.payload_v2.ecdsa).as_bytes()));
        let s = hex::encode(env::sha256_array(format!("s{}", request.payload_v2.ecdsa).as_bytes()));
        near_sdk::serde_json::json!({
            "scheme": "Secp256k1",
            "big_r": { "affine_point": format!("02{r}") },
            "s": { "scalar": s },
            "recovery_id": 1,
        })
    }

    /// (caller, path, payload hex) of every request, oldest first.
    pub fn requests(&self) -> Vec<(String, String, String)> {
        self.requests.clone()
    }
}
