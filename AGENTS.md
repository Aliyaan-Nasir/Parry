# Working on Parry

Parry keeps leveraged positions from being liquidated, and runs a delta-neutral NEAR vault.
A guardian in an OutLayer TEE acts only within each person's on-chain mandate, after a verifiable NEAR AI review.

## Layout

- `contracts/`: Rust contracts (near-sdk 5, one Cargo workspace).
- `apps/web`: the Next.js site and app. `apps/api`: the API.
- `services/`: monitor, risk, guardian, keeper, relayer, indexer, alerts, topup.
- `packages/`: `core` (risk and hedge math), `sdk`, `mcp`, `brand` (design tokens).
- `enclave/`: the guardian program that runs in OutLayer's TEE.

## Commands

```bash
pnpm install
pnpm test
pnpm test:contracts
```
