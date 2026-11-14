//! AI review before every rescue. The enclave asks a NEAR AI Cloud verifiable model (one that
//! runs in a TEE and signs its responses) to review the plan, and acts only on an approval.
//!
//! The review is bound to the exact bytes exchanged: the model's TEE signs
//! `[model:]sha256(request body):sha256(response body)` with its secp256k1 key (EIP-191), and the
//! enclave checks both hashes against what it sent and received and recovers the signing
//! address. The full record (and its SHA-256, the `review_hash` the account emits on chain) goes
//! out with the decision. The signing address must be one the enclave's own `attest` mode
//! verified (Intel TDX quote and NVIDIA GPU evidence) and pinned on the risk board
//! (`attest.rs`, checked in `modes.rs` before anything is signed); the API and `pnpm verify`
//! also check its attestation off chain with NEAR AI's inference SDK.

use crate::config;
use crate::io::{Io, Result};
use k256::ecdsa::{RecoveryId, Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const SYSTEM_PROMPT: &str = "You review rescue plans for Parry, a guardian that protects leveraged positions from liquidation. \
The guardian may only repay debt from the owner's reserve, add collateral from the reserve, sell some collateral to repay debt (deleverage), \
reduce or hedge a Hyperliquid position, or repay an Aave loan, always inside the owner's on-chain mandate. \
Approve the plan only if (1) the position is genuinely at risk or has crossed the owner's own trigger (owner_trigger: \
the owner asked the guardian to act at that score or health), (2) the action reduces liquidation risk, or is the token approval, \
sized to it, that the next step's repay needs, (3) the amounts are proportionate \
(no larger than needed to reach the target health and within the stated limits), and (4) nothing in it moves funds anywhere but the \
lending protocol, the exchange round trip or the owner's own positions. Otherwise reject. \
Token amounts inside proposed_action are integer base units (wNEAR has 24 decimals, USDC 6); proposed_amounts gives the same amounts in whole tokens, so judge sizes by proposed_amounts. \
Answer with only a JSON object: {\"verdict\": \"approve\" or \"reject\", \"reasoning\": \"at most three sentences\"}.";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Review {
    pub model: String,
    pub chat_id: String,
    pub request_hash: String,
    pub response_hash: String,
    /// The text the model's TEE signed.
    pub signed_text: String,
    pub signature: String,
    pub signing_address: String,
    pub signature_kind: String,
    pub verdict: String,
    pub reasoning: String,
}

impl Review {
    /// SHA-256 (hex) of the record's JSON: the hash the account emits with the action.
    pub fn hash(&self) -> String {
        hex::encode(crate::sha256(
            serde_json::to_string(self).unwrap().as_bytes(),
        ))
    }
}

/// Pulls the first `{...}` object out of a model's answer (models sometimes add a code fence).
fn json_object(text: &str) -> Option<Value> {
    let start = text.find('{')?;
    let end = text.rfind('}')?;
    serde_json::from_str(&text[start..=end]).ok()
}

/// The EIP-191 address that signed `text`.
pub fn recover_address(text: &str, signature_hex: &str) -> Result<String> {
    let sig =
        hex::decode(signature_hex.trim_start_matches("0x")).map_err(|_| "bad signature hex")?;
    if sig.len() != 65 {
        return Err("signature must be 65 bytes".into());
    }
    let prefixed = format!("\x19Ethereum Signed Message:\n{}{}", text.len(), text);
    let digest = crate::keccak256(prefixed.as_bytes());
    let v = sig[64];
    let recid = RecoveryId::from_byte(if v >= 27 { v - 27 } else { v }).ok_or("bad recovery id")?;
    let s = Signature::from_slice(&sig[..64]).map_err(|_| "bad signature")?;
    let key = VerifyingKey::recover_from_prehash(&digest, &s, recid)
        .map_err(|_| "signature does not recover")?;
    let point = key.to_encoded_point(false);
    Ok(format!(
        "0x{}",
        hex::encode(&crate::keccak256(&point.as_bytes()[1..])[12..])
    ))
}

/// How many times an empty or unreadable answer is asked again before it counts as a rejection.
const ANSWER_ATTEMPTS: usize = 3;

/// Asks the model to review `facts`; returns the verified review.
///
/// An empty or unreadable answer (no JSON verdict) is a fault of the model's run, not a judgement
/// of the plan, so the same question is asked again, up to `ANSWER_ATTEMPTS` times; only a clear
/// approval approves, and an answer that is still unreadable after that is a rejection (the
/// guardian fails closed). Each attempt is its own signed exchange; the one returned is the one
/// whose verdict counts.
pub fn review(io: &dyn Io, facts: &Value) -> Result<Review> {
    let key = io
        .secret("NEARAI_API_KEY")
        .ok_or("no NEARAI_API_KEY secret for this build")?;
    let auth = format!("Bearer {key}");
    let headers = [
        ("content-type", "application/json"),
        ("authorization", auth.as_str()),
    ];
    let body = json!({
        "model": config::MODEL,
        "messages": [
            { "role": "system", "content": SYSTEM_PROMPT },
            { "role": "user", "content": facts.to_string() },
        ],
        "temperature": 0,
        // The review model reasons before it answers: low effort answers in seconds, inside the
        // run's time limit, with room in max_tokens for the verdict after the reasoning.
        "reasoning_effort": "low",
        "max_tokens": 1500,
        "stream": false,
    })
    .to_string();
    let mut attempt = 0;
    loop {
        attempt += 1;
        let response = io.post(
            &format!("{}/chat/completions", config::NEARAI),
            &headers,
            body.as_bytes(),
        )?;
        let request_hash = hex::encode(crate::sha256(body.as_bytes()));
        let response_hash = hex::encode(crate::sha256(&response));
        let v: Value =
            serde_json::from_slice(&response).map_err(|e| format!("review response: {e}"))?;
        let chat_id = v["id"]
            .as_str()
            .ok_or("review response has no id")?
            .to_string();
        let content = v["choices"][0]["message"]["content"]
            .as_str()
            .unwrap_or_default();
        let parsed = json_object(content).unwrap_or(Value::Null);
        let readable = parsed["verdict"] == "approve" || parsed["verdict"] == "reject";
        if !readable && attempt < ANSWER_ATTEMPTS {
            continue;
        }
        // An answer that is not a clear approval is a rejection: the guardian fails closed.
        let verdict = if parsed["verdict"] == "approve" {
            "approve"
        } else {
            "reject"
        }
        .to_string();
        let reasoning: String = if readable {
            parsed["reasoning"].as_str().unwrap_or_default().to_string()
        } else if content.trim().is_empty() {
            format!("the model gave no answer in {ANSWER_ATTEMPTS} attempts, so the plan is not approved")
        } else {
            content.to_string()
        }
        .chars()
        .take(600)
        .collect();
        return signed_review(
            io,
            &auth,
            chat_id,
            request_hash,
            response_hash,
            verdict,
            reasoning,
        );
    }
}

/// Fetches and checks the model's TEE signature over one exchange.
fn signed_review(
    io: &dyn Io,
    auth: &str,
    chat_id: String,
    request_hash: String,
    response_hash: String,
    verdict: String,
    reasoning: String,
) -> Result<Review> {
    let url = format!(
        "{}/signature/{}?model={}&signing_algo=ecdsa",
        config::NEARAI,
        chat_id,
        config::MODEL
    );
    let mut last_err = String::new();
    for _ in 0..4 {
        match io
            .get(&url, &[("authorization", auth)])
            .and_then(|b| serde_json::from_slice::<Value>(&b).map_err(|e| e.to_string()))
        {
            Ok(sig) if sig["signature"].is_string() => {
                let text = sig["text"].as_str().unwrap_or_default().to_string();
                if !text.ends_with(&format!("{request_hash}:{response_hash}")) {
                    return Err("the model's signature does not cover this exchange".into());
                }
                let signature = sig["signature"].as_str().unwrap().to_string();
                let signing_address = sig["signing_address"]
                    .as_str()
                    .unwrap_or_default()
                    .to_string();
                if !recover_address(&text, &signature)?.eq_ignore_ascii_case(&signing_address) {
                    return Err(
                        "the model's signature does not recover to its signing address".into(),
                    );
                }
                return Ok(Review {
                    model: config::MODEL.to_string(),
                    chat_id,
                    request_hash,
                    response_hash,
                    signed_text: text,
                    signature,
                    signing_address,
                    signature_kind: sig["signature_kind"]
                        .as_str()
                        .unwrap_or("provider_tee")
                        .to_string(),
                    verdict,
                    reasoning,
                });
            }
            Ok(other) => last_err = other.to_string().chars().take(200).collect(),
            Err(e) => last_err = e,
        }
    }
    Err(format!("no signature for the review: {last_err}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use k256::ecdsa::SigningKey;

    #[test]
    fn recovers_an_eip191_signer() {
        let sk = SigningKey::from_slice(&[3u8; 32]).unwrap();
        let text = "z-ai/glm-5.3-flash:aa:bb";
        let prefixed = format!("\x19Ethereum Signed Message:\n{}{}", text.len(), text);
        let digest = crate::keccak256(prefixed.as_bytes());
        let (sig, recid) = sk.sign_prehash_recoverable(&digest).unwrap();
        let mut bytes = sig.to_bytes().to_vec();
        bytes.push(recid.to_byte() + 27);
        let point = sk.verifying_key().to_encoded_point(false);
        let want = format!(
            "0x{}",
            hex::encode(&crate::keccak256(&point.as_bytes()[1..])[12..])
        );
        assert_eq!(
            recover_address(text, &format!("0x{}", hex::encode(&bytes))).unwrap(),
            want
        );
        assert_ne!(
            recover_address("other", &format!("0x{}", hex::encode(&bytes))).unwrap_or_default(),
            want
        );
    }

    #[test]
    fn reads_a_fenced_answer() {
        let v =
            json_object("```json\n{\"verdict\": \"approve\", \"reasoning\": \"ok\"}\n```").unwrap();
        assert_eq!(v["verdict"], "approve");
        assert!(json_object("no json here").is_none());
    }
}
