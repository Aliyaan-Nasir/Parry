# Mainnet

Parry is live on NEAR testnet and mainnet-ready: the same contracts, enclave and services switch networks with one setting, against the live mainnet protocols.
This file covers what is ready, how it was rehearsed, the exact launch steps and what each costs.

## What is ready

One switch selects the network everywhere: `PARRY_NETWORK=mainnet` for the services, the API, the scripts and the enclave build, and `NEXT_PUBLIC_PARRY_NETWORK=mainnet` for the app.
The SDK and the MCP server take `network: "mainnet"` (or `PARRY_NETWORK`).

On mainnet, Parry deploys only its own contracts and uses the live protocols for everything else (`deployments/mainnet.json`):

| Role | Mainnet account | Why this one |
| --- | --- | --- |
| Lending | `contract.main.burrow.near` | Rhea lending; testnet runs the same wasm (code hash `6Nek1MZ8cwJJ2xMQAUWup9V5AToYS9rkTxJfwo6BCpFa`) |
| Price oracle | `aggregate-oracle.near` | the lending contract's own `pyth_oracle_account_id`, so the account prices a deleverage exactly as lending liquidates |
| Exchange | `v2.ref-finance.near`, pool 4512 | the deepest native USDC and wNEAR pool |
| Tokens | `wrap.near`, native USDC (`17208628...36133a1`), LiNEAR (`linear-protocol.near`) | with the lending contract's own decimals (USDC has 12 extra) |
| Chain Signatures | `v1.signer` | the MPC network's mainnet signer |
| Hyperliquid | mainnet API, NEAR perp asset 74 | order digests take the mainnet source (`"a"`) |
| EVM rescue | Aave v3 on Base (8453), pool `0xA238Dd80C259a72e81d7e4664a9801593F98d1c5` | the MPC network verifies Base transactions |
| TEE | OutLayer (`outlayer.near`) | the enclave build for mainnet compiles all of the above in |
| Review model | NEAR AI Cloud, `z-ai/glm-5.3-flash` | the same verifiable endpoint as testnet |
| Rescue routes | NEAR Intents 1Click | quotes with `dry: true`; confidential quotes with a partner key |
| Confidential rescue reserve | NEAR Intents Agent API | an owner-signed policy that only swaps wNEAR and USDC on confidential routes and withdraws into the protected account (`services/src/lib/intents.ts`, tested offline) |
| Hedge margin | 1Click, USDC on NEAR to USDC on HyperCore | the keeper records a dry-run quote whenever the hedge needs margin |

What changes on mainnet, in code:

- The account, factory, risk board and vault carry `network: "mainnet"`, so envelopes, owner requests and Hyperliquid digests take their mainnet form and cannot be replayed across networks.
- The market shock, the test token faucets and the testnet oracle do not exist: the oracle contract refuses to initialise for any network but testnet, and the API and relayer refuse the shock.
- The MCP server's write tools are listed but refuse every call on mainnet.
- `enclave/build.sh` with `PARRY_NETWORK=mainnet` compiles the mainnet ids, endpoints and exchange pool into the enclave, so the mainnet program has its own hash and its own keys.
- `scripts/deploy.ts --network mainnet` deploys only Parry's contracts and wires them to the accounts above; without `--confirm-mainnet` it only prints the plan and its cost.

## How it was tested

- **A mainnet rehearsal on a local sandbox** (`contracts/tests/tests/mainnet.rs`): the code mainnet runs today for Rhea lending, wNEAR, the Rhea exchange, LiNEAR and native USDC is imported under its mainnet account ids, and Parry is configured as `deployments/mainnet.json` plans it.
  A full rescue (a repay, then an atomic deleverage on a real-code pool) and a vault cycle (a deposit into real-code LiNEAR, a mainnet hedge order, a withdrawal) run end to end.
  Run it with `cd contracts && cargo test -p parry-sandbox-tests --test mainnet`.
- Covered outside the rehearsal, each by its own tests and its live run on testnet: Chain Signatures (a stand-in answers at `v1.signer`'s id; the signatures themselves run on testnet's MPC network), the live oracle feed (Parry's Pyth-interface code stands in at `aggregate-oracle.near`'s id with posted prices), and the off-chain services (OutLayer, NEAR AI, 1Click, Hyperliquid).
- **The deploy plan**: `bun scripts/deploy.ts --network mainnet` reads the reproducible builds and prints every account, balance and cost below, and whether the root exists and its key is present.
- **The mainnet enclave build**: `PARRY_NETWORK=mainnet enclave/build.sh` builds and prints the compiled-in ids and the program hash.

## Costs

