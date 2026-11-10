//! Protection flows on the real lending and exchange code: a protected account, its mandate,
//! every guardian power and refusal, the atomic deleverage, and a real liquidation of the same
//! position left unprotected.

mod common;

use anyhow::Result;
use common::*;
use ed25519_dalek::SigningKey;
use near_workspaces::types::NearToken;
use near_workspaces::{Account, AccountId};
use serde_json::{json, Value};

const INNER: u128 = 1_000_000_000_000; // USDC inner units per token unit (6 + 12 decimals)

fn mandate(s: &Stack, key: &SigningKey) -> Value {
    json!({
        "guardian_key": ed25519_key(key),
        "powers": ["repay", "add_collateral", "deleverage", "hl_reduce", "hl_hedge", "evm_repay"],
        "limits": [
            { "token": s.usdc.id(), "reserve": (200 * USDC).to_string(), "daily": (120 * USDC).to_string() },
            { "token": s.wrap.id(), "reserve": (40 * NEAR).to_string(), "daily": (80 * NEAR).to_string() },
        ],
        "max_actions_per_day": 10,
        "min_health_after_bps": 10_500,
        "max_slippage_bps": 300,
        "hl": { "asset": "NEAR", "asset_index": 54, "max_size_e8": (50u128 * 100_000_000).to_string(), "band_bps": 200, "hedge_is_buy": false },
        "evm": {
            "chain_id": 84_532, "pool": "0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27",
            "asset": "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f", "address": "0x2222222222222222222222222222222222222222",
            "max_amount": (100 * USDC).to_string(),
        },
        "sealed": "c2VhbGVk",
        "expires_at": now_secs() + 7 * 86_400,
    })
}

/// A protected account with 100 NEAR collateral and 150 USDC debt at $3.00 (health 1.425), a
/// 60 USDC + 30 wNEAR rescue reserve in the account, and a mandate for `key`.
async fn protected(s: &Stack, name: &str, key: &SigningKey) -> Result<(Account, AccountId)> {
    let owner = s.user(name, 300).await?;
    let acct = s.protected_account(&owner, NEAR / 2).await?;
    owner.transfer_near(&acct, NearToken::from_near(140)).await?.into_result()?;
    s.owner(&owner, &acct, json!([
        { "call": { "receiver_id": s.wrap.id(), "method_name": "near_deposit", "args": "e30=", "deposit": (130 * NEAR).to_string(), "gas": "20000000000000" } },
        { "supply": { "token": s.wrap.id(), "amount": (100 * NEAR).to_string() } },
    ]), 200).await?;
    s.refresh().await?;
    s.owner(
        &owner,
        &acct,
        json!([{ "borrow": { "token": s.usdc.id(), "amount": (150 * USDC).to_string() } }]),
        200,
    )
    .await?;
    call(
        &s.root,
        s.usdc.id(),
        "ft_transfer",
        json!({ "receiver_id": acct, "amount": (60 * USDC).to_string() }),
        1,
        30,
    )
    .await?;
    s.owner(&owner, &acct, json!([{ "set_mandate": { "mandate": mandate(s, key) } }]), 50).await?;
    Ok((owner, acct))
}

/// The same position as a plain NEAR account with no Parry account.
async fn unprotected(s: &Stack, name: &str) -> Result<Account> {
    let u = s.user(name, 300).await?;
    let l = s.lending.id();
    call(
        &u,
        s.wrap.id(),
        "storage_deposit",
        json!({ "account_id": u.id(), "registration_only": true }),
        NEAR / 100,
        30,
    )
    .await?;
    call(
        &u,
        s.usdc.id(),
        "storage_deposit",
        json!({ "account_id": u.id(), "registration_only": true }),
        NEAR / 100,
        30,
    )
    .await?;
    call(&u, l, "storage_deposit", json!({ "account_id": u.id() }), NEAR / 4, 30).await?;
    call(&u, s.wrap.id(), "near_deposit", json!({}), 100 * NEAR, 30).await?;
    call(
        &u,
        s.wrap.id(),
        "ft_transfer_call",
        json!({ "receiver_id": l, "amount": (100 * NEAR).to_string(), "msg": "\"OnlyIncreaseCollateral\"" }),
        1,
        150,
    )
    .await?;
    s.refresh().await?;
    call(
        &u,
        l,
        "execute_with_pyth",
        json!({ "actions": [
            { "Borrow": { "token_id": s.usdc.id(), "amount": (150 * USDC * INNER).to_string() } },
            { "Withdraw": { "token_id": s.usdc.id(), "max_amount": (150 * USDC * INNER).to_string() } },
        ]}),
        1,
        200,
    )
    .await?;
    Ok(u)
}

