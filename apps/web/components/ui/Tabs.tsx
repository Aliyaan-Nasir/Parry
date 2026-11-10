"use client";

import { m } from "framer-motion";
import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@/lib/cn";

export type TabItem = {
  id: string;
  label: ReactNode;
  content: ReactNode;
  disabled?: boolean;
};

export type TabsProps = {
  items: readonly TabItem[];
  /** Accessible name of the tab list. */
  label: string;
  /** Controlled selection. */
  value?: string;
  /** Initial selection when uncontrolled; defaults to the first enabled tab. */
  defaultValue?: string;
  onValueChange?: (id: string) => void;
  className?: string;
};

/**
 * WAI-ARIA tabs: arrow keys move between tabs (and select them), Home and End jump to the ends,
 * Tab moves into the panel.
 */
export function Tabs({ items, label, value, defaultValue, onValueChange, className }: TabsProps) {
  const baseId = useId();
  const firstEnabled = items.find((t) => !t.disabled)?.id ?? "";
  const [inner, setInner] = useState(defaultValue ?? firstEnabled);
  const selected = value ?? inner;
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());

  const select = (id: string) => {
    if (value === undefined) setInner(id);
    onValueChange?.(id);
  };

  const enabled = items.filter((t) => !t.disabled);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = enabled.findIndex((t) => t.id === selected);
    let next: TabItem | undefined;
    if (e.key === "ArrowRight") next = enabled[(i + 1) % enabled.length];
    else if (e.key === "ArrowLeft") next = enabled[(i - 1 + enabled.length) % enabled.length];
    else if (e.key === "Home") next = enabled[0];
    else if (e.key === "End") next = enabled[enabled.length - 1];
    if (!next) return;
    e.preventDefault();
    select(next.id);
    tabRefs.current.get(next.id)?.focus();
  };

  return (
    <div className={className}>
      <div role="tablist" aria-label={label} onKeyDown={onKeyDown} className="flex gap-1 overflow-x-auto border-b border-line">
        {items.map((t) => {
          const active = t.id === selected;
          return (
            <button
              key={t.id}
              ref={(el) => {
                if (el) tabRefs.current.set(t.id, el);
                else tabRefs.current.delete(t.id);
              }}
              type="button"
              role="tab"
              id={`${baseId}-tab-${t.id}`}
              aria-selected={active}
              aria-controls={`${baseId}-panel-${t.id}`}
              tabIndex={active ? 0 : -1}
              disabled={t.disabled}
              onClick={() => select(t.id)}
              className={cn(
                "relative -mb-px h-10 shrink-0 whitespace-nowrap rounded-t-md px-3 text-sm font-semibold transition-colors",
                active ? "text-fg" : "text-muted hover:text-fg",
                "disabled:cursor-not-allowed disabled:opacity-50",
              )}
            >
              {t.label}
              {active ? (
                // One underline that slides between tabs (instantly under reduced motion).
                <m.span
                  layoutId={`${baseId}-underline`}
                  aria-hidden="true"
                  className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-brass-fill"
                  transition={{ type: "spring", stiffness: 460, damping: 36, mass: 0.6 }}
                />
              ) : null}
            </button>
          );
        })}
      </div>
      {items.map((t) => (
        <div
          key={t.id}
          role="tabpanel"
          id={`${baseId}-panel-${t.id}`}
          aria-labelledby={`${baseId}-tab-${t.id}`}
          hidden={t.id !== selected}
          tabIndex={0}
          className="pt-5"
        >
          {t.id === selected ? t.content : null}
        </div>
      ))}
    </div>
  );
}
