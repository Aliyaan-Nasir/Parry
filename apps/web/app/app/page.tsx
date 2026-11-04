import Link from "next/link";
import { PageHeader } from "@/components/app/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { buttonClasses } from "@/components/ui/Button";
import { Mark } from "@/components/brand/Logo";

export default function DashboardPage() {
  return (
    <div className="grid gap-8">
      <PageHeader title="Dashboard" description="Your protected positions, their risk and the guardian's latest actions, in one place." />
      <EmptyState
        icon={<Mark size={22} />}
        title="Connect an account to see your positions"
        description="Once an account is connected, each position appears here with its risk score, time to liquidation and protection status."
        action={
          <Link href="/#protect" className={buttonClasses({ variant: "secondary" })}>
            How protection works
          </Link>
        }
      />
    </div>
  );
}
