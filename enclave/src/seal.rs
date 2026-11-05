//! Sealed mandates. The person's trigger thresholds and strategy are encrypted in the browser to
//! the enclave's X25519 key, and only this build can open them.
//!
//! Format (base64 in the mandate's `sealed`): ephemeral public key (32) || nonce (12) ||
//! ChaCha20-Poly1305 ciphertext. Key = SHA-256("parry-seal:v1" || shared secret || ephemeral
//! public key || enclave public key). Associated data = the protected account id, so a sealed
//! policy copied onto another account fails to open.

use crate::io::{Io, Result};
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use serde::{Deserialize, Serialize};
use x25519_dalek::{PublicKey, StaticSecret};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Policy {
    /// Act at or above this risk score.
    pub trigger_score: u8,
    /// Act at or below this health, whatever the score.
    pub trigger_health: f64,
    /// Health a rescue aims for.
    pub target_health: f64,
    /// "repay-first", "keep-exposure" or "deleverage-only".
    pub strategy: String,
    /// Close this fraction of a Hyperliquid position when it is in danger (0..1).
    #[serde(default = "default_hl_reduce")]
    pub hl_reduce_fraction: f64,
    /// Act on an Aave position at or below this health.
    #[serde(default = "default_evm_trigger")]
    pub evm_trigger_health: f64,
}

fn default_hl_reduce() -> f64 {
    0.25
}

fn default_evm_trigger() -> f64 {
    1.2
}

impl Default for Policy {
    /// Used when a mandate carries no sealed policy: conservative public defaults.
    fn default() -> Self {
        Policy {
            trigger_score: 60,
            trigger_health: 1.15,
            target_health: 1.45,
            strategy: "repay-first".into(),
            hl_reduce_fraction: default_hl_reduce(),
            evm_trigger_health: default_evm_trigger(),
        }
    }
}

pub fn secret(io: &dyn Io) -> Result<StaticSecret> {
    Ok(StaticSecret::from(io.seal_secret()?))
}

pub fn public_key(io: &dyn Io) -> Result<[u8; 32]> {
    Ok(PublicKey::from(&secret(io)?).to_bytes())
}

fn key(shared: &[u8; 32], eph: &[u8; 32], enclave: &[u8; 32]) -> [u8; 32] {
    crate::sha256(&[b"parry-seal:v1".as_slice(), shared, eph, enclave].concat())
}

pub fn open(io: &dyn Io, sealed: &[u8], account: &str) -> Result<Policy> {
    if sealed.len() < 32 + 12 + 16 {
        return Err("sealed policy too short".into());
    }
    let sk = secret(io)?;
    let eph: [u8; 32] = sealed[..32].try_into().unwrap();
    let shared = sk.diffie_hellman(&PublicKey::from(eph));
    let k = key(shared.as_bytes(), &eph, &PublicKey::from(&sk).to_bytes());
    let cipher = ChaCha20Poly1305::new(Key::from_slice(&k));
    let plain = cipher
        .decrypt(
            Nonce::from_slice(&sealed[32..44]),
            Payload {
                msg: &sealed[44..],
                aad: account.as_bytes(),
            },
        )
        .map_err(|_| "sealed policy does not open with this enclave's key".to_string())?;
    serde_json::from_slice(&plain).map_err(|e| format!("sealed policy: {e}"))
}

/// Seals `policy` for `account` to `enclave_pk` (what the browser does; used by tests and tools).
pub fn seal(
    policy: &Policy,
    account: &str,
    enclave_pk: &[u8; 32],
    eph_secret: [u8; 32],
    nonce: [u8; 12],
) -> Vec<u8> {
    let eph = StaticSecret::from(eph_secret);
    let eph_pk = PublicKey::from(&eph).to_bytes();
    let shared = eph.diffie_hellman(&PublicKey::from(*enclave_pk));
    let k = key(shared.as_bytes(), &eph_pk, enclave_pk);
    let cipher = ChaCha20Poly1305::new(Key::from_slice(&k));
    let ct = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: &serde_json::to_vec(policy).unwrap(),
                aad: account.as_bytes(),
            },
        )
        .expect("encrypt");
    [eph_pk.as_slice(), &nonce, &ct].concat()
}
