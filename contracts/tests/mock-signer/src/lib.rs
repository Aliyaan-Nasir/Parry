//! Sandbox test helper standing in for the MPC contract. Like the real one it derives a
//! secp256k1 key per caller and path (`derived_public_key`) and answers `sign` with a recoverable
//! signature by that key in the real response shape, so a signature recovers to the caller's
//! derived address exactly as on testnet. The keys come from a public hash, so they protect
//! nothing: this exists only for the local sandbox. It also records every request so tests can
//! check what a contract asked to have signed.

use k256::ecdsa::SigningKey;
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::{bs58, env, near, require, AccountId, NearToken};

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

/// The stand-in's key for `predecessor` at `path`: a hash of both (public, sandbox only).
fn key(predecessor: &str, path: &str) -> SigningKey {
    let seed = env::sha256_array(format!("parry-sandbox-signer:{predecessor},{path}").as_bytes());
    SigningKey::from_slice(&seed).unwrap_or_else(|_| env::panic_str("derived key out of range"))
}

#[near]
impl MockSigner {
    #[payable]
    pub fn sign(&mut self, request: SignRequest) -> near_sdk::serde_json::Value {
        require!(env::attached_deposit() >= NearToken::from_yoctonear(1), "attach a deposit");
        require!(request.domain_id == 0, "only domain 0 (secp256k1)");
        let caller = env::predecessor_account_id().to_string();
        let payload: [u8; 32] = hex::decode(&request.payload_v2.ecdsa)
            .ok()
            .and_then(|b| b.try_into().ok())
            .unwrap_or_else(|| env::panic_str("payload must be 32 bytes of hex"));
        let (sig, recid) = key(&caller, &request.path)
            .sign_prehash_recoverable(&payload)
            .unwrap_or_else(|_| env::panic_str("signing failed"));
        self.requests.push((caller, request.path, request.payload_v2.ecdsa));
        let (r, s) = sig.split_bytes();
        let prefix = if recid.is_y_odd() { "03" } else { "02" };
        near_sdk::serde_json::json!({
            "scheme": "Secp256k1",
            "big_r": { "affine_point": format!("{prefix}{}", hex::encode(r)) },
            "s": { "scalar": hex::encode(s) },
            "recovery_id": recid.to_byte() & 1,
        })
    }

    /// The public key `sign` uses for `predecessor` at `path`, as the real contract returns it.
    pub fn derived_public_key(&self, path: String, predecessor: AccountId, domain_id: Option<u32>) -> String {
        require!(domain_id.unwrap_or(0) == 0, "only domain 0 (secp256k1)");
        let point = key(predecessor.as_str(), &path).verifying_key().to_encoded_point(false);
        format!("secp256k1:{}", bs58::encode(&point.as_bytes()[1..]).into_string())
    }

    /// (caller, path, payload hex) of every request, oldest first.
    pub fn requests(&self) -> Vec<(String, String, String)> {
        self.requests.clone()
    }
}
