/**
 * `createParry`: one client for a network, with API reads (when an `apiUrl` is given), chain
 * reads (always), call builders and verification.
 */

import type { Near } from "near-kit";
import { apiMethods, ParryApi, ParryApiError, type ApiMethods, type FetchLike } from "./api.js";
import { contractCall, ONE_YOCTO, type ContractCall } from "./calls.js";

/** LiNEAR's NEP-145 storage bound, in yoctoNEAR (0.00125 NEAR). */
const LINEAR_STORAGE = "1250000000000000000000";
import { chainReads, nearClient, sendCall, type ChainReads, type SentCall } from "./chain.js";
import { u128 } from "./encoding.js";
import { NETWORKS, isNetwork, type ContractIds, type Network } from "./networks.js";
import { ownerRequest, type OwnerRequest, type OwnerRequestInput } from "./owner.js";
import type { Decision, RiskCheck } from "./types.js";
import { verifyDecision, type DecisionVerification } from "./verify.js";
import {
  decodePaymentResponse,
  encodePaymentHeader,
  PAYMENT_HEADER,
  PAYMENT_RESPONSE_HEADER,
  signPaymentDelegate,
  X402_VERSION,
  type PaymentRequired,
  type PaymentRequirements,
  type PaymentResponse,
} from "./x402.js";

export interface ParryOptions {
  network: Network;
  /** The Parry API, for API reads, relays and paid checks. Chain reads work without it. */
  apiUrl?: string;
  /** NEAR RPC; defaults to near-kit's endpoint for the network. */
  rpcUrl?: string;
  /** Overrides of the network's contract ids. */
  contracts?: Partial<ContractIds>;
  /** A fetch implementation for API calls (defaults to the global fetch). */
  fetch?: FetchLike;
}

export interface NearSigner {
  accountId: string;
  /** `ed25519:<base58>` full-access key. */
  privateKey: string;
}

export interface PaidOptions {
  payer: NearSigner;
  /** Refuse to pay more than this (token units). */
  maxAmount?: string | bigint;
  /** The token the payment must be in; defaults to the network's USDC. */
  asset?: string;
}

export interface PaidResult<T> {
  result: T;
  /** The decoded `X-PAYMENT-RESPONSE`, or null when the endpoint did not ask for payment. */
  payment: PaymentResponse | null;
  /** What was paid for, or null when no payment was needed. */
  requirement: PaymentRequirements | null;
}

/** A Parry client: API reads and relays (`ApiMethods`), chain reads (`ChainReads`), and the rest. */
export interface Parry extends ApiMethods, ChainReads {
  readonly network: Network;
  readonly contracts: Readonly<ContractIds>;
  /** Parry contracts not deployed on this network (unless overridden). */
  readonly notDeployed: ReadonlyArray<keyof ContractIds>;
  /** The near-kit client used for chain reads. */
  readonly near: Near;
  readonly api: ParryApi;
  /** A risk check paid per call over x402 on NEAR, signed by `payer`. */
  paidRiskCheck(accountId: string, opts: PaidOptions): Promise<PaidResult<RiskCheck>>;
  /** An owner request for this client's network (see `ownerRequest`). */
  ownerRequest(input: Omit<OwnerRequestInput, "network">): OwnerRequest;
  /** `deposit` on the vault with the attached NEAR (yoctoNEAR), 150 Tgas. */
  vaultDepositAction(amountYocto: string | bigint): ContractCall;
  /** wNEAR deposit: `ft_transfer_call` of wNEAR to the vault with msg "deposit", 1 yoctoNEAR, 300 Tgas. */
  vaultDepositWNearAction(amountYocto: string | bigint): ContractCall;
  /** `request_withdraw(shares)` on the vault (share units), 1 yoctoNEAR, 30 Tgas. */
  requestWithdrawAction(shares: string | bigint): ContractCall;
  /** `claim()` on the vault: pays failed transfers and owed USDC, 150 Tgas. */
  claimAction(): ContractCall;
  /**
   * NEP-145 registration of `accountId` with the LiNEAR token, which vault withdrawals pay out in
   * (0.00125 NEAR, refunded when already registered). Send it before `request_withdraw` and
   * `claim`: an unregistered account's payout waits as a claim.
   */
  linearStorageAction(accountId: string): ContractCall;
  /** Signs a call with a full-access key and sends it, waiting for optimistic execution. */
  sendCall(call: ContractCall, signer: NearSigner): Promise<SentCall>;
  /**
   * Verifies a decision (or the decision with this id, read from the API) against the enclave
   * key read from the risk board, unless a key is given.
   */
  verifyDecision(decision: Decision | string, opts?: { enclavePublicKey?: string }): Promise<DecisionVerification>;
}

