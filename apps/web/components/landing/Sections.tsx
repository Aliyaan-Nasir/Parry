"use client";

import type { CertificateBody } from "@parry/sdk";
import Link from "next/link";
import { useEffect, useState } from "react";
import proofs from "@/lib/proofs.generated.json";
import { Rise, useRevealed } from "@/components/fx/Reveal";
import { Spotlight } from "@/components/fx/Spotlight";
import { Terminal } from "@/components/fx/Terminal";
import { Heatmap } from "@/components/instrument/Heatmap";
import { Sparkline } from "@/components/ui/Sparkline";
import { SectionHead } from "./Story";
import { getJson, useCertificates, useHeatmap, useInsurance, useRatesLive, useReplay, type Check } from "@/lib/live";
import { useDecisions, useVault, useVaultHistory } from "@/lib/queries";
import { formatUsdCompact } from "@/lib/format";
import { cn } from "@/lib/cn";

const pct = (v: number, d = 1) => `${(v * 100).toFixed(d)}%`;

/** A live slice of the real liquidation map, read from Rhea lending on mainnet. */
export function CascadeSlice() {
  const main = useHeatmap("mainnet");
  const test = useHeatmap("testnet");
  const map = main.data ?? test.data ?? null;
  const total = map ? map.buckets.reduce((s, b) => s + b.collateralUsd, 0) : 0;
  const within20 = map ? map.buckets.filter((b) => b.price >= map.price * 0.8).reduce((s, b) => s + b.collateralUsd, 0) : 0;
  return (
    <section className="py-24 sm:py-32">
      <div className="mx-auto max-w-[1180px] px-4 sm:px-6">
        <SectionHead
          title={["Where the next", "cascade would start."]}
          lead={
            map
              ? `Read straight from Rhea lending on ${map.network}: ${map.accounts.toLocaleString()} borrowing accounts, ${formatUsdCompact(total)} of collateral that liquidates as NEAR falls, ${formatUsdCompact(within20)} of it within a 20% drop. Brass arcs mark where one wave of liquidations pushes the price into the next.`
              : "Read straight from Rhea lending: every borrowing account's liquidation price, bucketed by how far NEAR would have to fall. Parry's cascade pressure is computed from this map."
          }
        />
        <div className="surface mt-12 p-5 sm:p-7">
          {map ? (
            <Heatmap buckets={map.buckets} cascades={map.cascades} price={map.price} height={300} />
          ) : (
            <div className="grid h-[300px] place-items-center text-sm text-muted">The map is loading from Rhea lending.</div>
          )}
        </div>
        <div className="mt-4 flex justify-end">
          <Link href="/app/cascade" className="text-sm text-brass underline-offset-4 hover:underline">
            Open the full cascade map
          </Link>
        </div>
      </div>
    </section>
  );
}

