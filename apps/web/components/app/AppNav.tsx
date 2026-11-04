"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useLayoutEffect, useState } from "react";
import { NAV, isActive } from "./nav";
import { Logo } from "@/components/brand/Logo";
import { Sheet } from "@/components/ui/Modal";
import { cn } from "@/lib/cn";

function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <ul className="grid gap-0.5">
      {NAV.map((item) => {
        const active = isActive(pathname, item.href);
        return (
          <li key={item.href}>
            <Link
              href={item.href}
              onClick={onNavigate}
              aria-current={active ? "page" : undefined}
              className={cn(
                "group flex h-10 items-center gap-3 rounded-lg px-3 text-sm font-semibold transition-colors",
                active ? "bg-raised text-fg shadow-[0_0_0_1px_var(--parry-line)]" : "text-muted hover:bg-hover hover:text-fg",
              )}
            >
              <span className={cn("transition-colors", active ? "text-brass" : "text-muted group-hover:text-fg")}>{item.icon}</span>
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              {item.tag ? (
                <span className="rounded-full border border-caution/40 px-1.5 text-[10px] font-semibold uppercase leading-4 tracking-[0.06em] text-caution">
                  {item.tag}
                </span>
              ) : null}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/** Desktop sidebar (lg and up). */
export function Sidebar() {
  return (
    <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 flex-col border-r border-line bg-surface lg:flex">
      <div className="flex h-16 items-center px-5">
        <Link href="/" className="rounded-md px-1 py-1" aria-label="Parry home">
          <Logo height={24} />
        </Link>
      </div>
      <nav aria-label="App" className="flex-1 overflow-y-auto px-3 py-3">
        <NavLinks />
      </nav>
      <div className="border-t border-line px-5 py-4 text-xs leading-5 text-muted">
        The guardian can only protect. You can revoke or override it at any moment.
      </div>
    </aside>
  );
}

/** Phone and tablet navigation: a bottom bar with the main pages and a sheet with all of them. */
export function MobileNav() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const primary = NAV.filter((i) => i.primary);
  const inMenu = !primary.some((i) => isActive(pathname, i.href));

  // Lets fixed elements elsewhere (toasts) sit above the bottom bar while the app shell is shown.
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.bottomBar = "";
    return () => {
      delete root.dataset.bottomBar;
    };
  }, []);

  return (
    <>
      <nav
        aria-label="App"
        className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] lg:hidden"
      >
        <ul className="mx-auto grid h-16 max-w-xl grid-cols-5">
          {primary.map((item) => {
            const active = isActive(pathname, item.href);
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex h-full flex-col items-center justify-center gap-1 text-[11px] font-semibold transition-colors",
                    active ? "text-fg" : "text-muted hover:text-fg",
                  )}
                >
                  <span className={active ? "text-brass" : undefined}>{item.icon}</span>
                  {item.label}
                </Link>
              </li>
            );
          })}
          <li>
            <button
              type="button"
              onClick={() => setOpen(true)}
              aria-haspopup="dialog"
              className={cn(
                "flex h-full w-full flex-col items-center justify-center gap-1 text-[11px] font-semibold transition-colors",
                inMenu ? "text-fg" : "text-muted hover:text-fg",
              )}
            >
              <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" className={inMenu ? "text-brass" : undefined}>
                <circle cx="4.5" cy="10" r="1.5" fill="currentColor" />
                <circle cx="10" cy="10" r="1.5" fill="currentColor" />
                <circle cx="15.5" cy="10" r="1.5" fill="currentColor" />
              </svg>
              More
            </button>
          </li>
        </ul>
      </nav>
      <Sheet open={open} onOpenChange={setOpen} title="All pages">
        <nav aria-label="All pages">
          <NavLinks onNavigate={() => setOpen(false)} />
        </nav>
      </Sheet>
    </>
  );
}
