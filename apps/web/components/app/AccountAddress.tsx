"use client";

import { CopyButton, ExternalLink } from "./bits";
import { nearAccountUrl } from "@/lib/explorer";
import { cn } from "@/lib/cn";

/**
 * A NEAR account id in full (universal addresses are long, so it wraps), with copy and a
 * NearBlocks link.
 */
export function AccountAddress({ id, label = "account address", className }: { id: string; label?: string; className?: string }) {
  const href = nearAccountUrl(id);
  return (
    <div className={cn("flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1", className)}>
      <span className="num min-w-0 break-all text-[13px] leading-5 text-fg">{id}</span>
      <span className="flex items-center gap-1">
        <CopyButton value={id} label={label} className="-my-1" />
        {href ? (
          <ExternalLink href={href} className="px-1 text-[13px]">
            NearBlocks
          </ExternalLink>
        ) : null}
      </span>
    </div>
  );
}
