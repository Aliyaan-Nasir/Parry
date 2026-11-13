//! Hyperliquid L1 actions, encoded and hashed on chain, so a guard checks exactly the bytes that
//! Chain Signatures will sign.
//!
//! Hyperliquid authenticates an L1 action with an EIP-712 "agent" message: the action is
//! MessagePack encoded with the key order its reference SDK uses, followed by the nonce (u64, big
//! endian) and a 0x00 byte meaning "no vault address". The keccak256 of those bytes is the
//! `connectionId`, and the signed digest is EIP-712 over `Agent(string source, bytes32
//! connectionId)` in the `Exchange` domain (version "1", chain id 1337, zero verifying contract),
//! with `source` "a" on mainnet and "b" on testnet.

use near_sdk::{env, near, require};

/// One limit order. Price and size are the decimal strings Hyperliquid expects (no trailing
/// zeros, at most 8 decimals); the off-chain builder formats them to the asset's tick and lot.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HlOrder {
    /// Hyperliquid asset index (`a` in the wire format), for example 54 for NEAR on testnet.
    pub asset_index: u32,
    pub is_buy: bool,
    pub price: String,
    pub size: String,
    pub reduce_only: bool,
    /// `Gtc`, `Ioc` or `Alo`.
    pub tif: String,
}

/// Minimal MessagePack writer for the few shapes Hyperliquid actions use.
struct Pack(Vec<u8>);

impl Pack {
    fn map(&mut self, len: u8) -> &mut Self {
        debug_assert!(len < 16);
        self.0.push(0x80 | len);
        self
    }
    fn array(&mut self, len: u8) -> &mut Self {
        debug_assert!(len < 16);
        self.0.push(0x90 | len);
        self
    }
    fn str(&mut self, s: &str) -> &mut Self {
        let b = s.as_bytes();
        match b.len() {
            n if n < 32 => self.0.push(0xa0 | n as u8),
            n if n <= u8::MAX as usize => {
                self.0.push(0xd9);
                self.0.push(n as u8);
            }
            _ => env::panic_str("string too long for an action"),
        }
        self.0.extend_from_slice(b);
        self
    }
    fn bool(&mut self, v: bool) -> &mut Self {
        self.0.push(if v { 0xc3 } else { 0xc2 });
        self
    }
    fn uint(&mut self, v: u64) -> &mut Self {
        match v {
            0..=0x7f => self.0.push(v as u8),
            0x80..=0xff => self.0.extend_from_slice(&[0xcc, v as u8]),
            0x100..=0xffff => {
                self.0.push(0xcd);
                self.0.extend_from_slice(&(v as u16).to_be_bytes());
            }
            0x1_0000..=0xffff_ffff => {
                self.0.push(0xce);
                self.0.extend_from_slice(&(v as u32).to_be_bytes());
            }
            _ => {
                self.0.push(0xcf);
                self.0.extend_from_slice(&v.to_be_bytes());
            }
        }
        self
    }
}

/// MessagePack of `{"type":"order","orders":[{a,b,p,s,r,t:{limit:{tif}}}],"grouping":"na"}`.
pub fn order_action(order: &HlOrder) -> Vec<u8> {
    require!(matches!(order.tif.as_str(), "Gtc" | "Ioc" | "Alo"), "time in force must be Gtc, Ioc or Alo");
    require!(parse_e8(&order.price).is_some_and(|p| p > 0), "bad order price");
    require!(parse_e8(&order.size).is_some_and(|s| s > 0), "bad order size");
    let mut p = Pack(Vec::with_capacity(112));
    p.map(3).str("type").str("order").str("orders").array(1);
    p.map(6)
        .str("a")
        .uint(order.asset_index as u64)
        .str("b")
        .bool(order.is_buy)
        .str("p")
        .str(&order.price)
        .str("s")
        .str(&order.size)
        .str("r")
        .bool(order.reduce_only)
        .str("t")
        .map(1)
        .str("limit")
        .map(1)
        .str("tif")
        .str(&order.tif);
    p.str("grouping").str("na");
    p.0
}

/// MessagePack of `{"type":"updateLeverage","asset","isCross","leverage"}`.
pub fn leverage_action(asset_index: u32, is_cross: bool, leverage: u32) -> Vec<u8> {
    let mut p = Pack(Vec::with_capacity(56));
    p.map(4)
        .str("type")
        .str("updateLeverage")
        .str("asset")
        .uint(asset_index as u64)
        .str("isCross")
        .bool(is_cross)
        .str("leverage")
        .uint(leverage as u64);
    p.0
}