#[tokio::test]
async fn open_a_protected_leveraged_position() -> Result<()> {
    let s = Stack::new().await?;
    let key = SigningKey::from_bytes(&[1u8; 32]);
    let (_, acct) = protected(&s, "alice", &key).await?;
    assert!(acct.as_str().starts_with("0u"), "{acct}");
    let (c, b) = s.position(&acct).await?;
    assert_eq!(c, 100 * NEAR);
    assert!((150 * USDC * INNER..151 * USDC * INNER).contains(&b), "debt {b}");
    let h = s.health_bps(&acct, 300_000_000).await?;
    assert!((14_000..14_300).contains(&h), "health {h}");
    let m: Value = view(&s.worker, &acct, "mandate", json!({})).await?;
    assert_eq!(m["mandate"]["guardian_key"], ed25519_key(&key));
    Ok(())
}

#[tokio::test]
async fn guardian_repays_and_adds_collateral_within_the_mandate() -> Result<()> {
    let s = Stack::new().await?;
    let key = SigningKey::from_bytes(&[1u8; 32]);
    let (_, acct) = protected(&s, "alice", &key).await?;
    let relayer = s.user("relayer", 20).await?;
    // NEAR falls 20%: health drops to about 1.14.
    s.feed(240_000_000).await?;
    let before = s.health_bps(&acct, 240_000_000).await?;
    assert!(before < 11_500, "{before}");

    let r = ok(s
        .guardian(
            &relayer,
            &key,
            &acct,
            1,
            json!({ "repay": { "token": s.usdc.id(), "amount": (50 * USDC).to_string() } }),
            150,
        )
        .await?)?;
    let acted = r.events("guardian_acted");
    assert_eq!(acted[0]["review_hash"], "7c".repeat(32));
    let (_, b) = s.position(&acct).await?;
    assert!(b < 101 * USDC * INNER, "debt after repay {b}");

    ok(s.guardian(
        &relayer,
        &key,
        &acct,
        2,
        json!({ "add_collateral": { "token": s.wrap.id(), "amount": (20 * NEAR).to_string() } }),
        150,
    )
    .await?)?;
    let (c, _) = s.position(&acct).await?;
    assert_eq!(c, 120 * NEAR);
    let after = s.health_bps(&acct, 240_000_000).await?;
    assert!(after > 20_000, "health after the rescue {after}");
    Ok(())
}

