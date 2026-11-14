//! Pins the review model's signing keys to attested hardware, checked inside the enclave.
//!
//! A review signature proves which key signed, not where that key lives. NEAR AI Cloud generates
//! each model node's signing key inside an Intel TDX confidential VM attached to NVIDIA GPUs in
//! confidential mode, and its attestation says so. The keeper gathers the evidence (NEAR AI's
//! attestation report for a nonce, NVIDIA's signed verdict on the GPU evidence, Intel's signed
//! collateral and NVIDIA's signing certificates) and hands it to the `attest` mode, which trusts
//! none of the transport and checks every signature itself:
//!
//! 1. the nonce is SHA-256 of a label and a NEAR block hash whose block is at most 15 minutes old
//!    (read from the chain), so no older attestation can be replayed;
//! 2. each node's Intel TDX quote verifies against Intel's root of trust (`dcap-qvl`, Intel's
//!    root compiled in), and its TCB status is not out of date or revoked;
//! 3. the quote's report data is the node's signing address followed by that nonce, so the key
//!    was generated inside that TDX VM and the quote is fresh;
//! 4. NVIDIA's overall and per-GPU tokens are ES384-signed by a certificate issued by one of
//!    NVIDIA's attestation intermediates pinned below, carry the same nonce, are unexpired, and
//!    report secure boot on, debug off and measurements matched.
//!
//! The addresses that pass go to the risk board in a `model_signers` report signed by the enclave
//! key, with an expiry. The guardian accepts a review only from an address pinned there, so an
//! approval can only come from a key whose attestation this enclave checked.

use crate::config;
use crate::io::{Io, Result};
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use serde_json::{json, Value};

/// How long a pin lasts: the keeper re-attests well within it.
pub const PIN_SECS: u64 = 24 * 3600;
/// Oldest block whose hash may seed an attestation's nonce.
pub const MAX_NONCE_AGE_SECS: u64 = 900;
/// TCB statuses that still prove a genuine, patched TDX platform. Out of date and revoked do not.
const GOOD_TCB: &[&str] = &[
    "UpToDate",
    "SWHardeningNeeded",
    "ConfigurationNeeded",
    "ConfigurationAndSWHardeningNeeded",
];
/// SHA-256 of NVIDIA's attestation-service intermediate certificates ("NVIDIA Attestation
/// Service GPU Intermediate", issued by "NVIDIA Attestation Service CA 001", valid to 2030). The
/// tokens' signing certificates must be issued by one of them; a new intermediate needs a new
/// enclave build, and until then attestation fails closed.
pub const NVIDIA_INTERMEDIATES: [&str; 2] = [
    "38e3daf3cdbd5243bb15dd7993edcdd83a7238cb6745b980f8f3bf0a31a0d343",
    "2df8907cf4d6c277b855d407ec178a649930a8e73f7294e8fce66e6ee27c5175",
];

/// One attested signing key.
#[derive(Debug, Clone, PartialEq)]
pub struct Attested {
    pub address: String,
    pub tcb_status: String,
    pub gpus: usize,
}

/// The nonce an attestation must carry for `block_hash`.
pub fn nonce_for(block_hash: &str) -> [u8; 32] {
    crate::sha256(format!("parry-attest:v1:{block_hash}").as_bytes())
}