One-time, from the deploy plan (storage at 1 NEAR per 100 kB; global code burns ten times its storage):

| NEAR | What |
| ---: | --- |
| 4.00 | `risk.<root>` with the risk board (311 kB of code) |
| 4.00 | `vault.<root>` with the vault (307 kB) |
| 3.00 | `accounts.<root>` with the factory (184 kB) |
| 19.50 | service wallets: treasury 5, relayer 5, keeper 3, monitor 2, guardian 2, enclave 2, api 0.5 (the monitor, keeper and relayer prepay 0.5, 2 and 1 of theirs into gas keys) |
| 36.41 | publishing the protected-account code by hash (364 kB, burnt) |
| 1.00 | transaction fees and token storage registrations |
| **67.91** | **total from the root account** |

Plus the root account's registration, done with a wallet.
`parry.near` is taken; `deployments/mainnet.json` plans `parryguard.near`, which was free on 2026-11-10.

Running costs:

- **OutLayer**: `estimate_execution_cost` on `outlayer.near` returns 0.010005 NEAR for Parry's resource budget (50 billion instructions, 256 MB, 90 s); that is the most a run can cost, and what a run does not use is refunded.
  The services run the enclave for the risk report (every 5 minutes), the vault report (every 5 minutes) and each guardian pass, so at most about 6 NEAR a day at testnet's cadence; `RISK_PUBLISH_MS` and `VAULT_REPORT_MS` set it.
- **NEAR AI Cloud**: `z-ai/glm-5.3-flash` lists $0.08 per million input tokens and $0.50 per million output tokens; a review is about 2,000 tokens in and 300 out, so well under a tenth of a cent.
- **Gas**: at NEAR's minimum gas price (0.0001 NEAR per Tgas), each signed report costs a few thousandths of a NEAR in gas; the guardian's actions and the keeper's hedge orders add to it only when they happen.
- **Accounts**: the factory takes at least 0.25 NEAR to create a protected account; the relayer pays it, so a mainnet relayer needs a daily account budget (`RELAYER_DAILY_ACCOUNTS`).
- **Hyperliquid margin**: the vault's short needs USDC margin at its derived address on Hyperliquid, at most 3x leverage at a 90 % hedge; for the planned 1,000 NEAR deposit cap that is about a third of the hedged value, plus a buffer.

## Go-live steps

The launch is these steps, in order; each is one command against the reproducible builds.

1. **Register the root.**
   Register `parryguard.near` (or another free name, set in `deployments/mainnet.json` and the `#mainnet` ids in `services/src/lib/config.ts` and `packages/sdk/src/networks.ts`) with a mainnet wallet, fund it with at least 70 NEAR, and put its full-access key at `~/.near-credentials/mainnet/<root>.json`.
2. **Build reproducibly** at the commit to launch (the release commit on the main branch): `contracts/scripts/build.sh --reproducible <commit>`.
3. **Check the plan**: `bun scripts/deploy.ts --network mainnet --wasm-dir contracts/target/near-reproducible/<commit>`.
4. **Create the accounts and wallets**: run the same command with `--confirm-mainnet`.
   It stops at the risk board until the enclave's key exists, and writes the service keys to `.env.services.mainnet` (gitignored).
5. **Publish the enclave**: `outlayer login mainnet` with `enclave.<root>`'s key, then `PARRY_NETWORK=mainnet NEARAI_API_KEY=... bun scripts/enclave.ts publish` and `PARRY_NETWORK=mainnet bun scripts/enclave.ts keys`.
6. **Finish the deploy**: `bun scripts/deploy.ts --network mainnet --confirm-mainnet --wasm-dir ... --enclave-key <key> --enclave-wasm-sha256 <hash>` deploys the risk board (with the sealing key), the vault, the account code and the factory.
7. **Fund the hedge**: deposit USDC margin on Hyperliquid at the vault's Chain Signatures address: `derived_public_key` on `v1.signer` with path `parry-vault-hedge` and the vault as predecessor, also shown as `hedge.address` by the API's `/v1/vault`.
8. **Run the services** with `PARRY_NETWORK=mainnet` and `.env.services.mainnet`, and build the app with `NEXT_PUBLIC_PARRY_NETWORK=mainnet`.
   For private rescue swaps, add a NEAR Intents partner key (`NEAR_INTENTS_AGENT_API_KEY`) and `ONECLICK_JWT`; each owner then signs their rescue reserve's policy in the app.
9. **Verify**: `near contract verify deployed-at <account>` for `risk`, `vault` and `accounts`, then `PARRY_NETWORK=mainnet pnpm verify --quick`.
