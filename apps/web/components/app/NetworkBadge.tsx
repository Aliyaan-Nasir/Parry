import { Badge } from "@/components/ui/Badge";
import { isTestnet, networkLabel } from "@/lib/env";

/** The NEAR network this build talks to. */
export function NetworkBadge({ className }: { className?: string }) {
  return (
    <Badge tone={isTestnet ? "caution" : "safe"} variant="soft" className={className}>
      <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
      <span className="sr-only">Network: </span>
      NEAR {networkLabel}
    </Badge>
  );
}
