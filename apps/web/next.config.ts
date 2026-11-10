import type { NextConfig } from "next";
import { buildCsp } from "./lib/csp";

const dev = process.env.NODE_ENV === "development";

const securityHeaders = [
  // See lib/csp.ts for what each entry allows and why.
  { key: "Content-Security-Policy", value: buildCsp({ apiUrl: process.env.NEXT_PUBLIC_API_URL, rpcUrl: process.env.NEXT_PUBLIC_NEAR_RPC_URL, dev }) },
  // Only send the origin to other sites, never full paths with account ids.
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Belt and braces with frame-ancestors 'none' for older browsers.
  { key: "X-Frame-Options", value: "DENY" },
  // Wallet popups keep their opener so they can hand results back.
  { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
  // Parry never needs these sensors.
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  typedRoutes: true,
  cacheComponents: true,
  partialPrefetching: true,
  // next dev would otherwise write a managed AGENTS.md block; this package keeps its own notes.
  agentRules: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  async redirects() {
    return [{ source: "/legal", destination: "/legal/terms", permanent: false }];
  },
};

export default nextConfig;
