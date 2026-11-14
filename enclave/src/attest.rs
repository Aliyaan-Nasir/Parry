//! Pins the review model's signing keys to attested hardware, inside the enclave.
//!
//! A review signature proves which key signed, not where that key lives. NEAR AI Cloud generates
//! each model node's signing key inside an Intel TDX confidential VM attached to NVIDIA GPUs in
//! confidential mode, and its attestation report says so. The `attest` mode checks that report
//! here, with a nonce of its own:
//!
//! 1. the Intel TDX quote verifies against Intel's root of trust (`dcap-qvl`, with the PCK chain
//!    from the quote and Intel's signed collateral; any transport can carry it, the signatures
//!    are what count), and its TCB status is not out of date or revoked;
//! 2. the quote's report data is the node's signing address followed by this run's nonce, so the
//!    key was generated inside that TDX VM and the quote is fresh;
//! 3. NVIDIA's attestation service accepted the GPU evidence for the same nonce: the overall and
//!    per-GPU tokens are ES384-signed by a key in NVIDIA's published key set, carry the nonce,
//!    are unexpired, and report secure boot on, debug off and measurements matched.
//!
//! The addresses that pass go to the risk board in a `model_signers` report signed by the enclave
//! key, with an expiry. The guardian accepts a review only from an address pinned there, so an
//! approval can only come from a key that this enclave itself saw attested.

use crate::config;
use crate::io::{Io, Result};
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use serde_json::{json, Value};

/// How long a pin lasts: the keeper re-attests well within it.
pub const PIN_SECS: u64 = 24 * 3600;
/// TCB statuses that still prove a genuine, patched TDX platform. Out of date and revoked do not.
const GOOD_TCB: &[&str] = &[
    "UpToDate",
    "SWHardeningNeeded",
    "ConfigurationNeeded",
    "ConfigurationAndSWHardeningNeeded",
];
const INTEL_PCS: &str = "https://api.trustedservices.intel.com";
const INTEL_ROOT_CRL: &str = "https://certificates.trustedservices.intel.com/IntelSGXRootCA.der";
const NRAS: &str = "https://nras.attestation.nvidia.com/v3/attest/gpu";
const NRAS_JWKS: &str = "https://nras.attestation.nvidia.com/.well-known/jwks.json";

/// One attested signing key.
#[derive(Debug, Clone, PartialEq)]
pub struct Attested {
    pub address: String,
    pub tcb_status: String,
    pub gpus: usize,
}

/// The nonce for one attestation: a hash of this enclave's own signature over the model and the
/// time, so nobody outside can predict it and no older report can be replayed.
pub fn nonce(io: &dyn Io, model: &str) -> Result<[u8; 32]> {
    let sig = io.sign(format!("parry-attest:v1:{model}:{}", io.now()).as_bytes())?;
    Ok(crate::sha256(&sig))
}

/// Fetches the model's attestation report for `nonce` and returns every node key that passes.
/// A node that fails is left out with its reason; no node passing is an error.
pub fn attest_model(
    io: &dyn Io,
    model: &str,
    nonce: &[u8; 32],
) -> Result<(Vec<Attested>, Vec<String>)> {
    let key = io
        .secret("NEARAI_API_KEY")
        .ok_or("no NEARAI_API_KEY secret for this build")?;
    let auth = format!("Bearer {key}");
    let url = format!(
        "{}/attestation/report?model={}&signing_algo=ecdsa&nonce={}",
        config::NEARAI,
        model,
        hex::encode(nonce)
    );
    let report: Value = serde_json::from_slice(&io.get(&url, &[("authorization", auth.as_str())])?)
        .map_err(|e| format!("attestation report: {e}"))?;
    let nodes = report["model_attestations"]
        .as_array()
        .ok_or("the attestation report lists no model nodes")?;
    let jwks = NvidiaKeys::fetch(io)?;
    let mut passed: Vec<Attested> = vec![];
    let mut failed = vec![];
    for node in nodes {
        if node["model_name"].as_str().is_some_and(|m| m != model) {
            continue;
        }
        // Several entries can report the same key: one passing attestation pins it.
        let address = node["signing_address"].as_str().unwrap_or_default();
        if passed.iter().any(|p| p.address.eq_ignore_ascii_case(address)) {
            continue;
        }
        match attest_node(io, node, nonce, &jwks) {
            Ok(a) => {
                if !passed.iter().any(|p| p.address == a.address) {
                    passed.push(a);
                }
            }
            Err(e) => failed.push(format!(
                "{}: {e}",
                node["signing_address"].as_str().unwrap_or("?")
            )),
        }
    }
    if passed.is_empty() {
        return Err(format!(
            "no node of {model} passed attestation: {}",
            failed.join("; ")
        ));
    }
    Ok((passed, failed))
}

