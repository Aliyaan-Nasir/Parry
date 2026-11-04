"use client";

import { useId, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";

export type AccordionItem = {
  id: string;
  title: ReactNode;
  content: ReactNode;
};

export type AccordionProps = {
  items: readonly AccordionItem[];
  /** Ids open at first. */
  defaultOpen?: readonly string[];
  /** Allow several open at once (the default), or one at a time. */
  multiple?: boolean;
  /** Heading level wrapping each trigger. */
  headingAs?: "h3" | "h4";
  className?: string;
};

/**
 * Disclosure buttons with aria-expanded and aria-controls, each inside a heading. Panels open
 * with a height transition (none under reduced motion) and are inert while closed.
 */
export function Accordion({ items, defaultOpen = [], multiple = true, headingAs: Heading = "h3", className }: AccordionProps) {
  const baseId = useId();
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set(defaultOpen));

  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(multiple ? prev : []);
      if (prev.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className={cn("divide-y divide-line border-y border-line", className)}>
      {items.map((item) => {
        const isOpen = open.has(item.id);
        const buttonId = `${baseId}-${item.id}-button`;
        const panelId = `${baseId}-${item.id}-panel`;
        return (
          <div key={item.id}>
            <Heading className="m-0">
              <button
                id={buttonId}
                type="button"
                aria-expanded={isOpen}
                aria-controls={panelId}
                onClick={() => toggle(item.id)}
                className="group flex w-full items-center justify-between gap-6 py-5 text-left text-base font-semibold text-fg transition-colors hover:text-brass sm:text-[17px]"
              >
                <span>{item.title}</span>
                <span
                  aria-hidden="true"
                  className="relative inline-flex size-7 shrink-0 items-center justify-center rounded-full border border-line text-muted transition-colors group-hover:border-brass group-hover:text-brass"
                >
                  <svg viewBox="0 0 12 12" width="12" height="12">
                    <path d="M2 6 H10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                    <path
                      d="M6 2 V10"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      className={cn("origin-center transition-transform duration-200", isOpen && "scale-y-0")}
                    />
                  </svg>
                </span>
              </button>
            </Heading>
            <div
              id={panelId}
              role="region"
              aria-labelledby={buttonId}
              inert={!isOpen}
              className={cn(
                "grid transition-[grid-template-rows,opacity] duration-300 ease-out",
                isOpen ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
              )}
            >
              <div className="min-h-0 overflow-hidden">
                <div className="max-w-2xl pb-6 pr-10 text-[15px] leading-7 text-muted">{item.content}</div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
