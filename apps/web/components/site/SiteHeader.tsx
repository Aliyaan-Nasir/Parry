"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { Container } from "./Section";
import { MenuIcon } from "./icons";
import { Logo } from "@/components/brand/Logo";
import { ThemeToggle } from "@/components/theme/ThemeToggle";
import { ButtonLink } from "@/components/ui/Button";
import { Sheet } from "@/components/ui/Modal";

const LINKS = [
  { href: "#how", label: "How it works" },
  { href: "#protect", label: "Protect" },
  { href: "#earn", label: "Earn" },
  { href: "#near", label: "NEAR" },
  { href: "#agents", label: "Agents" },
  { href: "#faq", label: "FAQ" },
] as const;

/** Section links only make sense on the landing page; elsewhere they point back to it. */
function sectionHref(hash: string, onLanding: boolean): string {
  return onLanding ? hash : `/${hash}`;
}

export function SiteHeader() {
  const onLanding = usePathname() === "/";
  const [open, setOpen] = useState(false);
  return (
    <header className="sticky top-0 z-40 border-b border-line bg-bg">
      <Container className="flex h-16 items-center justify-between gap-4">
        <Link href="/" className="-ml-1 rounded-md px-1 py-1" aria-label="Parry home">
          <Logo height={26} />
        </Link>
        <nav aria-label="Sections" className="hidden md:block">
          <ul className="flex items-center gap-1">
            {LINKS.map((l) => (
              <li key={l.href}>
                <a
                  href={sectionHref(l.href, onLanding)}
                  className="rounded-md px-3 py-2 text-sm font-semibold text-muted transition-colors hover:text-fg"
                >
                  {l.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <div className="flex items-center gap-1.5">
          <ThemeToggle />
          <ButtonLink href="/app" size="sm">
            Open the app
          </ButtonLink>
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-haspopup="dialog"
            className="inline-flex size-9 items-center justify-center rounded-lg text-fg transition-colors hover:bg-hover md:hidden"
          >
            <MenuIcon />
            <span className="sr-only">Open menu</span>
          </button>
        </div>
      </Container>
      <Sheet open={open} onOpenChange={setOpen} title="Menu" hideTitle>
        <nav aria-label="Sections">
          <ul className="grid gap-1 pt-1">
            {LINKS.map((l) => (
              <li key={l.href}>
                <a
                  href={sectionHref(l.href, onLanding)}
                  onClick={() => setOpen(false)}
                  className="flex h-12 items-center rounded-lg px-3 text-[17px] font-semibold text-fg transition-colors hover:bg-hover"
                >
                  {l.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <ButtonLink href="/app" size="lg" className="mt-4 w-full" onClick={() => setOpen(false)}>
          Open the app
        </ButtonLink>
      </Sheet>
    </header>
  );
}
