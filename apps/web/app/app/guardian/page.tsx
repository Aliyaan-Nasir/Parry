import type { Metadata } from "next";
import { PageHeader } from "@/components/app/PageHeader";
import { Mark } from "@/components/brand/Logo";
import { EmptyState } from "@/components/ui/EmptyState";

export const metadata: Metadata = { title: "Guardian log" };

export default function GuardianLogPage() {
  return (
    <div className="grid gap-8">
      <PageHeader
        title="Guardian log"
        description="Every action the guardian takes, with the hash of the AI review that approved it."
      />
      <EmptyState
        icon={<Mark size={22} />}
        title="Connect an account to see the guardian's actions"
        description="Each rescue is listed with what was done, why, the review hash and a link to the transaction on its explorer."
      />
    </div>
  );
}
