"use client";

import { WatchlistManager } from "@/components/app/WatchlistManager";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useLayoutEffect, useState, type FormEvent, type ReactNode } from "react";
import { AccountAddress } from "@/components/app/AccountAddress";
import { errorMessage, ExternalLink, Note, QueryError, Segmented } from "@/components/app/bits";
import { useParryAccount, type Signer } from "@/components/providers/AccountProvider";
import { useMoney } from "@/components/providers/MoneyProvider";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardHeader } from "@/components/ui/Card";
import { Skeleton } from "@/components/ui/Skeleton";
import { Slider } from "@/components/ui/Slider";
import { Toggle } from "@/components/ui/Toggle";
import { useToast } from "@/components/ui/Toast";
import { CURRENCIES, isCurrency, type Currency, type Settings, type Thresholds } from "@/lib/api-types";
import { isPasskeyCancel, usePasskeySupport } from "@/lib/passkey";
import { api } from "@/lib/parry";
import { currentSubscription, pushSupported, subscribePush, unsubscribePush } from "@/lib/push";
import { keys, useSettings } from "@/lib/queries";
import { formatRelativeTime } from "@/lib/format";
import { formatNumber, shortId } from "@/lib/units";
import { useNow } from "@/lib/use-now";

const CURRENCY_NAME: Record<Currency, string> = {
  USD: "US dollar",
  EUR: "Euro",
  GBP: "British pound",
  JPY: "Japanese yen",
  CHF: "Swiss franc",
  CAD: "Canadian dollar",
  AUD: "Australian dollar",
  SGD: "Singapore dollar",
  HKD: "Hong Kong dollar",
  AED: "UAE dirham",
  INR: "Indian rupee",
  CNY: "Chinese yuan",
};

