"use client";

import { DataList, DataRow, Note, QueryError } from "@/components/app/bits";
import { TimeAgo } from "@/components/app/Feeds";
import { useLive } from "@/components/providers/LiveProvider";
import { formatRelativeTime } from "@/lib/format";
import { useNow } from "@/lib/use-now";
import { Card, CardHeader } from "@/components/ui/Card";
import { Skeleton } from "@/components/ui/Skeleton";
import { useStatus } from "@/lib/queries";
import { formatNumber, shortId } from "@/lib/units";
import { cn } from "@/lib/cn";

const SERVICE_LABEL: Record<string, string> = {
  monitor: "Monitor",
  risk: "Risk engine",
  "risk-publisher": "Risk publisher",
  guardian: "Guardian relay",
  keeper: "Keeper",
  relayer: "Relayer",
  indexer: "Indexer",
  "indexer-lag": "Indexer lag",
  alerts: "Alerts",
  topup: "Top-up",
  market: "Agent Market",
  agent: "Agent",
  api: "API",
  enclave: "Enclave",
  treasury: "Treasury",
  heatmap: "Heatmap sweep",
  incidents: "Incidents",
  stream: "Live stream",
};

function Up({ ok, yes = "Up", no = "Down" }: { ok: boolean; yes?: string; no?: string }) {
  return <span className={cn("text-[13px]", ok ? "text-fg" : "text-critical")}>{ok ? yes : no}</span>;
}

type Hour = { hour: string; checks: number; ok: number };

/** 48 bars, one an hour, oldest first: full when every report that hour was ok, red when some were not, faint when none came. */
function UptimeBars({ hours, now }: { hours: Hour[]; now: number }) {
  const at = new Map(hours.map((h) => [Math.floor(Date.parse(h.hour) / 3_600_000), h]));
  const last = Math.floor(now / 3_600_000);
  return (
    <span className="flex h-6 items-end gap-[2px]" role="img" aria-label={`${hours.length} of the last 48 hours reported`}>
      {Array.from({ length: 48 }, (_, i) => {
        const h = at.get(last - 47 + i);
        const ratio = h && h.checks ? h.ok / h.checks : null;
        return (
          <span
            key={i}
            title={h ? `${new Date((last - 47 + i) * 3_600_000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit" })}: ${h.ok} of ${h.checks} reports ok` : "no reports"}
            className={cn("w-[3px] rounded-[1px]", ratio === null ? "h-2 bg-line" : ratio === 1 ? "h-6 bg-fg/55" : ratio > 0.9 ? "h-6 bg-caution" : "h-6 bg-critical")}
          />
        );
      })}
    </span>
  );
}

/** How this browser hears about changes: the API's event stream, or polling. */
function LiveHealth() {
  const live = useLive();
  const now = useNow();
  return (
    <Card as="section" aria-labelledby="live-title" className="grid content-start gap-4">
      <CardHeader titleAs="h2" title={<span id="live-title">Live updates</span>} description="Server-Sent Events from the API; while the stream is down, every page keeps polling on its own interval." />
      <DataList>
        <DataRow label="Mode">
          <span className={cn("text-sm", live.mode === "stream" ? "text-fg" : "text-muted")}>{live.mode === "stream" ? "Streaming" : live.mode === "connecting" ? "Connecting" : "Polling"}</span>
        </DataRow>
        <DataRow label="Connected">
          <span className="text-sm">{live.since && now ? formatRelativeTime(new Date(live.since).toISOString(), now) : "not now"}</span>
        </DataRow>
        <DataRow label="Events received">
          <span className="num">{live.events}</span>
        </DataRow>
        <DataRow label="Last event">
          <span className="text-sm">{live.lastEventAt && now ? formatRelativeTime(new Date(live.lastEventAt).toISOString(), now) : "none yet"}</span>
        </DataRow>
        <DataRow label="Reconnects">
          <span className="num">{live.reconnects}</span>
        </DataRow>
      </DataList>
    </Card>
  );
}

function CardSkeleton() {
  return (
    <div className="grid gap-3" aria-busy="true">
      <Skeleton />
      <Skeleton />
      <Skeleton width="70%" />
    </div>
  );
}

