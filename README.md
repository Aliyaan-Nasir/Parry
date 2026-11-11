<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/readme/hero-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="assets/readme/hero-light.png">
  <img src="assets/readme/hero-light.png" alt="Parry: liquidation protection and a delta-neutral vault on NEAR" width="960">
</picture>

Parry keeps leveraged positions from being liquidated, and runs a delta-neutral NEAR vault.
A guardian in an OutLayer TEE watches each protected position, plans a rescue, has a NEAR AI Cloud verifiable model review it, and signs it with a key bound to its build.
The person's account contract accepts only protective actions within their on-chain mandate, and records the hash of the review that approved each one.

<!-- links:start -->
Run it with `docker compose up` or `pnpm dev` (below); the hosted app's address is added here when it is live.
<!-- links:end -->

## Try it in two minutes

1. Open the app and connect with a passkey (or a NEAR testnet wallet through NEAR Connect).
   The relayer creates your protected account; you pay no gas.
2. On **Open position**, supply test NEAR, borrow test USDC, and take a USDC reserve from the faucet.
   You see the position's health, liquidation price and time to liquidation.
3. On **Protect**, set a mandate: let the guardian repay from the reserve, up to a daily cap, for a week.
   Your trigger and target are sealed to the enclave before they leave the browser.
4. On **Market shock**, drop NEAR by 20 % on the testnet oracle.
   Within a minute the dashboard turns critical and an alert arrives.
5. On **Guardian**, the rescue appears with its plan, the model's verdict and its transactions.
   **Verify** checks the review's signature, its hash on chain and the enclave's signature in front of you.
6. Health is back above the target.
   On **Vault**, deposit test NEAR and see the hedge, the risk score and the proof of reserves.

## Built for four tracks

- **DeFi:** liquidation protection for Rhea lending, Hyperliquid perps and Aave, plus a delta-neutral vault with an on-chain risk score and proof of reserves.
- **Agent Economy:** an MCP server with read tools and capped write tools, risk checks paid per call over x402 on NEAR, an agent skill, `llms.txt`, and a NEAR Agent Market listing that answers hires.
- **AI Security:** the AI can only approve or block; it never holds a key that moves funds. Its review is bound to the exact bytes by the model's TEE signature, and the account contract enforces the mandate whatever any service or model says.
- **Privacy:** trigger thresholds and strategy are sealed to the enclave's key, so nobody watching the chain learns when a position will be defended; rescue swaps compare against NEAR Intents' confidential routes.

## What Parry does

**Protect.**
A protected account is your own NEAR smart account, owned by a passkey or a NEAR account.
It holds a Rhea lending position, and can also hold a Hyperliquid perp and an Aave loan on Base Sepolia through Chain Signatures.
You give the guardian a mandate: the powers it has (repay from a reserve, add collateral, deleverage, reduce or hedge the perp, repay the Aave loan), how much of each token it may use in total and per day, how many actions a day, and when the mandate ends.
Your trigger and target are sealed to the guardian's enclave, so nobody watching the chain learns when your position will be defended.

**Earn.**
The vault stakes NEAR into LiNEAR and shorts the NEAR perp on Hyperliquid with an order the vault itself builds and Chain Signatures signs, so its value follows dollars plus staking yield and funding.
Shares are the NEP-141 token `EARN`, valued at net asset value; withdrawals go through a queue and pay out in kind.
The enclave publishes the vault's risk score and a proof-of-reserves Merkle root on chain, and the vault stops taking deposits when the risk is high.

**Watch.**
Anyone can check any NEAR account's lending risk without signing up: health, liquidation price, the probability of liquidation within 24 hours, the median time to it, and a 0 to 100 score.
Agents pay per check over x402 on NEAR, or use the MCP server.

## How a rescue happens

<img src="assets/readme/pipeline.png" alt="How a rescue happens: the services watch and score every protected position, the guardian in the TEE plans, has the AI review and signs, and the account contract checks the envelope and acts inside the mandate" width="960">

