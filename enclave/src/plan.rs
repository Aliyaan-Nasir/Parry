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

/// The first step of `strategy` ("repay-first", "keep-exposure" or "deleverage-only") toward
/// `target`, or None when the position is already there or nothing is allowed.
pub fn first_step(strategy: &str, p: &Position, target: f64, b: &Budgets) -> Option<Step> {
    if p.health() >= target {
        return None;
    }
    let order: &[&str] = match strategy {
        "keep-exposure" => &["add", "repay", "delev"],
        "deleverage-only" => &["delev"],
        _ => &["repay", "add", "delev"],
    };
    for kind in order {
        match *kind {
            "repay" => {
                let need = (p.debt - p.collateral * p.price * p.a() / target).max(0.0);
                let usd = up(need, 6).min(down(b.repay_usd, 6)).min(p.debt);
                if usd > 0.0 {
                    return Some(Step::Repay { usd });
                }
            }
            "add" => {
                let need = (target * p.debt / (p.price * p.a()) - p.collateral).max(0.0);
                let near = up(need, 4).min(down(b.collateral_near, 4));
                if near > 0.0 {
                    return Some(Step::AddCollateral { near });
                }
            }
            _ => {
                let denom = p.price * (target * (1.0 - b.slippage) - p.a());
                let need = if denom <= 0.0 {
                    f64::INFINITY
                } else {
                    ((target * p.debt - p.collateral * p.price * p.a()) / denom).max(0.0)
                };
                let max_withdraw =
                    (p.collateral - b.withdraw_floor * p.debt / (p.price * p.a())).max(0.0);
                let near = up(need.min(1e12), 4)
                    .min(down(max_withdraw, 4))
                    .min(down(b.deleverage_near, 4));
                if near > 0.0 {
                    return Some(Step::Deleverage {
                        near,
                        min_out_usd: down(near * p.price * (1.0 - b.slippage), 6),
                    });
                }
            }
        }
    }
    None
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

    #[test]
    fn repay_first_uses_the_reserve() {
        let b = Budgets {
            repay_usd: 100.0,
            collateral_near: 0.0,
            deleverage_near: 50.0,
            slippage: 0.02,
            withdraw_floor: 1.01,
        };
        let Some(Step::Repay { usd }) = first_step("repay-first", &P, 1.5, &b) else {
            panic!()
        };
        let after = Position {
            debt: P.debt - usd,
            ..P
        };
        assert!(after.health() >= 1.5 - 1e-9);
    }

    #[test]
    fn falls_through_to_deleverage_and_respects_the_withdraw_floor() {
        let b = Budgets {
            repay_usd: 0.0,
            collateral_near: 0.0,
            deleverage_near: 50.0,
            slippage: 0.02,
            withdraw_floor: 1.01,
        };
        let Some(Step::Deleverage { near, min_out_usd }) = first_step("repay-first", &P, 1.3, &b)
        else {
            panic!()
        };
        let after_withdraw = Position {
            collateral: P.collateral - near,
            ..P
        };
        assert!(after_withdraw.health() >= 1.01 - 1e-6);
        assert!((min_out_usd - near * 2.3 * 0.98).abs() < 1e-5);
    }

    #[test]
    fn nothing_to_do_when_healthy() {
        let b = Budgets {
            repay_usd: 100.0,
            collateral_near: 10.0,
            deleverage_near: 10.0,
            slippage: 0.02,
            withdraw_floor: 1.01,
        };
        assert!(first_step("repay-first", &P, 1.0, &b).is_none());
    }
}
