import type { ReactNode } from "react";

/** The frame for the public tool pages: a quiet title block and a centered column. */
export function PublicShell({ title, lead, children }: { title: string; lead: ReactNode; children: ReactNode }) {
  return (
    <div className="grain relative min-h-[80vh] overflow-x-clip pb-24 pt-32 sm:pt-40">
      <div aria-hidden="true" className="glow-brass absolute left-1/2 top-24 -z-10 h-72 w-[900px] -translate-x-1/2" />
      <div className="mx-auto max-w-[1080px] px-4 sm:px-6">
        <h1 className="display text-gradient text-5xl sm:text-7xl">{title}</h1>
        <p className="mt-5 max-w-2xl text-lg leading-relaxed text-muted">{lead}</p>
        <div className="mt-12">{children}</div>
      </div>
    </div>
  );
}
