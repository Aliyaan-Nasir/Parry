import type { MetadataRoute } from "next";
import { siteUrl } from "@/lib/env";

/** The public pages, for search engines and agents; the app's pages read live data per account. */
const PAGES: readonly [path: string, priority: number][] = [
  ["/", 1],
  ["/app", 0.9],
  ["/verify", 0.8],
  ["/replay", 0.7],
  ["/check", 0.7],
  ["/app/vault", 0.7],
  ["/app/guardian", 0.6],
  ["/app/cascade", 0.5],
  ["/app/rates", 0.5],
  ["/app/status", 0.5],
  ["/llms.txt", 0.5],
  ["/legal/terms", 0.2],
  ["/legal/privacy", 0.2],
  ["/legal/security", 0.2],
  ["/legal/cookies", 0.2],
];

export default function sitemap(): MetadataRoute.Sitemap {
  return PAGES.map(([path, priority]) => ({ url: `${siteUrl}${path === "/" ? "" : path}`, priority }));
}
