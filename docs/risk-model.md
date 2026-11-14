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

The index also reads as a regime: calm below 130 % annual, stressed from 130 %, and panic from 215 % (`REGIME_THRESHOLDS`, `tremorRegime`).
The regime is a label for people (the market strip, `/v1/market`): no score, alert or guardian trigger uses it.
The thresholds come from NEAR's own history, chosen out of sample (section 11): every hour from 72 hours before each crash and spike the replay scores to 72 hours after its extreme is set aside (2523 hours), and the thresholds are chosen only on the rest.
There, the crash hours are the falls (peak to trough) of the 12 largest 72-hour falls outside that quarantine (27.6 % to 38.4 %, from November 2020 to October 2025), and the ordinary hours are every hour outside the quarantine and outside 72 hours around those falls (48 359 hours).
Stressed is the 80th percentile of Tremor over the ordinary hours, so one ordinary hour in five reads stressed or worse; panic is the level, on a 5 % grid, that best separates the crash hours from the ordinary hours (the largest share of crash hours flagged minus ordinary hours flagged) among the levels that flag at most 5 % of ordinary hours.
On the hours they were chosen on, panic flags 24.7 % of crash hours and 4.8 % of ordinary ones, and stressed or worse 55 % of crash hours.
Tested on the scored episodes they never saw, panic flags 39.4 % of the six crashes' hours and stressed or worse 72.4 %; panic flags 42.2 % of the six spikes' hours and stressed or worse 73.2 %.
Choosing the thresholds on the scored crashes themselves would have given 135 % and 230 %; `calibration.inSample` keeps those figures for comparison only.
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

## 10. Scope of the model

- Jumps: lognormal prices smooth over sudden moves, so the health floors and the Tremor index's weight on the last hour are built to catch them.
- Trend: a deliberately weak signal (halved and capped), so volatility and crowding drive the score.
- Cascades: cascade pressure covers every Rhea lending borrower the heatmap has swept, with market depth as a configured figure; leverage on other venues is outside its scope.
- Testnet market: on testnet, Hyperliquid's NEAR market is a test market whose price differs from the real one; the enclave rescales its candles onto the oracle's level for volatility only.

## 11. Crash and spike replay

`pnpm replay` (`scripts/replay.ts`, `packages/core/src/replay.ts`) runs this model, the planner and the vault's rules through NEAR's largest historical crashes and rallies and writes `deployments/replay.json`, which `GET /v1/replay` serves.
The candles are Binance's public hourly NEARUSDT klines (`https://data-api.binance.vision/api/v3/klines?symbol=NEARUSDT&interval=1h`) from October 2020, funding is Binance's NEARUSDT perpetual funding history, and the staking yield is LiNEAR's `ft_price` growth over the last 30 days on mainnet (4.48 % a year when it last ran).
The crashes are the six largest falls from an hourly close to the lowest close within the next 72 hours, and the spikes the six largest rises from an hourly close to the highest close within the next 72 hours (`findCrashes`, and `findSpikes`, the same rule on 1 / price); each set without overlap (no two within 144 hours), skipping the first week after listing.
Nothing in the replay is tuned to the episodes it scores: the guardian's settings are the defaults an owner gets, the vault's are the deployed configuration, and the regime thresholds are chosen out of sample (section 2), which they could not affect anyway, since no score uses the regime.

### The borrower through the crashes

Each crash opens a Rhea wNEAR/USDC position at health 1.30 on the peak's close (1000 NEAR, ratios 0.75 and 0.95) and replays it hour by hour to 24 hours after the trough, twice.
Alone, it is liquidated at the first hour whose low takes health under 1.
Protected, the guardian assesses it at each close with the history up to that hour and acts with the default policy: at score 60 or health 1.15, aiming for health 1.45, repay-first with a USDC reserve of 10 % of the debt (its daily cap), at most 4 actions in any 24 hours, swaps at 0.5 % slippage against the planner's 2 % bound.
The warning is the time from the model's first danger score (50, the default alert threshold) to the liquidation without Parry.