export function createParry(options: ParryOptions): Parry {
  if (!isNetwork(options.network)) throw new Error('network must be "testnet" or "mainnet"');
  const network = options.network;
  const defaults = NETWORKS[network];
  const overrides = Object.fromEntries(Object.entries(options.contracts ?? {}).filter(([, v]) => v !== undefined)) as Partial<ContractIds>;
  const contracts: ContractIds = { ...defaults.contracts, ...overrides };
  const overridden = new Set(Object.keys(overrides));

  /** A contract id, refusing Parry contracts that are not deployed on this network yet. */
  const contract = (name: keyof ContractIds): string => {
    if (defaults.notDeployed.includes(name) && !overridden.has(name)) {
      throw new Error(`Parry's ${name} contract is not deployed on ${network} yet: pass contracts.${name} to use another id`);
    }
    const id = contracts[name];
    if (!id) throw new Error(`no ${name} contract on ${network}`);
    return id;
  };

  const api = new ParryApi(options.apiUrl, options.fetch);
  const near: Near = nearClient({ network, ...(options.rpcUrl ? { rpcUrl: options.rpcUrl } : {}) });
  const reads = apiMethods(api);
  const chain = chainReads(near, contract);
  const signerClient = (signer: NearSigner) => nearClient({ network, ...(options.rpcUrl ? { rpcUrl: options.rpcUrl } : {}) }, signer);

  async function paid<T>(path: string, opts: PaidOptions): Promise<PaidResult<T>> {
    const first = await api.raw(path);
    if (first.status !== 402) {
      const body = await readJson(first);
      if (!first.ok) throw new ParryApiError(first.status, path, body);
      return { result: body as T, payment: null, requirement: null };
    }
    const required = (await readJson(first)) as PaymentRequired;
    const req = required?.accepts?.[0];
    if (!req) throw new Error(`${path} asked for payment but named no accepted payment`);
    if (req.scheme !== "exact") throw new Error(`unsupported payment scheme ${req.scheme}`);
    if (req.network !== `near:${network}`) throw new Error(`payment asked on ${req.network}, this client is on near:${network}`);
    const asset = opts.asset ?? contracts.usdc;
    if (req.asset !== asset) throw new Error(`payment asked in ${req.asset}, expected ${asset}`);
    if (!/^\d+$/.test(req.amount)) throw new Error("payment amount is not a decimal integer");
    if (opts.maxAmount !== undefined && BigInt(req.amount) > BigInt(opts.maxAmount)) {
      throw new Error(`payment of ${req.amount} is above the limit of ${opts.maxAmount}`);
    }
    const signedDelegateAction = await signPaymentDelegate(signerClient(opts.payer), opts.payer.accountId, req);
    const header = encodePaymentHeader({ x402Version: X402_VERSION, scheme: "exact", network: req.network, payload: { signedDelegateAction } });
    const second = await api.raw(path, { headers: { [PAYMENT_HEADER]: header } });
    const responseHeader = second.headers.get(PAYMENT_RESPONSE_HEADER);
    const payment = responseHeader ? decodePaymentResponse(responseHeader) : null;
    const body = await readJson(second);
    if (!second.ok) throw new ParryApiError(second.status, path, payment?.errorReason ? { error: payment.errorReason, body } : body);
    return { result: body as T, payment, requirement: req };
  }

  return {
    network,
    contracts,
    notDeployed: defaults.notDeployed.filter((n) => !overridden.has(n)),
    near,
    api,
    ...reads,
    ...chain,
    paidRiskCheck: (accountId, opts) => paid<RiskCheck>(`/v1/paid/risk/${encodeURIComponent(accountId)}`, opts),
    ownerRequest: (input) => ownerRequest({ ...input, network }),
    vaultDepositAction: (amountYocto) => contractCall(contract("vault"), "deposit", {}, { tgas: 150, deposit: u128(amountYocto, "amountYocto") }),
    vaultDepositWNearAction: (amountYocto) =>
      contractCall(contracts.wnear, "ft_transfer_call", { receiver_id: contract("vault"), amount: u128(amountYocto, "amountYocto"), msg: "deposit" }, { tgas: 300, deposit: ONE_YOCTO }),
    requestWithdrawAction: (shares) => contractCall(contract("vault"), "request_withdraw", { shares: u128(shares, "shares") }, { tgas: 30, deposit: ONE_YOCTO }),
    claimAction: () => contractCall(contract("vault"), "claim", {}, { tgas: 150 }),
    linearStorageAction: (accountId) => contractCall(contracts.linear, "storage_deposit", { account_id: accountId, registration_only: true }, { tgas: 10, deposit: LINEAR_STORAGE }),
    sendCall: (call, signer) => sendCall(signerClient(signer), signer.accountId, call),
    verifyDecision: async (decision, opts = {}) => {
      const d = typeof decision === "string" ? await reads.decision(decision) : decision;
      const key = opts.enclavePublicKey ?? (await chain.enclave()).key.public_key;
      return verifyDecision(d, { enclavePublicKey: key });
    },
  };
}


async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}
