/**
 * Builders for the owner's own closing actions: closing the Rhea position by selling collateral
 * (in rounds, `closeRheaRounds` drives them) or from the wallet, unwinding the whole account,
 * closing the Hyperliquid perp (a reduce-only order signed through Chain Signatures) and repaying
 * the Aave loan on an EVM chain (approve and repay, each an EIP-1559 transaction whose hash Chain
 * Signatures signs). Wrap the actions with `ownerCallAction` (a NEAR-account owner, which attaches
 * the gas they need) or `ownerRequest` (a passkey owner; the relayer attaches it).
 */

import { keccak_256 } from "@noble/hashes/sha3.js";
import { formatPrice, formatSize } from "@parryguard/core";
import { contractCall, ONE_YOCTO, type ContractCall } from "./calls.js";
import { concatBytes, fromHex, toHex, u128 } from "./encoding.js";
import { ownerActions, retryCloseAction, type OwnerAction } from "./owner.js";
import type { Closing, RheaLines } from "./types.js";

type Amount = string | number | bigint;

/**
 * `close_rhea { slippage_bps, pool_id }`: one close round through the exchange pool `poolId`
 * (`dexPool` in the API's `/v1/config`). A position that cannot let all the collateral it must
 * sell out at once (health under about 1.5) closes over several rounds: see `closeRheaRounds`.
 * Must be the only action; `ownerCallAction` attaches the 900 Tgas it needs.
 */
export const closeRheaAction = (o: { slippageBps: number; poolId: number }): OwnerAction => ownerActions.closeRhea(o);

/** Where a close stands, from `closing()` and the lending position. */
export type CloseStatus =
  /** No close in flight and no debt left (`collateral` is what is still supplied as collateral, inner units). */
  | { kind: "closed"; collateral: string }
  /** No close in flight and debt left: send `close_rhea` (again). */
  | { kind: "open"; debt: string; collateral: string }
  /** A round's callbacks are still running: read again in a few seconds. */
  | { kind: "in_flight"; closing: Closing }
  /** A round stopped after its swap at a `stuck_*` stage: send `retry_close` (anyone may). */
  | { kind: "stuck"; closing: Closing };

const sumLines = (xs: { balance: string }[] | undefined) => (xs ?? []).reduce((a, x) => a + BigInt(x.balance), 0n);

export function closeStatus(closing: Closing | null, position: RheaLines | null): CloseStatus {
  if (closing) return closing.stage.startsWith("stuck_") ? { kind: "stuck", closing } : { kind: "in_flight", closing };
  const debt = sumLines(position?.borrowed);
  const collateral = sumLines(position?.collateral).toString();
  return debt > 0n ? { kind: "open", debt: debt.toString(), collateral } : { kind: "closed", collateral };
}

export interface CloseRound {
  kind: "close" | "retry";
  txHash: string;
  /** Where the close stood after the round. */
  after: CloseStatus;
}

export interface CloseRoundsOptions {
  account: string;
  slippageBps: number;
  poolId: number;
  /** Reads `closing()` and the lending position (a `Parry` client has both). */
  read: { closing(accountId: string): Promise<Closing | null>; rheaPosition(accountId: string): Promise<RheaLines | null> };
  /**
   * Sends owner actions as the owner and resolves once they executed: `ownerCallAction` through a
   * wallet, or a passkey-signed `ownerRequest` through the relayer.
   */
  sendOwnerActions(actions: OwnerAction[]): Promise<{ txHash: string }>;
  /** Sends a plain contract call (for `retry_close`, which anyone may send). Without it a stuck close stops the loop. */
  sendCall?(call: ContractCall): Promise<{ txHash: string }>;
  /** Most transactions to send (default 4: a 1.425-health position closes in two). */
  maxRounds?: number;
  /** Called after each round; the next round waits for a returned promise (a UI may pause, a test may move the market). */
  onRound?(round: CloseRound): void | Promise<void>;
  /** How long to wait for a round still in flight, and how often to read (defaults 90 s and 3 s). */
  waitMs?: number;
  pollMs?: number;
}

export interface CloseRoundsResult {
  closed: boolean;
  status: CloseStatus;
  rounds: CloseRound[];
  /**
   * Why the loop stopped before the position closed: `rolled_back` (a round moved nothing: read the
   * transaction's `close_rolled_back` event), `stuck` (no `sendCall` for `retry_close`) or `max_rounds`.
   */
  stopped: "rolled_back" | "stuck" | "max_rounds" | null;
}

/**
 * Closes the Rhea position round by round: reads `closing()` and the position, sends `close_rhea`
 * while debt is left, `retry_close` when a round is stuck after its swap, and waits while a round
 * is in flight. Stops when the debt is gone, when a round repaid nothing (it was rolled back), or
 * after `maxRounds` transactions.
 */
