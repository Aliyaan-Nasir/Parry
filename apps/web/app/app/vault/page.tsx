import type { Metadata } from "next";
import { PageHeader } from "@/components/app/PageHeader";
import { Mark } from "@/components/brand/Logo";
import { EmptyState } from "@/components/ui/EmptyState";

export const metadata: Metadata = { title: "Vault" };

export default function VaultPage() {
  return (
    <div className="grid gap-8">
      <PageHeader
        title="Vault"
        description="The delta-neutral NEAR vault: staking yield plus funding, with no liquidation for depositors."
      />
      <EmptyState
        icon={<Mark size={22} />}
        title="Connect an account to see your vault shares"
        description="Deposits are staked with LiNEAR and hedged with a NEAR perp short on Hyperliquid, 90% hedged by default. Your shares and their value appear here."
      />
    </div>
  );
}
