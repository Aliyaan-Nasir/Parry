import type { Metadata } from "next";
import { PortfolioView } from "./PortfolioView";
import { PageHeader } from "@/components/app/PageHeader";

export const metadata: Metadata = { title: "Portfolio" };

export default function PortfolioPage() {
  return (
    <div className="grid gap-8">
      <PageHeader title="Portfolio" description="Everything your protected account holds: positions on every venue Parry watches, and vault shares." />
      <PortfolioView />
    </div>
  );
}
