import type { Metadata } from "next";
import { OpenView } from "./OpenView";
import { PageHeader } from "@/components/app/PageHeader";

export const metadata: Metadata = { title: "Open position" };

export default function OpenPositionPage() {
  return (
    <div className="grid gap-8">
      <PageHeader title="Open position" description="Deposit NEAR, borrow USDC against it on Rhea, and have the guardian protect it from the start." />
      <OpenView />
    </div>
  );
}