fn attest_node(io: &dyn Io, node: &Value, nonce: &[u8; 32], jwks: &NvidiaKeys) -> Result<Attested> {
    let address = node["signing_address"]
        .as_str()
        .ok_or("no signing address")?
        .to_ascii_lowercase();
    let addr = hex::decode(address.trim_start_matches("0x")).map_err(|_| "bad signing address")?;
    if addr.len() != 20 {
        return Err("the signing address is not 20 bytes".into());
    }
    // 1. Intel TDX.
    let quote = hex::decode(node["intel_quote"].as_str().ok_or("no TDX quote")?)
        .map_err(|_| "bad TDX quote hex")?;
    let collateral = intel_collateral(io, &quote)?;
    let verified = dcap_qvl::verify::verify(&quote, &collateral, io.now())
        .map_err(|e| format!("TDX quote does not verify: {e:#}"))?;
    if !GOOD_TCB.contains(&verified.status.as_str()) {
        return Err(format!("TDX TCB status {}", verified.status));
    }
    let td = verified
        .report
        .as_td10()
        .ok_or("the quote is not a TDX report")?;
    // 2. Binding: report data = address, zero padding to 32 bytes, then the nonce.
    let mut want = [0u8; 64];
    want[..20].copy_from_slice(&addr);
    want[32..].copy_from_slice(nonce);
    if td.report_data != want {
        return Err("the TDX report data does not bind this address to this run's nonce".into());
    }
    // 3. NVIDIA GPUs.
    let payload = node["nvidia_payload"].as_str().ok_or("no GPU evidence")?;
    let evidence: Value = serde_json::from_str(payload).map_err(|_| "bad GPU evidence")?;
    if evidence["nonce"].as_str() != Some(hex::encode(nonce).as_str()) {
        return Err("the GPU evidence is for another nonce".into());
    }
    let gpus = nvidia_verdict(io, payload.as_bytes(), nonce, jwks)?;
    Ok(Attested {
        address,
        tcb_status: verified.status,
        gpus,
    })
}

// ----- Intel collateral ------------------------------------------------------------------------

