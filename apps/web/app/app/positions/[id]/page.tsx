import type { Metadata } from "next";
import { Suspense } from "react";
import { PositionDetail, PositionSkeleton } from "./PositionDetail";
import { PageHeader } from "@/components/app/PageHeader";

export const metadata: Metadata = { title: "Position" };

/** The position id is only known at request time, so the page streams in under Suspense. */
export default function PositionPage() {
  return (
    <Suspense
      fallback={
        <div className="grid gap-8">
          <PageHeader title="Position" description="Loading" />
          <PositionSkeleton />
        </div>
      }
    >
      <PositionDetail />
    </Suspense>
  );
}
