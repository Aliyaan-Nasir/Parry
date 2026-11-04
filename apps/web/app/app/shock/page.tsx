import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/app/PageHeader";
import { Mark } from "@/components/brand/Logo";
import { EmptyState } from "@/components/ui/EmptyState";
import { network } from "@/lib/env";

export const metadata: Metadata = { title: "Market shock" };

/** Testnet only: this route does not exist in a mainnet build. */
export default function MarketShockPage() {
  if (network === "mainnet") notFound();
  return (
    <div className="grid gap-8">
      <PageHeader
        title="Market shock"
        tag="Testnet"
        description="Move the test oracle price, within limits, and watch the guardian rescue a live position."
      />
      <EmptyState
        icon={<Mark size={22} />}
        title="Connect an account to run a market shock"
        description="The shock moves the price on Parry's test oracle only. It exists on testnet so anyone can see a rescue happen end to end."
      />
    </div>
  );
}
