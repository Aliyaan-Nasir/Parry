//! The enclave entry point on OutLayer: reads the run's input, writes one JSON result.

#[cfg(target_family = "wasm")]
#[used]
#[link_section = "outlayer.manifest"]
static MANIFEST: [u8; include_bytes!("../manifest.json").len()] =
    *include_bytes!("../manifest.json");

#[cfg(target_family = "wasm")]
mod host {
    use parry_enclave::io::{Io, Result};
    use std::time::Duration;
    use wasi_http_client::Client;

    pub struct OutLayer;

    fn check(status: u16, url: &str) -> Result<()> {
        if status >= 300 {
            return Err(format!(
                "{}: HTTP {status}",
                url.split('?').next().unwrap_or(url)
            ));
        }
        Ok(())
    }

    impl Io for OutLayer {
        fn get(&self, url: &str, headers: &[(&str, &str)]) -> Result<Vec<u8>> {
            let mut req = Client::new()
                .get(url)
                .connect_timeout(Duration::from_secs(15));
            for (k, v) in headers {
                req = req.header(*k, *v);
            }
            let res = req.send().map_err(|e| format!("GET {url}: {e}"))?;
            check(res.status(), url)?;
            res.body().map_err(|e| e.to_string())
        }
        fn post(&self, url: &str, headers: &[(&str, &str)], body: &[u8]) -> Result<Vec<u8>> {
            let mut req = Client::new()
                .post(url)
                .connect_timeout(Duration::from_secs(30));
            for (k, v) in headers {
                req = req.header(*k, *v);
            }
            let res = req
                .body(body)
                .send()
                .map_err(|e| format!("POST {url}: {e}"))?;
            check(res.status(), url)?;
            res.body().map_err(|e| e.to_string())
        }
        fn sign(&self, message: &[u8]) -> Result<[u8; 64]> {
            let s = outlayer::signing_keys::sign("enclave", None, message)
                .map_err(|e| format!("sign: {e:?}"))?;
            s.try_into().map_err(|_| "signature is not 64 bytes".into())
        }
        fn public_key(&self) -> Result<[u8; 32]> {
            let k = outlayer::signing_keys::public_key("enclave", None)
                .map_err(|e| format!("public key: {e:?}"))?;
            k.try_into()
                .map_err(|_| "public key is not 32 bytes".into())
        }
        fn seal_secret(&self) -> Result<[u8; 32]> {
            let m = outlayer::encryption_keys::mac("seal", None, b"parry-seal:x25519:v1")
                .map_err(|e| format!("seal key: {e:?}"))?;
            Ok(parry_enclave::sha256(&m))
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
}

#[cfg(target_family = "wasm")]
fn main() {
    use std::io::Write;
    let input: serde_json::Value = outlayer::env::input_json()
        .ok()
        .flatten()
        .unwrap_or(serde_json::Value::Null);
    let out = match parry_enclave::modes::run(&host::OutLayer, &input) {
        Ok(v) => v,
        Err(e) => serde_json::json!({ "error": e }),
    };
    let bytes = serde_json::to_vec(&out).unwrap_or_default();
    outlayer::env::output(&bytes);
    let _ = std::io::stdout().flush();
}

#[cfg(not(target_family = "wasm"))]
fn main() {
    eprintln!(
        "parry-enclave runs on OutLayer (wasm32-wasip2); use parry-enclave-local for local runs"
    );
    std::process::exit(2);
}
