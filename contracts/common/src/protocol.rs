//! The contracts a protected account works with, and its owner. Both are part of the account's
//! initial state, which the factory writes and the account's universal address commits to.

use near_sdk::{near, AccountId};

/// One token the account handles.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TokenConfig {
    pub token_id: AccountId,
    pub symbol: String,
    pub decimals: u8,
    /// Rhea's `extra_decimals` for this asset: inner units = token units × 10^extra.
    pub extra_decimals: u8,
    /// Pyth price id (64 hex) on the protocol's price oracle.
    pub price_id: String,
    /// A view on the token that returns NEAR per token scaled by 1e24 (LiNEAR's `ft_price`).
    pub rate_call: Option<String>,
    /// The risk board mark this token is priced with in guards (for example "NEAR"); None for a
    /// USD stablecoin, valued at 1.
    pub mark: Option<String>,
}

/// Contract ids for one network.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Protocol {
    /// Rhea lending.
    pub lending: AccountId,
    /// Pyth-interface price oracle the lending contract prices with.
    pub oracle: AccountId,
    /// Rhea (Ref v2) exchange for rescue swaps.
    pub dex: AccountId,
    /// Parry's risk board (marks for the guards).
    pub risk: AccountId,
    /// Chain Signatures MPC contract.
    pub signer: AccountId,
    pub factory: AccountId,
    pub tokens: Vec<TokenConfig>,
}

impl Protocol {
    pub fn token(&self, id: &AccountId) -> Option<&TokenConfig> {
        self.tokens.iter().find(|t| &t.token_id == id)
    }
}

/// Who controls a protected account.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Owner {
    /// A passkey: compressed P-256 public key (33 bytes). Requests are WebAuthn assertions.
    Passkey { key: Vec<u8> },
    /// A NEAR account (any wallet): calls from it with one yoctoNEAR attached, which only a
    /// full-access key can attach.
    Near { account_id: AccountId },
}

/// The account's initial state, stored under `STATE`.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AccountCore {
    pub owner: Owner,
    /// "testnet" or "mainnet": part of every signed request, so a request never replays across.
    pub network: String,
    pub protocol: Protocol,
}

/// Chain Signatures derivation paths of a protected account.
pub const PATH_HYPERLIQUID: &str = "parry-hyperliquid";
pub const PATH_EVM: &str = "parry-evm";
