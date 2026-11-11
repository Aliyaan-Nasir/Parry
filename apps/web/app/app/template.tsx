import type { ReactNode } from "react";

/** Each app page enters with a short rise and fade (none under reduced motion). */
export default function AppTemplate({ children }: { children: ReactNode }) {
  return <div className="route-in">{children}</div>;
}
