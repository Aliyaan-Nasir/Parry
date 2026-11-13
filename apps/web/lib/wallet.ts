// NEAR wallets through NEAR Connect (HOT, Meteor, Intear and the rest of its manifest). The
// connector touches window, localStorage and IndexedDB, so it is created in the browser only, on
// first use.

import type { NearConnector, NearWalletBase } from "@hot-labs/near-connect";
import type { ContractCall } from "@parryguard/sdk";
import { nearRpcUrl, network } from "./env";

export const WALLET_STORAGE_KEY = "parry-wallet";

/** The connected wallet account this browser remembers, so pages can read before the connector loads. */
export interface StoredWallet {
  accountId: string;
  walletId: string | null;
}

export function isStoredWallet(v: unknown): v is StoredWallet {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.accountId === "string" && o.accountId.length > 1 && (o.walletId === null || typeof o.walletId === "string");
}

let connector: Promise<NearConnector> | null = null;

/** The NEAR Connect connector, created once. */
export function getConnector(): Promise<NearConnector> {
  connector ??= import("@hot-labs/near-connect")
    .then(async ({ NearConnector }) => {
      const c = new NearConnector({
        network,
        features: { signAndSendTransaction: true, [network]: true },
        ...(nearRpcUrl ? { providers: { [network]: [nearRpcUrl] } } : {}),
        footerBranding: null,
      });
      await c.whenManifestLoaded;
      return c;
    })
    .catch((e: unknown) => {
      connector = null;
      throw e;
    });
  return connector;
}

/** A transaction hash from a wallet's outcome (wallets return the RPC's final outcome). */
export function outcomeHash(outcome: unknown): string | null {
  const o = outcome as { transaction?: { hash?: unknown }; transaction_outcome?: { id?: unknown } } | null;
  const h = o?.transaction?.hash ?? o?.transaction_outcome?.id;
  return typeof h === "string" ? h : null;
}

/** The first failure in a wallet's outcome, transaction or receipt, or null when it succeeded. */
export function outcomeFailure(outcome: unknown): string | null {
  const o = outcome as {
    status?: { Failure?: unknown };
    receipts_outcome?: { outcome?: { status?: { Failure?: unknown } } }[];
  } | null;
  const failure = o?.status?.Failure ?? o?.receipts_outcome?.find((r) => r.outcome?.status?.Failure)?.outcome?.status?.Failure;
  if (!failure) return null;
  const text = JSON.stringify(failure);
  const panic = /"(?:ExecutionError|panic_msg)":"([^"]+)"/.exec(text);
  return panic?.[1] ?? text.slice(0, 240);
}

/** The call's JSON return value from a wallet's outcome (`status.SuccessValue`), or null. */
export function outcomeValue(outcome: unknown): unknown {
  const v = (outcome as { status?: { SuccessValue?: unknown } } | null)?.status?.SuccessValue;
  if (typeof v !== "string" || !v) return null;
  try {
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(v), (c) => c.charCodeAt(0))));
  } catch {
    return null;
  }
}

/** Signs and sends one SDK call with the wallet; returns the transaction hash and the call's return value. */
export async function sendWithWalletOutcome(wallet: NearWalletBase, signerId: string, call: Pick<ContractCall, "receiverId" | "actions">): Promise<{ txHash: string; value: unknown }> {
  const outcome = await wallet.signAndSendTransaction({ signerId, receiverId: call.receiverId, actions: call.actions, network });
  const failure = outcomeFailure(outcome);
  const hash = outcomeHash(outcome);
  if (failure) throw Object.assign(new Error(`The transaction failed: ${failure}`), { txHash: hash });
  if (!hash) throw new Error("The wallet returned no transaction hash.");
  return { txHash: hash, value: outcomeValue(outcome) };
}

/** Signs and sends one SDK call with the wallet; returns the transaction hash. */
export async function sendWithWallet(wallet: NearWalletBase, signerId: string, call: Pick<ContractCall, "receiverId" | "actions">): Promise<string> {
  return (await sendWithWalletOutcome(wallet, signerId, call)).txHash;
}

/** Sends NEAR from the wallet account to `receiverId` (yoctoNEAR). */
export async function transferWithWallet(wallet: NearWalletBase, signerId: string, receiverId: string, amountYocto: bigint): Promise<string> {
  return sendWithWallet(wallet, signerId, { receiverId, actions: [{ type: "Transfer", params: { deposit: amountYocto.toString() } }] as unknown as ContractCall["actions"] });
}
