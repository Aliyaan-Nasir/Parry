import type { MetadataRoute } from "next";
import tokens from "@parryguard/brand";
import { SITE_DESCRIPTION } from "@/lib/site";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Parry",
    short_name: "Parry",
    description: SITE_DESCRIPTION,
    id: "/app",
    start_url: "/app",
    scope: "/",
    display: "standalone",
    background_color: tokens.dark.bg,
    theme_color: tokens.dark.bg,
    categories: ["finance"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
