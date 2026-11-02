//! # Parry testnet oracle
//!
//! A price oracle for NEAR testnet that answers with the Pyth contract's interface, so the
//! lending contract (the same code that runs on mainnet) can price testnet positions through it
//! without any change. Keepers listed as feeders push real market prices; the views return them
//! with the usual staleness rules.
//!
//! On top of the real prices sits the market shock: anyone may move one feed by a bounded
//! percentage for 30 minutes, to watch protection react to a crash without waiting for one.
//! The shock is relative to the fed price and follows it (a shock of -2000 bps reads as 20%
//! below the latest real price, however the market moves meanwhile), it never compounds, its
//! price carries the fed publish time (so a shock never turns a price stale on its own), and it
//! expires by itself. The contract refuses to initialise for any network but testnet: a price
//! anyone can move must never exist on mainnet.

mod types;

pub use types::*;

use std::collections::BTreeMap;

use near_sdk::json_types::{I64, U64};
use near_sdk::store::{IterableMap, IterableSet, Lazy};
use near_sdk::{assert_one_yocto, env, near, require, AccountId, BorshStorageKey, PanicOnDefault};

/// The only network this contract may run on.
pub const TESTNET: &str = "testnet";
/// Freshness `get_price`, `get_ema_price` and `list_prices` require.
pub const DEFAULT_MAX_AGE_SECS: u64 = 60;
/// How far ahead of the block time a feeder's publish time may be (clock skew allowance).
pub const MAX_FUTURE_SECS: i64 = 60;
/// Upper bound for `max_shock_bps`: a shock moves a price by at most half.
pub const MAX_SHOCK_BPS_LIMIT: u32 = 5_000;
/// How long a shock lasts before the views ignore it.
pub const SHOCK_DURATION_SECS: u64 = 30 * 60;
/// One shock per caller in this window, across all feeds.
pub const CALLER_SHOCK_INTERVAL_SECS: u64 = 60;
/// One shock per feed in this window, across all callers.
pub const FEED_SHOCK_INTERVAL_SECS: u64 = 10;
/// Bounds the gas and the event size of one `update_prices` call.
pub const MAX_UPDATES_PER_CALL: usize = 64;

const BPS: i128 = 10_000;

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Feeders,
    Feeds,
    RecentShocks,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner_id: AccountId,
    network: String,
    max_shock_bps: u32,
    feeders: IterableSet<AccountId>,
    feeds: IterableMap<PriceIdentifier, Feed>,
    /// Shocks applied in the last `CALLER_SHOCK_INTERVAL_SECS`, oldest first. This is all the
    /// per-caller rate limit needs, and it stays small without any per-caller record: each feed
    /// takes at most one shock per `FEED_SHOCK_INTERVAL_SECS`, so the window never holds more
    /// than six entries per feed. Kept lazy so price views never load it.
    recent_shocks: Lazy<Vec<RecentShock>>,
}

/// NEP-297 events, standard `parry-oracle`.
#[near(event_json(standard = "parry-oracle"))]
pub enum Event {
    /// One event per `update_prices` call, with every update it applied.
    #[event_version("1.0.0")]
    PriceUpdated(Vec<PriceUpdate>),
    #[event_version("1.0.0")]
    ShockApplied {
        price_id: PriceIdentifier,
        bps: i32,
        by: AccountId,
        at: u64,
        expires_at: u64,
        fed_price: I64,
        shocked_price: I64,
    },
    #[event_version("1.0.0")]
    ShockReset {
        price_id: PriceIdentifier,
        by: AccountId,
        /// True when the shock had already expired (a cleanup, not an early end).
        expired: bool,
    },
}

fn now_secs() -> u64 {
    env::block_timestamp() / 1_000_000_000
}

/// True unless the price is more than `age` seconds older than `now`. A publish time ahead of
/// the block (allowed up to `MAX_FUTURE_SECS`) counts as fresh.
fn is_fresh(publish_time: i64, now: u64, age: u64) -> bool {
    i128::from(now) - i128::from(publish_time) <= i128::from(age)
}

