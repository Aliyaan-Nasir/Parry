"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useLayoutEffect, useMemo, useState, type FormEvent } from "react";
import { verifyReserves, type ReservesVerification } from "@parry/sdk";
import { AmountField } from "@/components/app/AmountField";
import { DataList, DataRow, errorMessage, ExternalLink, Note, QueryError, Segmented } from "@/components/app/bits";
import { useParryAccount, type Signer } from "@/components/providers/AccountProvider";
import { useMoney } from "@/components/providers/MoneyProvider";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardHeader } from "@/components/ui/Card";
import { Chart, type ChartSeries } from "@/components/ui/Chart";
import { RiskGauge } from "@/components/ui/RiskGauge";
import { Skeleton } from "@/components/ui/Skeleton";
import { Stat, StatGroup } from "@/components/ui/Stat";
import { Tabs } from "@/components/ui/Tabs";
import type { VaultView as Vault } from "@/lib/api-types";
import { asOwnerCall } from "@/lib/calls";
import { explorerUrl, hyperliquidAddressUrl } from "@/lib/explorer";
import { shortfallYocto } from "@/lib/funding";
import { chain } from "@/lib/parry";
import { keys, usePortfolio, useReserves, useVault, useVaultChainState, useVaultHistory } from "@/lib/queries";
import { formatRelativeTime } from "@/lib/format";
import { formatBps, formatNumber, formatPercent, fromUnits, shortId, toUnits } from "@/lib/units";
import { useNow } from "@/lib/use-now";
import { network } from "@/lib/env";
import { cn } from "@/lib/cn";

const DAYS = [
  { value: 7, label: "7 days" },
  { value: 30, label: "30 days" },
  { value: 90, label: "90 days" },
] as const;

function SharePrice() {
  const [days, setDays] = useState<number>(7);
  const q = useVaultHistory(days);
  const { rate, shown } = useMoney();
  const k = rate ?? 1;
  const series = useMemo<ChartSeries[]>(() => {
    const data: { time: number; value: number }[] = [];
    for (const p of q.data ?? []) {
      const time = Math.floor(Date.parse(p.t) / 1000);
      const value = p.sharePriceUsd * k;
      const prev = data[data.length - 1];
      if (Number.isFinite(time) && Number.isFinite(value) && (!prev || time > prev.time)) data.push({ time, value });
    }
    return [{ id: "share", kind: "area", tone: "brass", title: "Share", data }];
  }, [q.data, k]);
  const label = DAYS.find((d) => d.value === days)?.label ?? `${days} days`;
  return (
    <Card as="section" aria-labelledby="share-title" className="grid content-start gap-4">
      <CardHeader
        titleAs="h2"
        title={<span id="share-title">Share price</span>}
        description="One share was worth one dollar at the first deposit; it grows with staking yield and funding."
        actions={<Segmented label="Time range" options={DAYS} value={days as 7 | 30 | 90} onChange={setDays} />}
      />
      {q.isError && !q.data ? (
        <QueryError title="The share price history could not be loaded" error={q.error} onRetry={() => void q.refetch()} />
      ) : q.isPending ? (
        <Skeleton height="260px" shape="block" />
      ) : (
        <Chart series={series} label={`Vault share price, last ${label}`} height={260} valueFormat="usd" currency={shown} precision={4} minSpan={0.02} />
      )}
    </Card>
  );
}

