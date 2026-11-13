// Contract calls made from the protected account: an SDK ContractCall (vault deposit, withdrawal,
// claim) becomes the owner action `call`, so the account itself is the caller and holds the result.

import { ownerActions, TGAS, type ContractCall, type OwnerAction } from "@parryguard/sdk";

/** The owner action that makes the protected account send `call` (with its deposit and gas). */
export function asOwnerCall(call: ContractCall): OwnerAction {
  const tgas = Number(BigInt(call.gas) / TGAS);
  return ownerActions.call({ receiverId: call.receiverId, methodName: call.methodName, args: call.args, deposit: call.deposit, tgas: Math.min(300, Math.max(1, tgas)) });
}

/** NEAR an account keeps for its own storage and gas when it sends NEAR on (yoctoNEAR). */
export const ACCOUNT_RESERVE_YOCTO = 50_000_000_000_000_000_000_000n; // 0.05 NEAR