/// `fed * (10000 + bps) / 10000`, floored, kept at least 1 so a shocked price stays a valid
/// (positive) price, and saturating at `i64::MAX` instead of wrapping.
pub fn shocked_price(fed: i64, bps: i32) -> i64 {
    let value = i128::from(fed) * (BPS + i128::from(bps)) / BPS;
    value.clamp(1, i128::from(i64::MAX)) as i64
}

fn assert_max_shock_bps(max_shock_bps: u32) {
    require!(max_shock_bps <= MAX_SHOCK_BPS_LIMIT, "max_shock_bps must be at most 5000");
}

#[near]
impl Contract {
    #[init]
    pub fn new(owner_id: AccountId, feeders: Vec<AccountId>, network: String, max_shock_bps: u32) -> Self {
        require!(network == TESTNET, "this oracle runs on testnet only: network must be \"testnet\"");
        assert_max_shock_bps(max_shock_bps);
        let mut set = IterableSet::new(StorageKey::Feeders);
        set.extend(feeders);
        Self {
            owner_id,
            network,
            max_shock_bps,
            feeders: set,
            feeds: IterableMap::new(StorageKey::Feeds),
            recent_shocks: Lazy::new(StorageKey::RecentShocks, Vec::new()),
        }
    }

    // ---------------------------------------------------------------------------------------
    // Pyth-compatible views
    // ---------------------------------------------------------------------------------------

    /// The current price if it is at most `DEFAULT_MAX_AGE_SECS` old.
    pub fn get_price(&self, price_identifier: PriceIdentifier) -> Option<Price> {
        self.price_no_older_than(&price_identifier, DEFAULT_MAX_AGE_SECS)
    }

    /// The current price, however old.
    pub fn get_price_unsafe(&self, price_identifier: PriceIdentifier) -> Option<Price> {
        self.feeds.get(&price_identifier).map(|feed| current_price(feed, now_secs()))
    }

    /// The current price if `block time - publish_time <= age` (seconds), else `None`.
    pub fn get_price_no_older_than(&self, price_id: PriceIdentifier, age: u64) -> Option<Price> {
        self.price_no_older_than(&price_id, age)
    }

    /// The feeders publish spot prices only, so the moving average is the price itself.
    pub fn get_ema_price(&self, price_id: PriceIdentifier) -> Option<Price> {
        self.price_no_older_than(&price_id, DEFAULT_MAX_AGE_SECS)
    }

    pub fn get_ema_price_unsafe(&self, price_identifier: PriceIdentifier) -> Option<Price> {
        self.get_price_unsafe(price_identifier)
    }

    pub fn get_ema_price_no_older_than(&self, price_id: PriceIdentifier, age: u64) -> Option<Price> {
        self.price_no_older_than(&price_id, age)
    }

    pub fn price_feed_exists(&self, price_identifier: PriceIdentifier) -> bool {
        self.feeds.contains_key(&price_identifier)
    }

    /// `get_price` for each id, keyed by id (an unknown or stale id maps to `null`).
    pub fn list_prices(&self, price_ids: Vec<PriceIdentifier>) -> BTreeMap<PriceIdentifier, Option<Price>> {
        price_ids
            .into_iter()
            .map(|id| {
                let price = self.price_no_older_than(&id, DEFAULT_MAX_AGE_SECS);
                (id, price)
            })
            .collect()
    }

    // ---------------------------------------------------------------------------------------
    // Feeders
    // ---------------------------------------------------------------------------------------