/// The `attest` mode: checks the keeper's evidence and returns the `model_signers` report to
/// sign. Input: `{ block_hash, model, nodes: [{ signing_address, intel_quote, collateral, nras }],
/// nvidia_certs: { kid: [leaf, intermediate] } }`, certificates in base64 DER.
pub fn attest(io: &dyn Io, input: &Value, run_id: u64) -> Result<Value> {
    let model = input["model"].as_str().ok_or("no model")?;
    if model != config::MODEL {
        return Err(format!(
            "this build reviews with {}, not {model}",
            config::MODEL
        ));
    }
    let block_hash = input["block_hash"].as_str().ok_or("no block hash")?;
    let block_time = crate::chain::block_time(io, block_hash)?;
    let now = io.now();
    if block_time + MAX_NONCE_AGE_SECS < now || block_time > now + 60 {
        return Err("the nonce's block is not recent".into());
    }
    let nonce = nonce_for(block_hash);
    let keys = NvidiaKeys::from_certs(&input["nvidia_certs"], now)?;
    let nodes = input["nodes"].as_array().ok_or("no nodes")?;
    let mut passed: Vec<Attested> = vec![];
    let mut failed = vec![];
    for node in nodes {
        let address = node["signing_address"]
            .as_str()
            .unwrap_or("?")
            .to_ascii_lowercase();
        if passed.iter().any(|p| p.address == address) {
            continue;
        }
        match attest_node(node, &nonce, &keys, now) {
            Ok(a) => passed.push(a),
            Err(e) => failed.push(format!("{address}: {e}")),
        }
    }
    if passed.is_empty() {
        return Err(format!(
            "no node of {model} passed attestation: {}",
            failed.join("; ")
        ));
    }
    let report = json!({
        "kind": "model_signers", "run_id": run_id, "at": now, "model": model,
        "signers": passed.iter().map(|a| json!({ "address": a.address, "tcb_status": a.tcb_status, "gpus": a.gpus })).collect::<Vec<_>>(),
        "nonce": hex::encode(nonce), "expires_at": now + PIN_SECS,
    })
    .to_string();
    Ok(json!({ "report_json": report, "failed": failed }))
}

/// Checks one node: its TDX quote and the address and nonce bound in it, then its GPU tokens.
pub fn attest_node(
    node: &Value,
    nonce: &[u8; 32],
    keys: &NvidiaKeys,
    now: u64,
) -> Result<Attested> {
    let address = node["signing_address"]
        .as_str()
        .ok_or("no signing address")?
        .to_ascii_lowercase();
    let addr = hex::decode(address.trim_start_matches("0x")).map_err(|_| "bad signing address")?;
    if addr.len() != 20 {
        return Err("the signing address is not 20 bytes".into());
    }
    let quote = hex::decode(node["intel_quote"].as_str().ok_or("no TDX quote")?)
        .map_err(|_| "bad TDX quote hex")?;
    let collateral: dcap_qvl::QuoteCollateralV3 =
        serde_json::from_value(node["collateral"].clone())
            .map_err(|e| format!("bad Intel collateral: {e}"))?;
    let verified = dcap_qvl::verify::verify(&quote, &collateral, now)
        .map_err(|e| format!("TDX quote does not verify: {e:#}"))?;
    if !GOOD_TCB.contains(&verified.status.as_str()) {
        return Err(format!("TDX TCB status {}", verified.status));
    }
    let td = verified
        .report
        .as_td10()
        .ok_or("the quote is not a TDX report")?;
    let mut want = [0u8; 64];
    want[..20].copy_from_slice(&addr);
    want[32..].copy_from_slice(nonce);
    if td.report_data != want {
        return Err("the TDX report data does not bind this address to this nonce".into());
    }
    let gpus = check_nvidia(&node["nras"], nonce, keys, now)?;
    Ok(Attested {
        address,
        tcb_status: verified.status,
        gpus,
    })
}

// ----- NVIDIA ----------------------------------------------------------------------------------

/// The P-384 keys NVIDIA's tokens may be signed with, by key id: each from a certificate issued
/// by a pinned NVIDIA intermediate and valid now.
pub struct NvidiaKeys(Vec<(String, p384::ecdsa::VerifyingKey)>);

fn p384_key(
    spki: &x509_cert::spki::SubjectPublicKeyInfoOwned,
) -> Result<p384::ecdsa::VerifyingKey> {
    let point = spki
        .subject_public_key
        .as_bytes()
        .ok_or("certificate key is not byte aligned")?;
    p384::ecdsa::VerifyingKey::from_sec1_bytes(point)
        .map_err(|_| "certificate key is not a P-384 key".into())
}

