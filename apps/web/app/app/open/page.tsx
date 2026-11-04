import type { Metadata } from "next";
import { PageHeader } from "@/components/app/PageHeader";
import { Mark } from "@/components/brand/Logo";
import { EmptyState } from "@/components/ui/EmptyState";

export const metadata: Metadata = { title: "Open position" };

export default function OpenPositionPage() {
  return (
    <div className="grid gap-8">
      <PageHeader
        title="Open position"
        description="Open a leveraged position from your Parry account, protected from the moment it opens."
      />
      <EmptyState
        icon={<Mark size={22} />}
        title="Connect an account to open a position"
        description="Opening a position needs a connected NEAR account. You set the protection mandate as part of the same flow."
      />
    </div>
  );
}