    /// Stores real prices. Feeders only. The whole call is refused if any update has a publish
    /// time not newer than the stored one, more than `MAX_FUTURE_SECS` ahead of the block, a
    /// non-positive price, or an exponent different from the feed's (an exponent change would
    /// silently rescale every reader's price by a power of ten).
    pub fn update_prices(&mut self, updates: Vec<PriceUpdate>) {
        require!(self.feeders.contains(&env::predecessor_account_id()), "feeders only");
        require!(!updates.is_empty(), "no updates");
        require!(
            updates.len() <= MAX_UPDATES_PER_CALL,
            format!("at most {MAX_UPDATES_PER_CALL} updates per call")
        );
        let latest_allowed = now_secs() as i64 + MAX_FUTURE_SECS;
        for update in &updates {
            let id = update.price_id;
            require!(update.price.0 > 0, format!("{id}: price must be positive"));
            require!(update.publish_time > 0, format!("{id}: publish_time must be positive"));
            require!(
                update.publish_time <= latest_allowed,
                format!("{id}: publish_time is more than {MAX_FUTURE_SECS} s in the future")
            );
            match self.feeds.get_mut(&id) {
                Some(feed) => {
                    require!(
                        update.publish_time > feed.publish_time,
                        format!(
                            "{id}: publish_time {} is not newer than the stored {}",
                            update.publish_time, feed.publish_time
                        )
                    );
                    require!(
                        update.expo == feed.expo,
                        format!("{id}: expo {} differs from the feed's {}", update.expo, feed.expo)
                    );
                    feed.price = update.price.0;
                    feed.conf = update.conf.0;
                    feed.publish_time = update.publish_time;
                }
                None => {
                    self.feeds.insert(
                        id,
                        Feed {
                            price: update.price.0,
                            conf: update.conf.0,
                            expo: update.expo,
                            publish_time: update.publish_time,
                            last_shock_at: None,
                            shock: None,
                        },
                    );
                }
            }
        }
        Event::PriceUpdated(updates).emit();
    }

    // ---------------------------------------------------------------------------------------
    // Market shock (testnet only, anyone)
    // ---------------------------------------------------------------------------------------

    /// Moves `price_id` to `fed * (10000 + bps) / 10000` for `SHOCK_DURATION_SECS`, replacing
    /// any active shock (the new one is again relative to the fed price, never to the shocked
    /// one). `|bps|` is at most `max_shock_bps`. Rate limited to one shock per caller per
    /// `CALLER_SHOCK_INTERVAL_SECS` and one per feed per `FEED_SHOCK_INTERVAL_SECS`.
    pub fn shock(&mut self, price_id: PriceIdentifier, bps: i32) -> ShockView {
        require!(self.network == TESTNET, "market shocks exist on testnet only");
        require!(bps != 0, "bps must not be zero: use reset_shock to clear a shock");
        require!(
            bps.unsigned_abs() <= self.max_shock_bps,
            format!("|bps| must be at most {}", self.max_shock_bps)
        );
        let caller = env::predecessor_account_id();
        let now = now_secs();

        let recent = self.recent_shocks.get_mut();
        recent.retain(|r| now < r.at.saturating_add(CALLER_SHOCK_INTERVAL_SECS));
        if let Some(r) = recent.iter().find(|r| r.by == caller) {
            env::panic_str(&format!(
                "one shock per account per {CALLER_SHOCK_INTERVAL_SECS} s: next at {} (unix seconds)",
                r.at + CALLER_SHOCK_INTERVAL_SECS
            ));
        }

        let feed = self
            .feeds
            .get_mut(&price_id)
            .unwrap_or_else(|| env::panic_str(&format!("{price_id}: unknown price id")));
        if let Some(last) = feed.last_shock_at {
            let next = last.saturating_add(FEED_SHOCK_INTERVAL_SECS);
            require!(
                now >= next,
                format!(
                    "one shock per price id per {FEED_SHOCK_INTERVAL_SECS} s: next at {next} (unix seconds)"
                )
            );
        }
        let shock =
            Shock { bps, by: caller.clone(), at: now, expires_at: now.saturating_add(SHOCK_DURATION_SECS) };
        let view = shock_view(feed, &shock);
        feed.last_shock_at = Some(now);
        feed.shock = Some(shock);
        recent.push(RecentShock { by: caller, at: now });

        Event::ShockApplied {
            price_id,
            bps,
            by: view.by.clone(),
            at: view.at,
            expires_at: view.expires_at,
            fed_price: view.fed_price,
            shocked_price: view.shocked_price,
        }
        .emit();
        view
    }

