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

The index also reads as a regime: calm below 135 % annual, stressed from 135 %, and panic from 230 % (`REGIME_THRESHOLDS`, `tremorRegime`).
The thresholds come from NEAR's own history (section 11): stressed is the 80th percentile of Tremor over every ordinary hour (the 72 hours around each of the six worst crashes excluded), so one ordinary hour in five reads stressed or worse; panic is the level, on a 5 % grid, that best separates the hours of a crash's fall from ordinary hours (the largest share of crash hours flagged minus ordinary hours flagged) among the levels that flag at most 5 % of ordinary hours.
On the data, panic flags 35 % of crash hours and 4.8 % of ordinary ones, and stressed or worse flags 70 % of crash hours.
The calibration reads Tremor from hourly closes, where the 1-hour window holds a single return; the live index samples every 10 seconds, so its short windows are steadier, and a live reading is at least as well behaved as the calibration's.
`pnpm replay` recomputes the thresholds and says when they differ from the code's, and a test pins the code's to the committed `deployments/replay.json`.

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

Once the liquidation heatmap has data, the pressure comes from the whole market instead (`cascade.source: "heatmap"`).
The risk service pages every Rhea lending account on mainnet (`contract.main.burrow.near`, read-only view calls) and keeps each borrower's liquidation price on NEAR, the driver of wNEAR and the liquid staking tokens (`packages/core/src/heatmap.ts`).
A cascade starts at the 2σ daily fall, and liquidations are sized the way Rhea lending allows them (`internal_liquidate`): only while health is under 1, and only as far as leaves it under 1, at a discount of d = (weighted debt − weighted collateral) / weighted debt / 2.
So at a price p under an account's liquidation price, the most liquidators can repay is what brings its health back to 1,

    X = (D_w − C_w) / (1 / v_d − v_c / (1 − d)),   with D_w − C_w = exposure × (P_liq − p)

where exposure is the account's risk-weighted NEAR (collateral × ratio minus debt / ratio, in NEAR) and v_c, v_d its value-weighted ratios; they seize X / (1 − d) of collateral and sell the NEAR-linked share of it.
Those sales move the price down 2 % per `CASCADE_DEPTH_2PCT_USD` (1.5 million USD by default, a configured market depth); the lower price deepens those liquidations and may reach more accounts, and the price settles where the sales stop moving it (a fixed point).
Accounts already under health 1 at today's price (bad debt, or collateral nobody liquidates) are counted apart (`underwater`) and left out: a fall does not set them off.
The pressure is the extra fall the liquidations add over the 2σ fall itself, in log terms, capped at 1:

    C = min(1, ln(P_2σ / P_end) / (2 σ √24))

so 1 means the liquidations alone would double the move.
`atRiskUsd` is the collateral of every borrower the chain puts under health 1, and `soldUsd` what their liquidators sell.
`/v1/market` and `/v1/heatmap` compute it with the same function, borrowers, price and volatility.
Example (the test "the realistic case"): one mainnet borrower with 1.21 million wNEAR and 1.97 million USD of ZEC against 4.19 million USD of stablecoins, 7.2 % from liquidation, with NEAR at 3.585 and Tremor at 95 % annual: a 2σ day reaches it, liquidators may sell about 175 000 USD of NEAR, which adds 0.23 % to a 9.9 % fall, and the pressure is 0.024.
The heatmap view lists the chained cascades that start at each bucket's price and reach further buckets.

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
- Cascade pressure sees every Rhea lending borrower once the heatmap has swept them, but not other venues' leverage, and its market depth is a configured figure.
- On testnet, Hyperliquid's NEAR market is a test market whose price differs from the real one; the enclave rescales its candles onto the oracle's level for volatility only.

## 11. Crash replay

