"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { RevealText, Rise } from "@/components/fx/Reveal";
import { Marquee } from "@/components/fx/Marquee";
import { RiskInstrument } from "@/components/instrument/RiskInstrument";
import { NumberTicker } from "@/components/ui/NumberTicker";
import { useStatsLive } from "@/lib/live";
import { formatUsdCompact } from "@/lib/format";
import { cn } from "@/lib/cn";

export function SectionHead({ id, title, lead, className, center = false }: { id?: string; title: readonly ReactNode[]; lead?: ReactNode; className?: string; center?: boolean }) {
  return (
    <div id={id} className={cn("scroll-mt-28", center && "text-center", className)}>
      <RevealText lines={title} className={cn("display-sm text-gradient text-[2.4rem] sm:text-[3.4rem] lg:text-[4rem]", center && "mx-auto")} />
      {lead ? <p className={cn("mt-5 max-w-[38rem] text-lg leading-relaxed text-muted", center && "mx-auto")}>{lead}</p> : null}
    </div>
  );
}

/** Staleness is shown only when the data really is stale. */
function stale(iso: string | undefined): string | null {
  if (!iso) return null;
  const age = Date.now() - Date.parse(iso);
  return age > 15 * 60_000 ? `as of ${new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : null;
}

/** One giant live number, and a few smaller ones, all from the Parry API on testnet. */
export function LiveProof() {
  const { data } = useStatsLive();
  const big = data?.valueProtectedUsd ?? null;
  const note = stale(data?.updatedAt);
  const figure = (label: string, value: ReactNode) => (
    <div className="min-w-0">
      <div className="num text-3xl tracking-tight text-fg sm:text-4xl">{value}</div>
      <div className="label mt-2">{label}</div>
    </div>
  );
  return (
    <section className="relative border-y border-line py-20 sm:py-28" aria-label="Parry on testnet, live">
      <div className="mx-auto grid max-w-[1180px] gap-14 px-4 sm:px-6 lg:grid-cols-[1.3fr_1fr] lg:items-end">
        <div>
          <div className="label">Value under Parry&apos;s protection on NEAR testnet{note ? `, ${note}` : ""}</div>
          <div className="display mt-4 text-[4.5rem] leading-none text-fg sm:text-[7.5rem]">
            {big === null ? <span className="text-muted/40">$0</span> : <NumberTicker value={big} format={(v) => formatUsdCompact(v)} />}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-x-8 gap-y-10">
          {figure("Positions watched", data ? <NumberTicker value={data.positionsWatched ?? data.positionsProtected} format={(v) => Math.round(v).toString()} /> : "0")}
          {figure("Rescues, each AI reviewed", data ? <NumberTicker value={data.rescues} format={(v) => Math.round(v).toString()} /> : "0")}
          {figure("Vault size", data ? formatUsdCompact(data.vaultTvlUsd) : "$0")}
          {figure("Insurance fund", data ? formatUsdCompact(data.insuranceUsd ?? 0) : "$0")}
        </div>
      </div>
    </section>
  );
}

const ASSETS = ["NEAR", "wNEAR", "LiNEAR", "USDC", "Rhea Lending", "Rhea Exchange", "Hyperliquid", "Aave", "Base", "NEAR Intents", "OutLayer", "NEAR AI Cloud"];
const PRIMITIVES = [
  "Chain Signatures",
  "Universal accounts",
  "Global contracts",
  "Passkeys on chain",
  "Gas keys",
  "ML-DSA-65 keys",
  "Meta transactions",
  "MPC transaction checks",
  "x402 on NEAR",
  "Agent Market",
  "NEP-413 sign-in",
  "Verifiable AI",
];

export function Primitives() {
  const word = (w: string) => <span className="display-sm whitespace-nowrap text-2xl text-fg/70 sm:text-3xl">{w}</span>;
  return (
    <section className="py-16 sm:py-20" aria-label="What Parry runs on">
      <p className="label mb-8 text-center">Built from the assets, venues and primitives it runs on</p>
      <Marquee label="Assets and venues" items={ASSETS.map(word)} seconds={70} />
      <Marquee label="NEAR primitives" items={PRIMITIVES.map(word)} seconds={80} reverse className="mt-5" />
    </section>
  );
}

const STEPS = [
  { key: "watch", title: "Watch", body: "Every protected position is read every few seconds and scored: health, the chance of liquidation within a day, and the hours left at today's pace." },
  { key: "seal", title: "Seal", body: "Your trigger and target are sealed to the guardian's enclave before they leave your browser. Nobody watching the chain learns when you will be defended." },
  { key: "review", title: "Review", body: "At the trigger the guardian plans one step and a verifiable model reviews it inside a TEE. The model's signature covers the exact plan." },
  { key: "act", title: "Act", body: "Your account contract checks the enclave's signature, the mandate's powers and caps, and acts. The review's hash goes on chain with the action." },
] as const;

/**
 * The rescue as a scroll-pinned story: the text steps scroll past while one mockup, built from
 * Parry's own components, changes with each step.
 */
export function ProtectStory() {
  const [step, setStep] = useState(0);
  const refs = useRef<(HTMLDivElement | null)[]>([]);
  useEffect(() => {
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) setStep(Number((e.target as HTMLElement).dataset.step));
      },
      { rootMargin: "-45% 0px -45% 0px" },
    );
    refs.current.forEach((el) => el && io.observe(el));
    return () => io.disconnect();
  }, []);
  return (
    <section id="protect" className="scroll-mt-24 py-24 sm:py-32">
      <div className="mx-auto max-w-[1180px] px-4 sm:px-6">
        <SectionHead title={["Trouble, seen hours", "before it comes."]} lead="Parry watches your leveraged positions, predicts where each is heading, and a guardian that can only protect steps in on its own." />
        <div className="mt-16 grid gap-10 lg:grid-cols-[0.85fr_1.15fr]">
          <div>
            {STEPS.map((s, i) => (
              <div
                key={s.key}
                ref={(el) => {
                  refs.current[i] = el;
                }}
                data-step={i}
                className="flex min-h-[46vh] flex-col justify-center border-l border-line py-10 pl-7 lg:min-h-[62vh]"
              >
                <div className={cn("transition-opacity duration-[var(--dur-2)]", step === i ? "opacity-100" : "opacity-40")}>
                  <h3 className="display-sm text-3xl text-fg">{s.title}</h3>
                  <p className="mt-3 max-w-md text-lg leading-relaxed text-muted">{s.body}</p>
                </div>
                <div className="mt-6 lg:hidden">
                  <StoryMock step={i} />
                </div>
              </div>
            ))}
          </div>
          <div className="relative hidden lg:block">
            <div className="sticky top-28 [perspective:1600px]">
              <div className="[transform:rotateX(6deg)_rotateY(-8deg)] transition-transform duration-700 ease-[var(--ease-out)] hover:[transform:none]">
                <StoryMock step={step} />
              </div>
              <div aria-hidden="true" className="glow-brass absolute -inset-x-10 -bottom-16 -z-10 h-56" />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/** The mockup: a slice of the app as it looks at each step of one rescue. */
function StoryMock({ step }: { step: number }) {
  const health = step === 3 ? 1.46 : step === 0 ? 1.31 : step === 1 ? 1.24 : 1.17;
  return (
    <div className="surface-raised overflow-hidden">
      <div className="flex items-center justify-between border-b border-line px-5 py-3 text-[13px]">
        <span className="text-fg">Rhea wNEAR / USDC</span>
        <span className="text-muted">alice.near</span>
      </div>
      <div className="p-5">
        <RiskInstrument health={health} annualVol={0.85} trigger={1.18} target={1.45} marks={step === 3 ? [{ health: 1.17, label: "Repaid 41.20 USDC" }] : []} />
      </div>
      <div className="grid min-h-[176px] border-t border-line">
        {step === 0 ? (
          <dl className="grid grid-cols-3 divide-x divide-line">
            {[
              ["Time to liquidation", "9 h 40 m"],
              ["Liquidation in 24 h", "18 %"],
              ["Volatility", "stressed"],
            ].map(([k, v]) => (
              <div key={k} className="p-5">
                <dt className="label">{k}</dt>
                <dd className="num mt-2 text-xl text-fg">{v}</dd>
              </div>
            ))}
          </dl>
        ) : step === 1 ? (
          <div className="p-5 text-sm">
            <div className="label">Sealed to the enclave&apos;s X25519 key</div>
            <div className="num mt-3 break-all text-[12.5px] leading-6 text-fg/80">
              5e7b 91c4 0a3d f2e8 6c11 b9a0 77d4 3e05 c8f1 2a6b 90de 4f73 1c5a e8b2 0d96 7f41
            </div>
            <div className="mt-4 flex gap-6 text-muted">
              <span>Trigger: sealed</span>
              <span>Target: sealed</span>
              <span>Strategy: sealed</span>
            </div>
          </div>
        ) : step === 2 ? (
          <div className="p-5 text-sm">
            <div className="flex items-end justify-between">
              <span className="text-fg">Review by z-ai/glm-5.3-flash</span>
              <span className="text-fg">Approved</span>
            </div>
            <p className="mt-2 leading-relaxed text-muted">Health 1.17 is under the owner&apos;s trigger of 1.18. Repaying 41.20 USDC from the reserve lands on the 1.45 target and stays inside the daily cap.</p>
            <div className="num mt-3 text-[12px] text-muted">signed by 0x3b75...fa0c, attested in TEE hardware</div>
          </div>
        ) : (
          <ul className="divide-y divide-line text-sm">
            {[
              ["Envelope signed by the enclave", "verified"],
              ["Repay 41.20 USDC on Rhea", "executed"],
              ["Review hash recorded on chain", "1b8b...0ca3"],
            ].map(([k, v]) => (
              <li key={k} className="flex items-center justify-between px-5 py-3.5">
                <span className="text-fg">{k}</span>
                <span className="num text-muted">{v}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** What the guardian can and cannot do, as a two-column ledger. */
export function Ledger() {
  const can = ["Repay your loan from your reserve", "Add collateral from your reserve", "Deleverage atomically, all or nothing", "Reduce or hedge a Hyperliquid position", "Repay your Aave loan on Base"];
  const cannot = ["Move money out of your account", "Act outside your mandate", "Swap its own signing key", "Stop you from revoking or overriding it", "Act without a reviewed, signed plan"];
  return (
    <section className="py-24 sm:py-32">
      <div className="mx-auto max-w-[1180px] px-4 sm:px-6">
        <SectionHead title={["It can only protect.", "It can never take."]} lead="The guardian's powers are written into your own account contract. It acts under your mandate, and you can revoke or override it at any moment." />
        <div className="mt-14 grid border-t border-line sm:grid-cols-2">
          <Rise className="border-b border-line py-8 sm:border-r sm:pr-10">
            <div className="label">It can</div>
            <ul className="mt-5 space-y-4">
              {can.map((c) => (
                <li key={c} className="text-xl text-fg">
                  {c}
                </li>
              ))}
            </ul>
          </Rise>
          <Rise className="border-b border-line py-8 sm:pl-10" delay={120}>
            <div className="label">It never can</div>
            <ul className="mt-5 space-y-4">
              {cannot.map((c) => (
                <li key={c} className="struck text-xl text-fg/60">
                  {c}
                </li>
              ))}
            </ul>
          </Rise>
        </div>
      </div>
    </section>
  );
}
