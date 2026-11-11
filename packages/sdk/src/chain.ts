/**
 * Chain reads and writes through near-kit: views need no API and no key.
 */

import { Near } from "near-kit";
import { nearKitCallOptions, type ContractCall } from "./calls.js";
import { fromBase64, fromUtf8 } from "./encoding.js";
import type { ContractIds, Network } from "./networks.js";
import type { CertificateAnchor, Closing, EnclaveInfo, EnclaveKey, MandateView, Nonces, RheaLines, SealingKey, VaultChainState } from "./types.js";
import { compressedPasskey } from "./webauthn.js";

export interface ChainOptions {
  network: Network;
  rpcUrl?: string;
}

export function nearClient(opts: ChainOptions, signer?: { accountId: string; privateKey: string }): Near {
  return new Near({
    network: opts.network,
    ...(opts.rpcUrl ? { rpcUrl: opts.rpcUrl } : {}),
    ...(signer ? { privateKey: signer.privateKey as `ed25519:${string}`, defaultSignerId: signer.accountId } : {}),
  });
}

/** Who owns a protected account: a passkey (P-256 key: bytes, hex or `p256:<base58>`) or a NEAR account. */
export type ProtectedOwner = { passkey: Uint8Array | string } | { nearAccount: string };

export function chainReads(near: Near, contract: (name: keyof ContractIds) => string) {
  const view = <T>(contractId: string, method: string, args: object = {}) => near.view<T>(contractId, method, args);
  return {
    /** The protected account address of an owner, from the factory (`account_id_of`). */
    protectedAccountId: async (owner: ProtectedOwner): Promise<string> => {
      const args = "passkey" in owner ? { passkey: compressedPasskey(owner.passkey), near_account: null } : { passkey: null, near_account: owner.nearAccount };
      const id = await view<string>(contract("factory"), "account_id_of", args);
      if (typeof id !== "string") throw new Error("the factory returned no account id");
      return id;
    },
    /** The account's mandate with its live counters, or null. */
    mandate: async (accountId: string): Promise<MandateView | null> => (await view<MandateView | null>(accountId, "mandate")) ?? null,
    /** The last owner request nonce and guardian envelope nonce used. */
    nonces: async (accountId: string): Promise<Nonces> => {
      const n = await view<[number, number]>(accountId, "nonces");
      if (!Array.isArray(n)) throw new Error("nonces() returned no pair");
      return { owner: n[0], guardian: n[1] };
    },
    /** The close round in flight on a protected account (`closing()`), or null when none is. */
    closing: async (accountId: string): Promise<Closing | null> => (await view<Closing | null>(accountId, "closing")) ?? null,
    /** An account's Rhea lending position (`get_account` on the lending contract), or null when it has none. */
    rheaPosition: async (accountId: string): Promise<RheaLines | null> => {
      const v = await view<Partial<RheaLines> | null>(contract("lending"), "get_account", { account_id: accountId });
      if (!v) return null;
      const lines = (xs: { token_id: string; balance: string }[] | undefined) => (xs ?? []).map((x) => ({ token_id: x.token_id, balance: x.balance }));
      return { collateral: lines(v.collateral), supplied: lines(v.supplied), borrowed: lines(v.borrowed) };
    },
    /** The vault contract's own state (`vault_state`). */
    vaultState: async (): Promise<VaultChainState> => {
      const s = await view<VaultChainState>(contract("vault"), "vault_state");
      if (!s) throw new Error("vault_state() returned nothing");
      return s;
    },
    /** The enclave's signing key and sealing key, from the risk board. */
    enclave: async (): Promise<EnclaveInfo> => {
      const [key, sealingKey] = await Promise.all([
        view<EnclaveKey>(contract("risk"), "get_enclave"),
        view<SealingKey | null>(contract("risk"), "sealing_key"),
      ]);
      if (!key) throw new Error("get_enclave() returned nothing");
      return { key, sealingKey: sealingKey ?? null };
    },
    /** Every enclave key the risk board has trusted, newest first (a new enclave build rotates it). */
    enclaveHistory: async (): Promise<EnclaveKey[]> => (await view<EnclaveKey[]>(contract("risk"), "enclave_history", { limit: 100 })) ?? [],
    /**
     * The risk board's anchor of a health certificate (`certificate(hash)`), null when it has none,
     * or undefined while the deployed board has no such view.
     */
    certificateAnchor: async (hash: string): Promise<CertificateAnchor | null | undefined> => {
      try {
        return (await view<CertificateAnchor | null>(contract("risk"), "certificate", { hash })) ?? null;
      } catch (e) {
        if (/MethodNotFound|MethodResolveError/i.test(String((e as Error)?.message ?? e))) return undefined;
        throw e;
      }
    },
  };
}

export type ChainReads = ReturnType<typeof chainReads>;

export interface SentCall {
  txHash: string;
  /** The call's JSON return value, when it returned one. */
  value: unknown;
}

/** Signs `call` with a full-access key and sends it; waits for optimistic execution. */
export async function sendCall(near: Near, signerId: string, call: ContractCall): Promise<SentCall> {
  const outcome = (await near
    .transaction(signerId)
    .functionCall(call.receiverId, call.methodName, call.args, nearKitCallOptions(call))
    .send()) as { transaction?: { hash?: string }; transaction_outcome?: { id?: string }; status?: unknown };
  const txHash = outcome.transaction?.hash ?? outcome.transaction_outcome?.id ?? "";
  let value: unknown = null;
  const status = outcome.status as { SuccessValue?: string } | undefined;
  if (status && typeof status === "object" && typeof status.SuccessValue === "string" && status.SuccessValue) {
    try {
      value = JSON.parse(fromUtf8(fromBase64(status.SuccessValue)));
    } catch {
      value = status.SuccessValue;
    }
  }
  return { txHash, value };
}
