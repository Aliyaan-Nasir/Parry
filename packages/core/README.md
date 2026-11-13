# @parryguard/core

Parry's risk model and planning math as plain TypeScript, with no network access.
It computes the health factor, liquidation price, the Tremor volatility index, the probability and time of liquidation, cascade pressure and a 0 to 100 score.
It also holds the recovery planner, the vault's hedge math and the proof-of-reserves Merkle tree.
The Parry services, the SDK and the site all score positions with it, so a number computed here matches the one the guardian sees.

## Install

```bash
npm install @parryguard/core
```

## Quick start

```ts
import { assess } from "@parryguard/core";

// A Rhea position: 200 NEAR at $3.40 against 200 USDC of debt.
const position = {
  collateral: [{ symbol: "NEAR", amount: 200, priceUsd: 3.4, volatilityRatio: 0.6, driver: true }],
  debt: [{ symbol: "USDC", amount: 200, priceUsd: 1, volatilityRatio: 0.95, driver: false }],
};

// Price history as unix seconds and USD.
const now = Math.floor(Date.now() / 1000);
const history = Array.from({ length: 48 }, (_, i) => ({ t: now - (48 - i) * 3600, price: 3.4 + 0.05 * Math.sin(i / 3) }));

const a = assess(position, 3.4, history, now);
console.log(a.health, a.liqPrice, a.probability24h, a.ttl, a.score.score, a.score.tier);
```

The model and its calibration are described in [docs/risk-model.md](https://github.com/Aliyaan-Nasir/Parry/blob/main/docs/risk-model.md).

## What is in it

- `assess`, `assessPerp`, `healthFactor`, `liquidationPrice`, `tremor`, `liquidationProbability`, `timeToLiquidation`, `riskScore`: the risk model.
- `plan`, `STRATEGIES`, `repayNeeded`, `collateralNeeded`, `deleverageNeeded`: the recovery planner the guardian runs inside its enclave.
- `nav`, `sharePrice`, `targetShort`, `rebalance`: the delta-neutral vault's hedge math.
- `reserveRoot`, `reserveProof`, `verifyReserveProof`: the proof-of-reserves Merkle tree the enclave anchors on chain.

## License

MIT
