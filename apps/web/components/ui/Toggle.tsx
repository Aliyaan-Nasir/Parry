"use client";

import { useId, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";

export type ToggleProps = {
  label: ReactNode;
  description?: ReactNode;
  /** Controlled state. */
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
  /** Keep the label for screen readers only. */
  hideLabel?: boolean;
  id?: string;
  className?: string;
};

/** A switch (role="switch"): Space or Enter flips it; the state is announced as on or off. */
export function Toggle({ label, description, checked, defaultChecked = false, onCheckedChange, disabled = false, hideLabel = false, id, className }: ToggleProps) {
  const autoId = useId();
  const switchId = id ?? autoId;
  const labelId = `${switchId}-label`;
  const descId = `${switchId}-desc`;
  const [inner, setInner] = useState(defaultChecked);
  const on = checked ?? inner;

  return (
    <div className={cn("flex items-start justify-between gap-4", className)}>
      <div className={cn("min-w-0", hideLabel && "sr-only")}>
        <span id={labelId} className="text-sm font-semibold text-fg">
          {label}
        </span>
        {description ? (
          <p id={descId} className="mt-0.5 text-[13px] text-muted">
            {description}
          </p>
        ) : null}
      </div>
      <button
        id={switchId}
        type="button"
        role="switch"
        aria-checked={on}
        aria-labelledby={labelId}
        aria-describedby={description ? descId : undefined}
        disabled={disabled}
        onClick={() => {
          const next = !on;
          if (checked === undefined) setInner(next);
          onCheckedChange?.(next);
        }}
        className={cn(
          "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors duration-150",
          "focus-visible:rounded-full disabled:cursor-not-allowed disabled:opacity-55",
          on ? "border-brass-fill bg-brass-fill" : "border-line-strong bg-hover",
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            "inline-block size-[18px] rounded-full bg-raised shadow-[0_1px_2px_rgb(14_16_14/0.25)] transition-transform duration-200 ease-out",
            on ? "translate-x-[21px]" : "translate-x-[2px]",
          )}
        />
      </button>
    </div>
  );
}
