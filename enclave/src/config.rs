//! Endpoints and contract ids, compiled in. The caller's input picks a mode and the accounts to
//! look at, never where the enclave reads from: the wasm hash (which the key is bound to) pins
//! every source below. `build.sh` prints them.

macro_rules! cfg {
    ($name:ident, $env:literal, $default:literal) => {
        pub const $name: &str = match option_env!($env) {
            Some(v) => v,
            None => $default,
        };
    };
}

cfg!(NETWORK, "PARRY_NETWORK", "testnet");
cfg!(RPC, "PARRY_RPC_URL", "https://test.rpc.fastnear.com");
cfg!(RISK, "PARRY_RISK", "risk.parry.testnet");
cfg!(VAULT, "PARRY_VAULT", "vault.parry.testnet");
cfg!(LENDING, "PARRY_LENDING", "lending.parry.testnet");
cfg!(ORACLE, "PARRY_ORACLE", "oracle.parry.testnet");
cfg!(SIGNER, "PARRY_SIGNER", "v1.signer-prod.testnet");
cfg!(USDC, "PARRY_USDC", "usdc.parry.testnet");
cfg!(WNEAR, "PARRY_WNEAR", "wrap.testnet");
cfg!(LINEAR, "PARRY_LINEAR", "linear-protocol.testnet");
cfg!(
    HYPERLIQUID,
    "PARRY_HYPERLIQUID_URL",
    "https://api.hyperliquid-testnet.xyz"
);
cfg!(
    EVM_RPC,
    "PARRY_EVM_RPC_URL",
    "https://ethereum-sepolia-rpc.publicnode.com"
);
cfg!(NEARAI, "PARRY_NEARAI_URL", "https://cloud-api.near.ai/v1");
cfg!(MODEL, "PARRY_REVIEW_MODEL", "z-ai/glm-5.3-flash");

pub const NEAR_USD: &str = "c415de8d2eba7db216527dff4b60e8f3a5311c740dadb233e13e12547e226750";
pub const USDC_USD: &str = "eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a";
pub const HL_SZ_DECIMALS: u32 = 1;

pub fn mainnet() -> bool {
    NETWORK == "mainnet"
}

/// Hyperliquid's NEAR perp asset index: 54 on testnet, 74 on mainnet (from each API's `meta`).
pub fn hl_near_index() -> u32 {
    if mainnet() {
        74
    } else {
        54
    }
}

// The wNEAR/USDC pool on the exchange that rescue swaps use.
cfg!(DEX_POOL, "PARRY_DEX_POOL", "");
