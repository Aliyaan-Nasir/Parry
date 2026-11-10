// Public configuration, read once. Next.js inlines NEXT_PUBLIC_* values at build time,
// so each one must be read with a literal property access.

export type ParryNetwork = "testnet" | "mainnet";

function trimUrl(value: string | undefined): string | null {
  const v = value?.trim();
  if (!v) return null;
  return v.replace(/\/+$/, "");
}

export const network: ParryNetwork = process.env.NEXT_PUBLIC_PARRY_NETWORK === "mainnet" ? "mainnet" : "testnet";

export const isTestnet = network === "testnet";

/** Base URL of the Parry API, without a trailing slash, or null when not configured. */
export const apiUrl = trimUrl(process.env.NEXT_PUBLIC_API_URL);

/**
 * NEAR RPC override for chain reads, or null for the network's default RPC. Set it only for a
 * local node: contract ids are then taken from the API's /v1/config (a local deployment uses its
 * own ids), where a public build always uses the published ids of its network.
 */
export const nearRpcUrl = trimUrl(process.env.NEXT_PUBLIC_NEAR_RPC_URL);

/** Source repository URL for the footer, or null to hide the link. */
export const repoUrl = trimUrl(process.env.NEXT_PUBLIC_REPO_URL);

/** Public site URL for absolute metadata links. */
export const siteUrl = trimUrl(process.env.NEXT_PUBLIC_SITE_URL) ?? "http://localhost:3000";

export const networkLabel = network === "mainnet" ? "Mainnet" : "Testnet";
