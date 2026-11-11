import type { ReactNode } from "react";
import { RevealText } from "@/components/fx/Reveal";
import { cn } from "@/lib/cn";

/** A section's title, revealed line by line, and its lead (works on the server and in client sections). */
export function SectionHead({ id, title, lead, className, center = false }: { id?: string; title: readonly ReactNode[]; lead?: ReactNode; className?: string; center?: boolean }) {
  return (
    <div id={id} className={cn("scroll-mt-28", center && "text-center", className)}>
      <RevealText lines={title} className={cn("display-sm text-gradient text-[2.4rem] sm:text-[3.4rem] lg:text-[4rem]", center && "mx-auto")} />
      {lead ? <p className={cn("mt-5 max-w-[38rem] text-lg leading-relaxed text-muted", center && "mx-auto")}>{lead}</p> : null}
    </div>
  );
}