/** The vault, drawn: NEAR into LiNEAR on one side, the short on the other, the insurance fund beneath. */
export function Earn() {
  const vault = useVault();
  const history = useVaultHistory(30);
  const rates = useRatesLive();
  const insurance = useInsurance();
  const v = vault.data;
  const ratio = v?.hedge.hedgeRatio ?? 0.9;
  const share = (history.data ?? []).map((p) => p.sharePriceUsd);
  const r = rates.data;
  const bars = [
    r?.vault?.netApr != null ? { label: "Parry vault, net", value: r.vault.netApr, source: r.vault.source, strong: true } : null,
    r?.vault?.stakingApr != null ? { label: "of which LiNEAR staking", value: r.vault.stakingApr, source: r.vault.source } : null,
    r?.hyperliquid?.funding24hApr != null ? { label: "Hyperliquid NEAR funding, 24 h", value: r.hyperliquid.funding24hApr, source: r.hyperliquid.source } : null,
    ...(r?.rhea ?? [])
      .filter((a) => ["NEAR", "wNEAR", "USDC"].includes(a.asset))
      .map((a) => ({ label: `Rhea supply, ${a.asset}`, value: a.supplyApr, source: a.source })),
  ].filter((b): b is { label: string; value: number; source: string; strong?: boolean } => !!b);
  const maxBar = Math.max(0.01, ...bars.map((b) => Math.abs(b.value)));
  return (
    <section id="earn" className="scroll-mt-24 py-24 sm:py-32">
      <div className="mx-auto max-w-[1180px] px-4 sm:px-6">
        <SectionHead title={["Earn without", "liquidation risk at all."]} lead="A delta-neutral vault for NEAR. Your deposit is staked into LiNEAR, and the vault shorts the same NEAR on Hyperliquid, so a share holds its dollar value while it earns staking yield and funding. Nobody in it can be liquidated." />
        <div className="mt-14 grid gap-6 lg:grid-cols-[1.25fr_1fr]">
          <div className="surface relative overflow-hidden p-6 sm:p-8">
            <VaultDiagram ratio={ratio} insuranceUsd={insurance.data?.available ? Number(insurance.data.valueUsdE6) / 1e6 : null} shareBps={insurance.data?.shareBps ?? r?.vault?.insuranceShareBps ?? 1000} />
          </div>
          <div className="grid gap-6">
            <div className="surface p-6">
              <div className="flex items-end justify-between">
                <span className="label">Share price, 30 days</span>
                <span className="num text-2xl text-fg">{v ? `$${v.sharePriceUsd.toFixed(4)}` : "$1.0000"}</span>
              </div>
              <div className="mt-4 h-20">{share.length > 1 ? <Sparkline data={share} label="Vault share price over 30 days" width={480} height={80} area className="h-full w-full" /> : <div className="h-full border-b border-line" />}</div>
            </div>
            <div className="surface p-6">
              <div className="label">Yield, read live, with sources</div>
              <ul className="mt-4 space-y-3.5">
                {bars.length ? (
                  bars.map((b) => (
                    <li key={b.label}>
                      <div className="flex items-end justify-between text-sm">
                        <span className={cn(b.strong ? "text-fg" : "text-muted")}>{b.label}</span>
                        <span className="num text-fg">{pct(b.value, 2)}</span>
                      </div>
                      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-line">
                        <div className={cn("h-full rounded-full", b.strong ? "bg-brass-fill" : "bg-fg/40")} style={{ width: `${(Math.abs(b.value) / maxBar) * 100}%` }} />
                      </div>
                      <div className="mt-1 text-[11.5px] text-muted/80">{b.source}</div>
                    </li>
                  ))
                ) : (
                  <li className="text-sm text-muted">Rates load from Rhea lending, Hyperliquid and the vault.</li>
                )}
              </ul>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function VaultDiagram({ ratio, insuranceUsd, shareBps }: { ratio: number; insuranceUsd: number | null; shareBps: number }) {
  const ref = useRevealed<HTMLDivElement>();
  return (
    <div ref={ref} className="group">
      <svg viewBox="0 0 560 360" className="blueprint h-auto w-full" role="img" aria-label={`The deposit is staked into LiNEAR and hedged ${pct(ratio, 0)} with a short NEAR perp; ${shareBps / 100}% of positive yield funds the insurance fund.`}>
        <defs>
          <path id="leg-long" d="M70 70 C 150 70, 170 150, 280 170" />
          <path id="leg-short" d="M490 70 C 410 70, 390 150, 280 170" />
          <path id="leg-ins" d="M280 190 L 280 268" />
        </defs>
        {/* Construction lines. */}
        <line x1="0" y1="170" x2="560" y2="170" strokeDasharray="2 6" />
        <line x1="280" y1="0" x2="280" y2="360" strokeDasharray="2 6" />
        <circle cx="280" cy="170" r="70" strokeDasharray="2 6" />
        {/* Legs. */}
        <use href="#leg-long" style={{ stroke: "var(--parry-text)", strokeWidth: 1.6, fill: "none", opacity: 0.7 }} />
        <use href="#leg-short" style={{ stroke: "var(--parry-text)", strokeWidth: 1.6, fill: "none", opacity: 0.7 }} />
        <use href="#leg-ins" style={{ stroke: "var(--parry-brass-fill)", strokeWidth: 1.6, fill: "none" }} />
        {/* Flow. */}
        {[0, 1.2, 2.4].map((d) => (
          <g key={d} className="motion-reduce:hidden">
            <circle r="3" style={{ fill: "var(--parry-brass-fill)" }}>
              <animateMotion dur="3.6s" begin={`${d}s`} repeatCount="indefinite">
                <mpath href="#leg-long" />
              </animateMotion>
            </circle>
            <circle r="3" style={{ fill: "var(--parry-text)" }}>
              <animateMotion dur="3.6s" begin={`${d + 0.6}s`} repeatCount="indefinite">
                <mpath href="#leg-short" />
              </animateMotion>
            </circle>
          </g>
        ))}
        <circle r="2.5" className="motion-reduce:hidden" style={{ fill: "var(--parry-brass-fill)" }}>
          <animateMotion dur="2.4s" repeatCount="indefinite">
            <mpath href="#leg-ins" />
          </animateMotion>
        </circle>
        {/* Nodes. */}
        <g style={{ fill: "var(--parry-text)", fontSize: 14 }}>
          <text x="40" y="52">NEAR staked</text>
          <text x="40" y="94" style={{ fill: "var(--parry-muted)", fontSize: 12 }}>
            into LiNEAR, earning staking
          </text>
          <text x="520" y="52" textAnchor="end">
            NEAR perp, short
          </text>
          <text x="520" y="94" textAnchor="end" style={{ fill: "var(--parry-muted)", fontSize: 12 }}>
            on Hyperliquid, earning funding
          </text>
        </g>
        <circle cx="280" cy="170" r="30" style={{ fill: "var(--parry-bg)", stroke: "var(--parry-brass-fill)", strokeWidth: 1.5 }} />
        <text x="280" y="167" textAnchor="middle" className="num" style={{ fill: "var(--parry-text)", fontSize: 15 }}>
          {pct(ratio, 0)}
        </text>
        <text x="280" y="183" textAnchor="middle" style={{ fill: "var(--parry-muted)", fontSize: 10 }}>
          hedged
        </text>
        <rect x="190" y="270" width="180" height="62" rx="12" style={{ fill: "var(--parry-surface)", stroke: "var(--parry-brass-fill)", strokeOpacity: 0.6 }} />
        <text x="280" y="296" textAnchor="middle" style={{ fill: "var(--parry-text)", fontSize: 13.5 }}>
          Insurance fund {insuranceUsd !== null ? formatUsdCompact(insuranceUsd) : ""}
        </text>
        <text x="280" y="316" textAnchor="middle" style={{ fill: "var(--parry-muted)", fontSize: 11.5 }}>
          {shareBps / 100}% of positive yield
        </text>
      </svg>
      <p className="mt-4 text-sm leading-relaxed text-muted">
        The fund pays only for named losses: a streak of negative funding, hedge slippage beyond the band, and Hyperliquid margin top-ups under stress. Its rules and every payout are on chain.
      </p>
    </div>
  );
}

/** A real signed decision from testnet, its checks run in front of the visitor. */
export function ReviewProof() {
  const decisions = useDecisions(null, 10);
  const decision = decisions.data?.pages.flatMap((p) => p.items).find((d) => d.outcome === "executed") ?? null;
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [shown, setShown] = useState(0);
  const ref = useRevealed<HTMLDivElement>();
  const certs = useCertificates();
  const cert = certs.data?.[0] ?? null;
  // The certificate is the exact JSON text the enclave signed.
  const body = cert ? (JSON.parse(cert.certificate) as CertificateBody) : null;
  useEffect(() => {
    if (!decision) return;
    let cancelled = false;
    getJson<{ ok: boolean; checks: Check[] }>(`/v1/guardian/decisions/${decision.id}/verify`).then((v) => !cancelled && v && setChecks(v.checks), () => {});
    return () => {
      cancelled = true;
    };
  }, [decision]);
  useEffect(() => {
    if (!checks) return;
    const el = ref.current;
    if (!el) return;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const t = window.setTimeout(() => setShown(checks.length), 0);
      return () => window.clearTimeout(t);
    }
    let timer = 0;
    const io = new IntersectionObserver(([e]) => {
      if (!e?.isIntersecting) return;
      io.disconnect();
      let i = 0;
      const tick = () => {
        i += 1;
        setShown(i);
        if (i < checks.length) timer = window.setTimeout(tick, 420);
      };
      timer = window.setTimeout(tick, 300);
    }, { threshold: 0.4 });
    io.observe(el);
    return () => {
      io.disconnect();
      window.clearTimeout(timer);
    };
  }, [checks, ref]);
  return (
    <section className="py-24 sm:py-32">
      <div className="mx-auto max-w-[1180px] px-4 sm:px-6">
        <SectionHead title={["A second opinion,", "signed and checkable."]} lead="No rescue runs on the guardian's word alone. A verifiable model reviews each plan inside a TEE and signs its verdict; the hash rides on chain with the action. And a position's owner can prove its health to someone, without showing a single amount." />
        <div className="mt-14 grid gap-6 lg:grid-cols-2">
          <div ref={ref} className="surface p-6 sm:p-7">
            <div className="flex items-end justify-between gap-4">
              <span className="text-fg">A real rescue on testnet</span>
              {decision ? (
                <Link href={`/verify?id=${decision.id}`} className="num text-xs text-brass hover:underline">
                  {decision.id.slice(0, 10)}...
                </Link>
              ) : null}
            </div>
            <p className="mt-3 text-sm leading-relaxed text-muted">{decision ? decision.plan : "The latest executed rescue loads from the guardian's log."}</p>
            {decision?.review.reasoning ? <blockquote className="mt-4 border-l border-brass-fill/60 pl-4 text-sm leading-relaxed text-fg/85">{decision.review.reasoning}</blockquote> : null}
            <ul className="mt-6 divide-y divide-line border-t border-line">
              {(checks ?? []).map((c, i) => (
                <li key={c.name} className={cn("flex items-center justify-between gap-4 py-3 text-sm transition-opacity duration-300", i < shown ? "opacity-100" : "opacity-0")}>
                  <span className="text-fg">{c.name}</span>
                  <span className={cn("num", c.ok ? "text-fg" : "text-critical")}>{c.ok ? "checks" : "fails"}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="surface p-6 sm:p-7">
            <div className="text-fg">A private health certificate</div>
            <p className="mt-3 text-sm leading-relaxed text-muted">
              The guardian enclave reads the position on chain at a given block and signs one sentence for one named reader: health is at least the threshold. No amounts, no collateral, no debt.
            </p>
            {cert ? (
              <dl className="mt-6 divide-y divide-line border-t border-line text-sm">
                {[
                  ["Statement", body!.statement],
                  ["For", body!.reader],
                  ["Block", body!.block_height.toLocaleString()],
                  ["Expires", new Date(body!.expires_at * 1000).toUTCString().slice(5, 22)],
                  ["Signed by", `${cert.enclavePublicKey.slice(0, 18)}...`],
                ].map(([k, val]) => (
                  <div key={k} className="flex justify-between gap-6 py-3">
                    <dt className="text-muted">{k}</dt>
                    <dd className="num truncate text-right text-fg">{val}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <div className="mt-6 border-t border-line pt-5 text-sm text-muted">Issued certificates appear here once the enclave issues them on testnet.</div>
            )}
            <Link href="/verify" className="mt-5 inline-block text-sm text-brass underline-offset-4 hover:underline">
              Verify a decision or certificate
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}

/** Line art per primitive, drawn with one stroke so it can draw itself in. */
const ART: Record<string, string> = {
  "NEP-655 universal accounts and global contracts": "M10 50 h60 M40 20 v60 M20 30 l40 40 M60 30 l-40 40",
  "Chain Signatures": "M15 60 q25 -50 50 0 t50 0 M15 60 h100",
  "MPC foreign-transaction verification": "M20 40 l20 20 l40 -40 M20 70 h80",
  "OutLayer TEE": "M30 20 h60 v60 h-60 z M45 35 h30 v30 h-30 z",
  "NEAR AI Cloud verifiable models": "M20 70 q40 -70 80 0 M60 20 v60",
  "Rhea lending and exchange": "M20 70 v-30 M45 70 v-45 M70 70 v-20 M95 70 v-50",
  "x402 on NEAR": "M20 50 h70 l-15 -15 M90 50 l-15 15",
  "Gas keys (NEP-611)": "M25 50 a15 15 0 1 1 30 0 a15 15 0 1 1 -30 0 M55 50 h50 M90 50 v15 M100 50 v10",
  "Post-quantum keys (ML-DSA-65)": "M20 20 h20 v20 h-20 z M50 20 h20 v20 h-20 z M80 20 h20 v20 h-20 z M20 50 h20 v20 h-20 z M50 50 h20 v20 h-20 z M80 50 h20 v20 h-20 z",
};

export function NearBento() {
  const items = proofs.items;
  return (
    <section id="near" className="scroll-mt-24 py-24 sm:py-32">
      <div className="mx-auto max-w-[1180px] px-4 sm:px-6">
        <SectionHead title={["Built from parts", "only NEAR has."]} lead="Each guarantee comes from a NEAR primitive, and each links to a transaction on testnet that shows it working." />
        <div className="ruled mt-14 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((it, i) => (
            <Spotlight key={it.name} fill className="p-6 sm:p-7">
              <Rise delay={(i % 3) * 80}>
                <svg viewBox="0 0 120 90" className="draw-in h-16 w-24" aria-hidden="true">
                  <path d={ART[it.name] ?? "M20 45 h80"} pathLength={1} style={{ stroke: "var(--parry-brass-fill)" }} fill="none" strokeWidth={1.5} />
                </svg>
                <h3 className="mt-5 text-lg text-fg">{it.name}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted">{it.what}</p>
                {it.links.length ? (
                  <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-[13px]">
                    {it.links.slice(0, 3).map((l) => (
                      <a key={l.url} href={l.url} target="_blank" rel="noreferrer" className="text-brass underline-offset-4 hover:underline">
                        {l.label}
                      </a>
                    ))}
                  </div>
                ) : null}
              </Rise>
            </Spotlight>
          ))}
        </div>
      </div>
    </section>
  );
}

/** The crash replay's headline result. */
export function ReplayHeadline() {
  const { data } = useReplay();
  const s = data?.summary;
  return (
    <section className="py-24 sm:py-32">
      <div className="mx-auto max-w-[1180px] px-4 sm:px-6">
        <div className="grid gap-10 lg:grid-cols-[1fr_1fr] lg:items-end">
          <SectionHead title={["Replayed through", "NEAR's worst crashes."]} lead="Real hourly NEAR prices from Binance's public market data, run through Parry's risk model, guardian and vault. Every number is computed by a script anyone can run, not claimed." />
          <div className="grid grid-cols-2 gap-8">
            <div>
              <div className="display text-[4.5rem] leading-none text-fg sm:text-[5.5rem]">{s ? `${(s.medianWarningHours ?? 0).toFixed(0)}h` : "..."}</div>
              <div className="label mt-3">median warning before liquidation</div>
            </div>
            <div>
              <div className="display text-[4.5rem] leading-none text-fg sm:text-[5.5rem]">{s ? `${s.liquidationsAvoided}/${s.crashes}` : "..."}</div>
              <div className="label mt-3">liquidations avoided with Parry</div>
            </div>
          </div>
        </div>
        <Link href="/replay" className="mt-10 inline-block text-sm text-brass underline-offset-4 hover:underline">
          See each crash, hour by hour
        </Link>
      </div>
    </section>
  );
}

export function Agents() {
  return (
    <section id="agents" className="scroll-mt-24 py-24 sm:py-32">
      <div className="mx-auto grid max-w-[1180px] gap-12 px-4 sm:px-6 lg:grid-cols-[0.9fr_1.1fr] lg:items-center">
        <SectionHead
          title={["Agents can", "use it too."]}
          lead="Everything a person sees, an agent can read through the MCP server: positions, risk, the guardian's log and its proofs, the vault. Write tools are capped and testnet only, and risk checks can be paid per call over x402 on NEAR."
        />
        <Terminal
          title="claude"
          lines={[
            { kind: "cmd", text: "claude mcp add parry -- npx -y @parry/mcp" },
            { kind: "out", text: "Added stdio MCP server parry" },
            { kind: "comment", text: "# ask the agent: is alice.near at risk?" },
            { kind: "cmd", text: "parry.risk_check({ account: \"alice.near\" })" },
            { kind: "out", text: "health 1.32 (caution), liquidation at $2.79" },
            { kind: "out", text: "liquidation in 24 h: 0.4 %, median time beyond 30 days" },
            { kind: "out", text: "score 11 of 100, Tremor index 98 % a year (stressed)" },
          ]}
        />
      </div>
    </section>
  );
}
