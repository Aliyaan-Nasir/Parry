//! Proof of reserves, as in packages/core/src/reserves.ts.

use crate::sha256;

pub struct Leaf {
    pub asset: String,
    pub venue: String,
    pub amount: String,
    pub usd_e6: String,
}

pub fn leaf_hash(l: &Leaf) -> [u8; 32] {
    sha256(
        format!(
            "parry-reserve:v1|{}|{}|{}|{}",
            l.asset, l.venue, l.amount, l.usd_e6
        )
        .as_bytes(),
    )
}

fn node(a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
    let (lo, hi) = if a < b { (a, b) } else { (b, a) };
    sha256(&[[1u8].as_slice(), lo, hi].concat())
}

pub fn root(leaves: &[Leaf]) -> String {
    if leaves.is_empty() {
        return hex::encode(sha256(b"parry-reserve:v1|empty"));
    }
    let mut level: Vec<[u8; 32]> = leaves.iter().map(leaf_hash).collect();
    // Lowercase hex sorts like the bytes it encodes, so this matches the TypeScript tree.
    level.sort();
    while level.len() > 1 {
        level = level
            .chunks(2)
            .map(|c| {
                if c.len() == 2 {
                    node(&c[0], &c[1])
                } else {
                    c[0]
                }
            })
            .collect();
    }
    hex::encode(level[0])
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The same tree as the TypeScript test in packages/core.
    #[test]
    fn root_is_order_independent_and_changes_with_any_leaf() {
        let mk = |a: &str, v: &str, amt: &str, usd: &str| Leaf {
            asset: a.into(),
            venue: v.into(),
            amount: amt.into(),
            usd_e6: usd.into(),
        };
        let leaves = vec![
            mk(
                "LiNEAR",
                "near",
                "1000000000000000000000000000",
                "3600000000",
            ),
            mk("USDC", "hyperliquid", "2000000000", "2000000000"),
            mk("NEAR-PERP", "hyperliquid", "-108000000000", "0"),
        ];
        let r = root(&leaves);
        // The same root packages/core computes for these leaves.
        assert_eq!(
            r,
            "72baafd93e5edf320aee2a823451fee2cd9fbc8e38279bec948b293b9e3b95a3"
        );
        let rev: Vec<Leaf> = leaves
            .iter()
            .rev()
            .map(|l| mk(&l.asset, &l.venue, &l.amount, &l.usd_e6))
            .collect();
        assert_eq!(r, root(&rev));
        let mut changed = rev;
        changed[0].amount = "1".into();
        assert_ne!(r, root(&changed));
    }
}
