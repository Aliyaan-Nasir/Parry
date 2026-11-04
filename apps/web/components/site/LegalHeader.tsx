import type { ReactNode } from "react";

export function LegalHeader({ title, children }: { title: string; children: ReactNode }) {
  return (
    <header className="mb-10 border-b border-line pb-8">
      <h1 className="font-display text-[38px] font-semibold leading-[1.1] tracking-[-0.02em] text-fg sm:text-[46px]">{title}</h1>
      <p className="mt-4 text-[17px] leading-8 text-muted">{children}</p>
    </header>
  );
}
