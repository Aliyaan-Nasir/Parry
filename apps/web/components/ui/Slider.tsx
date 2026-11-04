"use client";

import { useId, useState, type CSSProperties, type ReactNode } from "react";
import { cn } from "@/lib/cn";

export type SliderProps = {
  label: ReactNode;
  /** Extra guidance read with the control. */
  description?: ReactNode;
  min: number;
  max: number;
  step?: number;
  /** Controlled value. */
  value?: number;
  /** Initial value when uncontrolled; defaults to min. */
  defaultValue?: number;
  onValueChange?: (value: number) => void;
  /** Formats the value for display and for screen readers (aria-valuetext). */
  formatValue?: (value: number) => string;
  disabled?: boolean;
  name?: string;
  id?: string;
  className?: string;
};

/**
 * Built on the native range input, so arrows, Page Up and Down, Home and End, touch and
 * screen readers all work as the platform intends.
 */
export function Slider({
  label,
  description,
  min,
  max,
  step = 1,
  value,
  defaultValue,
  onValueChange,
  formatValue = (v) => String(v),
  disabled = false,
  name,
  id,
  className,
}: SliderProps) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const descId = `${inputId}-desc`;
  const [inner, setInner] = useState(defaultValue ?? min);
  const current = value ?? inner;
  const fill = max > min ? ((current - min) / (max - min)) * 100 : 0;
  const text = formatValue(current);

  return (
    <div className={cn("w-full", className)}>
      <div className="flex items-end justify-between gap-4">
        <label htmlFor={inputId} className="text-sm font-semibold text-fg">
          {label}
        </label>
        <output htmlFor={inputId} className="num text-sm font-medium text-fg" aria-hidden="true">
          {text}
        </output>
      </div>
      {description ? (
        <p id={descId} className="mt-1 text-[13px] text-muted">
          {description}
        </p>
      ) : null}
      <input
        id={inputId}
        name={name}
        type="range"
        min={min}
        max={max}
        step={step}
        value={current}
        disabled={disabled}
        aria-valuetext={text}
        aria-describedby={description ? descId : undefined}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (value === undefined) setInner(v);
          onValueChange?.(v);
        }}
        className="parry-range mt-2"
        style={{ "--fill": `${fill}%` } as CSSProperties}
      />
    </div>
  );
}
