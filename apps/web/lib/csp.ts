// Content Security Policy for the site and app.
//
// The pages are prerendered, so there is no per-request nonce: Next.js streams its payload with
// inline scripts and the theme script runs inline before paint, which is why script-src carries
// 'unsafe-inline'. Everything else is an allow list, one documented entry at a time.

export type CspOptions = {
  /** NEXT_PUBLIC_API_URL: the Parry API the browser reads (stats, positions, alerts). */
  apiUrl?: string | undefined;
  /** Development adds 'unsafe-eval' (React rebuilds server error stacks with eval in dev only). */
  dev?: boolean;
};

/** Wallet hosts for NEAR Connect: HOT wallet and HERE wallet frames, scripts and APIs. */
export const WALLET_HOSTS = ["https://*.hot-labs.org", "https://*.herewallet.app"] as const;

/** NEAR RPC: FastNEAR (testnet and mainnet) and the public testnet RPC. */
export const NEAR_RPC_HOSTS = ["https://*.fastnear.com", "wss://*.fastnear.com", "https://rpc.testnet.near.org"] as const;

/** Hyperliquid testnet API (REST and WebSocket) for read-only market and position data. */
export const HYPERLIQUID_HOSTS = ["https://api.hyperliquid-testnet.xyz", "wss://api.hyperliquid-testnet.xyz"] as const;

/** Where NEAR Connect fetches its wallet manifest and sandboxed wallet executors. */
export const WALLET_MANIFEST_HOSTS = ["https://raw.githubusercontent.com", "https://cdn.jsdelivr.net"] as const;

/** Returns the origin of a URL, or null when it is missing or malformed. */
export function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.origin;
  } catch {
    return null;
  }
}

export function buildCsp({ apiUrl, dev = false }: CspOptions = {}): string {
  const api = originOf(apiUrl);
  const directives: Record<string, string[]> = {
    // Anything not listed below may only come from this site.
    "default-src": ["'self'"],
    // Next.js runtime and page chunks, its inline payload scripts, the inline theme script,
    // and the NEAR Connect wallet executors (which run in sandboxed srcdoc frames that inherit this policy).
    "script-src": ["'self'", "'unsafe-inline'", ...(dev ? ["'unsafe-eval'"] : []), ...WALLET_HOSTS],
    // Tailwind's stylesheet, next/font's inline @font-face rules and style attributes set by animations.
    "style-src": ["'self'", "'unsafe-inline'"],
    // Fonts are self-hosted at build time by next/font (Fraunces, Manrope, JetBrains Mono).
    "font-src": ["'self'"],
    // Local images, generated charts (data and blob URLs) and wallet icons served by each wallet over https.
    "img-src": ["'self'", "data:", "blob:", "https:"],
    // The Parry API, NEAR RPC, Hyperliquid testnet, wallet manifests and wallet APIs.
    "connect-src": [
      "'self'",
      ...(api ? [api] : []),
      ...NEAR_RPC_HOSTS,
      ...HYPERLIQUID_HOSTS,
      ...WALLET_MANIFEST_HOSTS,
      ...WALLET_HOSTS,
    ],
    // Wallet frames (HOT and HERE) used by NEAR Connect for signing.
    "frame-src": [...WALLET_HOSTS],
    // Web workers created from blobs by chart and wallet libraries.
    "worker-src": ["'self'", "blob:"],
    // The web app manifest.
    "manifest-src": ["'self'"],
    // No plugins, no <base> hijacking, forms only post here, and nobody may frame Parry.
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
    "frame-ancestors": ["'none'"],
  };
  const parts = Object.entries(directives).map(([name, values]) => `${name} ${values.join(" ")}`);
  // Upgrade stray http requests in production, unless the API itself is plain http (a local API).
  const upgrade = !dev && (!api || api.startsWith("https://"));
  if (upgrade) parts.push("upgrade-insecure-requests");
  return parts.join("; ");
}
