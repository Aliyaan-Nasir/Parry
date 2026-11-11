import Link from "next/link";
import type { Route } from "next";
import { Container } from "./Section";
import { GitHubIcon } from "./icons";
import { Logo } from "@/components/brand/Logo";
import { ThemeSwitcher } from "@/components/theme/ThemeToggle";
import { repoUrl } from "@/lib/env";
import { FooterWordmark } from "./FooterWordmark";

const LEGAL: { href: Route; label: string }[] = [
  { href: "/legal/terms", label: "Terms" },
  { href: "/legal/privacy", label: "Privacy" },
  { href: "/legal/cookies", label: "Cookies" },
  { href: "/legal/security", label: "Security" },
];

const PRODUCT: { href: Route; label: string }[] = [
  { href: "/app", label: "Open the app" },
  { href: "/check", label: "Check an account" },
  { href: "/verify", label: "Verify a proof" },
  { href: "/replay", label: "Crash replay" },
  { href: "/app/status", label: "Status" },
];

const linkClass = "text-sm text-muted transition-colors hover:text-fg";

export function SiteFooter() {
  return (
    <footer className="relative overflow-hidden border-t border-line">
      <Container className="py-14">
        <div className="grid grid-cols-2 gap-x-6 gap-y-10 md:grid-cols-12">
          <div className="col-span-2 md:col-span-5">
            <Logo height={26} />
            <p className="mt-4 max-w-sm text-sm leading-6 text-muted">
              Parry keeps your money from getting liquidated, and lets you earn without liquidation risk at all.
            </p>
            <div className="mt-6">
              <ThemeSwitcher />
            </div>
          </div>
          <nav aria-label="Product" className="md:col-span-2">
            <p className="text-[13px] font-semibold text-fg">Product</p>
            <ul className="mt-3 grid gap-2.5">
              {PRODUCT.map((l) => (
                <li key={l.href}>
                  <Link href={l.href} className={linkClass}>
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
          <nav aria-label="Legal" className="md:col-span-2">
            <p className="text-[13px] font-semibold text-fg">Legal</p>
            <ul className="mt-3 grid gap-2.5">
              {LEGAL.map((l) => (
                <li key={l.href}>
                  <Link href={l.href} className={linkClass}>
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
          <div className="col-span-2 md:col-span-3">
            <p className="text-[13px] font-semibold text-fg">Source</p>
            <ul className="mt-3 grid gap-2.5">
              {repoUrl ? (
                <li>
                  <a href={repoUrl} target="_blank" rel="noopener noreferrer" className={`${linkClass} inline-flex items-center gap-2`}>
                    <GitHubIcon />
                    GitHub
                    <span className="sr-only"> (opens in a new tab)</span>
                  </a>
                </li>
              ) : null}
              <li className="text-sm text-muted">MIT License</li>
            </ul>
          </div>
        </div>
        <div className="mt-12 flex flex-col gap-4 border-t border-line pt-6 text-[13px] text-muted sm:flex-row sm:items-center sm:justify-between">
          <p>Made by Aliyaan Nasir.</p>
          <p>Built on NEAR.</p>
        </div>
      </Container>
      <FooterWordmark />
    </footer>
  );
}
