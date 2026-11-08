# Working on Parry

Parry keeps leveraged positions from being liquidated, and runs a delta-neutral NEAR vault.
A guardian in an OutLayer TEE watches each protected position, plans a rescue, has a NEAR AI Cloud verifiable model review it, and signs it with a key bound to its build; the person's account contract accepts only protective actions within their on-chain mandate.
This file is for AI agents and engineers working in the repository; the product overview is [README.md](README.md) and the judges' map is [JUDGES.md](JUDGES.md).

## Layout

- `contracts/`: Rust contracts (near-sdk 5.30, one Cargo workspace).
  - `account`: the protected account (global code, one NEP-655 universal account per person): owner by passkey or NEAR account, mandate, guardian actions, the deleverage promise chain, Chain Signatures for Hyperliquid and EVM.
  - `accounts`: the factory that derives and creates universal accounts.
  - `vault`: the delta-neutral vault (LiNEAR staking, Hyperliquid short signed by Chain Signatures, NEP-141 `EARN` shares, withdrawal queue, risk-driven pausing, reserves views).
  - `risk`: the risk board (accepts only enclave-signed reports: scores, marks, vault reports, guardian decisions, the sealing key).
  - `oracle`: the testnet price oracle with the Pyth interface and the market shock.
  - `token`: test USDC with a faucet.
  - `common`: shared types and math (mandate, envelope, Rhea and Pyth wire types, Hyperliquid agent digest, EIP-1559 encoding, fixed-point math).
  - `tests`: sandbox tests on a local node with the real lending, exchange, wNEAR and LiNEAR code.
- `enclave/`: the guardian program for OutLayer (Rust, `wasm32-wasip2`): risk model, planner, AI review, sealed policies, reserves tree, signed outputs.
- `packages/core`: the risk model, planner, hedge math and reserves tree in TypeScript (the enclave's Rust mirrors it; both pass `packages/core/fixtures/risk-cases.json`).
- `packages/sdk` (`@parry/sdk`), `packages/mcp` (`@parry/mcp`), `packages/brand` (design tokens).
- `services/`: monitor, risk engine, guardian relay, keeper, relayer, indexer, alerts, top-up (Bun, one package, `bun services/src/main.ts <name>`).
- `apps/api`: the API (Hono on Bun, contract in `docs/api.md`), `apps/web`: the site and app (Next.js 16).
- `scripts/`: `deploy.ts` (testnet), `enclave.ts` (OutLayer), `sandbox.ts` (local node with the whole stack), `dev.ts` (run everything), `verify.ts` (check every claim).
- `deployments/<network>.json`: deployed accounts, code hashes, transactions and commits.

## Commands

```bash
pnpm install
pnpm test                      # every TypeScript package (database tests need TEST_DATABASE_URL)
pnpm test:contracts            # contract unit tests
contracts/scripts/fetch-fixtures.sh && contracts/scripts/build.sh && pnpm test:sandbox   # sandbox flows
cd enclave && cargo test       # enclave tests
pnpm typecheck && pnpm lint
pnpm security                  # Clippy, cargo audit, cargo deny, pnpm audit
pnpm verify                    # check every README claim against testnet
docker compose up              # the whole stack against testnet (read-only without keys)
pnpm dev                       # the same without Docker (needs Postgres)
bun scripts/sandbox.ts         # a local node with the stack; then `pnpm dev --sandbox`
```

- `contracts/scripts/build.sh --reproducible [commit]` builds in SourceScan's pinned image; only those builds are deployed (local builds carry the builder's paths), and `near contract verify deployed-at <account>` checks them.
- `enclave/build.sh` builds the enclave with the pinned toolchain and prints the sha256 OutLayer binds its keys to.

## Where each NEAR primitive is

| Primitive | Code |
| --- | --- |
| NEP-655 universal accounts, global contracts | `contracts/accounts/src/lib.rs` (`state_init`, `create_account`), `contracts/account/src/lib.rs` (`Upgrade`) |
| Passkey owner (WebAuthn P-256 on chain) | `contracts/account/src/passkey.rs` |
| Guardian that can only protect | `contracts/account/src/guardian.rs` (`guardian_execute`), `contracts/common/src/mandate.rs` (`GuardianAction` has no transfer) |
| Chain Signatures: Hyperliquid orders | `contracts/common/src/hyperliquid.rs` (agent digest), `guardian.rs` (`on_hl_mark` band check), `contracts/vault/src/hedge.rs` |
| Chain Signatures: EVM repay (Aave on Base Sepolia) | `contracts/common/src/evm.rs`, `guardian.rs` (`EvmRepay`), `enclave/src/modes.rs` (`evm_step`), `services/src/lib/evm.ts` |
| MPC foreign-transaction verification | `services/src/lib/evm.ts` (`verify_foreign_transaction`), `services/src/guardian.ts` (`verifyEvm`) |
| OutLayer TEE (keys bound to the build) | `enclave/manifest.json`, `enclave/src/main.rs`, `services/src/lib/enclave.ts` |
| NEAR AI Cloud verifiable review | `enclave/src/ai.rs`, `apps/api/src/verify.ts` |
| Sealed mandates | `enclave/src/seal.rs`, `@parry/sdk` `sealPolicy` |
| Gas keys (parallel lanes) | `services/src/lib/near.ts` (`Sender`), `scripts/deploy.ts` (lanes) |
| NEP-366 relayer | `services/src/relayer.ts` |
| x402 on NEAR | `apps/api/src/x402.ts`, `@parry/sdk` `paidRiskCheck` |
| NEAR Intents 1Click (dry-run quotes) | `services/src/lib/routes.ts` |
| Rhea lending and exchange | `contracts/common/src/rhea.rs`, `guardian.rs` (deleverage chain) |

## Conventions

- One network switch: `PARRY_NETWORK` (services, scripts), `NEXT_PUBLIC_PARRY_NETWORK` (app). Contract ids come from `deployments/<network>.json`; never hardcode one elsewhere.
- Units: wNEAR and LiNEAR 24 decimals, test USDC 6 (Rhea inner units add 12), `EARN` shares 24, prices in reports 1e8, USD values 1e6.
- Every service exposes `/live` and `/health` and records its state in `service_status`.
- Secrets live only in gitignored `.env`, `.env.services` and `.env.sandbox`; every app has a `.env.example`.
- Prose: no em dash; one sentence per line in long Markdown.

## Traps

- Rhea lending lets collateral out only while health stays at or above 1, so a deleverage near 1 is several small steps: the guardian acts early.
- `execute_with_pyth` does not return its inner promise; the account withdraws with `simple_withdraw`, which resolves to true only once the tokens arrived.
- Ref's `withdraw` resolves to the amount, or 0 when the transfer failed and it re-credited the deposit.
- OutLayer derives the enclave keys from the build and the calling account: every service calls it from `enclave.parry.testnet`.
- Publishing the account code as global code burns about 36 NEAR; `scripts/deploy.ts` never republishes the same hash.
- Contract refusals in callbacks are `guardian_refused` events, not failed transactions: read the receipts' logs.
- The testnet MPC network verifies Base, not Ethereum, transactions, so the EVM rescue runs on Base Sepolia (84532); `scripts/evm-position.ts` opens a loan there from an account's derived address.
