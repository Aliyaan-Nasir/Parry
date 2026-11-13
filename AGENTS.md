# Parry for AI agents

Parry keeps leveraged positions from being liquidated, and runs a delta-neutral NEAR vault.
A guardian in an OutLayer TEE watches each protected position, plans a rescue, has a NEAR AI Cloud verifiable model review it, and signs it with a key bound to its build.
The person's account contract accepts only protective actions inside their on-chain mandate, and records the hash of the review that approved each one.

Parry is live on NEAR testnet and mainnet-ready: one setting switches every part to mainnet ([MAINNET.md](MAINNET.md)).
This file is the map for agents and engineers working in or evaluating the repository.

## Start here

| To learn | Read |
| --- | --- |
| What Parry does and how to try it | [README.md](README.md) |
| Each judging criterion with its evidence and links to the exact code | [JUDGES.md](JUDGES.md) |
| The trust model and every review finding | [SECURITY.md](SECURITY.md) |
| The mainnet plan, its rehearsal and its costs | [MAINNET.md](MAINNET.md) |
| The HTTP API, every route and shape | [docs/api.md](docs/api.md) |
| The risk model, every formula and threshold | [docs/risk-model.md](docs/risk-model.md) |
| Using Parry from an agent (MCP, SDK, extending it) | [skills/parry/SKILL.md](skills/parry/SKILL.md), [packages/mcp/README.md](packages/mcp/README.md), [packages/sdk/README.md](packages/sdk/README.md) |
| Working on the site and app | [apps/web/AGENTS.md](apps/web/AGENTS.md) |

Live endpoints: the app at https://parry.market/app, the API at https://api.parry.market (status at `/v1/status`), MCP over Streamable HTTP at https://api.parry.market/mcp, and https://parry.market/llms.txt.

## How the parts fit

```text
monitor ──► risk engine ──► guardian relay ──► OutLayer TEE (enclave/)
 reads Rhea,   scores health,   queues accounts     opens the sealed policy, plans one step,
 Hyperliquid,  liquidation      at caution or       has NEAR AI Cloud review it, signs an envelope
 Aave          price, 0-100     under health 1.5            │
                                                            ▼
                         account contract (contracts/account) checks key, nonce, age,
                         powers and caps, acts, and emits the review's hash; the risk
                         board (contracts/risk) records the decision for anyone to verify
```

The services can delay a rescue but never redirect funds: the account contract enforces the mandate whatever any service or model says, and no guardian action has a recipient.

## Repository map

