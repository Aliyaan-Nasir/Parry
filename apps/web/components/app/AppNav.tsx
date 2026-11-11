"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Suspense, useLayoutEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { GROUPS, NAV, isActive } from "./nav";
import { Logo, Mark } from "@/components/brand/Logo";
import { Sheet } from "@/components/ui/Modal";
import { cn } from "@/lib/cn";

const RAIL_KEY = "parry-rail";

/**
 * The current path, read under Suspense: on a page with a runtime param (a position) the path is
 * only known at request time, so the nav prerenders without an active item and fills it in.
 */
function WithPathname({ children }: { children: (pathname: string | null) => ReactNode }) {
  return (
    <Suspense fallback={children(null)}>
      <CurrentPath>{children}</CurrentPath>
    </Suspense>
  );
}

function CurrentPath({ children }: { children: (pathname: string | null) => ReactNode }) {
  const pathname = usePathname();
  return <>{children(pathname)}</>;
}

function NavList({ pathname, onNavigate, collapsed = false }: { pathname: string | null; onNavigate?: () => void; collapsed?: boolean }) {
  return (
    <div className="grid gap-5">
      {GROUPS.map((g) => {
        const items = NAV.filter((i) => i.group === g);
        if (!items.length) return null;
        return (
          <div key={g}>
            <div className={cn("mb-1.5 px-3 text-[11.5px] text-muted/80 transition-opacity", collapsed && "opacity-0")}>{g}</div>
            <ul className="grid gap-px">
              {items.map((item) => {
                const active = pathname !== null && isActive(pathname, item.href);
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      onClick={onNavigate}
                      aria-current={active ? "page" : undefined}
                      title={collapsed ? item.label : undefined}
                      className={cn(
                        "group relative flex h-9 items-center gap-3 rounded-[8px] px-3 text-[13.5px] transition-colors duration-200",
                        active ? "bg-raised text-fg shadow-[var(--highlight),0_0_0_1px_var(--parry-line)]" : "text-muted hover:bg-hover hover:text-fg",
                      )}
                    >
                      {active ? <span aria-hidden="true" className="absolute -left-3 top-2 h-5 w-[2px] rounded-full bg-brass-fill" /> : null}
                      <span className={cn("shrink-0 transition-colors", active ? "text-brass" : "text-muted group-hover:text-fg")}>{item.icon}</span>
                      <span className={cn("min-w-0 flex-1 truncate transition-opacity", collapsed && "opacity-0")}>
                        {item.label}
                        {item.testnetOnly ? <span className="ml-2 text-[11px] text-muted">Testnet</span> : null}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

/** The desktop rail (lg and up): icon and label, collapsible to icons only; remembered per browser. */
function readRail(): boolean {
  try {
    return localStorage.getItem(RAIL_KEY) === "collapsed";
  } catch {
    return false;
  }
}
function subscribeRail(cb: () => void) {
  window.addEventListener("parry-rail", cb);
  return () => window.removeEventListener("parry-rail", cb);
}

export function Sidebar() {
  const collapsed = useSyncExternalStore(subscribeRail, readRail, () => false);
  const toggle = () => {
    try {
      localStorage.setItem(RAIL_KEY, collapsed ? "open" : "collapsed");
    } catch {}
    window.dispatchEvent(new Event("parry-rail"));
  };
  return (
    <aside className={cn("sticky top-0 hidden h-dvh shrink-0 flex-col border-r border-line bg-surface/60 transition-[width] duration-[var(--dur-2)] ease-[var(--ease-out)] lg:flex", collapsed ? "w-[64px]" : "w-60")}>
      <div className="flex h-14 items-center justify-between px-4">
        <Link href="/" className="rounded-md py-1" aria-label="Parry home">
          {collapsed ? <Mark size={24} /> : <Logo height={20} />}
        </Link>
      </div>
      <nav aria-label="App" className="flex-1 overflow-y-auto overflow-x-hidden px-3 py-3">
        <WithPathname>{(pathname) => <NavList pathname={pathname} collapsed={collapsed} />}</WithPathname>
      </nav>
      <button
        type="button"
        onClick={toggle}
        aria-label={collapsed ? "Expand the menu" : "Collapse the menu"}
        className="m-3 flex h-9 items-center gap-3 rounded-[8px] px-3 text-[13px] text-muted transition-colors hover:bg-hover hover:text-fg"
      >
        <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true" className={cn("shrink-0 transition-transform duration-300", collapsed && "rotate-180")}>
          <path d="M12 5 7 10l5 5" />
        </svg>
        <span className={cn("transition-opacity", collapsed && "opacity-0")}>Collapse</span>
      </button>
    </aside>
  );
}

/** Phone and tablet navigation: a bottom bar with the main pages and a sheet with all of them. */
export function MobileNav() {
  const [open, setOpen] = useState(false);
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
      <nav aria-label="App" className="surface-glass fixed inset-x-3 bottom-3 z-40 !rounded-2xl pb-[env(safe-area-inset-bottom)] lg:hidden">
        <WithPathname>{(pathname) => <MobileBar pathname={pathname} onMore={() => setOpen(true)} />}</WithPathname>
      </nav>
      <Sheet open={open} onOpenChange={setOpen} title="All pages">
        <nav aria-label="All pages">
          <WithPathname>{(pathname) => <NavList pathname={pathname} onNavigate={() => setOpen(false)} />}</WithPathname>
        </nav>
      </Sheet>
    </>
  );
}

function MobileBar({ pathname, onMore }: { pathname: string | null; onMore: () => void }) {
  const primary = NAV.filter((i) => i.primary);
  const inMenu = pathname !== null && !primary.some((i) => isActive(pathname, i.href));
  return (
    <ul className="mx-auto grid h-16 max-w-xl grid-cols-6">
      {primary.map((item) => {
        const active = pathname !== null && isActive(pathname, item.href);
        return (
          <li key={item.href}>
            <Link href={item.href} aria-current={active ? "page" : undefined} className={cn("flex h-full flex-col items-center justify-center gap-1 text-[10.5px] transition-colors", active ? "text-fg" : "text-muted hover:text-fg")}>
              <span className={active ? "text-brass" : undefined}>{item.icon}</span>
              <span className="max-w-full truncate px-1">{item.short ?? item.label.split(" ")[0]}</span>
            </Link>
          </li>
        );
      })}
      <li>
        <button type="button" onClick={onMore} aria-haspopup="dialog" className={cn("flex h-full w-full flex-col items-center justify-center gap-1 text-[10.5px] transition-colors", inMenu ? "text-fg" : "text-muted hover:text-fg")}>
          <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" className={inMenu ? "text-brass" : undefined}>
            <circle cx="4.5" cy="10" r="1.5" fill="currentColor" />
            <circle cx="10" cy="10" r="1.5" fill="currentColor" />
            <circle cx="15.5" cy="10" r="1.5" fill="currentColor" />
          </svg>
          More
        </button>
      </li>
    </ul>
  );
}