| Crash | Drop | Liquidated without Parry | Warning | Guardian steps | Min health with Parry | Vault drawdown (unhedged) | Hedged | Min margin ratio | Funding | Insurance paid |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 21 Dec 2020 to 24 Dec 2020 | 39.8 % | 2020-12-21 10:00 | 7 h | 7 | 1.080 | 2.7 % (39.8 %) | 90 % | 0.495 | $8.47 | $0.00 |
| 21 May 2021 to 23 May 2021 | 45.6 % | 2021-05-21 14:00 | 10 h | 9 | 1.236 | 6.1 % (45.6 %) | 81 % | 0.488 | $4.59 | $0.00 |
| 19 Jan 2022 to 22 Jan 2022 | 39.1 % | 2022-01-21 20:00 | 47 h | 7 | 1.193 | 2.7 % (39.1 %) | 84 % | 0.496 | -$5.29 | $3.83 |
| 9 May 2022 to 12 May 2022 | 51.7 % | 2022-05-11 06:00 | 44 h | 7 | 0.971 (liquidated) | 9.2 % (51.7 %) | 70 % | 0.479 | -$40.26 | $3.23 |
| 31 Jan 2025 to 3 Feb 2025 | 38.6 % | 2025-02-02 18:00 | 33 h | 6 | 1.149 | 2.6 % (38.6 %) | 88 % | 0.497 | -$2.59 | $2.78 |
| 3 Jun 2026 to 6 Jun 2026 | 38.9 % | 2026-06-04 08:00 | 16 h | 6 | 1.240 | 2.7 % (39.4 %) | 90 % | 0.484 | $1.72 | $0.68 |

How well the model warned: it warned before every liquidation, with a median of 24.5 hours and at least 7 hours.
At the first warning its median time to liquidation was, across the crashes, the actual time give or take a factor of two (the median ratio of predicted to actual is 1.0; it ran from 0.67 to 2.1).
The guardian avoided five of the six liquidations.
The sixth, in May 2022, was a single hour in which NEAR fell 32 % (7.87 to a low of 5.30): the position stood at health 1.45 after the guardian's fourth action of the day, and a 32 % fall within the hour takes 1.45 under 1.
The live guardian looks every minute rather than every hour; a one-hour fall that deep is covered by a higher target or a larger daily action budget, both of which the owner sets.

### The vault, by its real rules

The vault opens with 10 000 USD at the start of each episode (the peak of a crash, the low of a spike): LiNEAR staked and a short at leverage 2, sized by the hedge ratio the enclave's report would ask for then, and replays it hour by hour as the deployed vault, enclave and keeper work.

- Hedge ratio: 90 % while shorts were paid over the last 7 days, leaning toward the vault's floor of 70 % as 7-day funding is paid by shorts, all the way at 20 % a year (`hedgeRatioForFunding`, the enclave's `hedge_ratio`).
- Funding: Binance's real NEARUSDT funding, every 8 hours, paid to or by the short.
- Score: once an hour a vault report scored with the enclave's formula and its floors (`vaultRisk`, section 12), with no oracle deviation, LiNEAR rate fall or reserves shortfall, since the replay has none.
- Levers, with the contract's hysteresis (`contracts/vault/src/report.rs`): score 70 pauses deposits until one under 60, score 50 lowers the leverage cap from 3 to 2 until one under 40, and score 85 asks the keeper for margin.
- Rebalance (`rebalance()`, as `contracts/vault/src/order.rs`): whenever the short is off target by 2 % or 1 NEAR, trade it to the target, the hedge ratio of the exposure capped at the leverage cap on the hedge account's value, at 0.05 % in fees.
- Liquidation: Hyperliquid liquidates the short once the account's value falls to its maintenance margin (5 % of notional for NEAR): with account value E, short S and price P, at P' = (E + S P) / (S (1 + 0.05)).
  Each hour the high is checked against the liquidation price left by the last close, so a jump inside the hour counts in full; a short that reaches it is closed there and the hedge account's remaining value is lost (Hyperliquid's backstop case, the worst one).
