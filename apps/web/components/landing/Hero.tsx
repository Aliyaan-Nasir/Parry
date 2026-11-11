"use client";

import { useEffect, useRef, useState } from "react";
import { Mark } from "@/components/brand/Logo";
import { DitherField } from "@/components/fx/Dither";
import { Magnetic } from "@/components/fx/Magnetic";
import { RiskInstrument } from "@/components/instrument/RiskInstrument";
import { ButtonLink } from "@/components/ui/Button";
import { cn } from "@/lib/cn";

/**
 * The hero: the headline, the two ways in, and under them a still view of the app itself: a
 * protected position on its risk instrument, the sealed mandate, and the guardian's log. One quiet
 * beat plays once: a rescue lands in the log and the needle settles from 1.18 up to the 1.45
 * target. Reduced motion shows the settled frame at once.
 */

export function Hero() {
  return (
    <section className="grain relative isolate overflow-hidden pb-20 pt-32 sm:pt-40">
      {/* Atmosphere: the dither field, the brass horizon arc, and a soft top light. */}
      <DitherField className="absolute inset-x-0 top-[22%] -z-10 h-[60%] w-full opacity-[0.16] [mask-image:radial-gradient(60%_55%_at_50%_75%,#000,transparent)]" />
      <div aria-hidden="true" className="absolute left-1/2 top-[52%] -z-10 h-[900px] w-[1600px] -translate-x-1/2 rounded-[50%] border-t border-brass-fill/50 shadow-[0_-40px_120px_-40px_color-mix(in_oklab,var(--parry-brass-fill)_70%,transparent)] [background:radial-gradient(60%_30%_at_50%_0%,color-mix(in_oklab,var(--parry-brass-fill)_22%,transparent),transparent)]" />
      <div className="mx-auto max-w-[1180px] px-4 sm:px-6">
        <h1 className="display text-gradient mx-auto max-w-[14ch] text-center text-[3.4rem] sm:text-[5.5rem] lg:text-[7rem]">Liquidation, turned aside.</h1>
        <p className="mx-auto mt-6 max-w-[38rem] text-center text-lg leading-relaxed text-muted sm:text-xl">
          A guardian that sees trouble hours ahead and steps in on its own, inside limits only you set, with every move reviewed by a verifiable AI. Or earn without liquidation risk at all.
        </p>
        <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
          <Magnetic>
            <ButtonLink prefetch={false} href="/app" size="lg" className="!rounded-full px-7">
              Open the app
            </ButtonLink>
          </Magnetic>
          <ButtonLink prefetch={false} href="/check" size="lg" variant="secondary" className="!rounded-full px-7">
            Check any account
          </ButtonLink>
        </div>
        <HeroProduct />
      </div>
    </section>
  );
}

const BEFORE = 1.18;
const AFTER = 1.45;

const LOG = [
  { when: "now", what: "Repaid 54.40 USDC from the reserve", detail: "health 1.18 to 1.45, reviewed by a verifiable model, signed in the enclave" },
  { when: "2 d ago", what: "Mandate sealed to the enclave", detail: "trigger and target private; reserve 100 USDC, 60 a day" },
  { when: "3 d ago", what: "Position opened on Rhea", detail: "40 wNEAR supplied, 61 USDC borrowed" },
];

function Glyph({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

/** A still view of the app, drawn with its own components; decorative, so it is hidden from assistive tech. */
function HeroProduct() {
  const ref = useRef<HTMLDivElement>(null);
  const [rescued, setRescued] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Under reduced motion the settled frame shows at once; otherwise the rescue lands once,
    // shortly after the view is first on screen. Nothing ever falls: health only settles upward.
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const raf = requestAnimationFrame(() => setRescued(true));
      return () => cancelAnimationFrame(raf);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const io = new IntersectionObserver(
      ([e]) => {
        if (!e?.isIntersecting) return;
        io.disconnect();
        el.dataset.anim = "play";
        timer = setTimeout(() => setRescued(true), 900);
      },
      { threshold: 0.4 },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      if (timer) clearTimeout(timer);
    };
  }, []);
  const health = rescued ? AFTER : BEFORE;

  return (
    <div ref={ref} data-anim="still" aria-hidden="true" className="hero-product relative mx-auto mt-16 max-w-[1100px] [mask-image:linear-gradient(#000_72%,transparent)]">
      <div className="surface-glass overflow-hidden p-0 text-left [--edge-angle:180deg]">
        <div className="grid min-h-[380px] md:grid-cols-[3.25rem_minmax(0,1fr)_minmax(0,19rem)]">
          {/* The rail. */}
          <div className="hidden flex-col items-center gap-5 border-r border-line py-5 text-muted md:flex">
            <Mark size={20} />
            {["M3 10.5 10 4l7 6.5M5 9v7h10V9", "M10 2.5 16.5 5v4.5c0 4-2.7 6.8-6.5 8-3.8-1.2-6.5-4-6.5-8V5Z", "M5 3.5h10v13H5zM7.5 7h5M7.5 10h5M7.5 13h3", "M3 16h14M5 16v-3M8 16V8M11 16v-6M14 16V5"].map((d, i) => (
              <span key={d} className={cn("grid size-8 place-items-center rounded-lg", i === 1 && "bg-fg/[0.06] text-fg")}>
                <Glyph d={d} />
              </span>
            ))}
          </div>
          {/* The position. */}
          <div className="p-5 sm:p-7">
            <div className="flex items-end justify-between gap-4">
              <div>
                <div className="text-[15px] text-fg">Rhea wNEAR / USDC</div>
                <div className="text-[12.5px] text-muted">alice.near, guarding, trigger sealed</div>
              </div>
              <span className="num text-[12.5px] text-muted">NEAR $3.62</span>
            </div>
            <RiskInstrument className="mt-6" health={health} annualVol={0.85} trigger={1.2} target={AFTER} marks={rescued ? [{ health: BEFORE, label: "Repaid 54.40 USDC" }] : []} />
            <dl className="mt-6 grid grid-cols-3 gap-4 border-t border-line pt-4 text-[12.5px]">
              {[
                ["Liquidation price", rescued ? "$2.49" : "$3.07"],
                ["Liquidation in 24 h", rescued ? "under 1%" : "18%"],
                ["Reserve left today", rescued ? "5.60 USDC" : "60.00 USDC"],
              ].map(([k, v]) => (
                <div key={k}>
                  <dt className="text-muted">{k}</dt>
                  <dd className="num mt-1 text-[15px] text-fg transition-colors duration-[var(--dur-2)]">{v}</dd>
                </div>
              ))}
            </dl>
          </div>
          {/* The guardian's log. */}
          <div className="hidden border-l border-line p-5 lg:block">
            <div className="label">Guardian log</div>
            <ol className="mt-4 grid gap-4">
              {LOG.map((e, i) => (
                <li key={e.what} className={cn("grid gap-0.5 transition-[opacity,translate] duration-[var(--dur-2)] ease-[var(--ease-out)]", i === 0 && !rescued && "-translate-y-2 opacity-0")}>
                  <span className="flex items-end justify-between gap-3 text-[13px]">
                    <span className={cn(i === 0 ? "text-fg" : "text-fg/80")}>{e.what}</span>
                    <span className="shrink-0 text-[11.5px] text-muted">{e.when}</span>
                  </span>
                  <span className="text-[12px] leading-5 text-muted">{e.detail}</span>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </div>
    </div>
  );
}