/// The leaf's key, when `[leaf, intermediate]` (base64 DER) chains to a pinned intermediate and
/// the leaf is valid at `now`.
pub fn leaf_key(chain: &Value, now: u64) -> Result<p384::ecdsa::VerifyingKey> {
    use p384::ecdsa::signature::Verifier;
    use x509_cert::der::{Decode, Encode};
    let der = |i: usize| -> Result<Vec<u8>> {
        chain[i]
            .as_str()
            .and_then(|s| STANDARD.decode(s).ok())
            .ok_or_else(|| format!("certificate {i} is not base64"))
    };
    let (leaf_der, inter_der) = (der(0)?, der(1)?);
    let pinned = hex::encode(crate::sha256(&inter_der));
    if !NVIDIA_INTERMEDIATES.contains(&pinned.as_str()) {
        return Err("the token's certificate is not issued by a pinned NVIDIA intermediate".into());
    }
    let inter = x509_cert::Certificate::from_der(&inter_der).map_err(|_| "bad intermediate")?;
    let leaf = x509_cert::Certificate::from_der(&leaf_der).map_err(|_| "bad certificate")?;
    let tbs = leaf
        .tbs_certificate()
        .to_der()
        .map_err(|_| "bad certificate")?;
    let sig = leaf.signature().raw_bytes();
    let issuer = inter.tbs_certificate().subject_public_key_info();
    // The certificate names its own signature algorithm: P-384 ECDSA from NVIDIA's EC
    // intermediates, RSA PKCS#1 v1.5 from its RSA ones.
    match leaf.signature_algorithm().oid.to_string().as_str() {
        "1.2.840.10045.4.3.3" => {
            let sig =
                p384::ecdsa::Signature::from_der(sig).map_err(|_| "bad certificate signature")?;
            p384_key(issuer)?
                .verify(&tbs, &sig)
                .map_err(|_| "the certificate is not signed by the NVIDIA intermediate")?;
        }
        alg @ ("1.2.840.113549.1.1.11" | "1.2.840.113549.1.1.12") => {
            use rsa::pkcs8::DecodePublicKey;
            let spki = issuer.to_der().map_err(|_| "bad intermediate key")?;
            let key = rsa::RsaPublicKey::from_public_key_der(&spki)
                .map_err(|_| "the intermediate key is not an RSA key")?;
            let sig =
                rsa::pkcs1v15::Signature::try_from(sig).map_err(|_| "bad certificate signature")?;
            let ok = if alg.ends_with(".11") {
                rsa::pkcs1v15::VerifyingKey::<sha2::Sha256>::new(key).verify(&tbs, &sig)
            } else {
                rsa::pkcs1v15::VerifyingKey::<sha2::Sha384>::new(key).verify(&tbs, &sig)
            };
            ok.map_err(|_| "the certificate is not signed by the NVIDIA intermediate")?;
        }
        other => {
            return Err(format!(
                "unsupported certificate signature algorithm {other}"
            ))
        }
    }
    let validity = leaf.tbs_certificate().validity();
    let (from, to) = (
        validity.not_before.to_unix_duration().as_secs(),
        validity.not_after.to_unix_duration().as_secs(),
    );
    if now < from || now > to {
        return Err("the token's certificate is not valid now".into());
    }
    p384_key(leaf.tbs_certificate().subject_public_key_info())
}

impl NvidiaKeys {
    /// `{ kid: [leaf, intermediate] }`; a certificate that does not check out is left out.
    pub fn from_certs(certs: &Value, now: u64) -> Result<Self> {
        let map = certs.as_object().ok_or("no NVIDIA certificates")?;
        let keys: Vec<_> = map
            .iter()
            .filter_map(|(kid, chain)| leaf_key(chain, now).ok().map(|k| (kid.clone(), k)))
            .collect();
        if keys.is_empty() {
            return Err("no NVIDIA certificate checks out".into());
        }
        Ok(Self(keys))
    }

    #[cfg(test)]
    pub fn from_keys(keys: Vec<(String, p384::ecdsa::VerifyingKey)>) -> Self {
        Self(keys)
    }

