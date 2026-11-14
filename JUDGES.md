# Judging map

Each criterion, with the evidence for it and where to find it.
Links go to the exact code; `pnpm verify` re-checks the live claims and prints pass or fail per claim.

## Verify it yourself in five minutes

```bash
pnpm install
pnpm verify --quick          # the live claims against the testnet deployment: code hashes, the enclave key, each recorded primitive's transaction, the vault, the oracle, the API
pnpm test:contracts          # 288 contract unit tests, including the regression test each review finding names
cd enclave && cargo test     # the guardian program, against the same risk fixtures as the TypeScript model
```

## Live on testnet, ready for mainnet

Each scenario of the test matrix, run end to end by `bun scripts/scenarios.ts` against the live deployment (filled from `deployments/testnet-proofs.json` by `bun scripts/readme.ts`).

<!-- scenarios:start -->
| # | Scenario | On testnet | Transactions |
| --- | --- | --- | --- |
| 1 | Sign in with a NEAR wallet (Meteor, by hand in Chrome) and with a passkey (the app's Playwright suite) | passes | [tx 1](https://testnet.nearblocks.io/txns/2fiQBnPXs4y3NqDKeyK5N9bZ9HDo2RtkSNTKQxhfMzJM), [tx 2](https://testnet.nearblocks.io/txns/GAMPNdJFNuBruYF9Q1ZjKYcGXLfKu5qbj7scszaaNHEK) |
| 2 | A protected account without gas | passes | [tx 1](https://testnet.nearblocks.io/txns/FYxvwqXmG7E84ifKZB4hQFNh7LEAuUfenaE7nrkjwyzL), [tx 2](https://testnet.nearblocks.io/txns/3W8cwZQwrHi7TCT8HPgxEAA2N2KvJ49PqSVxTBVPhqFe), [tx 3](https://testnet.nearblocks.io/txns/7GvLod2WmHSbZpRMkqvsXgeWJZvHWvYTzAeEeoFCLbS3) |
| 3 | A leveraged Rhea position | passes | [tx 1](https://testnet.nearblocks.io/txns/AVZybr9fiYLxZukzmQA3AoZXMMKEwnzpi5aLXLcWy8kv), [tx 2](https://testnet.nearblocks.io/txns/HesapwfgHxDRXfQZGq6JwMRw9q3YZnRTFqfFp58e6tVw), [tx 3](https://testnet.nearblocks.io/txns/DPyQ9RUwNUBdm7V6y58J2hBmGZyYcgWFyyEKf6mDp1Ty) |
| 4 | A mandate with a sealed policy | passes | [tx 1](https://testnet.nearblocks.io/txns/Fj6DamhcS29NDCuxRsJ6cYnCFBmpsThnhgCD9R8Ggp7y), [tx 2](https://testnet.nearblocks.io/txns/6mR6URc6pqZSatuXVdvjGypxUjMu9BfGcYSsgk41Y1ti), [tx 3](https://testnet.nearblocks.io/txns/5SAqVSWGN5NdtuU13ZGy2SYGYvx64hD2esCMDGHajfh5) |
| 5 | The market shock moves the price | passes | [tx 1](https://testnet.nearblocks.io/txns/51LMMmEiAbdMfNLoFYTYVTufYjzFGSaFLnchdePst9bw) |
| 6 | Alert, AI review, rescue and recovery | passes | [tx 1](https://testnet.nearblocks.io/txns/Hnwb9p1y8V5Ajxh2kEgWeNdz1qhb5i9BYLcwUD7VqHPS), [tx 2](https://testnet.nearblocks.io/txns/8R1RxbGMXftdjRgZCZXN8UyEiqVawP62bXPY8FFWgkLS), [tx 3](https://testnet.nearblocks.io/txns/54XMKdDUu6dV7ErFg8Pv4pEdS98BfALbBGq9N3LtNGtZ) |
| 7 | Mandate enforcement: replays, forged envelopes, withdrawals and expiry are refused | passes | [tx 1](https://testnet.nearblocks.io/txns/7ktSsjYp9p1wAG1dh1s3qurLcJFwqjFL9gdzZkSfub8u), [tx 2](https://testnet.nearblocks.io/txns/CRDvQLbpcmiPcw821X6J4LECCXkq4zJfp1E1TgsCZFpP), [tx 3](https://testnet.nearblocks.io/txns/GpKErYejoLXUi2oFDwJLwQ7nYcUTn61KqEf7q2NKxEmq) |
| 8 | A Hyperliquid order signed by the protected account through Chain Signatures | passes | [tx 1](https://testnet.nearblocks.io/txns/7nRZmQ4VBwQSoAoRTsAETX15rnUNRhjH4U9K6zijR4Ez), [tx 2](https://testnet.nearblocks.io/txns/Dpg9QdydvGhKFcpSGQxa2jsTzjksxEoB4UvyrLF8jEQX), [tx 3](https://testnet.nearblocks.io/txns/HVJyZvz2rmKfPJ1ztYGx3PtA3x1T68fhAaKWcAbvV7bG) |
| 9 | An Aave position on Base Sepolia rescued through Chain Signatures | passes | [tx 1](https://testnet.nearblocks.io/txns/ARQorS56hvsJnGhQ9WMjHeT2Qr2SmawnXHAAWWyUy3Ah), [tx 2](https://testnet.nearblocks.io/txns/7PB7R7H991Y1YMohZauyhdiPWcmoRhpcp7LdjLeZssbT), [tx 3](https://testnet.nearblocks.io/txns/6QH7NDnskgmdmcCaonV3GXQHSFcFTDJuowSXz6chKA4a) |
| 10 | Vault deposit, hedge, withdrawal through the queue, proof of reserves | passes | [tx 1](https://testnet.nearblocks.io/txns/Fht1wfbKSpRvHVMpqQnEtK9yiKXAYxVGxddRpu9yCz9g), [tx 2](https://testnet.nearblocks.io/txns/C5mPs3JNRwq2D2jChJUVBfat1nX29nWnhthdXuBiZGY5), [tx 3](https://testnet.nearblocks.io/txns/8Uzk1Seyg5Y7HZTFqkUZFXd1gvuLCZoJ7RdGmBSYQF8U) |
| 11 | The vault pauses deposits from its risk score | passes |  |
| 12 | A paid risk check over x402 on NEAR | passes | [tx 1](https://testnet.nearblocks.io/txns/2NWq6offVAhutwAse6pVWT11LFXNhTzh5MiFTQNko2Hu), [tx 2](https://testnet.nearblocks.io/txns/ETZ1TFMQAHRwnkEdC9QAdWJHVhEMxYYi8FBRWLy2UyqT) |
| 13 | Core flows through the SDK and the MCP server | passes |  |
| 14 | Closing a Rhea position in rounds by selling collateral (a NEAR-wallet owner and a passkey owner through the relayer) | passes | [tx 1](https://testnet.nearblocks.io/txns/GB5Z7KZriR3dyYJ3Z5uNY64P2g9n74AJsJg5csECbLoR), [tx 2](https://testnet.nearblocks.io/txns/BLJHsJiA4jQuEvnabBoTJdmnt7HntjkKFAv8PBgwDoH1), [tx 3](https://testnet.nearblocks.io/txns/GhEAf1N7X4YRy2rhLBFwoVcGWcDvMgK6AKHFe5KUCtKB) |
| 15 | Closing a Rhea position from the wallet (repay with the owner's own USDC, then withdraw the collateral) | passes | [tx 1](https://testnet.nearblocks.io/txns/CtgUcoTBJhbSxgacCaZEvHUd9TDEvR8HrBnjJHwjgxFZ), [tx 2](https://testnet.nearblocks.io/txns/EqADQiSWhYndhm23WabgTCjhgwXiP8cGN4fW6ZuX7Bfj), [tx 3](https://testnet.nearblocks.io/txns/9RUc1cCUxWBDfYFREpFwR6vP1RbrFJWpBT7GDzEfpAwX) |
| 16 | Unwinding a protected account (mandate revoked, lending withdrawn, tokens and NEAR sent to the owner) | passes | [tx 1](https://testnet.nearblocks.io/txns/EyDVJzjzAvZfTxWsnChVx7yfXHVnF3Rc8ui5U7Dda3GR), [tx 2](https://testnet.nearblocks.io/txns/54yJdFD4M6UDmsDBirtapFyBnuzJu8wmVR2wDfbXs9jv), [tx 3](https://testnet.nearblocks.io/txns/BwRU7U3wQr6uKnq51DnWZdMV4PQr9qew15Kr7zyewMMw) |
| 17 | A health certificate: issued by the enclave, anchored on the risk board, verified | passes | [tx 1](https://testnet.nearblocks.io/txns/BpzRrP6kzK6pjTrnFe83uGZQCKzk3P9zJ5sUg9ibkDTt) |
| 18 | An insurance inflow: 10% of the vault's staking yield moves into its fund | passes | [tx 1](https://testnet.nearblocks.io/txns/8KzLyyqZMSF955B2ZtkAHgEntvcYNkB4hxFqAydNx77T), [tx 2](https://testnet.nearblocks.io/txns/88DxX1AHzUhZoA2Gy47kCZ9fnuUipKym5yVJsGdsQAJK) |
<!-- scenarios:end -->

`deployments/testnet.json` lists every deployed account, code hash and transaction; `deployments/testnet-proofs.json` records each scenario of the test matrix with its transactions; [`AGENTS.md`](AGENTS.md) maps every NEAR primitive to its code.

## Replayed through NEAR's worst crashes

Six real NEAR crashes and six real NEAR rallies, hour by hour from Binance's public candles, run through Parry's risk model, a repay-first guardian and the vault by its real rules (`pnpm replay` fetches and computes; `pnpm replay --print` prints the committed results; the live page is `/replay`).
The logic is [`packages/core/src/replay.ts`](packages/core/src/replay.ts); the results, with every source, are [`deployments/replay.json`](deployments/replay.json).

| Crash | Drop | Liquidated without Parry | Warning | Guardian steps | Min health with Parry | Vault drawdown (unhedged) | Hedged | Min margin ratio | Funding | Insurance paid |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 21 Dec 2020 to 24 Dec 2020 | 39.8 % | 2020-12-21 10:00 | 7 h | 7 | 1.080 | 2.7 % (39.8 %) | 90 % | 0.495 | $8.47 | $0.00 |
| 21 May 2021 to 23 May 2021 | 45.6 % | 2021-05-21 14:00 | 10 h | 9 | 1.236 | 6.1 % (45.6 %) | 81 % | 0.488 | $4.59 | $0.00 |
| 19 Jan 2022 to 22 Jan 2022 | 39.1 % | 2022-01-21 20:00 | 47 h | 7 | 1.193 | 2.7 % (39.1 %) | 84 % | 0.496 | -$5.29 | $3.83 |
| 9 May 2022 to 12 May 2022 | 51.7 % | 2022-05-11 06:00 | 44 h | 7 | 0.971 (liquidated) | 9.2 % (51.7 %) | 70 % | 0.479 | -$40.26 | $3.23 |
| 31 Jan 2025 to 3 Feb 2025 | 38.6 % | 2025-02-02 18:00 | 33 h | 6 | 1.149 | 2.6 % (38.6 %) | 88 % | 0.497 | -$2.59 | $2.78 |
| 3 Jun 2026 to 6 Jun 2026 | 38.9 % | 2026-06-04 08:00 | 16 h | 6 | 1.240 | 2.7 % (39.4 %) | 90 % | 0.484 | $1.72 | $0.68 |

| Spike | Rise | Vault liquidated | Min margin ratio | Closest to liquidation | Max score | Deposits paused | Margin asked | Margin topped up (largest shortfall) | Rebalances (buybacks) | Hedged at the end | Share price (unhedged) | Drawdown |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 10 Feb 2021 to 13 Feb 2021 | 67.8 % | no | 0.212 | 15.4 % away | 70 | 2 h | no | n/a | 39 (19) | 27 % | 1.122 (1.498) | 8.5 % |
| 23 Feb 2021 to 25 Feb 2021 | 63.2 % | no | 0.184 | 12.8 % away | 85 | 2 h | 1 h | $16.61 ($749.23) | 58 (30) | 14 % | 1.167 (1.627) | 11.5 % |
| 6 Sep 2021 to 9 Sep 2021 | 92.0 % | no | 0.093 | 4.1 % away | 85 | 8 h | 2 h | $0.00 ($1069.43) | 63 (24) | 9 % | 1.105 (1.555) | 17.7 % |
| 21 Dec 2021 to 24 Dec 2021 | 78.0 % | no | 0.197 | 14.0 % away | 70 | 2 h | no | n/a | 66 (35) | 11 % | 1.246 (1.741) | 6.4 % |
| 18 Dec 2023 to 21 Dec 2023 | 64.4 % | no | 0.191 | 13.4 % away | 70 | 1 h | no | n/a | 56 (31) | 21 % | 1.122 (1.518) | 8.1 % |
| 16 Sep 2026 to 19 Sep 2026 | 65.7 % | no | 0.271 | 21.0 % away | 38 | no | no | n/a | 57 (33) | 22 % | 1.144 (1.546) | 6.2 % |

- The model warned before every liquidation: median 24.5 hours, shortest 7 hours; at the first warning, its predicted time to liquidation over the actual one has a median of 1.0.
- Parry avoided 5 of 6 liquidations; the sixth was a single-hour 32 % wick on 11 May 2022 that arrived after the owner's daily action budget was spent, which a higher target or a larger budget covers.
- The hedged vault's drawdown was 2.6 % to 9.2 % against 38.6 % to 51.7 % unhedged. The two worst followed a week of funding paid by shorts, when the enclave leans the hedge to 81 % and 70 %. The insurance fund covered 0.68 to 3.83 USD of the funding paid in four of the crashes.
- Through the six largest rallies the vault's short was never liquidated (lowest margin ratio 0.093, closest 4.1 % from its liquidation price). The leverage cap bought it back each hour, leaving 9 % to 27 % of the NEAR hedged at the end. The score's floors (at least 70 within 20 % of the liquidation price, 85 within 15 %) paused deposits for 15 hours and asked for margin 3 times. The keeper's top-ups are clamped to what the insurance fund may pay: 16.61 USD once, and nothing twice when funding covers had spent the day's cap. The fund is sized for funding, not for margin.

## NEAR at the core

Parry is not a dapp that happens to deploy on NEAR: each of its guarantees comes from a NEAR primitive, and the README's "Only on NEAR" table links a testnet transaction for each.

- **Accounts:** every protected account is a NEP-655 universal account derived from one global contract hash, created gaslessly through a NEP-366 relayer and owned by a passkey verified on chain.
- **Cross-chain without bridges:** Chain Signatures sign Hyperliquid orders and Aave transactions on Base for the account's own derived addresses, and the MPC network's `verify_foreign_transaction` confirms the result back on NEAR.
- **Verifiable compute and AI:** the guardian runs in an OutLayer TEE with keys bound to its build, and every rescue is reviewed by a NEAR AI Cloud verifiable model whose TEE signature and hardware attestation are checked.
- **Protocol-level keys:** the services sign on gas keys (NEP-611) with parallel nonce lanes, and the treasury signs its top-ups with a post-quantum ML-DSA-65 key.
- **The agent economy:** risk checks paid per call over x402 on NEAR, an MCP server, a NEAR Agent Market listing, and NEAR Intents (1Click quotes, and on mainnet a confidential rescue reserve on the Intents Agent API).
- **DeFi on NEAR:** Rhea lending's exact mainnet code, the Rhea exchange, wNEAR and LiNEAR.

## Technical implementation

- **A guardian that can only protect.**
  The account accepts an envelope only with the enclave's signature, within 120 seconds, at the next nonce, inside the mandate's powers, caps, daily count and expiry, and only with the gas its whole promise chain needs: [`guardian_execute`](contracts/account/src/guardian.rs#L173).
  No guardian action has a recipient: [`GuardianAction`](contracts/common/src/mandate.rs#L188); the mandate is checked on the way in: [`assert_valid`](contracts/common/src/mandate.rs#L110).
- **An atomic deleverage on real lending code.**
  Withdraw, swap, repay and check health as one promise chain where every failed step restores the position, priced by the lending contract's own oracle: [`on_delev_prices`](contracts/account/src/guardian.rs#L448) and the steps after it.
  The sandbox suite runs it against Rhea lending's exact mainnet wasm, the Rhea exchange, wNEAR and LiNEAR: [`contracts/tests/tests/protect.rs`](contracts/tests/tests/protect.rs).
- **Chain Signatures for two other chains.**
  Hyperliquid orders: the account builds the EIP-712 agent digest on chain ([`agent_digest`](contracts/common/src/hyperliquid.rs#L139)) and checks the order against a price band before signing ([`on_hl_mark`](contracts/account/src/guardian.rs#L390)).
  Aave on Base Sepolia: the account builds the EIP-1559 transaction with capped fees ([`assert_guardian_fees`](contracts/common/src/evm.rs#L80), [`evm_sign`](contracts/account/src/guardian.rs#L430)); the relay checks the MPC signature recovers to the person's own address, broadcasts it, and has the MPC network verify the result on NEAR ([`verifyEvm`](services/src/guardian.ts#L170), [`verifyOnNear`](services/src/lib/evm.ts#L191)).
- **Verifiable AI in a TEE.**
  The enclave asks a NEAR AI Cloud verifiable model to review every plan and checks the model's TEE signature over the exact request and response bytes before it signs anything: [`review`](enclave/src/ai.rs).
  It accepts that signature only from a key it attested itself: its `attest` mode verifies the model's Intel TDX quote against Intel's root of trust, the quote's binding of the key to the enclave's own nonce, and NVIDIA's ES384-signed GPU verdict for the same nonce, and pins the key on the risk board for a day ([`enclave/src/attest.rs`](enclave/src/attest.rs), `model_signers` in [`contracts/risk/src/lib.rs`](contracts/risk/src/lib.rs)).
  The review's hash goes on chain with the action, and anyone can re-check a decision: [`verifyDecisionRecord`](apps/api/src/verify.ts), `parry.verifyDecision` in the SDK, `verify_guardian_decision` in the MCP server.
- **Caps on every venue.**
  Beyond each token's total and daily caps, the perp guard caps each order, the guardian's order size per day and the hedge it may open over the mandate's life, and the Aave guard caps each repay, the repays per day and in total ([`guardian_execute`](contracts/account/src/guardian.rs), [`Mandate::assert_valid`](contracts/common/src/mandate.rs)).
- **Keys bound to the build.**
  OutLayer derives the enclave's signing and sealing keys from the wasm: [`enclave/manifest.json`](enclave/manifest.json); the risk board accepts reports only from that key: [`submit`](contracts/risk/src/lib.rs#L450).
- **Sharper in round three.**
  The Tremor index carries a regime (calm, stressed, panic) whose thresholds are chosen out of sample, on NEAR hours away from every replayed crash and spike, then tested on them ([`tremorRegime`](packages/core/src/risk.ts), docs/risk-model.md section 2).
  Cascade pressure comes from every Rhea borrower read from the lending contract on mainnet and testnet, each liquidation sized by Rhea's own rule (back to health 1 at its discount, only the NEAR share sold), accounts already under water set aside ([`packages/core/src/heatmap.ts`](packages/core/src/heatmap.ts)); the app draws it as the cascade map.
  The owner orders the rescue steps; the planner takes the first allowed step that moves health, sizes it to land on the target, re-checks after each step, and records why it skipped the earlier ones ([`enclave/src/plan.rs`](enclave/src/plan.rs), `Decision.explanation`).
  The vault's hedge ratio follows funding within its bounds with the reason in each report, and an insurance fund (10 % of positive yield) pays negative funding and margin top-ups under caps; the keeper files funding covers hourly and top-ups, as large as the fund may pay, when the vault asks ([`contracts/vault/src/insurance.rs`](contracts/vault/src/insurance.rs), [`services/src/keeper.ts`](services/src/keeper.ts)).
  The owner can close a Rhea position by selling collateral in rounds that each keep health above 1, or unwind the whole account, with every failed step rolled back ([`contracts/account/src/close.rs`](contracts/account/src/close.rs)).
  The enclave signs private health certificates: "health is at least X" for one named reader at one block, with no amounts, optionally anchored on the risk board, checkable on `/verify`, in the SDK and over MCP.
- **Tests.**
  288 contract unit tests (each review fix names a regression test that fails without it), 21 sandbox flows on real protocol code including a mainnet rehearsal, 44 enclave tests and 2 cross-language vectors, 292 TypeScript tests (the database ones need `TEST_DATABASE_URL`), and 295 browser tests that open every page at three widths in both themes; the risk model is one fixture file both languages pass: [`packages/core/fixtures/risk-cases.json`](packages/core/fixtures/risk-cases.json).
  The test matrix's scenarios run end to end with recorded transactions: [`scripts/scenarios.ts`](scripts/scenarios.ts), [`deployments/testnet-proofs.json`](deployments/testnet-proofs.json).

## Design

- One palette (ink, bone and brass) from one token file, [`packages/brand/tokens.json`](packages/brand/tokens.json), drives the site, the app and the README figures; every text colour clears WCAG AA in both themes, and risk colours appear only inside the risk instrument.
- The signature element is the risk instrument: a health scale with a hatched liquidation edge, a sprung needle, a 24 hour ghost projection with its band, draggable trigger and target handles, and the guardian's past actions marked on it ([`RiskInstrument`](apps/web/components/instrument/RiskInstrument.tsx)).
- Protect is built around it: drag the trigger and target, order the rescue steps by dragging, and read in plain words what the guardian would do now with that draft.
- The landing explains by doing: drag the hero chart to push the price and watch Parry turn the strike aside; the Protect story pins the real components step by step.
- Every page works at phone width in both themes with no sideways scroll, under reduced motion, and from the keyboard (Cmd or Ctrl+K reaches every page and action); the public pages score 100 on Lighthouse accessibility, best practices and SEO.
- The risk model is written down with every formula and threshold: [`docs/risk-model.md`](docs/risk-model.md).

## Impact

- Liquidations take the liquidation bonus from borrowers on every lending market; a guardian that acts before the threshold, inside bounds the owner sets, keeps that value with the owner.
- Anyone can check any NEAR account's lending risk without signing up (`/v1/risk/{account}`), agents can pay per check over x402 on NEAR, and the MCP server gives every agent the same tools.
- The vault turns staking yield and funding into a dollar-stable product whose hedge and reserves are attested on chain.

## Originality

- The AI review is not advice next to an action: it is a condition of the action, bound to the exact bytes by the model's TEE signature and recorded on chain with it.
- Policies are sealed to the enclave ([`seal::open`](enclave/src/seal.rs#L111)), so nobody watching the chain learns in advance when a position will be defended, and the public record of a rescue names the action alone: the owner's plan, with its target and step order, is served only to the owner, signed in.
- A protected account is a NEP-655 universal account derived from one published global code hash, created gaslessly by the relayer ([`create_account`](contracts/accounts/src/lib.rs#L123), [`state_init_of`](contracts/accounts/src/lib.rs#L105)), and owned by a passkey verified on chain ([`passkey::verify`](contracts/account/src/passkey.rs#L34)).
- The Tremor index, cascade pressure and first-passage probability turn volatility and crowding into a time to liquidation, not just a health number: [`tremor`](packages/core/src/risk.ts#L150), [`assess`](packages/core/src/risk.ts#L339).

## Sustainability

- Mainnet is real code with a dry-run plan and exact costs: [`MAINNET.md`](MAINNET.md), `bun scripts/deploy.ts --network mainnet`, and a sandbox rehearsal on mainnet's own contract code ([`contracts/tests/tests/mainnet.rs`](contracts/tests/tests/mainnet.rs)).
- Revenue paths are built in: paid risk checks over x402 ([`apps/api/src/x402.ts`](apps/api/src/x402.ts)) and the vault.
- Running costs are small and measured: a guardian review costs well under a tenth of a cent, an enclave run at most 0.01 NEAR (MAINNET.md, "Costs").
- Gas keys with parallel nonce lanes let the services send many transactions at once from one account: [`Sender`](services/src/lib/near.ts#L168).

## Completeness

- Contracts, enclave, services, API, app, SDK, MCP server and agent skill all work together, live on testnet and mainnet-ready ([`MAINNET.md`](MAINNET.md)); `deployments/testnet.json` records every account, code hash and transaction.
- Every contract is a reproducible build; `near contract verify deployed-at <account>` matches each one, and `pnpm verify` checks it.
- `pnpm verify` checks the README's claims against testnet, each recorded transaction included, and names what a claim still waits for; `pnpm security` runs Clippy, cargo audit, cargo deny and pnpm audit; [`SECURITY.md`](SECURITY.md) lists every review finding and its status.
- Agents can run everything: [`AGENTS.md`](AGENTS.md), [`skills/parry/SKILL.md`](skills/parry/SKILL.md), [`llms.txt`](apps/web/public/llms.txt), and `docker compose up` for the whole stack.
