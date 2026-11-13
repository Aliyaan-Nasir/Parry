/**
 * Configuration from environment variables, for the `parry-mcp` command.
 */

import { createParry, isNetwork, type NearSigner } from "@parryguard/sdk";
import type { ParryMcpOptions } from "./server.js";

export interface EnvConfig {
  options: ParryMcpOptions;
  /** Notes for stderr (never secrets). */
  notes: string[];
}

/**
 * PARRY_NETWORK (testnet or mainnet, default testnet), PARRY_API_URL, PARRY_RPC_URL, and for the
 * write tools PARRY_AGENT_ACCOUNT_ID with PARRY_AGENT_PRIVATE_KEY (testnet only).
 */
export function configFromEnv(env: Record<string, string | undefined>): EnvConfig {
  const network = env["PARRY_NETWORK"]?.trim() || "testnet";
  if (!isNetwork(network)) throw new Error(`PARRY_NETWORK must be testnet or mainnet, not ${JSON.stringify(network)}`);
  const apiUrl = env["PARRY_API_URL"]?.trim() || undefined;
  const rpcUrl = env["PARRY_RPC_URL"]?.trim() || undefined;
  const accountId = env["PARRY_AGENT_ACCOUNT_ID"]?.trim() || undefined;
  const privateKey = env["PARRY_AGENT_PRIVATE_KEY"]?.trim() || undefined;
  const notes: string[] = [];
  if (Boolean(accountId) !== Boolean(privateKey)) {
    throw new Error("set both PARRY_AGENT_ACCOUNT_ID and PARRY_AGENT_PRIVATE_KEY for the write tools, or neither");
  }
  if (privateKey && !privateKey.startsWith("ed25519:")) throw new Error("PARRY_AGENT_PRIVATE_KEY must be an ed25519:<base58> key");
  let agent: NearSigner | undefined;
  if (accountId && privateKey) {
    agent = { accountId, privateKey };
    if (network === "mainnet") notes.push("write tools are listed but refuse every call on mainnet; the agent key is never used");
    else notes.push(`write tools enabled for ${accountId}`);
  }
  if (!apiUrl) notes.push("PARRY_API_URL is not set: only the chain reads inside the tools work");
  const parry = createParry({ network, ...(apiUrl ? { apiUrl } : {}), ...(rpcUrl ? { rpcUrl } : {}) });
  return { options: { parry, ...(agent ? { agent } : {}) }, notes };
}
