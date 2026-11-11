//! # Parry guardian enclave
//!
//! An OutLayer WASI program (Intel TDX). One run reads positions, mandates and markets itself,
//! scores risk with Parry's model, plans one protective step per account inside its mandate, has
//! a NEAR AI Cloud verifiable model review the plan, and signs what was approved with the
//! enclave's ed25519 key, which OutLayer derives for this exact build and never reveals. Accounts
//! accept guardian actions only with that key's signature, so only this code can act for them.
//!
//! Modes: `keys` (the signing and sealing keys), `risk_update` (signed scores and marks for the
//! risk board), `guardian` (reviewed, signed rescue envelopes), `vault_report` (the vault's
//! hedge, hedge ratio, risk score and proof of reserves), `certificate` (a signed statement that
//! an account's health is at least a threshold, with nothing else about the position).

pub mod ai;
pub mod chain;
pub mod config;
pub mod evm;
pub mod hl;
pub mod io;
pub mod modes;
pub mod plan;
pub mod reserves;
pub mod risk;
pub mod seal;

use sha2::Digest;

pub fn sha256(data: &[u8]) -> [u8; 32] {
    sha2::Sha256::digest(data).into()
}

pub fn keccak256(data: &[u8]) -> [u8; 32] {
    sha3::Keccak256::digest(data).into()
}
