//! Cross-language check: a policy sealed by the TypeScript SDK (`sealPolicy` in packages/sdk)
//! opens with this enclave's `seal::open`, and sealing the same policy here with the same
//! ephemeral secret and nonce gives the same bytes.

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use parry_enclave::io::{Io, Result};
use parry_enclave::seal::{self, Policy};
use serde_json::Value;
use x25519_dalek::{PublicKey, StaticSecret};

const FIXTURE: &str = include_str!("../../packages/sdk/test/fixtures/sealed.json");

/// An outside world that only knows the sealing secret.
struct SealOnly([u8; 32]);

impl Io for SealOnly {
    fn get(&self, url: &str, _headers: &[(&str, &str)]) -> Result<Vec<u8>> {
        Err(format!("no network in this test: {url}"))
    }
    fn post(&self, url: &str, _headers: &[(&str, &str)], _body: &[u8]) -> Result<Vec<u8>> {
        Err(format!("no network in this test: {url}"))
    }
    fn sign(&self, _message: &[u8]) -> Result<[u8; 64]> {
        Err("no signing key in this test".into())
    }
    fn public_key(&self) -> Result<[u8; 32]> {
        Err("no signing key in this test".into())
    }
    fn seal_secret(&self) -> Result<[u8; 32]> {
        Ok(self.0)
    }
    fn secret(&self, _name: &str) -> Option<String> {
        None
    }
    fn now(&self) -> u64 {
        0
    }
}

fn bytes<const N: usize>(v: &Value) -> [u8; N] {
    hex::decode(v.as_str().unwrap())
        .unwrap()
        .try_into()
        .unwrap()
}

#[test]
fn a_policy_sealed_by_the_sdk_opens_here() {
    let f: Value = serde_json::from_str(FIXTURE).unwrap();
    let seed: [u8; 32] = bytes(&f["enclave_secret"]);
    let enclave_pk = PublicKey::from(&StaticSecret::from(seed)).to_bytes();
    assert_eq!(
        hex::encode(enclave_pk),
        f["enclave_public_key"].as_str().unwrap()
    );

    let io = SealOnly(seed);
    assert_eq!(seal::public_key(&io).unwrap(), enclave_pk);
    let account = f["account"].as_str().unwrap();
    let sealed = STANDARD.decode(f["sealed"].as_str().unwrap()).unwrap();

    let opened = seal::open(&io, &sealed, account).unwrap();
    let want: Policy = serde_json::from_value(f["policy"].clone()).unwrap();
    assert_eq!(opened, want);
    // The SDK wrote the plaintext exactly as serde_json writes the policy.
    assert_eq!(
        serde_json::to_string(&opened).unwrap(),
        f["plaintext"].as_str().unwrap()
    );

    // Same inputs, same bytes.
    let again = seal::seal(
        &want,
        account,
        &enclave_pk,
        bytes(&f["ephemeral_secret"]),
        bytes(&f["nonce"]),
    );
    assert_eq!(STANDARD.encode(again), f["sealed"].as_str().unwrap());

    // Bound to the account and to this enclave's key.
    assert!(seal::open(&io, &sealed, "0uanother.testnet").is_err());
    assert!(seal::open(&SealOnly([7u8; 32]), &sealed, account).is_err());
}
