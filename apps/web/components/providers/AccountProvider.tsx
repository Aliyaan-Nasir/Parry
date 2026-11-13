"use client";

import { useQueryClient } from "@tanstack/react-query";
import { fromHex, ownerCallAction, type ContractCall, type OwnerAction } from "@parryguard/sdk";
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { useToast } from "@/components/ui/Toast";
import { api, chain, parry } from "@/lib/parry";
import { createPasskey, discoverPasskey, isStoredPasskey, PASSKEY_STORAGE_KEY, passkeySupported, signWithPasskey, type StoredPasskey } from "@/lib/passkey";
import { useOwnedAccounts } from "@/lib/queries";
import { isString, storedValue } from "@/lib/stored";
import { getConnector, isStoredWallet, sendWithWallet, sendWithWalletOutcome, transferWithWallet, WALLET_STORAGE_KEY, type StoredWallet } from "@/lib/wallet";
import { network } from "@/lib/env";

const walletStore = storedValue<StoredWallet>(WALLET_STORAGE_KEY, isStoredWallet);
const passkeyStore = storedValue<StoredPasskey>(PASSKEY_STORAGE_KEY, isStoredPasskey);
const selectedStore = storedValue<string>("parry-account", isString);
const watchStore = storedValue<string>("parry-watch", isString);

/** How the person can act on an account: their wallet, their passkey, or not at all (watching). */
export type Signer = "wallet" | "passkey" | "watch";

export type AccountEntry = { id: string; via: Signer };

export type ParryAccount = {
  /** False until this browser's stored identity has been read (server render and hydration). */
  ready: boolean;
  wallet: StoredWallet | null;
  passkey: StoredPasskey | null;
  /** A protected account viewed read-only. */
  watching: string | null;
  /** Every protected account this browser knows of, with how it can be acted on. */
  accounts: AccountEntry[];
  /** True while the wallet's accounts are being looked up. */
  accountsLoading: boolean;
  /** Why the wallet's accounts could not be looked up, if they could not. */
  accountsError: unknown;
  refetchAccounts: () => void;
  /** The selected protected account. */
  account: string | null;
  signer: Signer | null;
  /** The connect dialog, opened from anywhere. */
  connectOpen: boolean;
  setConnectOpen: (open: boolean) => void;
  connecting: boolean;
  selectAccount: (id: string) => void;
  connectWallet: () => Promise<void>;
  disconnectWallet: () => Promise<void>;
  /** Creates the gasless protected account of the connected wallet. */
  createWalletAccount: () => Promise<string>;
  /** Creates a passkey and its gasless protected account. */
  createPasskeyAccount: () => Promise<string>;
  /** Finds the protected account of a passkey made earlier (on this or another device). */
  findPasskeyAccount: () => Promise<string>;
  forgetPasskey: () => void;
  watchAccount: (id: string) => void;
  stopWatching: () => void;
  /** Runs owner actions on the selected account; returns the transaction hash and toasts it. */
  runOwnerActions: (actions: OwnerAction[], opts: { title: string; quiet?: boolean }) => Promise<string>;
  /** Runs owner actions and also returns the account's answer (a signing action's `{ r, s, v }`). Toasts nothing. */
  runOwnerActionsForValue: (actions: OwnerAction[]) => Promise<{ txHash: string; value: unknown }>;
  /** Sends NEAR from the connected wallet to the selected account (yoctoNEAR). */
  fundFromWallet: (amountYocto: bigint) => Promise<string>;
  /** Signs and sends one contract call from the connected wallet (for example a token transfer to the account). */
  sendFromWallet: (call: ContractCall) => Promise<string>;
  /** A sign-in token for the selected account's own writes (settings, alerts, push), kept in memory. */
  withSignIn: <T>(fn: (token: string) => Promise<T>) => Promise<T>;
  signedIn: boolean;
};

const AccountContext = createContext<ParryAccount | null>(null);

export function useParryAccount(): ParryAccount {
  const ctx = useContext(AccountContext);
  if (!ctx) throw new Error("useParryAccount must be used under <AccountProvider>");
  return ctx;
}

function errorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return typeof e === "string" ? e : "Something went wrong.";
}

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

