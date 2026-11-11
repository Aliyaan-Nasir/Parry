//! The recovery planner, as in packages/core/src/strategy.ts: one step at a time, sized to reach
//! the target health within what the mandate still allows. The enclave signs only the first
//! step; the next run re-plans from the position that step left.

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Step {
    Repay { usd: f64 },
    AddCollateral { near: f64 },
    Deleverage { near: f64, min_out_usd: f64 },
}

#[derive(Clone, Copy, Debug)]
pub struct Position {
    pub collateral: f64,
    pub debt: f64,
    pub price: f64,
    pub c_ratio: f64,
    pub d_ratio: f64,
}

impl Position {
    pub fn health(&self) -> f64 {
        crate::risk::health(
            self.collateral,
            self.debt,
            self.price,
            self.c_ratio,
            self.d_ratio,
        )
    }
    fn a(&self) -> f64 {
        self.c_ratio * self.d_ratio
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Budgets {
    pub repay_usd: f64,
    pub collateral_near: f64,
    pub deleverage_near: f64,
    pub slippage: f64,
    pub withdraw_floor: f64,
}

fn up(x: f64, dp: i32) -> f64 {
    let f = 10f64.powi(dp);
    (x * f - 1e-9).ceil() / f
}

fn down(x: f64, dp: i32) -> f64 {
    let f = 10f64.powi(dp);
    (x * f + 1e-9).floor() / f
}

/// USDC to repay so health lands on `target`, rounded up to the micro-dollar (so it lands on or
/// just above it), capped by `budget` and the debt. 0 when nothing is needed or allowed.
pub fn repay_usd(p: &Position, target: f64, budget: f64) -> f64 {
    if p.health() >= target {
        return 0.0;
    }
    let need = (p.debt - p.collateral * p.price * p.a() / target).max(0.0);
    up(need, 6).min(down(budget, 6)).min(p.debt).max(0.0)
}

/// wNEAR to add as collateral so health lands on `target`, rounded up to 1e-4 NEAR (the
/// action's granularity), capped by `budget`.
pub fn add_collateral_near(p: &Position, target: f64, budget: f64) -> f64 {
    if p.health() >= target {
        return 0.0;
    }
    let need = (target * p.debt / (p.price * p.a()) - p.collateral).max(0.0);
    up(need, 4).min(down(budget, 4)).max(0.0)
}

/// Why a deleverage cannot be sized.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum DeleverageLimit {
    /// The daily cap leaves no collateral to sell.
    Budget,
    /// Selling any collateral would take health under the lending contract's withdraw floor.
    Floor,
}

/// The collateral to sell (NEAR) and the least USDC it must buy so health lands on `target`
/// even when the swap gives only that least amount, within the withdraw floor (the lending
/// contract lets collateral out only while health stays at or above it) and the budget.
pub fn deleverage(p: &Position, target: f64, b: &Budgets) -> Result<Step, DeleverageLimit> {
    let denom = p.price * (target * (1.0 - b.slippage) - p.a());
    let need = if denom <= 0.0 {
        f64::INFINITY
    } else {
        ((target * p.debt - p.collateral * p.price * p.a()) / denom).max(0.0)
    };
    let max_withdraw = (p.collateral - b.withdraw_floor * p.debt / (p.price * p.a())).max(0.0);
    let budget = down(b.deleverage_near, 4);
    if budget <= 0.0 {
        return Err(DeleverageLimit::Budget);
    }
    let near = up(need.min(1e12), 4).min(down(max_withdraw, 4)).min(budget);
    if near <= 0.0 {
        return Err(DeleverageLimit::Floor);
    }
    Ok(Step::Deleverage {
        near,
        min_out_usd: down(near * p.price * (1.0 - b.slippage), 6),
    })
}

/// A perp position as the venue reports it, for sizing a reduce-only order.
#[derive(Clone, Copy, Debug)]
pub struct Perp {
    /// Absolute size in coins.
    pub size: f64,
    pub long: bool,
    pub mark: f64,
    pub account_value: f64,
    pub liquidation: Option<f64>,
}

/// Health of a perp as the guardian scores it: 1 plus the distance to liquidation.
pub fn perp_health(p: &Perp) -> f64 {
    match p.liquidation {
        None => f64::INFINITY,
        Some(l) if p.long => 1.0 + (1.0 - l / p.mark).max(0.0),
        Some(l) => 1.0 + (1.0 - p.mark / l).max(0.0),
    }
}

/// How much of the perp to close so its liquidation distance gives `target` health.
///
/// The maintenance fraction m is read off the current liquidation price: a long liquidates at
/// L = (P - V/S) / (1 - m) and a short at L = (P + V/S) / (1 + m), with V the account value, S
/// the size and P the mark. Closing at the mark leaves V unchanged, so the size S' whose
/// liquidation price gives the target follows from the same equations. None when the inputs
/// do not determine m (no liquidation price, no account value, or an implausible m); the
/// caller then falls back to the owner's fraction.
pub fn perp_reduce(p: &Perp, target: f64, lot_decimals: i32) -> Option<f64> {
    let l = p.liquidation.filter(|l| *l > 0.0)?;
    if p.size <= 0.0 || p.account_value <= 0.0 || p.mark <= 0.0 {
        return None;
    }
    let per_coin = p.account_value / p.size;
    let keep = if p.long {
        let m = 1.0 - (p.mark - per_coin) / l;
        if !(0.0..0.5).contains(&m) {
            return None;
        }
        // Target liquidation price P (2 - T); solve V / S' = P - (1 - m) P (2 - T).
        let denom = p.mark * (1.0 - (1.0 - m) * (2.0 - target));
        if denom <= 0.0 {
            0.0
        } else {
            p.account_value / denom
        }
    } else {
        let m = (per_coin + p.mark) / l - 1.0;
        if !(0.0..0.5).contains(&m) {
            return None;
        }
        // Target liquidation price P / (2 - T); a target of 2 or more means no liquidation
        // price at all, which a short only reaches by closing.
        if target >= 2.0 {
            0.0
        } else {
            let denom = p.mark * ((1.0 + m) / (2.0 - target) - 1.0);
            if denom <= 0.0 {
                f64::INFINITY
            } else {
                p.account_value / denom
            }
        }
    };
    let reduce = (p.size - keep).clamp(0.0, p.size);
    Some(up(reduce, lot_decimals).min(p.size))
}

/// Rounds `x` down to `dp` decimals (sizes and caps in lots).
pub fn floor_to(x: f64, dp: i32) -> f64 {
    down(x, dp)
}

/// Rounds `x` up to `dp` decimals.
pub fn ceil_to(x: f64, dp: i32) -> f64 {
    up(x, dp)
}

#[cfg(test)]
mod tests {
    use super::*;