| Path | What it is | Start with |
| --- | --- | --- |
| `contracts/account` | The protected account: global code, one NEP-655 universal account per person, owned by a passkey or a NEAR account; mandate, guardian actions, the atomic deleverage chain, Chain Signatures for Hyperliquid and EVM, the owner's exits | `src/guardian.rs` (`guardian_execute`), `src/close.rs`, `src/passkey.rs` |
| `contracts/accounts` | The factory that derives and creates universal accounts | `src/lib.rs` (`create_account`, `state_init_of`) |
| `contracts/vault` | The delta-neutral vault: LiNEAR staking, a Hyperliquid short signed by Chain Signatures, NEP-141 `EARN` shares, the withdrawal queue, risk-driven pausing, reserves views, the insurance fund | `src/lib.rs` (money model), `src/hedge.rs`, `src/insurance.rs` |
| `contracts/risk` | The risk board: accepts only enclave-signed reports (scores, marks, vault reports, decisions, certificate anchors, the sealing key) | `src/lib.rs` (`submit`) |
| `contracts/oracle`, `contracts/token` | The testnet price oracle with the Pyth interface and the market shock; test USDC with a faucet | |
| `contracts/common` | Shared types and math: mandate, envelope, Rhea and Pyth wire types, the Hyperliquid agent digest, EIP-1559 encoding, fixed point | `src/mandate.rs` (`GuardianAction`) |
| `contracts/tests` | Sandbox flows on a local node with Rhea lending's exact mainnet wasm, the exchange, wNEAR and LiNEAR, plus a mainnet rehearsal | `tests/protect.rs`, `tests/mainnet.rs` |
| `enclave/` | The guardian program for OutLayer (Rust, `wasm32-wasip2`): risk model, planner, AI review, sealed policies, health certificates, reserves tree, signed outputs | `src/modes.rs`, `src/plan.rs`, `src/ai.rs`, `src/seal.rs` |
| `packages/core` | The risk model (with the Tremor regime), planner, hedge math, reserves tree, liquidation heatmap and crash replay in TypeScript; the enclave mirrors the model and both pass one fixture file | `src/risk.ts`, `fixtures/risk-cases.json` |
| `packages/sdk`, `packages/mcp`, `packages/brand` | `@parryguard/sdk`, `@parryguard/mcp` and the design tokens | each package's README |
| `services/` | Monitor, risk engine, guardian relay, keeper, relayer, indexer, alerts, top-up and the Agent Market worker (Bun, one package: `bun services/src/main.ts <name>`) | `src/guardian.ts`, `src/lib/near.ts` |
| `apps/api` | The API (Hono on Bun) with MCP at `/mcp`, x402 paid checks and the event stream | `src/app.ts`, `src/routes.ts`, `src/verify.ts` |
| `apps/web` | The site and app (Next.js 16) with the risk instrument | `components/instrument/`, `app/system.css` |
| `scripts/` | `deploy.ts` (testnet, or a guarded mainnet plan and deploy), `enclave.ts` (OutLayer), `sandbox.ts` (a local node with the whole stack), `dev.ts`, `scenarios.ts` (the test matrix end to end, with recorded proofs), `evm-position.ts`, `verify.ts`, `replay.ts`, `readme.ts`, `security.ts` | |
| `deployments/` | Deployed accounts, code hashes, transactions and commits per network, the scenario proofs, the crash replay | `testnet.json`, `testnet-proofs.json`, `mainnet.json` |
| `skills/parry/SKILL.md` | The agent skill | |

## Commands

```bash
pnpm install
pnpm test                      # every TypeScript package (database tests need TEST_DATABASE_URL)
pnpm test:contracts            # contract unit tests
contracts/scripts/fetch-fixtures.sh && contracts/scripts/build.sh && pnpm test:sandbox   # sandbox flows
cd enclave && cargo test       # enclave tests
pnpm typecheck && pnpm lint
pnpm security                  # Clippy, cargo audit, cargo deny, pnpm audit
pnpm verify                    # check the README's claims against the live deployment
docker compose up              # the whole stack against testnet (read-only without keys)
pnpm dev                       # the same without Docker (needs Postgres)
bun scripts/sandbox.ts         # a local node with the stack; then `pnpm dev --sandbox`
bun scripts/scenarios.ts       # the scenarios end to end (`--only 8,14`, `--sandbox` for the local node)
pnpm replay                    # recompute deployments/replay.json from the crash candles (`--print` shows it)
bun scripts/deploy.ts --network mainnet   # the mainnet plan and its cost; sends nothing
```

- `contracts/scripts/build.sh --reproducible [commit]` builds in SourceScan's pinned image; only those builds are deployed, and `near contract verify deployed-at <account>` checks them.
- `enclave/build.sh` builds the enclave with the pinned toolchain and prints the sha256 OutLayer binds its keys to.

## Where each NEAR primitive is

