/**
 * Contract ids per network. Every id can be overridden in `createParry({ contracts })`.
 */

export type Network = "testnet" | "mainnet";

export interface ContractIds {
  /** Protected accounts factory. */
  factory: string;
  /** Delta-neutral vault (its share token is `EARN`). */
  vault: string;
  /** Risk board: enclave key, sealing key, marks, vault reports, guardian decisions. */
  risk: string;
  /** Price oracle with the Pyth interface. */
  oracle: string | null;
  /** Rhea lending. */
  lending: string;
  /** Rhea exchange for rescue swaps. */
  dex: string;
  /** Chain Signatures MPC contract. */
  signer: string;
  usdc: string;
  wnear: string;
  linear: string;
}

export interface NetworkDefaults {
  network: Network;
  contracts: ContractIds;
  /** Parry contracts that are not deployed on this network yet. */
  notDeployed: ReadonlyArray<keyof ContractIds>;
}

export const NETWORKS: Readonly<Record<Network, NetworkDefaults>> = {
  testnet: {
    network: "testnet",
    contracts: {
      factory: "accounts.parry.testnet",
      vault: "vault.parry.testnet",
      risk: "risk.parry.testnet",
      oracle: "oracle.parry.testnet",
      lending: "lending.parry.testnet",
      dex: "ref-finance-101.testnet",
      signer: "v1.signer-prod.testnet",
      usdc: "usdc.parry.testnet",
      wnear: "wrap.testnet",
      linear: "linear-protocol.testnet",
    },
    notDeployed: [],
  },
  mainnet: {
    network: "mainnet",
    contracts: {
      factory: "accounts.parryguard.near",
      vault: "vault.parryguard.near",
      risk: "risk.parryguard.near",
      oracle: "aggregate-oracle.near",
      lending: "contract.main.burrow.near",
      dex: "v2.ref-finance.near",
      signer: "v1.signer",
      usdc: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
      wnear: "wrap.near",
      linear: "linear-protocol.near",
    },
    notDeployed: ["factory", "vault", "risk"],
  },
};

export function isNetwork(value: unknown): value is Network {
  return value === "testnet" || value === "mainnet";
}
