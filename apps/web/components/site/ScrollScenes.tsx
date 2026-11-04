"use client";

import { useEffect, useRef } from "react";
import { usePrefersReducedMotion } from "@/lib/use-reduced-motion";

/**
 * Landing page motion: Lenis smooth scrolling driven by GSAP's ticker, ScrollTrigger reveals for
 * [data-reveal] blocks and [data-reveal-stagger] lists, and a brass reading-progress hairline.
 * Loaded after hydration, torn down on unmount (or when the route is hidden), and skipped
 * entirely under reduced motion, where everything is simply visible.
 */
export function ScrollScenes() {
  const reduced = usePrefersReducedMotion();
  const bar = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (reduced) return;
    let disposed = false;
    let teardown = () => {};

    void Promise.all([import("gsap"), import("gsap/ScrollTrigger"), import("lenis")]).then(
      ([{ gsap }, { ScrollTrigger }, { default: Lenis }]) => {
        if (disposed) return;
        gsap.registerPlugin(ScrollTrigger);

        const lenis = new Lenis({
          autoRaf: false,
          anchors: { offset: -72 },
          lerp: 0.11,
          prevent: (node: HTMLElement) => node.closest("dialog") !== null,
        });
        const onScroll = () => ScrollTrigger.update();
        lenis.on("scroll", onScroll);
        const raf = (time: number) => lenis.raf(time * 1000);
        gsap.ticker.add(raf);
        gsap.ticker.lagSmoothing(0);

        const ctx = gsap.context(() => {
          const inView = (el: Element) => {
            const r = el.getBoundingClientRect();
            return r.top < window.innerHeight && r.bottom > 0;
          };

          gsap.utils.toArray<HTMLElement>("[data-reveal]").forEach((el) => {
            if (inView(el)) return;
            gsap.from(el, {
              opacity: 0,
              y: 24,
              duration: 0.9,
              ease: "power3.out",
              scrollTrigger: { trigger: el, start: "top 86%", once: true },
            });
          });

          gsap.utils.toArray<HTMLElement>("[data-reveal-stagger]").forEach((list) => {
            if (inView(list)) return;
            gsap.from(Array.from(list.children), {
              opacity: 0,
              y: 18,
              duration: 0.8,
              ease: "power3.out",
              stagger: 0.07,
              scrollTrigger: { trigger: list, start: "top 88%", once: true },
            });
          });

          if (bar.current) {
            gsap.fromTo(
              bar.current,
              { scaleX: 0 },
              {
                scaleX: 1,
                ease: "none",
                scrollTrigger: { trigger: document.documentElement, start: "top top", end: "bottom bottom", scrub: 0.3 },
              },
            );
          }
        });

        teardown = () => {
          ctx.revert();
          gsap.ticker.remove(raf);
          lenis.off("scroll", onScroll);
          lenis.destroy();
        };
      },
    );

    return () => {
      disposed = true;
      teardown();
    };
  }, [reduced]);

  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-x-0 top-0 z-50 h-0.5">
      <div ref={bar} className="h-full origin-left scale-x-0 bg-brass-fill motion-reduce:hidden" />
    </div>
  );
}
