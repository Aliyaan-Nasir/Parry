//! Everything the enclave program does outside its own memory goes through `Io`, so the logic is
//! the same in the TEE (OutLayer host functions, WASI HTTP) and in a local run (sandbox tests,
//! development), and tests can script the outside world.

pub type Result<T> = std::result::Result<T, String>;

pub trait Io {
    fn get(&self, url: &str, headers: &[(&str, &str)]) -> Result<Vec<u8>>;
    fn post(&self, url: &str, headers: &[(&str, &str)], body: &[u8]) -> Result<Vec<u8>>;
    /// Signs with the enclave's ed25519 key (bound to this build on OutLayer).
    fn sign(&self, message: &[u8]) -> Result<[u8; 64]>;
    fn public_key(&self) -> Result<[u8; 32]>;
    /// A 32-byte secret only this build can derive: the X25519 sealing key's seed.
    fn seal_secret(&self) -> Result<[u8; 32]>;
    /// A secret the operator stored for this build (the NEAR AI API key).
    fn secret(&self, name: &str) -> Option<String>;
    /// Unix seconds.
    fn now(&self) -> u64;
}

/// A scripted outside world for tests: responses by URL prefix (and request body substring).
#[cfg(test)]
#[derive(Default)]
pub struct Scripted {
    pub responses: Vec<(String, Option<String>, Vec<u8>)>,
    pub secrets: std::collections::BTreeMap<String, String>,
    /// Every POST (url, body), so tests can see exactly what was sent.
    pub log: std::cell::RefCell<Vec<(String, Vec<u8>)>>,
    pub now: u64,
    pub seed: [u8; 32],
}

#[cfg(test)]
impl Scripted {
    pub fn respond(
        mut self,
        url_prefix: &str,
        body_contains: Option<&str>,
        response: &str,
    ) -> Self {
        self.responses.push((
            url_prefix.into(),
            body_contains.map(String::from),
            response.as_bytes().to_vec(),
        ));
        self
    }

    fn find(&self, url: &str, body: &[u8]) -> Result<Vec<u8>> {
        let text = String::from_utf8_lossy(body);
        self.responses
            .iter()
            .rev()
            .find(|(p, c, _)| {
                url.starts_with(p.as_str()) && c.as_ref().is_none_or(|c| text.contains(c.as_str()))
            })
            .map(|(_, _, r)| r.clone())
            .ok_or_else(|| {
                format!(
                    "no scripted response for {url} {}",
                    &text[..text.len().min(120)]
                )
            })
    }
}

#[cfg(test)]
impl Io for Scripted {
    fn get(&self, url: &str, _h: &[(&str, &str)]) -> Result<Vec<u8>> {
        self.find(url, b"")
    }
    fn post(&self, url: &str, _h: &[(&str, &str)], body: &[u8]) -> Result<Vec<u8>> {
        self.log.borrow_mut().push((url.to_string(), body.to_vec()));
        self.find(url, body)
    }
    fn sign(&self, message: &[u8]) -> Result<[u8; 64]> {
        use ed25519_dalek::Signer;
        Ok(ed25519_dalek::SigningKey::from_bytes(&self.seed)
            .sign(message)
            .to_bytes())
    }
    fn public_key(&self) -> Result<[u8; 32]> {
        Ok(ed25519_dalek::SigningKey::from_bytes(&self.seed)
            .verifying_key()
            .to_bytes())
    }
    fn seal_secret(&self) -> Result<[u8; 32]> {
        Ok(crate::sha256(&[b"seal".as_slice(), &self.seed].concat()))
    }
    fn secret(&self, name: &str) -> Option<String> {
        self.secrets.get(name).cloned()
    }
    fn now(&self) -> u64 {
        self.now
    }
}
