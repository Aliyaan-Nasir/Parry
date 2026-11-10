import type { Metadata } from "next";
import { AlertsList } from "./AlertsList";
import { PageHeader } from "@/components/app/PageHeader";

export const metadata: Metadata = { title: "Alerts" };

export default function AlertsPage() {
  return (
    <div className="grid gap-8">
      <PageHeader title="Alerts" description="What Parry noticed about your positions, newest first. Acknowledge what you have seen and resolve what you have handled." />
      <AlertsList />
    </div>
  );
}