| Primitive | Code |
| --- | --- |
| NEP-655 universal accounts, global contracts | `contracts/accounts/src/lib.rs` (`state_init`, `create_account`), `contracts/account/src/lib.rs` (`Upgrade`) |
| Passkey owner (WebAuthn P-256 on chain) | `contracts/account/src/passkey.rs` |
| Guardian that can only protect | `contracts/account/src/guardian.rs` (`guardian_execute`), `contracts/common/src/mandate.rs` (`GuardianAction` has no transfer) |
| Chain Signatures: Hyperliquid orders and margin | `contracts/common/src/hyperliquid.rs` (agent digest; `usd_class_transfer_digest` for the Spot-to-Perps margin move of the vault and of a protected account's owner, `hl_margin_to_perp`), `guardian.rs` (`on_hl_mark` band check), `contracts/vault/src/hedge.rs`, `services/src/keeper.ts` (`marginSweep`) |
| Chain Signatures: EVM repay (Aave on Base) | `contracts/common/src/evm.rs`, `guardian.rs` (`EvmRepay`), `enclave/src/modes.rs` (`evm_step`), `services/src/lib/evm.ts` |
| MPC foreign-transaction verification | `services/src/lib/evm.ts` (`verify_foreign_transaction`), `services/src/guardian.ts` (`verifyEvm`) |
| OutLayer TEE (keys bound to the build) | `enclave/manifest.json`, `enclave/src/main.rs`, `services/src/lib/enclave.ts` |
| NEAR AI Cloud verifiable review | `enclave/src/ai.rs` (signature over the exact exchange), `apps/api/src/verify.ts` (`modelAttestation`: TDX and GPU attestation with NEAR AI's inference SDK) |
| Sealed mandates (thresholds, strategy, step order) | `enclave/src/seal.rs`, `@parryguard/sdk` `sealPolicy` |
| Private health certificates | `enclave/src/modes.rs` (`certificate`), `contracts/risk/src/lib.rs` (`certificate`), `@parryguard/sdk` `verifyCertificate` |
| Gas keys (NEP-611, parallel lanes) | `services/src/lib/near.ts` (`Sender`, `tendGasKey`), `scripts/deploy.ts` (lanes) |
| Post-quantum keys (ML-DSA-65) | `scripts/deploy.ts` (the treasury's signing key), `apps/api/src/app.ts` (`postQuantum`) |
| NEP-366 relayer | `services/src/relayer.ts` |
| x402 on NEAR | `apps/api/src/x402.ts`, `@parryguard/sdk` `paidRiskCheck` |
| NEAR Intents 1Click (dry-run quotes) | `services/src/lib/routes.ts` (`quoteRescue`, `marginQuote` for the vault's Hyperliquid margin) |
| NEAR Intents Agent API (mainnet) | `services/src/lib/intents.ts`: a confidential rescue reserve whose owner-signed policy only swaps and pays back into the protected account |
| NEAR Agent Market (market.near.ai) | `services/src/market.ts` (answers hires with risk reports) |
| Rhea lending and exchange | `contracts/common/src/rhea.rs`, `guardian.rs` (deleverage chain) |

## Working in the repository

- One network switch: `PARRY_NETWORK` (services, scripts, enclave build) and `NEXT_PUBLIC_PARRY_NETWORK` (app). Contract ids come from `deployments/<network>.json`; never hardcode one elsewhere.
- Units: wNEAR and LiNEAR 24 decimals, test USDC 6 (Rhea inner units add 12), `EARN` shares 24, prices in reports 1e8, USD values 1e6.
- Every service exposes `/live` and `/health` and records its state in `service_status`.
- Secrets live only in gitignored `.env`, `.env.services` and `.env.sandbox`, and key files in the gitignored `.keys/`; every app has a `.env.example`.
- Deploy only reproducible builds (`contracts/scripts/build.sh --reproducible`), never local ones.
- Adding a guardian action touches, in order: `contracts/common/src/mandate.rs`, `contracts/account/src/guardian.rs`, its unit and sandbox tests, the planner step in `enclave/src/modes.rs`, `services/src/guardian.ts`, then the SDK types and `docs/api.md` (details in the skill).
- Before handing work back, run `pnpm test`, `pnpm test:contracts`, `cd enclave && cargo test`, `pnpm typecheck`, `pnpm lint` and `pnpm security`.
- Prose: no em dash; one sentence per line in long Markdown. The README's tables between `<!-- name:start -->` markers are generated by `bun scripts/readme.ts`; edit the data, not the table.
- The public site never loads the SDK, Framer Motion or Lenis up front (it reads plain JSON through `apps/web/lib/live.ts`): keep it that way, or mobile Lighthouse drops.

## Things worth knowing

- Rhea lending lets collateral out only while health stays at or above 1, so a deleverage near 1 is several small steps: the guardian acts early.
- `execute_with_pyth` does not return its inner promise; the account withdraws with `simple_withdraw`, which resolves to true only once the tokens arrived.
- Ref's `withdraw` resolves to the amount, or 0 when the transfer failed and it re-credited the deposit.
- OutLayer derives the enclave keys from the build and the calling account: every service calls it from the deployment's `enclave` account.
- Publishing the account code as global code burns about 36 NEAR; `scripts/deploy.ts` never republishes the same hash.
- The account refuses an envelope relayed with less gas than its whole chain needs: a deleverage takes at least 650 + 30 per priced token Tgas (the guardian sends 900), a perp order 140, `retry_deleverage` 260 + 30 per token.
  Owner exits too: `close_rhea` 750 + 30 per protocol token (send 900), `retry_close` 360, `unwind` 160 + 130 per protocol token + 25 per listed token; a call may carry up to 1 PGas, and `ownerCallAction` and the relayer size each call.
- A close round sells at most what keeps health at 1.02 (the lending contract's floor), so a position under about 1.5 health closes over several `close_rhea` calls (`closeRheaRounds` drives them).
- A deleverage's minimum output is raised to the fresh oracle floor when the price moved after planning (a `deleverage_floor_raised` event), so the swap never pays less than the owner's bound and the rescue goes ahead.
- The factory's birth code is fixed once accounts exist (the address commits to it): a new account runs it until its owner sends `upgrade { code_hash }` with the published hash in `deployments/<network>.json`.
  The API serves that hash as `accountCode` in `/v1/config`, and the app offers the owner the move (`AccountUpdate`).
- `scripts/deploy.ts --only risk,vault,account` upgrades just those (a reproducible build at a later commit has other hashes for every crate), and runs `migrate()` in the same batch as the new risk board and vault code.
- Contract refusals in callbacks are `guardian_refused` events, not failed transactions: read the receipts' logs.
- The MPC network verifies Base transactions, so the EVM rescue runs on Base Sepolia (84532) on testnet and Base on mainnet; `scripts/evm-position.ts` opens a loan there from an account's derived address.
- USDC sent to the vault's Hyperliquid address can land in its Spot balance, which the short cannot use: the keeper's margin sweep has the vault sign a Spot-to-Perps `usdClassTransfer` and submits it.
  A protected account's owner does the same with the `hl_margin_to_perp` owner action (the app's Hyperliquid card on the dashboard).
- An account's Hyperliquid signature does nothing until it is sent to Hyperliquid's `/exchange` with the action it signed (`hyperliquidBody` and `submitHyperliquid` in the SDK); the app sends close orders and margin moves from the browser, and the passkey relay returns the signature as `value`.
- Vault withdrawals pay out in LiNEAR: send `linearStorageAction` before `request_withdraw` or `claim` (the app does), or the payout waits as a claim.
- The default RPC list is FastNEAR, Intea and dRPC; dRPC lacks the `EXPERIMENTAL_*` methods, and the RPC helper falls through to the next provider.
- A 300 Tgas call is checked against the pessimistic gas price: an account needs about 0.35 NEAR up front to send one (about 1.1 NEAR for a 900 Tgas close), though most of it is refunded; the relayer tops its gas key up before a call above 300 Tgas.
- The review model reasons before it answers: the enclave asks with `reasoning_effort: "low"` to answer inside OutLayer's 90 s run, and a missing verdict counts as a rejection.
- A new enclave build gets new keys: publish it, run `keys`, rotate the risk board (`set_enclave`, which `scripts/deploy.ts` does), submit the sealing report, and set mandates again, since each names the guardian key (`bun scripts/scenarios.ts --remandate` does it for the test accounts whose owner keys are on hand; people re-sign theirs in the app).
