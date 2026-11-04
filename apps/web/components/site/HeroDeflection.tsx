"use client";

import { useEffect, useRef, useState } from "react";
import { TierBadge } from "@/components/ui/TierBadge";
import {
  APPROACH,
  CANVAS,
  CONTACT,
  GUIDES,
  HERO_VIEW,
  LIQUIDATION_Y,
  PROJECTED,
  PROJECTED_HIT,
  RECOVERY,
  RECOVERY_END,
  SABRE,
  SABRE_PIVOT,
  SABRE_SCALE,
  SABRE_TRANSLATE,
} from "@/lib/deflection";
import type { Tier } from "@/lib/risk";
import { usePrefersReducedMotion } from "@/lib/use-reduced-motion";

/**
 * The hero illustration. Server render and reduced motion show the whole story in one still
 * frame. With motion allowed, GSAP (loaded after hydration) plays it on a loop: health falls,
 * the projection points at liquidation, the sabre swings in and turns the line back up.
 * The loop pauses while the hero is off screen.
 */
export function HeroDeflection() {
  const svg = useRef<SVGSVGElement>(null);
  const [tier, setTier] = useState<Tier>("safe");
  const reduced = usePrefersReducedMotion();

  useEffect(() => {
    const el = svg.current;
    if (!el) return;
    if (reduced) {
      el.dataset.anim = "still";
      return;
    }
    let disposed = false;
    let teardown = () => {};

    void import("gsap").then(({ gsap }) => {
      if (disposed) return;
      const part = <T extends Element>(name: string) => el.querySelector<T>(`[data-part="${name}"]`);
      const approach = part<SVGPathElement>("approach");
      const recovery = part<SVGPathElement>("recovery");
      const projected = part<SVGGElement>("projected");
      const sabre = part<SVGGElement>("sabre");
      const flash = part<SVGCircleElement>("flash");
      const head = part<SVGCircleElement>("head");
      if (!approach || !recovery || !projected || !sabre || !flash || !head) return;

      const lenA = approach.getTotalLength();
      const lenR = recovery.getTotalLength();
      const progress = { a: 0, r: 0 };
      const placeHead = (path: SVGPathElement, at: number) => {
        const p = path.getPointAtLength(at);
        head.setAttribute("cx", p.x.toFixed(2));
        head.setAttribute("cy", p.y.toFixed(2));
      };
      const drawApproach = () => {
        approach.style.strokeDashoffset = String(lenA * (1 - progress.a));
        placeHead(approach, lenA * progress.a);
      };
      const drawRecovery = () => {
        recovery.style.strokeDashoffset = String(lenR * (1 - progress.r));
        placeHead(recovery, lenR * progress.r);
      };

      let loop: ReturnType<typeof gsap.timeline> | undefined;
      const ctx = gsap.context(() => {
        approach.style.strokeDasharray = String(lenA);
        recovery.style.strokeDasharray = String(lenR);
        const tl = gsap.timeline({ repeat: -1, repeatDelay: 0.3, defaults: { ease: "none" } });
        loop = tl;
        tl.call(() => {
          progress.a = 0;
          progress.r = 0;
          recovery.style.strokeDashoffset = String(lenR);
          drawApproach();
          head.dataset.state = "before";
          setTier("safe");
        })
          .set([approach, recovery, head], { opacity: 1 })
          .set(projected, { opacity: 0 })
          .set(sabre, { opacity: 0, rotation: 30, svgOrigin: `${SABRE_PIVOT.x} ${SABRE_PIVOT.y}` })
          .set(flash, { opacity: 0, scale: 0.4, transformOrigin: "50% 50%" })
          .call(() => {
            el.dataset.anim = "running";
          })
          .to(progress, { a: 1, duration: 2.8, ease: "power1.in", onUpdate: drawApproach }, 0.1)
          .call(() => setTier("caution"), [], 1.25)
          .to(projected, { opacity: 1, duration: 0.6, ease: "power2.out" }, 1.4)
          .call(() => setTier("danger"), [], 2.15)
          .to(sabre, { opacity: 1, duration: 0.12 }, 2.42)
          .to(sabre, { rotation: 0, duration: 0.48, ease: "back.out(2.2)" }, 2.42)
          .call(() => {
            head.dataset.state = "after";
          }, [], 2.9)
          .to(flash, { opacity: 0.9, scale: 0.6, duration: 0.06 }, 2.9)
          .to(flash, { opacity: 0, scale: 1.9, duration: 0.7, ease: "power2.out" }, 2.96)
          .to(projected, { opacity: 0.45, duration: 0.8 }, 3.1)
          .to(progress, { r: 1, duration: 1.7, ease: "power2.out", onUpdate: drawRecovery }, 2.9)
          .call(() => setTier("caution"), [], 3.25)
          .call(() => setTier("safe"), [], 3.85)
          .to([approach, recovery, projected, sabre, head], { opacity: 0, duration: 0.6, ease: "power1.inOut" }, 7.2);
      }, el);

      const io = new IntersectionObserver(([entry]) => {
        if (!loop) return;
        if (entry?.isIntersecting) loop.play();
        else loop.pause();
      });
      io.observe(el);

      teardown = () => {
        io.disconnect();
        ctx.revert();
        approach.style.strokeDasharray = "";
        approach.style.strokeDashoffset = "";
        recovery.style.strokeDasharray = "";
        recovery.style.strokeDashoffset = "";
        head.setAttribute("cx", String(RECOVERY_END.x));
        head.setAttribute("cy", String(RECOVERY_END.y));
        head.dataset.state = "after";
        el.dataset.anim = "pending";
      };
    });

    return () => {
      disposed = true;
      teardown();
      setTier("safe");
    };
  }, [reduced]);

  const guideYs = GUIDES.map((f) => f * CANVAS.height);
  const hit = PROJECTED_HIT;

  return (
    <div className="relative">
      <div className="flex items-center justify-between gap-3 px-5 pt-4 sm:px-6 sm:pt-5" aria-hidden="true">
        <span className="text-[13px] font-semibold text-muted">Position health</span>
        <span className="flex w-[7.5rem] justify-end">
          <TierBadge tier={tier} />
        </span>
      </div>
      <p className="sr-only">
        Illustration: a position&apos;s health falls toward the liquidation line. Parry sees where it is heading, steps in, and
        turns it back up to safety.
      </p>
      <div className="relative mt-2">
        <svg
          ref={svg}
          data-anim="pending"
          viewBox={`0 ${HERO_VIEW.y} ${CANVAS.width} ${HERO_VIEW.height}`}
          className="hero-deflection block h-auto w-full overflow-visible"
          aria-hidden="true"
          focusable="false"
        >
          {guideYs.map((y) => (
            <path key={y} d={`M0 ${y} H${CANVAS.width}`} className="stroke-line" strokeWidth="1" vectorEffect="non-scaling-stroke" />
          ))}
          <path
            d={`M0 ${LIQUIDATION_Y} H${CANVAS.width}`}
            className="stroke-critical"
            strokeWidth="1.25"
            strokeDasharray="5 5"
            vectorEffect="non-scaling-stroke"
          />
          <g data-part="projected" className="hero-part text-muted">
            <path d={PROJECTED} fill="none" stroke="currentColor" strokeWidth="1.75" strokeDasharray="4 5" strokeLinecap="round" />
            <path
              d={`M${hit.x - 6} ${hit.y - 6} L${hit.x + 6} ${hit.y + 6} M${hit.x + 6} ${hit.y - 6} L${hit.x - 6} ${hit.y + 6}`}
              className="stroke-critical"
              strokeWidth="1.75"
              strokeLinecap="round"
            />
          </g>
          <path data-part="approach" d={APPROACH} fill="none" className="hero-part stroke-fg" strokeWidth="3" strokeLinecap="round" />
          <path data-part="recovery" d={RECOVERY} fill="none" className="hero-part stroke-safe" strokeWidth="3" strokeLinecap="round" />
          <circle data-part="flash" cx={CONTACT.x} cy={CONTACT.y + 2} r="16" fill="none" className="stroke-brass-fill" strokeWidth="1.5" opacity="0" />
          <g data-part="sabre" className="hero-part text-brass-fill">
            <g transform={`translate(${SABRE_TRANSLATE.x.toFixed(2)} ${SABRE_TRANSLATE.y.toFixed(2)}) scale(${SABRE_SCALE})`}>
              <path d={SABRE.blade} fill="currentColor" />
              <path d={SABRE.grip} fill="none" stroke="currentColor" strokeWidth={SABRE.gripWidth} strokeLinecap="round" />
              <path d={SABRE.guard} fill="none" stroke="currentColor" strokeWidth={SABRE.guardWidth} strokeLinecap="round" />
              <circle cx={SABRE.pommel.cx} cy={SABRE.pommel.cy} r={SABRE.pommel.r} fill="currentColor" />
            </g>
          </g>
          <circle data-part="head" data-state="after" cx={RECOVERY_END.x} cy={RECOVERY_END.y} r="4.5" className="hero-part hero-head" />
        </svg>
        <span
          aria-hidden="true"
          className="num pointer-events-none absolute left-0 text-[11px] font-medium uppercase tracking-[0.08em] text-critical"
          style={{ top: `calc(${((LIQUIDATION_Y - HERO_VIEW.y) / HERO_VIEW.height) * 100}% - 1.35rem)` }}
        >
          Liquidation
        </span>
      </div>
    </div>
  );
}