`pnpm replay` (`scripts/replay.ts`, `packages/core/src/replay.ts`) runs this model, the planner and the vault's math through NEAR's largest historical crashes and writes `deployments/replay.json`, which `GET /v1/replay` serves.
The candles are Binance's public hourly NEARUSDT klines (`https://data-api.binance.vision/api/v3/klines?symbol=NEARUSDT&interval=1h`) from October 2020, funding is Binance's NEARUSDT perpetual funding history, and the staking yield is LiNEAR's `ft_price` growth over the last 30 days on mainnet (4.46 % a year when it last ran).
The crashes are the six largest falls from an hourly close to the lowest close within the next 72 hours, without overlap, skipping the first week after listing.

Each crash opens a Rhea wNEAR/USDC position at health 1.30 on the peak's close (1000 NEAR, ratios 0.75 and 0.95) and replays it hour by hour to 24 hours after the trough, twice.
Alone, it is liquidated at the first hour whose low takes health under 1.
Protected, the guardian assesses it at each close with the history up to that hour and acts with the default policy: at score 60 or health 1.15, aiming for health 1.45, repay-first with a USDC reserve of 10 % of the debt (its daily cap), at most 4 actions in any 24 hours, swaps at 0.5 % slippage against the planner's 2 % bound.
The warning is the time from the model's first danger score (50, the default alert threshold) to the liquidation without Parry.

| Crash | Drop | Liquidated without Parry | Warning | Guardian steps | Min health with Parry | Vault drawdown (unhedged) | Min margin ratio | Insurance paid |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 21 Dec 2020 to 24 Dec 2020 | 39.8 % | 2020-12-21 10:00 | 7 h | 7 | 1.080 | 2.7 % (39.8 %) | 0.500 | $0.00 |
| 21 May 2021 to 23 May 2021 | 45.6 % | 2021-05-21 14:00 | 10 h | 9 | 1.236 | 3.1 % (45.6 %) | 0.500 | $0.00 |
| 19 Jan 2022 to 22 Jan 2022 | 39.1 % | 2022-01-21 20:00 | 47 h | 7 | 1.193 | 2.7 % (39.1 %) | 0.500 | $5.48 |
| 9 May 2022 to 12 May 2022 | 51.7 % | 2022-05-11 06:00 | 44 h | 7 | 0.971 (liquidated) | 3.8 % (51.7 %) | 0.500 | $5.06 |
| 31 Jan 2025 to 3 Feb 2025 | 38.6 % | 2025-02-02 18:00 | 33 h | 6 | 1.149 | 2.6 % (38.6 %) | 0.500 | $2.93 |
| 3 Jun 2026 to 6 Jun 2026 | 38.9 % | 2026-06-04 08:00 | 16 h | 6 | 1.240 | 2.7 % (39.4 %) | 0.500 | $0.68 |

How well the model warned: it warned before every liquidation, with a median of 24.5 hours and at least 7 hours.
At the first warning its median time to liquidation was, across the crashes, the actual time give or take a factor of two (the median ratio of predicted to actual is 1.0; it ran from 0.67 to 2.1).
The guardian avoided five of the six liquidations.
The sixth, in May 2022, was a single hour in which NEAR fell 32 % (7.87 to a low of 5.30): the position stood at health 1.45 after the guardian's fourth action of the day, and a 32 % fall within the hour takes 1.45 under 1.
The live guardian looks every minute rather than every hour, but four actions a day and a 1.45 target cannot cover a one-hour fall that deep; a higher target or more actions a day would.

The vault opens with 10 000 USD at the peak: LiNEAR staked and a short of 90 % of it at 2x, rebalanced with `rebalance()`, paid or charged the real funding every 8 hours, scored with `assessPerp` (it asks for margin at score 85, as the vault contract does), against the same deposit all staked and unhedged.
Its insurance fund starts at 10 % of the positive yield (staking and funding) of the 30 days before the crash and pays negative funding and margin top-ups within 25 % of the fund a day.
The hedged vault's largest drawdown was 2.6 % to 3.8 % against 38.6 % to 51.7 % unhedged; in a fall the short gains, so the margin ratio never dropped below where it opened, and the fund paid only negative funding.