/// Intel's signed collateral for a quote whose certification data carries its PCK chain.
fn intel_collateral(io: &dyn Io, quote: &[u8]) -> Result<dcap_qvl::QuoteCollateralV3> {
    let parsed = dcap_qvl::quote::Quote::parse(quote).map_err(|e| format!("quote: {e:#}"))?;
    if parsed.inner_cert_type() != 5 {
        return Err(format!(
            "the quote's certification data type is {}, not an embedded PCK chain",
            parsed.inner_cert_type()
        ));
    }
    let pck_chain = String::from_utf8_lossy(parsed.inner_cert_data()).to_string();
    let leaf = pem_certs(&pck_chain)
        .into_iter()
        .next()
        .ok_or("no PCK certificate in the quote")?;
    let fmspc = fmspc_of(&leaf).ok_or("no FMSPC in the PCK certificate")?;
    let ca = if contains(&leaf, b"Intel SGX PCK Platform CA") {
        "platform"
    } else {
        "processor"
    };
    let header = |h: &[(String, String)], names: &[&str]| -> Result<String> {
        h.iter()
            .find(|(k, _)| names.contains(&k.as_str()))
            .map(|(_, v)| url_decode(v))
            .ok_or_else(|| format!("Intel's response has no {} header", names[0]))
    };
    let (pck_crl, h) = io.get_with_headers(
        &format!("{INTEL_PCS}/sgx/certification/v4/pckcrl?ca={ca}&encoding=der"),
        &[],
    )?;
    let pck_crl_issuer_chain = header(&h, &["sgx-pck-crl-issuer-chain"])?;
    let (tcb, h) = io.get_with_headers(
        &format!("{INTEL_PCS}/tdx/certification/v4/tcb?fmspc={fmspc}"),
        &[],
    )?;
    let tcb_info_issuer_chain =
        header(&h, &["tcb-info-issuer-chain", "sgx-tcb-info-issuer-chain"])?;
    let (qe, h) = io.get_with_headers(
        &format!("{INTEL_PCS}/tdx/certification/v4/qe/identity"),
        &[],
    )?;
    let qe_identity_issuer_chain = header(&h, &["sgx-enclave-identity-issuer-chain"])?;
    let root_ca_crl = io.get(INTEL_ROOT_CRL, &[])?;
    let (tcb_info, tcb_info_signature) = signed_body(&tcb, "tcbInfo")?;
    let (qe_identity, qe_identity_signature) = signed_body(&qe, "enclaveIdentity")?;
    Ok(dcap_qvl::QuoteCollateralV3 {
        pck_crl_issuer_chain,
        root_ca_crl,
        pck_crl,
        tcb_info_issuer_chain,
        tcb_info,
        tcb_info_signature,
        qe_identity_issuer_chain,
        qe_identity,
        qe_identity_signature,
        pck_certificate_chain: Some(pck_chain),
    })
}

/// `{"<field>": {...}, "signature": "<hex>"}`: the exact bytes of the signed object (the
/// signature covers them as sent) and the signature.
fn signed_body(body: &[u8], field: &str) -> Result<(String, Vec<u8>)> {
    #[derive(serde::Deserialize)]
    struct Signed<'a> {
        #[serde(borrow, rename = "tcbInfo", default)]
        tcb_info: Option<&'a serde_json::value::RawValue>,
        #[serde(borrow, rename = "enclaveIdentity", default)]
        enclave_identity: Option<&'a serde_json::value::RawValue>,
        signature: String,
    }
    let s: Signed = serde_json::from_slice(body).map_err(|e| format!("Intel {field}: {e}"))?;
    let raw = if field == "tcbInfo" {
        s.tcb_info
    } else {
        s.enclave_identity
    }
    .ok_or_else(|| format!("Intel's response has no {field}"))?;
    let sig = hex::decode(&s.signature).map_err(|_| format!("bad {field} signature hex"))?;
    Ok((raw.get().to_string(), sig))
}

fn pem_certs(pem: &str) -> Vec<Vec<u8>> {
    pem.split("-----BEGIN CERTIFICATE-----")
        .skip(1)
        .filter_map(|block| {
            let body: String = block
                .split("-----END CERTIFICATE-----")
                .next()?
                .chars()
                .filter(|c| !c.is_whitespace())
                .collect();
            STANDARD.decode(body).ok()
        })
        .collect()
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|w| w == needle)
}

/// The FMSPC (6 bytes, upper hex) in a PCK certificate: the OCTET STRING after the OID
/// 1.2.840.113741.1.13.1.4 inside Intel's SGX extension.
pub fn fmspc_of(cert_der: &[u8]) -> Option<String> {
    const OID: [u8; 12] = [
        0x06, 0x0a, 0x2a, 0x86, 0x48, 0x86, 0xf8, 0x4d, 0x01, 0x0d, 0x01, 0x04,
    ];
    let at = cert_der.windows(OID.len()).position(|w| w == OID)? + OID.len();
    let rest = cert_der.get(at..at + 8)?;
    (rest[0] == 0x04 && rest[1] == 0x06).then(|| hex::encode_upper(&rest[2..8]))
}

fn url_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(if b[i] == b'+' { b' ' } else { b[i] });
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

// ----- NVIDIA ----------------------------------------------------------------------------------

/// NVIDIA's published ES384 keys, by key id.
pub struct NvidiaKeys(Vec<(String, p384::ecdsa::VerifyingKey)>);