1. The monitor reads each position (Rhea every 10 seconds, Hyperliquid every 15, Aave every 60); the risk engine scores it with the model in [`docs/risk-model.md`](docs/risk-model.md).
2. At caution or worse, the guardian runs in the OutLayer TEE: it opens the sealed policy, plans one step inside the mandate, and asks a NEAR AI Cloud verifiable model to review it.
3. The model's TEE signs the exact request and response; the enclave checks that signature and signs an envelope with its own key, which OutLayer derives from the enclave's build.
4. The account contract checks the envelope's key, nonce, age, powers and caps, acts, and emits the review's hash with the action; the risk board records the decision.
5. Anyone can re-check a decision: the app's **Verify**, `parry.verifyDecision` in the SDK, `verify_guardian_decision` in the MCP server, and `pnpm verify`.

## What the guardian can and cannot do

- It can repay debt from your reserve, add collateral from your reserve, sell some collateral through the exchange to repay (and restore everything if any step fails), reduce or hedge your perp inside a size cap and a price band, and approve or repay your Aave loan for your own address.
- It cannot send funds to anyone: no guardian action has a recipient.
- It acts only inside the mandate: its powers, each token's total and daily caps, the daily action count and the expiry; and only with a fresh envelope (120 seconds) at the next nonce.
- It acts only after an approving review whose signature verifies; no review, no action.
- You can revoke the mandate, pause the guardian or act directly at any time.

## Privacy, honestly

