import type { Metadata } from "next";
import { PageHeader } from "@/components/app/PageHeader";
import { Mark } from "@/components/brand/Logo";
import { EmptyState } from "@/components/ui/EmptyState";

export const metadata: Metadata = { title: "Protect" };

export default function ProtectPage() {
  return (
    <div className="grid gap-8">
      <PageHeader
        title="Protect"
        description="Set the guardian's mandate for each position: what it may do, and when."
      />
      <EmptyState
        icon={<Mark size={22} />}
        title="Connect an account to set up protection"
        description="Your mandate covers thresholds, a rescue reserve, a daily cap, allowed actions and an expiry. You can revoke or override it at any moment."
      />
    </div>
  );
}