#[tokio::test]
async fn atomic_deleverage_and_its_rollback() -> Result<()> {
    let s = Stack::new().await?;
    let key = SigningKey::from_bytes(&[1u8; 32]);
    let (_, acct) = protected(&s, "alice", &key).await?;
    let relayer = s.user("relayer", 20).await?;
    s.feed(250_000_000).await?;
    s.mark(250_000_000).await?;
    let (c0, b0) = s.position(&acct).await?;

    // Health 1.19 at $2.50. Rhea lets collateral out only while health stays at or above 1, so
    // the planner sizes the withdrawal (12 NEAR here, the most is 15.8). The pool quotes above
    // min_out, which is within 3% of the mark: withdraw, swap, repay, verify.
    s.refresh().await?;
    let r = ok(s
        .guardian(
            &relayer,
            &key,
            &acct,
            1,
            json!({ "deleverage": {
                "collateral": s.wrap.id(), "amount": (12 * NEAR).to_string(), "pool_id": s.pool_id,
                "debt": s.usdc.id(), "min_out": (29_500_000u128).to_string(),
            }}),
            900,
        )
        .await?)?;
    let done = r.events("deleverage_completed");
    assert_eq!(done.len(), 1, "logs: {:#?}", r.logs());
    let (c1, b1) = s.position(&acct).await?;
    assert_eq!(c1, c0 - 12 * NEAR);
    assert!(b1 + 29_500_000 * INNER <= b0, "debt {b0} -> {b1}");
    let health = done[0]["health_bps"].as_str().unwrap().parse::<u128>()?;
    assert!(health > 13_000, "verified health {health}");
    assert!(view::<Value>(&s.worker, &acct, "pending", json!({})).await?.is_null());

    // A minimum the pool cannot meet: the swap fails and the collateral goes back.
    s.refresh().await?;
    let r = ok(s
        .guardian(
            &relayer,
            &key,
            &acct,
            2,
            json!({ "deleverage": {
                "collateral": s.wrap.id(), "amount": (5 * NEAR).to_string(), "pool_id": s.pool_id,
                "debt": s.usdc.id(), "min_out": (90 * USDC).to_string(),
            }}),
            900,
        )
        .await?)?;
    assert_eq!(r.events("deleverage_rolled_back").len(), 1, "logs: {:#?}", r.logs());
    let (c2, b2) = s.position(&acct).await?;
    assert_eq!(c2, c1, "collateral restored");
    assert!(b2 >= b1, "no repay happened");

    // A minimum below the slippage bound is refused before anything moves.
    s.refresh().await?;
    let r = ok(s
        .guardian(
            &relayer,
            &key,
            &acct,
            3,
            json!({ "deleverage": {
                "collateral": s.wrap.id(), "amount": (5 * NEAR).to_string(), "pool_id": s.pool_id,
                "debt": s.usdc.id(), "min_out": (5 * USDC).to_string(),
            }}),
            900,
        )
        .await?)?;
    assert!(r.has_log("slippage bound"));
    assert_eq!(s.position(&acct).await?.0, c2);

    // Too large a withdrawal: the lending contract refuses it and nothing changes.
    s.refresh().await?;
    let r = ok(s
        .guardian(
            &relayer,
            &key,
            &acct,
            4,
            json!({ "deleverage": {
                "collateral": s.wrap.id(), "amount": (60 * NEAR).to_string(), "pool_id": s.pool_id,
                "debt": s.usdc.id(), "min_out": (146 * USDC).to_string(),
            }}),
            900,
        )
        .await?)?;
    assert_eq!(r.events("deleverage_rolled_back").len(), 1);
    assert_eq!(s.position(&acct).await?.0, c2);
    Ok(())
}

#[tokio::test]
async fn guardian_limits_are_enforced_on_chain() -> Result<()> {
    let s = Stack::new().await?;
    let key = SigningKey::from_bytes(&[1u8; 32]);
    let (owner, acct) = protected(&s, "alice", &key).await?;
    let relayer = s.user("relayer", 20).await?;
    let repay =
        |amount: u128| json!({ "repay": { "token": s.usdc.id(), "amount": (amount * USDC).to_string() } });

    // Over the daily cap (120 USDC).
    let e = err(s.guardian(&relayer, &key, &acct, 1, repay(121), 150).await?);
    assert!(e.contains("daily cap"), "{e}");
    // A key that is not the mandate's.
    let e = err(s.guardian(&relayer, &SigningKey::from_bytes(&[9u8; 32]), &acct, 1, repay(1), 150).await?);
    assert!(e.contains("does not verify"), "{e}");
    // A withdraw to another account does not exist as a guardian action.
    let e = err(s
        .guardian(
            &relayer,
            &key,
            &acct,
            1,
            json!({ "withdraw": { "token": s.usdc.id(), "amount": "1", "receiver_id": relayer.id() } }),
            150,
        )
        .await?);
    assert!(e.contains("bad envelope"), "{e}");
    // A replayed nonce.
    ok(s.guardian(&relayer, &key, &acct, 1, repay(1), 150).await?)?;
    let e = err(s.guardian(&relayer, &key, &acct, 1, repay(1), 150).await?);
    assert!(e.contains("nonce already used"), "{e}");
    // The owner revokes: the guardian is done.
    s.owner(&owner, &acct, json!(["revoke_mandate"]), 50).await?;
    let e = err(s.guardian(&relayer, &key, &acct, 2, repay(1), 150).await?);
    assert!(e.contains("no mandate"), "{e}");
    // An expired mandate.
    let mut m = mandate(&s, &key);
    m["expires_at"] = json!(now_secs() + 3);
    s.owner(&owner, &acct, json!([{ "set_mandate": { "mandate": m } }]), 50).await?;
    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
    let e = err(s.guardian(&relayer, &key, &acct, 3, repay(1), 150).await?);
    assert!(e.contains("mandate expired"), "{e}");
    Ok(())
}