export async function closeRheaRounds(o: CloseRoundsOptions): Promise<CloseRoundsResult> {
  const max = o.maxRounds ?? 4;
  const rounds: CloseRound[] = [];
  const read = async () => closeStatus(await o.read.closing(o.account), await o.read.rheaPosition(o.account));
  const settle = async (): Promise<CloseStatus> => {
    const end = Date.now() + (o.waitMs ?? 90_000);
    for (;;) {
      const s = await read();
      if (s.kind !== "in_flight") return s;
      if (Date.now() > end) throw new Error(`the close round ${s.closing.id} is still at stage ${s.closing.stage}: read closing() again later`);
      await new Promise((r) => setTimeout(r, o.pollMs ?? 3_000));
    }
  };
  let status = await settle();
  while (status.kind !== "closed") {
    if (rounds.length >= max) return { closed: false, status, rounds, stopped: "max_rounds" };
    if (status.kind === "stuck") {
      if (!o.sendCall) return { closed: false, status, rounds, stopped: "stuck" };
      const { txHash } = await o.sendCall(retryCloseAction(o.account));
      status = await settle();
      const round: CloseRound = { kind: "retry", txHash, after: status };
      rounds.push(round);
      await o.onRound?.(round);
      continue;
    }
    const before = status.kind === "open" ? BigInt(status.debt) : 0n;
    const { txHash } = await o.sendOwnerActions([closeRheaAction({ slippageBps: o.slippageBps, poolId: o.poolId })]);
    status = await settle();
    const round: CloseRound = { kind: "close", txHash, after: status };
    rounds.push(round);
    await o.onRound?.(round);
    if (status.kind === "open" && BigInt(status.debt) >= before) return { closed: false, status, rounds, stopped: "rolled_back" };
  }
  return { closed: true, status, rounds, stopped: null };
}

/**
 * Closing from the wallet: the owner sends the debt token to the protected account
 * (`ft_transfer`, 1 yoctoNEAR), then the account repays the whole debt and withdraws the
 * collateral (`[repay, withdraw]`, one owner call).
 */
export function closeFromWalletActions(o: { account: string; debtToken: string; debtAmount: Amount; collateralToken: string; collateralAmount: Amount }): {
  transfer: ContractCall;
  actions: OwnerAction[];
} {
  const debt = u128(o.debtAmount, "debtAmount");
  if (BigInt(debt) === 0n) throw new Error("debtAmount must be positive");
  return {
    transfer: contractCall(o.debtToken, "ft_transfer", { receiver_id: o.account, amount: debt, memo: "parry: close from wallet" }, { tgas: 30, deposit: ONE_YOCTO }),
    actions: [ownerActions.repay(o.debtToken, debt), ownerActions.withdraw(o.collateralToken, u128(o.collateralAmount, "collateralAmount"))],
  };
}

/**
 * `unwind { tokens, to? }`: revoke the mandate, withdraw every lending supply, send each listed
 * token and the spare NEAR to the owner (`to` is required for a passkey owner). Collateral that
 * backs a loan stays: close the position first. `ownerCallAction` attaches `unwindTgas`.
 */
export const unwindAction = (tokens: string[], to?: string): OwnerAction => ownerActions.unwind(tokens, to);

/**
 * A reduce-only immediate-or-cancel order that closes a Hyperliquid perp position of signed size
 * `size` (negative is short), priced `slippageBps` through the mark, signed by the owner through
 * the account (`hl_order`). Must be the only action.
 */
export function closePerpAction(o: { assetIndex: number; size: number; markPrice: number; szDecimals: number; slippageBps?: number; nonce?: number }): OwnerAction {
  if (!Number.isFinite(o.size) || o.size === 0) throw new Error("there is no position to close");
  if (!(o.markPrice > 0)) throw new Error("markPrice must be positive");
  const slip = (o.slippageBps ?? 100) / 10_000;
  const isBuy = o.size < 0;
  const price = o.markPrice * (isBuy ? 1 + slip : 1 - slip);
  const size = formatSize(Math.abs(o.size), o.szDecimals);
  if (Number(size) === 0) throw new Error("the position is smaller than the asset's size step");
  return ownerActions.hlOrder(
    { asset_index: o.assetIndex, is_buy: isBuy, price: formatPrice(price, o.szDecimals, isBuy), size, reduce_only: true, tif: "Ioc" },
    o.nonce ?? Date.now(),
  );
}

// ---------------------------------------------------------------------------------------------
// EIP-1559 and the two Aave calls, encoded as the account contract encodes them
// ---------------------------------------------------------------------------------------------