/** A row inside a settings card: what it is on the left, the control on the right. */
function Row({ title, detail, children }: { title: ReactNode; detail?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="text-sm font-semibold text-fg">{title}</p>
        {detail ? <div className="mt-0.5 text-[13px] leading-5 text-muted">{detail}</div> : null}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

function useAction() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useLayoutEffect(
    () => () => {
      setBusy(null);
      setError(null);
    },
    [],
  );
  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (e) {
      if (!isPasskeyCancel(e)) setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const errorLine = error ? (
    <p role="alert" className="text-[13px] font-medium text-critical">
      {error}
    </p>
  ) : null;
  return { busy, run, errorLine };
}

function Identities() {
  const acct = useParryAccount();
  const canPasskey = usePasskeySupport();
  const { busy, run, errorLine } = useAction();
  if (!acct.ready) return <Skeleton height="6rem" shape="block" />;
  const anything = !!(acct.wallet || acct.passkey || acct.watching);
  return (
    <Card as="section" aria-labelledby="identity-title" className="grid content-start gap-4">
      <CardHeader titleAs="h2" title={<span id="identity-title">Account and sign-in</span>} description="What this browser uses to act on your protected account. Parry never holds your keys." />
      {acct.account ? (
        <div className="grid gap-1.5 rounded-xl border border-line bg-surface p-4">
          <p className="text-[13px] text-muted">Protected account</p>
          <AccountAddress id={acct.account} label="protected account address" />
        </div>
      ) : null}
      <div className="grid divide-y divide-line">
        <Row title="NEAR wallet" detail={acct.wallet ? <span className="num break-all">{acct.wallet.accountId}</span> : "HOT, Meteor, Intear and other NEAR wallets."}>
          {acct.wallet ? (
            <Button size="sm" variant="secondary" onClick={() => void acct.disconnectWallet()}>
              Disconnect
            </Button>
          ) : (
            <Button size="sm" variant="secondary" loading={acct.connecting} loadingLabel="Connecting the wallet" onClick={() => void acct.connectWallet()}>
              Connect a wallet
            </Button>
          )}
        </Row>
        <Row
          title="Passkey"
          detail={
            acct.passkey ? (
              acct.passkey.accountId ? (
                <>
                  Owns <span className="num">{shortId(acct.passkey.accountId, 10, 6)}</span>. Forgetting it here keeps the passkey on your device; use it again any time.
                </>
              ) : (
                "Created, but its account is not created yet."
              )
            ) : canPasskey === false ? (
              "This browser cannot use passkeys."
            ) : (
              "Adds a protected account owned by a passkey on this device, created without gas. It is a separate account from your wallet's."
            )
          }
        >
          {acct.passkey?.accountId ? (
            <Button size="sm" variant="secondary" onClick={acct.forgetPasskey}>
              Forget on this device
            </Button>
          ) : (
            <Button
              size="sm"
              variant="secondary"
              disabled={canPasskey === false}
              loading={busy === "passkey"}
              loadingLabel="Creating the passkey account"
              onClick={() =>
                void run("passkey", async () => {
                  await acct.createPasskeyAccount();
                })
              }
            >
              {acct.passkey ? "Finish creating" : "Add a passkey"}
            </Button>
          )}
        </Row>
        {acct.watching ? (
          <Row title="Watching" detail={<span className="num">{shortId(acct.watching, 10, 6)}</span>}>
            <Button size="sm" variant="secondary" onClick={acct.stopWatching}>
              Stop watching
            </Button>
          </Row>
        ) : null}
      </div>
      {errorLine}
      {anything ? (
        <div className="flex justify-end border-t border-line pt-4">
          <Button
            variant="ghost"
            onClick={() => {
              void acct.disconnectWallet();
              acct.forgetPasskey();
              acct.stopWatching();
            }}
          >
            Sign out of everything
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

function CurrencyCard({ account, signer, settings }: { account: string | null; signer: Signer | null; settings: Settings | undefined }) {
  const money = useMoney();
  const acct = useParryAccount();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const now = useNow();
  const { busy, run, errorLine } = useAction();
  const selectId = useId();
  const canSave = !!account && !!signer && signer !== "watch" && !!settings && settings.displayCurrency !== money.currency;
  return (
    <Card as="section" aria-labelledby="currency-title" className="grid content-start gap-4">
      <CardHeader titleAs="h2" title={<span id="currency-title">Display currency</span>} description="Every dollar figure in the app is shown in this currency, at the API's daily rates. Nothing is priced in it." />
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="grid gap-1.5">
          <label htmlFor={selectId} className="text-sm font-semibold text-fg">
            Currency
          </label>
          <select
            id={selectId}
            value={money.currency}
            onChange={(e) => {
              if (isCurrency(e.target.value)) money.setCurrency(e.target.value);
            }}
            className="h-10 min-w-56 rounded-lg border border-line-strong bg-raised px-3 text-sm text-fg"
          >
            {CURRENCIES.map((c) => (
              <option key={c} value={c}>
                {c}, {CURRENCY_NAME[c]}
              </option>
            ))}
          </select>
        </div>
        {canSave ? (
          <Button
            variant="secondary"
            loading={busy === "save"}
            loadingLabel="Saving the currency"
            onClick={() =>
              void run("save", async () => {
                await acct.withSignIn((token) => api.saveSettings(account!, { displayCurrency: money.currency }, token));
                await queryClient.invalidateQueries({ queryKey: keys.settings(account!) });
                toast({ title: `${money.currency} saved to your account`, tone: "success" });
              })
            }
          >
            Save to my account
          </Button>
        ) : null}
      </div>
      <p className="text-[13px] text-muted">
        {money.currency === "USD"
          ? "US dollars need no rate."
          : money.rate !== null
            ? `1 USD = ${formatNumber(money.rate, money.rate >= 10 ? 2 : 4)} ${money.currency}${money.ratesUpdatedAt && now ? `, rates from ${formatRelativeTime(money.ratesUpdatedAt, now)}` : ""}.`
            : money.ratesError
              ? `The rates could not be loaded, so figures stay in US dollars.`
              : "Loading the rate."}
        {" "}This device remembers the choice; saving it to your account applies it wherever you sign in.
      </p>
      {errorLine}
    </Card>
  );
}

function PushRow({ account, settings, canWrite }: { account: string; settings: Settings; canWrite: boolean }) {
  const acct = useParryAccount();
  const queryClient = useQueryClient();
  const { busy, run, errorLine } = useAction();
  const local = useQuery({ queryKey: ["push-subscription"], queryFn: async () => !!(await currentSubscription()), staleTime: Infinity });
  const supported = typeof window !== "undefined" && pushSupported();
  const on = settings.push && local.data === true;
  const vapid = settings.vapidPublicKey ?? null;
  const detail = !vapid
    ? "Push is not configured on this Parry API."
    : !supported
      ? "This browser cannot receive push notifications."
      : on
        ? "This browser shows Parry's alerts as notifications."
        : "Alerts arrive as notifications on this device, even with Parry closed.";
  return (
    <div className="grid gap-2">
      <Toggle
        label="Push notifications"
        description={detail}
        checked={on}
        disabled={!vapid || !supported || !canWrite || busy !== null}
        onCheckedChange={(next) =>
          void run("push", async () => {
            if (next) {
              const sub = await subscribePush(vapid!);
              await acct.withSignIn((token) => api.pushSubscribe(sub, token));
            } else {
              await unsubscribePush();
            }
            await Promise.all([queryClient.invalidateQueries({ queryKey: ["push-subscription"] }), queryClient.invalidateQueries({ queryKey: keys.settings(account) })]);
          })
        }
      />
      {errorLine}
    </div>
  );
}

function TelegramRow({ account, settings, canWrite }: { account: string; settings: Settings; canWrite: boolean }) {
  const acct = useParryAccount();
  const queryClient = useQueryClient();
  const { busy, run, errorLine } = useAction();
  const t = settings.telegram;
  return (
    <div className="grid gap-2">
      <Row
        title="Telegram"
        detail={
          t.linked
            ? "Alerts are sent to your Telegram chat."
            : t.available === false
              ? "Telegram alerts are not configured on this Parry API."
              : t.deepLink
                ? "Open the bot and press Start to finish linking."
                : "Get alerts in a chat with Parry's bot."
        }
      >
        {t.linked ? (
          <Badge tone="safe">Linked</Badge>
        ) : t.deepLink ? (
          <ExternalLink href={t.deepLink} className="text-sm">
            Open the Telegram bot
          </ExternalLink>
        ) : (
          <Button
            size="sm"
            variant="secondary"
            disabled={!canWrite || t.available === false}
            loading={busy === "telegram"}
            loadingLabel="Making the link"
            onClick={() =>
              void run("telegram", async () => {
                await acct.withSignIn((token) => api.saveSettings(account, { linkTelegram: true }, token));
                await queryClient.invalidateQueries({ queryKey: keys.settings(account) });
              })
            }
          >
            Link Telegram
          </Button>
        )}
      </Row>
      {errorLine}
    </div>
  );
}

function EmailRow({ account, settings, canWrite }: { account: string; settings: Settings; canWrite: boolean }) {
  const acct = useParryAccount();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { busy, run, errorLine } = useAction();
  const [email, setEmail] = useState(settings.email.address ?? "");
  const [digest, setDigest] = useState<"off" | "daily">(settings.email.digest);
  const inputId = useId();
  const valid = email === "" || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    void run("email", async () => {
      await acct.withSignIn((token) => api.saveSettings(account, { email: email || null, digest: email ? digest : "off" }, token));
      await queryClient.invalidateQueries({ queryKey: keys.settings(account) });
      toast({ title: "Email digest saved", tone: "success" });
    });
  };
  return (
    <form onSubmit={onSubmit} className="grid gap-3 pt-4" noValidate>
      <div>
        <p className="text-sm font-semibold text-fg">Email digest</p>
        <p className="mt-0.5 text-[13px] text-muted">A daily summary of your positions and alerts.</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto] sm:items-end">
        <div className="grid gap-1.5">
          <label htmlFor={inputId} className="text-[13px] font-semibold text-fg">
            Email address
          </label>
          <input
            id={inputId}
            type="email"
            autoComplete="email"
            value={email}
            disabled={!canWrite}
            onChange={(e) => setEmail(e.target.value.trim())}
            aria-invalid={valid ? undefined : true}
            placeholder="you@example.com"
            className="h-10 min-w-0 rounded-lg border border-line-strong bg-raised px-3 text-sm text-fg placeholder:text-muted disabled:opacity-55"
          />
        </div>
        <Segmented
          label="Digest"
          options={[
            { value: "off", label: "Off" },
            { value: "daily", label: "Daily" },
          ]}
          value={digest}
          onChange={setDigest}
        />
        <Button type="submit" variant="secondary" disabled={!canWrite || !valid} loading={busy === "email"} loadingLabel="Saving the email digest">
          Save
        </Button>
      </div>
      {!valid ? (
        <p role="alert" className="text-[13px] font-medium text-critical">
          Enter an email address, or leave it empty to turn the digest off.
        </p>
      ) : null}
      {errorLine}
    </form>
  );
}

function ThresholdsForm({ account, initial, canWrite }: { account: string; initial: Thresholds; canWrite: boolean }) {
  const acct = useParryAccount();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { busy, run, errorLine } = useAction();
  const [t, setT] = useState<Thresholds>(initial);
  const changed = t.score !== initial.score || t.health !== initial.health || t.cascade !== initial.cascade;
  return (
    <Card as="section" aria-labelledby="thresholds-title" className="grid content-start gap-5">
      <CardHeader
        titleAs="h2"
        title={<span id="thresholds-title">Alert thresholds</span>}
        description="When Parry alerts you. These are only for alerts: when the guardian acts is set, sealed, in your mandate."
      />
      <form
        className="grid gap-6"
        onSubmit={(e) => {
          e.preventDefault();
          void run("thresholds", async () => {
            await acct.withSignIn((token) => api.saveSettings(account, { thresholds: t }, token));
            await queryClient.invalidateQueries({ queryKey: keys.settings(account) });
            toast({ title: "Alert thresholds saved", tone: "success" });
          });
        }}
      >
        <Slider label="Risk score" description="Alert when a position's score reaches this." min={10} max={95} step={5} value={t.score} onValueChange={(score) => setT((x) => ({ ...x, score }))} disabled={!canWrite} />
        <Slider
          label="Health"
          description="Alert when a position's health falls to this."
          min={1.05}
          max={2}
          step={0.05}
          value={t.health}
          formatValue={(v) => v.toFixed(2)}
          onValueChange={(health) => setT((x) => ({ ...x, health: Math.round(health * 100) / 100 }))}
          disabled={!canWrite}
        />
        <Slider
          label="Cascade pressure"
          description="Alert when the market's cascade pressure reaches this."
          min={0.05}
          max={1}
          step={0.05}
          value={t.cascade}
          formatValue={(v) => `${Math.round(v * 100)}%`}
          onValueChange={(cascade) => setT((x) => ({ ...x, cascade: Math.round(cascade * 100) / 100 }))}
          disabled={!canWrite}
        />
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={!canWrite || !changed} loading={busy === "thresholds"} loadingLabel="Saving the thresholds">
            Save thresholds
          </Button>
          {changed ? (
            <Button variant="ghost" onClick={() => setT(initial)}>
              Undo changes
            </Button>
          ) : null}
        </div>
        {errorLine}
      </form>
    </Card>
  );
}

function AccountSettings({ account, signer }: { account: string; signer: Signer }) {
  const q = useSettings(account);
  const { signedIn } = useParryAccount();
  const canWrite = signer !== "watch";
  if (q.isError && !q.data) return <QueryError title="Your settings could not be loaded" error={q.error} onRetry={() => void q.refetch()} />;
  if (!q.data) return <Skeleton height="12rem" shape="block" />;
  const s = q.data;
  return (
    <>
      {!canWrite ? (
        <Note>You are watching this account, so its settings are read-only here.</Note>
      ) : !signedIn ? (
        <Note>Saving asks your {signer === "wallet" ? "wallet to sign a message" : "passkey"} once to sign in; the session stays in this tab only.</Note>
      ) : null}
      <Card as="section" aria-labelledby="notify-title" className="grid content-start gap-4">
        <CardHeader titleAs="h2" title={<span id="notify-title">Notifications</span>} description="Where alerts reach you besides this app." />
        <div className="grid divide-y divide-line">
          <div className="pb-4">
            <PushRow account={account} settings={s} canWrite={canWrite} />
          </div>
          <div className="py-4">
            <TelegramRow account={account} settings={s} canWrite={canWrite} />
          </div>
          <EmailRow key={`${s.email.address}-${s.email.digest}`} account={account} settings={s} canWrite={canWrite} />
        </div>
      </Card>
      <ThresholdsForm key={JSON.stringify(s.thresholds)} account={account} initial={s.thresholds} canWrite={canWrite} />
    </>
  );
}

export function SettingsView() {
  const { account, signer } = useParryAccount();
  const settings = useSettings(account);
  return (
    <>
      <Identities />
      <CurrencyCard account={account} signer={signer} settings={settings.data} />
      <WatchlistManager />
      {account && signer ? <AccountSettings account={account} signer={signer} /> : null}
    </>
  );
}
