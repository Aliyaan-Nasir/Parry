import type { ReactNode } from "react";

/** Each public page enters with a short rise and fade (none under reduced motion). */
export default function SiteTemplate({ children }: { children: ReactNode }) {
  return <div className="route-in">{children}</div>;
}
