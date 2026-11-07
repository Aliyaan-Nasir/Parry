/**
 * Contract calls as plain data: one shape that a NEAR Connect or wallet selector wallet signs
 * (`wallet.signAndSendTransaction(call)`, which reads `receiverId` and `actions`) and that near-kit
 * sends (`near.call(call.receiverId, call.methodName, call.args, nearKitCallOptions(call))`).
 */

export const TGAS = 1_000_000_000_000n;
export const ONE_YOCTO = "1";

/** A wallet (NEAR Connect, wallet selector) FunctionCall action. */
export interface WalletFunctionCallAction {
  type: "FunctionCall";
  params: { methodName: string; args: Record<string, unknown>; gas: string; deposit: string };
}

export interface ContractCall {
  receiverId: string;
  methodName: string;
  args: Record<string, unknown>;
  /** Gas units, decimal string (300 Tgas is "300000000000000"). */
  gas: string;
  /** yoctoNEAR, decimal string. */
  deposit: string;
  /** The same call as a wallet transaction's actions. */
  actions: [WalletFunctionCallAction];
}

export function contractCall(
  receiverId: string,
  methodName: string,
  args: Record<string, unknown>,
  opts: { tgas: number | bigint; deposit?: string | bigint },
): ContractCall {
  const gas = (BigInt(opts.tgas) * TGAS).toString();
  const deposit = BigInt(opts.deposit ?? 0).toString();
  return {
    receiverId,
    methodName,
    args,
    gas,
    deposit,
    actions: [{ type: "FunctionCall", params: { methodName, args, gas, deposit } }],
  };
}

/** Options for near-kit's `near.call` and `transaction().functionCall`. */
export function nearKitCallOptions(call: ContractCall): { gas: `${number}`; attachedDeposit: bigint } {
  return { gas: call.gas as `${number}`, attachedDeposit: BigInt(call.deposit) };
}