- Sealed: your trigger thresholds, target health and strategy (X25519 and ChaCha20-Poly1305 to the enclave's key, bound to your account id).
- Public: your positions, your mandate's powers and caps, and every action the guardian takes, because they are on chain.
- The review model sees the facts of one decision (the position, the plan, the limits and the owner's trigger) inside its TEE.
  The verdict and reasoning are shown in the guardian log; on chain there is only the review's hash.

## Only on NEAR

Each row is a NEAR primitive Parry depends on, the code that uses it, and a testnet transaction that shows it working (filled by `bun scripts/readme.ts` from `deployments/testnet-proofs.json`).

<!-- proofs:start -->
| Primitive | What Parry does with it | Code | On testnet |
| --- | --- | --- | --- |
| NEP-655 universal accounts and global contracts | every protected account is derived from one published code hash and created by the relayer | [`accounts/src/lib.rs`](contracts/accounts/src/lib.rs) | [transaction](https://testnet.nearblocks.io/txns/Bh14DgFZQoT1uJPj16rSLxvZ1UHDMXKuHeA1mgvZxemA) |
| Chain Signatures | a protected account signs its Hyperliquid orders and its Aave repay, and the vault its hedge, each for its own derived address | [`hyperliquid.rs`](contracts/common/src/hyperliquid.rs), [`evm.rs`](contracts/common/src/evm.rs) | [account's Hyperliquid order](https://testnet.nearblocks.io/txns/87oNvABbyosG7ySydrkNsA3d5ndHonLRUhxpDNAGb2FL), [Aave repay](https://testnet.nearblocks.io/txns/76HZsxGy3bW2ZS8eEbmYkT8R85hg6pvsgvkGby7eF3kw) |
| MPC foreign-transaction verification | the MPC network confirms the Aave repay landed on Base Sepolia | [`services/src/lib/evm.ts`](services/src/lib/evm.ts) | [transaction](https://testnet.nearblocks.io/txns/6QH7NDnskgmdmcCaonV3GXQHSFcFTDJuowSXz6chKA4a) |
| OutLayer TEE | the guardian runs with keys bound to its build | [`enclave/`](enclave) | [keys run](https://testnet.nearblocks.io/txns/9ww9V9DhgU43vN1Kjp9ckP1kHeX8nNDnWwBU3pwaSYYT) |
| NEAR AI Cloud verifiable models | every rescue is reviewed, and the review's TEE signature is checked before acting | [`enclave/src/ai.rs`](enclave/src/ai.rs) | [AI-reviewed rescue](https://testnet.nearblocks.io/txns/5dcSdzDaYjSWHERG9RK5Tt29bve7cXMGw8Ap9CTPwn5A) |
| Rhea lending and exchange | positions, repays and the atomic deleverage, on lending's exact mainnet code | [`guardian.rs`](contracts/account/src/guardian.rs) | [supply](https://testnet.nearblocks.io/txns/14gNW6irm4NX3k5DXfn5bk58mPkzQEKc7AijXwt6KtWU), [borrow](https://testnet.nearblocks.io/txns/ABPyym2uRx6KWXugUvyKYsjfZ4tL3xmtakaHUvkJMFSb), [guardian repay](https://testnet.nearblocks.io/txns/5dcSdzDaYjSWHERG9RK5Tt29bve7cXMGw8Ap9CTPwn5A) |
| x402 on NEAR | paid risk checks settled with a signed delegate `ft_transfer` | [`apps/api/src/x402.ts`](apps/api/src/x402.ts) | [transaction](https://testnet.nearblocks.io/txns/EWEDSQkWTjJNuUCsSf9w1Zbegh49FmSJb6v7oAJQTyVf) |
| Gas keys (NEP-611) | each service signs on a prepaid gas key with parallel nonce lanes, and refills it itself | [`near.ts`](services/src/lib/near.ts) | [keeper, 8 lanes](https://testnet.nearblocks.io/txns/ForLagMhcnjao6PzVgkRQQBaEpxo7iJ9bfcNXisUa3K1), [monitor, 4 lanes](https://testnet.nearblocks.io/txns/C4GFLKTB9Tkd6gU6eWjD6z5EHVsnBe4DA1iMvn8mTSHC), [relayer, 8 lanes](https://testnet.nearblocks.io/txns/7X4kzrKobrNoqZobrSG9JqDt2C4bNo1JvB16tZR3DtWp) |
| Post-quantum keys (ML-DSA-65) | the treasury, which holds the most NEAR, signs with an ML-DSA-65 key | [`deploy.ts`](scripts/deploy.ts), [`topup.ts`](services/src/topup.ts) | [key added](https://testnet.nearblocks.io/txns/CK3M4AqawEHZg7WVBNEK75DNVCUhzSLpnE33ZQm3MtDs), [a top-up it signed](https://testnet.nearblocks.io/txns/GwzViNzy9SjomAKq9MLdBC7hH5Qjx7XXnbFfGZ7fAQ9D) |
<!-- proofs:end -->

Parry also uses:

- passkeys verified on chain ([`passkey.rs`](contracts/account/src/passkey.rs)) and NEAR Connect wallets, with NEP-413 sign-in;
- NEP-366 meta transactions through its relayer ([`relayer.ts`](services/src/relayer.ts));
- NEAR AI's inference SDK to verify the review model's Intel TDX and NVIDIA GPU attestation ([`verify.ts`](apps/api/src/verify.ts));
- NEAR Intents: 1Click dry-run quotes for every rescue swap and for the vault's Hyperliquid margin ([`routes.ts`](services/src/lib/routes.ts)), and on mainnet a confidential rescue reserve on the Intents Agent API ([`intents.ts`](services/src/lib/intents.ts));
- NEAR's Agent Market, where a listing answers hires with risk reports ([`market.ts`](services/src/market.ts)).

## Deployed on testnet

Every contract is a reproducible build in SourceScan's pinned image (`contracts/scripts/build.sh --reproducible`), and `near contract verify deployed-at <account>` rebuilds it and matches the deployed code.

<!-- contracts:start -->
| Contract | Account | Code hash | Deployed in | Reproducible build |
| --- | --- | --- | --- | --- |
| Factory for protected accounts (NEP-655 universal accounts) | [`accounts.parry.testnet`](https://testnet.nearblocks.io/address/accounts.parry.testnet) | `5UTERdVdWxYY7MMD2xojiM5m8Kv25BxdXLzFvjoFcopo` | [wusyGMGb...](https://testnet.nearblocks.io/txns/wusyGMGb5NkcHH2YaHvQM7Wp9ytwYDiD466U7k3YWTq) | matched by `near contract verify` (2026-11-11) |
| Protected-account code, published by hash (global contract) | global code | `7PcFeeGqEvK1ZiqnoJXBUhohBgX9g1y76SAk6RoFDX8a` | [BuMSLcZ2...](https://testnet.nearblocks.io/txns/BuMSLcZ2x13ayxe4vmBPWdZwue5xC1cK8N4yQzEGdmzT) | matched by `near contract verify` (2026-11-11) |
| Risk board: enclave-signed scores, marks, decisions and the sealing key | [`risk.parry.testnet`](https://testnet.nearblocks.io/address/risk.parry.testnet) | `EVd56RoEga1Nrqsyeb81Aibk6k2QY8tDd49UQukoLiVg` | [AGq9Z6vx...](https://testnet.nearblocks.io/txns/AGq9Z6vx6fo9LNq4EfyJSWJ9HVu2poNpPX3tMPHi7x6j) | matched by `near contract verify` (2026-11-11) |
| Delta-neutral vault, `EARN` shares | [`vault.parry.testnet`](https://testnet.nearblocks.io/address/vault.parry.testnet) | `9c1tfY3TDGJDMjUCnriH1cza2eJZKXfJhCNRaFYshHQz` | [Hv7w1BYL...](https://testnet.nearblocks.io/txns/Hv7w1BYLhBCBbYnCxeGWXuT5TkFd2dbPRc9nS4MPhhp8) | matched by `near contract verify` (2026-11-11) |
| Pyth-interface price oracle with the testnet market shock | [`oracle.parry.testnet`](https://testnet.nearblocks.io/address/oracle.parry.testnet) | `2K81bAZJvapFWyQGQ2nPYA5tGRKPyZ4qiNFfNseqz8iM` | [8cvn41iv...](https://testnet.nearblocks.io/txns/8cvn41ivD68XY9NMAh1xM7xcNXd8Fr5eHixw3BMmLgE1) | matched by `near contract verify` (2026-11-11) |
| Rhea lending, mainnet's exact wasm | [`lending.parry.testnet`](https://testnet.nearblocks.io/address/lending.parry.testnet) | `6Nek1MZ8cwJJ2xMQAUWup9V5AToYS9rkTxJfwo6BCpFa` | [EoyGJoed...](https://testnet.nearblocks.io/txns/EoyGJoedMf222e1YjpD1Xbdy3q7fYXZcW55SYGEWeCgb) | mainnet's code hash |
| Test USDC with a faucet | [`usdc.parry.testnet`](https://testnet.nearblocks.io/address/usdc.parry.testnet) | `EHaWDn7qvuvqEu4uUE9DPCo3qPvRUmSQrgtZGvMen9U7` | [EuEKFymr...](https://testnet.nearblocks.io/txns/EuEKFymrVmpLJBZvAm1dDBgKvxJcJyFH7eTSP4Yg8cBM) | matched by `near contract verify` (2026-11-11) |
| Test booster token (the token code; Rhea lending's config names one) | [`boost.parry.testnet`](https://testnet.nearblocks.io/address/boost.parry.testnet) | `EHaWDn7qvuvqEu4uUE9DPCo3qPvRUmSQrgtZGvMen9U7` | [FenppYjV...](https://testnet.nearblocks.io/txns/FenppYjVodicXz44bN2ChN7tFS49APd3ybSnwJpubvMo) | matched by `near contract verify` (2026-11-11) |
<!-- contracts:end -->

## The repository

<img src="assets/readme/repository.png" alt="What is in the repository: Rust contracts, the guardian enclave, and the services, API and packages" width="960">

<img src="assets/readme/tree.png" alt="The file tree, with the account contract banded as the place the guardian's limits are enforced" width="960">

## Run it yourself

```bash
pnpm install
docker compose up                 # API, services and Postgres against the public testnet deployment
pnpm dev                          # the same without Docker (needs Postgres); the app on http://localhost:3000
```

Without keys the stack runs read-only: it reads testnet, scores positions and serves the API and the app.
`.env.example` lists every setting; the deploy script writes the service wallets to `.env.services`.

To run everything on a local NEAR node instead (no testnet funds needed):

```bash
contracts/scripts/fetch-fixtures.sh && contracts/scripts/build.sh
bun scripts/sandbox.ts            # a local node with lending, the exchange, wNEAR and Parry deployed
pnpm dev --sandbox                # the stack against it
bun scripts/scenarios.ts --sandbox
```

## Tests

```bash
pnpm test                         # TypeScript (database tests need TEST_DATABASE_URL)
pnpm test:contracts               # contract unit tests
pnpm test:sandbox                 # sandbox flows on real lending, exchange, wNEAR and LiNEAR code
cd enclave && cargo test          # the guardian program
pnpm typecheck && pnpm lint && pnpm security
pnpm verify                       # this README's claims, against testnet
```

## Use it from code

```ts
import { createParry } from "@parry/sdk";

const parry = createParry({ network: "testnet", apiUrl: "http://localhost:4000" }); // or the hosted API
const { position } = await parry.riskCheck("alice.testnet");
console.log(position?.score, position?.tier, position?.liqPrice, position?.ttlHours);
```

The SDK builds every contract call as plain data for a wallet to sign, seals policies to the enclave, and verifies decisions and reserve proofs: [`packages/sdk`](packages/sdk/README.md).

## Use it from an agent

The MCP server reads the Parry API at `PARRY_API_URL`: the hosted API (top of this page) or a local one from `pnpm dev`.
With `PARRY_AGENT_ACCOUNT_ID` and `PARRY_AGENT_PRIVATE_KEY` (a testnet account's own key) it also gets capped write tools.

Claude Code:

```bash
claude mcp add parry -e PARRY_API_URL=http://localhost:4000 -- npx -y @parry/mcp
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.parry]
command = "npx"
args = ["-y", "@parry/mcp"]
env = { PARRY_API_URL = "http://localhost:4000" }
```

Claude Desktop (`claude_desktop_config.json`):

```json
{ "mcpServers": { "parry": { "command": "npx", "args": ["-y", "@parry/mcp"], "env": { "PARRY_API_URL": "http://localhost:4000" } } } }
```

From a clone, the same server runs with `pnpm -F @parry/mcp build && node packages/mcp/dist/bin.js`, and the API serves it over Streamable HTTP at `/mcp`.
Read tools: `risk_check`, `get_position_risk`, `get_market`, `get_vault`, `get_reserves`, `get_guardian_log`, `verify_guardian_decision`, `simulate_rescue`, `get_rescue_route`, `get_status`; write tools: `create_protected_account`, `set_mandate`, `vault_deposit`, `vault_withdraw`, `paid_risk_check`.
The agent skill installs with `npx skills add Aliyaan-Nasir/Parry`, and the site serves [`llms.txt`](apps/web/public/llms.txt).

## Security

The trust model, the review method and every finding are in [`SECURITY.md`](SECURITY.md).
The guardian's limits are enforced by the account contract, not by the services: a compromised service can withhold a rescue, never misdirect funds.

## More

- [`AGENTS.md`](AGENTS.md): the architecture, every command, and where each NEAR primitive lives.
- [`JUDGES.md`](JUDGES.md): each judging criterion with its evidence.
- [`MAINNET.md`](MAINNET.md): what is ready for mainnet, how it was tested, and the go-live steps and costs.
- [`docs/api.md`](docs/api.md), [`docs/risk-model.md`](docs/risk-model.md).

## License

MIT
