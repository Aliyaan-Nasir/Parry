import type { Metadata } from "next";
import { PageHeader } from "@/components/app/PageHeader";
import { CascadeView } from "./CascadeView";

export const metadata: Metadata = { title: "Cascade map" };

export default function CascadePage() {
  return (
    <div className="grid gap-8">
      <PageHeader title="Cascade map" description="Every Rhea borrower's liquidation price, read from the lending contract, and where liquidations would chain into each other as NEAR falls." />
      <CascadeView />
    </div>
  );
}
