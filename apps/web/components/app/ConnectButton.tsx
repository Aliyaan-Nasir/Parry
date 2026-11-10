"use client";

import { cn } from "@/lib/cn";

export type ConnectButtonProps = {
  /**
   * Starts the wallet connection. Until a handler is passed, the button renders in its
   * unavailable state (muted, aria-disabled) and does nothing.
   */
  onClick?: () => void;
  /** The connected NEAR account; when set, the button shows it instead of "Connect". */
  accountId?: string | null;
  /** True while a connection is being made. */
  pending?: boolean;
  label?: string;
  className?: string;
};

function shorten(accountId: string, head = 8, tail = 8): string {
  if (accountId.length <= head + tail + 4) return accountId;
  return `${accountId.slice(0, head)}...${accountId.slice(-tail)}`;
}

/** The account slot in the top bar. Wallet wiring plugs in through `onClick` and `accountId`. */
export function ConnectButton({ onClick, accountId, pending = false, label = "Connect", className }: ConnectButtonProps) {
  const available = typeof onClick === "function";
  const connected = typeof accountId === "string" && accountId.length > 0;
  return (
    <button
      type="button"
      onClick={available && !pending ? onClick : undefined}
      aria-disabled={!available || pending || undefined}
      aria-busy={pending || undefined}
      title={available ? undefined : "Wallet connection is not available yet"}
      className={cn(
        "inline-flex h-9 items-center gap-2 rounded-lg px-3.5 text-sm font-semibold transition-colors",
        connected
          ? "border border-line bg-raised text-fg hover:bg-hover"
          : available
            ? "bg-brass-fill text-on-brass hover:bg-brass-fill-hover"
            : "cursor-not-allowed border border-dashed border-line-strong bg-transparent text-muted",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn("size-1.5 rounded-full", connected ? "bg-safe" : available ? "bg-on-brass/70" : "bg-line-strong")}
      />
      {connected ? (
        <span className="num text-[13px]" title={accountId}>
          <span className="sm:hidden">{shorten(accountId, 5, 4)}</span>
          <span className="hidden sm:inline">{shorten(accountId)}</span>
        </span>
      ) : pending ? (
        "Connecting"
      ) : (
        label
      )}
    </button>
  );
}
