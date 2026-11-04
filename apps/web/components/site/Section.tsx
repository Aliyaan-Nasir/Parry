import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/** Page width container with the site's gutters. */
export function Container({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("mx-auto w-full max-w-[76rem] px-4 sm:px-6 lg:px-8", className)}>{children}</div>;
}

export type SectionProps = {
  id: string;
  /** Short mono label above the title, for example "Protect". */
  eyebrow: string;
  index?: string;
  title: ReactNode;
  lead?: ReactNode;
  /** Extra content under the lead, in the title column on wide screens. */
  aside?: ReactNode;
  children?: ReactNode;
  className?: string;
};

/** A landing page section: hairline on top, numbered eyebrow, display title, lead, body. */
export function Section({ id, eyebrow, index, title, lead, aside, children, className }: SectionProps) {
  const headingId = `${id}-title`;
  return (
    <section id={id} aria-labelledby={headingId} className={cn("scroll-mt-20 border-t border-line", className)}>
      <Container className="py-20 sm:py-28">
        <div className="grid gap-10 lg:grid-cols-12 lg:gap-12">
          <header className="lg:col-span-5" data-reveal>
            <p className="num flex items-center gap-3 text-xs font-medium uppercase tracking-[0.14em] text-brass">
              {index ? <span>{index}</span> : null}
              <span aria-hidden="true" className="h-px w-8 bg-brass/60" />
              <span>{eyebrow}</span>
            </p>
            <h2 id={headingId} className="mt-5 font-display text-[34px] font-semibold leading-[1.08] tracking-[-0.02em] text-fg sm:text-[44px]">
              {title}
            </h2>
            {lead ? <p className="mt-5 max-w-xl text-[17px] leading-8 text-muted">{lead}</p> : null}
            {aside ? <div className="mt-8">{aside}</div> : null}
          </header>
          <div className="lg:col-span-7">{children}</div>
        </div>
      </Container>
    </section>
  );
}
