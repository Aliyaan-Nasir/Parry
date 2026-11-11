"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { NAV } from "./nav";
import { useTheme } from "@/lib/use-theme";
import { cn } from "@/lib/cn";

type Command = { id: string; label: string; hint?: string; group: string; keys?: string; run: () => void };

/**
 * Cmd+K (Ctrl+K) opens a palette of every page and action; "g" then a page's key goes straight
 * there. Arrow keys move, Enter runs, Escape closes.
 */
export function CommandPalette() {
  const router = useRouter();
  const { resolved, setPreference } = useTheme();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [i, setI] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);

  const go = useCallback((href: string) => {
    setOpen(false);
    router.push(href as never);
  }, [router]);

  const commands = useMemo<Command[]>(
    () => [
      { id: "a-open", group: "Actions", label: "Open a leveraged position", run: () => go("/app/open") },
      { id: "a-close", group: "Actions", label: "Close a position", hint: "repay, withdraw, close the perp", run: () => go("/app?action=close") },
      { id: "a-unwind", group: "Actions", label: "Unwind the protected account", hint: "revoke, return the reserve, withdraw all", run: () => go("/app?action=unwind") },
      { id: "a-mandate", group: "Actions", label: "Set the guardian's mandate", run: () => go("/app/protect") },
      { id: "a-deposit", group: "Actions", label: "Deposit into the vault", run: () => go("/app/vault#deposit") },
      { id: "a-cert", group: "Actions", label: "Issue a health certificate", run: () => go("/app/certificates#issue") },
      { id: "a-verify", group: "Actions", label: "Verify a decision or certificate", run: () => go("/verify") },
      { id: "a-check", group: "Actions", label: "Check any NEAR account", run: () => go("/check") },
      { id: "a-shock", group: "Actions", label: "Run a market shock", hint: "testnet", run: () => go("/app/shock") },
      { id: "a-theme", group: "Actions", label: `Switch to ${resolved === "dark" ? "light" : "dark"} theme`, run: () => { setPreference(resolved === "dark" ? "light" : "dark"); setOpen(false); } },
      ...NAV.map((n) => ({ id: n.href, group: "Pages", label: n.label, keys: n.key ? `G ${n.key.toUpperCase()}` : undefined, run: () => go(n.href) })),
    ],
    [go, resolved, setPreference],
  );

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    return t ? commands.filter((c) => `${c.label} ${c.hint ?? ""} ${c.group}`.toLowerCase().includes(t)) : commands;
  }, [commands, q]);

  useEffect(() => {
    let pending = false;
    let timer = 0;
    const onKey = (e: globalThis.KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = !!target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (pending) {
        pending = false;
        const hit = NAV.find((n) => n.key === e.key.toLowerCase());
        if (hit) {
          e.preventDefault();
          router.push(hit.href);
        }
        return;
      }
      if (e.key === "g") {
        pending = true;
        window.clearTimeout(timer);
        timer = window.setTimeout(() => (pending = false), 900);
      }
    };
    window.addEventListener("keydown", onKey);
    const openEvent = () => setOpen(true);
    window.addEventListener("parry-palette", openEvent);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("parry-palette", openEvent);
      window.clearTimeout(timer);
    };
  }, [router]);

  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      setQ("");
      setI(0);
      requestAnimationFrame(() => input.current?.focus());
    } else if (!open && d.open) d.close();
  }, [open]);

  const key = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setI((x) => Math.min(filtered.length - 1, x + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setI((x) => Math.max(0, x - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      filtered[i]?.run();
    }
  };

  let lastGroup = "";
  return (
    <dialog
      ref={dialog}
      onClose={() => setOpen(false)}
      onClick={(e) => e.target === dialog.current && setOpen(false)}
      aria-label="Command palette"
      className="surface-glass m-auto mt-[12vh] w-[min(640px,calc(100vw-2rem))] max-w-none p-0 text-fg backdrop:bg-scrim backdrop:backdrop-blur-sm"
    >
      <div className="flex items-center gap-3 border-b border-line px-4">
        <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" className="shrink-0 text-muted" aria-hidden="true">
          <circle cx="9" cy="9" r="5.5" />
          <path d="m13 13 4 4" />
        </svg>
        <input
          ref={input}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setI(0);
          }}
          onKeyDown={key}
          placeholder="Search pages and actions"
          role="combobox"
          aria-expanded="true"
          aria-autocomplete="list"
          aria-label="Search pages and actions"
          aria-controls="palette-list"
          aria-activedescendant={filtered[i] ? `cmd-${filtered[i]!.id}` : undefined}
          className="h-14 min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-muted/70"
        />
        <span className="kbd">Esc</span>
      </div>
      <ul id="palette-list" role="listbox" className="max-h-[56vh] overflow-y-auto p-2">
        {filtered.length === 0 ? <li className="px-3 py-6 text-center text-sm text-muted">Nothing matches.</li> : null}
        {filtered.map((c, idx) => {
          const head = c.group !== lastGroup ? c.group : null;
          lastGroup = c.group;
          return (
            <li key={c.id} role="presentation">
              {head ? <div className="px-3 pb-1 pt-3 text-[11.5px] text-muted/80">{head}</div> : null}
              <div
                id={`cmd-${c.id}`}
                role="option"
                aria-selected={idx === i}
                onMouseMove={() => setI(idx)}
                onClick={() => c.run()}
                className={cn("flex cursor-pointer items-center justify-between gap-4 rounded-[8px] px-3 py-2.5 text-sm", idx === i ? "bg-hover text-fg" : "text-fg/85")}
              >
                <span>
                  {c.label}
                  {c.hint ? <span className="ml-2 text-muted">{c.hint}</span> : null}
                </span>
                {c.keys ? (
                  <span className="flex gap-1">
                    {c.keys.split(" ").map((k, ki) => (
                      <span key={ki} className="kbd">
                        {k}
                      </span>
                    ))}
                  </span>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </dialog>
  );
}

/** Opens the palette from a button (the keyboard shortcut works anywhere). */
export function openPalette() {
  window.dispatchEvent(new Event("parry-palette"));
}
