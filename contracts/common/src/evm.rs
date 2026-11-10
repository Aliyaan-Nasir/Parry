//! EVM transactions built on chain for Chain Signatures: RLP encoding of an EIP-1559 transaction
//! and the ABI calldata of the two calls a guardian may make on a lending pool (ERC-20 `approve`
//! of the pool, and Aave v3 `repay` on behalf of the person's own address).
//!
//! The contract builds the unsigned transaction itself, so the MPC network signs only what the
//! guard allowed; the service that broadcasts it adds the signature (y parity, r, s) off chain.

use near_sdk::{env, near, require};

/// `approve(address,uint256)`.
pub const SELECTOR_APPROVE: [u8; 4] = [0x09, 0x5e, 0xa7, 0xb3];
/// Aave v3 `repay(address,uint256,uint256,address)`.
pub const SELECTOR_REPAY: [u8; 4] = [0x57, 0x3a, 0xde, 0x81];
/// Aave's variable interest rate mode.
pub const VARIABLE_RATE: u128 = 2;

/// Fee and nonce fields of an EIP-1559 transaction, chosen by the broadcaster.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EvmTxParams {
    pub nonce: u64,
    /// Decimal strings in wei.
    pub max_priority_fee_per_gas: String,
    pub max_fee_per_gas: String,
    pub gas_limit: u64,
}

fn rlp_bytes(out: &mut Vec<u8>, b: &[u8]) {
    if b.len() == 1 && b[0] < 0x80 {
        out.push(b[0]);
    } else if b.len() <= 55 {
        out.push(0x80 + b.len() as u8);
        out.extend_from_slice(b);
    } else {
        let len = trim(&(b.len() as u64).to_be_bytes());
        out.push(0xb7 + len.len() as u8);
        out.extend_from_slice(&len);
        out.extend_from_slice(b);
    }
}

fn rlp_list(out: &mut Vec<u8>, payload: &[u8]) {
    if payload.len() <= 55 {
        out.push(0xc0 + payload.len() as u8);
    } else {
        let len = trim(&(payload.len() as u64).to_be_bytes());
        out.push(0xf7 + len.len() as u8);
        out.extend_from_slice(&len);
    }
    out.extend_from_slice(payload);
}

/// Big-endian bytes without leading zeros (zero is the empty string).
fn trim(b: &[u8]) -> Vec<u8> {
    let first = b.iter().position(|x| *x != 0).unwrap_or(b.len());
    b[first..].to_vec()
}

fn rlp_uint(out: &mut Vec<u8>, v: u128) {
    rlp_bytes(out, &trim(&v.to_be_bytes()));
}

fn parse_wei(s: &str) -> u128 {
    if s.is_empty() || s.len() > 39 || !s.bytes().all(|c| c.is_ascii_digit()) {
        env::panic_str("fee must be a decimal wei amount");
    }
    s.parse().unwrap_or_else(|_| env::panic_str("fee out of range"))
}

/// Most gas a guardian transaction may reserve: an approve or a repay uses a few hundred
/// thousand.
pub const MAX_GUARDIAN_GAS_LIMIT: u64 = 600_000;
/// Largest priority fee per gas a guardian transaction may offer (20 gwei). The priority fee
/// goes to the block producer, so without a bound a signed transaction could hand the person's
/// gas balance to whoever builds the block.
pub const MAX_GUARDIAN_PRIORITY_FEE_WEI: u128 = 20_000_000_000;

/// Refuses fee fields a guardian may not choose: a priority fee above the cap or above the max
/// fee, or a gas limit outside 1 to `MAX_GUARDIAN_GAS_LIMIT`.
pub fn assert_guardian_fees(params: &EvmTxParams) {
    let tip = parse_wei(&params.max_priority_fee_per_gas);
    require!(tip <= parse_wei(&params.max_fee_per_gas), "priority fee above the max fee");
    require!(tip <= MAX_GUARDIAN_PRIORITY_FEE_WEI, "priority fee above the guardian's 20 gwei cap");
    require!(
        params.gas_limit > 0 && params.gas_limit <= MAX_GUARDIAN_GAS_LIMIT,
        "gas limit outside the guardian's 1 to 600000"
    );
}

