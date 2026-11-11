"use client";

import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { cn } from "@/lib/cn";

export type OrderItem = { id: string; label: string; detail: string; on: boolean; blocked?: string | null };

/**
 * An ordered list the owner rearranges by dragging a row's grip, or with the arrow keys on the
 * grip, and switches rows on or off. The order is the order the guardian tries the steps in.
 */
export function StepOrder({ items, onChange, disabled }: { items: OrderItem[]; onChange: (next: OrderItem[]) => void; disabled?: boolean }) {
  const list = useRef<HTMLOListElement>(null);
  const [drag, setDrag] = useState<{ id: string; dy: number } | null>(null);
  const start = useRef<{ y: number; index: number; heights: number[] } | null>(null);

  const move = (from: number, to: number) => {
    if (to < 0 || to >= items.length || from === to) return;
    const next = [...items];
    const [it] = next.splice(from, 1);
    next.splice(to, 0, it!);
    onChange(next);
  };

  const onDown = (e: PointerEvent<HTMLButtonElement>, index: number) => {
    if (disabled || !list.current) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const heights = [...list.current.children].map((c) => (c as HTMLElement).getBoundingClientRect().height + 8);
    start.current = { y: e.clientY, index, heights };
    setDrag({ id: items[index]!.id, dy: 0 });
  };

  const onMove = (e: PointerEvent<HTMLButtonElement>) => {
    const s = start.current;
    if (!s || !drag) return;
    let dy = e.clientY - s.y;
    // Swap with a neighbour once the row passes half of it, and carry on from there.
    const down = s.heights[s.index + 1];
    const up = s.heights[s.index - 1];
    if (down !== undefined && dy > down / 2) {
      move(s.index, s.index + 1);
      s.y += down;
      s.index += 1;
      dy -= down;
    } else if (up !== undefined && dy < -up / 2) {
      move(s.index, s.index - 1);
      s.y -= up;
      s.index -= 1;
      dy += up;
    }
    setDrag({ id: drag.id, dy });
  };

  const onUp = () => {
    start.current = null;
    setDrag(null);
  };

  const onKey = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      const to = index + (e.key === "ArrowUp" ? -1 : 1);
      move(index, to);
      // Keep focus on the grip of the row that moved.
      requestAnimationFrame(() => (list.current?.children[Math.max(0, Math.min(items.length - 1, to))]?.querySelector("button[data-grip]") as HTMLButtonElement | null)?.focus());
    }
  };

  // Each switched-on row's place among the steps the guardian will try.
  const ranks = items.reduce<number[]>((acc, it) => [...acc, (acc[acc.length - 1] ?? 0) + (it.on && !it.blocked ? 1 : 0)], []);
  return (
    <ol ref={list} className="grid gap-2" aria-label="Order of steps">
      {items.map((it, i) => {
        const active = it.on && !it.blocked;
        const dragging = drag?.id === it.id;
        return (
          <li
            key={it.id}
            className={cn(
              "surface-raised relative flex items-start gap-3 py-3 pl-2 pr-4 transition-[box-shadow,opacity]",
              dragging ? "z-10 shadow-[0_18px_40px_-18px_rgb(0_0_0/0.45)]" : "duration-[var(--dur-1)]",
              !active && "opacity-60",
            )}
            style={dragging ? { transform: `translateY(${drag.dy}px)` } : undefined}
          >
            <button
              type="button"
              data-grip
              disabled={disabled}
              aria-label={`Move ${it.label}, position ${i + 1} of ${items.length}. Use the up and down arrows.`}
              onPointerDown={(e) => onDown(e, i)}
              onPointerMove={onMove}
              onPointerUp={onUp}
              onPointerCancel={onUp}
              onKeyDown={(e) => onKey(e, i)}
              className={cn("mt-0.5 grid h-8 w-6 shrink-0 touch-none place-items-center rounded-md text-muted hover:bg-hover hover:text-fg", dragging ? "cursor-grabbing" : "cursor-grab")}
            >
              <svg viewBox="0 0 10 16" width="10" height="16" aria-hidden="true" fill="currentColor">
                {[3, 8, 13].flatMap((y) => [<circle key={`a${y}`} cx="3" cy={y} r="1.2" />, <circle key={`b${y}`} cx="7" cy={y} r="1.2" />])}
              </svg>
            </button>
            <span className="num mt-1.5 w-4 shrink-0 text-[12px] text-muted">{active ? ranks[i] : ""}</span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm text-fg">{it.label}</span>
              <span className="mt-0.5 block text-[12.5px] leading-5 text-muted">{it.blocked ?? it.detail}</span>
            </span>
            <label className="mt-1 flex shrink-0 cursor-pointer items-center gap-2 text-[12.5px] text-muted">
              <input
                type="checkbox"
                checked={it.on}
                disabled={disabled || !!it.blocked}
                onChange={(e) => onChange(items.map((x) => (x.id === it.id ? { ...x, on: e.target.checked } : x)))}
                className="size-4"
                aria-label={`Use ${it.label}`}
              />
              Use
            </label>
          </li>
        );
      })}
    </ol>
  );
}