    /// Ends a shock: allowed for the account that applied it and for the owner at any time, and
    /// for anyone once it has expired (then it only clears storage the views already ignore).
    pub fn reset_shock(&mut self, price_id: PriceIdentifier) {
        let caller = env::predecessor_account_id();
        let now = now_secs();
        let owner_id = self.owner_id.clone();
        let feed = self
            .feeds
            .get_mut(&price_id)
            .unwrap_or_else(|| env::panic_str(&format!("{price_id}: unknown price id")));
        let shock = feed.shock.take().unwrap_or_else(|| env::panic_str(&format!("{price_id}: no shock")));
        let expired = now >= shock.expires_at;
        require!(
            expired || caller == shock.by || caller == owner_id,
            "only the account that applied the shock or the owner can reset it before it expires"
        );
        Event::ShockReset { price_id, by: caller, expired }.emit();
    }

    /// The active shock on `price_id`, or `null` when there is none or it has expired.
    pub fn shock_of(&self, price_id: PriceIdentifier) -> Option<ShockView> {
        let feed = self.feeds.get(&price_id)?;
        let shock = active_shock(feed, now_secs())?;
        Some(shock_view(feed, shock))
    }

    // ---------------------------------------------------------------------------------------
    // Owner (1 yoctoNEAR, so only a full-access key can sign)
    // ---------------------------------------------------------------------------------------

    #[payable]
    pub fn add_feeder(&mut self, account_id: AccountId) {
        self.assert_owner();
        require!(self.feeders.insert(account_id), "already a feeder");
    }

    #[payable]
    pub fn remove_feeder(&mut self, account_id: AccountId) {
        self.assert_owner();
        require!(self.feeders.remove(&account_id), "not a feeder");
    }

    /// Bounds future shocks only; an active shock keeps its size until it expires or is reset.
    #[payable]
    pub fn set_max_shock_bps(&mut self, max_shock_bps: u32) {
        self.assert_owner();
        assert_max_shock_bps(max_shock_bps);
        self.max_shock_bps = max_shock_bps;
    }

    pub fn status(&self) -> Status {
        Status {
            owner_id: self.owner_id.clone(),
            feeders: self.feeders.iter().cloned().collect(),
            network: self.network.clone(),
            max_shock_bps: self.max_shock_bps,
            feeds: self
                .feeds
                .iter()
                .map(|(id, feed)| FeedStatus { price_id: *id, publish_time: feed.publish_time })
                .collect(),
        }
    }

    fn assert_owner(&self) {
        assert_one_yocto();
        require!(env::predecessor_account_id() == self.owner_id, "owner only");
    }

    fn price_no_older_than(&self, id: &PriceIdentifier, age: u64) -> Option<Price> {
        let now = now_secs();
        let feed = self.feeds.get(id)?;
        is_fresh(feed.publish_time, now, age).then(|| current_price(feed, now))
    }
}

/// The price the views serve: the shocked price while a shock is active, else the fed one,
/// always with the fed confidence, exponent and publish time.
fn current_price(feed: &Feed, now: u64) -> Price {
    let price = match active_shock(feed, now) {
        Some(shock) => shocked_price(feed.price, shock.bps),
        None => feed.price,
    };
    Price { price: I64(price), conf: U64(feed.conf), expo: feed.expo, publish_time: feed.publish_time }
}

fn active_shock(feed: &Feed, now: u64) -> Option<&Shock> {
    feed.shock.as_ref().filter(|shock| now < shock.expires_at)
}

fn shock_view(feed: &Feed, shock: &Shock) -> ShockView {
    ShockView {
        bps: shock.bps,
        by: shock.by.clone(),
        at: shock.at,
        expires_at: shock.expires_at,
        shocked_price: I64(shocked_price(feed.price, shock.bps)),
        fed_price: I64(feed.price),
    }
}

#[cfg(test)]
mod tests;