impl NvidiaKeys {
    fn fetch(io: &dyn Io) -> Result<Self> {
        let v: Value = serde_json::from_slice(&io.get(NRAS_JWKS, &[])?)
            .map_err(|e| format!("NVIDIA key set: {e}"))?;
        Self::from_jwks(&v)
    }

    pub fn from_jwks(v: &Value) -> Result<Self> {
        let mut keys = vec![];
        for k in v["keys"].as_array().ok_or("NVIDIA key set has no keys")? {
            if k["kty"] != "EC" || k["crv"] != "P-384" {
                continue;
            }
            let coord = |name: &str| {
                k[name]
                    .as_str()
                    .and_then(|s| URL_SAFE_NO_PAD.decode(s).ok())
                    .filter(|b| b.len() == 48)
            };
            let (Some(x), Some(y), Some(kid)) = (coord("x"), coord("y"), k["kid"].as_str()) else {
                continue;
            };
            let mut sec1 = vec![0x04];
            sec1.extend_from_slice(&x);
            sec1.extend_from_slice(&y);
            if let Ok(vk) = p384::ecdsa::VerifyingKey::from_sec1_bytes(&sec1) {
                keys.push((kid.to_string(), vk));
            }
        }
        if keys.is_empty() {
            return Err("NVIDIA key set has no P-384 keys".into());
        }
        Ok(Self(keys))
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
            .ok_or_else(|| format!("JWT key {kid} is not in NVIDIA's key set"))?;
        let sig_bytes = URL_SAFE_NO_PAD.decode(s).map_err(|_| "bad JWT signature")?;
        let sig =
            p384::ecdsa::Signature::from_slice(&sig_bytes).map_err(|_| "bad JWT signature")?;
        key.verify(format!("{h}.{p}").as_bytes(), &sig)
            .map_err(|_| "the JWT signature does not verify")?;
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(p).map_err(|_| "bad JWT claims")?)
            .map_err(|_| "bad JWT claims".into())
    }
}

/// Posts the GPU evidence to NVIDIA's attestation service and checks its signed verdict; returns
/// how many GPUs passed.
fn nvidia_verdict(
    io: &dyn Io,
    payload: &[u8],
    nonce: &[u8; 32],
    keys: &NvidiaKeys,
) -> Result<usize> {
    let response: Value = serde_json::from_slice(&io.post(
        NRAS,
        &[
            ("content-type", "application/json"),
            ("accept", "application/json"),
        ],
        payload,
    )?)
    .map_err(|e| format!("NVIDIA attestation: {e}"))?;
    check_nvidia(&response, nonce, keys, io.now())
}

/// Checks NVIDIA's two-part answer: `[["JWT", overall], {"GPU-0": jwt, ...}]`.
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