function Hedge({ v }: { v: Vault }) {
  const h = v.hedge;
  const { format } = useMoney();
  const hedged = h.targetNear > 0 ? h.currentNear / h.targetNear : null;
  // With no margin in its Hyperliquid account the vault cannot open the short at all.
  const unfunded = !h.needsMargin && h.accountValueUsd <= 0 && Number(v.stakedLinear) > 0;
  const addressUrl = h.address ? hyperliquidAddressUrl(h.address) : null;
  return (
    <Card as="section" aria-labelledby="hedge-title" className="grid content-start gap-4">
      <CardHeader
        titleAs="h2"
        title={<span id="hedge-title">Hedge</span>}
        description={`A NEAR perp short, ${formatPercent(h.hedgeRatio, 0)} of the staked NEAR.`}
        actions={h.needsMargin ? <Badge tone="critical">Needs margin</Badge> : unfunded ? <Badge tone="caution">Awaiting margin</Badge> : <Badge tone="safe">Margin ok</Badge>}
      />
      <div className="grid gap-1.5">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <span className="text-[13px] text-muted">Current short against the target</span>
          <span className="num text-sm text-fg">
            {formatNumber(h.currentNear, 2)} <span className="text-muted">/ {formatNumber(h.targetNear, 2)} NEAR</span>
          </span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-line" role="meter" aria-label="Hedged share of the target" aria-valuemin={0} aria-valuemax={100} aria-valuenow={hedged !== null ? Math.round(Math.min(1, hedged) * 100) : 0}>
          <div className="h-full rounded-full bg-brass-fill" style={{ width: `${hedged !== null ? Math.min(1, hedged) * 100 : 0}%` }} />
        </div>
        {unfunded ? <p className="text-[13px] text-muted">The hedge account holds no margin yet, so the short is not open. It opens once USDC reaches the hedge address on Hyperliquid.</p> : null}
      </div>
      <DataList>
        <DataRow label="Leverage">
          <span className="num">
            {formatNumber(h.leverage, 2)}x <span className="text-muted">of {formatNumber(h.maxLeverage, 2)}x allowed</span>
          </span>
        </DataRow>
        <DataRow label="Entry and mark">
          <span className="num">
            {format(h.entry)} <span className="text-muted">/</span> {format(h.mark)}
          </span>
        </DataRow>
        <DataRow label="Short liquidates at">
          <span className="num">{h.liquidation > 0 ? format(h.liquidation) : "n/a"}</span>
        </DataRow>
        <DataRow label="Hyperliquid account value" hint="Margin plus unsettled profit and loss">
          <span className="num">{format(h.accountValueUsd)}</span>
        </DataRow>
        <DataRow label="Hedge address">
          {h.address ? (
            <span className="flex flex-wrap items-center justify-end gap-2">
              <span className="num text-[13px]" title={h.address}>
                {shortId(h.address, 8, 6)}
              </span>
              {addressUrl ? (
                <ExternalLink href={addressUrl} className="text-[13px]">
                  Explorer
                </ExternalLink>
              ) : null}
            </span>
          ) : (
            <span className="text-muted">Not reported yet</span>
          )}
        </DataRow>
      </DataList>
      {(h.needsMargin || unfunded) && h.marginRoute ? <MarginRoute route={h.marginRoute} /> : null}
      <LastOrder order={h.lastOrder} />
    </Card>
  );
}

/** When the hedge needs margin: the NEAR Intents 1Click route for USDC on NEAR to USDC on HyperCore, as a dry run. */
function MarginRoute({ route }: { route: NonNullable<Vault["hedge"]["marginRoute"]> }) {
  const { format } = useMoney();
  const now = useNow();
  return (
    <div className="grid gap-1.5 rounded-xl border border-caution/35 bg-caution-soft p-4">
      <p className="text-sm font-semibold text-fg">Margin top-up route</p>
      {route.unavailable ? (
        <p className="text-[13px] text-muted">No 1Click quote right now: {route.unavailable}</p>
      ) : (
        <p className="num text-sm text-fg">
          {format(route.amountUsd)} USDC on NEAR <span aria-hidden="true">→</span>
          <span className="sr-only"> to </span> {route.outUsd !== null ? format(route.outUsd) : "no quote"} on HyperCore
        </p>
      )}
      <p className="text-[13px] text-muted">A dry-run NEAR Intents quote{now ? `, ${formatRelativeTime(route.at, now)}` : ""}: nothing is sent through it on testnet.</p>
    </div>
  );
}

