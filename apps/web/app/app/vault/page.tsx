import type { Metadata } from "next";
import { VaultView } from "./VaultView";
import { PageHeader } from "@/components/app/PageHeader";

export const metadata: Metadata = { title: "Vault" };

export default function VaultPage() {
  return (
    <div className="grid gap-8">
      <PageHeader title="Vault" description="The delta-neutral NEAR vault: staking yield plus funding, with no liquidation for depositors." />
      <VaultView />
    </div>
  );
}
