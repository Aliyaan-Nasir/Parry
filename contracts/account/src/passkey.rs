//! Passkey (WebAuthn, P-256) assertions, checked on chain with NEAR's `p256_verify`.
//!
//! The challenge is SHA-256 of the domain-separated request text. The authenticator signs
//! SHA-256(authenticatorData || SHA-256(clientDataJSON)); the browser returns the signature in
//! DER, which the app converts to 64-byte r || s before sending it.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use near_sdk::{env, near, serde_json};

/// An assertion as the app sends it.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct Assertion {
    /// base64url (no padding).
    pub authenticator_data: String,
    /// The exact clientDataJSON text the authenticator signed.
    pub client_data_json: String,
    /// r || s, 64 bytes, hex.
    pub signature: String,
}

#[near(serializers = [json])]
struct ClientData {
    #[serde(rename = "type")]
    kind: String,
    challenge: String,
}

/// User present and user verified: the person unlocked the passkey (biometrics or PIN).
const REQUIRED_FLAGS: u8 = 0x01 | 0x04;

/// True when `assertion` is `owner_key` (33-byte compressed P-256) signing `challenge`.
pub fn verify(challenge: &[u8; 32], assertion: &Assertion, owner_key: &[u8]) -> bool {
    let Ok(key) = <[u8; 33]>::try_from(owner_key) else { return false };
    let Ok(auth) = URL_SAFE_NO_PAD.decode(assertion.authenticator_data.trim_end_matches('=')) else {
        return false;
    };
    // 32-byte rp id hash, 1 flags byte, 4-byte counter.
    if auth.len() < 37 || auth[32] & REQUIRED_FLAGS != REQUIRED_FLAGS {
        return false;
    }
    let Ok(client) = serde_json::from_slice::<ClientData>(assertion.client_data_json.as_bytes()) else {
        return false;
    };
    if client.kind != "webauthn.get" || client.challenge != URL_SAFE_NO_PAD.encode(challenge) {
        return false;
    }
    let Some(sig) = hex::decode(&assertion.signature).ok().and_then(|b| <[u8; 64]>::try_from(b).ok()) else {
        return false;
    };
    let mut signed = auth;
    signed.extend_from_slice(&env::sha256_array(assertion.client_data_json.as_bytes()));
    env::p256_verify(&sig, &env::sha256_array(&signed), &key)
}