/** The Chain Signatures path the account's EVM address derives from. */
export const EVM_PATH = "parry-evm";

const be = (v: bigint): Uint8Array => (v === 0n ? new Uint8Array() : fromHex(v.toString(16).padStart(Math.ceil(v.toString(16).length / 2) * 2, "0")));
const len = (n: number, offset: number): Uint8Array => (n <= 55 ? Uint8Array.of(offset + n) : concatBytes(Uint8Array.of(offset + 55 + be(BigInt(n)).length), be(BigInt(n))));
const rlpBytes = (b: Uint8Array): Uint8Array => (b.length === 1 && b[0]! < 0x80 ? b : concatBytes(len(b.length, 0x80), b));
const word = (v: bigint): Uint8Array => fromHex(v.toString(16).padStart(64, "0"));
const address = (a: string): Uint8Array => {
  const b = fromHex(a.replace(/^0x/, ""));
  if (b.length !== 20) throw new Error(`${a} is not an EVM address`);
  return b;
};

export interface EvmTx {
  chainId: number;
  nonce: number;
  maxPriorityFeePerGas: bigint;
  maxFeePerGas: bigint;
  gasLimit: bigint;
  to: string;
  value: bigint;
  data: Uint8Array;
}

/** 0x02 || rlp([chainId, nonce, tip, maxFee, gas, to, value, data, []]) as hex. */
export function encodeEip1559(t: EvmTx): string {
  const fields = [be(BigInt(t.chainId)), be(BigInt(t.nonce)), be(t.maxPriorityFeePerGas), be(t.maxFeePerGas), be(t.gasLimit), address(t.to), be(t.value), t.data];
  const payload = concatBytes(...fields.map(rlpBytes), Uint8Array.of(0xc0));
  return `0x${toHex(concatBytes(Uint8Array.of(0x02), len(payload.length, 0xc0), payload))}`;
}

/** `approve(spender, amount)` calldata. */
export const approveCalldata = (spender: string, amount: bigint): Uint8Array => concatBytes(fromHex("095ea7b3"), word(BigInt(`0x${toHex(address(spender))}`)), word(amount));

/** Aave v3 `repay(asset, amount, 2, onBehalfOf)` calldata (variable rate). */
export const repayCalldata = (asset: string, amount: bigint, onBehalfOf: string): Uint8Array =>
  concatBytes(fromHex("573ade81"), word(BigInt(`0x${toHex(address(asset))}`)), word(amount), word(2n), word(BigInt(`0x${toHex(address(onBehalfOf))}`)));

export interface EvmSigningStep {
  kind: "approve" | "repay";
  /** The unsigned transaction (hex): add the MPC signature to it and broadcast it. */
  unsignedTx: string;
  /** keccak256 of the unsigned transaction: the hash Chain Signatures signs. */
  signingHash: string;
  /** `mpc_sign` at `parry-evm`, alone in its own owner call. */
  action: OwnerAction;
}

/**
 * The owner's Aave repay: an `approve` of the pool for exactly `amount` and the `repay` on behalf
 * of the account's own EVM address, at consecutive nonces. Each step's `action` is an `mpc_sign`
 * owner action (one owner call each); the returned signature completes `unsignedTx`.
 */
export function repayAaveActions(o: {
  chainId: number;
  /** The EVM address's next nonce. */
  nonce: number;
  pool: string;
  asset: string;
  amount: bigint;
  /** The account's derived EVM address (the borrower). */
  onBehalfOf: string;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  gasLimits?: { approve: bigint; repay: bigint };
}): [EvmSigningStep, EvmSigningStep] {
  if (o.amount <= 0n) throw new Error("amount must be positive");
  const gas = o.gasLimits ?? { approve: 80_000n, repay: 300_000n };
  const base = { chainId: o.chainId, maxFeePerGas: o.maxFeePerGas, maxPriorityFeePerGas: o.maxPriorityFeePerGas, value: 0n };
  const step = (kind: "approve" | "repay", tx: EvmTx): EvmSigningStep => {
    const unsignedTx = encodeEip1559(tx);
    const signingHash = toHex(keccak_256(fromHex(unsignedTx.slice(2))));
    return { kind, unsignedTx, signingHash, action: ownerActions.mpcSign(EVM_PATH, signingHash) };
  };
  return [
    step("approve", { ...base, nonce: o.nonce, gasLimit: gas.approve, to: o.asset, data: approveCalldata(o.pool, o.amount) }),
    step("repay", { ...base, nonce: o.nonce + 1, gasLimit: gas.repay, to: o.pool, data: repayCalldata(o.asset, o.amount, o.onBehalfOf) }),
  ];
}