    /// The claims of an ES384 JWT signed by one of these keys.
    pub fn claims(&self, jwt: &str) -> Result<Value> {
        use p384::ecdsa::signature::Verifier;
        let mut parts = jwt.split('.');
        let (Some(h), Some(p), Some(s), None) =
            (parts.next(), parts.next(), parts.next(), parts.next())
        else {
            return Err("not a JWT".into());
        };
        let header: Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(h).map_err(|_| "bad JWT header")?)
                .map_err(|_| "bad JWT header")?;
        if header["alg"] != "ES384" {
            return Err(format!("JWT algorithm {} is not ES384", header["alg"]));
        }
        let kid = header["kid"].as_str().ok_or("JWT names no key")?;
        let (_, key) = self
            .0
            .iter()
            .find(|(k, _)| k == kid)
            .ok_or_else(|| format!("JWT key {kid} has no checked NVIDIA certificate"))?;
        let sig_bytes = URL_SAFE_NO_PAD.decode(s).map_err(|_| "bad JWT signature")?;
        let sig =
            p384::ecdsa::Signature::from_slice(&sig_bytes).map_err(|_| "bad JWT signature")?;
        key.verify(format!("{h}.{p}").as_bytes(), &sig)
            .map_err(|_| "the JWT signature does not verify")?;
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(p).map_err(|_| "bad JWT claims")?)
            .map_err(|_| "bad JWT claims".into())
    }
}

/// Checks NVIDIA's two-part answer: `[["JWT", overall], {"GPU-0": jwt, ...}]`; returns how many
/// GPUs passed.
pub fn check_nvidia(
    response: &Value,
    nonce: &[u8; 32],
    keys: &NvidiaKeys,
    now: u64,
) -> Result<usize> {
    let want = hex::encode(nonce);
    let fresh = |c: &Value, what: &str| -> Result<()> {
        if c["eat_nonce"].as_str() != Some(want.as_str()) {
            return Err(format!("{what} is for another nonce"));
        }
        if c["exp"].as_u64().unwrap_or(0) <= now {
            return Err(format!("{what} has expired"));
        }
        Ok(())
    };
    let overall = response[0][1].as_str().ok_or("no overall GPU token")?;
    let c = keys.claims(overall)?;
    fresh(&c, "the overall GPU token")?;
    if c["x-nvidia-overall-att-result"] != true {
        return Err("NVIDIA's overall GPU attestation result is not true".into());
    }
    let per_gpu = response[1].as_object().ok_or("no per-GPU tokens")?;
    if per_gpu.is_empty() {
        return Err("no per-GPU tokens".into());
    }
    for (gpu, jwt) in per_gpu {
        let c = keys.claims(jwt.as_str().ok_or("bad per-GPU token")?)?;
        fresh(&c, gpu)?;
        if c["secboot"] != true || c["dbgstat"] != "disabled" || c["measres"] != "success" {
            return Err(format!(
                "{gpu}: secure boot, debug state or measurements do not pass"
            ));
        }
        if !c["x-nvidia-attestation-warning"].is_null() {
            return Err(format!("{gpu}: NVIDIA reports a warning"));
        }
    }
    Ok(per_gpu.len())
}