/** Parry's services, the oracle, the indexer, gas-key lanes and the treasury, from /v1/status. */
export function StatusBoard() {
  const q = useStatus();
  const s = q.data;
  const now = useNow();
  if (q.isError && !s) return <QueryError title="Service status could not be loaded" error={q.error} onRetry={() => void q.refetch()} />;
  const down = s?.services.filter((x) => !x.ok).length ?? 0;
  const isGasKey = (name: string) => / gas key$/.test(name);
  const gasKeys = new Map((s?.treasury?.wallets ?? []).filter((w) => isGasKey(w.name)).map((w) => [w.name.replace(/ gas key$/, ""), w]));
  const wallets = (s?.treasury?.wallets ?? []).filter((w) => !isGasKey(w.name));

  return (
    <div className="grid gap-6" data-stagger>
      <Card as="section" padding="none" aria-labelledby="services-title">
        <div className="px-5 pb-4 pt-5 sm:px-6">
          <CardHeader
            titleAs="h2"
            title={<span id="services-title">Services</span>}
            description="Each service reports its own state; one silent for five minutes counts as down. The bars are the last 48 hours, an hour each."
            actions={s ? <Up ok={down === 0} yes="All up" no={`${down} down`} /> : <Skeleton width="7ch" />}
          />
        </div>
        {!s ? (
          <div className="border-t border-line px-5 py-5 sm:px-6">
            <CardSkeleton />
          </div>
        ) : s.services.length === 0 ? (
          <p className="border-t border-line px-5 py-5 text-sm text-muted sm:px-6">No service has reported yet.</p>
        ) : (
          <ul className="divide-y divide-line border-t border-line">
            {s.services.map((x) => {
              const up = s.uptime?.find((u) => u.name === x.name);
              return (
                <li key={x.name} className="grid gap-x-6 gap-y-1.5 px-5 py-3 sm:grid-cols-[10rem_auto_4rem_minmax(0,1fr)_5rem] sm:items-center sm:px-6">
                  <span className="flex items-center justify-between gap-3 sm:contents">
                    <span className="text-sm text-fg">{SERVICE_LABEL[x.name] ?? x.name}</span>
                    <span className="sm:order-5 sm:text-right">
                      <Up ok={x.ok} />
                    </span>
                  </span>
                  <span className="sm:order-2">{up && now ? <UptimeBars hours={up.hours} now={now} /> : null}</span>
                  <span className="num text-[12.5px] text-muted sm:order-3 sm:text-right">{up?.ratio != null ? `${(up.ratio * 100).toFixed(up.ratio === 1 ? 0 : 1)}%` : ""}</span>
                  <span className="min-w-0 text-[12.5px] leading-5 text-muted [overflow-wrap:anywhere] sm:order-4">
                    {x.detail || "No detail"} <TimeAgo iso={x.checkedAt} className="ml-1 text-muted/80" />
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-3">
        <LiveHealth />
        <Card as="section" aria-labelledby="oracle-title" className="grid content-start gap-4">
          <CardHeader titleAs="h2" title={<span id="oracle-title">Oracle</span>} description="The NEAR price lending and the guardian read. Stale after 120 seconds." />
          {!s ? (
            <CardSkeleton />
          ) : s.oracle ? (
            <DataList>
              <DataRow label="Freshness">
                <Up ok={s.oracle.fresh} yes="Fresh" no="Stale" />
              </DataRow>
              <DataRow label="Age">
                <span className="num">{s.oracle.ageSeconds} s</span>
              </DataRow>
              <DataRow label="Published">
                <TimeAgo iso={s.oracle.publishTime} className="text-sm text-fg" />
              </DataRow>
            </DataList>
          ) : (
            <p className="text-sm text-muted">The oracle did not answer.</p>
          )}
        </Card>

        <Card as="section" aria-labelledby="indexer-title" className="grid content-start gap-4">
          <CardHeader titleAs="h2" title={<span id="indexer-title">Indexer</span>} description="How far the event indexer is behind the chain head." />
          {!s ? (
            <CardSkeleton />
          ) : (
            <DataList>
              <DataRow label="Last block">
                <span className="num">{s.indexer.lastBlock > 0 ? new Intl.NumberFormat("en-US").format(s.indexer.lastBlock) : "None yet"}</span>
              </DataRow>
              <DataRow label="Behind the head">
                <span className="num">{s.indexer.lagBlocks === null ? "Unknown" : `${new Intl.NumberFormat("en-US").format(s.indexer.lagBlocks)} blocks`}</span>
              </DataRow>
            </DataList>
          )}
        </Card>
      </div>

      <Card as="section" padding="none" aria-labelledby="lanes-title">
        <div className="px-5 pb-4 pt-5 sm:px-6">
          <CardHeader
            titleAs="h2"
            title={<span id="lanes-title">Gas-key lanes</span>}
            description="Each service sends on parallel gas-key nonce lanes, so its transactions never queue behind one another. Each gas key carries its own prepaid gas."
          />
        </div>
        {!s ? (
          <div className="border-t border-line px-5 py-5 sm:px-6">
            <CardSkeleton />
          </div>
        ) : (
          <ul className="divide-y divide-line border-t border-line">
            {s.lanes.map((l) => (
              <li key={l.service} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-5 py-3.5 sm:px-6">
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-fg">{SERVICE_LABEL[l.service] ?? l.service}</span>
                  <span className="num block text-[13px] text-muted [overflow-wrap:anywhere]" title={l.key ?? undefined}>
                    {l.account ?? "No account configured"}
                    {l.key ? ` · ${shortId(l.key, 14, 6)}` : ""}
                  </span>
                </span>
                <span className="grid justify-items-end text-right">
                  <span className="num text-[13px] text-fg">
                    {l.nonces} {l.nonces === 1 ? "lane" : "lanes"}
                    {typeof l.inFlight === "number" ? <span className="text-muted">, {l.inFlight} in flight</span> : null}
                  </span>
                  {gasKeys.get(l.service) ? (
                    <span className="num text-[12px] text-muted">
                      {formatNumber(gasKeys.get(l.service)!.balanceNear, 2)} NEAR prepaid gas
                    </span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card as="section" aria-labelledby="treasury-title" className="grid content-start gap-4">
        <CardHeader
          titleAs="h2"
          title={<span id="treasury-title">Treasury</span>}
          description="The treasury tops up every service wallet and gas key when it falls below half its target."
          actions={
            s?.treasury ? (
              <span className="flex flex-wrap items-center gap-1.5">
                {s.treasury.postQuantumKey ? <span className="text-[12.5px] text-muted">Post-quantum key (ML-DSA-65)</span> : null}
                <Up ok={!s.treasury.low} yes="Funded" no="Low" />
              </span>
            ) : null
          }
        />
        {!s ? (
          <CardSkeleton />
        ) : !s.treasury ? (
          <p className="text-sm text-muted">No treasury is configured for this deployment.</p>
        ) : (
          <>
            {s.treasury.low ? <Note tone="caution">The treasury is below its target: service wallets may stop being topped up.</Note> : null}
            <DataList>
              <DataRow label="Account">
                <span className="num break-all text-[13px]">{s.treasury.account}</span>
              </DataRow>
              <DataRow label="Balance">
                <span className="num">{formatNumber(s.treasury.balanceNear, 2)} NEAR</span>
              </DataRow>
            </DataList>
            {wallets.length > 0 ? (
              <ul className="grid gap-3">
                {wallets.map((w) => {
                  const fill = w.target > 0 ? Math.min(1, w.balanceNear / w.target) : 1;
                  const low = w.balanceNear < w.target / 2;
                  return (
                    <li key={w.name} className="grid gap-1.5">
                      <div className="flex flex-wrap items-end justify-between gap-x-3">
                        <span className="min-w-0">
                          <span className="text-sm font-semibold text-fg">{SERVICE_LABEL[w.name] ?? w.name}</span>
                          <span className="num ml-2 text-[12px] text-muted">{shortId(w.account, 16, 8)}</span>
                        </span>
                        <span className="num text-[13px] text-fg">
                          {formatNumber(w.balanceNear, 2)} <span className="text-muted">/ {formatNumber(w.target, 0)} NEAR</span>
                        </span>
                      </div>
                      <div
                        className="h-1.5 overflow-hidden rounded-full bg-line"
                        role="meter"
                        aria-label={`${w.name} wallet balance against its target`}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={Math.round(fill * 100)}
                      >
                        <div className={cn("h-full rounded-full", low ? "bg-critical" : "bg-safe")} style={{ width: `${fill * 100}%` }} />
                      </div>
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </>
        )}
      </Card>
    </div>
  );
}
