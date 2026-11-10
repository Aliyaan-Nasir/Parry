import { Dashboard } from "./Dashboard";
import { PageHeader } from "@/components/app/PageHeader";

export default function DashboardPage() {
  return (
    <div className="grid gap-8">
      <PageHeader title="Dashboard" description="Your protected positions, their risk and the guardian's latest actions, in one place." />
      <Dashboard />
    </div>
  );
}
