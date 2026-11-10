import type { Metadata } from "next";
import { ProtectView } from "./ProtectView";
import { PageHeader } from "@/components/app/PageHeader";

export const metadata: Metadata = { title: "Protect" };

export default function ProtectPage() {
  return (
    <div className="grid gap-8">
      <PageHeader title="Protect" description="Set the guardian's mandate: what it may do, how much it may spend, and when it should act. Revoke or pause it at any moment." />
      <ProtectView />
    </div>
  );
}