/** The last hedge order: built by the vault, signed by Chain Signatures in a NEAR transaction. */
function LastOrder({ order }: { order: Vault["hedge"]["lastOrder"] }) {
  const { format } = useMoney();
  const now = useNow();
  const href = order ? explorerUrl("nearblocks", order.tx) : null;
  return (
    <div className="grid gap-2 rounded-xl border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold text-fg">Last hedge order</p>
        {order ? <Badge tone={/fail|reject|error/i.test(order.status) ? "critical" : /fill/i.test(order.status) ? "safe" : "neutral"}>{order.status}</Badge> : null}
      </div>
      {order ? (
        <>
          <p className="num text-sm text-fg">
            {order.side === "sell" ? "Sell" : "Buy"} {order.size} NEAR at {Number.isFinite(Number(order.price)) ? format(Number(order.price)) : order.price}
          </p>
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-muted">
            <span>Signed through Chain Signatures{now ? `, ${formatRelativeTime(order.at, now)}` : ""}</span>
            {href ? (
              <ExternalLink href={href} className="text-[13px]">
                NEAR transaction
              </ExternalLink>
            ) : null}
          </p>
        </>
      ) : (
        <p className="text-[13px] text-muted">No order yet: the vault rebalances when the short drifts more than 2% from its target.</p>
      )}
    </div>
  );
}

function Yield({ v }: { v: Vault }) {
  const { format } = useMoney();
  return (
    <Card as="section" aria-labelledby="yield-title" className="grid content-start gap-4">
      <CardHeader titleAs="h2" title={<span id="yield-title">Yield</span>} description="Where the share price growth comes from." />
      <DataList>
        <DataRow label="Staking yield" hint="LiNEAR rate growth, annualized">
          <span className="num">{v.yield.stakingApr !== null ? formatPercent(v.yield.stakingApr, 2) : "Not enough history"}</span>
        </DataRow>
        <DataRow label="Funding received" hint="Paid to the short by longs">
          <span className={cn("num", v.yield.fundingUsd < 0 && "text-critical")}>{format(v.yield.fundingUsd, { signed: true })}</span>
        </DataRow>
        <DataRow label="Hedge profit and loss" hint="Offsets the staked NEAR's price moves">
          <span className="num">{format(v.yield.hedgePnlUsd, { signed: true })}</span>
        </DataRow>
        <DataRow label="LiNEAR rate">
          <span className="num">{formatNumber(v.linearRate, 4)} NEAR</span>
        </DataRow>
        <DataRow label="Staked">
          <span className="num">{fromUnits(v.stakedLinear, 24, 2)} LiNEAR</span>
        </DataRow>
      </DataList>
    </Card>
  );
}

type ReservesResult = ReservesVerification & { chainNote: string | null };

