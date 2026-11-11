"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";

/**
 * Scrolls to the URL's #anchor once the element exists. Pages load their data after the route
 * renders, so the browser's own jump often finds nothing; this waits up to five seconds for it.
 */
export function HashScroll() {
  const pathname = usePathname();
  useEffect(() => {
    const id = decodeURIComponent(window.location.hash.slice(1));
    if (!id) return;
    let tries = 0;
    const timer = setInterval(() => {
      const el = document.getElementById(id);
      if (el || ++tries > 50) clearInterval(timer);
      if (el) {
        el.scrollIntoView({ block: "start" });
        el.querySelector<HTMLElement>("input, button, [tabindex]")?.focus({ preventScroll: true });
      }
    }, 100);
    return () => clearInterval(timer);
  }, [pathname]);
  return null;
}