#[tokio::test]
async fn unprotected_position_is_liquidated_while_the_protected_one_is_rescued() -> Result<()> {
    let s = Stack::new().await?;
    let key = SigningKey::from_bytes(&[1u8; 32]);
    let (_, alice) = protected(&s, "alice", &key).await?;
    let carol = unprotected(&s, "carol").await?;
    let relayer = s.user("relayer", 20).await?;
    let bob = s.user("bob", 50).await?;
    call(
        &bob,
        s.usdc.id(),
        "storage_deposit",
        json!({ "account_id": bob.id(), "registration_only": true }),
        NEAR / 100,
        30,
    )
    .await?;
    call(
        &bob,
        s.wrap.id(),
        "storage_deposit",
        json!({ "account_id": bob.id(), "registration_only": true }),
        NEAR / 100,
        30,
    )
    .await?;
    call(&bob, s.lending.id(), "storage_deposit", json!({ "account_id": bob.id() }), NEAR / 4, 30).await?;
    call(
        &s.root,
        s.usdc.id(),
        "ft_transfer",
        json!({ "receiver_id": bob.id(), "amount": (500 * USDC).to_string() }),
        1,
        30,
    )
    .await?;
    call(
        &bob,
        s.usdc.id(),
        "ft_transfer_call",
        json!({ "receiver_id": s.lending.id(), "amount": (500 * USDC).to_string(), "msg": "" }),
        1,
        150,
    )
    .await?;

    // NEAR slides 20%: the guardian repays 60 USDC from alice's reserve (her daily cap allows it).
    s.feed(240_000_000).await?;
    ok(s.guardian(
        &relayer,
        &key,
        &alice,
        1,
        json!({ "repay": { "token": s.usdc.id(), "amount": (60 * USDC).to_string() } }),
        150,
    )
    .await?)?;

    // Then a crash to $1.95, through the market shock tool: carol's health falls below 1.
    s.refresh().await?;
    let shocker = s.user("shocker", 5).await?;
    call(&shocker, s.oracle.id(), "shock", json!({ "price_id": NEAR_USD, "bps": -1875 }), 0, 30).await?;
    let p: Value =
        view(&s.worker, s.oracle.id(), "get_price_unsafe", json!({ "price_identifier": NEAR_USD })).await?;
    assert_eq!(p["price"], "195000000");
    assert!(s.health_bps(carol.id(), 195_000_000).await? < 10_000);
    assert!(s.health_bps(&alice, 195_000_000).await? > 10_000);

    // Bob liquidates carol: repays 10 USDC of her debt and takes 5.1 NEAR of her collateral.
    let liquidate = |who: &AccountId| {
        json!({ "actions": [{ "Liquidate": {
            "account_id": who,
            "in_assets": [{ "token_id": s.usdc.id(), "amount": (10 * USDC * INNER).to_string() }],
            "out_assets": [{ "token_id": s.wrap.id(), "amount": (51 * NEAR / 10).to_string() }],
            "position": null, "min_token_amounts": null,
        }}]})
    };
    s.refresh().await?;
    let r = call(&bob, s.lending.id(), "execute_with_pyth", liquidate(carol.id()), 1, 300).await?;
    assert!(r.has_log("liquidate"), "logs: {:#?}", r.logs());
    let (carol_c, _) = s.position(carol.id()).await?;
    assert_eq!(carol_c, 100 * NEAR - 51 * NEAR / 10, "carol lost collateral to the liquidator");

    // The same liquidation against alice fails: her account is healthy.
    s.refresh().await?;
    let r = try_call(&bob, s.lending.id(), "execute_with_pyth", liquidate(&alice), 1, 300).await?;
    assert!(
        r.receipt_failures()
            .iter()
            .any(|f| format!("{f:?}").contains("max_discount") || format!("{f:?}").contains("liquidat"))
            || !r.is_success()
    );
    assert_eq!(s.position(&alice).await?.0, 100 * NEAR, "alice keeps all her collateral");
    Ok(())
}

