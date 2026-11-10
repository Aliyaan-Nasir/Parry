"use client";

import { useId, useLayoutEffect, useState, type FormEvent, type ReactNode } from "react";
import { errorMessage } from "./bits";
import { useParryAccount } from "@/components/providers/AccountProvider";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { isPasskeyCancel, usePasskeySupport } from "@/lib/passkey";
import { cn } from "@/lib/cn";

/** NEAR account ids: named (alice.testnet) or implicit and universal (0u..., 64 hex). */
const ACCOUNT_ID = /^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$/;

function Option({ title, description, icon, children }: { title: string; description: ReactNode; icon: ReactNode; children: ReactNode }) {
  return (
    <section className="grid gap-3 rounded-xl border border-line bg-surface p-4">
      <div className="flex gap-3">
        <span aria-hidden="true" className="flex size-9 shrink-0 items-center justify-center rounded-full border border-line bg-raised text-brass">
          {icon}
        </span>
        <div className="min-w-0">
          <h3 className="text-[15px] font-semibold text-fg">{title}</h3>
          <p className="mt-0.5 text-[13px] leading-5 text-muted">{description}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

export const WalletGlyph = () => (
  <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
    <rect x="2.75" y="5" width="14.5" height="11" rx="2" />
    <path d="M2.75 8 H17.25 M13 11.75 H14.5" strokeLinecap="round" />
    <path d="M5 5 L13 2.75 L14 5" />
  </svg>
);

export const PasskeyGlyph = () => (
  <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
    <circle cx="7.5" cy="8" r="3.25" />
    <path d="M10.5 9.5 L17 9.5 M14.5 9.5 V12 M16.5 9.5 V11.25" />
    <path d="M2.75 16.5 C3.4 14.2, 5.2 13, 7.5 13 C 8.6 13, 9.6 13.3, 10.4 13.8" />
  </svg>
);

export const EyeGlyph = () => (
  <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2 10 C 4 6, 7 4.5, 10 4.5 C 13 4.5, 16 6, 18 10 C 16 14, 13 15.5, 10 15.5 C 7 15.5, 4 14, 2 10 Z" />
    <circle cx="10" cy="10" r="2.5" />
  </svg>
);

/** Connect a NEAR wallet, create or find a passkey account, or watch an account read-only. */
export function ConnectDialog() {
  const acct = useParryAccount();
  const [busy, setBusy] = useState<"create" | "find" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [watchId, setWatchId] = useState("");
  const [watchError, setWatchError] = useState<string | null>(null);
  const watchInputId = useId();
  const watchErrorId = useId();
  const canPasskey = usePasskeySupport();

  // A route kept in the background comes back with no stale messages.
  useLayoutEffect(
    () => () => {
      setError(null);
      setWatchError(null);
    },
    [],
  );

  const close = (open: boolean) => {
    acct.setConnectOpen(open);
    if (!open) {
      setError(null);
      setWatchError(null);
    }
  };

  const passkeyAction = async (kind: "create" | "find") => {
    setBusy(kind);
    setError(null);
    try {
      if (kind === "create") await acct.createPasskeyAccount();
      else await acct.findPasskeyAccount();
    } catch (e) {
      if (!isPasskeyCancel(e)) setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const onWatch = (e: FormEvent) => {
    e.preventDefault();
    const id = watchId.trim().toLowerCase();
    if (!ACCOUNT_ID.test(id)) {
      setWatchError("Enter a NEAR account id, such as a 0u... protected account address.");
      return;
    }
    setWatchError(null);
    acct.watchAccount(id);
    setWatchId("");
    close(false);
  };

  return (
    <Modal open={acct.connectOpen} onOpenChange={close} title="Connect to Parry" description="Act with a NEAR wallet or a passkey. Parry never holds your keys." size="md">
      <div className="grid gap-3 pt-1">
        <Option
          title="NEAR wallet"
          description="HOT, Meteor, Intear and other NEAR wallets. Your protected account is created for the wallet, without gas."
          icon={<WalletGlyph />}
        >
          <Button
            className="w-full sm:w-auto sm:justify-self-start"
            loading={acct.connecting}
            loadingLabel="Connecting the wallet"
            onClick={() => {
              // The wallet picker draws its own window, which must not sit under this dialog.
              acct.setConnectOpen(false);
              void acct.connectWallet();
            }}
          >
            {acct.wallet ? "Switch wallet" : "Choose a wallet"}
          </Button>
        </Option>

        <Option
          title="Passkey"
          description="A protected account owned by a passkey on your device: Face ID, Touch ID, Windows Hello or a security key. No wallet and no gas needed."
          icon={<PasskeyGlyph />}
        >
          {canPasskey !== false ? (
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button variant="secondary" loading={busy === "create"} loadingLabel="Creating the passkey account" disabled={busy === "find"} onClick={() => void passkeyAction("create")}>
                {acct.passkey && !acct.passkey.accountId ? "Finish creating the account" : "Create a passkey account"}
              </Button>
              <Button variant="ghost" loading={busy === "find"} loadingLabel="Looking for the passkey's account" disabled={busy === "create"} onClick={() => void passkeyAction("find")}>
                Use an existing passkey
              </Button>
            </div>
          ) : (
            <p className="text-[13px] text-muted">This browser cannot use passkeys.</p>
          )}
          {error ? (
            <p role="alert" className="text-[13px] font-medium text-critical">
              {error}
            </p>
          ) : null}
        </Option>

        <Option title="Watch an account" description="See any protected account read-only, without signing anything." icon={<EyeGlyph />}>
          <form onSubmit={onWatch} className="flex flex-col gap-2 sm:flex-row" noValidate>
            <label htmlFor={watchInputId} className="sr-only">
              Protected account address
            </label>
            <input
              id={watchInputId}
              value={watchId}
              onChange={(e) => setWatchId(e.target.value)}
              placeholder="0u... or name.testnet"
              autoComplete="off"
              spellCheck={false}
              aria-invalid={watchError ? true : undefined}
              aria-describedby={watchError ? watchErrorId : undefined}
              className={cn(
                "num h-10 min-w-0 flex-1 rounded-lg border bg-raised px-3 text-[13px] text-fg placeholder:text-muted",
                watchError ? "border-critical" : "border-line-strong",
              )}
            />
            <Button type="submit" variant="secondary">
              View
            </Button>
          </form>
          {watchError ? (
            <p id={watchErrorId} role="alert" className="text-[13px] font-medium text-critical">
              {watchError}
            </p>
          ) : null}
        </Option>
      </div>
    </Modal>
  );
}