/// keccak256(action || nonce (big endian) || 0x00), the agent's `connectionId`.
pub fn connection_id(action: &[u8], nonce: u64) -> [u8; 32] {
    let mut data = Vec::with_capacity(action.len() + 9);
    data.extend_from_slice(action);
    data.extend_from_slice(&nonce.to_be_bytes());
    data.push(0);
    env::keccak256_array(&data)
}

fn u256_word(v: u64) -> [u8; 32] {
    let mut w = [0u8; 32];
    w[24..].copy_from_slice(&v.to_be_bytes());
    w
}

/// The EIP-712 digest of the agent message for `connection_id`.
pub fn agent_digest(connection_id: &[u8; 32], mainnet: bool) -> [u8; 32] {
    let mut domain = Vec::with_capacity(5 * 32);
    domain.extend_from_slice(&env::keccak256_array(
        b"EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
    ));
    domain.extend_from_slice(&env::keccak256_array(b"Exchange"));
    domain.extend_from_slice(&env::keccak256_array(b"1"));
    domain.extend_from_slice(&u256_word(1337));
    domain.extend_from_slice(&[0u8; 32]);
    let separator = env::keccak256_array(&domain);

    let mut agent = Vec::with_capacity(3 * 32);
    agent.extend_from_slice(&env::keccak256_array(b"Agent(string source,bytes32 connectionId)"));
    agent.extend_from_slice(&env::keccak256_array(if mainnet { b"a" } else { b"b" }));
    agent.extend_from_slice(connection_id);
    let struct_hash = env::keccak256_array(&agent);

    let mut message = Vec::with_capacity(66);
    message.extend_from_slice(&[0x19, 0x01]);
    message.extend_from_slice(&separator);
    message.extend_from_slice(&struct_hash);
    env::keccak256_array(&message)
}

/// The digest Chain Signatures signs for `order` at `nonce`.
pub fn order_digest(order: &HlOrder, nonce: u64, mainnet: bool) -> [u8; 32] {
    agent_digest(&connection_id(&order_action(order), nonce), mainnet)
}

/// The Arbitrum chain id Hyperliquid's user-signed actions name (`signatureChainId`): Arbitrum
/// One on mainnet, Arbitrum Sepolia on testnet.
pub fn signature_chain_id(mainnet: bool) -> u64 {
    if mainnet {
        42_161
    } else {
        421_614
    }
}

/// The EIP-712 digest of a `usdClassTransfer`, a user-signed action that moves USDC between the
/// signer's own Spot and Perps balances: `HyperliquidTransaction:UsdClassTransfer(string
/// hyperliquidChain,string amount,bool toPerp,uint64 nonce)` in the `HyperliquidSignTransaction`
/// domain (version "1", the chain id above, zero verifying contract). It has no destination, so
/// a signature for it can never move funds to another address.
pub fn usd_class_transfer_digest(amount: &str, to_perp: bool, nonce: u64, mainnet: bool) -> [u8; 32] {
    require!(parse_e8(amount).is_some_and(|a| a > 0), "bad transfer amount");
    let mut domain = Vec::with_capacity(5 * 32);
    domain.extend_from_slice(&env::keccak256_array(
        b"EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
    ));
    domain.extend_from_slice(&env::keccak256_array(b"HyperliquidSignTransaction"));
    domain.extend_from_slice(&env::keccak256_array(b"1"));
    domain.extend_from_slice(&u256_word(signature_chain_id(mainnet)));
    domain.extend_from_slice(&[0u8; 32]);
    let separator = env::keccak256_array(&domain);

    let mut transfer = Vec::with_capacity(5 * 32);
    transfer.extend_from_slice(&env::keccak256_array(
        b"HyperliquidTransaction:UsdClassTransfer(string hyperliquidChain,string amount,bool toPerp,uint64 nonce)",
    ));
    transfer.extend_from_slice(&env::keccak256_array(if mainnet { b"Mainnet" } else { b"Testnet" }));
    transfer.extend_from_slice(&env::keccak256_array(amount.as_bytes()));
    transfer.extend_from_slice(&u256_word(to_perp as u64));
    transfer.extend_from_slice(&u256_word(nonce));
    let struct_hash = env::keccak256_array(&transfer);

    let mut message = Vec::with_capacity(66);
    message.extend_from_slice(&[0x19, 0x01]);
    message.extend_from_slice(&separator);
    message.extend_from_slice(&struct_hash);
    env::keccak256_array(&message)
}

