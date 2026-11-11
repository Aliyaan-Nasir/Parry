"use client";

import { useCallback, type HTMLAttributes, type PointerEvent } from "react";
import { cn } from "@/lib/cn";

/**
 * A bordered region whose edge lights up under the cursor: it sets --mx and --my for the
 * `.spotlight` (border) and `.spotlight-fill` (wash) styles in system.css. Touch and keyboard
 * users see the plain border.
 */
export function Spotlight({ className, fill = false, onPointerMove, ...rest }: HTMLAttributes<HTMLDivElement> & { fill?: boolean }) {
  const move = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      const r = e.currentTarget.getBoundingClientRect();
      e.currentTarget.style.setProperty("--mx", `${e.clientX - r.left}px`);
      e.currentTarget.style.setProperty("--my", `${e.clientY - r.top}px`);
      onPointerMove?.(e);
    },
    [onPointerMove],
  );
  return <div {...rest} onPointerMove={move} className={cn("spotlight relative", fill && "spotlight-fill", className)} />;
}
