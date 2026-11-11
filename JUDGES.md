# Judging map

Each criterion, with the evidence for it and where to find it.
Links go to the exact code; `pnpm verify` re-checks the live claims and prints pass or fail per claim.

## Verify it yourself in five minutes

```bash
pnpm install
pnpm verify --quick          # the live claims against testnet: code hashes, the enclave key, each recorded primitive's transaction, the vault, the oracle, the API
pnpm test:contracts          # 229 contract unit tests, including an audit_* test for every review finding
cd enclave && cargo test     # the guardian program, against the same risk fixtures as the TypeScript model
```

## What runs on testnet today

Each scenario of the test matrix, run end to end by `bun scripts/scenarios.ts` against the live deployment (filled from `deployments/testnet-proofs.json` by `bun scripts/readme.ts`).

<!-- scenarios:start -->
| # | Scenario | On testnet | Transactions |
| --- | --- | --- | --- |
| 1 | Sign in with a passkey or a NEAR wallet | runs in a browser: the app's Playwright suite signs in with a virtual passkey authenticator |  |
| 2 | A protected account without gas | passes | [tx 1](https://testnet.nearblocks.io/txns/Gw8ZTrqUpmY7zbtb25hhvmojApRrmcVSqkHHHsTffNKY) |
| 3 | A leveraged Rhea position | passes | [tx 1](https://testnet.nearblocks.io/txns/FFn16RRK3Fykmnt8TiTpWHTew9wEXnTQMfq6vUbwJra7), [tx 2](https://testnet.nearblocks.io/txns/3XjNb5s41sGwXjNYwL9VNayJr4ygmwXfC4j8oKrMwSPt), [tx 3](https://testnet.nearblocks.io/txns/DfVtq8hz4cid4AH2CjiaAg9BPjPXKDsvAzStcfTYZwx6) |
| 4 | A mandate with a sealed policy | passes | [tx 1](https://testnet.nearblocks.io/txns/7A3QiDCEYtuSwUfTmKkmo1ZrFd6Kz5YkStmF1GFxt4qm) |
| 5 | The market shock moves the price | passes | [tx 1](https://testnet.nearblocks.io/txns/EFSsqwrvoZvnhiH7npbdt77wKaQpr1JzEgcr97HiSxDm) |
| 6 | Alert, AI review, rescue and recovery | waits for the NEAR AI Cloud key |  |
| 7 | Limits: replays, forged envelopes, withdrawals and expiry are refused | passes | [tx 1](https://testnet.nearblocks.io/txns/9CzERLrWh1v8in6vZy2uvfQJLfQeZDuUEU7TPtVDeica), [tx 2](https://testnet.nearblocks.io/txns/JAMYHxcEzNyyxDHMZgLvBeXZwwz5EKg8QRqoMqBLTYeL), [tx 3](https://testnet.nearblocks.io/txns/J9ZahDCsajk7gyspFx34dbfmF9ZMwyEJbzfET3oARADT) |
| 8 | A Hyperliquid order signed by the protected account through Chain Signatures | passes | [tx 1](https://testnet.nearblocks.io/txns/HGRN5UQNq3UTTH6dUNvVQASK5adm7cRK6yJnkpZW34p2), [tx 2](https://testnet.nearblocks.io/txns/87oNvABbyosG7ySydrkNsA3d5ndHonLRUhxpDNAGb2FL) |
| 9 | An Aave loan on Base Sepolia rescued through Chain Signatures and verified by the MPC network | waits for Base Sepolia ETH at the account's derived address |  |
| 10 | Vault deposit, withdrawal through the queue, proof of reserves (the hedge waits for margin) | passes | [tx 1](https://testnet.nearblocks.io/txns/EoJq4eTPyPKvnJQuHg19dzzzfVwzam6ZrUWMUtwmUktf), [tx 2](https://testnet.nearblocks.io/txns/FBabiQkufqw8jnLQB7fYqTQt3wpLWxDR4KERtC67NbvE) |
| 11 | The vault pauses deposits from its risk score | passes |  |
| 12 | A paid risk check over x402 on NEAR | passes | [tx 1](https://testnet.nearblocks.io/txns/7HiVRqxDKGfywuh2maTLjFHteRMU3euseNiF5L9mbofR), [tx 2](https://testnet.nearblocks.io/txns/EWEDSQkWTjJNuUCsSf9w1Zbegh49FmSJb6v7oAJQTyVf) |
| 13 | Core flows through the SDK and the MCP server | passes |  |
<!-- scenarios:end -->

`deployments/testnet.json` lists every deployed account, code hash and transaction; `deployments/testnet-proofs.json` records each scenario of the test matrix with its transactions; [`AGENTS.md`](AGENTS.md) maps every NEAR primitive to its code.

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
  The account accepts an envelope only with the enclave's signature, within 120 seconds, at the next nonce, inside the mandate's powers, caps, daily count and expiry, and only with the gas its whole promise chain needs: [`guardian_execute`](contracts/account/src/guardian.rs#L171).
  No guardian action has a recipient: [`GuardianAction`](contracts/common/src/mandate.rs#L162); the mandate is checked on the way in: [`assert_valid`](contracts/common/src/mandate.rs#L100).
- **An atomic deleverage on real lending code.**
  Withdraw, swap, repay and check health as one promise chain where every failed step restores the position, priced by the lending contract's own oracle: [`on_delev_prices`](contracts/account/src/guardian.rs#L424) and the steps after it.
  The sandbox suite runs it against Rhea lending's exact mainnet wasm, the Rhea exchange, wNEAR and LiNEAR: [`contracts/tests/tests/protect.rs`](contracts/tests/tests/protect.rs).
- **Chain Signatures for two other chains.**
  Hyperliquid orders: the account builds the EIP-712 agent digest on chain ([`agent_digest`](contracts/common/src/hyperliquid.rs#L139)) and checks the order against a price band before signing ([`on_hl_mark`](contracts/account/src/guardian.rs#L368)).
  Aave on Base Sepolia: the account builds the EIP-1559 transaction with capped fees ([`assert_guardian_fees`](contracts/common/src/evm.rs#L80), [`evm_sign`](contracts/account/src/guardian.rs#L408)); the relay checks the MPC signature recovers to the person's own address, broadcasts it, and has the MPC network verify the result on NEAR ([`verifyEvm`](services/src/guardian.ts#L151), [`verifyOnNear`](services/src/lib/evm.ts#L191)).
- **Verifiable AI in a TEE.**
  The enclave asks a NEAR AI Cloud verifiable model to review every plan and checks the model's TEE signature over the exact request and response bytes before it signs anything: [`review`](enclave/src/ai.rs#L78).
  The review's hash goes on chain with the action, and anyone can re-check a decision: [`verifyDecisionRecord`](apps/api/src/verify.ts#L91), `parry.verifyDecision` in the SDK, `verify_guardian_decision` in the MCP server.
- **Keys bound to the build.**
  OutLayer derives the enclave's signing and sealing keys from the wasm: [`enclave/manifest.json`](enclave/manifest.json); the risk board accepts reports only from that key: [`submit`](contracts/risk/src/lib.rs#L273).
- **Tests.**
  229 contract unit tests (each audit fix has an `audit_*` test that fails without it), 15 sandbox flows on real protocol code including a mainnet rehearsal, 16 enclave tests and 2 cross-language vectors, 152 TypeScript tests (10 of them need `TEST_DATABASE_URL`); the risk model is one fixture file both languages pass: [`packages/core/fixtures/risk-cases.json`](packages/core/fixtures/risk-cases.json).
  The test matrix's scenarios run end to end with recorded transactions: [`scripts/scenarios.ts`](scripts/scenarios.ts), [`deployments/testnet-proofs.json`](deployments/testnet-proofs.json).

## Design

- One palette (ink, bone and brass) from one token file, [`packages/brand/tokens.json`](packages/brand/tokens.json), drives the site, the app and the README figures ([`tools/make_readme_art.py`](tools/make_readme_art.py)); every text colour clears WCAG AA in both themes.
- The app reads like a risk desk: health, liquidation price, time to liquidation and the guardian's log with each decision's verification, in plain words.
- The risk model is written down with every formula and threshold: [`docs/risk-model.md`](docs/risk-model.md).

## Impact

- Liquidations take the liquidation bonus from borrowers on every lending market; a guardian that acts before the threshold, inside limits the owner sets, keeps that value with the owner.
- Anyone can check any NEAR account's lending risk without signing up (`/v1/risk/{account}`), agents can pay per check over x402 on NEAR, and the MCP server gives every agent the same tools.
- The vault turns staking yield and funding into a dollar-stable product whose hedge and reserves are attested on chain.

## Originality

- The AI review is not advice next to an action: it is a condition of the action, bound to the exact bytes by the model's TEE signature and recorded on chain with it.
- Policies are sealed to the enclave ([`seal::open`](enclave/src/seal.rs#L67)), so nobody watching the chain learns when a position will be defended.
- A protected account is a NEP-655 universal account derived from one published global code hash, created gaslessly by the relayer ([`create_account`](contracts/accounts/src/lib.rs#L123), [`state_init_of`](contracts/accounts/src/lib.rs#L105)), and owned by a passkey verified on chain ([`passkey::verify`](contracts/account/src/passkey.rs#L34)).
- The Tremor index, cascade pressure and first-passage probability turn volatility and crowding into a time to liquidation, not just a health number: [`tremor`](packages/core/src/risk.ts#L115), [`assess`](packages/core/src/risk.ts#L297).

## Sustainability

- Mainnet is real code with a dry-run plan and exact costs: [`MAINNET.md`](MAINNET.md), `bun scripts/deploy.ts --network mainnet`, and a sandbox rehearsal on mainnet's own contract code ([`contracts/tests/tests/mainnet.rs`](contracts/tests/tests/mainnet.rs)).
- Revenue paths are built in: paid risk checks over x402 ([`apps/api/src/x402.ts`](apps/api/src/x402.ts)) and the vault.
- Running costs are small and measured: a guardian review costs well under a tenth of a cent, an enclave run at most 0.01 NEAR (MAINNET.md, "Costs").
- Gas keys with parallel nonce lanes let the services send many transactions at once from one account: [`Sender`](services/src/lib/near.ts#L146).

## Completeness

- Contracts, enclave, services, API, app, SDK, MCP server and agent skill all work together on testnet; `deployments/testnet.json` records every account, code hash and transaction.
- Every contract is a reproducible build; `near contract verify deployed-at <account>` matches each one, and `pnpm verify` checks it.
- `pnpm verify` checks the README's claims against testnet, each recorded transaction included, and names what a claim still waits for; `pnpm security` runs Clippy, cargo audit, cargo deny and pnpm audit; [`SECURITY.md`](SECURITY.md) lists every review finding and its status.
- Agents can run everything: [`AGENTS.md`](AGENTS.md), [`skills/parry/SKILL.md`](skills/parry/SKILL.md), [`llms.txt`](apps/web/public/llms.txt), and `docker compose up` for the whole stack.
