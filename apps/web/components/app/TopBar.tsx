"use client";

import Link from "next/link";
import { AccountButton } from "./AccountButton";
import { CommandPalette, openPalette } from "./CommandPalette";
import { WatchlistBar } from "./WatchlistBar";
import { Mark } from "@/components/brand/Logo";
import { ThemeToggle } from "@/components/theme/ThemeToggle";
import { networkLabel } from "@/lib/env";

/** The app's top bar: the network in plain text, the watchlist, the palette, the theme and the account. */
export function TopBar() {
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-bg/80 backdrop-blur-md backdrop-saturate-150">
      <div className="flex h-14 items-center gap-4 px-4 sm:px-6 lg:px-8">
        <Link href="/" className="rounded-md p-1 lg:hidden" aria-label="Parry home">
          <Mark size={24} />
        </Link>
        <span className="shrink-0 text-[12.5px] text-muted">NEAR {networkLabel.toLowerCase()}</span>
        <span aria-hidden="true" className="hidden h-4 w-px bg-line md:block" />
        <WatchlistBar className="hidden min-w-0 flex-1 md:flex" />
        <div className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            onClick={openPalette}
            className="hidden h-8 items-center gap-2 rounded-[8px] border border-line px-2.5 text-[12.5px] text-muted transition-colors hover:bg-hover hover:text-fg sm:flex"
          >
            Search
            <span className="kbd">⌘K</span>
          </button>
          <ThemeToggle />
          <AccountButton />
        </div>
      </div>
      <CommandPalette />
    </header>
  );
}