- The insurance fund, as the contract keeps it (`contracts/vault/src/insurance.rs`): it opens with 10 % of the positive yield (staking and funding) of the 30 days before, then takes 10 % of the staking yield (as LiNEAR) and of each report's funding received (as USDC that stays in the hedge account), and records the funding each report shows paid as owed back.
  The depositors' value leaves the fund out, and what it earmarks for margin.
- The keeper's two payouts from it (`services/src/keeper.ts`), each clamped to what `insurance_pay` allows (at most 1000 USD a payout, the fund's value, and 25 % of the fund's value a day), so the vault does not refuse them:
  - every hour while the last 12 reports show funding paid, the negative funding cover (`fundingCover`): the least of what is owed back, the per-payout cap, the fund and the day's cap left, at least a cent, back to the depositors;
  - while the vault asks for margin, the margin top-up (`marginDecision` with `payableUsd`): the shortfall back to a margin ratio of 0.4, clamped to what the fund may pay now and floored to the cent, nothing under a cent, at most one insurance payout an hour; the fund's USDC is earmarked where it already is, and its LiNEAR is counted as routed into the hedge account within the hour (the owner does that by hand on the live vault).

The live keeper reports every 5 minutes and rebalances every 2, so within an hour it would buy the short back sooner than the replay does: the replay's intra-hour risk is an upper bound.

In the crashes the short gains, so its margin ratio barely moves from the 0.5 it opened at (0.479 to 0.497 at the worst hourly high) and its liquidation price stays 41 % to 43 % above every hourly high.
The drawdown comes from the part left unhedged: where shorts had been paying funding for a week before the crash, the report leans the hedge down, to 81 % before May 2021 and to 70 % before May 2022, and those two crashes cost the vault 6.1 % and 9.2 % instead of about 2.7 %.
The fund covered the funding the short paid in four of the crashes, 0.68 to 3.83 USD each, within its daily cap: in May 2022 it covered 3.23 of the 40.26 USD paid.

### The vault's short through the spikes

| Spike | Rise | Vault liquidated | Min margin ratio | Closest to liquidation | Max score | Deposits paused | Margin asked | Margin topped up (largest shortfall) | Rebalances (buybacks) | Hedged at the end | Share price (unhedged) | Drawdown |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 10 Feb 2021 to 13 Feb 2021 | 67.8 % | no | 0.212 | 15.4 % away | 70 | 2 h | no | n/a | 39 (19) | 27 % | 1.122 (1.498) | 8.5 % |
| 23 Feb 2021 to 25 Feb 2021 | 63.2 % | no | 0.184 | 12.8 % away | 85 | 2 h | 1 h | $16.61 ($749.23) | 58 (30) | 14 % | 1.167 (1.627) | 11.5 % |
| 6 Sep 2021 to 9 Sep 2021 | 92.0 % | no | 0.093 | 4.1 % away | 85 | 8 h | 2 h | $0.00 ($1069.43) | 63 (24) | 9 % | 1.105 (1.555) | 17.7 % |
| 21 Dec 2021 to 24 Dec 2021 | 78.0 % | no | 0.197 | 14.0 % away | 70 | 2 h | no | n/a | 66 (35) | 11 % | 1.246 (1.741) | 6.4 % |
| 18 Dec 2023 to 21 Dec 2023 | 64.4 % | no | 0.191 | 13.4 % away | 70 | 1 h | no | n/a | 56 (31) | 21 % | 1.122 (1.518) | 8.1 % |
| 16 Sep 2026 to 19 Sep 2026 | 65.7 % | no | 0.271 | 21.0 % away | 38 | no | no | n/a | 57 (33) | 22 % | 1.144 (1.546) | 6.2 % |

