import type { Metadata, Viewport } from "next";
import { Fraunces, JetBrains_Mono, Manrope } from "next/font/google";
import tokens from "@parry/brand";
import "./globals.css";
import { Providers } from "@/components/providers/Providers";
import { siteUrl } from "@/lib/env";
import { SITE_DESCRIPTION, SITE_TITLE } from "@/lib/site";
import { themeScript } from "@/lib/theme";

const display = Fraunces({ subsets: ["latin"], variable: "--font-fraunces", display: "swap", axes: ["opsz"] });
const text = Manrope({ subsets: ["latin"], variable: "--font-manrope", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains", display: "swap" });

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: { default: SITE_TITLE, template: "%s | Parry" },
  description: SITE_DESCRIPTION,
  applicationName: "Parry",
  authors: [{ name: "Aliyaan Nasir" }],
  creator: "Aliyaan Nasir",
  openGraph: { type: "website", siteName: "Parry", title: SITE_TITLE, description: SITE_DESCRIPTION, url: "/" },
  twitter: { card: "summary_large_image", title: SITE_TITLE, description: SITE_DESCRIPTION },
  appleWebApp: { capable: true, title: "Parry", statusBarStyle: "black-translucent" },
  formatDetection: { telephone: false, email: false, address: false },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: tokens.light.bg },
    { media: "(prefers-color-scheme: dark)", color: tokens.dark.bg },
  ],
  colorScheme: "light dark",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${display.variable} ${text.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="font-sans">
        <a
          href="#main"
          className="sr-only z-[100] rounded-lg bg-brass-fill px-4 py-2 text-sm font-semibold text-on-brass focus:not-sr-only focus:fixed focus:left-4 focus:top-3"
        >
          Skip to content
        </a>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
