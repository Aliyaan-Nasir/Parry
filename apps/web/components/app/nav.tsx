import type { Route } from "next";
import type { ReactNode } from "react";
import { isTestnet } from "@/lib/env";

function Glyph({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

export type NavItem = {
  href: Route;
  label: string;
  icon: ReactNode;
  group: "Overview" | "Protect" | "Earn" | "Markets" | "System";
  /** Shown on the phone's bottom bar (the rest live in the palette and the menu). */
  primary?: boolean;
  /** A single key that opens the page from anywhere in the app (shown in the palette). */
  key?: string;
  testnetOnly?: boolean;
};

const ALL: NavItem[] = [
  { href: "/app", label: "Dashboard", group: "Overview", primary: true, key: "d", icon: <Glyph><path d="M3 10.5 10 4l7 6.5" /><path d="M5 9v7h10V9" /></Glyph> },
  { href: "/app/portfolio", label: "Portfolio", group: "Overview", key: "p", icon: <Glyph><path d="M3 15h14M5 15V9M9 15V5M13 15v-4M17 15V7" /></Glyph> },
  { href: "/app/watched", label: "Watched accounts", group: "Overview", key: "w", icon: <Glyph><path d="M2.5 10s2.8-5 7.5-5 7.5 5 7.5 5-2.8 5-7.5 5-7.5-5-7.5-5Z" /><circle cx="10" cy="10" r="2.2" /></Glyph> },
  { href: "/app/open", label: "Open position", group: "Protect", key: "o", icon: <Glyph><circle cx="10" cy="10" r="7" /><path d="M10 6.5v7M6.5 10h7" /></Glyph> },
  { href: "/app/protect", label: "Protect", group: "Protect", primary: true, key: "m", icon: <Glyph><path d="M10 2.5 16.5 5v4.5c0 4-2.7 6.8-6.5 8-3.8-1.2-6.5-4-6.5-8V5Z" /></Glyph> },
  { href: "/app/guardian", label: "Guardian log", group: "Protect", primary: true, key: "g", icon: <Glyph><path d="M5 3.5h10v13H5zM7.5 7h5M7.5 10h5M7.5 13h3" /></Glyph> },
  { href: "/app/certificates", label: "Certificates", group: "Protect", key: "c", icon: <Glyph><path d="M4 3.5h12v9H4z" /><path d="m7.5 15.5 2.5-1.5 2.5 1.5v-3h-5z" /></Glyph> },
  { href: "/app/alerts", label: "Alerts", group: "Protect", primary: true, key: "a", icon: <Glyph><path d="M5.5 13.5V9a4.5 4.5 0 0 1 9 0v4.5l1.5 1.5H4z" /><path d="M8.5 17h3" /></Glyph> },
  { href: "/app/vault", label: "Vault", group: "Earn", primary: true, key: "v", icon: <Glyph><rect x="3" y="4" width="14" height="12" rx="1.75" /><circle cx="10" cy="10" r="2.75" /></Glyph> },
  { href: "/app/rates", label: "Rates", group: "Earn", key: "r", icon: <Glyph><path d="M4 15 15.5 4.5" /><circle cx="6" cy="6" r="1.8" /><circle cx="14" cy="14" r="1.8" /></Glyph> },
  { href: "/app/cascade", label: "Cascade map", group: "Markets", key: "h", icon: <Glyph><path d="M3 16h14" /><path d="M5 16v-3M8 16V8M11 16v-6M14 16V5" /></Glyph> },
  { href: "/app/shock", label: "Market shock", group: "Markets", key: "s", testnetOnly: true, icon: <Glyph><path d="M11 2.5 5 11h4.5L8.5 17.5 15 9h-4.5z" /></Glyph> },
  { href: "/app/status", label: "Status", group: "System", icon: <Glyph><path d="M2.5 10h3l2-4.5 3.5 9 2-4.5h4.5" /></Glyph> },
  { href: "/app/settings", label: "Settings", group: "System", icon: <Glyph><circle cx="10" cy="10" r="2.5" /><path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4" /></Glyph> },
];

export const NAV: NavItem[] = ALL.filter((i) => !i.testnetOnly || isTestnet);
export const GROUPS = ["Overview", "Protect", "Earn", "Markets", "System"] as const;

export function isActive(pathname: string, href: string): boolean {
  if (href === "/app") return pathname === "/app";
  return pathname === href || pathname.startsWith(`${href}/`);
}
