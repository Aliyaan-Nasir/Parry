# Parry's risk model

This is how Parry scores a leveraged position, predicts its liquidation, and decides how worried to be.
The same model runs in two places: the services (`packages/core/src/risk.ts`, TypeScript) and the guardian enclave (`enclave/src/risk.rs`, Rust).
Both are tested against the same hand-checked cases in `packages/core/fixtures/risk-cases.json`, whose expected values were computed independently with an exact error function.

Units: prices in USD, time in hours, volatility per square-root hour unless it says annual.

## 1. Health and the liquidation price

Rhea lending counts collateral at its value times the asset's volatility ratio and debt at its value divided by the debt asset's volatility ratio.
Health is their quotient, and an account can be liquidated below 1:

    H = Σ c_i p_i v_i / Σ d_j p_j / v_j

Split each side into the part that moves with the driver asset (NEAR, wNEAR, LiNEAR) and the part that does not: A(P) = A_s + P a_n for collateral and D(P) = D_s + P d_n for debt.
Holding everything else fixed, health reaches 1 at the driver price

    P_liq = (D_s − A_s) / (a_n − d_n)

for a position that is long the driver (a_n > d_n); a position that is not long the driver has no liquidation price from a fall.
The distance to liquidation is δ = 1 − P_liq / P.

Example (fixture "near liquidation, no trend"): 100 NEAR at $2.20 with ratio 0.75 against 150 USDC with ratio 0.95 gives H = 1.045 and P_liq = $2.1053, 4.3% away.

## 2. The Tremor index

The Tremor index is Parry's volatility measure: realized volatility of log returns over the last 1, 4 and 12 hours,

    σ_W = sqrt( Σ r² / hours(W) )   with r = ln(p_t / p_{t−1}) over the samples in window W

combined with time-decay weights 0.5, 0.3 and 0.2, so the last hour counts most:

    σ = sqrt( Σ w_W σ_W² / Σ w_W )

Windows with fewer than two samples drop out and the weights renormalize.
Without any history the index falls back to 70% annual and says so (`fallback: true`).
Annual volatility is σ × sqrt(8760); the levels are calm below 40%, elevated below 80%, high below 130%, and extreme above.

The monitor samples the oracle price every 10 seconds; the enclave reads Hyperliquid's 5-minute closes, rescaled to the oracle's level, so the volatility is the market's while the level is the one lending uses.

## 3. The trend

The trend m is half the least-squares slope of log price over the last 4 hours, capped at one σ per hour either way.
Halving it and capping it keeps a short burst from dominating a 24-hour forecast.

## 4. Probability of liquidation within T hours

Log price is modelled as a Brownian motion with trend m and volatility σ.
The barrier is d = ln(P / P_liq) below today's log price, and the probability of touching it within T hours is the first-passage formula

    P_hit(T) = Φ((−d − mT) / (σ√T)) + exp(−2md / σ²) · Φ((−d + mT) / (σ√T))

With no trend this is 2Φ(−d / (σ√T)), the reflection principle.
The second term is computed in log space so a strong downward trend cannot overflow.

Time to liquidation is the median first-passage time, the T at which P_hit(T) = 0.5, found by bisection and reported as "more than 30 days" beyond that.
When the trend is downward Parry also reports the trend-only time d / |m|.

Example (fixture "falling trend at 2.40"): health 1.14, σ from 70% annual, trend −0.4% per hour: P_hit(24h) = 20.9%, median time to liquidation 31.1 hours.

## 5. Cascade pressure

Liquidations push the price down, which can liquidate more positions.
Across every monitored position on the same driver, Parry adds up the collateral that a 2σ daily fall (2 σ √24 in log terms) would bring to its liquidation price, and divides it by the reference liquidity of the market:

    C = min(1, collateral liquidated by a 2σ day / reference liquidity)

It also flags an owner whose positions on two or more venues would liquidate in the same 2σ move, because those risks add up rather than diversify.

## 6. Value at risk

The 99% one-day value at risk is the driver exposure times a 2.326σ daily fall, plus a liquidation penalty (5% of debt) when that fall crosses the liquidation price.

## 7. The score and the tiers

    S = round(100 × clamp(0.70 √H + 0.15 V + 0.15 C))

with H = P_hit(24h), V = clamp((σ_annual − 0.3) / 1.2) for market turbulence, and C the cascade pressure.
The square root makes small daily probabilities count: a 1% chance of liquidation within a day adds 7 points, 25% adds 35, 100% adds 70.
Health floors apply whatever the forecast says: below 1.10 the score is at least 50, below 1.03 at least 75.

| Tier | Score |
| --- | --- |
| safe | below 25 |
| caution | 25 to 49 |
| danger | 50 to 74 |
| critical | 75 and above |

The square root is deliberate: weighted linearly, a 21 % chance of liquidation within a day would still score as safe; with the root it scores as danger, and the fixtures pin the result.

## 8. Other venues

- **Hyperliquid perps.** The barrier is Hyperliquid's own liquidation price for the position. A short is liquidated by a rise, so the model works on 1/P, where the same formula applies. Health is shown as 1 + distance to liquidation.
- **Aave on an EVM chain.** Aave reports its own health factor; with one collateral asset, liquidation is a fall to 1/health of today's price. Parry keeps no history for that asset, so the index's default volatility stands in, and the result says so.

## 9. What acts on the score

- The risk engine raises alerts at the person's thresholds (score 50 and health 1.25 by default) and resolves them when the condition clears.
- Protected accounts in caution or worse, or under health 1.5 (the highest trigger health a sealed policy may hold), are queued for the guardian enclave, which decides with the person's sealed thresholds (by default: act at score 60 or health 1.15, aim for health 1.45).
  A position queued only for its health is looked at every 5 minutes rather than every minute.
- The planner (`packages/core/src/strategy.ts`, `enclave/src/plan.rs`) sizes one step at a time. A deleverage can only withdraw collateral while health stays at or above 1 (the lending contract refuses otherwise), so near health 1 each step is small; that is why the guardian acts early.

## 10. Limits of the model

- Lognormal prices understate jumps; the health floors and the Tremor index's weight on the last hour are there to catch them.
- The trend is a weak signal by design (halved and capped).
- Cascade pressure only sees the positions Parry monitors and a configured market depth, not the whole market.
- On testnet, Hyperliquid's NEAR market is a test market whose price differs from the real one; the enclave rescales its candles onto the oracle's level for volatility only.
