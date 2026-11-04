import type { Metadata } from "next";
import Link from "next/link";
import { Logo } from "@/components/brand/Logo";
import { ButtonLink } from "@/components/ui/Button";

export const metadata: Metadata = { title: "Page not found" };

export default function NotFound() {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b border-line">
        <div className="mx-auto flex h-16 w-full max-w-[76rem] items-center px-4 sm:px-6 lg:px-8">
          <Link href="/" className="-ml-1 rounded-md px-1 py-1" aria-label="Parry home">
            <Logo height={26} />
          </Link>
        </div>
      </header>
      <main id="main" tabIndex={-1} className="flex flex-1 items-center justify-center px-4 py-20 outline-none">
        <div className="max-w-md text-center">
          <p className="num text-sm font-medium tracking-[0.14em] text-brass">404</p>
          <h1 className="mt-4 font-display text-[36px] font-semibold leading-tight tracking-[-0.02em] text-fg">This page was turned aside.</h1>
          <p className="mt-4 text-[15px] leading-7 text-muted">There is nothing at this address. It may have moved, or it never existed.</p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <ButtonLink href="/">Back to Parry</ButtonLink>
            <ButtonLink href="/app" variant="secondary">
              Open the app
            </ButtonLink>
          </div>
        </div>
      </main>
    </div>
  );
}