function Reserves({ v }: { v: Vault }) {
  const q = useReserves();
  const onChain = useVaultChainState(false);
  const { format } = useMoney();
  const verify = useMutation({
    mutationFn: async (): Promise<ReservesResult> => {
      const reserves = q.data;
      if (!reserves) throw new Error("No reserves report to check yet.");
      let root: string | null = null;
      let chainNote: string | null = null;
      try {
        const state = await onChain.refetch({ throwOnError: true });
        root = state.data?.reserves?.root ?? null;
        if (!root) chainNote = "The vault contract holds no reserves root yet.";
      } catch {
        chainNote = "The vault contract could not be read, so the root was not compared with the chain.";
      }
      return { ...verifyReserves(reserves, { onChainRoot: root }), chainNote };
    },
  });
  const { reset } = verify;
  useLayoutEffect(() => () => reset(), [reset]);
  const result = verify.data;
  const r = q.data;
  return (
    <Card as="section" aria-labelledby="reserves-title" className="grid content-start gap-5">
      <CardHeader
        titleAs="h2"
        title={<span id="reserves-title">Proof of reserves</span>}
        description="The enclave publishes a Merkle root of everything the vault holds. Check every leaf against it here, and the root against the vault contract."
      />
      {q.isError && !r ? (
        <QueryError title="The reserves report could not be loaded" error={q.error} onRetry={() => void q.refetch()} />
      ) : !r ? (
        <div className="grid gap-3" aria-busy="true">
          <Skeleton />
          <Skeleton width="60%" />
        </div>
      ) : (
        <>
          <StatGroup className="grid-cols-2 sm:grid-cols-3">
            <Stat label="Backing ratio" value={formatBps(r.ratioBps)} hint="Reserves over what depositors are owed" />
            <Stat label="Reserves" value={v.reserves ? format(v.reserves.totalUsd) : "n/a"} />
            <Stat label="Owed to depositors" value={v.reserves ? format(v.reserves.liabilitiesUsd) : "n/a"} />
          </StatGroup>
          <DataList className="border-t border-line">
            <div className="grid gap-1 py-3">
              <dt className="text-sm text-muted">Root</dt>
              <dd className="num break-all text-[12px] text-fg">{r.root}</dd>
            </div>
            <DataRow label="Reported">
              <span className="text-[13px] font-normal">{new Date(r.reportAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
            </DataRow>
          </DataList>
          <div className="overflow-hidden rounded-lg border border-line">
            <table className="w-full border-collapse text-left text-[13px]">
              <caption className="sr-only">Reserve leaves</caption>
              <thead>
                <tr className="border-b border-line text-[12px] uppercase tracking-[0.06em] text-muted">
                  <th scope="col" className="px-4 py-2.5 font-semibold">
                    Asset
                  </th>
                  <th scope="col" className="hidden px-4 py-2.5 font-semibold sm:table-cell">
                    Venue
                  </th>
                  <th scope="col" className="px-4 py-2.5 text-right font-semibold">
                    Value
                  </th>
                  <th scope="col" className="px-4 py-2.5 text-right font-semibold">
                    Proof
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {r.leaves.map((l, i) => {
                  const checked = result?.leaves[i];
                  return (
                    <tr key={`${l.asset}-${l.venue}-${i}`}>
                      <th scope="row" className="px-4 py-2.5 font-semibold text-fg">
                        {l.asset}
                        <span className="block text-[12px] font-normal text-muted sm:hidden">{l.venue}</span>
                      </th>
                      <td className="hidden px-4 py-2.5 text-muted sm:table-cell">{l.venue}</td>
                      <td className="num px-4 py-2.5 text-right text-fg">{format(Number(l.usdE6) / 1e6)}</td>
                      <td className="px-4 py-2.5 text-right">
                        {checked ? <Badge tone={checked.proofOk ? "safe" : "critical"}>{checked.proofOk ? "Verified" : "Fails"}</Badge> : <span className="num whitespace-nowrap text-muted">{l.proof.length} hashes</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="grid gap-3">
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="secondary" size="sm" loading={verify.isPending} loadingLabel="Verifying the reserves" onClick={() => verify.mutate()}>
                Verify
              </Button>
              <span className="text-[13px] text-muted">Hashes every leaf and its proof in this browser.</span>
            </div>
            {verify.isError ? <QueryError title="Verification could not run" error={verify.error} /> : null}
            {result ? (
              <div className="grid gap-2 rounded-xl border border-line bg-surface p-4" aria-live="polite">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-fg">{result.ok ? "The reserves check out" : "The reserves do not check out"}</p>
                  <Badge tone={result.ok ? "safe" : "critical"}>{result.ok ? "Verified" : "Failed"}</Badge>
                </div>
                <ul className="grid gap-1 text-[13px] text-muted">
                  <li>
                    {result.leaves.filter((l) => l.proofOk).length} of {result.leaves.length} leaf proofs verify against the root.
                  </li>
                  <li>{result.rootMatches ? "The leaves recompute the published root." : `The leaves recompute ${shortId(result.recomputedRoot, 10, 8)}, not the published root.`}</li>
                  <li>
                    {result.onChainMatches === null
                      ? (result.chainNote ?? "The root was not compared with the chain.")
                      : result.onChainMatches
                        ? "The root equals the one the vault contract holds."
                        : "The root differs from the one the vault contract holds."}
                  </li>
                </ul>
              </div>
            ) : null}
          </div>
        </>
      )}
    </Card>
  );
}

function Actions({ v, account, signer }: { v: Vault; account: string; signer: Signer }) {
  const acct = useParryAccount();
  const queryClient = useQueryClient();
  const portfolio = usePortfolio(account);
  const { format } = useMoney();
  const [tab, setTab] = useState("deposit");
  const [amount, setAmount] = useState("");
  const [shares, setShares] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useLayoutEffect(
    () => () => {
      setError(null);
      setBusy(null);
    },
    [],
  );
  const watch = signer === "watch";
  const held = portfolio.data?.vault.shares ?? "0";
  const minYocto = BigInt(v.minDepositNear || "0");

  const refresh = () => {
    for (const k of [keys.vault, keys.portfolio(account), keys.balance(account)]) void queryClient.invalidateQueries({ queryKey: k });
  };

  const deposit = async (e: FormEvent) => {
    e.preventDefault();
    const yocto = toUnits(amount, 24);
    if (!yocto || yocto <= 0n) return setError("Enter how much NEAR to deposit.");
    if (yocto < minYocto) return setError(`The vault takes at least ${fromUnits(minYocto, 24)} NEAR.`);
    setError(null);
    setBusy("deposit");
    try {
      const missing = await shortfallYocto(account, yocto);
      if (missing > 0n) {
        if (signer !== "wallet") throw new Error(`Your account needs ${fromUnits(missing, 24)} more NEAR first: send it to the account address.`);
        await acct.fundFromWallet(missing);
      }
      const c = await chain();
      await acct.runOwnerActions([asOwnerCall(c.vaultDepositAction(yocto))], { title: `Deposited ${amount} NEAR in the vault` });
      setAmount("");
      refresh();
    } catch (e2) {
      setError(errorMessage(e2));
    } finally {
      setBusy(null);
    }
  };

  const withdraw = async (e: FormEvent) => {
    e.preventDefault();
    const units = toUnits(shares, 24);
    if (!units || units <= 0n) return setError("Enter how many shares to withdraw.");
    if (units > BigInt(held)) return setError("That is more than the account holds.");
    setError(null);
    setBusy("withdraw");
    try {
      const c = await chain();
      await acct.runOwnerActions([asOwnerCall(c.requestWithdrawAction(units))], { title: "Withdrawal requested" });
      setShares("");
      refresh();
    } catch (e2) {
      setError(errorMessage(e2));
    } finally {
      setBusy(null);
    }
  };

  const claim = async () => {
    setError(null);
    setBusy("claim");
    try {
      const c = await chain();
      await acct.runOwnerActions([asOwnerCall(c.claimAction())], { title: "Claim sent" });
      refresh();
    } catch (e2) {
      setError(errorMessage(e2));
    } finally {
      setBusy(null);
    }
  };

  const errorLine = error ? (
    <p role="alert" className="text-[13px] font-medium text-critical">
      {error}
    </p>
  ) : null;

  return (
    <Card as="section" aria-labelledby="mine-title" className="grid content-start gap-5">
      <CardHeader titleAs="h2" title={<span id="mine-title">Your shares</span>} description="Held by your protected account, which deposits and withdraws for you." />
      <StatGroup className="grid-cols-2">
        <Stat label="Value" loading={portfolio.isPending} value={portfolio.data ? format(portfolio.data.vault.valueUsd) : ""} />
        <Stat label="Shares" loading={portfolio.isPending} value={`${fromUnits(held, 24, 4)} EARN`} />
      </StatGroup>
      {watch ? <Note>You are watching this account. Depositing and withdrawing needs its owner&apos;s wallet or passkey.</Note> : null}
      <Tabs
        label="Vault actions"
        value={tab}
        onValueChange={(t) => {
          setTab(t);
          setError(null);
        }}
        items={[
          {
            id: "deposit",
            label: "Deposit",
            content: (
              <form onSubmit={deposit} className="grid gap-4" noValidate>
                {v.paused ? <Note tone="caution">Deposits are paused while the vault&apos;s risk score is high.</Note> : null}
                <AmountField
                  label="Amount"
                  unit="NEAR"
                  value={amount}
                  onChange={setAmount}
                  disabled={watch || v.paused}
                  hint={`At least ${fromUnits(minYocto, 24)} NEAR. ${signer === "wallet" ? "Your wallet first sends any NEAR the account lacks." : "Paid from the account's own NEAR."}`}
                />
                <div className="flex flex-wrap items-center gap-3">
                  <Button type="submit" disabled={watch || v.paused} loading={busy === "deposit"} loadingLabel="Depositing">
                    Deposit
                  </Button>
                </div>
                {errorLine}
              </form>
            ),
          },
          {
            id: "withdraw",
            label: "Withdraw",
            content: (
              <form onSubmit={withdraw} className="grid gap-4" noValidate>
                <AmountField
                  label="Shares"
                  unit="EARN"
                  value={shares}
                  onChange={setShares}
                  disabled={watch}
                  onMax={() => setShares(fromUnits(held, 24, 24).replace(/,/g, ""))}
                  hint="Shares wait in escrow until the next vault report, then pay out LiNEAR plus their share of the hedge's profit."
                />
                <div>
                  <Button type="submit" variant="secondary" disabled={watch} loading={busy === "withdraw"} loadingLabel="Requesting the withdrawal">
                    Request withdrawal
                  </Button>
                </div>
                {errorLine}
              </form>
            ),
          },
          {
            id: "claim",
            label: "Claim",
            content: (
              <div className="grid gap-4">
                <p className="text-sm leading-6 text-muted">
                  LiNEAR or USDC that could not reach the account when a withdrawal paid out waits as a claim. Claiming sends all of it.
                </p>
                <div>
                  <Button variant="secondary" disabled={watch} loading={busy === "claim"} loadingLabel="Claiming" onClick={() => void claim()}>
                    Claim
                  </Button>
                </div>
                {errorLine}
              </div>
            ),
          },
        ]}
      />
    </Card>
  );
}

function Overview({ v }: { v: Vault }) {
  const { format } = useMoney();
  const now = useNow();
  return (
    <Card as="section" aria-labelledby="overview-title" className="grid gap-6 md:grid-cols-[auto_1fr] md:items-center md:gap-10">
      <h2 id="overview-title" className="sr-only">
        Overview
      </h2>
      <div className="flex flex-col items-center gap-2">
        <RiskGauge score={v.riskScore} label="Vault risk score" />
        <Badge tone={v.paused ? "caution" : "safe"}>{v.paused ? "Deposits paused" : "Open for deposits"}</Badge>
      </div>
      <StatGroup className="grid-cols-2 gap-y-5 lg:grid-cols-4">
        <Stat label="Net asset value" value={format(v.navUsd)} />
        <Stat label="Share price" value={format(v.sharePriceUsd, { digits: 4 })} />
        <Stat label="NEAR price" value={format(v.nearPriceUsd)} hint="As the last report priced it" />
        <Stat label="Last report" value={v.reportAt && now ? formatRelativeTime(v.reportAt, now) : v.reportAt ? "" : "None yet"} hint={`${v.queueLength} ${v.queueLength === 1 ? "withdrawal" : "withdrawals"} queued`} />
      </StatGroup>
    </Card>
  );
}

function VaultBody({ v }: { v: Vault }) {
  const { account, signer, ready, setConnectOpen } = useParryAccount();
  return (
    <div className="grid gap-6" data-stagger>
      <Overview v={v} />
      {account && signer ? (
        <Actions v={v} account={account} signer={signer} />
      ) : ready ? (
        <Card className="flex flex-wrap items-center justify-between gap-4">
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold text-fg">Deposit NEAR</h2>
            <p className="mt-1 text-sm text-muted">Connect a wallet or a passkey account to deposit, withdraw and claim.</p>
          </div>
          <Button onClick={() => setConnectOpen(true)}>Connect</Button>
        </Card>
      ) : null}
      <SharePrice />
      <div className="grid gap-6 lg:grid-cols-2">
        <Hedge v={v} />
        <Yield v={v} />
      </div>
      <Reserves v={v} />
      {network === "testnet" ? (
        <Note tone="brass">
          <p>
            <strong className="font-semibold text-fg">How the testnet vault is funded. </strong>
            The hedge margin on Hyperliquid is operator-funded test USDC and is not depositors&apos; money; it is reported apart from the vault&apos;s value, and only the hedge&apos;s
            profit or loss counts towards it. The USDC buffer that pays positive hedge profit to leavers is operator money too, never part of the net asset value.
          </p>
        </Note>
      ) : null}
    </div>
  );
}

export function VaultView() {
  const q = useVault();
  if (q.isError && !q.data) return <QueryError title="The vault could not be loaded" error={q.error} onRetry={() => void q.refetch()} />;
  if (!q.data) {
    return (
      <div className="grid gap-6" aria-busy="true">
        <span className="sr-only">Loading the vault</span>
        <Card>
          <Skeleton height="9rem" shape="block" />
        </Card>
        <Card>
          <Skeleton height="16rem" shape="block" />
        </Card>
      </div>
    );
  }
  return <VaultBody v={q.data} />;
}