/// The unsigned EIP-1559 transaction: 0x02 || rlp([chainId, nonce, maxPriorityFee, maxFee, gas,
/// to, value, data, accessList]).
pub fn eip1559_unsigned(
    chain_id: u64,
    params: &EvmTxParams,
    to: &[u8; 20],
    value: u128,
    data: &[u8],
) -> Vec<u8> {
    let mut payload = Vec::with_capacity(96 + data.len());
    rlp_uint(&mut payload, chain_id as u128);
    rlp_uint(&mut payload, params.nonce as u128);
    rlp_uint(&mut payload, parse_wei(&params.max_priority_fee_per_gas));
    rlp_uint(&mut payload, parse_wei(&params.max_fee_per_gas));
    rlp_uint(&mut payload, params.gas_limit as u128);
    rlp_bytes(&mut payload, to);
    rlp_uint(&mut payload, value);
    rlp_bytes(&mut payload, data);
    rlp_list(&mut payload, &[]);
    let mut tx = vec![0x02];
    rlp_list(&mut tx, &payload);
    tx
}

/// keccak256 of the unsigned transaction: the hash Chain Signatures signs.
pub fn signing_hash(unsigned: &[u8]) -> [u8; 32] {
    env::keccak256_array(unsigned)
}

fn word_address(a: &[u8; 20]) -> [u8; 32] {
    let mut w = [0u8; 32];
    w[12..].copy_from_slice(a);
    w
}

fn word_uint(v: u128) -> [u8; 32] {
    let mut w = [0u8; 32];
    w[16..].copy_from_slice(&v.to_be_bytes());
    w
}

/// ABI calldata of `approve(spender, amount)`.
pub fn approve_calldata(spender: &[u8; 20], amount: u128) -> Vec<u8> {
    let mut d = SELECTOR_APPROVE.to_vec();
    d.extend_from_slice(&word_address(spender));
    d.extend_from_slice(&word_uint(amount));
    d
}

/// ABI calldata of Aave v3 `repay(asset, amount, VARIABLE_RATE, on_behalf_of)`.
pub fn repay_calldata(asset: &[u8; 20], amount: u128, on_behalf_of: &[u8; 20]) -> Vec<u8> {
    let mut d = SELECTOR_REPAY.to_vec();
    d.extend_from_slice(&word_address(asset));
    d.extend_from_slice(&word_uint(amount));
    d.extend_from_slice(&word_uint(VARIABLE_RATE));
    d.extend_from_slice(&word_address(on_behalf_of));
    d
}

/// Parses a 0x-prefixed 20-byte hex address (any case).
pub fn parse_address(s: &str) -> Option<[u8; 20]> {
    let h = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X"))?;
    let b = hex::decode(h).ok()?;
    b.try_into().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selectors_are_the_keccak_of_their_signatures() {
        assert_eq!(&env::keccak256_array(b"approve(address,uint256)")[..4], &SELECTOR_APPROVE);
        assert_eq!(&env::keccak256_array(b"repay(address,uint256,uint256,address)")[..4], &SELECTOR_REPAY);
    }

    #[test]
    fn rlp_basics() {
        let mut o = vec![];
        rlp_uint(&mut o, 0);
        assert_eq!(o, vec![0x80]);
        let mut o = vec![];
        rlp_uint(&mut o, 0x7f);
        assert_eq!(o, vec![0x7f]);
        let mut o = vec![];
        rlp_uint(&mut o, 0x80);
        assert_eq!(o, vec![0x81, 0x80]);
        let mut o = vec![];
        rlp_uint(&mut o, 1024);
        assert_eq!(o, vec![0x82, 0x04, 0x00]);
        let mut o = vec![];
        rlp_bytes(&mut o, &[0u8; 56]);
        assert_eq!(&o[..2], &[0xb8, 56]);
    }

    /// A Base Sepolia approve: the type byte, the list header and the chain id encoding.
    #[test]
    fn unsigned_tx_shape() {
        let params = EvmTxParams {
            nonce: 7,
            max_priority_fee_per_gas: "1000000000".into(),
            max_fee_per_gas: "100000000000".into(),
            gas_limit: 200_000,
        };
        let to = parse_address("0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27").unwrap();
        let data = approve_calldata(&to, 5_000_000);
        let tx = eip1559_unsigned(84_532, &params, &to, 0, &data);
        assert_eq!(tx[0], 0x02);
        // list header 0xf8 + one length byte (payload between 56 and 255 bytes)
        assert_eq!(tx[1], 0xf8);
        assert_eq!(tx.len(), 3 + tx[2] as usize);
        // chain id 84532 = 0x014a34
        assert_eq!(&tx[3..7], &[0x83, 0x01, 0x4a, 0x34]);
        assert_eq!(data.len(), 4 + 64);
        assert_eq!(repay_calldata(&to, 1, &to).len(), 4 + 128);
    }

    #[test]
    fn parses_addresses() {
        assert!(parse_address("0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27").is_some());
        assert!(parse_address("8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27").is_none());
        assert!(parse_address("0x1234").is_none());
    }
}
