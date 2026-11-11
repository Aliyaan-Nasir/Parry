import type { Metadata } from "next";
import { Suspense } from "react";
import { PageHeader } from "@/components/app/PageHeader";
import { WatchedView } from "./WatchedView";

export const metadata: Metadata = { title: "Watched accounts" };

export default function WatchedPage() {
  return (
    <div className="grid gap-8">
      <PageHeader title="Watched accounts" description="Keep an eye on any NEAR account's Rhea position, protected by Parry or not, with your own thresholds for when it should alert." />
      <Suspense>
        <WatchedView />
      </Suspense>
    </div>
  );
}
