"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/lib/cn";

// 4×4 Bayer matrix, the classic ordered-dither threshold map.
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);

/**
 * A slow, animated ordered-dither field: a soft brass light drifting under a 4×4 Bayer screen,
 * drawn on a low-resolution canvas (one dot per 6 px) at 24 fps, paused off screen and in hidden
 * tabs. Reduced motion draws one still frame.
 */
export function DitherField({ className, cell = 6 }: { className?: string; cell?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0;
    let visible = true;
    let last = 0;
    let w = 0;
    let h = 0;
    const color = () => getComputedStyle(document.documentElement).getPropertyValue("--parry-brass-fill").trim() || "#c99a45";
    let fill = color();
    const resize = () => {
      const r = canvas.getBoundingClientRect();
      w = Math.max(1, Math.ceil(r.width / cell));
      h = Math.max(1, Math.ceil(r.height / cell));
      canvas.width = w;
      canvas.height = h;
      fill = color();
    };
    const draw = (t: number) => {
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = fill;
      const cx = w * (0.5 + 0.18 * Math.sin(t / 7000));
      const cy = h * (0.92 + 0.05 * Math.cos(t / 9000));
      const rx = w * 0.62;
      const ry = h * 0.75;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const dx = (x - cx) / rx;
          const dy = (y - cy) / ry;
          const v = Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy)) ** 1.6;
          if (v > BAYER[(y & 3) * 4 + (x & 3)]!) ctx.fillRect(x, y, 1, 1);
        }
      }
    };
    const loop = (t: number) => {
      raf = requestAnimationFrame(loop);
      if (!visible || t - last < 42) return;
      last = t;
      draw(t);
    };
    resize();
    const ro = new ResizeObserver(() => {
      resize();
      draw(performance.now());
    });
    ro.observe(canvas);
    const io = new IntersectionObserver(([e]) => (visible = !!e?.isIntersecting));
    io.observe(canvas);
    const theme = new MutationObserver(() => (fill = color()));
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    if (reduced) draw(0);
    else raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      theme.disconnect();
    };
  }, [cell]);
  return <canvas ref={ref} aria-hidden="true" className={cn("pointer-events-none [image-rendering:pixelated]", className)} />;
}
