import Link from "next/link";
import type { Route } from "next";
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/cn";

export type ButtonVariant = "primary" | "secondary" | "ghost";
export type ButtonSize = "sm" | "md" | "lg";

const base =
  "relative inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-[10px] font-medium tracking-[-0.005em] " +
  "transition-[background-color,border-color,color,box-shadow,scale,translate] duration-200 ease-[var(--ease-std)] enabled:active:scale-[0.985] " +
  "disabled:cursor-not-allowed aria-disabled:cursor-not-allowed";

const variants: Record<ButtonVariant, string> = {
  // Brass with an inner highlight and a soft lift; the gradient gives it a cast-metal sheen.
  primary:
    "bg-brass-fill bg-[linear-gradient(180deg,rgb(255_255_255/0.18),rgb(255_255_255/0)_55%)] text-on-brass " +
    "shadow-[inset_0_1px_0_rgb(255_255_255/0.35),0_1px_2px_rgb(0_0_0/0.18),0_8px_24px_-8px_color-mix(in_oklab,var(--parry-brass-fill)_60%,transparent)] " +
    "hover:bg-brass-fill-hover disabled:opacity-55 aria-disabled:opacity-55 disabled:hover:bg-brass-fill",
  secondary:
    "border border-line-strong bg-raised/70 text-fg shadow-[inset_0_1px_0_rgb(255_255_255/0.06)] backdrop-blur hover:bg-hover active:bg-press " +
    "disabled:opacity-55 aria-disabled:opacity-55 disabled:hover:bg-raised",
  ghost: "text-fg hover:bg-hover active:bg-press disabled:opacity-55 aria-disabled:opacity-55 disabled:hover:bg-transparent",
};

const sizes: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-[13px]",
  md: "h-10 px-4 text-sm",
  lg: "h-12 px-6 text-[15px]",
};

export function buttonClasses({
  variant = "primary",
  size = "md",
  className,
}: { variant?: ButtonVariant; size?: ButtonSize; className?: string } = {}): string {
  return cn(base, variants[variant], sizes[size], className);
}

function Spinner() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" className="motion-safe:animate-spin">
      <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="1.75" />
      <path d="M14.25 8A6.25 6.25 0 0 0 8 1.75" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
    </svg>
  );
}

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner, keeps the width, and blocks clicks while true. */
  loading?: boolean;
  /** Announced to screen readers while loading. */
  loadingLabel?: string;
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode;
};

export function Button({
  variant = "primary",
  size = "md",
  loading = false,
  loadingLabel = "Working",
  leadingIcon,
  trailingIcon,
  className,
  children,
  disabled,
  type = "button",
  onClick,
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={buttonClasses({ variant, size, className: cn(loading && "cursor-progress", className) })}
      // A loading button keeps its color and focus; it only ignores clicks until the work is done.
      disabled={disabled}
      aria-busy={loading || undefined}
      onClick={(e) => {
        if (loading) {
          e.preventDefault();
          return;
        }
        onClick?.(e);
      }}
      {...rest}
    >
      <span className={cn("inline-flex items-center gap-2", loading && "invisible")}>
        {leadingIcon}
        {children}
        {trailingIcon}
      </span>
      {loading ? (
        <span className="absolute inset-0 inline-flex items-center justify-center">
          <Spinner />
          <span className="sr-only">{loadingLabel}</span>
        </span>
      ) : null}
    </button>
  );
}

export type ButtonLinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {
  href: Route;
  variant?: ButtonVariant;
  size?: ButtonSize;
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode;
};

/** A link to another Parry page, styled as a button. */
export function ButtonLink({ href, variant = "primary", size = "md", className, leadingIcon, trailingIcon, children, ...rest }: ButtonLinkProps) {
  return (
    <Link href={href} className={buttonClasses({ variant, size, className })} {...rest}>
      {leadingIcon}
      {children}
      {trailingIcon}
    </Link>
  );
}
