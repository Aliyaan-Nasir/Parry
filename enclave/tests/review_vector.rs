//! Cross-language check: the review hash the TypeScript SDK computes (`reviewHash` in
//! packages/sdk) equals `Review::hash()` for the same fields, including text that needs escaping.

use parry_enclave::ai::{recover_address, Review};
use serde_json::Value;

const FIXTURE: &str = include_str!("../../packages/sdk/test/fixtures/review.json");

#[test]
fn the_sdk_hashes_a_review_like_the_enclave() {
    let f: Value = serde_json::from_str(FIXTURE).unwrap();
    let r = &f["review"];
    let field = |name: &str| r[name].as_str().unwrap().to_string();
    let review = Review {
        model: field("model"),
        chat_id: field("chat_id"),
        request_hash: field("request_hash"),
        response_hash: field("response_hash"),
        signed_text: field("signed_text"),
        signature: field("signature"),
        signing_address: field("signing_address"),
        signature_kind: field("signature_kind"),
        verdict: field("verdict"),
        reasoning: field("reasoning"),
    };
    assert_eq!(
        serde_json::to_string(&review).unwrap(),
        f["json"].as_str().unwrap()
    );
    assert_eq!(review.hash(), f["hash"].as_str().unwrap());
    // The SDK's model signature recovers here to the same address.
    assert_eq!(
        recover_address(&review.signed_text, &review.signature).unwrap(),
        review.signing_address
    );
}
