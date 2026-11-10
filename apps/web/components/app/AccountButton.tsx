"use client";

import Link from "next/link";
import { useLayoutEffect, useState } from "react";
import { AccountAddress } from "./AccountAddress";
import { ConnectButton } from "./ConnectButton";
import { useParryAccount, type Signer } from "@/components/providers/AccountProvider";
import { Badge } from "@/components/ui/Badge";
import { Button, buttonClasses } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { shortId } from "@/lib/units";
import { cn } from "@/lib/cn";

export const SIGNER_LABEL: Record<Signer, string> = { wallet: "NEAR wallet", passkey: "Passkey", watch: "Watching" };

/** The top bar's account slot: connect when nothing is connected, the account menu otherwise. */
export function AccountButton() {
  const acct = useParryAccount();
  const [menuOpen, setMenuOpen] = useState(false);
  const connected = !!(acct.wallet || acct.passkey?.accountId || acct.watching);

  useLayoutEffect(() => () => setMenuOpen(false), []);

  return (
    <>
      <ConnectButton
        onClick={() => (connected ? setMenuOpen(true) : acct.setConnectOpen(true))}
        accountId={acct.account ?? acct.wallet?.accountId ?? null}
        pending={acct.connecting}
      />
      <Modal open={menuOpen} onOpenChange={setMenuOpen} title="Your account" size="md">
        <div className="grid gap-5 pt-1">
          {acct.account ? (
            <section aria-labelledby="menu-selected" className="grid gap-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 id="menu-selected" className="text-sm font-semibold text-fg">
                  Protected account
                </h3>
                {acct.signer ? <Badge tone={acct.signer === "watch" ? "neutral" : "brass"}>{SIGNER_LABEL[acct.signer]}</Badge> : null}
              </div>
              <AccountAddress id={acct.account} label="protected account address" />
              {acct.signer === "watch" ? <p className="text-[13px] text-muted">Read-only: connect the owner&apos;s wallet or passkey to act on it.</p> : null}
            </section>
          ) : (
            <p className="text-sm text-muted">No protected account yet. Create one from the dashboard.</p>
          )}

          {acct.accounts.length > 1 ? (
            <section aria-labelledby="menu-switch" className="grid gap-2">
              <h3 id="menu-switch" className="text-sm font-semibold text-fg">
                Switch account
              </h3>
              <ul className="grid gap-1.5">
                {acct.accounts.map((a) => {
                  const current = a.id === acct.account;
                  return (
                    <li key={a.id}>
                      <button
                        type="button"
                        aria-current={current ? "true" : undefined}
                        onClick={() => {
                          acct.selectAccount(a.id);
                          setMenuOpen(false);
                        }}
                        className={cn(
                          "flex w-full items-center justify-between gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors",
                          current ? "border-brass/50 bg-brass-soft" : "border-line hover:bg-hover",
                        )}
                      >
                        <span className="num min-w-0 truncate text-[13px] text-fg">{shortId(a.id, 12, 8)}</span>
                        <span className="shrink-0 text-xs font-semibold text-muted">{SIGNER_LABEL[a.via]}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ) : null}

          <section aria-labelledby="menu-signers" className="grid gap-2">
            <h3 id="menu-signers" className="text-sm font-semibold text-fg">
              Connected
            </h3>
            <ul className="grid divide-y divide-line rounded-xl border border-line">
              {acct.wallet ? (
                <li className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                  <span className="min-w-0">
                    <span className="block text-[13px] text-muted">NEAR wallet</span>
                    <span className="num block truncate text-[13px] text-fg">{acct.wallet.accountId}</span>
                  </span>
                  <Button size="sm" variant="secondary" onClick={() => void acct.disconnectWallet()}>
                    Disconnect
                  </Button>
                </li>
              ) : null}
              {acct.passkey ? (
                <li className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                  <span className="min-w-0">
                    <span className="block text-[13px] text-muted">Passkey</span>
                    <span className="num block truncate text-[13px] text-fg">{acct.passkey.accountId ? shortId(acct.passkey.accountId, 12, 8) : "Account not created yet"}</span>
                  </span>
                  <Button size="sm" variant="secondary" onClick={acct.forgetPasskey}>
                    Forget on this device
                  </Button>
                </li>
              ) : null}
              {acct.watching ? (
                <li className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                  <span className="min-w-0">
                    <span className="block text-[13px] text-muted">Watching</span>
                    <span className="num block truncate text-[13px] text-fg">{shortId(acct.watching, 12, 8)}</span>
                  </span>
                  <Button size="sm" variant="secondary" onClick={acct.stopWatching}>
                    Stop watching
                  </Button>
                </li>
              ) : null}
            </ul>
          </section>

          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Link href="/app/settings" onClick={() => setMenuOpen(false)} className={buttonClasses({ variant: "ghost" })}>
              Settings
            </Link>
            <Button
              variant="secondary"
              onClick={() => {
                setMenuOpen(false);
                acct.setConnectOpen(true);
              }}
            >
              Connect another
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