/// Parses a positive decimal string ("3.6345") into an integer scaled by 1e8; None for anything
/// that is not plain digits with an optional fraction of at most 8 digits.
pub fn parse_e8(s: &str) -> Option<u128> {
    if s.is_empty() || s.len() > 32 {
        return None;
    }
    let (whole, frac) = match s.split_once('.') {
        Some((w, f)) if !w.is_empty() && !f.is_empty() => (w, f),
        Some(_) => return None,
        None => (s, ""),
    };
    if frac.len() > 8
        || !whole.bytes().all(|c| c.is_ascii_digit())
        || !frac.bytes().all(|c| c.is_ascii_digit())
    {
        return None;
    }
    let whole: u128 = whole.parse().ok()?;
    let mut scaled: u128 = if frac.is_empty() { 0 } else { frac.parse().ok()? };
    for _ in frac.len()..8 {
        scaled *= 10;
    }
    whole.checked_mul(100_000_000)?.checked_add(scaled)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn btc_ioc() -> HlOrder {
        HlOrder {
            asset_index: 0,
            is_buy: true,
            price: "65000".into(),
            size: "0.001".into(),
            reduce_only: false,
            tif: "Ioc".into(),
        }
    }

    /// Vectors from Hyperliquid's reference encoder (msgpack + keccak), testnet source "b".
    #[test]
    fn order_bytes_and_digest_match_the_reference_encoder() {
        let want = "83a474797065a56f72646572a66f72646572739186a16100a162c3a170a53635303030a173a5302e303031a172c2a17481a56c696d697481a3746966a3496f63a867726f7570696e67a26e61";
        assert_eq!(hex::encode(order_action(&btc_ioc())), want);
        let cid = connection_id(&order_action(&btc_ioc()), 1_700_000_000_000);
        assert_eq!(hex::encode(cid), "3da5943d2d9f1ea6c0dbb3b01f6bbde493957855410e9a7a4dd5c766146a1883");
        assert_eq!(
            hex::encode(agent_digest(&cid, false)),
            "b2537461185e0995f837c1e35d7e8a19244a13383f2e5a7013e1572cd25543ba"
        );
        assert_ne!(agent_digest(&cid, true), agent_digest(&cid, false));
    }

    /// Vectors from ethers' `TypedDataEncoder.hash` over the same typed data.
    #[test]
    fn usd_class_transfer_digest_matches_eip712() {
        assert_eq!(
            hex::encode(usd_class_transfer_digest("997", true, 1_700_000_000_000, false)),
            "d4b0ab05d405a1e7ce9b28eb6c4ba57972b792dae0036b699b714deabc3f383b"
        );
        assert_eq!(
            hex::encode(usd_class_transfer_digest("997", true, 1_700_000_000_000, true)),
            "1424d2e72a90323e096fc09f48d6a29794923275c225ba62e2e71e951cda37a7"
        );
        assert_ne!(
            usd_class_transfer_digest("997", true, 1, false),
            usd_class_transfer_digest("997", false, 1, false)
        );
    }

    #[test]
    #[should_panic(expected = "bad transfer amount")]
    fn usd_class_transfer_refuses_a_bad_amount() {
        usd_class_transfer_digest("-5", true, 1, false);
    }

    #[test]
    fn leverage_bytes() {
        assert_eq!(
            hex::encode(leverage_action(3, false, 10)),
            "84a474797065ae7570646174654c65766572616765a5617373657403a7697343726f7373c2a86c657665726167650a"
        );
    }

    #[test]
    fn large_asset_index_uses_wider_ints() {
        let mut o = btc_ioc();
        o.asset_index = 200;
        let bytes = order_action(&o);
        // "a" then 0xcc 0xc8
        let pos = bytes.windows(3).position(|w| w == [0xa1, 0x61, 0xcc]).unwrap();
        assert_eq!(bytes[pos + 3], 200);
    }

    #[test]
    fn parses_decimals() {
        assert_eq!(parse_e8("65000"), Some(6_500_000_000_000));
        assert_eq!(parse_e8("0.001"), Some(100_000));
        assert_eq!(parse_e8("3.6345"), Some(363_450_000));
        assert_eq!(parse_e8("1.23456789"), Some(123_456_789));
        for bad in ["", ".5", "5.", "1.234567891", "-1", "1e3", "1,5", "0x10", " 1"] {
            assert_eq!(parse_e8(bad), None, "{bad}");
        }
    }
}
