"use client";

import { useId, type ReactNode } from "react";
import { cn } from "@/lib/cn";

export type AmountFieldProps = {
  label: ReactNode;
  value: string;
  onChange: (value: string) => void;
  /** The unit shown inside the field, for example "NEAR". */
  unit: string;
  hint?: ReactNode;
  error?: string | null;
  /** Fills the field with the most that can be used. */
  onMax?: (() => void) | undefined;
  disabled?: boolean;
  className?: string;
};

/** A decimal amount: numeric keyboard, unit inside the field, error and hint read with it. */
export function AmountField({ label, value, onChange, unit, hint, error, onMax, disabled = false, className }: AmountFieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className={cn("grid gap-1.5", className)}>
      <label htmlFor={id} className="text-sm font-semibold text-fg">
        {label}
      </label>
      <div
        className={cn(
          "flex h-11 items-center rounded-lg border bg-raised pl-3 pr-1.5 focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-brass",
          error ? "border-critical" : "border-line-strong",
          disabled && "opacity-55",
        )}
      >
        <input
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value.replace(",", "."))}
          inputMode="decimal"
          autoComplete="off"
          placeholder="0"
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className="num h-full min-w-0 flex-1 bg-transparent text-[15px] text-fg outline-none placeholder:text-muted focus-visible:outline-none"
        />
        <span className="num px-2 text-[13px] text-muted">{unit}</span>
        {onMax ? (
          <button
            type="button"
            onClick={onMax}
            disabled={disabled}
            className="h-8 rounded-md px-2 text-[12px] font-semibold uppercase tracking-[0.06em] text-brass transition-colors hover:bg-hover disabled:cursor-not-allowed"
          >
            Max
          </button>
        ) : null}
      </div>
      {hint ? (
        <p id={hintId} className="text-[13px] text-muted">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} role="alert" className="text-[13px] font-medium text-critical">
          {error}
        </p>
      ) : null}
    </div>
  );
}
