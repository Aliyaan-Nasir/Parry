import type { Metadata } from "next";
import { PageHeader } from "@/components/app/PageHeader";
import { RatesBoard } from "@/components/app/Rates";

export const metadata: Metadata = { title: "Rates" };

export default function RatesPage() {
  return (
    <div className="grid gap-8">
      <PageHeader title="Rates" description="What lending and borrowing cost on Rhea, what funding pays on Hyperliquid, and where the vault's yield comes from, read live with their sources." />
      <RatesBoard />
    </div>
  );
}