export function AccountProvider({ children }: { children: ReactNode }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const storedWallet = walletStore.use();
  const storedPasskey = passkeyStore.use();
  const selected = selectedStore.use();
  const watching = watchStore.use();
  const ready = storedWallet !== undefined;
  const wallet = storedWallet ?? null;
  const passkey = storedPasskey ?? null;

  const [connectOpen, setConnectOpen] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [tokens, setTokens] = useState<Record<string, string>>({});
  const signingIn = useRef<Promise<string> | null>(null);

  const owned = useOwnedAccounts(wallet?.accountId ?? null);
  const { refetch: refetchOwned } = owned;
  const refetchAccounts = useCallback(() => void refetchOwned(), [refetchOwned]);

  const accounts = useMemo<AccountEntry[]>(() => {
    const out: AccountEntry[] = [];
    const seen = new Set<string>();
    const add = (id: string, via: Signer) => {
      if (seen.has(id)) return;
      seen.add(id);
      out.push({ id, via });
    };
    for (const id of owned.data ?? []) add(id, "wallet");
    if (passkey?.accountId) add(passkey.accountId, "passkey");
    if (watching) add(watching, "watch");
    return out;
  }, [owned.data, passkey, watching]);

  const entry = accounts.find((a) => a.id === selected) ?? accounts[0] ?? null;
  const account = entry?.id ?? null;
  const signer = entry?.via ?? null;

  const refreshAccount = useCallback(
    (id: string) => {
      for (const key of [["account", id], ["positions", id], ["portfolio", id], ["mandate", id], ["balance", id], ["simulation", id]]) {
        void queryClient.invalidateQueries({ queryKey: key });
      }
    },
    [queryClient],
  );

  const selectAccount = useCallback((id: string) => selectedStore.write(id), []);

  const connectWallet = useCallback(async () => {
    setConnecting(true);
    try {
      const connector = await getConnector();
      const w = await connector.connect();
      const signedIn = await w.getAccounts({ network });
      const id = signedIn[0]?.accountId;
      if (!id) throw new Error("The wallet returned no account.");
      walletStore.write({ accountId: id, walletId: w.manifest.id });
      setConnectOpen(false);
      toast({ title: "Wallet connected", description: id, tone: "success" });
    } catch (e) {
      if (!/rejected/i.test(errorText(e))) toast({ title: "The wallet did not connect", description: errorText(e), tone: "error" });
    } finally {
      setConnecting(false);
    }
  }, [toast]);

  const disconnectWallet = useCallback(async () => {
    const id = wallet?.accountId;
    walletStore.write(null);
    if (id) {
      setTokens(({ [id]: _drop, ...rest }) => rest);
    }
    try {
      const connector = await getConnector();
      await connector.disconnect();
    } catch {
      // Already signed out of the wallet, or it never loaded: forgetting it here is enough.
    }
  }, [wallet?.accountId]);

  const createWalletAccount = useCallback(async () => {
    if (!wallet) throw new Error("Connect a NEAR wallet first.");
    const { accountId, txHash } = await parry().createProtectedAccount({ nearAccount: wallet.accountId });
    await queryClient.invalidateQueries({ queryKey: ["owned", wallet.accountId] });
    selectedStore.write(accountId);
    toast({ title: "Protected account created", description: "The relayer paid the gas.", tone: "success", explorer: { kind: "nearblocks", hash: txHash } });
    return accountId;
  }, [wallet, queryClient, toast]);

  const createPasskeyAccount = useCallback(async () => {
    if (!passkeySupported()) throw new Error("This browser cannot create passkeys.");
    const created = passkey && !passkey.accountId ? passkey : await createPasskey("Parry account");
    passkeyStore.write({ ...created, accountId: null });
    const { accountId, txHash } = await parry().createProtectedAccount({ passkey: created.publicKey });
    passkeyStore.write({ ...created, accountId });
    selectedStore.write(accountId);
    setConnectOpen(false);
    toast({ title: "Passkey account created", description: "The relayer paid the gas.", tone: "success", explorer: { kind: "nearblocks", hash: txHash } });
    return accountId;
  }, [passkey, toast]);

  const findPasskeyAccount = useCallback(async () => {
    if (!passkeySupported()) throw new Error("This browser cannot use passkeys.");
    const { credentialId, candidates } = await discoverPasskey();
    for (const key of candidates) {
      const ids = await api.accountsByOwner(key);
      const id = ids[0];
      if (id) {
        passkeyStore.write({ credentialId, publicKey: key, accountId: id });
        selectedStore.write(id);
        setConnectOpen(false);
        toast({ title: "Passkey account found", description: id, tone: "success" });
        return id;
      }
    }
    throw new Error("No Parry account is owned by this passkey. Create one instead.");
  }, [toast]);

  const forgetPasskey = useCallback(() => {
    const id = passkey?.accountId;
    passkeyStore.write(null);
    if (id) setTokens(({ [id]: _drop, ...rest }) => rest);
  }, [passkey?.accountId]);

  const watchAccount = useCallback((id: string) => {
    watchStore.write(id);
    selectedStore.write(id);
  }, []);
  const stopWatching = useCallback(() => watchStore.write(null), []);

  const runOwnerActionsForValue = useCallback(
    async (actions: OwnerAction[]): Promise<{ txHash: string; value: unknown }> => {
      if (!account || !signer) throw new Error("Connect an account first.");
      let sent: { txHash: string; value: unknown };
      if (signer === "wallet") {
        if (!wallet) throw new Error("Connect the owner's NEAR wallet first.");
        const connector = await getConnector();
        const w = await connector.wallet();
        sent = await sendWithWalletOutcome(w, wallet.accountId, ownerCallAction(account, actions));
      } else if (signer === "passkey") {
        if (!passkey) throw new Error("This browser does not hold the account's passkey.");
        const c = await chain();
        const { owner } = await c.nonces(account);
        const request = c.ownerRequest({ account, nonce: owner + 1, actions });
        const assertion = await signWithPasskey(request.challenge, passkey.credentialId);
        const r = await api.relayOwner(account, request.text, assertion);
        sent = { txHash: r.txHash, value: r.value ?? null };
      } else {
        throw new Error("This account is only being watched: connect its owner's wallet or passkey to act.");
      }
      refreshAccount(account);
      return sent;
    },
    [account, signer, wallet, passkey, refreshAccount],
  );

  const runOwnerActions = useCallback(
    async (actions: OwnerAction[], opts: { title: string; quiet?: boolean }) => {
      const { txHash } = await runOwnerActionsForValue(actions);
      if (!opts.quiet) toast({ title: opts.title, tone: "success", explorer: { kind: "nearblocks", hash: txHash } });
      return txHash;
    },
    [runOwnerActionsForValue, toast],
  );

  const fundFromWallet = useCallback(
    async (amountYocto: bigint) => {
      if (!account || !wallet) throw new Error("Connect a NEAR wallet first.");
      const connector = await getConnector();
      const w = await connector.wallet();
      const hash = await transferWithWallet(w, wallet.accountId, account, amountYocto);
      refreshAccount(account);
      return hash;
    },
    [account, wallet, refreshAccount],
  );

  const sendFromWallet = useCallback(
    async (call: ContractCall) => {
      if (!account || !wallet) throw new Error("Connect a NEAR wallet first.");
      const connector = await getConnector();
      const w = await connector.wallet();
      const hash = await sendWithWallet(w, wallet.accountId, call);
      refreshAccount(account);
      return hash;
    },
    [account, wallet, refreshAccount],
  );

  const signIn = useCallback(async (): Promise<string> => {
    if (!account || !signer) throw new Error("Connect an account first.");
    if (signer === "watch") throw new Error("Sign in with the account's owner to change it.");
    const challenge = await api.challenge(account);
    let token: string;
    if (signer === "wallet") {
      if (!wallet) throw new Error("Connect the owner's NEAR wallet first.");
      const connector = await getConnector();
      const w = await connector.wallet();
      const signed = await w.signMessage({ message: challenge.message, recipient: challenge.recipient, nonce: fromHex(challenge.nonce), network, signerId: wallet.accountId });
      ({ token } = await api.verify({ accountId: account, nonce: challenge.nonce, nep413: { publicKey: signed.publicKey, signature: signed.signature } }));
    } else {
      if (!passkey) throw new Error("This browser does not hold the account's passkey.");
      const assertion = await signWithPasskey(await sha256(challenge.message), passkey.credentialId);
      ({ token } = await api.verify({ accountId: account, nonce: challenge.nonce, passkey: assertion }));
    }
    setTokens((t) => ({ ...t, [account]: token }));
    return token;
  }, [account, signer, wallet, passkey]);

  const token = account ? (tokens[account] ?? null) : null;

  const withSignIn = useCallback(
    async <T,>(fn: (token: string) => Promise<T>): Promise<T> => {
      const run = async (t: string) => fn(t);
      if (token) {
        try {
          return await run(token);
        } catch (e) {
          if ((e as { status?: number }).status !== 401) throw e;
          if (account) setTokens(({ [account]: _drop, ...rest }) => rest);
        }
      }
      signingIn.current ??= signIn().finally(() => {
        signingIn.current = null;
      });
      return run(await signingIn.current);
    },
    [token, account, signIn],
  );

  const value = useMemo<ParryAccount>(
    () => ({
      ready,
      wallet,
      passkey,
      watching: watching ?? null,
      accounts,
      accountsLoading: !!wallet && owned.isPending,
      accountsError: owned.error ?? null,
      refetchAccounts,
      account,
      signer,
      connectOpen,
      setConnectOpen,
      connecting,
      selectAccount,
      connectWallet,
      disconnectWallet,
      createWalletAccount,
      createPasskeyAccount,
      findPasskeyAccount,
      forgetPasskey,
      watchAccount,
      stopWatching,
      runOwnerActions,
      runOwnerActionsForValue,
      fundFromWallet,
      sendFromWallet,
      withSignIn,
      signedIn: !!token,
    }),
    [
      ready,
      wallet,
      passkey,
      watching,
      accounts,
      owned.isPending,
      owned.error,
      refetchAccounts,
      account,
      signer,
      connectOpen,
      connecting,
      selectAccount,
      connectWallet,
      disconnectWallet,
      createWalletAccount,
      createPasskeyAccount,
      findPasskeyAccount,
      forgetPasskey,
      watchAccount,
      stopWatching,
      runOwnerActions,
      runOwnerActionsForValue,
      fundFromWallet,
      sendFromWallet,
      withSignIn,
      token,
    ],
  );

  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
}
