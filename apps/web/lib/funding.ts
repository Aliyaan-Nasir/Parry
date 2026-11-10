// NEAR the protected account must hold before it can spend some (wrap, deposit in the vault).

import { ACCOUNT_RESERVE_YOCTO } from "./calls";
import { chain } from "./parry";
import { toUnits } from "./units";

/** The account's spendable NEAR in yoctoNEAR. */
export async function spendableYocto(account: string): Promise<bigint> {
  const c = await chain();
  const balance = await c.near.getBalance(account);
  return toUnits(balance, 24) ?? 0n;
}

/** How much NEAR the account lacks to spend `amountYocto` and keep its own reserve (0 when none). */
export async function shortfallYocto(account: string, amountYocto: bigint): Promise<bigint> {
  const have = await spendableYocto(account);
  const need = amountYocto + ACCOUNT_RESERVE_YOCTO - have;
  return need > 0n ? need : 0n;
}