/// The `attest` mode: attests the review model and returns a signed `model_signers` report for
/// the risk board.
pub fn attest(io: &dyn Io, run_id: u64) -> Result<Value> {
    let model = config::MODEL;
    let nonce = nonce(io, model)?;
    let (passed, failed) = attest_model(io, model, &nonce)?;
    let at = io.now();
    let report = json!({
        "kind": "model_signers", "run_id": run_id, "at": at, "model": model,
        "signers": passed.iter().map(|a| json!({ "address": a.address, "tcb_status": a.tcb_status, "gpus": a.gpus })).collect::<Vec<_>>(),
        "nonce": hex::encode(nonce), "expires_at": at + PIN_SECS,
    })
    .to_string();
    Ok(json!({ "report_json": report, "failed": failed }))
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
    fn reads_the_fmspc_after_its_oid() {
        let mut der = vec![0x30, 0x82, 0x01, 0x00];
        der.extend_from_slice(&[
            0x06, 0x0a, 0x2a, 0x86, 0x48, 0x86, 0xf8, 0x4d, 0x01, 0x0d, 0x01, 0x04, 0x04, 0x06,
            0x90, 0xc0, 0x6f, 0x00, 0x00, 0x00,
        ]);
        assert_eq!(fmspc_of(&der).as_deref(), Some("90C06F000000"));
        assert_eq!(fmspc_of(&[0x30, 0x00]), None);
    }

    #[test]
    fn decodes_intel_header_chains() {
        assert_eq!(
            url_decode("-----BEGIN%20CERT%0AAB%2B%3D"),
            "-----BEGIN CERT\nAB+="
        );
    }

    #[test]
    fn takes_the_exact_signed_bytes() {
        let body = br#"{"tcbInfo":{"id":"TDX","version":3,"x":[1, 2]},"signature":"0a0b"}"#;
        let (raw, sig) = signed_body(body, "tcbInfo").unwrap();
        assert_eq!(raw, r#"{"id":"TDX","version":3,"x":[1, 2]}"#);
        assert_eq!(sig, vec![10, 11]);
    }

    fn es384_jwt(sk: &p384::ecdsa::SigningKey, kid: &str, claims: &Value) -> String {
        use p384::ecdsa::signature::Signer;
        let h = URL_SAFE_NO_PAD.encode(json!({ "alg": "ES384", "kid": kid }).to_string());
        let p = URL_SAFE_NO_PAD.encode(claims.to_string());
        let sig: p384::ecdsa::Signature = sk.sign(format!("{h}.{p}").as_bytes());
        format!("{h}.{p}.{}", URL_SAFE_NO_PAD.encode(sig.to_bytes()))
    }

    fn keyset(sk: &p384::ecdsa::SigningKey, kid: &str) -> NvidiaKeys {
        let point = sk.verifying_key().to_encoded_point(false);
        NvidiaKeys::from_jwks(&json!({ "keys": [{
            "kty": "EC", "crv": "P-384", "kid": kid,
            "x": URL_SAFE_NO_PAD.encode(point.x().unwrap()), "y": URL_SAFE_NO_PAD.encode(point.y().unwrap()),
        }]}))
        .unwrap()
    }

    #[test]
    fn accepts_only_signed_fresh_passing_gpu_tokens() {
        let sk = p384::ecdsa::SigningKey::from_slice(&[7u8; 48]).unwrap();
        let keys = keyset(&sk, "k1");
        let nonce = [9u8; 32];
        let n = hex::encode(nonce);
        let overall = json!({ "eat_nonce": n, "exp": 2000, "x-nvidia-overall-att-result": true });
        let gpu = json!({ "eat_nonce": n, "exp": 2000, "secboot": true, "dbgstat": "disabled", "measres": "success", "x-nvidia-attestation-warning": null });
        let ok = json!([["JWT", es384_jwt(&sk, "k1", &overall)], { "GPU-0": es384_jwt(&sk, "k1", &gpu) }]);
        assert_eq!(check_nvidia(&ok, &nonce, &keys, 1000), Ok(1));
        // Expired.
        assert!(check_nvidia(&ok, &nonce, &keys, 3000).is_err());
        // Another nonce.
        assert!(check_nvidia(&ok, &[1u8; 32], &keys, 1000).is_err());
        // Debug on.
        let bad = json!({ "eat_nonce": n, "exp": 2000, "secboot": true, "dbgstat": "enabled", "measres": "success", "x-nvidia-attestation-warning": null });
        let r = json!([["JWT", es384_jwt(&sk, "k1", &overall)], { "GPU-0": es384_jwt(&sk, "k1", &bad) }]);
        assert!(check_nvidia(&r, &nonce, &keys, 1000).is_err());
        // Signed by a key outside NVIDIA's set.
        let other = p384::ecdsa::SigningKey::from_slice(&[8u8; 48]).unwrap();
        let r = json!([["JWT", es384_jwt(&other, "k1", &overall)], { "GPU-0": es384_jwt(&sk, "k1", &gpu) }]);
        assert!(check_nvidia(&r, &nonce, &keys, 1000).is_err());
        let r = json!([["JWT", es384_jwt(&sk, "k2", &overall)], { "GPU-0": es384_jwt(&sk, "k1", &gpu) }]);
        assert!(check_nvidia(&r, &nonce, &keys, 1000).is_err());
    }
}
