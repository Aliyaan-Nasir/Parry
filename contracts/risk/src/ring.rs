//! A bounded history: the newest `capacity` items, each in its own storage slot.

use near_sdk::borsh::{BorshDeserialize, BorshSerialize};
use near_sdk::store::LookupMap;
use near_sdk::{near, require, IntoStorageKey};

/// Items get increasing sequence numbers; only `head..tail` is kept. Pushing past `capacity`
/// removes the oldest item from storage, so the history never costs more than `capacity`
/// slots however long the contract runs.
#[near(serializers = [borsh])]
pub struct Ring<T>
where
    T: BorshSerialize + BorshDeserialize,
{
    items: LookupMap<u64, T>,
    /// Sequence number of the oldest kept item.
    head: u64,
    /// Sequence number the next item gets.
    tail: u64,
    capacity: u64,
}

impl<T> Ring<T>
where
    T: BorshSerialize + BorshDeserialize,
{
    pub fn new<S: IntoStorageKey>(prefix: S, capacity: u64) -> Self {
        require!(capacity > 0, "a ring needs room for one item");
        Self { items: LookupMap::new(prefix), head: 0, tail: 0, capacity }
    }

    fn len(&self) -> u64 {
        self.tail - self.head
    }

    /// Appends `item` and returns the item evicted to make room, if any.
    pub fn push(&mut self, item: T) -> Option<T> {
        self.items.insert(self.tail, item);
        self.tail += 1;
        if self.len() > self.capacity {
            let evicted = self.items.remove(&self.head);
            self.head += 1;
            evicted
        } else {
            None
        }
    }

    pub fn newest(&self) -> Option<&T> {
        self.newest_first(0, 1).next()
    }

    /// Up to `limit` items, newest first, skipping the `from_index` newest.
    pub fn newest_first(&self, from_index: u64, limit: u64) -> impl Iterator<Item = &T> {
        let end = self.len().min(from_index.saturating_add(limit));
        (from_index..end).filter_map(move |i| self.items.get(&(self.tail - 1 - i)))
    }

    /// Writes pending changes now (normally done when the contract state is dropped), so tests
    /// can look at raw storage.
    #[cfg(test)]
    pub fn flush(&mut self) {
        self.items.flush();
    }
}
