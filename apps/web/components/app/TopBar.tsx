import Link from "next/link";
import { ConnectButton } from "./ConnectButton";
import { NetworkBadge } from "./NetworkBadge";
import { Mark } from "@/components/brand/Logo";
import { ThemeToggle } from "@/components/theme/ThemeToggle";

export function TopBar() {
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-bg">
      <div className="flex h-16 items-center justify-between gap-3 px-4 sm:px-6 lg:px-8">
        <div className="flex items-center gap-3">
          <Link href="/" className="rounded-md p-1 lg:hidden" aria-label="Parry home">
            <Mark size={26} />
          </Link>
          <NetworkBadge />
        </div>
        <div className="flex items-center gap-1.5">
          <ThemeToggle />
          <ConnectButton />
        </div>
      </div>
    </header>
  );
}
