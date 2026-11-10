"use client";

import { useLayoutEffect, useState, type ReactNode } from "react";
import { errorMessage, QueryError } from "./bits";
import { PasskeyGlyph, WalletGlyph } from "./ConnectDialog";
import { useParryAccount, type Signer } from "@/components/providers/AccountProvider";
import { Mark } from "@/components/brand/Logo";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Skeleton } from "@/components/ui/Skeleton";
import { isPasskeyCancel, usePasskeySupport } from "@/lib/passkey";

function Path({ icon, title, body, action }: { icon: ReactNode; title: string; body: string; action: ReactNode }) {
  return (
    <div className="flex flex-col gap-4 rounded-xl border border-line bg-surface p-5">
      <div className="flex gap-3">
        <span aria-hidden="true" className="flex size-10 shrink-0 items-center justify-center rounded-full border border-line bg-raised text-brass">
          {icon}
        </span>
        <div className="min-w-0">
          <h3 className="text-[15px] font-semibold text-fg">{title}</h3>
          <p className="mt-1 text-sm leading-6 text-muted">{body}</p>
        </div>
      </div>
      <div className="mt-auto">{action}</div>
    </div>
  );
}

/** The first thing someone without an account sees: connect a wallet, or create a passkey account. */
export function OnboardingCard({ title, description }: { title: string; description: string }) {
  const acct = useParryAccount();
  const canPasskey = usePasskeySupport();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useLayoutEffect(() => () => setError(null), []);

  return (
    <Card as="section" padding="lg" aria-labelledby="onboarding-title" className="grid content-start gap-6">
      <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center">
        <span aria-hidden="true" className="flex size-11 shrink-0 items-center justify-center rounded-full border border-line bg-surface text-muted">
          <Mark size={22} />
        </span>
        <div className="min-w-0">
          <h2 id="onboarding-title" className="font-display text-xl font-semibold tracking-[-0.01em] text-fg sm:text-[22px]">
            {title}
          </h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-muted">{description}</p>
        </div>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <Path
          icon={<WalletGlyph />}
          title="Connect a NEAR wallet"
          body="HOT, Meteor, Intear and other wallets. Parry creates your protected account for the wallet, and the relayer pays the gas."
          action={
            <Button className="w-full sm:w-auto" loading={acct.connecting} loadingLabel="Connecting the wallet" onClick={() => void acct.connectWallet()}>
              Connect a wallet
            </Button>
          }
        />
        <Path
          icon={<PasskeyGlyph />}
          title="Create a passkey account"
          body="No wallet needed: a passkey on this device owns the account, and every action is a fingerprint or face away. Gasless."
          action={
            <div className="grid gap-2">
              <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                <Button
                  variant="secondary"
                  disabled={canPasskey === false}
                  loading={busy}
                  loadingLabel="Creating the passkey account"
                  onClick={async () => {
                    setBusy(true);
                    setError(null);
                    try {
                      await acct.createPasskeyAccount();
                    } catch (e) {
                      if (!isPasskeyCancel(e)) setError(errorMessage(e));
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Create a passkey account
                </Button>
                <Button variant="ghost" onClick={() => acct.setConnectOpen(true)}>
                  More ways to connect
                </Button>
              </div>
              {canPasskey === false ? <p className="text-[13px] text-muted">This browser cannot use passkeys.</p> : null}
              {error ? (
                <p role="alert" className="text-[13px] font-medium text-critical">
                  {error}
                </p>
              ) : null}
            </div>
          }
        />
      </div>
    </Card>
  );
}

/** The connected wallet has no protected account yet: create it, gasless. */
function CreateForWallet({ walletId }: { walletId: string }) {
  const acct = useParryAccount();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useLayoutEffect(() => () => setError(null), []);
  return (
    <Card as="section" padding="lg" aria-labelledby="create-title" className="grid content-start gap-4">
      <div>
        <h2 id="create-title" className="font-display text-xl font-semibold tracking-[-0.01em] text-fg sm:text-[22px]">
          Create your protected account
        </h2>
        <p className="mt-1 max-w-2xl text-sm leading-6 text-muted">
          <span className="num text-fg">{walletId}</span> owns no Parry account yet. The protected account is a NEAR account of its own that only your wallet controls; the
          guardian can act on it only within the mandate you set. Creating it costs you no gas.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          loading={busy}
          loadingLabel="Creating the protected account"
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await acct.createWalletAccount();
            } catch (e) {
              setError(errorMessage(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          Create protected account
        </Button>
        <Button variant="ghost" onClick={() => acct.setConnectOpen(true)}>
          Use a passkey instead
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-[13px] font-medium text-critical">
          {error}
        </p>
      ) : null}
    </Card>
  );
}

function GateSkeleton() {
  return (
    <Card padding="lg" aria-busy="true" className="grid content-start gap-4">
      <span className="sr-only">Loading your account</span>
      <Skeleton width="40%" height="1.6rem" />
      <Skeleton width="70%" />
      <Skeleton height="6rem" shape="block" />
    </Card>
  );
}

export type GateProps = {
  /** Rendered once a protected account is selected. */
  children: (ctx: { account: string; signer: Signer }) => ReactNode;
  /** The onboarding card's title and line for this page. */
  title: string;
  description: string;
};

/** Shows the page's content for the selected account, or the way to get one. */
export function AccountGate({ children, title, description }: GateProps) {
  const acct = useParryAccount();
  if (!acct.ready || (acct.accountsLoading && !acct.account)) return <GateSkeleton />;
  if (acct.account && acct.signer) return <>{children({ account: acct.account, signer: acct.signer })}</>;
  if (acct.wallet && acct.accountsError) return <QueryError title="Your wallet's accounts could not be looked up" error={acct.accountsError} onRetry={acct.refetchAccounts} />;
  if (acct.wallet) return <CreateForWallet walletId={acct.wallet.accountId} />;
  return <OnboardingCard title={title} description={description} />;
}
