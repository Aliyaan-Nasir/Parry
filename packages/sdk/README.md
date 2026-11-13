# @parryguard/sdk

TypeScript client for Parry: liquidation protection under an on-chain mandate, and a delta-neutral NEAR vault.
It reads the Parry API and the chain, builds every contract call as plain data, seals mandate policies to the guardian enclave, and verifies what the guardian publishes.
It runs in browsers, Node 20+ and Bun.

## Install

```bash
npm install @parryguard/sdk
```

## Quick start

```ts
import { createParry, ownerActions, ownerCallAction, verifyDecision } from "@parryguard/sdk";

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
- `rates()`: every Rhea lending asset's rates, Hyperliquid's NEAR funding and the vault's yield, each with its source.
- `prices(tokens?)`: USD prices with 24 hour change.
- `replay()`: the crash replay.
- `heatmap({ network, asset })`: the liquidation heatmap and chained cascades.
- `verify(id)`: the API's re-check of a decision id, a certificate hash or a NEAR transaction hash.
- `routeSavings(account?)`, `vaultInsurance()`, `incidents(account)`: rescue route savings, the vault's insurance fund, grouped alerts.
- `watchlist(token)`, `watch(token, accountId, { thresholds, label })`, `unwatch(token, accountId)`: watched accounts (signed in).
- `issueCertificate(token, request)`, `certificates(account)`, `certificate(hash)`: health certificates.
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
- `signIn(accountId, privateKey)`: a session token for the API, signed with the owner's full-access key (NEP-413).
- `closing(accountId)`, `rheaPosition(accountId)`: the close round in flight on a protected account (null when none) and its Rhea lending position, read from the chain.
- `verifyCertificate(certificateOrHash, { reader })`: verifies a health certificate with the key the risk board trusted at issue time and the board's anchor.
- `subscribe({ events, account, onEvent })`: live updates over Server-Sent Events, polling where there is no EventSource; returns a stop function.

## Functions

Owner actions:

- `ownerActions`: a builder for every owner action (`setMandate`, `revokeMandate`, `pauseGuardian`, `clearPending`, `supply`, `borrow`, `repay`, `withdraw`, `call`, `transfer`, `ftTransfer`, `mpcSign`, `hlOrder`, `closeRhea`, `unwind`, `upgrade`).
- `ownerCallAction(account, actions, { protocolTokens? })`: `owner_call` for a NEAR-account owner, 1 yoctoNEAR, with the gas the actions need (`ownerActionsTgas`): 300 Tgas, 900 for a close, `unwindTgas(tokens)` (at least 600) for an unwind.
  One call may carry up to 1 PGas; the account refuses a close or unwind sent with less than its whole chain needs.
- `retryCloseAction(account)`: `retry_close()`, 400 Tgas, no deposit: resumes a close stuck after its swap (anyone may send it).
- `ownerRequest({ account, network, nonce, actions })`: the request text a passkey signs, and its WebAuthn challenge.
- `requestDigest(text)`: SHA-256 of the domain-separated request, the challenge.
- `assertionFromWebAuthn(credential)`: a browser passkey assertion in the contract's form (low-s r and s in hex).
- `derToRawSignature(der)`: a DER P-256 signature as 64 bytes, low-s.
- `compressedPasskey(key)`: a passkey public key as 66 hex characters.
- `closeRheaAction({ slippageBps, poolId })`: one `close_rhea` round through the exchange pool `poolId` (`dexPool` in `/v1/config`); slippage is 1 to 1000 bps.
  A round sells at most the collateral that keeps health at 1.02, so a position under about 1.5 health closes over several rounds (`close_progress`, then `position_closed`); a failed step before the swap restores the round (`close_rolled_back`).
- `closeRheaRounds({ account, slippageBps, poolId, read, sendOwnerActions, sendCall?, maxRounds?, onRound? })` (or `parry.closeRheaRounds` with the client's reads): sends rounds until no debt is left, `retry_close` for a stuck round, and waits while a round is in flight; `closeStatus(closing, position)` says where a close stands (`closed`, `open`, `in_flight`, `stuck`).
- `closeFromWalletActions(...)`, `unwindAction(tokens, to?)`: closing the Rhea position with the owner's own debt tokens, and unwinding the account (at most 16 tokens).
- `closePerpAction(...)`: a reduce-only order that closes a Hyperliquid perp; `repayAaveActions(...)`: the approve and repay transactions of an Aave loan, each with its `mpc_sign` action.

Mandates:

- `buildMandate(input)`: a mandate, checked as the contract checks it, with the policy sealed when given.
- `sealPolicy(policy, { account, sealingPublicKey })`: encrypts trigger thresholds and strategy to the enclave.
- `openPolicy(sealed, { account, secret })`: opens a sealed policy with a known secret (tests and tools).
- `policyJson(policy)`: the exact plaintext the enclave reads.
- `defaultSteps(strategy)`, `STRATEGY_STEPS`: the order the planner tries protective steps in; a policy's `steps` overrides it.

Verification:

- `verifyDecision(decision, { enclavePublicKey })`: checks the review hash, the signed exchange, the model's signature, the envelope's signature, the envelope's review hash and the decision id.
- `verifyReserves(reserves, { onChainRoot })`: checks every reserve proof and recomputes the root.
- `verifyCertificate(certificate, { enclaveHistory, reader, anchor, now })`: checks a health certificate's hash, statement, signature, expiry, reader and anchor.
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
