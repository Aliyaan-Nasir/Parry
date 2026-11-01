//! Shared by Parry's contracts. Everything here is pure (no state), so each contract stays the
//! single owner of its storage.

pub mod evm;
pub mod hyperliquid;
pub mod mandate;
pub mod math;
pub mod protocol;
pub mod pyth;
pub mod rhea;
pub mod wire;

use near_sdk::{env, NearToken};

pub const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
pub const SECS_PER_DAY: u64 = 86_400;

/// Block time in whole seconds.
pub fn now_secs() -> u64 {
    env::block_timestamp() / 1_000_000_000
}

/// The UTC day number of `secs`.
pub fn day_of(secs: u64) -> u64 {
    secs / SECS_PER_DAY
}

/// Largest promise result a callback reads: views of a lending position or a list of marks
/// stay far below it, and a bound keeps a hostile callee from burning the callback's gas.
pub const MAX_RESULT_BYTES: usize = 64 * 1024;

/// The bytes of promise result `index` when it succeeded.
pub fn promise_bytes(index: u64) -> Option<Vec<u8>> {
    env::promise_result_checked(index, MAX_RESULT_BYTES).ok()
}

/// True when every promise result of this callback succeeded.
pub fn all_promises_succeeded() -> bool {
    (0..env::promise_results_count()).all(|i| promise_bytes(i).is_some())
}
