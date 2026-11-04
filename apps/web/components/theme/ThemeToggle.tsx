"use client";

import { useTheme } from "@/lib/use-theme";
import type { ThemePreference } from "@/lib/theme";
import { cn } from "@/lib/cn";

function SunIcon() {
  return (
    <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
      <circle cx="10" cy="10" r="3.4" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M10 2.2v1.9M10 15.9v1.9M2.2 10h1.9M15.9 10h1.9M4.5 4.5l1.35 1.35M14.15 14.15l1.35 1.35M4.5 15.5l1.35-1.35M14.15 5.85l1.35-1.35"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
      <path d="M16.4 12.6A6.6 6.6 0 0 1 7.4 3.6a6.6 6.6 0 1 0 9 9Z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

function SystemIcon() {
  return (
    <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
      <rect x="2.75" y="3.75" width="14.5" height="10" rx="1.75" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M7 17h6M10 13.75V17" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/**
 * One button that flips between light and dark and remembers the choice. Before hydration it
 * shows both icons stacked at rest, so the server and client render the same markup.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const { resolved, setPreference } = useTheme();
  const next = resolved === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      onClick={() => setPreference(next)}
      className={cn(
        "relative inline-flex size-9 items-center justify-center rounded-lg text-muted transition-colors hover:bg-hover hover:text-fg",
        className,
      )}
    >
      <span className="sr-only">{resolved ? `Switch to ${next} theme` : "Switch theme"}</span>
      <span className="hidden dark:inline-flex">
        <SunIcon />
      </span>
      <span className="inline-flex dark:hidden">
        <MoonIcon />
      </span>
    </button>
  );
}

const OPTIONS: { value: ThemePreference; label: string; Icon: () => React.JSX.Element }[] = [
  { value: "system", label: "System", Icon: SystemIcon },
  { value: "light", label: "Light", Icon: SunIcon },
  { value: "dark", label: "Dark", Icon: MoonIcon },
];

/** A three way choice (system, light, dark) as a radio group. */
export function ThemeSwitcher({ className, label = "Theme" }: { className?: string; label?: string }) {
  const { preference, resolved, setPreference } = useTheme();
  const hydrated = resolved !== null;
  return (
    <div role="radiogroup" aria-label={label} className={cn("inline-flex rounded-lg border border-line bg-surface p-0.5", className)}>
      {OPTIONS.map(({ value, label: optionLabel, Icon }) => {
        const checked = hydrated && preference === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked || (!hydrated && value === "system") ? 0 : -1}
            onClick={() => setPreference(value)}
            onKeyDown={(e) => {
              const i = OPTIONS.findIndex((o) => o.value === value);
              const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
              if (!step) return;
              e.preventDefault();
              const target = OPTIONS[(i + step + OPTIONS.length) % OPTIONS.length];
              if (!target) return;
              setPreference(target.value);
              const sibling = e.currentTarget.parentElement?.children[OPTIONS.indexOf(target)];
              if (sibling instanceof HTMLElement) sibling.focus();
            }}
            className={cn(
              "inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-semibold transition-colors",
              checked ? "bg-raised text-fg shadow-[0_0_0_1px_var(--parry-line)]" : "text-muted hover:text-fg",
            )}
          >
            <Icon />
            {optionLabel}
          </button>
        );
      })}
    </div>
  );
}
