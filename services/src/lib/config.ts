/**
 * One switch for everything: PARRY_NETWORK=testnet|mainnet. Contract ids come from
 * deployments/<network>.json; endpoints default per network and can be overridden by env.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export type Network = "testnet" | "mainnet";

export const network: Network = process.env.PARRY_NETWORK === "mainnet" ? "mainnet" : "testnet";

const ROOT = join(import.meta.dir, "..", "..", "..");

export interface Deployment {
  network: Network;
  status?: string;
  contracts: Record<string, { account: string; codeHash?: string; tx?: string; commit?: string }>;
  dexPool?: number;
  enclave?: { publicKey: string; sealingPublicKey?: string; wasmSha256: string; wasmUrl?: string; project?: string };
  services?: Record<string, string>;
}

const DEFAULT_CONTRACTS: Record<Network, Record<string, string>> = {
  testnet: {
    factory: "accounts.parry.testnet",
    vault: "vault.parry.testnet",
    risk: "risk.parry.testnet",
    oracle: "oracle.parry.testnet",
    lending: "lending.parry.testnet",
    usdc: "usdc.parry.testnet",
    wnear: "wrap.testnet",
    linear: "linear-protocol.testnet",
    dex: "ref-finance-101.testnet",
    signer: "v1.signer-prod.testnet",
    outlayer: "outlayer.testnet",
  },
  // #mainnet: Parry's own contracts are planned under parryguard.near; the rest are live.
  mainnet: {
    factory: "accounts.parryguard.near",
    vault: "vault.parryguard.near",
    risk: "risk.parryguard.near",
    oracle: "aggregate-oracle.near",
    lending: "contract.main.burrow.near",
    usdc: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
    wnear: "wrap.near",
    linear: "linear-protocol.near",
    dex: "v2.ref-finance.near",
    signer: "v1.signer",
    outlayer: "outlayer.near",
  },
};

export function loadDeployment(): Deployment | null {
  const file = process.env.PARRY_DEPLOYMENTS ?? join(ROOT, "deployments", `${network}.json`);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8")) as Deployment;
}

const deployment = loadDeployment();

/** The account of a contract by its short name (factory, vault, risk, ...). */
export function contract(name: string): string {
  const env = process.env[`PARRY_${name.toUpperCase()}`];
  return env ?? deployment?.contracts[name]?.account ?? DEFAULT_CONTRACTS[network][name] ?? "";
}

/** A contract on either network: this network's deployment (or env), else the other network's default. */
export const contractOn = (net: Network, name: string): string => (net === network ? contract(name) : (DEFAULT_CONTRACTS[net][name] ?? ""));

export const dexPool = (): number => Number(process.env.PARRY_DEX_POOL ?? deployment?.dexPool ?? -1);

export const enclaveInfo = () => deployment?.enclave ?? null;

/** The protected-account code this deployment publishes (global, by hash), or null. */
export const accountCode = (): string | null => process.env.PARRY_ACCOUNT_CODE ?? deployment?.contracts.account?.codeHash ?? null;

export const RPC_URLS: string[] = (process.env.NEAR_RPC_URLS ?? (network === "testnet" ? "https://test.rpc.fastnear.com,https://testnet-rpc.intea.rs,https://near-testnet.drpc.org" : "https://free.rpc.fastnear.com,https://rpc.intea.rs,https://near.drpc.org"))
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/** RPC providers per network, for reads that span both (the heatmap pages mainnet lending from testnet too). */
export const RPC_BY_NETWORK: Record<Network, string[]> = {
  testnet: network === "testnet" ? RPC_URLS : (process.env.TESTNET_RPC_URLS ?? "https://test.rpc.fastnear.com,https://testnet-rpc.intea.rs").split(","),
  mainnet: network === "mainnet" ? RPC_URLS : (process.env.MAINNET_RPC_URLS ?? "https://free.rpc.fastnear.com,https://rpc.intea.rs,https://near.drpc.org").split(","),
};

export const HYPERLIQUID_URL = process.env.HYPERLIQUID_URL ?? (network === "testnet" ? "https://api.hyperliquid-testnet.xyz" : "https://api.hyperliquid.xyz");
export const HYPERLIQUID_NEAR_INDEX = network === "testnet" ? 54 : 74;
/**
 * The EVM chain of the Aave rescue: Base Sepolia on testnet (the testnet MPC network verifies
 * Base transactions, not Ethereum's), Base on mainnet. `foreignChain` is the MPC network's name
 * for it in `verify_foreign_transaction`.
 */
export const EVM = network === "testnet"
  ? { name: "Base Sepolia", chainId: 84532, foreignChain: "Base", explorer: "https://sepolia.basescan.org",
      aave: { pool: "0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27", usdc: "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f", weth: "0x4200000000000000000000000000000000000006" } }
  : { name: "Base", chainId: 8453, foreignChain: "Base", explorer: "https://basescan.org",
      aave: { pool: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5", usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", weth: "0x4200000000000000000000000000000000000006" } };
export const EVM_RPC_URL = process.env.EVM_RPC_URL ?? (network === "testnet" ? "https://sepolia.base.org" : "https://mainnet.base.org");
export const EVM_CHAIN_ID = EVM.chainId;
export const FASTNEAR_TX_URL = process.env.FASTNEAR_TX_URL ?? (network === "testnet" ? "https://tx.test.fastnear.com" : "https://tx.main.fastnear.com");
export const NEAR_USD = "c415de8d2eba7db216527dff4b60e8f3a5311c740dadb233e13e12547e226750";
export const USDC_USD = "eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a";

export const explorers = {
  near: network === "testnet" ? "https://testnet.nearblocks.io" : "https://nearblocks.io",
  hyperliquid: network === "testnet" ? "https://app.hyperliquid-testnet.xyz/explorer" : "https://app.hyperliquid.xyz/explorer",
  intents: "https://explorer.near-intents.org",
  evm: EVM.explorer,
};

export function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`missing env ${name}`);
  return v;
}

export const intEnv = (name: string, fallback: number): number => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && process.env[name] !== undefined && process.env[name] !== "" ? v : fallback;
};
