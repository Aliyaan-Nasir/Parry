import type { Metadata } from "next";
import { GuardianLog } from "./GuardianLog";
import { PageHeader } from "@/components/app/PageHeader";

export const metadata: Metadata = { title: "Guardian log" };

export default function GuardianPage() {
  return (
    <div className="grid gap-8">
      <PageHeader
        title="Guardian log"
        description="Every action the guardian took or was refused, with its AI review, its transactions and checks you can run here."
      />
      <GuardianLog />
    </div>
  );
}
