"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { MenuIcon } from "./icons";
import { Logo } from "@/components/brand/Logo";
import { Magnetic } from "@/components/fx/Magnetic";
import { ThemeToggle } from "@/components/theme/ThemeToggle";
import { ButtonLink } from "@/components/ui/Button";
import { Sheet } from "@/components/ui/Modal";
import { cn } from "@/lib/cn";

const LINKS = [
  { href: "#protect", label: "Protect" },
  { href: "#earn", label: "Earn" },
  { href: "#near", label: "NEAR" },
  { href: "#agents", label: "Agents" },
  { href: "/replay", label: "Crash replay" },
] as const;

/** Section links only make sense on the landing page; elsewhere they point back to it. */
function sectionHref(href: string, onLanding: boolean): string {
  if (!href.startsWith("#")) return href;
  return onLanding ? href : `/${href}`;
}

/**
 * A floating glass pill: the wordmark, a few links, the theme switch and "Open the app". It
 * condenses (narrower, tighter) once the page scrolls.
 */
export function SiteHeader() {
  const onLanding = usePathname() === "/";
  const [open, setOpen] = useState(false);
  const [condensed, setCondensed] = useState(false);
  useEffect(() => {
    const onScroll = () => setCondensed(window.scrollY > 24);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  return (
    <header className="pointer-events-none fixed inset-x-0 top-0 z-40 flex justify-center px-4 pt-3 sm:pt-4">
      <div
        className={cn(
          "surface-glass pointer-events-auto flex w-full items-center justify-between gap-3 !rounded-full pl-5 pr-2 transition-[max-width,height,padding] duration-[var(--dur-2)] ease-[var(--ease-out)]",
          condensed ? "h-12 max-w-[760px]" : "h-14 max-w-[1080px]",
        )}
      >
        <Link href="/" className="-ml-1 shrink-0 rounded-full px-1 py-1" aria-label="Parry home">
          <Logo height={condensed ? 20 : 22} className="transition-[width,height] duration-[var(--dur-2)]" />
        </Link>
        <nav aria-label="Sections" className="hidden md:block">
          <ul className="flex items-center">
            {LINKS.map((l) => (
              <li key={l.href}>
                <a href={sectionHref(l.href, onLanding)} className="rounded-full px-3 py-2 text-[13.5px] text-muted transition-colors duration-200 hover:text-fg">
                  {l.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <div className="flex items-center gap-1">
          <ThemeToggle />
          <Magnetic>
            <ButtonLink href="/app" size="sm" className="!rounded-full px-4">
              Open the app
            </ButtonLink>
          </Magnetic>
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-haspopup="dialog"
            className="inline-flex size-9 items-center justify-center rounded-full text-fg transition-colors hover:bg-hover md:hidden"
          >
            <MenuIcon />
            <span className="sr-only">Open menu</span>
          </button>
        </div>
      </div>
      <Sheet open={open} onOpenChange={setOpen} title="Menu" hideTitle>
        <nav aria-label="Sections">
          <ul className="grid gap-1 pt-1">
            {LINKS.map((l) => (
              <li key={l.href}>
                <a
                  href={sectionHref(l.href, onLanding)}
                  onClick={() => setOpen(false)}
                  className="flex h-12 items-center rounded-lg px-3 text-[17px] text-fg transition-colors hover:bg-hover"
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
