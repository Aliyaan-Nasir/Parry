"use client";

import Link from "next/link";
import type { Route } from "next";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";

const PAGES: { href: Route; label: string }[] = [
  { href: "/legal/terms", label: "Terms" },
  { href: "/legal/privacy", label: "Privacy" },
  { href: "/legal/cookies", label: "Cookies" },
  { href: "/legal/security", label: "Security" },
];

export function LegalNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Legal" className="lg:sticky lg:top-24">
      <p className="num text-[11px] font-medium uppercase tracking-[0.14em] text-muted">Legal</p>
      <ul className="mt-3 flex flex-wrap gap-1 lg:flex-col">
        {PAGES.map((p) => {
          const active = pathname === p.href;
          return (
            <li key={p.href}>
              <Link
                href={p.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "block rounded-lg px-3 py-2 text-sm font-semibold transition-colors",
                  active ? "bg-raised text-fg shadow-[0_0_0_1px_var(--parry-line)]" : "text-muted hover:text-fg",
                )}
              >
                {p.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
