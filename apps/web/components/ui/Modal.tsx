"use client";

import { useEffect, useId, useLayoutEffect, useRef, type ReactNode } from "react";
import { cn } from "@/lib/cn";

export type ModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  /** Buttons, right aligned on wide screens and stacked on phones. */
  footer?: ReactNode;
  /** "modal" is centered; "sheet" rises from the bottom edge (phone navigation, quick actions). */
  variant?: "modal" | "sheet";
  size?: "sm" | "md" | "lg";
  /** Hide the visible title (it stays the dialog's accessible name). */
  hideTitle?: boolean;
  closeLabel?: string;
  className?: string;
};

const widths = { sm: "sm:max-w-sm", md: "sm:max-w-lg", lg: "sm:max-w-2xl" } as const;

function CloseIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <path d="M3.5 3.5 L12.5 12.5 M12.5 3.5 L3.5 12.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Native <dialog> shown with showModal(): focus moves in and is kept inside, the page behind is
 * inert, Escape and a click on the backdrop close it, and focus returns to the opener.
 */
export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  variant = "modal",
  size = "md",
  hideTitle = false,
  closeLabel = "Close",
  className,
}: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descId = useId();

  // Closes the page asks for itself are not the person closing the dialog: they must not report back.
  const quiet = useRef(false);
  const closeQuietly = (dialog: HTMLDialogElement) => {
    quiet.current = true;
    dialog.close();
  };

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) closeQuietly(dialog);
  }, [open]);

  // Lock page scroll while open. Layout effect cleanup also runs when the route is hidden.
  useLayoutEffect(() => {
    if (!open) return;
    const root = document.documentElement;
    root.dataset.scrollLocked = "";
    return () => {
      delete root.dataset.scrollLocked;
    };
  }, [open]);

  // A route kept alive in the background should come back with this dialog closed.
  useLayoutEffect(() => {
    const dialog = ref.current;
    return () => {
      if (dialog?.open) closeQuietly(dialog);
    };
  }, []);

  return (
    <dialog
      ref={ref}
      data-variant={variant}
      data-lenis-prevent=""
      aria-labelledby={titleId}
      aria-describedby={description ? descId : undefined}
      onClose={() => {
        if (quiet.current) {
          quiet.current = false;
          return;
        }
        onOpenChange(false);
      }}
      onCancel={(e) => {
        e.preventDefault();
        onOpenChange(false);
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onOpenChange(false);
      }}
      className={cn(
        "parry-dialog overflow-hidden shadow-[0_24px_64px_-24px_rgb(14_16_14/0.45)]",
        variant === "modal"
          ? cn("m-auto w-[calc(100%-2rem)] rounded-2xl", widths[size])
          : "mx-auto mb-0 mt-auto w-full rounded-t-2xl border-b-0 sm:max-w-lg",
        className,
      )}
    >
      <div className={cn("flex max-h-[85dvh] flex-col", variant === "sheet" && "pb-[env(safe-area-inset-bottom)]")}>
        {variant === "sheet" ? <div aria-hidden="true" className="mx-auto mt-2.5 h-1 w-10 shrink-0 rounded-full bg-line-strong" /> : null}
        <div className={cn("flex items-start justify-between gap-4 px-5 pt-4 sm:px-6", hideTitle ? "pb-0" : "pb-3")}>
          <div className={cn("min-w-0", hideTitle && "sr-only")}>
            <h2 id={titleId} className="font-display text-xl font-semibold tracking-[-0.01em] text-fg">
              {title}
            </h2>
            {description ? (
              <p id={descId} className="mt-1 text-sm text-muted">
                {description}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="-mr-2 ml-auto inline-flex size-9 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-hover hover:text-fg"
          >
            <CloseIcon />
            <span className="sr-only">{closeLabel}</span>
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-5 sm:px-6">{children}</div>
        {footer ? (
          <div className="flex flex-col-reverse gap-2 border-t border-line px-5 py-4 sm:flex-row sm:justify-end sm:px-6">{footer}</div>
        ) : null}
      </div>
    </dialog>
  );
}

/** The bottom sheet form of Modal. */
export function Sheet(props: Omit<ModalProps, "variant">) {
  return <Modal {...props} variant="sheet" />;
}