    const P: Position = Position {
        collateral: 100.0,
        debt: 150.0,
        price: 2.3,
        c_ratio: 0.75,
        d_ratio: 0.95,
    };

    fn budgets(deleverage_near: f64) -> Budgets {
        Budgets {
            repay_usd: 0.0,
            collateral_near: 0.0,
            deleverage_near,
            slippage: 0.02,
            withdraw_floor: 1.01,
        }
    }

    #[test]
    fn repay_lands_on_the_target() {
        let usd = repay_usd(&P, 1.5, 100.0);
        let after = Position {
            debt: P.debt - usd,
            ..P
        };
        assert!(after.health() >= 1.5 - 1e-9 && after.health() < 1.5 + 1e-5);
        // Capped by the budget.
        assert_eq!(repay_usd(&P, 1.5, 10.0), 10.0);
        assert_eq!(repay_usd(&P, 1.0, 100.0), 0.0);
    }

    #[test]
    fn add_collateral_lands_on_the_target() {
        let near = add_collateral_near(&P, 1.5, 1_000.0);
        let after = Position {
            collateral: P.collateral + near,
            ..P
        };
        assert!(after.health() >= 1.5 - 1e-9 && after.health() < 1.5 + 1e-5);
    }

    #[test]
    fn deleverage_lands_on_the_target_at_its_least_output_within_the_floor() {
        // Health 0.98 is under the floor: nothing can be withdrawn.
        let weak = Position {
            collateral: 90.0,
            ..P
        };
        assert_eq!(
            deleverage(&weak, 1.3, &budgets(50.0)),
            Err(DeleverageLimit::Floor)
        );
        assert_eq!(
            deleverage(&P, 1.3, &budgets(0.0)),
            Err(DeleverageLimit::Budget)
        );
        // Health 1.09: a small step to 1.10 lands on it at the least output.
        let Ok(Step::Deleverage { near, min_out_usd }) = deleverage(&P, 1.1, &budgets(50.0)) else {
            panic!()
        };
        let after = Position {
            collateral: P.collateral - near,
            debt: P.debt - min_out_usd,
            ..P
        };
        assert!((after.health() - 1.1).abs() < 1e-4, "{}", after.health());
        assert!((min_out_usd - near * 2.3 * 0.98).abs() < 1e-5);
        // A step to 1.30 would need more than the lending contract releases: it stops at the
        // withdraw floor.
        let Ok(Step::Deleverage { near, .. }) = deleverage(&P, 1.3, &budgets(50.0)) else {
            panic!()
        };
        let after_withdraw = Position {
            collateral: P.collateral - near,
            ..P
        };
        assert!((after_withdraw.health() - 1.01).abs() < 1e-3);
        assert!(after_withdraw.health() >= 1.01 - 1e-6);
    }

    /// A long of 100 coins at 4.00 with 100 of account value and a 2.5% maintenance fraction:
    /// liquidation at (4 - 1) / 0.975.
    fn long() -> Perp {
        Perp {
            size: 100.0,
            long: true,
            mark: 4.0,
            account_value: 100.0,
            liquidation: Some(3.0 / 0.975),
        }
    }

    #[test]
    fn perp_reduce_lands_on_the_target_health() {
        for (p, target) in [
            (long(), 1.45),
            (
                Perp {
                    long: false,
                    liquidation: Some(5.0 / 1.025),
                    ..long()
                },
                1.3,
            ),
        ] {
            let before = perp_health(&p);
            assert!(before < target, "{before}");
            let reduce = perp_reduce(&p, target, 1).unwrap();
            assert!(reduce > 0.0 && reduce < p.size);
            // The liquidation price of what is left, from the same maintenance fraction.
            let left = p.size - reduce;
            let liq = if p.long {
                (p.mark - p.account_value / left) / 0.975
            } else {
                (p.mark + p.account_value / left) / 1.025
            };
            let after = perp_health(&Perp {
                size: left,
                liquidation: Some(liq),
                ..p
            });
            assert!(after >= target - 1e-9 && after < target + 0.01, "{after}");
        }
    }

    #[test]
    fn perp_reduce_needs_a_liquidation_price_and_value() {
        assert!(perp_reduce(
            &Perp {
                liquidation: None,
                ..long()
            },
            1.45,
            1
        )
        .is_none());
        assert!(perp_reduce(
            &Perp {
                account_value: 0.0,
                ..long()
            },
            1.45,
            1
        )
        .is_none());
        // A healthy position needs nothing.
        assert_eq!(perp_reduce(&long(), 1.0, 1), Some(0.0));
    }
}
