import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/cn";

type CardTag = "div" | "section" | "article" | "li" | "aside";

export type CardProps = HTMLAttributes<HTMLElement> & {
  as?: CardTag;
  /** Inner padding; "none" for edge to edge content such as charts and tables. */
  padding?: "none" | "sm" | "md" | "lg";
  /** Raised cards sit on the page surface; flat cards blend into it with only a hairline. */
  tone?: "raised" | "flat";
};

const paddings = { none: "", sm: "p-4", md: "p-5 sm:p-6", lg: "p-6 sm:p-8" } as const;

export function Card({ as: Tag = "div", padding = "md", tone = "raised", className, children, ...rest }: CardProps) {
  return (
    <Tag
      className={cn(
        "rounded-xl border border-line",
        tone === "raised" ? "bg-raised" : "bg-surface",
        paddings[padding],
        className,
      )}
      {...rest}
    >
      {children}
    </Tag>
  );
}

export type CardHeaderProps = {
  title: ReactNode;
  description?: ReactNode;
  /** Buttons or links aligned to the right of the title. */
  actions?: ReactNode;
  titleAs?: "h2" | "h3";
  className?: string;
};

export function CardHeader({ title, description, actions, titleAs: Title = "h3", className }: CardHeaderProps) {
  return (
    <div className={cn("flex flex-wrap items-start justify-between gap-x-4 gap-y-2", className)}>
      {/* The title block shares the line with the actions until the card gets narrow. */}
      <div className="min-w-0 flex-1 basis-64">
        <Title className="text-[15px] font-semibold tracking-[-0.01em] text-fg">{title}</Title>
        {description ? <p className="mt-1 text-sm text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}
