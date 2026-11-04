import type { Route } from "next";
import type { ReactNode } from "react";
import { isTestnet } from "@/lib/env";

function Glyph({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 20 20"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export type NavItem = {
  href: Route;
  label: string;
  icon: ReactNode;
  /** Shown on the phone's bottom bar (the rest live in the menu sheet). */
  primary?: boolean;
  /** Small tag after the label. */
  tag?: string;
};

const ALL: (NavItem & { testnetOnly?: boolean })[] = [
  {
    href: "/app",
    label: "Dashboard",
    primary: true,
    icon: (
      <Glyph>
        <rect x="3" y="3" width="6" height="8" rx="1.25" />
        <rect x="11" y="3" width="6" height="5" rx="1.25" />
        <rect x="3" y="13" width="6" height="4" rx="1.25" />
        <rect x="11" y="10" width="6" height="7" rx="1.25" />
      </Glyph>
    ),
  },
  {
    href: "/app/open",
    label: "Open position",
    icon: (
      <Glyph>
        <circle cx="10" cy="10" r="7" />
        <path d="M10 6.5 V13.5 M6.5 10 H13.5" />
      </Glyph>
    ),
  },
  {
    href: "/app/protect",
    label: "Protect",
    primary: true,
    icon: (
      <Glyph>
        <path d="M10 2.5 L16.5 5 V9.5 C 16.5 13.5, 13.8 16.3, 10 17.5 C 6.2 16.3, 3.5 13.5, 3.5 9.5 V5 Z" />
      </Glyph>
    ),
  },
  {
    href: "/app/vault",
    label: "Vault",
    primary: true,
    icon: (
      <Glyph>
        <rect x="3" y="4" width="14" height="12" rx="1.75" />
        <circle cx="10" cy="10" r="2.75" />
        <path d="M10 7.25 V6 M12.75 10 H14" />
      </Glyph>
    ),
  },
  {
    href: "/app/portfolio",
    label: "Portfolio",
    icon: (
      <Glyph>
        <path d="M10 3 A7 7 0 1 0 17 10 H10 Z" />
        <path d="M12.5 2.9 A7 7 0 0 1 17.1 7.5 H12.5 Z" />
      </Glyph>
    ),
  },
  {
    href: "/app/guardian",
    label: "Guardian log",
    icon: (
      <Glyph>
        <path d="M5 3 H15 V17 H5 Z" />
        <path d="M8 7 H12 M8 10 H12 M8 13 H10.5" />
      </Glyph>
    ),
  },
  {
    href: "/app/alerts",
    label: "Alerts",
    primary: true,
    icon: (
      <Glyph>
        <path d="M5.5 13.5 V9 A4.5 4.5 0 0 1 14.5 9 V13.5 L16 15 H4 Z" />
        <path d="M8.5 17 H11.5" />
      </Glyph>
    ),
  },
  {
    href: "/app/settings",
    label: "Settings",
    icon: (
      <Glyph>
        <path d="M3 6 H11 M15 6 H17 M3 14 H5 M9 14 H17" />
        <circle cx="13" cy="6" r="2" />
        <circle cx="7" cy="14" r="2" />
      </Glyph>
    ),
  },
  {
    href: "/app/status",
    label: "Status",
    icon: (
      <Glyph>
        <path d="M2.5 10 H6 L8 5.5 L12 14.5 L14 10 H17.5" />
      </Glyph>
    ),
  },
  {
    href: "/app/shock",
    label: "Market shock",
    tag: "Testnet",
    testnetOnly: true,
    icon: (
      <Glyph>
        <path d="M11 2.5 L5 11 H10 L9 17.5 L15 9 H10 Z" />
      </Glyph>
    ),
  },
];

/** The app's navigation for this build: Market shock exists only off mainnet. */
export const NAV: NavItem[] = ALL.filter((i) => !i.testnetOnly || isTestnet).map(({ testnetOnly: _t, ...item }) => item);

export function isActive(pathname: string, href: string): boolean {
  if (href === "/app") return pathname === "/app";
  return pathname === href || pathname.startsWith(`${href}/`);
}
