import type { Metadata } from "next";
import { PageHeader } from "@/components/app/PageHeader";
import { Mark } from "@/components/brand/Logo";
import { EmptyState } from "@/components/ui/EmptyState";

export const metadata: Metadata = { title: "Alerts" };

export default function AlertsPage() {
  return (
    <div className="grid gap-8">
      <PageHeader
        title="Alerts"
        description="Choose what Parry tells you about, and how."
      />
      <EmptyState
        icon={<Mark size={22} />}
        title="Connect an account to manage alerts"
        description="Get notified when a position changes tier or when the guardian acts. Alerts are tied to your account."
      />
    </div>
  );
}
