import type { Metadata } from "next";
import { PageHeader } from "@/components/app/PageHeader";
import { Mark } from "@/components/brand/Logo";
import { EmptyState } from "@/components/ui/EmptyState";

export const metadata: Metadata = { title: "Portfolio" };

export default function PortfolioPage() {
  return (
    <div className="grid gap-8">
      <PageHeader
        title="Portfolio"
        description="Everything your account holds across NEAR, Hyperliquid and EVM chains."
      />
      <EmptyState
        icon={<Mark size={22} />}
        title="Connect an account to see your portfolio"
        description="Balances, positions and vault shares from every venue Parry watches appear here together."
      />
    </div>
  );
}