#[tokio::test]
async fn hyperliquid_and_evm_orders_are_signed_inside_the_guards() -> Result<()> {
    let s = Stack::new().await?;
    let key = SigningKey::from_bytes(&[1u8; 32]);
    let (_, acct) = protected(&s, "alice", &key).await?;
    let relayer = s.user("relayer", 20).await?;
    s.mark(250_000_000).await?;
    let order = |price: &str| json!({ "asset_index": 54, "is_buy": false, "price": price, "size": "12.5", "reduce_only": false, "tif": "Ioc" });

    // Inside the 2% band: signed for the account's Hyperliquid path.
    let r = ok(s
        .guardian(
            &relayer,
            &key,
            &acct,
            1,
            json!({ "hl_hedge": { "order": order("2.48"), "nonce": 1_800_000_000_000u64 } }),
            300,
        )
        .await?)?;
    let signed = r.events("hyperliquid_signed");
    assert_eq!(signed.len(), 1, "logs: {:#?}", r.logs());
    let reqs: Vec<(String, String, String)> = view(&s.worker, s.signer.id(), "requests", json!({})).await?;
    assert_eq!(reqs.last().unwrap().1, "parry-hyperliquid");
    assert_eq!(reqs.last().unwrap().2, signed[0]["digest"].as_str().unwrap());
    let sig: Value = r.json()?;
    assert_signed_by(
        &s.worker,
        s.signer.id(),
        &acct,
        "parry-hyperliquid",
        signed[0]["digest"].as_str().unwrap(),
        &sig,
    )
    .await?;

    // Outside the band: refused, nothing signed.
    let n = reqs.len();
    let r = ok(s
        .guardian(
            &relayer,
            &key,
            &acct,
            2,
            json!({ "hl_hedge": { "order": order("2.40"), "nonce": 1_800_000_000_001u64 } }),
            300,
        )
        .await?)?;
    assert!(r.has_log("outside the band"));
    assert_eq!(view::<Vec<Value>>(&s.worker, s.signer.id(), "requests", json!({})).await?.len(), n);

    // EVM: a repay on behalf of the person's own address, for the guard's pool only.
    let params = json!({ "nonce": 0, "max_priority_fee_per_gas": "1500000000", "max_fee_per_gas": "30000000000", "gas_limit": 250000 });
    let r = ok(s
        .guardian(
            &relayer,
            &key,
            &acct,
            3,
            json!({ "evm_repay": { "params": params, "amount": (25 * USDC).to_string() } }),
            300,
        )
        .await?)?;
    let ev = &r.events("evm_signed")[0];
    let tx = ev["unsigned_tx"].as_str().unwrap();
    assert!(tx.contains("8bab6d1b75f19e9ed9fce8b9bd338844ff79ae27") && tx.contains("573ade81"));
    assert!(tx.contains("2222222222222222222222222222222222222222"));
    let reqs: Vec<(String, String, String)> = view(&s.worker, s.signer.id(), "requests", json!({})).await?;
    assert_eq!(reqs.last().unwrap().1, "parry-evm");
    assert_eq!(reqs.last().unwrap().2, ev["hash"].as_str().unwrap());
    let sig: Value = r.json()?;
    assert_signed_by(&s.worker, s.signer.id(), &acct, "parry-evm", ev["hash"].as_str().unwrap(), &sig)
        .await?;
    Ok(())
}
