"use client";

import { AnimatePresence, m } from "framer-motion";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { explorerLabel, explorerUrl, type ExplorerKind } from "@/lib/explorer";
import { cn } from "@/lib/cn";

export type ToastTone = "info" | "success" | "warning" | "error";

export type ToastInput = {
  title: string;
  description?: string;
  tone?: ToastTone;
  /** Adds a "View on ..." link to the transaction on its explorer. */
  explorer?: { kind: ExplorerKind; hash: string };
  /** Milliseconds before it closes on its own; Infinity keeps it until dismissed. */
  duration?: number;
};

type ToastItem = ToastInput & { id: number; tone: ToastTone; duration: number };

type ToastApi = {
  toast: (input: ToastInput) => number;
  dismiss: (id: number) => void;
};

const ToastContext = createContext<ToastApi | null>(null);

/** Shows a toast from any client component under ToastProvider. */
export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error("useToast must be used under <ToastProvider>");
  return api;
}

const defaultDuration: Record<ToastTone, number> = { info: 6000, success: 6000, warning: 9000, error: 12000 };
const toneText: Record<ToastTone, string> = { info: "text-brass", success: "text-safe", warning: "text-caution", error: "text-critical" };
const toneWord: Record<ToastTone, string> = { info: "Notice", success: "Done", warning: "Warning", error: "Error" };

function ToneIcon({ tone }: { tone: ToastTone }) {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" className={cn("mt-0.5 shrink-0", toneText[tone])}>
      {tone === "success" ? (
        <>
          <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1.4" />
          <path d="M4.8 8.3 L7 10.4 L11.2 5.8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </>
      ) : tone === "info" ? (
        <>
          <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1.4" />
          <path d="M8 7.2 V11.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          <circle cx="8" cy="4.9" r="0.95" fill="currentColor" />
        </>
      ) : tone === "warning" ? (
        <>
          <path d="M8 1.6 L15 14 H1 Z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
          <path d="M8 6.2 V9.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          <circle cx="8" cy="11.8" r="0.9" fill="currentColor" />
        </>
      ) : (
        <>
          <path d="M5.1 1.2 H10.9 L14.8 5.1 V10.9 L10.9 14.8 H5.1 L1.2 10.9 V5.1 Z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
          <path d="M5.8 5.8 L10.2 10.2 M10.2 5.8 L5.8 10.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </>
      )}
    </svg>
  );
}

function ExternalIcon() {
  return (
    <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">
      <path d="M4.5 2.5 H9.5 V7.5 M9.3 2.7 L2.8 9.2" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ToastCard({ item, dismiss }: { item: ToastItem; dismiss: (id: number) => void }) {
  const [paused, setPaused] = useState(false);
  const onDismiss = useCallback(() => dismiss(item.id), [dismiss, item.id]);
  const remaining = useRef(item.duration);
  const started = useRef(0);

  useEffect(() => {
    if (paused || !Number.isFinite(remaining.current)) return;
    started.current = Date.now();
    const t = window.setTimeout(onDismiss, remaining.current);
    return () => {
      window.clearTimeout(t);
      remaining.current -= Date.now() - started.current;
    };
  }, [paused, onDismiss]);

  const link = item.explorer ? explorerUrl(item.explorer.kind, item.explorer.hash) : null;

  return (
    <m.li
      initial={{ opacity: 0, y: 16, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, scale: 0.98, transition: { duration: 0.15 } }}
      transition={{ type: "spring", stiffness: 420, damping: 34 }}
      role={item.tone === "error" ? "alert" : "status"}
      aria-atomic="true"
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      className="pointer-events-auto flex w-full gap-3 rounded-xl border border-line bg-raised p-4 shadow-[0_18px_48px_-20px_rgb(14_16_14/0.4)]"
    >
      <ToneIcon tone={item.tone} />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-fg">
          <span className="sr-only">{toneWord[item.tone]}: </span>
          {item.title}
        </p>
        {item.description ? <p className="mt-0.5 text-[13px] leading-5 text-muted">{item.description}</p> : null}
        {link && item.explorer ? (
          <a
            href={link}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 inline-flex items-center gap-1.5 text-[13px] font-semibold text-brass underline-offset-4 hover:underline"
          >
            View on {explorerLabel(item.explorer.kind)}
            <ExternalIcon />
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        ) : null}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        className="-m-1.5 inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-hover hover:text-fg"
      >
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <path d="M3.5 3.5 L12.5 12.5 M12.5 3.5 L3.5 12.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
        <span className="sr-only">Dismiss notification</span>
      </button>
    </m.li>
  );
}

/** Holds the toast queue and renders the notification region (bottom right, bottom on phones). */
export function ToastProvider({ children, max = 4 }: { children: ReactNode; max?: number }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => setItems((all) => all.filter((t) => t.id !== id)), []);
  const toast = useCallback(
    (input: ToastInput) => {
      const id = nextId.current++;
      const tone = input.tone ?? "info";
      setItems((all) => [...all, { ...input, id, tone, duration: input.duration ?? defaultDuration[tone] }].slice(-max));
      return id;
    },
    [max],
  );
  const api = useMemo(() => ({ toast, dismiss }), [toast, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <section aria-label="Notifications" className="pointer-events-none fixed inset-x-0 z-[60] flex justify-center px-4 sm:inset-x-auto sm:right-6 sm:px-0" style={{ bottom: "calc(env(safe-area-inset-bottom) + var(--parry-bottom-bar, 0px) + 16px)" }}>
        <ol className="flex w-full max-w-sm flex-col gap-2">
          <AnimatePresence initial={false}>
            {items.map((item) => (
              <ToastCard key={item.id} item={item} dismiss={dismiss} />
            ))}
          </AnimatePresence>
        </ol>
      </section>
    </ToastContext.Provider>
  );
}