/// True when the risk board pins `address` for `model` now.
pub fn is_pinned(io: &dyn Io, model: &str, address: &str) -> Result<bool> {
    let pins: Option<Value> = crate::chain::view(
        io,
        config::RISK,
        "model_signers",
        &json!({ "model": model }),
    )?;
    let Some(p) = pins else { return Ok(false) };
    if p["expires_at"].as_u64().unwrap_or(0) <= io.now() {
        return Ok(false);
    }
    Ok(p["signers"].as_array().is_some_and(|a| {
        a.iter().any(|s| {
            s["address"]
                .as_str()
                .is_some_and(|x| x.eq_ignore_ascii_case(address))
        })
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_real_nvidia_certificate_chains_to_a_pinned_intermediate() {
        let real: Value = serde_json::from_str(include_str!("testdata-nvidia-cert.json")).unwrap();
        // Issued 2026-11-14 00:57 UTC, valid two days.
        let now = 1_794_675_000;
        assert!(leaf_key(&real["x5c"], now).is_ok());
        assert!(
            leaf_key(&real["x5c"], now + 30 * 86_400).is_err(),
            "expired"
        );
        // The leaf presented as its own issuer, or swapped, is refused.
        let swapped = json!([real["x5c"][1], real["x5c"][0]]);
        assert!(leaf_key(&swapped, now).is_err());
        let selfie = json!([real["x5c"][0], real["x5c"][0]]);
        assert!(leaf_key(&selfie, now).is_err());
        // A certificate from NVIDIA's RSA intermediate (issued 2026-11-14 12:39 UTC, valid 12 hours).
        let rsa: Value =
            serde_json::from_str(include_str!("testdata-nvidia-cert-rsa.json")).unwrap();
        assert!(leaf_key(&rsa["x5c"], 1_794_682_000).is_ok());
        assert!(leaf_key(&rsa["x5c"], 1_794_800_000).is_err(), "expired");
        let keys =
            NvidiaKeys::from_certs(&json!({ real["kid"].as_str().unwrap(): real["x5c"] }), now)
                .unwrap();
        assert_eq!(keys.0.len(), 1);
    }

    #[test]
    fn the_nonce_is_bound_to_a_block_hash() {
        assert_ne!(nonce_for("a"), nonce_for("b"));
        assert_eq!(nonce_for("a"), crate::sha256(b"parry-attest:v1:a"));
    }

    fn es384_jwt(sk: &p384::ecdsa::SigningKey, kid: &str, claims: &Value) -> String {
        use p384::ecdsa::signature::Signer;
        let h = URL_SAFE_NO_PAD.encode(json!({ "alg": "ES384", "kid": kid }).to_string());
        let p = URL_SAFE_NO_PAD.encode(claims.to_string());
        let sig: p384::ecdsa::Signature = sk.sign(format!("{h}.{p}").as_bytes());
        format!("{h}.{p}.{}", URL_SAFE_NO_PAD.encode(sig.to_bytes()))
    }

    #[test]
    fn accepts_only_signed_fresh_passing_gpu_tokens() {
        let sk = p384::ecdsa::SigningKey::from_slice(&[7u8; 48]).unwrap();
        let keys = NvidiaKeys::from_keys(vec![("k1".into(), *sk.verifying_key())]);
        let nonce = [9u8; 32];
        let n = hex::encode(nonce);
        let overall = json!({ "eat_nonce": n, "exp": 2000, "x-nvidia-overall-att-result": true });
        let gpu = json!({ "eat_nonce": n, "exp": 2000, "secboot": true, "dbgstat": "disabled", "measres": "success", "x-nvidia-attestation-warning": null });
        let ok = json!([["JWT", es384_jwt(&sk, "k1", &overall)], { "GPU-0": es384_jwt(&sk, "k1", &gpu) }]);
        assert_eq!(check_nvidia(&ok, &nonce, &keys, 1000), Ok(1));
        assert!(check_nvidia(&ok, &nonce, &keys, 3000).is_err(), "expired");
        assert!(
            check_nvidia(&ok, &[1u8; 32], &keys, 1000).is_err(),
            "another nonce"
        );
        let bad = json!({ "eat_nonce": n, "exp": 2000, "secboot": true, "dbgstat": "enabled", "measres": "success", "x-nvidia-attestation-warning": null });
        let r = json!([["JWT", es384_jwt(&sk, "k1", &overall)], { "GPU-0": es384_jwt(&sk, "k1", &bad) }]);
        assert!(check_nvidia(&r, &nonce, &keys, 1000).is_err(), "debug on");
        let other = p384::ecdsa::SigningKey::from_slice(&[8u8; 48]).unwrap();
        let r = json!([["JWT", es384_jwt(&other, "k1", &overall)], { "GPU-0": es384_jwt(&sk, "k1", &gpu) }]);
        assert!(
            check_nvidia(&r, &nonce, &keys, 1000).is_err(),
            "wrong signer"
        );
        let r = json!([["JWT", es384_jwt(&sk, "k2", &overall)], { "GPU-0": es384_jwt(&sk, "k1", &gpu) }]);
        assert!(
            check_nvidia(&r, &nonce, &keys, 1000).is_err(),
            "unknown key id"
        );
    }
}
