# @parry/sdk

TypeScript client for Parry: liquidation protection under an on-chain mandate, and a delta-neutral NEAR vault.
It reads the Parry API and the chain, builds every contract call as plain data, seals mandate policies to the guardian enclave, and verifies what the guardian publishes.
It runs in browsers, Node 20+ and Bun.

## Install

```bash
npm install @parry/sdk
```

## Quick start

```ts
import { createParry, ownerActions, ownerCallAction, verifyDecision } from "@parry/sdk";

const parry = createParry({ network: "testnet", apiUrl: process.env.PARRY_API_URL });

// Chain reads need no API.
const account = await parry.protectedAccountId({ nearAccount: "alice.testnet" });
const mandate = await parry.mandate(account);

// API reads are typed.
const market = await parry.market();
const { items } = await parry.decisions({ account, limit: 5 });

// Calls are data: a NEAR Connect wallet (here `wallet`) signs them as they are.
const call = ownerCallAction(account, [ownerActions.revokeMandate()]);
await wallet.signAndSendTransaction(call);

// Check a guardian decision against the enclave key on the risk board.
const { key } = await parry.enclave();
const report = verifyDecision(items[0], { enclavePublicKey: key.public_key });
```

## Networks

`createParry({ network: "testnet" | "mainnet" })` picks the contract ids for that network.
Every id can be overridden with `contracts: { vault: "..." }`, and `rpcUrl` replaces the default RPC.
On mainnet, Parry's own contracts (factory, vault, risk board) are not deployed yet: calls that need them throw until you pass an id.
The `apiUrl` is optional: chain reads and every builder work without it.

## The client

`createParry(options)` returns one client with these members.

API reads:

- `stats()`: live counters (protected positions, rescues, vault TVL and risk).
- `config()`: network, contract ids, the enclave's keys, the review model and explorer URLs.
- `market()`: NEAR price, the Tremor volatility index and cascade pressure.
- `account(id)`: a protected account with its owner, mandate and positions.
- `positions(id)`: the account's positions with their risk.
- `history(positionId, hours)`: health, score and price over time.
- `riskCheck(accountId)`: the risk of any NEAR account's lending position.
- `simulate(accountId)`: what the guardian would do now, unsigned.
- `decisions({ account, limit, cursor })`: guardian decisions, newest first.
- `decision(id)`: one guardian decision.
- `verification(id)`: the API's own verification of a decision.
- `alerts(account, { status })`: alerts for an account.
- `vault()`: vault state, risk score, hedge and reserves summary.
- `vaultHistory(days)`: vault share price, NAV and risk over time.
- `reserves()`: every reserve leaf with its Merkle proof.
- `rates()`: lending rates and the vault's yield.
- `status()`: services, oracle freshness and treasury.
- `rescueQuote(amountNear)`: the rescue swap route comparison.

Relays (the relayer pays the gas):

- `createProtectedAccount({ passkey } | { nearAccount })`: creates a protected account.
- `relayOwnerRequest(text, assertion)`: relays a passkey-signed owner request.
- `relayDelegate(signedDelegateAction)`: relays a NEP-366 signed delegate action.

Chain reads:

- `protectedAccountId({ passkey } | { nearAccount })`: the protected account address of an owner, from the factory.
- `mandate(accountId)`: the mandate with its live counters, or null.
- `nonces(accountId)`: the last owner and guardian nonces.
- `vaultState()`: the vault contract's own state.
- `enclave()`: the enclave's signing key and sealing key from the risk board.

Calls and payments:

- `vaultDepositAction(amountYocto)`: `deposit` on the vault with the attached NEAR, 150 Tgas.
- `vaultDepositWNearAction(amountYocto)`: a wNEAR deposit through `ft_transfer_call`.
- `requestWithdrawAction(shares)`: queues a withdrawal of vault shares.
- `claimAction()`: pays the caller's vault claims.
- `sendCall(call, { accountId, privateKey })`: signs a call with a full-access key and sends it.
- `ownerRequest({ account, nonce, actions })`: an owner request for the client's network.
- `verifyDecision(decisionOrId)`: verifies a decision with the key read from the risk board.
- `paidRiskCheck(accountId, { payer, maxAmount })`: a risk check paid per call over x402 on NEAR.

## Functions

Owner actions:

- `ownerActions`: a builder for every owner action (`setMandate`, `revokeMandate`, `pauseGuardian`, `clearPending`, `supply`, `borrow`, `repay`, `withdraw`, `call`, `transfer`, `ftTransfer`, `mpcSign`, `hlOrder`, `upgrade`).
- `ownerCallAction(account, actions)`: `owner_call` for a NEAR-account owner, 1 yoctoNEAR, 300 Tgas.
- `ownerRequest({ account, network, nonce, actions })`: the request text a passkey signs, and its WebAuthn challenge.
- `requestDigest(text)`: SHA-256 of the domain-separated request, the challenge.
- `assertionFromWebAuthn(credential)`: a browser passkey assertion in the contract's form (low-s r and s in hex).
- `derToRawSignature(der)`: a DER P-256 signature as 64 bytes, low-s.
- `compressedPasskey(key)`: a passkey public key as 66 hex characters.

Mandates:

- `buildMandate(input)`: a mandate, checked as the contract checks it, with the policy sealed when given.
- `sealPolicy(policy, { account, sealingPublicKey })`: encrypts trigger thresholds and strategy to the enclave.
- `openPolicy(sealed, { account, secret })`: opens a sealed policy with a known secret (tests and tools).
- `policyJson(policy)`: the exact plaintext the enclave reads.

Verification:

- `verifyDecision(decision, { enclavePublicKey })`: checks the review hash, the signed exchange, the model's signature, the envelope's signature, the envelope's review hash and the decision id.
- `verifyReserves(reserves, { onChainRoot })`: checks every reserve proof and recomputes the root.
- `reviewHash(review)`: the review hash the account emits with each action.
- `envelopeDigest(envelope)`: the digest the enclave signs.
- `recoverEip191Address(text, signature)`: the address that signed a model review.

x402 on NEAR:

- `encodePaymentHeader(payment)` and `decodePaymentHeader(header)`: the `X-PAYMENT` header.
- `encodePaymentResponse(response)` and `decodePaymentResponse(header)`: the `X-PAYMENT-RESPONSE` header.
- `parseSignedDelegate(base64)`: sender, receiver, actions, nonce, max block height and public key of a signed delegate action.
- `verifySignedDelegate(base64)`: checks its ed25519 signature over the NEP-461 hash.
- `verifyPayment(payment, requirements, { blockHeight })`: checks a payment against what was asked.
- `checkDelegateOnChain(near, delegate)`: checks the payer's full-access key, its nonce and the expiry on chain.
- `signPaymentDelegate(near, payerId, requirements)`: signs the `ft_transfer` a payment needs.

Helpers:

- `contractCall(receiverId, methodName, args, { tgas, deposit })`: any call in the same shape.
- `nearKitCallOptions(call)`: the gas and deposit options near-kit expects.
- `NETWORKS`: the contract ids per network.
- `toBase64`, `fromBase64`, `toBase64Url`, `toHex`, `fromHex`, `toBase58`, `fromBase58`, `nearToYocto`, `yoctoToNear`: encodings and units.

## License

MIT
