import type { ReactNode } from "react";

export type PageHeaderProps = {
  title: string;
  description?: ReactNode;
  /** A small tag beside the title, for example "Testnet". */
  tag?: string;
  actions?: ReactNode;
};

export function PageHeader({ title, description, tag, actions }: PageHeaderProps) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4 pb-2">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="display-sm text-gradient text-[2.25rem] sm:text-[2.75rem]">{title}</h1>
          {tag ? <span className="text-sm text-muted">{tag}</span> : null}
        </div>
        {description ? <p className="mt-2 max-w-2xl text-[15px] leading-7 text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </header>
  );
}
