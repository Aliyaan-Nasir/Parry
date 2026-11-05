//! The enclave's logic run natively, for the local sandbox and development only. It signs with a
//! key from `PARRY_LOCAL_ENCLAVE_SEED` (32 bytes hex), which no testnet or mainnet mandate ever
//! names: protected accounts there trust only the OutLayer key bound to the wasm build.
//!
//! Usage: echo '{"mode":"keys"}' | parry-enclave-local

use ed25519_dalek::{Signer, SigningKey};
use parry_enclave::io::{Io, Result};
use std::io::Read;

struct Local {
    key: SigningKey,
}

impl Io for Local {
    fn get(&self, url: &str, headers: &[(&str, &str)]) -> Result<Vec<u8>> {
        let mut req = ureq::get(url).timeout(std::time::Duration::from_secs(30));
        for (k, v) in headers {
            req = req.set(k, v);
        }
        read(req.call().map_err(|e| format!("GET {url}: {e}"))?)
    }
    fn post(&self, url: &str, headers: &[(&str, &str)], body: &[u8]) -> Result<Vec<u8>> {
        let mut req = ureq::post(url).timeout(std::time::Duration::from_secs(60));
        for (k, v) in headers {
            req = req.set(k, v);
        }
        read(
            req.send_bytes(body)
                .map_err(|e| format!("POST {url}: {e}"))?,
        )
    }
    fn sign(&self, message: &[u8]) -> Result<[u8; 64]> {
        Ok(self.key.sign(message).to_bytes())
    }
    fn public_key(&self) -> Result<[u8; 32]> {
        Ok(self.key.verifying_key().to_bytes())
    }
    fn seal_secret(&self) -> Result<[u8; 32]> {
        Ok(parry_enclave::sha256(
            &[b"parry-seal:x25519:v1".as_slice(), &self.key.to_bytes()].concat(),
        ))
    }
    fn secret(&self, name: &str) -> Option<String> {
        std::env::var(name).ok().filter(|v| !v.is_empty())
    }
    fn now(&self) -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0)
    }
}

fn read(res: ureq::Response) -> Result<Vec<u8>> {
    let mut out = vec![];
    res.into_reader()
        .take(16 << 20)
        .read_to_end(&mut out)
        .map_err(|e| e.to_string())?;
    Ok(out)
}

fn main() {
    let seed = std::env::var("PARRY_LOCAL_ENCLAVE_SEED").unwrap_or_default();
    let Ok(bytes) = hex::decode(seed.trim()) else {
        eprintln!("PARRY_LOCAL_ENCLAVE_SEED must be 32 bytes of hex");
        std::process::exit(2);
    };
    let Ok(seed) = <[u8; 32]>::try_from(bytes.as_slice()) else {
        eprintln!("PARRY_LOCAL_ENCLAVE_SEED must be 32 bytes of hex");
        std::process::exit(2);
    };
    let mut input = String::new();
    let _ = std::io::stdin().read_to_string(&mut input);
    let input: serde_json::Value = serde_json::from_str(&input).unwrap_or(serde_json::Value::Null);
    let out = match parry_enclave::modes::run(
        &Local {
            key: SigningKey::from_bytes(&seed),
        },
        &input,
    ) {
        Ok(v) => v,
        Err(e) => serde_json::json!({ "error": e }),
    };
    println!("{out}");
}
