//! Wire types. `PriceIdentifier` and `Price` match the Pyth contract on NEAR byte for byte in
//! JSON, because the lending contract reads this oracle through that interface unchanged.

use std::fmt;

use near_sdk::json_types::{I64, U64};
use near_sdk::serde::{de, Deserialize, Deserializer, Serialize, Serializer};
use near_sdk::{near, AccountId};

/// A 32-byte price feed id, written in JSON as 64 hex characters without a `0x` prefix.
/// Output is always lowercase; input may use either case, as the Pyth contract accepts.
#[near(serializers = [borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct PriceIdentifier(pub [u8; 32]);

impl fmt::Display for PriceIdentifier {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&hex::encode(self.0))
    }
}

impl Serialize for PriceIdentifier {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&hex::encode(self.0))
    }
}

impl<'de> Deserialize<'de> for PriceIdentifier {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let s = String::deserialize(deserializer)?;
        let mut bytes = [0u8; 32];
        hex::decode_to_slice(&s, &mut bytes)
            .map_err(|_| de::Error::custom("price id must be 64 hex characters"))?;
        Ok(Self(bytes))
    }
}

/// A price as the Pyth contract returns it:
/// `{ "price": "<i64>", "conf": "<u64>", "expo": <i32>, "publish_time": <i64 seconds> }`.
/// The value is `price * 10^expo`, with `conf` the confidence interval in the same units.
#[near(serializers = [json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Price {
    pub price: I64,
    pub conf: U64,
    pub expo: i32,
    pub publish_time: i64,
}

/// One feeder observation, also the item type of the `price_updated` event.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PriceUpdate {
    pub price_id: PriceIdentifier,
    pub price: I64,
    pub conf: U64,
    pub expo: i32,
    pub publish_time: i64,
}

/// What a feed holds: the last real (fed) price and, at most, one shock over it.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Feed {
    pub price: i64,
    pub conf: u64,
    pub expo: i32,
    pub publish_time: i64,
    /// Block time (unix seconds) of the last shock on this feed, kept after a reset so the
    /// per-feed rate limit cannot be skipped by resetting.
    pub last_shock_at: Option<u64>,
    pub shock: Option<Shock>,
}

/// A market shock: a relative move of the fed price, applied by anyone on testnet.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Shock {
    pub bps: i32,
    pub by: AccountId,
    pub at: u64,
    pub expires_at: u64,
}

/// One shock in the per-caller rate-limit window.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RecentShock {
    pub by: AccountId,
    pub at: u64,
}

/// An active shock as `shock_of` and `shock` return it.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ShockView {
    pub bps: i32,
    pub by: AccountId,
    pub at: u64,
    pub expires_at: u64,
    pub shocked_price: I64,
    pub fed_price: I64,
}

/// Per-feed line of `status`.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FeedStatus {
    pub price_id: PriceIdentifier,
    pub publish_time: i64,
}

/// The oracle's configuration and how fresh each feed is.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Status {
    pub owner_id: AccountId,
    pub feeders: Vec<AccountId>,
    pub network: String,
    pub max_shock_bps: u32,
    pub feeds: Vec<FeedStatus>,
}
