import type { Metadata } from "next";
import { LegalHeader } from "@/components/site/LegalHeader";
import { THEME_STORAGE_KEY } from "@/lib/theme";

export const metadata: Metadata = {
  title: "Cookies",
  description: "Parry sets no cookies. It keeps one theme preference in your browser's local storage.",
};

export default function CookiesPage() {
  return (
    <>
      <LegalHeader title="Cookies">Parry sets no cookies and does no tracking.</LegalHeader>

      <h2>The one thing your browser keeps</h2>
      <p>
        If you pick a light or dark theme, Parry saves that choice in your browser&apos;s local storage under the key{" "}
        <code>{THEME_STORAGE_KEY}</code>, so the site looks the way you left it. It never leaves your device. If you never pick a
        theme, nothing is stored and Parry follows your system setting.
      </p>

      <h2>Removing it</h2>
      <p>Choose &quot;System&quot; in the theme switcher, or clear this site&apos;s data in your browser settings.</p>

      <h2>No tracking</h2>
      <p>No analytics, no advertising cookies, no third party scripts that follow you around the web.</p>
    </>
  );
}