"Min margin ratio" is the account's value over the short's notional at the worst hourly high, and "closest to liquidation" how far that high stayed under the short's liquidation price.
The short was liquidated in none of the six rallies of 63 % to 92 % in 72 hours.
What kept it alive is the leverage cap: as NEAR rose, the short's losses shrank the hedge account, and each hourly rebalance bought part of the short back to stay within leverage 3, or 2 once the score reached 50.
The score's floors (section 12) now act in a rally: a short whose liquidation price came within 20 % of the mark paused deposits (15 hours in five of the six spikes) and lowered the leverage cap at once, and within 15 % asked for margin (3 hours, in two spikes).
The closest call was 8 September 2021, when one hour's high came within 4.1 % of the liquidation price and the margin ratio fell to 0.093.
The cost is the hedge itself: at the end of the spikes only 9 % to 27 % of the NEAR was still hedged (median 18 %), so the share price followed NEAR part of the way up (ending at 1.12 to 1.25 against 1.50 to 1.74 unhedged) and fell 6 % to 18 % from its high as NEAR came back.

The vault asked for margin in 3 hours, against shortfalls of 561 to 1069 USD back to a ratio of 0.4.
In late February 2021 the keeper paid 16.61 USD, a quarter of the 66 USD fund and all it may pay in a day; in September 2021 it could pay nothing in either hour, because the funding covers earlier the same day (5.97 and 4.67 USD) had already spent the day's cap of a fund of about 20 USD.
The fund, at 10 % of a month's yield, is sized for funding, not for margin: its daily cap is a few to tens of USD against a shortfall of hundreds.
Nothing else refills the hedge account after a rally: the short regrows only as the price falls back, until margin is added by hand.

## 12. The vault's score

The enclave scores the vault in every vault report, and the vault contract acts on the score (section 11):

    S = max( round(0.35 L + 0.25 M + 0.10 F + 0.10 O + 0.05 R + 0.15 V), floor(d) )

each component in percent of "fully risky" and clamped to 0 to 100 %:

- L, the liquidation price: 1 − d / 0.5 for a short, where d = P_liq / P − 1 is how far the liquidation price is above the mark, so full at the mark and nothing 50 % above it.
- M, leverage: notional over account value, over 5.
- F, funding: the hourly rate paid by shorts, over 1 bp.
- O, the oracle: the mark's deviation from the oracle, over 2 %.
- R, the LiNEAR rate: its fall from the rate the vault booked, over 1 %.
- V, reserves: the shortfall of reserves under liabilities, over 5 %.

The weighted sum alone cannot make a short ask for margin: L, M and F, all a short can move, top out at 35 + 25 + 10 = 70, under the contract's margin score of 85, which only oracle, LiNEAR rate or reserves trouble on top could reach.
So the score has floors on the liquidation distance d:

| d | Floor | What the vault does |
| --- | ---: | --- |
| under 15 % | 85 | asks the keeper for margin (and pauses deposits and lowers the leverage cap) |
| under 20 % | 70 | pauses deposits and lowers the leverage cap to 2 |
| 20 % or more | none | the weighted sum alone |

The thresholds come from the margin ratio m (account value over notional): with Hyperliquid's 5 % maintenance margin, d = (m − 0.05) / 1.05.
A distance of 15 % is a margin ratio of about 0.21, just above the keeper's early mark of 0.2 (`MARGIN_EARLY_RATIO`), so the vault asks for margin where the keeper starts watching rather than after it.
A distance of 20 % is a margin ratio of about 0.26: the leverage cap of 3 leaves a ratio of 1/3 (d of 27 %) after each rebalance, so the pause floor is reached only when the price outruns the rebalances, and well before the margin floor.
The floors only raise the score, and both step up as d falls, so the score never falls as the liquidation price comes closer.
In the replay's spikes they paused deposits as the short neared liquidation and asked for margin at the September 2021 and late February 2021 peaks (section 11).

`risk::vault_risk` in the enclave (with `VAULT_MARGIN_DISTANCE` and `VAULT_PAUSE_DISTANCE`) and `vaultRisk` in `packages/core` (`VAULT_SCORE_FLOORS`) compute it, and both pass the hand-checked cases in `packages/core/fixtures/vault-cases.json`, with the funding-aware hedge ratio (`hedge_ratio`, `hedgeRatioForFunding`).
